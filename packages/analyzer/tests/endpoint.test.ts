import { describe, expect, it } from 'vitest'
import { connectionDestination, connectionSource, endpoint, joinPartNumbers } from '../src/endpoint'
import { connection, pin } from './helpers'

describe('endpoint', () => {
  it('liefert "" ohne Anschluss oder ohne Funktion', () => {
    expect(endpoint(null)).toBe('')
    expect(endpoint(pin('', '1', { pinDesignation: '1', plugAutomatic: 'X1' }))).toBe('')
  })

  it('hängt den Anschlussnamen an ein Kennzeichen ohne Doppelpunkt', () => {
    expect(endpoint(pin('=A1+S1-K1', '13'))).toBe('=A1+S1-K1:13')
    expect(endpoint(pin('=A1-Q1', '1/L1', { pinDesignation: '1' }))).toBe('=A1-Q1:1/L1')
  })

  it('nimmt ohne Anschlussnamen die Designation, ohne beides nur das Kennzeichen', () => {
    expect(endpoint(pin('=A1-K1', '', { pinDesignation: 'A2' }))).toBe('=A1-K1:A2')
    expect(endpoint(pin('=A1-K1', ''))).toBe('=A1-K1')
  })

  it('fügt die Steckerbezeichnung nach dem ersten Doppelpunkt ein', () => {
    expect(endpoint(pin('=+H.A25-A1-B150:1', '1', { plugAutomatic: 'X531' }))).toBe('=+H.A25-A1-B150:X531:1')
  })

  it('fügt die Steckerbezeichnung nicht doppelt ein', () => {
    expect(endpoint(pin('=+H.A25-A1-B150:X531:1', '1', { plugAutomatic: 'X531' }))).toBe('=+H.A25-A1-B150:X531:1')
  })

  it('nimmt die manuelle Steckerbezeichnung nur, wenn die automatische leer ist', () => {
    expect(endpoint(pin('-A1-B150:2', '2', { plugManual: 'X532' }))).toBe('-A1-B150:X532:2')
    expect(endpoint(pin('-A1-B150:2', '2', { plugAutomatic: 'X531', plugManual: 'X532' }))).toBe('-A1-B150:X531:2')
  })

  it('hängt einen Anschluss an, der nicht schon im Namen steht (Klemme)', () => {
    expect(endpoint(pin('=A1-X60:1', 'B'))).toBe('=A1-X60:1:B')
  })

  it('hängt einen Anschluss nicht an, wenn der Name schon darauf endet (Geräteanschluss)', () => {
    expect(endpoint(pin('-K530:12', '12'))).toBe('-K530:12')
  })

  it('nimmt bei Namen mit Doppelpunkt die Designation nicht als Ersatz', () => {
    expect(endpoint(pin('=A1-X60:1', '', { pinDesignation: '3' }))).toBe('=A1-X60:1')
  })

  it('verbindet Stecker-Einfügung und angehängten Anschluss', () => {
    expect(endpoint(pin('-A1-B150:3', 'S', { plugAutomatic: 'X531' }))).toBe('-A1-B150:X531:3:S')
  })
})

describe('Quelle und Ziel', () => {
  it('nimmt CONNECTION_SOURCE/_DESTINATION, wenn gesetzt', () => {
    const c = connection({ sourceProperty: '=A1-X1:1', destinationProperty: '=A1-X2:1', start: pin('-K1', '1'), end: pin('-K2', '2') })
    expect(connectionSource(c)).toBe('=A1-X1:1')
    expect(connectionDestination(c)).toBe('=A1-X2:1')
  })

  it('bildet Quelle/Ziel sonst aus Start-/Endanschluss', () => {
    const c = connection({ start: pin('-K1', '13'), end: pin('-X1:4', 'B') })
    expect(connectionSource(c)).toBe('-K1:13')
    expect(connectionDestination(c)).toBe('-X1:4:B')
  })

  it('liefert "" ohne Anschluss', () => {
    const c = connection({ start: null, end: null })
    expect(connectionSource(c)).toBe('')
    expect(connectionDestination(c)).toBe('')
  })
})

describe('joinPartNumbers', () => {
  it('entdoppelt, lässt leere aus und verbindet mit ", "', () => {
    expect(joinPartNumbers(['3RT2015', '', 'SIE.1', '3RT2015'])).toBe('3RT2015, SIE.1')
    expect(joinPartNumbers([])).toBe('')
  })
})
