import { cronPreview } from '../../services/control'

export default defineAdminHandler((event, actor) => {
  const { cron, timezone, count } = queryValidated(event, schemas.cronPreview)
  return cronPreview(actor, cron, timezone, count)
})
