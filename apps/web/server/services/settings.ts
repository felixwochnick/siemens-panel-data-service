import type { Kysely } from 'kysely'
import type { AppDatabase } from '../database/types'
import { defaultSettings, schedulerIssues, validateSettings } from '../lib/settings'
import { SECRET_FIELDS } from '../../shared/types/api'
import type { PdsSettings, SecretField, SecretInput, SecretState, SettingsInput, SettingsIssue, SettingsResponse, SettingsSaveResponse, SettingsView, Via } from '../../shared/types/api'
import { secretTargetChanges } from '../../shared/utils/secret-targets'
import type { SecretTargetChange } from '../../shared/utils/secret-targets'
import type { Actor } from './access'
import { requireAdmin } from './access'
import { writeAudit } from './audit'
import { ServiceError, issuesError } from './errors'
import { decryptSecret, encryptSecret } from './secrets'

export interface SettingsDeps {
  db: Kysely<AppDatabase>
  /** AES-256-Schlüssel für Geheimnisse (abgeleitet aus dem App-Geheimnis) */
  secretKey: Buffer
  /** nach jedem Speichern (Zeitplan neu einplanen) */
  onSettingsChanged?: () => Promise<void> | void
}

export interface LoadedSettings {
  /** Geheimnisse im Klartext; '' wenn nicht gesetzt oder nicht lesbar */
  settings: PdsSettings
  /** gesetzt, aber mit dem aktuellen Schlüssel nicht lesbar */
  unreadable: SecretField[]
  saved: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

// Nur ein Geheimnis: das Passwort des Netzlaufwerks
const getSecret = (s: PdsSettings, _field: SecretField) => s.networkDrive.password
function setSecret(s: PdsSettings, _field: SecretField, value: string): void {
  s.networkDrive.password = value
}

/**
 * Gespeichertes JSON auf die bekannten Schlüssel abbilden: fehlende oder falsch typisierte Werte nehmen den Standard.
 * So übersteht die Zeile neue Felder in späteren Versionen und fremde Schlüssel landen nirgends. Listen (Dateimuster)
 * nur als Liste von Texten.
 */
export function normalizeSettings(stored: unknown, defaults: PdsSettings = defaultSettings): PdsSettings {
  const merge = (base: Record<string, unknown>, value: unknown): Record<string, unknown> => {
    const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    return Object.fromEntries(Object.entries(base).map(([key, fallback]) => {
      const candidate = Object.hasOwn(source, key) ? source[key] : undefined
      if (Array.isArray(fallback)) {
        return [key, Array.isArray(candidate) && candidate.every(item => typeof item === 'string') ? [...candidate] : [...fallback]]
      }
      if (fallback !== null && typeof fallback === 'object') return [key, merge(fallback as Record<string, unknown>, candidate)]
      if (typeof candidate === typeof fallback && !(typeof candidate === 'number' && !Number.isFinite(candidate))) return [key, candidate]
      return [key, fallback]
    }))
  }
  return merge(structuredClone(defaults) as unknown as Record<string, unknown>, stored) as unknown as PdsSettings
}

/** Gespeicherte Zeile: Geheimnisse verschlüsselt (`enc:v1:…`) oder '' */
async function readRow(db: Kysely<AppDatabase>) {
  const row = await db.selectFrom('pds.settings as s')
    .leftJoin('core.users as u', 'u.id', 's.updatedBy')
    .select(['s.data', 's.updatedAt', 'u.displayName as updatedBy'])
    .where('s.id', '=', 1)
    .executeTakeFirst()
  if (!row) return { stored: structuredClone(defaultSettings), saved: false, updatedAt: null, updatedBy: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.data)
  }
  catch {
    parsed = {}
  }
  return { stored: normalizeSettings(parsed), saved: true, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}

/** Geheimnisse einer gespeicherten Zeile entschlüsseln */
function decryptStored(deps: Pick<SettingsDeps, 'secretKey'>, stored: PdsSettings) {
  const settings = structuredClone(stored)
  const unreadable: SecretField[] = []
  for (const field of SECRET_FIELDS) {
    const value = getSecret(stored, field)
    if (!value) continue
    const plain = decryptSecret(deps.secretKey, value)
    if (plain === undefined) unreadable.push(field)
    setSecret(settings, field, plain ?? '')
  }
  return { settings, unreadable }
}

/** Einstellungen mit entschlüsselten Geheimnissen – nur für Analyse, Zeitplaner und Verbindungstest, nie nach außen */
export async function loadSettings(deps: Pick<SettingsDeps, 'db' | 'secretKey'>): Promise<LoadedSettings> {
  const { stored, saved, updatedAt, updatedBy } = await readRow(deps.db)
  return { ...decryptStored(deps, stored), saved, updatedAt, updatedBy }
}

/** Geheimnisse durch `{ set, readable }` ersetzen */
export function maskSettings(settings: PdsSettings, unreadable: readonly SecretField[] = []): SettingsView {
  const state = (field: SecretField): SecretState => ({
    set: !!getSecret(settings, field) || unreadable.includes(field),
    readable: !unreadable.includes(field),
  })
  return { ...structuredClone(settings), networkDrive: { ...settings.networkDrive, password: state('networkDrive.password') } }
}

/** Was für eine Analyse noch fehlt, inklusive nicht lesbarer Geheimnisse */
export function runIssues(loaded: Pick<LoadedSettings, 'settings' | 'unreadable'>): SettingsIssue[] {
  // Ein nicht lesbares Geheimnis ist gesetzt, nur nicht entschlüsselbar: eigener Code statt „fehlt“
  const issues = validateSettings(loaded.settings, { forRun: true })
    .filter(issue => !loaded.unreadable.includes(issue.path as SecretField))
  for (const path of loaded.unreadable) issues.push({ path, code: 'secret_unreadable' })
  return issues
}

/** Hinweise für Übersicht und Formular: was Analysen fehlt, mit Zeitplan zusätzlich der Projektordner */
export function settingsIssues(loaded: Pick<LoadedSettings, 'settings' | 'unreadable'>): SettingsIssue[] {
  return [...runIssues(loaded), ...(loaded.settings.schedulerEnabled ? schedulerIssues(loaded.settings) : [])]
}

/** Einstellungen mit Geheimnissen nur als `{ set, readable }` (Oberfläche und MCP, nur Admins) */
export async function getSettings(deps: SettingsDeps, actor: Actor): Promise<SettingsResponse> {
  requireAdmin(actor)
  const loaded = await loadSettings(deps)
  return {
    settings: maskSettings(loaded.settings, loaded.unreadable),
    issues: settingsIssues(loaded),
    saved: loaded.saved,
    updatedAt: loaded.updatedAt?.toISOString() ?? null,
    updatedBy: loaded.updatedBy,
  }
}

/** Alle Blätter als `pfad → Wert` (für die Liste geänderter Felder im Änderungsprotokoll); Listen als JSON */
function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>()
  if (Array.isArray(value)) {
    result.set(prefix, JSON.stringify(value))
  }
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, leaf] of flatten(child, prefix ? `${prefix}.${key}` : key)) result.set(path, leaf)
    }
  }
  else {
    result.set(prefix, value)
  }
  return result
}

