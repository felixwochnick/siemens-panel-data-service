import type { Kysely } from 'kysely'
import type { CoreDatabase } from '../database'

export type Claims = Record<string, unknown>

export interface ProvisionOptions {
  issuer: string
  rolesClaim: string
  adminRoles: string[]
}

/** Claim-Wert als Liste von Strings (Entra liefert Arrays, manche IdPs einen kommagetrennten String) */
export function claimValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean)
  return []
}

export function splitList(value: string): string[] {
  return value.split(',').map(v => v.trim()).filter(Boolean)
}

/** Stabile Identität: Entra liefert die Objekt-ID in `oid` (gleich für alle Apps des Tenants), sonst `sub` */
export function subjectOf(claims: Claims): string {
  const subject = typeof claims.oid === 'string' && claims.oid ? claims.oid : claims.sub
  if (typeof subject !== 'string' || !subject) throw new Error('Token enthält weder oid noch sub')
  return subject
}

export function emailOf(claims: Claims): string | null {
  for (const key of ['email', 'preferred_username', 'upn']) {
    const value = claims[key]
    if (typeof value === 'string' && value.includes('@')) return value.toLowerCase().slice(0, 320)
  }
  return null
}

export function displayNameOf(claims: Claims): string {
  const str = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string).trim() : '')
  const name = str('name')
    || [str('given_name'), str('family_name')].filter(Boolean).join(' ')
    || str('preferred_username')
    || emailOf(claims)
    || subjectOf(claims)
  return name.slice(0, 200)
}

export function isAdminFromClaims(claims: Claims, options: Pick<ProvisionOptions, 'rolesClaim' | 'adminRoles'>): boolean {
  const roles = claimValues(claims[options.rolesClaim])
  return roles.some(role => options.adminRoles.includes(role))
}

/**
 * Legt den Benutzer beim ersten Login an bzw. aktualisiert Name, E-Mail und Admin-Status.
 * Erkannt wird ausschließlich über Issuer + Subject – nie über die E-Mail.
 */
export async function provisionUser(db: Kysely<CoreDatabase>, claims: Claims, options: ProvisionOptions): Promise<string> {
  const subject = subjectOf(claims)
  const values = {
    email: emailOf(claims),
    displayName: displayNameOf(claims),
    isAdmin: isAdminFromClaims(claims, options),
    lastLoginAt: new Date(),
  }

  return db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('core.users')
      .select('id')
      .where('issuer', '=', options.issuer)
      .where('subject', '=', subject)
      .executeTakeFirst()
    if (existing) {
      await trx.updateTable('core.users').set(values).where('id', '=', existing.id).execute()
      return existing.id
    }
    const created = await trx.insertInto('core.users')
      .values({ issuer: options.issuer, subject, ...values })
      .output('inserted.id')
      .executeTakeFirstOrThrow()
    return created.id
  })
}
