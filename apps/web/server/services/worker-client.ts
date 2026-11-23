import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { EPLAN_STATES } from '../../shared/types/api'
import type { EplanSettings, WorkerEplanStatus, WorkerState, WorkerStatusInfo } from '../../shared/types/api'

/*
 * Client des EPLAN-Workers (worker/, Protokoll im Spec „Protokoll“): JSON-Zeilen über die Named Pipe des Dienstes
 * `pds-eplan` oder über stdin/stdout eines Kindprozesses (Entwicklung: tools/fake-worker). Nach dem Verbinden schickt
 * der Worker `hello`; Anfragen tragen eine id, Antworten (`response`), Fortschritt (`progress`) und Protokollzeilen
 * (`log`) beziehen sich darauf. Reißt die Verbindung ab, scheitern offene Anfragen mit `worker_disconnected` und der
 * Client verbindet sich mit wachsendem Abstand neu.
 */

export const WORKER_PROTOCOL = 1
export const DEFAULT_PIPE = '\\\\.\\pipe\\pds-eplan'

export type WorkerSpec
  = | { kind: 'pipe', path: string }
    | { kind: 'spawn', command: string, args: string[], cwd: string, env?: Record<string, string> }

/** Fehler des Workers (response.error.code) oder der Verbindung (worker_disconnected, timeout, …) */
export class WorkerError extends Error {
  readonly code: string
  readonly detail?: string

  constructor(code: string, detail?: string) {
    super(code)
    this.name = 'WorkerError'
    this.code = code
    this.detail = detail
  }
}

/** Befehlszeile in Teile zerlegen: Leerzeichen trennen, "…" und '…' halten zusammen (ohne Shell) */
export function splitCommand(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    }
    else if (char === '"' || char === '\'') {
      quote = char
      started = true
    }
    else if (/\s/.test(char)) {
      if (started) parts.push(current)
      current = ''
      started = false
    }
    else {
      current += char
      started = true
    }
  }
  if (quote) throw new Error('NUXT_EPLAN_WORKER: Anführungszeichen nicht geschlossen')
  if (started) parts.push(current)
  return parts
}

/** Nächster Ordner mit pnpm-workspace.yaml (Wurzel des Monorepos), sonst der Startordner */
export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

/**
 * NUXT_EPLAN_WORKER: `pipe:\\.\pipe\pds-eplan` oder `spawn:<Befehl …>`. Leer ⇒ unter Windows die Pipe des Dienstes,
 * sonst kein Worker (null). `spawn:` ist für die Entwicklung: Pfade im Befehl gelten relativ zur Wurzel des Monorepos.
 */
export function parseWorkerSpec(value: string | undefined | null, options: { platform?: NodeJS.Platform, cwd?: string } = {}): WorkerSpec | null {
  const text = (value ?? '').trim()
  if (!text) return (options.platform ?? process.platform) === 'win32' ? { kind: 'pipe', path: DEFAULT_PIPE } : null
  if (/^pipe:/i.test(text)) return { kind: 'pipe', path: text.slice('pipe:'.length).trim() || DEFAULT_PIPE }
  if (/^spawn:/i.test(text)) {
    const [command, ...args] = splitCommand(text.slice('spawn:'.length))
    if (!command) throw new Error('NUXT_EPLAN_WORKER: Nach spawn: fehlt der Befehl')
    return { kind: 'spawn', command, args, cwd: options.cwd ?? findWorkspaceRoot(process.cwd()) }
  }
  throw new Error('NUXT_EPLAN_WORKER muss mit pipe: oder spawn: beginnen')
}

/** Eine Verbindung zum Worker (Pipe oder Kindprozess); austauschbar für Tests */
export interface WorkerConnection {
  write(line: string): void
  /** Daten (UTF-8) in beliebigen Stücken */
  onData(listener: (chunk: string) => void): void
  /** genau einmal, wenn die Verbindung endet */
  onClose(listener: (error?: Error) => void): void
  /** freundlich beenden (Pipe schließen, stdin schließen) */
  end(): void
  /** sofort beenden (Socket zerstören, Prozess beenden) */
  kill(): void
}

export type WorkerConnector = (spec: WorkerSpec, log: (line: string) => void) => WorkerConnection

