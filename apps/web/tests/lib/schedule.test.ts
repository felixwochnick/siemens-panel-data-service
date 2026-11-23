import { Cron } from 'croner'
import { describe, expect, it } from 'vitest'
import { cronOptions, isValidCron, nextRuns } from '../../server/lib/schedule'

const iso = (dates: Date[]) => dates.map(d => d.toISOString())
// Samstag, 21.11.2026, 10:17 UTC (11:17 in Berlin)
const FROM = new Date('2026-11-21T10:17:00Z')

describe('isValidCron', () => {
  it('akzeptiert die Quartz-Beispiele der .NET-Version und 5-Felder-Ausdrücke', () => {
    for (const expr of ['0 0 * * * ?', '0 0/5 * * * ?', '0 0 8 ? * MON-FRI', '0 0 2 * * ?', '*/5 * * * *', '0 8 * * 1-5', '0 0 8 ? * MON-FRI 2030']) {
      expect(isValidCron(expr), expr).toBe(true)
    }
  })

  it('lehnt Unsinn ab', () => {
    for (const expr of ['', '   ', 'bogus', '1 2 3', '0 0 25 * * ?', '0 61 * * * ?', '0 0 0 30 2 ?']) {
      expect(isValidCron(expr), expr).toBe(false)
    }
  })
})

describe('nextRuns', () => {
  it('jede Stunde zur vollen Stunde', () => {
    expect(iso(nextRuns('0 0 * * * ?', 'Europe/Berlin', 3, FROM))).toEqual([
      '2026-11-21T11:00:00.000Z', '2026-11-21T12:00:00.000Z', '2026-11-21T13:00:00.000Z',
    ])
  })

  it('alle 5 Minuten (Quartz 0/5)', () => {
    expect(iso(nextRuns('0 0/5 * * * ?', 'Europe/Berlin', 3, FROM))).toEqual([
      '2026-11-21T10:20:00.000Z', '2026-11-21T10:25:00.000Z', '2026-11-21T10:30:00.000Z',
    ])
  })

  it('werktags um 08:00 in der Zeitzone der Einstellungen', () => {
    expect(iso(nextRuns('0 0 8 ? * MON-FRI', 'Europe/Berlin', 3, FROM))).toEqual([
      '2026-11-23T07:00:00.000Z', '2026-11-24T07:00:00.000Z', '2026-11-25T07:00:00.000Z',
    ])
    expect(iso(nextRuns('0 0 8 ? * MON-FRI', 'America/New_York', 1, FROM))).toEqual(['2026-11-23T13:00:00.000Z'])
  })

  it('täglich um 02:00', () => {
    expect(iso(nextRuns('0 0 2 * * ?', 'Europe/Berlin', 2, FROM))).toEqual(['2026-11-22T01:00:00.000Z', '2026-11-23T01:00:00.000Z'])
  })

  it('Quartz-Wochentage 1–7 (SUN=1) bei 6 Feldern, klassisch 0–6 bei 5 Feldern', () => {
    expect(iso(nextRuns('0 0 8 ? * 2-6', 'UTC', 1, FROM))).toEqual(['2026-11-23T08:00:00.000Z'])
    expect(iso(nextRuns('0 8 * * 1-5', 'UTC', 1, FROM))).toEqual(['2026-11-23T08:00:00.000Z'])
    expect(iso(nextRuns('0 0 8 ? * 1', 'UTC', 1, FROM))).toEqual(['2026-11-22T08:00:00.000Z'])
  })

  it('ungültiger Ausdruck oder ungültige Zeitzone ⇒ leere Liste', () => {
    expect(nextRuns('bogus', 'Europe/Berlin', 3, FROM)).toEqual([])
    expect(nextRuns('0 0 * * * ?', 'Mars/Phobos', 3, FROM)).toEqual([])
    expect(nextRuns('0 0 * * * ?', 'Europe/Berlin', 0, FROM)).toEqual([])
  })

  it('cronOptions passt zu einem direkt erzeugten croner-Job (für den Zeitplaner der App)', () => {
    const expr = '0 0 8 ? * 2-6'
    const job = new Cron(expr, { ...cronOptions(expr), timezone: 'UTC', paused: true })
    expect(job.nextRun(FROM)!.toISOString()).toBe('2026-11-23T08:00:00.000Z')
    job.stop()
  })
})
