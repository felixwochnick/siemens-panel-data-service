// SQLite-Zweig der Datenbankbefehle: db-test mit `sqlite:<pfad>` und db-backup (Sicherung im laufenden Betrieb).
// db-test legt nie etwas an: Es läuft als Administrator, und ein Ordner oder eine Datei, die es anlegte, bekäme die
// geerbten (womöglich zu weiten) Rechte statt der strengen, die das Speichern der Konfiguration vergibt. Eine
// vorhandene Datei öffnet es wie die App (WAL, busy_timeout 5 s, Fremdschlüssel), damit die Prüfung dieselben Dateien
// (-wal, -shm) und Sperren berührt wie der Dienst.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, rmSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { parseSqliteUrl } from '@pds/core/database'
import { MIGRATION_SCHEMAS, migrationsMessage, warningsSuffix } from './db-messages'
import type { MigrationCounts } from './db-messages'
import { errorMessage } from './network'
import { ToolFailure, UsageError, requireEnv, runStep } from './protocol'
import type { Details, ErrorCode, Outcome, Reporter } from './protocol'

/** Wie lange ein Zugriff auf eine gesperrte Datei wartet (wie openSqliteFile) */
const BUSY_TIMEOUT_MS = 5_000

/**
 * Seiten je Schritt der Sicherung: alle auf einmal. So entsteht die Kopie in einer einzigen Lesetransaktion und ist
 * ein stimmiger Stand; in kleinen Schritten finge SQLite bei jedem Schreibvorgang des Dienstes von vorn an (bei
 * regem Betrieb womöglich endlos). Im WAL-Modus blockiert das Lesen den Dienst dabei nicht.
 */
const ALL_PAGES = 0x7FFFFFFF

/** Rechteprobleme: SQLite legt neben der Datenbank -wal und -shm an, dafür braucht der Dienst den Ordner */
const SERVICE_ACCOUNT_HINT = 'Das Dienstkonto NT SERVICE\\pds braucht das Recht „Ändern“ auf dem Ordner der Datenbank, weil SQLite daneben die Dateien „-wal“ und „-shm“ anlegt.'

/** Primäre Ergebniscodes von SQLite (https://sqlite.org/rescode.html); erweiterte Codes tragen sie im unteren Byte */
const SQLITE_CODES: Record<number, ErrorCode> = {
  3: 'cannot_open', // SQLITE_PERM
  5: 'locked', // SQLITE_BUSY
  6: 'locked', // SQLITE_LOCKED
  8: 'read_only', // SQLITE_READONLY
  10: 'io_error', // SQLITE_IOERR
  11: 'corrupt', // SQLITE_CORRUPT
  13: 'disk_full', // SQLITE_FULL
  14: 'cannot_open', // SQLITE_CANTOPEN
  26: 'not_a_database', // SQLITE_NOTADB
}
const SQLITE_PERM = 3

/** Fehler des Dateisystems (z. B. mkdir in openSqliteFile) */
const SYSTEM_CODES: Record<string, ErrorCode> = {
  EACCES: 'cannot_open',
  EPERM: 'cannot_open',
  ENOENT: 'cannot_open',
  ENOTDIR: 'cannot_open',
  EISDIR: 'cannot_open',
  EEXIST: 'cannot_open',
  EROFS: 'read_only',
  EBUSY: 'locked',
  ENOSPC: 'disk_full',
  EIO: 'io_error',
}
const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])

// ---------------------------------------------------------------------------------------------
// URL, Pfade, Fehler
// ---------------------------------------------------------------------------------------------

/** Wie parseSqliteUrl: Eine URL ist SQLite, wenn sie mit `sqlite:` beginnt */
export function isSqliteUrl(url: string): boolean {
  return /^sqlite:/i.test(url)
}

