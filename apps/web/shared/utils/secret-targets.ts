// Wohin ein gespeichertes Geheimnis geht – gemeinsam für Server (Speichern, MCP, Verbindungstest) und Formular
import type { SecretField } from '../types/api'

/** Die Felder, die bestimmen, wohin das Netzlaufwerk-Passwort geschickt wird */
export interface SecretTargets {
  networkDrive: { networkPath: string, user: string }
}

export interface SecretTargetChange {
  field: SecretField
  /** geänderte Zielfelder, z. B. `networkDrive.networkPath` */
  changed: string[]
}

/** UNC-Pfad ohne Unterschiede in Groß-/Kleinschreibung, Trennzeichen und abschließendem Backslash (wie Windows) */
export function normalizeUncPath(path: string): string {
  const parts = (path ?? '').trim().split(/[\\/]+/).filter(Boolean)
  return parts.length ? `\\\\${parts.join('\\').toLowerCase()}` : ''
}

/** Benutzernamen (E-Mail, DOMÄNE\name) unterscheiden Groß-/Kleinschreibung nicht */
const normalizeUser = (user: string) => (user ?? '').trim().toLowerCase()

/**
 * Geheimnisse, deren Ziel sich gegenüber dem gespeicherten Stand geändert hat. Ein gespeichertes Passwort darf nur
 * für sein bisheriges Ziel weiterverwendet werden – sonst ginge es etwa über MCP (Freigabe auf einen fremden Server)
 * samt Verbindungstest an jemand anderen. Netzlaufwerk: UNC-Pfad und Benutzer.
 */
export function secretTargetChanges(before: SecretTargets, after: SecretTargets): SecretTargetChange[] {
  const drive: string[] = []
  if (normalizeUncPath(before.networkDrive.networkPath) !== normalizeUncPath(after.networkDrive.networkPath)) drive.push('networkDrive.networkPath')
  if (normalizeUser(before.networkDrive.user) !== normalizeUser(after.networkDrive.user)) drive.push('networkDrive.user')
  return drive.length ? [{ field: 'networkDrive.password', changed: drive }] : []
}