function once<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let called = false
  return (...args) => {
    if (called) return
    called = true
    fn(...args)
  }
}

/** Standard: Named Pipe per net.createConnection bzw. Kindprozess mit stdin/stdout; stderr landet im Log */
export const defaultConnector: WorkerConnector = (spec, log) => {
  let dataListener: (chunk: string) => void = () => {}
  let closeListener: (error?: Error) => void = () => {}
  let lastError: Error | undefined
  if (spec.kind === 'pipe') {
    const socket = createConnection(spec.path)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => dataListener(chunk))
    socket.on('error', (error) => {
      lastError = error
    })
    const closed = once(() => closeListener(lastError))
    socket.on('close', closed)
    return {
      write: line => void socket.write(line),
      onData: (listener) => {
        dataListener = listener
      },
      onClose: (listener) => {
        closeListener = listener
      },
      end: () => void socket.end(),
      kill: () => void socket.destroy(),
    }
  }

  // Ohne Shell: Argumente gehen unverändert an den Prozess (kein Geheimnis darin – EPLAN-Pfade kommen per configure)
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = once((error?: Error) => closeListener(error ?? lastError))
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => dataListener(chunk))
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
    const lines = stderr.split('\n')
    stderr = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) log(`[worker] ${line.trimEnd()}`)
  })
  // Schreibfehler nach dem Ende des Prozesses (EPIPE) meldet 'exit'/'close'
  child.stdin.on('error', (error) => {
    lastError = error
  })
  child.on('error', (error) => {
    lastError = error
    closed(error)
  })
  child.on('close', (code, signal) => closed(lastError ?? (code === 0 ? undefined : new Error(`worker exited (${signal ?? code})`))))
  return {
    write: (line) => {
      if (child.stdin.writable) child.stdin.write(line)
    },
    onData: (listener) => {
      dataListener = listener
    },
    onClose: (listener) => {
      closeListener = listener
    },
    end: () => void child.stdin.end(),
    kill: () => void child.kill(),
  }
}

/** Ergebnis von analyze */
export interface AnalyzeResult {
  outputFile: string
  pages?: number
  connections?: number
}

export interface AnalyzeParams {
  projectPath: string
  workFolder: string
  outputFile: string
  openMode: EplanSettings['openMode']
}

/** log-Zeile des Workers */
export interface WorkerLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  code: string
  message: string
}

export interface RequestHandlers {
  onProgress?: (stage: string) => void
  onLog?: (entry: WorkerLogEntry) => void
  /** bricht die Anfrage ab (Zeitlimit): sie scheitert mit dem Grund bzw. WorkerError('timeout') */
  signal?: AbortSignal
  /** eigenes Zeitlimit der Anfrage in ms */
  timeoutMs?: number
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  handlers: RequestHandlers
}

export interface WorkerClientOptions {
  spec: WorkerSpec | null
  connector?: WorkerConnector
  /** Zeilen für stdout bzw. app.log */
  log?: (line: string) => void
  /** so lange wird nach dem Verbinden auf hello gewartet (Standard 30 s) */
  helloTimeoutMs?: number
  /** erster Abstand zwischen Verbindungsversuchen (Standard 1 s), verdoppelt sich bis reconnectMaxMs (Standard 30 s) */
  reconnectInitialMs?: number
  reconnectMaxMs?: number
  /** so lange darf der Worker nach `exit` brauchen, bevor er beendet wird (Standard 10 s) */
  exitTimeoutMs?: number
  now?: () => Date
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function toEplanStatus(value: unknown): WorkerEplanStatus {
  const v = (value ?? {}) as Record<string, unknown>
  return {
    eplan: EPLAN_STATES.includes(v.eplan as never) ? v.eplan as WorkerEplanStatus['eplan'] : 'failed',
    eplanVersion: typeof v.eplanVersion === 'string' && v.eplanVersion ? v.eplanVersion : null,
    busy: v.busy === true,
    configured: v.configured === true,
  }
}

/** Verbindung zum EPLAN-Worker mit Wiederverbinden; eine Instanz je Prozess */
export class WorkerClient {
  private conn: WorkerConnection | null = null
  private seq = 0
  private state: WorkerState
  private since: Date
  private version: string | null = null
  private protocol: number | null = null
  private lastError: string | null = null
  private lastStatus: WorkerEplanStatus | null = null
  private readonly pending = new Map<string, Pending>()
  private nextId = 1
  private buffer = ''
  private started = false
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private delayMs: number
  /** nach `restart`: sofort neu verbinden statt mit Abstand */
  private reconnectNow = false
  /** Grund, aus dem dieser Client die Verbindung selbst beendet (statt des Fehlers beim Schließen) */
  private closeReason: string | null = null
  /** Pfade, mit denen diese Verbindung eingerichtet ist (configure) */
  private configuredKey: string | null = null
  private readonly listeners = new Set<() => void>()
  private readonly closeWaiters = new Map<number, (() => void)[]>()
  private readonly connector: WorkerConnector
  private readonly log: (line: string) => void
  private readonly now: () => Date

