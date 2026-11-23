import { runRetention } from '../services/retention'

const FIRST_RUN_MS = 5 * 60_000
const INTERVAL_MS = 24 * 60 * 60_000

/*
 * Aufbewahrung täglich (zusätzlich zu Beginn jedes Zeitplan-Laufs): alte Analysen außer dem aktuellen Stand,
 * nicht mehr gebrauchte hochgeladene Dateien und verwaiste Arbeitsordner löschen. Erster Lauf einige Minuten nach dem
 * Start, damit der Start selbst schnell bleibt.
 */
export default defineNitroPlugin((nitroApp) => {
  const run = async () => {
    try {
      await ensureDatabaseReady()
      await runRetention(await useAppContext())
    }
    catch (error) {
      console.error('[retention] fehlgeschlagen', error)
    }
  }
  let interval: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    void run()
    interval = setInterval(() => void run(), INTERVAL_MS)
  }, FIRST_RUN_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(first)
    clearInterval(interval)
  })
})
