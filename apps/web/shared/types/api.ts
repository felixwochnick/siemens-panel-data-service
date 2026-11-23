// Datenformen zwischen Server, Oberfläche und MCP. Zeitpunkte als ISO-Text (UTC), Geheimnisse nie im Klartext.
// Stabiler Vertrag für die Oberfläche: Felder nur ergänzen, nicht umbenennen.
import type {
  AnalysisCounts,
  CableRow,
  CableWireRow,
  ConnectionRow,
  ShieldRow,
  TextRow,
} from '@pds/analyzer'

export type { AnalysisCounts, CableRow, CableWireRow, ConnectionRow, ShieldRow, TextRow }

// ── Listen fester Werte ───────────────────────────────────────────────────────

/** Datenbank des Servers (wie DatabaseDialect in @pds/core/database; hier ohne Server-Code für die Oberfläche) */
export const DATABASE_DIALECTS = ['mssql', 'sqlite'] as const
export type DatabaseDialect = typeof DATABASE_DIALECTS[number]

/** upload: über die Web-App hochgeladen (.zw1); folder: aus dem Projektordner (.elk + .edb oder .zw1) */
export const PROJECT_SOURCES = ['upload', 'folder'] as const
export type ProjectSource = typeof PROJECT_SOURCES[number]

export const FILE_KINDS = ['elk', 'zw1'] as const
export type FileKind = typeof FILE_KINDS[number]

/** Wodurch eine Analyse entstand: Hochladen, „Analysieren“ in der Oberfläche, Zeitplan, KI-Assistent */
export const ANALYSIS_TRIGGERS = ['upload', 'manual', 'schedule', 'mcp'] as const
export type AnalysisTrigger = typeof ANALYSIS_TRIGGERS[number]

export const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'aborted'] as const
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number]

/** Offene Aufträge: höchstens einer je Projekt */
export const OPEN_ANALYSIS_STATUSES = ['queued', 'running'] as const satisfies readonly AnalysisStatus[]
export const FINISHED_ANALYSIS_STATUSES = ['succeeded', 'failed', 'aborted'] as const satisfies readonly AnalysisStatus[]

/** Stufen des EPLAN-Workers (progress) */
export const WORKER_STAGES = ['starting_eplan', 'restoring', 'opening', 'reading', 'writing'] as const
/**
 * Stufe einer laufenden Analyse (analyses.stage): vorbereiten, Netzlaufwerk verbinden, Projekt in den Arbeitsordner
 * kopieren, auf den Worker warten/ihn einrichten, Stufen des Workers, Rohdaten auswerten, Ergebnisse speichern
 */
export const ANALYSIS_STAGES = [
  'preparing',
  'connecting_drive',
  'copying',
  'configuring',
  ...WORKER_STAGES,
  'analyzing',
  'saving',
] as const
export type AnalysisStage = typeof ANALYSIS_STAGES[number]

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]

export const EPLAN_OPEN_MODES = ['ReadOnly', 'Standard', 'Exclusive'] as const
export type EplanOpenMode = typeof EPLAN_OPEN_MODES[number]

/** Fehlercodes des EPLAN-Workers (response.error.code) – zugleich Fehlercode der Analyse */
export const WORKER_ERROR_CODES = [
  'not_configured',
  'eplan_start_failed',
  'project_not_found',
  'restore_failed',
  'archive_without_project',
  'open_failed',
  'read_failed',
  'write_failed',
  'busy',
  'invalid_request',
  'restart_required',
] as const

/**
 * Hinweise der Auswertung (@pds/analyzer), als Ereignis gespeichert: unmatched_hash_marks { count },
 * unmatched_twist_ticks { count }, wire_not_found { cable, id }
 */
export const ANALYZER_NOTICE_CODES = ['unmatched_hash_marks', 'unmatched_twist_ticks', 'wire_not_found'] as const

