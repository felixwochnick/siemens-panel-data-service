import { describe, expect, it } from 'vitest'
import { createSafeLogger, DETAIL_MAX_LENGTH, formatEvent, scrubSecrets } from '../../server/lib/log'
import type { LogEvent } from '../../server/lib/log'

describe('formatEvent', () => {
  it('englische Einzeile mit Code, Parametern und Detail', () => {
    expect(formatEvent({ level: 'info', code: 'results_saved', params: { connections: 3, texts: 1 } }))
      .toBe('INFO  [results_saved] connections=3 texts=1')
    expect(formatEvent({ level: 'error', code: 'open_failed', detail: 'line 1\nline 2' }))
      .toBe('ERROR [open_failed]  | line 1 \\n line 2')
  })
})

describe('Geheimnisse', () => {
  it('scrubSecrets ersetzt rohe, JSON- und URL-kodierte Vorkommen', () => {
    const pw = 'p"a s\\w&'
    const text = [pw, JSON.stringify({ password: pw }), encodeURIComponent(pw), JSON.stringify(JSON.stringify({ password: pw }))].join(' | ')
    const out = scrubSecrets(text, [pw, '', undefined])
    expect(out).not.toContain('a s')
    expect(out.match(/\*\*\*/g)!.length).toBe(4)
  })

  it('scrubSecrets erkennt `\\/` und \\uXXXX (.NET, PHP)', () => {
    const pw = 'Grün/Weiß'
    const text = [String.raw`Grün\/Weiß`, String.raw`Grün/Weiß`, String.raw`Grün\/Weiß`].join(' | ')
    expect(scrubSecrets(text, [pw])).toBe('*** | *** | ***')
  })

  it('createSafeLogger entfernt Geheimnisse aus detail und Parametern und kürzt detail', () => {
    const events: LogEvent[] = []
    const log = createSafeLogger(e => events.push(e), ['hunter2', 'drivepw'])
    log({ level: 'error', code: 'network_drive_failed', params: { target: 'x hunter2', n: 1 }, detail: `${'y'.repeat(5000)} drivepw` })
    log({ level: 'error', code: 'network_drive_failed', detail: 'login hunter2 failed' })
    expect(events[0]!.params).toEqual({ target: 'x ***', n: 1 })
    expect(events[0]!.detail!.length).toBe(DETAIL_MAX_LENGTH)
    expect(events[1]!.detail).toBe('login *** failed')
  })

  it('ein werfender Logger bricht nichts ab', () => {
    const log = createSafeLogger(() => {
      throw new Error('disk full')
    }, [])
    expect(() => log({ level: 'info', code: 'drive_connected' })).not.toThrow()
  })
})
