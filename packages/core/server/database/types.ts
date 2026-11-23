import type { ColumnType, Generated, Selectable } from 'kysely'
import type { McpGrant } from '../../shared/utils/mcp'

type CreatedAt = ColumnType<Date, never, never>
/** Zeitpunkt, den der OAuth-Code selbst setzt (injizierbare Uhr), sonst die Datenbank */
type SetOnInsert = ColumnType<Date, Date | undefined, never>

export interface UsersTable {
  id: Generated<string>
  issuer: string
  subject: string
  email: string | null
  displayName: string
  isAdmin: ColumnType<boolean, boolean | undefined, boolean>
  createdAt: CreatedAt
  lastLoginAt: Date | null
}

export interface SessionsTable {
  id: Generated<string>
  userId: string
  expiresAt: Date
  createdAt: CreatedAt
  userAgent: string | null
}

/** Programme, die sich per Selbstregistrierung angemeldet haben (RFC 7591) */
export interface OAuthClientsTable {
  id: string
  name: string
  /** JSON-Array */
  redirectUris: string
  /** nur bei Programmen mit Secret */
  secretHash: string | null
  createdAt: SetOnInsert
  lastUsedAt: Date | null
}

/** Einmal einlösbare Autorisierungscodes (nur als Hash) */
export interface OAuthCodesTable {
  codeHash: string
  clientId: string
  userId: string
  redirectUri: string
  codeChallenge: string
  access: McpGrant
  expiresAt: Date
  /** Ende der Verbindung, die der Code eröffnet (spätestens das Ende der Sitzung bei der Zustimmung) */
  connectionExpiresAt: Date | null
}

/** Verbindung einer Person mit einem Programm; endet mit `expiresAt` */
export interface McpConnectionsTable {
  id: Generated<string>
  userId: string
  clientId: string
  /** Programmname zum Zeitpunkt der Zustimmung */
  name: string
  access: McpGrant
  expiresAt: Date
  createdAt: SetOnInsert
  lastUsedAt: Date | null
}

/** Zugangs- und Erneuerungs-Tokens (nur als Hash); `usedAt`: Erneuerungs-Token eingelöst */
export interface McpTokensTable {
  tokenHash: string
  connectionId: string
  kind: 'access' | 'refresh'
  expiresAt: Date
  usedAt: Date | null
}

/** Tabellen des core-Layers (Schema `core`) */
export interface CoreDatabase {
  'core.users': UsersTable
  'core.sessions': SessionsTable
  'core.oauthClients': OAuthClientsTable
  'core.oauthCodes': OAuthCodesTable
  'core.mcpConnections': McpConnectionsTable
  'core.mcpTokens': McpTokensTable
}

export type UserRow = Selectable<UsersTable>
