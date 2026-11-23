import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMcpTool } from '../server/mcp'
import type { McpServerDefinition } from '../server/mcp'
import { OAuthError, approveAuthorization, exchangeToken, oauthOptions, registerClient } from '../server/oauth'
import type { CoreDatabase } from '../server/database'
import type { McpGrant } from '../shared/utils/mcp'
import { handleMcpRequest, oauthEndpoint } from '../server/utils/mcp'
import { createTestDatabase } from './helpers/test-db'
import type { TestDatabase } from './helpers/test-db'

// handleMcpRequest nutzt die Auto-Importe von Nitro; hier kleine Ersatz-Funktionen auf einem einfachen Ereignis
interface FakeEvent {
  method: string
  headers: Record<string, string>
  body?: string
  status?: number
  responseHeaders: Record<string, string>
  redirect?: string
}

const appUrl = 'https://tp.example'
const redirectUri = 'http://localhost:33418/callback'
const verifier = 'a'.repeat(43)
const challenge = createHash('sha256').update(verifier).digest('base64url')
let config: { public: { appUrl: string, mcpEnabled: unknown }, session: { maxAge: number } }
let t: TestDatabase<CoreDatabase>

const definition: McpServerDefinition = {
  name: 'test-server',
  title: 'Test server',
  version: '1.0.0',
  instructions: 'Use the tools.',
  tools: [
    defineMcpTool({ name: 'echo', title: 'Echo', description: 'Returns the text.', access: 'read', input: { text: z.string() }, handler: async input => ({ text: input.text }) }),
    defineMcpTool({ name: 'change', title: 'Change', description: 'Changes something.', access: 'write', input: {}, handler: async () => ({ changed: true }) }),
  ],
}

beforeAll(async () => {
  t = await createTestDatabase<CoreDatabase>('core_mcp_request')
})
afterAll(() => t?.destroy())

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubNitro() {
  config = { public: { appUrl, mcpEnabled: true }, session: { maxAge: 43_200 } }
  vi.stubGlobal('useRuntimeConfig', () => config)
  vi.stubGlobal('useDb', () => t.db)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name.toLowerCase()])
  vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
    event.status = status
  })
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.responseHeaders[name.toLowerCase()] = value
  })
  vi.stubGlobal('setResponseHeaders', (event: FakeEvent, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries(headers)) event.responseHeaders[name.toLowerCase()] = value
  })
  vi.stubGlobal('sendRedirect', (event: FakeEvent, location: string) => {
    event.redirect = location
    return `redirect:${location}`
  })
  vi.stubGlobal('toWebRequest', (event: FakeEvent) => new Request(`${appUrl}/mcp`, { method: event.method, headers: event.headers, body: event.body }))
}

function fakeEvent(method: string, headers: Record<string, string> = {}, body?: unknown): FakeEvent {
  return {
    method,
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    responseHeaders: {},
  }
}

const call = (event: FakeEvent) => handleMcpRequest(event as unknown as Parameters<typeof handleMcpRequest>[0], definition)

/** Person mit gültigem Zugangs-Token der gewünschten Stufe, über den echten Ablauf ausgestellt */
async function accessToken(access: McpGrant): Promise<string> {
  const o = oauthOptions(appUrl, 43_200)
  const { id } = await t.db.insertInto('core.users')
    .values({ issuer: 'https://idp', subject: randomUUID(), email: null, displayName: 'Test' })
    .output('inserted.id').executeTakeFirstOrThrow()
  const client = await registerClient(t.db, { client_name: 'Claude Code', redirect_uris: [redirectUri] })
  const url = new URL(await approveAuthorization(t.db, o, id, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }, access, new Date(Date.now() + 43_200_000)))
  const tokens = await exchangeToken(t.db, o, {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code: url.searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  })
  return tokens.access_token
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, params })

