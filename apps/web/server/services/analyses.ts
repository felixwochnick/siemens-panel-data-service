import type { Kysely, Selectable } from 'kysely'
import { isUniqueViolation } from '@pds/core/database'
import type { AnalysesTable, AnalysisEventsTable, AppDatabase } from '../database/types'
import { LOG_LEVELS, OPEN_ANALYSIS_STATUSES } from '../../shared/types/api'
import type {
  AnalysisEventInfo,
  AnalysisEventQuery,
  AnalysisInfo,
  AnalysisQuery,
  AnalysisTrigger,
  DeleteResponse,
  Paged,
  ProjectSource,
  StartAnalysisInput,
  StartAnalysisResponse,
  Via,
} from '../../shared/types/api'
import type { Actor } from './access'
import { requireAdmin, requireUser } from './access'
import { writeAudit } from './audit'
import type { AppContext } from './context'
import { ServiceError, notFound } from './errors'
import { resolveFolderProjects } from './folder'
import { paging } from './sql'

type AnalysisRow = Selectable<AnalysesTable> & {
  projectName: string
  projectSource: ProjectSource
  projectCurrentAnalysisId: number | null
  triggeredByName: string | null
}

/** Analysen mit Projekt und Anzeigename des Auslösers */
export const analysesWithProject = (db: Kysely<AppDatabase>) => db.selectFrom('pds.analyses as a')
  .innerJoin('pds.projects as p', 'p.id', 'a.projectId')
  .leftJoin('core.users as u', 'u.id', 'a.triggeredBy')
  .selectAll('a')
  .select(['p.name as projectName', 'p.source as projectSource', 'p.currentAnalysisId as projectCurrentAnalysisId', 'u.displayName as triggeredByName'])

const iso = (date: Date | null) => date?.toISOString() ?? null

export function toAnalysisInfo(row: AnalysisRow): AnalysisInfo {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.projectName,
    projectSource: row.projectSource,
    trigger: row.trigger,
    triggeredBy: row.triggeredByName,
    status: row.status,
    stage: row.status === 'running' ? row.stage : null,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    sourceModified: iso(row.sourceModified),
    eplanProjectName: row.eplanProjectName,
    eplanVersion: row.eplanVersion,
    workerVersion: row.workerVersion,
    counts: row.status === 'succeeded' && row.countConnections !== null
      ? {
          connections: row.countConnections,
          hashMarks: row.countHashMarks ?? 0,
          unmatchedHashMarks: row.countUnmatchedHashMarks ?? 0,
          twisted: row.countTwisted ?? 0,
          twistSymbols: row.countTwistSymbols ?? 0,
          unmatchedTwistTicks: row.countUnmatchedTwistTicks ?? 0,
          shielded: row.countShielded ?? 0,
          shields: row.countShields ?? 0,
          cables: row.countCables ?? 0,
          texts: row.countTexts ?? 0,
          pages: row.countPages ?? 0,
        }
      : null,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    isCurrent: row.projectCurrentAnalysisId === row.id,
  }
}

function parseParams(value: string | null): Record<string, string | number> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

export function toEventInfo(row: Selectable<AnalysisEventsTable>): AnalysisEventInfo {
  return {
    id: String(row.id),
    at: row.at.toISOString(),
    level: row.level,
    code: row.code,
    params: parseParams(row.params),
    detail: row.detail,
  }
}

/** Eine Analyse (ohne Rechteprüfung, für Warteschlange und Status) */
export async function findAnalysis(db: Kysely<AppDatabase>, id: number): Promise<AnalysisInfo | undefined> {
  const row = await analysesWithProject(db).where('a.id', '=', id).executeTakeFirst()
  return row ? toAnalysisInfo(row) : undefined
}

/** Analysen nach ids (Reihenfolge beliebig) */
export async function findAnalyses(db: Kysely<AppDatabase>, ids: number[]): Promise<Map<number, AnalysisInfo>> {
  const unique = [...new Set(ids)]
  const result = new Map<number, AnalysisInfo>()
  // ids einzeln als Parameter: in Blöcken weit unter der Grenze von SQL Server
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await analysesWithProject(db).where('a.id', 'in', unique.slice(i, i + 500)).execute()
    for (const row of rows) result.set(row.id, toAnalysisInfo(row))
  }
  return result
}

