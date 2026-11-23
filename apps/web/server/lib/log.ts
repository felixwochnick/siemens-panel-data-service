// Protokoll-Hilfen aus dem ESWC-Controller (packages/controller/src/log.ts): Geheimnisse entfernen, kürzen, Einzeiler
import type { LogLevel } from '../../shared/types/api'

export const DETAIL_MAX_LENGTH = 2000

/** Ereignis einer Analyse (vor dem Speichern in pds.analysis_events) */
export interface LogEvent {
  level: LogLevel
  /** Text unter analysisEvents.<code> */
  code: string
  params?: Record<string, string | number>
  /** Rohtext von Worker oder Betriebssystem, ohne Geheimnisse, gekürzt */
  detail?: string
}
export type EventLogger = (event: LogEvent) => void

/** Englische Einzeile für stdout bzw. app.log unter Windows: `INFO  [code] key=value | detail` */
export function formatEvent(event: LogEvent): string {
  const params = Object.entries(event.params ?? {}).map(([key, value]) => `${key}=${value}`).join(' ')
  const detail = event.detail ? ` | ${event.detail}` : ''
  return oneLine(`${event.level.toUpperCase().padEnd(5)} [${event.code}] ${params}${detail}`.trimEnd())
}

function oneLine(text: string): string {
  return text.replace(/\r?\n|\r/g, ' \\n ')
}

type HexCase = 'lower' | 'upper'

/** Inhalt eines JSON-Strings; optional `/` als `\/` und Nicht-ASCII als `\uXXXX` (je UTF-16-Einheit) */
function jsonEscape(text: string, slash: boolean, hex?: HexCase): string {
  let out = JSON.stringify(text).slice(1, -1)
  if (slash) out = out.replace(/\//g, '\\/')
  if (hex) {
    out = out.replace(/[\u0080-￿]/g, (char) => {
      const code = char.charCodeAt(0).toString(16).padStart(4, '0')
      return `\\u${hex === 'upper' ? code.toUpperCase() : code}`
    })
  }
  return out
}

// JSON.stringify maskiert weder `/` noch Nicht-ASCII, andere Encoder (.NET, PHP) tun es – alle Formen erkennen
const JSON_ENCODERS = [false, true].flatMap(slash =>
  ([undefined, 'lower', 'upper'] as const).map(hex => (text: string) => jsonEscape(text, slash, hex)))

/** So tief verschachtelt wird ein JSON-kodiertes Geheimnis noch erkannt */
const MAX_JSON_DEPTH = 2

/** Ersetzt alle Vorkommen der Geheimnisse (roh, JSON- und URL-kodiert) durch `***` */
export function scrubSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let result = text
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (!secret) continue
    let level = [secret]
    level.forEach(v => variants.add(v))
    for (let depth = 1; depth <= MAX_JSON_DEPTH; depth++) {
      level = [...new Set(level.flatMap(v => JSON_ENCODERS.map(encode => encode(v))))]
      level.forEach(v => variants.add(v))
    }
    variants.add(encodeURIComponent(secret))
    variants.add(encodeURIComponent(secret).replace(/%20/g, '+'))
  }
  // Längste zuerst, damit kein Teilstück eines längeren Geheimnisses stehen bleibt
  for (const v of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(v).join('***')
  }
  return result
}

export function truncateDetail(text: string, max = DETAIL_MAX_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Detailtext für Ereignisse/Fehler: ohne Geheimnisse und gekürzt */
export function safeDetail(text: string | undefined | null, secrets: readonly (string | undefined | null)[]): string | undefined {
  if (text === undefined || text === null || text === '') return undefined
  return truncateDetail(scrubSecrets(String(text), secrets))
}

/**
 * Umhüllt einen Logger: entfernt Geheimnisse aus detail und Parametern, kürzt detail und schluckt Fehler des Loggers
 * (ein defekter Logger darf die Analyse nicht abbrechen).
 */
export function createSafeLogger(log: EventLogger, secrets: readonly (string | undefined | null)[]): EventLogger {
  return (event) => {
    const safe: LogEvent = { ...event }
    if (event.params) {
      safe.params = Object.fromEntries(Object.entries(event.params).map(([k, v]) => [k, typeof v === 'string' ? scrubSecrets(v, secrets) : v]))
    }
    if (event.detail !== undefined) {
      const detail = safeDetail(event.detail, secrets)
      if (detail === undefined) delete safe.detail
      else safe.detail = detail
    }
    try {
      log(safe)
    }
    catch {
      // Protokollfehler ignorieren
    }
  }
}

export const noopLogger: EventLogger = () => {}

/** Fehlertext für detail: Nachricht plus Detail und Ursache */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const detail = (err as { detail?: unknown }).detail
    const cause = (err as { cause?: unknown }).cause
    const parts = [err.message]
    if (typeof detail === 'string' && detail && !err.message.includes(detail)) parts.push(detail)
    if (cause instanceof Error && cause.message && !parts.some(p => p.includes(cause.message))) parts.push(cause.message)
    return parts.join(': ')
  }
  return String(err)
}
