import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { CoreDatabase } from '../database/types'

// Laufzeiten in Sekunden
export const CODE_SECONDS = 600
export const ACCESS_TOKEN_SECONDS = 3600
/** Ein bereits eingelöstes Erneuerungs-Token gilt so lange noch einmal (parallele Programmfenster) */
export const REFRESH_GRACE_SECONDS = 60
/** Programme, die nie ein Token bekommen haben, verschwinden wieder (Schutz gegen Registrierungs-Spam) */
export const UNUSED_CLIENT_SECONDS = 86_400
/** So viele nie genutzte Programme dürfen in UNUSED_CLIENT_SECONDS entstehen; danach nimmt die Registrierung vorerst keine an */
export const MAX_UNUSED_CLIENTS = 1000
/** Genutzte Programme ohne Verbindung, die so lange kein Token mehr bekommen haben, verschwinden ebenfalls */
export const IDLE_CLIENT_SECONDS = 180 * 86_400
/**
 * Zustimmen nur mit frischer Anmeldung: die Verbindung endet mit der Sitzung, und die Person hat sich gerade erst
 * über Entra ausgewiesen (Kontosperre, MFA) – nicht vor fast einem Arbeitstag
 */
export const CONSENT_MAX_SESSION_AGE_SECONDS = 600

/** Ids der Datenbank (uniqueidentifier); anderes vorher abweisen, SQL Server würde mit einem Konvertierungsfehler antworten */
export const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export interface OAuthOptions {
  /** Adresse der App ohne abschließenden Schrägstrich, zugleich Aussteller der Tokens */
  issuer: string
  /** geschützte Ressource: `<issuer>/mcp` */
  resource: string
  /** Lebensdauer einer Verbindung ab Zustimmung */
  connectionSeconds: number
  /**
   * Verbindung darf die Sitzung der Zustimmung überdauern (App legt eine eigene Dauer fest, z. B. 30 Tage).
   * Standard: Sie endet spätestens mit der Sitzung.
   */
  outlivesSession?: boolean
  /** Zeitquelle, in Tests austauschbar */
  now?: () => Date
}

export function oauthOptions(appUrl: string, connectionSeconds: number, now?: () => Date, extra: { outlivesSession?: boolean } = {}): OAuthOptions {
  const issuer = appUrl.replace(/\/+$/, '')
  return { issuer, resource: `${issuer}/mcp`, connectionSeconds, now, ...(extra.outlivesSession && { outlivesSession: true }) }
}

export function currentTime(o: OAuthOptions): Date {
  return o.now?.() ?? new Date()
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

/** Fehler im OAuth-Format (`error`, `error_description`); `status` ist der HTTP-Status */
export class OAuthError extends Error {
  constructor(readonly code: string, readonly description: string, readonly status = 400) {
    super(`${code}: ${description}`)
    this.name = 'OAuthError'
  }
}

/** Gespeichert wird nur dieser Hash, nie das Geheimnis selbst */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

/** Zeitkonstanter Vergleich, damit Antwortzeiten nichts über das Geheimnis verraten */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// Herkunft plus Pfad ohne abschließenden Schrägstrich; Query und Fragment gehören nicht zu einer Ressource
function addressOf(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return null
  }
  if (url.search || url.hash || url.username || url.password || url.origin === 'null') return null
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/**
 * Prüft die angefragte Ressource (RFC 8707): erlaubt sind nur die App selbst und ihr `/mcp`;
 * ohne Angabe gilt die eigene Ressource. Liefert immer die eigene Ressource, damit Tokens nie für
 * fremde Zielgruppen ausgestellt werden.
 */
export function normalizeResource(o: OAuthOptions, resource: string | null | undefined): string {
  if (resource === null || resource === undefined || resource === '') return o.resource
  const address = addressOf(resource)
  if (address !== null && (address === addressOf(o.issuer) || address === addressOf(o.resource))) return o.resource
  throw new OAuthError('invalid_target', 'The requested resource is not served by this authorization server')
}

/**
 * Räumt Abgelaufenes auf: Codes, Zugangs-Tokens, Verbindungen (samt Tokens per Kaskade), nie genutzte Programme und
 * lange nicht mehr genutzte ohne Verbindung. Eingelöste Erneuerungs-Tokens bleiben bis zum Ende der Verbindung, sie
 * erkennen die Wiederverwendung.
 */
export async function cleanupOAuth(db: Kysely<CoreDatabase>, now: Date): Promise<void> {
  await db.deleteFrom('core.oauthCodes').where('expiresAt', '<', now).execute()
  await db.deleteFrom('core.mcpTokens').where('kind', '=', 'access').where('expiresAt', '<', now).execute()
  await db.deleteFrom('core.mcpConnections').where('expiresAt', '<', now).execute()
  await db.deleteFrom('core.oauthClients')
    .where('lastUsedAt', 'is', null)
    .where('createdAt', '<', addSeconds(now, -UNUSED_CLIENT_SECONDS))
    .execute()
  await db.deleteFrom('core.oauthClients')
    .where('lastUsedAt', '<', addSeconds(now, -IDLE_CLIENT_SECONDS))
    .where('id', 'not in', eb => eb.selectFrom('core.mcpConnections').select('clientId'))
    .execute()
}

/** Aufräumen nach einer bereits gespeicherten Aktion: scheitert es, darf deren Erfolg nicht zu einem 500 werden */
export async function tryCleanupOAuth(db: Kysely<CoreDatabase>, now: Date): Promise<void> {
  try {
    await cleanupOAuth(db, now)
  }
  catch (error) {
    console.error('[oauth] cleanup', error)
  }
}
