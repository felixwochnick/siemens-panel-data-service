import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze'
import { project, text } from './helpers'

const P1 = '=A1/1'
const REPORT = '=A1/2'
const P3 = '=A1/3'

describe('Texte', () => {
  it('nimmt nur freie Texte außerhalb von Auswertungsseiten, ohne leere und ohne "#"', () => {
    const result = analyze(project({
      pages: [{ name: P1, isReport: false }, { name: REPORT, isReport: true }],
      texts: [
        text(P1, 'Hinweis', 10, 10),
        text(P1, 'RDY', 10, 20, { free: false }),
        text(P1, '#', 10, 30),
        text(P1, '', 10, 40),
        text(REPORT, 'Klemmenplan', 10, 50),
      ],
    }))
    expect(result.texts).toEqual([{ idx: 0, page: P1, text: 'Hinweis' }])
    expect(result.counts.texts).toBe(1)
  })

  it('sortiert je Seite von oben nach unten, dann von links nach rechts, Seiten in Projektreihenfolge', () => {
    const result = analyze(project({
      pages: [{ name: P3, isReport: false }, { name: P1, isReport: false }],
      texts: [
        text(P1, 'unten', 0, 10),
        text(P3, 'Seite 3', 0, 0),
        text(P1, 'rechts', 50, 100),
        text(P1, 'links', 5, 100),
        text(P1, 'oben', 200, 250),
        text(P1, 'gleich 1', 20, 10),
        text(P1, 'gleich 2', 20, 10),
      ],
    }))
    expect(result.texts.map(t => [t.idx, t.page, t.text])).toEqual([
      [0, P3, 'Seite 3'],
      [1, P1, 'oben'],
      [2, P1, 'links'],
      [3, P1, 'rechts'],
      [4, P1, 'unten'],
      [5, P1, 'gleich 1'],
      [6, P1, 'gleich 2'],
    ])
  })

  it('hängt Texte unbekannter Seiten in Auftretensreihenfolge an', () => {
    const result = analyze(project({
      pages: [{ name: P1, isReport: false }],
      texts: [text('=X/9', 'unbekannt 1', 0, 0), text(P1, 'bekannt', 0, 0), text('=X/8', 'unbekannt 2', 0, 100)],
    }))
    expect(result.texts.map(t => t.text)).toEqual(['bekannt', 'unbekannt 1', 'unbekannt 2'])
  })
})
