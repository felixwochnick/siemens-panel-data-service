import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { coreMigrations, createDatabase, migrateDatabase, openSqliteFile, sqliteSql } from '@pds/core/database'
import { classifySqliteError, isNetworkPath } from '../src/sqlite'
import { ToolFailure } from '../src/protocol'
import { runTool, step } from './helpers'

// Ohne Docker: jede Prüfung in einem eigenen Temp-Ordner
const root = mkdtempSync(join(tmpdir(), 'pds-node-tools-sqlite-'))
let counter = 0
function tempDir(): string {
  const dir = join(root, String(++counter))
  mkdirSync(dir)
  return dir
}

afterAll(() => {
  // Schreibschutz der Tests aufheben, sonst lässt sich nicht aufräumen
  for (let index = 1; index <= counter; index++) {
    try {
      chmodSync(join(root, String(index)), 0o755)
    }
    catch { /* schon weg */ }
  }
  rmSync(root, { recursive: true, force: true })
})

/** Modus-Bits greifen nur unter POSIX und nicht für root; unter Windows gelten ACLs (chmod setzt nur das Schreibschutz-Attribut) */
const noModeBits = process.platform === 'win32' || process.getuid?.() === 0

/** Datei mit Tabelle und Zeilen, wie sie die App anlegt (WAL) */
function seed(path: string, statements: string[]): void {
  const db = openSqliteFile(path)
  try {
    for (const statement of statements) db.exec(statement)
  }
  finally {
    db.close()
  }
}

function count(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)
  }
  finally {
    db.close()
  }
}

