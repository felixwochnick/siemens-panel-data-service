// Prüft die Session bei jeder Anfrage gegen die Datenbank – Abmelden/Ablauf wirkt sofort, auch beim SSR.
// Der Benutzer (inkl. Admin-Status) kommt dabei frisch aus der Datenbank und steht in event.context.authUser.
// Programm-Endpunkte (MCP, OAuth) laufen ohne Sitzung: schon das Lesen würde einem anonymen Aufrufer ein Cookie setzen.
export default defineEventHandler(async (event) => {
  if (!isDynamicRequest(event.path) || isSessionlessRequest(event.path)) return
  const session = await getUserSession(event)
  if (!session.user) return
  const user = session.sessionId ? await loadSessionUser(session.sessionId, session.user.id) : undefined
  if (!user) {
    await clearUserSession(event)
    return
  }
  event.context.authUser = user
  // Cookie nachziehen, wenn sich Name oder Admin-Status geändert haben (Anzeige im Client)
  if (user.isAdmin !== session.user.isAdmin || user.displayName !== session.user.displayName || user.email !== session.user.email)
    await replaceUserSession(event, { user, sessionId: session.sessionId })
})
