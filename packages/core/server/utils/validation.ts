import type { H3Event } from 'h3'
import { z } from 'zod'
import { isUniqueViolation } from '../database'

function toError(error: z.ZodError) {
  const message = error.issues[0]?.message
  return createError({
    statusCode: 400,
    // Eigene Fehlercodes (snake_case) aus .refine(…, { message }) durchreichen, sonst generisch
    message: message && /^[a-z_]+$/.test(message) ? message : 'invalid_input',
    data: { issues: error.issues.map(i => ({ path: i.path.join('.'), code: i.code })) },
  })
}

/** Liest den Request-Body und prüft ihn mit zod; Fehler → 400 mit Code */
export async function readValidated<T extends z.ZodType>(event: H3Event, schema: T): Promise<z.output<T>> {
  const result = schema.safeParse(await readBody(event))
  if (!result.success) throw toError(result.error)
  return result.data
}

export function queryValidated<T extends z.ZodType>(event: H3Event, schema: T): z.output<T> {
  const result = schema.safeParse(getQuery(event))
  if (!result.success) throw toError(result.error)
  return result.data
}

export function paramsValidated<T extends z.ZodType>(event: H3Event, schema: T): z.output<T> {
  const result = schema.safeParse(getRouterParams(event, { decode: true }))
  if (!result.success) throw toError(result.error)
  return result.data
}

/** Unique-Verletzung (SQL Server oder SQLite) → 409 mit Code */
export function rethrowUnique(error: unknown, code: string): never {
  if (isUniqueViolation(error)) throw createError({ statusCode: 409, message: code })
  throw error
}

// GUID im Format 8-4-4-4-12 (keine Versionsprüfung: SQL Server unter Windows erzeugt mit NEWSEQUENTIALID
// byte-vertauschte IDs, die z.uuid() ablehnen würde)
export const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid_id').transform(v => v.toLowerCase())
