// Datenbankbefehle: db-test (App-Zugang prüfen), db-setup (Datenbank und Login anlegen).
// Eine `sqlite:`-URL prüft sqlite.ts; db-setup gilt nur für SQL Server.
// Die URL liest `parseDatabaseUrl` der App; die Verbindung öffnet tedious direkt mit denselben Optionen
// wie `createDatabase`. Der Pool der App (tarn) würde Fehler hinter einer 30-s-Wartezeit verstecken
// und ihnen Code und Nummer nehmen – hier brauchen wir beides, um sie auf Codes abzubilden.
import { Connection, Request, RequestError } from 'tedious'
import { parseDatabaseUrl } from '@pds/core/database'
import type { MssqlConnectionOptions } from '@pds/core/database'
import { MIGRATION_SCHEMAS, migrationsMessage, warningsSuffix } from './db-messages'
import type { MigrationCounts } from './db-messages'
import { DNS_CODES, TIMEOUT_CODES, TLS_CERT_CODES, UNREACHABLE_CODES, causeCodes, errorMessage } from './network'
import { ToolFailure, UsageError, requireEnv, runStep } from './protocol'
import type { Details, Outcome, Reporter } from './protocol'
import { SETUP_STEPS, setupBatches, setupScript } from './setup-sql'
import { isSqliteUrl, sqlitePathOf, sqliteTest } from './sqlite'

/** Wie `connectTimeout` in createDatabase */
const CONNECT_TIMEOUT_MS = 15_000
/** Standard von tedious für eine einzelne Anweisung (die App ändert ihn nicht) */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** CREATE/ALTER DATABASE (inkl. ROLLBACK IMMEDIATE) kann auf einem belasteten Server deutlich länger als 15 s dauern */
const SETUP_REQUEST_TIMEOUT_MS = 120_000
/** Wartezeit beim Schließen, falls tedious kein `end` meldet */
const CLOSE_TIMEOUT_MS = 2_000

/** Fehlernummern des Servers: fehlende Rechte */
const PERMISSION_DENIED = new Set([229, 262, 297, 300, 916, 5011, 15151, 15247])
/** Kennwortrichtlinie beim Anlegen des Logins (15118 unter Windows, 33062 ff. ab SQL Server 2022) */
const PASSWORD_POLICY = new Set([15118, 15119, 33062, 33063, 33064, 33065])
/** „Cannot open database requested by the login“: Datenbank fehlt oder das Login hat keinen Zugriff */
const DATABASE_UNAVAILABLE = 4060

const ADMIN_LOGIN_REFUSED = 'Der App-Benutzer darf kein Administrator-Login sein – bitte ein eigenes Login für den EPLAN Panel Data Service verwenden'

interface Target {
  server: string
  port: number
  database: string
  user: string
  requestTimeoutMs?: number
}

/** „1 Sekunde“, „120 Sekunden“, „1,5 Sekunden“ */
function seconds(ms: number): string {
  const value = ms / 1000
  return `${String(value).replace('.', ',')} ${value === 1 ? 'Sekunde' : 'Sekunden'}`
}

// ---------------------------------------------------------------------------------------------
// Fehler auf Codes abbilden
// ---------------------------------------------------------------------------------------------

/**
 * Bildet einen Fehler von tedious auf einen Code ab. `loginErrors` sind die Fehlernummern, die der
 * Server beim Anmelden meldete: tedious nennt im Fehler nur die letzte („Login failed“), die
 * Datenbank fehlt aber, wenn zuvor 4060 kam.
 */
