import { sql } from 'kysely'
import type { Expression, SqlBool } from 'kysely'

/**
 * LIKE-Muster mit wörtlichem Text: %, _ und (nur SQL Server) [ sind Platzhalter. Maskiert wird mit `\` und
 * `ESCAPE '\'` – das verstehen SQL Server und SQLite gleich (die SQL-Server-Form `[%]` kennt SQLite nicht).
 */
export const escapeLike = (text: string) => text.replace(/[\\%_[]/g, char => `\\${char}`)

/** Spalte enthält den Text wörtlich (Groß/Klein egal: SQL-Server-Kollation bzw. LIKE in SQLite, dort nur ASCII) */
export function containsText(column: Expression<unknown>, text: string) {
  return sql<SqlBool>`${column} LIKE ${`%${escapeLike(text)}%`} ESCAPE '\\'`
}

/** Zeilen je Anweisung bei `columns` Parametern je Zeile: SQL Server erlaubt höchstens 2100 Parameter */
export function rowsPerStatement(columns: number): number {
  return Math.max(1, Math.floor(2000 / columns))
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

/** Seite und Seitengröße begrenzen */
export function paging(page: number | undefined, pageSize: number | undefined, max: number, fallback = 50) {
  const size = Math.min(Math.max(Math.trunc(pageSize ?? fallback), 1), max)
  const number = Math.max(Math.trunc(page ?? 1), 1)
  return { pageSize: size, offset: (number - 1) * size }
}
