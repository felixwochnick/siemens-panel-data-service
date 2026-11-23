// oidc-test: Discovery-Dokument des Issuers prüfen und bei Entra ID optional die Client-Anmeldedaten.
// Mit fetch wie die App (openid-client): Weiterleitungen werden nicht verfolgt, ein Proxy kommt über
// NODE_USE_ENV_PROXY, vertraut wird dem Speicher des Systems (--use-system-ca).
import { DNS_CODES, TIMEOUT_CODES, TLS_CERT_CODES, causeCodes, errorMessage } from './network'
import { ToolFailure, requireEnv, runStep } from './protocol'
import type { Outcome, Reporter } from './protocol'

const REQUEST_TIMEOUT_MS = 15_000
/** Größer ist nie ein Discovery-Dokument */
const MAX_BODY_CHARS = 1_000_000
const ENTRA_HOST = 'login.microsoftonline.com'
const REQUIRED_ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const
/** Graph gibt es in jedem Mandanten; Client-Credentials brauchen eine Ressource (`.default`) */
const CLIENT_CHECK_SCOPE = 'https://graph.microsoft.com/.default'

/** Entra-Fehler (AADSTS…), die eindeutig auf Client-ID oder -Secret zeigen */
const ENTRA_ERRORS = {
  7000215: ['client_secret_invalid', 'Entra ID lehnt das Client-Secret ab (AADSTS7000215). Vermutlich wurde die Secret-ID statt des Secret-Werts kopiert oder der Wert falsch eingegeben.'],
  7000222: ['client_secret_expired', 'Das Client-Secret ist abgelaufen (AADSTS7000222). Im Azure-Portal unter „Zertifikate & Geheimnisse“ ein neues erzeugen und eintragen.'],
  700016: ['client_id_unknown', 'Entra ID kennt die Client-ID in diesem Mandanten nicht (AADSTS700016). Anwendungs-ID (Client-ID) und Tenant-ID prüfen.'],
} as const satisfies Record<number, readonly [string, string]>

type ClientFailureCode = (typeof ENTRA_ERRORS)[keyof typeof ENTRA_ERRORS][0]

export type ClientCheck
  = | { kind: 'ok' }
    | { kind: 'failure', code: ClientFailureCode, message: string }
    | { kind: 'unknown', message: string }

export function isEntraIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    return url.protocol === 'https:' && url.hostname === ENTRA_HOST
  }
  catch {
    return false
  }
}

/** Erklärt einen Netzwerkfehler von fetch (die Ursache steckt in `cause`) */
function describeNetworkError(error: unknown): { text: string, cause?: string } {
  const codes = causeCodes(error)
  const cause = codes.find(code => TLS_CERT_CODES.has(code) || DNS_CODES.has(code) || TIMEOUT_CODES.has(code) || code === 'ECONNREFUSED') ?? codes[0]
  const isTimeout = (error instanceof Error && error.name === 'TimeoutError') || codes.some(code => TIMEOUT_CODES.has(code))
  if (isTimeout) return { text: `keine Antwort innerhalb von ${REQUEST_TIMEOUT_MS / 1000} Sekunden. Ist ein Proxy nötig (Einstellungen unter „Erweitert“)?`, cause: cause ?? 'timeout' }
  if (codes.some(code => TLS_CERT_CODES.has(code))) {
    return { text: 'Das TLS-Zertifikat des Servers ist nicht vertrauenswürdig. Die ausstellende CA muss im Zertifikatspeicher des Computers stehen (bei TLS-Inspektion durch einen Proxy: dessen CA).', cause }
  }
  if (codes.some(code => DNS_CODES.has(code))) return { text: 'Der Servername lässt sich nicht auflösen (DNS).', cause }
  if (codes.includes('ECONNREFUSED')) return { text: 'Die Verbindung wurde abgelehnt (Dienst gestartet, Port, Firewall, Proxy?).', cause }
  const inner = (error as { cause?: unknown } | undefined)?.cause
  return { text: inner ? errorMessage(inner) : errorMessage(error), ...(cause && { cause }) }
}