/** Fehlercodes einer Analyse, die die App selbst vergibt (zusätzlich zu WORKER_ERROR_CODES) */
export const APP_ANALYSIS_ERROR_CODES = [
  // Zeitlimit (analysisTimeoutMinutes) überschritten; der Worker wird neu gestartet
  'timeout',
  // Worker hat die Verbindung während der Analyse verloren (abgestürzt, Dienst beendet)
  'worker_disconnected',
  // unbekannter Fehlercode des Workers
  'worker_error',
  // Rohdaten (raw.json) fehlen, sind kein JSON oder haben ein falsches Format
  'raw_unreadable',
  'raw_invalid',
  // Projektdatei (Upload bzw. Ordner) nicht mehr vorhanden oder nicht kopierbar
  'project_file_missing',
  'copy_failed',
  'folder_not_configured',
  // Netzlaufwerk
  'network_drive_unsupported',
  'network_drive_failed',
  'drive_unavailable',
  'secret_unreadable',
  // Beim Start des Servers noch `running` (Server wurde beendet) bzw. Server fährt herunter
  'interrupted',
  'shutting_down',
  'unexpected_error',
] as const
export const ANALYSIS_ERROR_CODES = [...WORKER_ERROR_CODES, ...APP_ANALYSIS_ERROR_CODES] as const

/** Ereignisse, die die App selbst schreibt (Text unter analysisEvents.<code>, Platzhalter aus params) */
export const APP_ANALYSIS_EVENT_CODES = [
  // { trigger }
  'analysis_started',
  // { target, networkPath } / { target, exitCode } / { target }
  'drive_connecting',
  'drive_disconnect_fallback',
  'drive_connected',
  // { files }
  'project_copied',
  // Worker neu gestartet (andere EPLAN-Pfade oder nach Zeitlimit)
  'worker_restarted',
  // { pages, connections }
  'raw_read',
  // { connections, cables, shields, texts }
  'results_saved',
  'analysis_succeeded',
  // { code }
  'analysis_failed',
  'analysis_aborted',
  // Arbeitsordner konnte nicht gelöscht werden
  'work_folder_not_removed',
  // { code, message }: log-Zeile des Workers mit unbekanntem Code
  'worker_log',
] as const

/**
 * log-Codes des EPLAN-Workers: einmal je Code und Analyse, die Anzahl steht nur im Text (Ereignis-detail). Unbekannte
 * Codes speichert die App als `worker_log` mit { code }.
 */
export const WORKER_LOG_CODES = [
  'project_unreadable',
  'page_unreadable',
  'connection_unreadable',
  'text_unreadable',
  'line_unreadable',
  'shield_unreadable',
  'cable_unreadable',
  'restore_cleanup_failed',
] as const

/** Alle Codes, die unter analysisEvents.<code> übersetzt sein müssen */
export const ANALYSIS_EVENT_CODES = [...APP_ANALYSIS_EVENT_CODES, ...WORKER_LOG_CODES, ...ANALYZER_NOTICE_CODES, ...ANALYSIS_ERROR_CODES] as const

/** Codes der Einstellungsprüfung (Text unter settingsIssues.<code>) */
export const SETTINGS_ISSUE_CODES = [
  'required',
  'invalid_value',
  'invalid_cron',
  'invalid_timezone',
  'invalid_network_path',
  'invalid_drive_letter',
  'invalid_pattern',
  'out_of_range',
  'secret_unreadable',
  'secret_required',
] as const
export type SettingsIssueCode = typeof SETTINGS_ISSUE_CODES[number]

/** Ergebnisse des Verbindungstests (Text unter checks.<code>) */
export const CHECK_CODES = [
  'drive_ok',
  'drive_unsupported',
  'drive_failed',
  'drive_unavailable',
  'folder_ok',
  'folder_not_configured',
  'folder_not_found',
  'folder_unreadable',
  'worker_ok',
  'worker_not_configured',
  'worker_unreachable',
  'worker_failed',
] as const
export type CheckCode = typeof CHECK_CODES[number]

export const AUDIT_ACTIONS = [
  'settings_updated',
  'scheduler_toggled',
  'project_uploaded',
  'analysis_started',
  'analysis_deleted',
  'project_deleted',
  'worker_restarted',
] as const
export type AuditAction = typeof AUDIT_ACTIONS[number]

