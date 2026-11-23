// Export der Tabellenansicht als .xlsx (write-excel-file) oder CSV – im Browser und in Node-Tests nutzbar.
// Alle Werte sind Text: Kennzeichen wie `=VB030+LCM-Q20:1` dürfen nie als Formel ausgewertet werden.
import writeXlsxFile from 'write-excel-file/universal'
import type { Cell, Feature } from 'write-excel-file/universal'
import { getCellAddress, getOrderOfSiblings, insertElementMarkupAccordingToOrderOfSiblings, sanitizeTextContent } from 'write-excel-file/utility'

const BOM = '﻿'

/** Zeichen, mit denen Tabellenprogramme eine Formel beginnen (CSV-/Formel-Injektion) */
const FORMULA_START = /^[=+\-@\t\r]/

export interface SheetExport {
  /** Name des Tabellenblatts (wird gekürzt und bereinigt) */
  sheetName: string
  header: string[]
  rows: string[][]
}

/**
 * Eine CSV-Zelle. Werte, die mit = + - @ (oder Tabulator/Wagenrücklauf) beginnen, bekommen ein ' davor: Excel und
 * LibreOffice führen sie so nicht als Formel aus, das Kennzeichen bleibt lesbar (`'=VB030+LCM-Q20:1`). Wer die Werte
 * ohne Zeichen davor braucht, nimmt den .xlsx-Export (dort sind alle Zellen echte Textzellen).
 */
export function csvCell(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** CSV für Excel: Semikolon, CRLF, UTF-8 mit BOM (sonst liest deutsches Excel Umlaute und Spalten falsch) */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return BOM + [header, ...rows].map(row => `${row.map(csvCell).join(';')}\r\n`).join('')
}

/** Zelle für write-excel-file: immer Text mit Zahlenformat '@' (auch beim späteren Bearbeiten bleibt es Text) */
export function xlsxCell(text: string, header = false): Cell {
  if (!text) return null
  return { value: text, type: String, format: '@', ...(header ? { fontWeight: 'bold' as const } : {}) }
}

/** Spaltenbreiten in Zeichen: längster Wert (Stichprobe), mindestens 8, höchstens 60 */
export function columnWidths(header: readonly string[], rows: readonly (readonly string[])[], sample = 5000): number[] {
  return header.map((label, index) => {
    let longest = label.length + 2
    const count = Math.min(rows.length, sample)
    for (let row = 0; row < count; row++) longest = Math.max(longest, rows[row]![index]?.length ?? 0)
    return Math.min(60, Math.max(8, longest + 2))
  })
}

/** Excel erlaubt höchstens 31 Zeichen und keines von []:*?/\ im Namen eines Tabellenblatts */
export function excelSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s']+|[\s']+$/g, '').slice(0, 31).trim()
  return cleaned || 'Tabelle1'
}

/** Bereich des Autofilters: Kopfzeile bis letzte Zeile, alle Spalten (z. B. A1:N21) */
export function autoFilterRange(columns: number, rows: number): string {
  return `${getCellAddress(0, 0)}:${getCellAddress(Math.max(0, rows), Math.max(0, columns - 1))}`
}

/**
 * Autofilter in der Kopfzeile (write-excel-file kennt ihn nicht): `<autoFilter>` im Tabellenblatt und der versteckte
 * Name `_xlnm._FilterDatabase`, den Excel für gefilterte Bereiche erwartet.
 */
export function autoFilterFeature(sheetName: string, ref: string): Feature<Blob> {
  const absolute = ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')
  const quoted = `'${sheetName.replaceAll('\'', '\'\'')}'`
  return {
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform: (xml, _options, { sheetIndex }) => sheetIndex !== 0
            ? xml
            : insertElementMarkupAccordingToOrderOfSiblings(xml, `<autoFilter ref="${ref}"/>`, getOrderOfSiblings('xl/worksheets/sheet{id}.xml', 'worksheet')!, 'worksheet'),
        },
        'xl/workbook.xml': {
          transform: xml => insertElementMarkupAccordingToOrderOfSiblings(
            xml,
            `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${sanitizeTextContent(`${quoted}!${absolute}`)}</definedName></definedNames>`,
            getOrderOfSiblings('xl/workbook.xml', 'workbook')!,
            'workbook',
          ),
        },
      },
    },
  }
}

/** .xlsx mit einer Tabelle: Kopfzeile fett, fixiert und mit Autofilter, alle Werte als Text, passende Breiten */
export function writeXlsx(sheet: SheetExport): Promise<Blob> {
  const name = excelSheetName(sheet.sheetName)
  const data: Cell[][] = [
    sheet.header.map(label => xlsxCell(label, true)),
    ...sheet.rows.map(row => sheet.header.map((_, index) => xlsxCell(row[index] ?? ''))),
  ]
  return writeXlsxFile(data, {
    sheet: name,
    columns: columnWidths(sheet.header, sheet.rows).map(width => ({ width })),
    stickyRowsCount: 1,
  }, {
    features: [autoFilterFeature(name, autoFilterRange(sheet.header.length, sheet.rows.length))],
  }).toBlob()
}

export function csvBlob(sheet: SheetExport): Blob {
  return new Blob([toCsv(sheet.header, sheet.rows)], { type: 'text/csv;charset=utf-8' })
}

/** Dateiname `<Projekt>_<Tab>_<Analyse-Id>.<Endung>`; Zeichen, die Windows nicht erlaubt, werden zu _ */
export function exportFileName(project: string, tab: string, analysisId: number, extension: 'xlsx' | 'csv'): string {
  // eslint-disable-next-line no-control-regex
  const clean = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Projekt'
  return `${clean(project)}_${clean(tab)}_${analysisId}.${extension}`
}

/** Datei im Browser herunterladen (nur Browser) */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Erst nach dem Start des Downloads freigeben, manche Browser brechen ihn sonst ab
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
