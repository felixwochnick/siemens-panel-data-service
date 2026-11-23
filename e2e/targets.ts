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

/** Feste Ordner (Konfiguration und Tests laufen in verschiedenen Prozessen und müssen denselben Pfad kennen) */
export const LOG_DIR = join(tmpdir(), 'pds-e2e-logs')
/** Datenordner der App (uploads/, work/), vor jedem Start des Dev-Servers geleert */
export const DATA_DIR = join(tmpdir(), 'pds-e2e-data')
/** Projektordner mit Ersatz-Projekten (global-setup legt ihn an; der Admin trägt ihn in den Einstellungen ein) */
export const PROJECTS_DIR = join(tmpdir(), 'pds-e2e-projects')

/** Ersatz-Worker statt EPLAN: liefert packages/analyzer/fixtures/sample-raw.json (Pfad relativ zur Wurzel) */
export const FAKE_WORKER = 'spawn:node tools/fake-worker/index.mjs'

/** Zeilen der Fixture (20 Verbindungen, 5 Kabel mit 10 Adern, 2 Schirme mit 4 Adern, 8 Texte) */
export const FIXTURE = { connections: 20, cables: 5, cableWires: 10, shields: 2, shieldWires: 4, texts: 8 }