/** Klartext eines Geheimnisses nach der Eingabe; undefined = unverändert */
function resolveSecretInput(input: SecretInput | undefined): string | undefined {
  if (input === undefined || input === '') return undefined
  if (input === null) return ''
  return input
}

/** Eingabe ohne Geheimnisse, auf bekannte Schlüssel normalisiert */
function withoutSecrets(input: SettingsInput): PdsSettings {
  const { networkDrive, ...rest } = input
  return normalizeSettings({ ...rest, networkDrive: { ...networkDrive, password: '' } })
}

/** 400 `secret_required`: `issues` markiert das Feld im Formular, `details` erklärt es dem Modell (MCP) */
function secretRequired(changes: SecretTargetChange[], via: Via): ServiceError {
  const reason = changes.map(change => `${change.field} must be entered again because ${change.changed.join(', ')} changed`).join('; ')
  return new ServiceError(400, 'secret_required', {
    issues: changes.map(change => ({ path: change.field, code: 'secret_required' })),
    fields: changes.map(change => change.field),
    details: via === 'mcp'
      ? `${reason}. Passwords cannot be set via MCP: ask an administrator to make this change in the web app (Settings) and enter the password there.`
      : reason,
  })
}

/**
 * Geheimnisse einer Eingabe auflösen – die eine Stelle für Speichern, MCP (patchSettings) und Verbindungstest.
 * Ergebnis je Feld: neuer Klartext ('' = entfernen) oder undefined = gespeicherten Wert weiterverwenden. Weiterverwenden
 * nur, solange das Ziel des Geheimnisses gleich bleibt (secretTargetChanges): Sonst ginge ein gespeichertes Passwort an
 * eine andere Freigabe oder einen anderen Benutzer – ohne dass es jemand neu eingegeben hat.
 */
