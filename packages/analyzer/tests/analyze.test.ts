import { describe, expect, it } from 'vitest'
import { analyze, parseRawProject } from '../src'
import sample from '../fixtures/sample-raw.json'
import { PAGE, project, shield, text, twistSymbol } from './helpers'

const P5 = '=VB030+LCM&EFS/5'
const P7 = '=VB030+LCM&EFS/7'
const P8 = '=VB030+LCM&EFS/8'
const P9 = '=VB030+LCM&EFS/9'
const DT = '=VB030+LCM'

describe('analyze: Projekt ohne Verbindungen', () => {
  it('liefert leere Ergebnisse ohne Seiten', () => {
    expect(analyze(project({ pages: [] }))).toEqual({
      connections: [],
      cables: [],
      shields: [],
      texts: [],
      counts: {
        connections: 0, hashMarks: 0, unmatchedHashMarks: 0, twisted: 0, twistSymbols: 0, unmatchedTwistTicks: 0,
        shielded: 0, shields: 0, cables: 0, texts: 0, pages: 0,
      },
      notices: [],
    })
  })

  it('wertet Zeichnung und Texte auch ohne Verbindungen aus', () => {
    const result = analyze(project({
      texts: [text(PAGE, '#', 10, 10), text(PAGE, 'Hinweis', 10, 50)],
      lines: twistSymbol(PAGE, 100, 50, [3, 7]),
      shields: [shield(PAGE, 50, 50, 0, 20, 2)],
    }))
    expect(result.connections).toEqual([])
    expect(result.shields).toEqual([{ idx: 0, page: PAGE, name: 'Abschirmung', type: '', wireCountAndCrossSection: '', connectionIdx: [] }])
    expect(result.texts).toEqual([{ idx: 0, page: PAGE, text: 'Hinweis' }])
    expect(result.counts).toMatchObject({ unmatchedHashMarks: 1, twistSymbols: 1, unmatchedTwistTicks: 2, shields: 1, texts: 1, pages: 1 })
    expect(result.notices.map(n => n.code)).toEqual(['unmatched_hash_marks', 'unmatched_twist_ticks'])
  })
})