function parseIssuer(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url
  }
  catch { /* ungültig, siehe unten */ }
  throw new ToolFailure('invalid_url', 'NUXT_OIDC_ISSUER ist keine gültige Adresse (erwartet wird https://…).')
}

/** Nur der erklärende Satz: Entra hängt Trace-ID und Zeitstempel an, entweder nach einem Zeilenumbruch oder im selben Satz */
function firstLine(text: unknown): string {
  if (typeof text !== 'string') return ''
  return (text.split(/\r?\n/)[0] ?? '').replace(/\s*Trace ID:.*$/, '').trim()
}

/**
 * Prüft Client-ID und -Secret mit einer Client-Credentials-Anfrage an den Token-Endpunkt. Nur
 * eindeutig erkannte Fehler sind ein Fehlschlag; alles andere (anderer Fehler, Netzwerk) bleibt
 * ungeklärt, damit eine Eigenheit des Mandanten (Richtlinien, Scope) die Prüfung nicht scheitern lässt.
 * Das Token wird nie behalten.
 */
export async function checkClientCredentials(tokenEndpoint: string, clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Promise<ClientCheck> {
  let response: Response
  let text: string
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json' },
      // URLSearchParams als Body: Das Secret steht nur im Körper, nie in der Adresse
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: CLIENT_CHECK_SCOPE }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    text = (await response.text()).slice(0, MAX_BODY_CHARS)
  }
  catch (error) {
    return { kind: 'unknown', message: `Der Token-Endpunkt war nicht erreichbar: ${describeNetworkError(error).text}` }
  }

  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  }
  catch { /* kein JSON, siehe unten */ }

  if (response.ok && typeof body.access_token === 'string') return { kind: 'ok' }

  const description = typeof body.error_description === 'string' ? body.error_description : ''
  const numbers = new Set<number>()
  if (Array.isArray(body.error_codes)) for (const code of body.error_codes) if (typeof code === 'number') numbers.add(code)
  for (const match of description.matchAll(/AADSTS(\d+)/g)) numbers.add(Number(match[1]))
  for (const [number, [code, message]] of Object.entries(ENTRA_ERRORS)) {
    if (numbers.has(Number(number))) return { kind: 'failure', code, message }
  }

  const reason = firstLine(body.error_description) || (typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  return { kind: 'unknown', message: `Client-ID und Client-Secret ließen sich nicht abschließend prüfen: ${reason}` }
}

