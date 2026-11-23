import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { defineConfig } from 'vite'

// app.config.ts des UI-Layers ruft das Nuxt-Global `defineAppConfig` auf; ohne Nuxt reicht die Identität.
// Deshalb erst das Global setzen, dann dynamisch importieren (statische Importe liefen vorher).
globalThis.defineAppConfig = config => config
const { default: appConfig } = await import('@pds/ui/app-config')

const uiLayer = fileURLToPath(new URL('../../../packages/ui', import.meta.url))

// Hinweise (variant="subtle") in Siemens-Flächen mit dunklem Text; die Signalfarbe tragen Icon und Rand.
// Die Farbvarianten aus app.config.ts greifen hier nicht (Nuxt UI legt `color` als Text-Variante an),
// und Gelb auf Hellgelb wäre unleserlich. Klassen ausgeschrieben, damit Tailwind sie findet.
const alertSubtle = [
  { color: 'primary', class: { root: 'bg-(--ui-color-siemens-hover-background) border-l-(--ui-color-siemens)', icon: 'text-(--ui-color-siemens)' } },
  { color: 'info', class: { root: 'bg-(--ui-color-alert-info) border-l-(--ui-color-feedback-blue)', icon: 'text-(--ui-color-feedback-blue)' } },
  { color: 'success', class: { root: 'bg-(--ui-color-alert-success) border-l-(--ui-color-feedback-green)', icon: 'text-(--ui-color-feedback-green)' } },
  { color: 'warning', class: { root: 'bg-(--ui-color-alert-warning) border-l-(--ui-color-feedback-yellow)', icon: 'text-(--ui-color-feedback-orange)' } },
  { color: 'error', class: { root: 'bg-(--ui-color-alert-error) border-l-(--ui-color-feedback-red)', icon: 'text-(--ui-color-feedback-red)' } },
].map(({ color, class: slots }) => ({
  color,
  variant: 'subtle',
  class: { ...slots, root: `${slots.root} text-(--ui-text) ring-0`, title: 'font-semibold', description: 'opacity-100' },
}))

export default defineConfig({
  // Siemens-Schriften des UI-Layers (/fonts/…), keine eigene Kopie
  publicDir: `${uiLayer}/public`,
  plugins: [
    vue(),
    ui({
      ui: {
        ...appConfig.ui,
        icons: {
          ...appConfig.ui.icons,
          // Fehlen im UI-Layer; sonst fiele Nuxt UI auf Lucide zurück und lüde nach
          edit: 'siemens:edit',
          star: 'siemens:favorite',
          trash: 'siemens:delete',
        },
        alert: {
          ...appConfig.ui.alert,
          compoundVariants: alertSubtle,
        },
      },
      theme: {
        colors: ['primary', 'secondary', 'tertiary', 'info', 'success', 'warning', 'error', 'neutral'],
      },
      // Ohne vue-router: die Bereiche schaltet App.vue selbst um
      router: false,
      // Explizite Importe statt generierter .d.ts-Dateien, damit `vue-tsc` ohne Vite-Lauf prüft
      autoImport: false,
      components: false,
      // Nur Siemens-Icons, registriert in src/icons.ts; nichts aus Iconify-Sammlungen bündeln
      icon: { clientBundle: false },
    }),
  ],
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Läuft nur in WebView2 (Chromium)
    target: 'chrome120',
    // Lädt lokal aus der EXE, nicht übers Netz; ein Bündel ist hier kein Nachteil
    chunkSizeWarningLimit: 1500,
  },
})
