/** Angemeldeter Benutzer, wie er im Session-Cookie steht */
export interface SessionUser {
  id: string
  displayName: string
  email: string | null
  /** Plattform-Admin (aus dem Rollen-Claim des Identity-Providers, bei jedem Login aktualisiert) */
  isAdmin: boolean
}