export function classifyDatabaseError(error: unknown, loginErrors: number[] = [], target?: Partial<Target>): ToolFailure {
  if (error instanceof ToolFailure) return error
  if (!(error instanceof Error)) return new ToolFailure('internal_error', `Unerwarteter Fehler: ${String(error)}`)

  const { code, number } = error as { code?: unknown, number?: unknown }
  const codes = causeCodes(error)
  const server = target?.server ? `${target.server}${target.port ? `:${target.port}` : ''}` : 'dem Server'
  const user = target?.user ?? 'dem Benutzer'
  const database = target?.database ?? 'der Datenbank'
  const details: Details = { serverMessage: error.message }

  if (code === 'ELOGIN') {
    if (loginErrors.includes(DATABASE_UNAVAILABLE)) return databaseMissing(database, user, details)
    return new ToolFailure('login_failed', `Die Anmeldung als „${user}“ ist fehlgeschlagen: Benutzername oder Passwort stimmen nicht, oder das Login ist gesperrt oder deaktiviert.`, details)
  }

  // Eine einzelne Anweisung dauert zu lange (ein RequestError, nicht der Verbindungsaufbau)
  if (error instanceof RequestError && code === 'ETIMEOUT') {
    return new ToolFailure('timeout', `Die Anweisung dauerte länger als ${seconds(target?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)}.`, details)
  }

  if (typeof number === 'number') {
    if (number === DATABASE_UNAVAILABLE) return databaseMissing(database, user, details)
    if (PERMISSION_DENIED.has(number)) return new ToolFailure('permission_denied', `Dem Benutzer fehlen Rechte für diese Aktion: ${error.message}`, details)
    if (PASSWORD_POLICY.has(number) || /password validation failed/i.test(error.message)) {
      return new ToolFailure('password_policy', `Das Passwort erfüllt die Kennwortrichtlinie des SQL Servers nicht: ${error.message}`, details)
    }
    return new ToolFailure('internal_error', `Der SQL Server meldet einen Fehler (${number}): ${error.message}`, details)
  }

  const isConnectionError = code === 'ESOCKET' || code === 'ETIMEOUT' || code === 'ECONNCLOSED'
  if (isConnectionError) {
    const found = (set: Set<string>) => codes.find(item => set.has(item))
    const cause = found(TLS_CERT_CODES) ?? found(DNS_CODES) ?? found(TIMEOUT_CODES) ?? found(UNREACHABLE_CODES)
    const withCause: Details = { ...details, ...(cause && { cause }) }
    if (found(TLS_CERT_CODES) || /certificate|self[- ]signed|altnames/i.test(error.message)) {
      return new ToolFailure('tls_untrusted', `Das TLS-Zertifikat von ${server} ist nicht vertrauenswürdig oder passt nicht zum Servernamen. Entweder die ausstellende CA im Zertifikatspeicher des Computers installieren oder die Option „trustServerCertificate“ einschalten.`, withCause)
    }
    if (found(DNS_CODES)) return new ToolFailure('dns_failed', `Der Servername ${server.split(':')[0]} lässt sich nicht auflösen (DNS).`, withCause)
    if (code === 'ETIMEOUT' || found(TIMEOUT_CODES)) {
      return new ToolFailure('timeout', `${server} antwortet nicht innerhalb von ${CONNECT_TIMEOUT_MS / 1000} Sekunden (Firewall, falscher Servername oder Port?).`, withCause)
    }
    // Sonst scheitert schon der Socket oder der TLS-Aufbau: aus Sicht des Betreibers eine Verbindungsstörung.
    // Ist die Ursache nicht eindeutig, steht der Text von Node dabei.
    const hint = found(UNREACHABLE_CODES) ? '' : ` (${error.message})`
    return new ToolFailure('connection_refused', `${server} ist nicht erreichbar oder lehnt die Verbindung ab: Dienst gestartet, Firewall, richtiger Port?${hint}`, withCause)
  }

  return new ToolFailure('internal_error', `Unerwarteter Fehler: ${error.message}`, details)
}

function databaseMissing(database: string, user: string, details: Details): ToolFailure {
  return new ToolFailure('database_missing', `Die Datenbank „${database}“ existiert nicht oder „${user}“ hat keinen Zugriff darauf.`, details)
}

// ---------------------------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------------------------

/** Liest die URL aus der Umgebung. Die Fehlertexte von parseDatabaseUrl enthalten nie den Wert. */
function parseUrl(variable: string, url: string): MssqlConnectionOptions {
  try {
    return parseDatabaseUrl(url)
  }
  catch (error) {
    // parseDatabaseUrl nennt immer NUXT_DATABASE_URL, auch für die Admin-URL
    throw new ToolFailure('invalid_url', errorMessage(error).replaceAll('NUXT_DATABASE_URL', variable))
  }
}

export class DatabaseSession {
  private ended = false

  private constructor(private readonly connection: Connection, readonly target: Target) {
    connection.once('end', () => (this.ended = true))
  }

  static async open(variable: string, url: string, session: { requestTimeoutMs?: number } = {}): Promise<DatabaseSession> {
    const options = parseUrl(variable, url)
    const requestTimeoutMs = session.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const target: Target = { server: options.server, port: options.port, database: options.database, user: options.user, requestTimeoutMs }
    const loginErrors: number[] = []
    const connection = new Connection({
      server: options.server,
      authentication: { type: 'default', options: { userName: options.user, password: options.password } },
      options: {
        port: options.port,
        database: options.database,
        encrypt: options.encrypt,
        trustServerCertificate: options.trustServerCertificate,
        lowerCaseGuids: true,
        useUTC: true,
        connectTimeout: CONNECT_TIMEOUT_MS,
        requestTimeout: requestTimeoutMs,
      },
    })
    connection.on('errorMessage', message => loginErrors.push(message.number))
    // Ein später Socket-Fehler darf den Prozess nicht abstürzen lassen
    connection.on('error', () => {})
    try {
      await new Promise<void>((resolve, reject) => connection.connect(error => (error ? reject(error) : resolve())))
    }
    catch (error) {
      throw classifyDatabaseError(error, loginErrors, target)
    }
    return new DatabaseSession(connection, target)
  }

