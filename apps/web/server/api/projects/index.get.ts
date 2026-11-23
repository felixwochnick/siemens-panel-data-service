import { listProjects } from '../../services/projects'

export default defineApiHandler((event, actor, ctx) => listProjects(ctx.db, actor, queryValidated(event, schemas.projects)))
