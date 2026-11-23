import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Kysely } from 'kysely'
import type { AnalysisResult, ConnectionRow, RawProject } from '@pds/analyzer'
import { coreMigrations } from '@pds/core/database'
import { createTestDatabase } from '@pds/core/testing'
import { pdsMigrations } from '../../server/database/migrations'
import type { AppDatabase } from '../../server/database/types'
import { defaultSettings } from '../../server/lib/settings'
import type { Actor } from '../../server/services/access'
import { createAppContext } from '../../server/services/context'
import type { AppContext, AppContextOptions } from '../../server/services/context'
import type { WorkerSpec } from '../../server/services/worker-client'
import type { SettingsInput } from '../../shared/types/api'

export const WEB_ROOT = resolve(import.meta.dirname, '../..')
export const REPO_ROOT = resolve(WEB_ROOT, '../..')
export const FAKE_WORKER = join(REPO_ROOT, 'tools/fake-worker/index.mjs')
export const SMALL_FIXTURE = join(WEB_ROOT, 'tests/fixtures/raw-small.json')

export function readFixture(path = SMALL_FIXTURE): RawProject {
  return JSON.parse(readFileSync(path, 'utf8')) as RawProject
}

export function createAppTestDatabase(name: string) {
  return createTestDatabase<AppDatabase>(`web_${name}`, [coreMigrations, pdsMigrations])
}

let counter = 0

/** Legt einen Benutzer an, wie es der Login tun würde */
export async function createUser(db: Kysely<AppDatabase>, options: { isAdmin?: boolean, name?: string } = {}): Promise<Actor & { displayName: string }> {
  counter++
  const displayName = options.name ?? `Benutzer ${counter}`
  const { id } = await db.insertInto('core.users')
    .values({ issuer: 'test', subject: `user-${counter}-${Math.random()}`, email: `user${counter}@example.com`, displayName, isAdmin: options.isAdmin ?? false })
    .output('inserted.id').executeTakeFirstOrThrow()
  return { id, isAdmin: options.isAdmin ?? false, displayName }
}

/** Ersatz-Worker als Kindprozess (Fixture fest, damit der Test sie selbst auswerten kann) */
export function fakeWorkerSpec(env: Record<string, string> = {}): WorkerSpec {
  return { kind: 'spawn', command: process.execPath, args: [FAKE_WORKER], cwd: REPO_ROOT, env: { FAKE_WORKER_FIXTURE: SMALL_FIXTURE, ...env } }
}

export type TestContext = AppContext & { lines: string[], cleanup: () => Promise<void> }

/** Kontext wie in Nuxt, aber mit zufälligem Schlüssel, eigenem Datenordner und ohne Ausgabe auf stdout */
export async function createTestContext(db: Kysely<AppDatabase>, options: Partial<AppContextOptions> = {}): Promise<TestContext> {
  const lines: string[] = []
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'pds-web-test-'))
  const ctx = createAppContext({
    db,
    secretKey: options.secretKey ?? randomBytes(32),
    dataDir,
    log: line => lines.push(line),
    ...options,
    worker: { reconnectInitialMs: 50, reconnectMaxMs: 200, exitTimeoutMs: 2000, ...options.worker },
    queue: { flushIntervalMs: 50, pollIntervalMs: 200, ...options.queue },
  })
  return Object.assign(ctx, {
    lines,
    cleanup: async () => {
      ctx.scheduler.stop()
      await ctx.queue.stop(5000)
      await ctx.worker.stop()
      if (!options.dataDir) await rm(dataDir, { recursive: true, force: true })
    },
  })
}

/** Vollständige Eingabe für saveSettings (Passwort unverändert, wenn nicht angegeben) */
export function settingsInput(overrides: Partial<Omit<SettingsInput, 'networkDrive' | 'eplan'>> & {
  networkDrive?: Partial<SettingsInput['networkDrive']>
  eplan?: Partial<SettingsInput['eplan']>
} = {}): SettingsInput {
  const base = structuredClone(defaultSettings)
  const { networkDrive, eplan, ...rest } = overrides
  return {
    ...base,
    ...rest,
    networkDrive: { ...base.networkDrive, password: undefined, ...networkDrive },
    eplan: { ...base.eplan, ...eplan },
  }
}

