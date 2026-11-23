import { z } from 'zod'
import { approveAuthorization, denyAuthorization } from '../../oauth'
import { MCP_GRANTS } from '../../../shared/utils/mcp'

// Query der Autorisierungsanfrage kommt unverändert zurück; sie wird erneut geprüft, dem Browser wird nicht vertraut
const query = z.record(z.string(), z.string())
const bodySchema = z.discriminatedUnion('approve', [
  z.object({ query, approve: z.literal(true), access: z.enum(MCP_GRANTS) }),
  z.object({ query, approve: z.literal(false) }),
])

// Zustimmung oder Ablehnung → Adresse, zu der der Browser zurückspringt
export default defineEventHandler(async (event) => {
  requireMcpEnabled()
  const user = await requireConsentUser(event)
  const body = await readValidated(event, bodySchema)
  const db = useDb()
  const o = useOAuthOptions()
  const redirect = await oauthApi(async () => {
    // Auch zwischen Laden und Klick kann die Anmeldung zu alt geworden sein; die Verbindung endet mit der Sitzung
    const session = await requireConsentSession(event, user, o)
    return body.approve
      ? approveAuthorization(db, o, user.id, body.query, body.access, session.expiresAt)
      : denyAuthorization(db, o, body.query)
  })
  return { redirect }
})
