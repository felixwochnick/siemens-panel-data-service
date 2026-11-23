import type { Insertable, Kysely } from 'kysely'
import type { AnalysisResult } from '@pds/analyzer'
import type { AnalysisEventsTable, AppDatabase, CableWiresTable, CablesTable, ConnectionsTable, ShieldWiresTable, ShieldsTable, TextsTable } from '../database/types'
import type { CableRow, CablesResponse, ConnectionRow, ConnectionsResponse, ShieldsResponse, TextsResponse } from '../../shared/types/api'
import type { Actor } from './access'
import { requireUser } from './access'
import { ServiceError, notFound } from './errors'
import { chunk, containsText, rowsPerStatement } from './sql'

export interface ResultMeta {
  eplanProjectName: string | null
  eplanVersion: string | null
  workerVersion: string | null
  sourceModified: Date | null
}

/** Zeilen in Stücken einfügen; Stückgröße aus der Spaltenzahl (SQL Server: höchstens 2100 Parameter je Anweisung) */
async function insertChunked<T extends keyof AppDatabase & `pds.${string}`>(trx: Kysely<AppDatabase>, table: T, rows: Insertable<AppDatabase[T]>[]): Promise<void> {
  if (!rows.length) return
  const size = rowsPerStatement(Object.keys(rows[0]!).length)
  for (const part of chunk(rows, size)) await trx.insertInto(table).values(part as never).execute()
}

/**
 * Ergebnisse einer Analyse speichern – in **einer** Transaktion: alle Zeilen, dann als letzte Anweisungen Status
 * `succeeded` mit Zählern und `projects.current_analysis_id`. Ein Leser sieht so nie einen halben Stand: vorher den
 * alten aktuellen Stand, danach den neuen. Der aktuelle Stand springt nur vorwärts (neuere Analyse gewinnt).
 */
export async function saveResults(db: Kysely<AppDatabase>, options: {
  analysisId: number
  projectId: number
  result: AnalysisResult
  meta: ResultMeta
  now: Date
  /** Ereignisse, die mit dem Erfolg zusammen sichtbar werden sollen */
  events?: Insertable<AnalysisEventsTable>[]
}): Promise<void> {
  const { analysisId, projectId, result, meta, now } = options
  const connections: Insertable<ConnectionsTable>[] = result.connections.map(row => ({
    analysisId,
    idx: row.idx,
    eplanId: row.eplanId,
    page: row.page,
    definition: row.definition,
    designation: row.designation,
    source: row.source,
    destination: row.destination,
    cable: row.cable,
    wireNumber: row.wireNumber,
    crossSection: row.crossSection,
    wireType: row.wireType,
    length: row.length,
    partNumbers: row.partNumbers,
    hashMark: row.hashMark,
    twisted: row.twisted,
    shielded: row.shielded,
  }))
  const cables: Insertable<CablesTable>[] = result.cables.map(row => ({
    analysisId,
    idx: row.idx,
    kind: row.kind,
    name: row.name,
    definition: row.definition,
    page: row.page,
    source: row.source,
    destination: row.destination,
    type: row.type,
    wireCountAndCrossSection: row.wireCountAndCrossSection,
    length: row.length,
    partNumbers: row.partNumbers,
  }))
  const cableWires: Insertable<CableWiresTable>[] = result.cables.flatMap(cable => cable.wires.map(wire => ({
    analysisId,
    cableIdx: cable.idx,
    idx: wire.idx,
    connectionIdx: wire.connectionIdx,
    definition: wire.definition,
    page: wire.page,
    source: wire.source,
    destination: wire.destination,
    length: wire.length,
    wireNumber: wire.wireNumber,
    crossSection: wire.crossSection,
    partNumbers: wire.partNumbers,
  })))
  const shields: Insertable<ShieldsTable>[] = result.shields.map(row => ({
    analysisId,
    idx: row.idx,
    page: row.page,
    name: row.name,
    type: row.type,
    wireCountAndCrossSection: row.wireCountAndCrossSection,
  }))
  const shieldWires: Insertable<ShieldWiresTable>[] = result.shields.flatMap(shield => shield.connectionIdx.map((connectionIdx, idx) => ({
    analysisId,
    shieldIdx: shield.idx,
    idx,
    connectionIdx,
  })))
  const texts: Insertable<TextsTable>[] = result.texts.map(row => ({ analysisId, idx: row.idx, page: row.page, text: row.text }))
  const counts = result.counts

  // SQLite hat eine Verbindung: in der Transaktion nur trx
  await db.transaction().execute(async (trx) => {
    await insertChunked(trx, 'pds.connections', connections)
    await insertChunked(trx, 'pds.cables', cables)
    await insertChunked(trx, 'pds.cableWires', cableWires)
    await insertChunked(trx, 'pds.shields', shields)
    await insertChunked(trx, 'pds.shieldWires', shieldWires)
    await insertChunked(trx, 'pds.texts', texts)
    await insertChunked(trx, 'pds.analysisEvents', options.events ?? [])
    const updated = await trx.updateTable('pds.analyses')
      .set({
        status: 'succeeded',
        stage: null,
        finishedAt: now,
        errorCode: null,
        errorDetail: null,
        eplanProjectName: meta.eplanProjectName?.slice(0, 400) ?? null,
        eplanVersion: meta.eplanVersion?.slice(0, 50) ?? null,
        workerVersion: meta.workerVersion?.slice(0, 50) ?? null,
        sourceModified: meta.sourceModified,
        countConnections: counts.connections,
        countHashMarks: counts.hashMarks,
        countUnmatchedHashMarks: counts.unmatchedHashMarks,
        countTwisted: counts.twisted,
        countTwistSymbols: counts.twistSymbols,
        countUnmatchedTwistTicks: counts.unmatchedTwistTicks,
        countShielded: counts.shielded,
        countShields: counts.shields,
        countCables: counts.cables,
        countTexts: counts.texts,
        countPages: counts.pages,
      })
      .where('id', '=', analysisId)
      .where('status', '=', 'running')
      .executeTakeFirst()
    // Analyse inzwischen gelöscht oder nicht mehr laufend: nichts übernehmen
    if (Number(updated.numUpdatedRows) !== 1) throw new ServiceError(409, 'analysis_not_running')
    await trx.updateTable('pds.projects')
      .set({ currentAnalysisId: analysisId, updatedAt: now })
      .where('id', '=', projectId)
      .where(eb => eb.or([eb('currentAnalysisId', 'is', null), eb('currentAnalysisId', '<', analysisId)]))
      .execute()
  })
}

