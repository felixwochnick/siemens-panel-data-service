import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreDatabase } from '../server/database'
import { claimValues, displayNameOf, emailOf, isAdminFromClaims, provisionUser, splitList, subjectOf } from '../server/utils/provision'
import { createTestDatabase, TEST_DIALECT } from './helpers/test-db'
import type { TestDatabase } from './helpers/test-db'

const options = { issuer: 'https://login.microsoftonline.com/tenant/v2.0', rolesClaim: 'roles', adminRoles: ['Admin'] }

describe('Claims', () => {
  it('bevorzugt die Entra-Objekt-ID (oid) vor sub', () => {
    expect(subjectOf({ sub: 'pairwise', oid: 'object-id' })).toBe('object-id')
    expect(subjectOf({ sub: 'dex-sub' })).toBe('dex-sub')
    expect(() => subjectOf({})).toThrow()
  })

  it('findet die E-Mail in email, preferred_username oder upn', () => {
    expect(emailOf({ email: 'A@Siemens.com' })).toBe('a@siemens.com')
    expect(emailOf({ preferred_username: 'b@siemens.com' })).toBe('b@siemens.com')
    expect(emailOf({ preferred_username: 'kein-mail', upn: 'c@siemens.com' })).toBe('c@siemens.com')
    expect(emailOf({ preferred_username: 'kein-mail' })).toBeNull()
  })

  it('bildet einen Anzeigenamen mit Rückfallebenen', () => {
    expect(displayNameOf({ sub: 'x', name: ' Max Muster ' })).toBe('Max Muster')
    expect(displayNameOf({ sub: 'x', given_name: 'Max', family_name: 'Muster' })).toBe('Max Muster')
    expect(displayNameOf({ sub: 'x', email: 'max@siemens.com' })).toBe('max@siemens.com')
    expect(displayNameOf({ sub: 'x' })).toBe('x')
  })

  it('erkennt Admin-Rollen aus Arrays und Strings', () => {
    expect(claimValues(['Admin', 1, 'User'])).toEqual(['Admin', 'User'])
    expect(claimValues('a, b c')).toEqual(['a', 'b', 'c'])
    expect(claimValues(undefined)).toEqual([])
    expect(splitList(' Admin , Planer,, ')).toEqual(['Admin', 'Planer'])
    expect(isAdminFromClaims({ roles: ['Admin'] }, options)).toBe(true)
    expect(isAdminFromClaims({ roles: ['admin'] }, options)).toBe(false)
    expect(isAdminFromClaims({ groups: ['Admin'] }, options)).toBe(false)
  })
})

describe(`provisionUser (${TEST_DIALECT})`, () => {
  let t: TestDatabase<CoreDatabase>
  beforeAll(async () => {
    t = await createTestDatabase<CoreDatabase>('core_provision')
  })
  afterAll(() => t?.destroy())

  it('legt Benutzer beim ersten Login an und aktualisiert sie danach', async () => {
    const id = await provisionUser(t.db, { oid: 'u1', name: 'Erika', email: 'erika@siemens.com', roles: ['Admin'] }, options)
    const again = await provisionUser(t.db, { oid: 'u1', name: 'Erika Mustermann', email: 'erika@siemens.com', roles: [] }, options)
    expect(again).toBe(id)
    const row = await t.db.selectFrom('core.users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.displayName).toBe('Erika Mustermann')
    expect(row.isAdmin).toBe(false)
    expect(row.lastLoginAt).toBeInstanceOf(Date)
  })

  it('verknüpft nie über die E-Mail – gleiche E-Mail, anderes Subject ergibt neues Konto', async () => {
    const a = await provisionUser(t.db, { oid: 'u2', email: 'same@siemens.com' }, options)
    const b = await provisionUser(t.db, { oid: 'u3', email: 'same@siemens.com' }, options)
    expect(a).not.toBe(b)
  })

  it('trennt gleiche Subjects verschiedener Issuer', async () => {
    const a = await provisionUser(t.db, { sub: 'shared' }, options)
    const b = await provisionUser(t.db, { sub: 'shared' }, { ...options, issuer: 'http://localhost:5556/dex' })
    expect(a).not.toBe(b)
  })
})
