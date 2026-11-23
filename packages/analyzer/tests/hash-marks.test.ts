import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze'
import { PAGE, project, text, wire } from './helpers'

const REPORT = '=A1+B1&EFS/90'
const OTHER = '=A1+B1&EFS/2'

// Senkrechte Leitung bei x = 10 von y = 0 bis y = 50
const vertical = (page = PAGE, x = 10) => wire(page, [[x, 0], [x, 50]])

describe('#-Markierung', () => {
  it('trifft eine Leitung im Abstand von 2 mm', () => {
    const result = analyze(project({ connections: [vertical()], texts: [text(PAGE, '#', 12, 20)] }))
    expect(result.connections[0]?.hashMark).toBe(true)
    expect(result.counts.hashMarks).toBe(1)
    expect(result.counts.unmatchedHashMarks).toBe(0)
    expect(result.notices).toEqual([])
  })

  it('trifft im Abstand von 2,1 mm nicht und meldet die Markierung', () => {
    const result = analyze(project({ connections: [vertical()], texts: [text(PAGE, '#', 12.1, 20)] }))
    expect(result.connections[0]?.hashMark).toBe(false)
    expect(result.counts.hashMarks).toBe(0)
    expect(result.counts.unmatchedHashMarks).toBe(1)
    expect(result.notices).toEqual([{ level: 'warn', code: 'unmatched_hash_marks', params: { count: 1 } }])
  })

  it('wertet auch Texte in Gruppen und auf Auswertungsseiten aus', () => {
    const result = analyze(project({
      pages: [{ name: PAGE, isReport: false }, { name: REPORT, isReport: true }],
      connections: [vertical(REPORT)],
      texts: [text(REPORT, '#', 9, 20, { free: false })],
    }))
    expect(result.connections[0]?.hashMark).toBe(true)
    expect(result.texts).toEqual([])
  })

  it('zählt nur Texte mit Inhalt genau "#"', () => {
    const result = analyze(project({
      connections: [vertical()],
      texts: [text(PAGE, '#1', 10, 20), text(PAGE, '##', 30, 20)],
    }))
    expect(result.connections[0]?.hashMark).toBe(false)
    expect(result.counts.unmatchedHashMarks).toBe(0)
  })

  it('nimmt den Textpunkt, wenn der Rahmen fehlt', () => {
    const result = analyze(project({ connections: [vertical()], texts: [text(PAGE, '#', 11.5, 30, { box: [] })] }))
    expect(result.connections[0]?.hashMark).toBe(true)
  })

  it('ordnet nur Leitungen derselben Seite zu', () => {
    const result = analyze(project({
      pages: [{ name: PAGE, isReport: false }, { name: OTHER, isReport: false }],
      connections: [vertical(PAGE)],
      texts: [text(OTHER, '#', 10, 20)],
    }))
    expect(result.connections[0]?.hashMark).toBe(false)
    expect(result.counts.unmatchedHashMarks).toBe(1)
  })

  it('markiert alle Leitungen, die den Rahmen schneiden', () => {
    const result = analyze(project({
      connections: [vertical(PAGE, 10), vertical(PAGE, 12), vertical(PAGE, 20)],
      texts: [text(PAGE, '#', 11, 20)],
    }))
    expect(result.connections.map(c => c.hashMark)).toEqual([true, true, false])
    expect(result.counts.hashMarks).toBe(2)
    expect(result.counts.unmatchedHashMarks).toBe(0)
  })
})
