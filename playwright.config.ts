import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { e2eDatabaseUrl } from './e2e/db'
import { APP_URL, E2E_DIALECT, LOG_DIR, OIDC_ISSUER } from './e2e/targets'

// Protokollordner wie im Windows-Dienst (NUXT_LOG_DIR) mit Beispieldateien; fester Pfad, weil die Konfiguration
// in mehreren Prozessen geladen wird
mkdirSync(LOG_DIR, { recursive: true })
writeFileSync(join(LOG_DIR, 'service.log'), ['2026-11-21T08:00:00Z INFO Dienst gestartet', '2026-11-21T08:00:01Z INFO Node gestartet', '2026-11-21T08:00:02Z WARN E2E-Warnung', ''].join('\r\n'))
writeFileSync(join(LOG_DIR, 'service.log.1'), 'alte Zeile\n')

// Eigener Dev-Server auf Port 3500 gegen die Datenbank pds_e2e (SQL Server) oder mit E2E_DATABASE=sqlite gegen eine
// frische SQLite-Datei im Temp-Ordner. Vorher `pnpm sso:up` (SQL Server und Test-IdP); laufende `pnpm dev`-Server dieser
// App beenden (gemeinsames .nuxt).
const env = {
  E2E_DATABASE: E2E_DIALECT,
  NUXT_DATABASE_URL: e2eDatabaseUrl(),
  NUXT_APP_SECRET: 'e2e-only-app-secret-0123456789abcdefghij',
  NUXT_PUBLIC_APP_URL: APP_URL,
  NUXT_OIDC_ISSUER: OIDC_ISSUER,
  NUXT_OIDC_CLIENT_ID: 'pds',
  NUXT_OIDC_CLIENT_SECRET: 'pds-dev-secret',
  NUXT_OIDC_SCOPES: 'openid profile email groups',
  NUXT_OIDC_ROLES_CLAIM: 'groups',
  NUXT_OIDC_ADMIN_ROLES: 'admins',
  NUXT_PUBLIC_OIDC_PROVIDER_NAME: 'Dex (Test)',
  NUXT_PUBLIC_MCP_ENABLED: 'true',
  NUXT_LOG_DIR: LOG_DIR,
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Die Tests bauen aufeinander auf (gemeinsame Datenbank)
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    locale: 'de-DE',
    screenshot: 'only-on-failure',
    trace: 'off',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'pnpm exec tsx e2e/ensure-db.ts && pnpm --filter @pds/web exec nuxt dev --port 3500',
    url: `${APP_URL}/api/health`,
    env,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
})
