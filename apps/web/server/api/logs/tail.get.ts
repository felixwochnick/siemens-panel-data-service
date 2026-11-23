import { readLogTail } from '../../services/logs'

// Name als Query (nicht im Pfad): Pfade mit Punkt gelten in core als statische Dateien
export default defineAdminHandler((event, actor, ctx) => {
  const { name, lines, filter } = queryValidated(event, schemas.logTail)
  return readLogTail(ctx.logDir, actor, name, { lines, filter })
})
