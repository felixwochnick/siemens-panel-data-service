import { describe, expect, it } from 'vitest'
import { boxFromCorners, buildRouteIndex, connectionSegments, intersects, markIntersecting } from '../src/geometry'
import type { PageBox } from '../src/geometry'
import { connection, symbolEnd, wire } from './helpers'

const P1 = '=A1/1'
const P2 = '=A1/2'

describe('connectionSegments', () => {
  it('verbindet benachbarte Punkte derselben Seite', () => {
    const c = wire(P1, [[0, 0], [0, 10], [20, 10]])
    expect(connectionSegments(c)).toEqual([
      { page: P1, a: { x: 0, y: 0 }, b: { x: 0, y: 10 } },
      { page: P1, a: { x: 0, y: 10 }, b: { x: 20, y: 10 } },
    ])
  })

  it('bildet keinen Abschnitt über einen Seitenwechsel', () => {
    const c = connection({
      symbols: [
        { page: P1, x: 0, y: 0 }, { page: P1, x: 0, y: 10 },
        { page: P2, x: 50, y: 10 }, { page: P2, x: 50, y: 30 },
      ],
    })
    expect(connectionSegments(c)).toEqual([
      { page: P1, a: { x: 0, y: 0 }, b: { x: 0, y: 10 } },
      { page: P2, a: { x: 50, y: 10 }, b: { x: 50, y: 30 } },
    ])
  })

  it('bildet ohne Seite (leerer Name) keinen Abschnitt', () => {
    const c = connection({ symbols: [{ page: '', x: 0, y: 0 }, { page: '', x: 0, y: 10 }] })
    expect(connectionSegments(c)).toEqual([])
  })

  it('verschiebt nur den ersten Punkt des Startsymbols um den Anschlusspunkt', () => {
    const c = connection({
      symbols: [{ page: P1, x: 10, y: 20 }, { page: P1, x: 10, y: 40 }, { page: P1, x: 10, y: 20 }],
      startSymbol: symbolEnd(P1, 10, 20, 2, -4),
    })
    const segments = connectionSegments(c)
    expect(segments[0]?.a).toEqual({ x: 12, y: 16 })
    expect(segments[1]?.b).toEqual({ x: 10, y: 20 })
  })

  it('verschiebt jeden Punkt des Endsymbols', () => {
    const c = connection({
      symbols: [{ page: P1, x: 30, y: 20 }, { page: P1, x: 10, y: 40 }, { page: P1, x: 30, y: 20 }],
      endSymbol: symbolEnd(P1, 30, 20, 0, 5),
    })
    const segments = connectionSegments(c)
    expect(segments[0]?.a).toEqual({ x: 30, y: 25 })
    expect(segments[1]?.b).toEqual({ x: 30, y: 25 })
  })

  it('nimmt bei gleicher Lage zuerst das Startsymbol, danach das Endsymbol', () => {
    const c = connection({
      symbols: [{ page: P1, x: 10, y: 20 }, { page: P1, x: 10, y: 40 }, { page: P1, x: 10, y: 20 }],
      startSymbol: symbolEnd(P1, 10, 20, 1, 0),
      endSymbol: symbolEnd(P1, 10, 20, 3, 0),
    })
    const segments = connectionSegments(c)
    expect(segments[0]?.a).toEqual({ x: 11, y: 20 })
    expect(segments[1]?.b).toEqual({ x: 13, y: 20 })
  })

  it('vergleicht die Lage mit Toleranz < 0,01 und die Seite exakt', () => {
    const near = connection({
      symbols: [{ page: P1, x: 10.005, y: 20 }, { page: P1, x: 10, y: 40 }],
      startSymbol: symbolEnd(P1, 10, 20, 1, 0),
    })
    expect(connectionSegments(near)[0]?.a.x).toBeCloseTo(11.005, 9)

    const far = connection({
      symbols: [{ page: P1, x: 10.02, y: 20 }, { page: P1, x: 10, y: 40 }],
      startSymbol: symbolEnd(P1, 10, 20, 1, 0),
    })
    expect(connectionSegments(far)[0]?.a).toEqual({ x: 10.02, y: 20 })

    const otherPage = connection({
      symbols: [{ page: P1, x: 10, y: 20 }, { page: P1, x: 10, y: 40 }],
      startSymbol: symbolEnd(P2, 10, 20, 1, 0),
    })
    expect(connectionSegments(otherPage)[0]?.a).toEqual({ x: 10, y: 20 })
  })
})

describe('PageBox', () => {
  it('bildet das Rechteck aus den Ecken plus Rand', () => {
    expect(boxFromCorners([{ x: 5, y: 1 }, { x: 2, y: 4 }], 1)).toEqual({ minX: 1, minY: 0, maxX: 6, maxY: 5, matched: false })
  })

  it('schneidet Abschnitte einschließlich des Rands', () => {
    const box: PageBox = { minX: 0, minY: 0, maxX: 10, maxY: 10, matched: false }
    expect(intersects(box, { page: P1, a: { x: 10, y: -5 }, b: { x: 10, y: 20 } })).toBe(true)
    expect(intersects(box, { page: P1, a: { x: 10.001, y: -5 }, b: { x: 10.001, y: 20 } })).toBe(false)
    expect(intersects(box, { page: P1, a: { x: -5, y: 5 }, b: { x: 20, y: 5 } })).toBe(true)
    expect(intersects(box, { page: P1, a: { x: 11, y: 5 }, b: { x: 20, y: 5 } })).toBe(false)
  })
})

describe('markIntersecting', () => {
  it('markiert Verbindungen und Rechtecke nur auf derselben Seite', () => {
    const connections = [
      wire(P1, [[5, 0], [5, 50]]),
      wire(P2, [[5, 0], [5, 50]]),
      wire(P1, [[30, 0], [30, 50]]),
    ]
    const hit: PageBox = { minX: 4, minY: 10, maxX: 6, maxY: 12, matched: false }
    const miss: PageBox = { minX: 14, minY: 10, maxX: 16, maxY: 12, matched: false }
    const marked = connections.map(() => false)
    markIntersecting(buildRouteIndex(connections), new Map([[P1, [hit, miss]]]), marked)
    expect(marked).toEqual([true, false, false])
    expect(hit.matched).toBe(true)
    expect(miss.matched).toBe(false)
  })
})
