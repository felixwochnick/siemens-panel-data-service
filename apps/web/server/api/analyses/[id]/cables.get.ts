import { getCables } from '../../../services/results'

// Tab „Kabel“: Kabel und Schirme mit eingebetteten Adern
export default defineApiHandler((event, actor, ctx) => getCables(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
