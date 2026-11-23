import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { getDatabaseDialect } from './connection'

/**
 * Migrationen eines Layers/einer App. Jede Datenbank hat ihre eigene Reihe mit demselben Endstand: SQL Server legt
 * alles im Schema `schema` an, SQLite (ohne Schemas) als Tabellen `<schema>_<tabelle>`.
 */
export interface MigrationSet {
  schema: string
  /** SQL Server (T-SQL). Bestehende Einträge nie ändern. */
  mssql: Record<string, Migration>
  /** SQLite. Bestehende Einträge nie ändern. */
  sqlite: Record<string, Migration>
}

/** Migration aus reinen Anweisungen (eine Anweisung pro Eintrag, kein GO bzw. kein `;`-Stapel) */
function statements(list: string[]): Migration {
  return {
    async up(db) {
      for (const statement of list) await sql.raw(statement).execute(db)
    },
  }
}

/** Migration aus reinen T-SQL-Anweisungen (SQL Server) */
export function tsql(...list: string[]): Migration {
  return statements(list)
}

/** Migration aus reinen SQLite-Anweisungen */
export function sqliteSql(...list: string[]): Migration {
  return statements(list)
}

/**
 * Führt alle Migrationsmengen nacheinander aus, jede in einer Transaktion (scheitert eine Migration, bleibt nichts
 * halb angelegt). SQL Server sperrt über sp_getapplock (Kysely-MSSQL-Adapter), SQLite über die Schreibsperre der
 * Transaktion (BEGIN IMMEDIATE): Ein zweiter Prozess wartet und findet danach nichts mehr zu tun.
 */
export async function migrateDatabase(db: Kysely<unknown>, sets: MigrationSet[]): Promise<void> {
  const dialect = getDatabaseDialect(db)
  for (const set of sets) {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => set[dialect] },
      ...(dialect === 'mssql'
        ? { migrationTableSchema: set.schema, migrationTableName: 'migrations', migrationLockTableName: 'migrations_lock' }
        : { migrationTableName: `${set.schema}_migrations`, migrationLockTableName: `${set.schema}_migrations_lock` }),
    })
    const { error, results } = await migrator.migrateToLatest()
    const failed = results?.find(r => r.status === 'Error')
    if (error || failed) {
      const cause = error instanceof Error ? error.message : String(error ?? '')
      throw new Error(`Migration ${set.schema}/${failed?.migrationName ?? '?'} fehlgeschlagen: ${cause}`, { cause: error })
    }
  }
}
