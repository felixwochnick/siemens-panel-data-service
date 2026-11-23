import { listAnalysisEvents } from '../../../services/analyses'

export default defineApiHandler((event, actor, ctx) =>
  listAnalysisEvents(ctx.db, actor, paramsValidated(event, schemas.idParams).id, queryValidated(event, schemas.events)))
