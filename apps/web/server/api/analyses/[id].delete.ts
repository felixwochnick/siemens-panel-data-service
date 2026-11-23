import { deleteAnalysis } from '../../services/analyses'

// Wartende oder beendete Analyse löschen (nur Admins)
export default defineAdminHandler((event, actor, ctx) => deleteAnalysis(ctx, actor, paramsValidated(event, schemas.idParams).id))
