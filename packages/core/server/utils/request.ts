/** Seiten-, API- und Auth-Anfragen – keine statischen Dateien oder Nuxt-Interna (/_nuxt, /__nuxt_…) */
export function isDynamicRequest(path: string): boolean {
  if (path.startsWith('/api/_')) return true
  if (path.startsWith('/_') || path.startsWith('/__')) return false
  const lastSegment = path.split('?')[0]!.split('/').pop() ?? ''
  return !lastSegment.includes('.')
}

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/**
 * Endpunkte, die Programme ohne Cookie aufrufen (MCP, OAuth-Registrierung/-Token/-Widerruf, Metadaten): Sie lesen keine
 * Sitzung und bekommen auch kein Sitzungs-Cookie. Zustimmungsseite und `/api/oauth/*` gehören zur Oberfläche.
 */
export function isSessionlessRequest(path: string): boolean {
  const pathname = path.split('?')[0]!
  return isUnder(pathname, '/mcp') || pathname.startsWith('/.well-known/')
    || ['/oauth/register', '/oauth/token', '/oauth/revoke'].some(prefix => isUnder(pathname, prefix))
}