/** Pfad aus `sqlite:<pfad>` oder `undefined` für SQL Server; `sqlite:` ohne Pfad ist `invalid_url` */
export function sqlitePathOf(variable: string, url: string): string | undefined {
  try {
    return parseSqliteUrl(url)
  }
  catch (error) {
    throw new ToolFailure('invalid_url', errorMessage(error).replaceAll('NUXT_DATABASE_URL', variable))
  }
}

/**
 * UNC-Pfad (`\\server\freigabe\…`, auch `//server/…` und `\\?\UNC\…`). Rust lehnt ihn ebenfalls ab; hier zur
 * Sicherheit. Ein langer Pfad auf ein lokales Laufwerk (`\\?\C:\…`) ist lokal.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path) && !/^[\\/]{2}[?.][\\/][a-z]:/i.test(path)
}

function networkPath(path: string): ToolFailure {
  return new ToolFailure('network_path', `„${path}“ liegt im Netzwerk. Die SQLite-Datenbank muss auf einem lokalen Laufwerk des Servers liegen: Über das Netzwerk sind Sperren und WAL nicht zuverlässig, die Datenbank kann beschädigt werden.`, { path })
}

/**
 * Bildet einen Fehler von node:sqlite (`errcode` = erweiterter Ergebniscode, `errstr`) oder des Dateisystems
 * (`code` = EACCES …) auf einen Code ab. `serviceHint`: bei Rechteproblemen auf das Dienstkonto hinweisen
 * (nicht für die Zieldatei einer Sicherung, die schreibt das Werkzeug selbst).
 */
export function classifySqliteError(error: unknown, path: string, { serviceHint = true }: { serviceHint?: boolean } = {}): ToolFailure {
  if (error instanceof ToolFailure) return error
  if (!(error instanceof Error)) return new ToolFailure('internal_error', `Unerwarteter Fehler bei der Datenbank „${path}“: ${String(error)}`, { path })

  const { code, errcode, errstr } = error as { code?: unknown, errcode?: unknown, errstr?: unknown }
  const isSqlite = code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number'
  const primary = isSqlite ? errcode & 0xFF : undefined
  const systemCode = !isSqlite && typeof code === 'string' ? code : undefined
  const details: Details = isSqlite
    ? { path, sqliteCode: errcode, sqliteMessage: typeof errstr === 'string' ? errstr : error.message }
    : { path, ...(systemCode && { systemCode }) }
  const mapped = primary !== undefined ? SQLITE_CODES[primary] : systemCode ? SYSTEM_CODES[systemCode] : undefined
  const hint = serviceHint ? ` ${SERVICE_ACCOUNT_HINT}` : ''

  switch (mapped) {
    case 'cannot_open': {
      const permission = primary === SQLITE_PERM || (systemCode !== undefined && PERMISSION_CODES.has(systemCode))
      return new ToolFailure('cannot_open', permission
        ? `Keine Berechtigung für die Datenbankdatei „${path}“ oder ihren Ordner.${hint}`
        : `Die Datenbankdatei „${path}“ lässt sich nicht öffnen oder anlegen: Der Pfad stimmt nicht (z. B. ist ein Teil davon eine Datei statt eines Ordners, oder der Pfad ist ein Ordner) oder es fehlen Rechte.${hint}`, details)
    }
    case 'read_only':
      return new ToolFailure('read_only', `Die Datenbank „${path}“ ist schreibgeschützt: Die Datei oder ihr Ordner ist schreibgeschützt, oder der Datenträger erlaubt kein Schreiben.${hint}`, details)
    case 'locked':
      return new ToolFailure('locked', `Die Datenbank „${path}“ ist gesperrt: Ein anderes Programm hält die Datei, z. B. der alte .NET-Dienst, eine Sicherung oder ein Virenscanner. Bitte das Programm beenden und erneut prüfen.`, details)
    case 'not_a_database':
      return new ToolFailure('not_a_database', `„${path}“ ist keine SQLite-Datenbank (oder sie ist verschlüsselt).`, details)
    case 'corrupt':
      return new ToolFailure('corrupt', `Die Datenbank „${path}“ ist beschädigt. Bitte aus einer Sicherung wiederherstellen.`, details)
    case 'disk_full':
      return new ToolFailure('disk_full', `Der Datenträger der Datenbank „${path}“ ist voll.`, details)
    case 'io_error':
      return new ToolFailure('io_error', `Lese- oder Schreibfehler bei der Datenbank „${path}“: Datenträger defekt oder getrennt, oder ein Virenscanner greift ein?`, details)
    default:
      return new ToolFailure('internal_error', `Unerwarteter Fehler bei der Datenbank „${path}“: ${error.message}`, details)
  }
}

