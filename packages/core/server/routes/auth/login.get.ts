// Startet die Anmeldung beim Identity-Provider (Entra ID bzw. Dex)
export default defineEventHandler(async (event) => {
  const redirect = safeRedirectPath(getQuery(event).redirect)
  try {
    return await startOidcLogin(event, redirect)
  }
  catch (error) {
    console.error('[auth] Login konnte nicht gestartet werden', error)
    return sendRedirect(event, `/login?error=sso_unavailable&redirect=${encodeURIComponent(redirect)}`)
  }
})
