import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@pds/core/testing'
import type { AppDatabase } from '../server/database/types'
import { defaultSettings, isValidPattern, patternToRegExp, validateSettings } from '../server/lib/settings'
import type { Actor } from '../server/services/access'
import { listAudit } from '../server/services/audit'
import { getSettings, loadSettings, normalizeSettings, patchSettings, saveSettings, setSchedulerEnabled } from '../server/services/settings'
import { createAppTestDatabase, createTestContext, createUser, settingsInput } from './helpers/db'
import type { TestContext } from './helpers/db'

let t: TestDatabase<AppDatabase>
let admin: Actor
let member: Actor
let ctx: TestContext

const DRIVE = { networkPath: '\\\\fileserver\\eplan', user: 'DOMAIN\\svc', mapping: 'P' }

beforeAll(async () => {
  t = await createAppTestDatabase('settings')
  admin = await createUser(t.db, { isAdmin: true, name: 'Ada Admin' })
  member = await createUser(t.db, { name: 'Max Mitarbeiter' })
})
beforeEach(async () => {
  await t.db.deleteFrom('pds.settings').execute()
  await t.db.deleteFrom('pds.audit').execute()
  ctx = await createTestContext(t.db)
})
afterEach(async () => {
  await ctx.cleanup()
})
afterAll(async () => {
  await t?.destroy()
})

describe('Prüfung (lib/settings)', () => {
  it('Standardwerte sind gültig, Zeitplan aus, Pfade wie bisher', () => {
    expect(validateSettings(defaultSettings, { forRun: true })).toEqual([])
    expect(defaultSettings).toMatchObject({
      schedulerEnabled: false,
      cronSchedule: '0 0 2 * * ?',
      filePatterns: ['*.elk', '*.zw1'],
      recursive: true,
      analysisTimeoutMinutes: 60,
      retentionDays: 180,
      uploadMaxMb: 500,
      eplan: { openMode: 'ReadOnly', platformBin: 'C:\\Program Files\\EPLAN\\Platform\\2025.0.3\\Bin' },
    })
  })

  it('liefert Issue-Codes je Feld', () => {
    const s = structuredClone(defaultSettings)
    Object.assign(s, { cronSchedule: 'bogus', timezone: 'Mars/Phobos', filePatterns: ['*.elk', 'a/b'], retentionDays: 0, uploadMaxMb: 1.5, source: 'network' })
    s.networkDrive = { mapping: 'PQ', networkPath: 'C:\\lokal', user: '', password: 'x' }
    s.eplan.openMode = 'Kaputt' as never
    expect(validateSettings(s)).toEqual(expect.arrayContaining([
      { path: 'cronSchedule', code: 'invalid_cron' },
      { path: 'timezone', code: 'invalid_timezone' },
      { path: 'filePatterns', code: 'invalid_pattern' },
      { path: 'networkDrive.networkPath', code: 'invalid_network_path' },
      { path: 'networkDrive.mapping', code: 'invalid_drive_letter' },
      { path: 'networkDrive.user', code: 'required' },
      { path: 'eplan.openMode', code: 'invalid_value' },
      { path: 'retentionDays', code: 'out_of_range' },
      { path: 'uploadMaxMb', code: 'out_of_range' },
    ]))
    const forRun = structuredClone(defaultSettings)
    forRun.eplan.platformBin = ' '
    Object.assign(forRun, { source: 'network', networkDrive: { ...DRIVE, password: '' } })
    expect(validateSettings(forRun, { forRun: true })).toEqual(expect.arrayContaining([
      { path: 'eplan.platformBin', code: 'required' },
      { path: 'networkDrive.password', code: 'required' },
    ]))
  })

  it('Dateimuster: * und ?, ohne Groß-/Kleinschreibung, nur Namen', () => {
    expect(patternToRegExp('*.elk').test('Anlage.ELK')).toBe(true)
    expect(patternToRegExp('A?.zw1').test('ab.zw1')).toBe(true)
    expect(patternToRegExp('A?.zw1').test('abc.zw1')).toBe(false)
    expect(patternToRegExp('[x].elk').test('[x].elk')).toBe(true)
    expect(isValidPattern('sub/*.elk')).toBe(false)
    expect(isValidPattern(' ')).toBe(false)
  })

  it('normalizeSettings übernimmt nur bekannte Schlüssel mit passendem Typ', () => {
    const n = normalizeSettings({ folder: 3, recursive: false, filePatterns: ['*.zw1', 7], extra: 1, eplan: { openMode: 'Standard', platformBin: null } })
    expect(n.folder).toBe('')
    expect(n.recursive).toBe(false)
    expect(n.filePatterns).toEqual(['*.elk', '*.zw1'])
    expect(n.eplan).toMatchObject({ openMode: 'Standard', platformBin: defaultSettings.eplan.platformBin })
    expect(n).not.toHaveProperty('extra')
  })
})

