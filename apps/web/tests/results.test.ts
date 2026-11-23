import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InsertQueryNode, ValuesNode } from 'kysely'
import type { KyselyPlugin, QueryId, RootOperationNode } from 'kysely'
import { createDatabase } from '@pds/core/database'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import type { Actor } from '../server/services/access'
import { getAnalysis } from '../server/services/analyses'
import { getCables, getConnections, getShields, getTexts, listShields, listTexts, queryCables, queryConnections, saveResults } from '../server/services/results'
import { createAppTestDatabase, createRunningAnalysis, createUser, syntheticResult } from './helpers/db'
import { withFaults } from './helpers/faults'

let t: TestDatabase<AppDatabase>
let member: Actor

const meta = { eplanProjectName: 'Gross', eplanVersion: '2025.0.3', workerVersion: '1.0.0', sourceModified: new Date('2026-11-01T00:00:00.000Z') }

beforeAll(async () => {
  t = await createAppTestDatabase('results')
  member = await createUser(t.db)
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
})
afterAll(async () => {
  await t?.destroy()
})

/** Name der Tabelle einer INSERT-Anweisung (ohne Schema/Präfix) */
const tableOf = (node: InsertQueryNode) => node.into?.table.identifier.name.replace(/^pds_/, '')

/**
 * Beobachtet die Anweisungen: zählt Parameter je INSERT und ruft nach dem ersten Block in `pds.connections` einen
 * Leser auf einer zweiten Verbindung auf (mitten in der Transaktion)
 */
function observer(onMidway: () => Promise<void>) {
  const inserts = new Map<QueryId, string>()
  const stats = { maxParameters: 0, statements: 0 }
  let fired = false
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (InsertQueryNode.is(node)) {
        const values = node.values && ValuesNode.is(node.values) ? node.values.values : []
        const parameters = values.reduce((sum, row) => sum + row.values.length, 0)
        stats.maxParameters = Math.max(stats.maxParameters, parameters)
        stats.statements++
        inserts.set(queryId, tableOf(node) ?? '')
      }
      return node as RootOperationNode
    },
    async transformResult({ result, queryId }) {
      if (!fired && inserts.get(queryId) === 'connections') {
        fired = true
        await onMidway()
      }
      return result
    },
  }
  return { plugin, stats }
}

describe('Ergebnisse speichern', () => {
  it('20 000 Verbindungen: Stücke unter 2100 Parametern, eine Transaktion, Leser sieht bis zum Ende den alten Stand', async () => {
    const old = await createRunningAnalysis(t.db, { name: 'Gross' })
    await saveResults(t.db, { analysisId: old.analysisId, projectId: old.projectId, result: syntheticResult(3, 'alt'), meta, now: new Date() })
    const next = await createRunningAnalysis(t.db, { projectId: old.projectId })

    // Zweite Verbindung (SQL Server: Zeilenversionen, SQLite: WAL) – sieht nur Bestätigtes
    const reader = createDatabase<AppDatabase>(t.url)
    const seen: Record<string, unknown> = {}
    try {
      const { plugin, stats } = observer(async () => {
        const view = await reader.selectFrom('pds.vCurrentConnections').select(['analysisId', 'eplanId']).where('projectId', '=', old.projectId).execute()
        const fresh = await reader.selectFrom('pds.connections').select(eb => eb.fn.countAll<number>().as('count')).where('analysisId', '=', next.analysisId).executeTakeFirstOrThrow()
        const status = await reader.selectFrom('pds.analyses').select('status').where('id', '=', next.analysisId).executeTakeFirstOrThrow()
        Object.assign(seen, { view: view.map(r => r.eplanId), fresh: Number(fresh.count), status: status.status })
      })
      const result = syntheticResult(20_000, 'neu')
      await saveResults(t.db.withPlugin(plugin), { analysisId: next.analysisId, projectId: old.projectId, result, meta, now: new Date() })

      expect(seen).toEqual({ view: ['alt-0', 'alt-1', 'alt-2'], fresh: 0, status: 'running' })
      expect(stats.maxParameters).toBeLessThan(2100)
      expect(stats.statements).toBeGreaterThan(100)

      const after = await reader.selectFrom('pds.vCurrentConnections').select(eb => eb.fn.countAll<number>().as('count')).where('projectId', '=', old.projectId).executeTakeFirstOrThrow()
      expect(Number(after.count)).toBe(20_000)
      const stored = await getConnections(t.db, member, next.analysisId)
      expect(stored.rows).toHaveLength(20_000)
      expect(stored.rows[19_999]).toEqual(result.connections[19_999])
      expect(await getAnalysis(t.db, member, next.analysisId)).toMatchObject({ status: 'succeeded', isCurrent: true, eplanProjectName: 'Gross', counts: { connections: 20_000 }, sourceModified: meta.sourceModified.toISOString() })
    }
    finally {
      await reader.destroy()
    }
  })

  it('Fehler mitten im Speichern ⇒ nichts gespeichert, alter Stand bleibt aktuell', async () => {
    const old = await createRunningAnalysis(t.db, { name: 'Fehler' })
    await saveResults(t.db, { analysisId: old.analysisId, projectId: old.projectId, result: syntheticResult(2, 'alt'), meta, now: new Date() })
    const next = await createRunningAnalysis(t.db, { projectId: old.projectId })
    const faults = withFaults(t.db)
    faults.fail('InsertQueryNode', 'texts')
    await expect(saveResults(faults.db, { analysisId: next.analysisId, projectId: old.projectId, result: syntheticResult(500, 'neu'), meta, now: new Date() })).rejects.toThrow()
    const count = await t.db.selectFrom('pds.connections').select(eb => eb.fn.countAll<number>().as('count')).where('analysisId', '=', next.analysisId).executeTakeFirstOrThrow()
    expect(Number(count.count)).toBe(0)
    expect(await getAnalysis(t.db, member, next.analysisId)).toMatchObject({ status: 'running', isCurrent: false })
    const project = await t.db.selectFrom('pds.projects').select('currentAnalysisId').where('id', '=', old.projectId).executeTakeFirstOrThrow()
    expect(project.currentAnalysisId).toBe(old.analysisId)
  })

  it('ein älterer Auftrag, der später fertig wird, verdrängt den neueren Stand nicht', async () => {
    const a = await createRunningAnalysis(t.db, { name: 'Reihe' })
    // vorübergehend beendet, damit eine zweite Analyse laufen darf (eindeutiger Index für offene Aufträge)
    await t.db.updateTable('pds.analyses').set({ status: 'aborted' }).where('id', '=', a.analysisId).execute()
    const b = await createRunningAnalysis(t.db, { projectId: a.projectId })
    await saveResults(t.db, { analysisId: b.analysisId, projectId: a.projectId, result: syntheticResult(1, 'b'), meta, now: new Date() })
    await t.db.updateTable('pds.analyses').set({ status: 'running' }).where('id', '=', a.analysisId).execute()
    await saveResults(t.db, { analysisId: a.analysisId, projectId: a.projectId, result: syntheticResult(1, 'a'), meta, now: new Date() })
    const project = await t.db.selectFrom('pds.projects').select('currentAnalysisId').where('id', '=', a.projectId).executeTakeFirstOrThrow()
    expect(project.currentAnalysisId).toBe(b.analysisId)
  })
})

