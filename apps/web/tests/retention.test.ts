import { existsSync } from 'node:fs'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import type { Actor } from '../server/services/access'
import { runRetention } from '../server/services/retention'
import { saveResults } from '../server/services/results'
import { saveSettings } from '../server/services/settings'
import { uploadProject } from '../server/services/uploads'
import { createAppTestDatabase, createTestContext, createUser, settingsInput, syntheticResult } from './helpers/db'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let ctx: TestContext

const DAY = 86_400_000
const NOW = new Date('2026-11-23T12:00:00.000Z')
const meta = { eplanProjectName: null, eplanVersion: null, workerVersion: null, sourceModified: null }

beforeAll(async () => {
  t = await createAppTestDatabase('retention')
  admin = await createUser(t.db, { isAdmin: true })
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  await t.db.deleteFrom('pds.settings').execute()
  ctx = await createTestContext(t.db, { workerSpec: null })
  await saveSettings(ctx, admin, settingsInput({ retentionDays: 30 }))
})
afterEach(async () => {
  await ctx.cleanup()
})
afterAll(async () => {
  await t?.destroy()
})

/** Hochladen und die Analyse als erfolgreich mit Ergebnissen abschließen (fertig vor `daysAgo` Tagen) */
async function uploadAndFinish(name: string, daysAgo: number, status: 'succeeded' | 'failed' = 'succeeded') {
  const { project, analysis } = await uploadProject(ctx, admin, { fileName: `${name}.zw1`, body: Readable.from([Buffer.from(name)]) })
  await t.db.updateTable('pds.analyses').set({ status: 'running', queuedAt: new Date(NOW.getTime() - daysAgo * DAY) }).where('id', '=', analysis.id).execute()
  if (status === 'succeeded') await saveResults(t.db, { analysisId: analysis.id, projectId: project.id, result: syntheticResult(5, name), meta, now: new Date(NOW.getTime() - daysAgo * DAY) })
  else await t.db.updateTable('pds.analyses').set({ status: 'failed', finishedAt: new Date(NOW.getTime() - daysAgo * DAY) }).where('id', '=', analysis.id).execute()
  return { projectId: project.id, analysisId: analysis.id }
}

const uploadDirs = async (projectId: number) => (await readdir(join(ctx.dataDir, 'uploads', String(projectId)))).sort()

/** Ordner älter machen (junge Ordner lässt die Aufbewahrung stehen: Hochladen oder Analyse könnte gerade laufen) */
async function age(...paths: string[]) {
  const old = new Date(NOW.getTime() - 2 * DAY)
  for (const path of paths) await utimes(path, old, old)
}
const fileOf = async (analysisId: number) => (await t.db.selectFrom('pds.analyses').select('uploadFile').where('id', '=', analysisId).executeTakeFirstOrThrow()).uploadFile!.split('/')[0]

describe('Aufbewahrung', () => {
  it('löscht alte Stände außer dem aktuellen, behält neuere; hochgeladene Dateien nur, solange gebraucht', async () => {
    const old = await uploadAndFinish('Anlage', 100)
    const middle = await uploadAndFinish('Anlage', 60)
    const current = await uploadAndFinish('Anlage', 40)
    const failedNewer = await uploadAndFinish('Anlage', 1, 'failed')
    // einziger (alter) Stand eines anderen Projekts bleibt, weil er aktuell ist
    const lonely = await uploadAndFinish('Einzeln', 400)
    // aktueller Stand von „Anlage“ ist `current` (40 Tage) – älter als die Frist, bleibt trotzdem
    expect(await uploadDirs(old.projectId)).toHaveLength(4)
    const dirs = await uploadDirs(old.projectId)
    // der jüngste Ordner bleibt jung: auch ohne Eintrag in der Datenbank würde er nicht gelöscht
    await age(...dirs.map(dir => join(ctx.dataDir, 'uploads', String(old.projectId), dir)))

    const result = await runRetention(ctx, NOW)
    expect(result.analyses).toBe(2)
    const left = await t.db.selectFrom('pds.analyses').select('id').orderBy('id').execute()
    expect(left.map(r => r.id)).toEqual([current.analysisId, failedNewer.analysisId, lonely.analysisId])
    const connections = await t.db.selectFrom('pds.connections').select('analysisId').distinct().execute()
    expect(connections.map(r => r.analysisId).sort()).toEqual([current.analysisId, lonely.analysisId].sort())

    // Dateien: die des aktuellen Stands und die neueste (für „Erneut analysieren“) bleiben
    expect(await uploadDirs(old.projectId)).toEqual([await fileOf(current.analysisId), await fileOf(failedNewer.analysisId)].sort())
    expect(result.uploads).toBe(2)
    expect(middle.analysisId).toBeLessThan(current.analysisId)
  })

  it('räumt verwaiste Upload- und Arbeitsordner sowie alte abgebrochene Uploads auf', async () => {
    const kept = await uploadAndFinish('Bleibt', 1)
    await mkdir(join(ctx.dataDir, 'uploads', '99999', 'x'), { recursive: true })
    await mkdir(join(ctx.dataDir, 'work', '123', 'restore'), { recursive: true })
    const incoming = join(ctx.dataDir, 'uploads', '.incoming')
    await mkdir(incoming, { recursive: true })
    await writeFile(join(incoming, 'alt.part'), 'x')
    await utimes(join(incoming, 'alt.part'), new Date(NOW.getTime() - 2 * DAY), new Date(NOW.getTime() - 2 * DAY))
    await writeFile(join(incoming, 'neu.part'), 'x')
    await utimes(join(incoming, 'neu.part'), NOW, NOW)
    await age(join(ctx.dataDir, 'uploads', '99999'), join(ctx.dataDir, 'work', '123'))
    // junge Ordner bleiben (Hochladen bzw. Analyse kann gerade begonnen haben)
    await mkdir(join(ctx.dataDir, 'uploads', '99998'), { recursive: true })
    await mkdir(join(ctx.dataDir, 'work', '124'), { recursive: true })

    const result = await runRetention(ctx, new Date())
    expect(result).toMatchObject({ analyses: 0, workFolders: 1 })
    expect(existsSync(join(ctx.dataDir, 'uploads', '99999'))).toBe(false)
    expect(existsSync(join(ctx.dataDir, 'work', '123'))).toBe(false)
    expect(existsSync(join(ctx.dataDir, 'uploads', '99998'))).toBe(true)
    expect(existsSync(join(ctx.dataDir, 'work', '124'))).toBe(true)
    expect(await readdir(incoming)).toEqual(['neu.part'])
    expect(await uploadDirs(kept.projectId)).toHaveLength(1)
  })
})
