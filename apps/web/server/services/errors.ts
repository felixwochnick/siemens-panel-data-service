/**
 * Fachlicher Fehler mit HTTP-Status und Fehlercode (snake_case, übersetzt im Client über errors.<code>).
 * Nitro übernimmt statusCode/message/data beim Antworten; die Services bleiben so ohne Nuxt testbar.
 */
export class ServiceError extends Error {
  readonly statusCode: number
  readonly statusMessage: string
  readonly data: { message: string, [key: string]: unknown }

  constructor(statusCode: number, code: string, data: Record<string, unknown> = {}) {
    super(code)
    this.statusCode = statusCode
    this.statusMessage = code
    this.data = { ...data, message: code }
  }
}

export const notFound = () => new ServiceError(404, 'not_found')
export const forbidden = () => new ServiceError(403, 'forbidden')

/** Fehler mit Liste der Einstellungsprobleme; `details` als Text für MCP (das Modell sieht nur ihn) */
export const issuesError = (code: string, issues: { path: string, code: string }[]) =>
  new ServiceError(400, code, { issues, details: issues.map(issue => `${issue.path}: ${issue.code}`).join(', ') })
