import { createHash, randomBytes } from 'node:crypto'
import { devices, expect, test } from '@playwright/test'
import type { APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test'
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { ageSessions as ageSessionsOf } from './db-exec'
import { APP_URL, E2E_DIALECT, FIXTURE, PROJECTS_DIR } from './targets'
import { PASSWORD, expectNoPageOverflow, gotoHydrated, loggedIn, waitForPage } from './utils'

/*
 * KI-Assistent wie in Betrieb: Ein Programm (hier ein kleiner JSON-RPC-Client) entdeckt die Anmeldung, registriert sich,
 * die Person stimmt im Browser zu, danach arbeitet es mit ihren Rechten. Alle Angemeldeten dürfen das; Admin-Werkzeuge
 * prüfen die Rolle selbst. Projekte, Analysen und Einstellungen stammen aus den vorigen Specs.
 */

const MCP_URL = `${APP_URL}/mcp`
// Rücksprung wie bei Claude Code: Loopback-Adresse des Programms; im Test lauscht dort niemand, der Browser wird abgefangen
const REDIRECT_URI = 'http://127.0.0.1:9/callback'
const CLIENT_NAME = 'E2E-Assistent'
const iPhone = { ...devices['iPhone 13'], defaultBrowserType: undefined }

type Json = Record<string, any>

interface Endpoints {
  authorize: string
  token: string
  register: string
}

interface Tokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

/** `fetch` des SDK über den Playwright-Client: gleiche Zertifikatsregeln wie die übrigen Anfragen (Stack: lokale CA) */
function fetchVia(request: APIRequestContext): FetchLike {
  return async (url, init) => {
    const response = await request.fetch(url.toString(), {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      maxRedirects: 0,
    })
    return new Response(new Uint8Array(await response.body()), { status: response.status(), headers: response.headers() })
  }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorizeQuery(clientId: string, challenge: string, state: string, scope = 'mcp:read mcp:write', redirectUri = REDIRECT_URI) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope,
    resource: MCP_URL,
  }).toString()
}

/** Pfad samt Query, wie ihn der Browser öffnet (die Seite liegt auf demselben Ursprung wie die App) */
const authorizePath = (endpoint: string, query: string) => `${new URL(endpoint).pathname}?${query}`

/** Kleiner MCP-Client: JSON-Antworten (zustandsloser Server), Anmeldung per Bearer-Token */
function mcpClient(request: APIRequestContext, token: string) {
  let nextId = 1
  const post = (message: Json): Promise<APIResponse> => request.post(MCP_URL, {
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    },
    data: { jsonrpc: '2.0', ...message },
  })
  return {
    post,
    /** Anfrage mit Antwort; JSON-RPC-Fehler und HTTP-Fehler bleiben für den Test sichtbar */
    async request(method: string, params?: Json) {
      const response = await post({ id: nextId++, method, params })
      return { status: response.status(), body: (response.status() === 200 ? await response.json() : null) as Json | null }
    },
    async initialize() {
      const { status, body } = await this.request('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'e2e-client', version: '1.0.0' },
      })
      expect(status).toBe(200)
      expect(body?.error).toBeUndefined()
      // Wie ein echter Client: danach „initialized“ melden (Benachrichtigung, keine Antwort außer 202)
      expect((await post({ method: 'notifications/initialized' })).status()).toBe(202)
      return body!.result as Json
    },
    async tools() {
      const { status, body } = await this.request('tools/list')
      expect(status).toBe(200)
      return (body!.result.tools as { name: string }[]).map(t => t.name)
    },
    /** Werkzeugaufruf; Ergebnis ist ein Textblock mit JSON, Fehler als `code: Text` */
    async tool(name: string, args: Json = {}) {
      const { status, body } = await this.request('tools/call', { name, arguments: args })
      expect(status).toBe(200)
      if (body?.error) return { isError: true, text: String(body.error.message), json: null as Json | null }
      const result = body!.result as { isError?: boolean, content: { type: string, text: string }[] }
      const text = result.content[0]!.text
      let json: Json | null = null
      try {
        json = JSON.parse(text)
      }
      catch {
        // Fehlertexte sind kein JSON
      }
      return { isError: result.isError === true, text, json }
    },
  }
}

// ── Ablauf ───────────────────────────────────────────────────────────────────

