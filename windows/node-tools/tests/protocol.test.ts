import { describe, expect, it } from 'vitest'
import { Scrubber, collectSecrets } from '../src/protocol'

describe('collectSecrets', () => {
  it('collects_url_password_in_all_forms', () => {
    const secrets = collectSecrets({ NUXT_DATABASE_URL: 'mssql://app:p%40ss%3Aw0rd@host:1433/db', PATH: '/usr/bin' })
    expect(secrets).toContain('mssql://app:p%40ss%3Aw0rd@host:1433/db')
    expect(secrets).toContain('p%40ss%3Aw0rd')
    expect(secrets).toContain('p@ss:w0rd')
    expect(secrets).not.toContain('/usr/bin')
  })

  it('sqlite_url_is_no_secret', () => {
    // Der Pfad soll in den Meldungen stehen bleiben, auch mit Leerzeichen, Backslashes oder einem @ darin
    expect(collectSecrets({ NUXT_DATABASE_URL: 'sqlite:C:\\ProgramData\\EPLAN Panel Data Service\\data\\pds.db' })).toEqual([])
    expect(collectSecrets({ PDS_ADMIN_DATABASE_URL: 'SQLite://user:path-part@host/pds.db' })).toEqual([])
    expect(collectSecrets({ NUXT_DATABASE_URL: 'sqlite:/var/lib/pds.db', PDS_DB_PASSWORD: 'Geheim-1A' })).toEqual(['Geheim-1A'])
  })

  it('collects_the_sql_literal_form', () => {
    expect(collectSecrets({ PDS_DB_PASSWORD: 'o\'brien-1A' })).toEqual(expect.arrayContaining(['o\'brien-1A', 'o\'\'brien-1A']))
  })

  it('collects_plain_secrets_and_ignores_short_values', () => {
    const secrets = collectSecrets({ PDS_DB_PASSWORD: 'Geheim-1A', NUXT_OIDC_CLIENT_SECRET: 'abc', PDS_ADMIN_DATABASE_URL: 'kein url' })
    expect(secrets).toEqual(expect.arrayContaining(['Geheim-1A', 'kein url']))
    expect(secrets).not.toContain('abc')
  })
})

describe('Scrubber', () => {
  const scrubber = new Scrubber(['mssql://app:pw-1234@host/db', 'pw-1234', 'a"b\\c-1'])

  it('masks_longest_first', () => {
    expect(scrubber.text('Fehler bei mssql://app:pw-1234@host/db und pw-1234')).toBe('Fehler bei *** und ***')
  })

  it('masks_in_nested_details', () => {
    const line = scrubber.deep({ a: ['x pw-1234'], b: { c: 'pw-1234', d: 3 } })
    expect(line).toEqual({ a: ['x ***'], b: { c: '***', d: 3 } })
  })

  it('masks_json_escaped_form', () => {
    const serialized = JSON.stringify({ message: 'Wert a"b\\c-1 ist falsch' })
    const masked = scrubber.json(serialized)
    expect(masked).not.toContain('a\\"b')
    expect(JSON.parse(masked)).toEqual({ message: 'Wert *** ist falsch' })
  })

  it('line_is_valid_json_without_secrets', () => {
    const text = scrubber.line({ type: 'result', ok: false, code: 'internal_error', message: 'pw-1234 a"b\\c-1' })
    expect(text).not.toContain('pw-1234')
    expect(JSON.parse(text)).toMatchObject({ message: '*** ***' })
  })
})