/** Wo eine Änderung herkommt (steht im Änderungsprotokoll) */
export const VIA = ['ui', 'mcp'] as const
export type Via = typeof VIA[number]

export const SECRET_FIELDS = ['networkDrive.password'] as const
export type SecretField = typeof SECRET_FIELDS[number]

/** Tabs einer Analyse: GET /api/analyses/:id/<tab> */
export const RESULT_TABS = ['connections', 'cables', 'shields', 'texts'] as const
export type ResultTab = typeof RESULT_TABS[number]

/**
 * Zustand der Verbindung zum EPLAN-Worker. disabled: kein Worker eingestellt (NUXT_EPLAN_WORKER leer, nicht
 * Windows); connecting: Verbindungsaufbau bzw. warten auf hello; connected; disconnected: getrennt, neuer Versuch folgt
 */
export const WORKER_STATES = ['disabled', 'connecting', 'connected', 'disconnected'] as const
export type WorkerState = typeof WORKER_STATES[number]

/** Zustand von EPLAN im Worker (Antwort auf status) */
export const EPLAN_STATES = ['not_started', 'starting', 'ready', 'failed'] as const
export type EplanState = typeof EPLAN_STATES[number]

/** Gründe, warum ein Eintrag im Projektordner kein Projekt ist (Text unter folderSkips.<code>) */
export const FOLDER_SKIP_CODES = ['edb_missing', 'path_too_long'] as const
export type FolderSkipCode = typeof FOLDER_SKIP_CODES[number]

// ── Allgemein ─────────────────────────────────────────────────────────────────

export interface Paged<T> {
  items: T[]
  total: number
}

/** Geheimnis nach außen: gesetzt ja/nein; readable=false ⇒ mit dem aktuellen App-Geheimnis nicht entschlüsselbar */
export interface SecretState {
  set: boolean
  readable: boolean
}

export interface AuditEntry {
  id: string
  at: string
  /** Anzeigename; null bei System (Zeitplan) oder gelöschtem Benutzer */
  user: string | null
  action: string
  details: Record<string, unknown> | null
}

// ── Einstellungen (Admin) ─────────────────────────────────────────────────────

export interface NetworkDriveSettings {
  /** Laufwerksbuchstabe, z. B. „P“; leer = nur UNC-Verbindung */
  mapping: string
  /** UNC-Pfad, z. B. \\server\freigabe */
  networkPath: string
  user: string
  password: string
}

export interface EplanSettings {
  platformBin: string
  productBin: string
  applicationModifier: string
  openMode: EplanOpenMode
}

/** Einstellungen der App (eine Zeile pds.settings). Im Server mit Klartext-Passwort, nach außen nie. */
export interface PdsSettings {
  /** Projektordner (lokal, Laufwerk oder UNC); leer = keine Ordner-Projekte */
  folder: string
  /** network: Netzlaufwerk vor jedem Zugriff verbinden (nur Windows) */
  source: 'local' | 'network'
  networkDrive: NetworkDriveSettings
  /** Unterordner durchsuchen */
  recursive: boolean
  /** Dateimuster (`*`, `?`), z. B. ['*.elk', '*.zw1']; nur .elk und .zw1 sind Projekte */
  filePatterns: string[]
  eplan: EplanSettings
  /** Zeitplan; nach der Installation aus */
  schedulerEnabled: boolean
  /** Quartz (6/7 Felder) oder klassisch (5 Felder) */
  cronSchedule: string
  /** IANA-Zeitzone des Zeitplans */
  timezone: string
  analysisTimeoutMinutes: number
  /** ältere, nicht aktuelle Analysen löschen */
  retentionDays: number
  uploadMaxMb: number
}

