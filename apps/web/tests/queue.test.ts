import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { analyze, parseRawProject } from '@pds/analyzer'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import type { Actor } from '../server/services/access'
import { getAnalysis, listAnalysisEvents, startAnalysis } from '../server/services/analyses'
import type { AppContextOptions } from '../server/services/context'
import { getProject } from '../server/services/projects'
import { getCables, getConnections, getShields, getTexts } from '../server/services/results'
import { saveSettings } from '../server/services/settings'
import { uploadProject } from '../server/services/uploads'
import { defaultConnector } from '../server/services/worker-client'
import type { WorkerConnector } from '../server/services/worker-client'
import { createAppTestDatabase, createTestContext, createUser, fakeWorkerSpec, readFixture, settingsInput, tempFolder, waitFor } from './helpers/db'
import { withFaults } from './helpers/faults'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext | undefined

beforeAll(async () => {
  t = await createAppTestDatabase('queue')
  admin = await createUser(t.db, { isAdmin: true })
  member = await createUser(t.db, { name: 'Max Mitarbeiter' })
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  await t.db.deleteFrom('pds.settings').execute()
})
afterEach(async () => {
  await ctx?.cleanup()
  ctx = undefined
})
afterAll(async () => {
  await t?.destroy()
})

async function start(options: Partial<AppContextOptions> = {}) {
  ctx = await createTestContext(t.db, { workerSpec: fakeWorkerSpec(), ...options })
  ctx.worker.start()
  ctx.queue.start()
  return ctx
}

const upload = (c: TestContext, fileName = 'Anlage.zw1', actor = member) =>
  uploadProject(c, actor, { fileName, body: Readable.from([Buffer.from('zw1-archiv')]) })

const finished = (id: number) => waitFor(async () => {
  const row = await t.db.selectFrom('pds.analyses').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  return row.status !== 'queued' && row.status !== 'running' ? row : undefined
}, 30_000)

