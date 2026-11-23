import { rm } from 'node:fs/promises'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { createDatabase, getDatabaseDialect } from '@pds/core/database'
import type { AppDatabase } from '../apps/web/server/database/types'
import { DATA_DIR, E2E_DB, E2E_DIALECT, E2E_SERVER_URL, E2E_SQLITE_FILE } from './targets'

export function e2eDatabaseUrl() {
  if (E2E_DIALECT === 'sqlite') return `sqlite:${E2E_SQLITE_FILE}`
  const url = new URL(E2E_SERVER_URL)
  url.pathname = `/${E2E_DB}`
  return url.toString()
}

/** SQL Server: legt die E2E-Datenbank bei Bedarf an; Tabellen erzeugt der Dev-Server per Migration */
export async function ensureDatabase() {
  if (E2E_DIALECT === 'sqlite') return
  const master = createDatabase<unknown>(E2E_SERVER_URL, { poolMax: 1 })
  try {
    await sql.raw(`IF DB_ID(N'${E2E_DB}') IS NULL BEGIN CREATE DATABASE [${E2E_DB}]; ALTER DATABASE [${E2E_DB}] SET READ_COMMITTED_SNAPSHOT ON; END`).execute(master)
  }
  finally {
    await master.destroy()
  }
}

/**
 * Vor dem Start des Dev-Servers: frische Datenbank – SQL Server: löschen und neu anlegen, SQLite: Datei samt Journal
 * löschen (der Server migriert). Der Datenordner (hochgeladene Dateien, Arbeitsordner) wird geleert. Nur hier, solange
 * kein Server die Datenbank oder die Dateien offen hat.
 */
export async function prepareDatabase() {
  await rm(DATA_DIR, { recursive: true, force: true })
  if (E2E_DIALECT === 'sqlite') {
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${E2E_SQLITE_FILE}${suffix}`, { force: true })
    return
  }
  const master = createDatabase<unknown>(E2E_SERVER_URL, { poolMax: 1 })
  try {
    await sql.raw(`IF DB_ID(N'${E2E_DB}') IS NOT NULL BEGIN ALTER DATABASE [${E2E_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${E2E_DB}] END`).execute(master)
  }
  finally {
    await master.destroy()
  }
  await ensureDatabase()
}

/** Gibt es die Tabelle (`schema.tabelle`) schon? Vor der ersten Migration fehlen sie */
async function tableExists(db: Kysely<AppDatabase>, table: string): Promise<boolean> {
  if (getDatabaseDialect(db) === 'sqlite') {
    const { rows } = await sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${table.replace('.', '_')}`.execute(db)
    return rows.length > 0
  }
  const { rows } = await sql<{ id: number | null }>`SELECT OBJECT_ID(${table}, N'U') AS id`.execute(db)
  return rows[0]?.id != null
}

/** Mit einer eigenen Verbindung auf der E2E-Datenbank arbeiten (dialektneutral über Kysely) */
export async function withE2eDb<T>(work: (db: Kysely<AppDatabase>) => Promise<T>): Promise<T> {
  const db = createDatabase<AppDatabase>(e2eDatabaseUrl(), { poolMax: 1 })
  try {
    return await work(db)
  }
  finally {
    await db.destroy()
  }
}

/**
 * Fachdaten und Benutzer leeren (Schema bleibt), falls ein laufender Server weiterverwendet wird. Ergebnisse zuerst
 * (große Tabellen ohne Cascade-Arbeit), dann Projekte vom aktuellen Stand lösen (Fremdschlüssel ohne Cascade) und
 * löschen – Analysen und Ereignisse folgen per Cascade.
 */
export async function resetData() {
  await ensureDatabase()
  await withE2eDb(async (db) => {
    if (await tableExists(db, 'pds.projects')) {
      for (const table of ['pds.cableWires', 'pds.cables', 'pds.shieldWires', 'pds.shields', 'pds.connections', 'pds.texts'] as const)
        await db.deleteFrom(table).execute()
      await db.updateTable('pds.projects').set({ currentAnalysisId: null }).execute()
      await db.deleteFrom('pds.projects').execute()
      for (const table of ['pds.settings', 'pds.audit'] as const) await db.deleteFrom(table).execute()
    }
    if (await tableExists(db, 'core.sessions')) {
      await db.deleteFrom('core.sessions').execute()
      await db.deleteFrom('core.users').execute()
    }
  })
}
