// Beispieldaten für den Browser (ohne Tauri): Entwicklung und Bildschirmprüfung mit Playwright.
// Bildet die Tauri-Befehle aus `commands.rs` nach. Ausgangslage: eine bestehende Installation auf SQL Server
// (vor SQLite gab es nur diese), Dienst läuft, das Zertifikat läuft in 20 Tagen ab (Warnung), KI-Assistenten
// aus, Client-Secret fehlt (Warnung am Feld).
// `?stale=1` in der Adresse zeigt einen veralteten Status (Dienst abgestürzt), `?broken=1` eine unlesbare
// config.toml (Dienst `unconfigured`, Befund `config_unreadable` in Status und Prüfung), `?fresh=1` eine neue
// Installation mit der Standard-Datenbank (SQLite im Datenordner, kein Datenbankpasswort: Wer auf SQL Server
// wechselt, lässt es von der Einrichtung erzeugen), `?gpo=1` eine per GPO verwaltete Firewall (Speichern
// meldet eine Warnung).
// EPLAN-Worker: eingerichtet unter EXAMPLE\svc-eplan und läuft; bei `?fresh=1` noch nicht eingerichtet,
// `?noworker=1` ein MSI ohne Worker. Das Passwort `falsch` lehnt die Anmeldeprüfung ab.
// SQLite-Pfade: Laufwerke C: und D: gibt es, Z: ist ein verbundenes Netzlaufwerk, andere fehlen (Warnung).
import type { CertInfo } from '../bindings/CertInfo'
import type { Config } from '../bindings/Config'
import type { EplanStatus } from '../bindings/EplanStatus'
import type { Finding } from '../bindings/Finding'
import type { ScmInfo } from '../bindings/ScmInfo'
import type { ServiceAction } from '../bindings/ServiceAction'
import type { ServiceState } from '../bindings/ServiceState'
import type { StatusReport } from '../bindings/StatusReport'
import type { ToolLine } from '../bindings/ToolLine'
import type { ToolResult } from '../bindings/ToolResult'
import { accountProblem } from '../eplan'
import { appUrlOf, formatDate, issuerOf, redirectUriOf } from '../format'
import { texts } from '../texts'
import { defaultConfig } from './defaults'
import type { Command, Commands, FileFilter } from './index'

const DAY_MS = 24 * 60 * 60 * 1000
const DATA_DIR = 'C:\\ProgramData\\EPLAN Panel Data Service'
const LOGS_DIR = `${DATA_DIR}\\logs`
const EPLAN_EXE = 'C:\\Program Files\\EPLAN Panel Data Service\\eplan\\pds-eplan.exe'
// Wie `Paths::default_sqlite_file`
const DEFAULT_DB_PATH = `${DATA_DIR}\\data\\pds.db`
const LOCAL_DRIVES = ['C', 'D']
const NETWORK_DRIVES = ['Z']
const SECRET_FIELDS = ['db.password', 'oidc.client_secret', 'app.secret', 'tls.acme_eab_hmac'] as const
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i
const DB_HOST = /^(?=.{1,253}$)(?!-)[\w-]{1,63}(?<!-)(\.(?!-)[\w-]{1,63}(?<!-))*$/i

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function stale(): boolean {
  return new URLSearchParams(window.location.search).has('stale')
}

function broken(): boolean {
  return new URLSearchParams(window.location.search).has('broken')
}

function fresh(): boolean {
  return new URLSearchParams(window.location.search).has('fresh')
}

function gpo(): boolean {
  return new URLSearchParams(window.location.search).has('gpo')
}

function noWorker(): boolean {
  return new URLSearchParams(window.location.search).has('noworker')
}

// Wie `ops::unreadable_finding`: Feld `config`, Meldung aus `ConfigError::Unreadable`
const UNREADABLE: Finding = {
  field: 'config',
  code: 'config_unreadable',
  message: 'Konfiguration nicht lesbar: unbekanntes Feld `passwort` im Abschnitt [db] (Zeile 14)',
  severity: 'error',
}

function certificate(daysLeft: number, host: string): CertInfo {
  return {
    subject: `CN=${host}`,
    issuer: 'CN=Example Issuing CA 2026, O=Example Corp',
    dnsNames: [host],
    notBefore: iso((daysLeft - 365) * DAY_MS),
    notAfter: iso(daysLeft * DAY_MS),
    thumbprintSha1: '3F2A9C1D7E5B4A6C8D0E1F2A3B4C5D6E7F8A9B0C',
  }
}

