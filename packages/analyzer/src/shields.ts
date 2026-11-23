// Abgeschirmte Verbindungen und ihre Schirme (Port von ShieldFinder.cs):
// - Schirmsymbole („Abschirmung, Kabeldefinition“): logisch über `shieldings`, zusätzlich über die Adern, die die
//   gezeichnete Schirmlinie kreuzen (EPLAN verknüpft die Adern nicht immer mit dem Schirm).
// - Geschirmte Kabel: Kabel, deren Typ mit "GSC" beginnt (z. B. GSC-01), mit ihren Adern.
import { intersects } from './geometry'
import type { PageBox, RouteIndex } from './geometry'
import type { RawConnection, RawShield } from './types'
import { compareOrdinal } from './util'

/** Name eines Schirms ohne Namen */
export const DEFAULT_SHIELD_NAME = 'Abschirmung'

/** FUNC_CABLETYPE geschirmter Kabel beginnt mit "GSC" (Groß-/Kleinschreibung egal) */
const SHIELDED_CABLE_TYPE = /^GSC/i

export interface ShieldGroup {
  page: string
  name: string
  type: string
  wireCountAndCrossSection: string
  /** Indizes in die Verbindungen, aufsteigend, ohne Doppelte */
  wires: number[]
}

export interface ShieldResult {
  /** nach Seite sortiert (Ordinal, stabil) */
  groups: ShieldGroup[]
  /** je Verbindung: abgeschirmt */
  shielded: boolean[]
}

/** Math.Round(value, 2) aus .NET: Mitte zur geraden Zahl (MidpointRounding.ToEven) */
function roundTwoDigits(value: number): number {
  const scaled = value * 100
  const floor = Math.floor(scaled)
  const fraction = scaled - floor
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor
  return rounded / 100
}

/** Gruppe eines Schirmsymbols; Seite und gerundete Lage identifizieren es (die API liefert je Zugriff neue Objekte) */
function shieldGroup(groups: Map<string, ShieldGroup>, page: string, x: number, y: number, name: string): ShieldGroup {
  const key = `Schirm|${page}|${roundTwoDigits(x)}|${roundTwoDigits(y)}`
  let group = groups.get(key)
  if (!group) {
    group = { page, name: name.length > 0 ? name : DEFAULT_SHIELD_NAME, type: '', wireCountAndCrossSection: '', wires: [] }
    groups.set(key, group)
  }
  return group
}

/**
 * Fläche der Schirmlinie. Die Ausdehnung steht in RECTANGLE_WIDTH/HEIGHT (in Seitenrichtung), die Richtung vom
 * Symbolpunkt aus ergibt sich aus der Variante: 0 rechts, 1 oben, 2 links, 3 unten. Unlesbare Werte ⇒ keine Fläche.
 */
function shieldArea(shield: RawShield): PageBox | null {
  const { x, y, width, height, variant } = shield
  if (width === null || height === null || variant === -1) return null
  switch (variant) {
    case 0: return { minX: x, maxX: x + width, minY: y - height, maxY: y + height, matched: false }
    case 1: return { minX: x - width, maxX: x + width, minY: y, maxY: y + height, matched: false }
    case 2: return { minX: x - width, maxX: x, minY: y - height, maxY: y + height, matched: false }
    case 3: return { minX: x - width, maxX: x + width, minY: y - height, maxY: y, matched: false }
    // Gespiegelte Varianten: Richtung unbekannt, beide Seiten berücksichtigen
    default: return { minX: x - width, maxX: x + width, minY: y - height, maxY: y + height, matched: false }
  }
}

/** Schirmanschluss (Leitung vom Schirm zur Erdung/Schirmklemme) oder interner Schirm-Eintrag ohne Anschlüsse */
function isShieldConnection(connection: RawConnection): boolean {
  const { start, end } = connection
  return (start === null && end === null) || start?.parentIsShield === true || end?.parentIsShield === true
}

export function findShields(shields: readonly RawShield[], connections: readonly RawConnection[], routes: RouteIndex): ShieldResult {
  // Map behält die Einfügereihenfolge wie Dictionary im .NET-Altstand (ohne Entfernen)
  const groups = new Map<string, ShieldGroup>()

  // 1. Schirmsymbole: logisch zugeordnete Adern
  connections.forEach((connection, index) => {
    for (const shielding of connection.shieldings) {
      shieldGroup(groups, shielding.page, shielding.x, shielding.y, shielding.name).wires.push(index)
    }
  })

  // 2. Schirmsymbole: Adern, die die Schirmlinie kreuzen; die Gruppe entsteht auch ohne Fläche.
  // Reihenfolge und Doppelte spielen keine Rolle, die Adern werden unten entdoppelt und sortiert.
  for (const shield of shields) {
    const group = shieldGroup(groups, shield.page, shield.x, shield.y, shield.name)
    const area = shieldArea(shield)
    if (!area) continue
    for (const { connection, segment } of routes.get(shield.page) ?? []) {
      if (intersects(area, segment)) group.wires.push(connection)
    }
  }

  // 3. Geschirmte Kabel (GSC…) mit ihren Adern; Seite, Typ und Querschnitt von der ersten Ader
  connections.forEach((connection, index) => {
    const cable = connection.cable
    if (!cable || !SHIELDED_CABLE_TYPE.test(cable.type)) return
    const key = `Kabel|${cable.name}`
    let group = groups.get(key)
    if (!group) {
      group = { page: connection.page, name: cable.name, type: cable.type, wireCountAndCrossSection: cable.wireCountAndCrossSection, wires: [] }
      groups.set(key, group)
    }
    group.wires.push(index)
  })

  // Schirmanschlüsse sind selbst nicht abgeschirmt
  const shielded = Array.from({ length: connections.length }, () => false)
  for (const group of groups.values()) {
    const wires = group.wires.filter(index => !isShieldConnection(connections[index]!))
    group.wires = [...new Set(wires)].sort((a, b) => a - b)
    for (const index of group.wires) shielded[index] = true
  }

  // Array.prototype.sort ist stabil wie OrderBy
  return { groups: [...groups.values()].sort((a, b) => compareOrdinal(a.page, b.page)), shielded }
}
