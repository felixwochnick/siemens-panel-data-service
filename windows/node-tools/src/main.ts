// Einstieg des gebündelten pds-tools.mjs (esbuild, siehe build.mjs). Getrennt von tools.ts, damit die
// Tests runCommand importieren können, ohne dass ein Befehl läuft.
import { fatalHandler } from './fatal'
import { Scrubber, collectSecrets } from './protocol'
import { runCommand } from './tools'

const scrubber = new Scrubber(collectSecrets(process.env))
let resultWritten = false

const fatal = fatalHandler({
  scrubber,
  hasResult: () => resultWritten,
  io: {
    stdout: (text, done) => process.stdout.write(text, done),
    stderr: text => process.stderr.write(text),
    exit: code => process.exit(code),
  },
})
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

const exitCode = await runCommand(process.argv.slice(2), process.env, (line) => {
  // Jede Zeile ist ein JSON-Objekt, dessen erster Schlüssel `type` ist (Reporter); die Abschlusszeile merken,
  // damit der Fehlerpfad keine zweite schreibt
  if (line.startsWith('{"type":"result"')) resultWritten = true
  process.stdout.write(`${line}\n`)
})
// Erst leeren, dann beenden: Pipes schreiben asynchron, und offene Handles (Verbindungen, Keep-Alive)
// sollen das Ende nicht hinauszögern
await new Promise<void>(resolve => process.stdout.write('', () => resolve()))
process.exit(exitCode)
