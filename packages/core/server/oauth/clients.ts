import type { Kysely } from 'kysely'
import { z } from 'zod'
import { isAllowedRedirectUri } from '../../shared/utils/mcp'
import type { CoreDatabase } from '../database/types'
import { MAX_UNUSED_CLIENTS, OAuthError, UNUSED_CLIENT_SECONDS, addSeconds, hashSecret, newSecret, safeEqual } from './common'

export { isAllowedRedirectUri }

const MAX_REDIRECT_URIS = 5
/** Claude Code braucht rund 40 Zeichen; mehr Platz dient nur dem Füllen der Datenbank durch anonyme Registrierungen */
export const MAX_REDIRECT_URI_LENGTH = 500
const DEFAULT_CLIENT_NAME = 'MCP'
// Steuer- und Formatzeichen (Bidi-Umschaltung, unsichtbare Leerzeichen) könnten den Namen auf der Zustimmungsseite verfälschen
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

export interface ClientRegistration {
  client_id: string
  client_id_issued_at: number
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic'
  client_secret?: string
  client_secret_expires_at?: 0
}

// Unbekannte Metadaten (logo_uri, software_id, …) sind erlaubt, werden aber nicht gespeichert
const registrationSchema = z.looseObject({
  client_name: z.string().trim().max(100).optional(),
  redirect_uris: z.array(z.string().max(MAX_REDIRECT_URI_LENGTH)).min(1).max(MAX_REDIRECT_URIS),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1)
    .refine(grants => grants.includes('authorization_code'), 'authorization_code is required').optional(),
  response_types: z.array(z.literal('code')).min(1).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
})

/**
 * Dynamische Client-Registrierung (RFC 7591). Jeder darf sich anonym registrieren; damit das die Datenbank nicht
 * füllt, nimmt sie nach `maxUnusedClients` nie genutzten Programmen binnen 24 h vorerst keine mehr an (503).
 */
export async function registerClient(
  db: Kysely<CoreDatabase>,
  body: unknown,
  now = new Date(),
  { maxUnusedClients = MAX_UNUSED_CLIENTS }: { maxUnusedClients?: number } = {},
): Promise<ClientRegistration> {
  const parsed = registrationSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new OAuthError('invalid_client_metadata', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`)
  }
  const metadata = parsed.data
  const bad = metadata.redirect_uris.find(uri => !isAllowedRedirectUri(uri))
  if (bad !== undefined)
    throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must use https or http on localhost, without a fragment')

  const { unused } = await db.selectFrom('core.oauthClients')
    .select(eb => eb.fn.countAll<number>().as('unused'))
    .where('lastUsedAt', 'is', null)
    .where('createdAt', '>', addSeconds(now, -UNUSED_CLIENT_SECONDS))
    .executeTakeFirstOrThrow()
  if (Number(unused) >= maxUnusedClients)
    throw new OAuthError('temporarily_unavailable', 'Too many new clients, try again later', 503)

  const method = metadata.token_endpoint_auth_method ?? 'none'
  const secret = method === 'none' ? undefined : newSecret('pds_cs')
  const registration: ClientRegistration = {
    client_id: newSecret('pds_client'),
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: metadata.client_name?.replace(INVISIBLE, '').trim() || DEFAULT_CLIENT_NAME,
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
  }
  await db.insertInto('core.oauthClients').values({
    id: registration.client_id,
    name: registration.client_name,
    redirectUris: JSON.stringify(registration.redirect_uris),
    secretHash: secret === undefined ? null : hashSecret(secret),
    createdAt: now,
  }).execute()
  if (secret !== undefined) {
    registration.client_secret = secret
    registration.client_secret_expires_at = 0
  }
  return registration
}

export interface StoredClient {
  id: string
  name: string
  redirectUris: string[]
  secretHash: string | null
}

export async function findClient(db: Kysely<CoreDatabase>, id: string): Promise<StoredClient | undefined> {
  const row = await db.selectFrom('core.oauthClients')
    .select(['id', 'name', 'redirectUris', 'secretHash'])
    .where('id', '=', id)
    .executeTakeFirst()
  return row && { ...row, redirectUris: JSON.parse(row.redirectUris) as string[] }
}

const invalidClient = () => new OAuthError('invalid_client', 'Client authentication failed', 401)

// Basic-Header (RFC 6749 2.3.1): id und Secret sind URL-kodiert; andere Schemata gehören nicht zur Programm-Anmeldung
function basicCredentials(authorization: string | undefined): { id: string, secret: string } | null {
  const match = authorization && /^Basic\s+(\S+)$/i.exec(authorization.trim())
  if (!match) return null
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) throw invalidClient()
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1)) }
  }
  catch {
    throw invalidClient()
  }
}

/**
 * Token-/Revoke-Endpunkt: öffentliche Programme nennen nur ihre client_id, Programme mit Secret
 * zusätzlich das Secret (Body oder Basic-Header).
 */
export async function authenticateClient(db: Kysely<CoreDatabase>, body: Record<string, unknown>, authorization?: string): Promise<{ id: string, name: string }> {
  const basic = basicCredentials(authorization)
  const bodyId = typeof body.client_id === 'string' && body.client_id !== '' ? body.client_id : undefined
  // Zwei verschiedene Programme in einer Anfrage sind uneindeutig
  if (basic && bodyId !== undefined && bodyId !== basic.id) throw invalidClient()
  const id = basic?.id ?? bodyId
  if (id === undefined || id.length > 200) throw invalidClient()
  const secret = basic?.secret || (typeof body.client_secret === 'string' ? body.client_secret : '')

  const client = await findClient(db, id)
  if (!client) throw invalidClient()
  // Öffentliche Programme haben kein Secret – ein mitgeschicktes kann nicht stimmen
  if (client.secretHash === null ? secret !== '' : secret === '' || !safeEqual(hashSecret(secret), client.secretHash))
    throw invalidClient()
  return { id: client.id, name: client.name }
}
