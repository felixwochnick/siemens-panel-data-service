import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreMigrations, migrateDatabase, parseDatabaseUrl } from '../server/database'
import type { CoreDatabase } from '../server/database'
import { createTestDatabase, TEST_DIALECT } from './helpers/test-db'
import type { TestDatabase } from './helpers/test-db'

describe('parseDatabaseUrl', () => {
  it('liest alle Bestandteile inkl. URL-kodierter Zugangsdaten', () => {
    expect(parseDatabaseUrl('mssql://app%40x:p%40ss%3Aw@db.example:1444/planner?trustServerCertificate=true')).toEqual({
      server: 'db.example',
      port: 1444,
      database: 'planner',
      user: 'app@x',
      password: 'p@ss:w',
      encrypt: true,
      trustServerCertificate: true,
    })
  })

  it('nutzt sichere Standardwerte', () => {
    const cfg = parseDatabaseUrl('mssql://u:p@host/db')
    expect(cfg.port).toBe(1433)
    expect(cfg.encrypt).toBe(true)
    expect(cfg.trustServerCertificate).toBe(false)
  })

  it('lehnt unvollständige oder falsche URLs ab', () => {
    expect(() => parseDatabaseUrl('postgres://u:p@h/db')).toThrow(/mssql/)
    expect(() => parseDatabaseUrl('mssql://u:p@host/')).toThrow(/Datenbank/)
    expect(() => parseDatabaseUrl('kein url')).toThrow(/gültige URL/)
  })
})

describe(`Migrationen (${TEST_DIALECT})`, () => {
  let t: TestDatabase<CoreDatabase>

  beforeAll(async () => {
    t = await createTestDatabase<CoreDatabase>('core_database')
  })
  afterAll(() => t?.destroy())

  it('legt Schema core mit Benutzern, Sessions und OAuth-Tabellen an', async () => {
    const tables = TEST_DIALECT === 'sqlite'
      ? await sql<{ name: string }>`SELECT replace(name, 'core_', 'core.') AS name FROM sqlite_master WHERE type = 'table' AND name GLOB 'core_*' ORDER BY name`.execute(t.db)
      : await sql<{ name: string }>`SELECT s.name + '.' + t.name AS name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = 'core' ORDER BY name`.execute(t.db)
    expect(tables.rows.map(r => r.name)).toEqual(expect.arrayContaining(['core.mcp_connections', 'core.mcp_tokens', 'core.migrations', 'core.oauth_clients', 'core.oauth_codes', 'core.sessions', 'core.users']))
  })

  it('ist idempotent', async () => {
    await expect(migrateDatabase(t.db, [coreMigrations])).resolves.toBeUndefined()
  })

  it('liefert IDs klein geschrieben und Booleans als boolean', async () => {
    const user = await t.db.insertInto('core.users')
      .values({ issuer: 'https://idp', subject: 'abc', email: null, displayName: 'Test', isAdmin: true })
      .output(['inserted.id', 'inserted.isAdmin', 'inserted.createdAt'])
      .executeTakeFirstOrThrow()
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(user.isAdmin).toBe(true)
    expect(user.createdAt).toBeInstanceOf(Date)
  })

  it('verhindert doppelte Identitäten', async () => {
    await expect(t.db.insertInto('core.users').values({ issuer: 'https://idp', subject: 'abc', email: null, displayName: 'X' }).execute())
      .rejects.toThrow(/UNIQUE/i)
  })

  it('Zeitpunkte behalten ihre Millisekunden (Date als datetime2, nicht datetime)', async () => {
    const { id } = await t.db.insertInto('core.users').values({ issuer: 'https://idp', subject: 'ms', email: null, displayName: 'Ms' })
      .output('inserted.id').executeTakeFirstOrThrow()
    // .315 würde als datetime auf .317 gerundet
    const expiresAt = new Date('2026-11-23T15:35:39.315Z')
    await t.db.insertInto('core.sessions').values({ userId: id, expiresAt, userAgent: null }).execute()
    const session = await t.db.selectFrom('core.sessions').where('userId', '=', id).select('expiresAt').executeTakeFirstOrThrow()
    expect(new Date(session.expiresAt).toISOString()).toBe(expiresAt.toISOString())
    const found = await t.db.selectFrom('core.sessions').where('expiresAt', '=', expiresAt).select('id').execute()
    expect(found).toHaveLength(1)
  })

  it('löscht Sessions mit dem Benutzer', async () => {
    const { id } = await t.db.insertInto('core.users').values({ issuer: 'https://idp', subject: 'del', email: null, displayName: 'Del' })
      .output('inserted.id').executeTakeFirstOrThrow()
    await t.db.insertInto('core.sessions').values({ userId: id, expiresAt: new Date(Date.now() + 1000), userAgent: null }).execute()
    await t.db.deleteFrom('core.users').where('id', '=', id).execute()
    const left = await t.db.selectFrom('core.sessions').where('userId', '=', id).select('id').execute()
    expect(left).toHaveLength(0)
  })
})

describe('parseDatabaseUrl Fehlerfälle', () => {
  it('meldet falsch kodierte Passwörter verständlich', () => {
    expect(() => parseDatabaseUrl('mssql://u:50%@host/db')).toThrow(/URL-kodiert/)
  })
})
