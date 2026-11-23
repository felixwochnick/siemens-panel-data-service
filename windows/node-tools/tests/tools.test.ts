import { describe, expect, it } from 'vitest'
import { runTool } from './helpers'
import { runCommand } from '../src/tools'

describe('db-script', () => {
  it('returns_script_with_names', async () => {
    const run = await runTool('db-script', { PDS_DB_NAME: 'pds', PDS_DB_USER: 'pds_app' })
    expect(run.result).toMatchObject({ ok: true, code: 'ok' })
    expect(run.exitCode).toBe(0)
    const script = run.result.details?.script
    expect(script).toEqual(expect.stringContaining(':setvar DB_NAME "pds"'))
    expect(script).toEqual(expect.stringContaining(':setvar DB_PASSWORD "<PASSWORT HIER EINTRAGEN>"'))
  })

  it('never_contains_the_password', async () => {
    const run = await runTool('db-script', { PDS_DB_NAME: 'db', PDS_DB_USER: 'usr', PDS_DB_PASSWORD: 'Geheim-Passwort-1A' })
    expect(run.raw.join('\n')).not.toContain('Geheim-Passwort-1A')
  })

  it('rejects_bad_names_as_usage_error', async () => {
    const run = await runTool('db-script', { PDS_DB_NAME: 'a]b', PDS_DB_USER: 'usr' })
    expect(run.result).toMatchObject({ ok: false, code: 'internal_error' })
    expect(run.exitCode).toBe(1)
  })
})

describe('Bedienfehler', () => {
  it('missing_environment_variable', async () => {
    const run = await runTool('db-test', {})
    expect(run.result).toMatchObject({ ok: false, code: 'internal_error' })
    expect(run.result.message).toContain('NUXT_DATABASE_URL')
    expect(run.exitCode).toBe(1)
  })

  it('empty_environment_variable', async () => {
    const run = await runTool('oidc-test', { NUXT_OIDC_ISSUER: '' })
    expect(run.result.code).toBe('internal_error')
    expect(run.exitCode).toBe(1)
  })

  it('unknown_command', async () => {
    const run = await runTool('gibt-es-nicht', {})
    expect(run.result).toMatchObject({ ok: false, code: 'internal_error' })
    expect(run.exitCode).toBe(1)
    expect(run.result.message).toContain('db-test')
  })

  it('missing_command', async () => {
    const lines: string[] = []
    expect(await runCommand([], {}, line => lines.push(line))).toBe(1)
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ type: 'result', ok: false, code: 'internal_error' })
  })

  it('every_line_starts_with_its_type', async () => {
    // main.ts erkennt die Abschlusszeile daran
    const run = await runTool('db-test', { NUXT_DATABASE_URL: 'kein url' })
    for (const line of run.raw) expect(line).toMatch(/^\{"type":"(step|result)"/)
    expect(run.raw.at(-1)).toMatch(/^\{"type":"result"/)
  })

  it('one_json_object_per_line', async () => {
    const run = await runTool('db-script', { PDS_DB_NAME: 'db', PDS_DB_USER: 'usr' })
    // Das Skript hat Zeilenumbrüche, die Zeile selbst nicht
    expect(run.raw).toHaveLength(1)
    expect(run.raw[0]).not.toContain('\n')
  })
})