/** Analyse mit Ergebnissen: existiert (404) und ist erfolgreich (409 `analysis_not_succeeded`) */
async function succeededAnalysis(db: Kysely<AppDatabase>, analysisId: number): Promise<{ analysisId: number, projectId: number }> {
  const row = await db.selectFrom('pds.analyses').select(['id', 'projectId', 'status']).where('id', '=', analysisId).executeTakeFirst()
  if (!row) throw notFound()
  if (row.status !== 'succeeded') throw new ServiceError(409, 'analysis_not_succeeded', { status: row.status })
  return { analysisId: row.id, projectId: row.projectId }
}

/**
 * Welche Analyse gemeint ist: `analysisId` oder der aktuelle Stand des Projekts (404 `no_current_analysis`, wenn es
 * noch keinen erfolgreichen gibt). Eines von beiden ist Pflicht (400 `project_or_analysis_required`).
 */
export async function resolveResultAnalysis(db: Kysely<AppDatabase>, target: { projectId?: number, analysisId?: number }): Promise<{ analysisId: number, projectId: number }> {
  if (target.analysisId !== undefined) {
    const result = await succeededAnalysis(db, target.analysisId)
    if (target.projectId !== undefined && result.projectId !== target.projectId) throw notFound()
    return result
  }
  if (target.projectId === undefined) throw new ServiceError(400, 'project_or_analysis_required')
  const project = await db.selectFrom('pds.projects').select(['id', 'currentAnalysisId']).where('id', '=', target.projectId).executeTakeFirst()
  if (!project) throw notFound()
  if (project.currentAnalysisId === null) throw new ServiceError(404, 'no_current_analysis')
  return { analysisId: project.currentAnalysisId, projectId: project.id }
}

const connectionColumns = [
  'idx', 'eplanId', 'page', 'definition', 'designation', 'source', 'destination', 'cable', 'wireNumber', 'crossSection',
  'wireType', 'length', 'partNumbers', 'hashMark', 'twisted', 'shielded',
] as const

/** Booleans kommen je nach Datenbank als bit/0/1: auf boolean bringen */
const toConnectionRow = (row: Omit<ConnectionsTable, 'analysisId'>): ConnectionRow => ({
  ...row,
  hashMark: !!row.hashMark,
  twisted: !!row.twisted,
  shielded: !!row.shielded,
})