/** Temporärer Ordner mit Dateien (Pfade mit /, Ordner werden angelegt); mtime optional */
export async function tempFolder(files: Record<string, { content?: string, mtime?: Date } | string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pds-web-folder-'))
  for (const [name, spec] of Object.entries(files)) {
    const { content = 'eplan', mtime } = typeof spec === 'string' ? { content: spec } : spec
    const path = join(dir, ...name.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    if (mtime) await utimes(path, mtime, mtime)
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Wartet, bis eine Bedingung erfüllt ist (Hintergrundarbeit) */
export async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('Zeitüberschreitung beim Warten')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
}

/** Ergebnis mit `n` Verbindungen (und je einem Kabel, Schirm, Text) ohne Auswertung – für Speichertests */
export function syntheticResult(n: number, tag = 'x'): AnalysisResult {
  const connections: ConnectionRow[] = Array.from({ length: n }, (_, idx) => ({
    idx,
    eplanId: `${tag}-${idx}`,
    page: `=A1+S1/${Math.floor(idx / 50) + 1}`,
    definition: 'Ader / Draht',
    designation: idx % 2 ? 'VD_X500' : '',
    source: `=A1+S1-Q${idx}:1`,
    destination: `=A1+S1-X1:${idx}`,
    cable: idx % 3 ? '' : '-W1',
    wireNumber: 'BK',
    crossSection: '1,5 mm²',
    wireType: 'H07V-K',
    length: '',
    partNumbers: 'SIE.1, SIE.2',
    hashMark: idx % 5 === 0,
    twisted: idx % 2 === 1,
    shielded: idx % 7 === 0,
  }))
  return {
    connections,
    cables: [{
      idx: 0, kind: 'cable', name: '-W1', definition: 'Kabeldefinition', page: '=A1+S1/1', source: 'Q', destination: 'X', type: 'GSC-01',
      wireCountAndCrossSection: '4x0,22', length: '5 m', partNumbers: '',
      wires: [{ idx: 0, connectionIdx: 0, definition: 'Ader', page: '=A1+S1/1', source: 'Q', destination: 'X', length: '', wireNumber: 'BK', crossSection: '0,22', partNumbers: '' }],
    }],
    shields: [{ idx: 0, page: '=A1+S1/1', name: 'Abschirmung', type: 'GSC-01', wireCountAndCrossSection: '4x0,22', connectionIdx: [0, Math.min(1, n - 1)].filter(i => i >= 0) }],
    texts: [{ idx: 0, page: '=A1+S1/1', text: `Text ${tag}` }],
    counts: {
      connections: n, hashMarks: 0, unmatchedHashMarks: 0, twisted: 0, twistSymbols: 0, unmatchedTwistTicks: 0,
      shielded: 0, shields: 1, cables: 1, texts: 1, pages: 1,
    },
    notices: [],
  }
}

/** Projekt mit einer laufenden Analyse anlegen (für Speicher- und Aufbewahrungstests) */
export async function createRunningAnalysis(db: Kysely<AppDatabase>, options: { projectId?: number, name?: string, queuedAt?: Date } = {}) {
  const projectId = options.projectId ?? (await db.insertInto('pds.projects')
    .values({ source: 'upload', name: options.name ?? 'P', path: null, pathKey: (options.name ?? `p-${Math.random()}`).toLowerCase(), fileKind: 'zw1', createdBy: null })
    .output('inserted.id').executeTakeFirstOrThrow()).id
  const { id } = await db.insertInto('pds.analyses')
    .values({ projectId, trigger: 'manual', triggeredBy: null, status: 'running', startedAt: new Date(), queuedAt: options.queuedAt ?? new Date() })
    .output('inserted.id').executeTakeFirstOrThrow()
  return { projectId, analysisId: id }
}
