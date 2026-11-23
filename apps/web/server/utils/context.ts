import { resolve } from 'node:path'
import { deriveSecret } from 'nuxt/server'
import { createAppContext } from '../services/context'
import type { AppContext } from '../services/context'
import { SETTINGS_KEY_PURPOSE, keyFromHex } from '../services/secrets'
import { parseWorkerSpec } from '../services/worker-client'

let context: Promise<AppContext> | undefined

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * Kontext der Services für diesen Prozess: Datenbank, Schlüssel der Einstellungen (aus NUXT_APP_SECRET), Datenordner
 * (NUXT_PDS_DATA_DIR, Standard ./.data), Protokollordner, Worker (NUXT_EPLAN_WORKER), Warteschlange und Zeitplaner.
 * Einmal erzeugt; schlägt das Ableiten fehl, beim nächsten Aufruf erneut.
 */
export function useAppContext(): Promise<AppContext> {
  context ??= (async () => {
    const secretKey = keyFromHex(await deriveSecret(SETTINGS_KEY_PURPOSE))
    const { logDir, pdsDataDir, eplanWorker } = useRuntimeConfig()
    return createAppContext({
      db: useAppDb(),
      secretKey,
      dataDir: resolve(text(pdsDataDir) || '.data'),
      logDir: text(logDir),
      workerSpec: parseWorkerSpec(text(eplanWorker)),
    })
  })().catch((error) => {
    context = undefined
    throw error
  })
  return context
}
