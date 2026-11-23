import type { Kysely } from 'kysely'
import type { AppDatabase } from '../database/types'
import type { AuditAction, AuditEntry } from '../../shared/types/api'
import type { Actor } from './access'
import { requireAdmin } from './access'

/** Änderung protokollieren; details nie mit Geheimnissen */
export async function writeAudit(db: Kysely<AppDatabase>, userId: string | null, action: AuditAction, details: Record<string, unknown> = {}): Promise<void> {
  await db.insertInto('pds.audit').values({ userId, action, details: JSON.stringify(details) }).execute()
}

function parseDetails(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

/** Letzte Änderungen, neueste zuerst (nur Admins) */
export async function listAudit(db: Kysely<AppDatabase>, actor: Actor, limit = 20): Promise<AuditEntry[]> {
  requireAdmin(actor)
  const rows = await db.selectFrom('pds.audit as a')
    .leftJoin('core.users as u', 'u.id', 'a.userId')
    .select(['a.id', 'a.at', 'a.action', 'a.details', 'u.displayName'])
    .orderBy('a.id', 'desc')
    .top(Math.min(Math.max(limit, 1), 200))
    .execute()
  return rows.map(row => ({
    id: String(row.id),
    at: row.at.toISOString(),
    user: row.displayName,
    action: row.action,
    details: parseDetails(row.details),
  }))
}
