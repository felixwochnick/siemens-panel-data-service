// Verdrillte Verbindungen (Port von TwistFinder.cs und ConnectionExporter.TwistDesignation).
// Das gezeichnete Verdrillungssymbol ist keine EPLAN-Funktion, sondern besteht aus einzelnen Linien: ein Querbalken
// mit kurzem Haken an beiden Enden und einem Schrägstrich je Ader. Verdrillt sind die Verbindungen, die einen
// Schrägstrich kreuzen.
import { boxFromCorners, markIntersecting, sameLocation } from './geometry'
import type { PageBox, Point, RouteIndex } from './geometry'
import type { RawLine } from './types'
import { pushTo } from './util'

/** Maximale Länge in mm von Haken und Schrägstrich (je Achse); der Balken muss länger als 2 × sein */
export const TWIST_MARK_LENGTH = 3

/** Maximaler Abstand in mm zwischen Schrägstrich-Mitte und Leitung */
export const TWIST_TOLERANCE = 1

const EPSILON = 0.01

/**
 * Verdrillte Adern haben eine gemeinsame Verbindungsbezeichnung, z. B. VD_X500 oder VD_F500_1.
 * `\p{Nd}` statt `\d`, weil `\d` in .NET alle Unicode-Ziffern trifft.
 */
const TWIST_DESIGNATION = /^VD_[A-Za-z]\p{Nd}+(?:_\p{Nd}+)?$/u

export function isTwistDesignation(designation: string): boolean {
  return TWIST_DESIGNATION.test(designation.trim())
}

interface LineSegment {
  a: Point
  b: Point
  horizontal: boolean
  axisAligned: boolean
  diagonal: boolean
  length: number
  middle: Point
}

function lineSegment(line: RawLine): LineSegment {
  const a = { x: line.x1, y: line.y1 }
  const b = { x: line.x2, y: line.y2 }
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  const horizontal = dy < EPSILON && dx >= EPSILON
  return {
    a,
    b,
    horizontal,
    axisAligned: horizontal || (dx < EPSILON && dy >= EPSILON),
    diagonal: dx >= EPSILON && Math.abs(dx - dy) < EPSILON,
    length: Math.max(dx, dy),
    middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  }
}

/** Liegt der Punkt auf der (waagerechten/senkrechten) Linie? */
function contains(line: LineSegment, p: Point): boolean {
  return p.x >= Math.min(line.a.x, line.b.x) - EPSILON && p.x <= Math.max(line.a.x, line.b.x) + EPSILON
    && p.y >= Math.min(line.a.y, line.b.y) - EPSILON && p.y <= Math.max(line.a.y, line.b.y) + EPSILON
}

/** Kurze, zum Balken senkrechte Linie, die am Balkenende beginnt */
function hasHook(hooks: readonly LineSegment[], bar: LineSegment, end: Point): boolean {
  return hooks.some(line => line.horizontal !== bar.horizontal && (sameLocation(line.a, end) || sameLocation(line.b, end)))
}

export interface TwistSymbolResult {
  /** je Verbindung: kreuzt einen Schrägstrich eines Verdrillungssymbols */
  twisted: boolean[]
  /** Anzahl gezeichneter Verdrillungssymbole */
  symbols: number
  /** Schrägstriche ohne zugeordnete Verbindung */
  unmatchedTicks: number
}

export function findTwistSymbols(lines: readonly RawLine[], routes: RouteIndex, connectionCount: number): TwistSymbolResult {
  const linesByPage = new Map<string, LineSegment[]>()
  for (const line of lines) pushTo(linesByPage, line.page, lineSegment(line))

  const marksByPage = new Map<string, PageBox[]>()
  let symbols = 0
  for (const [page, pageLines] of linesByPage) {
    // Kandidaten einmal je Seite vorfiltern; gleiche Bedingungen wie im .NET-Altstand
    const ticks = pageLines.filter(line => line.diagonal && line.length <= TWIST_MARK_LENGTH)
    const hooks = pageLines.filter(line => line.axisAligned && line.length <= TWIST_MARK_LENGTH)
    const marks: PageBox[] = []

    for (const bar of pageLines) {
      if (!bar.axisAligned || !(bar.length > 2 * TWIST_MARK_LENGTH)) continue
      const barTicks = ticks.filter(tick => contains(bar, tick.middle))
      if (barTicks.length < 2 || !hasHook(hooks, bar, bar.a) || !hasHook(hooks, bar, bar.b)) continue

      symbols++
      for (const tick of barTicks) marks.push(boxFromCorners([tick.middle], TWIST_TOLERANCE))
    }
    if (marks.length > 0) marksByPage.set(page, marks)
  }

  const twisted = Array.from({ length: connectionCount }, () => false)
  markIntersecting(routes, marksByPage, twisted)

  let unmatchedTicks = 0
  for (const marks of marksByPage.values()) {
    unmatchedTicks += marks.filter(mark => !mark.matched).length
  }
  return { twisted, symbols, unmatchedTicks }
}
