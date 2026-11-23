import { ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { toUiError } from '../api'
import type { UiError } from '../bindings/UiError'
import { texts } from '../texts'

/** Fehler eines Befehls als Hinweis oben rechts */
export function useErrorToast() {
  const toast = useToast()
  return (error: unknown) => {
    const { message } = toUiError(error)
    toast.add({ title: texts.errors.title, description: message, color: 'error', icon: 'siemens:circle-error' })
  }
}

/**
 * Ein Aufruf mit Ladezustand: `running` sperrt den Knopf, Fehler erscheinen als Hinweis.
 * Liefert `undefined`, wenn der Aufruf fehlschlug.
 */
export function useTask<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const running = ref(false)
  const error = ref<UiError | null>(null)
  const showError = useErrorToast()

  async function run(...args: A): Promise<R | undefined> {
    running.value = true
    error.value = null
    try {
      return await fn(...args)
    }
    catch (caught) {
      error.value = toUiError(caught)
      showError(caught)
      return undefined
    }
    finally {
      running.value = false
    }
  }

  return { running, error, run }
}
