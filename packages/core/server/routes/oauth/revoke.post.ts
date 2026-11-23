import { revokeToken } from '../../oauth'

// RFC 7009: antwortet immer mit 200, auch bei unbekanntem Token
export default defineEventHandler(event => oauthEndpoint(event, async () => {
  await revokeToken(useDb(), await readOAuthBody(event), getRequestHeader(event, 'authorization'))
  return {}
}))
