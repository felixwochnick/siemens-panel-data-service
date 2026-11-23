import { CamelCasePlugin, Kysely, MssqlDialect, SqliteAdapter } from 'kysely'
import * as Tarn from 'tarn'
import * as Tedious from 'tedious'
import { createSqliteDatabase, parseSqliteUrl } from './sqlite'

/** Unterstützte Datenbanken: SQL Server (`mssql://…`) oder eine SQLite-Datei (`sqlite:<pfad>`) */
export type DatabaseDialect = 'mssql' | 'sqlite'

/** Welche Datenbank eine Verbindungs-URL meint (ohne sie zu öffnen) */
export function databaseDialectOf(url: string): DatabaseDialect {
  return parseSqliteUrl(url) === undefined ? 'mssql' : 'sqlite'
}

/** Welche Datenbank hinter einem Client (auch einer Transaktion) steckt */
export function getDatabaseDialect(db: { getExecutor: () => { readonly adapter: unknown } }): DatabaseDialect {
  return db.getExecutor().adapter instanceof SqliteAdapter ? 'sqlite' : 'mssql'
}

/**
 * Unique-Verletzung: SQL Server 2627/2601, SQLite SQLITE_CONSTRAINT_UNIQUE (2067) bzw. _PRIMARYKEY (1555)
 */
export function isUniqueViolation(error: unknown): boolean {
  const number = (error as { number?: number })?.number
    ?? (error as { originalError?: { info?: { number?: number } } })?.originalError?.info?.number
  if (number === 2627 || number === 2601) return true
  const errcode = (error as { errcode?: unknown })?.errcode
  return errcode === 2067 || errcode === 1555
}

export interface MssqlConnectionOptions {
  server: string
  port: number
  database: string
  user: string
  password: string
  encrypt: boolean
  trustServerCertificate: boolean
}

/**
 * Liest eine Verbindungs-URL der Form
 * `mssql://user:pass@host:1433/datenbank?encrypt=true&trustServerCertificate=false`.
 * Sonderzeichen in Benutzer/Passwort müssen URL-kodiert sein.
 */
export function parseDatabaseUrl(url: string): MssqlConnectionOptions {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    throw new Error('NUXT_DATABASE_URL ist keine gültige URL')
  }
  if (parsed.protocol !== 'mssql:' && parsed.protocol !== 'sqlserver:')
    throw new Error('NUXT_DATABASE_URL muss mit mssql:// oder sqlite: beginnen')

  const flag = (name: string, fallback: boolean) => {
    const value = parsed.searchParams.get(name)
    return value === null ? fallback : value === 'true' || value === '1'
  }
  const decode = (value: string, part: string) => {
    try {
      return decodeURIComponent(value)
    }
    catch {
      throw new Error(`NUXT_DATABASE_URL: ${part} ist nicht korrekt URL-kodiert (z. B. % als %25 schreiben)`)
    }
  }
  const database = decode(parsed.pathname.replace(/^\//, ''), 'Datenbankname')
  if (!parsed.hostname || !database || !parsed.username)
    throw new Error('NUXT_DATABASE_URL braucht Host, Benutzer und Datenbank')

  return {
    server: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 1433,
    database,
    user: decode(parsed.username, 'Benutzer'),
    password: decode(parsed.password, 'Passwort'),
    encrypt: flag('encrypt', true),
    trustServerCertificate: flag('trustServerCertificate', false),
  }
}

/**
 * Erzeugt einen Kysely-Client für SQL Server oder SQLite (camelCase im Code, snake_case in der Datenbank).
 * `poolMax` gilt nur für SQL Server; SQLite hat genau eine Verbindung, Abfragen laufen nacheinander.
 */
export function createDatabase<DB>(url: string, options: { poolMax?: number } = {}): Kysely<DB> {
  const sqlitePath = parseSqliteUrl(url)
  if (sqlitePath !== undefined) return createSqliteDatabase<DB>(sqlitePath)
  const cfg = parseDatabaseUrl(url)
  return new Kysely<DB>({
    dialect: new MssqlDialect({
      tarn: { ...Tarn, options: { min: 0, max: options.poolMax ?? 10 } },
      tedious: {
        ...Tedious,
        connectionFactory: () => new Tedious.Connection({
          server: cfg.server,
          authentication: { type: 'default', options: { userName: cfg.user, password: cfg.password } },
          options: {
            port: cfg.port,
            database: cfg.database,
            encrypt: cfg.encrypt,
            trustServerCertificate: cfg.trustServerCertificate,
            // IDs (uniqueidentifier) im Code immer klein geschrieben – wie crypto.randomUUID()
            lowerCaseGuids: true,
            useUTC: true,
            connectTimeout: 15_000,
          },
        }),
      },
    }),
    plugins: [new CamelCasePlugin()],
  })
}
