/** Anzeige-Zeitzone: fest, damit Server (UTC) und Browser identisch rendern */
export const DISPLAY_TIME_ZONE = 'Europe/Berlin'

export function formatDateTime(value: string | Date | null | undefined, locale: string, options: { seconds?: boolean, timeZone?: string } = {}): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: options.seconds ? 'medium' : 'short',
    timeZone: options.timeZone ?? DISPLAY_TIME_ZONE,
  }).format(date)
}

/** Uhrzeit mit Sekunden (Ereignisse eines Laufs) */
export function formatTime(value: string | null | undefined, locale: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(locale, { timeStyle: 'medium', timeZone: DISPLAY_TIME_ZONE }).format(new Date(value))
}

/** Dauer kompakt: „45 s“, „3 min 12 s“, „2 h 5 min“ */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null
  return new Date(end).getTime() - new Date(start).getTime()
}

/** Dateigröße mit Einheit (1024er-Schritte) */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}
