import { getDatabaseDialect } from '@pds/core/database'
import { AnalysisError } from '../lib/errors'
import { errorText, safeDetail } from '../lib/log'
import { OPEN_ANALYSIS_STATUSES } from '../../shared/types/api'
import type { CheckResult, ConnectionTestResult, CronPreview, PdsSettings, SettingsInput, StatusInfo, Via } from '../../shared/types/api'
import type { Actor } from './access'
import { requireAdmin, requireUser } from './access'
import { analysesWithProject, toAnalysisInfo } from './analyses'
import { listAudit, writeAudit } from './audit'
import type { AppContext } from './context'
import { ServiceError } from './errors'
import { scanFolder } from './folder'
import { previewRuns } from './scheduler'
import { loadSettings, settingsFromInput, settingsIssues } from './settings'

/**
 * Übersicht für alle Angemeldeten: Worker, Warteschlange (laufend mit Stufe, wartend), zuletzt beendete Analysen.
 * Admins zusätzlich Hinweise der Einstellungen, Zeitplan und letzte Änderungen.
 */
export async function getStatus(ctx: AppContext, actor: Actor): Promise<StatusInfo> {
  requireUser(actor)
  // Zustand von EPLAN frisch abfragen (kurz; der Worker antwortet auch während einer Analyse)
  if (ctx.worker.connected) await ctx.worker.status(2000).catch(() => {})
  const [running, queued, queuedCount, recent] = await Promise.all([
    analysesWithProject(ctx.db).where('a.status', '=', 'running').orderBy('a.id', 'desc').top(1).executeTakeFirst(),
    analysesWithProject(ctx.db).where('a.status', '=', 'queued').orderBy('a.queuedAt').orderBy('a.id').top(50).execute(),
    ctx.db.selectFrom('pds.analyses').select(eb => eb.fn.countAll<number>().as('count')).where('status', '=', 'queued').executeTakeFirstOrThrow(),
    analysesWithProject(ctx.db).where('a.status', 'not in', [...OPEN_ANALYSIS_STATUSES]).orderBy('a.finishedAt', 'desc').orderBy('a.id', 'desc').top(10).execute(),
  ])
  let admin: StatusInfo['admin'] = null
  if (actor.isAdmin) {
    const loaded = await loadSettings(ctx)
    admin = {
      issues: settingsIssues(loaded),
      scheduler: ctx.scheduler.info(loaded.settings),
      unreadableSecrets: loaded.unreadable,
      saved: loaded.saved,
      recentAudit: await listAudit(ctx.db, actor, 8),
    }
  }
  return {
    database: getDatabaseDialect(ctx.db),
    worker: ctx.worker.info(),
    queue: {
      running: running ? toAnalysisInfo(running) : null,
      queued: queued.map(toAnalysisInfo),
      queuedCount: Number(queuedCount.count),
    },
    recentAnalyses: recent.map(toAnalysisInfo),
    admin,
  }
}

const check = (ok: boolean, code: CheckResult['code'], extra: Omit<CheckResult, 'ok' | 'code'> = {}): CheckResult => ({ ok, code, ...extra })

/**
 * Verbindungstest mit den Werten des Formulars (auch ungespeichert): Netzlaufwerk (nur source network), Projektordner
 * (Anzahl Projekte), Worker (status). Geheimnisse ohne Eingabe aus der Datenbank – nur für ihr bisheriges Ziel. Mit
 * Netzlaufwerk nicht während einer Analyse (sie kopiert womöglich gerade von dort) ⇒ 409 `analysis_running`.
 */
export async function testSettings(ctx: AppContext, actor: Actor, input?: SettingsInput): Promise<ConnectionTestResult> {
  requireAdmin(actor)
  const settings: PdsSettings = input ? await settingsFromInput(ctx, input) : (await loadSettings(ctx)).settings
  const secrets = [settings.networkDrive.password]
  const detail = (error: unknown) => safeDetail(errorText(error), secrets)
  const signal = AbortSignal.timeout(45_000)
  const result: Partial<ConnectionTestResult> = {}

  if (settings.source === 'network') {
    const running = await ctx.db.selectFrom('pds.analyses').select('id').where('status', '=', 'running').executeTakeFirst()
    if (running) throw new ServiceError(409, 'analysis_running')
    try {
      await ctx.drive.connect(settings.networkDrive, () => {}, signal)
      result.drive = check(true, 'drive_ok')
    }
    catch (error) {
      const code = error instanceof AnalysisError ? error.code : undefined
      result.drive = code === 'network_drive_unsupported'
        ? check(false, 'drive_unsupported')
        : check(false, code === 'drive_unavailable' ? 'drive_unavailable' : 'drive_failed', { detail: detail(error) })
    }
  }

  if (!settings.folder.trim()) {
    result.folder = check(false, 'folder_not_configured')
  }
  else {
    try {
      const scan = await scanFolder(settings, signal)
      result.folder = check(true, 'folder_ok', { params: { count: scan.items.length, skipped: scan.skipped.length, folder: settings.folder.trim() } })
    }
    catch (error) {
      const code = error instanceof ServiceError ? error.message : ''
      result.folder = check(false, code === 'folder_not_found' ? 'folder_not_found' : 'folder_unreadable', { detail: detail((error as { data?: { details?: string } }).data?.details ?? error) })
    }
  }

  if (!ctx.worker.enabled) {
    result.worker = check(false, 'worker_not_configured')
  }
  else if (!ctx.worker.connected) {
    result.worker = check(false, 'worker_unreachable', { detail: ctx.worker.info().lastError ?? undefined })
  }
  else {
    try {
      const status = await ctx.worker.status(5000)
      result.worker = check(status.eplan !== 'failed', status.eplan === 'failed' ? 'worker_failed' : 'worker_ok', {
        params: { version: ctx.worker.info().version ?? '', eplan: status.eplan, eplanVersion: status.eplanVersion ?? '' },
      })
    }
    catch (error) {
      result.worker = check(false, 'worker_unreachable', { detail: detail(error) })
    }
  }
  return result as ConnectionTestResult
}

/** Vorschau der nächsten Ausführungen für das Formular */
export function cronPreview(actor: Actor, cron: string, timezone: string, count = 5): CronPreview {
  requireAdmin(actor)
  const runs = previewRuns(cron, timezone, count)
  return { valid: runs.length > 0, nextRuns: runs.map(d => d.toISOString()) }
}

/**
 * Worker neu starten (Admin): `exit`, danach verbindet sich der Client neu (der Dienst startet den Worker über seine
 * Wiederherstellungsaktionen neu). Eine laufende Analyse scheitert dabei mit `worker_disconnected`.
 */
export async function restartWorker(ctx: AppContext, actor: Actor, via: Via = 'ui'): Promise<{ restarted: boolean }> {
  requireAdmin(actor)
  if (!ctx.worker.enabled) throw new ServiceError(409, 'worker_not_configured')
  if (!ctx.worker.connected) throw new ServiceError(409, 'worker_unreachable')
  await ctx.worker.restart()
  await writeAudit(ctx.db, actor.id, 'worker_restarted', { via })
  return { restarted: true }
}
