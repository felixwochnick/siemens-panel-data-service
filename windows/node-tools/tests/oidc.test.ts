import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Reporter } from '../src/protocol'
import type { ToolLine } from '../src/protocol'
import { checkClient, checkClientCredentials, isEntraIssuer } from '../src/oidc'
import { runTool, step } from './helpers'

let server: Server
let base: string
let tokenRequests: string[] = []

const document = (issuer: string, extra: Record<string, unknown> = {}) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/keys`,
  ...extra,
})

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type })
      response.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const url = request.url ?? ''
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (url === '/ok/.well-known/openid-configuration') return send(200, document(`${root}/ok`))
    if (url === '/slash/.well-known/openid-configuration') return send(200, document(`${root}/slash`))
    if (url === '/other/.well-known/openid-configuration') return send(200, document('https://anderer.example.com/other'))
    if (url === '/missing/.well-known/openid-configuration') return send(200, { issuer: `${root}/missing`, authorization_endpoint: `${root}/a` })
    if (url === '/html/.well-known/openid-configuration') return send(200, '<html>Anmeldung</html>', 'text/html')
    if (url === '/redirect/.well-known/openid-configuration') {
      response.writeHead(302, { location: '/ok/.well-known/openid-configuration' })
      return response.end()
    }
    if (url === '/err/.well-known/openid-configuration') return send(500, { error: 'boom' })
    if (url === '/ok/token') {
      let body = ''
      request.on('data', chunk => (body += chunk))
      request.on('end', () => {
        tokenRequests.push(body)
        send(400, { error: 'invalid_client' })
      })
      return
    }
    send(404, { error: 'not_found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('oidc-test', () => {
  it('discovery_ok', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/ok` })
    expect(run.result).toMatchObject({ ok: true, code: 'ok' })
    expect(run.exitCode).toBe(0)
    expect(step(run, 'discovery')).toMatchObject({ ok: true })
    expect(step(run, 'issuer')).toMatchObject({ ok: true })
    expect(step(run, 'endpoints')).toMatchObject({ ok: true })
  })

  it('issuer_comparison_is_as_strict_as_the_app', async () => {
    // openid-client vergleicht `new URL(issuer).href` genau; der Schrägstrich am Ende zählt
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/slash/` })
    expect(run.result).toMatchObject({ ok: false, code: 'issuer_mismatch' })
    expect((await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/slash` })).result.ok).toBe(true)
  })

  it('http_issuer_is_a_warning', async () => {
    // Die App erlaubt http nur im Entwicklungsmodus; die Prüfung selbst funktioniert
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/ok` })
    expect(step(run, 'transport')).toMatchObject({ ok: false, details: { warning: true } })
  })

  it('issuer_mismatch', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/other` })
    expect(run.result).toMatchObject({ ok: false, code: 'issuer_mismatch' })
    expect(run.exitCode).toBe(3)
    expect(run.result.message).toContain('https://anderer.example.com/other')
  })

  it('discovery_404', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/gibt-es-nicht` })
    expect(run.result).toMatchObject({ ok: false, code: 'discovery_failed' })
    expect(run.result.details).toMatchObject({ status: 404 })
    expect(run.exitCode).toBe(3)
  })

  it('discovery_server_error_and_redirect', async () => {
    expect((await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/err` })).result).toMatchObject({ code: 'discovery_failed', details: { status: 500 } })
    // Wie die App: Weiterleitungen werden nicht verfolgt
    expect((await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/redirect` })).result).toMatchObject({ code: 'discovery_failed', details: { status: 302 } })
  })

  it('discovery_unreachable', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: 'http://127.0.0.1:1/x' })
    expect(run.result).toMatchObject({ ok: false, code: 'discovery_failed' })
    expect(run.exitCode).toBe(3)
    expect(run.steps.at(-1)).toMatchObject({ code: 'discovery', ok: false })
  })

  it('invalid_discovery', async () => {
    const missing = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/missing` })
    expect(missing.result).toMatchObject({ ok: false, code: 'invalid_discovery' })
    expect(missing.result.message).toContain('token_endpoint')
    expect(missing.result.message).toContain('jwks_uri')
    expect((await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/html` })).result.code).toBe('invalid_discovery')
  })

  it('invalid_issuer_url', async () => {
    for (const issuer of ['kein url', 'ftp://example.com/x']) {
      expect((await runTool('oidc-test', { NUXT_OIDC_ISSUER: issuer })).result.code, issuer).toBe('invalid_url')
    }
  })

  it('client_check_needs_entra', async () => {
    tokenRequests = []
    const run = await runTool('oidc-test', {
      NUXT_OIDC_ISSUER: `${base}/ok`,
      NUXT_OIDC_CLIENT_ID: 'client',
      NUXT_OIDC_CLIENT_SECRET: 'sehr-geheim',
      PDS_OIDC_CHECK_CLIENT: '1',
    })
    // Kein Entra-Issuer: das Secret geht nie an irgendeinen Server
    expect(run.result.ok).toBe(true)
    expect(step(run, 'client')).toMatchObject({ ok: false, details: { warning: true } })
    expect(tokenRequests).toEqual([])
    expect(run.raw.join('\n')).not.toContain('sehr-geheim')
  })

  it('client_check_is_opt_in', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: `${base}/ok`, NUXT_OIDC_CLIENT_ID: 'c', NUXT_OIDC_CLIENT_SECRET: 'sehr-geheim' })
    expect(step(run, 'client')).toBeUndefined()
  })
})

describe('isEntraIssuer', () => {
  it('recognizes_only_microsoft_login_host', () => {
    expect(isEntraIssuer('https://login.microsoftonline.com/0a1b/v2.0')).toBe(true)
    expect(isEntraIssuer('https://login.microsoftonline.com.evil.example/x')).toBe(false)
    expect(isEntraIssuer('https://evil.example/login.microsoftonline.com')).toBe(false)
    expect(isEntraIssuer('http://login.microsoftonline.com/x')).toBe(false)
    expect(isEntraIssuer('kein url')).toBe(false)
  })
})

describe('checkClientCredentials', () => {
  async function check(status: number, body: unknown) {
    const fake = (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch
    return checkClientCredentials('https://login.microsoftonline.com/t/oauth2/v2.0/token', 'client', 'secret', fake)
  }

  it('success', async () => {
    expect(await check(200, { access_token: 'geheimes-token', token_type: 'Bearer' })).toEqual({ kind: 'ok' })
  })

  it('maps_entra_errors', async () => {
    const aadsts = (n: number) => ({ error: 'invalid_client', error_codes: [n], error_description: `AADSTS${n}: Text.\r\nTrace ID: x` })
    expect(await check(401, aadsts(7000215))).toMatchObject({ kind: 'failure', code: 'client_secret_invalid' })
    expect(await check(401, aadsts(7000222))).toMatchObject({ kind: 'failure', code: 'client_secret_expired' })
    expect(await check(400, { ...aadsts(700016), error: 'unauthorized_client' })).toMatchObject({ kind: 'failure', code: 'client_id_unknown' })
    // Nur die Beschreibung, ohne error_codes
    expect(await check(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' })).toMatchObject({ code: 'client_secret_invalid' })
  })

  it('unknown_errors_are_not_failures', async () => {
    const unknown = await check(400, { error: 'invalid_scope', error_codes: [70011], error_description: 'AADSTS70011: Scope fehlerhaft.\r\nTrace ID: abc' })
    expect(unknown).toMatchObject({ kind: 'unknown' })
    expect(JSON.stringify(unknown)).not.toContain('Trace ID')
    // Entra schreibt Trace-ID und Zeitstempel teils in denselben Satz
    const inline = await check(400, { error: 'invalid_grant', error_codes: [53003], error_description: 'AADSTS53003: Zugriff durch eine Richtlinie blockiert. Trace ID: 413ad67e Correlation ID: 8889a61d Timestamp: 2026-11-19 22:50:31Z' })
    expect(inline).toEqual({ kind: 'unknown', message: expect.stringContaining('AADSTS53003: Zugriff durch eine Richtlinie blockiert.') })
    expect(JSON.stringify(inline)).not.toContain('Trace ID')
    expect(await check(502, '<html>Bad Gateway</html>')).toMatchObject({ kind: 'unknown' })
  })

  it('sends_secret_only_in_body', async () => {
    let request: { url: string, body: string } | undefined
    const fake = (async (url: string, init: { body: URLSearchParams }) => {
      request = { url, body: init.body.toString() }
      return new Response('{}', { status: 400 })
    }) as unknown as typeof fetch
    await checkClientCredentials('https://login.microsoftonline.com/t/oauth2/v2.0/token', 'client', 'a b&c', fake)
    expect(request?.url).not.toContain('secret')
    expect(request?.body).toContain('client_secret=a+b%26c')
    expect(request?.body).toContain('grant_type=client_credentials')
  })
})

describe('checkClient', () => {
  const issuer = new URL('https://login.microsoftonline.com/t/v2.0')
  const env = { NUXT_OIDC_CLIENT_ID: 'client', NUXT_OIDC_CLIENT_SECRET: 'sehr-geheim' }

  async function run(tokenEndpoint: string, answer: () => Response = () => new Response('{"access_token":"t"}', { status: 200 })) {
    const lines: ToolLine[] = []
    const requests: string[] = []
    const fake = (async (url: string) => {
      requests.push(url)
      return answer()
    }) as unknown as typeof fetch
    const outcome = await checkClient(env, issuer, { token_endpoint: tokenEndpoint }, new Reporter(line => lines.push(line)), fake)
    return { outcome, lines, requests }
  }

  it('sends_the_secret_only_to_https_on_the_microsoft_host', async () => {
    const accepted = await run('https://login.microsoftonline.com/t/oauth2/v2.0/token')
    expect(accepted.outcome).toBe('ok')
    expect(accepted.requests).toEqual(['https://login.microsoftonline.com/t/oauth2/v2.0/token'])

    // Anderes Schema oder anderer Host: kein Aufruf, nur eine Warnung
    for (const endpoint of ['http://login.microsoftonline.com/t/oauth2/v2.0/token', 'https://evil.example/token', 'https://login.microsoftonline.com.evil.example/token']) {
      const refused = await run(endpoint)
      expect(refused.outcome, endpoint).toBe('warning')
      expect(refused.requests, endpoint).toEqual([])
      expect(refused.lines).toEqual([expect.objectContaining({ code: 'client', ok: false, details: { warning: true } })])
    }
  })
})
