export interface RetryOptions {
  /** beendet das Warten und weitere Versuche (Server fährt herunter) */
  signal: AbortSignal
  /** Wartezeit nach dem ersten Fehlschlag (Standard 2 s), verdoppelt sich je Fehlschlag */
  initialDelayMs?: number
  /** Obergrenze der Wartezeit (Standard 60 s) */
  maxDelayMs?: number
  /** nach jedem Fehlschlag, mit der Wartezeit bis zum nächsten Versuch */
  onError?: (error: unknown, delayMs: number, attempt: number) => void
  /** austauschbar für Tests; muss bei Abbruch sofort zurückkehren */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Wartet `ms` oder bis zum Abbruch (ohne Fehler) */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Führt `task` aus, bis sie gelingt – beim Hochfahren ist die Datenbank nicht immer schon da (SQL Server startet nach
 * dem Dienst, Netzwerk noch nicht bereit). Zwischen den Versuchen 2 s, 4 s, … höchstens 60 s, ohne Ende; nur der
 * Abbruch (Beenden des Servers) hört auf. Liefert true bei Erfolg, false nach Abbruch.
 */
export async function retryUntilDone(task: () => Promise<void>, options: RetryOptions): Promise<boolean> {
  const { signal } = options
  const sleep = options.sleep ?? abortableSleep
  const maxDelayMs = options.maxDelayMs ?? 60_000
  let delayMs = options.initialDelayMs ?? 2000
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) return false
    try {
      await task()
      return true
    }
    catch (error) {
      if (signal.aborted) return false
      const wait = Math.min(delayMs, maxDelayMs)
      options.onError?.(error, wait, attempt)
      await sleep(wait, signal)
      delayMs = Math.min(delayMs * 2, maxDelayMs)
    }
  }
}
