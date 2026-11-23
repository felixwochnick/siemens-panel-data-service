import { startAnalysis } from '../../services/analyses'

// Analysen einreihen: { projectId } oder { folderPaths } (alle Angemeldeten)
export default defineApiHandler(async (event, actor, ctx) => {
  const input = await readValidated(event, schemas.startAnalysis)
  const result = await startAnalysis(ctx, actor, input)
  setResponseStatus(event, 202)
  return result
})
