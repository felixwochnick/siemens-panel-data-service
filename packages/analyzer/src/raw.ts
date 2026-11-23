import { RAW_FORMAT } from './types'
import type { RawProject } from './types'

/** Fehler der Auswertung mit Code (übersetzt in der App unter errors.<code>) */
export class AnalyzerError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'AnalyzerError'
  }
}

// VORLÄUFIG (Task 0): prüft nur das Format; die vollständige Prüfung folgt in Task 1
export function parseRawProject(json: unknown): RawProject {
  if (typeof json !== 'object' || json === null || (json as { format?: unknown }).format !== RAW_FORMAT) {
    throw new AnalyzerError('raw_invalid', 'format')
  }
  return json as RawProject
}
