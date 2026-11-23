// Rückruf des Identity-Providers: Benutzer anlegen/aktualisieren und Session starten
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  if (query.error) {
    console.warn('[auth] IdP meldet Fehler', query.error, query.error_description)
    return sendRedirect(event, '/login?error=sso_denied')
  }

  try {
    const { claims, redirect, issuer } = await finishOidcLogin(event)
    const { oidc } = useRuntimeConfig()
    const userId = await provisionUser(useDb(), claims, {
      issuer,
      rolesClaim: oidc.rolesClaim,
      adminRoles: splitList(oidc.adminRoles),
    })
    await startUserSession(event, userId)
    return sendRedirect(event, redirect)
  }
  catch (error) {
    const code = (error as { message?: string })?.message === 'login_expired' ? 'login_expired' : 'sso_failed'
    console.error('[auth] Anmeldung fehlgeschlagen', error)
    return sendRedirect(event, `/login?error=${code}`)
  }
})
