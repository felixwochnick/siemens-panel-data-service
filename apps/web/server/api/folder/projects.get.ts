import { listFolderProjects } from '../../services/folder'

// Projekte im Projektordner mit ihrem Stand (Dialog „Aus Ordner wählen“)
export default defineApiHandler((_event, actor, ctx) => listFolderProjects(ctx, actor))
