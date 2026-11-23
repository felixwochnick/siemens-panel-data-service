import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PIPE, WorkerClient, WorkerError, parseWorkerSpec, splitCommand } from '../server/services/worker-client'
import type { WorkerConnection, WorkerConnector, WorkerSpec } from '../server/services/worker-client'
import { fakeWorkerSpec } from './helpers/db'

/** Verbindung im Speicher: der Test spielt den Worker */
class MemoryWorker {
  readonly written: Record<string, unknown>[] = []
  private dataListener: (chunk: string) => void = () => {}
  private closeListener: (error?: Error) => void = () => {}
  closed = false
  readonly connection: WorkerConnection = {
    write: (line) => {
      for (const part of line.split('\n').filter(Boolean)) this.written.push(JSON.parse(part))
      this.onWrite?.(this.written.at(-1)!)
    },
    onData: (listener) => {
      this.dataListener = listener
    },
    onClose: (listener) => {
      this.closeListener = listener
    },
    end: () => this.close(),
    kill: () => this.close(new Error('killed')),
  }

  onWrite?: (message: Record<string, unknown>) => void

  send(chunk: string) {
    this.dataListener(chunk)
  }

  sendJson(message: unknown) {
    this.send(`${JSON.stringify(message)}\n`)
  }

  close(error?: Error) {
    if (this.closed) return
    this.closed = true
    this.closeListener(error)
  }
}

function memoryConnector() {
  const workers: MemoryWorker[] = []
  const connector: WorkerConnector = () => {
    const worker = new MemoryWorker()
    workers.push(worker)
    return worker.connection
  }
  return { workers, connector }
}

const spec: WorkerSpec = { kind: 'pipe', path: DEFAULT_PIPE }
const clients: WorkerClient[] = []

function client(connector: WorkerConnector, options: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}) {
  const c = new WorkerClient({ spec, connector, log: () => {}, reconnectInitialMs: 10, reconnectMaxMs: 40, helloTimeoutMs: 2000, exitTimeoutMs: 200, ...options })
  clients.push(c)
  return c
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.stop()))
})

describe('NUXT_EPLAN_WORKER', () => {
  it('pipe: und spawn: werden gelesen; leer ⇒ unter Windows die Pipe, sonst kein Worker', () => {
    expect(parseWorkerSpec('pipe:\\\\.\\pipe\\pds-eplan')).toEqual({ kind: 'pipe', path: '\\\\.\\pipe\\pds-eplan' })
    expect(parseWorkerSpec('pipe:')).toEqual({ kind: 'pipe', path: DEFAULT_PIPE })
    expect(parseWorkerSpec('spawn:node tools/fake-worker/index.mjs', { cwd: '/repo' }))
      .toEqual({ kind: 'spawn', command: 'node', args: ['tools/fake-worker/index.mjs'], cwd: '/repo' })
    expect(parseWorkerSpec('', { platform: 'win32' })).toEqual({ kind: 'pipe', path: DEFAULT_PIPE })
    expect(parseWorkerSpec('  ', { platform: 'linux' })).toBeNull()
    expect(() => parseWorkerSpec('tcp:1234')).toThrow()
    expect(() => parseWorkerSpec('spawn:')).toThrow()
  })

  it('splitCommand hält Anführungszeichen zusammen (ohne Shell)', () => {
    expect(splitCommand('node "C:\\Program Files\\x.mjs" --a \'b c\'')).toEqual(['node', 'C:\\Program Files\\x.mjs', '--a', 'b c'])
    expect(splitCommand('  a   b ')).toEqual(['a', 'b'])
    expect(splitCommand('a ""')).toEqual(['a', ''])
    expect(() => splitCommand('a "b')).toThrow()
  })
})

