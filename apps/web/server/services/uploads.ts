import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isUniqueViolation } from '@pds/core/database'
import { OPEN_ANALYSIS_STATUSES } from '../../shared/types/api'
import type { UploadResponse, Via } from '../../shared/types/api'
import type { Actor } from './access'
import { requireUser } from './access'
import { enqueueAnalysis, findAnalysis } from './analyses'
import { writeAudit } from './audit'
import type { AppContext } from './context'
import { ServiceError } from './errors'
import { findProject, uploadDir } from './projects'
import { loadSettings } from './settings'

/** Zeichen, die Windows in Dateinamen nicht erlaubt (plus Steuerzeichen) */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME = /[\\/:*?"<>|\u0000-\u001F]/

export interface UploadInput {
  /** Dateiname aus der Anfrage, z. B. `Anlage.zw1` */
  fileName: string
  /** Inhalt als Stream (Request-Body) – wird nie ganz in den Speicher gelesen */
  body: Readable | AsyncIterable<Uint8Array>
  /** Content-Length, falls bekannt: zu große Dateien früh ablehnen */
  contentLength?: number
}

/**
 * Dateiname prüfen: nur `.zw1` (400 `upload_invalid_type`), ein schlichter Name ohne Pfad und verbotene Zeichen
 * (400 `upload_invalid_name`). Liefert Name (ohne Endung) und den bereinigten Dateinamen.
 */
export function checkUploadName(fileName: string): { name: string, fileName: string } {
  const trimmed = (fileName ?? '').trim()
  if (extname(trimmed).toLowerCase() !== '.zw1') throw new ServiceError(400, 'upload_invalid_type')
  const name = basename(trimmed, extname(trimmed)).trim()
  if (!name || trimmed !== basename(trimmed) || FORBIDDEN_NAME.test(trimmed) || name.endsWith('.') || trimmed.length > 200)
    throw new ServiceError(400, 'upload_invalid_name')
  return { name, fileName: `${name}.zw1` }
}

/** Zählt die Bytes und bricht ab, sobald die Grenze überschritten ist */
function limitBytes(maxBytes: number) {
  let total = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) callback(new ServiceError(413, 'upload_too_large', { maxMb: Math.round(maxBytes / 1024 / 1024) }))
      else callback(null, chunk)
    },
  })
  return { stream, size: () => total }
}

/**
 * Projekt hochladen (alle Angemeldeten): Datei streamend nach `uploads/.incoming` schreiben (Grenze `uploadMaxMb`,
 * sonst 413 `upload_too_large`), dann nach `uploads/<projectId>/<uploadId>/<Name>.zw1` verschieben und einen Auftrag
 * `upload` einreihen. Gleicher Name ⇒ dasselbe Projekt mit neuem Stand. Wartet für das Projekt schon ein Auftrag ⇒
 * 409 `analysis_already_queued` (vor dem Schreiben geprüft und beim Einreihen per eindeutigem Index).
 */
export async function uploadProject(ctx: AppContext, actor: Actor, input: UploadInput, via: Via = 'ui'): Promise<UploadResponse> {
  requireUser(actor)
  const { name, fileName } = checkUploadName(input.fileName)
  const { settings } = await loadSettings(ctx)
  const maxBytes = settings.uploadMaxMb * 1024 * 1024
  if (input.contentLength !== undefined && input.contentLength > maxBytes)
    throw new ServiceError(413, 'upload_too_large', { maxMb: settings.uploadMaxMb })

  const pathKey = name.toLowerCase()
  const existing = await ctx.db.selectFrom('pds.projects').select('id').where('source', '=', 'upload').where('pathKey', '=', pathKey).executeTakeFirst()
  if (existing) {
    const open = await ctx.db.selectFrom('pds.analyses').select('id').where('projectId', '=', existing.id).where('status', 'in', [...OPEN_ANALYSIS_STATUSES]).executeTakeFirst()
    if (open) throw new ServiceError(409, 'analysis_already_queued', { analysisId: open.id })
  }

  // 1. Datei streamend in einen Zwischenordner
  const incoming = join(ctx.dataDir, 'uploads', '.incoming')
  await mkdir(incoming, { recursive: true })
  const temp = join(incoming, `${randomBytes(12).toString('hex')}.part`)
  const counter = limitBytes(maxBytes)
  try {
    const source = input.body instanceof Readable ? input.body : Readable.from(input.body)
    await pipeline(source, counter.stream, createWriteStream(temp, { flags: 'wx' }))
    if (counter.size() === 0) throw new ServiceError(400, 'upload_empty')
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }

  // 2. Projekt anlegen bzw. finden, Datei an ihren Platz
  const now = ctx.now()
  let finalDir: string | undefined
  try {
    const projectId = existing?.id ?? await createUploadProject(ctx, name, pathKey, actor.id, now)
    const uploadId = `${now.toISOString().replace(/\D/g, '').slice(0, 17)}-${randomBytes(3).toString('hex')}`
    finalDir = join(uploadDir(ctx.dataDir, projectId), uploadId)
    await mkdir(finalDir, { recursive: true })
    await rename(temp, join(finalDir, fileName))
    const uploadFile = `${uploadId}/${fileName}`

    // 3. Auftrag (409, wenn inzwischen einer wartet), dann das Projekt auf die neue Datei zeigen lassen
    const analysisId = await enqueueAnalysis(ctx.db, { projectId, trigger: 'upload', userId: actor.id, uploadFile, now })
    await ctx.db.updateTable('pds.projects').set({ uploadFile, name, sourceModified: now, updatedAt: now }).where('id', '=', projectId).execute()
    await writeAudit(ctx.db, actor.id, 'project_uploaded', { projectId, analysisId, fileName, size: counter.size(), via })
    ctx.queue.kick()
    const [project, analysis] = await Promise.all([findProject(ctx.db, projectId), findAnalysis(ctx.db, analysisId)])
    return { project: project!, analysis: analysis! }
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    if (finalDir) await rm(finalDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function createUploadProject(ctx: AppContext, name: string, pathKey: string, userId: string, now: Date): Promise<number> {
  try {
    const row = await ctx.db.insertInto('pds.projects')
      .values({ source: 'upload', name, path: null, pathKey, fileKind: 'zw1', createdAt: now, createdBy: userId, updatedAt: now })
      .output('inserted.id')
      .executeTakeFirstOrThrow()
    return row.id
  }
  catch (error) {
    // gleichzeitig mit gleichem Namen hochgeladen
    if (!isUniqueViolation(error)) throw error
    const row = await ctx.db.selectFrom('pds.projects').select('id').where('source', '=', 'upload').where('pathKey', '=', pathKey).executeTakeFirst()
    if (!row) throw error
    return row.id
  }
}
