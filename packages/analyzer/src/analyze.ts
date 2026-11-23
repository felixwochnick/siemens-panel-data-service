// Rohdaten → Zeilen (Port von ConnectionExporter.Export): Verbindungen, Kabel, Schirme, Texte, Zähler und Hinweise.
import { cableRows } from './cables'
import { connectionDestination, connectionSource, joinPartNumbers } from './endpoint'
import { buildRouteIndex } from './geometry'
import { findHashMarks } from './hash-marks'
import { findShields } from './shields'
import { textRows } from './texts'
import { findTwistSymbols, isTwistDesignation } from './twist'
import type { AnalysisResult, AnalyzerNotice, ConnectionRow, RawConnection, RawProject, ShieldRow } from './types'

export function analyze(raw: RawProject): AnalysisResult {
  // 3D-Verbindungen (Schaltschrankaufbau) doppeln die Schaltplan-Verbindungen und tragen deren Eigenschaften nicht
  const connections = raw.connections.filter(connection => !connection.is3d)
  const routes = buildRouteIndex(connections)

  const hashMarks = findHashMarks(raw.texts, routes, connections.length)
  const shields = findShields(raw.shields, connections, routes)
  const twistSymbols = findTwistSymbols(raw.lines, routes, connections.length)

  const connectionRows = connections.map((connection, idx): ConnectionRow => ({
    idx,
    eplanId: connection.id,
    page: connection.page,
    definition: connection.definition,
    designation: connection.designation,
    source: connectionSource(connection),
    destination: connectionDestination(connection),
    cable: connection.cable?.name ?? '',
    wireNumber: connection.wireNumber,
    crossSection: connection.crossSection,
    wireType: connection.wireType,
    length: connection.length,
    partNumbers: joinPartNumbers(connection.partNumbers),
    hashMark: hashMarks.marked[idx]!,
    twisted: twistSymbols.twisted[idx]! || isTwistDesignation(connection.designation),
    shielded: shields.shielded[idx]!,
  }))

  const connectionIndex = new Map<RawConnection, number>(connections.map((connection, idx) => [connection, idx]))
  const cables = cableRows(raw.cableDefinitions, raw.connections, connectionIndex)
  const texts = textRows(raw.pages, raw.texts)

  const shieldRows = shields.groups.map((group, idx): ShieldRow => ({
    idx,
    page: group.page,
    name: group.name,
    type: group.type,
    wireCountAndCrossSection: group.wireCountAndCrossSection,
    connectionIdx: group.wires,
  }))

  const notices: AnalyzerNotice[] = []
  if (hashMarks.unmatched > 0) {
    notices.push({ level: 'warn', code: 'unmatched_hash_marks', params: { count: hashMarks.unmatched } })
  }
  if (twistSymbols.unmatchedTicks > 0) {
    notices.push({ level: 'warn', code: 'unmatched_twist_ticks', params: { count: twistSymbols.unmatchedTicks } })
  }
  notices.push(...cables.notices)

  return {
    connections: connectionRows,
    cables: cables.rows,
    shields: shieldRows,
    texts,
    counts: {
      connections: connectionRows.length,
      hashMarks: connectionRows.filter(row => row.hashMark).length,
      unmatchedHashMarks: hashMarks.unmatched,
      twisted: connectionRows.filter(row => row.twisted).length,
      twistSymbols: twistSymbols.symbols,
      unmatchedTwistTicks: twistSymbols.unmatchedTicks,
      shielded: connectionRows.filter(row => row.shielded).length,
      shields: shieldRows.length,
      cables: cables.rows.length,
      texts: texts.length,
      pages: raw.pages.length,
    },
    notices,
  }
}
