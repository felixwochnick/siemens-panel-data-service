import { fileURLToPath } from 'node:url'

// Gemeinsamer Design-Layer aller PDS-Monorepos: Nuxt UI im Siemens-Design, Siemens-Icons, Schriften, Sprachen
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxtjs/i18n', '@vueuse/nuxt'],

  app: {
    head: {
      meta: [{ name: 'theme-color', content: '#000028' }],
    },
  },

  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],

  ui: {
    theme: {
      colors: ['primary', 'secondary', 'tertiary', 'info', 'success', 'warning', 'error', 'neutral'],
    },
  },

  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'de',
    locales: [
      { code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'pds_locale',
      fallbackLocale: 'de',
    },
  },

  // Nur Siemens-Icons; alle verwendeten Symbole landen im Client-Bundle (keine Nachladeanfragen)
  icon: {
    customCollections: [
      { prefix: 'siemens', dir: fileURLToPath(new URL('./app/assets/siemens', import.meta.url)) },
    ],
    clientBundle: {
      scan: { globInclude: ['**/*.{vue,ts}'], globExclude: ['node_modules', 'dist', '.nuxt', '.output', 'e2e', 'tests'] },
      includeCustomCollections: true,
      sizeLimitKb: 512,
    },
  },
})
