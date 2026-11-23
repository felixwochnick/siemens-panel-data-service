import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const entrySource = fileURLToPath(new URL('../src/pds-entry.mjs', import.meta.url))

// Ersatz für Nitros server/index.mjs: Shutdown wie in Nitro über process.once('SIGTERM'),
// ein Intervall hält den Prozess wie ein lauschender Server am Leben
const fakeServer = `
process.once('SIGTERM', () => {
  process.stdout.write('shutdown-ok\\n')
  process.exit(0)
})
setInterval(() => {}, 60_000)
process.stdout.write('ready\\n')
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
    }
    finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 15_000)
})
