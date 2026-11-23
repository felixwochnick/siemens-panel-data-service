import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreMigrations, createDatabase, migrateDatabase, tsql } from '@pds/core/database'
import { TEST_DIALECT, TEST_SERVER_URL } from '@pds/core/testing'
import { RequestError } from 'tedious'
import { DatabaseSession, classifyDatabaseError } from '../src/db'
import { runTool, step } from './helpers'

// Datenbank und Login nur für diese Datei (SQL Server aus docker-compose.dev.yml)
const NAME = 'pds_test_nodetools'
const PASSWORD = 'Pa\'ss@w%rd#1A'

const server = new URL(TEST_SERVER_URL)

function urlFor(user: string, password: string, database: string): string {
  return `mssql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.host}/${encodeURIComponent(database)}?trustServerCertificate=true`
}

const appUrl = urlFor(NAME, PASSWORD, NAME)
const setupEnv = { PDS_ADMIN_DATABASE_URL: TEST_SERVER_URL, PDS_DB_NAME: NAME, PDS_DB_USER: NAME, PDS_DB_PASSWORD: PASSWORD }

/** Führt T-SQL als Admin aus (Aufräumen, Zustand für einzelne Tests herstellen) */
async function admin(statement: string, database = 'master'): Promise<void> {
  const url = new URL(TEST_SERVER_URL)
  url.pathname = `/${database}`
  const db = createDatabase<unknown>(url.toString(), { poolMax: 1 })
  try {
    await sql.raw(statement).execute(db)
  }
  finally {
    await db.destroy()
  }
}

/** Eine Abfrage als Admin; liefert die Zeilen */
async function adminRows(statement: string, database = 'master'): Promise<Record<string, unknown>[]> {
  const url = new URL(TEST_SERVER_URL)
  url.pathname = `/${database}`
  const db = createDatabase<unknown>(url.toString(), { poolMax: 1 })
  try {
    return (await sql.raw(statement).execute(db)).rows as Record<string, unknown>[]
  }
  finally {
    await db.destroy()
  }
}

// Zusätzliche Namen dieser Datei: Datenbanken, die ein Fehler der Schutzprüfung anlegen würde, und ein Admin-Login
const SYSADMIN = `${NAME}_sysadmin`
const EXTRA_DATABASES = [`${NAME}_sa`, `${NAME}_sysadmin`, `${NAME}_same`, `${NAME}_model`]

async function cleanup(): Promise<void> {
  for (const name of [NAME, ...EXTRA_DATABASES]) {
    await admin(`IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}] END`)
  }
  for (const login of [NAME, SYSADMIN]) await admin(`IF SUSER_ID(N'${login}') IS NOT NULL DROP LOGIN [${login}]`)
}

const databaseExists = async (name: string) => (await adminRows(`SELECT DB_ID(N'${name}') AS id`))[0]?.id != null

