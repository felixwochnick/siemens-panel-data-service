import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { CertInfo } from '../bindings/CertInfo'
import type { Config } from '../bindings/Config'
import type { DbSetupOutcome } from '../bindings/DbSetupOutcome'
import type { Finding } from '../bindings/Finding'
import type { PortStatus } from '../bindings/PortStatus'
import type { SaveDraftOutcome } from '../bindings/SaveDraftOutcome'
import type { ServiceAction } from '../bindings/ServiceAction'
import type { StatusReport } from '../bindings/StatusReport'
import type { StoreCert } from '../bindings/StoreCert'
import type { ToolResult } from '../bindings/ToolResult'
import type { UiError } from '../bindings/UiError'
import type { UiState } from '../bindings/UiState'

/**
 * Die Tauri-Befehle (`commands.rs`): Name, Argumente (camelCase wie in JS) und Ergebnis. Die Typen
 * erzeugt ts-rs aus dem Rust-Code; die Beispieldaten (mock.ts) bilden genau diese Tabelle nach.
 */
export interface Commands {
  load_state: { args: undefined, result: UiState }
  validate_draft: { args: { draft: Config }, result: Finding[] }
  save_draft: { args: { draft: Config }, result: SaveDraftOutcome }
  get_status: { args: undefined, result: StatusReport }
  service_control: { args: { action: ServiceAction }, result: StatusReport }
  // `host`: Hostname aus dem Entwurf, damit Hostname und Zertifikat zusammen wechseln können
  tls_import_pfx: { args: { path: string, password: string, host: string }, result: CertInfo }
  tls_import_pem: { args: { certPath: string, keyPath: string, host: string }, result: CertInfo }
  tls_import_store: { args: { thumbprint: string, host: string }, result: CertInfo }
  tls_list_store: { args: undefined, result: StoreCert[] }
  db_test: { args: { draft: Config }, result: ToolResult }
  db_setup: { args: { draft: Config, adminUser: string, adminPassword: string }, result: DbSetupOutcome }
  db_script: { args: { draft: Config, path: string }, result: ToolResult }
  // Online-Sicherung der SQLite-Datei des Entwurfs nach `path` (darf noch nicht existieren)
  db_backup: { args: { draft: Config, path: string }, result: ToolResult }
  oidc_test: { args: { draft: Config, checkClient: boolean }, result: ToolResult }
  ports_check: { args: { draft: Config }, result: PortStatus[] }
  regenerate_app_secret: { args: undefined, result: null }
  logs_dir: { args: undefined, result: string }
  open_log_file: { args: { path: string }, result: null }
  // Adresse aus der gespeicherten Konfiguration (Rust), nie aus der Oberfläche
  open_web_console: { args: undefined, result: null }
}

export type Command = keyof Commands

export interface FileFilter {
  name: string
  extensions: string[]
}

/** Läuft die Oberfläche in Tauri? Sonst (Browser, Playwright) gelten die Beispieldaten. */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Fehler eines Befehls einheitlich als `UiError` (Tauri liefert das serialisierte Objekt) */
export function toUiError(error: unknown): UiError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return { code: String(error.code), message: String(error.message) }
  }
  if (error instanceof Error) return { code: 'unknown', message: error.message }
  return { code: 'unknown', message: String(error) }
}

async function call<C extends Command>(command: C, ...rest: Commands[C]['args'] extends undefined ? [] : [Commands[C]['args']]): Promise<Commands[C]['result']> {
  const args = rest[0]
  try {
    if (inTauri()) return await invoke<Commands[C]['result']>(command, args)
    // Beispieldaten erst bei Bedarf laden, damit sie nicht im Tauri-Pfad liegen
    const { mockInvoke } = await import('./mock')
    return await mockInvoke(command, args)
  }
  catch (error) {
    throw toUiError(error)
  }
}

async function pickFile(filters: FileFilter[], defaultPath?: string): Promise<string | null> {
  if (!inTauri()) return (await import('./mock')).mockPickFile(filters, defaultPath)
  return open({ multiple: false, directory: false, filters, defaultPath })
}

async function pickSavePath(defaultPath: string, filters: FileFilter[]): Promise<string | null> {
  if (!inTauri()) return (await import('./mock')).mockPickSavePath(defaultPath)
  return save({ defaultPath, filters })
}

export const api = {
  loadState: () => call('load_state'),
  validateDraft: (draft: Config) => call('validate_draft', { draft }),
  saveDraft: (draft: Config) => call('save_draft', { draft }),
  getStatus: () => call('get_status'),
  serviceControl: (action: ServiceAction) => call('service_control', { action }),
  tlsImportPfx: (path: string, password: string, host: string) => call('tls_import_pfx', { path, password, host }),
  tlsImportPem: (certPath: string, keyPath: string, host: string) => call('tls_import_pem', { certPath, keyPath, host }),
  tlsImportStore: (thumbprint: string, host: string) => call('tls_import_store', { thumbprint, host }),
  tlsListStore: () => call('tls_list_store'),
  dbTest: (draft: Config) => call('db_test', { draft }),
  dbSetup: (draft: Config, adminUser: string, adminPassword: string) => call('db_setup', { draft, adminUser, adminPassword }),
  dbScript: (draft: Config, path: string) => call('db_script', { draft, path }),
  dbBackup: (draft: Config, path: string) => call('db_backup', { draft, path }),
  oidcTest: (draft: Config, checkClient: boolean) => call('oidc_test', { draft, checkClient }),
  portsCheck: (draft: Config) => call('ports_check', { draft }),
  regenerateAppSecret: () => call('regenerate_app_secret'),
  logsDir: () => call('logs_dir'),
  openLogFile: (path: string) => call('open_log_file', { path }),
  openWebConsole: () => call('open_web_console'),
  pickFile,
  pickSavePath,
}
