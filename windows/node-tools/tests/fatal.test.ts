import { describe, expect, it } from 'vitest'
import { fatalHandler } from '../src/fatal'
import { EXIT_INTERNAL, Scrubber } from '../src/protocol'

function harness(hasResult: boolean) {
  const out = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] }
  const handle = fatalHandler({
    scrubber: new Scrubber(['Geheim-Passwort-1A']),
    hasResult: () => hasResult,
    io: {
      // Wie process.stdout.write: erst schreiben, dann das Ende melden
      stdout: (text, done) => {
        out.stdout.push(text)
        done()
      },
      stderr: text => out.stderr.push(text),
      exit: code => out.exits.push(code),
    },
  })
  return { out, handle }
}

describe('fatalHandler', () => {
  it('writes_a_result_line_when_none_was_written', () => {
    const { out, handle } = harness(false)
    handle(new Error('kaputt Geheim-Passwort-1A'))

    expect(out.stdout).toHaveLength(1)
    expect(out.stdout[0]).toMatch(/\n$/)
    expect(JSON.parse(out.stdout[0] ?? '')).toEqual({ type: 'result', ok: false, code: 'internal_error', message: 'Unerwarteter Fehler: kaputt ***' })
    expect(out.stderr.join('')).toBe('Unerwarteter Fehler: kaputt ***\n')
    expect(out.exits).toEqual([EXIT_INTERNAL])
  })

  it('keeps_an_existing_result_line_unique', () => {
    const { out, handle } = harness(true)
    handle(new Error('später Fehler'))

    expect(out.stdout).toEqual([])
    expect(out.stderr.join('')).toContain('später Fehler')
    expect(out.exits).toEqual([EXIT_INTERNAL])
  })

  it('handles_non_error_values_and_runs_only_once', () => {
    const { out, handle } = harness(false)
    handle('nur ein Text')
    handle(new Error('zweiter'))

    expect(out.stdout).toHaveLength(1)
    expect(JSON.parse(out.stdout[0] ?? '').message).toBe('Unerwarteter Fehler: nur ein Text')
    expect(out.exits).toEqual([EXIT_INTERNAL])
  })
})
