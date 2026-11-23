import { getProject } from '../../services/projects'

export default defineApiHandler((event, actor, ctx) => getProject(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
