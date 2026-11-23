import { getShields } from '../../../services/results'

// Tab „Schirme“: je Schirm die Indizes der abgeschirmten Verbindungen
export default defineApiHandler((event, actor, ctx) => getShields(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
