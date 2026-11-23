import type { H3Event } from 'h3'
import type { SessionUser } from '../../shared/types/auth'

/** Legt eine Session (DB-Zeile + versiegeltes Cookie) für einen Benutzer an */
export async function startUserSession(event: H3Event, userId: string): Promise<SessionUser> {
  const { session: { maxAge } } = useRuntimeConfig()
  const db = useDb()
  // Vorherige Session dieses Browsers und abgelaufene Sessions aufräumen
  const previous = await getUserSession(event)
  if (previous.sessionId) await db.deleteFrom('core.sessions').where('id', '=', previous.sessionId).execute()
  await db.deleteFrom('core.sessions').where('expiresAt', '<', new Date()).execute()
  const user = await db.selectFrom('core.users')
    .select(['id', 'displayName', 'email', 'isAdmin'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!user) throw createError({ statusCode: 403, message: 'account_unknown' })

  const session = await db.insertInto('core.sessions')
    .values({
      userId,
      expiresAt: new Date(Date.now() + maxAge * 1000),
      userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 500) ?? null,
    })
    .output('inserted.id')
    .executeTakeFirstOrThrow()

  const sessionUser: SessionUser = { id: user.id, displayName: user.displayName, email: user.email, isAdmin: user.isAdmin }
  await replaceUserSession(event, { user: sessionUser, sessionId: session.id })
  return sessionUser
}

/** Beendet die aktuelle Session (DB-Zeile löschen, Cookie leeren) */
export async function endUserSession(event: H3Event) {
  const session = await getUserSession(event)
  if (session.sessionId) await useDb().deleteFrom('core.sessions').where('id', '=', session.sessionId).execute()
  await clearUserSession(event)
}

/** Gültige Session → Benutzer mit aktuellem Stand aus der Datenbank (Admin-Status, Name) */
export async function loadSessionUser(sessionId: string, userId: string): Promise<SessionUser | undefined> {
  return useDb().selectFrom('core.sessions as s')
    .innerJoin('core.users as u', 'u.id', 's.userId')
    .select(['u.id', 'u.displayName', 'u.email', 'u.isAdmin'])
    .where('s.id', '=', sessionId)
    .where('s.userId', '=', userId)
    .where('s.expiresAt', '>', new Date())
    .executeTakeFirst()
}

/**
 * Verlangt eine gültige Anmeldung; optional Plattform-Admin.
 * Rechte kommen aus der Datenbank (nicht aus dem Cookie) – entzogene Admin-Rechte wirken sofort.
 */
export async function requireAuth(event: H3Event, options: { admin?: boolean } = {}): Promise<SessionUser> {
  let user = event.context.authUser
  if (!user) {
    const session = await requireUserSession(event, { message: 'unauthorized' })
    user = session.sessionId ? await loadSessionUser(session.sessionId, session.user.id) : undefined
    if (!user) throw createError({ statusCode: 401, message: 'unauthorized' })
    event.context.authUser = user
  }
  if (options.admin && !user.isAdmin) throw createError({ statusCode: 403, message: 'forbidden' })
  return user
}
