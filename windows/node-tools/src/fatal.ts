// Letztes Netz des gebündelten Werkzeugs: ein unerwarteter Fehler außerhalb von runCommand.
// Getrennt von main.ts, damit der Ablauf ohne echten Prozessabbruch testbar ist.
import { EXIT_INTERNAL } from './protocol'
import type { Scrubber } from './protocol'

export interface FatalIo {
  /** Schreibt auf stdout und ruft `done`, wenn die Zeile draußen ist */
  stdout: (text: string, done: () => void) => void
  stderr: (text: string) => void
  exit: (code: number) => void
}

export interface FatalOptions {
  scrubber: Scrubber
  /** Steht die Abschlusszeile schon auf stdout? Es soll genau eine geben. */
  hasResult: () => boolean
  io: FatalIo
}

/**
 * Meldet einen unerwarteten Fehler als bereinigten Text auf stderr (Rust zeigt dessen Ende an, ein
 * Stacktrace könnte Werte der Umgebung enthalten) und, falls noch keine da ist, als `result`-Zeile
 * `internal_error` auf stdout. Danach Exit 1. Läuft nur einmal.
 */
export function fatalHandler({ scrubber, hasResult, io }: FatalOptions): (error: unknown) => void {
  let handled = false
  return (error) => {
    if (handled) return
    handled = true
    const message = scrubber.text(`Unerwarteter Fehler: ${error instanceof Error ? error.message : String(error)}`)
    io.stderr(`${message}\n`)
    if (hasResult()) return io.exit(EXIT_INTERNAL)
    const line = scrubber.line({ type: 'result', ok: false, code: 'internal_error', message })
    io.stdout(`${line}\n`, () => io.exit(EXIT_INTERNAL))
  }
}
