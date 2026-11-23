import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSheet } from 'read-excel-file/node'
import { afterAll, describe, expect, it } from 'vitest'
import {
  autoFilterRange,
  columnWidths,
  csvCell,
  excelSheetName,
  exportFileName,
  toCsv,
  writeXlsx,
  xlsxCell,
} from '../../app/utils/sheet/export'

const dir = mkdtempSync(join(tmpdir(), 'pds-sheet-export-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const header = ['Seite', 'Quelle', 'Länge', '#-Markierung']
const rows = [
  ['=VB030+LCM&EFS/5', '=VB030+LCM-Q20:1', '5', 'ja'],
  ['=VB030+LCM&EFS/7', '-W10', '0,8 m', ''],
  ['+LCM', '@SUMME(A1)', '00123', ''],
]

/** Rohes XML einer Datei im .xlsx (ZIP) */
function xmlOf(file: string, entry: string): string {
  return execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8' })
}

describe('CSV', () => {
  it('schützt Werte, die wie Formeln beginnen, mit einem vorangestellten Apostroph', () => {
    expect(csvCell('=VB030+LCM-Q20:1')).toBe('\'=VB030+LCM-Q20:1')
    expect(csvCell('+LCM')).toBe('\'+LCM')
    expect(csvCell('-W10')).toBe('\'-W10')
    expect(csvCell('@SUMME(A1)')).toBe('\'@SUMME(A1)')
    expect(csvCell('\tx')).toBe('\'\tx')
    // Normale Werte bleiben unverändert, auch mit Zeichen in der Mitte
    expect(csvCell('X1:1+2')).toBe('X1:1+2')
    expect(csvCell('')).toBe('')
  })

  it('setzt Semikolon, Anführungszeichen und Zeilenumbrüche in Anführungszeichen', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('5" Rohr')).toBe('"5"" Rohr"')
    expect(csvCell('Zeile 1\nZeile 2')).toBe('"Zeile 1\nZeile 2"')
    expect(csvCell('=A;B')).toBe('"\'=A;B"')
  })

  it('UTF-8 mit BOM, Semikolon, CRLF', () => {
    const csv = toCsv(header, rows)
    expect(csv.startsWith('﻿Seite;Quelle;Länge;#-Markierung\r\n')).toBe(true)
    expect(csv.split('\r\n')[1]).toBe('\'=VB030+LCM&EFS/5;\'=VB030+LCM-Q20:1;5;ja')
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})

describe('xlsx', () => {
  it('Zellen sind Text mit Textformat, die Kopfzeile fett, leere Zellen leer', () => {
    expect(xlsxCell('=VB030')).toEqual({ value: '=VB030', type: String, format: '@' })
    expect(xlsxCell('Seite', true)).toEqual({ value: 'Seite', type: String, format: '@', fontWeight: 'bold' })
    expect(xlsxCell('')).toBeNull()
  })

  it('Formel-ähnliche Werte und Zahlen bleiben beim Einlesen Text', async () => {
    const file = join(dir, 'export.xlsx')
    writeFileSync(file, Buffer.from(await (await writeXlsx({ sheetName: 'Verbindungen', header, rows })).arrayBuffer()))

    const data = await readSheet(file)
    expect(data[0]).toEqual(header)
    expect(data[1]).toEqual(['=VB030+LCM&EFS/5', '=VB030+LCM-Q20:1', '5', 'ja'])
    expect(data[3]).toEqual(['+LCM', '@SUMME(A1)', '00123', null])
    for (const row of data) for (const cell of row) expect(cell === null || typeof cell === 'string').toBe(true)

    const sheet = xmlOf(file, 'xl/worksheets/sheet1.xml')
    // Keine Formeln, Kopfzeile fixiert, Autofilter über alle Zeilen und Spalten
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain('<autoFilter ref="A1:D4"/>')
    expect(sheet).toMatch(/<pane [^>]*ySplit="1"/)
    expect(sheet.indexOf('<autoFilter')).toBeGreaterThan(sheet.indexOf('</sheetData>'))
    const workbook = xmlOf(file, 'xl/workbook.xml')
    expect(workbook).toContain('name="Verbindungen"')
    expect(workbook).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'Verbindungen\'!$A$1:$D$4</definedName>')
    expect(workbook.indexOf('<definedNames>')).toBeGreaterThan(workbook.indexOf('</sheets>'))
  })

  it('leere Tabelle: nur Kopfzeile', async () => {
    const file = join(dir, 'empty.xlsx')
    writeFileSync(file, Buffer.from(await (await writeXlsx({ sheetName: 'Texte', header: ['Seite', 'Text'], rows: [] })).arrayBuffer()))
    expect(await readSheet(file)).toEqual([['Seite', 'Text']])
    expect(xmlOf(file, 'xl/worksheets/sheet1.xml')).toContain('<autoFilter ref="A1:B1"/>')
  })

  it('Spaltenbreiten, Blattname und Autofilter-Bereich', () => {
    expect(columnWidths(['Seite', 'X'], [['=VB030+LCM&EFS/5', ''], ['a', 'b']])).toEqual([18, 8])
    expect(columnWidths(['A'], [['x'.repeat(200)]])).toEqual([60])
    expect(excelSheetName('Kabel/Adern: [neu]?')).toBe('Kabel Adern neu')
    expect(excelSheetName('x'.repeat(40))).toHaveLength(31)
    expect(excelSheetName('[]')).toBe('Tabelle1')
    expect(autoFilterRange(14, 20)).toBe('A1:N21')
    expect(autoFilterRange(2, 0)).toBe('A1:B1')
  })
})

describe('Dateiname', () => {
  it('<Projekt>_<Tab>_<Analyse-Id> ohne unzulässige Zeichen', () => {
    expect(exportFileName('Anlage 1', 'Verbindungen', 42, 'xlsx')).toBe('Anlage 1_Verbindungen_42.xlsx')
    expect(exportFileName('Linie: 3/4 "neu"', 'Kabel', 7, 'csv')).toBe('Linie_ 3_4 _neu__Kabel_7.csv')
    expect(exportFileName('', 'Texte', 1, 'csv')).toBe('Projekt_Texte_1.csv')
  })
})
