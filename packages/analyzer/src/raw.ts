// Prüfung der Rohdaten des Workers (raw.json, Format 1) gegen den Vertrag in types.ts. Handgeschrieben, damit das
// Paket ohne Abhängigkeiten bleibt; der erste fehlerhafte Pfad steht im Fehler (z. B. connections[3].start.pinName).
import { RAW_FORMAT } from './types'
import type { RawProject } from './types'

/** Fehler der Auswertung mit Code (übersetzt in der App unter errors.<code>) */
export class AnalyzerError extends Error {
  constructor(public readonly code: string, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'AnalyzerError'
  }
}

type Check = (value: unknown, path: string) => void

function fail(path: string): never {
  throw new AnalyzerError('raw_invalid', path)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const string: Check = (value, path) => {
  if (typeof value !== 'string') fail(path)
}

const boolean: Check = (value, path) => {
  if (typeof value !== 'boolean') fail(path)
}

// JSON kennt kein NaN/Infinity; ein bereits geparstes Objekt könnte sie trotzdem enthalten
const number: Check = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path)
}

const nullable = (check: Check): Check => (value, path) => {
  if (value !== null) check(value, path)
}

const oneOf = (...allowed: unknown[]): Check => (value, path) => {
  if (!allowed.includes(value)) fail(path)
}

const array = (item: Check): Check => (value, path) => {
  if (!Array.isArray(value)) fail(path)
  value.forEach((entry, index) => item(entry, `${path}[${index}]`))
}

/** Tupel fester Länge, z. B. Ecke [x, y] */
const tuple = (...items: Check[]): Check => (value, path) => {
  if (!Array.isArray(value) || value.length !== items.length) fail(path)
  items.forEach((item, index) => item(value[index], `${path}[${index}]`))
}

/** Objekt mit den Feldern in Vertragsreihenfolge; zusätzliche Felder sind erlaubt */
const object = (fields: Record<string, Check>): Check => (value, path) => {
  if (!isRecord(value)) fail(path)
  for (const [key, check] of Object.entries(fields)) {
    check(value[key], path ? `${path}.${key}` : key)
  }
}

const pagePoint = { page: string, x: number, y: number }

const pin = object({
  functionName: string,
  pinName: string,
  pinDesignation: string,
  plugAutomatic: string,
  plugManual: string,
  parentIsShield: boolean,
})

const symbolEnd = object({ ...pagePoint, pinX: number, pinY: number })

const connection = object({
  id: string,
  is3d: boolean,
  page: string,
  definition: string,
  designation: string,
  sourceProperty: string,
  destinationProperty: string,
  wireNumber: string,
  crossSection: string,
  wireType: string,
  length: string,
  partNumbers: array(string),
  cable: nullable(object({ name: string, type: string, wireCountAndCrossSection: string })),
  start: nullable(pin),
  end: nullable(pin),
  shieldings: array(object({ ...pagePoint, name: string })),
  symbols: array(object(pagePoint)),
  startSymbol: nullable(symbolEnd),
  endSymbol: nullable(symbolEnd),
})

const rawProject = object({
  format: oneOf(RAW_FORMAT),
  worker: string,
  eplanVersion: string,
  project: object({ name: string, pageCount: number }),
  pages: array(object({ name: string, isReport: boolean })),
  connections: array(connection),
  texts: array(object({ ...pagePoint, content: string, box: array(tuple(number, number)), free: boolean })),
  lines: array(object({ page: string, x1: number, y1: number, x2: number, y2: number })),
  shields: array(object({ ...pagePoint, name: string, variant: number, width: nullable(number), height: nullable(number) })),
  cableDefinitions: array(object({
    ...pagePoint,
    kind: oneOf('cable', 'shield'),
    name: string,
    definition: string,
    sourceProperty: string,
    destinationProperty: string,
    type: string,
    wireCountAndCrossSection: string,
    length: string,
    partNumbers: array(string),
    wires: array(string),
  })),
})

/**
 * Prüft Struktur und Typen aller Felder; wirft AnalyzerError('raw_invalid', '<pfad>') beim ersten Fehler
 * ('$' = Wurzel). Gibt dasselbe Objekt zurück (keine Kopie, Rohdaten können groß sein).
 */
export function parseRawProject(json: unknown): RawProject {
  if (!isRecord(json)) fail('$')
  rawProject(json, '')
  return json as unknown as RawProject
}