const saved: Config = {
  schema: 1,
  public: { host: 'pds.example.com', port: 443, scheme: 'https' },
  listen: { http_port: 80 },
  internal: { port: 3000 },
  tls: { mode: 'certificate', acme_email: '', acme_ca_url: '', acme_ca_root: '', acme_eab_key_id: '', acme_eab_hmac: '' },
  db: { kind: 'sqlserver', path: '', server: 'sql01.example.com', port: 1433, database: 'pds', user: 'pds_app', password: '***', encrypt: true, trust_server_certificate: false },
  oidc: {
    tenant_id: '3f6c1e2a-8b4d-4c7e-9a1f-2d5b8e0c4a76',
    issuer: '',
    client_id: 'b7e2d9c4-1a3f-4e6b-8c5d-9f0a2b4c6d81',
    client_secret: '',
    scopes: 'openid profile email',
    roles_claim: 'roles',
    admin_roles: 'Admin',
    provider_name: 'Microsoft',
  },
  proxy: { url: '', no_proxy: '' },
  mcp: { enabled: false },
  app: { secret: '***' },
}

const mock = {
  config: fresh() ? { ...saved, db: defaultConfig().db } : saved,
  certificate: certificate(20, saved.public.host) as CertInfo | null,
  service: { state: 'running', startType: 'auto', delayed: true, account: 'NT SERVICE\\pds' } as ScmInfo,
  state: 'running' as ServiceState,
  since: iso(-3 * 60 * 60 * 1000),
  eplan: (fresh() || noWorker()
    ? { state: 'not_installed', startType: '', delayed: false, account: '' }
    : { state: 'running', startType: 'auto', delayed: true, account: 'EXAMPLE\\svc-eplan' }) as ScmInfo,
}

