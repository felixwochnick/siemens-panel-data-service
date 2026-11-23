import { pdsMigrations } from '../database/migrations'

// Fachtabellen nach den core-Tabellen migrieren (Ausführung steuert der core-Layer)
export default defineNitroPlugin(() => {
  registerMigrations(pdsMigrations)
})