describe('analyze: Fixture sample-raw.json', () => {
  const result = analyze(parseRawProject(sample))

  it('zählt wie erwartet', () => {
    expect(result.counts).toEqual({
      connections: 20,
      hashMarks: 1,
      unmatchedHashMarks: 0,
      twisted: 4,
      twistSymbols: 1,
      unmatchedTwistTicks: 1,
      shielded: 4,
      shields: 2,
      cables: 5,
      texts: 8,
      pages: 5,
    })
    expect(result.notices).toEqual([{ level: 'warn', code: 'unmatched_twist_ticks', params: { count: 1 } }])
  })

  it('bildet die Verbindungen (ohne 3D) mit Quelle, Ziel und Merkmalen', () => {
    const W10 = `${DT}-W10`
    const W20 = `${DT}-W20`
    const W21 = `${DT}-W21`
    // [eplanId, Quelle, Ziel, Kabel, #, verdrillt, abgeschirmt]
    expect(result.connections.map(c => [c.idx, c.eplanId, c.source, c.destination, c.cable, c.hashMark, c.twisted, c.shielded])).toEqual([
      [0, '16/4101/0', `${DT}-X1:1:B`, `${DT}-Q1:1/L1`, '', true, false, false],
      [1, '16/4102/0', `${DT}-X1:2:B`, `${DT}-Q1:3/L2`, '', false, false, false],
      [2, '16/4103/0', `${DT}-X1:3:B`, `${DT}-Q1:5/L3`, '', false, false, false],
      [3, '16/4104/0', `${DT}-X1:PE:B`, `${DT}-XPE:1`, '', false, false, false],
      [4, '16/4105/0', `${DT}-Q1:2/T1`, `${DT}-K1:1/L1`, '', false, false, false],
      [5, '16/4106/0', `${DT}-K1:2/T1`, `${DT}-M1:U1`, W10, false, false, false],
      [6, '16/4107/0', `${DT}-K1:4/T2`, `${DT}-M1:V1`, W10, false, false, false],
      [7, '16/4108/0', `${DT}-XPE:2`, `${DT}-M1:PE`, W10, false, false, false],
      [8, '16/4201/0', `${DT}-X2:1:B`, `${DT}-K1:A1`, '', false, false, false],
      [9, '16/4202/0', `${DT}-K1:A2`, `${DT}-X2:2:B`, '', false, false, false],
      [10, '16/4203/0', `${DT}-A1-B150:X531:1`, `${DT}-X2:3:A`, '', false, false, false],
      [11, '16/4204/0', `${DT}-A1-B150:X531:2`, `${DT}-X2:4:A`, '', false, false, false],
      [12, '16/4205/0', `${DT}-K530:12`, `${DT}-X2:5:A`, '', false, false, false],
      [13, '16/4206/0', `${DT}-X2:6:B`, '', '', false, false, false],
      [14, '16/4301/0', `${DT}-B1:1`, `${DT}-A2:X11:2`, W20, false, true, true],
      [15, '16/4302/0', `${DT}-B1:2`, `${DT}-A2:X11:3`, W20, false, true, true],
      [16, '16/4303/0', `${DT}-SH1:1`, `${DT}-XPE:3`, '', false, false, false],
      [17, '16/4304/0', `${DT}-B2:1`, `${DT}-A2:X11:4`, W21, false, true, true],
      [18, '16/4305/0', `${DT}-B2:2`, `${DT}-A2:X11:5`, W21, false, true, true],
      [19, '16/4401/0', `${DT}-E1:PE`, `${DT}-XPE:4`, `${DT}-W5`, false, false, false],
    ])
  })

  it('übernimmt alle Spalten einer Verbindung', () => {
    expect(result.connections[14]).toEqual({
      idx: 14,
      eplanId: '16/4301/0',
      page: P8,
      definition: 'Ader / Draht',
      designation: 'VD_X500',
      source: `${DT}-B1:1`,
      destination: `${DT}-A2:X11:2`,
      cable: `${DT}-W20`,
      wireNumber: 'WH',
      crossSection: '0,5 mm²',
      wireType: 'LiYCY',
      length: '',
      partNumbers: '',
      hashMark: false,
      twisted: true,
      shielded: true,
    })
    expect(result.connections[10]?.partNumbers).toBe('PXC.3044076')
    expect(result.connections[19]?.partNumbers).toBe('LAPP.4520014')
  })

  it('findet Schirmsymbol und GSC-Kabel ohne Schirmanschluss', () => {
    expect(result.shields).toEqual([
      { idx: 0, page: P8, name: `${DT}-SH1`, type: '', wireCountAndCrossSection: '', connectionIdx: [14, 15] },
      { idx: 1, page: P8, name: `${DT}-W21`, type: 'GSC-01', wireCountAndCrossSection: '2x0,22', connectionIdx: [17, 18] },
    ])
  })

  it('listet Kabel und Schirme einmal, mit Adern und genauer Quelle/Ziel', () => {
    expect(result.cables.map(c => [c.idx, c.kind, c.name, c.page, c.source, c.destination, c.wires.map(w => w.connectionIdx)])).toEqual([
      [0, 'cable', `${DT}-W10`, P5, `${DT}-K1`, `${DT}-M1`, [5, 6, 7, null]],
      [1, 'cable', `${DT}-W20`, P8, `${DT}-B1`, `${DT}-A2`, [14, 15]],
      [2, 'shield', `${DT}-SH1`, P8, '', '', [16]],
      [3, 'cable', `${DT}-W21`, P8, `${DT}-B2`, `${DT}-A2`, [17, 18]],
      [4, 'cable', `${DT}-W5`, P9, `${DT}-XPE:4`, `${DT}-E1:PE`, [19]],
    ])
    expect(result.cables[0]).toMatchObject({
      definition: 'Kabeldefinition',
      type: 'ÖLFLEX CLASSIC 110',
      wireCountAndCrossSection: '3G1,5',
      length: '5 m',
      partNumbers: 'LAPP.1119303',
    })
    expect(result.cables[0]?.wires[3]).toEqual({
      idx: 3,
      connectionIdx: null,
      definition: '',
      page: '',
      source: `${DT}-K1:2/T1`,
      destination: `${DT}-M1:U1`,
      length: '',
      wireNumber: '',
      crossSection: '',
      partNumbers: '',
    })
  })

  it('listet die freien Texte je Seite von oben nach unten', () => {
    expect(result.texts).toEqual([
      { idx: 0, page: P5, text: 'Einspeisung 400 V AC' },
      { idx: 1, page: P5, text: '# = kurzschlusssichere Verlegung' },
      { idx: 2, page: P7, text: 'Steuerspannung 24 V DC' },
      { idx: 3, page: P7, text: 'Klemme X2:6 Reserve' },
      { idx: 4, page: P7, text: 'Brücke X2:1–X2:2 bauseits' },
      { idx: 5, page: P8, text: 'Analogsignale Sensoren' },
      { idx: 6, page: P8, text: 'Schirm beidseitig auflegen' },
      { idx: 7, page: P9, text: 'Erdung Gehäuse' },
    ])
  })
})
