import type { Kysely } from 'kysely'
import { withE2eDb } from './db'

/** Nur was ageSessions braucht – in der App ist der Anmeldezeitpunkt nicht änderbar (Typ `never`) */
interface SessionAging {
  'core.sessions': { userId: string, createdAt: Date }
  'core.users': { id: string, email: string | null }
}

/** Anmeldungen einer Person älter machen (z. B. für die Zustimmung, die eine frische Anmeldung verlangt) */
export function ageSessions(email: string, minutes: number) {
  const createdAt = new Date(Date.now() - minutes * 60_000)
  return withE2eDb((app) => {
    const db = app as unknown as Kysely<SessionAging>
    return db.updateTable('core.sessions')
      .set({ createdAt })
      .where('userId', 'in', db.selectFrom('core.users').select('id').where('email', '=', email))
      .execute()
  })
}
