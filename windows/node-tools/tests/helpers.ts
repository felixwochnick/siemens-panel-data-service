import { runCommand } from '../src/tools'
import type { ToolLine } from '../src/protocol'

export interface ToolRun {
  exitCode: number
  /** Rohe Ausgabezeilen (für Prüfungen auf Geheimnisse) */
  raw: string[]
  lines: ToolLine[]
  steps: ToolLine[]
  result: ToolLine
}

/** Führt einen Befehl im Prozess aus, mit genau der übergebenen Umgebung */
export async function runTool(command: string, env: Record<string, string>): Promise<ToolRun> {
  const raw: string[] = []
  const exitCode = await runCommand([command], env, line => raw.push(line))
  const lines = raw.map(line => JSON.parse(line) as ToolLine)
  const result = lines.at(-1)
  if (result?.type !== 'result') throw new Error(`Keine Abschlusszeile: ${raw.join('\n')}`)
  return { exitCode, raw, lines, steps: lines.filter(line => line.type === 'step'), result }
}

export function step(run: ToolRun, code: string): ToolLine | undefined {
  return run.steps.find(line => line.code === code)
}