describe('WorkerClient (Protokoll)', () => {
  it('ohne Worker: Zustand disabled, Anfragen scheitern', async () => {
    const c = new WorkerClient({ spec: null, log: () => {} })
    c.start()
    expect(c.info()).toMatchObject({ state: 'disabled', transport: null })
    await expect(c.status()).rejects.toMatchObject({ code: 'worker_disconnected' })
  })

  it('wartet auf hello, ordnet Antworten der id zu und liest Zeilen über Stückgrenzen hinweg', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector)
    c.start()
    expect(c.info().state).toBe('connecting')
    // hello mit BOM und \r\n, in zwei Stücken
    workers[0]!.send('\uFEFF{"type":"hel')
    workers[0]!.send('lo","protocol":1,"version":"1.2.3"}\r\n')
    expect(c.info()).toMatchObject({ state: 'connected', version: '1.2.3', protocol: 1, transport: 'pipe' })

    workers[0]!.onWrite = (message) => {
      if (message.method === 'status') workers[0]!.sendJson({ type: 'response', id: message.id, result: { eplan: 'ready', eplanVersion: '2025.0.3', busy: true, configured: true } })
    }
    await expect(c.status()).resolves.toEqual({ eplan: 'ready', eplanVersion: '2025.0.3', busy: true, configured: true })
    expect(c.info().eplan).toMatchObject({ eplan: 'ready' })
    expect(workers[0]!.written[0]).toMatchObject({ type: 'request', method: 'status', params: {} })
  })

  it('analyze: progress und log gehen an die Anfrage, Fehler mit Code', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector)
    c.start()
    workers[0]!.sendJson({ type: 'hello', protocol: 1, version: 'x' })
    const stages: string[] = []
    const logs: string[] = []
    workers[0]!.onWrite = (message) => {
      if (message.method !== 'analyze') return
      workers[0]!.sendJson({ type: 'progress', id: message.id, stage: 'opening' })
      workers[0]!.sendJson({ type: 'log', id: message.id, level: 'warn', code: 'text_unreadable', message: '3 texts' })
      workers[0]!.send('kein json\n')
      workers[0]!.sendJson({ type: 'response', id: message.id, error: { code: 'open_failed', message: 'locked' } })
    }
    const error = await c.analyze({ projectPath: 'a.zw1', workFolder: 'w', outputFile: 'w/raw.json', openMode: 'ReadOnly' }, {
      onProgress: stage => stages.push(stage),
      onLog: entry => logs.push(`${entry.level}:${entry.code}:${entry.message}`),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkerError)
    expect(error).toMatchObject({ code: 'open_failed', detail: 'locked' })
    expect(stages).toEqual(['opening'])
    expect(logs).toEqual(['warn:text_unreadable:3 texts'])
  })

  it('ungültiger Fehlercode ⇒ worker_error; Zeitlimit einer Anfrage ⇒ timeout', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector)
    c.start()
    workers[0]!.sendJson({ type: 'hello', protocol: 1, version: 'x' })
    workers[0]!.onWrite = (message) => {
      if (message.method === 'configure') workers[0]!.sendJson({ type: 'response', id: message.id, error: { code: 'Kaputt!', message: 'x' } })
    }
    await expect(c.request('configure', {})).rejects.toMatchObject({ code: 'worker_error' })
    await expect(c.request('status', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('Verbindung weg: offene Anfragen scheitern mit worker_disconnected, danach Wiederverbinden mit wachsendem Abstand', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector)
    const states: string[] = []
    c.onChange(() => states.push(c.info().state))
    c.start()
    workers[0]!.sendJson({ type: 'hello', protocol: 1, version: 'x' })
    const pending = c.request('status')
    workers[0]!.close(new Error('pipe broken'))
    await expect(pending).rejects.toMatchObject({ code: 'worker_disconnected' })
    expect(c.info()).toMatchObject({ state: 'disconnected', lastError: 'pipe broken' })

    // Versuch 2 scheitert sofort (Worker nicht da), Versuch 3 gelingt
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(workers.length).toBeGreaterThanOrEqual(2)
    workers.at(-1)!.close(new Error('ENOENT'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(workers.length).toBeGreaterThanOrEqual(3)
    workers.at(-1)!.sendJson({ type: 'hello', protocol: 1, version: 'y' })
    expect(c.connected).toBe(true)
    expect(c.info().version).toBe('y')
    expect(states).toEqual(expect.arrayContaining(['connecting', 'connected', 'disconnected']))
  })

  it('kein hello in der Zeit oder falsches Protokoll ⇒ trennen und neu versuchen', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector, { helloTimeoutMs: 20 })
    c.start()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(workers[0]!.closed).toBe(true)
    expect(c.info().lastError).toBe('no hello from worker')

    const other = memoryConnector()
    const d = client(other.connector)
    d.start()
    other.workers[0]!.sendJson({ type: 'hello', protocol: 2, version: 'neu' })
    expect(d.connected).toBe(false)
    expect(other.workers[0]!.closed).toBe(true)
    expect(d.info().lastError).toBe('unsupported protocol 2')
  })

  it('configure mit anderen Pfaden ⇒ restart_required ⇒ exit, neu verbinden, erneut einrichten', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector)
    c.start()
    const behave = (worker: MemoryWorker, startedWith: string | null) => {
      worker.sendJson({ type: 'hello', protocol: 1, version: 'x' })
      worker.onWrite = (message) => {
        const params = message.params as { platformBin?: string }
        if (message.method === 'configure') {
          if (startedWith && params.platformBin !== startedWith) worker.sendJson({ type: 'response', id: message.id, error: { code: 'restart_required', message: 'x' } })
          else worker.sendJson({ type: 'response', id: message.id, result: {} })
        }
        if (message.method === 'exit') worker.close()
      }
    }
    behave(workers[0]!, 'C:\\alt')
    const done = c.configure({ platformBin: 'C:\\neu', productBin: 'p', applicationModifier: '' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(workers).toHaveLength(2)
    behave(workers[1]!, null)
    await expect(done).resolves.toEqual({ restarted: true })
    expect(workers[0]!.written.map(m => m.method)).toEqual(['configure', 'exit'])
    expect(workers[1]!.written.map(m => m.method)).toEqual(['configure'])
    // gleiche Pfade auf derselben Verbindung: nichts mehr zu tun
    await expect(c.configure({ platformBin: 'C:\\neu', productBin: 'p', applicationModifier: '' })).resolves.toEqual({ restarted: false })
    expect(workers[1]!.written).toHaveLength(1)
  })

  it('restart beendet hart, wenn der Worker auf exit nicht reagiert', async () => {
    const { workers, connector } = memoryConnector()
    const c = client(connector, { exitTimeoutMs: 20 })
    c.start()
    workers[0]!.sendJson({ type: 'hello', protocol: 1, version: 'x' })
    await c.restart()
    expect(workers[0]!.closed).toBe(true)
    await tick()
    expect(workers).toHaveLength(2)
  })
})

describe('WorkerClient mit dem Ersatz-Worker (spawn)', () => {
  it('hello, status und configure', async () => {
    const c = new WorkerClient({ spec: fakeWorkerSpec(), log: () => {}, exitTimeoutMs: 2000 })
    clients.push(c)
    c.start()
    expect(await c.waitForConnection({ timeoutMs: 10_000 })).toBe(true)
    expect(c.info()).toMatchObject({ state: 'connected', version: '0.0.0-fake', transport: 'spawn' })
    await expect(c.status()).resolves.toEqual({ eplan: 'not_started', eplanVersion: null, busy: false, configured: false })
    await expect(c.configure({ platformBin: 'a', productBin: 'b', applicationModifier: '' })).resolves.toEqual({ restarted: false })
    await expect(c.status()).resolves.toMatchObject({ configured: true })
    await expect(c.request('nonsense')).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
