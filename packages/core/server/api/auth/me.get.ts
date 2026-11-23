// Aktueller Benutzer frisch aus der Datenbank (z. B. nach Änderungen am Admin-Status)
export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const row = await useDb().selectFrom('core.users')
    .select(['id', 'displayName', 'email', 'isAdmin'])
    .where('id', '=', user.id)
    .executeTakeFirst()
  if (!row) {
    await endUserSession(event)
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }
  return row
})