/** Grenzen der Zahlenwerte in den Einstellungen (Prüfung im Server, Formular, MCP) */
export const SETTINGS_LIMITS = {
  analysisTimeoutMinutes: { min: 1, max: 1440 },
  retentionDays: { min: 1, max: 3650 },
  // Höchstens 2 GiB: so viel lässt Caddy unter Windows für /api/projects/upload durch (windows/pds-common/src/render.rs)
  uploadMaxMb: { min: 1, max: 2048 },
  filePatterns: { max: 20 },
} as const

export interface SettingsIssue {
  /** Pfad des Felds, z. B. `networkDrive.networkPath` */
  path: string
  code: SettingsIssueCode
}

/** Einstellungen nach außen: Netzlaufwerk-Passwort nur als Zustand */
export interface SettingsView extends Omit<PdsSettings, 'networkDrive'> {
  networkDrive: Omit<NetworkDriveSettings, 'password'> & { password: SecretState }
}

/**
 * Eingabe des Netzlaufwerk-Passworts: Text = neuer Wert, '' oder fehlt = unverändert (nur bei gleicher Freigabe und
 * gleichem Benutzer, sonst 400 `secret_required`), null = entfernen
 */
export type SecretInput = string | null

/** PUT /api/settings, POST /api/settings/test */
export interface SettingsInput extends Omit<PdsSettings, 'networkDrive'> {
  networkDrive: Omit<NetworkDriveSettings, 'password'> & { password?: SecretInput }
}

/** GET /api/settings */
export interface SettingsResponse {
  settings: SettingsView
  /** was für Analysen bzw. den Zeitplan noch fehlt */
  issues: SettingsIssue[]
  /** false: noch nie gespeichert (Standardwerte) */
  saved: boolean
  updatedAt: string | null
  updatedBy: string | null
}

/** PUT /api/settings: wie GET plus geänderte Felder (Geheimnisse nur als Name) */
export interface SettingsSaveResponse extends SettingsResponse {
  changed: string[]
}

export interface CheckResult {
  ok: boolean
  code: CheckCode
  params?: Record<string, string | number>
  /** Rohtext (Betriebssystem, Worker), ohne Geheimnisse */
  detail?: string
}

/** POST /api/settings/test: Netzlaufwerk (nur source network), Projektordner, EPLAN-Worker */
export interface ConnectionTestResult {
  drive?: CheckResult
  folder: CheckResult
  worker: CheckResult
}

/** PUT /api/scheduler */
export interface SchedulerInput {
  enabled: boolean
}

export interface SchedulerInfo {
  enabled: boolean
  cronSchedule: string
  timezone: string
  /** Ausdruck und Zeitzone gültig */
  valid: boolean
  /** Zeitplan ist in diesem Prozess tatsächlich eingeplant */
  active: boolean
  nextRuns: string[]
}

/** GET /api/settings/cron-preview?cron=…&timezone=…&count=5 */
export interface CronPreview {
  valid: boolean
  nextRuns: string[]
}

// ── Worker ────────────────────────────────────────────────────────────────────

/** Antwort des Workers auf status */
export interface WorkerEplanStatus {
  eplan: EplanState
  eplanVersion: string | null
  busy: boolean
  configured: boolean
}

export interface WorkerStatusInfo {
  state: WorkerState
  /** Art der Verbindung (ohne Befehl/Pfad); null = kein Worker eingestellt */
  transport: 'pipe' | 'spawn' | null
  /** Version und Protokoll aus hello (null, solange nie verbunden) */
  version: string | null
  protocol: number | null
  /** seit wann der Zustand gilt */
  since: string
  /** letzter Verbindungsfehler (Rohtext) */
  lastError: string | null
  /** letzte Antwort auf status; null, wenn noch keine */
  eplan: WorkerEplanStatus | null
}

// ── Projekte ──────────────────────────────────────────────────────────────────