  constructor(private readonly options: WorkerClientOptions) {
    this.connector = options.connector ?? defaultConnector
    this.log = options.log ?? (line => console.info(line))
    this.now = options.now ?? (() => new Date())
    this.delayMs = options.reconnectInitialMs ?? 1000
    this.state = options.spec ? 'disconnected' : 'disabled'
    this.since = this.now()
  }

  get connected(): boolean {
    return this.state === 'connected'
  }

  /** Worker eingestellt (sonst bleiben Aufträge in der Warteschlange) */
  get enabled(): boolean {
    return this.options.spec !== null
  }

  /** Zustand für Übersicht und MCP */
  info(): WorkerStatusInfo {
    return {
      state: this.state,
      transport: this.options.spec?.kind ?? null,
      version: this.version,
      protocol: this.protocol,
      since: this.since.toISOString(),
      lastError: this.lastError,
      eplan: this.lastStatus,
    }
  }

  /** Bei jeder Zustandsänderung; liefert die Abmeldung */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Verbindung aufbauen (einmal je Prozess); ohne Worker nichts */
  start(): void {
    if (this.started || !this.options.spec) return
    this.started = true
    this.connect()
  }

  /** Beenden: keine neuen Verbindungen, offene Anfragen scheitern mit shutting_down, Verbindung schließen */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.rejectAll(new WorkerError('shutting_down'))
    const conn = this.conn
    if (!conn) return
    const closed = this.waitForClose(this.seq)
    conn.end()
    const timer = setTimeout(() => conn.kill(), this.options.exitTimeoutMs ?? 10_000)
    await closed
    clearTimeout(timer)
  }