/** Ein Schritt mit SQLite: wie runStep, Fehler werden zu Codes */
function sqliteStep<T>(report: Reporter, code: string, path: string, run: () => T | Promise<T>, options?: { serviceHint?: boolean }): Promise<T> {
  return runStep(report, code, async () => {
    try {
      return await run()
    }
    catch (error) {
      throw classifySqliteError(error, path, options)
    }
  })
}

/** Erster Wert der ersten Zeile */
function scalar(db: DatabaseSync, statement: string, ...parameters: SQLInputValue[]): unknown {
  const row = db.prepare(statement).get(...parameters)
  return row ? Object.values(row)[0] : undefined
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Number(scalar(db, 'SELECT count(*) FROM sqlite_master WHERE type = \'table\' AND name = ?', name)) > 0
}

function entries(count: number): string {
  return `${count} ${count === 1 ? 'Eintrag' : 'Einträge'}`
}

/**
 * Beweist mit einem echten, festgeschriebenen Schreibvorgang, dass Datenbank, -wal und -shm beschreibbar sind, ohne
 * eine Spur zu hinterlassen: `user_version` bekommt seinen eigenen Wert. SQLite schreibt dafür Seite 1 neu (im
 * WAL-Modus in die -wal-Datei); Daten und Schema-Version bleiben gleich, der Dienst muss nichts neu vorbereiten. Eine
 * Probetabelle dagegen änderte die Schema-Version. BEGIN IMMEDIATE holt die Schreibsperre vor dem Lesen, damit kein
 * anderer Prozess dazwischen einen anderen Wert setzt.
 */
