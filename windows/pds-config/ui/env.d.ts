/// <reference types="vite/client" />

declare global {
  // Nuxt-Global, das app.config.ts des UI-Layers aufruft; vite.config.ts setzt es als Identität
  var defineAppConfig: <T>(config: T) => T
}

export {}
