import { listConnections } from '../../../oauth'

// Eigene Verbindungen von KI-Assistenten
export default defineEventHandler(async (event) => {
  requireMcpEnabled()
  const user = await requireAuth(event)
  return listConnections(useDb(), user.id)
})