  /** Wartet auf eine Verbindung; false bei Zeitüberschreitung, Abbruch oder ohne Worker */
  async waitForConnection(options: { signal?: AbortSignal, timeoutMs?: number } = {}): Promise<boolean> {
    if (this.connected) return true
    if (!this.options.spec || this.stopped) return false
    return new Promise<boolean>((resolvePromise) => {
      const finish = (value: boolean) => {
        unsubscribe()
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolvePromise(value)
      }
      const onAbort = () => finish(false)
      const unsubscribe = this.onChange(() => {
        if (this.connected) finish(true)
        else if (this.stopped) finish(false)
      })
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => finish(false), options.timeoutMs)
      if (options.signal?.aborted) finish(false)
      else options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Anfrage schicken; scheitert mit WorkerError (Code des Workers, worker_disconnected, timeout) */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, handlers: RequestHandlers = {}): Promise<T> {
    const conn = this.conn
    if (!conn || !this.connected) return Promise.reject(new WorkerError('worker_disconnected', this.lastError ?? undefined))
    const id = `r${this.nextId++}`
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        handlers.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        cleanup()
        const reason = handlers.signal?.reason
        rejectPromise(reason instanceof Error ? reason : new WorkerError('timeout'))
      }
      this.pending.set(id, {
        method,
        handlers,
        resolve: (value) => {
          cleanup()
          resolvePromise(value as T)
        },
        reject: (error) => {
          cleanup()
          rejectPromise(error)
        },
      })
      if (handlers.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          cleanup()
          rejectPromise(new WorkerError('timeout', `${method} took longer than ${handlers.timeoutMs} ms`))
        }, handlers.timeoutMs)
      }
      if (handlers.signal?.aborted) return onAbort()
      handlers.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        conn.write(`${JSON.stringify({ type: 'request', id, method, params })}\n`)
      }
      catch (error) {
        this.pending.delete(id)
        cleanup()
        rejectPromise(new WorkerError('worker_disconnected', error instanceof Error ? error.message : String(error)))
      }
    })
  }

  /** Zustand von EPLAN im Worker (merkt sich die Antwort für die Übersicht) */
  async status(timeoutMs = 5000): Promise<WorkerEplanStatus> {
    const status = toEplanStatus(await this.request('status', {}, { timeoutMs }))
    this.lastStatus = status
    return status
  }

  /**
   * EPLAN-Pfade setzen (einmal je Verbindung und Pfaden). Läuft EPLAN im Worker schon mit anderen Pfaden, antwortet er
   * `restart_required`: dann `exit`, neu verbinden und erneut einrichten. Liefert, ob der Worker neu gestartet wurde.
   */
  async configure(eplan: Pick<EplanSettings, 'platformBin' | 'productBin' | 'applicationModifier'>, options: { signal?: AbortSignal } = {}): Promise<{ restarted: boolean }> {
    const params = { platformBin: eplan.platformBin, productBin: eplan.productBin, applicationModifier: eplan.applicationModifier }
    const key = JSON.stringify(params)
    if (this.configuredKey === key && this.connected) return { restarted: false }
    let restarted = false
    try {
      await this.request('configure', params, { timeoutMs: 30_000, signal: options.signal })
    }
    catch (error) {
      if (!(error instanceof WorkerError) || error.code !== 'restart_required') throw error
      this.log('[worker] Andere EPLAN-Pfade: Worker wird neu gestartet')
      await this.restart()
      restarted = true
      if (!(await this.waitForConnection({ signal: options.signal, timeoutMs: 120_000 }))) throw new WorkerError('worker_disconnected', 'no connection after restart')
      await this.request('configure', params, { timeoutMs: 30_000, signal: options.signal })
    }
    this.configuredKey = key
    return { restarted }
  }

  /** Rohdaten schreiben lassen; Fortschritt und Protokollzeilen über die Handler */
  async analyze(params: AnalyzeParams, handlers: RequestHandlers = {}): Promise<AnalyzeResult> {
    const result = await this.request<AnalyzeResult>('analyze', { ...params }, handlers)
    if (!result || typeof result.outputFile !== 'string') throw new WorkerError('invalid_request', 'analyze: response without outputFile')
    return result
  }

  /**
   * Worker beenden lassen (`exit`; der Dienst bzw. dieser Client startet ihn neu) und sofort neu verbinden. Antwortet
   * er nicht rechtzeitig, wird die Verbindung bzw. der Prozess hart beendet.
   */
  async restart(code = 3): Promise<void> {
    const conn = this.conn
    if (!conn) return
    const seq = this.seq
    this.reconnectNow = true
    const closed = this.waitForClose(seq)
    try {
      conn.write(`${JSON.stringify({ type: 'request', id: `r${this.nextId++}`, method: 'exit', params: { code } })}\n`)
    }
    catch {
      // Verbindung schon weg
    }
    const timer = setTimeout(() => conn.kill(), this.options.exitTimeoutMs ?? 10_000)
    await closed
    clearTimeout(timer)
  }

  private setState(state: WorkerState) {
    if (this.state === state) return
    this.state = state
    this.since = this.now()
    for (const listener of [...this.listeners]) {
      try {
        listener()
      }
      catch {
        // Zuhörer dürfen den Client nicht stören
      }
    }
  }

  private waitForClose(seq: number): Promise<void> {
    if (seq !== this.seq || !this.conn) return Promise.resolve()
    return new Promise((resolvePromise) => {
      const list = this.closeWaiters.get(seq) ?? []
      list.push(resolvePromise)
      this.closeWaiters.set(seq, list)
    })
  }

  private connect() {
    if (this.stopped || !this.options.spec) return
    this.reconnectTimer = null
    const seq = ++this.seq
    this.buffer = ''
    this.configuredKey = null
    this.setState('connecting')
    let conn: WorkerConnection
    try {
      conn = this.connector(this.options.spec, this.log)
    }
    catch (error) {
      this.conn = null
      this.handleClose(seq, error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.conn = conn
    conn.onData(chunk => this.onData(seq, chunk))
    conn.onClose(error => this.handleClose(seq, error))
    this.helloTimer = setTimeout(() => {
      if (seq !== this.seq || this.state !== 'connecting') return
      this.closeReason = 'no hello from worker'
      conn.kill()
    }, this.options.helloTimeoutMs ?? 30_000)
  }

  private handleClose(seq: number, error?: Error) {
    if (seq !== this.seq) return
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = null
    this.conn = null
    this.configuredKey = null
    if (this.closeReason) this.lastError = this.closeReason
    else if (error) this.lastError = error.message
    this.closeReason = null
    this.rejectAll(new WorkerError('worker_disconnected', this.lastError ?? undefined))
    const waiters = this.closeWaiters.get(seq) ?? []
    this.closeWaiters.delete(seq)
    this.setState('disconnected')
    for (const waiter of waiters) waiter()
    if (this.stopped) return
    const delay = this.reconnectNow ? 0 : this.delayMs
    this.reconnectNow = false
    if (delay > 0) this.delayMs = Math.min(this.delayMs * 2, this.options.reconnectMaxMs ?? 30_000)
    this.log(`[worker] Verbindung getrennt${this.lastError ? ` (${this.lastError})` : ''}; neuer Versuch in ${Math.round(delay / 1000)} s`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private rejectAll(error: WorkerError) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  private onData(seq: number, chunk: string) {
    if (seq !== this.seq) return
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim()) this.onLine(seq, line)
      index = this.buffer.indexOf('\n')
    }
    // Schutz gegen eine Zeile ohne Ende (z. B. falscher Prozess an der Pipe)
    if (this.buffer.length > 10_000_000) {
      this.closeReason = 'line too long'
      this.buffer = ''
      this.conn?.kill()
    }
  }

  private onLine(seq: number, line: string) {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(line.replace(/^\uFEFF/, ''))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no object')
      message = parsed as Record<string, unknown>
    }
    catch {
      this.log(`[worker] Zeile ist kein JSON: ${line.slice(0, 200)}`)
      return
    }
    const id = typeof message.id === 'string' ? message.id : undefined
    switch (message.type) {
      case 'hello': {
        if (this.helloTimer) clearTimeout(this.helloTimer)
        this.helloTimer = null
        if (message.protocol !== WORKER_PROTOCOL) {
          this.closeReason = `unsupported protocol ${String(message.protocol)}`
          this.log(`[worker] Protokoll ${String(message.protocol)} wird nicht unterstützt (erwartet ${WORKER_PROTOCOL})`)
          this.conn?.kill()
          return
        }
        this.version = typeof message.version === 'string' ? message.version : null
        this.protocol = WORKER_PROTOCOL
        this.lastError = null
        this.delayMs = this.options.reconnectInitialMs ?? 1000
        if (seq === this.seq) this.setState('connected')
        this.log(`[worker] verbunden (Version ${this.version ?? '?'})`)
        return
      }
      case 'response': {
        const entry = id ? this.pending.get(id) : undefined
        if (!entry) return
        this.pending.delete(id!)
        const error = message.error as { code?: unknown, message?: unknown } | undefined
        if (error) {
          const code = typeof error.code === 'string' && /^[a-z0-9_]{1,50}$/.test(error.code) ? error.code : 'worker_error'
          entry.reject(new WorkerError(code, typeof error.message === 'string' ? error.message : undefined))
        }
        else {
          entry.resolve(message.result)
        }
        return
      }
      case 'progress': {
        const stage = typeof message.stage === 'string' ? message.stage : ''
        if (id && stage) this.pending.get(id)?.handlers.onProgress?.(stage)
        return
      }
      case 'log': {
        const entry: WorkerLogEntry = {
          level: LOG_LEVELS.has(message.level as string) ? message.level as WorkerLogEntry['level'] : 'info',
          code: typeof message.code === 'string' ? message.code : 'unknown',
          message: typeof message.message === 'string' ? message.message : '',
        }
        const handler = id ? this.pending.get(id)?.handlers.onLog : undefined
        if (handler) handler(entry)
        else this.log(`[worker] ${entry.level.toUpperCase()} [${entry.code}] ${entry.message}`)
        return
      }
      default:
        this.log(`[worker] unbekannte Nachricht: ${String(message.type)}`)
    }
  }
}