// Nur gegen SQL Server; `TEST_DATABASE=sqlite` (pnpm test:sqlite) läuft ohne Docker, SQLite prüft sqlite.test.ts
describe.skipIf(TEST_DIALECT === 'sqlite')('mit SQL Server', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  it('setup_then_test', async () => {
    const setup = await runTool('db-setup', setupEnv)
    expect(setup.result).toMatchObject({ ok: true, code: 'ok' })
    expect(setup.exitCode).toBe(0)
    expect(setup.steps.map(line => `${line.code}:${line.ok}`)).toEqual([
      'connect:true', 'database:true', 'read_committed_snapshot:true', 'login:true', 'db_owner:true',
    ])
    expect(step(setup, 'database')?.details).toMatchObject({ created: true })
    expect(step(setup, 'login')?.details).toMatchObject({ created: true })

    const test = await runTool('db-test', { NUXT_DATABASE_URL: appUrl })
    expect(test.result).toMatchObject({ ok: true, code: 'ok' })
    expect(test.exitCode).toBe(0)
    expect(step(test, 'connect')?.ok).toBe(true)
    expect(step(test, 'server_version')).toMatchObject({ ok: true })
    expect(step(test, 'db_owner')).toMatchObject({ ok: true })
    expect(step(test, 'read_committed_snapshot')).toMatchObject({ ok: true })
    // Frische Datenbank: noch keine Migrationen, die Tabellen fehlen (Anzahl 0)
    expect(step(test, 'migrations')).toMatchObject({ ok: true, details: { core: 0, pds: 0 } })

    // Zweiter Lauf: nichts wird doppelt angelegt, das Login bleibt nutzbar
    const again = await runTool('db-setup', setupEnv)
    expect(again.result).toMatchObject({ ok: true, code: 'ok' })
    expect(step(again, 'database')?.details).toMatchObject({ created: false })
    expect(step(again, 'login')?.details).toMatchObject({ created: false })
    expect((await runTool('db-test', { NUXT_DATABASE_URL: appUrl })).result.ok).toBe(true)
  })

  it('setup_resets_password', async () => {
    const next = 'Neu-Pa$$w0rd ü?'
    expect((await runTool('db-setup', { ...setupEnv, PDS_DB_PASSWORD: next })).result.ok).toBe(true)
    expect((await runTool('db-test', { NUXT_DATABASE_URL: appUrl })).result.code).toBe('login_failed')
    expect((await runTool('db-test', { NUXT_DATABASE_URL: urlFor(NAME, next, NAME) })).result.ok).toBe(true)
    expect((await runTool('db-setup', setupEnv)).result.ok).toBe(true)
  })

  it('app_login_creates_schemas_by_migration', async () => {
    // Wie die App beim Start: Migrationen für core und pds mit dem Login aus db-setup. Dafür braucht es
    // CREATE SCHEMA und CREATE TABLE in der eigenen Datenbank (db_owner), aber keine Rechte auf master.
    expect((await runTool('db-setup', setupEnv)).result.ok).toBe(true)
    const db = createDatabase<unknown>(appUrl, { poolMax: 1 })
    try {
      await migrateDatabase(db, [
        coreMigrations,
        { schema: 'pds', mssql: { '0001_probe': tsql('CREATE TABLE pds.probe (id int NOT NULL CONSTRAINT pk_probe PRIMARY KEY)') }, sqlite: {} },
      ])
    }
    finally {
      await db.destroy()
    }

    const test = await runTool('db-test', { NUXT_DATABASE_URL: appUrl })
    expect(test.result.ok).toBe(true)
    expect(step(test, 'migrations')).toMatchObject({
      ok: true,
      details: { core: Object.keys(coreMigrations.mssql).length, pds: 1 },
    })
    expect(step(test, 'migrations')?.message).toContain('pds 1')
  })

  it('warns_without_db_owner_and_snapshot', async () => {
    await admin(`ALTER DATABASE [${NAME}] SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE`)
    await admin(`ALTER ROLE db_owner DROP MEMBER [${NAME}]`, NAME)

    const test = await runTool('db-test', { NUXT_DATABASE_URL: appUrl })
    // Warnungen sind Schritte mit ok:false, das Ergebnis bleibt ok
    expect(test.result).toMatchObject({ ok: true, code: 'ok' })
    expect(test.exitCode).toBe(0)
    expect(step(test, 'db_owner')).toMatchObject({ ok: false, details: { warning: true } })
    expect(step(test, 'read_committed_snapshot')).toMatchObject({ ok: false, details: { warning: true } })
    expect(test.result.details).toMatchObject({ warnings: ['db_owner', 'read_committed_snapshot'] })

    // Die Einrichtung stellt beides wieder her
    expect((await runTool('db-setup', setupEnv)).result.ok).toBe(true)
    const healed = await runTool('db-test', { NUXT_DATABASE_URL: appUrl })
    expect(step(healed, 'db_owner')?.ok).toBe(true)
    expect(step(healed, 'read_committed_snapshot')?.ok).toBe(true)
  })

  it('setup_without_admin_rights_is_permission_denied', async () => {
    // Das App-Login darf auf master nichts anlegen
    const run = await runTool('db-setup', {
      PDS_ADMIN_DATABASE_URL: urlFor(NAME, PASSWORD, 'master'),
      PDS_DB_NAME: `${NAME}_other`,
      PDS_DB_USER: `${NAME}_other`,
      PDS_DB_PASSWORD: PASSWORD,
    })
    expect(run.result.code).toBe('permission_denied')
    expect(run.exitCode).toBe(3)
    expect(run.steps.at(-1)).toMatchObject({ ok: false, code: 'database', details: { error: 'permission_denied' } })
  })

  it('setup_with_weak_password_is_password_policy', async () => {
    const run = await runTool('db-setup', { ...setupEnv, PDS_DB_NAME: `${NAME}_weak`, PDS_DB_USER: `${NAME}_weak`, PDS_DB_PASSWORD: 'abc' })
    expect(run.result.code).toBe('password_policy')
    expect(run.exitCode).toBe(3)
    // Die Datenbank wurde schon angelegt, bevor das Login scheiterte: aufräumen
    await admin(`IF DB_ID(N'${NAME}_weak') IS NOT NULL BEGIN ALTER DATABASE [${NAME}_weak] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${NAME}_weak] END`)
  })

  it('refuses_a_sysadmin_as_app_user', async () => {
    // Ein Login mit Administratorrechten (hier ein eigenes statt sa, damit ein Fehler den Server nicht beschädigt)
    const original = 'Orig-Pa55w0rd!x'
    await admin(`CREATE LOGIN [${SYSADMIN}] WITH PASSWORD = N'${original}'; ALTER SERVER ROLE sysadmin ADD MEMBER [${SYSADMIN}]`)

    const run = await runTool('db-setup', { ...setupEnv, PDS_DB_NAME: `${NAME}_sysadmin`, PDS_DB_USER: SYSADMIN, PDS_DB_PASSWORD: 'Anderes-Pa55w0rd!y' })

    expect(run.result.code).toBe('permission_denied')
    expect(run.exitCode).toBe(3)
    expect(run.result.message).toBe('Der App-Benutzer darf kein Administrator-Login sein – bitte ein eigenes Login für den EPLAN Panel Data Service verwenden')
    // Vor jedem Batch abgelehnt: nur die Verbindung gelang, nichts wurde angelegt
    expect(run.steps.map(line => `${line.code}:${line.ok}`)).toEqual(['connect:true', 'login:false'])
    expect(run.steps.at(-1)?.details).toMatchObject({ error: 'permission_denied', reason: 'sysadmin' })
    expect(await databaseExists(`${NAME}_sysadmin`)).toBe(false)
    // Das Passwort des Logins ist unverändert
    expect((await runTool('db-test', { NUXT_DATABASE_URL: urlFor(SYSADMIN, original, 'master') })).result.ok).toBe(true)
    expect((await runTool('db-test', { NUXT_DATABASE_URL: urlFor(SYSADMIN, 'Anderes-Pa55w0rd!y', 'master') })).result.code).toBe('login_failed')
  })

  it('refuses_sa_as_app_user', async () => {
    // Mit dem echten Passwort von sa: Selbst ein Fehler der Prüfung ließe es unverändert
    const saPassword = decodeURIComponent(server.password)
    for (const user of ['sa', 'SA']) {
      const run = await runTool('db-setup', { ...setupEnv, PDS_DB_NAME: `${NAME}_sa`, PDS_DB_USER: user, PDS_DB_PASSWORD: saPassword })
      expect(run.result.code, user).toBe('permission_denied')
      expect(run.exitCode).toBe(3)
      expect(await databaseExists(`${NAME}_sa`), user).toBe(false)
    }
    expect((await runTool('db-test', { NUXT_DATABASE_URL: TEST_SERVER_URL })).result.ok).toBe(true)
  })

  it('refuses_the_admin_login_as_app_user', async () => {
    // Derselbe Login als Admin und als App-Benutzer, auch in anderer Schreibweise
    for (const user of [NAME, NAME.toUpperCase()]) {
      const run = await runTool('db-setup', {
        PDS_ADMIN_DATABASE_URL: urlFor(NAME, PASSWORD, 'master'),
        PDS_DB_NAME: `${NAME}_same`,
        PDS_DB_USER: user,
        PDS_DB_PASSWORD: 'Anderes-Pa55w0rd!y',
      })
      expect(run.result.code, user).toBe('permission_denied')
      expect(run.steps.at(-1)).toMatchObject({ code: 'login', ok: false, details: { reason: 'same_as_admin' } })
      expect(await databaseExists(`${NAME}_same`)).toBe(false)
    }
    expect((await runTool('db-test', { NUXT_DATABASE_URL: appUrl })).result.ok).toBe(true)
  })

  it('refuses_system_databases', async () => {
    const before = await adminRows('SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = N\'model\'')
    for (const dbName of ['model', 'MODEL', 'master', 'msdb', 'tempdb']) {
      const run = await runTool('db-setup', { ...setupEnv, PDS_DB_NAME: dbName })
      expect(run.result.ok, dbName).toBe(false)
      expect(run.result.message).toContain('Systemdatenbank')
      // Ohne Verbindung abgelehnt
      expect(run.steps).toEqual([])
    }
    // model unverändert: Snapshot-Einstellung gleich, kein Benutzer des App-Logins darin
    expect(await adminRows('SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = N\'model\'')).toEqual(before)
    expect(await adminRows(`SELECT name FROM sys.database_principals WHERE name = N'${NAME}'`, 'model')).toEqual([])
    expect((await runTool('db-script', { PDS_DB_NAME: 'model', PDS_DB_USER: 'usr' })).result.ok).toBe(false)
  })

  it('request_timeout_is_reported_as_timeout', async () => {
    const session = await DatabaseSession.open('NUXT_DATABASE_URL', TEST_SERVER_URL, { requestTimeoutMs: 1_000 })
    try {
      await expect(session.query('WAITFOR DELAY \'00:00:05\'')).rejects.toMatchObject({
        code: 'timeout',
        message: 'Die Anweisung dauerte länger als 1 Sekunde.',
      })
    }
    finally {
      await session.close()
    }
  })

  it('wrong_password', async () => {
    const run = await runTool('db-test', { NUXT_DATABASE_URL: urlFor('sa', 'falsch', 'master') })
    expect(run.result).toMatchObject({ ok: false, code: 'login_failed' })
    expect(run.exitCode).toBe(3)
    expect(run.steps).toEqual([expect.objectContaining({ code: 'connect', ok: false, details: expect.objectContaining({ error: 'login_failed' }) })])
  })

  it('missing_database', async () => {
    const run = await runTool('db-test', { NUXT_DATABASE_URL: urlFor(server.username, decodeURIComponent(server.password), 'pds_test_nodetools_gibt_es_nicht') })
    expect(run.result).toMatchObject({ ok: false, code: 'database_missing' })
    expect(run.exitCode).toBe(3)
  })

  it('refused', async () => {
    const run = await runTool('db-test', { NUXT_DATABASE_URL: 'mssql://sa:x@127.0.0.1:1/master?trustServerCertificate=true' })
    expect(run.result).toMatchObject({ ok: false, code: 'connection_refused' })
    expect(run.exitCode).toBe(3)
  })

  it('dns_failed', async () => {
    const run = await runTool('db-test', { NUXT_DATABASE_URL: 'mssql://sa:x@gibt-es-nicht.invalid:1433/master' })
    expect(run.result).toMatchObject({ ok: false, code: 'dns_failed' })
  })

  it('tls_untrusted', async () => {
    // Der Entwicklungsserver hat ein selbstsigniertes Zertifikat
    const url = new URL(TEST_SERVER_URL)
    url.search = ''
    const run = await runTool('db-test', { NUXT_DATABASE_URL: url.toString() })
    expect(run.result).toMatchObject({ ok: false, code: 'tls_untrusted' })
    expect(run.result.message).toContain('trustServerCertificate')
  })

  it('invalid_url', async () => {
    for (const value of ['kein url', 'http://sa:x@host/db', 'mssql://sa:%zz@host/db']) {
      const run = await runTool('db-test', { NUXT_DATABASE_URL: value })
      expect(run.result.code, value).toBe('invalid_url')
      expect(run.exitCode).toBe(3)
      // Die Meldung nennt die Variable, aber nie den Wert
      expect(run.raw.join('\n')).not.toContain(value)
    }
    const admin = await runTool('db-setup', { ...setupEnv, PDS_ADMIN_DATABASE_URL: 'kein url' })
    expect(admin.result.code).toBe('invalid_url')
    expect(admin.result.message).toContain('PDS_ADMIN_DATABASE_URL')
  })

  it('never_prints_secrets', async () => {
    const secret = 'Streng-Geheim-1A'
    const runs = [
      await runTool('db-test', { NUXT_DATABASE_URL: `mssql://sa:${secret}@127.0.0.1:1/master` }),
      await runTool('db-test', { NUXT_DATABASE_URL: urlFor('sa', secret, 'master') }),
      await runTool('db-setup', { ...setupEnv, PDS_ADMIN_DATABASE_URL: urlFor('sa', secret, 'master'), PDS_DB_PASSWORD: 'Anderes-Geheim-1A' }),
    ]
    for (const run of runs) {
      const output = run.raw.join('\n')
      expect(output).not.toContain(secret)
      expect(output).not.toContain(encodeURIComponent(secret))
      expect(output).not.toContain('Anderes-Geheim-1A')
    }
  })
})

