import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import type { Actor } from '../server/services/access'
import { listAudit } from '../server/services/audit'
import { getProject, listProjects } from '../server/services/projects'
import { saveSettings } from '../server/services/settings'
import { checkUploadName, uploadProject } from '../server/services/uploads'
import { createAppTestDatabase, createTestContext, createUser, settingsInput } from './helpers/db'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext

beforeAll(async () => {
  t = await createAppTestDatabase('uploads')
  admin = await createUser(t.db, { isAdmin: true })
  member = await createUser(t.db, { name: 'Lena Lernt' })
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  await t.db.deleteFrom('pds.settings').execute()
  // Ohne Worker: Aufträge bleiben in der Warteschlange
  ctx = await createTestContext(t.db, { workerSpec: null })
})
afterEach(async () => {
  await ctx.cleanup()
})
afterAll(async () => {
  await t?.destroy()
})

/** Datei in Stücken (wie ein Request-Body) */
function body(size: number, chunk = 64 * 1024): Readable {
  let sent = 0
  return new Readable({
    read() {
      if (sent >= size) return this.push(null)
      const n = Math.min(chunk, size - sent)
      sent += n
      this.push(Buffer.alloc(n, 7))
    },
  })
}

const files = async (dir: string): Promise<string[]> => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(entry.name)
  return out
}

describe('Hochladen', () => {
  it('.zw1: Datei streamend gespeichert, Projekt und Auftrag `upload` angelegt', async () => {
    const result = await uploadProject(ctx, member, { fileName: 'Anlage 7.zw1', body: body(300_000), contentLength: 300_000 })
    expect(result.project).toMatchObject({ source: 'upload', name: 'Anlage 7', path: null, fileKind: 'zw1', createdBy: 'Lena Lernt', latestAnalysis: { id: result.analysis.id } })
    expect(result.analysis).toMatchObject({ status: 'queued', trigger: 'upload', triggeredBy: 'Lena Lernt' })

    const row = await t.db.selectFrom('pds.projects').select(['uploadFile', 'pathKey', 'sourceModified']).where('id', '=', result.project.id).executeTakeFirstOrThrow()
    expect(row.pathKey).toBe('anlage 7')
    expect(row.uploadFile).toMatch(/^\d{17}-[0-9a-f]{6}\/Anlage 7\.zw1$/)
    const path = join(ctx.dataDir, 'uploads', String(result.project.id), ...row.uploadFile!.split('/'))
    expect((await readFile(path)).length).toBe(300_000)
    const analysis = await t.db.selectFrom('pds.analyses').select('uploadFile').where('id', '=', result.analysis.id).executeTakeFirstOrThrow()
    expect(analysis.uploadFile).toBe(row.uploadFile)
    // kein Rest im Zwischenordner
    expect(await files(join(ctx.dataDir, 'uploads', '.incoming'))).toEqual([])
    expect((await listAudit(t.db, admin))[0]).toMatchObject({ action: 'project_uploaded', details: { fileName: 'Anlage 7.zw1', size: 300_000 } })
  })

  it('anderes Format ⇒ 400 upload_invalid_type; Pfade im Namen ⇒ 400 upload_invalid_name', async () => {
    await expect(uploadProject(ctx, member, { fileName: 'Anlage.elk', body: body(10) })).rejects.toMatchObject({ statusCode: 400, message: 'upload_invalid_type' })
    await expect(uploadProject(ctx, member, { fileName: 'Anlage.zw1.txt', body: body(10) })).rejects.toMatchObject({ statusCode: 400, message: 'upload_invalid_type' })
    for (const name of ['../x.zw1', 'a/b.zw1', 'a\\b.zw1', '.zw1', 'a:b.zw1'])
      expect(() => checkUploadName(name), name).toThrow(expect.objectContaining({ message: expect.stringMatching(/^upload_invalid_(name|type)$/) }))
    expect(checkUploadName('Anlage.ZW1')).toEqual({ name: 'Anlage', fileName: 'Anlage.zw1' })
    await expect(uploadProject(ctx, member, { fileName: 'Leer.zw1', body: body(0) })).rejects.toMatchObject({ statusCode: 400, message: 'upload_empty' })
    expect((await listProjects(t.db, member)).total).toBe(0)
  })

  it('zu groß ⇒ 413 upload_too_large (vorab über Content-Length und beim Streamen), nichts bleibt liegen', async () => {
    await saveSettings(ctx, admin, settingsInput({ uploadMaxMb: 1 }))
    await expect(uploadProject(ctx, member, { fileName: 'Gross.zw1', body: body(10), contentLength: 2 * 1024 * 1024 })).rejects.toMatchObject({ statusCode: 413, message: 'upload_too_large' })
    // ohne Content-Length: Abbruch beim Überschreiten
    await expect(uploadProject(ctx, member, { fileName: 'Gross.zw1', body: body(1024 * 1024 + 1) })).rejects.toMatchObject({ statusCode: 413, message: 'upload_too_large', data: { maxMb: 1 } })
    expect(await files(join(ctx.dataDir, 'uploads'))).toEqual([])
    expect((await listProjects(t.db, member)).total).toBe(0)
    // genau an der Grenze geht es
    await expect(uploadProject(ctx, member, { fileName: 'Gross.zw1', body: body(1024 * 1024) })).resolves.toBeDefined()
  })

  it('gleicher Name ⇒ gleiches Projekt mit neuem Stand; wartender Auftrag ⇒ 409 ohne Doppel-Eintrag', async () => {
    const first = await uploadProject(ctx, member, { fileName: 'Anlage.zw1', body: body(10) })
    await expect(uploadProject(ctx, member, { fileName: 'ANLAGE.zw1', body: body(10) })).rejects.toMatchObject({ statusCode: 409, message: 'analysis_already_queued' })
    // der abgelehnte Upload hinterlässt keine Datei
    expect(await files(join(ctx.dataDir, 'uploads'))).toHaveLength(1)

    // Auftrag erledigt (hier von Hand) ⇒ erneutes Hochladen ergibt einen neuen Stand desselben Projekts
    await t.db.updateTable('pds.analyses').set({ status: 'failed', finishedAt: new Date(), errorCode: 'open_failed' }).where('id', '=', first.analysis.id).execute()
    const second = await uploadProject(ctx, admin, { fileName: 'ANLAGE.zw1', body: body(20) })
    expect(second.project.id).toBe(first.project.id)
    expect(second.project.name).toBe('ANLAGE')
    expect(second.analysis.id).not.toBe(first.analysis.id)
    const detail = await getProject(t.db, member, first.project.id)
    expect(detail.analyses.map(a => a.id)).toEqual([second.analysis.id, first.analysis.id])
    expect(await files(join(ctx.dataDir, 'uploads', String(first.project.id)))).toHaveLength(2)
    expect((await listProjects(t.db, member)).total).toBe(1)
  })
})