function proveWritable(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = Math.trunc(Number(scalar(db, 'PRAGMA user_version') ?? 0))
    db.exec(`PRAGMA user_version = ${version}`)
    db.exec('COMMIT')
  }
  catch (error) {
    try {
      db.exec('ROLLBACK')
    }
    catch { /* keine offene Transaktion mehr */ }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// db-test (SQLite)
// ---------------------------------------------------------------------------------------------

/** Was unter dem Pfad liegt: die Datei, nur ihr Ordner, oder nicht einmal der Ordner */
type Presence = 'file' | 'no_file' | 'no_folder'

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * Sieht nach, ohne etwas anzulegen. Ein Teil des Pfads, der eine Datei statt eines Ordners ist, und der Pfad als
 * Ordner sind Fehler (ENOTDIR, EISDIR, wie das Dateisystem sie meldet).
 */
function presenceOf(path: string): Presence {
  try {
    if (statSync(path).isDirectory()) throw systemError('EISDIR', `„${path}“ ist ein Ordner`)
    return 'file'
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Der nächste vorhandene Teil des Pfads muss ein Ordner sein (unter Windows meldet ein Pfad durch eine Datei ENOENT)
  let folder = dirname(resolve(path))
  for (let depth = 0; ; depth++) {
    try {
      if (!statSync(folder).isDirectory()) throw systemError('ENOTDIR', `„${folder}“ ist kein Ordner`)
      return depth === 0 ? 'no_file' : 'no_folder'
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(folder)
      if (parent === folder) return 'no_folder'
      folder = parent
    }
  }
}

/** Öffnet die vorhandene Datei wie die App (`openSqliteFile` ohne das Anlegen des Ordners) */
function openLikeTheApp(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  catch (error) {
    db.close()
    throw error
  }
  return db
}

/** Version der eingebauten SQLite-Bibliothek, ohne eine Datei zu berühren */
function libraryVersion(): string {
  const memory = new DatabaseSync(':memory:')
  try {
    return String(scalar(memory, 'SELECT sqlite_version()'))
  }
  finally {
    memory.close()
  }
}

/** Ordner oder Datei fehlen: melden, was der Dienst bzw. das Speichern daraus macht, und nichts anlegen */
async function reportMissing(path: string, presence: Exclude<Presence, 'file'>, report: Reporter): Promise<Outcome> {
  const folder = dirname(resolve(path))
  const folderExists = presence === 'no_file'
  report.ok('open', folderExists
    ? `„${path}“ gibt es noch nicht: eine neue Datenbank, die der Dienst bei seinem Start anlegt. Angelegt wurde nichts.`
    : `Den Ordner „${folder}“ gibt es noch nicht: Das Speichern der Konfiguration legt ihn mit den richtigen Rechten an, die Datenbank danach der Dienst. Angelegt wurde nichts.`, { path, exists: false, folderExists, created: false })
  const version = await sqliteStep(report, 'sqlite_version', path, libraryVersion)
  report.ok('sqlite_version', `SQLite ${version}.`, { version })
  const counts: MigrationCounts = { core: 0, pds: 0 }
  report.ok('migrations', migrationsMessage(counts), counts)
  return {
    message: folderExists
      ? `Die SQLite-Datenbank „${path}“ gibt es noch nicht; der Dienst legt sie bei seinem Start an.`
      : `Die SQLite-Datenbank „${path}“ gibt es noch nicht; ihr Ordner entsteht beim Speichern der Konfiguration.`,
    details: { path, warnings: [], exists: false, folderExists },
  }
}

export async function sqliteTest(path: string, report: Reporter): Promise<Outcome> {
  const presence = await sqliteStep(report, 'open', path, () => {
    if (isNetworkPath(path)) throw networkPath(path)
    return presenceOf(path)
  })
  if (presence !== 'file') return reportMissing(path, presence, report)

  const db = await sqliteStep(report, 'open', path, () => openLikeTheApp(path))
  const warnings: string[] = []
  try {
    report.ok('open', `Datenbankdatei „${path}“ geöffnet.`, { path, exists: true, folderExists: true, created: false })

    const journalMode = await sqliteStep(report, 'writable', path, () => {
      proveWritable(db)
      return String(scalar(db, 'PRAGMA journal_mode'))
    })
    if (journalMode === 'wal') {
      report.ok('writable', 'Die Datenbank und ihre Dateien „-wal“ und „-shm“ sind beschreibbar (WAL-Modus).', { journalMode })
    }
    else {
      warnings.push('writable')
      report.warn('writable', `Die Datenbank ist beschreibbar, aber WAL ließ sich nicht einschalten (journal_mode = ${journalMode}), etwa auf einem schreibgeschützten Datenträger oder einem Netzlaufwerk. Dann blockieren Lesende den Schreibenden, und der Dienst wartet öfter auf Sperren.`, { journalMode })
    }

    const version = await sqliteStep(report, 'sqlite_version', path, () => String(scalar(db, 'SELECT sqlite_version()')))
    report.ok('sqlite_version', `SQLite ${version}.`, { version })

    const counts = await sqliteStep(report, 'migrations', path, () => {
      const found: MigrationCounts = { core: 0, pds: 0 }
      for (const schema of MIGRATION_SCHEMAS) {
        const table = `${schema}_migrations`
        found[schema] = tableExists(db, table) ? Number(scalar(db, `SELECT count(*) FROM ${table}`)) : 0
      }
      return found
    })
    report.ok('migrations', migrationsMessage(counts), counts)

    // Tabelle der .NET-Version: Zeigt die URL auf deren pds.db, kann die Konsole die Nachverfolgung übernehmen
    const legacyRows = await sqliteStep(report, 'legacy', path, () => tableExists(db, 'wiring_files') ? Number(scalar(db, 'SELECT count(*) FROM wiring_files')) : undefined)
    if (legacyRows !== undefined) {
      report.ok('legacy', `Tabelle „wiring_files“ der .NET-Version gefunden (${entries(legacyRows)}). Die Admin-Konsole kann sie übernehmen (Einstellungen, „Bisherige Nachverfolgung“).`, { rows: legacyRows })
    }
  }
  finally {
    db.close()
  }

  return { message: `Die SQLite-Datenbank „${path}“ funktioniert${warningsSuffix(warnings)}.`, details: { path, warnings, exists: true, folderExists: true } }
}

// ---------------------------------------------------------------------------------------------
// db-backup
// ---------------------------------------------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

const COMPANIONS = ['-journal', '-wal', '-shm']

/** Dieselbe Datei (Datenträger und Dateinummer), nicht nur derselbe Name */
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** lstat ohne Ausnahme: `undefined`, wenn es nichts (mehr) gibt */
function entryAt(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true })
  }
  catch {
    return undefined
  }
}