describe('Ergebnisse lesen', () => {
  async function seeded() {
    const run = await createRunningAnalysis(t.db, { name: 'Lesen' })
    const result = syntheticResult(30, 'r')
    await saveResults(t.db, { analysisId: run.analysisId, projectId: run.projectId, result, meta, now: new Date() })
    return { ...run, result }
  }

  it('je Tab komplett: Kabel mit Adern, Schirme mit Indizes', async () => {
    const { analysisId, projectId, result } = await seeded()
    expect(await getCables(t.db, member, analysisId)).toEqual({ analysisId, projectId, rows: result.cables })
    expect(await getShields(t.db, member, analysisId)).toEqual({ analysisId, projectId, rows: result.shields })
    expect(await getTexts(t.db, member, analysisId)).toEqual({ analysisId, projectId, rows: result.texts })
    await expect(getConnections(t.db, member, 999_999)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('Abfragen mit Filtern und Seiten (aktueller Stand oder bestimmte Analyse)', async () => {
    const { analysisId, projectId } = await seeded()
    const twisted = await queryConnections(t.db, member, { projectId }, { twisted: true }, { limit: 5, offset: 0 })
    expect(twisted).toMatchObject({ analysisId, total: 15 })
    expect(twisted.rows.map(r => r.idx)).toEqual([1, 3, 5, 7, 9])
    const filtered = await queryConnections(t.db, member, { analysisId }, { endpoint: 'Q1', page: '=a1+s1/1', hashMark: true }, { limit: 50, offset: 0 })
    expect(filtered.rows.map(r => r.idx)).toEqual([10, 15])
    // Platzhalter im Suchtext gelten wörtlich
    expect((await queryConnections(t.db, member, { projectId }, { designation: 'VD%' }, { limit: 10, offset: 0 })).total).toBe(0)
    expect((await queryConnections(t.db, member, { projectId }, { designation: 'VD_X' }, { limit: 10, offset: 0 })).total).toBe(15)
    expect((await queryCables(t.db, member, { projectId }, { name: 'w1' }, { limit: 10, offset: 0 })).rows[0]!.wires).toHaveLength(1)
    expect((await listShields(t.db, member, { projectId }, { limit: 10, offset: 0 })).rows[0]!.connectionIdx).toEqual([0, 1])
    expect((await listTexts(t.db, member, { projectId }, { contains: 'text r' }, { limit: 10, offset: 0 })).total).toBe(1)
    await expect(queryConnections(t.db, member, {}, {}, { limit: 1, offset: 0 })).rejects.toMatchObject({ message: 'project_or_analysis_required' })
  })

  it('ohne erfolgreichen Stand ⇒ no_current_analysis bzw. analysis_not_succeeded', async () => {
    const run = await createRunningAnalysis(t.db, { name: 'Leer' })
    await expect(queryConnections(t.db, member, { projectId: run.projectId }, {}, { limit: 1, offset: 0 })).rejects.toMatchObject({ statusCode: 404, message: 'no_current_analysis' })
    await expect(getConnections(t.db, member, run.analysisId)).rejects.toMatchObject({ statusCode: 409, message: 'analysis_not_succeeded' })
  })
})
