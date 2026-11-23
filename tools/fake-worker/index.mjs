#!/usr/bin/env node
/*
 * Ersatz-Worker für Entwicklung und Tests unter Linux: spricht das Protokoll des EPLAN-Workers (JSON-Zeilen über
 * stdin/stdout, siehe docs/superpowers/specs/2026-11-23-pds-monorepo-design.md, „Protokoll“) und liefert statt
 * EPLAN-Rohdaten eine Fixture. Ohne Abhängigkeiten.
 *
 *   NUXT_EPLAN_WORKER=spawn:node tools/fake-worker/index.mjs
 *
 * Umgebung:
 *   FAKE_WORKER_FIXTURE   Rohdaten-Datei (Standard packages/analyzer/fixtures/sample-raw.json, sonst
 *                         apps/web/tests/fixtures/raw-small.json)
 *   FAKE_WORKER_DELAY_MS  Wartezeit je Stufe von analyze (Standard 0)
 *   FAKE_WORKER_FAIL      analyze antwortet mit diesem Fehlercode (z. B. open_failed)
 *   FAKE_WORKER_CRASH=1   Prozess endet mitten in analyze (Absturz)
 *   FAKE_WORKER_START_FAIL=1  EPLAN-Start scheitert; wie beim echten Worker bleibt EPLAN in diesem Prozess gescheitert
 *   FAKE_WORKER_EPLAN_VERSION  gemeldete EPLAN-Version (Standard 2025.0.3)
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const VERSION = '0.0.0-fake'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FIXTURE = join(root, 'packages/analyzer/fixtures/sample-raw.json')
const FALLBACK_FIXTURE = join(root, 'apps/web/tests/fixtures/raw-small.json')

const delayMs = Math.max(0, Number(process.env.FAKE_WORKER_DELAY_MS ?? 0) || 0)
const failCode = (process.env.FAKE_WORKER_FAIL ?? '').trim()
const crash = process.env.FAKE_WORKER_CRASH === '1'
const startFail = process.env.FAKE_WORKER_START_FAIL === '1'
const eplanVersion = process.env.FAKE_WORKER_EPLAN_VERSION || '2025.0.3'

/** Pfade aus configure; EPLAN „startet“ beim ersten analyze mit genau diesen */
let configured = null
let startedWith = null
let eplan = 'not_started'
let busy = false

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const respond = (id, result) => send({ type: 'response', id, result })
const fail = (id, code, message) => send({ type: 'response', id, error: { code, message } })
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
// Wie EplanPaths.Matches im echten Worker: ohne Groß-/Kleinschreibung und abschließenden Trenner
const normalizePath = value => value.trim().replace(/[\\/]+$/, '').toLowerCase()
const samePaths = (a, b) => normalizePath(a.platformBin) === normalizePath(b.platformBin)
  && normalizePath(a.productBin) === normalizePath(b.productBin)
  && a.applicationModifier.trim().toLowerCase() === b.applicationModifier.trim().toLowerCase()

function fixturePath() {
  if (process.env.FAKE_WORKER_FIXTURE) return resolve(process.env.FAKE_WORKER_FIXTURE)
  return existsSync(DEFAULT_FIXTURE) ? DEFAULT_FIXTURE : FALLBACK_FIXTURE
}

function configure(id, params) {
  const paths = {
    platformBin: String(params?.platformBin ?? ''),
    productBin: String(params?.productBin ?? ''),
    applicationModifier: String(params?.applicationModifier ?? ''),
  }
  // EPLAN lässt sich je Prozess nur einmal starten
  if (startedWith && !samePaths(startedWith, paths)) return fail(id, 'restart_required', 'EPLAN is already running with other paths')
  configured = paths
  respond(id, { configured: true })
}

async function analyze(id, params) {
  if (!configured) return fail(id, 'not_configured', 'configure first')
  if (busy) return fail(id, 'busy', 'another analysis is running')
  const { projectPath, workFolder, outputFile } = params ?? {}
  if (typeof projectPath !== 'string' || typeof workFolder !== 'string' || typeof outputFile !== 'string')
    return fail(id, 'invalid_request', 'projectPath, workFolder and outputFile are required')
  // Wie der echte Worker: nur .elk (mit .edb) und .zw1
  const extension = extname(projectPath).toLowerCase()
  if (extension !== '.elk' && extension !== '.zw1') return fail(id, 'invalid_request', `unsupported file type ${extension}`)
  // Wie der echte Worker: Projekt prüfen, bevor EPLAN startet
  if (!existsSync(projectPath)) return fail(id, 'project_not_found', `not found: ${projectPath}`)
  if (extension === '.elk' && !existsSync(join(dirname(projectPath), `${basename(projectPath, extname(projectPath))}.edb`)))
    return fail(id, 'project_not_found', `.edb missing for ${basename(projectPath)}`)
  // EPLAN lässt sich je Prozess nur einmal starten: ein gescheiterter Start bleibt gescheitert
  if (eplan === 'failed') return fail(id, 'eplan_start_failed', 'simulated EPLAN start failure')
  busy = true
  try {
    const stage = async (name) => {
      send({ type: 'progress', id, stage: name })
      if (delayMs) await sleep(delayMs)
    }
    if (eplan !== 'ready') {
      eplan = 'starting'
      await stage('starting_eplan')
      startedWith = { ...configured }
      if (startFail) {
        eplan = 'failed'
        return fail(id, 'eplan_start_failed', 'simulated EPLAN start failure')
      }
      eplan = 'ready'
    }
    if (extension === '.zw1') await stage('restoring')
    await stage('opening')
    if (crash) process.exit(70)
    await stage('reading')
    if (failCode) return fail(id, failCode, `simulated failure (${failCode})`)
    send({ type: 'log', id, level: 'info', code: 'fake_worker', message: `fixture ${basename(fixturePath())}` })
    await stage('writing')
    const raw = JSON.parse(await readFile(fixturePath(), 'utf8'))
    raw.project = { ...raw.project, name: basename(projectPath, extname(projectPath)) }
    raw.worker = VERSION
    raw.eplanVersion = eplanVersion
    await writeFile(outputFile, JSON.stringify(raw))
    respond(id, { outputFile, pages: raw.pages?.length ?? 0, connections: raw.connections?.length ?? 0 })
  }
  catch (error) {
    fail(id, 'write_failed', error instanceof Error ? error.message : String(error))
  }
  finally {
    busy = false
  }
}

function handle(line) {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  }
  catch {
    return fail(null, 'invalid_request', 'line is not JSON')
  }
  const { id, method, params } = message ?? {}
  if (message?.type !== 'request' || typeof id !== 'string' || typeof method !== 'string')
    return fail(typeof id === 'string' ? id : null, 'invalid_request', 'expected { type: "request", id, method }')
  switch (method) {
    case 'configure':
      return configure(id, params)
    case 'status':
      return respond(id, { eplan, eplanVersion: eplan === 'ready' ? eplanVersion : null, busy, configured: !!configured })
    case 'analyze':
      return void analyze(id, params)
    case 'exit': {
      const code = Number.isInteger(params?.code) ? params.code : 0
      // Erst die Antwort ausliefern, dann beenden
      return process.stdout.write(`${JSON.stringify({ type: 'response', id, result: {} })}\n`, () => process.exit(code))
    }
    default:
      return fail(id, 'invalid_request', `unknown method ${method}`)
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', handle)
// Client weg (stdin geschlossen): beenden wie der echte Worker im Modus stdio
input.on('close', () => process.exit(0))

send({ type: 'hello', protocol: 1, version: VERSION })
