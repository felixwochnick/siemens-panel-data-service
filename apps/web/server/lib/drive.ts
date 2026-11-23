// Netzlaufwerk unter Windows, aus dem ESWC-Controller (packages/controller/src/drive.ts)
import { spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { NetworkDriveSettings } from '../../shared/types/api'
import { AnalysisError } from './errors'
import { createSafeLogger, errorText, safeDetail } from './log'
import type { EventLogger } from './log'
import { isValidDriveLetter, isValidUncPath, normalizeDriveLetter } from './settings'

export interface DriveConnector {
  /** Verbindet das Netzlaufwerk neu; wirft AnalysisError mit network_drive_unsupported/_failed bzw. drive_unavailable */
  connect(drive: NetworkDriveSettings, log: EventLogger, signal?: AbortSignal): Promise<void>
}

export interface SpawnResult { code: number | null, stdout: string, stderr: string }

/** Startet einen Prozess und wartet auf sein Ende (austauschbar für Tests) */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number },
) => Promise<SpawnResult>

export interface WindowsDriveConnectorOptions {
  spawn?: ProcessSpawner
  /** Standard: process.platform */
  platform?: NodeJS.Platform
  /** Prüft nach dem Verbinden, ob Laufwerk bzw. UNC-Pfad erreichbar ist */
  pathExists?: (path: string) => Promise<boolean>
  /** Basis-Umgebung für Kindprozesse; Standard: process.env */
  env?: NodeJS.ProcessEnv
}

export const DRIVE_PROCESS_TIMEOUT_MS = 120_000

export const defaultSpawner: ProcessSpawner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, [...args], {
      env: options.env,
      signal: options.signal,
      timeout: options.timeoutMs ?? DRIVE_PROCESS_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      stdout += c
    })
    child.stderr?.setEncoding('utf8').on('data', (c: string) => {
      stderr += c
    })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

// Nur absoluter Pfad mit Laufwerksbuchstabe: kein UNC (Programm von einer Freigabe), keine Sonderzeichen. Segmente
// enden nicht auf Punkt oder Leerzeichen; das schließt `.`/`..` aus (Windows entfernt solche Endungen still)
const SYSTEM_ROOT_PATTERN = /^[a-z]:(?:\\[\w .()-]*[\w()-])+\\?$/i

/** Wert einer Umgebungsvariablen ohne Rücksicht auf Groß-/Kleinschreibung (wie unter Windows) */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Absolute Pfade von net.exe und powershell.exe unter SystemRoot. Ein bloßer Name würde über Arbeitsverzeichnis und
 * PATH gesucht; ein dort untergeschobenes Programm bekäme das Laufwerks-Passwort. Ungültiges SystemRoot ⇒ C:\Windows.
 */
export function windowsCommandPaths(env: NodeJS.ProcessEnv): { net: string, powershell: string } {
  const value = envValue(env, 'SystemRoot')
  const systemRoot = value && SYSTEM_ROOT_PATTERN.test(value) ? value : DEFAULT_SYSTEM_ROOT
  // win32.join: Backslashes auch dann, wenn die Tests unter Linux laufen
  const system32 = win32.join(systemRoot, 'System32')
  return {
    net: win32.join(system32, 'net.exe'),
    powershell: win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  }
}

/** PowerShell-Skript als -EncodedCommand (UTF-16LE, Base64): keine Quoting-Probleme, keine Geheimnisse in argv */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

// Fallback wie in der .NET-Version: net use /delete entfernt nur Verbindungen, die es selbst kennt
const REMOVE_SCRIPT = `try { (New-Object -ComObject WScript.Network).RemoveNetworkDrive($env:PDS_DRIVE_LETTER, $true, $true) } catch {}`

