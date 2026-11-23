/**
 * Führt eine API-Aktion aus und meldet Erfolg/Fehler als Toast.
 * Liefert das Ergebnis oder undefined bei Fehlern (der Fehler ist dann schon gemeldet).
 */
export function useApiAction() {
  const toast = useToast()
  const { errorText } = useLabels()
  const pending = ref(false)

  async function run<T>(action: () => Promise<T>, options: { success?: string | ((result: T) => string) } = {}): Promise<T | undefined> {
    pending.value = true
    try {
      const result = await action()
      const success = typeof options.success === 'function' ? options.success(result) : options.success
      if (success) toast.add({ title: success, color: 'success', icon: 'siemens:circle-checkmark' })
      return result
    }
    catch (error) {
      toast.add({ title: errorText(error), color: 'error', icon: 'siemens:circle-error' })
      return undefined
    }
    finally {
      pending.value = false
    }
  }

  return { run, pending }
}

/** Einstellungsprobleme aus einer Fehlerantwort (invalid_settings, settings_incomplete) */
export function issuesOf(error: unknown): { path: string, code: string }[] {
  const issues = (error as { data?: { data?: { issues?: unknown } } } | null)?.data?.data?.issues
  return Array.isArray(issues) ? issues.filter((i): i is { path: string, code: string } => typeof i?.path === 'string' && typeof i?.code === 'string') : []
}
