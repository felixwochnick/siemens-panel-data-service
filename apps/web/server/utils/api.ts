import type { H3Event } from 'h3'
import { z } from 'zod'
import { ANALYSIS_STATUSES, ANALYSIS_TRIGGERS, EPLAN_OPEN_MODES, LOG_LEVELS, PROJECT_SOURCES } from '../../shared/types/api'
import { LIMITS } from '../lib/settings'
import type { Actor } from '../services/access'
import type { AppContext } from '../services/context'
import { ServiceError } from '../services/errors'
import { PROJECT_SORTS } from '../services/projects'

type Handler<T> = (event: H3Event, actor: Actor, ctx: AppContext) => Promise<T> | T

function wrap<T>(admin: boolean, handler: Handler<T>) {
  return defineEventHandler(async (event) => {
    const user = await requireAuth(event, { admin })
    try {
      return await handler(event, { id: user.id, isAdmin: user.isAdmin }, await useAppContext())
    }
    catch (error) {
      // Fachliche Fehler (ServiceError) werden zu HTTP-Fehlern mit Code (errors.<code>)
      if (error instanceof ServiceError) throw createError({ statusCode: error.statusCode, message: error.message, data: error.data })
      throw error
    }
  })
}

/**
 * API-Handler für alle Angemeldeten (Rechte frisch aus der Datenbank); liefert den Kontext der Services und macht aus
 * fachlichen Fehlern HTTP-Fehler mit Code
 */
export const defineApiHandler = <T>(handler: Handler<T>) => wrap(false, handler)

/** Wie defineApiHandler, verlangt aber die Admin-Rolle (Einstellungen, Protokolle, Zeitplan, Löschen) */
export const defineAdminHandler = <T>(handler: Handler<T>) => wrap(true, handler)

const text = (max: number) => z.string().max(max)
const id = z.coerce.number().int().min(1).max(2_147_483_647)
const page = z.coerce.number().int().min(1).max(100_000).optional()
const pageSize = (max: number) => z.coerce.number().int().min(1).max(max).optional()
const optionalText = (max: number) => z.string().trim().max(max).optional().transform(v => v || undefined)
const int = (limits: { min: number, max: number }) => z.number().int().min(limits.min).max(limits.max)

export const schemas = {
  settings: z.object({
    folder: text(1000),
    source: z.enum(['local', 'network']),
    networkDrive: z.object({
      mapping: text(10),
      networkPath: text(1000),
      user: text(320),
      password: z.union([z.string().max(500), z.null()]).optional(),
    }),
    recursive: z.boolean(),
    filePatterns: z.array(text(100)).max(LIMITS.filePatterns.max),
    eplan: z.object({
      platformBin: text(1000),
      productBin: text(1000),
      applicationModifier: text(200),
      openMode: z.enum(EPLAN_OPEN_MODES),
    }),
    schedulerEnabled: z.boolean(),
    cronSchedule: text(200),
    timezone: text(100),
    analysisTimeoutMinutes: int(LIMITS.analysisTimeoutMinutes),
    retentionDays: int(LIMITS.retentionDays),
    uploadMaxMb: int(LIMITS.uploadMaxMb),
  }),
  scheduler: z.object({ enabled: z.boolean() }),
  cronPreview: z.object({ cron: text(200), timezone: text(100), count: z.coerce.number().int().min(1).max(20).optional() }),
  idParams: z.object({ id }),
  projects: z.object({
    search: optionalText(200),
    source: z.enum(PROJECT_SOURCES).optional(),
    sort: z.enum(PROJECT_SORTS).optional(),
    page,
    pageSize: pageSize(200),
  }),
  // ?name=Anlage.zw1 – der Body ist die Datei selbst
  upload: z.object({ name: z.string().trim().min(1, 'upload_invalid_name').max(255, 'upload_invalid_name') }),
  analyses: z.object({
    projectId: id.optional(),
    status: z.enum(ANALYSIS_STATUSES).optional(),
    trigger: z.enum(ANALYSIS_TRIGGERS).optional(),
    page,
    pageSize: pageSize(200),
  }),
  startAnalysis: z.union([
    z.object({ projectId: z.number().int().min(1) }).strict(),
    z.object({ folderPaths: z.array(z.string().trim().min(1).max(1000)).min(1).max(500) }).strict(),
  ]),
  events: z.object({
    level: z.enum(LOG_LEVELS).optional(),
    offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
    limit: pageSize(5000),
  }),
  logTail: z.object({
    name: z.string().min(1).max(255),
    lines: z.coerce.number().int().min(1).max(2000).optional(),
    filter: optionalText(200),
  }),
  logFile: z.object({ name: z.string().min(1).max(255) }),
}
