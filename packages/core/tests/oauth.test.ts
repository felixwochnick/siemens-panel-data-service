import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { KyselyPlugin } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreDatabase } from '../server/database'
import {
  CONSENT_MAX_SESSION_AGE_SECONDS,
  MAX_UNUSED_CLIENTS,
  OAuthError,
  approveAuthorization,
  authenticateAccessToken,
  authenticateClient,
  authorizationServerMetadata,
  authorizeInfo,
  checkAuthorizeRequest,
  cleanupOAuth,
  deleteConnection,
  denyAuthorization,
  exchangeToken,
  hashSecret,
  isAllowedRedirectUri,
  listConnections,
  loadConsentSession,
  newSecret,
  normalizeResource,
  oauthOptions,
  protectedResourceMetadata,
  registerClient,
  requireFreshSession,
  revokeToken,
  tryCleanupOAuth,
} from '../server/oauth'
import type { ClientRegistration } from '../server/oauth'
import { grantFromScope, mcpAllows } from '../shared/utils/mcp'
import type { McpGrant } from '../shared/utils/mcp'
import { createTestDatabase, TEST_DIALECT } from './helpers/test-db'
import type { TestDatabase } from './helpers/test-db'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const verifier = 'a'.repeat(43)
const challenge = createHash('sha256').update(verifier).digest('base64url')
// Sitzung, die nach jeder Verbindung endet: dann gilt die volle Verbindungsdauer (eigene Tests prüfen die Kappung)
const SESSION_END = new Date('2100-01-01T00:00:00.000Z')

// Lässt nur das Aufräumen scheitern: es löscht als Erstes abgelaufene Codes ohne OUTPUT (der Code-Tausch löscht mit OUTPUT,
// unter SQLite als RETURNING)
const failingCleanup: KyselyPlugin = {
  transformQuery({ node }) {
    if (node.kind === 'DeleteQueryNode' && !node.output && !node.returning && /oauth_?codes/i.test(JSON.stringify(node.from)))
      throw new Error('cleanup failed')
    return node
  },
  transformResult: async ({ result }) => result,
}

describe('MCP-Stufen', () => {
  it('lesen genügt nicht zum Planen, planen schließt lesen ein', () => {
    expect(mcpAllows('read', 'read')).toBe(true)
    expect(mcpAllows('read', 'write')).toBe(false)
    expect(mcpAllows('write', 'read')).toBe(true)
    expect(mcpAllows('write', 'write')).toBe(true)
  })

  it('nimmt die höchste bekannte Stufe aus dem scope', () => {
    expect(grantFromScope('mcp:read')).toBe('read')
    expect(grantFromScope('openid mcp:write mcp:read')).toBe('write')
    expect(grantFromScope('openid profile')).toBeNull()
    expect(grantFromScope('')).toBeNull()
    expect(grantFromScope(undefined)).toBeNull()
  })
})

describe('Geheimnisse und Adressen', () => {
  it('hasht base64url (SHA-256) und erzeugt Geheimnisse mit Präfix', () => {
    expect(hashSecret('abc')).toBe(createHash('sha256').update('abc').digest('base64url'))
    const a = newSecret('pds_at')
    expect(a).toMatch(/^pds_at_[\w-]{43}$/)
    expect(newSecret('pds_at')).not.toBe(a)
  })

  it('leitet Aussteller und Ressource aus der App-Adresse ab', () => {
    const o = oauthOptions('https://tp.example//', 43_200)
    expect(o).toMatchObject({ issuer: 'https://tp.example', resource: 'https://tp.example/mcp', connectionSeconds: 43_200 })
  })

  it('akzeptiert nur die eigene Ressource', () => {
    const o = oauthOptions('https://tp.example/', 43_200)
    for (const ok of [undefined, null, '', 'https://tp.example', 'https://tp.example/', 'https://tp.example/mcp', 'https://tp.example/mcp/', 'HTTPS://TP.example:443/mcp'])
      expect(normalizeResource(o, ok)).toBe('https://tp.example/mcp')
    for (const bad of ['https://evil.example/mcp', 'https://tp.example/other', 'https://tp.example/mcp/x', 'https://tp.example//mcp', 'http://tp.example/mcp', 'https://tp.example/mcp?x=1', 'https://tp.example/mcp#f', 'tp.example/mcp']) {
      expect(() => normalizeResource(o, bad), bad).toThrow(OAuthError)
      try {
        normalizeResource(o, bad)
      }
      catch (error) {
        expect(error).toMatchObject({ code: 'invalid_target', status: 400 })
      }
    }
  })
})

