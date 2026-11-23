import { copyFile, cp, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep, win32 } from 'node:path'
import type { Kysely } from 'kysely'
import { isUniqueViolation } from '@pds/core/database'
import type { AppDatabase } from '../database/types'
import { AnalysisError } from '../lib/errors'
import { errorText, noopLogger } from '../lib/log'
import type { EventLogger } from '../lib/log'
import { patternToRegExp } from '../lib/settings'
import type { AnalysisStatus, FileKind, FolderProject, FolderScanResult, FolderSkip, PdsSettings } from '../../shared/types/api'
import type { Actor } from './access'
import { requireUser } from './access'
import type { AppContext } from './context'
import { ServiceError } from './errors'
import { loadSettings } from './settings'

/** Längster Pfad relativ zum Projektordner (Spalte path_key, Indexgrenze von SQL Server) */
export const MAX_PROJECT_PATH = 800

export interface ScannedProject {
  /** relativ zum Projektordner, Trennzeichen des Servers */
  path: string
  /** kleingeschrieben, Trennzeichen / */
  pathKey: string
  name: string
  fileKind: FileKind
  sourceModified: Date
  absolutePath: string
}

export interface ScanResult {
  folder: string
  items: ScannedProject[]
  skipped: FolderSkip[]
}

/** Schlüssel eines Ordner-Projekts: Groß-/Kleinschreibung und Trennzeichen spielen keine Rolle (wie unter Windows) */
export const folderPathKey = (path: string) => path.split(/[\\/]+/).filter(Boolean).join('/').toLowerCase()

const KINDS: Record<string, FileKind> = { '.elk': 'elk', '.zw1': 'zw1' }
const kindOf = (fileName: string): FileKind | undefined => KINDS[extname(fileName).toLowerCase()]
const edbNameOf = (elkName: string) => `${basename(elkName, extname(elkName))}.edb`.toLowerCase()

/** Zeitpunkt auf Millisekunden (so speichern ihn beide Datenbanken) */
const toMs = (ms: number) => new Date(Math.floor(ms))

/** Neueste Änderung einer Datei in einem Ordner (rekursiv); 0 bei leerem Ordner */
async function newestInDirectory(dir: string, signal?: AbortSignal): Promise<number> {
  let newest = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, await newestInDirectory(path, signal))
    else if (entry.isFile()) newest = Math.max(newest, (await stat(path)).mtimeMs)
  }
  return newest
}

/** .edb-Ordner zu einer .elk-Datei (gleicher Name, Groß-/Kleinschreibung egal); undefined, wenn es keinen gibt */
export async function findEdbPath(elkPath: string): Promise<string | undefined> {
  try {
    const entry = findEdb(await readdir(dirname(elkPath), { withFileTypes: true }), basename(elkPath))
    return entry ? join(dirname(elkPath), entry.name) : undefined
  }
  catch {
    return undefined
  }
}

/** Änderungszeit eines Projekts: .zw1 selbst bzw. die neueste Datei aus .elk und .edb (rekursiv) */
export async function projectModified(absolutePath: string, kind: FileKind, signal?: AbortSignal, edbPath?: string): Promise<Date> {
  const own = (await stat(absolutePath)).mtimeMs
  if (kind === 'zw1') return toMs(own)
  const edb = edbPath ?? await findEdbPath(absolutePath)
  return toMs(Math.max(own, edb ? await newestInDirectory(edb, signal) : 0))
}

const isDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

/** .edb-Ordner zur .elk-Datei (gleicher Name, Groß-/Kleinschreibung egal) aus den Einträgen desselben Ordners */
function findEdb(entries: Dirent[], elkName: string): Dirent | undefined {
  const wanted = edbNameOf(elkName)
  return entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === wanted)
}

/**
 * Projekte im Projektordner nach den Mustern (rekursiv, wenn eingestellt): `.zw1` und `.elk` mit gleichnamigem
 * `.edb`-Ordner (ohne ihn übersprungen). `.edb`-Ordner selbst werden nicht durchsucht. Wirft ServiceError, wenn der
 * Ordner fehlt oder nicht lesbar ist.
 */
