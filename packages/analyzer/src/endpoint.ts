// Quelle/Ziel und Artikelnummern einer Verbindung (Port von ConnectionExporter.Source/Destination/Endpoint/PartNumbers)
import type { RawConnection, RawPin } from './types'

/**
 * Betriebsmittelkennzeichen und Anschluss, z. B. "=A1+S1-K1:13", bei Steckern/Geräteanschlüssen mit
 * Steckerbezeichnung, z. B. "=+H.A25-A1-B150:X531:1".
 */
export function endpoint(pin: RawPin | null): string {
  let name = pin?.functionName ?? ''
  if (!pin || name.length === 0) return ''

  // Anschlussbezeichnung wie im EPLAN-Verbindungsnavigator ("1/L1", "B"); pinDesignation ist nur die Nummer des
  // Symbolanschlusses und dient nur bei Kennzeichen ohne Doppelpunkt als Ersatz
  let connectionPoint = pin.pinName

  // Klemmen, Stecker- und Geräteanschlüsse tragen den Anschluss bereits im Namen ("-A1-B150:1")
  const colon = name.indexOf(':')
  if (colon < 0) {
    if (connectionPoint.length === 0) connectionPoint = pin.pinDesignation
    return connectionPoint.length === 0 ? name : `${name}:${connectionPoint}`
  }

  // Steckerbezeichnung: EPLAN trägt die manuelle oft nur beim ersten Anschluss ein, die automatische bei allen
  const plug = pin.plugAutomatic.length > 0 ? pin.plugAutomatic : pin.plugManual
  if (plug.length > 0 && !name.includes(`:${plug}:`)) {
    name = `${name.slice(0, colon)}:${plug}${name.slice(colon)}`
  }
  // Geräteanschlüsse heißen wie ihr Anschluss ("-K530:12" mit Anschluss "12"), Klemmen nicht ("-X60:1" mit "B")
  const contained = name.endsWith(`:${connectionPoint}`)
  return connectionPoint.length === 0 || contained ? name : `${name}:${connectionPoint}`
}

/** Quelle wie im EPLAN-Verbindungsnavigator (CONNECTION_SOURCE), sonst aus dem Startanschluss gebildet */
export function connectionSource(connection: RawConnection): string {
  return connection.sourceProperty.length > 0 ? connection.sourceProperty : endpoint(connection.start)
}

/** Ziel wie im EPLAN-Verbindungsnavigator (CONNECTION_DESTINATION), sonst aus dem Endanschluss gebildet */
export function connectionDestination(connection: RawConnection): string {
  return connection.destinationProperty.length > 0 ? connection.destinationProperty : endpoint(connection.end)
}

/** Artikelnummern ohne leere und doppelte, mit ", " verbunden */
export function joinPartNumbers(partNumbers: readonly string[]): string {
  return [...new Set(partNumbers.filter(partNr => partNr.length > 0))].join(', ')
}