  /** Führt einen Batch aus (wie sqlcmd: kein sp_executesql, ein `USE` bleibt wirksam) */
  query(statement: string): Promise<unknown[][]> {
    return new Promise((resolve, reject) => {
      const rows: unknown[][] = []
      const request = new Request(statement, error => (error ? reject(classifyDatabaseError(error, [], this.target)) : resolve(rows)))
      request.on('row', (columns: Array<{ value: unknown }>) => rows.push(columns.map(column => column.value)))
      this.connection.execSqlBatch(request)
    })
  }

  async close(): Promise<void> {
    if (this.ended) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
      this.connection.once('end', () => {
        clearTimeout(timer)
        resolve()
      })
      this.connection.close()
    })
  }
}

// ---------------------------------------------------------------------------------------------
// db-test
// ---------------------------------------------------------------------------------------------

/** Marketingname zur Hauptversion (16.0.… = SQL Server 2022) */
const SERVER_YEARS: Record<number, string> = { 17: '2025', 16: '2022', 15: '2019', 14: '2017', 13: '2016', 12: '2014', 11: '2012' }

function first(rows: unknown[][]): unknown[] {
  return rows[0] ?? []
}

export async function dbTest(env: NodeJS.ProcessEnv, report: Reporter): Promise<Outcome> {
  const url = requireEnv(env, 'NUXT_DATABASE_URL')
  const sqlitePath = sqlitePathOf('NUXT_DATABASE_URL', url)
  if (sqlitePath !== undefined) return sqliteTest(sqlitePath, report)

  const session = await runStep(report, 'connect', () => DatabaseSession.open('NUXT_DATABASE_URL', url))
  const { server, port, database, user } = session.target
  const warnings: string[] = []
  try {
    report.ok('connect', `Verbindung zu ${server}:${port} hergestellt.`, { server, port, database })

    const [version, edition] = await runStep(report, 'server_version', async () => first(await session.query(
      'SELECT CAST(SERVERPROPERTY(\'ProductVersion\') AS nvarchar(64)), CAST(SERVERPROPERTY(\'Edition\') AS nvarchar(128))',
    )))
    const versionText = String(version ?? '')
    const year = SERVER_YEARS[Number.parseInt(versionText, 10)]
    report.ok('server_version', `SQL Server${year ? ` ${year}` : ''} (${versionText}), ${String(edition ?? 'Edition unbekannt')}.`, { version: versionText, edition: String(edition ?? '') })

    const [isOwner] = await runStep(report, 'db_owner', async () => first(await session.query('SELECT IS_ROLEMEMBER(N\'db_owner\')')))
    if (Number(isOwner) === 1) {
      report.ok('db_owner', `„${user}“ ist db_owner der Datenbank „${database}“.`)
    }
    else {
      warnings.push('db_owner')
      report.warn('db_owner', `„${user}“ ist nicht db_owner der Datenbank „${database}“. Die App kann ihre Tabellen dann nicht anlegen oder ändern.`)
    }

    const [snapshot] = await runStep(report, 'read_committed_snapshot', async () => first(await session.query(
      'SELECT is_read_committed_snapshot_on FROM sys.databases WHERE database_id = DB_ID()',
    )))
    if (snapshot === true || Number(snapshot) === 1) {
      report.ok('read_committed_snapshot', 'READ_COMMITTED_SNAPSHOT ist eingeschaltet.')
    }
    else {
      warnings.push('read_committed_snapshot')
      report.warn('read_committed_snapshot', 'READ_COMMITTED_SNAPSHOT ist ausgeschaltet: Leser blockieren dann Schreiber. Die Einrichtung (db-setup) bzw. das SQL-Skript schaltet es ein.')
    }

    const counts: MigrationCounts = { core: 0, pds: 0 }
    await runStep(report, 'migrations', async () => {
      for (const schema of MIGRATION_SCHEMAS) {
        // Zwei Anweisungen: Fehlt die Tabelle, wird die zweite nie übersetzt
        const [count] = first(await session.query(`IF OBJECT_ID(N'${schema}.migrations', N'U') IS NULL SELECT 0 ELSE SELECT COUNT(*) FROM ${schema}.migrations`))
        counts[schema] = Number(count ?? 0)
      }
    })
    report.ok('migrations', migrationsMessage(counts), counts)
  }
  finally {
    await session.close()
  }

  return { message: `Die Verbindung zur Datenbank „${database}“ funktioniert${warningsSuffix(warnings)}.`, details: { warnings } }
}

