import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { SessionUser } from '../../shared/types/auth'
import type { McpConnectionInfo, McpGrant } from '../../shared/utils/mcp'
import type { CoreDatabase } from '../database/types'
import { authenticateClient } from './clients'
import { ACCESS_TOKEN_SECONDS, GUID, OAuthError, REFRESH_GRACE_SECONDS, addSeconds, currentTime, hashSecret, newSecret, normalizeResource, safeEqual, tryCleanupOAuth } from './common'
import type { OAuthOptions } from './common'

/** `last_used_at` einer Verbindung wird höchstens so oft geschrieben (jede MCP-Anfrage prüft ein Token) */
const LAST_USED_INTERVAL_SECONDS = 60

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** Wer die Anfrage stellt: die Person (frisch aus der Datenbank), die Stufe der Verbindung und deren Id */
export interface McpPrincipal {
  user: SessionUser
  access: McpGrant
  connectionId: string
}

// Eine Antwort für alle Gründe (abgelaufen, verbraucht, falsches Programm, falscher Verifier …):
// wer rät, soll nicht erfahren, was daran gestimmt hat
const invalidGrant = () => new OAuthError('invalid_grant', 'The grant is invalid, expired or already used')

// readBody liefert für Formular und JSON ein einfaches Objekt; alles andere ist kein gültiger Token-Request
function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new OAuthError('invalid_request', 'The request body must be form-encoded or a JSON object')
  return body as Record<string, unknown>
}

// Parameter dürfen nur einmal und als Text vorkommen (doppelte Formularfelder werden zur Liste)
function optionalParam(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new OAuthError('invalid_request', `${name} must be a single string`)
  return value
}

function requiredParam(body: Record<string, unknown>, name: string): string {
  const value = optionalParam(body, name)
  if (value === undefined || value === '') throw new OAuthError('invalid_request', `${name} is required`)
  return value
}

/**
 * Token-Endpunkt (RFC 6749 §3.2): `authorization_code` (PKCE) und `refresh_token` (rotierend).
 * Fehler: invalid_request, invalid_client (401), invalid_grant, invalid_target, unsupported_grant_type.
 */
export async function exchangeToken(db: Kysely<CoreDatabase>, o: OAuthOptions, body: unknown, authorization?: string): Promise<TokenResponse> {
  const params = bodyObject(body)
  const client = await authenticateClient(db, params, authorization)
  const grantType = requiredParam(params, 'grant_type')
  const now = currentTime(o)

  let response: TokenResponse
  if (grantType === 'authorization_code') response = await exchangeCode(db, o, now, client, params)
  else if (grantType === 'refresh_token') response = await exchangeRefreshToken(db, now, client, params)
  else throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported')

  // Erst nach dem Ausstellen: sonst könnte das Aufräumen ein nie genutztes, gerade authentifiziertes Programm samt Code löschen.
  // Die Tokens sind dann schon gespeichert – ein Fehler beim Aufräumen darf sie nicht in einen 500 verwandeln.
  await tryCleanupOAuth(db, now)
  return response
}

type ClientIdentity = { id: string, name: string }

