// Verbindungen, auf deren Leitung ein Text "#" steht, z. B. „kurzschlusssichere Verlegung“ (Port von HashMarkFinder.cs).
// Das "#" ist keine Eigenschaft der Verbindung; die Zuordnung erfolgt geometrisch über den Leitungsweg.
import { boxFromCorners, markIntersecting } from './geometry'
import type { PageBox, Point, RouteIndex } from './geometry'
import type { RawText } from './types'
import { pushTo } from './util'

export const HASH_MARK = '#'

/** Maximaler Abstand in mm zwischen Textrahmen und Leitung */
export const HASH_MARK_TOLERANCE = 2

export interface HashMarkResult {
  /** je Verbindung: markiert */
  marked: boolean[]
  /** "#"-Texte ohne zugeordnete Verbindung */
  unmatched: number
}

/**
 * Alle Texte zählen, auch in Gruppen und auf Auswertungsseiten (wie im .NET-Altstand). Abweichung: der Inhalt nimmt
 * als letzte Stufe auch Englisch (vorher nur Deutsch/sprachneutral) – für "#" ohne Bedeutung.
 */
export function findHashMarks(texts: readonly RawText[], routes: RouteIndex, connectionCount: number): HashMarkResult {
  const marksByPage = new Map<string, PageBox[]>()
  for (const text of texts) {
    if (text.content !== HASH_MARK) continue
    // Abweichung: ohne lesbaren Rahmen zählt der Textpunkt (im .NET-Altstand bricht der leere Rahmen den Export ab)
    const corners: Point[] = text.box.length > 0 ? text.box.map(([x, y]) => ({ x, y })) : [{ x: text.x, y: text.y }]
    pushTo(marksByPage, text.page, boxFromCorners(corners, HASH_MARK_TOLERANCE))
  }

  const marked = Array.from({ length: connectionCount }, () => false)
  markIntersecting(routes, marksByPage, marked)

  let unmatched = 0
  for (const marks of marksByPage.values()) {
    unmatched += marks.filter(mark => !mark.matched).length
  }
  return { marked, unmatched }
}