// Wie `eplan::status`
function eplanStatus(): EplanStatus {
  return { service: mock.eplan, workerPresent: !noWorker(), executable: EPLAN_EXE }
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function secretOf(config: Config, path: typeof SECRET_FIELDS[number]): string {
  const [section, key] = path.split('.') as [keyof Config, string]
  return (config[section] as Record<string, string>)[key] ?? ''
}

/** Wie `config show`: gesetzte Secrets als "***" */
function masked(config: Config): Config {
  const copy = clone(config)
  for (const path of SECRET_FIELDS) {
    const [section, key] = path.split('.') as [keyof Config, string]
    const values = copy[section] as Record<string, string>
    values[key] = secretOf(config, path) ? '***' : ''
  }
  return copy
}

type Report = (field: string, code: string, message: string) => void

function isNetworkPath(path: string): boolean {
  const normalized = path.trim().replaceAll('/', '\\')
  return normalized.startsWith('\\\\') || (NETWORK_DRIVES.includes(normalized.charAt(0).toUpperCase()) && normalized.charAt(1) === ':')
}

// Auszug aus der Prüfung von `db.path`: nur ein vollständiger, lokaler Pfad an einem erlaubten Ort
function validateSqlitePath(raw: string, error: Report, warning: Report) {
  const path = raw.trim().replaceAll('/', '\\')
  if (!path) return
  if (/^\\\\[?.]\\/.test(path)) {
    return error('db.path', 'invalid_path', 'Gerätepfade (\\\\?\\ oder \\\\.\\) sind nicht erlaubt')
  }
  if (isNetworkPath(path)) {
    return error('db.path', 'sqlite_network_path', 'Die SQLite-Datei muss auf einem lokalen Laufwerk liegen: Auf Netzlaufwerken (UNC-Pfad oder verbundenes Laufwerk) drohen Sperrfehler und eine beschädigte Datenbank')
  }
  const drive = /^([a-z]):\\/i.exec(path)
  if (!drive) {
    return error('db.path', 'sqlite_path_not_absolute', 'Bitte den vollständigen Pfad mit Laufwerksbuchstaben angeben, z. B. D:\\PDS\\pds.db')
  }
  const segments = path.slice(3).split('\\')
  if (/[<>"|?*:]/.test(path.slice(2)) || segments.some(part => part === '' || part === '.' || part === '..')) {
    return error('db.path', 'invalid_path', 'Der Pfad ist ungültig: keine Zeichen < > : " | ? *, keine Teile . oder .. und kein Trennzeichen am Ende')
  }
  const lower = path.toLowerCase()
  const data = DATA_DIR.toLowerCase()
  const forbidden = segments.length === 1
    || ['c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\'].some(prefix => lower.startsWith(prefix))
    || (lower.startsWith(`${data}\\`) && !lower.startsWith(`${data}\\data\\`))
  if (forbidden) {
    return error('db.path', 'sqlite_path_forbidden', 'Hier darf die Datenbank nicht liegen (Programmordner, Windows, Programme, Wurzel eines Laufwerks oder Datenordner außerhalb von data\\): Das Dienstkonto bekäme dort das Recht „Ändern“')
  }
  const letter = drive[1]!.toUpperCase()
  if (!LOCAL_DRIVES.includes(letter)) {
    warning('db.path', 'sqlite_drive_missing', `Laufwerk ${letter}: gibt es auf diesem Rechner nicht; der Dienst findet die Datei erst, wenn es da ist`)
  }
}

// Wie `ops::database_summary`
function databaseSummary(config: Config): string {
  const db = config.db
  if (db.kind === 'sqlite') return `SQLite: ${db.path.trim() || DEFAULT_DB_PATH}`
  if (!db.server.trim()) return 'SQL Server: (kein Server eingetragen)'
  return `SQL Server: ${db.server}:${db.port}, Datenbank ${db.database}`
}

// Auszug aus `validate.rs`, genug für die Vorschau; maßgeblich ist die Prüfung im Dienst
function validate(config: Config): Finding[] {
  const out: Finding[] = []
  const error = (field: string, code: string, message: string) => out.push({ field, code, message, severity: 'error' })
  const warning = (field: string, code: string, message: string) => out.push({ field, code, message, severity: 'warning' })

  const host = config.public.host.trim()
  if (!host) error('public.host', 'required', 'Hostname fehlt')
  else if (!HOST.test(host)) error('public.host', 'invalid_hostname', 'Hostname ist ungültig: erlaubt sind Buchstaben, Ziffern, Bindestriche und Punkte oder eine IP-Adresse, ohne Schema und Port')

  const ports: Array<[string, number]> = [['listen.http_port', config.listen.http_port], ['public.port', config.public.port], ['internal.port', config.internal.port]]
  if (config.db.kind === 'sqlserver') ports.push(['db.port', config.db.port])
  for (const [field, port] of ports) {
    if (port < 1 || port > 65535) error(field, 'invalid_port', 'Port muss zwischen 1 und 65535 liegen')
  }
  const listening: Array<[string, number]> = []
  if (config.tls.mode !== 'off') listening.push(['public.port', config.public.port])
  listening.push(['listen.http_port', config.listen.http_port], ['internal.port', config.internal.port])
  listening.forEach(([field, port], index) => {
    const other = listening.slice(0, index).find(([, p]) => p === port)
    if (port && other) error(field, 'port_conflict', `Port ${port} wird bereits von ${other[0]} verwendet`)
  })

  if (config.tls.mode === 'off' && !['http', 'https'].includes(config.public.scheme)) {
    error('public.scheme', 'invalid_scheme', 'Das Schema muss http oder https sein')
  }
  if (config.tls.mode === 'certificate') {
    const cert = mock.certificate
    if (!cert) {
      error('tls', 'certificate_missing', 'Es ist kein Zertifikat hinterlegt')
    }
    else {
      const left = new Date(cert.notAfter).getTime() - Date.now()
      if (left < 0) error('tls', 'certificate_expired', `Das Zertifikat ist am ${formatDate(cert.notAfter)} abgelaufen`)
      else if (left <= 30 * DAY_MS) warning('tls', 'certificate_expires_soon', `Das Zertifikat läuft am ${formatDate(cert.notAfter)} ab`)
      if (host && HOST.test(host) && !cert.dnsNames.includes(host.toLowerCase())) {
        error('public.host', 'certificate_hostname_mismatch', `Das Zertifikat gilt nicht für ${host}`)
      }
    }
  }
  if (config.tls.mode === 'acme') {
    const email = config.tls.acme_email.trim()
    if (!email) error('tls.acme_email', 'required', 'E-Mail-Adresse für ACME fehlt')
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error('tls.acme_email', 'invalid_email', 'Die E-Mail-Adresse ist ungültig (erwartet: name@domain.tld)')
    if (config.tls.acme_ca_url && !config.tls.acme_ca_url.startsWith('https://')) {
      error('tls.acme_ca_url', 'invalid_url', 'Die CA-URL muss eine gültige Adresse mit https:// sein')
    }
    if (Boolean(config.tls.acme_eab_key_id) !== Boolean(config.tls.acme_eab_hmac)) {
      error('tls.acme_eab_key_id', 'acme_eab_incomplete', 'EAB-Key-ID und EAB-HMAC-Schlüssel gehören zusammen')
    }
  }

  if (config.db.kind === 'sqlite') {
    validateSqlitePath(config.db.path, error, warning)
  }
  else {
    const server = config.db.server.trim()
    if (!server) error('db.server', 'required', 'Datenbankserver fehlt')
    else if (server.includes('\\')) error('db.server', 'named_instance_not_supported', 'Benannte Instanzen bitte über ihren festen TCP-Port angeben (nur den Servernamen eintragen, Port unter db.port)')
    else if (!DB_HOST.test(server)) error('db.server', 'invalid_hostname', 'Der Datenbankserver ist ungültig: erlaubt sind Buchstaben, Ziffern, Bindestriche, Unterstriche und Punkte oder eine IPv4-Adresse, ohne Port und ohne Instanznamen')
    for (const [field, value, label] of [['db.database', config.db.database, 'Datenbankname'], ['db.user', config.db.user, 'Datenbankbenutzer']] as const) {
      if (!value.trim()) error(field, 'required', `${label} fehlt`)
      else if (/[\]']/.test(value)) error(field, 'invalid_identifier', `${label} darf weder ] noch ' enthalten`)
    }
    if (['master', 'model', 'msdb', 'tempdb'].includes(config.db.database.trim().toLowerCase())) {
      error('db.database', 'system_database_not_allowed', 'Der Datenbankname darf keine SQL-Server-Systemdatenbank sein (master, model, msdb, tempdb) – bitte eine eigene Datenbank für den EPLAN Panel Data Service verwenden')
    }
    if (!config.db.password) error('db.password', 'required', 'Datenbankpasswort fehlt')
  }

  if (!config.oidc.issuer) {
    if (!config.oidc.tenant_id.trim()) error('oidc.tenant_id', 'required', 'Tenant-ID fehlt (oder einen eigenen Issuer angeben)')
    else if (!GUID.test(config.oidc.tenant_id)) error('oidc.tenant_id', 'invalid_guid', 'Die Tenant-ID muss eine GUID sein (z. B. 11111111-2222-3333-4444-555555555555)')
  }
  else if (!/^https:\/\/[^\s/]+/.test(config.oidc.issuer)) {
    error('oidc.issuer', 'invalid_url', 'Der Issuer muss eine gültige Adresse mit https:// sein (http:// nur für localhost)')
  }
  if (!config.oidc.client_id.trim()) error('oidc.client_id', 'required', 'Client-ID fehlt')
  else if (!config.oidc.issuer && !GUID.test(config.oidc.client_id)) error('oidc.client_id', 'invalid_guid', 'Die Client-ID muss eine GUID sein (z. B. 11111111-2222-3333-4444-555555555555)')
  if (!config.oidc.client_secret) warning('oidc.client_secret', 'oidc_client_secret_missing', 'Das Client-Secret fehlt, die Anmeldung schlägt ohne es meist fehl')

  if (config.proxy.url && !/^https?:\/\/[^\s/]+/.test(config.proxy.url)) {
    error('proxy.url', 'invalid_url', 'Die Proxy-Adresse muss eine gültige Adresse mit http:// oder https:// sein')
  }
  else if (/^https?:\/\/[^/@]+@/.test(config.proxy.url)) {
    error('proxy.url', 'proxy_credentials_not_supported', 'Zugangsdaten in der Proxy-Adresse werden nicht unterstützt – sie stünden im Klartext in der Konfiguration')
  }
  if (!config.app.secret) error('app.secret', 'app_secret_missing', 'Das App-Secret fehlt')
  return out
}

/** Wie `merge_masked`: "***" behält das gespeicherte Secret */
function merged(draft: Config): Config {
  const copy = clone(draft)
  for (const path of SECRET_FIELDS) {
    const [section, key] = path.split('.') as [keyof Config, string]
    const values = copy[section] as Record<string, string>
    if (values[key] === '***') values[key] = secretOf(mock.config, path) ? 'gespeichert' : ''
  }
  return copy
}

/** Dienst läuft, liest config.toml aber nicht: keine Kinder, keine Health-Abfrage */
function brokenReport(): StatusReport {
  return {
    service: mock.service,
    status: {
      state: 'unconfigured',
      since: iso(-10 * 60 * 1000),
      heartbeat: iso(-2_000),
      productVersion: '1.2.0',
      nodeVersion: '24.22.3',
      caddyVersion: '2.11.9',
      health: null,
      lastError: null,
      nextAttempt: null,
      findings: [UNREADABLE],
      certificateNotAfter: null,
      app: { pid: null, running: false, restarts: 0 },
      proxy: { pid: null, running: false, restarts: 0 },
    },
    statusError: null,
    stale: false,
    internal: null,
    public: null,
    appUrl: '',
    database: '',
    configError: null,
    eplan: eplanStatus(),
  }
}

function statusReport(): StatusReport {
  if (broken()) return brokenReport()
  const isStale = stale()
  const running = mock.state === 'running'
  const report: StatusReport = {
    service: isStale ? { ...mock.service, state: 'stopped' } : mock.service,
    status: {
      state: isStale ? 'running' : mock.state,
      since: mock.since,
      heartbeat: iso(isStale ? -95_000 : -2_000),
      productVersion: '1.2.0',
      nodeVersion: '24.22.3',
      caddyVersion: '2.11.9',
      health: running ? { ok: true, checkedAt: iso(-4_000), message: null } : null,
      lastError: isStale || mock.config.db.kind !== 'sqlserver'
        ? null
        : { at: iso(-26 * 60 * 60 * 1000), source: 'app', message: 'Datenbank nicht erreichbar: Zeitüberschreitung beim Verbinden mit sql01.example.com:1433' },
      nextAttempt: null,
      findings: validate(mock.config).filter(f => f.field === 'tls'),
      certificateNotAfter: mock.certificate?.notAfter ?? null,
      app: { pid: running ? 4712 : null, running, restarts: 1 },
      proxy: { pid: running ? 4711 : null, running, restarts: 0 },
    },
    statusError: null,
    stale: isStale,
    internal: running ? { ok: !isStale, status: isStale ? null : 200, message: isStale ? 'Nicht erreichbar: Verbindung abgelehnt' : 'HTTP 200' } : null,
    public: running ? { ok: !isStale, status: isStale ? null : 200, message: isStale ? 'Nicht erreichbar: Verbindung abgelehnt' : 'HTTP 200' } : null,
    appUrl: appUrlOf(mock.config),
    database: databaseSummary(mock.config),
    configError: null,
    eplan: eplanStatus(),
  }
  return report
}

function step(code: string, message: string, kind: 'ok' | 'warning' | 'error' = 'ok', extra: Record<string, unknown> = {}): ToolLine {
  const details = kind === 'warning' ? { warning: true } : kind === 'error' ? { error: code } : {}
  return { type: 'step', ok: kind === 'ok', code, message, details: { ...details, ...extra } }
}

function result(steps: ToolLine[], message: string, code = 'ok'): ToolResult {
  return { ok: code === 'ok', code, message, steps, details: {} }
}

function control(action: ServiceAction): StatusReport {
  const running = action !== 'stop'
  mock.state = running ? 'running' : 'stopped'
  mock.service = { ...mock.service, state: running ? 'running' : 'stopped' }
  mock.since = iso(0)
  return statusReport()
}

// Wie `logic::db_setup` und `logic::db_script`: Eine SQLite-Datei braucht keine Einrichtung
function sqlServerOnly(draft: Config) {
  if (draft.db.kind !== 'sqlserver') {
    throw Object.assign(new Error('Nur für SQL Server: Eine SQLite-Datei braucht keine Einrichtung.'), { code: 'sqlserver_only' })
  }
}

function sqliteTest(draft: Config): ToolResult {
  const custom = draft.db.path.trim()
  const path = custom || DEFAULT_DB_PATH
  if (isNetworkPath(path)) {
    return result([
      step('open', `${path} liegt auf einem Netzlaufwerk; SQLite braucht ein lokales Laufwerk.`, 'error'),
    ], 'Die Datenbankdatei lässt sich nicht verwenden.', 'network_path')
  }
  // Neue Installation: Die Standarddatei gibt es noch nicht; der Test legt nichts an, das tut der Dienst
  if (!custom && fresh()) {
    return result([
      step('open', `${path} gibt es noch nicht: eine neue Datenbank, die der Dienst bei seinem Start anlegt. Angelegt wurde nichts.`, 'ok', { path, exists: false, folderExists: true, created: false }),
      step('sqlite_version', 'SQLite 3.50.4.', 'ok', { version: '3.50.4' }),
      step('migrations', 'Noch keine Migrationen: Die App legt ihre Tabellen beim ersten Start an.', 'ok', { core: 0, pds: 0 }),
    ], `Die SQLite-Datenbank ${path} gibt es noch nicht; der Dienst legt sie bei seinem Start an.`)
  }
  const steps = [
    step('open', `${path} geöffnet.`, 'ok', { path, exists: true, folderExists: true, created: false }),
    step('writable', 'Die Datei und ihr Ordner sind beschreibbar.'),
    step('sqlite_version', 'SQLite 3.50.4.', 'ok', { version: '3.50.4' }),
    step('migrations', 'Migrationen ausgeführt: core 9, pds 6.', 'ok', { core: 9, pds: 6 }),
  ]
  return result(steps, `Die Datenbankdatei ${path} ist bereit.`)
}

type Handlers = { [C in Command]: (args: Commands[C]['args']) => Promise<Commands[C]['result']> }

const handlers: Handlers = {
  async load_state() {
    await sleep(150)
    if (broken()) {
      // Wie bei einer unlesbaren Datei: Standardwerte, einziger Befund `config_unreadable`
      const config = defaultConfig()
      return { config, findings: [UNREADABLE], certificate: null, status: brokenReport(), appUrl: '', redirectUri: '', issuer: issuerOf(config), defaultDbPath: DEFAULT_DB_PATH }
    }
    const config = masked(mock.config)
    return {
      config,
      findings: validate(mock.config),
      certificate: mock.certificate,
      status: statusReport(),
      appUrl: appUrlOf(config),
      redirectUri: redirectUriOf(config),
      issuer: issuerOf(config),
      defaultDbPath: DEFAULT_DB_PATH,
    }
  },
  async validate_draft({ draft }) {
    await sleep(80)
    return broken() ? [UNREADABLE, ...validate(draft)] : validate(merged(draft))
  },
  async save_draft({ draft }) {
    await sleep(400)
    const findings = broken() ? [UNREADABLE, ...validate(draft)] : validate(merged(draft))
    if (findings.some(f => f.severity === 'error')) return { findings, saved: false, apply: null, warnings: [] }
    mock.config = merged(draft)
    await sleep(1200)
    mock.state = 'running'
    mock.since = iso(0)
    return {
      findings,
      saved: true,
      apply: { ok: true, state: 'running', message: 'Der Dienst läuft, Health ok.', waitedSeconds: 7 },
      // Wie `ops::save_config`, wenn die Firewall-Regel nicht angelegt werden kann
      warnings: gpo()
        ? ['Firewall-Regel „EPLAN Panel Data Service (HTTP/HTTPS)“ konnte nicht angelegt werden: Zugriff verweigert. Bitte als Administrator ausführen. – bitte Ports 80, 443 von Hand freigeben']
        : [],
    }
  },
  async get_status() {
    return statusReport()
  },
  async service_control({ action }) {
    await sleep(600)
    return control(action)
  },
  // Wie `logic::eplan_install`: erst das Konto, dann Programm, dann die Anmeldeprüfung
  async eplan_install({ account, password }) {
    await sleep(900)
    const problem = accountProblem(account)
    if (problem) {
      const codes = { missing: 'eplan_account_missing', noDomain: 'eplan_account_invalid', builtin: 'eplan_account_builtin', managed: 'eplan_account_managed', invalid: 'eplan_account_invalid' } as const
      fail(codes[problem], texts.eplan.accountProblems[problem])
    }
    if (noWorker()) fail('eplan_worker_missing', `Der EPLAN-Worker fehlt in dieser Installation (${EPLAN_EXE}).`)
    if (!password) fail('eplan_password_missing', 'Das Passwort fehlt.')
    const name = account.trim()
    if (password === 'falsch') {
      fail('eplan_logon_failed', `Die Anmeldung als „${name}“ ist fehlgeschlagen: Benutzername oder Passwort ist falsch. Am Dienst wurde nichts geändert.`)
    }
    const created = mock.eplan.state === 'not_installed'
    mock.eplan = { state: 'running', startType: 'auto', delayed: true, account: name }
    return {
      created,
      account: name,
      started: true,
      // Wie `rights_step`: Die Rechte des bisherigen Kontos fallen weg
      warnings: created ? [] : ['Bisherige Rechte im Datenordner entfernt: work: EXAMPLE\\alt (S-1-5-21-1-2-3-1100)'],
    }
  },
  async eplan_control({ action }) {
    await sleep(500)
    if (mock.eplan.state === 'not_installed') {
      fail('eplan_not_installed', 'Der EPLAN-Worker ist nicht eingerichtet – zuerst `pds eplan install --user <konto>`.')
    }
    mock.eplan = { ...mock.eplan, state: action === 'stop' ? 'stopped' : 'running' }
    return statusReport()
  },
  // Das Beispielzertifikat gilt für den Hostnamen des Entwurfs (leer: den gespeicherten)
  async tls_import_pfx({ host }) {
    await sleep(500)
    mock.certificate = certificate(730, host.trim() || mock.config.public.host)
    return mock.certificate
  },
  async tls_import_pem({ host }) {
    await sleep(500)
    mock.certificate = certificate(730, host.trim() || mock.config.public.host)
    return mock.certificate
  },
  async tls_import_store({ host }) {
    await sleep(500)
    mock.certificate = certificate(365, host.trim() || mock.config.public.host)
    return mock.certificate
  },
  async tls_list_store() {
    await sleep(200)
    return [
      { thumbprint: '8C1D3E5F7A9B0C2D4E6F8A0B1C3D5E7F9A1B3C5D', subject: mock.config.public.host, notAfter: iso(365 * DAY_MS), hasPrivateKey: true },
      { thumbprint: '3F2A9C1D7E5B4A6C8D0E1F2A3B4C5D6E7F8A9B0C', subject: mock.config.public.host, notAfter: iso(20 * DAY_MS), hasPrivateKey: true },
      { thumbprint: '0A1B2C3D4E5F60718293A4B5C6D7E8F901234567', subject: 'Example Root CA', notAfter: iso(3650 * DAY_MS), hasPrivateKey: false },
    ]
  },
  async db_test({ draft }) {
    await sleep(700)
    if (draft.db.kind === 'sqlite') return sqliteTest(draft)
    const { server, port, database, user } = draft.db
    return result([
      step('connect', `Verbindung zu ${server}:${port} hergestellt.`),
      step('server_version', 'SQL Server 2022 (16.0.4135.4), Standard Edition (64-bit).'),
      step('db_owner', `„${user}“ ist db_owner der Datenbank „${database}“.`),
      step('read_committed_snapshot', 'READ_COMMITTED_SNAPSHOT ist ausgeschaltet: Leser blockieren dann Schreiber. Die Einrichtung (db-setup) bzw. das SQL-Skript schaltet es ein.', 'warning'),
      step('migrations', 'Migrationen ausgeführt: core 9, pds 6.'),
    ], `Die Verbindung zur Datenbank „${database}“ funktioniert, aber ein Hinweis ist zu beachten.`)
  },
  async db_setup({ draft, adminUser }) {
    await sleep(900)
    sqlServerOnly(draft)
    const { server, port, database, user } = draft.db
    // Wie `logic::db_setup`: Ohne Login geschieht nichts
    if (!adminUser.trim()) throw Object.assign(new Error('Der Administrator-Login fehlt.'), { code: 'db_admin_user_missing' })
    // Wie `ops::db_setup`: Ohne Passwort im Entwurf und in der Datei wird eins erzeugt und gespeichert,
    // auch wenn die Einrichtung danach scheitert
    const stored = secretOf(mock.config, 'db.password')
    const passwordGenerated = !(draft.db.password === '***' ? stored : draft.db.password) && !stored
    if (passwordGenerated) mock.config.db.password = 'erzeugt'
    return {
      result: result([
        step('connect', `Als Administrator mit ${server}:${port} verbunden.`),
        step('database', `Datenbank „${database}“ ist schon vorhanden.`),
        step('read_committed_snapshot', 'READ_COMMITTED_SNAPSHOT eingeschaltet (offene Verbindungen zur Datenbank wurden getrennt).'),
        step('login', `Login „${user}“ ist schon vorhanden, sein Passwort wurde neu gesetzt.`),
        step('db_owner', `„${user}“ ist Benutzer und db_owner der Datenbank „${database}“.`),
      ], `Datenbank „${database}“ und Login „${user}“ sind bereit.`),
      passwordGenerated,
    }
  },
  async db_script({ draft, path }) {
    await sleep(300)
    sqlServerOnly(draft)
    return { ...result([], 'SQL-Skript erzeugt.'), details: { path } }
  },
  async db_backup({ draft, path }) {
    await sleep(600)
    if (draft.db.kind !== 'sqlite') {
      return result([], 'Sicherungen erstellt dieses Werkzeug nur für SQLite; SQL Server sichern die DBAs.', 'not_supported')
    }
    const source = draft.db.path.trim() || DEFAULT_DB_PATH
    const bytes = 18_874_368
    return {
      ...result([
        step('open', `${source} geöffnet.`),
        step('backup', 'Online-Sicherung geschrieben (18 874 368 Byte).'),
        step('verify', 'Die Sicherung ist vollständig lesbar (integrity_check ok).'),
      ], 'Die Datenbank wurde gesichert.'),
      details: { file: path, bytes },
    }
  },
  async oidc_test({ draft, checkClient }) {
    await sleep(800)
    const host = new URL(issuerOf(draft)).host
    const steps = [
      step('discovery', `Discovery-Dokument von ${host} abgerufen.`),
      step('issuer', 'Der Issuer im Discovery-Dokument stimmt überein.'),
      step('endpoints', 'Anmelde-, Token- und Schlüssel-Endpunkt sind vorhanden.'),
    ]
    if (checkClient) {
      steps.push(draft.oidc.client_secret
        ? step('client', 'Client-ID und Client-Secret werden von Entra ID akzeptiert.')
        : step('client', 'Client-ID und Client-Secret wurden nicht geprüft: Das Client-Secret fehlt.', 'warning'))
    }
    const warnings = steps.filter(s => !s.ok).length
    return result(steps, `Der Issuer ${host} ist erreichbar und das Discovery-Dokument passt${warnings ? ', aber ein Hinweis ist zu beachten' : ''}.`)
  },
  async ports_check({ draft }) {
    await sleep(400)
    // Wie `logic::wanted_ports`: HTTP, HTTPS (nicht bei `off`), intern; je einmal, ohne 0
    const wanted = [draft.listen.http_port, ...(draft.tls.mode === 'off' ? [] : [draft.public.port]), draft.internal.port]
    const ports = wanted.filter((port, index) => port !== 0 && wanted.indexOf(port) === index)
    return ports.map((port) => {
      if (port === 80) return { port, free: false, ownerPid: 4, ownerName: 'System', httpSys: true }
      if (port === draft.internal.port) return { port, free: false, ownerPid: 4712, ownerName: 'node.exe', httpSys: false }
      return { port, free: false, ownerPid: 4711, ownerName: 'caddy.exe', httpSys: false }
    })
  },
  async regenerate_app_secret() {
    await sleep(300)
    return null
  },
  async logs_dir() {
    return LOGS_DIR
  },
  async open_web_console() {
    // Wie `logic::web_console_url`: nur die gespeicherte Adresse; den Browser öffnet hier niemand
    if (!mock.config.public.host.trim()) {
      throw Object.assign(new Error('Es ist noch kein Hostname gespeichert.'), { code: 'web_console_unconfigured' })
    }
    await sleep(200)
    return null
  },
  async open_log_file({ path }) {
    // Wie `logic::log_file`: nur Dateien im Logordner
    if (!path.startsWith(`${LOGS_DIR}\\`) || path.includes('..')) {
      throw Object.assign(new Error(`${path} ist keine Datei im Logordner ${LOGS_DIR}`), { code: 'invalid_path' })
    }
    return null
  },
}

export async function mockInvoke<C extends Command>(command: C, args: Commands[C]['args'] | undefined): Promise<Commands[C]['result']> {
  const handler = handlers[command] as (args: Commands[C]['args'] | undefined) => Promise<Commands[C]['result']>
  return clone(await handler(args))
}

export async function mockPickFile(filters: FileFilter[], defaultPath?: string): Promise<string | null> {
  const extension = (filters[0]?.extensions[0] ?? 'pem').replace('*', '')
  return defaultPath
    ? `${defaultPath}\\service.${extension}`
    : `C:\\Users\\admin\\Downloads\\pds.${extension}`
}

export async function mockPickSavePath(defaultPath: string): Promise<string | null> {
  return `C:\\Users\\admin\\Documents\\${defaultPath}`
}
