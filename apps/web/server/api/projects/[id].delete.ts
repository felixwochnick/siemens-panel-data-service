import { deleteProject } from '../../services/projects'

// Projekt mit allen Ständen löschen (nur Admins)
export default defineAdminHandler((event, actor, ctx) => deleteProject(ctx, actor, paramsValidated(event, schemas.idParams).id))
