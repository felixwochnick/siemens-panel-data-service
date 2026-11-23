// Alle Texte der Oberfläche (nur Deutsch). Zustände und Statuszeilen wie in der CLI (`status`).
import type { ChildStatus } from './bindings/ChildStatus'
import type { DbKind } from './bindings/DbKind'
import type { EplanStatus } from './bindings/EplanStatus'
import type { PortStatus } from './bindings/PortStatus'
import type { ProbeResult } from './bindings/ProbeResult'
import type { ScmInfo } from './bindings/ScmInfo'
import type { ScmState } from './bindings/ScmState'
import type { ServiceState } from './bindings/ServiceState'
import type { TlsMode } from './bindings/TlsMode'

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

const stateTexts: Record<ServiceState, string> = {
  unconfigured: 'nicht eingerichtet',
  starting: 'startet',
  running: 'läuft',
  backoff: 'wartet auf erneuten Versuch',
  config_error: 'Konfigurationsfehler',
  stopping: 'wird beendet',
  stopped: 'gestoppt',
}

const scmTexts: Record<Exclude<ScmState, 'not_installed'>, string> = {
  stopped: 'gestoppt',
  start_pending: 'startet',
  running: 'läuft',
  stop_pending: 'wird beendet',
  other: 'angehalten oder im Übergang',
}

function startTypeText(service: ScmInfo): string {
  switch (service.startType) {
    case 'auto': return service.delayed ? 'automatisch, verzögert' : 'automatisch'
    case 'manual': return 'manuell'
    case 'disabled': return 'deaktiviert'
    default: return service.startType
  }
}

// Wie `status_text` in der CLI (`pds status`)
function serviceText(service: ScmInfo | null): string {
  if (!service) return 'nicht abfragbar (nur unter Windows mit Dienststeuerung)'
  if (service.state === 'not_installed') return 'nicht installiert'
  const start = startTypeText(service)
  return start ? `${scmTexts[service.state]} (Start: ${start})` : scmTexts[service.state]
}

// Wie `eplan_cmd::summary` in der CLI
function eplanSummary(eplan: EplanStatus): string {
  if (!eplan.workerPresent) return 'fehlt in dieser Installation (MSI ohne EPLAN-Worker gebaut)'
  if (!eplan.service) return serviceText(null)
  if (eplan.service.state === 'not_installed') return 'nicht eingerichtet'
  return `${serviceText(eplan.service)}, Konto ${eplan.service.account}`
}

