import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { coreMigrations, createDatabase, migrateDatabase } from '../../server/database'
import type { DatabaseDialect, MigrationSet } from '../../server/database'

/**
 * Datenbank der Tests: `TEST_DATABASE=sqlite` (Dateien im Temp-Ordner, ohne Docker) oder SQL Server (Standard,
 * `pnpm db:up`). Die Dienste müssen sich mit beiden gleich verhalten; CI prüft beide.
 */
export const TEST_DIALECT: DatabaseDialect = process.env.TEST_DATABASE === 'sqlite' ? 'sqlite' : 'mssql'

/** Server-Verbindung mit Rechten auf master (Standard: SQL Server aus docker/docker-compose.dev.yml) */
export const TEST_SERVER_URL = process.env.TEST_DATABASE_URL
  ?? 'mssql://sa:PdsDev-Sa-2026@localhost:1435/master?trustServerCertificate=true'

/** Ordner der SQLite-Testdatenbanken */
export const TEST_SQLITE_DIR = join(tmpdir(), 'pds-test-sqlite')

export interface TestDatabase<DB> {
  db: Kysely<DB>
  url: string
  name: string
  dialect: DatabaseDialect
  destroy: () => Promise<void>
}

function removeSqliteFile(path: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true })
}

/**
 * Legt eine frische Testdatenbank an (vorhandene gleichen Namens wird gelöscht) und migriert sie.
 * Jede Testdatei nutzt einen eigenen Namen, damit Dateien parallel laufen können.
 */
export async function createTestDatabase<DB>(name: string, sets: MigrationSet[] = [coreMigrations]): Promise<TestDatabase<DB>> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Ungültiger Testdatenbank-Name: ${name}`)
  const dbName = `pds_test_${name}`

  if (TEST_DIALECT === 'sqlite') {
    mkdirSync(TEST_SQLITE_DIR, { recursive: true })
    const path = join(TEST_SQLITE_DIR, `${dbName}.db`)
    removeSqliteFile(path)
    const url = `sqlite:${path}`
    const db = createDatabase<DB>(url)
    await migrateDatabase(db, sets)
    return {
      db,
      url,
      name: dbName,
      dialect: 'sqlite',
      destroy: async () => {
        await db.destroy()
        removeSqliteFile(path)
      },
    }
  }

  const master = createDatabase<unknown>(TEST_SERVER_URL, { poolMax: 1 })
  try {
    await sql.raw(`IF DB_ID(N'${dbName}') IS NOT NULL BEGIN ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbName}] END`).execute(master)
    await sql.raw(`CREATE DATABASE [${dbName}]`).execute(master)
    await sql.raw(`ALTER DATABASE [${dbName}] SET READ_COMMITTED_SNAPSHOT ON`).execute(master)
  }
  finally {
    await master.destroy()
  }

  const url = new URL(TEST_SERVER_URL)
  url.pathname = `/${dbName}`
  const db = createDatabase<DB>(url.toString())
  await migrateDatabase(db, sets)
  return { db, url: url.toString(), name: dbName, dialect: 'mssql', destroy: () => db.destroy() }
}
