import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { api, toUiError } from '../api'
import { defaultConfig } from '../api/defaults'
import type { Config } from '../bindings/Config'
import type { Finding } from '../bindings/Finding'
import type { UiError } from '../bindings/UiError'

/** Wartezeit nach der letzten Eingabe, bevor der Entwurf geprüft wird */
export const VALIDATE_DEBOUNCE_MS = 300

export interface DraftOptions {
  validate: (draft: Config) => Promise<Finding[]>
  debounceMs?: number
}

export interface Draft {
  /** Bearbeiteter Stand; Secrets als "***" (unverändert), "" (leer/entfernen) oder neuer Klartext */
  draft: Ref<Config>
  /** Zuletzt geladener Stand */
  original: Ref<Config>
  /** Befunde zum aktuellen Entwurf (bzw. zum zuletzt geprüften Stand) */
  findings: Ref<Finding[]>
  validating: Ref<boolean>
  /** Die Prüfung selbst schlug fehl (nicht: Befunde); Speichern prüft ohnehin erneut */
  validationError: Ref<UiError | null>
  dirtyCount: ComputedRef<number>
  errorCount: ComputedRef<number>
  warningCount: ComputedRef<number>
  load: (config: Config, findings: Finding[]) => void
  setFindings: (findings: Finding[]) => void
  findingsFor: (path: string) => Finding[]
  isDirty: (path: string) => boolean
  /**
   * Ein Secret wurde außerhalb des Entwurfs gespeichert (App-Secret neu erzeugt, DB-Passwort von der
   * Einrichtung): Es gilt ab jetzt als gesetzt. War es leer und im Entwurf unverändert, wird es dort "***".
   */
  markSecretSet: (path: SecretPath) => void
  reset: () => void
  revalidate: () => void
}

export type SecretPath = 'db.password' | 'oidc.client_secret' | 'app.secret' | 'tls.acme_eab_hmac'

function clone(config: Config): Config {
  // Config ist reines JSON; structuredClone scheitert an Vue-Proxys
  return JSON.parse(JSON.stringify(config)) as Config
}

/** Abschnitt und Schlüssel eines Secret-Feldes zum Lesen und Schreiben */
function secretSlot(config: Config, path: SecretPath): { values: Record<string, string>, key: string } {
  const [section, key] = path.split('.') as [keyof Config, string]
  return { values: config[section] as unknown as Record<string, string>, key }
}

function serialize(config: Config): string {
  return JSON.stringify(config)
}

/** Blätter als Feldpfade wie in `config set` (`db.port`) */
function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  else {
    out[prefix] = value
  }
  return out
}

export function createDraft(options: DraftOptions): Draft {
  const debounceMs = options.debounceMs ?? VALIDATE_DEBOUNCE_MS
  const original = ref<Config>(defaultConfig())
  const draft = ref<Config>(defaultConfig())
  const findings = ref<Finding[]>([])
  const validating = ref(false)
  const validationError = ref<UiError | null>(null)

  // Befunde zum Original, damit „Verwerfen“ ohne erneute Prüfung zurückkehrt; null = veraltet
  let originalFindings: Finding[] | null = []
  // Stand des Entwurfs, zu dem `findings` gehören; gleicher Stand ⇒ keine Prüfung nötig
  let checked = serialize(draft.value)
  let timer: ReturnType<typeof setTimeout> | undefined
  // Nur die Antwort der jüngsten Prüfung zählt
  let sequence = 0

  const dirtyPaths = computed(() => {
    const before = flatten(original.value)
    const after = flatten(draft.value)
    return Object.keys(after).filter(path => after[path] !== before[path])
  })

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    sequence++
    validating.value = false
  }

  function load(config: Config, initialFindings: Finding[]) {
    cancel()
    original.value = clone(config)
    draft.value = clone(config)
    originalFindings = initialFindings
    findings.value = initialFindings
    checked = serialize(config)
  }

  function reset() {
    cancel()
    draft.value = clone(original.value)
    if (originalFindings) {
      findings.value = originalFindings
      checked = serialize(original.value)
    }
    else {
      revalidate()
    }
  }

  function markSecretSet(path: SecretPath) {
    const before = secretSlot(original.value, path)
    const wasEmpty = before.values[before.key] === ''
    before.values[before.key] = '***'
    const current = secretSlot(draft.value, path)
    if (wasEmpty && current.values[current.key] === '') current.values[current.key] = '***'
    // Befunde zum Original (z. B. app_secret_missing) gelten nicht mehr
    originalFindings = null
    revalidate()
  }

  async function run() {
    timer = undefined
    const id = ++sequence
    const snapshot = clone(draft.value)
    try {
      const result = await options.validate(snapshot)
      if (id !== sequence) return
      findings.value = result
      validationError.value = null
      checked = serialize(snapshot)
    }
    catch (error) {
      if (id === sequence) validationError.value = toUiError(error)
    }
    finally {
      if (id === sequence && timer === undefined) validating.value = false
    }
  }

  function revalidate() {
    clearTimeout(timer)
    validating.value = true
    timer = setTimeout(run, debounceMs)
  }

  watch(() => serialize(draft.value), (text) => {
    if (text !== checked) revalidate()
  })

  return {
    draft,
    original,
    findings,
    validating,
    validationError,
    dirtyCount: computed(() => dirtyPaths.value.length),
    errorCount: computed(() => findings.value.filter(f => f.severity === 'error').length),
    warningCount: computed(() => findings.value.filter(f => f.severity === 'warning').length),
    load,
    setFindings(next) {
      findings.value = next
      checked = serialize(draft.value)
    },
    findingsFor: path => findings.value.filter(f => f.field === path),
    isDirty: path => dirtyPaths.value.includes(path),
    markSecretSet,
    reset,
    revalidate,
  }
}

let shared: Draft | undefined

/** Der gemeinsame Entwurf aller Bereiche, geprüft über `validate_draft` */
export function useDraft(): Draft {
  shared ??= createDraft({ validate: draft => api.validateDraft(draft) })
  return shared
}
