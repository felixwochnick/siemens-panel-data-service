import { describe, expect, it } from 'vitest'
import { arrangeLines } from '../../app/utils/sheet/model'
import type { SheetColumn, SheetItem } from '../../app/utils/sheet/model'
import {
  cellSelection,
  inRange,
  moveFocus,
  rangeOf,
  selectAll,
  selectColumns,
  selectionSize,
  selectionText,
  selectRows,
  toTsv,
  tsvCell,
} from '../../app/utils/sheet/selection'

const columns: SheetColumn[] = [
  { key: 'page', label: 'Seite' },
  { key: 'source', label: 'Quelle' },
  { key: 'text', label: 'Text' },
]
const items: SheetItem[] = [
  { key: 'a', cells: ['=VB030+LCM&EFS/5', '=VB030+LCM-X1:1', 'eins'] },
  { key: 'b', cells: ['=VB030+LCM&EFS/7', '-K1:A1', 'zwei\tSpalten'] },
  { key: 'c', cells: ['=VB030+LCM&EFS/8', '', 'Zeile 1\nZeile 2 mit "Zitat"'] },
]
const { lines } = arrangeLines(items, columns)

describe('Auswahl', () => {
  it('Anker und Fokus ergeben einen Bereich in beide Richtungen', () => {
    const selection = { anchor: { row: 2, col: 2 }, focus: { row: 0, col: 1 }, wholeColumns: false }
    expect(rangeOf(selection)).toEqual({ top: 0, bottom: 2, left: 1, right: 2 })
    expect(inRange(rangeOf(selection), 1, 1)).toBe(true)
    expect(inRange(rangeOf(selection), 1, 0)).toBe(false)
    expect(inRange(null, 0, 0)).toBe(false)
    expect(selectionSize(selection, 3, 3)).toEqual({ rows: 3, cols: 2 })
  })

  it('Tastatur wie in Excel: Pfeile, Strg+Pfeil, Pos1/Ende, Bild auf/ab, an den Rändern begrenzt', () => {
    const size = { rows: 100, cols: 5, pageRows: 20 }
    const at = { row: 10, col: 2 }
    expect(moveFocus(at, 'ArrowDown', size)).toEqual({ row: 11, col: 2 })
    expect(moveFocus(at, 'ArrowUp', size)).toEqual({ row: 9, col: 2 })
    expect(moveFocus(at, 'ArrowLeft', size)).toEqual({ row: 10, col: 1 })
    expect(moveFocus(at, 'ArrowRight', size)).toEqual({ row: 10, col: 3 })
    expect(moveFocus(at, 'ArrowDown', size, true)).toEqual({ row: 99, col: 2 })
    expect(moveFocus(at, 'ArrowLeft', size, true)).toEqual({ row: 10, col: 0 })
    expect(moveFocus(at, 'Home', size)).toEqual({ row: 10, col: 0 })
    expect(moveFocus(at, 'End', size, true)).toEqual({ row: 99, col: 4 })
    expect(moveFocus(at, 'Home', size, true)).toEqual({ row: 0, col: 0 })
    expect(moveFocus(at, 'PageDown', size)).toEqual({ row: 30, col: 2 })
    expect(moveFocus(at, 'PageUp', size)).toEqual({ row: 0, col: 2 })
    expect(moveFocus({ row: 0, col: 0 }, 'ArrowUp', size)).toEqual({ row: 0, col: 0 })
    expect(moveFocus({ row: 99, col: 4 }, 'ArrowRight', size)).toEqual({ row: 99, col: 4 })
  })

  it('ganze Spalten, ganze Zeilen und alles', () => {
    const cell = cellSelection({ row: 1, col: 1 })
    expect(selectColumns(cell, 3)).toEqual({ anchor: { row: 0, col: 1 }, focus: { row: 2, col: 1 }, wholeColumns: true })
    expect(selectRows(cell, 3)).toEqual({ anchor: { row: 1, col: 0 }, focus: { row: 1, col: 2 }, wholeColumns: false })
    expect(selectAll(3, 3)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 }, wholeColumns: true })
  })
})

describe('Kopieren als TSV', () => {
  it('Zellen mit Tabulator, Zeilenumbruch oder Anführungszeichen stehen in Anführungszeichen (wie Excel)', () => {
    expect(tsvCell('=VB030+LCM-X1:1')).toBe('=VB030+LCM-X1:1')
    expect(tsvCell('a\tb')).toBe('"a\tb"')
    expect(tsvCell('a\nb')).toBe('"a\nb"')
    expect(tsvCell('5" Rohr')).toBe('"5"" Rohr"')
    expect(toTsv([['a', 'b'], ['', 'c']])).toBe('a\tb\r\n\tc')
  })

  it('ein Zellbereich ohne Kopfzeile', () => {
    expect(selectionText(lines, columns, cellSelection({ row: 0, col: 1 }))).toBe('=VB030+LCM-X1:1')
    const range = { anchor: { row: 0, col: 1 }, focus: { row: 2, col: 2 }, wholeColumns: false }
    expect(selectionText(lines, columns, range)).toBe([
      '=VB030+LCM-X1:1\teins',
      '-K1:A1\t"zwei\tSpalten"',
      '\t"Zeile 1\nZeile 2 mit ""Zitat"""',
    ].join('\r\n'))
  })

  it('ganze Spalten mit Kopfzeile', () => {
    expect(selectionText(lines, columns, selectColumns(cellSelection({ row: 1, col: 0 }), lines.length))).toBe([
      'Seite',
      '=VB030+LCM&EFS/5',
      '=VB030+LCM&EFS/7',
      '=VB030+LCM&EFS/8',
    ].join('\r\n'))
    expect(selectionText(lines, columns, selectAll(lines.length, columns.length)).split('\r\n')[0]).toBe('Seite\tQuelle\tText')
  })

  it('Bereiche außerhalb der Tabelle werden begrenzt, leere Tabelle ergibt leeren Text', () => {
    expect(selectionText(lines, columns, { anchor: { row: 2, col: 0 }, focus: { row: 9, col: 0 }, wholeColumns: false })).toBe('=VB030+LCM&EFS/8')
    expect(selectionText([], columns, selectAll(0, 3))).toBe('')
  })
})
