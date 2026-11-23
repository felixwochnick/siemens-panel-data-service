import { testSettings } from '../../services/control'

// Verbindung testen – mit den Werten des Formulars, auch ungespeichert (Netzlaufwerk, Ordner, Worker)
export default defineAdminHandler(async (event, actor, ctx) => testSettings(ctx, actor, await readValidated(event, schemas.settings)))