export interface AnalysisInfo {
  id: number
  projectId: number
  projectName: string
  projectSource: ProjectSource
  trigger: AnalysisTrigger
  /** Anzeigename; null beim Zeitplan oder wenn der Benutzer gelöscht wurde */
  triggeredBy: string | null
  status: AnalysisStatus
  /** nur während `running` */
  stage: AnalysisStage | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Änderungszeit der analysierten Projektdateien (Ordner: neueste Datei; Upload: Zeitpunkt des Hochladens) */
  sourceModified: string | null
  /** Projektname laut EPLAN (aus den Rohdaten) */
  eplanProjectName: string | null
  eplanVersion: string | null
  workerVersion: string | null
  /** Zähler, nur bei `succeeded` */
  counts: AnalysisCounts | null
  /** bei `failed`/`aborted` einer aus ANALYSIS_ERROR_CODES (Text unter analysisEvents.<code>) */
  errorCode: string | null
  /** Rohtext zum Fehler (ohne Geheimnisse) */
  errorDetail: string | null
  /** aktueller Stand des Projekts (projects.current_analysis_id) */
  isCurrent: boolean
}

export interface ProjectInfo {
  id: number
  source: ProjectSource
  /** Name ohne Endung */
  name: string
  /** nur folder: Pfad relativ zum Projektordner (Trennzeichen des Servers) */
  path: string | null
  fileKind: FileKind
  sourceModified: string | null
  createdAt: string
  /** Anzeigename; null beim Zeitplan oder wenn der Benutzer gelöscht wurde */
  createdBy: string | null
  updatedAt: string
  /** neueste erfolgreiche Analyse (Standard der Tabellen) */
  currentAnalysis: AnalysisInfo | null
  /** neueste Analyse überhaupt (auch wartend, laufend oder gescheitert) */
  latestAnalysis: AnalysisInfo | null
}

/** GET /api/projects/:id: mit allen Ständen, neueste zuerst */
export interface ProjectDetail extends ProjectInfo {
  analyses: AnalysisInfo[]
}

/** Sortierung der Projektliste: name (A–Z, Standard) oder updated (zuletzt geändert zuerst) */
export const PROJECT_SORTS = ['name', 'updated'] as const
export type ProjectSort = typeof PROJECT_SORTS[number]

/** GET /api/projects?search=&source=&sort=&page=&pageSize= */
export interface ProjectQuery {
  /** Teil von Name oder Pfad */
  search?: string
  source?: ProjectSource
  sort?: ProjectSort
  page?: number
  pageSize?: number
}

/**
 * POST /api/projects/upload?name=<Datei>.zw1 – Body: die Datei selbst (Rohdaten, z. B. `fetch(url, { method: 'POST',
 * body: file })`), keine Multipart-Form. Nur .zw1 (400 `upload_invalid_type`), Größe ≤ uploadMaxMb (413
 * `upload_too_large`). Gleicher Name ⇒ dasselbe Projekt mit neuem Stand; wartet schon ein Auftrag ⇒ 409
 * `analysis_already_queued`.
 */
export interface UploadResponse {
  project: ProjectInfo
  analysis: AnalysisInfo
}

/** DELETE /api/projects/:id bzw. /api/analyses/:id */
export interface DeleteResponse {
  id: number
}

// ── Projektordner ─────────────────────────────────────────────────────────────

/** Ein Projekt im Projektordner (GET /api/folder/projects) */
export interface FolderProject {
  /** relativ zum Projektordner, z. B. `Linie 1\Anlage.elk` (Trennzeichen des Servers) */
  path: string
  name: string
  fileKind: FileKind
  /** neueste Datei (.elk und .edb rekursiv) bzw. .zw1 */
  sourceModified: string
  /** schon bekanntes Projekt (source folder) mit aktuellem und neuestem Stand; null = neu */
  project: { id: number, currentAnalysisId: number | null, latestStatus: AnalysisStatus | null } | null
  /** seit der letzten erfolgreichen Analyse geändert (oder nie erfolgreich analysiert) */
  changed: boolean
}

export interface FolderSkip {
  path: string
  code: FolderSkipCode
}

export interface FolderScanResult {
  /** Projektordner laut Einstellungen */
  folder: string
  items: FolderProject[]
  /** übersprungene Einträge, z. B. .elk ohne .edb */
  skipped: FolderSkip[]
}

