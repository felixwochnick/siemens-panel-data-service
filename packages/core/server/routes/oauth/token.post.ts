import { exchangeToken } from '../../oauth'

// Formular (Standard) oder JSON; ein Basic-Header authentifiziert Programme mit Secret
export default defineEventHandler(event => oauthEndpoint(event, async () =>
  exchangeToken(useDb(), useOAuthOptions(), await readOAuthBody(event), getRequestHeader(event, 'authorization'))))
