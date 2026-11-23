// Anfragen warten, bis die Datenbank migriert ist
export default defineEventHandler(async (event) => {
  if (isDynamicRequest(event.path)) await ensureDatabaseReady()
})