// Zugangsdaten nur über Umgebungsvariablen; New-SmbMapping bekommt das Passwort innerhalb von PowerShell
const CONNECT_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `try {`,
  `  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
  `  $p = @{ RemotePath = $env:PDS_DRIVE_PATH }`,
  `  if ($env:PDS_DRIVE_LETTER) { $p.LocalPath = $env:PDS_DRIVE_LETTER }`,
  `  if ($env:PDS_DRIVE_USER) { $p.UserName = $env:PDS_DRIVE_USER; $p.Password = $env:PDS_DRIVE_PASSWORD }`,
  `  New-SmbMapping @p | Out-Null`,
  `  exit 0`,
  `} catch {`,
  `  [Console]::Error.WriteLine($_.Exception.Message)`,
  `  exit 1`,
  `}`,
].join('\n')

/**
 * Verbindungen nacheinander: Warteschlange, Zeitplan und Verbindungstest dürfen das Laufwerk nicht gleichzeitig
 * trennen und neu verbinden
 */
export function serializeConnector(connector: DriveConnector): DriveConnector {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    connect(drive, log, signal) {
      const next = chain.then(() => connector.connect(drive, log, signal))
      chain = next.catch(() => {})
      return next
    },
  }
}

/**
 * Netzlaufwerk unter Windows: bestehende Verbindung trennen, neu verbinden (mit Laufwerksbuchstabe oder nur
 * UNC-Verbindung), danach Erreichbarkeit prüfen. Auf anderen Plattformen ⇒ AnalysisError('network_drive_unsupported').
 */
export function createWindowsDriveConnector(options: WindowsDriveConnectorOptions = {}): DriveConnector {
  const spawn = options.spawn ?? defaultSpawner
  const pathExists = options.pathExists ?? defaultPathExists

  return {
    async connect(drive: NetworkDriveSettings, log: EventLogger, signal?: AbortSignal) {
      if ((options.platform ?? process.platform) !== 'win32') throw new AnalysisError('network_drive_unsupported')
      const secrets = [drive.password]
      const emit = createSafeLogger(log, secrets)
      const baseEnv = options.env ?? process.env
      const commands = windowsCommandPaths(baseEnv)

      const networkPath = (drive.networkPath ?? '').trim()
      if (!isValidUncPath(networkPath)) throw new AnalysisError('network_drive_failed', 'invalid network path')
      if (drive.mapping?.trim() && !isValidDriveLetter(drive.mapping)) throw new AnalysisError('network_drive_failed', 'invalid drive letter')
      const letter = normalizeDriveLetter(drive.mapping)
      const target = letter ? `${letter}:` : networkPath

      const run = async (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<SpawnResult> => {
        try {
          return await spawn(command, args, { env, signal })
        }
        catch (err) {
          if (signal?.aborted) throw signal.reason ?? err
          return { code: -1, stdout: '', stderr: errorText(err) }
        }
      }

      emit({ level: 'info', code: 'drive_connecting', params: { target, networkPath } })

      // 1. bestehende Verbindung trennen (Fehler hier sind normal, z. B. „nicht verbunden“)
      const removed = await run(commands.net, ['use', target, '/delete', '/y'], { ...baseEnv })
      if (removed.code !== 0 && letter) {
        emit({ level: 'info', code: 'drive_disconnect_fallback', params: { target, exitCode: removed.code ?? -1 } })
        await run(commands.powershell, powershellArgs(REMOVE_SCRIPT), { ...baseEnv, PDS_DRIVE_LETTER: target })
      }

      // 2. verbinden – Passwort nur in der Umgebung des Kindprozesses
      const connected = await run(commands.powershell, powershellArgs(CONNECT_SCRIPT), {
        ...baseEnv,
        PDS_DRIVE_PATH: networkPath,
        PDS_DRIVE_LETTER: letter ? target : '',
        PDS_DRIVE_USER: drive.user?.trim() ?? '',
        PDS_DRIVE_PASSWORD: drive.password ?? '',
      })
      if (connected.code !== 0) {
        throw new AnalysisError('network_drive_failed', safeDetail((connected.stderr || connected.stdout).trim() || `exit code ${connected.code}`, secrets))
      }

      // 3. Erreichbarkeit prüfen
      const checkPath = letter ? `${letter}:\\` : networkPath
      if (!(await pathExists(checkPath))) throw new AnalysisError('drive_unavailable', checkPath)
      emit({ level: 'info', code: 'drive_connected', params: { target } })
    },
  }
}
