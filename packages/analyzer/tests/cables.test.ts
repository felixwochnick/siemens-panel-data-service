import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze'
import { PAGE, cableDefinition, connection, pin, project } from './helpers'

const P2 = '=A1+B1&EFS/2'

describe('Kabel', () => {
  it('gibt jedes Kabel nur einmal aus (nach Name, ohne Name nach Seite und Lage)', () => {
    const result = analyze(project({
      cableDefinitions: [
        cableDefinition({ name: '-W1', page: PAGE }),
        cableDefinition({ name: '-W1', page: P2 }),
        cableDefinition({ name: '', page: PAGE, x: 1, y: 2 }),
        cableDefinition({ name: '', page: PAGE, x: 1, y: 2 }),
        cableDefinition({ name: '', page: PAGE, x: 3, y: 2 }),
        cableDefinition({ name: '', page: P2, x: 1, y: 2 }),
      ],
    }))
    expect(result.cables.map(c => [c.idx, c.name, c.page])).toEqual([
      [0, '-W1', PAGE],
      [1, '', PAGE],
      [2, '', PAGE],
      [3, '', P2],
    ])
    expect(result.counts.cables).toBe(4)
  })

  it('übernimmt die Werte der Kabeldefinition', () => {
    const result = analyze(project({
      cableDefinitions: [cableDefinition({
        kind: 'shield',
        name: '-W2',
        definition: 'Abschirmung, Kabeldefinition',
        sourceProperty: '=A1-K1',
        destinationProperty: '=A1-K2',
        type: 'ÖLFLEX 110',
        wireCountAndCrossSection: '3G1,5',
        length: '12 m',
        partNumbers: ['LAPP.1119303', '', 'LAPP.1119303', 'SIE.1'],
      })],
    }))
    expect(result.cables).toEqual([{
      idx: 0,
      kind: 'shield',
      name: '-W2',
      definition: 'Abschirmung, Kabeldefinition',
      page: PAGE,
      source: '=A1-K1',
      destination: '=A1-K2',
      type: 'ÖLFLEX 110',
      wireCountAndCrossSection: '3G1,5',
      length: '12 m',
      partNumbers: 'LAPP.1119303, SIE.1',
      wires: [],
    }])
  })

  it('löst Adern über ihre id auf, auch 3D-Verbindungen, und meldet unbekannte ids', () => {
    const plain = connection({ id: 'a' })
    const w1 = connection({
      id: 'w1',
      page: P2,
      definition: 'Ader / Draht',
      start: pin('=A1-K1', '13'),
      destinationProperty: '=A1-X1:4',
      length: '1,2 m',
      wireNumber: 'BN',
      crossSection: '0,75 mm²',
      partNumbers: ['P1', 'P1'],
    })
    const w3d = connection({ id: 'w3d', is3d: true, page: '', definition: '', start: pin('=A1-K1', '14'), end: null })
    const result = analyze(project({
      connections: [plain, w3d, w1],
      cableDefinitions: [cableDefinition({ name: '-W3', wires: ['w1', 'missing', 'w3d'] })],
    }))
    expect(result.connections.map(c => c.eplanId)).toEqual(['a', 'w1'])
    expect(result.cables[0]?.wires).toEqual([
      {
        idx: 0,
        connectionIdx: 1,
        definition: 'Ader / Draht',
        page: P2,
        source: '=A1-K1:13',
        destination: '=A1-X1:4',
        length: '1,2 m',
        wireNumber: 'BN',
        crossSection: '0,75 mm²',
        partNumbers: 'P1',
      },
      {
        idx: 1,
        connectionIdx: null,
        definition: '',
        page: '',
        source: '=A1-K1:14',
        destination: '',
        length: '',
        wireNumber: '',
        crossSection: '',
        partNumbers: '',
      },
    ])
    expect(result.notices).toEqual([{ level: 'warn', code: 'wire_not_found', params: { cable: '-W3', id: 'missing' } }])
  })

  it('nummeriert die Adern je Kabel ab 0', () => {
    const a = connection({ id: 'a' })
    const b = connection({ id: 'b' })
    const result = analyze(project({
      connections: [a, b],
      cableDefinitions: [cableDefinition({ name: '-W1', wires: ['a', 'b'] }), cableDefinition({ name: '-W2', wires: ['b'] })],
    }))
    expect(result.cables.map(c => c.wires.map(w => [w.idx, w.connectionIdx]))).toEqual([[[0, 0], [1, 1]], [[0, 1]]])
  })
})

describe('Quelle/Ziel des Kabels mit Anschluss (Precise)', () => {
  const cableWith = (source: string, destination: string, wires: Array<[string, string]>) => {
    const connections = wires.map(([from, to], i) => connection({ id: `w${i}`, sourceProperty: from, destinationProperty: to }))
    const result = analyze(project({
      connections,
      cableDefinitions: [cableDefinition({ sourceProperty: source, destinationProperty: destination, wires: connections.map(c => c.id) })],
    }))
    return [result.cables[0]?.source, result.cables[0]?.destination]
  }

  it('ergänzt den Anschluss, wenn alle Adern am Gerät am selben Anschluss enden', () => {
    expect(cableWith('=A1-K1', '=A1-X1', [['=A1-K1:CH1', '=A1-X1:1'], ['=A1-K1:CH1', '=A1-X1:1']]))
      .toEqual(['=A1-K1:CH1', '=A1-X1:1'])
  })

  it('lässt das Gerät stehen, wenn die Adern an mehreren Anschlüssen enden', () => {
    expect(cableWith('=A1-K1', '=A1-X1', [['=A1-K1:CH1', '=A1-X1:1'], ['=A1-K1:CH1', '=A1-X1:2']]))
      .toEqual(['=A1-K1:CH1', '=A1-X1'])
  })

  it('sucht auf der anderen Aderseite, wenn die gleichnamige keinen Treffer hat', () => {
    expect(cableWith('=A1-K1', '=A1-X1', [['=A1-X1:7', '=A1-K1:CH2']])).toEqual(['=A1-K1:CH2', '=A1-X1:7'])
  })

  it('vergleicht das Gerät mit Doppelpunkt (kein Präfix eines anderen Geräts)', () => {
    expect(cableWith('=A1-K1', '=A1-X1', [['=A1-K10:1', '=A1-X10:1']])).toEqual(['=A1-K1', '=A1-X1'])
  })

  it('bleibt leer ohne Quelle/Ziel an der Kabeldefinition', () => {
    expect(cableWith('', '', [['=A1-K1:1', '=A1-X1:1']])).toEqual(['', ''])
  })

  it('nimmt Quelle/Ziel der Adern aus den Anschlüssen, wenn die Eigenschaften leer sind', () => {
    const w = connection({ id: 'w', start: pin('=A1-K1', 'CH1'), end: pin('=A1-X1:3', 'B') })
    const result = analyze(project({
      connections: [w],
      cableDefinitions: [cableDefinition({ sourceProperty: '=A1-K1', destinationProperty: '=A1-X1', wires: ['w'] })],
    }))
    expect([result.cables[0]?.source, result.cables[0]?.destination]).toEqual(['=A1-K1:CH1', '=A1-X1:3:B'])
  })
})