function resolveSecrets(stored: PdsSettings, next: PdsSettings, input: SettingsInput, via: Via): Record<SecretField, string | undefined> {
  const values: Record<SecretField, string | undefined> = { 'networkDrive.password': resolveSecretInput(input.networkDrive.password) }
  // Nur Felder, bei denen wirklich ein gespeicherter Wert (auch ein nicht lesbarer) weiterverwendet würde
  const blocked = secretTargetChanges(stored, next).filter(change => values[change.field] === undefined && getSecret(stored, change.field))
  if (blocked.length) throw secretRequired(blocked, via)
  return values
}

/**
 * Einstellungen aus einer (noch nicht gespeicherten) Eingabe mit Klartext-Geheimnissen – für den Verbindungstest.
 * Geheimnisse ohne Eingabe kommen aus der Datenbank, aber nur für ihr bisheriges Ziel (sonst 400 `secret_required`).
 */
export async function settingsFromInput(deps: Pick<SettingsDeps, 'db' | 'secretKey'>, input: SettingsInput): Promise<PdsSettings> {
  const current = await readRow(deps.db)
  const currentPlain = decryptStored(deps, current.stored)
  const plain = withoutSecrets(input)
  const secrets = resolveSecrets(current.stored, plain, input, 'ui')
  for (const field of SECRET_FIELDS) setSecret(plain, field, secrets[field] ?? getSecret(currentPlain.settings, field))
  return plain
}

/**
 * Einstellungen prüfen und speichern. Netzlaufwerk-Passwort: leer = unverändert (nur bei gleicher Freigabe und gleichem
 * Benutzer, sonst 400 `secret_required`), null = entfernen, Text = Wert (verschlüsselt). Fachliche Prüfung über
 * validateSettings (ohne forRun: Unvollständiges darf gespeichert werden; Zeitplan und Analysen prüfen es selbst).
 * Liefert die neue Ansicht und die geänderten Felder (Geheimnisse nur als Name).
 */
export async function saveSettings(deps: SettingsDeps, actor: Actor, input: SettingsInput, via: Via = 'ui'): Promise<SettingsSaveResponse> {
  requireAdmin(actor)
  const current = await readRow(deps.db)
  const currentPlain = decryptStored(deps, current.stored)

  const next = withoutSecrets(input)
  const secrets = resolveSecrets(current.stored, next, input, via)
  const plain = structuredClone(next)
  const stored = structuredClone(next)
  const changedSecrets: SecretField[] = []
  for (const field of SECRET_FIELDS) {
    const value = secrets[field]
    if (value === undefined) {
      // unverändert: verschlüsselten Wert übernehmen (auch einen nicht lesbaren – er wird erst ersetzt, wenn jemand ihn neu eingibt)
      setSecret(stored, field, getSecret(current.stored, field))
      setSecret(plain, field, getSecret(currentPlain.settings, field))
    }
    else {
      if (value !== getSecret(currentPlain.settings, field) || currentPlain.unreadable.includes(field)) changedSecrets.push(field)
      setSecret(stored, field, value ? encryptSecret(deps.secretKey, value) : '')
      setSecret(plain, field, value)
    }
  }

  const issues = validateSettings(plain)
  if (issues.length) throw issuesError('invalid_settings', issues)
  // Zeitplan einschalten nur mit vollständigen, lesbaren Einstellungen (wie setSchedulerEnabled)
  if (plain.schedulerEnabled && !(current.saved && current.stored.schedulerEnabled)) {
    const unreadable = currentPlain.unreadable.filter(field => !changedSecrets.includes(field))
    const missing = [...runIssues({ settings: plain, unreadable }), ...schedulerIssues(plain)]
    if (missing.length) throw issuesError('settings_incomplete', missing)
  }

  const masked = (s: PdsSettings) => ({ ...s, networkDrive: { ...s.networkDrive, password: null } })
  const before = flatten(masked(current.stored))
  const after = flatten(masked(stored))
  const changed = [...after.keys()].filter(path => !SECRET_FIELDS.includes(path as SecretField) && before.get(path) !== after.get(path))
  changed.push(...changedSecrets)

  if (changed.length || !current.saved) {
    await writeRow(deps.db, stored, actor.id)
    await writeAudit(deps.db, actor.id, 'settings_updated', { changed, via })
    await deps.onSettingsChanged?.()
  }
  return { ...await getSettings(deps, actor), changed }
}