describe('Einstellungen (Dienst)', () => {
  it('liefert Standardwerte, solange nichts gespeichert ist', async () => {
    const result = await getSettings(ctx, admin)
    expect(result).toMatchObject({ saved: false, updatedBy: null, issues: [] })
    expect(result.settings.networkDrive.password).toEqual({ set: false, readable: true })
  })

  it('speichert das Netzlaufwerk-Passwort verschlüsselt und zeigt es nur als { set, readable }', async () => {
    const saved = await saveSettings(ctx, admin, settingsInput({ folder: 'P:\\Projekte', source: 'network', networkDrive: { ...DRIVE, password: 'Geheim-1' } }))
    expect(saved.changed).toEqual(expect.arrayContaining(['folder', 'source', 'networkDrive.networkPath', 'networkDrive.password']))
    expect(saved.settings.networkDrive.password).toEqual({ set: true, readable: true })
    expect(JSON.stringify(saved)).not.toContain('Geheim-1')

    const row = await t.db.selectFrom('pds.settings').select('data').executeTakeFirstOrThrow()
    expect(row.data).not.toContain('Geheim-1')
    expect(JSON.parse(row.data).networkDrive.password).toMatch(/^enc:v1:/)
    expect((await loadSettings(ctx)).settings.networkDrive.password).toBe('Geheim-1')

    // Audit ohne Geheimnis
    const audit = await listAudit(t.db, admin)
    expect(audit[0]).toMatchObject({ action: 'settings_updated', user: 'Ada Admin' })
    expect(JSON.stringify(audit)).not.toContain('Geheim-1')
  })

  it('leeres Passwort = unverändert, null = entfernen', async () => {
    await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, password: 'Geheim-1' } }))
    await saveSettings(ctx, admin, settingsInput({ source: 'network', folder: 'neu', networkDrive: { ...DRIVE, password: '' } }))
    expect((await loadSettings(ctx)).settings.networkDrive.password).toBe('Geheim-1')
    const removed = await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, password: null } }))
    expect(removed.settings.networkDrive.password).toEqual({ set: false, readable: true })
    expect(removed.changed).toContain('networkDrive.password')
  })

  it('„unverändert“ gilt nur bei gleicher Freigabe und gleichem Benutzer (sonst secret_required)', async () => {
    await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, password: 'Geheim-1' } }))
    // Schreibweise egal
    await expect(saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, networkPath: '\\\\FILESERVER\\eplan\\', user: 'domain\\SVC' } }))).resolves.toBeDefined()
    const error = await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, networkPath: '\\\\fremd\\eplan' } })).catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 400, message: 'secret_required', data: { fields: ['networkDrive.password'] } })
    // mit neuem Passwort geht es
    await expect(saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, networkPath: '\\\\fremd\\eplan', password: 'Neu-2' } }))).resolves.toBeDefined()
    expect((await loadSettings(ctx)).settings.networkDrive.password).toBe('Neu-2')
  })

  it('ungültige Werte ⇒ 400 invalid_settings mit Issues; nichts gespeichert', async () => {
    const error = await saveSettings(ctx, admin, settingsInput({ cronSchedule: 'bogus' })).catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 400, message: 'invalid_settings', data: { issues: [{ path: 'cronSchedule', code: 'invalid_cron' }] } })
    expect((await getSettings(ctx, admin)).saved).toBe(false)
  })

  it('nicht lesbares Passwort (anderer Schlüssel) ⇒ readable false und Hinweis secret_unreadable', async () => {
    await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, password: 'Geheim-1' } }))
    const other = await createTestContext(t.db, { secretKey: randomBytes(32) })
    try {
      const result = await getSettings(other, admin)
      expect(result.settings.networkDrive.password).toEqual({ set: true, readable: false })
      expect(result.issues).toContainEqual({ path: 'networkDrive.password', code: 'secret_unreadable' })
    }
    finally {
      await other.cleanup()
    }
  })

  it('Zeitplan einschalten nur mit Projektordner und vollständigen Einstellungen', async () => {
    const error = await setSchedulerEnabled(ctx, admin, true).catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 400, message: 'settings_incomplete', data: { issues: [{ path: 'folder', code: 'required' }] } })
    await saveSettings(ctx, admin, settingsInput({ folder: '/srv/eplan' }))
    const result = await setSchedulerEnabled(ctx, admin, true, 'mcp')
    expect(result.settings.schedulerEnabled).toBe(true)
    expect((await listAudit(t.db, admin))[0]).toMatchObject({ action: 'scheduler_toggled', details: { enabled: true, via: 'mcp' } })
  })

  it('patchSettings (MCP) ändert Teile und kann kein Passwort setzen', async () => {
    await saveSettings(ctx, admin, settingsInput({ source: 'network', networkDrive: { ...DRIVE, password: 'Geheim-1' } }))
    const result = await patchSettings(ctx, admin, { retentionDays: 30, eplan: { openMode: 'Standard' } })
    expect(result.changed).toEqual(expect.arrayContaining(['retentionDays', 'eplan.openMode']))
    expect((await loadSettings(ctx)).settings.networkDrive.password).toBe('Geheim-1')
    // Freigabe ändern ohne Passwort ⇒ secret_required mit Erklärung für das Modell
    const error = await patchSettings(ctx, admin, { networkDrive: { networkPath: '\\\\fremd\\x' } }).catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'secret_required', data: { details: expect.stringContaining('cannot be set via MCP') } })
  })

  it('Nicht-Admins dürfen Einstellungen weder lesen noch ändern', async () => {
    await expect(getSettings(ctx, member)).rejects.toMatchObject({ statusCode: 403, message: 'forbidden' })
    await expect(saveSettings(ctx, member, settingsInput())).rejects.toMatchObject({ statusCode: 403 })
    await expect(patchSettings(ctx, member, { retentionDays: 3 })).rejects.toMatchObject({ statusCode: 403 })
    await expect(setSchedulerEnabled(ctx, member, false)).rejects.toMatchObject({ statusCode: 403 })
  })
})