export async function scanFolder(settings: Pick<PdsSettings, 'folder' | 'recursive' | 'filePatterns'>, signal?: AbortSignal): Promise<ScanResult> {
  const folder = settings.folder.trim()
  if (!folder) throw new ServiceError(400, 'folder_not_configured')
  try {
    if (!(await stat(folder)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
  }
  catch (error) {
    const code = (error as { code?: unknown }).code
    throw new ServiceError(424, code === 'ENOENT' || code === 'ENOTDIR' ? 'folder_not_found' : 'folder_unreadable', { details: errorText(error) })
  }
  const patterns = settings.filePatterns.map(patternToRegExp)
  const items: ScannedProject[] = []
  const skipped: FolderSkip[] = []

  const walk = async (dir: string) => {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch (error) {
      if (dir === folder) throw new ServiceError(424, 'folder_unreadable', { details: errorText(error) })
      // Unterordner ohne Leserechte überspringen
      return
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (settings.recursive && !/\.edb$/i.test(entry.name)) await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const kind = kindOf(entry.name)
      if (!kind || !patterns.some(pattern => pattern.test(entry.name))) continue
      const path = relative(folder, absolutePath)
      if (path.length > MAX_PROJECT_PATH) {
        skipped.push({ path, code: 'path_too_long' })
        continue
      }
      const edb = kind === 'elk' ? findEdb(entries, entry.name) : undefined
      if (kind === 'elk' && !edb) {
        skipped.push({ path, code: 'edb_missing' })
        continue
      }
      try {
        items.push({
          path,
          pathKey: folderPathKey(path),
          name: basename(entry.name, extname(entry.name)),
          fileKind: kind,
          sourceModified: await projectModified(absolutePath, kind, signal, edb && join(dir, edb.name)),
          absolutePath,
        })
      }
      catch (error) {
        if (signal?.aborted) throw error
        // zwischen Auflisten und Lesen gelöscht: beim nächsten Mal
      }
    }
  }
  await walk(folder)
  items.sort((a, b) => a.pathKey.localeCompare(b.pathKey))
  return { folder, items, skipped }
}

/**
 * Netzlaufwerk vor dem Zugriff verbinden (nur source network). `always`: jedes Mal neu (Analyse, Zeitplan);
 * `if_needed`: nur, wenn der Ordner nicht erreichbar ist (Liste in der Oberfläche – ein Neuverbinden trennt das
 * Laufwerk kurz und störte eine laufende Kopie). Fehler als AnalysisError (network_drive_*, drive_unavailable).
 */
export async function ensureFolderAvailable(ctx: Pick<AppContext, 'drive'>, settings: PdsSettings, unreadable: readonly string[], mode: 'always' | 'if_needed', log: EventLogger = noopLogger, signal?: AbortSignal): Promise<void> {
  if (settings.source !== 'network') return
  if (mode === 'if_needed' && await isDirectory(settings.folder.trim())) return
  if (unreadable.includes('networkDrive.password')) throw new AnalysisError('secret_unreadable', 'networkDrive.password')
  await ctx.drive.connect(settings.networkDrive, log, signal)
}

/** Fehler beim Verbinden als ServiceError für API und MCP */
function driveError(error: unknown): never {
  if (error instanceof AnalysisError) throw new ServiceError(424, error.code, error.detail ? { details: error.detail } : {})
  throw error
}

/** Ordner-Projekt anlegen oder aktualisieren (Name, Pfad, Änderungszeit); liefert die id */
export async function upsertFolderProject(db: Kysely<AppDatabase>, scanned: Omit<ScannedProject, 'absolutePath'>, userId: string | null, now = new Date()): Promise<number> {
  const update = async () => {
    const existing = await db.selectFrom('pds.projects').select(['id', 'name', 'path', 'fileKind', 'sourceModified'])
      .where('source', '=', 'folder').where('pathKey', '=', scanned.pathKey).executeTakeFirst()
    if (!existing) return undefined
    // Unverändert: updated_at nicht anfassen (Sortierung „zuletzt geändert“)
    if (existing.name === scanned.name && existing.path === scanned.path && existing.fileKind === scanned.fileKind
      && existing.sourceModified?.getTime() === scanned.sourceModified.getTime()) return existing.id
    await db.updateTable('pds.projects')
      .set({ name: scanned.name, path: scanned.path, fileKind: scanned.fileKind, sourceModified: scanned.sourceModified, updatedAt: now })
      .where('id', '=', existing.id)
      .execute()
    return existing.id
  }
  const id = await update()
  if (id !== undefined) return id
  try {
    const row = await db.insertInto('pds.projects')
      .values({
        source: 'folder',
        name: scanned.name,
        path: scanned.path,
        pathKey: scanned.pathKey,
        fileKind: scanned.fileKind,
        sourceModified: scanned.sourceModified,
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
      })
      .output('inserted.id')
      .executeTakeFirstOrThrow()
    return row.id
  }
  catch (error) {
    // gleichzeitig angelegt (anderer Prozess, Zeitplan)
    if (!isUniqueViolation(error)) throw error
    const again = await update()
    if (again === undefined) throw error
    return again
  }
}

/** Stand der bekannten Ordner-Projekte: aktuelle Analyse (mit Änderungszeit) und Status der neuesten */
export async function folderProjectStates(db: Kysely<AppDatabase>) {
  const projects = await db.selectFrom('pds.projects as p')
    .leftJoin('pds.analyses as c', 'c.id', 'p.currentAnalysisId')
    .select(['p.id', 'p.pathKey', 'p.currentAnalysisId', 'c.sourceModified as currentSourceModified'])
    .where('p.source', '=', 'folder')
    .execute()
  const latest = await db.selectFrom('pds.analyses as a')
    .innerJoin('pds.projects as p', 'p.id', 'a.projectId')
    .select(['a.projectId', 'a.status', 'a.id'])
    .where('p.source', '=', 'folder')
    .where('a.id', 'in', eb => eb.selectFrom('pds.analyses as x').select(e => e.fn.max('x.id').as('id')).groupBy('x.projectId'))
    .execute()
  const latestStatus = new Map<number, AnalysisStatus>(latest.map(row => [row.projectId, row.status]))
  return new Map(projects.map(row => [row.pathKey, {
    id: row.id,
    currentAnalysisId: row.currentAnalysisId,
    currentSourceModified: row.currentSourceModified,
    latestStatus: latestStatus.get(row.id) ?? null,
  }]))
}

/** Geändert seit der letzten erfolgreichen Analyse (oder nie erfolgreich analysiert) */
export const isChanged = (sourceModified: Date, currentSourceModified: Date | null | undefined) =>
  !currentSourceModified || sourceModified.getTime() > currentSourceModified.getTime()

/** Projekte im Projektordner mit ihrem Stand in der Datenbank (Dialog „Aus Ordner wählen“) */
export async function listFolderProjects(ctx: AppContext, actor: Actor, signal?: AbortSignal): Promise<FolderScanResult> {
  requireUser(actor)
  const { settings, unreadable } = await loadSettings(ctx)
  if (!settings.folder.trim()) throw new ServiceError(400, 'folder_not_configured')
  await ensureFolderAvailable(ctx, settings, unreadable, 'if_needed', noopLogger, signal).catch(driveError)
  const scan = await scanFolder(settings, signal)
  const states = await folderProjectStates(ctx.db)
  const items: FolderProject[] = scan.items.map((item) => {
    const state = states.get(item.pathKey)
    return {
      path: item.path,
      name: item.name,
      fileKind: item.fileKind,
      sourceModified: item.sourceModified.toISOString(),
      project: state ? { id: state.id, currentAnalysisId: state.currentAnalysisId, latestStatus: state.latestStatus } : null,
      changed: isChanged(item.sourceModified, state?.currentSourceModified),
    }
  })
  return { folder: scan.folder, items, skipped: scan.skipped }
}

/**
 * Pfad aus der Anfrage (relativ zum Projektordner) → absoluter Pfad im Ordner; undefined bei absoluten Pfaden, `..`
 * oder leeren Angaben. Beide Trennzeichen sind erlaubt.
 */
export function resolveInFolder(folder: string, input: string): { path: string, absolutePath: string } | undefined {
  const text = (input ?? '').trim()
  if (!text || isAbsolute(text) || win32.isAbsolute(text) || /^[a-z]:/i.test(text)) return undefined
  const parts = text.split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes('\0'))) return undefined
  const path = parts.join(sep)
  return { path, absolutePath: join(folder, path) }
}

