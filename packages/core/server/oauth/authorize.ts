import type { Kysely } from 'kysely'
import { z } from 'zod'
import { grantFromScope, isAllowedRedirectUri } from '../../shared/utils/mcp'
import type { AuthorizeInfo, McpGrant } from '../../shared/utils/mcp'
import type { CoreDatabase } from '../database/types'
import { MAX_REDIRECT_URI_LENGTH, findClient } from './clients'
import { CODE_SECONDS, CONSENT_MAX_SESSION_AGE_SECONDS, GUID, OAuthError, addSeconds, cleanupOAuth, currentTime, hashSecret, newSecret, normalizeResource } from './common'
import type { OAuthOptions } from './common'

/** Query der Autorisierungsanfrage; PKCE mit S256 ist Pflicht (OAuth 2.1) */
export const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(MAX_REDIRECT_URI_LENGTH),
  code_challenge: z.string().regex(/^[\w-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
})

export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>

export interface CheckedAuthorize {
  params: AuthorizeQuery
  client: { id: string, name: string }
  resource: string
}

// http auf Loopback ohne Port; der Rest der Adresse bleibt Zeichen für Zeichen, wie er war
const LOOPBACK_AUTHORITY = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?=[/?]|$)/

function withoutLoopbackPort(uri: string): string | null {
  const match = LOOPBACK_AUTHORITY.exec(uri)
  return match ? `http://${match[1]}${uri.slice(match[0].length)}` : null
}

/**
 * Angefragte gegen registrierte Rücksprung-Adresse: exakt, nur bei `http:` auf Loopback ist der Port frei
 * (RFC 8252 7.3, OAuth 2.1 8.4.2). Claude Code lauscht nach jedem Start auf einem anderen freien Port und
 * verwendet seine gespeicherte client_id weiter.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true
  if (!isAllowedRedirectUri(requested)) return false
  const portless = withoutLoopbackPort(registered)
  return portless !== null && portless === withoutLoopbackPort(requested)
}

/**
 * Prüft die Anfrage, bevor irgendetwas angezeigt oder weitergeleitet wird.
 * Fehler gehören auf die Seite, nie in eine Weiterleitung: solange Programm oder Rücksprung-Adresse nicht
 * feststehen, darf die App niemanden irgendwohin schicken.
 */
export async function checkAuthorizeRequest(db: Kysely<CoreDatabase>, o: OAuthOptions, query: unknown): Promise<CheckedAuthorize> {
  const parsed = authorizeQuerySchema.safeParse(query)
  if (!parsed.success) throw new OAuthError('oauth_invalid_request', 'The authorization request is invalid')
  const params = parsed.data

  const client = await findClient(db, params.client_id)
  if (!client) throw new OAuthError('oauth_unknown_client', 'Unknown client')
  if (!client.redirectUris.some(registered => redirectUriMatches(registered, params.redirect_uri)))
    throw new OAuthError('oauth_invalid_redirect', 'Redirect URI is not registered')

  let resource: string
  try {
    resource = normalizeResource(o, params.resource)
  }
  catch {
    throw new OAuthError('oauth_invalid_resource', 'The requested resource is not served by this server')
  }
  return { params, client: { id: client.id, name: client.name }, resource }
}

export function authorizeInfo(checked: CheckedAuthorize): AuthorizeInfo {
  return {
    client: { name: checked.client.name, redirectHost: new URL(checked.params.redirect_uri).host },
    requested: grantFromScope(checked.params.scope),
  }
}

// Parameter an die registrierte Adresse hängen und deren eigene Query behalten; `iss` (RFC 9207) immer dabei
function redirectWith(o: OAuthOptions, redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [name, value] of Object.entries({ ...params, iss: o.issuer }))
    if (value !== undefined) url.searchParams.set(name, value)
  return url.toString()
}

/** Sitzung der Oberfläche, mit der die Person zustimmt */
export interface ConsentSession {
  createdAt: Date
  expiresAt: Date
}

/** Zustimmen nur mit gültiger Sitzung, die höchstens CONSENT_MAX_SESSION_AGE_SECONDS alt ist; sonst neu anmelden (401) */
export function requireFreshSession(session: ConsentSession | undefined, now: Date): ConsentSession {
  if (!session || session.expiresAt <= now || now.getTime() - session.createdAt.getTime() > CONSENT_MAX_SESSION_AGE_SECONDS * 1000)
    throw new OAuthError('reauth_required', 'Sign in again to approve access', 401)
  return session
}

/** Sitzung der Person aus der Datenbank (Beginn und Ende stehen nur dort, nicht im Cookie), geprüft wie oben */
export async function loadConsentSession(db: Kysely<CoreDatabase>, sessionId: string | undefined, userId: string, now: Date): Promise<ConsentSession> {
  const session = sessionId && GUID.test(sessionId)
    ? await db.selectFrom('core.sessions').select(['createdAt', 'expiresAt']).where('id', '=', sessionId).where('userId', '=', userId).executeTakeFirst()
    : undefined
  return requireFreshSession(session, now)
}

/**
 * Zustimmung der Person: legt den Code an (10 min, einmalig) und liefert die Rücksprung-URL mit code, state, iss.
 * Die Verbindung endet spätestens mit der Sitzung, in der zugestimmt wurde – nie später als die Anmeldung in der
 * Oberfläche –, außer die App erlaubt längere Verbindungen (`outlivesSession`, Laufzeit-Option
 * `mcp.connectionSeconds`); das Ende steht am Code, damit der Tausch es übernimmt.
 */
export async function approveAuthorization(db: Kysely<CoreDatabase>, o: OAuthOptions, userId: string, query: unknown, access: McpGrant, sessionExpiresAt: Date): Promise<string> {
  const now = currentTime(o)
  // Zuerst aufräumen: ein abgelaufenes Programm soll als unbekannt gelten, nicht beim Speichern des Codes scheitern
  await cleanupOAuth(db, now)
  const { params, client } = await checkAuthorizeRequest(db, o, query)
  const code = newSecret('pds_code')
  await db.insertInto('core.oauthCodes').values({
    codeHash: hashSecret(code),
    clientId: client.id,
    userId,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    access,
    expiresAt: addSeconds(now, CODE_SECONDS),
    connectionExpiresAt: new Date(Math.min(addSeconds(now, o.connectionSeconds).getTime(), o.outlivesSession ? Infinity : sessionExpiresAt.getTime())),
  }).execute()
  return redirectWith(o, params.redirect_uri, { code, state: params.state })
}

/** Ablehnung der Person: Rücksprung-URL mit error=access_denied, state, iss (nur nach erfolgreicher Prüfung) */
export async function denyAuthorization(db: Kysely<CoreDatabase>, o: OAuthOptions, query: unknown): Promise<string> {
  const { params } = await checkAuthorizeRequest(db, o, query)
  return redirectWith(o, params.redirect_uri, { error: 'access_denied', state: params.state })
}
