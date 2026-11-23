import { getStatus } from '../services/control'

// Übersicht: Worker, Warteschlange, zuletzt beendete Analysen; Admins zusätzlich Hinweise und Zeitplan
export default defineApiHandler((_event, actor, ctx) => getStatus(ctx, actor))
