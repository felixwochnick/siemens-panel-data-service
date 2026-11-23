import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Ziel der E2E-Tests: eigener Dev-Server auf Port 3500 (siehe playwright.config.ts)
export const APP_URL = 'http://localhost:3500'
export const OIDC_ISSUER = 'http://localhost:5558/dex'

/**
 * Datenbank der E2E-Tests: SQL Server (Standard) oder mit `E2E_DATABASE=sqlite` eine Datei im Temp-Ordner, die vor
 * jedem Start des Dev-Servers gelöscht wird (e2e/ensure-db.ts)
 */
export const E2E_DIALECT: 'mssql' | 'sqlite' = process.env.E2E_DATABASE === 'sqlite' ? 'sqlite' : 'mssql'

/** SQL-Server-Zugang mit Rechten auf master (Dev: docker/docker-compose.dev.yml) */
export const E2E_SERVER_URL = process.env.E2E_SERVER_URL ?? 'mssql://sa:PdsDev-Sa-2026@localhost:1435/master?trustServerCertificate=true'
export const E2E_DB = 'pds_e2e'
/** SQLite-Datei (fester Pfad: Konfiguration und Tests laufen in verschiedenen Prozessen) */
export const E2E_SQLITE_FILE = join(tmpdir(), 'pds-e2e-sqlite', 'pds.db')

/** Nachbau der EPLAN-API (global-setup startet ihn) */
export const FAKE_EPLAN_PORT = Number(process.env.E2E_FAKE_EPLAN_PORT ?? 3399)
export const FAKE_EPLAN_URL = `http://127.0.0.1:${FAKE_EPLAN_PORT}`
export const E2E_API_USER = 'e2e@example.com'
export const E2E_API_PASSWORD = 'E2E-Passwort!'

/** Feste Ordner (Konfiguration und Tests laufen in verschiedenen Prozessen und müssen denselben Pfad kennen) */
export const EPDZ_DIR = join(tmpdir(), 'pds-e2e-epdz')
export const LOG_DIR = join(tmpdir(), 'pds-e2e-logs')