/**
 * Die Zieldatei der Sicherung, exklusiv angelegt (`wx`: scheitert an allem, was schon da ist, auch an einem Verweis,
 * dessen Ziel fehlt). Die Sicherung schreibt in genau diese leere Datei; gelöscht wird bei einem Fehler nur, was
 * dieser Aufruf angelegt hat und was noch dieselbe Datei ist.
 */
class BackupTarget {
  private constructor(readonly file: string, private readonly identity: BigIntStats, private readonly companions: string[]) {}

  static create(file: string): BackupTarget {
    // Begleitdateien, die schon vorher da waren, gehören nicht dieser Sicherung und bleiben bei einem Fehler
    const companions = COMPANIONS.map(suffix => `${file}${suffix}`).filter(path => entryAt(path) === undefined)
    let fd: number
    try {
      fd = openSync(file, 'wx')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ToolFailure('target_exists', `Die Zieldatei „${file}“ gibt es schon. Bitte einen neuen Dateinamen wählen: Eine vorhandene Datei wird nicht überschrieben.`, { file })
      }
      throw error
    }
    try {
      return new BackupTarget(file, fstatSync(fd, { bigint: true }), companions)
    }
    finally {
      closeSync(fd)
    }
  }

  /** Liegt unter dem Namen noch die eigene, gewöhnliche Datei (kein Verweis, nicht ersetzt)? */
  isOurs(): boolean {
    const entry = entryAt(this.file)
    return entry !== undefined && entry.isFile() && sameFile(entry, this.identity)
  }

  /** Wurde die Datei zwischendurch ersetzt, ist das ein Fehler: Geschrieben hätte die Sicherung dann woanders hin */
  assertOurs(): void {
    if (!this.isOurs()) {
      throw new ToolFailure('cannot_open', `Die Zieldatei „${this.file}“ wurde während der Sicherung ersetzt. Bitte einen Ordner verwenden, in dem nur Administratoren schreiben dürfen.`, { file: this.file })
    }
  }

  /** Entfernt nur, was diese Sicherung angelegt hat; scheitert das, bleibt der eigentliche Fehler maßgeblich */
  remove(): void {
    const targets = [...(this.isOurs() ? [this.file] : []), ...this.companions]
    for (const path of targets) {
      try {
        rmSync(path, { force: true })
      }
      catch { /* z. B. noch geöffnet (Windows) */ }
    }
  }
}

/** „512 KB“, „1,5 MB“ */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

