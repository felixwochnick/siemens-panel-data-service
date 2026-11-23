// Leitungsweg einer Verbindung im Schaltplan (Port von ConnectionGeometry.cs). Die EPLAN-API liefert die gezeichneten
// Linien einer Verbindung nicht; der Weg wird aus den Symbolen der Verbindung gebildet.
import type { RawConnection, RawPagePoint, RawSymbolEnd } from './types'
import { pushTo } from './util'

/** Toleranz in mm für „gleiche Lage“ (ConnectionGeometry.SameLocation) */
export const LOCATION_EPSILON = 0.01

export interface Point {
  x: number
  y: number
}

/** Rechteck auf einer Seite in mm, z. B. Rahmen eines Textes; `matched` = von einem Leitungsabschnitt geschnitten */
export interface PageBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  matched: boolean
}

export interface ConnectionSegment {
  page: string
  a: Point
  b: Point
}

/** Abschnitt mit dem Index seiner Verbindung */
export interface IndexedSegment {
  connection: number
  segment: ConnectionSegment
}

/** Leitungsabschnitte aller Verbindungen je Seite */
export type RouteIndex = ReadonlyMap<string, readonly IndexedSegment[]>

/** Rechteck um die Ecken plus Rand; mindestens eine Ecke nötig */
export function boxFromCorners(corners: readonly Point[], margin: number): PageBox {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of corners) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin, matched: false }
}

/** Überschneidet sich der (waagerechte/senkrechte) Leitungsabschnitt mit dem Rechteck? Rand zählt mit. */
export function intersects(box: PageBox, segment: ConnectionSegment): boolean {
  const { a, b } = segment
  return Math.max(a.x, b.x) >= box.minX && Math.min(a.x, b.x) <= box.maxX
    && Math.max(a.y, b.y) >= box.minY && Math.min(a.y, b.y) <= box.maxY
}

export function sameLocation(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < LOCATION_EPSILON && Math.abs(a.y - b.y) < LOCATION_EPSILON
}

function isSymbolOf(symbol: RawPagePoint, end: RawSymbolEnd | null): end is RawSymbolEnd {
  return end !== null && end.page === symbol.page && sameLocation(end, symbol)
}

/**
 * Leitungsabschnitte einer Verbindung. `symbols` liefert den Weg in Reihenfolge (Gerät, Winkel,
 * Unterbrechungsstelle, … über mehrere Seiten); benachbarte Punkte derselben Seite bilden einen Abschnitt.
 */
export function connectionSegments(connection: RawConnection): ConnectionSegment[] {
  const { startSymbol, endSymbol } = connection
  const segments: ConnectionSegment[] = []
  let previousPage: string | null = null
  let previous: Point = { x: 0, y: 0 }
  let startUsed = false

  for (const symbol of connection.symbols) {
    // Der Worker schreibt "" statt null für eine fehlende Seite; ohne Seite entsteht kein Abschnitt
    const page = symbol.page === '' ? null : symbol.page
    let point: Point = { x: symbol.x, y: symbol.y }

    // Gerätesymbole liefern ihren Ursprung, die Leitung beginnt aber am Anschluss (relativ zum Symbol).
    // Das Startsymbol gilt nur einmal, das Endsymbol bei jedem Treffer (wie im .NET-Altstand).
    if (!startUsed && isSymbolOf(symbol, startSymbol)) {
      point = { x: point.x + startSymbol.pinX, y: point.y + startSymbol.pinY }
      startUsed = true
    }
    else if (isSymbolOf(symbol, endSymbol)) {
      point = { x: point.x + endSymbol.pinX, y: point.y + endSymbol.pinY }
    }

    if (page !== null && page === previousPage) {
      segments.push({ page, a: previous, b: point })
    }
    previousPage = page
    previous = point
  }
  return segments
}

/** Abschnitte aller Verbindungen einmal berechnen; Index = Position in `connections` */
export function buildRouteIndex(connections: readonly RawConnection[]): RouteIndex {
  const byPage = new Map<string, IndexedSegment[]>()
  connections.forEach((connection, index) => {
    for (const segment of connectionSegments(connection)) {
      pushTo(byPage, segment.page, { connection: index, segment })
    }
  })
  return byPage
}

/**
 * Markiert alle Verbindungen, deren Leitungsweg eines der Rechtecke (nach Seitenname) schneidet, und setzt
 * `matched` an den getroffenen Rechtecken. Gleiches Ergebnis wie die Schleife über alle Verbindungen im
 * .NET-Altstand, aber nur über die Abschnitte der Seiten mit Rechtecken.
 */
export function markIntersecting(routes: RouteIndex, boxesByPage: ReadonlyMap<string, readonly PageBox[]>, marked: boolean[]): void {
  for (const [page, boxes] of boxesByPage) {
    const segments = routes.get(page)
    if (!segments) continue
    for (const { connection, segment } of segments) {
      for (const box of boxes) {
        if (intersects(box, segment)) {
          box.matched = true
          marked[connection] = true
        }
      }
    }
  }
}
