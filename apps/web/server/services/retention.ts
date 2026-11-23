import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FINISHED_ANALYSIS_STATUSES, OPEN_ANALYSIS_STATUSES } from '../../shared/types/api'
import type { AppContext } from './context'
import { loadSettings } from './settings'

export interface RetentionResult {
  /** gelöschte Analysen (mit Ergebnissen und Ereignissen) */
  analyses: number
  /** gelöschte hochgeladene Dateien (je Hochladen ein Ordner) */
  uploads: number
  /** gelöschte Arbeitsordner (Reste nach Abstürzen) */
  workFolders: number
}

const DAY_MS = 86_400_000
/** Abgebrochene Uploads (uploads/.incoming) älter als das */
const INCOMING_MAX_AGE_MS = DAY_MS

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  }
  catch {
    return []
  }
}

/**
 * Aufbewahrung (täglich und zu Beginn eines Zeitplan-Laufs):
 * - beendete Analysen, älter als `retentionDays`, löschen – außer dem aktuellen Stand je Projekt; einzeln, damit
 *   keine Transaktion zehntausende Zeilen auf einmal sperrt;
 * - hochgeladene Dateien löschen, die kein Auftrag mehr braucht: Es bleiben die neueste Datei je Projekt (für
 *   „Erneut analysieren“), die des aktuellen Stands und die offener Aufträge;
 * - verwaiste Arbeitsordner und abgebrochene Uploads entfernen.
 */
export async function runRetention(ctx: AppContext, now: Date = ctx.now()): Promise<RetentionResult> {
  const { db } = ctx
  const { settings } = await loadSettings(ctx)
  const threshold = new Date(now.getTime() - settings.retentionDays * DAY_MS)

  const old = await db.selectFrom('pds.analyses as a')
    .select('a.id')
    .where('a.status', 'in', [...FINISHED_ANALYSIS_STATUSES])
    .where(eb => eb(eb.fn.coalesce('a.finishedAt', 'a.queuedAt'), '<', threshold))
    .where(eb => eb.not(eb.exists(eb.selectFrom('pds.projects as p').select('p.id').whereRef('p.currentAnalysisId', '=', 'a.id'))))
    .orderBy('a.id')
    .execute()
  let analyses = 0
  for (const { id } of old) {
    // Nochmals geprüft: inzwischen aktueller Stand geworden (sehr unwahrscheinlich) ⇒ stehen lassen
    const result = await db.deleteFrom('pds.analyses')
      .where('id', '=', id)
      .where(eb => eb.not(eb.exists(eb.selectFrom('pds.projects as p').select('p.id').where('p.currentAnalysisId', '=', id))))
      .executeTakeFirst()
    analyses += Number(result.numDeletedRows)
  }

  // Hochgeladene Dateien, die noch gebraucht werden: uploads/<projectId>/<uploadId>/<Datei>
  const projects = await db.selectFrom('pds.projects').select(['id', 'uploadFile', 'currentAnalysisId']).where('source', '=', 'upload').execute()
  const needed = await db.selectFrom('pds.analyses as a')
    .innerJoin('pds.projects as p', 'p.id', 'a.projectId')
    .select(['a.projectId', 'a.uploadFile'])
    .where('p.source', '=', 'upload')
    .where('a.uploadFile', 'is not', null)
    .where(eb => eb.or([eb('a.status', 'in', [...OPEN_ANALYSIS_STATUSES]), eb('a.id', '=', eb.ref('p.currentAnalysisId'))]))
    .execute()
  const keep = new Map<string, Set<string>>(projects.map(project => [String(project.id), new Set<string>()]))
  const uploadId = (file: string | null) => file?.split('/')[0]
  for (const project of projects) {
    const id = uploadId(project.uploadFile)
    if (id) keep.get(String(project.id))!.add(id)
  }
  for (const row of needed) {
    const id = uploadId(row.uploadFile)
    if (id) keep.get(String(row.projectId))?.add(id)
  }

  let uploads = 0
  const uploadsRoot = join(ctx.dataDir, 'uploads')
  for (const name of await listDir(uploadsRoot)) {
    const path = join(uploadsRoot, name)
    if (name === '.incoming') {
      for (const part of await listDir(path)) {
        const file = join(path, part)
        const info = await stat(file).catch(() => null)
        if (info && now.getTime() - info.mtimeMs > INCOMING_MAX_AGE_MS) await rm(file, { force: true }).catch(() => {})
      }
      continue
    }
    const wanted = keep.get(name)
    if (!wanted) {
      // Projekt gibt es nicht mehr
      await rm(path, { recursive: true, force: true }).catch(() => {})
      continue
    }
    for (const entry of await listDir(path)) {
      if (wanted.has(entry)) continue
      await rm(join(path, entry), { recursive: true, force: true }).catch(() => {})
      uploads++
    }
  }

  // Arbeitsordner: nur der laufenden Analyse dieses Prozesses bleibt
  let workFolders = 0
  const workRoot = join(ctx.dataDir, 'work')
  const running = await db.selectFrom('pds.analyses').select('id').where('status', '=', 'running').execute()
  const active = new Set(running.map(row => String(row.id)))
  for (const name of await listDir(workRoot)) {
    if (active.has(name)) continue
    await rm(join(workRoot, name), { recursive: true, force: true }).catch(() => {})
    workFolders++
  }

  if (analyses || uploads || workFolders)
    ctx.log(`[retention] ${analyses} Analysen, ${uploads} hochgeladene Dateien, ${workFolders} Arbeitsordner gelöscht (Aufbewahrung ${settings.retentionDays} Tage)`)
  return { analyses, uploads, workFolders }
}
