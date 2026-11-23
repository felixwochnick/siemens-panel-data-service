import { z } from 'zod'
import { deleteConnection } from '../../../oauth'

export default defineEventHandler(async (event) => {
  requireMcpEnabled()
  const user = await requireAuth(event)
  const { id } = paramsValidated(event, z.object({ id: idSchema }))
  // Fremde Verbindungen sehen aus wie unbekannte
  if (!await deleteConnection(useDb(), user.id, id)) throw createError({ statusCode: 404, message: 'not_found' })
  return { ok: true }
})