export const texts = {
  app: {
    name: 'EPLAN Panel Data Service',
    subtitle: 'Konfiguration',
    loading: 'Konfiguration wird geladen …',
    loadFailed: 'Konfiguration konnte nicht geladen werden',
    retry: 'Erneut laden',
    demo: 'Vorschau mit Beispieldaten',
    navigation: 'Bereiche',
    colorMode: 'Farbschema',
    findingsBadge: (errors: number, warnings: number) =>
      [errors ? plural(errors, 'Fehler', 'Fehler') : '', warnings ? plural(warnings, 'Warnung', 'Warnungen') : '']
        .filter(Boolean).join(', '),
  },

  sections: {
    status: 'Status',
    addressTls: 'Adresse und TLS',
    database: 'Datenbank',
    login: 'Anmeldung',
    eplan: 'EPLAN-Worker',
    assistants: 'KI-Assistenten',
  },

  actions: {
    save: 'Speichern',
    discard: 'Verwerfen',
    start: 'Starten',
    stop: 'Stoppen',
    restart: 'Neu starten',
    openLogs: 'Logdatei öffnen …',
    openWebConsole: 'Web-App öffnen',
    testConnection: 'Verbindung testen',
    setup: 'Einrichten …',
    exportScript: 'SQL-Skript exportieren …',
    saveBackup: 'Sicherung speichern …',
    check: 'Prüfen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    regenerate: 'Neu erzeugen …',
    remove: 'Entfernen',
    undo: 'Rückgängig',
    cancel: 'Abbrechen',
    choose: 'Auswählen …',
    import: 'Importieren',
    checkPorts: 'Ports prüfen',
    showSecret: 'Eingabe anzeigen',
    hideSecret: 'Eingabe verbergen',
  },

  placeholders: {
    https: 'https://',
    http: 'http://',
  },

  errors: {
    title: 'Fehler',
    validationFailed: 'Die Prüfung der Eingaben ist fehlgeschlagen',
  },

  finding: {
    error: 'Fehler',
    warning: 'Warnung',
  },

  secret: {
    setPlaceholder: 'gesetzt – zum Ändern neu eingeben',
    emptyPlaceholder: 'nicht gesetzt',
    removedPlaceholder: 'wird beim Speichern entfernt',
  },

  saveBar: {
    changes: (count: number) => count === 0
      ? 'Keine ungespeicherten Änderungen'
      : plural(count, 'ungespeicherte Änderung', 'ungespeicherte Änderungen'),
    errors: (count: number) => plural(count, 'Fehler', 'Fehler'),
    warnings: (count: number) => plural(count, 'Warnung', 'Warnungen'),
    validating: 'wird geprüft …',
    saving: 'Speichern und Dienst neu starten … (bis 90 s)',
    blocked: 'Erst die Fehler beheben',
    applied: 'Gespeichert – der Dienst läuft',
    applyFailed: 'Gespeichert, aber der Dienst läuft nicht',
    savedOnly: 'Gespeichert',
    notRestarted: 'Der Dienst wurde nicht neu gestartet. Die Änderungen werden beim nächsten Start wirksam.',
    notSaved: 'Nicht gespeichert',
    notSavedDetail: 'Die Konfiguration enthält Fehler. Sie sind an den Feldern markiert.',
    waited: (seconds: number) => `nach ${seconds} s`,
  },

  status: {
    heading: 'Status',
    description: 'Zustand der Windows-Dienste, Erreichbarkeit der Web-App und letzte Meldungen.',
    stale: (seconds: number) => `Dienst läuft nicht (letztes Lebenszeichen vor ${seconds} s)`,
    staleDetail: 'Der zuletzt geschriebene Status ist veraltet. Der Dienst ist abgestürzt oder wurde beendet.',
    logFilter: 'Logdateien',
    logOpened: (file: string) => `Im Editor geöffnet: ${file}`,
    webConsole: {
      heading: 'Web-App',
      description: 'In der Web-App analysieren alle angemeldeten Benutzer EPLAN-Projekte (hochladen oder aus dem Projektordner wählen) und sehen die Ergebnisse als Tabellen. Admins stellen dort zusätzlich Projektordner, Netzlaufwerk, EPLAN-Pfade, Zeitplan und Aufbewahrung ein und sehen die Protokolle. Diese Oberfläche richtet nur Adresse, Zertifikat, Datenbank, Anmeldung und den EPLAN-Worker ein.',
      opened: (url: string) => `Im Browser geöffnet: ${url}`,
    },
    labels: {
      service: 'Dienst',
      state: 'Zustand',
      address: 'Adresse',
      database: 'Datenbank',
      healthInternal: 'Health intern',
      healthPublic: 'Health öffentlich',
      eplan: 'EPLAN-Worker',
      versions: 'Versionen',
      app: 'App (Node)',
      proxy: 'Proxy (Caddy)',
      certificate: 'Zertifikat',
      nextAttempt: 'Nächster Versuch',
      lastError: 'Letzter Fehler',
      findings: 'Befunde',
    },
    stateText: (state: ServiceState) => stateTexts[state],
    since: (state: string, since: string) => `${state} (seit ${since})`,
    noStatus: 'Kein Status vorhanden – der Dienst lief noch nie',
    noAddress: '(kein Hostname konfiguriert)',
    service: serviceText,
    eplan: eplanSummary,
    probe: (probe: ProbeResult | null) => {
      if (!probe) return 'nicht geprüft'
      return probe.ok ? `ok (${probe.message})` : `Fehler (${probe.message})`
    },
    child: (child: ChildStatus) => {
      const running = child.running
        ? (child.pid !== null ? `läuft (PID ${child.pid})` : 'läuft')
        : 'läuft nicht'
      return `${running}, ${child.restarts} Neustarts`
    },
    versions: (product: string, node: string, caddy: string) => {
      const known = (value: string) => value || 'unbekannt'
      return `Produkt ${known(product)}, Node ${known(node)}, Caddy ${known(caddy)}`
    },
    certificate: (date: string, days: number) => days < 0
      ? `abgelaufen am ${date}`
      : `gültig bis ${date} (noch ${plural(days, 'Tag', 'Tage')})`,
    noError: '–',
    lastError: (at: string, source: string, message: string) => `${at} (${source}): ${message}`,
    confirmStopTitle: 'Dienst stoppen?',
    confirmStop: 'Die Web-App ist danach nicht mehr erreichbar, und es laufen keine Analysen, bis der Dienst wieder gestartet wird.',
    controlDone: {
      start: 'Dienst wird gestartet',
      stop: 'Dienst wird gestoppt',
      restart: 'Dienst wird neu gestartet',
    },
  },

  addressTls: {
    heading: 'Adresse und TLS',
    description: 'Unter welcher Adresse die Web-App erreichbar ist und woher das Zertifikat kommt.',
    address: 'Adresse',
    host: 'Hostname',
    hostHelp: 'Ohne Schema und Port, so wie ihn die Benutzer im Browser eingeben.',
    hostPlaceholder: 'pds.example.com',
    port: 'Öffentlicher Port',
    appUrl: 'App-Adresse',
    appUrlHelp: 'Ergibt sich aus Hostname, Port und TLS-Modus.',
    tls: 'TLS',
    mode: 'Modus',
    modes: {
      certificate: { label: 'Zertifikat', description: 'Eigenes Zertifikat, z. B. aus der Firmen-PKI' },
      acme: { label: 'ACME', description: 'Automatisch von einer ACME-Zertifizierungsstelle' },
      internal: { label: 'Intern', description: 'Von Caddy selbst ausgestellt – nur zum Testen' },
      off: { label: 'Aus', description: 'Nur HTTP; TLS übernimmt ein vorgelagerter Proxy' },
    } satisfies Record<TlsMode, { label: string, description: string }>,
    certificate: 'Zertifikat',
    noCertificate: 'Es ist kein Zertifikat hinterlegt.',
    certificateLabels: {
      subject: 'Ausgestellt für',
      issuer: 'Aussteller',
      dnsNames: 'Namen (SAN)',
      validity: 'Gültig',
      thumbprint: 'Fingerabdruck (SHA-1)',
    },
    validity: (from: string, to: string) => `${from} bis ${to}`,
    importPfx: 'PFX-Datei …',
    importPem: 'PEM-Dateien …',
    importStore: 'Aus Zertifikatspeicher …',
    importHint: 'Der Import gilt sofort und unabhängig vom Speichern. Wirksam wird er mit dem nächsten Neustart des Dienstes.',
    imported: 'Zertifikat importiert',
    importedDetail: 'Wirksam nach dem nächsten Neustart des Dienstes (Status → Neu starten).',
    pfxTitle: 'PFX-Datei importieren',
    pfxDescription: 'Zertifikat mit privatem Schlüssel. Das Passwort wird nur für den Import verwendet und nicht gespeichert.',
    pfxFilter: 'PFX/PKCS#12',
    pemTitle: 'PEM-Dateien importieren',
    pemDescription: 'Zertifikatskette und privater Schlüssel als getrennte PEM-Dateien.',
    pemFilter: 'PEM',
    file: 'Datei',
    password: 'Passwort',
    certFile: 'Zertifikat (Kette)',
    keyFile: 'Privater Schlüssel',
    noFile: 'keine Datei ausgewählt',
    storeTitle: 'Zertifikat aus dem Speicher wählen',
    storeDescription: 'Zertifikate aus LocalMachine\\My. Verwendbar sind nur solche mit privatem Schlüssel.',
    storeEmpty: 'Im Speicher liegt kein Zertifikat.',
    storeNoKey: 'ohne privaten Schlüssel',
    storeValidUntil: (date: string) => `gültig bis ${date}`,
    acmeEmail: 'E-Mail-Adresse',
    acmeEmailHelp: 'Für Hinweise der Zertifizierungsstelle, z. B. zum Ablauf.',
    acmeCaUrl: 'CA-URL',
    acmeCaUrlHelp: 'Leer lassen für den Standard von Caddy (Let’s Encrypt).',
    acmeCaRoot: 'CA-Stammzertifikat',
    acmeCaRootHelp: 'PEM-Datei, falls die Zertifizierungsstelle nicht öffentlich vertrauenswürdig ist.',
    acmeEabKeyId: 'EAB-Key-ID',
    acmeEabHmac: 'EAB-HMAC-Schlüssel',
    acmeEabHelp: 'Nur, wenn die Zertifizierungsstelle External Account Binding verlangt.',
    internalHint: 'Caddy stellt das Zertifikat mit einer eigenen Zertifizierungsstelle aus. Browser vertrauen ihm nicht – nur zum Testen.',
    scheme: 'Öffentliches Schema',
    cookieHint: 'Bei „http“ setzt die App das Sitzungs-Cookie ohne Secure-Flag. „https“ wählen, wenn ein vorgelagerter Proxy TLS übernimmt.',
    ports: 'Ports',
    httpPort: 'HTTP-Port',
    httpPortRedirect: 'Leitet auf HTTPS um.',
    httpPortOff: 'Caddy nimmt hier HTTP an.',
    internalPort: 'Interner Port',
    internalPortHelp: 'Node lauscht nur auf 127.0.0.1.',
    portsHelp: 'Zeigt, ob die Ports frei sind und welcher Prozess sie belegt.',
    portLabel: (port: number) => `Port ${port}`,
    portState: (status: PortStatus) => {
      if (status.free) return 'frei'
      if (status.httpSys) return 'belegt von http.sys (IIS, WinRM oder URL-Reservierung, PID 4)'
      if (status.ownerName) return `belegt von ${status.ownerName}${status.ownerPid !== null ? ` (PID ${status.ownerPid})` : ''}`
      return status.ownerPid !== null ? `belegt (PID ${status.ownerPid})` : 'belegt'
    },
  },

  database: {
    heading: 'Datenbank',
    description: 'Wo die App Einstellungen, Projekte und Analyse-Ergebnisse speichert: in einer SQLite-Datei auf diesem Server oder auf einem SQL Server. Ihre Tabellen legt die App beim Start selbst an.',
    storage: 'Speicherort',
    kind: 'Art der Datenbank',
    kinds: {
      sqlite: { label: 'SQLite (Datei)', description: 'Eine Datei auf diesem Server, ohne eigenen Datenbankserver (Standard)' },
      sqlserver: { label: 'SQL Server', description: 'Eine Datenbank auf einem vorhandenen SQL Server – empfohlen, wenn andere Systeme die Ergebnisse lesen (Sichten pds.v_current_*)' },
    } satisfies Record<DbKind, { label: string, description: string }>,
    kindChangeTitle: 'Nach dem Speichern startet die App mit einer leeren Datenbank',
    kindChange: (from: DbKind) => `Einstellungen, Projekte und Analysen bleiben in der bisherigen Datenbank (${from === 'sqlite' ? 'SQLite-Datei' : 'SQL Server'}) und werden nicht übertragen. Sie wird nicht gelöscht: Ein Wechsel zurück findet ihre Daten wieder.`,
    path: 'Datenbankdatei',
    pathHelp: 'Leer lassen für die Standarddatei im Datenordner. Nur ein lokales Laufwerk, nie ein Netzlaufwerk: Dort drohen Sperrfehler und eine beschädigte Datenbank.',
    pathFolder: 'Bei einem eigenen Pfad legt das Speichern einen fehlenden Ordner an und gibt dem Dienstkonto NT SERVICE\\pds dort das Recht „Ändern“, denn SQLite legt neben der Datei die Hilfsdateien -wal und -shm an.',
    connection: 'Verbindung',
    server: 'Server',
    serverHelp: 'Hostname oder IPv4-Adresse, ohne Instanznamen (benannte Instanzen über ihren festen Port).',
    serverPlaceholder: 'sql01.example.com',
    port: 'Port',
    database: 'Datenbank',
    user: 'Benutzer (SQL-Login)',
    password: 'Passwort',
    encrypt: 'Verbindung verschlüsseln',
    encryptHelp: 'Empfohlen. Das Serverzertifikat muss einer Zertifizierungsstelle im Windows-Zertifikatspeicher vertrauen.',
    trust: 'Serverzertifikat ohne Prüfung vertrauen',
    trustHelp: 'Nur für Tests: schaltet die Prüfung des Serverzertifikats ab.',
    tools: 'Prüfen und einrichten',
    toolsHelp: 'Die Prüfungen verwenden die Eingaben oben, auch wenn sie noch nicht gespeichert sind.',
    sqliteTools: 'Prüfen und sichern',
    sqliteToolsHelp: 'Beide verwenden die Datei aus den Eingaben oben, auch ungespeichert. Der Test legt nichts an: Eine vorhandene Datei öffnet er und prüft, ob sie sich beschreiben lässt, und zählt die Migrationen; fehlt sie, legt der Dienst sie bei seinem Start an, einen fehlenden Ordner das Speichern. Die Sicherung kopiert die Datenbank im laufenden Betrieb in eine neue Datei und prüft die Kopie.',
    backupFilter: 'SQLite-Datenbank',
    backupSaved: (file: string, size: string | null) => size ? `Gespeichert unter ${file} (${size})` : `Gespeichert unter ${file}`,
    setupTitle: 'Datenbank einrichten',
    setupDescription: 'Legt Datenbank, Login und Benutzer an, wie es die Anwendung braucht. Dafür ist ein SQL-Login mit sysadmin-Rechten nötig (z. B. sa).',
    setupNotes: [
      'Ist schon alles vorhanden, wird nichts doppelt angelegt.',
      'Das Login bekommt das Passwort aus der Konfiguration neu gesetzt; offene Verbindungen zur Datenbank werden dabei getrennt.',
      'Ist kein Passwort eingetragen, wird ein zufälliges erzeugt und gespeichert.',
      'Die Admin-Anmeldedaten werden nur für diesen Vorgang verwendet und nicht gespeichert.',
    ],
    setupUnsavedPassword: 'Das eingegebene Passwort ist noch nicht gespeichert',
    setupUnsavedPasswordDetail: 'Die Einrichtung setzt es sofort am SQL-Login. Danach die Konfiguration speichern, sonst meldet sich die Anwendung weiter mit dem alten Passwort an und scheitert.',
    adminUser: 'Admin-Login',
    adminPassword: 'Admin-Passwort',
    runSetup: 'Einrichten',
    scriptFilter: 'SQL-Skript',
    scriptFile: 'pds-setup.sql',
    scriptSaved: (path: string) => `Gespeichert unter ${path}`,
    passwordGenerated: 'Es war kein Datenbankpasswort gesetzt: Ein neues wurde erzeugt und verschlüsselt gespeichert. Die Anwendung übernimmt es mit dem nächsten Neustart des Dienstes.',
  },

  login: {
    heading: 'Anmeldung',
    description: 'Anmeldung an der Web-App über Microsoft Entra ID (OpenID Connect).',
    entra: 'Entra ID',
    tenantId: 'Tenant-ID',
    tenantIdUnused: 'Wird nicht verwendet, solange ein eigener Issuer eingetragen ist.',
    guidPlaceholder: '11111111-2222-3333-4444-555555555555',
    clientId: 'Client-ID (Anwendungs-ID)',
    clientSecret: 'Client-Secret',
    clientSecretHelp: 'Wird nie angezeigt.',
    rolesClaim: 'Rollen-Claim',
    rolesClaimHelp: 'Claim im ID-Token mit den App-Rollen.',
    adminRoles: 'Admin-Rollen',
    adminRolesHelp: 'Kommagetrennt; Personen mit einer dieser App-Rollen sind Admins (Einstellungen, Protokolle, Löschen). Alle anderen angemeldeten Personen analysieren Projekte und sehen die Ergebnisse.',
    providerName: 'Anzeigename',
    providerNameHelp: 'Erscheint auf der Anmeldeseite („Anmelden mit …“).',
    redirectUri: 'Redirect-URI',
    redirectUriHelp: 'In der App-Registrierung von Entra ID als Umleitungs-URI (Web) eintragen.',
    issuer: 'Issuer',
    checkHelp: 'Ruft das Discovery-Dokument des Issuers ab, mit den Eingaben oben.',
    checkClient: 'Client-ID und Client-Secret mitprüfen',
    advanced: 'Erweitert',
    customIssuer: 'Eigener Issuer',
    customIssuerHelp: 'Statt der Tenant-ID, z. B. für einen anderen OpenID-Connect-Anbieter.',
    scopes: 'Scopes',
    proxyUrl: 'Proxy für ausgehende Verbindungen',
    proxyUrlHelp: 'z. B. http://proxy.example.com:8080, ohne Zugangsdaten.',
    noProxy: 'Ausnahmen (NO_PROXY)',
    noProxyHelp: 'Kommagetrennt, z. B. localhost,.intern.example.com',
    appSecret: 'App-Secret',
    appSecretHelp: 'Signiert Sitzungen und die Zugänge der KI-Assistenten und verschlüsselt das Netzlaufwerk-Passwort in den Einstellungen der Web-App. Es wurde bei der Installation erzeugt und wird nie angezeigt.',
    appSecretSet: 'gesetzt',
    appSecretMissing: 'fehlt',
    regenerateTitle: 'App-Secret neu erzeugen?',
    regenerateWarning: 'Danach sind alle Anmeldungen und KI-Assistenten-Verbindungen ungültig, und das Netzlaufwerk-Passwort muss in den Einstellungen der Web-App neu eingegeben werden. Bis dahin scheitern Analysen von Projekten auf dem Netzlaufwerk.',
    regenerateConfirm: 'Neu erzeugen',
    regenerated: 'App-Secret neu erzeugt',
    regeneratedDetail: 'Wirksam nach dem nächsten Neustart des Dienstes.',
  },

  assistants: {
    heading: 'KI-Assistenten',
    description: 'Anbindung von Claude Code über MCP (Model Context Protocol).',
    toggle: 'KI-Assistenten (MCP) zulassen',
    toggleHelp: 'Claude Code kann dann im Namen angemeldeter Benutzer Projekte, Analysen und Ergebnisse lesen und – wenn sie es zulassen – Analysen starten; im Namen von Admins auch Einstellungen lesen und ändern (nie Passwörter) und den Zeitplan schalten. Standard: aus.',
    privacyTitle: 'Datenschutz',
    // docs/pds-windows.md, Abschnitt zu KI-Assistenten (MCP)
    privacy: 'Was der Assistent liest (Projektnamen, Analyse-Ergebnisse, Protokolle), geht an den Anbieter der KI (bei Claude Code an Anthropic). Erst einschalten, wenn das im Unternehmen freigegeben und Claude Code zugelassen ist. Die Benutzer sehen diesen Hinweis auch auf der Seite „KI-Assistenten“ der Web-App.',
    endpoint: 'MCP-Adresse',
    endpointHelp: 'Diese Adresse tragen die Benutzer in Claude Code ein. Die Anmeldung läuft über die bestehende Entra-ID-Anmeldung.',
    off: 'Ausgeschaltet: Alle MCP-Endpunkte antworten mit 404, bestehende Zugänge sind ungültig.',
  },

  eplan: {
    heading: 'EPLAN-Worker',
    description: 'Der Dienst pds-eplan öffnet die Projekte mit EPLAN und liefert der Web-App die Rohdaten über eine Named Pipe. Er läuft unter einem Benutzerkonto mit EPLAN-Lizenz.',
    service: 'Dienst',
    labels: {
      state: 'Worker',
      account: 'Konto',
      executable: 'Programm',
    },
    executable: (path: string, present: boolean) => present ? path : `${path} (fehlt)`,
    workerMissingTitle: 'Der EPLAN-Worker fehlt in dieser Installation',
    workerMissing: 'Das MSI wurde ohne EPLAN gebaut (build-payload.ps1 -SkipEplanWorker). Für Analysen ein MSI mit Worker installieren.',
    notInstalled: 'Noch nicht eingerichtet: Bis dahin bleiben Analysen in der Warteschlange.',
    setupHeading: 'Konto',
    setupHelp: 'Das Konto braucht eine EPLAN-Lizenz. Es bekommt das Recht „Als Dienst anmelden“, Lesen auf uploads\\ und Ändern auf work\\ und logs\\ im Datenordner, sonst nichts. Das Passwort wird nur an Windows übergeben und nirgends gespeichert.',
    account: 'Konto',
    accountHelp: 'DOMÄNE\\Benutzer, .\\Benutzer (lokales Konto) oder benutzer@domäne',
    accountPlaceholder: 'EXAMPLE\\svc-eplan',
    password: 'Passwort',
    passwordHelp: 'Wird vorab geprüft; bei einem falschen Passwort ändert sich am Dienst nichts.',
    install: 'Einrichten',
    change: 'Konto ändern',
    installing: 'Anmeldung prüfen, Dienst einrichten und starten …',
    installed: (account: string) => `EPLAN-Worker läuft unter ${account}`,
    installedNotStarted: (account: string) => `EPLAN-Worker unter ${account} eingerichtet, aber nicht gestartet`,
    warningsTitle: 'Hinweise',
    accountProblems: {
      missing: 'Das Konto fehlt.',
      noDomain: 'Die Domäne fehlt: lokale Konten als .\\Benutzer, Domänenkonten als DOMÄNE\\Benutzer oder benutzer@domäne.',
      builtin: 'Eingebaute und virtuelle Konten (LocalSystem, NT AUTHORITY\\…, NT SERVICE\\…) gehen nicht: EPLAN braucht ein Benutzerkonto mit Lizenz.',
      managed: 'Verwaltete Dienstkonten und Computerkonten (…$) gehen nicht: EPLAN braucht ein Benutzerkonto mit Passwort und Lizenz.',
      invalid: 'Der Kontoname ist ungültig.',
    },
    confirmStopTitle: 'EPLAN-Worker stoppen?',
    confirmStop: 'Laufende Analysen scheitern, neue bleiben in der Warteschlange, bis der Worker wieder läuft.',
    controlDone: {
      start: 'EPLAN-Worker wird gestartet',
      stop: 'EPLAN-Worker wird gestoppt',
      restart: 'EPLAN-Worker wird neu gestartet',
    },
    licenseHint: 'Die EPLAN-Lizenz unter dem Konto prüfen: Worker stoppen und als das Konto pds-eplan.exe run --dialogs starten (siehe docs/pds-windows.md, Fehlersuche).',
  },

  tool: {
    running: 'Läuft …',
    stepOk: 'ok',
    stepWarning: 'Warnung',
    stepError: 'Fehler',
  },
} as const