// ── Analysen ──────────────────────────────────────────────────────────────────

/** POST /api/analyses: ein bekanntes Projekt oder Projekte aus dem Ordner (Pfade wie in FolderProject.path) */
export type StartAnalysisInput = { projectId: number } | { folderPaths: string[] }

export interface StartAnalysisSkip {
  /** projectId als Text bzw. der Ordnerpfad */
  target: string
  /** z. B. analysis_already_queued, folder_project_not_found */
  code: string
}

/**
 * Antwort von POST /api/analyses. Mit projectId: 409 `analysis_already_queued`, wenn schon ein Auftrag offen ist.
 * Mit folderPaths: je Pfad eingereiht oder übersprungen (mit Code).
 */
export interface StartAnalysisResponse {
  queued: AnalysisInfo[]
  skipped: StartAnalysisSkip[]
}

/** GET /api/analyses?projectId=&status=&trigger=&page=&pageSize= (neueste zuerst) */
export interface AnalysisQuery {
  projectId?: number
  status?: AnalysisStatus
  trigger?: AnalysisTrigger
  page?: number
  pageSize?: number
}

export interface AnalysisEventInfo {
  id: string
  at: string
  level: LogLevel
  /** Text unter analysisEvents.<code>; unbekannte Codes des Workers als worker_log */
  code: string
  params: Record<string, string | number> | null
  /** Rohtext (Worker, Betriebssystem), ohne Geheimnisse */
  detail: string | null
}

/** GET /api/analyses/:id/events?level=&offset=&limit= (älteste zuerst) */
export interface AnalysisEventQuery {
  /** Mindeststufe */
  level?: LogLevel
  offset?: number
  limit?: number
}

// ── Ergebnisse (je Tab komplett) ──────────────────────────────────────────────

interface ResultBase {
  analysisId: number
  projectId: number
}

/** GET /api/analyses/:id/connections – nach idx */
export interface ConnectionsResponse extends ResultBase {
  rows: ConnectionRow[]
}

/** GET /api/analyses/:id/cables – Kabel mit eingebetteten Adern, nach idx */
export interface CablesResponse extends ResultBase {
  rows: CableRow[]
}

/** GET /api/analyses/:id/shields – je Schirm die Indizes der Verbindungen (connectionIdx) */
export interface ShieldsResponse extends ResultBase {
  rows: ShieldRow[]
}

/** GET /api/analyses/:id/texts */
export interface TextsResponse extends ResultBase {
  rows: TextRow[]
}

// ── Übersicht ─────────────────────────────────────────────────────────────────

/** GET /api/status */
export interface StatusInfo {
  /** Art der Datenbank (ohne Pfad oder Zugangsdaten) */
  database: DatabaseDialect
  worker: WorkerStatusInfo
  queue: {
    running: AnalysisInfo | null
    /** wartende Aufträge in Reihenfolge der Abarbeitung (höchstens 50) */
    queued: AnalysisInfo[]
    queuedCount: number
  }
  /** zuletzt beendete Analysen, neueste zuerst */
  recentAnalyses: AnalysisInfo[]
  /** nur für Admins (sonst null): Hinweise und Zeitplan */
  admin: {
    issues: SettingsIssue[]
    scheduler: SchedulerInfo
    unreadableSecrets: SecretField[]
    saved: boolean
    recentAudit: AuditEntry[]
  } | null
}

// ── Protokolle (Admin) ────────────────────────────────────────────────────────

export interface LogFileInfo {
  name: string
  size: number
  modifiedAt: string
}

/** GET /api/logs */
export interface LogsInfo {
  /** NUXT_LOG_DIR gesetzt (nur im Windows-Dienst) */
  configured: boolean
  /** Ordner fehlt oder ist nicht lesbar */
  readable: boolean
  files: LogFileInfo[]
}

/** GET /api/logs/tail?name=&lines=&filter= */
export interface LogTail extends LogFileInfo {
  lines: string[]
  /** vor den gezeigten Zeilen gibt es weitere (Treffer) */
  truncated: boolean
}