export async function oidcTest(env: NodeJS.ProcessEnv, report: Reporter): Promise<Outcome> {
  const issuer = parseIssuer(requireEnv(env, 'NUXT_OIDC_ISSUER'))
  const warnings: string[] = []

  if (issuer.protocol === 'http:') {
    warnings.push('transport')
    report.warn('transport', 'Der Issuer verwendet http. Die App erlaubt das nur im Entwicklungsmodus; im Betrieb ist https nötig.')
  }

  const discoveryUrl = `${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`
  const document = await runStep(report, 'discovery', async () => {
    let response: Response
    let text: string
    try {
      // Wie die App: Weiterleitungen nicht verfolgen
      response = await fetch(discoveryUrl, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      text = await response.text()
    }
    catch (error) {
      const { text: reason, cause } = describeNetworkError(error)
      throw new ToolFailure('discovery_failed', `Der Issuer ist nicht erreichbar: ${reason}`, { url: discoveryUrl, ...(cause && { cause }) })
    }
    if (response.status !== 200) {
      throw new ToolFailure('discovery_failed', `Der Issuer antwortet mit HTTP ${response.status} statt 200. Issuer-Adresse prüfen (bei Entra: https://login.microsoftonline.com/<Tenant-ID>/v2.0).`, { url: discoveryUrl, status: response.status })
    }
    let parsed: unknown
    try {
      if (text.length > MAX_BODY_CHARS) throw new Error('zu groß')
      parsed = JSON.parse(text)
    }
    catch {
      throw new ToolFailure('invalid_discovery', 'Die Antwort des Issuers ist kein Discovery-Dokument (kein JSON). Issuer-Adresse prüfen.', { url: discoveryUrl })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ToolFailure('invalid_discovery', 'Die Antwort des Issuers ist kein Discovery-Dokument (kein JSON-Objekt).', { url: discoveryUrl })
    }
    return parsed as Record<string, unknown>
  })
  report.ok('discovery', `Discovery-Dokument von ${issuer.host} abgerufen.`, { url: discoveryUrl })

  await runStep(report, 'issuer', async () => {
    const claimed = document.issuer
    if (typeof claimed !== 'string' || !claimed) throw new ToolFailure('invalid_discovery', 'Im Discovery-Dokument fehlt „issuer“.')
    // Wie die App (openid-client): Vergleich der normalisierten Adressen
    let same = false
    try {
      same = new URL(claimed).href === issuer.href
    }
    catch { /* kein URL: stimmt nicht überein */ }
    if (!same) {
      throw new ToolFailure('issuer_mismatch', `Der Issuer im Discovery-Dokument („${claimed}“) stimmt nicht mit dem konfigurierten („${issuer.href}“) überein. Die Anmeldung würde scheitern.`, { expected: issuer.href, actual: claimed })
    }
  })
  report.ok('issuer', 'Der Issuer im Discovery-Dokument stimmt überein.')

  const missing = REQUIRED_ENDPOINTS.filter((name) => {
    const value = document[name]
    if (typeof value !== 'string') return true
    try {
      return !['https:', 'http:'].includes(new URL(value).protocol)
    }
    catch {
      return true
    }
  })
  await runStep(report, 'endpoints', async () => {
    if (missing.length > 0) {
      throw new ToolFailure('invalid_discovery', `Im Discovery-Dokument fehlt bzw. ist ungültig: ${missing.join(', ')}.`, { missing })
    }
  })
  report.ok('endpoints', 'Anmelde-, Token- und Schlüssel-Endpunkt sind vorhanden.')

  if (env.PDS_OIDC_CHECK_CLIENT === '1') {
    const outcome = await checkClient(env, issuer, document, report)
    if (outcome === 'warning') warnings.push('client')
  }

  const hints = warnings.length === 0 ? '' : ', aber es gibt Hinweise'
  return { message: `Der Issuer ${issuer.host} ist erreichbar und das Discovery-Dokument passt${hints}.`, details: { warnings } }
}

/** Optionale Prüfung von Client-ID und -Secret; nur bei Entra ID und nur gegen deren eigenen Token-Endpunkt */
export async function checkClient(env: NodeJS.ProcessEnv, issuer: URL, document: Record<string, unknown>, report: Reporter, fetchImpl: typeof fetch = fetch): Promise<'ok' | 'warning'> {
  const clientId = env.NUXT_OIDC_CLIENT_ID ?? ''
  const clientSecret = env.NUXT_OIDC_CLIENT_SECRET ?? ''
  const skip = (reason: string) => {
    report.warn('client', `Client-ID und Client-Secret wurden nicht geprüft: ${reason}`)
    return 'warning' as const
  }
  if (!isEntraIssuer(issuer.href)) return skip('Die Prüfung gibt es nur für Microsoft Entra ID.')
  if (!clientId) return skip('Es ist keine Client-ID eingetragen.')
  if (!clientSecret) return skip('Es ist kein Client-Secret eingetragen.')
  // Das Secret geht nur per https an den Token-Endpunkt von Entra, auch wenn das Dokument anderes behauptet
  const tokenEndpoint = String(document.token_endpoint)
  let token: URL
  try {
    token = new URL(tokenEndpoint)
  }
  catch {
    return skip('Der Token-Endpunkt ist keine gültige Adresse.')
  }
  if (token.protocol !== 'https:' || token.hostname !== ENTRA_HOST) return skip('Der Token-Endpunkt liegt nicht bei Microsoft oder verwendet kein https.')

  const check = await checkClientCredentials(tokenEndpoint, clientId, clientSecret, fetchImpl)
  if (check.kind === 'unknown') {
    report.warn('client', check.message)
    return 'warning'
  }
  await runStep(report, 'client', async () => {
    if (check.kind === 'failure') throw new ToolFailure(check.code, check.message)
  })
  report.ok('client', 'Client-ID und Client-Secret werden von Entra ID akzeptiert.')
  return 'ok'
}