/** Öffnet die vorhandene Datei, ohne sie oder einen Ordner anzulegen und ohne ihren Modus zu ändern */
function openExisting(path: string): DatabaseSync {
  if (isNetworkPath(path)) throw networkPath(path)
  if (!existsSync(path)) throw new ToolFailure('not_found', `Die Datenbankdatei „${path}“ gibt es nicht.`, { path })
  const db = new DatabaseSync(path)
  try {
    // Der Dienst darf weiterarbeiten: Hält er kurz eine Sperre, wartet das Werkzeug statt zu scheitern
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    // Liest den Kopf: Eine Datei, die keine Datenbank ist, fällt schon hier auf
    scalar(db, 'SELECT count(*) FROM sqlite_master')
  }
  catch (error) {
    db.close()
    throw error
  }
  return db
}

/** Prüft die Kopie und macht sie zu einer einzelnen Datei */
function verifyCopy(file: string): void {
  const copy = new DatabaseSync(file)
  try {
    copy.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    // Die Kopie übernimmt den WAL-Modus der Quelle. Ohne WAL braucht sie keine -wal/-shm daneben und lässt sich auch
    // von einem schreibgeschützten Datenträger öffnen; beim Zurückspielen schaltet die App WAL wieder ein.
    copy.exec('PRAGMA journal_mode = DELETE')
    const problems = copy.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0]))
    if (problems.length !== 1 || problems[0] !== 'ok') {
      throw new ToolFailure('corrupt', `Die Kopie „${file}“ ist fehlerhaft (integrity_check): ${problems.slice(0, 3).join('; ')}`, { file, problems: problems.slice(0, 20) })
    }
  }
  finally {
    copy.close()
  }
}

/**
 * Sicherung der SQLite-Datenbank im laufenden Betrieb über die Backup-API von SQLite (kein Dateikopieren, das die
 * -wal-Datei verpassen oder einen halben Schreibvorgang erwischen könnte).
 */
export async function dbBackup(env: NodeJS.ProcessEnv, report: Reporter): Promise<Outcome> {
  const path = sqlitePathOf('NUXT_DATABASE_URL', requireEnv(env, 'NUXT_DATABASE_URL'))
  if (path === undefined) {
    throw new ToolFailure('not_supported', 'Die Sicherung gilt nur für SQLite; eine SQL-Server-Datenbank sichert die Datenbankverwaltung, z. B. mit BACKUP DATABASE.')
  }
  const file = requireEnv(env, 'PDS_BACKUP_FILE')
  if (!isAbsolute(file)) throw new UsageError('PDS_BACKUP_FILE muss ein absoluter Pfad sein')

  const source = await sqliteStep(report, 'open', path, () => openExisting(path))
  let target: BackupTarget | undefined
  try {
    report.ok('open', `Datenbank „${path}“ geöffnet.`, { path })
    const pages = await sqliteStep(report, 'backup', file, async () => {
      const folder = dirname(file)
      if (!isDirectory(folder)) throw new ToolFailure('cannot_open', `Den Ordner „${folder}“ für die Sicherung gibt es nicht.`, { file })
      target = BackupTarget.create(file)
      // Eine leere Datei ist für SQLite eine leere Datenbank: Die Sicherung füllt genau die angelegte Datei
      const written = await backup(source, file, { rate: ALL_PAGES })
      target.assertOurs()
      return written
    }, { serviceHint: false })
    report.ok('backup', `Kopie nach „${file}“ geschrieben (${pages} ${pages === 1 ? 'Seite' : 'Seiten'}).`, { pages })
  }
  catch (error) {
    target?.remove()
    throw error
  }
  finally {
    source.close()
  }

  try {
    await sqliteStep(report, 'verify', file, () => {
      verifyCopy(file)
      target?.assertOurs()
    }, { serviceHint: false })
  }
  catch (error) {
    target?.remove()
    throw error
  }
  report.ok('verify', 'Die Kopie ist vollständig und fehlerfrei (integrity_check: ok).')

  const bytes = statSync(file).size
  return { message: `Sicherung von „${path}“ nach „${file}“ geschrieben (${formatBytes(bytes)}).`, details: { file, bytes } }
}
