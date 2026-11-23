import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  coreMigrations,
  createDatabase,
  databaseDialectOf,
  getDatabaseDialect,
  isUniqueViolation,
  migrateDatabase,
  parseSqliteUrl,
  sqliteSql,
} from '../server/database'
import type { CoreDatabase, MigrationSet } from '../server/database'

// Läuft immer gegen SQLite (unabhängig von TEST_DATABASE): Adapter und Übersetzung der SQL-Server-Eigenheiten

describe('parseSqliteUrl', () => {
  it('liest den Pfad nach sqlite: (auch Windows-Pfade mit Leerzeichen)', () => {
    expect(parseSqliteUrl('sqlite:./.data/pds.db')).toBe('./.data/pds.db')
    expect(parseSqliteUrl('sqlite:C:\\ProgramData\\EPLAN Panel Data Service\\data\\pds.db'))
      .toBe('C:\\ProgramData\\EPLAN Panel Data Service\\data\\pds.db')
    expect(parseSqliteUrl('sqlite::memory:')).toBe(':memory:')
    expect(parseSqliteUrl('mssql://u:p@h/db')).toBeUndefined()
  })

  it('verlangt einen Pfad', () => {
    expect(() => parseSqliteUrl('sqlite:')).toThrow(/Pfad/)
  })

  it('erkennt die Datenbank an der URL', () => {
    expect(databaseDialectOf('sqlite:x.db')).toBe('sqlite')
    expect(databaseDialectOf('mssql://u:p@h/db')).toBe('mssql')
  })
})

