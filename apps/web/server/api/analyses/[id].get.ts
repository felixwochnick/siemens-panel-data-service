import { getAnalysis } from '../../services/analyses'

export default defineApiHandler((event, actor, ctx) => getAnalysis(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
