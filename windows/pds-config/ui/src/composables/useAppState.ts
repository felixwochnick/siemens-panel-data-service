import { computed, ref } from 'vue'
import { api, toUiError } from '../api'
import type { CertInfo } from '../bindings/CertInfo'
import type { SaveDraftOutcome } from '../bindings/SaveDraftOutcome'
import type { ServiceAction } from '../bindings/ServiceAction'
import type { StatusReport } from '../bindings/StatusReport'
import type { UiError } from '../bindings/UiError'
import { secondsSince } from '../format'
import { useDraft } from './useDraft'
import { useErrorToast } from './useTask'

/** Abstand der Statusabfrage; der Dienst schreibt seinen Heartbeat alle paar Sekunden */
const STATUS_POLL_MS = 5_000

function createAppState() {
  const draft = useDraft()
  const showError = useErrorToast()

  const loading = ref(true)
  const loadError = ref<UiError | null>(null)
  const certificate = ref<CertInfo | null>(null)
  const status = ref<StatusReport | null>(null)
  // SQLite-Datei bei leerem `db.path`; kommt vom Dienst, weil der Datenordner dort festliegt
  const defaultDbPath = ref('')
  const saving = ref(false)
  const outcome = ref<SaveDraftOutcome | null>(null)
  const now = ref(Date.now())
  let poller: ReturnType<typeof setInterval> | undefined

  // Nur mit Änderungen, ohne Fehlerbefunde und mit abgeschlossener Prüfung (Knopf und Strg+S)
  const canSave = computed(() =>
    draft.dirtyCount.value > 0 && draft.errorCount.value === 0 && !draft.validating.value && !saving.value)

  const staleSeconds = computed(() => {
    const report = status.value
    if (!report?.stale || !report.status) return null
    return secondsSince(report.status.heartbeat, now.value)
  })

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      const state = await api.loadState()
      draft.load(state.config, state.findings)
      certificate.value = state.certificate
      status.value = state.status
      defaultDbPath.value = state.defaultDbPath
    }
    catch (error) {
      loadError.value = toUiError(error)
    }
    finally {
      loading.value = false
    }
  }

  async function refreshStatus() {
    try {
      status.value = await api.getStatus()
      now.value = Date.now()
    }
    catch {
      // Beim nächsten Durchlauf erneut; ein Hinweis alle 5 s wäre nur Lärm
    }
  }

  function startPolling() {
    clearInterval(poller)
    poller = setInterval(refreshStatus, STATUS_POLL_MS)
  }

  async function serviceControl(action: ServiceAction) {
    status.value = await api.serviceControl(action)
    now.value = Date.now()
  }

  async function save() {
    if (!canSave.value) return
    saving.value = true
    outcome.value = null
    try {
      const result = await api.saveDraft(draft.draft.value)
      outcome.value = result
      if (result.saved) {
        // Neu laden: Secrets kommen wieder maskiert, der Entwurf ist danach unverändert
        const state = await api.loadState()
        draft.load(state.config, state.findings)
        certificate.value = state.certificate
        status.value = state.status
        defaultDbPath.value = state.defaultDbPath
      }
      else {
        draft.setFindings(result.findings)
      }
    }
    catch (error) {
      showError(error)
    }
    finally {
      saving.value = false
    }
  }

  return {
    loading,
    loadError,
    certificate,
    status,
    defaultDbPath,
    staleSeconds,
    saving,
    canSave,
    outcome,
    load,
    refreshStatus,
    startPolling,
    serviceControl,
    save,
  }
}

let shared: ReturnType<typeof createAppState> | undefined

/** Gemeinsamer Zustand der Oberfläche: geladene Daten, Status, Speichern */
export function useAppState() {
  shared ??= createAppState()
  return shared
}