async function exchangeCode(db: Kysely<CoreDatabase>, o: OAuthOptions, now: Date, client: ClientIdentity, params: Record<string, unknown>): Promise<TokenResponse> {
  const code = requiredParam(params, 'code')
  const verifier = requiredParam(params, 'code_verifier')
  const redirectUri = optionalParam(params, 'redirect_uri')
  // Vor dem Verbrauchen: ein falscher Parameter soll den Code nicht verbrennen
  normalizeResource(o, optionalParam(params, 'resource'))

  // Wer den Code als Erster löscht, darf ihn prüfen; jeder Fehlversuch verbraucht ihn (kein Raten des Verifiers)
  const row = await db.deleteFrom('core.oauthCodes')
    .where('codeHash', '=', hashSecret(code))
    .output(['deleted.clientId', 'deleted.userId', 'deleted.redirectUri', 'deleted.codeChallenge', 'deleted.access', 'deleted.expiresAt', 'deleted.connectionExpiresAt'])
    .executeTakeFirst()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  if (!row || row.expiresAt <= now || row.clientId !== client.id
    || (redirectUri !== undefined && redirectUri !== row.redirectUri)
    || !safeEqual(challenge, row.codeChallenge))
    throw invalidGrant()

  // Ende wie bei der Zustimmung festgelegt (spätestens Ende der Sitzung); Codes ohne Angabe bekommen die volle Dauer
  const expiresAt = new Date(Math.min(addSeconds(now, o.connectionSeconds).getTime(), row.connectionExpiresAt?.getTime() ?? Infinity))
  return db.transaction().execute(async (trx) => {
    // Erneutes Verbinden derselben Person mit demselben Programm ersetzt die alte Verbindung (Tokens fallen per Kaskade)
    await trx.deleteFrom('core.mcpConnections').where('userId', '=', row.userId).where('clientId', '=', client.id).execute()
    const connection = await trx.insertInto('core.mcpConnections')
      .values({ userId: row.userId, clientId: client.id, name: client.name, access: row.access, expiresAt, createdAt: now })
      .output(['inserted.id', 'inserted.access', 'inserted.expiresAt'])
      .executeTakeFirstOrThrow()
    await markClientUsed(trx, client.id, now)
    return issueTokens(trx, now, connection)
  })
}

// Ein Programm mit Token zählt als genutzt – sonst würde das Aufräumen es nach 24 h (nie genutzt) bzw. 180 Tagen
// (lange nicht genutzt) löschen, und Claude Code müsste sich neu registrieren
async function markClientUsed(db: Kysely<CoreDatabase>, clientId: string, now: Date): Promise<void> {
  await db.updateTable('core.oauthClients').set({ lastUsedAt: now }).where('id', '=', clientId).execute()
}

async function exchangeRefreshToken(db: Kysely<CoreDatabase>, now: Date, client: ClientIdentity, params: Record<string, unknown>): Promise<TokenResponse> {
  const hash = hashSecret(requiredParam(params, 'refresh_token'))

  // Nach der Transaktion werfen: ein Fehler darin würde das Löschen der Verbindung zurückrollen
  const response = await db.transaction().execute(async (trx): Promise<TokenResponse | null> => {
    const token = await trx.selectFrom('core.mcpTokens as t')
      .innerJoin('core.mcpConnections as c', 'c.id', 't.connectionId')
      .select(['t.usedAt', 'c.id', 'c.access', 'c.expiresAt'])
      .where('t.tokenHash', '=', hash)
      .where('t.kind', '=', 'refresh')
      .where('t.expiresAt', '>', now)
      .where('c.clientId', '=', client.id)
      .where('c.expiresAt', '>', now)
      .executeTakeFirst()
    if (!token) return null

    // Bedingtes UPDATE: bei zwei gleichzeitigen Anfragen mit demselben Token gewinnt genau eine
    const claimed = token.usedAt === null
      && Number((await trx.updateTable('core.mcpTokens').set({ usedAt: now }).where('tokenHash', '=', hash).where('usedAt', 'is', null).executeTakeFirst()).numUpdatedRows) > 0
    if (!claimed) {
      const usedAt = token.usedAt
        ?? (await trx.selectFrom('core.mcpTokens').select('usedAt').where('tokenHash', '=', hash).executeTakeFirst())?.usedAt
      if (!usedAt) return null
      // Bereits eingelöst: kurz nach der Rotation ist das normal (mehrere Fenster), später gilt es als Diebstahl
      if (now.getTime() - usedAt.getTime() > REFRESH_GRACE_SECONDS * 1000) {
        await trx.deleteFrom('core.mcpConnections').where('id', '=', token.id).execute()
        return null
      }
    }
    await markClientUsed(trx, client.id, now)
    return issueTokens(trx, now, token)
  })
  if (response === null) throw invalidGrant()
  return response
}

