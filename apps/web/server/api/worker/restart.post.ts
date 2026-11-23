import { restartWorker } from '../../services/control'

// EPLAN-Worker neu starten (nur Admins)
export default defineAdminHandler((_event, actor, ctx) => restartWorker(ctx, actor))
