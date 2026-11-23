// Protokoll von pds-tools.mjs: Jede Zeile auf stdout ist ein JSON-Objekt (ein Schritt oder das Ergebnis).
// Eingaben kommen nur über die Umgebung, nie über Argumente (Prozessargumente sind für andere sichtbar).

export type Details = Record<string, unknown>

/** Eine Ausgabezeile. `step` = Zwischenschritt, `result` = Abschluss (genau eine, wenn möglich). */
export interface ToolLine {
  type: 'step' | 'result'
  ok: boolean
  code: string
  message: string
  details?: Details
}

/** Codes der Fehlschläge (Schnittstelle zu Rust und UI, nur ergänzen) */
export type ErrorCode
  = | 'invalid_url' | 'dns_failed' | 'connection_refused' | 'timeout' | 'tls_untrusted'
    | 'login_failed' | 'database_missing' | 'permission_denied' | 'password_policy'
    | 'discovery_failed' | 'issuer_mismatch' | 'invalid_discovery'
    | 'client_secret_invalid' | 'client_secret_expired' | 'client_id_unknown'
    // SQLite (db-test, db-backup) und Befehle, die für die gewählte Datenbank nicht gelten
    | 'network_path' | 'cannot_open' | 'read_only' | 'locked' | 'not_a_database' | 'corrupt'
    | 'disk_full' | 'io_error' | 'not_found' | 'target_exists' | 'not_needed' | 'not_supported'
    | 'internal_error'

/** Erfolg eines Befehls: Meldung und Einzelheiten der Abschlusszeile */
export interface Outcome {
  message: string
  details?: Details
}

/** 0 = ok, 3 = Prüfung fehlgeschlagen, 1 = Bedienfehler oder interner Fehler */
export const EXIT_OK = 0
export const EXIT_INTERNAL = 1
export const EXIT_FAILED = 3

/** Erwarteter Fehlschlag einer Prüfung (Exit 3); `step` benennt den Schritt, der scheiterte */
export class ToolFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Details,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ToolFailure'
  }
}

/** Falsche Eingabe des Aufrufers (fehlende Umgebungsvariable, ungültiger Name): Exit 1 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Schreibt Zwischenschritte. Ein Schritt trägt als `code` seine Kennung (`connect`, `db_owner` …);
 * den Fehlercode eines gescheiterten Schritts nennt `details.error`. Eine Warnung ist ein Schritt mit
 * `ok: false` und `details.warning: true`; sie lässt das Ergebnis ok.
 */
export class Reporter {
  constructor(private readonly write: (line: ToolLine) => void) {}

  ok(code: string, message: string, details?: Details): void {
    this.write({ type: 'step', ok: true, code, message, ...(details && { details }) })
  }

  warn(code: string, message: string, details?: Details): void {
    this.write({ type: 'step', ok: false, code, message, details: { ...details, warning: true } })
  }

  fail(code: string, failure: ToolFailure): void {
    this.write({ type: 'step', ok: false, code, message: failure.message, details: { ...failure.details, error: failure.code } })
  }

  result(ok: boolean, code: string, message: string, details?: Details): void {
    this.write({ type: 'result', ok, code, message, ...(details && { details }) })
  }
}

/**
 * Führt einen Schritt aus. Scheitert er, wird der Schritt als Fehlschlag gemeldet und die
 * Ausnahme weitergereicht (der Aufrufer meldet daraus das Ergebnis).
 */
export async function runStep<T>(report: Reporter, code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (error instanceof ToolFailure) report.fail(code, error)
    throw error
  }
}

/** Liest eine Pflichtvariable; fehlt sie oder ist sie leer, ist das ein Bedienfehler */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new UsageError(`Umgebungsvariable ${name} fehlt`)
  return value
}

// ---------------------------------------------------------------------------------------------
// Geheimnisse aus der Ausgabe fernhalten
// ---------------------------------------------------------------------------------------------

/** Variablen, deren Wert (und bei URLs das Passwort darin) nie ausgegeben werden darf */
const SECRET_VARIABLES = ['NUXT_DATABASE_URL', 'PDS_ADMIN_DATABASE_URL', 'PDS_DB_PASSWORD', 'NUXT_OIDC_CLIENT_SECRET']
const URL_VARIABLES = new Set(['NUXT_DATABASE_URL', 'PDS_ADMIN_DATABASE_URL'])
/** Kürzere Werte würden normalen Text zerstückeln; Passwörter sind länger */
const MIN_SECRET_LENGTH = 4
const MASK = '***'

export function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const secrets = new Set<string>()
  const add = (value: string | undefined) => {
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value)
  }
  for (const name of SECRET_VARIABLES) {
    const value = env[name]
    if (!value) continue
    // Eine SQLite-URL (`sqlite:<pfad>`) enthält kein Geheimnis, nur den Pfad, und den sollen die Meldungen nennen
    if (URL_VARIABLES.has(name) && /^sqlite:/i.test(value)) continue
    add(value)
    // So steht das Passwort in einem T-SQL-Literal (' verdoppelt), falls ein Serverfehler es wiedergibt
    add(value.replaceAll('\'', '\'\''))
    if (!URL_VARIABLES.has(name)) continue
    // Das Passwort steht in der URL kodiert, in Fehlertexten aber oft dekodiert
    try {
      const { password } = new URL(value)
      add(password)
      add(decodeURIComponent(password))
    }
    catch { /* keine gültige URL: der ganze Wert ist schon erfasst */ }
  }
  return [...secrets]
}

export class Scrubber {
  private readonly secrets: string[]

  constructor(secrets: string[]) {
    // Längste zuerst: Die ganze URL enthält das Passwort, das sonst einzeln ersetzt würde
    this.secrets = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)
  }

  text(value: string): string {
    let result = value
    for (const secret of this.secrets) result = result.split(secret).join(MASK)
    return result
  }

  /** Auch die Form, in der das Geheimnis in JSON-Text steht (Anführungszeichen, Backslash maskiert) */
  json(serialized: string): string {
    let result = serialized
    for (const secret of this.secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1)
      if (escaped !== secret) result = result.split(escaped).join(MASK)
    }
    return result
  }

  deep<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T
    if (Array.isArray(value)) return value.map(item => this.deep(item)) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)])) as T
    }
    return value
  }

  /** Eine fertige, geprüfte JSON-Zeile */
  line(line: ToolLine): string {
    return this.json(JSON.stringify(this.deep(line)))
  }
}
