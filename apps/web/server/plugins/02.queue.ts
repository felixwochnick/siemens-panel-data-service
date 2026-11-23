import type { AppContext } from '../services/context'
import { retryUntilDone } from '../services/startup'

/*
 * Warteschlange und Worker-Verbindung: nach der Migration hängengebliebene Analysen (`running` aus einem früheren
 * Prozess) als abgebrochen markieren, Worker verbinden, Aufträge abarbeiten. Ist die Datenbank beim Hochfahren (noch)
 * nicht erreichbar, so lange wiederholen (2 s … 60 s), bis es klappt. Beim Beenden: laufende Analyse abbrechen, kurz
 * auf sie warten, dann die Verbindung zum Worker schließen.
 */
export default defineNitroPlugin((nitroApp) => {
  let ctx: AppContext | undefined
  const stop = new AbortController()

  // Erst im nächsten Tick: alle Plugins haben dann ihre Migrationen registriert
  const ready = new Promise<void>(resolve => setTimeout(resolve, 0))
    .then(() => retryUntilDone(async () => {
      await ensureDatabaseReady()
      ctx = await useAppContext()
      const stale = await ctx.queue.abortStale()
      if (stale) console.info(`[queue] ${stale} unterbrochene Analysen als abgebrochen markiert`)
      if (stop.signal.aborted) return
      ctx.worker.start()
      ctx.queue.start()
    }, {
      signal: stop.signal,
      onError: (error, delayMs) => console.error(`[queue] Start fehlgeschlagen, neuer Versuch in ${Math.round(delayMs / 1000)} s`, error),
    }))

  nitroApp.hooks.hook('close', async () => {
    stop.abort()
    await ready
    await ctx?.queue.stop()
    await ctx?.worker.stop()
  })
})