describe('SQLite-Adapter', () => {
  let dir: string
  let db: Kysely<CoreDatabase>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pds-sqlite-'))
    // Unterordner fehlt absichtlich: der Adapter legt ihn an
    db = createDatabase<CoreDatabase>(`sqlite:${join(dir, 'data', 'pds.db')}`)
    await migrateDatabase(db, [coreMigrations])
  })
  afterAll(async () => {
    await db?.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  const insertUser = (subject: string, isAdmin = false) => db.insertInto('core.users')
    .values({ issuer: 'https://idp', subject, email: null, displayName: subject, isAdmin })
    .output(['inserted.id', 'inserted.isAdmin', 'inserted.createdAt'])
    .executeTakeFirstOrThrow()

  it('erkennt die Datenbank am Client', () => {
    expect(getDatabaseDialect(db)).toBe('sqlite')
  })

  it('OUTPUT inserted.* liefert ID (klein, UUID-Form), Boolean und Zeitpunkt', async () => {
    const user = await insertUser('a', true)
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(user.isAdmin).toBe(true)
    expect(user.createdAt).toBeInstanceOf(Date)
    expect(Math.abs(user.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
  })

  it('schreibt Zeitpunkte als ISO-Text und liest sie als Date zurück (auch über Joins)', async () => {
    const { id } = await insertUser('b')
    const expiresAt = new Date('2030-05-06T07:08:09.123Z')
    await db.insertInto('core.sessions').values({ userId: id, expiresAt, userAgent: null }).execute()
    // Gespeichert als Text; replace() verhindert, dass der Adapter ihn beim Lesen wieder zum Date macht
    const raw = await sql<{ kind: string, text: string }>`SELECT typeof(expires_at) AS kind, replace(expires_at, 'T', ' ') AS text FROM core_sessions WHERE user_id = ${id}`.execute(db.withoutPlugins())
    expect(raw.rows[0]).toEqual({ kind: 'text', text: '2030-05-06 07:08:09.123Z' })
    const row = await db.selectFrom('core.sessions as s')
      .innerJoin('core.users as u', 'u.id', 's.userId')
      .select(['s.expiresAt', 'u.isAdmin'])
      .where('s.userId', '=', id)
      .where('s.expiresAt', '>', new Date('2030-01-01T00:00:00.000Z'))
      .executeTakeFirstOrThrow()
    expect(row.expiresAt).toEqual(expiresAt)
    expect(row.isAdmin).toBe(false)
  })

  it('berechnete Zeitpunkte (ohne Spaltentyp) kommen ebenfalls als Date', async () => {
    const row = await db.selectFrom('core.sessions').select(eb => eb.fn.max('expiresAt').as('last')).executeTakeFirstOrThrow()
    expect(row.last).toEqual(new Date('2030-05-06T07:08:09.123Z'))
  })

  it('übersetzt TOP und OFFSET … FETCH in LIMIT/OFFSET', async () => {
    for (const subject of ['c', 'd', 'e']) await insertUser(subject)
    const top = await db.selectFrom('core.users').select('subject').orderBy('subject').top(2).execute()
    expect(top.map(r => r.subject)).toEqual(['a', 'b'])
    const page = await db.selectFrom('core.users').select('subject').orderBy('subject').offset(2).fetch(2).execute()
    expect(page.map(r => r.subject)).toEqual(['c', 'd'])
    const rest = await db.selectFrom('core.users').select('subject').orderBy('subject').offset(3).execute()
    expect(rest.map(r => r.subject)).toEqual(['d', 'e'])
    expect(db.selectFrom('core.users').selectAll().top(1).compile().sql).toMatch(/from "core_users" limit 1$/)
  })

  it('OUTPUT deleted.* wird zu RETURNING *', async () => {
    const { id } = await insertUser('weg')
    const deleted = await db.deleteFrom('core.users').where('id', '=', id).outputAll('deleted').executeTakeFirst()
    expect(deleted).toMatchObject({ id, subject: 'weg', isAdmin: false })
    expect(deleted?.createdAt).toBeInstanceOf(Date)
  })

  it('zählt geänderte Zeilen', async () => {
    const result = await db.updateTable('core.users').set({ email: 'x@example.com' }).where('subject', 'in', ['c', 'd']).executeTakeFirst()
    expect(Number(result.numUpdatedRows)).toBe(2)
  })

  it('Fremdschlüssel sind aktiv (Kaskade beim Löschen)', async () => {
    const { id } = await insertUser('kaskade')
    await db.insertInto('core.sessions').values({ userId: id, expiresAt: new Date(), userAgent: null }).execute()
    await db.deleteFrom('core.users').where('id', '=', id).execute()
    expect(await db.selectFrom('core.sessions').select('id').where('userId', '=', id).execute()).toHaveLength(0)
  })

  it('erkennt Unique-Verletzungen', async () => {
    const error = await insertUser('a').catch((e: unknown) => e)
    expect(isUniqueViolation(error)).toBe(true)
    expect(isUniqueViolation(new Error('x'))).toBe(false)
  })

  it('Transaktionen laufen nacheinander und rollen bei Fehlern zurück', async () => {
    const failing = db.transaction().execute(async (trx) => {
      await trx.updateTable('core.users').set({ displayName: 'geändert' }).where('subject', '=', 'e').execute()
      throw new Error('abbrechen')
    })
    // Läuft parallel an, muss aber auf die Transaktion warten (eine Verbindung)
    const parallel = db.selectFrom('core.users').select('displayName').where('subject', '=', 'e').executeTakeFirstOrThrow()
    await expect(failing).rejects.toThrow('abbrechen')
    expect((await parallel).displayName).toBe('e')
  })

  it('ist idempotent', async () => {
    await expect(migrateDatabase(db, [coreMigrations])).resolves.toBeUndefined()
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'core_*'`.execute(db)
    expect(tables.rows.map(r => r.name)).toEqual(expect.arrayContaining(['core_migrations', 'core_users', 'core_sessions', 'core_mcp_tokens']))
  })
})

describe('SQLite-Migrationen', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pds-sqlite-migrate-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('sind atomar: scheitert eine Anweisung, bleibt nichts halb angelegt, und ein neuer Versuch gelingt', async () => {
    const db = createDatabase<unknown>(`sqlite:${join(dir, 'atomar.db')}`)
    const set = (second: string): MigrationSet => ({
      schema: 'probe',
      mssql: {},
      sqlite: { '0001_probe': sqliteSql('CREATE TABLE probe_a (id integer NOT NULL)', second) },
    })
    try {
      await expect(migrateDatabase(db, [set('CREATE TABLE kaputt (')])).rejects.toThrow(/probe\/0001_probe/)
      const left = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'probe_*'`.execute(db)
      expect(left.rows.map(r => r.name).sort()).toEqual(['probe_migrations', 'probe_migrations_lock'])

      await migrateDatabase(db, [set('CREATE TABLE probe_b (id integer NOT NULL)')])
      const done = await sql<{ name: string }>`SELECT name FROM probe_migrations`.execute(db)
      expect(done.rows.map(r => r.name)).toEqual(['0001_probe'])
    }
    finally {
      await db.destroy()
    }
  })

  it('mehrere Prozesse migrieren dieselbe neue Datei gleichzeitig: alle gelingen, jede Migration einmal', async () => {
    const file = join(dir, 'parallel.db')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const script = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'migrate-sqlite.ts')
    const run = promisify(execFile)
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      run(process.execPath, ['--import', 'tsx', script, file], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' } })))
    expect(results.map(r => r.stdout.trim())).toEqual(['ok', 'ok', 'ok', 'ok'])

    const db = createDatabase<unknown>(`sqlite:${file}`)
    try {
      const done = await sql<{ name: string }>`SELECT name FROM core_migrations ORDER BY name`.execute(db)
      expect(done.rows.map(r => r.name)).toEqual(Object.keys(coreMigrations.sqlite).sort())
    }
    finally {
      await db.destroy()
    }
  }, 60_000)
})
