import { getTexts } from '../../../services/results'

// Tab „Texte“
export default defineApiHandler((event, actor, ctx) => getTexts(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
