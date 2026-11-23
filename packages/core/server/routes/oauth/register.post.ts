import { registerClient, tryCleanupOAuth } from '../../oauth'

// Dynamische Client-Registrierung (RFC 7591)
export default defineEventHandler(event => oauthEndpoint(event, async () => {
  const db = useDb()
  const now = new Date()
  // Nie genutzte Programme verschwinden nach einem Tag; hier aufräumen, damit Registrieren nicht die Tabelle füllt.
  // Scheitert das, wird trotzdem registriert (die Obergrenze in registerClient schützt weiter).
  await tryCleanupOAuth(db, now)
  return registerClient(db, await readOAuthBody(event), now)
}, 201))