/** Analysen, neueste zuerst */
export async function listAnalyses(db: Kysely<AppDatabase>, actor: Actor, query: AnalysisQuery = {}): Promise<Paged<AnalysisInfo>> {
  requireUser(actor)
  const { pageSize, offset } = paging(query.page, query.pageSize, 200)
  let base = db.selectFrom('pds.analyses as a')
  let rows = analysesWithProject(db)
  if (query.projectId !== undefined) {
    base = base.where('a.projectId', '=', query.projectId)
    rows = rows.where('a.projectId', '=', query.projectId)
  }
  if (query.status) {
    base = base.where('a.status', '=', query.status)
    rows = rows.where('a.status', '=', query.status)
  }
  if (query.trigger) {
    base = base.where('a.trigger', '=', query.trigger)
    rows = rows.where('a.trigger', '=', query.trigger)
  }
  const [items, count] = await Promise.all([
    rows.orderBy('a.id', 'desc').offset(offset).fetch(pageSize).execute(),
    base.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { items: items.map(toAnalysisInfo), total: Number(count.count) }
}

export async function getAnalysis(db: Kysely<AppDatabase>, actor: Actor, id: number): Promise<AnalysisInfo> {
  requireUser(actor)
  const analysis = await findAnalysis(db, id)
  if (!analysis) throw notFound()
  return analysis
}

/** Ereignisse einer Analyse, älteste zuerst; optional ab einer Mindeststufe */
export async function listAnalysisEvents(db: Kysely<AppDatabase>, actor: Actor, id: number, query: AnalysisEventQuery = {}): Promise<Paged<AnalysisEventInfo>> {
  requireUser(actor)
  const exists = await db.selectFrom('pds.analyses').select('id').where('id', '=', id).executeTakeFirst()
  if (!exists) throw notFound()
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 500), 1), 5000)
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0)
  let events = db.selectFrom('pds.analysisEvents').where('analysisId', '=', id)
  if (query.level && query.level !== 'debug') events = events.where('level', 'in', LOG_LEVELS.slice(LOG_LEVELS.indexOf(query.level)))
  const [rows, count] = await Promise.all([
    events.selectAll().orderBy('id').offset(offset).fetch(limit).execute(),
    events.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { items: rows.map(toEventInfo), total: Number(count.count) }
}

/** Letzte Ereignisse einer Analyse in zeitlicher Reihenfolge */
export async function recentEvents(db: Kysely<AppDatabase>, analysisId: number, limit = 5): Promise<AnalysisEventInfo[]> {
  const rows = await db.selectFrom('pds.analysisEvents').selectAll().where('analysisId', '=', analysisId).orderBy('id', 'desc').top(limit).execute()
  return rows.reverse().map(toEventInfo)
}

export interface EnqueueOptions {
  projectId: number
  trigger: AnalysisTrigger
  userId: string | null
  /** upload: die hochgeladene Datei dieses Auftrags */
  uploadFile?: string | null
  now?: Date
}

/**
 * Auftrag einreihen. Ein Projekt hat höchstens einen offenen Auftrag (eindeutiger Index, auch über Prozesse hinweg)
 * ⇒ 409 `analysis_already_queued`.
 */
export async function enqueueAnalysis(db: Kysely<AppDatabase>, options: EnqueueOptions): Promise<number> {
  const open = await db.selectFrom('pds.analyses').select('id')
    .where('projectId', '=', options.projectId)
    .where('status', 'in', [...OPEN_ANALYSIS_STATUSES])
    .executeTakeFirst()
  if (open) throw new ServiceError(409, 'analysis_already_queued', { analysisId: open.id })
  try {
    const row = await db.insertInto('pds.analyses')
      .values({
        projectId: options.projectId,
        trigger: options.trigger,
        triggeredBy: options.userId,
        status: 'queued',
        queuedAt: options.now ?? new Date(),
        uploadFile: options.uploadFile ?? null,
      })
      .output('inserted.id')
      .executeTakeFirstOrThrow()
    return row.id
  }
  catch (error) {
    if (isUniqueViolation(error)) throw new ServiceError(409, 'analysis_already_queued')
    throw error
  }
}

/**
 * Analysen starten (Oberfläche: „Analysieren“, MCP): ein bekanntes Projekt (409 `analysis_already_queued`, wenn schon
 * ein Auftrag offen ist) oder Projekte aus dem Projektordner (je Pfad eingereiht oder mit Code übersprungen).
 */
export async function startAnalysis(ctx: AppContext, actor: Actor, input: StartAnalysisInput, via: Via = 'ui'): Promise<StartAnalysisResponse> {
  requireUser(actor)
  const trigger: AnalysisTrigger = via === 'mcp' ? 'mcp' : 'manual'
  const queuedIds: number[] = []
  const skipped: StartAnalysisResponse['skipped'] = []

  if ('projectId' in input) {
    const project = await ctx.db.selectFrom('pds.projects').select(['id', 'source', 'uploadFile']).where('id', '=', input.projectId).executeTakeFirst()
    if (!project) throw notFound()
    queuedIds.push(await enqueueAnalysis(ctx.db, { projectId: project.id, trigger, userId: actor.id, uploadFile: project.uploadFile, now: ctx.now() }))
  }
  else {
    const resolved = await resolveFolderProjects(ctx, actor, input.folderPaths)
    for (const entry of resolved) {
      if ('code' in entry) {
        skipped.push({ target: entry.path, code: entry.code })
        continue
      }
      try {
        queuedIds.push(await enqueueAnalysis(ctx.db, { projectId: entry.projectId, trigger, userId: actor.id, now: ctx.now() }))
      }
      catch (error) {
        if (!(error instanceof ServiceError) || error.statusCode !== 409) throw error
        skipped.push({ target: entry.path, code: error.message })
      }
    }
  }

  for (const analysisId of queuedIds) await writeAudit(ctx.db, actor.id, 'analysis_started', { analysisId, via })
  if (queuedIds.length) ctx.queue.kick()
  const infos = await findAnalyses(ctx.db, queuedIds)
  return { queued: queuedIds.map(id => infos.get(id)!).filter(Boolean), skipped }
}

/**
 * Analyse löschen (Admin): nur wartende oder beendete (409 `analysis_running`). War sie der aktuelle Stand, wird die
 * vorige erfolgreiche Analyse des Projekts zum aktuellen Stand.
 */
export async function deleteAnalysis(ctx: AppContext, actor: Actor, id: number, via: Via = 'ui'): Promise<DeleteResponse> {
  requireAdmin(actor)
  const analysis = await ctx.db.selectFrom('pds.analyses').select(['id', 'projectId', 'status']).where('id', '=', id).executeTakeFirst()
  if (!analysis) throw notFound()
  if (analysis.status === 'running') throw new ServiceError(409, 'analysis_running')
  await ctx.db.transaction().execute(async (trx) => {
    const project = await trx.selectFrom('pds.projects').select('currentAnalysisId').where('id', '=', analysis.projectId).executeTakeFirstOrThrow()
    if (project.currentAnalysisId === id) {
      const previous = await trx.selectFrom('pds.analyses').select('id')
        .where('projectId', '=', analysis.projectId)
        .where('status', '=', 'succeeded')
        .where('id', '<>', id)
        .orderBy('id', 'desc')
        .top(1)
        .executeTakeFirst()
      await trx.updateTable('pds.projects').set({ currentAnalysisId: previous?.id ?? null }).where('id', '=', analysis.projectId).execute()
    }
    // Ergebnisse und Ereignisse per Cascade; Status nochmals prüfen (könnte gerade gestartet sein)
    const result = await trx.deleteFrom('pds.analyses').where('id', '=', id).where('status', '<>', 'running').executeTakeFirst()
    if (Number(result.numDeletedRows) === 0) throw new ServiceError(409, 'analysis_running')
  })
  await writeAudit(ctx.db, actor.id, 'analysis_deleted', { analysisId: id, projectId: analysis.projectId, via })
  return { id }
}
