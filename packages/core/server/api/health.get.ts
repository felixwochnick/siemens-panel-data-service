import { sql } from 'kysely'

// Bereitschaftsprüfung für Docker/Proxy und Tests: Datenbank erreichbar und migriert
export default defineEventHandler(async () => {
  await ensureDatabaseReady()
  await sql`SELECT 1`.execute(useDb())
  return { status: 'ok' }
})
