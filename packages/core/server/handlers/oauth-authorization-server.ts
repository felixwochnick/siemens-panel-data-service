import { authorizationServerMetadata } from '../oauth'

// Eingetragen in nuxt.config.ts (serverHandlers), weil Ordner mit Punkt nicht gescannt werden
export default defineEventHandler(() => {
  requireMcpEnabled()
  return authorizationServerMetadata(useOAuthOptions())
})
