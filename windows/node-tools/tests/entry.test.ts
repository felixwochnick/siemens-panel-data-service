import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const entrySource = fileURLToPath(new URL('../src/pds-entry.mjs', import.meta.url))

// Ersatz für Nitros server/index.mjs: Shutdown wie in Nitro über process.once('SIGTERM'), ein lauschender
// HTTP-Server wie bei Nitro (meldet sein Zeitlimit für ganze Anfragen) hält den Prozess am Leben
const fakeServer = `
import { createServer } from 'node:http'
process.once('SIGTERM', () => {
  process.stdout.write('shutdown-ok\\n')
  process.exit(0)
})
const server = createServer(() => {})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('requestTimeout=' + server.requestTimeout + '\\n')
  process.stdout.write('ready\\n')
})
`

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function prepareAppDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pds-entry-'))
  tempDirs.push(dir)
  await copyFile(entrySource, join(dir, 'pds-entry.mjs'))
  await mkdir(join(dir, 'server'))
  await writeFile(join(dir, 'server', 'index.mjs'), fakeServer)
  return dir
}

function collect(child: ChildProcessWithoutNullStreams) {
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk))
  return output
}

function waitFor(check: () => boolean, child: ChildProcessWithoutNullStreams, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        cleanup()
        resolve()
      }
    }, 10)
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Zeitüberschreitung beim Warten auf ${what}`))
    }, 5_000)
    const onExit = (code: number | null) => {
      cleanup()
      if (check()) resolve()
      else reject(new Error(`Prozess endete mit ${code} vor ${what}`))
    }
    function cleanup() {
      clearInterval(timer)
      clearTimeout(timeout)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

describe('pds-entry.mjs', () => {
  it('closing_stdin_triggers_graceful_shutdown', async () => {
    const dir = await prepareAppDir()
    const child = spawn(process.execPath, [join(dir, 'pds-entry.mjs')], { cwd: dir, stdio: 'pipe' })
    const output = collect(child)
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))

    try {
      // Erst schließen, wenn der Server seinen SIGTERM-Handler registriert hat
      await waitFor(() => output.stdout.includes('ready'), child, 'ready')

      const started = performance.now()
      child.stdin.end()
      const guard = setTimeout(() => child.kill('SIGKILL'), 5_000)
      const code = await exited
      clearTimeout(guard)
      const duration = performance.now() - started

      expect(output.stderr).toBe('')
      expect(code).toBe(0)
      expect(output.stdout).toContain('shutdown-ok')
      expect(duration).toBeLessThan(2_000)
      // Große Uploads: kein Abbruch nach Nodes Standard von 300 s
      expect(output.stdout).toContain(`requestTimeout=${2 * 60 * 60 * 1000}`)
    }
    finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 15_000)
})
