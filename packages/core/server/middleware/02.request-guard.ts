const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_BODY_BYTES = 1_000_000

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/**
 * Schutz für schreibende Anfragen an /api, /auth, /oauth und /mcp:
 * - Größe: übergroße Bodies früh ablehnen (der Proxy begrenzt zusätzlich); gilt für alle vier
 * - CSRF (nur /api und /auth, also Anfragen mit Cookie-Sitzung): SameSite=Lax schützt nicht vor
 *   Geschwister-Subdomains (*.<domain>) – daher Origin bzw. Sec-Fetch-Site prüfen; ohne beide Angaben
 *   (Skripte) nur JSON zulassen (erzwingt bei Browsern einen Preflight). /oauth und /mcp nutzen keine
 *   Cookies, sondern Programm-Zugangsdaten bzw. Bearer-Token, und werden von Programmen ohne Origin aufgerufen
 */
export default defineEventHandler((event) => {
  if (!UNSAFE_METHODS.has(event.method)) return
  const path = event.path.split('?')[0]!
  const withSession = isUnder(path, '/api') || isUnder(path, '/auth')
  if (!withSession && !isUnder(path, '/oauth') && !isUnder(path, '/mcp')) return

  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY_BYTES)
    throw createError({ statusCode: 413, message: 'payload_too_large' })
  if (!withSession) return

  const origin = getRequestHeader(event, 'origin')
  if (origin) {
    if (origin !== new URL(useRuntimeConfig().public.appUrl).origin) throw createError({ statusCode: 403, message: 'forbidden' })
    return
  }
  const site = getRequestHeader(event, 'sec-fetch-site')
  if (site) {
    if (site !== 'same-origin' && site !== 'none') throw createError({ statusCode: 403, message: 'forbidden' })
    return
  }
  const type = getRequestHeader(event, 'content-type') ?? ''
  if (event.method !== 'DELETE' && !type.toLowerCase().startsWith('application/json'))
    throw createError({ statusCode: 415, message: 'unsupported_media_type' })
})
