import { getSettings } from '../../services/settings'

// Einstellungen (nur Admins); Netzlaufwerk-Passwort nur als { set, readable }
export default defineAdminHandler((event, actor, ctx) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return getSettings(ctx, actor)
})