test.describe.serial('KI-Assistent (MCP)', () => {
  let context: BrowserContext
  let page: Page
  let endpoints: Endpoints
  let clientId = ''
  let readTokens: Tokens
  let writeTokens: Tokens

  test.beforeAll(async ({ browser }) => {
    ;({ context, page } = await loggedIn(browser, 'anna'))
    // Rücksprung des Programms abfangen: der Browser soll nirgends hin, die Adresse genügt
    await context.route(`${new URL(REDIRECT_URI).origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Rücksprung abgefangen' }))
  })

  test.afterAll(async () => {
    await context.close()
  })

  /** Zustimmungsseite öffnen, entscheiden, auf den Rücksprung warten; liefert dessen Adresse */
  async function decide(query: string, decision: { approve: true, access: 'read' | 'write' } | { approve: false }, on: Page = page) {
    await gotoHydrated(on, authorizePath(endpoints.authorize, query))
    await expect(on.getByTestId('oauth-consent')).toBeVisible()
    if (decision.approve) {
      const level = decision.access === 'read' ? /Nur lesen/ : /Lesen und Analysen starten/
      await on.getByRole('radio', { name: level }).check()
      await expect(on.getByRole('radio', { name: level })).toBeChecked()
    }
    const callback = on.waitForRequest(request => request.url().startsWith(REDIRECT_URI))
    await on.getByTestId(decision.approve ? 'oauth-allow' : 'oauth-deny').click()
    return new URL((await callback).url())
  }

  async function exchange(request: APIRequestContext, code: string, verifier: string) {
    return request.post(endpoints.token, {
      form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: MCP_URL },
    })
  }

  /** Vollständige Zustimmung mit Austausch gegen Tokens */
  async function connect(request: APIRequestContext, access: 'read' | 'write', on: Page = page) {
    const { verifier, challenge } = pkce()
    const state = randomBytes(12).toString('base64url')
    const callback = await decide(authorizeQuery(clientId, challenge, state), { approve: true, access }, on)
    expect(callback.searchParams.get('state')).toBe(state)
    expect(callback.searchParams.get('iss')).toBe(APP_URL)
    const code = callback.searchParams.get('code')!
    expect(code).toMatch(/^pds_code_/)
    const response = await exchange(request, code, verifier)
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toContain('no-store')
    return { tokens: await response.json() as Tokens, code, verifier }
  }

  test('ein Programm entdeckt die Anmeldung wie nach RFC 9728 und RFC 8414', async ({ request }) => {
    const fetchFn = fetchVia(request)
    // Wie Claude Code: erst die geschützte Ressource, daraus den Autorisierungsserver
    const resource = await discoverOAuthProtectedResourceMetadata(MCP_URL, {}, fetchFn)
    expect(resource.resource).toBe(MCP_URL)
    expect(resource.authorization_servers).toEqual([APP_URL])
    expect(resource.scopes_supported).toEqual(['mcp:read', 'mcp:write'])

    const server = await discoverAuthorizationServerMetadata(resource.authorization_servers![0]!, { fetchFn })
    expect(server?.issuer).toBe(APP_URL)
    expect(server?.code_challenge_methods_supported).toEqual(['S256'])
    expect(server?.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(server?.registration_endpoint).toBe(`${APP_URL}/oauth/register`)
    endpoints = { authorize: server!.authorization_endpoint, token: server!.token_endpoint, register: server!.registration_endpoint! }
    expect(endpoints).toEqual({ authorize: `${APP_URL}/oauth/authorize`, token: `${APP_URL}/oauth/token`, register: `${APP_URL}/oauth/register` })
  })

  test('ohne Token oder mit fremdem Token antwortet /mcp mit 401 und dem Verweis auf die Metadaten', async ({ request }) => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const headers = { 'accept': 'application/json, text/event-stream', 'content-type': 'application/json' }

    const anonymous = await request.post(MCP_URL, { headers, data: message })
    expect(anonymous.status()).toBe(401)
    expect(anonymous.headers()['www-authenticate']).toBe(`Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp"`)

    const forged = await request.post(MCP_URL, { headers: { ...headers, authorization: `Bearer pds_at_${randomBytes(32).toString('base64url')}` }, data: message })
    expect(forged.status()).toBe(401)
    expect(forged.headers()['www-authenticate']).toContain('error="invalid_token"')
  })

  test('das Programm registriert sich selbst; fremde Rücksprung-Adressen werden abgelehnt', async ({ request }) => {
    const rejected = await request.post(endpoints.register, { data: { client_name: CLIENT_NAME, redirect_uris: ['http://evil.example/callback'] } })
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).error).toBe('invalid_redirect_uri')

    const registered = await request.post(endpoints.register, {
      data: {
        client_name: CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    })
    expect(registered.status()).toBe(201)
    const client = await registered.json()
    expect(client.client_id).toMatch(/^pds_client_/)
    expect(client.client_secret).toBeUndefined()
    clientId = client.client_id
  })

  test('Zustimmung ist immer sichtbar und schlägt „Nur lesen“ vor', async ({ request }) => {
    const { verifier, challenge } = pkce()
    const state = randomBytes(12).toString('base64url')
    // Das Programm fragt wie Claude Code alle Stufen an; vorausgewählt bleibt die niedrigste
    await gotoHydrated(page, authorizePath(endpoints.authorize, authorizeQuery(clientId, challenge, state)))
    await expect(page.getByTestId('oauth-client')).toHaveText(CLIENT_NAME)
    await expect(page.getByTestId('oauth-redirect-host')).toHaveText('127.0.0.1:9')
    await expect(page.getByRole('radio', { name: /Nur lesen/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: /Lesen und Analysen starten/ })).not.toBeChecked()

    const callback = page.waitForRequest(r => r.url().startsWith(REDIRECT_URI))
    await page.getByTestId('oauth-allow').click()
    const url = new URL((await callback).url())
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('iss')).toBe(APP_URL)

    const code = url.searchParams.get('code')!
    // Falscher Verifier verbraucht den Code (kein Raten); der richtige kommt danach zu spät
    expect((await exchange(request, code, pkce().verifier)).status()).toBe(400)
    const again = await exchange(request, code, verifier)
    expect(again.status()).toBe(400)
    expect((await again.json()).error).toBe('invalid_grant')

    // Neue Zustimmung für die Tokens dieses Tests
    const fresh = await connect(request, 'read')
    readTokens = fresh.tokens
    expect(readTokens.token_type).toBe('Bearer')
    expect(readTokens.access_token).toMatch(/^pds_at_/)
    expect(readTokens.refresh_token).toMatch(/^pds_rt_/)
    expect(readTokens.scope).toBe('mcp:read')
    expect(readTokens.expires_in).toBeGreaterThan(3000)
    expect(readTokens.expires_in).toBeLessThanOrEqual(3600)

    // Ein verbrauchter Code ist wertlos
    expect((await exchange(request, fresh.code, fresh.verifier)).status()).toBe(400)
  })

  test('lesende Verbindung: keine schreibenden Werkzeuge; Status, Projekte, Ergebnisse und Einstellungen abrufbar', async ({ request }) => {
    const mcp = mcpClient(request, readTokens.access_token)
    const init = await mcp.initialize()
    expect(init.serverInfo.name).toBe('pds')
    expect(init.instructions).toContain('get_status')

    const tools = await mcp.tools()
    expect(tools.sort()).toEqual(['get_analysis', 'get_project', 'get_settings', 'get_status', 'list_folder_projects', 'list_projects', 'list_shields', 'list_texts', 'query_cables', 'query_connections'])

    // Was nicht angeboten wird, lässt sich auch nicht aufrufen
    const forbidden = await mcp.tool('start_analysis', { projectId: 1 })
    expect(forbidden.isError).toBe(true)

    const status = await mcp.tool('get_status')
    expect(status.isError, status.text).toBe(false)
    expect(status.json?.database).toBe(E2E_DIALECT === 'sqlite' ? 'SQLite' : 'SQL Server')
    expect(status.json?.worker.state).toBe('connected')
    expect(status.json?.scheduler).toMatchObject({ enabled: false, cronSchedule: '0 0 6 ? * MON-FRI' })
    expect(status.json?.recentAnalyses[0].status).toBe('succeeded')

    const projects = await mcp.tool('list_projects')
    expect(projects.json?.total).toBe(3)
    const project = projects.json?.projects.find((p: { name: string }) => p.name === 'Anlage E2E')
    expect(project).toBeTruthy()

    const twisted = await mcp.tool('query_connections', { projectId: project.id, twisted: true })
    expect(twisted.isError, twisted.text).toBe(false)
    expect(twisted.json?.total).toBe(4)
    const all = await mcp.tool('query_connections', { projectId: project.id, limit: 5 })
    expect(all.json?.total).toBe(FIXTURE.connections)
    expect(all.json?.rows).toHaveLength(5)

    const folder = await mcp.tool('list_folder_projects')
    expect(folder.json?.folder).toBe(PROJECTS_DIR)
    expect(folder.json?.total).toBe(2)

    const settings = await mcp.tool('get_settings')
    expect(settings.json?.settings).toMatchObject({ retentionDays: 90, folder: PROJECTS_DIR })
    expect(settings.json?.settings.networkDrive.password).toEqual({ set: false, readable: true })

    // Unbekannte Analyse: Fehlercode statt Rateversuch
    const unknown = await mcp.tool('get_analysis', { analysisId: 999999 })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toMatch(/^not_found/)
  })

  test('„Lesen und Analysen starten“ ersetzt die erste Verbindung; Änderungen wirken in der App', async ({ request }) => {
    writeTokens = (await connect(request, 'write')).tokens
    expect(writeTokens.scope).toBe('mcp:write')

    // Dasselbe Programm und dieselbe Person: die alte Verbindung ist weg
    expect((await mcpClient(request, readTokens.access_token).request('tools/list')).status).toBe(401)

    const mcp = mcpClient(request, writeTokens.access_token)
    await mcp.initialize()
    expect(await mcp.tools()).toEqual(expect.arrayContaining(['start_analysis', 'set_scheduler', 'update_settings']))

    // Passwörter lassen sich über MCP nicht setzen
    const password = await mcp.tool('update_settings', { networkDrive: { password: 'neu' } })
    expect(password.isError).toBe(true)

    const updated = await mcp.tool('update_settings', { retentionDays: 30 })
    expect(updated.isError, updated.text).toBe(false)
    expect(updated.json?.changed).toEqual(['retentionDays'])
    // So sieht es auch die Oberfläche (REST-API mit der Sitzung der Person)
    const settings = await context.request.get(`${APP_URL}/api/settings`)
    expect((await settings.json()).settings.retentionDays).toBe(30)

    const projects = await mcp.tool('list_projects', { search: 'Süd' })
    const started = await mcp.tool('start_analysis', { projectId: projects.json?.projects[0].id })
    expect(started.isError, started.text).toBe(false)
    expect(started.json).toMatchObject({ trigger: 'mcp', triggeredBy: 'Anna Admin' })
    await expect.poll(async () => (await mcp.tool('get_analysis', { analysisId: started.json?.id })).json?.status, { timeout: 30_000 }).toBe('succeeded')

    await mcp.tool('update_settings', { retentionDays: 90 })
  })

  test('Ablehnen führt mit error=access_denied zurück, ohne Verbindung', async ({ request }) => {
    const { challenge } = pkce()
    const state = randomBytes(12).toString('base64url')
    const callback = await decide(authorizeQuery(clientId, challenge, state), { approve: false })
    expect(callback.searchParams.get('error')).toBe('access_denied')
    expect(callback.searchParams.get('state')).toBe(state)
    expect(callback.searchParams.get('iss')).toBe(APP_URL)
    expect(callback.searchParams.get('code')).toBeNull()
    // Die bestehende Verbindung bleibt unberührt
    expect((await mcpClient(request, writeTokens.access_token).request('tools/list')).status).toBe(200)
  })

  test('fehlerhafte Anfragen werden auf der Seite gezeigt und leiten nirgends hin', async () => {
    let evilHits = 0
    await context.route('https://evil.example/**', (route) => {
      evilHits++
      return route.abort()
    })
    const { challenge } = pkce()
    await gotoHydrated(page, authorizePath(endpoints.authorize, authorizeQuery(clientId, challenge, 'x', 'mcp:read', 'https://evil.example/callback')))
    await expect(page.getByTestId('oauth-error')).toBeVisible()
    await expect(page.getByTestId('oauth-allow')).toHaveCount(0)
    expect(new URL(page.url()).origin).toBe(new URL(APP_URL).origin)
    expect(evilHits).toBe(0)

    // Auch ein unbekanntes Programm bekommt keine Weiterleitung
    await gotoHydrated(page, authorizePath(endpoints.authorize, authorizeQuery('pds_client_unbekannt', challenge, 'x')))
    await expect(page.getByTestId('oauth-error')).toBeVisible()
    expect(evilHits).toBe(0)
  })

  test('„KI-Assistenten“ zeigt Befehl und Verbindung', async () => {
    await gotoHydrated(page, '/assistants')
    await expect(page.getByTestId('mcp-command')).toHaveText(`claude mcp add --transport http pds ${MCP_URL}`)
    await expect(page.getByTestId('mcp-privacy')).toBeVisible()
    const connection = page.getByTestId('mcp-connection')
    await expect(connection).toHaveCount(1)
    await expect(connection).toContainText(CLIENT_NAME)
    await expect(connection).toContainText('Lesen und Analysen starten')

    // Erreichbar über das Benutzermenü
    await gotoHydrated(page, '/')
    await page.getByTestId('user-menu').click()
    await page.getByRole('menuitem', { name: 'KI-Assistenten' }).click()
    await page.waitForURL(/\/assistants$/)
  })

  test('mobil: Zustimmung und „KI-Assistenten“ ohne Seitenüberlauf', async ({ browser }) => {
    const mobile = await loggedIn(browser, 'anna', iPhone)
    try {
      const { challenge } = pkce()
      await gotoHydrated(mobile.page, authorizePath(endpoints.authorize, authorizeQuery(clientId, challenge, 'mobil')))
      await expect(mobile.page.getByTestId('oauth-consent')).toBeVisible()
      await expect(mobile.page.getByTestId('oauth-allow')).toBeVisible()
      await expectNoPageOverflow(mobile.page)

      await gotoHydrated(mobile.page, '/assistants')
      await expect(mobile.page.getByTestId('mcp-connection')).toBeVisible()
      await expectNoPageOverflow(mobile.page)
    }
    finally {
      await mobile.context.close()
    }
  })

  test('Nicht-Admins verbinden sich mit ihren Rechten: Admin-Werkzeuge antworten forbidden', async ({ browser, request }) => {
    const paul = await loggedIn(browser, 'paul')
    try {
      await paul.context.route(`${new URL(REDIRECT_URI).origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Rücksprung abgefangen' }))
      const { tokens } = await connect(request, 'write', paul.page)
      const mcp = mcpClient(request, tokens.access_token)
      await mcp.initialize()
      expect((await mcp.tool('list_projects')).json?.total).toBe(3)
      const settings = await mcp.tool('get_settings')
      expect(settings.isError).toBe(true)
      expect(settings.text).toMatch(/^forbidden/)
      expect((await mcp.tool('set_scheduler', { enabled: true })).text).toMatch(/^forbidden/)
      // Paul hat seine eigene Verbindung; Annas bleibt bestehen
      expect((await mcpClient(request, writeTokens.access_token).request('tools/list')).status).toBe(200)
    }
    finally {
      await paul.context.close()
    }
  })

  test('Trennen beendet die Verbindung sofort', async ({ request }) => {
    await gotoHydrated(page, '/assistants')
    await page.getByTestId('mcp-disconnect').click()
    await page.getByTestId('confirm-ok').click()
    await expect(page.getByTestId('mcp-empty')).toBeVisible()

    expect((await mcpClient(request, writeTokens.access_token).request('tools/list')).status).toBe(401)
    // Auch das Erneuerungs-Token ist wertlos
    const refreshed = await request.post(endpoints.token, { form: { grant_type: 'refresh_token', refresh_token: writeTokens.refresh_token, client_id: clientId } })
    expect(refreshed.status()).toBe(400)
    expect((await refreshed.json()).error).toBe('invalid_grant')
  })

  test('ältere Anmeldung: Zustimmung führt einmal über die Anmeldung und zurück', async ({ request }) => {
    // Anmeldung älter als 10 Minuten (die Verbindung endet mit der Sitzung, Zustimmen verlangt eine frische)
    const ageSessions = () => ageSessionsOf('anna@lpd.test', 11)
    /** Test-IdP fragt erneut nach dem Passwort (Entra meldet meist ohne Eingabe an); danach zurück auf die Zustimmungsseite */
    const signInAgain = async () => {
      await page.locator('#login').fill('anna')
      await page.locator('#password').fill(PASSWORD('anna'))
      await page.locator('#submit-login').click()
      await waitForPage(page, url => url.origin === new URL(APP_URL).origin && url.pathname === new URL(endpoints.authorize).pathname)
    }
    const { verifier, challenge } = pkce()
    const state = randomBytes(12).toString('base64url')
    const query = authorizeQuery(clientId, challenge, state)

    await ageSessions()
    await page.goto(APP_URL + authorizePath(endpoints.authorize, query))
    await signInAgain()
    // Dieselbe Anfrage wie vorher, jetzt mit frischer Anmeldung
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(new URLSearchParams(query)))
    await expect(page.getByTestId('oauth-allow')).toBeVisible()

    // Wird die Anmeldung zwischen Laden und Klick zu alt, führt auch „Zulassen“ erst über die Anmeldung
    await ageSessions()
    await page.getByTestId('oauth-allow').click()
    await signInAgain()
    const callback = page.waitForRequest(r => r.url().startsWith(REDIRECT_URI))
    await page.getByTestId('oauth-allow').click()
    const url = new URL((await callback).url())
    expect(url.searchParams.get('state')).toBe(state)
    const response = await exchange(request, url.searchParams.get('code')!, verifier)
    expect(response.status()).toBe(200)
    const tokens = await response.json() as Tokens
    expect(tokens.scope).toBe('mcp:read')
    expect((await mcpClient(request, tokens.access_token).request('tools/list')).status).toBe(200)
  })
})
