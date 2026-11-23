import { uploadProject } from '../../services/uploads'

/*
 * Hochladen: POST /api/projects/upload?name=Anlage.zw1, Body = die Datei (keine Multipart-Form). Der Body wird
 * streamend auf die Platte geschrieben und nie ganz in den Speicher gelesen; die Größe prüft der Service während des
 * Schreibens (uploadMaxMb). Die allgemeine Grenze für Bodies gilt hier nicht (runtimeConfig.requestGuard).
 */
export default defineApiHandler(async (event, actor, ctx) => {
  const { name } = queryValidated(event, schemas.upload)
  const length = Number(getRequestHeader(event, 'content-length'))
  const result = await uploadProject(ctx, actor, {
    fileName: name,
    body: event.node.req,
    contentLength: Number.isFinite(length) && length >= 0 ? length : undefined,
  })
  setResponseStatus(event, 201)
  return result
})