// Zugang nie länger als die Verbindung; das Erneuerungs-Token lebt genau so lange wie sie
async function issueTokens(db: Kysely<CoreDatabase>, now: Date, connection: { id: string, access: McpGrant, expiresAt: Date }): Promise<TokenResponse> {
  const accessToken = newSecret('pds_at')
  const refreshToken = newSecret('pds_rt')
  const accessExpiresAt = new Date(Math.min(addSeconds(now, ACCESS_TOKEN_SECONDS).getTime(), connection.expiresAt.getTime()))
  await db.insertInto('core.mcpTokens').values([
    { tokenHash: hashSecret(accessToken), connectionId: connection.id, kind: 'access', expiresAt: accessExpiresAt },
    { tokenHash: hashSecret(refreshToken), connectionId: connection.id, kind: 'refresh', expiresAt: connection.expiresAt },
  ]).execute()
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000),
    refresh_token: refreshToken,
    scope: `mcp:${connection.access}`,
  }
}

/**
 * Widerruf (RFC 7009): Zugangs- oder Erneuerungs-Token beendet die ganze Verbindung.
 * Unbekannte Tokens und Tokens anderer Programme bleiben still ohne Wirkung; das Programm muss sich ausweisen.
 */
export async function revokeToken(db: Kysely<CoreDatabase>, body: unknown, authorization?: string): Promise<void> {
  const params = bodyObject(body)
  const client = await authenticateClient(db, params, authorization)
  const token = requiredParam(params, 'token')
  await db.deleteFrom('core.mcpConnections')
    .where('clientId', '=', client.id)
    .where('id', 'in', eb => eb.selectFrom('core.mcpTokens').select('connectionId').where('tokenHash', '=', hashSecret(token)))
    .execute()
}

/** Prüft ein Zugangs-Token bei jeder MCP-Anfrage; die Person kommt frisch aus der Datenbank (Admin-Status, Löschung) */
export async function authenticateAccessToken(db: Kysely<CoreDatabase>, o: OAuthOptions, token: string): Promise<McpPrincipal | null> {
  // Ohne Präfix kann es keines von uns sein: spart die Abfrage bei Fremdem und Erneuerungs-Tokens
  if (!token.startsWith('pds_at_')) return null
  const now = currentTime(o)
  const row = await db.selectFrom('core.mcpTokens as t')
    .innerJoin('core.mcpConnections as c', 'c.id', 't.connectionId')
    .innerJoin('core.users as u', 'u.id', 'c.userId')
    .select(['c.id as connectionId', 'c.access', 'c.lastUsedAt', 'u.id as userId', 'u.displayName', 'u.email', 'u.isAdmin'])
    .where('t.tokenHash', '=', hashSecret(token))
    .where('t.kind', '=', 'access')
    .where('t.expiresAt', '>', now)
    .where('c.expiresAt', '>', now)
    .executeTakeFirst()
  if (!row) return null

  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_INTERVAL_SECONDS * 1000)
    await db.updateTable('core.mcpConnections').set({ lastUsedAt: now }).where('id', '=', row.connectionId).execute()
  return {
    user: { id: row.userId, displayName: row.displayName, email: row.email, isAdmin: row.isAdmin },
    access: row.access,
    connectionId: row.connectionId,
  }
}

/** Verbindungen der Person, älteste zuerst; abgelaufene werden vorher samt Tokens entfernt */
export async function listConnections(db: Kysely<CoreDatabase>, userId: string, now = new Date()): Promise<McpConnectionInfo[]> {
  await db.deleteFrom('core.mcpConnections').where('userId', '=', userId).where('expiresAt', '<=', now).execute()
  const rows = await db.selectFrom('core.mcpConnections')
    .select(['id', 'name', 'access', 'createdAt', 'lastUsedAt', 'expiresAt'])
    .where('userId', '=', userId)
    .orderBy('createdAt')
    .orderBy('id')
    .execute()
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    access: row.access,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  }))
}

/** Trennt eine Verbindung der Person; fremde oder unbekannte Ids ändern nichts (false) */
export async function deleteConnection(db: Kysely<CoreDatabase>, userId: string, connectionId: string): Promise<boolean> {
  // Eine Nicht-GUID würde SQL Server mit einem Konvertierungsfehler (500) quittieren
  if (!GUID.test(connectionId)) return false
  const result = await db.deleteFrom('core.mcpConnections').where('id', '=', connectionId).where('userId', '=', userId).executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}
