// Kabel und Schirme wie im EPLAN-Kabelnavigator (Port von CableList.cs): je Kabeldefinition eine Zeile mit ihren Adern.
import { connectionDestination, connectionSource, joinPartNumbers } from './endpoint'
import type { AnalyzerNotice, CableRow, CableWireRow, RawCableDefinition, RawConnection } from './types'

export interface CableListResult {
  rows: CableRow[]
  notices: AnalyzerNotice[]
}

/**
 * Quelle/Ziel des Kabels mit Anschluss, z. B. "=+H.A25-K1:CH1" statt "=+H.A25-K1", wenn alle Adern am Gerät am
 * selben Anschluss enden; bei mehreren Anschlüssen (z. B. Klemmleiste) bleibt das Gerät stehen.
 * Zuerst die gleichnamige Aderseite, dann die andere (Adern können umgekehrt gezeichnet sein).
 */
export function precise(device: string, side: readonly string[], otherSide: readonly string[]): string {
  if (device.length === 0) return device
  const atDevice = (ends: readonly string[]) => [...new Set(ends.filter(end => end.startsWith(`${device}:`)))]
  let matches = atDevice(side)
  if (matches.length === 0) matches = atDevice(otherSide)
  return matches.length === 1 ? matches[0]! : device
}

/**
 * @param definitions Kabeldefinitionen in Seitenreihenfolge (nicht entdoppelt)
 * @param allConnections alle Rohverbindungen (auch 3D), um Adern über ihre id zu finden
 * @param connectionIndex Index jeder ausgegebenen Verbindung in AnalysisResult.connections
 */
export function cableRows(
  definitions: readonly RawCableDefinition[],
  allConnections: readonly RawConnection[],
  connectionIndex: ReadonlyMap<RawConnection, number>,
): CableListResult {
  const byId = new Map<string, RawConnection>()
  for (const connection of allConnections) {
    if (!byId.has(connection.id)) byId.set(connection.id, connection)
  }

  const rows: CableRow[] = []
  const notices: AnalyzerNotice[] = []
  const seen = new Set<string>()

  for (const definition of definitions) {
    // Ein Kabel kann mehrfach platziert sein (z. B. auf mehreren Seiten); nur einmal ausgeben
    const key = definition.name.length > 0 ? definition.name : `${definition.page}|${definition.x}|${definition.y}`
    if (seen.has(key)) continue
    seen.add(key)

    const wires: RawConnection[] = []
    for (const id of definition.wires) {
      const wire = byId.get(id)
      if (wire) wires.push(wire)
      else notices.push({ level: 'warn', code: 'wire_not_found', params: { cable: definition.name, id } })
    }
    const starts = wires.map(connectionSource)
    const ends = wires.map(connectionDestination)

    rows.push({
      idx: rows.length,
      kind: definition.kind,
      name: definition.name,
      definition: definition.definition,
      page: definition.page,
      source: precise(definition.sourceProperty, starts, ends),
      destination: precise(definition.destinationProperty, ends, starts),
      type: definition.type,
      wireCountAndCrossSection: definition.wireCountAndCrossSection,
      length: definition.length,
      partNumbers: joinPartNumbers(definition.partNumbers),
      wires: wires.map((wire, idx): CableWireRow => ({
        idx,
        connectionIdx: connectionIndex.get(wire) ?? null,
        definition: wire.definition,
        page: wire.page,
        source: starts[idx]!,
        destination: ends[idx]!,
        length: wire.length,
        wireNumber: wire.wireNumber,
        crossSection: wire.crossSection,
        partNumbers: joinPartNumbers(wire.partNumbers),
      })),
    })
  }
  return { rows, notices }
}
