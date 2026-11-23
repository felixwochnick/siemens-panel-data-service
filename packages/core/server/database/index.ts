// Öffentliche Datenbank-API des core-Layers (auch für Tests und Skripte außerhalb von Nuxt)
export * from './connection'
export * from './migrator'
export { openSqliteFile, parseSqliteUrl, SqliteCompatPlugin } from './sqlite'
export * from './types'
export { coreMigrations, SQLITE_NOW, SQLITE_UUID } from './migrations'