export type ResolvedFolderProject = { path: string, projectId: number } | { path: string, code: string }

/**
 * Ordnerpfade aus der Anfrage (Dialog „Aus Ordner wählen“, MCP) zu Projekten: prüft die Dateien, legt Projekte an
 * bzw. aktualisiert sie. Je Pfad die Projekt-id oder ein Code (invalid_path, folder_project_not_found, edb_missing).
 */
export async function resolveFolderProjects(ctx: AppContext, actor: Actor, paths: readonly string[], signal?: AbortSignal): Promise<ResolvedFolderProject[]> {
  requireUser(actor)
  const { settings, unreadable } = await loadSettings(ctx)
  const folder = settings.folder.trim()
  if (!folder) throw new ServiceError(400, 'folder_not_configured')
  await ensureFolderAvailable(ctx, settings, unreadable, 'if_needed', noopLogger, signal).catch(driveError)
  const result: ResolvedFolderProject[] = []
  const seen = new Set<string>()
  for (const input of paths) {
    const resolved = resolveInFolder(folder, input)
    const kind = resolved && kindOf(resolved.absolutePath)
    if (!resolved || !kind || resolved.path.length > MAX_PROJECT_PATH) {
      result.push({ path: input, code: 'invalid_path' })
      continue
    }
    const pathKey = folderPathKey(resolved.path)
    if (seen.has(pathKey)) continue
    seen.add(pathKey)
    try {
      if (!(await stat(resolved.absolutePath)).isFile()) throw new Error('not a file')
    }
    catch {
      result.push({ path: input, code: 'folder_project_not_found' })
      continue
    }
    if (kind === 'elk' && !(await findEdbPath(resolved.absolutePath))) {
      result.push({ path: input, code: 'edb_missing' })
      continue
    }
    const projectId = await upsertFolderProject(ctx.db, {
      path: resolved.path,
      pathKey,
      name: basename(resolved.path, extname(resolved.path)),
      fileKind: kind,
      sourceModified: await projectModified(resolved.absolutePath, kind, signal),
    }, actor.id, ctx.now())
    result.push({ path: input, projectId })
  }
  return result
}