async function writeRow(db: Kysely<AppDatabase>, stored: PdsSettings, userId: string | null) {
  const data = JSON.stringify(stored)
  const updatedAt = new Date()
  const result = await db.updateTable('pds.settings')
    .set({ data, updatedAt, updatedBy: userId })
    .where('id', '=', 1)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows) > 0) return
  try {
    await db.insertInto('pds.settings').values({ id: 1, data, updatedAt, updatedBy: userId }).execute()
  }
  catch {
    // Gleichzeitig angelegt: dann eben aktualisieren
    await db.updateTable('pds.settings').set({ data, updatedAt, updatedBy: userId }).where('id', '=', 1).execute()
  }
}

/** Nicht-geheime Einstellungen, die MCP ändern darf (Teilmenge, verschachtelt) */
export type SettingsPatch = {
  [K in keyof Omit<PdsSettings, 'networkDrive' | 'eplan'>]?: PdsSettings[K]
} & {
  networkDrive?: Partial<Omit<PdsSettings['networkDrive'], 'password'>>
  eplan?: Partial<PdsSettings['eplan']>
}

/**
 * Teiländerung ohne Geheimnisse (MCP): fehlende Felder bleiben, das Passwort ist nicht änderbar. Ändert die Änderung
 * das Ziel eines gespeicherten Passworts, scheitert sie mit `secret_required` (das geht nur in der Oberfläche).
 */
export async function patchSettings(deps: SettingsDeps, actor: Actor, patch: SettingsPatch, via: Via = 'mcp'): Promise<SettingsSaveResponse> {
  requireAdmin(actor)
  const { settings } = await loadSettings(deps)
  const { networkDrive, eplan, ...rest } = patch
  const input: SettingsInput = {
    ...settings,
    ...rest,
    networkDrive: { ...settings.networkDrive, ...networkDrive, password: undefined },
    eplan: { ...settings.eplan, ...eplan },
  }
  return saveSettings(deps, actor, input, via)
}

/** Zeitplan an/aus. Einschalten nur mit vollständigen, lesbaren Einstellungen und einem Projektordner. */
export async function setSchedulerEnabled(deps: SettingsDeps, actor: Actor, enabled: boolean, via: Via = 'ui'): Promise<SettingsResponse> {
  requireAdmin(actor)
  const loaded = await loadSettings(deps)
  if (enabled) {
    const issues = [...runIssues(loaded), ...schedulerIssues(loaded.settings)]
    if (issues.length) throw issuesError('settings_incomplete', issues)
  }
  if (loaded.settings.schedulerEnabled !== enabled || !loaded.saved) {
    const { stored } = await readRow(deps.db)
    await writeRow(deps.db, { ...stored, schedulerEnabled: enabled }, actor.id)
    await writeAudit(deps.db, actor.id, 'scheduler_toggled', { enabled, via })
    await deps.onSettingsChanged?.()
  }
  return getSettings(deps, actor)
}