describe('Metadaten', () => {
  const o = oauthOptions('https://tp.example/', 43_200)

  it('beschreibt die geschützte Ressource (RFC 9728)', () => {
    expect(protectedResourceMetadata(o, 'Trainee Planner')).toEqual({
      resource: 'https://tp.example/mcp',
      authorization_servers: ['https://tp.example'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Trainee Planner',
    })
  })

  it('beschreibt den Autorisierungsserver (RFC 8414) mit allen Endpunkten', () => {
    expect(authorizationServerMetadata(o)).toMatchObject({
      issuer: 'https://tp.example',
      authorization_endpoint: 'https://tp.example/oauth/authorize',
      token_endpoint: 'https://tp.example/oauth/token',
      registration_endpoint: 'https://tp.example/oauth/register',
      revocation_endpoint: 'https://tp.example/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
    })
  })
})

describe('Redirect-URIs', () => {
  it('isAllowedRedirectUri: https und Loopback ja, Rest nein', () => {
    for (const ok of ['http://localhost:33418/callback', 'http://127.0.0.1:1/cb', 'http://[::1]:5/cb', 'https://claude.ai/api/mcp/auth_callback'])
      expect(isAllowedRedirectUri(ok)).toBe(true)
    for (const bad of ['http://example.com/cb', 'cursor://cb', 'https://x.example/cb#f', 'https://x.example/cb#', 'javascript:alert(1)', 'kein url', 'https://user:pw@x.example/cb', 'http://localhost.evil.example/cb'])
      expect(isAllowedRedirectUri(bad), bad).toBe(false)
  })
})

describe('Frische Anmeldung für die Zustimmung', () => {
  const now = new Date('2026-11-19T08:00:00.000Z')
  const session = (ageSeconds: number, endsInSeconds = 12 * 3600) =>
    ({ createdAt: new Date(now.getTime() - ageSeconds * 1000), expiresAt: new Date(now.getTime() + endsInSeconds * 1000) })

  it('höchstens 10 Minuten alt und nicht abgelaufen', () => {
    expect(CONSENT_MAX_SESSION_AGE_SECONDS).toBe(600)
    expect(requireFreshSession(session(0), now)).toEqual(session(0))
    expect(requireFreshSession(session(600), now)).toEqual(session(600))
    for (const stale of [session(601), session(3600), session(0, 0), session(0, -60), undefined]) {
      expect(() => requireFreshSession(stale, now)).toThrow(OAuthError)
      expect(() => requireFreshSession(stale, now)).toThrow(expect.objectContaining({ code: 'reauth_required', status: 401 }))
    }
  })
})

describe(`OAuth (${TEST_DIALECT})`, () => {
  let t: TestDatabase<CoreDatabase>
  const start = new Date('2026-11-19T08:00:00.000Z')
  let now = start
  const o = oauthOptions('https://tp.example/', 43_200, () => now)
  const redirectUri = 'http://localhost:33418/callback'

  beforeAll(async () => {
    t = await createTestDatabase<CoreDatabase>('core_oauth')
  })
  afterAll(() => t?.destroy())

  // Die Uhr ist für alle Tests gemeinsam: jeder beginnt wieder am Ausgangszeitpunkt
  beforeEach(() => {
    now = start
  })

  async function user(): Promise<string> {
    const { id } = await t.db.insertInto('core.users')
      .values({ issuer: 'https://idp', subject: randomUUID(), email: null, displayName: 'Test' })
      .output('inserted.id').executeTakeFirstOrThrow()
    return id
  }

  async function register(extra: Record<string, unknown> = {}) {
    return registerClient(t.db, { client_name: 'Claude Code', redirect_uris: [redirectUri], ...extra }, now)
  }

  function authorizeQuery(clientId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...extra,
    }
  }

  async function expectOAuthError(promise: Promise<unknown>, code: string, status = 400) {
    const error = await promise.then(() => null, (e: unknown) => e)
    expect(error, `erwartet ${code}`).toBeInstanceOf(OAuthError)
    expect(error).toMatchObject({ code, status })
  }

  describe('Registrierung', () => {
    it('registriert öffentliche Programme', async () => {
      const reg = await register()
      expect(reg.client_id).toMatch(/^pds_client_[\w-]{43}$/)
      expect(reg).toMatchObject({
        client_id_issued_at: Math.floor(now.getTime() / 1000),
        client_name: 'Claude Code',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      })
      expect(reg).not.toHaveProperty('client_secret')
      const row = await t.db.selectFrom('core.oauthClients').selectAll().where('id', '=', reg.client_id).executeTakeFirstOrThrow()
      expect(row.secretHash).toBeNull()
      expect(row.lastUsedAt).toBeNull()
      expect(JSON.parse(row.redirectUris)).toEqual([redirectUri])
    })

    it('registriert Programme mit Secret', async () => {
      const reg = await register({ token_endpoint_auth_method: 'client_secret_post' })
      expect(reg.token_endpoint_auth_method).toBe('client_secret_post')
      expect(reg.client_secret).toMatch(/^pds_cs_[\w-]{43}$/)
      expect(reg.client_secret_expires_at).toBe(0)
      const row = await t.db.selectFrom('core.oauthClients').select('secretHash').where('id', '=', reg.client_id).executeTakeFirstOrThrow()
      expect(row.secretHash).toBe(hashSecret(reg.client_secret!))
      expect(row.secretHash).not.toContain('pds_cs_')
    })

    it('kürzt den Namen, setzt einen Standardnamen und ignoriert unbekannte Felder', async () => {
      const named = await register({ client_name: '  Mein Programm  ', logo_uri: 'https://x.example/logo.png', software_id: 'abc' })
      expect(named.client_name).toBe('Mein Programm')
      expect(named).not.toHaveProperty('logo_uri')
      const unnamed = await registerClient(t.db, { redirect_uris: [redirectUri] }, now)
      expect(unnamed.client_name).toBe('MCP')
      const blank = await register({ client_name: '   ' })
      expect(blank.client_name).toBe('MCP')
    })

    it('lehnt ungültige Metadaten ab', async () => {
      const invalidMetadata = async (body: unknown) => expectOAuthError(registerClient(t.db, body, now), 'invalid_client_metadata')
      await invalidMetadata({ client_name: 'x' })
      await invalidMetadata({ redirect_uris: [] })
      await invalidMetadata({ redirect_uris: Array.from({ length: 6 }, (_, i) => `http://localhost:${i + 1}/cb`) })
      await invalidMetadata({ redirect_uris: [redirectUri], grant_types: ['client_credentials'] })
      await invalidMetadata({ redirect_uris: [redirectUri], grant_types: ['refresh_token'] })
      await invalidMetadata({ redirect_uris: [redirectUri], response_types: ['token'] })
      await invalidMetadata({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'private_key_jwt' })
      await invalidMetadata({ redirect_uris: [redirectUri], client_name: 'x'.repeat(101) })
      await invalidMetadata({ redirect_uris: [42] })
      await invalidMetadata(null)
      await invalidMetadata('kein objekt')
      await expectOAuthError(registerClient(t.db, { redirect_uris: ['http://evil.example/cb'] }, now), 'invalid_redirect_uri')
      await expectOAuthError(registerClient(t.db, { redirect_uris: [redirectUri, 'cursor://cb'] }, now), 'invalid_redirect_uri')
    })

    it('begrenzt Rücksprung-Adressen auf 500 Zeichen', async () => {
      const base = 'http://localhost:1/'
      const uri = (length: number) => base + 'a'.repeat(length - base.length)
      expect((await register({ redirect_uris: [uri(500)] })).redirect_uris).toEqual([uri(500)])
      await expectOAuthError(register({ redirect_uris: [uri(501)] }), 'invalid_client_metadata')
    })

    it('entfernt Steuer- und Formatzeichen aus dem Namen (keine Bidi-Täuschung auf der Zustimmungsseite)', async () => {
      const spoofed = await register({ client_name: 'Claude‮ edoC​\u0007 Code⁦' })
      expect(spoofed.client_name).toBe('Claude edoC Code')
      const row = await t.db.selectFrom('core.oauthClients').select('name').where('id', '=', spoofed.client_id).executeTakeFirstOrThrow()
      expect(row.name).toBe('Claude edoC Code')
      expect((await register({ client_name: 'Zeile\nZwei\t' })).client_name).toBe('ZeileZwei')
      // Bleibt nichts übrig, gilt der Standardname
      expect((await register({ client_name: ' ‮⁦​﻿ ' })).client_name).toBe('MCP')
    })

    it('nimmt nach zu vielen nie genutzten Programmen in 24 h vorerst keine mehr an', async () => {
      expect(MAX_UNUSED_CLIENTS).toBe(1000)
      // Eigener Zeitpunkt, damit die Programme der übrigen Tests nicht mitzählen
      const later = new Date(start.getTime() + 100 * DAY)
      const limited = (at: Date) => registerClient(t.db, { client_name: 'Viele', redirect_uris: [redirectUri] }, at, { maxUnusedClients: 2 })
      const first = await limited(later)
      await limited(later)
      await expectOAuthError(limited(later), 'temporarily_unavailable', 503)

      // Genutzte Programme zählen nicht
      await t.db.updateTable('core.oauthClients').set({ lastUsedAt: later }).where('id', '=', first.client_id).execute()
      await limited(later)
      await expectOAuthError(limited(later), 'temporarily_unavailable', 503)
      // Ältere als 24 h ebenfalls nicht
      await expect(limited(new Date(later.getTime() + DAY + 1000))).resolves.toMatchObject({ client_name: 'Viele' })
    })

    it('räumt nie genutzte Programme nach 24 h auf', async () => {
      const unused = await register()
      const used = await register()
      await t.db.updateTable('core.oauthClients').set({ lastUsedAt: now }).where('id', '=', used.client_id).execute()
      await cleanupOAuth(t.db, new Date(now.getTime() + 23 * HOUR))
      expect(await t.db.selectFrom('core.oauthClients').select('id').where('id', '=', unused.client_id).execute()).toHaveLength(1)
      await cleanupOAuth(t.db, new Date(now.getTime() + 25 * HOUR))
      expect(await t.db.selectFrom('core.oauthClients').select('id').where('id', '=', unused.client_id).execute()).toHaveLength(0)
      expect(await t.db.selectFrom('core.oauthClients').select('id').where('id', '=', used.client_id).execute()).toHaveLength(1)
    })

    it('räumt genutzte Programme ohne Verbindung nach 180 Tagen ohne Token auf', async () => {
      const idle = await register()
      const connected = await register()
      const recent = await register()
      const lastUsed = (ids: string[], at: Date) => t.db.updateTable('core.oauthClients').set({ lastUsedAt: at }).where('id', 'in', ids).execute()
      await lastUsed([idle.client_id, connected.client_id], start)
      await lastUsed([recent.client_id], new Date(start.getTime() + 2 * DAY))
      // Eine Verbindung hält ihr Programm (hier künstlich lang, damit das Aufräumen sie nicht vorher entfernt)
      await t.db.insertInto('core.mcpConnections')
        .values({ userId: await user(), clientId: connected.client_id, name: 'Claude Code', access: 'read', expiresAt: new Date(start.getTime() + 400 * DAY) })
        .execute()
      const left = async () => (await t.db.selectFrom('core.oauthClients').select('id')
        .where('id', 'in', [idle.client_id, connected.client_id, recent.client_id]).execute()).map(row => row.id).sort()

      await cleanupOAuth(t.db, new Date(start.getTime() + 179 * DAY))
      expect(await left()).toEqual([idle.client_id, connected.client_id, recent.client_id].sort())
      await cleanupOAuth(t.db, new Date(start.getTime() + 181 * DAY))
      expect(await left()).toEqual([connected.client_id, recent.client_id].sort())
    })

    it('ein fehlschlagendes Aufräumen wird nur protokolliert', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(tryCleanupOAuth(t.db.withPlugin(failingCleanup), now)).resolves.toBeUndefined()
        expect(error).toHaveBeenCalledWith('[oauth] cleanup', expect.objectContaining({ message: 'cleanup failed' }))
      }
      finally {
        error.mockRestore()
      }
    })
  })

  describe('Programm-Anmeldung am Token-Endpunkt', () => {
    it('öffentliche Programme genügt die client_id', async () => {
      const reg = await register()
      await expect(authenticateClient(t.db, { client_id: reg.client_id })).resolves.toEqual({ id: reg.client_id, name: 'Claude Code' })
      await expectOAuthError(authenticateClient(t.db, { client_id: reg.client_id, client_secret: 'pds_cs_geraten' }), 'invalid_client', 401)
    })

    it('Programme mit Secret müssen es per Body oder Basic-Header nennen', async () => {
      const reg = await register({ token_endpoint_auth_method: 'client_secret_basic' })
      const secret = reg.client_secret!
      await expectOAuthError(authenticateClient(t.db, { client_id: reg.client_id }), 'invalid_client', 401)
      await expectOAuthError(authenticateClient(t.db, { client_id: reg.client_id, client_secret: `${secret}x` }), 'invalid_client', 401)
      await expect(authenticateClient(t.db, { client_id: reg.client_id, client_secret: secret })).resolves.toMatchObject({ id: reg.client_id })
      const basic = (id: string, pw: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(pw)}`).toString('base64')}`
      await expect(authenticateClient(t.db, {}, basic(reg.client_id, secret))).resolves.toMatchObject({ id: reg.client_id })
      await expectOAuthError(authenticateClient(t.db, {}, basic(reg.client_id, 'falsch')), 'invalid_client', 401)
      // Basic-Header und abweichende client_id im Body: uneindeutig, also abgelehnt
      await expectOAuthError(authenticateClient(t.db, { client_id: 'pds_client_anderes' }, basic(reg.client_id, secret)), 'invalid_client', 401)
    })

    it('lehnt unbekannte und fehlende Programme mit 401 ab', async () => {
      await expectOAuthError(authenticateClient(t.db, { client_id: 'pds_client_unbekannt' }), 'invalid_client', 401)
      await expectOAuthError(authenticateClient(t.db, {}), 'invalid_client', 401)
      await expectOAuthError(authenticateClient(t.db, { client_id: 42 }), 'invalid_client', 401)
      await expectOAuthError(authenticateClient(t.db, {}, 'Basic !!!'), 'invalid_client', 401)
      await expectOAuthError(authenticateClient(t.db, {}, 'Bearer abc'), 'invalid_client', 401)
    })
  })

  describe('Autorisierung', () => {
    it('prüft Autorisierungsanfragen', async () => {
      const reg = await register()
      const ok = await checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id))
      expect(ok.client).toEqual({ id: reg.client_id, name: 'Claude Code' })
      expect(ok.resource).toBe('https://tp.example/mcp')
      expect(ok.params).toMatchObject({ redirect_uri: redirectUri, code_challenge: challenge, state: 'xyz' })

      const withResource = await checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id, { resource: 'https://tp.example' }))
      expect(withResource.resource).toBe('https://tp.example/mcp')

      const invalidRequest = (extra: Record<string, unknown>) => expectOAuthError(checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id, extra)), 'oauth_invalid_request')
      await invalidRequest({ code_challenge_method: undefined })
      await invalidRequest({ code_challenge_method: 'plain' })
      await invalidRequest({ code_challenge: undefined })
      await invalidRequest({ code_challenge: 'kurz' })
      await invalidRequest({ response_type: 'token' })
      await invalidRequest({ redirect_uri: undefined })
      await invalidRequest({ state: 's'.repeat(2001) })
      await invalidRequest({ state: ['a', 'b'] })
      await expectOAuthError(checkAuthorizeRequest(t.db, o, null), 'oauth_invalid_request')
      await expectOAuthError(checkAuthorizeRequest(t.db, o, 'kein objekt'), 'oauth_invalid_request')

      await expectOAuthError(checkAuthorizeRequest(t.db, o, authorizeQuery('pds_client_unbekannt')), 'oauth_unknown_client')
      await expectOAuthError(checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id, { redirect_uri: 'http://localhost:33418/anders' })), 'oauth_invalid_redirect')
      await expectOAuthError(checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id, { redirect_uri: 'http://evil.example/cb' })), 'oauth_invalid_redirect')
      await expectOAuthError(checkAuthorizeRequest(t.db, o, authorizeQuery(reg.client_id, { resource: 'https://evil.example/mcp' })), 'oauth_invalid_resource')
      await invalidRequest({ redirect_uri: `http://localhost:33418/${'a'.repeat(482)}` })
    })

    it('Loopback-Rücksprung: der Port ist frei, alles andere muss passen (RFC 8252 7.3)', async () => {
      const reg = await register()
      const check = (redirectUri: string, clientId = reg.client_id) => checkAuthorizeRequest(t.db, o, authorizeQuery(clientId, { redirect_uri: redirectUri }))
      // Claude Code lauscht nach jedem Start auf einem anderen Port und nutzt seine gespeicherte client_id weiter
      expect((await check('http://localhost:51234/callback')).params.redirect_uri).toBe('http://localhost:51234/callback')
      expect((await check('http://localhost/callback')).params.redirect_uri).toBe('http://localhost/callback')
      for (const bad of [
        'http://localhost:51234/anders', 'http://localhost:51234/callback/', 'http://localhost:51234/callback?x=1',
        'http://127.0.0.1:33418/callback', 'https://localhost:33418/callback', 'http://localhost:51234/callback#f',
        'http://localhost:99999/callback', 'http://user@localhost:51234/callback', 'http://localhost:51234/Callback',
      ])
        await expectOAuthError(check(bad), 'oauth_invalid_redirect')

      // Registrierte Query bleibt Pflicht, auch bei 127.0.0.1 und [::1]
      const ipv4 = await register({ redirect_uris: ['http://127.0.0.1:1/cb?app=1', 'http://[::1]:2/cb'] })
      await expect(check('http://127.0.0.1:2/cb?app=1', ipv4.client_id)).resolves.toBeDefined()
      await expect(check('http://[::1]:3/cb', ipv4.client_id)).resolves.toBeDefined()
      await expectOAuthError(check('http://127.0.0.1:2/cb?app=2', ipv4.client_id), 'oauth_invalid_redirect')
      await expectOAuthError(check('http://127.0.0.1:2/cb', ipv4.client_id), 'oauth_invalid_redirect')

      // https bleibt exakt
      const web = await register({ redirect_uris: ['https://claude.ai/cb'] })
      await expect(check('https://claude.ai/cb', web.client_id)).resolves.toBeDefined()
      await expectOAuthError(check('https://claude.ai:8443/cb', web.client_id), 'oauth_invalid_redirect')
    })

    it('Loopback-Rücksprung: Code nur mit genau der angefragten Adresse einlösbar', async () => {
      const reg = await register()
      const moved = 'http://localhost:51234/callback'
      const approveAt = async () => new URL(await approveAuthorization(t.db, o, await user(), authorizeQuery(reg.client_id, { redirect_uri: moved }), 'read', SESSION_END))
      const url = await approveAt()
      expect(url.origin + url.pathname).toBe(moved)
      const body = (code: string, redirect: string) => ({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: redirect })
      await expect(exchangeToken(t.db, o, body(url.searchParams.get('code')!, moved))).resolves.toMatchObject({ token_type: 'Bearer' })
      // Die registrierte Adresse mit anderem Port ist beim Tausch nicht dieselbe
      const other = await approveAt()
      await expectOAuthError(exchangeToken(t.db, o, body(other.searchParams.get('code')!, redirectUri)), 'invalid_grant')
    })

    it('Zustimmung verlangt eine frische Anmeldung (Sitzung aus der Datenbank)', async () => {
      const userId = await user()
      const { id } = await t.db.insertInto('core.sessions')
        .values({ userId, expiresAt: new Date(now.getTime() + 12 * HOUR), userAgent: null })
        .output('inserted.id').executeTakeFirstOrThrow()
      const createdAt = async (date: Date) => {
        await sql`UPDATE ${sql.table('core.sessions')} SET created_at = ${date} WHERE id = ${id}`.execute(t.db)
      }
      await createdAt(new Date(now.getTime() - 9 * MINUTE))
      expect(await loadConsentSession(t.db, id, userId, now))
        .toEqual({ createdAt: new Date(now.getTime() - 9 * MINUTE), expiresAt: new Date(now.getTime() + 12 * HOUR) })

      await createdAt(new Date(now.getTime() - 11 * MINUTE))
      await expectOAuthError(loadConsentSession(t.db, id, userId, now), 'reauth_required', 401)
      // Fremde, unbekannte oder fehlende Sitzung: ebenfalls neu anmelden
      await createdAt(now)
      await expectOAuthError(loadConsentSession(t.db, id, await user(), now), 'reauth_required', 401)
      await expectOAuthError(loadConsentSession(t.db, randomUUID(), userId, now), 'reauth_required', 401)
      await expectOAuthError(loadConsentSession(t.db, undefined, userId, now), 'reauth_required', 401)
      await expectOAuthError(loadConsentSession(t.db, 'kein-guid', userId, now), 'reauth_required', 401)
    })

    it('Code merkt sich das Ende der Verbindung: Sitzungsende oder Verbindungsdauer, was früher kommt', async () => {
      const reg = await register()
      const userId = await user()
      const endOf = async (code: string) => (await t.db.selectFrom('core.oauthCodes').select('connectionExpiresAt')
        .where('codeHash', '=', hashSecret(code)).executeTakeFirstOrThrow()).connectionExpiresAt
      const codeFor = async (sessionEnd: Date) =>
        new URL(await approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id), 'read', sessionEnd)).searchParams.get('code')!

      expect(await endOf(await codeFor(new Date(now.getTime() + 2 * HOUR)))).toEqual(new Date(now.getTime() + 2 * HOUR))
      expect(await endOf(await codeFor(new Date(now.getTime() + 20 * HOUR)))).toEqual(new Date(now.getTime() + 12 * HOUR))
    })

    it('zeigt Programmname, Rücksprung-Host und angefragte Stufe', async () => {
      const reg = await register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
      const query = authorizeQuery(reg.client_id, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback' })
      expect(authorizeInfo(await checkAuthorizeRequest(t.db, o, query)))
        .toEqual({ client: { name: 'Claude Code', redirectHost: 'claude.ai' }, requested: null })
      expect(authorizeInfo(await checkAuthorizeRequest(t.db, o, { ...query, scope: 'mcp:read mcp:write' })).requested).toBe('write')
      expect(authorizeInfo(await checkAuthorizeRequest(t.db, o, { ...query, scope: 'mcp:read' })).requested).toBe('read')
      const local = await register()
      expect(authorizeInfo(await checkAuthorizeRequest(t.db, o, authorizeQuery(local.client_id))).client.redirectHost).toBe('localhost:33418')
    })

    it('Zustimmung liefert Code, state und iss', async () => {
      const reg = await register()
      const userId = await user()
      const url = new URL(await approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id), 'read', SESSION_END))
      expect(url.origin + url.pathname).toBe(redirectUri)
      const code = url.searchParams.get('code')!
      expect(code).toMatch(/^pds_code_/)
      expect(url.searchParams.get('state')).toBe('xyz')
      expect(url.searchParams.get('iss')).toBe('https://tp.example')

      const rows = await t.db.selectFrom('core.oauthCodes').selectAll().where('clientId', '=', reg.client_id).execute()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ codeHash: hashSecret(code), userId, redirectUri, codeChallenge: challenge, access: 'read' })
      expect(rows[0]!.expiresAt.getTime()).toBe(now.getTime() + 600_000)
      expect(JSON.stringify(rows)).not.toContain(code)
    })

    it('behält die Query der registrierten Redirect-URI und lässt state weg, wenn keiner kam', async () => {
      const reg = await register({ redirect_uris: ['https://claude.ai/cb?app=1'] })
      const query = authorizeQuery(reg.client_id, { redirect_uri: 'https://claude.ai/cb?app=1', state: undefined })
      const url = new URL(await approveAuthorization(t.db, o, await user(), query, 'write', SESSION_END))
      expect(url.searchParams.get('app')).toBe('1')
      expect(url.searchParams.has('state')).toBe(false)
      expect(url.searchParams.get('iss')).toBe('https://tp.example')
      const row = await t.db.selectFrom('core.oauthCodes').select('access').where('clientId', '=', reg.client_id).executeTakeFirstOrThrow()
      expect(row.access).toBe('write')
    })

    it('Zustimmung räumt abgelaufene Codes auf und verweigert fehlerhafte Anfragen', async () => {
      const reg = await register()
      const userId = await user()
      await approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id), 'read', SESSION_END)
      const before = now
      now = new Date(before.getTime() + 11 * 60_000)
      try {
        await approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id), 'read', SESSION_END)
        const rows = await t.db.selectFrom('core.oauthCodes').select('expiresAt').where('clientId', '=', reg.client_id).execute()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.expiresAt.getTime()).toBe(now.getTime() + 600_000)
        await expectOAuthError(approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id, { redirect_uri: 'http://evil.example/cb' }), 'read', SESSION_END), 'oauth_invalid_redirect')
        await expectOAuthError(approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id, { code_challenge_method: 'plain' }), 'read', SESSION_END), 'oauth_invalid_request')
        expect(await t.db.selectFrom('core.oauthCodes').select('codeHash').where('clientId', '=', reg.client_id).execute()).toHaveLength(1)
      }
      finally {
        now = before
      }
    })

    it('Ablehnung liefert access_denied ohne Code', async () => {
      const reg = await register()
      const url = new URL(await denyAuthorization(t.db, o, authorizeQuery(reg.client_id)))
      expect(url.origin + url.pathname).toBe(redirectUri)
      expect(url.searchParams.get('error')).toBe('access_denied')
      expect(url.searchParams.get('state')).toBe('xyz')
      expect(url.searchParams.get('iss')).toBe('https://tp.example')
      expect(url.searchParams.has('code')).toBe(false)
      expect(await t.db.selectFrom('core.oauthCodes').select('codeHash').where('clientId', '=', reg.client_id).execute()).toHaveLength(0)
      // Auch das Ablehnen leitet nie auf eine nicht registrierte Adresse weiter
      await expectOAuthError(denyAuthorization(t.db, o, authorizeQuery(reg.client_id, { redirect_uri: 'http://evil.example/cb' })), 'oauth_invalid_redirect')
    })
  })

  describe('Tokens', () => {
    const at = (offsetMs: number) => {
      now = new Date(start.getTime() + offsetMs)
    }

    const basicAuth = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`
    const codeBody = (clientId: string, code: string, extra: Record<string, unknown> = {}) =>
      ({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, ...extra })
    const refreshBody = (clientId: string, token: string, extra: Record<string, unknown> = {}) =>
      ({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...extra })

    /** Zustimmung der Person: liefert den Autorisierungscode */
    async function approve(client: ClientRegistration, userId: string, access: McpGrant = 'read', sessionEnd = SESSION_END): Promise<string> {
      const url = new URL(await approveAuthorization(t.db, o, userId, authorizeQuery(client.client_id), access, sessionEnd))
      return url.searchParams.get('code')!
    }

    /** Registrieren, zustimmen und Code tauschen; Person und Programm lassen sich wiederverwenden */
    async function connect(access: McpGrant, existing: { userId?: string, client?: ClientRegistration } = {}) {
      const client = existing.client ?? await register()
      const userId = existing.userId ?? await user()
      const code = await approve(client, userId, access)
      const tokens = await exchangeToken(t.db, o, codeBody(client.client_id, code, { client_secret: client.client_secret }))
      return { client, clientId: client.client_id, userId, tokens }
    }

    const tokenRows = (connectionUserId: string) => t.db.selectFrom('core.mcpTokens as t')
      .innerJoin('core.mcpConnections as c', 'c.id', 't.connectionId')
      .select(['t.tokenHash', 't.kind', 't.expiresAt', 't.usedAt'])
      .where('c.userId', '=', connectionUserId)
      .orderBy('t.kind')
      .execute()

    describe('Code tauschen', () => {
      it('tauscht Code gegen Tokens (PKCE)', async () => {
        const { clientId, userId, tokens } = await connect('read')
        expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' })
        expect(tokens.access_token).toMatch(/^pds_at_[\w-]{43}$/)
        expect(tokens.refresh_token).toMatch(/^pds_rt_[\w-]{43}$/)
        expect(await authenticateAccessToken(t.db, o, tokens.access_token)).toEqual({
          user: { id: userId, displayName: 'Test', email: null, isAdmin: false },
          access: 'read',
          connectionId: expect.any(String),
        })

        // Gespeichert werden nur Hashes; Zugang läuft nach 1 h, Erneuerung mit der Verbindung ab
        const rows = await tokenRows(userId)
        expect(rows.map(row => row.tokenHash).sort()).toEqual([hashSecret(tokens.access_token), hashSecret(tokens.refresh_token)].sort())
        expect(JSON.stringify(rows)).not.toContain(tokens.access_token)
        expect(JSON.stringify(rows)).not.toContain(tokens.refresh_token)
        expect(rows.find(row => row.kind === 'access')!.expiresAt.getTime()).toBe(now.getTime() + HOUR)
        expect(rows.find(row => row.kind === 'refresh')).toMatchObject({ usedAt: null })
        expect(rows.find(row => row.kind === 'refresh')!.expiresAt.getTime()).toBe(now.getTime() + 12 * HOUR)

        const [connection] = await t.db.selectFrom('core.mcpConnections').selectAll().where('userId', '=', userId).execute()
        expect(connection).toMatchObject({ clientId, name: 'Claude Code', access: 'read' })
        expect(connection!.expiresAt.getTime()).toBe(now.getTime() + 12 * HOUR)
      })

      it('übernimmt die Stufe der Zustimmung', async () => {
        const { tokens } = await connect('write')
        expect(tokens.scope).toBe('mcp:write')
        expect((await authenticateAccessToken(t.db, o, tokens.access_token))!.access).toBe('write')
      })

      it('Code ist einmalig und läuft nach 10 min ab', async () => {
        const client = await register()
        const userId = await user()
        const code = await approve(client, userId)
        await exchangeToken(t.db, o, codeBody(client.client_id, code))
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code)), 'invalid_grant')

        const late = await approve(client, userId)
        at(10 * MINUTE)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, late)), 'invalid_grant')
        // abgelaufen heißt auch verbraucht – nicht später doch noch gültig
        at(0)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, late)), 'invalid_grant')
      })

      it('lehnt falschen Verifier, falsches Programm und falsche redirect_uri ab', async () => {
        const client = await register()
        const other = await register()
        const userId = await user()

        const wrongVerifier = await approve(client, userId)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, wrongVerifier, { code_verifier: 'b'.repeat(43) })), 'invalid_grant')
        // Jeder Fehlversuch verbraucht den Code: Raten des Verifiers ist nicht möglich
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, wrongVerifier)), 'invalid_grant')

        const wrongClient = await approve(client, userId)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(other.client_id, wrongClient)), 'invalid_grant')
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, wrongClient)), 'invalid_grant')

        const wrongRedirect = await approve(client, userId)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, wrongRedirect, { redirect_uri: 'http://localhost:33418/anders' })), 'invalid_grant')

        expect(await listConnections(t.db, userId, now)).toEqual([])
      })

      it('verlangt redirect_uri nicht, wenn das Programm keine mitschickt', async () => {
        const client = await register()
        const code = await approve(client, await user())
        await expect(exchangeToken(t.db, o, codeBody(client.client_id, code, { redirect_uri: undefined }))).resolves.toMatchObject({ token_type: 'Bearer' })
      })

      it('prüft resource', async () => {
        const client = await register()
        const code = await approve(client, await user())
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { resource: 'https://evil.example/mcp' })), 'invalid_target')
        // Ein fehlerhafter Parameter verbrennt den Code nicht
        await expect(exchangeToken(t.db, o, codeBody(client.client_id, code, { resource: 'https://tp.example/mcp' }))).resolves.toMatchObject({ scope: 'mcp:read' })
      })

      it('Programm mit Secret muss sich ausweisen', async () => {
        const client = await register({ token_endpoint_auth_method: 'client_secret_basic' })
        const userId = await user()
        const code = await approve(client, userId)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code)), 'invalid_client', 401)
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { client_secret: 'pds_cs_falsch' })), 'invalid_client', 401)
        // Die Anmeldung scheitert vor dem Code: er ist weiter gültig
        const tokens = await exchangeToken(t.db, o, codeBody(client.client_id, code, { client_id: undefined }), basicAuth(client.client_id, client.client_secret!))
        expect(tokens.token_type).toBe('Bearer')
        expect((await authenticateAccessToken(t.db, o, tokens.access_token))!.user.id).toBe(userId)
      })

      it('lehnt ungültige Anfragen ab', async () => {
        const client = await register()
        const userId = await user()
        const code = await approve(client, userId)

        for (const body of [null, undefined, 'grant_type=refresh_token', 42, ['a']])
          await expectOAuthError(exchangeToken(t.db, o, body), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, { client_id: client.client_id }), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, { client_id: client.client_id, grant_type: ['authorization_code'] }), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, { client_id: client.client_id, grant_type: 'password' }), 'unsupported_grant_type')
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { code: undefined })), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { code: [code] })), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { code_verifier: undefined })), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, codeBody(client.client_id, code, { redirect_uri: 42 })), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(client.client_id, '', { refresh_token: undefined })), 'invalid_request')
        await expectOAuthError(exchangeToken(t.db, o, codeBody('pds_client_unbekannt', code)), 'invalid_client', 401)
        await expectOAuthError(exchangeToken(t.db, o, { grant_type: 'authorization_code', code }), 'invalid_client', 401)

        // Nichts davon hat den Code verbraucht
        await expect(exchangeToken(t.db, o, codeBody(client.client_id, code))).resolves.toMatchObject({ token_type: 'Bearer' })
      })

      it('setzt last_used_at des Programms bei jedem Ausstellen, damit es das Aufräumen übersteht', async () => {
        const client = await register()
        const userId = await user()
        const lastUsed = () => t.db.selectFrom('core.oauthClients').select('lastUsedAt').where('id', '=', client.client_id).executeTakeFirst()
        const code = await approve(client, userId)
        expect((await lastUsed())!.lastUsedAt).toBeNull()
        const tokens = await exchangeToken(t.db, o, codeBody(client.client_id, code))
        expect((await lastUsed())!.lastUsedAt).toEqual(now)

        // Auch Erneuern und ein weiterer Code-Tausch zählen als Nutzung
        at(10 * MINUTE)
        await exchangeToken(t.db, o, refreshBody(client.client_id, tokens.refresh_token))
        expect((await lastUsed())!.lastUsedAt).toEqual(now)
        const again = await approve(client, await user())
        at(15 * MINUTE)
        await exchangeToken(t.db, o, codeBody(client.client_id, again))
        expect((await lastUsed())!.lastUsedAt).toEqual(now)
        // Ein abgelehnter Versuch nicht
        at(30 * MINUTE)
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(client.client_id, 'pds_rt_unbekannt')), 'invalid_grant')
        expect((await lastUsed())!.lastUsedAt).toEqual(new Date(start.getTime() + 15 * MINUTE))

        // Verbindung ist nach 12 h weg, das Programm bleibt, damit es sich wieder verbinden kann
        at(25 * HOUR)
        await cleanupOAuth(t.db, now)
        expect(await lastUsed()).toBeDefined()
        expect(await listConnections(t.db, userId, now)).toEqual([])
      })

      it('ein fehlschlagendes Aufräumen macht ausgestellte Tokens nicht zunichte', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          const client = await register()
          const code = await approve(client, await user())
          const failing = t.db.withPlugin(failingCleanup)
          const tokens = await exchangeToken(failing, o, codeBody(client.client_id, code))
          expect(await authenticateAccessToken(t.db, o, tokens.access_token)).not.toBeNull()
          at(MINUTE)
          const renewed = await exchangeToken(failing, o, refreshBody(client.client_id, tokens.refresh_token))
          expect(await authenticateAccessToken(t.db, o, renewed.access_token)).not.toBeNull()
          expect(error).toHaveBeenCalledTimes(2)
          expect(error).toHaveBeenCalledWith('[oauth] cleanup', expect.objectContaining({ message: 'cleanup failed' }))
        }
        finally {
          error.mockRestore()
        }
      })
    })

    describe('Ende mit der Sitzung', () => {
      it('Verbindung endet mit der Sitzung, wenn diese früher endet', async () => {
        const client = await register()
        const userId = await user()
        const sessionEnd = new Date(start.getTime() + 2 * HOUR)
        const code = await approve(client, userId, 'read', sessionEnd)
        at(MINUTE)
        const tokens = await exchangeToken(t.db, o, codeBody(client.client_id, code))
        expect(tokens.expires_in).toBe(3600)
        expect((await listConnections(t.db, userId, now))[0]!.expiresAt).toBe(sessionEnd.toISOString())
        expect((await tokenRows(userId)).find(row => row.kind === 'refresh')!.expiresAt).toEqual(sessionEnd)

        // Kurz vor Ende wird der Zugang gekürzt, danach ist alles ungültig
        at(90 * MINUTE)
        const last = await exchangeToken(t.db, o, refreshBody(client.client_id, tokens.refresh_token))
        expect(last.expires_in).toBe(1800)
        at(2 * HOUR)
        expect(await authenticateAccessToken(t.db, o, last.access_token)).toBeNull()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(client.client_id, last.refresh_token)), 'invalid_grant')
      })

      it('Code-Tausch übernimmt das gespeicherte Ende; ohne eines gilt die volle Verbindungsdauer', async () => {
        const client = await register()
        const capped = await user()
        const code = await approve(client, capped)
        // Nachträglich gesetzt: der Tausch rechnet nicht neu, sondern übernimmt das Ende vom Code
        const end = new Date(start.getTime() + 3 * HOUR)
        await t.db.updateTable('core.oauthCodes').set({ connectionExpiresAt: end }).where('codeHash', '=', hashSecret(code)).execute()
        await exchangeToken(t.db, o, codeBody(client.client_id, code))
        expect((await listConnections(t.db, capped, now))[0]!.expiresAt).toBe(end.toISOString())

        const open = await user()
        const other = await approve(client, open)
        await t.db.updateTable('core.oauthCodes').set({ connectionExpiresAt: null }).where('codeHash', '=', hashSecret(other)).execute()
        at(5 * MINUTE)
        await exchangeToken(t.db, o, codeBody(client.client_id, other))
        expect((await listConnections(t.db, open, now))[0]!.expiresAt).toBe(new Date(start.getTime() + 5 * MINUTE + 12 * HOUR).toISOString())
      })
    })

    describe('Erneuern', () => {
      it('erneuert rotierend mit 60 s Kulanz', async () => {
        const { clientId, userId, tokens: first } = await connect('write')
        at(10_000)
        const second = await exchangeToken(t.db, o, refreshBody(clientId, first.refresh_token))
        expect(second).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:write' })
        expect(second.access_token).toMatch(/^pds_at_/)
        expect(second.refresh_token).toMatch(/^pds_rt_/)
        expect(second.refresh_token).not.toBe(first.refresh_token)
        const used = () => t.db.selectFrom('core.mcpTokens').select('usedAt').where('tokenHash', '=', hashSecret(first.refresh_token)).executeTakeFirstOrThrow()
        expect((await used()).usedAt!.getTime()).toBe(now.getTime())

        // 30 s nach der Einlösung: Kulanz, zweites neues Paar; der Einlösezeitpunkt bleibt der erste
        at(40_000)
        const third = await exchangeToken(t.db, o, refreshBody(clientId, first.refresh_token))
        expect(third.access_token).not.toBe(second.access_token)
        expect(await authenticateAccessToken(t.db, o, third.access_token)).not.toBeNull()
        expect((await used()).usedAt!.getTime()).toBe(start.getTime() + 10_000)

        // 61 s nach der Einlösung: Wiederverwendung gilt als Diebstahl, die Verbindung ist weg
        at(71_000)
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, first.refresh_token)), 'invalid_grant')
        expect(await authenticateAccessToken(t.db, o, third.access_token)).toBeNull()
        expect(await authenticateAccessToken(t.db, o, second.access_token)).toBeNull()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, second.refresh_token)), 'invalid_grant')
        expect(await listConnections(t.db, userId, now)).toEqual([])
      })

      it('rotiert Kette um Kette', async () => {
        const { clientId, tokens } = await connect('read')
        let current = tokens
        for (let i = 1; i <= 3; i++) {
          at(i * 10 * MINUTE)
          current = await exchangeToken(t.db, o, refreshBody(clientId, current.refresh_token))
          expect(await authenticateAccessToken(t.db, o, current.access_token)).not.toBeNull()
        }
      })

      it('gleichzeitige Erneuerungen mit demselben Token liefern alle ein gültiges Paar', async () => {
        const { clientId, userId, tokens } = await connect('read')
        at(5_000)
        // Mehrere Anfragen auf einmal, damit auch der Fall „zweite Anfrage verliert das bedingte UPDATE“ vorkommt
        const pairs = await Promise.all(Array.from({ length: 6 }, () => exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token))))
        expect(new Set(pairs.map(pair => pair.access_token)).size).toBe(6)
        for (const pair of pairs)
          expect(await authenticateAccessToken(t.db, o, pair.access_token)).not.toBeNull()
        expect(await listConnections(t.db, userId, now)).toHaveLength(1)
        // Ausgangspaar plus sechs neue Paare; eingelöst ist nur das Ausgangs-Erneuerungs-Token, und zwar einmal
        const rows = await tokenRows(userId)
        expect(rows).toHaveLength(14)
        expect(rows.filter(row => row.usedAt !== null).map(row => [row.tokenHash, row.usedAt!.getTime()]))
          .toEqual([[hashSecret(tokens.refresh_token), now.getTime()]])
      })

      it('ist an das Programm gebunden', async () => {
        const { clientId, tokens } = await connect('read')
        const other = await register()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(other.client_id, tokens.refresh_token)), 'invalid_grant')
        // Das fremde Programm kann die Verbindung nicht beenden, das eigene erneuert weiter
        await expect(exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token))).resolves.toMatchObject({ token_type: 'Bearer' })
      })

      it('nimmt weder Zugangs-Tokens noch Unbekanntes an', async () => {
        const { clientId, tokens } = await connect('read')
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, tokens.access_token)), 'invalid_grant')
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, 'pds_rt_unbekannt')), 'invalid_grant')
        await expect(exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token))).resolves.toBeDefined()
      })

      it('Programm mit Secret muss sich auch beim Erneuern ausweisen', async () => {
        const client = await register({ token_endpoint_auth_method: 'client_secret_post' })
        const { tokens } = await connect('read', { client })
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(client.client_id, tokens.refresh_token)), 'invalid_client', 401)
        await expect(exchangeToken(t.db, o, refreshBody(client.client_id, tokens.refresh_token, { client_secret: client.client_secret }))).resolves.toBeDefined()
      })
    })

    describe('Laufzeiten', () => {
      it('ältere Zugangs-Tokens bleiben bis zum Ablauf gültig', async () => {
        const { clientId, tokens: first } = await connect('read')
        at(10 * MINUTE)
        const second = await exchangeToken(t.db, o, refreshBody(clientId, first.refresh_token))
        expect(await authenticateAccessToken(t.db, o, first.access_token)).not.toBeNull()
        expect(await authenticateAccessToken(t.db, o, second.access_token)).not.toBeNull()

        at(61 * MINUTE)
        expect(await authenticateAccessToken(t.db, o, first.access_token)).toBeNull()
        // Das zweite wurde 10 min später ausgestellt und lebt noch
        expect(await authenticateAccessToken(t.db, o, second.access_token)).not.toBeNull()
        at(70 * MINUTE)
        expect(await authenticateAccessToken(t.db, o, second.access_token)).toBeNull()
      })

      it('Verbindung endet nach der Sitzungsdauer', async () => {
        const { clientId, tokens } = await connect('read')
        at(11.5 * HOUR)
        const last = await exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token))
        // Der Zugang wird auf das Ende der Verbindung gekürzt
        expect(last.expires_in).toBe(1800)
        expect(await authenticateAccessToken(t.db, o, last.access_token)).not.toBeNull()

        at(12 * HOUR)
        expect(await authenticateAccessToken(t.db, o, last.access_token)).toBeNull()
        at(12 * HOUR + 1000)
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, last.refresh_token)), 'invalid_grant')
      })

      it('räumt beim Ausstellen abgelaufene Zugangs-Tokens auf, Erneuerungs-Tokens nicht', async () => {
        const { clientId, userId, tokens } = await connect('read')
        expect((await tokenRows(userId)).map(row => row.kind)).toEqual(['access', 'refresh'])
        at(61 * MINUTE)
        await exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token))
        const rows = await tokenRows(userId)
        // Alter Zugang weg, eingelöstes altes Erneuerungs-Token bleibt für die Wiederverwendungs-Erkennung
        expect(rows.map(row => row.kind)).toEqual(['access', 'refresh', 'refresh'])
        expect(rows.find(row => row.kind === 'access')!.tokenHash).not.toBe(hashSecret(tokens.access_token))

        at(2 * HOUR + 2 * MINUTE)
        await cleanupOAuth(t.db, now)
        expect((await tokenRows(userId)).map(row => row.kind)).toEqual(['refresh', 'refresh'])
      })
    })

    describe('Zugangs-Token prüfen', () => {
      it('lehnt Unbekanntes und Falsches ab', async () => {
        const { tokens } = await connect('read')
        for (const bad of ['', 'pds_at_', 'pds_at_unbekannt', tokens.refresh_token, tokens.access_token.slice(0, -1), 'Bearer x', 'x'.repeat(5000)])
          expect(await authenticateAccessToken(t.db, o, bad), bad.slice(0, 20)).toBeNull()
      })

      it('Admin-Status und Löschung wirken sofort', async () => {
        const { userId, tokens } = await connect('read')
        const principal = () => authenticateAccessToken(t.db, o, tokens.access_token)
        expect((await principal())!.user).toEqual({ id: userId, displayName: 'Test', email: null, isAdmin: false })

        await t.db.updateTable('core.users').set({ isAdmin: true, displayName: 'Neu', email: 'neu@example.com' }).where('id', '=', userId).execute()
        expect((await principal())!.user).toEqual({ id: userId, displayName: 'Neu', email: 'neu@example.com', isAdmin: true })
        await t.db.updateTable('core.users').set({ isAdmin: false }).where('id', '=', userId).execute()
        expect((await principal())!.user.isAdmin).toBe(false)

        await t.db.deleteFrom('core.users').where('id', '=', userId).execute()
        expect(await principal()).toBeNull()
      })

      it('schreibt last_used_at höchstens einmal pro Minute', async () => {
        const { userId, tokens } = await connect('read')
        const lastUsed = async () => (await listConnections(t.db, userId, now))[0]!.lastUsedAt
        expect(await lastUsed()).toBeNull()
        await authenticateAccessToken(t.db, o, tokens.access_token)
        expect(await lastUsed()).toBe(start.toISOString())
        at(30_000)
        await authenticateAccessToken(t.db, o, tokens.access_token)
        expect(await lastUsed()).toBe(start.toISOString())
        at(60_000)
        await authenticateAccessToken(t.db, o, tokens.access_token)
        expect(await lastUsed()).toBe(new Date(start.getTime() + 60_000).toISOString())
      })
    })

    describe('Verbindungen', () => {
      it('erneutes Verbinden ersetzt die alte Verbindung', async () => {
        const first = await connect('read')
        const second = await connect('write', { userId: first.userId, client: first.client })
        const connections = await listConnections(t.db, first.userId, now)
        expect(connections).toHaveLength(1)
        expect(connections[0]).toMatchObject({ name: 'Claude Code', access: 'write' })
        expect(await authenticateAccessToken(t.db, o, first.tokens.access_token)).toBeNull()
        expect(await authenticateAccessToken(t.db, o, second.tokens.access_token)).not.toBeNull()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(first.clientId, first.tokens.refresh_token)), 'invalid_grant')

        // Ein anderes Programm derselben Person oder dieselbe Person bei einem anderen Programm bleibt unberührt
        const other = await connect('read', { userId: first.userId })
        expect(await listConnections(t.db, first.userId, now)).toHaveLength(2)
        await connect('read', { client: first.client })
        expect(await listConnections(t.db, first.userId, now)).toHaveLength(2)
        expect(await authenticateAccessToken(t.db, o, other.tokens.access_token)).not.toBeNull()
      })

      it('listet Verbindungen mit ISO-Zeiten, nach Beginn sortiert und ohne abgelaufene', async () => {
        const userId = await user()
        const early = await connect('read', { userId })
        at(HOUR)
        const late = await connect('write', { userId })
        at(2 * HOUR)
        const connections = await listConnections(t.db, userId, now)
        expect(connections).toEqual([
          { id: expect.any(String), name: 'Claude Code', access: 'read', createdAt: start.toISOString(), lastUsedAt: null, expiresAt: new Date(start.getTime() + 12 * HOUR).toISOString() },
          { id: expect.any(String), name: 'Claude Code', access: 'write', createdAt: new Date(start.getTime() + HOUR).toISOString(), lastUsedAt: null, expiresAt: new Date(start.getTime() + 13 * HOUR).toISOString() },
        ])

        // Die erste Verbindung endet nach 12 h und wird beim Auflisten samt Tokens entfernt
        at(12 * HOUR + 30 * MINUTE)
        expect(await listConnections(t.db, userId, now)).toHaveLength(1)
        expect(await authenticateAccessToken(t.db, o, early.tokens.access_token)).toBeNull()
        expect(await t.db.selectFrom('core.mcpTokens').select('tokenHash').where('tokenHash', '=', hashSecret(early.tokens.refresh_token)).execute()).toHaveLength(0)
        expect(await authenticateAccessToken(t.db, o, late.tokens.access_token)).toBeNull()
      })

      it('Widerruf beendet die Verbindung', async () => {
        const { clientId, userId, tokens } = await connect('read')
        await revokeToken(t.db, { token: tokens.refresh_token, client_id: clientId })
        expect(await listConnections(t.db, userId, now)).toEqual([])
        expect(await authenticateAccessToken(t.db, o, tokens.access_token)).toBeNull()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token)), 'invalid_grant')
        // Unbekannte und bereits widerrufene Tokens: still in Ordnung (RFC 7009)
        await expect(revokeToken(t.db, { token: tokens.refresh_token, client_id: clientId })).resolves.toBeUndefined()
        await expect(revokeToken(t.db, { token: 'pds_rt_unbekannt', client_id: clientId, token_type_hint: 'refresh_token' })).resolves.toBeUndefined()
      })

      it('Widerruf per Zugangs-Token beendet ebenfalls die ganze Verbindung', async () => {
        const { clientId, userId, tokens } = await connect('read')
        await revokeToken(t.db, { token: tokens.access_token, client_id: clientId })
        expect(await listConnections(t.db, userId, now)).toEqual([])
        expect(await authenticateAccessToken(t.db, o, tokens.access_token)).toBeNull()
      })

      it('Widerruf wirkt nur auf Tokens des eigenen Programms und verlangt dessen Anmeldung', async () => {
        const { clientId, userId, tokens } = await connect('read')
        const other = await register()
        await expect(revokeToken(t.db, { token: tokens.refresh_token, client_id: other.client_id })).resolves.toBeUndefined()
        expect(await listConnections(t.db, userId, now)).toHaveLength(1)

        await expectOAuthError(revokeToken(t.db, { token: tokens.refresh_token, client_id: 'pds_client_unbekannt' }), 'invalid_client', 401)
        await expectOAuthError(revokeToken(t.db, { token: tokens.refresh_token }), 'invalid_client', 401)
        await expectOAuthError(revokeToken(t.db, { client_id: clientId }), 'invalid_request')
        await expectOAuthError(revokeToken(t.db, { token: ['a'], client_id: clientId }), 'invalid_request')
        await expectOAuthError(revokeToken(t.db, null), 'invalid_request')
        expect(await listConnections(t.db, userId, now)).toHaveLength(1)

        const secured = await register({ token_endpoint_auth_method: 'client_secret_basic' })
        const own = await connect('read', { client: secured })
        await expectOAuthError(revokeToken(t.db, { token: own.tokens.refresh_token, client_id: secured.client_id }), 'invalid_client', 401)
        await revokeToken(t.db, { token: own.tokens.refresh_token }, basicAuth(secured.client_id, secured.client_secret!))
        expect(await listConnections(t.db, own.userId, now)).toEqual([])
      })

      it('Verbindungen nur für die eigene Person', async () => {
        const { userId } = await connect('read')
        const stranger = await user()
        const [connection] = await listConnections(t.db, userId, now)
        expect(await deleteConnection(t.db, stranger, connection!.id)).toBe(false)
        expect(await listConnections(t.db, stranger, now)).toEqual([])
        expect(await listConnections(t.db, userId, now)).toHaveLength(1)
        expect(await deleteConnection(t.db, userId, 'kein-guid')).toBe(false)
        expect(await deleteConnection(t.db, userId, randomUUID())).toBe(false)
        expect(await deleteConnection(t.db, userId, connection!.id)).toBe(true)
        expect(await deleteConnection(t.db, userId, connection!.id)).toBe(false)
        expect(await listConnections(t.db, userId, now)).toEqual([])
      })

      it('Trennen beendet auch die Tokens', async () => {
        const { userId, tokens, clientId } = await connect('read')
        const [connection] = await listConnections(t.db, userId, now)
        await deleteConnection(t.db, userId, connection!.id)
        expect(await authenticateAccessToken(t.db, o, tokens.access_token)).toBeNull()
        await expectOAuthError(exchangeToken(t.db, o, refreshBody(clientId, tokens.refresh_token)), 'invalid_grant')
      })
    })
  })

  describe('Schema', () => {
    it('erzwingt gültiges JSON für Redirect-URIs und gültige Stufen', async () => {
      await expect(t.db.insertInto('core.oauthClients').values({ id: 'pds_client_kaputt', name: 'x', redirectUris: 'kein json' }).execute())
        .rejects.toThrow(/ck_oauth_clients_redirect_uris/)
      const reg = await register()
      await expect(t.db.insertInto('core.oauthCodes').values({
        codeHash: 'h1', clientId: reg.client_id, userId: await user(), redirectUri, codeChallenge: challenge, access: 'admin' as 'read', expiresAt: now,
      }).execute()).rejects.toThrow(/ck_oauth_codes_access/)
    })

    it('hat Indizes für Aufräumen und Registrierungs-Obergrenze', async () => {
      const { rows } = TEST_DIALECT === 'sqlite'
        ? await sql<{ name: string, filter: string | null }>`
          SELECT name, CASE WHEN instr(sql, ' WHERE ') > 0 THEN substr(sql, instr(sql, ' WHERE ') + 7) END AS filter
          FROM sqlite_master
          WHERE type = 'index' AND tbl_name IN ('core_oauth_clients', 'core_oauth_codes', 'core_mcp_connections', 'core_mcp_tokens')
            AND name GLOB 'ix_*'`.execute(t.db)
        : await sql<{ name: string, filter: string | null }>`
          SELECT i.name, i.filter_definition AS filter FROM sys.indexes i
          WHERE i.object_id IN (OBJECT_ID('core.oauth_clients'), OBJECT_ID('core.oauth_codes'), OBJECT_ID('core.mcp_connections'), OBJECT_ID('core.mcp_tokens'))
            AND i.name LIKE 'ix[_]%'`.execute(t.db)
      expect(Object.fromEntries(rows.map(row => [row.name, row.filter]))).toMatchObject({
        ix_oauth_clients_unused: TEST_DIALECT === 'sqlite' ? 'last_used_at IS NULL' : '([last_used_at] IS NULL)',
        ix_oauth_codes_expires_at: null,
        ix_mcp_connections_expires_at: null,
        ix_mcp_tokens_expires_at: null,
      })
    })

    it('löscht Codes, Verbindungen und Tokens kaskadierend', async () => {
      const reg = await register()
      const userId = await user()
      await approveAuthorization(t.db, o, userId, authorizeQuery(reg.client_id), 'read', SESSION_END)
      const connect = async (clientId: string, uid: string, tokenHash: string) => {
        const { id } = await t.db.insertInto('core.mcpConnections')
          .values({ userId: uid, clientId, name: 'Claude Code', access: 'read', expiresAt: new Date(now.getTime() + 12 * HOUR) })
          .output('inserted.id').executeTakeFirstOrThrow()
        await t.db.insertInto('core.mcpTokens').values({ tokenHash, connectionId: id, kind: 'access', expiresAt: new Date(now.getTime() + HOUR) }).execute()
      }
      const other = await register()
      await connect(reg.client_id, userId, 'tok-client')
      await connect(other.client_id, userId, 'tok-user')
      const codes = (clientId: string) => t.db.selectFrom('core.oauthCodes').select('codeHash').where('clientId', '=', clientId).execute()
      const connections = (uid: string) => t.db.selectFrom('core.mcpConnections').select('id').where('userId', '=', uid).execute()
      const tokens = (hash: string) => t.db.selectFrom('core.mcpTokens').select('tokenHash').where('tokenHash', '=', hash).execute()

      expect(await codes(reg.client_id)).toHaveLength(1)
      await t.db.deleteFrom('core.oauthClients').where('id', '=', reg.client_id).execute()
      expect(await codes(reg.client_id)).toHaveLength(0)
      expect(await tokens('tok-client')).toHaveLength(0)
      expect(await tokens('tok-user')).toHaveLength(1)

      await t.db.deleteFrom('core.users').where('id', '=', userId).execute()
      expect(await connections(userId)).toHaveLength(0)
      expect(await tokens('tok-user')).toHaveLength(0)
      // Das Programm selbst bleibt, damit es sich später wieder verbinden kann
      expect(await t.db.selectFrom('core.oauthClients').select('id').where('id', '=', other.client_id).execute()).toHaveLength(1)
    })

    it('räumt abgelaufene Verbindungen samt Tokens auf', async () => {
      const reg = await register()
      const userId = await user()
      const { id } = await t.db.insertInto('core.mcpConnections')
        .values({ userId, clientId: reg.client_id, name: 'Claude Code', access: 'write', expiresAt: new Date(now.getTime() + 12 * HOUR) })
        .output('inserted.id').executeTakeFirstOrThrow()
      await t.db.insertInto('core.mcpTokens').values({ tokenHash: 'tok-expiring', connectionId: id, kind: 'refresh', expiresAt: new Date(now.getTime() + 12 * HOUR) }).execute()
      await cleanupOAuth(t.db, new Date(now.getTime() + 11 * HOUR))
      expect(await t.db.selectFrom('core.mcpConnections').select('id').where('id', '=', id).execute()).toHaveLength(1)
      await cleanupOAuth(t.db, new Date(now.getTime() + 13 * HOUR))
      expect(await t.db.selectFrom('core.mcpConnections').select('id').where('id', '=', id).execute()).toHaveLength(0)
      expect(await t.db.selectFrom('core.mcpTokens').select('tokenHash').where('tokenHash', '=', 'tok-expiring').execute()).toHaveLength(0)
    })
  })
})