/** Tab „Verbindungen“: alle Zeilen nach idx */
export async function getConnections(db: Kysely<AppDatabase>, actor: Actor, analysisId: number): Promise<ConnectionsResponse> {
  requireUser(actor)
  const target = await succeededAnalysis(db, analysisId)
  const rows = await db.selectFrom('pds.connections').select(connectionColumns).where('analysisId', '=', analysisId).orderBy('idx').execute()
  return { ...target, rows: rows.map(toConnectionRow) }
}

/** Kabel mit eingebetteten Adern (nach idx); optional nur die Kabel `idx` */
async function readCables(db: Kysely<AppDatabase>, analysisId: number, cableIdx?: number[]): Promise<CableRow[]> {
  if (cableIdx && !cableIdx.length) return []
  let cables = db.selectFrom('pds.cables')
    .select(['idx', 'kind', 'name', 'definition', 'page', 'source', 'destination', 'type', 'wireCountAndCrossSection', 'length', 'partNumbers'])
    .where('analysisId', '=', analysisId)
  let wires = db.selectFrom('pds.cableWires')
    .select(['cableIdx', 'idx', 'connectionIdx', 'definition', 'page', 'source', 'destination', 'length', 'wireNumber', 'crossSection', 'partNumbers'])
    .where('analysisId', '=', analysisId)
  if (cableIdx) {
    cables = cables.where('idx', 'in', cableIdx)
    wires = wires.where('cableIdx', 'in', cableIdx)
  }
  const [cableRows, wireRows] = await Promise.all([cables.orderBy('idx').execute(), wires.orderBy('cableIdx').orderBy('idx').execute()])
  const byCable = new Map<number, CableRow['wires']>()
  for (const { cableIdx: owner, ...wire } of wireRows) {
    const list = byCable.get(owner) ?? []
    list.push(wire)
    byCable.set(owner, list)
  }
  return cableRows.map(cable => ({ ...cable, wires: byCable.get(cable.idx) ?? [] }))
}

/** Tab „Kabel“: Kabel und Schirme (Kabelnavigator) mit ihren Adern */
export async function getCables(db: Kysely<AppDatabase>, actor: Actor, analysisId: number): Promise<CablesResponse> {
  requireUser(actor)
  const target = await succeededAnalysis(db, analysisId)
  return { ...target, rows: await readCables(db, analysisId) }
}

async function readShields(db: Kysely<AppDatabase>, analysisId: number, limit?: { offset: number, fetch: number }) {
  let shields = db.selectFrom('pds.shields').select(['idx', 'page', 'name', 'type', 'wireCountAndCrossSection']).where('analysisId', '=', analysisId).orderBy('idx')
  if (limit) shields = shields.offset(limit.offset).fetch(limit.fetch)
  const shieldRows = await shields.execute()
  if (!shieldRows.length) return []
  let wires = db.selectFrom('pds.shieldWires').select(['shieldIdx', 'connectionIdx']).where('analysisId', '=', analysisId)
  if (limit) wires = wires.where('shieldIdx', '>=', shieldRows[0]!.idx).where('shieldIdx', '<=', shieldRows.at(-1)!.idx)
  const wireRows = await wires.orderBy('shieldIdx').orderBy('idx').execute()
  const byShield = new Map<number, number[]>()
  for (const wire of wireRows) {
    const list = byShield.get(wire.shieldIdx) ?? []
    list.push(wire.connectionIdx)
    byShield.set(wire.shieldIdx, list)
  }
  return shieldRows.map(shield => ({ ...shield, connectionIdx: byShield.get(shield.idx) ?? [] }))
}

/** Tab „Schirme“: je Schirm die Indizes der abgeschirmten Verbindungen */
export async function getShields(db: Kysely<AppDatabase>, actor: Actor, analysisId: number): Promise<ShieldsResponse> {
  requireUser(actor)
  const target = await succeededAnalysis(db, analysisId)
  return { ...target, rows: await readShields(db, analysisId) }
}

/** Tab „Texte“ */
export async function getTexts(db: Kysely<AppDatabase>, actor: Actor, analysisId: number): Promise<TextsResponse> {
  requireUser(actor)
  const target = await succeededAnalysis(db, analysisId)
  const rows = await db.selectFrom('pds.texts').select(['idx', 'page', 'text']).where('analysisId', '=', analysisId).orderBy('idx').execute()
  return { ...target, rows }
}

// ── Abfragen für MCP (gefiltert, seitenweise) ─────────────────────────────────

export interface ResultTarget {
  projectId?: number
  analysisId?: number
}

export interface Page {
  limit: number
  offset: number
}

export interface ConnectionFilter {
  /** Seite enthält */
  page?: string
  /** Kabel enthält */
  cable?: string
  /** Verbindungsbezeichnung enthält */
  designation?: string
  /** Quelle oder Ziel enthält */
  endpoint?: string
  hashMark?: boolean
  twisted?: boolean
  shielded?: boolean
}