// ---------------------------------------------------------------------------------------------
// db-setup und db-script
// ---------------------------------------------------------------------------------------------

export async function dbSetup(env: NodeJS.ProcessEnv, report: Reporter): Promise<Outcome> {
  const adminUrl = requireEnv(env, 'PDS_ADMIN_DATABASE_URL')
  // Vor den übrigen Variablen: Für SQLite braucht es weder Datenbankname noch Login
  if (isSqliteUrl(adminUrl)) {
    throw new ToolFailure('not_needed', 'Für SQLite ist keine Einrichtung nötig: Die Anwendung legt die Datenbankdatei beim ersten Start selbst an.')
  }
  const values = {
    dbName: requireEnv(env, 'PDS_DB_NAME'),
    dbUser: requireEnv(env, 'PDS_DB_USER'),
    dbPassword: requireEnv(env, 'PDS_DB_PASSWORD'),
  }
  let batches: string[]
  try {
    batches = setupBatches(values)
  }
  catch (error) {
    throw new UsageError(errorMessage(error))
  }

  const session = await runStep(report, 'connect', () => DatabaseSession.open('PDS_ADMIN_DATABASE_URL', adminUrl, { requestTimeoutMs: SETUP_REQUEST_TIMEOUT_MS }))
  try {
    // Namen sind geprüft (kein ' und kein ]), die Literale sind sicher
    const [dbId, loginId, isSysadmin, adminLoginId] = await runStep(report, 'connect', async () => first(await session.query(
      `SELECT DB_ID(N'${values.dbName}'), SUSER_ID(N'${values.dbUser}'), IS_SRVROLEMEMBER(N'sysadmin', N'${values.dbUser}'), SUSER_ID(SUSER_SNAME())`,
    )))
    const databaseExists = dbId !== null && dbId !== undefined
    const loginExists = loginId !== null && loginId !== undefined
    report.ok('connect', `Als Administrator mit ${session.target.server}:${session.target.port} verbunden.`, { server: session.target.server, port: session.target.port })

    // Vor jedem Batch: Das Login bekommt ein neues Passwort (ALTER LOGIN). Ein Administrator-Login oder
    // das des Admins selbst darf das nicht sein, sonst sperrt sich der Betreiber aus oder es trifft eine fremde Anwendung.
    await runStep(report, 'login', async () => {
      const sameAsAdmin = values.dbUser.trim().toLowerCase() === session.target.user.trim().toLowerCase()
        || (loginExists && Number(loginId) === Number(adminLoginId))
      if (Number(isSysadmin) === 1 || sameAsAdmin) {
        throw new ToolFailure('permission_denied', ADMIN_LOGIN_REFUSED, { user: values.dbUser, reason: sameAsAdmin ? 'same_as_admin' : 'sysadmin' })
      }
    })

    const messages: Record<(typeof SETUP_STEPS)[number], { text: string, details?: Details }> = {
      database: databaseExists
        ? { text: `Datenbank „${values.dbName}“ ist schon vorhanden.`, details: { created: false } }
        : { text: `Datenbank „${values.dbName}“ angelegt.`, details: { created: true } },
      read_committed_snapshot: { text: 'READ_COMMITTED_SNAPSHOT eingeschaltet (offene Verbindungen zur Datenbank wurden getrennt).' },
      login: loginExists
        ? { text: `Login „${values.dbUser}“ ist schon vorhanden, sein Passwort wurde neu gesetzt.`, details: { created: false } }
        : { text: `Login „${values.dbUser}“ angelegt.`, details: { created: true } },
      db_owner: { text: `„${values.dbUser}“ ist Benutzer und db_owner der Datenbank „${values.dbName}“.` },
    }
    for (const [index, step] of SETUP_STEPS.entries()) {
      const batch = batches[index]
      if (batch === undefined) throw new Error('Batch fehlt')
      await runStep(report, step, () => session.query(batch))
      report.ok(step, messages[step].text, messages[step].details)
    }
    return {
      message: `Datenbank „${values.dbName}“ und Login „${values.dbUser}“ sind bereit.`,
      details: { databaseCreated: !databaseExists, loginCreated: !loginExists },
    }
  }
  finally {
    await session.close()
  }
}

/** Dieselben Anweisungen als sqlcmd-Skript für die DBAs; das Passwort bleibt ein Platzhalter */
export async function dbScript(env: NodeJS.ProcessEnv): Promise<Outcome> {
  const dbName = requireEnv(env, 'PDS_DB_NAME')
  const dbUser = requireEnv(env, 'PDS_DB_USER')
  try {
    return { message: 'SQL-Skript erzeugt.', details: { script: setupScript({ dbName, dbUser }) } }
  }
  catch (error) {
    throw new UsageError(errorMessage(error))
  }
}
