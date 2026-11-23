import type { H3Event } from 'h3'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { SessionUser } from '../../shared/types/auth'
import { OAuthError, authenticateAccessToken, currentTime, loadConsentSession, oauthOptions } from '../oauth'
import type { ConsentSession, OAuthOptions } from '../oauth'
import { buildMcpServer } from '../mcp'
import type { McpServerDefinition } from '../mcp'

/** Adresse, Verbindungsdauer (= Sitzungsdauer) und Zeitquelle für alle OAuth-Funktionen */
export function useOAuthOptions(): OAuthOptions {
  const { public: { appUrl }, session: { maxAge } } = useRuntimeConfig()
  return oauthOptions(appUrl, maxAge)
}

/**
 * Ist der MCP-Zugang ausgeschaltet, gibt es die Endpunkte nicht (404 statt 403: sie sollen nicht auffindbar sein).
 * Nur ein echtes `true` schaltet ein: ein Text wie "off" oder "false" aus der Umgebung darf nicht als wahr gelten.
 */
export function requireMcpEnabled(): void {
  if (useRuntimeConfig().public.mcpEnabled !== true) throw createError({ statusCode: 404, message: 'not_found' })
}

/**
 * Person auf der Zustimmungsseite (`/api/oauth/authorize`). Mit `mcp.adminOnly` (Laufzeit-Konfiguration der App,
 * Standard aus) dürfen nur Admins Programme zulassen. Geprüft im Handler selbst: eine Middleware mit Pfadvergleich
 * übersieht Schreibweisen, die der Router trotzdem hierher leitet (etwa ein abschließender Schrägstrich).
 * Nur ein echtes `false` (oder nichts) schaltet die Prüfung ab – ein unklarer Wert verlangt im Zweifel Admin.
 */
export function requireConsentUser(event: H3Event): Promise<SessionUser> {
  const adminOnly = (useRuntimeConfig() as { mcp?: { adminOnly?: unknown } }).mcp?.adminOnly
  return requireAuth(event, { admin: adminOnly !== undefined && adminOnly !== null && adminOnly !== false })
}

// Body vom Token-/Registrierungs-Endpunkt: kaputtes JSON soll als OAuth-Fehler ankommen, nicht als h3-Fehler
export async function readOAuthBody(event: H3Event): Promise<unknown> {
  try {
    return await readBody(event)
  }
  catch {
    throw new OAuthError('invalid_request', 'The request body could not be read')
  }
}

/**
 * Rahmen der OAuth-Endpunkte (`/oauth/*`): MCP muss an sein, Antworten dürfen nie zwischengespeichert werden
 * (RFC 6749 5.1), OAuthError wird zu `{ error, error_description }` mit dessen Status. Alles andere
 * (Datenbank, Programmfehler) bleibt ein 500 und verrät nichts. Scheitert die Anmeldung eines Programms per
 * Basic-Header, fordert der 401 sie wieder an (RFC 6749 5.2).
 */
export async function oauthEndpoint<T>(event: H3Event, fn: () => Promise<T>, status?: number): Promise<T | { error: string, error_description: string }> {
  requireMcpEnabled()
  setResponseHeaders(event, { 'cache-control': 'no-store', 'pragma': 'no-cache' })
  try {
    const result = await fn()
    if (status !== undefined) setResponseStatus(event, status)
    return result
  }
  catch (error) {
    if (!(error instanceof OAuthError)) throw error
    setResponseStatus(event, error.status)
    if (error.status === 401 && error.code === 'invalid_client' && /^Basic\s/i.test(getRequestHeader(event, 'authorization') ?? ''))
      setResponseHeader(event, 'www-authenticate', 'Basic realm="oauth"')
    return { error: error.code, error_description: error.description }
  }
}

/**
 * Für `/api/oauth/*`: Prüffehler der Anfrage werden zu einem Code, den die Zustimmungsseite übersetzt (`errors.<code>`);
 * der Status bleibt (`reauth_required` ist ein 401, Prüffehler sind 400)
 */
export async function oauthApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  }
  catch (error) {
    if (error instanceof OAuthError) throw createError({ statusCode: error.status, message: error.code })
    throw error
  }
}

/**
 * Sitzung, mit der die Person zustimmt: höchstens 10 Minuten alt, sonst OAuthError `reauth_required` (401) – die
 * Zustimmungsseite schickt dann einmal über die Anmeldung (Entra-SSO meist ohne Eingabe) und kommt zurück.
 */
export async function requireConsentSession(event: H3Event, user: SessionUser, o: OAuthOptions): Promise<ConsentSession> {
  const { sessionId } = await getUserSession(event)
  return loadConsentSession(useDb(), sessionId, user.id, currentTime(o))
}

// Gleiche Grenze wie die Anfragewächter-Middleware; sie prüft nur den Content-Length-Header, der Transport zählt mit
const MAX_MCP_BODY_BYTES = 1_000_000

/**
 * `/mcp` (zustandslos, nur POST): prüft das Bearer-Token und beantwortet die JSON-RPC-Anfrage mit einem Server, der
 * nur die Werkzeuge der Verbindungsstufe kennt. Ohne gültiges Token ein 401 mit Verweis auf die Ressourcen-Metadaten
 * (RFC 9728), über die Programme den OAuth-Ablauf finden.
 */
export async function handleMcpRequest(event: H3Event, def: McpServerDefinition): Promise<unknown> {
  requireMcpEnabled()

  // Browser, die die Adresse öffnen, landen bei der Anleitung statt bei einer Fehlermeldung
  if (event.method === 'GET' && (getRequestHeader(event, 'accept') ?? '').includes('text/html'))
    return sendRedirect(event, '/assistants')
  if (event.method !== 'POST') {
    setResponseStatus(event, 405)
    setResponseHeader(event, 'allow', 'POST')
    return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }
  }

  const o = useOAuthOptions()
  const token = /^Bearer\s+(\S+)$/i.exec((getRequestHeader(event, 'authorization') ?? '').trim())?.[1]
  const principal = token ? await authenticateAccessToken(useDb(), o, token) : null
  if (!principal) {
    const challenge = `Bearer resource_metadata="${o.issuer}/.well-known/oauth-protected-resource/mcp"`
    setResponseStatus(event, 401)
    setResponseHeader(event, 'www-authenticate', token ? `${challenge}, error="invalid_token"` : challenge)
    return { error: token ? 'invalid_token' : 'unauthorized' }
  }

  const server = buildMcpServer(def, { user: principal.user, access: principal.access })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(toWebRequest(event))
  }
  finally {
    // Der Server lebt nur für diese Anfrage; ohne Schließen blieben Handler und Zuordnungen hängen
    await server.close()
  }
}
