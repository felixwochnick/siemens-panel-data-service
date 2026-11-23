import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Insertable, Kysely, Updateable } from 'kysely'
import { AnalyzerError, analyze, parseRawProject } from '@pds/analyzer'
import type { AnalysisResult, RawProject } from '@pds/analyzer'
import { isUniqueViolation } from '@pds/core/database'
import type { AnalysesTable, AnalysisEventsTable, AppDatabase } from '../database/types'
import type { DriveConnector } from '../lib/drive'
import { AnalysisError } from '../lib/errors'
import { createSafeLogger, errorText, formatEvent, truncateDetail } from '../lib/log'
import type { EventLogger, LogEvent } from '../lib/log'
import { ANALYSIS_ERROR_CODES, ANALYSIS_EVENT_CODES, WORKER_STAGES } from '../../shared/types/api'
import type { AnalysisStage, AnalysisStatus } from '../../shared/types/api'
import { ServiceError } from './errors'
import { EventQueue } from './events'
import { copyProjectToWork, ensureFolderAvailable, projectModified, resolveInFolder } from './folder'
import { uploadDir } from './projects'
import { saveResults } from './results'
import { loadSettings } from './settings'
import type { WorkerClient } from './worker-client'
import { WorkerError } from './worker-client'

// Je Ereigniszeile 6 Parameter; SQL Server erlaubt höchstens 2100 je Anweisung
const EVENT_CHUNK = 300
const MAX_BUFFERED_EVENTS = 10_000
const FINISH_RETRIES = 4
const KNOWN_EVENT_CODES = new Set<string>(ANALYSIS_EVENT_CODES)
const KNOWN_ERROR_CODES = new Set<string>(ANALYSIS_ERROR_CODES)

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const clip = (value: string | undefined | null, max: number) => (value ? value.slice(0, max) : null)

export interface QueueOptions {
  db: Kysely<AppDatabase>
  secretKey: Buffer
  /** Datenordner mit uploads/ und work/ */
  dataDir: string
  worker: WorkerClient
  drive: DriveConnector
  now?: () => Date
  /** Zeile je Ereignis (Standard stdout; unter Windows landet sie in app.log) */
  print?: (line: string) => void
  /** wie oft gepufferte Ereignisse geschrieben werden (Standard 1 s) */
  flushIntervalMs?: number
  /** wie oft ohne Anstoß nach Aufträgen gesehen wird – auch solchen anderer Prozesse (Standard 5 s) */
  pollIntervalMs?: number
  /** Zeitlimit in ms statt analysisTimeoutMinutes (Tests) */
  timeoutMs?: number
}

interface Job {
  id: number
  projectId: number
  trigger: string
  uploadFile: string | null
}

interface Final {
  status: AnalysisStatus
  errorCode: string | null
  errorDetail: string | null
}

/**
 * Warteschlange der Analysen: eine gleichzeitig (im Prozess und per eindeutigem Index über Prozesse hinweg), in der
 * Reihenfolge des Einreihens. Ohne Worker-Verbindung bleiben Aufträge `queued`. Ablauf je Auftrag: Arbeitsordner
 * `work/<id>`, Ordner-Projekte dorthin kopieren (Netzlaufwerk vorher verbinden), Worker `configure` + `analyze`,
 * Rohdaten auswerten, Ergebnisse in einer Transaktion speichern, Arbeitsordner löschen.
 */
