// Vor dem Start des E2E-Dev-Servers: SQL Server – Datenbank anlegen, SQLite – Datei löschen (der Server migriert)
import { prepareDatabase } from './db'

await prepareDatabase()
