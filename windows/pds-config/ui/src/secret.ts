// Zustand eines Secret-Feldes. Im Entwurf steht "***" (gesetzt, unverändert), "" (leer bzw. entfernen) oder ein
// neuer Klartext. Was die Person tippt, hält das Feld getrennt davon, damit auch ein Passwort, das mit "***"
// beginnt, eingegeben werden kann (nur genau "***" bedeutet für den Dienst „unverändert“).

/** Gespeicherter Wert vor dem Bearbeiten: "***" = gesetzt, "" = leer */
export type SecretOriginal = string

export interface SecretField {
  /** Eingetippter Text; leer heißt „unverändert“ */
  text: string
  /** „Entfernen“ gewählt (nur sinnvoll, wenn ein Wert gesetzt ist) */
  removed: boolean
}

export type SecretMode = 'set' | 'removed' | 'empty' | 'new'

/** Wert für den Entwurf */
export function secretValue(original: SecretOriginal, field: SecretField): string {
  if (field.text !== '') return field.text
  return field.removed ? '' : original
}

export function secretMode(original: SecretOriginal, field: SecretField): SecretMode {
  if (field.text !== '') return 'new'
  if (field.removed && original !== '') return 'removed'
  return original === '' ? 'empty' : 'set'
}

/** Eingabe: leer lassen stellt den gespeicherten Wert wieder her, auch nach „Entfernen“ */
export function typed(text: string): SecretField {
  return { text, removed: false }
}

export function removed(): SecretField {
  return { text: '', removed: true }
}

export function unchanged(): SecretField {
  return { text: '', removed: false }
}

/** Feldzustand aus einem Entwurfswert, der von außen kam (Laden, Verwerfen) */
export function fromValue(original: SecretOriginal, value: string): SecretField {
  if (value === original) return unchanged()
  if (value === '') return removed()
  return typed(value)
}
