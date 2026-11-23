// Reine Hilfen der Tabellenansicht (DataSheet): Filter, Suche, natürliche Sortierung und Baumzeilen (Kabel mit
// Adern). Ohne Vue/Nuxt, damit Vitest sie direkt prüfen kann. Alle Werte sind Text – so wie sie angezeigt, kopiert und
// exportiert werden.

/** Spalte der Tabellenansicht */
export interface SheetColumn {
  key: string
  label: string
  /** flag: Ja/Nein-Spalte (Text „ja“ bzw. leer), Filter als Auswahl ja/nein/alle */
  kind?: 'text' | 'flag'
  /** Breite in Pixeln (Standard DEFAULT_COLUMN_WIDTH) */
  width?: number
}

/** Zeile der Tabelle: Text je Spalte, optional Kindzeilen (Adern eines Kabels oder Schirms) */
export interface SheetItem {
  /** stabiler Schlüssel, z. B. `c12` (Auswahl, Sprungziel, Auf-/Zuklappen) */
  key: string
  cells: string[]
  children?: SheetItem[]
}

/** Filter je Spalte (Index → Wert): Text „enthält“ bzw. bei flag-Spalten 'yes'/'no'; fehlt/leer = kein Filter */
export type ColumnFilters = Record<number, string | undefined>

export interface SortState {
  column: number
  direction: 'asc' | 'desc'
}

/** Angezeigte Zeile: Element mit Tiefe (0 = Hauptzeile, 1 = Kindzeile) */
export interface SheetLine {
  item: SheetItem
  depth: 0 | 1
  /** Schlüssel der Hauptzeile (nur bei Kindzeilen) */
  parent?: string
  /** Hauptzeile mit Kindzeilen (aufklappbar) */
  expandable: boolean
}

export interface ArrangeOptions {
  filters?: ColumnFilters
  search?: string
  sort?: SortState | null
  /** zugeklappte Hauptzeilen (ihre Kinder werden nicht angezeigt, zählen aber als Treffer) */
  collapsed?: ReadonlySet<string>
}

export interface Arranged {
  lines: SheetLine[]
  /** Zeilen, die zu Filter und Suche passen (Haupt- und Kindzeilen, unabhängig vom Zuklappen) */
  matched: number
  /** alle Zeilen (Haupt- und Kindzeilen) */
  total: number
}

export const DEFAULT_COLUMN_WIDTH = 160
export const MIN_COLUMN_WIDTH = 48
export const MAX_COLUMN_WIDTH = 800

// Natürliche Sortierung wie `a.localeCompare(b, 'de', { numeric: true })`: „X2:10“ nach „X2:9“, ohne Rücksicht auf
// Groß-/Kleinschreibung. Ein Collator ist bei 20 000 Zeilen deutlich schneller als localeCompare je Vergleich.
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

/** Vergleich für die Sortierung; leere Werte stehen in beiden Richtungen am Ende (wie in Excel) */
export function compareCells(a: string, b: string, direction: 'asc' | 'desc' = 'asc'): number {
  if (!a || !b) return a === b ? 0 : a ? -1 : 1
  const result = collator.compare(a, b)
  return direction === 'asc' ? result : -result
}

const lowered = new WeakMap<SheetItem, string[]>()

/** Kleingeschriebene Zellen (zwischengespeichert, damit Tippen in Filtern auch bei 20 000 Zeilen flüssig bleibt) */
function lowerCells(item: SheetItem): string[] {
  let cells = lowered.get(item)
  if (!cells) {
    cells = item.cells.map(normalizeText)
    lowered.set(item, cells)
  }
  return cells
}

export function normalizeText(text: string): string {
  return text.toLocaleLowerCase('de')
}

/** Aktive Filter als Liste (Index, Art, Suchtext); leere fallen weg */
function activeFilters(columns: readonly SheetColumn[], filters: ColumnFilters = {}) {
  const result: { index: number, flag: boolean, value: string }[] = []
  for (const [key, raw] of Object.entries(filters)) {
    const index = Number(key)
    const column = columns[index]
    const value = raw?.trim() ?? ''
    if (!column || !value) continue
    const flag = column.kind === 'flag'
    if (flag && value !== 'yes' && value !== 'no') continue
    result.push({ index, flag, value: flag ? value : normalizeText(value) })
  }
  return result
}

