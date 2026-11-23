import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '@pds/core/mcp'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import { createPdsMcpServer } from '../server/mcp'
import type { Actor } from '../server/services/access'
import { listAudit } from '../server/services/audit'
import { saveResults } from '../server/services/results'
import { loadSettings, saveSettings } from '../server/services/settings'
import { uploadProject } from '../server/services/uploads'
import { createAppTestDatabase, createTestContext, createUser, settingsInput, syntheticResult, tempFolder } from './helpers/db'
import type { TestContext } from './helpers/db'

const READ_TOOLS = ['get_status', 'list_projects', 'get_project', 'list_folder_projects', 'get_analysis', 'query_connections', 'query_cables', 'list_shields', 'list_texts', 'get_settings']
const WRITE_TOOLS = ['start_analysis', 'set_scheduler', 'update_settings']

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext
const clients: Client[] = []

/** Verbindung wie ein Assistent: eigener Server pro Benutzer und Stufe, Client über den Speicher-Transport */
async function connect(actor: Actor, access: 'read' | 'write' = 'read') {
  const row = await t.db.selectFrom('core.users').select(['id', 'displayName', 'email', 'isAdmin']).where('id', '=', actor.id).executeTakeFirstOrThrow()
  const server = buildMcpServer(createPdsMcpServer(ctx), { user: row, access })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>
const textOf = (result: ToolResult) => (result.content as { type: string, text: string }[])[0]!.text
type Json = ReturnType<typeof JSON.parse>

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, textOf(result)).toBeFalsy()
  return JSON.parse(textOf(result))
}

async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).toBe(true)
  return textOf(result)
}

/** Projekt mit erfolgreichem Stand (30 Verbindungen) */
async function seeded(name = 'Anlage') {
  const { project, analysis } = await uploadProject(ctx, member, { fileName: `${name}.zw1`, body: Readable.from([Buffer.from('x')]) })
  await t.db.updateTable('pds.analyses').set({ status: 'running' }).where('id', '=', analysis.id).execute()
  await saveResults(t.db, { analysisId: analysis.id, projectId: project.id, result: syntheticResult(30, 'm'), meta: { eplanProjectName: name, eplanVersion: null, workerVersion: null, sourceModified: null }, now: new Date() })
  return { projectId: project.id, analysisId: analysis.id }
}

beforeAll(async () => {
  t = await createAppTestDatabase('mcp')
  admin = await createUser(t.db, { isAdmin: true, name: 'Ada Admin' })
  member = await createUser(t.db, { name: 'Max Mitarbeiter' })
})
beforeEach(async () => {
  await t.db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
  await t.db.deleteFrom('pds.projects').execute()
  await t.db.deleteFrom('pds.settings').execute()
  ctx = await createTestContext(t.db, { workerSpec: null })
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await ctx.cleanup()
})
afterAll(async () => {
  await t?.destroy()
})