const clampPage = (page: Page) => ({ limit: Math.min(Math.max(Math.trunc(page.limit), 1), 1000), offset: Math.max(Math.trunc(page.offset), 0) })

/** Verbindungen eines Stands mit Filtern (enthält, Groß/Klein egal) */
export async function queryConnections(db: Kysely<AppDatabase>, actor: Actor, target: ResultTarget, filter: ConnectionFilter, page: Page) {
  requireUser(actor)
  const { analysisId, projectId } = await resolveResultAnalysis(db, target)
  const { limit, offset } = clampPage(page)
  let base = db.selectFrom('pds.connections as c').where('c.analysisId', '=', analysisId)
  if (filter.page) base = base.where(eb => containsText(eb.ref('c.page'), filter.page!))
  if (filter.cable) base = base.where(eb => containsText(eb.ref('c.cable'), filter.cable!))
  if (filter.designation) base = base.where(eb => containsText(eb.ref('c.designation'), filter.designation!))
  if (filter.endpoint) base = base.where(eb => eb.or([containsText(eb.ref('c.source'), filter.endpoint!), containsText(eb.ref('c.destination'), filter.endpoint!)]))
  if (filter.hashMark !== undefined) base = base.where('c.hashMark', '=', filter.hashMark)
  if (filter.twisted !== undefined) base = base.where('c.twisted', '=', filter.twisted)
  if (filter.shielded !== undefined) base = base.where('c.shielded', '=', filter.shielded)
  const [rows, count] = await Promise.all([
    base.select(connectionColumns.map(column => `c.${column}` as const)).orderBy('c.idx').offset(offset).fetch(limit).execute(),
    base.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { analysisId, projectId, total: Number(count.count), offset, rows: rows.map(toConnectionRow) }
}

/** Kabel (mit Adern) eines Stands; Filter auf Name und Seite */
export async function queryCables(db: Kysely<AppDatabase>, actor: Actor, target: ResultTarget, filter: { name?: string, page?: string, kind?: 'cable' | 'shield' }, page: Page) {
  requireUser(actor)
  const { analysisId, projectId } = await resolveResultAnalysis(db, target)
  const { limit, offset } = clampPage(page)
  let base = db.selectFrom('pds.cables as c').where('c.analysisId', '=', analysisId)
  if (filter.name) base = base.where(eb => containsText(eb.ref('c.name'), filter.name!))
  if (filter.page) base = base.where(eb => containsText(eb.ref('c.page'), filter.page!))
  if (filter.kind) base = base.where('c.kind', '=', filter.kind)
  const [idx, count] = await Promise.all([
    base.select('c.idx').orderBy('c.idx').offset(offset).fetch(limit).execute(),
    base.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { analysisId, projectId, total: Number(count.count), offset, rows: await readCables(db, analysisId, idx.map(row => row.idx)) }
}

/** Schirme eines Stands mit den Indizes der abgeschirmten Verbindungen */
export async function listShields(db: Kysely<AppDatabase>, actor: Actor, target: ResultTarget, page: Page) {
  requireUser(actor)
  const { analysisId, projectId } = await resolveResultAnalysis(db, target)
  const { limit, offset } = clampPage(page)
  const count = await db.selectFrom('pds.shields').select(eb => eb.fn.countAll<number>().as('count')).where('analysisId', '=', analysisId).executeTakeFirstOrThrow()
  return { analysisId, projectId, total: Number(count.count), offset, rows: await readShields(db, analysisId, { offset, fetch: limit }) }
}

/** Freie Texte eines Stands; Filter auf Seite und Inhalt */
export async function listTexts(db: Kysely<AppDatabase>, actor: Actor, target: ResultTarget, filter: { page?: string, contains?: string }, page: Page) {
  requireUser(actor)
  const { analysisId, projectId } = await resolveResultAnalysis(db, target)
  const { limit, offset } = clampPage(page)
  let base = db.selectFrom('pds.texts as t').where('t.analysisId', '=', analysisId)
  if (filter.page) base = base.where(eb => containsText(eb.ref('t.page'), filter.page!))
  if (filter.contains) base = base.where(eb => containsText(eb.ref('t.text'), filter.contains!))
  const [rows, count] = await Promise.all([
    base.select(['t.idx', 't.page', 't.text']).orderBy('t.idx').offset(offset).fetch(limit).execute(),
    base.select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
  ])
  return { analysisId, projectId, total: Number(count.count), offset, rows }
}
