import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely, Selectable } from 'kysely'
import type { AppDatabase, ProjectsTable } from '../database/types'
import type { AnalysisInfo, DeleteResponse, Paged, ProjectDetail, ProjectInfo, ProjectQuery, Via } from '../../shared/types/api'
import type { Actor } from './access'
import { requireAdmin, requireUser } from './access'
import { analysesWithProject, findAnalyses, toAnalysisInfo } from './analyses'
import { writeAudit } from './audit'
import type { AppContext } from './context'
import { ServiceError, notFound } from './errors'
import { containsText, paging } from './sql'

type ProjectRow = Selectable<ProjectsTable> & { createdByName: string | null }

const projectsWithUser = (db: Kysely<AppDatabase>) => db.selectFrom('pds.projects as p')
  .leftJoin('core.users as u', 'u.id', 'p.createdBy')
  .selectAll('p')
  .select('u.displayName as createdByName')

/** Ordner der hochgeladenen Dateien eines Projekts */
export const uploadDir = (dataDir: string, projectId: number) => join(dataDir, 'uploads', String(projectId))

/** Projekte mit aktuellem und neuestem Stand (zwei Abfragen für die ganze Seite statt einer je Projekt) */
async function withAnalyses(db: Kysely<AppDatabase>, rows: ProjectRow[]): Promise<ProjectInfo[]> {
  if (!rows.length) return []
  const ids = rows.map(row => row.id)
  const latest = new Map<number, number>()
  for (let i = 0; i < ids.length; i += 500) {
    const part = await db.selectFrom('pds.analyses')
      .select(['projectId', eb => eb.fn.max('id').as('id')])
      .where('projectId', 'in', ids.slice(i, i + 500))
      .groupBy('projectId')
      .execute()
    for (const row of part) latest.set(row.projectId, Number(row.id))
  }
  const analyses = await findAnalyses(db, [...rows.map(row => row.currentAnalysisId).filter((id): id is number => id !== null), ...latest.values()])
  return rows.map(row => toProjectInfo(row, analyses.get(row.currentAnalysisId ?? -1) ?? null, analyses.get(latest.get(row.id) ?? -1) ?? null))
}

function toProjectInfo(row: ProjectRow, current: AnalysisInfo | null, latest: AnalysisInfo | null): ProjectInfo {
  return {
    id: row.id,
    source: row.source,
    name: row.name,
    path: row.path,
    fileKind: row.fileKind,
    sourceModified: row.sourceModified?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdByName,
    updatedAt: row.updatedAt.toISOString(),
    currentAnalysis: current,
    latestAnalysis: latest,
  }
}

/** Projekte mit Suche (Name oder Pfad) und Quelle; Standard nach Name */
export async function listProjects(db: Kysely<AppDatabase>, actor: Actor, query: ProjectQuery = {}): Promise<Paged<ProjectInfo>> {
  requireUser(actor)
  const { pageSize, offset } = paging(query.page, query.pageSize, 200)
  const search = query.search?.trim()
  let base = db.selectFrom('pds.projects as p')
  let rows = projectsWithUser(db)
  if (search) {
    base = base.where(eb => eb.or([containsText(eb.ref('p.name'), search), containsText(eb.ref('p.path'), search)]))
    rows = rows.where(eb => eb.or([containsText(eb.ref('p.name'), search), containsText(eb.ref('p.path'), search)]))
  }
  if (query.source) {
    base = base.where('p.source', '=', query.source)
    rows = rows.where('p.source', '=', query.source)
  }
  rows = query.sort === 'updated' ? rows.orderBy('p.updatedAt', 'desc').orderBy('p.id', 'desc') : rows.orderBy('p.name').orderBy('p.id')
  const [items, count] = await Promise.all([
    rows.offset(offset).fetch(pageSize).execute(),
    base.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { items: await withAnalyses(db, items), total: Number(count.count) }
}

/** Ein Projekt ohne Rechteprüfung */
export async function findProject(db: Kysely<AppDatabase>, id: number): Promise<ProjectInfo | undefined> {
  const row = await projectsWithUser(db).where('p.id', '=', id).executeTakeFirst()
  if (!row) return undefined
  return (await withAnalyses(db, [row]))[0]
}

/** Projekt mit allen Ständen, neueste zuerst (höchstens 1000) */
export async function getProject(db: Kysely<AppDatabase>, actor: Actor, id: number): Promise<ProjectDetail> {
  requireUser(actor)
  const project = await findProject(db, id)
  if (!project) throw notFound()
  const rows = await analysesWithProject(db).where('a.projectId', '=', id).orderBy('a.id', 'desc').top(1000).execute()
  return { ...project, analyses: rows.map(toAnalysisInfo) }
}

/**
 * Projekt mit allen Ständen löschen (Admin). Nicht während seiner Analyse (409 `analysis_running`). Hochgeladene
 * Dateien werden mit gelöscht; Dateien im Projektordner bleiben unberührt.
 */
export async function deleteProject(ctx: AppContext, actor: Actor, id: number, via: Via = 'ui'): Promise<DeleteResponse> {
  requireAdmin(actor)
  const project = await ctx.db.selectFrom('pds.projects').select(['id', 'name', 'source', 'path']).where('id', '=', id).executeTakeFirst()
  if (!project) throw notFound()
  await ctx.db.transaction().execute(async (trx) => {
    const running = await trx.selectFrom('pds.analyses').select('id').where('projectId', '=', id).where('status', '=', 'running').executeTakeFirst()
    if (running) throw new ServiceError(409, 'analysis_running')
    // Verweis auf die aktuelle Analyse zuerst lösen (Fremdschlüssel ohne Cascade), dann alles per Cascade. Die
    // Bedingung steht nochmals in derselben Anweisung: die Warteschlange könnte gerade einen Auftrag übernommen haben
    await trx.updateTable('pds.projects').set({ currentAnalysisId: null }).where('id', '=', id).execute()
    const deleted = await trx.deleteFrom('pds.projects')
      .where('id', '=', id)
      .where(eb => eb.not(eb.exists(eb.selectFrom('pds.analyses as a').select('a.id').where('a.projectId', '=', id).where('a.status', '=', 'running'))))
      .executeTakeFirst()
    if (Number(deleted.numDeletedRows) === 0) throw new ServiceError(409, 'analysis_running')
  })
  if (project.source === 'upload') await rm(uploadDir(ctx.dataDir, id), { recursive: true, force: true }).catch(() => {})
  await writeAudit(ctx.db, actor.id, 'project_deleted', { projectId: id, name: project.name, source: project.source, path: project.path, via })
  return { id }
}