describe('MCP-Werkzeuge', () => {
  it('Stufe read sieht nur Lese-Werkzeuge, write zusätzlich die schreibenden', async () => {
    const read = await connect(member, 'read')
    expect((await read.listTools()).tools.map(tool => tool.name).sort()).toEqual([...READ_TOOLS].sort())
    const write = await connect(member, 'write')
    expect((await write.listTools()).tools.map(tool => tool.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort())
    const annotations = (await write.listTools()).tools.find(tool => tool.name === 'query_connections')!.annotations
    expect(annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  })

  it('Lesen für alle Angemeldeten: Status, Projekte, Analyse mit Ereignissen', async () => {
    const { projectId, analysisId } = await seeded()
    await t.db.insertInto('pds.analysisEvents').values({ analysisId, at: new Date(), level: 'warn', code: 'unmatched_hash_marks', params: JSON.stringify({ count: 2 }), detail: null }).execute()
    const client = await connect(member)
    const status = await call(client, 'get_status')
    expect(status).toMatchObject({ worker: { state: 'disabled' }, queuedCount: 0, recentAnalyses: [{ id: analysisId, status: 'succeeded' }] })
    expect(status).not.toHaveProperty('scheduler')

    const projects = await call(client, 'list_projects', { search: 'anl' })
    expect(projects).toMatchObject({ total: 1, projects: [{ id: projectId, name: 'Anlage', current: { analysisId, counts: { connections: 30 } } }] })
    const project = await call(client, 'get_project', { projectId })
    expect(project.analyses).toMatchObject([{ id: analysisId, isCurrent: true }])

    const analysis = await call(client, 'get_analysis', { analysisId, level: 'warn' })
    expect(analysis).toMatchObject({ status: 'succeeded', eventCount: 1, events: [{ code: 'unmatched_hash_marks', message: '2 # marks could not be assigned to a connection' }] })
  })

  it('query_connections mit Filtern, limit/offset; Standard = aktueller Stand, optional analysisId', async () => {
    const { projectId, analysisId } = await seeded()
    const client = await connect(member)
    const twisted = await call(client, 'query_connections', { projectId, twisted: true, limit: 3, offset: 2 })
    expect(twisted).toMatchObject({ analysisId, projectId, total: 15, offset: 2 })
    expect(twisted.rows.map((r: { idx: number }) => r.idx)).toEqual([5, 7, 9])
    const byAnalysis = await call(client, 'query_connections', { analysisId, endpoint: 'Q1', hashMark: true })
    expect(byAnalysis.rows.map((r: { idx: number }) => r.idx)).toEqual([10, 15])
    expect((await call(client, 'query_cables', { projectId })).rows[0]).toMatchObject({ name: '-W1', wires: [{ connectionIdx: 0 }] })
    expect((await call(client, 'list_shields', { projectId })).rows[0]).toMatchObject({ connectionIdx: [0, 1] })
    expect((await call(client, 'list_texts', { projectId })).rows).toEqual([{ idx: 0, page: '=A1+S1/1', text: 'Text m' }])
    expect(await callError(client, 'query_connections', {})).toMatch(/^project_or_analysis_required/)
  })

  it('Einstellungen nur für Admins und ohne Passwort', async () => {
    await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { networkPath: '\\\\srv\\eplan', user: 'svc', password: 'Geheim-9' } }))
    expect(await callError(await connect(member), 'get_settings')).toMatch(/^forbidden/)
    const settings = await call(await connect(admin), 'get_settings')
    expect(settings.settings.networkDrive.password).toEqual({ set: true, readable: true })
    expect(JSON.stringify(settings)).not.toContain('Geheim-9')

    const write = await connect(admin, 'write')
    const updated = await call(write, 'update_settings', { retentionDays: 90, eplan: { openMode: 'Standard' } })
    expect(updated.changed).toEqual(expect.arrayContaining(['retentionDays', 'eplan.openMode']))
    expect(await callError(write, 'update_settings', { networkDrive: { password: 'x' } })).toBeTruthy()
    expect(await callError(write, 'update_settings', { networkDrive: { networkPath: '\\\\fremd\\x' } })).toMatch(/^secret_required/)
    expect((await loadSettings(ctx)).settings.networkDrive.password).toBe('Geheim-9')
    expect(await callError(await connect(member, 'write'), 'update_settings', { retentionDays: 5 })).toMatch(/^forbidden/)
    expect(await callError(await connect(member, 'write'), 'set_scheduler', { enabled: false })).toMatch(/^forbidden/)
    expect(await callError(write, 'set_scheduler', { enabled: true })).toMatch(/^settings_incomplete/)
  })

  it('start_analysis (Stufe write): Projekt-ID oder Ordnerpfad, doppelt ⇒ analysis_already_queued', async () => {
    const folder = await tempFolder({ 'Sub/Archiv.zw1': 'x' })
    try {
      const { projectId } = await seeded()
      const write = await connect(member, 'write')
      const started = await call(write, 'start_analysis', { projectId })
      expect(started).toMatchObject({ projectId, status: 'queued', trigger: 'mcp', triggeredBy: 'Max Mitarbeiter' })
      expect(await callError(write, 'start_analysis', { projectId })).toMatch(/^analysis_already_queued/)
      expect(await callError(write, 'start_analysis', {})).toMatch(/^project_or_folder_path_required/)

      await saveSettings(ctx, admin, settingsInput({ folder: folder.dir }))
      const listed = await call(await connect(member), 'list_folder_projects', { changedOnly: true })
      expect(listed).toMatchObject({ total: 1, items: [{ name: 'Archiv', changed: true, project: null }] })
      const fromFolder = await call(write, 'start_analysis', { folderPath: listed.items[0].path })
      expect(fromFolder).toMatchObject({ projectName: 'Archiv', status: 'queued' })
      expect(await callError(write, 'start_analysis', { folderPath: 'Sub/Fehlt.zw1' })).toMatch(/^folder_project_not_found/)
      expect((await listAudit(t.db, admin)).filter(e => e.action === 'analysis_started').map(e => e.details?.via)).toEqual(['mcp', 'mcp'])
    }
    finally {
      await folder.cleanup()
    }
  })
})
