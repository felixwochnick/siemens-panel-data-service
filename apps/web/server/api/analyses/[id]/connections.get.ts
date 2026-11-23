import { getConnections } from '../../../services/results'

// Tab „Verbindungen“: alle Zeilen auf einmal (die Tabelle filtert und sortiert im Browser)
export default defineApiHandler((event, actor, ctx) => getConnections(ctx.db, actor, paramsValidated(event, schemas.idParams).id))
