import { openLogFile } from '../../services/logs'

export default defineAdminHandler(async (event, actor, ctx) => {
  const { name } = queryValidated(event, schemas.logFile)
  const file = await openLogFile(ctx.logDir, actor, name)
  setResponseHeaders(event, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': file.size,
    'content-disposition': `attachment; filename="${file.name.replace(/[^\w.-]/g, '_')}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  return sendStream(event, file.stream)
})
