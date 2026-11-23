import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../shared/types/auth'
import { requireConsentUser } from '../server/utils/mcp'

/*
 * Zustimmungs-Endpunkte (`/api/oauth/authorize`, GET und POST) mit `mcp.adminOnly`: Die Prüfung sitzt im Handler,
 * nicht in einer Middleware mit Pfadvergleich. Die Nitro-Auto-Importe sind hier kleine Ersatz-Funktionen; requireAuth
 * verhält sich wie das Original (Admin verlangt ⇒ 403 für Nicht-Admins).
 */

const admin: SessionUser = { id: 'a', displayName: 'Ada Admin', email: 'ada@example.com', isAdmin: true }
const member: SessionUser = { id: 'm', displayName: 'Max Mitarbeiter', email: 'max@example.com', isAdmin: false }

let config: { mcp?: { adminOnly?: unknown } }
let user: SessionUser
let reached: string[]

type Handler = (event: unknown) => Promise<unknown>
const handlers = async () => ({
  get: (await import('../server/api/oauth/authorize.get')).default as unknown as Handler,
  post: (await import('../server/api/oauth/authorize.post')).default as unknown as Handler,
})

beforeEach(() => {
  config = {}
  user = member
  reached = []
  vi.stubGlobal('defineEventHandler', (handler: Handler) => handler)
  vi.stubGlobal('useRuntimeConfig', () => config)
  vi.stubGlobal('requireMcpEnabled', () => {})
  vi.stubGlobal('requireConsentUser', requireConsentUser)
  vi.stubGlobal('requireAuth', async (_event: unknown, options: { admin?: boolean } = {}) => {
    if (options.admin && !user.isAdmin) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
    return user
  })
  vi.stubGlobal('useDb', () => {
    reached.push('db')
    return {}
  })
  vi.stubGlobal('useOAuthOptions', () => ({}))
  vi.stubGlobal('getQuery', () => ({}))
  vi.stubGlobal('readValidated', async () => {
    reached.push('body')
    return { query: {}, approve: false }
  })
  vi.stubGlobal('oauthApi', async () => {
    reached.push('oauth')
    return 'https://client.example/callback'
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('Zustimmung mit mcp.adminOnly', () => {
  it('Nicht-Admins bekommen 403, bevor Anfrage oder Body gelesen werden (GET und POST)', async () => {
    config = { mcp: { adminOnly: true } }
    const { get, post } = await handlers()
    await expect(get({})).rejects.toMatchObject({ statusCode: 403, message: 'forbidden' })
    await expect(post({})).rejects.toMatchObject({ statusCode: 403, message: 'forbidden' })
    expect(reached).toEqual([])

    user = admin
    await expect(get({})).resolves.toBe('https://client.example/callback')
    await expect(post({})).resolves.toEqual({ redirect: 'https://client.example/callback' })
  })

  it('Standard (aus): jede angemeldete Person darf zulassen – core bleibt allgemein', async () => {
    const { get, post } = await handlers()
    for (const value of [undefined, { adminOnly: false }]) {
      config = value === undefined ? {} : { mcp: value }
      await expect(get({})).resolves.toBeDefined()
      await expect(post({})).resolves.toBeDefined()
    }
  })

  it('ein unklarer Wert verlangt im Zweifel Admin', async () => {
    const { post } = await handlers()
    for (const adminOnly of ['yes', 1, 'true']) {
      config = { mcp: { adminOnly } }
      await expect(post({})).rejects.toMatchObject({ statusCode: 403 })
    }
  })
})
