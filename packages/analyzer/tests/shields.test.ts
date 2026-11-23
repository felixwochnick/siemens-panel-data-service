import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze'
import { PAGE, connection, pin, project, shield, wire } from './helpers'

const P2 = '=A1+B1&EFS/2'

// Probeleitungen um den Schirmpunkt (100, 50): senkrecht rechts/links, waagerecht darüber/darunter
const probes = () => [
  wire(PAGE, [[110, 0], [110, 100]]),
  wire(PAGE, [[90, 0], [90, 100]]),
  wire(PAGE, [[0, 51], [200, 51]]),
  wire(PAGE, [[0, 49], [200, 49]]),
]

describe('Schirme', () => {
  it.each<[string, number, number[]]>([
    ['0 (rechts)', 0, [0, 2, 3]],
    ['1 (oben)', 1, [0, 1, 2]],
    ['2 (links)', 2, [1, 2, 3]],
    ['3 (unten)', 3, [0, 1, 3]],
    ['4 (gespiegelt, beide Seiten)', 4, [0, 1, 2, 3]],
    ['7 (gespiegelt, beide Seiten)', 7, [0, 1, 2, 3]],
  ])('schneidet die Fläche der Variante %s', (_, variant, expected) => {
    const result = analyze(project({ connections: probes(), shields: [shield(PAGE, 100, 50, variant, 20, 2, '-SH1')] }))
    expect(result.shields).toEqual([
      { idx: 0, page: PAGE, name: '-SH1', type: '', wireCountAndCrossSection: '', connectionIdx: expected },
    ])
    expect(result.connections.map(c => c.shielded)).toEqual([0, 1, 2, 3].map(i => expected.includes(i)))
    expect(result.counts.shielded).toBe(expected.length)
    expect(result.counts.shields).toBe(1)
  })

  it.each<[string, number, number | null, number | null]>([
    ['ohne Breite', 0, null, 2],
    ['ohne Höhe', 0, 20, null],
    ['mit unlesbarer Variante', -1, 20, 2],
  ])('legt den Schirm %s ohne Fläche an', (_, variant, width, height) => {
    const result = analyze(project({ connections: probes(), shields: [shield(PAGE, 100, 50, variant, width, height)] }))
    expect(result.shields).toEqual([
      { idx: 0, page: PAGE, name: 'Abschirmung', type: '', wireCountAndCrossSection: '', connectionIdx: [] },
    ])
    expect(result.counts).toMatchObject({ shields: 1, shielded: 0 })
  })

  it('ordnet Adern logisch über Shieldings zu und fasst sie mit dem Symbol zusammen', () => {
    const result = analyze(project({
      connections: [
        connection({ shieldings: [{ page: PAGE, x: 300.001, y: 40, name: '' }] }),
        wire(PAGE, [[310, 0], [310, 100]]),
        connection({ shieldings: [{ page: PAGE, x: 299.996, y: 40.004, name: '-SH9' }] }),
      ],
      shields: [shield(PAGE, 300.004, 40, 0, 20, 2, '-SH9')],
    }))
    // Erste Zuordnung bestimmt den Namen; die Lage zählt auf 2 Stellen gerundet
    expect(result.shields).toEqual([
      { idx: 0, page: PAGE, name: 'Abschirmung', type: '', wireCountAndCrossSection: '', connectionIdx: [0, 1, 2] },
    ])
  })

  it('rundet die Lage wie .NET (Mitte zur geraden Zahl)', () => {
    const result = analyze(project({
      connections: [connection({ shieldings: [{ page: PAGE, x: 0.125, y: 0, name: '-SH1' }] })],
      shields: [shield(PAGE, 0.12, 0, 0, null, null, '-SH1')],
    }))
    expect(result.shields).toHaveLength(1)
  })

  it('fasst Adern geschirmter Kabel (Typ GSC…) zusammen', () => {
    const gsc = { name: '-W5', type: 'gsc-01', wireCountAndCrossSection: '2x0,5' }
    const result = analyze(project({
      pages: [{ name: PAGE, isReport: false }, { name: P2, isReport: false }],
      connections: [
        connection({ page: P2, cable: gsc }),
        connection({ cable: { name: '-W6', type: 'LiYY', wireCountAndCrossSection: '4x0,25' } }),
        connection({ page: PAGE, cable: { ...gsc, type: 'GSC-99' } }),
      ],
    }))
    expect(result.shields).toEqual([
      { idx: 0, page: P2, name: '-W5', type: 'gsc-01', wireCountAndCrossSection: '2x0,5', connectionIdx: [0, 2] },
    ])
    expect(result.connections.map(c => c.shielded)).toEqual([true, false, true])
  })

  it('entfernt Schirmanschlüsse und Einträge ohne Anschlüsse', () => {
    const across = (over: Parameters<typeof connection>[0]) => wire(PAGE, [[110, 0], [110, 100]], over)
    const gsc = { name: '-W7', type: 'GSC', wireCountAndCrossSection: '' }
    const result = analyze(project({
      connections: [
        across({}),
        across({ start: null, end: null }),
        across({ start: pin('-SH1', '1', { parentIsShield: true }) }),
        across({ end: pin('-SH1', '1', { parentIsShield: true }) }),
        across({ start: null }),
        connection({ cable: gsc, start: null, end: null }),
        connection({ cable: gsc }),
      ],
      shields: [shield(PAGE, 100, 50, 0, 20, 2, '-SH1')],
    }))
    expect(result.shields.map(s => [s.name, s.connectionIdx])).toEqual([['-SH1', [0, 4]], ['-W7', [6]]])
    expect(result.connections.map(c => c.shielded)).toEqual([true, false, false, false, true, false, true])
  })

  it('sortiert nach Seite (Ordinal, stabil)', () => {
    const result = analyze(project({
      shields: [
        shield('=A1/2', 0, 0, 0, null, null, 'S1'),
        shield('a', 0, 0, 0, null, null, 'S2'),
        shield('=A1/10', 0, 0, 0, null, null, 'S3'),
        shield('=A1/2', 10, 0, 0, null, null, 'S4'),
        shield('B', 0, 0, 0, null, null, 'S5'),
      ],
    }))
    expect(result.shields.map(s => [s.idx, s.page, s.name])).toEqual([
      [0, '=A1/10', 'S3'],
      [1, '=A1/2', 'S1'],
      [2, '=A1/2', 'S4'],
      [3, 'B', 'S5'],
      [4, 'a', 'S2'],
    ])
  })
})
