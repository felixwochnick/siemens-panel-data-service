import { listLogFiles } from '../../services/logs'

export default defineAdminHandler((_event, actor, ctx) => listLogFiles(ctx.logDir, actor))
