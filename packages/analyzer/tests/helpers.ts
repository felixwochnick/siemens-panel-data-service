// Kleine Bausteine für synthetische Rohdaten; Standardwerte wie vom Worker bei leeren Eigenschaften ("")
import type {
  RawCableDefinition,
  RawConnection,
  RawLine,
  RawPage,
  RawPin,
  RawProject,
  RawShield,
  RawSymbolEnd,
  RawText,
} from '../src/types'

export const PAGE = '=A1+B1&EFS/1'

let nextId = 0

export function pin(functionName: string, pinName = '', over: Partial<RawPin> = {}): RawPin {
  return {
    functionName,
    pinName,
    pinDesignation: '',
    plugAutomatic: '',
    plugManual: '',
    parentIsShield: false,
    ...over,
  }
}

export function connection(over: Partial<RawConnection> = {}): RawConnection {
  nextId++
  return {
    id: `c${nextId}`,
    is3d: false,
    page: PAGE,
    definition: 'Ader / Draht',
    designation: '',
    sourceProperty: '',
    destinationProperty: '',
    wireNumber: '',
    crossSection: '',
    wireType: '',
    length: '',
    partNumbers: [],
    cable: null,
    start: pin('=A1-K1', '1'),
    end: pin('=A1-K2', '1'),
    shieldings: [],
    symbols: [],
    startSymbol: null,
    endSymbol: null,
    ...over,
  }
}

/** Verbindung, deren Leitungsweg die Punkte auf einer Seite verbindet (ohne Gerätesymbole an den Enden) */
export function wire(page: string, points: [number, number][], over: Partial<RawConnection> = {}): RawConnection {
  return connection({ page, symbols: points.map(([x, y]) => ({ page, x, y })), ...over })
}

export function symbolEnd(page: string, x: number, y: number, pinX: number, pinY: number): RawSymbolEnd {
  return { page, x, y, pinX, pinY }
}

/** Text mit Rahmen 1,5 mm breit je Zeichen und 2,5 mm hoch ab dem Einfügepunkt */
export function text(page: string, content: string, x: number, y: number, over: Partial<RawText> = {}): RawText {
  const width = 1.5 * content.length
  return {
    page,
    content,
    x,
    y,
    box: [[x, y], [x + width, y], [x + width, y + 2.5], [x, y + 2.5]],
    free: true,
    ...over,
  }
}

export function line(page: string, x1: number, y1: number, x2: number, y2: number): RawLine {
  return { page, x1, y1, x2, y2 }
}

export interface TwistSymbolOptions {
  /** Länge des Balkens in mm */
  length?: number
  /** Haken an Anfang/Ende des Balkens */
  hooks?: [boolean, boolean]
  /** Länge der Haken in mm */
  hookLength?: number
  /** Halbe Ausdehnung der Schrägstriche je Achse (Länge = 2 × half) */
  tickHalf?: number
  /** Balken senkrecht statt waagerecht */
  vertical?: boolean
}

/**
 * Gezeichnetes Verdrillungssymbol: Balken ab (x, y), Haken nach unten (bzw. links) an beiden Enden, je Ader ein
 * Schrägstrich (45°), dessen Mitte an der Position `ticks` (Abstand vom Balkenanfang) auf dem Balken liegt.
 */
export function twistSymbol(page: string, x: number, y: number, ticks: number[], options: TwistSymbolOptions = {}): RawLine[] {
  const length = options.length ?? 10
  const [hookStart, hookEnd] = options.hooks ?? [true, true]
  const hookLength = options.hookLength ?? 2
  const half = options.tickHalf ?? 1
  if (options.vertical) {
    const lines = [line(page, x, y, x, y + length)]
    if (hookStart) lines.push(line(page, x, y, x - hookLength, y))
    if (hookEnd) lines.push(line(page, x, y + length, x - hookLength, y + length))
    for (const t of ticks) lines.push(line(page, x - half, y + t - half, x + half, y + t + half))
    return lines
  }
  const lines = [line(page, x, y, x + length, y)]
  if (hookStart) lines.push(line(page, x, y, x, y - hookLength))
  if (hookEnd) lines.push(line(page, x + length, y, x + length, y - hookLength))
  for (const t of ticks) lines.push(line(page, x + t - half, y - half, x + t + half, y + half))
  return lines
}

export function shield(page: string, x: number, y: number, variant: number, width: number | null, height: number | null, name = ''): RawShield {
  return { page, name, x, y, variant, width, height }
}

export function cableDefinition(over: Partial<RawCableDefinition> = {}): RawCableDefinition {
  return {
    page: PAGE,
    kind: 'cable',
    name: '-W1',
    x: 0,
    y: 0,
    definition: 'Kabeldefinition',
    sourceProperty: '',
    destinationProperty: '',
    type: '',
    wireCountAndCrossSection: '',
    length: '',
    partNumbers: [],
    wires: [],
    ...over,
  }
}

export function project(over: Partial<RawProject> = {}): RawProject {
  const pages: RawPage[] = over.pages ?? [{ name: PAGE, isReport: false }]
  return {
    format: 1,
    worker: 'test',
    eplanVersion: '2025.0.3',
    project: { name: 'Test', pageCount: pages.length },
    pages,
    connections: [],
    texts: [],
    lines: [],
    shields: [],
    cableDefinitions: [],
    ...over,
  }
}