describe('handleMcpRequest', () => {
  it('antwortet 404, solange MCP nicht ausdrücklich an ist', async () => {
    stubNitro()
    for (const value of [false, 'off', 'false', 'true', 1, undefined]) {
      config.public.mcpEnabled = value
      await expect(call(fakeEvent('POST', {}, rpc('tools/list'))), String(value)).rejects.toMatchObject({ statusCode: 404, message: 'not_found' })
    }
  })

  it('leitet Browser auf die Anleitung um', async () => {
    stubNitro()
    const event = fakeEvent('GET', { accept: 'text/html,application/xhtml+xml' })
    expect(await call(event)).toBe('redirect:/assistants')
    expect(event.redirect).toBe('/assistants')
  })

  it('erlaubt nur POST', async () => {
    stubNitro()
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const event = fakeEvent(method)
      expect(await call(event), method).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
      expect(event.status).toBe(405)
      expect(event.responseHeaders.allow).toBe('POST')
    }
  })

  it('verlangt ein Token und verweist auf die Ressourcen-Metadaten', async () => {
    stubNitro()
    const metadata = `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource/mcp"`
    for (const authorization of [undefined, '', 'Bearer', 'Basic abc']) {
      const event = fakeEvent('POST', authorization === undefined ? {} : { authorization }, rpc('tools/list'))
      expect(await call(event), String(authorization)).toEqual({ error: 'unauthorized' })
      expect(event.status).toBe(401)
      expect(event.responseHeaders['www-authenticate']).toBe(metadata)
    }
    for (const token of ['pds_at_unknown', 'pds_rt_something', 'whatever']) {
      const event = fakeEvent('POST', { authorization: `Bearer ${token}` }, rpc('tools/list'))
      expect(await call(event), token).toEqual({ error: 'invalid_token' })
      expect(event.status).toBe(401)
      expect(event.responseHeaders['www-authenticate']).toBe(`${metadata}, error="invalid_token"`)
    }
  })

  it('beantwortet JSON-RPC mit den Werkzeugen der Stufe', async () => {
    stubNitro()
    const read = await accessToken('read')
    const readResponse = await call(fakeEvent('POST', { authorization: `Bearer ${read}` }, rpc('tools/list'))) as Response
    expect(readResponse.status).toBe(200)
    expect(readResponse.headers.get('content-type')).toContain('application/json')
    const readBody = await readResponse.json() as { result: { tools: Array<{ name: string }> } }
    expect(readBody.result.tools.map(tool => tool.name)).toEqual(['echo'])

    const write = await accessToken('write')
    const writeBody = await (await call(fakeEvent('POST', { authorization: `Bearer ${write}` }, rpc('tools/list'))) as Response).json() as typeof readBody
    expect(writeBody.result.tools.map(tool => tool.name).sort()).toEqual(['change', 'echo'])
  })

  it('führt Werkzeuge aus und setzt keine Sitzung auf', async () => {
    stubNitro()
    const token = await accessToken('read')
    const response = await call(fakeEvent('POST', { authorization: `Bearer ${token}` }, rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }))) as Response
    expect(response.headers.get('mcp-session-id')).toBeNull()
    const body = await response.json() as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ text: 'hi' })
  })

  it('initialize nennt Server und Anleitung', async () => {
    stubNitro()
    const token = await accessToken('read')
    const response = await call(fakeEvent('POST', { authorization: `Bearer ${token}` }, rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }))) as Response
    const body = await response.json() as { result: { serverInfo: { name: string }, instructions: string } }
    expect(body.result.serverInfo.name).toBe('test-server')
    expect(body.result.instructions).toBe('Use the tools.')
  })
})

describe('oauthEndpoint', () => {
  const endpoint = (event: FakeEvent, fn: () => Promise<unknown>) => oauthEndpoint(event as unknown as Parameters<typeof oauthEndpoint>[0], fn)
  const invalidClient = async () => {
    throw new OAuthError('invalid_client', 'Client authentication failed', 401)
  }

  it('liefert OAuth-Fehler mit Status und ohne Zwischenspeichern', async () => {
    stubNitro()
    const event = fakeEvent('POST')
    expect(await endpoint(event, async () => {
      throw new OAuthError('invalid_grant', 'nope')
    })).toEqual({ error: 'invalid_grant', error_description: 'nope' })
    expect(event.status).toBe(400)
    expect(event.responseHeaders['cache-control']).toBe('no-store')
    expect(event.responseHeaders['www-authenticate']).toBeUndefined()
  })

  it('fordert nach gescheiterter Basic-Anmeldung wieder Basic an (RFC 6749 5.2)', async () => {
    stubNitro()
    const basic = fakeEvent('POST', { authorization: 'Basic bHBkX2NsaWVudF94Onk=' })
    expect(await endpoint(basic, invalidClient)).toMatchObject({ error: 'invalid_client' })
    expect(basic.status).toBe(401)
    expect(basic.responseHeaders['www-authenticate']).toBe('Basic realm="oauth"')

    // Ohne Basic-Header (client_id im Body) gibt es nichts anzufordern
    const body = fakeEvent('POST')
    await endpoint(body, invalidClient)
    expect(body.status).toBe(401)
    expect(body.responseHeaders['www-authenticate']).toBeUndefined()
  })
})
