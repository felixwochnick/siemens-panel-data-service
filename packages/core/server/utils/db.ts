import type { Kysely } from 'kysely'
import { coreMigrations, createDatabase, migrateDatabase } from '../database'
import type { CoreDatabase, MigrationSet } from '../database'

let db: Kysely<unknown> | undefined

/** Gemeinsamer Datenbank-Client; Apps typisieren ihn mit ihrer eigenen Datenbank-Schnittstelle */
export function useDb<DB = CoreDatabase>(): Kysely<DB> {
  if (!db) {
    const { databaseUrl } = useRuntimeConfig()
    if (!databaseUrl) throw new Error('NUXT_DATABASE_URL ist nicht gesetzt')
    db = createDatabase<unknown>(databaseUrl)
  }
  return db as unknown as Kysely<DB>
}

const migrationSets: MigrationSet[] = [coreMigrations]
let ready: Promise<void> | undefined

/** Apps registrieren ihre Migrationen in einem Nitro-Plugin (läuft synchron beim Start) */
export function registerMigrations(set: MigrationSet) {
  if (ready) throw new Error(`Migrationen für Schema ${set.schema} wurden zu spät registriert`)
  if (!migrationSets.some(s => s.schema === set.schema)) migrationSets.push(set)
}

/** Migriert die Datenbank einmal pro Prozess; Requests warten darauf (Middleware 00.database) */
export function ensureDatabaseReady(): Promise<void> {
  ready ??= migrateDatabase(useDb<unknown>(), migrationSets).catch((error) => {
    ready = undefined
    throw error
  })
  return ready
}
