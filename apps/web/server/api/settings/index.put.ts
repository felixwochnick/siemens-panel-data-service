import { saveSettings } from '../../services/settings'

// Speichern; Antwort wie GET plus geänderte Felder
export default defineAdminHandler(async (event, actor, ctx) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return saveSettings(ctx, actor, await readValidated(event, schemas.settings))
})