describe('classifyDatabaseError', () => {
  function error(fields: Record<string, unknown>, message = 'Fehler'): Error {
    return Object.assign(new Error(message), fields)
  }
  const code = (value: Error, login: number[] = []) => classifyDatabaseError(value, login).code

  it('maps_connection_errors', () => {
    const cause = (c: string) => ({ cause: Object.assign(new Error(c), { code: c }) })
    expect(code(error({ code: 'ESOCKET', ...cause('ENOTFOUND') }))).toBe('dns_failed')
    expect(code(error({ code: 'ESOCKET', ...cause('EAI_AGAIN') }))).toBe('dns_failed')
    expect(code(error({ code: 'ESOCKET', ...cause('ECONNREFUSED') }))).toBe('connection_refused')
    expect(code(error({ code: 'ESOCKET', ...cause('EHOSTUNREACH') }))).toBe('connection_refused')
    expect(code(error({ code: 'ESOCKET', ...cause('ETIMEDOUT') }))).toBe('timeout')
    expect(code(error({ code: 'ETIMEOUT' }, 'Failed to connect to x in 15000ms'))).toBe('timeout')
    // Mehrere Adressen (IPv4 und IPv6): die Fehler stecken in einem AggregateError
    const aggregate = new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], 'Could not connect (sequence)')
    expect(code(error({ code: 'ESOCKET', cause: aggregate }))).toBe('connection_refused')
    // Unbekannter Socket-Fehler: bleibt eine Verbindungsstörung, mit dem Text von Node
    const unknown = classifyDatabaseError(error({ code: 'ESOCKET' }, 'Failed to connect to x - wrong version number'), [])
    expect(unknown.code).toBe('connection_refused')
    expect(unknown.message).toContain('wrong version number')
  })

  it('maps_tls_errors', () => {
    for (const tls of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const failure = classifyDatabaseError(error({ code: 'ESOCKET', cause: Object.assign(new Error('x'), { code: tls }) }), [])
      expect(failure.code, tls).toBe('tls_untrusted')
    }
    expect(code(error({ code: 'ESOCKET' }, 'Failed to connect to x - self-signed certificate'))).toBe('tls_untrusted')
  })

  it('maps_login_errors', () => {
    expect(code(error({ code: 'ELOGIN' }, 'Login failed for user \'sa\'.'), [18456])).toBe('login_failed')
    // Fehlt die Datenbank, meldet der Server erst 4060, dann 18456
    expect(code(error({ code: 'ELOGIN' }, 'Login failed for user \'sa\'.'), [4060, 18456])).toBe('database_missing')
    expect(code(error({ code: 'ELOGIN' }), [])).toBe('login_failed')
  })

  it('maps_request_errors', () => {
    for (const number of [229, 262, 297, 300, 916, 15247]) expect(code(error({ code: 'EREQUEST', number })), String(number)).toBe('permission_denied')
    for (const number of [15118, 33062, 33063]) expect(code(error({ code: 'EREQUEST', number })), String(number)).toBe('password_policy')
    expect(code(error({ code: 'EREQUEST', number: 4060 }))).toBe('database_missing')
    expect(code(error({ code: 'EREQUEST', number: 208 }, 'Invalid object name'))).toBe('internal_error')
  })

  it('distinguishes_request_timeout_from_connection_timeout', () => {
    const request = new RequestError('Timeout: Request failed to complete in 120000ms', 'ETIMEOUT')
    const failure = classifyDatabaseError(request, [], { server: 'sql', port: 1433, requestTimeoutMs: 120_000 })
    expect(failure.code).toBe('timeout')
    expect(failure.message).toBe('Die Anweisung dauerte länger als 120 Sekunden.')
    expect(failure.message).not.toContain('antwortet nicht')
    // Der Verbindungsaufbau hat einen eigenen Text
    const connection = classifyDatabaseError(error({ code: 'ETIMEOUT' }, 'Failed to connect to sql:1433 in 15000ms'), [], { server: 'sql', port: 1433 })
    expect(connection.code).toBe('timeout')
    expect(connection.message).toContain('antwortet nicht')
  })

  it('unknown_errors_are_internal', () => {
    expect(code(new Error('kaputt'))).toBe('internal_error')
    expect(code('kaputt' as unknown as Error)).toBe('internal_error')
  })
})
