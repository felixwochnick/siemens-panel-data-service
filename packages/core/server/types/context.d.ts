import type { SessionUser } from '../../shared/types/auth'

declare module 'h3' {
  interface H3EventContext {
    /** Angemeldeter Benutzer, frisch aus der Datenbank (gesetzt von middleware/01.session) */
    authUser?: SessionUser
  }
}

export {}
