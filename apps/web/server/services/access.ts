import { ServiceError, forbidden } from './errors'

/** Wer eine Aktion auslöst (Oberfläche oder MCP); Rechte kommen frisch aus der Datenbank */
export interface Actor {
  id: string
  isAdmin: boolean
}

/**
 * Alle Angemeldeten sehen Projekte und Ergebnisse, laden hoch und starten Analysen. Die API-Handler verlangen die
 * Anmeldung schon; die Services prüfen den Akteur noch einmal, weil MCP-Werkzeuge sie direkt aufrufen.
 */
export function requireUser(actor: Actor | null | undefined): asserts actor is Actor {
  if (!actor?.id) throw new ServiceError(401, 'unauthorized')
}

/**
 * Einstellungen, Protokolle, Zeitplan, Löschen und Worker-Neustart nur für Admins – auch über MCP (eine Verbindung kann
 * älter sein als ein Entzug der Admin-Rolle; die Rolle kommt deshalb bei jedem Aufruf frisch aus der Datenbank).
 */
export function requireAdmin(actor: Actor | null | undefined): asserts actor is Actor {
  requireUser(actor)
  if (!actor.isAdmin) throw forbidden()
}
