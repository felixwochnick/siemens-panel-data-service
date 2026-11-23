import { createReadStream } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { LogFileInfo, LogsInfo, LogTail } from '../../shared/types/api'
import type { Actor } from './access'
import { requireAdmin } from './access'
import { ServiceError, notFound } from './errors'

const CHUNK_BYTES = 64 * 1024
/** so weit wird höchstens zurückgelesen (eine rotierte Datei hat 10 MB) */
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const MAX_LINE_LENGTH = 4000
export const MAX_TAIL_LINES = 2000

/**
 * Dateiname aus der Anfrage: nur ein schlichter Name ohne Pfadanteile. Ob es die Datei im Protokollordner gibt,
 * entscheidet danach die Liste des Ordners – nie ein aus der Anfrage gebauter Pfad.
 */
function isPlainName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name === basename(name) && !/[/\\:\0]/.test(name)
    && name !== '.' && name !== '..' && !name.startsWith('.')
}

async function listEntries(logDir: string): Promise<LogFileInfo[] | null> {
  let names: string[]
  try {
    names = await readdir(logDir)
  }
  catch {
    return null
  }
  const files: LogFileInfo[] = []
  for (const name of names) {
    if (!isPlainName(name)) continue
    try {
      // lstat: Verknüpfungen zählen nicht (könnten aus dem Ordner herausführen)
      const stat = await lstat(join(logDir, name))
      if (stat.isFile()) files.push({ name, size: stat.size, modifiedAt: stat.mtime.toISOString() })
    }
    catch {
      // zwischen readdir und lstat rotiert oder gelöscht
    }
  }
  // Aktuelle Dateien zuerst (app.log vor app.log.1), dann nach Name
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/** Protokolldateien im Ordner NUXT_LOG_DIR (nur Dateien direkt darin) */
export async function listLogFiles(logDir: string, actor: Actor): Promise<LogsInfo> {
  requireAdmin(actor)
  if (!logDir) return { configured: false, readable: false, files: [] }
  const files = await listEntries(logDir)
  return { configured: true, readable: files !== null, files: files ?? [] }
}

/** Pfad einer gelisteten Datei; sonst 404 (auch für Namen mit Pfadanteilen) */
async function resolveLogFile(logDir: string, name: string): Promise<{ path: string, info: LogFileInfo }> {
  if (!logDir) throw new ServiceError(404, 'log_dir_not_configured')
  if (!isPlainName(name)) throw notFound()
  const files = await listEntries(logDir)
  const info = files?.find(file => file.name === name)
  if (!info) throw notFound()
  const root = await realpath(resolve(logDir))
  const path = await realpath(join(root, info.name))
  // Doppelt gesichert: die echte Datei liegt direkt im Protokollordner
  if (dirname(path) !== root) throw notFound()
  return { path, info }
}

export interface TailOptions {
  /** letzte N (passende) Zeilen */
  lines?: number
  /** Textfilter, Groß/Klein egal */
  filter?: string
}

/**
 * Letzte N Zeilen einer Protokolldatei, rückwärts in Blöcken gelesen (auch große rotierte Dateien bleiben schnell).
 * Mit Filter: die letzten N passenden Zeilen, höchstens MAX_SCAN_BYTES weit zurück.
 */
export async function readLogTail(logDir: string, actor: Actor, name: string, options: TailOptions = {}): Promise<LogTail> {
  requireAdmin(actor)
  const { path, info } = await resolveLogFile(logDir, name)
  const wanted = Math.min(Math.max(Math.trunc(options.lines ?? 200), 1), MAX_TAIL_LINES)
  const needle = options.filter?.trim().toLowerCase() ?? ''
  const matches = (line: string) => !needle || line.toLowerCase().includes(needle)

  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const collected: string[] = []
    let position = size
    // Rest am Blockanfang: gehört zur Zeile, deren Anfang erst im nächsten (früheren) Block liegt
    let carry = Buffer.alloc(0)
    let scanned = 0
    let first = true
    let more = false

    const take = (raw: Buffer) => {
      let line = raw.toString('utf8')
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!matches(line)) return
      collected.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)} …` : line)
    }

    while (position > 0 && collected.length < wanted) {
      if (scanned >= MAX_SCAN_BYTES) {
        more = true
        break
      }
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      scanned += length
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, position)
      let data = Buffer.concat([chunk, carry])
      // Abschließender Zeilenumbruch der Datei ist keine leere Zeile
      if (first) {
        if (data.at(-1) === 0x0A) data = data.subarray(0, -1)
        first = false
      }
      let end = data.length
      for (let i = data.length - 1; i >= 0 && collected.length < wanted; i--) {
        if (data[i] !== 0x0A) continue
        take(data.subarray(i + 1, end))
        end = i
      }
      carry = data.subarray(0, end)
      if (collected.length >= wanted) {
        more = position > 0 || carry.length > 0
        break
      }
    }
    // Erste Zeile der Datei (ohne Umbruch davor)
    if (position === 0 && collected.length < wanted && carry.length > 0) take(carry)
    else if (position > 0 && collected.length < wanted) more = true

    return { ...info, size, lines: collected.reverse(), truncated: more }
  }
  finally {
    await handle.close()
  }
}

/**
 * Datei zum Herunterladen (Stream); Name bleibt der gelistete. Gelesen wird bis zur Größe beim Öffnen: das Log wächst
 * weiter, die angekündigte Länge muss trotzdem stimmen.
 */
export async function openLogFile(logDir: string, actor: Actor, name: string): Promise<{ name: string, size: number, stream: Readable }> {
  requireAdmin(actor)
  const { path, info } = await resolveLogFile(logDir, name)
  const { size } = await lstat(path)
  return { name: info.name, size, stream: size > 0 ? createReadStream(path, { start: 0, end: size - 1 }) : Readable.from([]) }
}
