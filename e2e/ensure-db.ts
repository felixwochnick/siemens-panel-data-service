// Vor dem Start des E2E-Dev-Servers: frische Datenbank (SQL Server neu anlegen, SQLite-Datei löschen; der Server migriert);
// Datenordner der App leeren
import { prepareDatabase } from './db'

await prepareDatabase()
