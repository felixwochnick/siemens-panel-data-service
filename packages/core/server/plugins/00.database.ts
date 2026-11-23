// Migriert beim Start. Apps registrieren ihre Migrationen in eigenen Plugins (synchron, also vor diesem Tick).
export default defineNitroPlugin(() => {
  setTimeout(() => {
    ensureDatabaseReady()
      .then(() => console.info('[db] Datenbankschema ist aktuell'))
      .catch((error) => {
        console.error('[db] Datenbankmigration fehlgeschlagen', error)
        if (!import.meta.dev) process.exit(1)
      })
  }, 0)
})
