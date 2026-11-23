// Einstieg von pds-tools.mjs: `node --use-system-ca pds-tools.mjs <befehl>`. Eingaben nur über die Umgebung,
// Ausgabe als JSON-Zeilen auf stdout (siehe protocol.ts).
import { dbScript, dbSetup, dbTest } from './db'
import { oidcTest } from './oidc'
import { dbBackup } from './sqlite'
import { EXIT_FAILED, EXIT_INTERNAL, EXIT_OK, Reporter, Scrubber, ToolFailure, UsageError, collectSecrets } from './protocol'
import type { Outcome } from './protocol'
import { errorMessage } from './network'

type Command = (env: NodeJS.ProcessEnv, report: Reporter) => Promise<Outcome>

const COMMANDS: Record<string, Command> = {
  'db-test': dbTest,
  'db-setup': dbSetup,
  'db-script': dbScript,
  'db-backup': dbBackup,
  'oidc-test': oidcTest,
}

/**
 * Führt einen Befehl aus und schreibt die Zeilen über `write`. Jede Zeile ist ein JSON-Objekt, aus dem
 * Geheimnisse der Umgebung entfernt sind. Wirft nie; gibt den Exit-Code zurück.
 */
export async function runCommand(argv: string[], env: NodeJS.ProcessEnv, write: (line: string) => void): Promise<number> {
  const scrubber = new Scrubber(collectSecrets(env))
  const report = new Reporter(line => write(scrubber.line(line)))
  const name = argv[0]
  try {
    const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
    if (!command) throw new UsageError(`Unbekannter Befehl${name ? ` „${name}“` : ''}. Erlaubt: ${Object.keys(COMMANDS).join(', ')}`)
    const outcome = await command(env, report)
    report.result(true, 'ok', outcome.message, outcome.details)
    return EXIT_OK
  }
  catch (error) {
    if (error instanceof ToolFailure) {
      report.result(false, error.code, error.message, error.details)
      return error.code === 'internal_error' ? EXIT_INTERNAL : EXIT_FAILED
    }
    // Bedienfehler und alles Unerwartete: Exit 1 mit knapper Meldung, ohne Stack (der kann Werte enthalten)
    const message = error instanceof UsageError ? error.message : `Unerwarteter Fehler: ${errorMessage(error)}`
    report.result(false, 'internal_error', message)
    return EXIT_INTERNAL
  }
}