describe('db-test mit SQLite', () => {
  // Nichts anlegen: Ein Ordner oder eine Datei des Werkzeugs (Administrator) bekäme nur geerbte Rechte statt der
  // strengen, die das Speichern der Konfiguration vergibt
  it('missing_file_is_not_created', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })

    expect(run.result).toMatchObject({
      ok: true,
      code: 'ok',
      message: `Die SQLite-Datenbank „${path}“ gibt es noch nicht; der Dienst legt sie bei seinem Start an.`,
      details: { path, warnings: [], exists: false, folderExists: true },
    })
    expect(run.exitCode).toBe(0)
    expect(run.steps.map(line => `${line.code}:${line.ok}`)).toEqual(['open:true', 'sqlite_version:true', 'migrations:true'])
    expect(step(run, 'open')).toMatchObject({ details: { path, exists: false, folderExists: true, created: false } })
    expect(step(run, 'open')?.message).toContain('Angelegt wurde nichts')
    expect(step(run, 'sqlite_version')?.details?.version).toMatch(/^3\.\d+\.\d+/)
    expect(step(run, 'migrations')).toMatchObject({ details: { core: 0, pds: 0 }, message: 'Noch keine Migrationen: Die App legt ihre Tabellen beim ersten Start an.' })
    expect(readdirSync(dir)).toEqual([])
    // Der Pfad ist kein Geheimnis und bleibt sichtbar
    expect(run.raw.join('\n')).not.toContain('***')
  })

  it('missing_folder_is_not_created', async () => {
    // Mit Leerzeichen im Namen wie unter ProgramData
    const dir = tempDir()
    const path = join(dir, 'EPLAN Panel Data Service', 'data', 'pds.db')
    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })

    expect(run.result).toMatchObject({ ok: true, code: 'ok', details: { path, exists: false, folderExists: false } })
    expect(run.result.message).toContain('ihr Ordner entsteht beim Speichern')
    expect(step(run, 'open')?.message).toContain('mit den richtigen Rechten')
    expect(readdirSync(dir)).toEqual([])
  })

  it('migrated_database_reports_counts', async () => {
    const path = join(tempDir(), 'pds.db')
    const db = createDatabase<unknown>(`sqlite:${path}`)
    try {
      await migrateDatabase(db, [
        coreMigrations,
        { schema: 'pds', mssql: {}, sqlite: { '0001_probe': sqliteSql('CREATE TABLE pds_probe (id integer PRIMARY KEY)') } },
      ])
    }
    finally {
      await db.destroy()
    }

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result).toMatchObject({ ok: true, code: 'ok', message: `Die SQLite-Datenbank „${path}“ funktioniert.`, details: { path, exists: true } })
    expect(run.steps.map(line => `${line.code}:${line.ok}`)).toEqual(['open:true', 'writable:true', 'sqlite_version:true', 'migrations:true'])
    expect(step(run, 'open')?.details).toMatchObject({ exists: true, created: false })
    expect(step(run, 'writable')?.details).toEqual({ journalMode: 'wal' })
    const core = Object.keys(coreMigrations.sqlite).length
    expect(step(run, 'migrations')).toMatchObject({ ok: true, details: { core, pds: 1 } })
    expect(step(run, 'migrations')?.message).toBe(`Migrationen ausgeführt: core ${core}, pds 1.`)
    // Keine Tabelle der .NET-Version
    expect(step(run, 'legacy')).toBeUndefined()
  })

  it('writable_check_leaves_no_trace', async () => {
    const path = join(tempDir(), 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)', 'PRAGMA user_version = 7'])
    const schemaVersion = () => {
      const db = new DatabaseSync(path)
      try {
        return db.prepare('SELECT * FROM pragma_schema_version, pragma_user_version').get()
      }
      finally {
        db.close()
      }
    }
    const before = schemaVersion()

    expect((await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })).result.ok).toBe(true)
    expect(schemaVersion()).toEqual(before)
  })

  it('finds_the_table_of_the_dotnet_version', async () => {
    const path = join(tempDir(), 'pds.db')
    seed(path, [
      'CREATE TABLE wiring_files (order_name text, file_name text, file_created text, file_updated text, file_uploaded text)',
      'INSERT INTO wiring_files (order_name, file_name) VALUES (\'A1\', \'a.zw1\'), (\'A2\', \'b.zw1\')',
    ])

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result.ok).toBe(true)
    expect(step(run, 'legacy')).toMatchObject({ ok: true, details: { rows: 2 } })
    expect(step(run, 'legacy')?.message).toContain('.NET-Version')
  })

  it.skipIf(noModeBits)('read_only_file', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    chmodSync(path, 0o444)

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result).toMatchObject({ ok: false, code: 'read_only' })
    expect(run.exitCode).toBe(3)
    // Öffnen gelingt (nur lesend), erst der Schreibversuch scheitert
    expect(step(run, 'open')?.ok).toBe(true)
    expect(step(run, 'writable')).toMatchObject({ ok: false, details: { error: 'read_only', path } })
    expect(run.result.message).toContain(path)
    expect(run.result.message).toContain('NT SERVICE\\pds')
  })

  it.skipIf(noModeBits)('read_only_folder', async () => {
    // Die Datei wäre beschreibbar, aber -wal und -shm lassen sich nicht anlegen
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    chmodSync(dir, 0o555)

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result.code).toBe('read_only')
    expect(run.steps.at(-1)).toMatchObject({ ok: false, details: { error: 'read_only' } })
    expect(run.result.message).toContain('„Ändern“')
  })

  it.skipIf(noModeBits)('folder_without_permission', async () => {
    // Nicht einmal nachsehen darf das Werkzeug
    const dir = tempDir()
    chmodSync(dir, 0o000)
    const path = join(dir, 'neu', 'pds.db')

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result).toMatchObject({ ok: false, code: 'cannot_open', details: { path, systemCode: 'EACCES' } })
    expect(run.result.message).toContain('Keine Berechtigung')
    expect(run.result.message).toContain('NT SERVICE\\pds')
  })

  it('cannot_open', async () => {
    const dir = tempDir()
    const file = join(dir, 'datei')
    writeFileSync(file, 'x')
    // Ein Teil des Pfads ist eine Datei; der Pfad ist ein Ordner
    for (const path of [join(file, 'pds.db'), join(file, 'sub', 'pds.db'), dir]) {
      const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
      expect(run.result.code, path).toBe('cannot_open')
      expect(run.exitCode).toBe(3)
      expect(run.steps).toEqual([expect.objectContaining({ code: 'open', ok: false, details: expect.objectContaining({ error: 'cannot_open', path }) })])
    }
  })

  it('locked_by_another_program', async () => {
    const path = join(tempDir(), 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    // Wie ein anderer Prozess, der schreibt und die Sperre hält (busy_timeout des Werkzeugs: 5 s)
    const other = new DatabaseSync(path)
    other.exec('BEGIN EXCLUSIVE')
    try {
      const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
      expect(run.result).toMatchObject({ ok: false, code: 'locked' })
      expect(run.exitCode).toBe(3)
      expect(step(run, 'writable')).toMatchObject({ ok: false, details: { error: 'locked', sqliteCode: 5 } })
      expect(run.result.message).toContain('.NET-Dienst')
    }
    finally {
      other.exec('ROLLBACK')
      other.close()
    }
  })

  it('not_a_database', async () => {
    const path = join(tempDir(), 'pds.db')
    writeFileSync(path, 'Das ist keine Datenbank. '.repeat(200))

    const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
    expect(run.result).toMatchObject({ ok: false, code: 'not_a_database' })
    expect(step(run, 'open')).toMatchObject({ ok: false, details: { error: 'not_a_database', sqliteCode: 26 } })
  })

  it('network_path', async () => {
    for (const path of ['\\\\server\\freigabe\\pds.db', '//server/freigabe/pds.db']) {
      const run = await runTool('db-test', { NUXT_DATABASE_URL: `sqlite:${path}` })
      expect(run.result, path).toMatchObject({ ok: false, code: 'network_path', details: { path } })
      expect(run.exitCode).toBe(3)
      expect(run.steps).toEqual([expect.objectContaining({ code: 'open', ok: false })])
      expect(run.result.message).toContain(path)
    }
    // Nichts angelegt (unter Linux wäre //server ein Ordner im Wurzelverzeichnis)
    expect(existsSync('/server')).toBe(false)
  })

  it('sqlite_without_path_is_invalid_url', async () => {
    for (const value of ['sqlite:', 'sqlite:   ']) {
      const run = await runTool('db-test', { NUXT_DATABASE_URL: value })
      expect(run.result.code, value).toBe('invalid_url')
      expect(run.result.message).toContain('NUXT_DATABASE_URL')
    }
  })
})

