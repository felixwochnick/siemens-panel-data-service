import { defineConfig } from 'vitest/config'

// Eigene Konfiguration ohne Nuxt-UI-Plugin: Die Unit-Tests prüfen reine Logik (useDraft, Formatierung).
// Die Bildschirmprüfung (e2e/) läuft mit Playwright über `test:screens`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
