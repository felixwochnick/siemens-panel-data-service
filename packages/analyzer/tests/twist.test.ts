import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze'
import { isTwistDesignation } from '../src/twist'
import { PAGE, connection, project, twistSymbol, wire } from './helpers'
import type { TwistSymbolOptions } from './helpers'

// Balken von (100, 50) nach (110, 50), Schrägstriche bei x = 103 und x = 107, Adern senkrecht durch die Schrägstriche
const symbolProject = (options: TwistSymbolOptions = {}, ticks = [3, 7], wiresAt = [103, 107]) => project({
  connections: wiresAt.map(x => wire(PAGE, [[x, 0], [x, 100]])),
  lines: twistSymbol(PAGE, 100, 50, ticks, options),
})

describe('Verdrillung über die Verbindungsbezeichnung', () => {
  it.each(['VD_X500', 'VD_F500_1', 'VD_a1', ' VD_X500 '])('erkennt %j', (designation) => {
    expect(isTwistDesignation(designation)).toBe(true)
  })

  it.each(['VD_500', 'VD_X500_', 'vd_X500', 'VD_XY500', 'VD_X500_1_2', 'XVD_X500', 'VD_X', ''])('erkennt %j nicht', (designation) => {
    expect(isTwistDesignation(designation)).toBe(false)
  })

  it('markiert die Verbindung und gibt die Bezeichnung ungetrimmt aus', () => {
    const result = analyze(project({ connections: [connection({ designation: ' VD_X500 ' }), connection({ designation: 'VD_500' })] }))
    expect(result.connections.map(c => [c.designation, c.twisted])).toEqual([[' VD_X500 ', true], ['VD_500', false]])
    expect(result.counts.twisted).toBe(1)
    expect(result.counts.twistSymbols).toBe(0)
  })
})

describe('Verdrillung über das gezeichnete Symbol', () => {
  it('erkennt Balken mit Haken an beiden Enden und zwei Schrägstrichen', () => {
    const result = analyze(symbolProject())
    expect(result.connections.map(c => c.twisted)).toEqual([true, true])
    expect(result.counts).toMatchObject({ twisted: 2, twistSymbols: 1, unmatchedTwistTicks: 0 })
    expect(result.notices).toEqual([])
  })

  it('erkennt auch einen senkrechten Balken', () => {
    const result = analyze(project({
      connections: [wire(PAGE, [[0, 53], [200, 53]]), wire(PAGE, [[0, 57], [200, 57]])],
      lines: twistSymbol(PAGE, 100, 50, [3, 7], { vertical: true }),
    }))
    expect(result.connections.map(c => c.twisted)).toEqual([true, true])
    expect(result.counts.twistSymbols).toBe(1)
  })

  it.each<[string, boolean, boolean]>([
    ['Anfang', false, true],
    ['Ende', true, false],
  ])('erkennt kein Symbol ohne Haken am %s', (_, hookStart, hookEnd) => {
    const result = analyze(symbolProject({ hooks: [hookStart, hookEnd] }))
    expect(result.connections.map(c => c.twisted)).toEqual([false, false])
    expect(result.counts.twistSymbols).toBe(0)
    expect(result.counts.unmatchedTwistTicks).toBe(0)
  })

  it('erkennt kein Symbol mit zu langen Haken (> 3 mm)', () => {
    expect(analyze(symbolProject({ hookLength: 3 })).counts.twistSymbols).toBe(1)
    expect(analyze(symbolProject({ hookLength: 3.5 })).counts.twistSymbols).toBe(0)
  })

  it('erkennt kein Symbol mit nur einem Schrägstrich', () => {
    const result = analyze(symbolProject({}, [3], [103]))
    expect(result.connections[0]?.twisted).toBe(false)
    expect(result.counts.twistSymbols).toBe(0)
  })

  it('verlangt einen Balken länger als 6 mm', () => {
    expect(analyze(symbolProject({ length: 6 }, [2, 4], [102, 104])).counts.twistSymbols).toBe(0)
    expect(analyze(symbolProject({ length: 6.5 }, [2, 4], [102, 104])).counts.twistSymbols).toBe(1)
  })

  it('zählt Schrägstriche nur bis 3 mm Länge', () => {
    expect(analyze(symbolProject({ tickHalf: 1.5 })).counts.twistSymbols).toBe(1)
    expect(analyze(symbolProject({ tickHalf: 1.6 })).counts.twistSymbols).toBe(0)
  })

  it('ordnet Adern bis 1 mm neben der Schrägstrich-Mitte zu und meldet Schrägstriche ohne Ader', () => {
    const result = analyze(symbolProject({}, [3, 7], [104, 108.1]))
    expect(result.connections.map(c => c.twisted)).toEqual([true, false])
    expect(result.counts.unmatchedTwistTicks).toBe(1)
    expect(result.notices).toEqual([{ level: 'warn', code: 'unmatched_twist_ticks', params: { count: 1 } }])
  })

  it('zählt eine Ader mit Symbol und Bezeichnung nur einmal', () => {
    const raw = symbolProject()
    raw.connections[0]!.designation = 'VD_X1'
    expect(analyze(raw).counts.twisted).toBe(2)
  })
})