describe('db-setup mit SQLite', () => {
  it('is_not_needed', async () => {
    // Ohne die übrigen Variablen: Die Ablehnung kommt vor ihrer Prüfung
    const run = await runTool('db-setup', { PDS_ADMIN_DATABASE_URL: `sqlite:${join(tempDir(), 'pds.db')}` })
    expect(run.result).toMatchObject({
      ok: false,
      code: 'not_needed',
      message: 'Für SQLite ist keine Einrichtung nötig: Die Anwendung legt die Datenbankdatei beim ersten Start selbst an.',
    })
    expect(run.exitCode).toBe(3)
    expect(run.steps).toEqual([])
  })
})

describe('db-backup', () => {
  it('copies_a_database_in_use', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    const db = createDatabase<unknown>(`sqlite:${path}`)
    try {
      await migrateDatabase(db, [coreMigrations])
    }
    finally {
      await db.destroy()
    }
    seed(path, [
      'CREATE TABLE pds_probe (id integer PRIMARY KEY, name text)',
      'INSERT INTO pds_probe (name) VALUES (\'eins\'), (\'zwei\'), (\'drei\')',
    ])
    // Der Dienst läuft weiter: eine offene Verbindung mitten in einer Schreibtransaktion
    const service = openSqliteFile(path)
    service.exec('BEGIN IMMEDIATE')
    service.exec('INSERT INTO pds_probe (name) VALUES (\'noch nicht festgeschrieben\')')
    const file = join(dir, 'sicherung', 'pds-2026-11-23.db')
    mkdirSync(join(dir, 'sicherung'))
    try {
      const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: file })

      expect(run.result).toMatchObject({ ok: true, code: 'ok', details: { file } })
      expect(run.exitCode).toBe(0)
      expect(run.steps.map(line => `${line.code}:${line.ok}`)).toEqual(['open:true', 'backup:true', 'verify:true'])
      expect(step(run, 'open')?.details).toEqual({ path })
      expect(step(run, 'backup')?.details?.pages).toBeGreaterThan(1)
      expect(run.result.details?.bytes).toBe(statSync(file).size)
      expect(run.result.message).toContain(file)
    }
    finally {
      service.exec('ROLLBACK')
      service.close()
    }

    // Die Kopie hat den festgeschriebenen Stand und ist eine einzelne Datei (ohne WAL)
    expect(count(file, 'pds_probe')).toBe(3)
    expect(count(file, 'core_migrations')).toBe(Object.keys(coreMigrations.sqlite).length)
    expect(existsSync(`${file}-wal`)).toBe(false)
    const copy = new DatabaseSync(file, { readOnly: true })
    try {
      expect(copy.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    }
    finally {
      copy.close()
    }
    // Die Quelle bleibt im WAL-Modus
    expect(count(path, 'pds_probe')).toBe(3)
  })

  it.skipIf(process.platform === 'win32')('refuses_a_dangling_link_as_target', async () => {
    // Ein Verweis, dessen Ziel fehlt: existsSync sähe nichts, die Sicherung schriebe sonst an sein Ziel
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    const elsewhere = join(dir, 'woanders.db')
    const file = join(dir, 'kopie.db')
    symlinkSync(elsewhere, file)

    const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: file })
    expect(run.result).toMatchObject({ ok: false, code: 'target_exists', details: { file } })
    expect(existsSync(elsewhere)).toBe(false)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('refuses_an_existing_target', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    const file = join(dir, 'alt.db')
    writeFileSync(file, 'alte Sicherung')

    const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: file })
    expect(run.result).toMatchObject({ ok: false, code: 'target_exists', details: { file } })
    expect(run.exitCode).toBe(3)
    expect(step(run, 'backup')).toMatchObject({ ok: false, details: { error: 'target_exists' } })
    expect(readFileSync(file, 'utf8')).toBe('alte Sicherung')
    // Auch die Quelle selbst ist ein vorhandenes Ziel
    expect((await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: path })).result.code).toBe('target_exists')
  })

  it('target_folder_must_exist', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    const file = join(dir, 'fehlt', 'pds.db')

    const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: file })
    expect(run.result).toMatchObject({ ok: false, code: 'cannot_open' })
    expect(run.result.message).toContain(join(dir, 'fehlt'))
    expect(existsSync(join(dir, 'fehlt'))).toBe(false)
  })

  it('source_must_exist', async () => {
    const dir = tempDir()
    const path = join(dir, 'gibt-es-nicht.db')

    const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: join(dir, 'kopie.db') })
    expect(run.result).toMatchObject({ ok: false, code: 'not_found', details: { path } })
    expect(run.exitCode).toBe(3)
    expect(run.steps).toEqual([expect.objectContaining({ code: 'open', ok: false, details: expect.objectContaining({ error: 'not_found' }) })])
    // Weder Quelle noch Kopie angelegt
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, 'kopie.db'))).toBe(false)
  })

  it('removes_a_copy_that_fails_verification', async () => {
    const dir = tempDir()
    const path = join(dir, 'pds.db')
    // Ohne WAL, damit alle Seiten in der Datei selbst stehen
    seed(path, ['PRAGMA journal_mode = DELETE', 'CREATE TABLE pds_probe (id integer PRIMARY KEY, name text)'])
    const filler = new DatabaseSync(path)
    try {
      // Eine Transaktion statt 200: Jede einzelne wartet auf fsync, auf einer belasteten Platte minutenlang
      filler.exec('BEGIN')
      const insert = filler.prepare('INSERT INTO pds_probe (name) VALUES (?)')
      for (let index = 0; index < 200; index++) insert.run('x'.repeat(500))
      filler.exec('COMMIT')
    }
    finally {
      filler.close()
    }
    // Eine Seite mitten in der Tabelle zerstören: Die Backup-API kopiert sie unbesehen, die Prüfung fällt durch
    const bytes = readFileSync(path)
    bytes.fill(0xFF, 4096 * 3, 4096 * 3 + 200)
    writeFileSync(path, bytes)
    const file = join(dir, 'kopie.db')

    const run = await runTool('db-backup', { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: file })
    expect(run.result).toMatchObject({ ok: false, code: 'corrupt' })
    expect(step(run, 'backup')?.ok).toBe(true)
    expect(step(run, 'verify')).toMatchObject({ ok: false, details: { error: 'corrupt' } })
    expect(existsSync(file)).toBe(false)
  })

  it('is_not_supported_for_sql_server', async () => {
    const run = await runTool('db-backup', { NUXT_DATABASE_URL: 'mssql://sa:Geheim-1A@localhost:1433/pds' })
    expect(run.result).toMatchObject({ ok: false, code: 'not_supported' })
    expect(run.result.message).toContain('BACKUP DATABASE')
    expect(run.exitCode).toBe(3)
    expect(run.raw.join('\n')).not.toContain('Geheim-1A')
  })

  it('needs_an_absolute_target', async () => {
    const path = join(tempDir(), 'pds.db')
    seed(path, ['CREATE TABLE pds_probe (id integer PRIMARY KEY)'])
    const envs: Array<Record<string, string>> = [{ NUXT_DATABASE_URL: `sqlite:${path}` }, { NUXT_DATABASE_URL: `sqlite:${path}`, PDS_BACKUP_FILE: 'kopie.db' }]
    for (const env of envs) {
      const run = await runTool('db-backup', env)
      expect(run.result.code).toBe('internal_error')
      expect(run.result.message).toContain('PDS_BACKUP_FILE')
      expect(run.exitCode).toBe(1)
    }
  })
})

