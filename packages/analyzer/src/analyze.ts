import type { AnalysisResult, RawProject } from './types'

// VORLÄUFIG (Task 0): einfache Abbildung ohne Geometrie, Quelle/Ziel-Aufbau und Kabelliste. Task 1 ersetzt sie
// durch die Portierung der .NET-Regeln; die Schnittstelle bleibt gleich.
export function analyze(raw: RawProject): AnalysisResult {
  const connections = raw.connections.filter(c => !c.is3d).map((c, idx) => ({
    idx,
    eplanId: c.id,
    page: c.page,
    definition: c.definition,
    designation: c.designation,
    source: c.sourceProperty,
    destination: c.destinationProperty,
    cable: c.cable?.name ?? '',
    wireNumber: c.wireNumber,
    crossSection: c.crossSection,
    wireType: c.wireType,
    length: c.length,
    partNumbers: [...new Set(c.partNumbers)].join(', '),
    hashMark: false,
    twisted: false,
    shielded: false,
  }))
  const texts = raw.texts.filter(t => t.free && t.content && t.content !== '#')
    .map((t, idx) => ({ idx, page: t.page, text: t.content }))
  return {
    connections,
    cables: [],
    shields: [],
    texts,
    counts: {
      connections: connections.length, hashMarks: 0, unmatchedHashMarks: 0, twisted: 0, twistSymbols: 0,
      unmatchedTwistTicks: 0, shielded: 0, shields: 0, cables: 0, texts: texts.length, pages: raw.pages.length,
    },
    notices: [],
  }
}
