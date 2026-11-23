import { join, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import { defaultSettings } from '../server/lib/settings'
import type { Actor } from '../server/services/access'
import { copyProjectToWork, listFolderProjects, resolveInFolder, scanFolder } from '../server/services/folder'
import { runScheduledScan } from '../server/services/scan'
import { saveSettings } from '../server/services/settings'
import { createAppTestDatabase, createRunningAnalysis, createTestContext, createUser, settingsInput, tempFolder } from './helpers/db'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext
let folder: Awaited<ReturnType<typeof tempFolder>>

const T1 = new Date('2026-01-01T10:00:00.000Z')
const T2 = new Date('2026-02-01T10:00:00.000Z')
const T3 = new Date('2026-03-01T10:00:00.000Z')
const p = (...parts: string[]) => parts.join(sep)

beforeAll(async () => {
  t = await createAppTestDatabase('folder')
  admin = await createUser(t.db, { isAdmin: true })
  member = await createUser(t.db)
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  await t.db.deleteFrom('pds.settings').execute()
  folder = await tempFolder({
    'Anlage.elk': { mtime: T1 },
    'Anlage.edb/x/data.db': { mtime: T2 },
    'Anlage.edb/a.txt': { mtime: T1 },
    'Archiv.ZW1': { mtime: T3 },
    'Ohne.elk': { mtime: T1 },
    'notiz.txt': 'x',
    'Linie 2/Tief.elk': { mtime: T1 },
    'Linie 2/TIEF.edb/leer.txt': { mtime: T1 },
    'Linie 2/Unter/Ganz.zw1': { mtime: T2 },
  })
  ctx = await createTestContext(t.db, { workerSpec: null })
})
afterEach(async () => {
  await ctx.cleanup()
  await folder.cleanup()
})
afterAll(async () => {
  await t?.destroy()
})

describe('Ordner-Scan', () => {
  it('findet .elk mit .edb und .zw1 rekursiv; .elk ohne .edb übersprungen; Änderungszeit = neueste Datei', async () => {
    const scan = await scanFolder({ ...defaultSettings, folder: folder.dir })
    expect(scan.items.map(i => [i.path, i.fileKind, i.name, i.sourceModified.toISOString()])).toEqual([
      ['Anlage.elk', 'elk', 'Anlage', T2.toISOString()],
      ['Archiv.ZW1', 'zw1', 'Archiv', T3.toISOString()],
      [p('Linie 2', 'Tief.elk'), 'elk', 'Tief', T1.toISOString()],
      [p('Linie 2', 'Unter', 'Ganz.zw1'), 'zw1', 'Ganz', T2.toISOString()],
    ])
    expect(scan.items[2]!.pathKey).toBe('linie 2/tief.elk')
    expect(scan.skipped).toEqual([{ path: 'Ohne.elk', code: 'edb_missing' }])
  })

  it('nicht rekursiv und nach Mustern', async () => {
    const flat = await scanFolder({ ...defaultSettings, folder: folder.dir, recursive: false })
    expect(flat.items.map(i => i.path)).toEqual(['Anlage.elk', 'Archiv.ZW1'])
    const zw1 = await scanFolder({ ...defaultSettings, folder: folder.dir, filePatterns: ['*.zw1'] })
    expect(zw1.items.map(i => i.name)).toEqual(['Archiv', 'Ganz'])
    expect(zw1.skipped).toEqual([])
  })

  it('fehlender Ordner ⇒ folder_not_found; leer ⇒ folder_not_configured', async () => {
    await expect(scanFolder({ ...defaultSettings, folder: join(folder.dir, 'fehlt') })).rejects.toMatchObject({ statusCode: 424, message: 'folder_not_found' })
    await expect(scanFolder({ ...defaultSettings, folder: ' ' })).rejects.toMatchObject({ statusCode: 400, message: 'folder_not_configured' })
  })

  it('Pfade aus Anfragen bleiben im Projektordner', () => {
    expect(resolveInFolder('/srv/p', 'Linie 2\\Tief.elk')).toEqual({ path: p('Linie 2', 'Tief.elk'), absolutePath: join('/srv/p', 'Linie 2', 'Tief.elk') })
    for (const bad of ['../x.elk', 'a/../../x.elk', '/etc/passwd', 'C:\\x.elk', '\\\\srv\\x.elk', '', '.'])
      expect(resolveInFolder('/srv/p', bad), bad).toBeUndefined()
  })

  it('kopiert .elk samt .edb (unter dem Namen der .elk) bzw. .zw1 in den Arbeitsordner', async () => {
    const work = await tempFolder()
    try {
      const elk = await copyProjectToWork(join(folder.dir, 'Linie 2', 'Tief.elk'), 'elk', work.dir)
      expect(elk).toEqual({ projectPath: join(work.dir, 'Tief.elk'), files: 2 })
      const zw1 = await copyProjectToWork(join(folder.dir, 'Archiv.ZW1'), 'zw1', work.dir)
      expect(zw1.files).toBe(1)
      await expect(copyProjectToWork(join(folder.dir, 'Ohne.elk'), 'elk', work.dir)).rejects.toMatchObject({ code: 'project_file_missing' })
    }
    finally {
      await work.cleanup()
    }
  })
})

describe('Projektordner in der App', () => {
  it('Liste mit Stand: neu, unverändert, geändert', async () => {
    await saveSettings(ctx, admin, settingsInput({ folder: folder.dir }))
    let list = await listFolderProjects(ctx, member)
    expect(list.folder).toBe(folder.dir)
    expect(list.items.every(i => i.project === null && i.changed)).toBe(true)

    // Anlage wurde mit dem aktuellen Stand analysiert, Archiv mit einem älteren
    const scheduled = await runScheduledScan(ctx)
    expect(scheduled).toMatchObject({ found: 4, queued: 4, skipped: [{ path: 'Ohne.elk', code: 'edb_missing' }] })
    const projects = await t.db.selectFrom('pds.projects').select(['id', 'pathKey']).execute()
    const id = (key: string) => projects.find(row => row.pathKey === key)!.id
    for (const [key, modified] of [['anlage.elk', T2], ['archiv.zw1', T1]] as const) {
      await t.db.updateTable('pds.analyses').set({ status: 'succeeded', finishedAt: new Date(), sourceModified: modified, countConnections: 0 }).where('projectId', '=', id(key)).execute()
      const analysis = await t.db.selectFrom('pds.analyses').select('id').where('projectId', '=', id(key)).executeTakeFirstOrThrow()
      await t.db.updateTable('pds.projects').set({ currentAnalysisId: analysis.id }).where('id', '=', id(key)).execute()
    }
    list = await listFolderProjects(ctx, member)
    expect(list.items.map(i => [i.name, i.changed, i.project?.latestStatus])).toEqual([
      ['Anlage', false, 'succeeded'],
      ['Archiv', true, 'succeeded'],
      ['Tief', true, 'queued'],
      ['Ganz', true, 'queued'],
    ])
  })

  it('Zeitplan-Lauf reiht neue, geänderte und zuletzt gescheiterte Projekte ein, sonst nichts', async () => {
    await saveSettings(ctx, admin, settingsInput({ folder: folder.dir, recursive: false }))
    expect(await runScheduledScan(ctx)).toMatchObject({ found: 2, queued: 2 })
    const rows = await t.db.selectFrom('pds.analyses as a').innerJoin('pds.projects as p', 'p.id', 'a.projectId').select(['a.id', 'p.name', 'a.trigger', 'a.triggeredBy', 'p.id as projectId']).execute()
    expect(rows.map(r => [r.name, r.trigger, r.triggeredBy]).sort()).toEqual([['Anlage', 'schedule', null], ['Archiv', 'schedule', null]])

    // Noch offen ⇒ nichts Neues
    expect((await runScheduledScan(ctx)).queued).toBe(0)

    // Anlage erfolgreich mit aktuellem Stand, Archiv gescheitert
    const anlage = rows.find(r => r.name === 'Anlage')!
    const archiv = rows.find(r => r.name === 'Archiv')!
    await t.db.updateTable('pds.analyses').set({ status: 'succeeded', finishedAt: new Date(), sourceModified: T2 }).where('id', '=', anlage.id).execute()
    await t.db.updateTable('pds.projects').set({ currentAnalysisId: anlage.id }).where('id', '=', anlage.projectId).execute()
    await t.db.updateTable('pds.analyses').set({ status: 'failed', finishedAt: new Date(), errorCode: 'open_failed' }).where('id', '=', archiv.id).execute()
    expect((await runScheduledScan(ctx)).queued).toBe(1)
    const open = await t.db.selectFrom('pds.analyses').select('projectId').where('status', '=', 'queued').execute()
    expect(open).toEqual([{ projectId: archiv.projectId }])
  })

  it('läuft gerade eine Analyse des Projekts, reiht der Zeitplan nichts ein', async () => {
    await saveSettings(ctx, admin, settingsInput({ folder: folder.dir, recursive: false, filePatterns: ['*.zw1'] }))
    await runScheduledScan(ctx)
    const project = await t.db.selectFrom('pds.projects').select('id').executeTakeFirstOrThrow()
    await t.db.updateTable('pds.analyses').set({ status: 'failed', finishedAt: new Date() }).execute()
    await createRunningAnalysis(t.db, { projectId: project.id })
    expect((await runScheduledScan(ctx)).queued).toBe(0)
  })

  it('ohne Projektordner ⇒ folder_not_configured', async () => {
    await expect(listFolderProjects(ctx, member)).rejects.toMatchObject({ statusCode: 400, message: 'folder_not_configured' })
    await expect(runScheduledScan(ctx)).rejects.toMatchObject({ message: 'folder_not_configured' })
  })

  it('Netzlaufwerk unter Linux: Liste meldet network_drive_unsupported, wenn der Ordner fehlt', async () => {
    await saveSettings(ctx, admin, settingsInput({ folder: join(folder.dir, 'fehlt'), source: 'network', networkDrive: { networkPath: '\\\\srv\\x', password: null } }))
    await expect(listFolderProjects(ctx, member)).rejects.toMatchObject({ statusCode: 424, message: 'network_drive_unsupported' })
  })
})
