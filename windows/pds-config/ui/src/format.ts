import type { Config } from './bindings/Config'

const DAY_MS = 24 * 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// Feste Zeitzone (UTC) wie die CLI, damit Ausgaben auf allen Servern gleich lesbar sind
export function formatDateTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${at.getUTCFullYear()} `
    + `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} UTC`
}

export function formatDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${at.getUTCFullYear()}`
}

/**
 * Vorschlag für den Dateinamen einer Sicherung (`pds-sicherung-20261123.db`). Lokales Datum, nicht
 * UTC: Der Name soll den Kalendertag zeigen, an dem der Admin am Server gesichert hat.
 */
export function backupFileName(now = new Date()): string {
  return `pds-sicherung-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.db`
}

/**
 * Dateigröße wie im Explorer (Basis 1024), eine Nachkommastelle mit Komma. Zahl und Einheit trennt ein
 * geschütztes Leerzeichen, damit „18,0 MB“ nicht über zwei Zeilen bricht.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes) || 0)}\u00A0Byte`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  // Erst nach dem Runden wechseln, sonst stünde „1024,0 KB“ statt „1,0 MB“ da
  while (Math.round(value * 10) / 10 >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1).replace('.', ',')}\u00A0${units[unit]}`
}

/** Angebrochene Tage bis `iso`; negativ, sobald der Zeitpunkt vorbei ist */
export function daysUntil(iso: string, now = Date.now()): number {
  const days = (new Date(iso).getTime() - now) / DAY_MS
  return days >= 0 ? Math.ceil(days) : Math.floor(days)
}

export function secondsSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
}

// Wie `render::app_url` (Rust): Schema nur bei `off` frei, Standardport entfällt, Host klein,
// IPv6-Literal in Klammern. Nur zur Anzeige des Entwurfs, gespeichert rechnet der Dienst selbst.
export function appUrlOf(config: Config): string {
  const scheme = config.tls.mode === 'off' ? config.public.scheme : 'https'
  const defaultPort = scheme === 'http' ? 80 : 443
  const lower = config.public.host.toLowerCase()
  const host = lower.includes(':') ? `[${lower}]` : lower
  return config.public.port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${config.public.port}`
}

export function redirectUriOf(config: Config): string {
  return `${appUrlOf(config)}/auth/callback`
}

// Wie `render::issuer` (Rust)
export function issuerOf(config: Config): string {
  return config.oidc.issuer === ''
    ? `https://login.microsoftonline.com/${config.oidc.tenant_id}/v2.0`
    : config.oidc.issuer.replace(/\/+$/, '')
}

/** Wert eines Zahlenfeldes; leer oder ungültig wird 0 (die Prüfung meldet dann `invalid_port`) */
export function toPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0
}
