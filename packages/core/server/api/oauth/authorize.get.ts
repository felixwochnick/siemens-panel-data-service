import { authorizeInfo, checkAuthorizeRequest } from '../../oauth'

// Prüft die Anfrage des Programms und liefert, was die Zustimmungsseite anzeigt
export default defineEventHandler(async (event) => {
  requireMcpEnabled()
  const user = await requireConsentUser(event)
  const db = useDb()
  const o = useOAuthOptions()
  return oauthApi(async () => {
    // Fehlerhafte Anfragen zuerst: sie werden gezeigt, ohne die Person erst durch die Anmeldung zu schicken
    const checked = await checkAuthorizeRequest(db, o, getQuery(event))
    await requireConsentSession(event, user, o)
    return authorizeInfo(checked)
  })
})
