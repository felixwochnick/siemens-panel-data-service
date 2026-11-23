import { protectedResourceMetadata } from '../oauth'

// Eingetragen in nuxt.config.ts (serverHandlers), weil Ordner mit Punkt nicht gescannt werden
export default defineEventHandler(() => {
  requireMcpEnabled()
  // Der Name des Servers kommt aus der App (app.config); core kennt den Schlüssel nicht
  const pds = (useAppConfig() as { pds?: { mcp?: { title?: string } } }).pds
  return protectedResourceMetadata(useOAuthOptions(), pds?.mcp?.title ?? 'MCP')
})
