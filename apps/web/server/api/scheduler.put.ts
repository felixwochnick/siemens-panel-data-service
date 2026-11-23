import { setSchedulerEnabled } from '../services/settings'

// Zeitplan an/aus (Einschalten nur mit vollständigen Einstellungen und Projektordner)
export default defineAdminHandler(async (event, actor, ctx) => {
  const { enabled } = await readValidated(event, schemas.scheduler)
  return setSchedulerEnabled(ctx, actor, enabled)
})