export class AnalysisQueue {
  private active: { id: number, controller: AbortController } | null = null
  private loop: Promise<void> | null = null
  private stopped = false
  private kicked = false
  private wakeUp: (() => void) | null = null
  /** Analysen, die vor diesem Zeitpunkt begannen, stammen aus einem früheren Prozess (abortStale) */
  readonly createdAt: Date
  private readonly now: () => Date
  private readonly print: (line: string) => void

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date())
    this.print = options.print ?? (line => console.info(line))
    this.createdAt = this.now()
  }

  /** id der laufenden Analyse dieses Prozesses */
  get runningId(): number | null {
    return this.active?.id ?? null
  }

  /** Abarbeiten beginnen (einmal je Prozess) */
  start(): void {
    if (this.loop || this.stopped) return
    this.loop = this.run()
  }

  /** Neuer Auftrag: sofort nachsehen statt bis zur nächsten Runde zu warten */
  kick(): void {
    this.kicked = true
    this.wakeUp?.()
  }

  /** Beenden: keine neuen Aufträge, laufende Analyse abbrechen (`aborted`/`shutting_down`) und kurz auf sie warten */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true
    this.active?.controller.abort(new AnalysisError('shutting_down'))
    this.wakeUp?.()
    if (!this.loop) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.loop, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })])
    clearTimeout(timer)
  }

  /**
   * Beim Hochfahren: Analysen, die beim letzten Beenden noch liefen, gelten als abgebrochen (`interrupted`). Nur solche
   * vor diesem Prozess – eine gerade begonnene bleibt. Wartende bleiben in der Warteschlange.
   */
  async abortStale(): Promise<number> {
    let query = this.options.db.updateTable('pds.analyses')
      .set({ status: 'aborted', stage: null, finishedAt: this.now(), errorCode: 'interrupted' })
      .where('status', '=', 'running')
      .where('startedAt', '<', this.createdAt)
    if (this.active) query = query.where('id', '<>', this.active.id)
    const result = await query.executeTakeFirst()
    return Number(result.numUpdatedRows)
  }

  private async run(): Promise<void> {
    let errorDelay = 1000
    while (!this.stopped) {
      try {
        // Ein Anstoß zählt für genau eine Runde (sonst liefe die Schleife ohne Worker im Kreis)
        this.kicked = false
        if (!this.options.worker.connected) {
          await this.wait(this.options.pollIntervalMs ?? 5000)
          continue
        }
        const job = await this.claim()
        if (job === 'retry') continue
        if (job === 'busy') {
          await this.wait(this.options.pollIntervalMs ?? 5000)
          continue
        }
        if (!job) {
          await this.wait(this.options.pollIntervalMs ?? 5000)
          continue
        }
        errorDelay = 1000
        await this.execute(job)
      }
      catch (error) {
        console.error(`[queue] Fehler, neuer Versuch in ${Math.round(errorDelay / 1000)} s`, error)
        await this.wait(errorDelay)
        errorDelay = Math.min(errorDelay * 2, 60_000)
      }
    }
  }

  /** Warten bis Zeit um, Anstoß, Änderung der Worker-Verbindung oder Beenden */
  private wait(ms: number): Promise<void> {
    if (this.stopped || this.kicked) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        this.wakeUp = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      const unsubscribe = this.options.worker.onChange(done)
      this.wakeUp = done
    })
  }

  /**
   * Ältesten wartenden Auftrag übernehmen; 'retry', wenn ein anderer Prozess schneller war. 'busy', solange der Worker
   * noch beschäftigt ist: Reißt die Verbindung während einer Analyse ab, rechnet der Worker sie zu Ende (die Antwort
   * geht verloren, der Auftrag ist schon `failed`/`worker_disconnected`) – der nächste wartet, bis er fertig ist.
   */
  private async claim(): Promise<Job | 'retry' | 'busy' | null> {
    const { db, worker } = this.options
    const next = await db.selectFrom('pds.analyses')
      .select(['id', 'projectId', 'trigger', 'uploadFile'])
      .where('status', '=', 'queued')
      .orderBy('queuedAt')
      .orderBy('id')
      .top(1)
      .executeTakeFirst()
    if (!next) return null
    const status = await worker.status(5000).catch(() => null)
    if (!status || status.busy) return 'busy'
    try {
      const result = await db.updateTable('pds.analyses')
        .set({ status: 'running', startedAt: this.now(), stage: 'preparing' })
        .where('id', '=', next.id)
        .where('status', '=', 'queued')
        .executeTakeFirst()
      return Number(result.numUpdatedRows) === 1 ? next : 'retry'
    }
    catch (error) {
      // Eine Analyse läuft schon (anderer Prozess): später erneut
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  private async setStage(id: number, stage: AnalysisStage): Promise<void> {
    await this.options.db.updateTable('pds.analyses').set({ stage }).where('id', '=', id).where('status', '=', 'running').execute()
      .catch(() => {})
  }

  private async execute(job: Job): Promise<void> {
    const { db, worker } = this.options
    const id = job.id
    const controller = new AbortController()
    this.active = { id, controller }
    const signal = controller.signal

    const events = new EventQueue<Insertable<AnalysisEventsTable>>({
      chunkSize: EVENT_CHUNK,
      max: MAX_BUFFERED_EVENTS,
      write: rows => db.insertInto('pds.analysisEvents').values(rows).execute().then(() => {}),
      onError: error => console.error(`[analysis ${id}] Ereignisse konnten nicht gespeichert werden, neuer Versuch folgt`, error),
      onDrop: () => console.warn(`[analysis ${id}] Zu viele ungespeicherte Ereignisse – die ältesten werden verworfen`),
    })
    const flushTimer = setInterval(() => void events.flush(), this.options.flushIntervalMs ?? 1000)
    const toRow = (event: LogEvent): Insertable<AnalysisEventsTable> => ({
      analysisId: id,
      at: this.now(),
      level: event.level,
      code: event.code.slice(0, 100),
      params: event.params && Object.keys(event.params).length ? JSON.stringify(event.params) : null,
      detail: clip(event.detail, 2000),
    })
    const printEvent = (event: LogEvent, at: Date) => this.print(`${at.toISOString()} [analysis ${id}] ${formatEvent(event)}`)
    const rawLog: EventLogger = (event: LogEvent) => {
      const row = toRow(event)
      events.push(row)
      printEvent(event, row.at)
    }
    let log = rawLog
    let timeout: ReturnType<typeof setTimeout> | undefined
    const workDir = join(this.options.dataDir, 'work', String(id))
    let final: Final
    let saved = false

    try {
      const loaded = await loadSettings(this.options)
      const { settings } = loaded
      // Geheimnisse nie in Ereignisse
      log = createSafeLogger(rawLog, [settings.networkDrive.password])
      const timeoutMs = this.options.timeoutMs ?? settings.analysisTimeoutMinutes * 60_000
      timeout = setTimeout(() => controller.abort(new AnalysisError('timeout', `${Math.round(timeoutMs / 1000)} s`)), timeoutMs)

      const project = await db.selectFrom('pds.projects').selectAll().where('id', '=', job.projectId).executeTakeFirst()
      if (!project) throw new AnalysisError('project_file_missing', 'project deleted')
      log({ level: 'info', code: 'analysis_started', params: { trigger: job.trigger } })

      await rm(workDir, { recursive: true, force: true })
      await mkdir(workDir, { recursive: true })

      // 1. Projektdatei bereitstellen
      let projectPath: string
      let sourceModified: Date | null
      if (project.source === 'folder') {
        const folder = settings.folder.trim()
        if (!folder) throw new AnalysisError('folder_not_configured')
        if (settings.source === 'network') {
          await this.setStage(id, 'connecting_drive')
          await ensureFolderAvailable({ drive: this.options.drive }, settings, loaded.unreadable, 'always', log, signal)
        }
        await this.setStage(id, 'copying')
        const resolved = resolveInFolder(folder, project.path ?? '')
        if (!resolved) throw new AnalysisError('project_file_missing', project.path ?? '')
        sourceModified = await projectModified(resolved.absolutePath, project.fileKind, signal).catch((error: unknown) => {
          if (signal.aborted) throw error
          throw new AnalysisError('project_file_missing', errorText(error))
        })
        const copied = await copyProjectToWork(resolved.absolutePath, project.fileKind, workDir, signal)
        projectPath = copied.projectPath
        log({ level: 'info', code: 'project_copied', params: { files: copied.files } })
      }
      else {
        const file = job.uploadFile ?? project.uploadFile
        if (!file) throw new AnalysisError('project_file_missing')
        projectPath = join(uploadDir(this.options.dataDir, project.id), ...file.split('/'))
        if (!existsSync(projectPath)) throw new AnalysisError('project_file_missing', file)
        // Zeitpunkt des Hochladens dieser Datei
        sourceModified = new Date(Math.floor((await stat(projectPath)).mtimeMs))
      }
      signal.throwIfAborted()

      // 2. Worker: einrichten (EPLAN-Pfade) und Rohdaten schreiben lassen
      await this.setStage(id, 'configuring')
      const { restarted } = await worker.configure(settings.eplan, { signal })
      if (restarted) log({ level: 'info', code: 'worker_restarted' })
      const outputFile = join(workDir, 'raw.json')
      await worker.analyze({ projectPath, workFolder: workDir, outputFile, openMode: settings.eplan.openMode }, {
        signal,
        onProgress: (stage) => {
          if ((WORKER_STAGES as readonly string[]).includes(stage)) void this.setStage(id, stage as AnalysisStage)
        },
        onLog: entry => log(KNOWN_EVENT_CODES.has(entry.code)
          ? { level: entry.level, code: entry.code, detail: entry.message || undefined }
          : { level: entry.level, code: 'worker_log', params: { code: entry.code.slice(0, 100) }, detail: entry.message || undefined }),
      })

      // 3. Rohdaten auswerten
      await this.setStage(id, 'analyzing')
      const { raw, result } = await readAndAnalyze(outputFile)
      log({ level: 'info', code: 'raw_read', params: { pages: raw.pages.length, connections: raw.connections.length } })
      for (const notice of result.notices) log({ level: notice.level, code: notice.code, params: notice.params })
      signal.throwIfAborted()

      // 4. Speichern – nicht mehr abbrechen (eine Transaktion; Zeitlimit gilt bis hierher)
      clearTimeout(timeout)
      await this.setStage(id, 'saving')
      await events.flush()
      // Abschluss-Ereignisse in derselben Transaktion: wer `succeeded` sieht, findet auch sie
      const closing: LogEvent[] = [
        { level: 'info', code: 'results_saved', params: { connections: result.connections.length, cables: result.cables.length, shields: result.shields.length, texts: result.texts.length } },
        { level: 'info', code: 'analysis_succeeded' },
      ]
      const closingRows = closing.map(toRow)
      // Was noch nicht geschrieben ist, geht mit; scheitert das Speichern, bleibt es in der Warteschlange
      const pending = events.drain()
      await saveResults(db, {
        analysisId: id,
        projectId: project.id,
        result,
        now: this.now(),
        meta: {
          eplanProjectName: raw.project.name || null,
          eplanVersion: raw.eplanVersion || null,
          workerVersion: raw.worker || worker.info().version,
          sourceModified,
        },
        events: [...pending, ...closingRows],
      }).catch((error: unknown) => {
        for (const row of pending) events.push(row)
        throw error
      })
      saved = true
      final = { status: 'succeeded', errorCode: null, errorDetail: null }
      closing.forEach((event, index) => printEvent(event, closingRows[index]!.at))
    }
    catch (error) {
      final = toFinal(signal.aborted && !(error instanceof AnalysisError) ? signal.reason : error)
      if (final.status === 'aborted') {
        log({ level: 'warn', code: 'analysis_aborted', params: { code: final.errorCode ?? '' } })
      }
      else {
        log({ level: 'error', code: final.errorCode ?? 'unexpected_error', detail: final.errorDetail ?? undefined })
        log({ level: 'error', code: 'analysis_failed', params: { code: final.errorCode ?? '' } })
      }
      if (final.errorCode === 'timeout') {
        // Der Worker hängt womöglich noch in EPLAN: beenden, der Dienst bzw. der Client startet ihn neu
        await worker.restart().catch(() => {})
        log({ level: 'info', code: 'worker_restarted' })
      }
    }
    finally {
      clearTimeout(timeout)
      clearInterval(flushTimer)
    }

    // 5. Arbeitsordner löschen (der Worker hat restore/ selbst entfernt)
    await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
      log({ level: 'warn', code: 'work_folder_not_removed', detail: errorText(error) })
    })

    // Ereignisse vor dem Status: wer die Analyse beendet sieht, soll alle Ereignisse finden
    for (let attempt = 0; attempt <= FINISH_RETRIES && events.size; attempt++) {
      if (attempt) await sleep(250 * 2 ** (attempt - 1))
      await events.flush()
    }
    if (!saved) await this.saveFinal(id, final)
    this.active = null
  }

  /** Abschluss einer gescheiterten oder abgebrochenen Analyse; mehrfach versucht (die Zeile sperrt sonst `running`) */
  private async saveFinal(id: number, final: Final): Promise<void> {
    const values: Updateable<AnalysesTable> = {
      status: final.status,
      stage: null,
      finishedAt: this.now(),
      errorCode: final.errorCode,
      errorDetail: clip(final.errorDetail, 2000),
    }
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt) await sleep(250 * 2 ** (attempt - 1))
        await this.options.db.updateTable('pds.analyses').set(values).where('id', '=', id).where('status', '=', 'running').execute()
        return
      }
      catch (error) {
        if (attempt >= FINISH_RETRIES) {
          // Bleibt `running`: der nächste Start des Servers markiert sie als abgebrochen
          console.error(`[analysis ${id}] Abschluss konnte nicht gespeichert werden`, error)
          return
        }
      }
    }
  }
}

