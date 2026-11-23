import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Rauchtest des echten Bündels: Es läuft in einem eigenen Prozess wie auf dem Zielrechner (ohne node_modules)
const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = fileURLToPath(new URL('../dist/pds-tools.mjs', import.meta.url))

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function runBundle(command: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    // Nur die übergebene Umgebung (PATH braucht Node nicht einmal), wie beim Aufruf durch den Dienst
    execFile(process.execPath, ['--use-system-ca', bundle, command], { env, cwd: '/' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })
}

describe('dist/pds-tools.mjs', () => {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'pds-node-tools-bundle-'))

  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe' })
  })
  afterAll(() => rmSync(sqliteDir, { recursive: true, force: true }))

  it('db_script_prints_exactly_one_result_line', async () => {
    const run = await runBundle('db-script', { PDS_DB_NAME: 'pds', PDS_DB_USER: 'pds_app' })

    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    const lines = run.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const result = JSON.parse(lines[0] ?? '')
    expect(result).toMatchObject({ type: 'result', ok: true, code: 'ok' })
    expect(result.details.script).toContain(':setvar DB_NAME "pds"')
  })

  it('usage_error_exits_with_1_and_still_prints_a_result', async () => {
    const run = await runBundle('db-test', {})

    expect(run.code).toBe(1)
    const lines = run.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'result', ok: false, code: 'internal_error' })
  })

  it('failed_check_exits_with_3', async () => {
    const run = await runBundle('db-test', { NUXT_DATABASE_URL: 'kein url' })

    expect(run.code).toBe(3)
    expect(JSON.parse(run.stdout.split('\n').filter(Boolean).at(-1) ?? '')).toMatchObject({ ok: false, code: 'invalid_url' })
  })

  it('sqlite_test_and_backup_work_without_node_modules', async () => {
    // node:sqlite ist in Node eingebaut und bleibt außerhalb des Bündels; keine Warnung auf stderr
    const path = join(sqliteDir, 'pds.db')
    // db-test legt nichts an: Die Datenbank kommt vom Test
    const seed = new DatabaseSync(path)
    seed.exec('CREATE TABLE pds_probe (id integer PRIMARY KEY)')
    seed.close()
    const test = await runBundle('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(test.stderr).toBe('')
    expect(test.code).toBe(0)
    expect(JSON.parse(test.stdout.split('\n').filter(Boolean).at(-1) ?? '')).toMatchObject({ type: 'result', ok: true, details: { path } })

    const backup = await runBundle('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: join(sqliteDir, 'kopie.db') })
    expect(backup.stderr).toBe('')
    expect(backup.code).toBe(0)
    expect(existsSync(join(sqliteDir, 'kopie.db'))).toBe(true)
  })

  it('ships_the_third_party_license_notices_next_to_it', () => {
    // Task 13 legt die Datei in den Ordner licenses\ des Pakets
    expect(existsSync(`${bundle}.LEGAL.txt`)).toBe(true)
  })
})
