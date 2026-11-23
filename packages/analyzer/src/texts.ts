// Freie Texte der Seiten, z. B. Hinweise für die Montage (Port von TextList.cs).
import { HASH_MARK } from './hash-marks'
import type { RawPage, RawText, TextRow } from './types'
import { pushTo } from './util'

/**
 * Nur freie Texte: Texte in Gruppen gehören zu Symbolen, Gerätegrafiken oder Makros (z. B. "RDY"). Markierungen wie
 * "#" sind eigene Spalten der Verbindungen und werden hier ausgelassen.
 */
function isListed(text: RawText): boolean {
  return text.free && text.content.length > 0 && text.content !== HASH_MARK
}

export function textRows(pages: readonly RawPage[], texts: readonly RawText[]): TextRow[] {
  const byPage = new Map<string, RawText[]>()
  for (const text of texts) {
    if (isListed(text)) pushTo(byPage, text.page, text)
  }

  const rows: TextRow[] = []
  const add = (text: RawText) => rows.push({ idx: rows.length, page: text.page, text: text.content })

  const known = new Set<string>()
  for (const page of pages) {
    if (known.has(page.name)) continue
    known.add(page.name)
    // Automatisch erzeugte Auswertungsseiten (Klemmenplan, Kabelplan, …) enthalten nur Listeninhalte
    if (page.isReport) continue
    // Von oben nach unten, dann von links nach rechts (y wächst nach oben); sort ist stabil wie OrderBy
    const sorted = [...(byPage.get(page.name) ?? [])].sort((a, b) => b.y - a.y || a.x - b.x)
    sorted.forEach(add)
  }

  // Texte zu Seiten, die nicht in `pages` stehen (im .NET-Altstand nicht möglich): hinten, in Auftretensreihenfolge
  for (const text of texts) {
    if (!known.has(text.page) && isListed(text)) add(text)
  }
  return rows
}
