// Texte von db-test, die SQL Server und SQLite teilen: Rust und die Oberfläche zeigen beide Zweige gleich an

/** Migrationstabellen: Basis (core) und App (pds). SQL Server `<schema>.migrations`, SQLite `<schema>_migrations`. */
export const MIGRATION_SCHEMAS = ['core', 'pds'] as const

export type MigrationCounts = Record<(typeof MIGRATION_SCHEMAS)[number], number>

export function migrationsMessage(counts: MigrationCounts): string {
  const done = Object.values(counts).some(count => count > 0)
  return done
    ? `Migrationen ausgeführt: ${MIGRATION_SCHEMAS.map(schema => `${schema} ${counts[schema]}`).join(', ')}.`
    : 'Noch keine Migrationen: Die App legt ihre Tabellen beim ersten Start an.'
}

/** „, aber ein Hinweis ist zu beachten“ für die Abschlussmeldung; leer ohne Warnungen */
export function warningsSuffix(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return `, aber ${warnings.length === 1 ? 'ein Hinweis ist' : `${warnings.length} Hinweise sind`} zu beachten`
}
