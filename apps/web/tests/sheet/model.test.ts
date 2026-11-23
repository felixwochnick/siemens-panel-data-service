import { describe, expect, it } from 'vitest'
import { arrangeLines, clampWidth, compareCells, countItems, fitColumnWidth, matchesItem, sortItems } from '../../app/utils/sheet/model'
import type { SheetColumn, SheetItem } from '../../app/utils/sheet/model'

const columns: SheetColumn[] = [
  { key: 'page', label: 'Seite' },
  { key: 'source', label: 'Quelle' },
  { key: 'twisted', label: 'Verdrillung', kind: 'flag' },
]

const item = (key: string, ...cells: string[]): SheetItem => ({ key, cells })
const keys = (lines: { item: SheetItem }[]) => lines.map(line => line.item.key)
const itemKeys = (items: readonly SheetItem[]) => items.map(entry => entry.key)

const rows = [
  item('a', '=VB030+LCM&EFS/10', '=VB030+LCM-X2:10', ''),
  item('b', '=VB030+LCM&EFS/9', '=VB030+LCM-X2:9', 'ja'),
  item('c', '=VB030+LCM&EFS/9', '', 'ja'),
  item('d', '=VB030+LCM&EFS/2', '=vb030+lcm-x2:2', ''),
]

describe('Sortierung', () => {
  it('sortiert natürlich (9 vor 10) und ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(compareCells('X2:9', 'X2:10')).toBeLessThan(0)
    expect(compareCells('a', 'B')).toBeLessThan(0)
    expect(compareCells('ä', 'b')).toBeLessThan(0)
    expect(keys(arrangeLines(rows, columns, { sort: { column: 0, direction: 'asc' } }).lines)).toEqual(['d', 'b', 'c', 'a'])
    expect(keys(arrangeLines(rows, columns, { sort: { column: 0, direction: 'desc' } }).lines)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leere Werte stehen in beiden Richtungen am Ende, gleiche Werte behalten ihre Reihenfolge', () => {
    expect(itemKeys(sortItems(rows, { column: 1, direction: 'asc' }))).toEqual(['d', 'b', 'a', 'c'])
    expect(itemKeys(sortItems(rows, { column: 1, direction: 'desc' }))).toEqual(['a', 'b', 'd', 'c'])
    // stabil: b und c haben dieselbe Seite
    expect(itemKeys(sortItems(rows, { column: 0, direction: 'desc' }))).toEqual(['a', 'b', 'c', 'd'])
    expect(itemKeys(sortItems(rows, null))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sortiert je Liste und Sortierung nur einmal (Filter ändern die Reihenfolge nicht)', () => {
    const first = sortItems(rows, { column: 1, direction: 'asc' })
    expect(sortItems(rows, { column: 1, direction: 'asc' })).toBe(first)
    expect(sortItems(rows, { column: 1, direction: 'desc' })).not.toBe(first)
    expect(sortItems([...rows], { column: 1, direction: 'asc' })).not.toBe(first)
    // Die Eingabe bleibt unverändert
    expect(itemKeys(rows)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('Filter und Suche', () => {
  it('Textfilter „enthält“ ohne Groß-/Kleinschreibung, mehrere Filter mit UND', () => {
    expect(keys(arrangeLines(rows, columns, { filters: { 1: 'X2:1' } }).lines)).toEqual(['a'])
    expect(keys(arrangeLines(rows, columns, { filters: { 1: 'lcm-X2' } }).lines)).toEqual(['a', 'b', 'd'])
    expect(keys(arrangeLines(rows, columns, { filters: { 0: 'efs/9', 1: 'x2' } }).lines)).toEqual(['b'])
    // Leerzeichen am Rand zählen nicht, leerer Filter = kein Filter
    expect(keys(arrangeLines(rows, columns, { filters: { 1: '  ', 0: ' EFS/2 ' } }).lines)).toEqual(['d'])
  })

  it('ja/nein-Spalten filtern nach gesetzt bzw. leer', () => {
    expect(keys(arrangeLines(rows, columns, { filters: { 2: 'yes' } }).lines)).toEqual(['b', 'c'])
    expect(keys(arrangeLines(rows, columns, { filters: { 2: 'no' } }).lines)).toEqual(['a', 'd'])
    // „ja“ als Text ist bei einer flag-Spalte kein gültiger Filter
    expect(keys(arrangeLines(rows, columns, { filters: { 2: 'ja' } }).lines)).toHaveLength(4)
  })

  it('Suche über alle Spalten', () => {
    expect(matchesItem(rows[1]!, columns, {}, 'JA')).toBe(true)
    expect(keys(arrangeLines(rows, columns, { search: 'x2:9' }).lines)).toEqual(['b'])
    expect(keys(arrangeLines(rows, columns, { search: '&efs/' }).lines)).toHaveLength(4)
    expect(arrangeLines(rows, columns, { search: 'gibt es nicht' })).toEqual({ lines: [], matched: 0, total: 4 })
  })
})

describe('Baumzeilen (Kabel mit Adern)', () => {
  const cables: SheetItem[] = [
    { key: 'k1', cells: ['-W10', 'ÖLFLEX', ''], children: [item('k1w0', '-W10', '', 'X1:2'), item('k1w1', '-W10', '', 'X1:10')] },
    { key: 'k2', cells: ['-W2', 'LiYCY', ''], children: [item('k2w0', '-W2', '', 'B1:1')] },
  ]
  const cableColumns: SheetColumn[] = [{ key: 'name', label: 'Kabel' }, { key: 'type', label: 'Typ' }, { key: 'source', label: 'Quelle' }]

  it('zeigt Kinder unter ihrer Hauptzeile und zählt alle Zeilen', () => {
    const result = arrangeLines(cables, cableColumns)
    expect(keys(result.lines)).toEqual(['k1', 'k1w0', 'k1w1', 'k2', 'k2w0'])
    expect(result.lines.map(line => line.depth)).toEqual([0, 1, 1, 0, 1])
    expect(result.lines[1]!.parent).toBe('k1')
    expect(result.lines[0]!.expandable).toBe(true)
    expect(result).toMatchObject({ matched: 5, total: 5 })
    expect(countItems(cables)).toBe(5)
  })

  it('sortiert Hauptzeilen und Kinder je Hauptzeile nach derselben Spalte', () => {
    const result = arrangeLines(cables, cableColumns, { sort: { column: 0, direction: 'asc' } })
    expect(keys(result.lines)).toEqual(['k2', 'k2w0', 'k1', 'k1w0', 'k1w1'])
    const bySource = arrangeLines(cables, cableColumns, { sort: { column: 2, direction: 'desc' } })
    expect(keys(bySource.lines)).toEqual(['k1', 'k1w1', 'k1w0', 'k2', 'k2w0'])
  })

  it('eine passende Ader bringt ihre Hauptzeile mit; Kinder erscheinen nur, wenn sie selbst passen', () => {
    expect(keys(arrangeLines(cables, cableColumns, { search: 'x1:10' }).lines)).toEqual(['k1', 'k1w1'])
    // Typ steht nur in der Kabelzeile: wie in Excel bleiben die Adern dann ausgeblendet
    expect(keys(arrangeLines(cables, cableColumns, { filters: { 1: 'liycy' } }).lines)).toEqual(['k2'])
    // Kabel steht auch in den Aderzeilen: Filter nach Kabel zeigt alles darunter
    expect(arrangeLines(cables, cableColumns, { filters: { 0: '-w2' } })).toMatchObject({ matched: 2, total: 5 })
  })

  it('zugeklappte Hauptzeilen verbergen ihre Kinder, die trotzdem als Treffer zählen', () => {
    const result = arrangeLines(cables, cableColumns, { collapsed: new Set(['k1']) })
    expect(keys(result.lines)).toEqual(['k1', 'k2', 'k2w0'])
    expect(result.matched).toBe(5)
  })
})

describe('Spaltenbreite', () => {
  it('passt die Breite an den längsten Wert an und bleibt in Grenzen', () => {
    expect(fitColumnWidth('Seite', ['=VB030+LCM&EFS/5'])).toBeGreaterThan(fitColumnWidth('Seite', ['5']))
    expect(fitColumnWidth('A', ['x'.repeat(500)])).toBe(800)
    expect(clampWidth(10)).toBe(48)
    expect(clampWidth(Number.NaN)).toBe(160)
  })
})

describe('Leistung', () => {
  it('filtert und sortiert 20 000 Zeilen schnell', () => {
    const many = Array.from({ length: 20_000 }, (_, index) => item(`r${index}`, `=VB030+LCM&EFS/${index % 200}`, `=VB030+LCM-X${index}:1`, index % 3 ? '' : 'ja'))
    const start = performance.now()
    const result = arrangeLines(many, columns, { filters: { 2: 'yes' }, search: 'lcm-x1', sort: { column: 1, direction: 'desc' } })
    expect(result.matched).toBeGreaterThan(1000)
    expect(performance.now() - start).toBeLessThan(1500)
  })
})
