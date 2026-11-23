import { defineConfig, devices } from '@playwright/test'

const PORT = 5181

// Bildschirmprüfung der Oberfläche im Browser mit den Beispieldaten (src/api/mock.ts).
// Nicht Teil von `pnpm test`; Aufruf: pnpm --filter @pds/config-ui test:screens
export default defineConfig({
  testDir: './e2e',
  // Die Bildschirmfotos liegen getrennt in test-results/screens/ (siehe e2e/screens.spec.ts)
  outputDir: 'test-results/playwright',
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
