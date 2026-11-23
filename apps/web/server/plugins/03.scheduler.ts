import type { AppContext } from '../services/context'
import { retryUntilDone } from '../services/startup'

/*
 * Zeitplaner: nach der Migration nach den Einstellungen planen (nach der Installation ist der Zeitplan aus). Ist die
 * Datenbank beim Hochfahren nicht erreichbar, so lange wiederholen, bis es klappt – sonst bliebe der Zeitplan bis zum
 * nächsten Neustart aus. Beim Beenden keine Termine mehr.
 */
export default defineNitroPlugin((nitroApp) => {
  let ctx: AppContext | undefined
  const stop = new AbortController()

  const ready = new Promise<void>(resolve => setTimeout(resolve, 0))
    .then(() => retryUntilDone(async () => {
      await ensureDatabaseReady()
      ctx = await useAppContext()
      if (!stop.signal.aborted) await ctx.scheduler.load()
    }, {
      signal: stop.signal,
      onError: (error, delayMs) => console.error(`[scheduler] Start fehlgeschlagen, neuer Versuch in ${Math.round(delayMs / 1000)} s`, error),
    }))

  nitroApp.hooks.hook('close', async () => {
    stop.abort()
    await ready
    ctx?.scheduler.stop()
  })
})
