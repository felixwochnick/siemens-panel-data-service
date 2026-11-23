// Kindprozess für sqlite.test.ts: migriert die angegebene SQLite-Datei (mehrere davon starten gleichzeitig)
import { coreMigrations, createDatabase, migrateDatabase } from '../../server/database'

const db = createDatabase<unknown>(`sqlite:${process.argv[2]}`)
try {
  await migrateDatabase(db, [coreMigrations])
  console.log('ok')
}
finally {
  await db.destroy()
}
