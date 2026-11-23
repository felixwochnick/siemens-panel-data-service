import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import type { Actor } from '../server/services/access'
import { deleteAnalysis, listAnalyses, startAnalysis } from '../server/services/analyses'
import { listAudit } from '../server/services/audit'
import { cronPreview, getStatus, restartWorker, testSettings } from '../server/services/control'
import { listLogFiles, readLogTail } from '../server/services/logs'
import { deleteProject, getProject, listProjects } from '../server/services/projects'
import { getSettings } from '../server/services/settings'
import { uploadProject } from '../server/services/uploads'
import { createAppTestDatabase, createTestContext, createUser, waitFor } from './helpers/db'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext
let logDir: string

beforeAll(async () => {
  t = await createAppTestDatabase('access')
  admin = await createUser(t.db, { isAdmin: true, name: 'Ada Admin' })
  member = await createUser(t.db, { name: 'Paul Planer' })
  logDir = await mkdtemp(join(tmpdir(), 'pds-logs-'))
  await writeFile(join(logDir, 'app.log'), 'INFO a\nWARN b\n')
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  ctx = await createTestContext(t.db, { workerSpec: null, logDir })
})
afterEach(async () => {
  await ctx.cleanup()
})
afterAll(async () => {
  await t?.destroy()
  await rm(logDir, { recursive: true, force: true })
})

const upload = (actor: Actor, name = 'Anlage') => uploadProject(ctx, actor, { fileName: `${name}.zw1`, body: Readable.from([Buffer.from('x')]) })

describe('Rechte', () => {
  it('alle Angemeldeten: Projekte, Analysen, Hochladen, Analyse starten, Übersicht ohne Admin-Teil', async () => {
    const { project, analysis } = await upload(member)
    expect((await listProjects(t.db, member)).items.map(p => p.id)).toEqual([project.id])
    expect((await getProject(t.db, member, project.id)).analyses).toHaveLength(1)
    expect((await listAnalyses(t.db, member, { projectId: project.id })).total).toBe(1)
    await t.db.updateTable('pds.analyses').set({ status: 'failed', finishedAt: new Date() }).where('id', '=', analysis.id).execute()
    expect((await startAnalysis(ctx, member, { projectId: project.id })).queued).toHaveLength(1)

    const status = await getStatus(ctx, member)
    expect(status).toMatchObject({ admin: null, worker: { state: 'disabled' }, queue: { queuedCount: 1 } })
    expect((await getStatus(ctx, admin)).admin).toMatchObject({ issues: [], scheduler: { enabled: false } })
  })

  it('Nicht-Admins: keine Einstellungen, Protokolle, Zeitplan-Vorschau, Löschen oder Worker-Neustart', async () => {
    const { project, analysis } = await upload(member)
    const forbidden = { statusCode: 403, message: 'forbidden' }
    await expect(getSettings(ctx, member)).rejects.toMatchObject(forbidden)
    await expect(testSettings(ctx, member)).rejects.toMatchObject(forbidden)
    await expect(listLogFiles(ctx.logDir, member)).rejects.toMatchObject(forbidden)
    await expect(readLogTail(ctx.logDir, member, 'app.log')).rejects.toMatchObject(forbidden)
    expect(() => cronPreview(member, '0 0 2 * * ?', 'Europe/Berlin')).toThrow(expect.objectContaining(forbidden))
    await expect(deleteProject(ctx, member, project.id)).rejects.toMatchObject(forbidden)
    await expect(deleteAnalysis(ctx, member, analysis.id)).rejects.toMatchObject(forbidden)
    await expect(restartWorker(ctx, member)).rejects.toMatchObject(forbidden)
    await expect(listAudit(t.db, member)).rejects.toMatchObject(forbidden)
    // Admins dürfen
    expect((await readLogTail(ctx.logDir, admin, 'app.log')).lines).toEqual(['INFO a', 'WARN b'])
    expect(cronPreview(admin, '0 0 2 * * ?', 'Europe/Berlin').valid).toBe(true)
  })

  it('Dienste prüfen den Akteur (ohne Anmeldung ⇒ 401)', async () => {
    const nobody = null as unknown as Actor
    await expect(listProjects(t.db, nobody)).rejects.toMatchObject({ statusCode: 401, message: 'unauthorized' })
    await expect(getStatus(ctx, nobody)).rejects.toMatchObject({ statusCode: 401 })
    await expect(upload(nobody)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('Admin löscht Analyse und Projekt (nicht während der Analyse), mit Änderungsprotokoll', async () => {
    const { project, analysis } = await upload(member)
    await t.db.updateTable('pds.analyses').set({ status: 'running' }).where('id', '=', analysis.id).execute()
    await expect(deleteAnalysis(ctx, admin, analysis.id)).rejects.toMatchObject({ statusCode: 409, message: 'analysis_running' })
    await expect(deleteProject(ctx, admin, project.id)).rejects.toMatchObject({ statusCode: 409, message: 'analysis_running' })
    await t.db.updateTable('pds.analyses').set({ status: 'failed' }).where('id', '=', analysis.id).execute()
    await expect(deleteAnalysis(ctx, admin, analysis.id)).resolves.toEqual({ id: analysis.id })
    await expect(deleteProject(ctx, admin, project.id)).resolves.toEqual({ id: project.id })
    await waitFor(async () => (await listProjects(t.db, member)).total === 0)
    expect((await listAudit(t.db, admin)).map(e => e.action).slice(0, 2)).toEqual(['project_deleted', 'analysis_deleted'])
  })

  it('Worker neu starten ohne Worker ⇒ 409 worker_not_configured', async () => {
    await expect(restartWorker(ctx, admin)).rejects.toMatchObject({ statusCode: 409, message: 'worker_not_configured' })
  })
})
