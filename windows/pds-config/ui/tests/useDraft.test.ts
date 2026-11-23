import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Finding } from '../src/bindings/Finding'
import type { Config } from '../src/bindings/Config'
import { createDraft } from '../src/composables/useDraft'

function config(): Config {
  return {
    schema: 1,
    public: { host: 'trainee.example.com', port: 443, scheme: 'https' },
    listen: { http_port: 80 },
    internal: { port: 3000 },
    tls: { mode: 'certificate', acme_email: '', acme_ca_url: '', acme_ca_root: '', acme_eab_key_id: '', acme_eab_hmac: '' },
    db: { kind: 'sqlserver', path: '', server: 'sql01', port: 1433, database: 'pds', user: 'pds_app', password: '***', encrypt: true, trust_server_certificate: false },
    oidc: {
      tenant_id: '11111111-2222-3333-4444-555555555555',
      issuer: '',
      client_id: '66666666-7777-8888-9999-000000000000',
      client_secret: '***',
      scopes: 'openid profile email',
      roles_claim: 'roles',
      admin_roles: 'Admin',
      provider_name: 'Microsoft',
    },
    proxy: { url: '', no_proxy: '' },
    mcp: { enabled: false },
    app: { secret: '***' },
  }
}

function finding(field: string, code: string, severity: Finding['severity'] = 'error'): Finding {
  return { field, code, message: code, severity }
}

/** Lässt Watcher (Vue-Scheduler) und ausstehende Promises laufen */
async function settle() {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dirty_count', async () => {
    const draft = createDraft({ validate: async () => [] })
    draft.load(config(), [])
    expect(draft.dirtyCount.value).toBe(0)

    draft.draft.value.db.server = 'sql02'
    draft.draft.value.mcp.enabled = true
    // Neues Secret zählt wie jedes andere Feld
    draft.draft.value.db.password = 'neues Passwort'
    expect(draft.dirtyCount.value).toBe(3)

    // Zurück auf den Ausgangswert ist keine Änderung mehr
    draft.draft.value.db.server = 'sql01'
    expect(draft.dirtyCount.value).toBe(2)
    expect(draft.isDirty('mcp.enabled')).toBe(true)
    expect(draft.isDirty('db.server')).toBe(false)
  })

  it('reset_restores', async () => {
    const initial = [finding('tls', 'certificate_expires_soon', 'warning')]
    const validate = vi.fn(async () => [finding('public.host', 'required')])
    const draft = createDraft({ validate })
    draft.load(config(), initial)

    draft.draft.value.public.host = ''
    draft.draft.value.tls.mode = 'acme'
    draft.draft.value.oidc.client_secret = ''
    await settle()
    await vi.advanceTimersByTimeAsync(300)
    expect(draft.findingsFor('public.host')).toHaveLength(1)

    draft.reset()

    expect(draft.draft.value).toEqual(config())
    expect(draft.dirtyCount.value).toBe(0)
    // Die Befunde gehören wieder zum Original, ohne erneute Prüfung
    expect(draft.findings.value).toEqual(initial)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(validate).toHaveBeenCalledTimes(1)

    // Entwurf und Original teilen sich keine Objekte
    draft.draft.value.db.port = 1434
    expect(draft.original.value.db.port).toBe(1433)
  })

  it('findings_for_path', async () => {
    const draft = createDraft({ validate: async () => [] })
    draft.load(config(), [
      finding('db.server', 'invalid_hostname'),
      finding('db.server', 'named_instance_not_supported'),
      finding('db.server_extra', 'other'),
      finding('tls', 'certificate_expires_soon', 'warning'),
    ])

    expect(draft.findingsFor('db.server').map(f => f.code)).toEqual(['invalid_hostname', 'named_instance_not_supported'])
    expect(draft.findingsFor('tls').map(f => f.code)).toEqual(['certificate_expires_soon'])
    expect(draft.findingsFor('db.port')).toEqual([])
    expect(draft.errorCount.value).toBe(3)
    expect(draft.warningCount.value).toBe(1)
  })

  it('mark_secret_set', async () => {
    const validate = vi.fn(async () => [])
    const draft = createDraft({ validate })
    const initial = config()
    initial.app.secret = ''
    initial.db.password = ''
    draft.load(initial, [finding('app.secret', 'app_secret_missing')])
    draft.draft.value.db.password = 'neu getippt'

    draft.markSecretSet('app.secret')
    draft.markSecretSet('db.password')

    expect(draft.original.value.app.secret).toBe('***')
    expect(draft.draft.value.app.secret).toBe('***')
    // Neu getippter Wert bleibt im Entwurf
    expect(draft.original.value.db.password).toBe('***')
    expect(draft.draft.value.db.password).toBe('neu getippt')
    expect(draft.dirtyCount.value).toBe(1)
    await settle()
    await vi.advanceTimersByTimeAsync(300)
    expect(draft.findings.value).toEqual([])

    // Verwerfen prüft neu, statt den veralteten Befund zurückzuholen
    draft.reset()
    await settle()
    await vi.advanceTimersByTimeAsync(300)
    expect(draft.findings.value).toEqual([])
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('revalidate_debounces', async () => {
    const validate = vi.fn(async (draft: Config) => draft.db.server ? [] : [finding('db.server', 'required')])
    const draft = createDraft({ validate })
    draft.load(config(), [])

    draft.draft.value.db.server = 's'
    await settle()
    draft.draft.value.db.server = ''
    await settle()
    await vi.advanceTimersByTimeAsync(299)
    expect(validate).not.toHaveBeenCalled()
    expect(draft.validating.value).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]?.[0].db.server).toBe('')
    expect(draft.findingsFor('db.server').map(f => f.code)).toEqual(['required'])
    expect(draft.validating.value).toBe(false)

    // Eine überholte Antwort überschreibt das neuere Ergebnis nicht
    let release: (findings: Finding[]) => void = () => {}
    validate.mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
    draft.draft.value.db.server = 'sql03'
    await settle()
    await vi.advanceTimersByTimeAsync(300)
    draft.draft.value.db.server = 'sql04'
    await settle()
    await vi.advanceTimersByTimeAsync(300)
    expect(draft.findings.value).toEqual([])
    release([finding('db.server', 'stale')])
    await settle()
    expect(draft.findings.value).toEqual([])
  })
})
