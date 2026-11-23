import { describe, expect, it } from 'vitest'
import type { EplanStatus } from '../src/bindings/EplanStatus'
import { accountProblem } from '../src/eplan'
import { texts } from '../src/texts'

// Gleiche Fälle wie die Tests von `Account::parse` in pds-common (eplan.rs)
describe('Konto des EPLAN-Workers', () => {
  it('accepts_the_three_forms', () => {
    for (const account of ['EXAMPLE\\svc-eplan', ' EXAMPLE\\svc-eplan ', '.\\eplan', 'svc.eplan@corp.example.com', 'corp.example.com\\svc-eplan']) {
      expect(accountProblem(account), account).toBeNull()
    }
  })

  it('rejects_builtin_and_virtual_accounts', () => {
    for (const account of [
      'LocalSystem', '.\\LocalSystem', 'SYSTEM', 'NetworkService', 'NT AUTHORITY\\SYSTEM', 'nt authority\\NetworkService',
      'NT-AUTORITÄT\\Netzwerkdienst', 'NT SERVICE\\pds', 'BUILTIN\\Administrators', 'VORDEFINIERT\\Administratoren',
      'IIS APPPOOL\\DefaultAppPool',
    ]) {
      expect(accountProblem(account), account).toBe('builtin')
    }
  })

  it('rejects_managed_and_computer_accounts', () => {
    for (const account of ['EXAMPLE\\gmsa-eplan$', 'EXAMPLE\\SERVER01$', 'gmsa$@example.com']) {
      expect(accountProblem(account), account).toBe('managed')
    }
  })

  it('rejects_invalid_names', () => {
    expect(accountProblem('  ')).toBe('missing')
    expect(accountProblem('eplan')).toBe('noDomain')
    for (const account of [
      'EXAMPLE\\', '\\eplan', 'EXAMPLE\\a\\b', 'EXAMPLE\\a*b', 'EXAMPLE\\ eplan', 'EX AMPLE\\eplan', 'EXAMPLE\\...',
      '@example.com', 'eplan@', 'eplan@.example.com', 'eplan@example..com', 'a\u0007b@example.com',
      `EXAMPLE\\${'a'.repeat(300)}`,
    ]) {
      expect(accountProblem(account), account).toBe('invalid')
    }
  })

  it('every_problem_has_a_text', () => {
    for (const problem of ['missing', 'noDomain', 'builtin', 'managed', 'invalid'] as const) {
      expect(texts.eplan.accountProblems[problem]).toBeTruthy()
    }
  })
})

describe('Zustand des EPLAN-Workers', () => {
  const status = (patch: Partial<EplanStatus>): EplanStatus => ({
    service: { state: 'running', startType: 'auto', delayed: true, account: 'EXAMPLE\\svc-eplan' },
    workerPresent: true,
    executable: 'C:\\Program Files\\EPLAN Panel Data Service\\eplan\\pds-eplan.exe',
    ...patch,
  })

  it('summary_like_the_cli', () => {
    expect(texts.status.eplan(status({}))).toBe('läuft (Start: automatisch, verzögert), Konto EXAMPLE\\svc-eplan')
    expect(texts.status.eplan(status({ service: { state: 'not_installed', startType: '', delayed: false, account: '' } })))
      .toBe('nicht eingerichtet')
    expect(texts.status.eplan(status({ workerPresent: false }))).toMatch(/^fehlt in dieser Installation/)
    expect(texts.status.eplan(status({ service: null }))).toMatch(/^nicht abfragbar/)
  })
})
