export default defineNuxtConfig({
  extends: ['@pds/ui', '@pds/core'],

  modules: ['@nuxt/eslint'],

  devtools: { enabled: true },

  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },

  runtimeConfig: {
    // Verzeichnis mit den Protokolldateien des Windows-Dienstes (service.log, app.log, caddy.log, eplan-worker-*.log)
    logDir: '',
    // Verbindung zum EPLAN-Worker: `pipe:\\.\pipe\pds-eplan` (Dienst) oder `spawn:<Befehl …>` (Entwicklung);
    // leer ⇒ unter Windows die Pipe, sonst kein Worker (Aufträge bleiben in der Warteschlange)
    eplanWorker: '',
    // Datenordner mit uploads/ und work/ (NUXT_PDS_DATA_DIR); leer ⇒ ./.data relativ zur App
    pdsDataDir: '',
    // KI-Assistenten für alle Angemeldeten (die Werkzeuge prüfen Admin-Rechte selbst); Verbindung gilt 30 Tage
    mcp: { adminOnly: false, connectionSeconds: 30 * 86_400 },
    // Hochladen von Projekten (.zw1) ist größer als die allgemeine Grenze; die Route prüft ihre Grenze selbst
    requestGuard: { largeBodyPaths: ['/api/projects/upload'] },
    public: {
      appUrl: 'http://localhost:3400',
    },
  },

  // Die Einstellungsseite enthält Pfade und Benutzer des Netzlaufwerks
  routeRules: {
    '/settings': { headers: { 'cache-control': 'no-store' } },
  },

  compatibilityDate: '2026-10-01',

  eslint: {
    config: {
      stylistic: true,
    },
  },

  // Texte je Bereich in eigener Datei (de/en), damit Änderungen sich nicht überschneiden
  i18n: {
    locales: ['de', 'en'].map(code => ({
      code,
      files: ['app', 'analyses', 'settings'].map(f => `${code}/${f}.json`),
    })),
  },
})