/** raw.json lesen, prüfen (parseRawProject) und auswerten (analyze) */
async function readAndAnalyze(outputFile: string): Promise<{ raw: RawProject, result: AnalysisResult }> {
  let json: unknown
  try {
    json = JSON.parse((await readFile(outputFile, 'utf8')).replace(/^\uFEFF/, ''))
  }
  catch (error) {
    throw new AnalysisError('raw_unreadable', errorText(error))
  }
  try {
    const raw = parseRawProject(json)
    return { raw, result: analyze(raw) }
  }
  catch (error) {
    if (error instanceof AnalyzerError) throw new AnalysisError(KNOWN_ERROR_CODES.has(error.code) ? error.code : 'raw_invalid', error.detail ?? error.message)
    throw error
  }
}

/** Fehler → Status und Code der Analyse */
function toFinal(error: unknown): Final {
  if (error instanceof AnalysisError) {
    return { status: error.code === 'shutting_down' ? 'aborted' : 'failed', errorCode: error.code, errorDetail: error.detail ? truncateDetail(error.detail) : null }
  }
  if (error instanceof WorkerError) {
    if (error.code === 'shutting_down') return { status: 'aborted', errorCode: 'shutting_down', errorDetail: null }
    const known = KNOWN_ERROR_CODES.has(error.code)
    const detail = known ? error.detail : `${error.code}${error.detail ? `: ${error.detail}` : ''}`
    return { status: 'failed', errorCode: known ? error.code : 'worker_error', errorDetail: detail ? truncateDetail(detail) : null }
  }
  if (error instanceof ServiceError) return { status: 'failed', errorCode: 'unexpected_error', errorDetail: error.message }
  return { status: 'failed', errorCode: 'unexpected_error', errorDetail: truncateDetail(errorText(error)) }
}