/** Passt die Zeile zu allen Spaltenfiltern und zur Suche (über alle Spalten)? */
export function matchesItem(item: SheetItem, columns: readonly SheetColumn[], filters: ColumnFilters = {}, search = ''): boolean {
  return makeMatcher(columns, filters, search)(item)
}

function makeMatcher(columns: readonly SheetColumn[], filters: ColumnFilters = {}, search = '') {
  const active = activeFilters(columns, filters)
  const needle = normalizeText(search.trim())
  if (!active.length && !needle) return () => true
  return (item: SheetItem) => {
    const cells = lowerCells(item)
    for (const filter of active) {
      const cell = cells[filter.index] ?? ''
      if (filter.flag ? (filter.value === 'yes') !== (cell !== '') : !cell.includes(filter.value)) return false
    }
    return !needle || cells.some(cell => cell.includes(needle))
  }
}

// Sortierte Reihenfolge je Liste und Sortierung: Filter und Suche ändern sich beim Tippen, die Sortierung nicht – so
// wird eine Liste mit 20 000 Zeilen nur einmal je Klick auf die Kopfzeile sortiert
const sortCache = new WeakMap<readonly SheetItem[], Map<string, readonly SheetItem[]>>()

/** Stabil sortiert (gleiche Werte behalten ihre Reihenfolge); ohne Sortierung die Liste selbst */
export function sortItems(items: readonly SheetItem[], sort: SortState | null | undefined): readonly SheetItem[] {
  if (!sort) return items
  let cache = sortCache.get(items)
  if (!cache) sortCache.set(items, cache = new Map())
  const key = `${sort.column}:${sort.direction}`
  let sorted = cache.get(key)
  if (!sorted) {
    sorted = items
      .map((item, index) => ({ item, index, value: item.cells[sort.column] ?? '' }))
      .sort((a, b) => compareCells(a.value, b.value, sort.direction) || a.index - b.index)
      .map(entry => entry.item)
    cache.set(key, sorted)
  }
  return sorted
}

/**
 * Zeilen für die Anzeige: filtern, suchen, sortieren, Kinder unter ihre Hauptzeile. Eine Hauptzeile erscheint, wenn
 * sie selbst oder eine ihrer Kindzeilen passt; Kindzeilen erscheinen nur, wenn sie selbst passen (wie der Autofilter
 * in Excel) und die Hauptzeile aufgeklappt ist. Kinder werden innerhalb ihrer Hauptzeile nach derselben Spalte
 * sortiert.
 */
export function arrangeLines(items: readonly SheetItem[], columns: readonly SheetColumn[], options: ArrangeOptions = {}): Arranged {
  const matches = makeMatcher(columns, options.filters, options.search)
  const lines: SheetLine[] = []
  let matched = 0
  let total = 0
  for (const item of sortItems(items, options.sort)) {
    const children = item.children ?? []
    total += 1 + children.length
    const selfMatch = matches(item)
    const childMatches = children.length ? sortItems(children, options.sort).filter(matches) : []
    if (!selfMatch && !childMatches.length) continue
    // Eine Hauptzeile, die nur wegen ihrer Kinder erscheint, zählt mit (sie steht ja in der Liste)
    matched += 1 + childMatches.length
    lines.push({ item, depth: 0, expandable: children.length > 0 })
    if (options.collapsed?.has(item.key)) continue
    for (const child of childMatches) lines.push({ item: child, depth: 1, parent: item.key, expandable: false })
  }
  return { lines, matched, total }
}

/** Anzahl aller Zeilen (Haupt- und Kindzeilen) */
export function countItems(items: readonly SheetItem[]): number {
  return items.reduce((sum, item) => sum + 1 + (item.children?.length ?? 0), 0)
}

/** Breite einer Spalte für ihren Inhalt (Doppelklick auf den Rand): grobe Schätzung über die Zeichenzahl */
export function fitColumnWidth(label: string, values: Iterable<string>, charWidth = 7.5, padding = 28, sample = 5000): number {
  let longest = label.length + 3
  let seen = 0
  for (const value of values) {
    if (value.length > longest) longest = value.length
    if (++seen >= sample) break
  }
  return clampWidth(Math.round(longest * charWidth + padding))
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTH
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
}
