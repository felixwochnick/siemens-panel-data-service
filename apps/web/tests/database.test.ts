import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isUniqueViolation } from '@pds/core/database'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import { saveResults } from '../server/services/results'
import { createAppTestDatabase, createRunningAnalysis, syntheticResult } from './helpers/db'

let t: TestDatabase<AppDatabase>

const meta = { eplanProjectName: 'P', eplanVersion: '2025.0.3', workerVersion: '1.0.0', sourceModified: null }

beforeAll(async () => {
  t = await createAppTestDatabase('database')
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
})
afterAll(async () => {
  await t?.destroy()
})

/** Analyse mit Ergebnissen speichern (aktueller Stand springt auf sie) */
async function analysisWith(projectId: number | undefined, n: number, tag: string, name?: string) {
  const run = await createRunningAnalysis(t.db, { projectId, name })
  await saveResults(t.db, { analysisId: run.analysisId, projectId: run.projectId, result: syntheticResult(n, tag), meta, now: new Date() })
  return run
}

describe('Migrationen', () => {
  it('legen Tabellen und Sichten an (beide Datenbanken gleich)', async () => {
    for (const table of ['pds.settings', 'pds.projects', 'pds.analyses', 'pds.analysisEvents', 'pds.connections', 'pds.cables', 'pds.cableWires', 'pds.shields', 'pds.shieldWires', 'pds.texts', 'pds.audit'] as const) {
      const row = await t.db.selectFrom(table).select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow()
      expect(Number(row.count), table).toBe(0)
    }
    for (const view of ['pds.vCurrentConnections', 'pds.vCurrentCables', 'pds.vCurrentCableWires', 'pds.vCurrentShields', 'pds.vCurrentShieldWires', 'pds.vCurrentTexts'] as const) {
      await expect(t.db.selectFrom(view).selectAll().execute(), view).resolves.toEqual([])
    }
  })

  it('Sichten zeigen nur den aktuellen Stand je Projekt, mit Projekt und Analyse', async () => {
    const first = await analysisWith(undefined, 3, 'alt', 'Anlage')
    const second = await analysisWith(first.projectId, 2, 'neu')
    const other = await analysisWith(undefined, 1, 'b', 'Andere')

    const rows = await t.db.selectFrom('pds.vCurrentConnections').selectAll().orderBy('projectId').orderBy('idx').execute()
    expect(rows.map(r => [r.projectId, r.projectName, r.analysisId, r.eplanId])).toEqual([
      [first.projectId, 'Anlage', second.analysisId, 'neu-0'],
      [first.projectId, 'Anlage', second.analysisId, 'neu-1'],
      [other.projectId, 'Andere', other.analysisId, 'b-0'],
    ])
    expect(rows[1]!.twisted).toBeTruthy()

    const cables = await t.db.selectFrom('pds.vCurrentCables').selectAll().execute()
    expect(cables.map(r => r.analysisId).sort()).toEqual([second.analysisId, other.analysisId].sort())
    const wires = await t.db.selectFrom('pds.vCurrentCableWires').selectAll().where('projectId', '=', first.projectId).execute()
    expect(wires).toMatchObject([{ analysisId: second.analysisId, cableIdx: 0, cableName: '-W1', idx: 0, connectionIdx: 0 }])
    const shields = await t.db.selectFrom('pds.vCurrentShields').selectAll().where('projectId', '=', first.projectId).execute()
    expect(shields).toMatchObject([{ analysisId: second.analysisId, name: 'Abschirmung' }])
    const shieldWires = await t.db.selectFrom('pds.vCurrentShieldWires').selectAll().where('projectId', '=', first.projectId).orderBy('idx').execute()
    expect(shieldWires.map(r => r.connectionIdx)).toEqual([0, 1])
    const texts = await t.db.selectFrom('pds.vCurrentTexts').selectAll().where('projectId', '=', first.projectId).execute()
    expect(texts).toMatchObject([{ text: 'Text neu', projectName: 'Anlage' }])

    // Der alte Stand bleibt gespeichert (eigener Stand), nur nicht in den Sichten
    const old = await t.db.selectFrom('pds.connections').select('eplanId').where('analysisId', '=', first.analysisId).execute()
    expect(old).toHaveLength(3)
  })

  it('Löschen eines Projekts entfernt Analysen und Ergebnisse (Cascade)', async () => {
    const run = await analysisWith(undefined, 5, 'x')
    await t.db.insertInto('pds.analysisEvents').values({ analysisId: run.analysisId, at: new Date(), level: 'info', code: 'analysis_started', params: null, detail: null }).execute()
    await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).where('id', '=', run.projectId).execute()
    await t.db.deleteFrom('pds.projects').where('id', '=', run.projectId).execute()
    for (const table of ['pds.analyses', 'pds.analysisEvents', 'pds.connections', 'pds.cables', 'pds.cableWires', 'pds.shields', 'pds.shieldWires', 'pds.texts'] as const) {
      const row = await t.db.selectFrom(table).select(eb => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow()
      expect(Number(row.count), table).toBe(0)
    }
  })

  it('höchstens ein offener Auftrag je Projekt und eine laufende Analyse insgesamt', async () => {
    const a = await createRunningAnalysis(t.db, { name: 'Eins' })
    const insert = (projectId: number, status: 'queued' | 'running') => t.db.insertInto('pds.analyses').values({ projectId, trigger: 'manual', triggeredBy: null, status }).execute()
    // zweiter offener Auftrag für dasselbe Projekt
    await expect(insert(a.projectId, 'queued').catch((e: unknown) => isUniqueViolation(e))).resolves.toBe(true)
    // zweite laufende Analyse (anderes Projekt)
    const b = await t.db.insertInto('pds.projects').values({ source: 'upload', name: 'Zwei', path: null, pathKey: 'zwei', fileKind: 'zw1', createdBy: null }).output('inserted.id').executeTakeFirstOrThrow()
    await expect(insert(b.id, 'running').catch((e: unknown) => isUniqueViolation(e))).resolves.toBe(true)
    await expect(insert(b.id, 'queued')).resolves.toBeDefined()
  })

  it('gleiche Quelle und gleicher Pfad sind eindeutig', async () => {
    const values = { source: 'folder' as const, name: 'A', path: 'Sub/A.elk', pathKey: 'sub/a.elk', fileKind: 'elk' as const, createdBy: null }
    await t.db.insertInto('pds.projects').values(values).execute()
    await expect(t.db.insertInto('pds.projects').values(values).execute().catch((e: unknown) => isUniqueViolation(e))).resolves.toBe(true)
    // Upload gleichen Schlüssels ist ein anderes Projekt
    await expect(t.db.insertInto('pds.projects').values({ ...values, source: 'upload', path: null, fileKind: 'zw1' }).execute()).resolves.toBeDefined()
  })
})
