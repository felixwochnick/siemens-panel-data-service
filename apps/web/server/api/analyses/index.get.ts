import { listAnalyses } from '../../services/analyses'

export default defineApiHandler((event, actor, ctx) => listAnalyses(ctx.db, actor, queryValidated(event, schemas.analyses)))
