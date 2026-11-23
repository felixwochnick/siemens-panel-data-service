import { describe, expect, it } from 'vitest'
import { AnalyzerError, parseRawProject } from '../src/raw'
import sample from '../fixtures/sample-raw.json'
import { cableDefinition, connection, line, pin, project, shield, symbolEnd, text } from './helpers'

/** Vollständiges Projekt mit jedem Feldtyp; als JSON-Kopie, damit Tests es verändern können */
function valid(): Record<string, unknown> {
  const raw = project({
    connections: [
      connection({ id: 'a', start: null, end: null }),
      connection({ id: 'b', cable: { name: '-W1', type: 'GSC-01', wireCountAndCrossSection: '2x1' } }),
      connection({ id: 'c', is3d: true, partNumbers: ['P1'] }),
      connection({
        id: 'd',
        start: pin('-K1', '1', { pinDesignation: '1', plugAutomatic: 'X1', plugManual: 'X2', parentIsShield: true }),
        shieldings: [{ page: 'p', x: 1, y: 2, name: '-SH1' }],
        symbols: [{ page: 'p', x: 1, y: 2 }],
        startSymbol: symbolEnd('p', 1, 2, 3, 4),
        endSymbol: symbolEnd('p', 5, 6, 0, 0),
      }),
    ],
    texts: [text('p', '#', 1, 2), text('p', 'x', 1, 2, { box: [], free: false })],
    lines: [line('p', 0, 0, 10, 0)],
    shields: [shield('p', 1, 2, 0, 12.5, 4), shield('p', 1, 2, -1, null, null)],
    cableDefinitions: [cableDefinition({ wires: ['b'], partNumbers: ['P2'] }), cableDefinition({ kind: 'shield' })],
  })
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
}

function invalidPath(json: unknown): string | undefined {
  try {
    parseRawProject(json)
  }
  catch (error) {
    expect(error).toBeInstanceOf(AnalyzerError)
    expect((error as AnalyzerError).code).toBe('raw_invalid')
    return (error as AnalyzerError).detail
  }
  return undefined
}

/** Ändert einen Wert über einen Pfad wie `connections.3.start.pinName` (undefined löscht ihn) */
function withValue(path: string, value: unknown): Record<string, unknown> {
  const raw = valid()
  const keys = path.split('.')
  const last = keys.pop()!
  let target = raw as Record<string, unknown>
  for (const key of keys) target = target[key] as Record<string, unknown>
  if (value === undefined) Reflect.deleteProperty(target, last)
  else target[last] = value
  return raw
}

describe('parseRawProject', () => {
  it('nimmt gültige Rohdaten unverändert an', () => {
    const raw = valid()
    expect(parseRawProject(raw)).toEqual(raw)
  })

  it('nimmt die Fixture an', () => {
    expect(() => parseRawProject(sample)).not.toThrow()
  })

  it('lässt zusätzliche Felder zu (Erweiterungen des Workers)', () => {
    expect(() => parseRawProject({ ...valid(), extra: 1 })).not.toThrow()
  })

  it.each([null, [], 'raw', 1])('lehnt %j als Wurzel ab', (json) => {
    expect(invalidPath(json)).toBe('$')
  })

  it.each([2, '1', undefined])('verlangt format 1 (nicht %j)', (format) => {
    expect(invalidPath(withValue('format', format))).toBe('format')
  })

  it('meldet einen falschen Typ mit Pfad und Meldung', () => {
    expect(() => parseRawProject(withValue('connections.3.start.pinName', 1)))
      .toThrowError(new AnalyzerError('raw_invalid', 'connections[3].start.pinName'))
  })

  it.each<[string, unknown, string]>([
    ['worker', undefined, 'worker'],
    ['project.pageCount', '3', 'project.pageCount'],
    ['project', null, 'project'],
    ['pages', {}, 'pages'],
    ['pages.0.isReport', 'false', 'pages[0].isReport'],
    ['connections.0.is3d', 0, 'connections[0].is3d'],
    ['connections.0.start', undefined, 'connections[0].start'],
    ['connections.1.cable.type', null, 'connections[1].cable.type'],
    ['connections.2.partNumbers.0', 7, 'connections[2].partNumbers[0]'],
    ['connections.3.start.parentIsShield', 'ja', 'connections[3].start.parentIsShield'],
    ['connections.3.shieldings.0.x', '1', 'connections[3].shieldings[0].x'],
    ['connections.3.symbols.0.page', null, 'connections[3].symbols[0].page'],
    ['connections.3.startSymbol.pinX', undefined, 'connections[3].startSymbol.pinX'],
    ['connections.3.endSymbol.y', Number.NaN, 'connections[3].endSymbol.y'],
    ['texts.0.box.1', [1], 'texts[0].box[1]'],
    ['texts.0.box.2.1', 'a', 'texts[0].box[2][1]'],
    ['texts.1.free', 1, 'texts[1].free'],
    ['lines.0.x2', Number.POSITIVE_INFINITY, 'lines[0].x2'],
    ['shields.0.width', '12', 'shields[0].width'],
    ['shields.1.variant', null, 'shields[1].variant'],
    ['cableDefinitions.0.kind', 'wire', 'cableDefinitions[0].kind'],
    ['cableDefinitions.1.wires', ['b', 1], 'cableDefinitions[1].wires[1]'],
  ])('meldet %s = %j als %s', (path, value, expected) => {
    expect(invalidPath(withValue(path, value))).toBe(expected)
  })

  it('meldet den ersten fehlerhaften Pfad', () => {
    const raw = withValue('connections.2.id', 3)
    ;(raw.texts as Array<Record<string, unknown>>)[0]!.content = null
    expect(invalidPath(raw)).toBe('connections[2].id')
  })
})
