import { describe, expect, it } from 'vitest'
import type { Config } from '../src/bindings/Config'
import { defaultConfig } from '../src/api/defaults'
import { appUrlOf, backupFileName, daysUntil, formatBytes, formatDate, formatDateTime, issuerOf, redirectUriOf, toPort } from '../src/format'

function config(change: (config: Config) => void): Config {
  const value = defaultConfig()
  value.public.host = 'Trainee.Example.com'
  change(value)
  return value
}

describe('format', () => {
  // Gleiche Fälle wie `render::app_url` in Rust
  it('app_url_like_render', () => {
    expect(appUrlOf(config(() => {}))).toBe('https://trainee.example.com')
    expect(appUrlOf(config(c => (c.public.port = 8443)))).toBe('https://trainee.example.com:8443')
    // Schema nur bei `off` frei, dann zählt 80 als Standard für http
    expect(appUrlOf(config((c) => {
      c.public.scheme = 'http'
    }))).toBe('https://trainee.example.com')
    expect(appUrlOf(config((c) => {
      c.tls.mode = 'off'
      c.public.scheme = 'http'
      c.public.port = 80
    }))).toBe('http://trainee.example.com')
    expect(appUrlOf(config(c => (c.public.host = '::1')))).toBe('https://[::1]')
    expect(redirectUriOf(config(() => {}))).toBe('https://trainee.example.com/auth/callback')
  })

  it('issuer_like_render', () => {
    expect(issuerOf(config(c => (c.oidc.tenant_id = 'abc')))).toBe('https://login.microsoftonline.com/abc/v2.0')
    expect(issuerOf(config(c => (c.oidc.issuer = 'https://idp.example.com/realms/x/')))).toBe('https://idp.example.com/realms/x')
  })

  it('dates_in_utc', () => {
    expect(formatDateTime('2027-01-15T08:00:05Z')).toBe('15.01.2027 08:00:05 UTC')
    expect(formatDate('2027-01-15T23:30:00-02:00')).toBe('16.01.2027')
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(daysUntil('2026-12-10T11:59:59Z', now)).toBe(20)
    expect(daysUntil('2026-11-20T00:00:00Z', now)).toBe(-1)
  })

  it('backup_file_name_uses_local_date', () => {
    // Lokale Zeit kurz nach Mitternacht: der neue Kalendertag, egal wie weit UTC zurückliegt
    expect(backupFileName(new Date(2026, 10, 23, 0, 30))).toBe('pds-sicherung-20261123.db')
    expect(backupFileName(new Date(2027, 0, 5, 23, 59))).toBe('pds-sicherung-20270105.db')
  })

  it('bytes_like_explorer', () => {
    // Geschütztes Leerzeichen zwischen Zahl und Einheit
    const nbsp = (text: string) => text.replace(' ', '\u00A0')
    expect(formatBytes(0)).toBe(nbsp('0 Byte'))
    expect(formatBytes(1023)).toBe(nbsp('1023 Byte'))
    expect(formatBytes(1024)).toBe(nbsp('1,0 KB'))
    expect(formatBytes(1536)).toBe(nbsp('1,5 KB'))
    expect(formatBytes(18_874_368)).toBe(nbsp('18,0 MB'))
    // Gerundet 1024,0 KB wäre unschön: dann schon die nächste Einheit
    expect(formatBytes(1024 * 1024 - 1)).toBe(nbsp('1,0 MB'))
    expect(formatBytes(5 * 1024 ** 3)).toBe(nbsp('5,0 GB'))
    expect(formatBytes(Number.NaN)).toBe(nbsp('0 Byte'))
  })

  it('port_input', () => {
    expect(toPort('1433')).toBe(1433)
    expect(toPort('')).toBe(0)
    expect(toPort('70000')).toBe(0)
    expect(toPort(443)).toBe(443)
  })
})

describe('defaults', () => {
  it('default_database_is_sqlite', () => {
    // Wie `DbConfig::default()`: SQLite im Datenordner, SQL-Server-Felder mit ihren Standards
    expect(defaultConfig().db).toEqual({
      kind: 'sqlite',
      path: '',
      server: '',
      port: 1433,
      database: 'pds',
      user: 'pds_app',
      password: '',
      encrypt: true,
      trust_server_certificate: false,
    })
  })
})