describe('classifySqliteError', () => {
  const sqliteError = (errcode: number, errstr = 'Fehler') => Object.assign(new Error(errstr), { code: 'ERR_SQLITE_ERROR', errcode, errstr })
  const systemError = (code: string) => Object.assign(new Error(`${code}: x`), { code })
  const classify = (error: unknown) => classifySqliteError(error, 'C:\\Daten\\pds.db')

  it('maps_sqlite_result_codes_including_extended_ones', () => {
    const cases: Array<[number, string]> = [
      [14, 'cannot_open'], [3, 'cannot_open'],
      [8, 'read_only'], [1544, 'read_only'], [264, 'read_only'],
      [5, 'locked'], [517, 'locked'], [6, 'locked'],
      [26, 'not_a_database'], [11, 'corrupt'], [13, 'disk_full'], [10, 'io_error'], [3338, 'io_error'],
      [1, 'internal_error'], [19, 'internal_error'],
    ]
    for (const [errcode, code] of cases) expect(classify(sqliteError(errcode)).code, String(errcode)).toBe(code)
    expect(classify(sqliteError(5, 'database is locked')).details).toEqual({ path: 'C:\\Daten\\pds.db', sqliteCode: 5, sqliteMessage: 'database is locked' })
  })

  it('maps_file_system_errors', () => {
    const cases: Array<[string, string]> = [
      ['EACCES', 'cannot_open'], ['EPERM', 'cannot_open'], ['ENOENT', 'cannot_open'], ['ENOTDIR', 'cannot_open'],
      ['EISDIR', 'cannot_open'], ['EEXIST', 'cannot_open'], ['EROFS', 'read_only'], ['EBUSY', 'locked'],
      ['ENOSPC', 'disk_full'], ['EIO', 'io_error'], ['EMFILE', 'internal_error'],
    ]
    for (const [systemCode, code] of cases) expect(classify(systemError(systemCode)).code, systemCode).toBe(code)
    expect(classify(systemError('EACCES')).details).toEqual({ path: 'C:\\Daten\\pds.db', systemCode: 'EACCES' })
  })

  it('names_the_path_and_hints_at_the_service_account', () => {
    for (const error of [sqliteError(14), sqliteError(8), systemError('EACCES')]) {
      const failure = classify(error)
      expect(failure.message).toContain('„C:\\Daten\\pds.db“')
      expect(failure.message).toContain('NT SERVICE\\pds')
      expect(failure.message).toContain('„Ändern“')
    }
    expect(classify(systemError('EPERM')).message).toContain('Keine Berechtigung')
    // Ohne Hinweis (Zieldatei einer Sicherung)
    expect(classifySqliteError(sqliteError(14), 'x.db', { serviceHint: false }).message).not.toContain('NT SERVICE')
    expect(classify(sqliteError(5)).message).toContain('.NET-Dienst')
  })

  it('passes_tool_failures_and_wraps_the_rest', () => {
    const failure = new ToolFailure('network_path', 'x')
    expect(classify(failure)).toBe(failure)
    expect(classify('kaputt').code).toBe('internal_error')
    expect(classify(new Error('kaputt'))).toMatchObject({ code: 'internal_error', message: 'Unerwarteter Fehler bei der Datenbank „C:\\Daten\\pds.db“: kaputt' })
    // Ein anderer Node-Fehler mit errcode ist kein SQLite-Fehler
    expect(classify(Object.assign(new Error('x'), { code: 'ERR_INVALID_STATE', errcode: 5 })).code).toBe('internal_error')
  })
})

describe('isNetworkPath', () => {
  it('detects_unc_paths', () => {
    for (const path of ['\\\\server\\share\\pds.db', '//server/share/pds.db', '\\\\?\\UNC\\server\\share\\pds.db', '/\\server\\x']) expect(isNetworkPath(path), path).toBe(true)
    // Lange Pfade auf ein lokales Laufwerk (\\?\C:\…) sind lokal
    for (const path of ['C:\\ProgramData\\EPLAN Panel Data Service\\data\\pds.db', '\\\\?\\C:\\Daten\\pds.db', '\\\\.\\D:\\pds.db', '/var/lib/pds.db', 'pds.db', '\\pds.db']) {
      expect(isNetworkPath(path), path).toBe(false)
    }
  })
})