/**
 * Ordner-Projekt in den Arbeitsordner kopieren (`.zw1` bzw. `.elk` + `.edb`), damit EPLAN das Original nicht
 * verändert und der Worker keine Netzwerkrechte braucht. Liefert den Pfad der Kopie und die Zahl der Dateien.
 */
export async function copyProjectToWork(absolutePath: string, kind: FileKind, workDir: string, signal?: AbortSignal): Promise<{ projectPath: string, files: number }> {
  const target = join(workDir, basename(absolutePath))
  try {
    await copyFile(absolutePath, target)
    if (kind === 'zw1') return { projectPath: target, files: 1 }
    const edb = await findEdbPath(absolutePath)
    if (!edb) throw Object.assign(new Error(`.edb missing for ${basename(absolutePath)}`), { code: 'ENOENT' })
    signal?.throwIfAborted()
    // Kopie mit dem Namen der .elk-Datei, damit EPLAN die Datenbank zum Projekt findet
    const edbName = `${basename(absolutePath, extname(absolutePath))}.edb`
    await cp(edb, join(workDir, edbName), { recursive: true, errorOnExist: false, force: true })
    return { projectPath: target, files: 1 + await countFiles(join(workDir, edbName)) }
  }
  catch (error) {
    if (signal?.aborted) throw error
    const code = (error as { code?: unknown }).code
    throw new AnalysisError(code === 'ENOENT' ? 'project_file_missing' : 'copy_failed', errorText(error))
  }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name))
    else if (entry.isFile()) count++
  }
  return count
}