describe('Warteschlange mit dem Ersatz-Worker', () => {
  it('Erfolg: Zeilen gespeichert und gleich analyze(fixture), Stand aktuell, Arbeitsordner weg', async () => {
    const c = await start()
    const { project, analysis } = await upload(c)
    // Die Warteschlange kann den Auftrag schon übernommen haben
    expect(analysis).toMatchObject({ status: expect.stringMatching(/^(queued|running)$/), trigger: 'upload', projectName: 'Anlage', triggeredBy: 'Max Mitarbeiter' })

    const row = await finished(analysis.id)
    expect(row).toMatchObject({ status: 'succeeded', errorCode: null, stage: null, eplanProjectName: 'Anlage', eplanVersion: '2025.0.3', workerVersion: '0.0.0-fake' })

    const expected = analyze(parseRawProject(readFixture()))
    expect((await getConnections(t.db, member, analysis.id)).rows).toEqual(expected.connections)
    expect((await getCables(t.db, member, analysis.id)).rows).toEqual(expected.cables)
    expect((await getShields(t.db, member, analysis.id)).rows).toEqual(expected.shields)
    expect((await getTexts(t.db, member, analysis.id)).rows).toEqual(expected.texts)

    const info = await getAnalysis(t.db, member, analysis.id)
    expect(info).toMatchObject({ isCurrent: true, counts: expected.counts, stage: null })
    expect((await getProject(t.db, member, project.id)).currentAnalysis?.id).toBe(analysis.id)

    const events = (await listAnalysisEvents(t.db, member, analysis.id)).items.map(e => e.code)
    expect(events[0]).toBe('analysis_started')
    expect(events).toEqual(expect.arrayContaining(['worker_log', 'raw_read', 'results_saved', 'analysis_succeeded', ...expected.notices.map(n => n.code)]))
    const workerLog = (await listAnalysisEvents(t.db, member, analysis.id)).items.find(e => e.code === 'worker_log')
    expect(workerLog).toMatchObject({ params: { code: 'fake_worker' } })
    // Arbeitsordner wird nach dem Speichern gelöscht
    await waitFor(async () => !existsSync(join(c.dataDir, 'work', String(analysis.id))))
  })

  it('Ordner-Projekt (.elk + .edb) wird in den Arbeitsordner kopiert und analysiert', async () => {
    const folder = await tempFolder({ 'Linie/Anlage.elk': 'elk', 'Linie/Anlage.edb/db/a.bin': 'x' })
    try {
      const c = await start()
      await saveSettings(c, admin, settingsInput({ folder: folder.dir }))
      const result = await startAnalysis(c, member, { folderPaths: ['Linie/Anlage.elk', 'Linie\\Fehlt.elk', '../x.elk'] })
      expect(result.skipped).toEqual([
        { target: 'Linie\\Fehlt.elk', code: 'folder_project_not_found' },
        { target: '../x.elk', code: 'invalid_path' },
      ])
      expect(result.queued).toHaveLength(1)
      const row = await finished(result.queued[0]!.id)
      expect(row).toMatchObject({ status: 'succeeded', trigger: 'manual' })
      expect(row.sourceModified).toBeInstanceOf(Date)
      const events = (await listAnalysisEvents(t.db, member, row.id)).items
      expect(events.find(e => e.code === 'project_copied')).toMatchObject({ params: { files: 2 } })
      // das Original bleibt unberührt
      expect(await readdir(join(folder.dir, 'Linie'))).toEqual(['Anlage.edb', 'Anlage.elk'])
    }
    finally {
      await folder.cleanup()
    }
  })

  it('Worker-Fehler ⇒ failed mit dem Code des Workers; nächster Auftrag läuft weiter', async () => {
    const c = await start({ workerSpec: fakeWorkerSpec({ FAKE_WORKER_FAIL: 'open_failed' }) })
    const { analysis } = await upload(c)
    const row = await finished(analysis.id)
    expect(row).toMatchObject({ status: 'failed', errorCode: 'open_failed', errorDetail: 'simulated failure (open_failed)' })
    const codes = (await listAnalysisEvents(t.db, member, analysis.id, { level: 'error' })).items.map(e => e.code)
    expect(codes).toEqual(['open_failed', 'analysis_failed'])
    expect((await getProject(t.db, member, row.projectId)).currentAnalysis).toBeNull()
    await expect(getConnections(t.db, member, analysis.id)).rejects.toMatchObject({ statusCode: 409, message: 'analysis_not_succeeded' })

    // Erneut analysieren: neuer Auftrag, gleiches Projekt
    const again = await startAnalysis(c, member, { projectId: row.projectId })
    expect((await finished(again.queued[0]!.id)).status).toBe('failed')
  })

  it('Zeitlimit ⇒ failed/timeout, Worker wird neu gestartet', async () => {
    const c = await start({ workerSpec: fakeWorkerSpec({ FAKE_WORKER_DELAY_MS: '1000' }), queue: { timeoutMs: 1200 } })
    const version = c.worker.info().since
    const { analysis } = await upload(c)
    const row = await finished(analysis.id)
    expect(row).toMatchObject({ status: 'failed', errorCode: 'timeout' })
    const codes = (await listAnalysisEvents(t.db, member, analysis.id)).items.map(e => e.code)
    expect(codes).toEqual(expect.arrayContaining(['timeout', 'analysis_failed', 'worker_restarted']))
    await waitFor(async () => c.worker.connected && c.worker.info().since !== version)
  })

  it('Absturz des Workers ⇒ failed/worker_disconnected; nach dem Neustart läuft der nächste Auftrag', async () => {
    let connections = 0
    // Erster Prozess stürzt ab, der neu gestartete nicht mehr
    const connector: WorkerConnector = (spec, log) => defaultConnector(
      spec.kind === 'spawn' ? { ...spec, env: { ...spec.env, ...(connections++ === 0 ? { FAKE_WORKER_CRASH: '1' } : {}) } } : spec,
      log,
    )
    const c = await start({ worker: { connector } })
    const first = await upload(c, 'Eins.zw1')
    const second = await upload(c, 'Zwei.zw1')
    expect(await finished(first.analysis.id)).toMatchObject({ status: 'failed', errorCode: 'worker_disconnected' })
    expect(await finished(second.analysis.id)).toMatchObject({ status: 'succeeded' })
    expect(connections).toBeGreaterThanOrEqual(2)
  })

  it('Worker noch beschäftigt (verlorene Analyse nach Wiederverbinden) ⇒ Auftrag wartet, bis er frei ist', async () => {
    let busy = 2
    const methods: string[] = []
    // Pipe-Worker im Speicher: meldet zweimal busy, dann frei; analyze schreibt die Fixture
    const connector: WorkerConnector = () => {
      let data: (chunk: string) => void = () => {}
      let close: (error?: Error) => void = () => {}
      const send = (message: unknown) => setTimeout(() => data(`${JSON.stringify(message)}\n`), 1)
      send({ type: 'hello', protocol: 1, version: 'mem' })
      return {
        write: (line) => {
          const message = JSON.parse(line) as { id: string, method: string, params: { outputFile?: string } }
          methods.push(message.method)
          if (message.method === 'status') send({ type: 'response', id: message.id, result: { eplan: 'ready', eplanVersion: null, busy: busy-- > 0, configured: true } })
          else if (message.method === 'analyze') {
            void writeFile(message.params.outputFile!, JSON.stringify(readFixture())).then(() => send({ type: 'response', id: message.id, result: { outputFile: message.params.outputFile } }))
          }
          else send({ type: 'response', id: message.id, result: {} })
        },
        onData: (listener) => {
          data = listener
        },
        onClose: (listener) => {
          close = listener
        },
        end: () => close(),
        kill: () => close(),
      }
    }
    const c = await start({ workerSpec: { kind: 'pipe', path: 'mem' }, worker: { connector }, queue: { pollIntervalMs: 50 } })
    const { analysis } = await upload(c)
    expect(await finished(analysis.id)).toMatchObject({ status: 'succeeded' })
    expect(methods.filter(m => m === 'status').length).toBeGreaterThanOrEqual(3)
    expect(methods.indexOf('analyze')).toBeGreaterThan(methods.lastIndexOf('status') - 1)
  })

  it('EPLAN-Start scheitert ⇒ failed/eplan_start_failed, Worker wird neu gestartet, nächster Auftrag läuft', async () => {
    let connections = 0
    // Im ersten Prozess scheitert der EPLAN-Start (bleibt dort gescheitert), im neu gestarteten nicht mehr
    const connector: WorkerConnector = (spec, log) => defaultConnector(
      spec.kind === 'spawn' ? { ...spec, env: { ...spec.env, ...(connections++ === 0 ? { FAKE_WORKER_START_FAIL: '1' } : {}) } } : spec,
      log,
    )
    const c = await start({ worker: { connector } })
    const first = await upload(c, 'Eins.zw1')
    expect(await finished(first.analysis.id)).toMatchObject({ status: 'failed', errorCode: 'eplan_start_failed' })
    const codes = (await listAnalysisEvents(t.db, member, first.analysis.id)).items.map(e => e.code)
    expect(codes).toEqual(expect.arrayContaining(['eplan_start_failed', 'analysis_failed', 'worker_restarted']))

    const second = await upload(c, 'Zwei.zw1')
    expect(await finished(second.analysis.id)).toMatchObject({ status: 'succeeded' })
    expect(connections).toBeGreaterThanOrEqual(2)
  })

  it('Worker länger als das Zeitlimit beschäftigt ohne eigene Analyse ⇒ Neustart, danach läuft der Auftrag', async () => {
    let processes = 0
    const methods: string[] = []
    // Pipe-Worker im Speicher: Der erste Prozess hängt in einer verwaisten Analyse (immer busy), bis exit kommt
    const connector: WorkerConnector = () => {
      const stuck = processes++ === 0
      let data: (chunk: string) => void = () => {}
      let close: (error?: Error) => void = () => {}
      const send = (message: unknown) => setTimeout(() => data(`${JSON.stringify(message)}\n`), 1)
      send({ type: 'hello', protocol: 1, version: 'mem' })
      return {
        write: (line) => {
          const message = JSON.parse(line) as { id: string, method: string, params: { outputFile?: string } }
          methods.push(message.method)
          if (message.method === 'status') send({ type: 'response', id: message.id, result: { eplan: 'ready', eplanVersion: null, busy: stuck, configured: true } })
          else if (message.method === 'exit') {
            send({ type: 'response', id: message.id, result: {} })
            setTimeout(() => close(), 10)
          }
          else if (message.method === 'analyze') {
            void writeFile(message.params.outputFile!, JSON.stringify(readFixture())).then(() => send({ type: 'response', id: message.id, result: { outputFile: message.params.outputFile } }))
          }
          else send({ type: 'response', id: message.id, result: {} })
        },
        onData: (listener) => {
          data = listener
        },
        onClose: (listener) => {
          close = listener
        },
        end: () => close(),
        kill: () => close(),
      }
    }
    const c = await start({ workerSpec: { kind: 'pipe', path: 'mem' }, worker: { connector }, queue: { pollIntervalMs: 50, timeoutMs: 1500 } })
    const { analysis } = await upload(c)
    expect(await finished(analysis.id)).toMatchObject({ status: 'succeeded' })
    expect(methods).toContain('exit')
    expect(processes).toBeGreaterThanOrEqual(2)
  })

  it('Abschluss bei gestörter Datenbank: wird nachgetragen, danach läuft der nächste Auftrag', async () => {
    const faults = withFaults(t.db)
    ctx = await createTestContext(faults.db, { workerSpec: fakeWorkerSpec({ FAKE_WORKER_FAIL: 'open_failed', FAKE_WORKER_DELAY_MS: '300' }) })
    ctx.worker.start()
    ctx.queue.start()
    const first = await upload(ctx, 'Eins.zw1')
    await waitFor(async () => (await getAnalysis(t.db, member, first.analysis.id)).status === 'running')
    // Alle Änderungen an pds.analyses scheitern (wie eine abgerissene Verbindung)
    faults.fail('UpdateQueryNode', 'analyses')
    const unfinished = (ctx.queue as unknown as { unfinished: Map<number, unknown> }).unfinished
    await waitFor(async () => unfinished.size > 0)
    expect((await getAnalysis(t.db, member, first.analysis.id)).status).toBe('running')
    faults.heal()
    expect(await finished(first.analysis.id)).toMatchObject({ status: 'failed', errorCode: 'open_failed' })
    const second = await upload(ctx, 'Zwei.zw1')
    expect((await finished(second.analysis.id)).status).toBe('failed')
  })

  it('doppelter Auftrag ⇒ 409 analysis_already_queued, kein zweiter Eintrag', async () => {
    // Ohne Worker bleiben Aufträge in der Warteschlange
    ctx = await createTestContext(t.db, { workerSpec: null })
    ctx.queue.start()
    const { project, analysis } = await upload(ctx)
    await expect(startAnalysis(ctx, member, { projectId: project.id })).rejects.toMatchObject({ statusCode: 409, message: 'analysis_already_queued' })
    await expect(upload(ctx)).rejects.toMatchObject({ statusCode: 409, message: 'analysis_already_queued' })
    const rows = await t.db.selectFrom('pds.analyses').select('id').where('projectId', '=', project.id).execute()
    expect(rows).toEqual([{ id: analysis.id }])
    expect(ctx.worker.info().state).toBe('disabled')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await getAnalysis(t.db, member, analysis.id)).status).toBe('queued')
  })

  it('beim Start: hängengebliebene `running` ⇒ aborted/interrupted, wartende bleiben', async () => {
    const project = await t.db.insertInto('pds.projects').values({ source: 'upload', name: 'X', path: null, pathKey: 'x', fileKind: 'zw1', createdBy: null }).output('inserted.id').executeTakeFirstOrThrow()
    const other = await t.db.insertInto('pds.projects').values({ source: 'upload', name: 'Y', path: null, pathKey: 'y', fileKind: 'zw1', createdBy: null }).output('inserted.id').executeTakeFirstOrThrow()
    const stale = await t.db.insertInto('pds.analyses').values({ projectId: project.id, trigger: 'manual', triggeredBy: null, status: 'running', startedAt: new Date(Date.now() - 60_000) }).output('inserted.id').executeTakeFirstOrThrow()
    const waiting = await t.db.insertInto('pds.analyses').values({ projectId: other.id, trigger: 'manual', triggeredBy: null, status: 'queued' }).output('inserted.id').executeTakeFirstOrThrow()
    ctx = await createTestContext(t.db, { workerSpec: null })
    expect(await ctx.queue.abortStale()).toBe(1)
    expect(await t.db.selectFrom('pds.analyses').select(['status', 'errorCode']).where('id', '=', stale.id).executeTakeFirstOrThrow()).toEqual({ status: 'aborted', errorCode: 'interrupted' })
    expect((await t.db.selectFrom('pds.analyses').select('status').where('id', '=', waiting.id).executeTakeFirstOrThrow()).status).toBe('queued')
  })
})
