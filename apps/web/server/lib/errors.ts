/**
 * Fehler einer Analyse mit Code (ANALYSIS_ERROR_CODES, Text unter analysisEvents.<code>) und Rohtext ohne Geheimnisse.
 * Aus `RunError` des ESWC-Controllers (packages/controller/src/errors.ts) hervorgegangen.
 */
export class AnalysisError extends Error {
  readonly code: string
  readonly detail?: string

  constructor(code: string, detail?: string) {
    super(code)
    this.name = 'AnalysisError'
    this.code = code
    this.detail = detail
  }
}
