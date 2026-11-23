/** Zugriffsstufen einer MCP-Verbindung, aufsteigend; `write` heißt in der App „Lesen und planen“ */
export const MCP_GRANTS = ['read', 'write'] as const
export type McpGrant = typeof MCP_GRANTS[number]

/** OAuth-Scopes, je Stufe einer */
export const MCP_SCOPES: string[] = MCP_GRANTS.map(grant => `mcp:${grant}`)

/** Die höhere Stufe schließt die niedrigere ein */
export function mcpAllows(have: McpGrant, need: McpGrant): boolean {
  return MCP_GRANTS.indexOf(have) >= MCP_GRANTS.indexOf(need)
}

/** höchste bekannte Stufe aus einem space-getrennten scope, sonst null */
export function grantFromScope(scope: string | null | undefined): McpGrant | null {
  const requested = new Set((scope ?? '').split(/\s+/))
  return MCP_GRANTS.findLast(grant => requested.has(`mcp:${grant}`)) ?? null
}

/** Rechnernamen des eigenen Rechners (Loopback), auf denen Programme wie Claude Code ihren Rücksprung empfangen */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Nur `https:` oder `http:` auf dem eigenen Rechner (Loopback), ohne Fragment und ohne Zugangsdaten.
 * Eigene App-Schemata (`cursor://`) sind bewusst ausgeschlossen: der Rücksprung soll nie unbemerkt
 * in ein fremdes Programm führen. Gilt bei der Registrierung und vor dem Rücksprung im Browser.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return false
  }
  // `#` auch dann ausschließen, wenn das Fragment leer ist (url.hash wäre dann '')
  if (value.includes('#') || url.username || url.password) return false
  if (url.protocol === 'https:') return url.hostname !== ''
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

/** Verbindung eines Assistenten, wie die Oberfläche sie listet (Zeitpunkte als ISO-Text) */
export interface McpConnectionInfo {
  id: string
  name: string
  access: McpGrant
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
}

/** Was die Zustimmungsseite über eine Autorisierungsanfrage anzeigt */
export interface AuthorizeInfo {
  client: { name: string, redirectHost: string }
  /** vom Programm angefragte Stufe (aus `scope`), nur zur Anzeige – vorausgewählt ist immer die niedrigste */
  requested: McpGrant | null
}
