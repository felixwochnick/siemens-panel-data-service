// Standardwerte und Prüfung der Einstellungen; Pfad-Hilfen aus dem ESWC-Controller (packages/controller/src/settings.ts)
import { EPLAN_OPEN_MODES, SETTINGS_LIMITS } from '../../shared/types/api'
import type { PdsSettings, SettingsIssue, SettingsIssueCode } from '../../shared/types/api'
import { isValidCron } from './schedule'

export const defaultSettings: PdsSettings = {
  folder: '',
  source: 'local',
  networkDrive: { mapping: '', networkPath: '', user: '', password: '' },
  recursive: true,
  filePatterns: ['*.elk', '*.zw1'],
  // Wie die bisherige .NET-Version (config.yaml)
  eplan: {
    platformBin: 'C:\\Program Files\\EPLAN\\Platform\\2025.0.3\\Bin',
    productBin: 'C:\\Program Files\\EPLAN\\Electric P8\\2025.0.3\\Bin',
    applicationModifier: '',
    openMode: 'ReadOnly',
  },
  // Anti-Ziel: nach der Installation analysiert der Zeitplan nichts ungefragt
  schedulerEnabled: false,
  cronSchedule: '0 0 2 * * ?',
  timezone: 'Europe/Berlin',
  analysisTimeoutMinutes: 60,
  retentionDays: 180,
  uploadMaxMb: 500,
}

/** Grenzen der Zahlenwerte (Prüfung und Formular; steht im gemeinsamen Vertrag, damit das Formular sie kennt) */
export const LIMITS = SETTINGS_LIMITS

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}

const DRIVE_LETTER_RE = /^[a-z]:?$/i
// \\server\share[\pfad] – Server und Freigabe ohne verbotene Zeichen
const UNC_RE = /^\\\\[^\\/:*?"<>|\s][^\\/:*?"<>|]*\\[^\\/:*?"<>|]+(?:\\[^\\/:*?"<>|]*)*$/

/** Laufwerksbuchstabe normalisiert ("p", "P:" → "P"); leer bleibt leer */
export function normalizeDriveLetter(mapping: string): string {
  return (mapping ?? '').trim().replace(/[:\\/]+$/, '').toUpperCase()
}

export function isValidDriveLetter(mapping: string): boolean {
  return DRIVE_LETTER_RE.test((mapping ?? '').trim().replace(/\\$/, ''))
}

export function isValidUncPath(path: string): boolean {
  return UNC_RE.test(path ?? '')
}

// Dateimuster: nur Name (keine Pfadteile), Platzhalter * und ?
const PATTERN_RE = /^[^\\/:"<>|\0]+$/

export function isValidPattern(pattern: string): boolean {
  return typeof pattern === 'string' && pattern.trim().length > 0 && pattern.length <= 100 && PATTERN_RE.test(pattern.trim())
}

/** Dateimuster → regulärer Ausdruck, ohne Rücksicht auf Groß-/Kleinschreibung (wie unter Windows) */
export function patternToRegExp(pattern: string): RegExp {
  const source = pattern.trim().split('').map((char) => {
    if (char === '*') return '.*'
    if (char === '?') return '.'
    return char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${source}$`, 'i')
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const isInteger = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/**
 * Prüft die Einstellungen. Ohne `forRun` Format und Wertebereiche (Geheimnisse sind beim Speichern oft leer =
 * „unverändert“). Mit `forRun` zusätzlich, was eine Analyse braucht (EPLAN-Pfade, Passwort zum Benutzer des
 * Netzlaufwerks). Der Projektordner ist nur für Ordner-Projekte und den Zeitplan nötig (siehe schedulerIssues).
 */
export function validateSettings(s: PdsSettings, opts: { forRun?: boolean } = {}): SettingsIssue[] {
  const issues: SettingsIssue[] = []
  const add = (path: string, code: SettingsIssueCode) => issues.push({ path, code })

  for (const key of ['schedulerEnabled', 'recursive'] as const) {
    if (typeof s[key] !== 'boolean') add(key, 'invalid_value')
  }

  // Zeitplan
  if (!str(s.cronSchedule)) add('cronSchedule', 'required')
  else if (!isValidCron(s.cronSchedule)) add('cronSchedule', 'invalid_cron')
  if (!str(s.timezone)) add('timezone', 'required')
  else if (!isValidTimezone(s.timezone)) add('timezone', 'invalid_timezone')

  // Projektordner
  if (s.source !== 'local' && s.source !== 'network') add('source', 'invalid_value')
  if (!Array.isArray(s.filePatterns) || !s.filePatterns.length) add('filePatterns', 'required')
  else if (s.filePatterns.length > LIMITS.filePatterns.max || !s.filePatterns.every(isValidPattern)) add('filePatterns', 'invalid_pattern')

  // Netzlaufwerk
  if (s.source === 'network') {
    const d = s.networkDrive
    if (!str(d.networkPath)) add('networkDrive.networkPath', 'required')
    else if (!isValidUncPath(d.networkPath.trim())) add('networkDrive.networkPath', 'invalid_network_path')
    if (str(d.mapping) && !isValidDriveLetter(d.mapping)) add('networkDrive.mapping', 'invalid_drive_letter')
    // Anmeldedaten nur paarweise sinnvoll; ohne beide gilt das Konto des Dienstes
    if (!str(d.user) && d.password) add('networkDrive.user', 'required')
    if (opts.forRun && str(d.user) && !d.password) add('networkDrive.password', 'required')
  }

  // EPLAN
  if (!EPLAN_OPEN_MODES.includes(s.eplan.openMode)) add('eplan.openMode', 'invalid_value')
  if (typeof s.eplan.applicationModifier !== 'string') add('eplan.applicationModifier', 'invalid_value')
  if (opts.forRun) {
    if (!str(s.eplan.platformBin)) add('eplan.platformBin', 'required')
    if (!str(s.eplan.productBin)) add('eplan.productBin', 'required')
  }

  // Grenzen
  for (const key of ['analysisTimeoutMinutes', 'retentionDays', 'uploadMaxMb'] as const) {
    if (!isInteger(s[key], LIMITS[key].min, LIMITS[key].max)) add(key, 'out_of_range')
  }

  return issues
}

/** Was der Zeitplan zusätzlich braucht: einen Projektordner */
export function schedulerIssues(s: PdsSettings): SettingsIssue[] {
  return str(s.folder) ? [] : [{ path: 'folder', code: 'required' }]
}
