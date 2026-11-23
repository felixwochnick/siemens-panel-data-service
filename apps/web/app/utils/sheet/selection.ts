// Zellbereich der Tabellenansicht wie in Excel: Anker (Startzelle) und Fokus (aktive Zelle) in Anzeige-Koordinaten.
// Rein, ohne Vue, damit Vitest die Tastatur-Logik und die Kopie direkt prüfen kann.
import type { SheetColumn, SheetLine } from './model'

export interface CellPos {
  row: number
  col: number
}

export interface SheetSelection {
  anchor: CellPos
  focus: CellPos
  /**
   * Ganze Spalten markiert (Strg+Leertaste, Strg+A oder Klick auf die Ecke links oben). Nur dann kopiert Strg+C die
   * Kopfzeile mit: wer ganze Spalten nimmt, will sie meist woanders als Tabelle einfügen; ein Zellbereich dagegen
   * soll in bestehende Zeilen passen.
   */
  wholeColumns: boolean
}

export interface CellRange {
  top: number
  bottom: number
  left: number
  right: number
}

export function rangeOf(selection: SheetSelection): CellRange {
  const { anchor, focus } = selection
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    right: Math.max(anchor.col, focus.col),
  }
}

export function inRange(range: CellRange | null, row: number, col: number): boolean {
  return !!range && row >= range.top && row <= range.bottom && col >= range.left && col <= range.right
}

export function clampPos(pos: CellPos, rows: number, cols: number): CellPos {
  return {
    row: Math.max(0, Math.min(rows - 1, pos.row)),
    col: Math.max(0, Math.min(cols - 1, pos.col)),
  }
}

export function cellSelection(pos: CellPos): SheetSelection {
  return { anchor: { ...pos }, focus: { ...pos }, wholeColumns: false }
}

/** Alle Zellen (Kopie mit Kopfzeile) */
export function selectAll(rows: number, cols: number): SheetSelection {
  return { anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, rows - 1), col: Math.max(0, cols - 1) }, wholeColumns: true }
}

/** Die Spalten der Auswahl über alle Zeilen (Kopie mit Kopfzeile) */
export function selectColumns(selection: SheetSelection, rows: number): SheetSelection {
  const range = rangeOf(selection)
  return { anchor: { row: 0, col: range.left }, focus: { row: Math.max(0, rows - 1), col: range.right }, wholeColumns: true }
}

/** Die Zeilen der Auswahl über alle Spalten */
export function selectRows(selection: SheetSelection, cols: number): SheetSelection {
  const range = rangeOf(selection)
  return { anchor: { row: range.top, col: 0 }, focus: { row: range.bottom, col: Math.max(0, cols - 1) }, wholeColumns: false }
}

export const NAVIGATION_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const
export type NavigationKey = typeof NAVIGATION_KEYS[number]

export function isNavigationKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key)
}

/**
 * Neue aktive Zelle nach einer Taste: Pfeile ein Feld (mit Strg bis zum Rand), Pos1/Ende an den Zeilenanfang bzw.
 * das Zeilenende (mit Strg an den Tabellenanfang bzw. das Tabellenende), Bild auf/ab um `pageRows` Zeilen.
 */
export function moveFocus(pos: CellPos, key: NavigationKey, size: { rows: number, cols: number, pageRows: number }, ctrl = false): CellPos {
  const lastRow = Math.max(0, size.rows - 1)
  const lastCol = Math.max(0, size.cols - 1)
  let { row, col } = pos
  switch (key) {
    case 'ArrowUp':
      row = ctrl ? 0 : row - 1
      break
    case 'ArrowDown':
      row = ctrl ? lastRow : row + 1
      break
    case 'ArrowLeft':
      col = ctrl ? 0 : col - 1
      break
    case 'ArrowRight':
      col = ctrl ? lastCol : col + 1
      break
    case 'Home':
      col = 0
      if (ctrl) row = 0
      break
    case 'End':
      col = lastCol
      if (ctrl) row = lastRow
      break
    case 'PageUp':
      row -= Math.max(1, size.pageRows)
      break
    case 'PageDown':
      row += Math.max(1, size.pageRows)
      break
  }
  return clampPos({ row, col }, size.rows, size.cols)
}

/** Eine Zelle für die Zwischenablage (Excel-Format): mit Tabulator, Zeilenumbruch oder " in Anführungszeichen */
export function tsvCell(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Tabelle als TSV, wie Excel sie in die Zwischenablage legt (Zeilen mit CRLF getrennt) */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(tsvCell).join('\t')).join('\r\n')
}

/** Text des markierten Bereichs; mit Kopfzeile, wenn ganze Spalten markiert sind */
export function selectionText(lines: readonly SheetLine[], columns: readonly SheetColumn[], selection: SheetSelection): string {
  if (!lines.length || !columns.length) return ''
  const range = rangeOf(selection)
  const bottom = Math.min(range.bottom, lines.length - 1)
  const right = Math.min(range.right, columns.length - 1)
  const rows: string[][] = []
  if (selection.wholeColumns) rows.push(columns.slice(range.left, right + 1).map(column => column.label))
  for (let row = range.top; row <= bottom; row++) rows.push(lines[row]!.item.cells.slice(range.left, right + 1).map(cell => cell ?? ''))
  return toTsv(rows)
}

/** Anzahl markierter Zellen (für den Hinweis „3 × 2 markiert“) */
export function selectionSize(selection: SheetSelection, rows: number, cols: number): { rows: number, cols: number } {
  const range = rangeOf(selection)
  return {
    rows: Math.max(0, Math.min(range.bottom, rows - 1) - range.top + 1),
    cols: Math.max(0, Math.min(range.right, cols - 1) - range.left + 1),
  }
}
