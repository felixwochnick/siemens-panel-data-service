import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { setupBatches, setupScript } from '../src/setup-sql'

const initSh = readFileSync(fileURLToPath(new URL('../../../docker/mssql/init.sh', import.meta.url)), 'utf8')

/** Kommentare und Leerraum spielen keine Rolle, nur die Anweisungen */
function normalize(sql: string): string {
  return sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim()
}

/** Der Heredoc `<<'SQL' … SQL` aus init.sh, an GO geteilt */
function heredocBatches(): string[] {
  const match = /<<'SQL'\n([\s\S]*?)\n^SQL$/m.exec(initSh)
  if (!match?.[1]) throw new Error('Heredoc in docker/mssql/init.sh nicht gefunden')
  return match[1].split(/^GO$/m).map(normalize).filter(Boolean)
}

const placeholders = { dbName: '$(DB_NAME)', dbUser: '$(DB_USER)', dbPassword: '$(DB_PASSWORD)' }

describe('setupBatches', () => {
  it('matches_init_sh', () => {
    const expected = heredocBatches()
    expect(expected).toHaveLength(4)
    expect(setupBatches(placeholders).map(normalize)).toEqual(expected)
  })

  it('quotes_password', () => {
    const batches = setupBatches({ dbName: 'pds', dbUser: 'pds_app', dbPassword: 'o\'brien' })
    // CREATE LOGIN und ALTER LOGIN
    expect(batches[2]?.match(/N'o''brien'/g)).toHaveLength(2)
    expect(batches.join('\n')).not.toContain('$(DB_PASSWORD)')
  })

  it('inserts_values_literally', () => {
    // Sonderfolgen von String.replace und Platzhalter im Passwort bleiben unberührt
    const password = '$&$1$\'$`$(DB_NAME)'
    const batches = setupBatches({ dbName: 'db', dbUser: 'usr', dbPassword: password })
    expect(batches[2]).toContain(`PASSWORD = N'${password.replaceAll('\'', '\'\'')}'`)
    expect(batches[0]).toContain('[db]')
  })

  it('rejects_bracket', () => {
    const ok = { dbName: 'db', dbUser: 'usr', dbPassword: 'pw' }
    expect(() => setupBatches({ ...ok, dbName: 'a]b' })).toThrow(']')
    expect(() => setupBatches({ ...ok, dbUser: 'a]b' })).toThrow(']')
    expect(() => setupBatches({ ...ok, dbName: 'a\'b' })).toThrow('\'')
    expect(() => setupBatches({ ...ok, dbUser: 'a\'b' })).toThrow('\'')
    expect(() => setupScript({ dbName: 'a]b', dbUser: 'usr' })).toThrow(']')
  })

  it('rejects_system_databases', () => {
    // master/model/msdb/tempdb: model etwa würde Snapshot-Einstellung und db_owner in jede künftige Datenbank vererben
    const ok = { dbUser: 'usr', dbPassword: 'pw' }
    for (const dbName of ['master', 'model', 'msdb', 'tempdb', 'MODEL', 'Master', ' tempdb ']) {
      expect(() => setupBatches({ ...ok, dbName }), dbName).toThrow('Systemdatenbank')
      expect(() => setupScript({ dbName, dbUser: 'usr' }), dbName).toThrow('Systemdatenbank')
    }
    // Der Benutzer darf so heißen
    expect(() => setupBatches({ dbName: 'db', dbUser: 'model', dbPassword: 'pw' })).not.toThrow()
    expect(() => setupBatches({ ...ok, dbName: 'model_x' })).not.toThrow()
  })

  it('rejects_empty_values', () => {
    const ok = { dbName: 'db', dbUser: 'usr', dbPassword: 'pw' }
    expect(() => setupBatches({ ...ok, dbName: '' })).toThrow('DB_NAME')
    expect(() => setupBatches({ ...ok, dbUser: '' })).toThrow('DB_USER')
    expect(() => setupBatches({ ...ok, dbPassword: '' })).toThrow('DB_PASSWORD')
  })
})

describe('setupScript', () => {
  const script = setupScript({ dbName: 'pds', dbUser: 'pds_app' })

  it('script_has_setvar_and_go', () => {
    expect(script).toContain(':setvar DB_NAME "pds"')
    expect(script).toContain(':setvar DB_USER "pds_app"')
    expect(script).toContain(':setvar DB_PASSWORD "<PASSWORT HIER EINTRAGEN>"')
    // vier Batches und die Prüfung des Passworts davor
    expect(script.match(/^GO$/gm)).toHaveLength(5)
    for (const name of ['DB_NAME', 'DB_USER', 'DB_PASSWORD']) expect(script).toContain(`$(${name})`)
  })

  it('script_batches_match_init_sh', () => {
    // Ohne Kopf (Kommentare, :setvar, :on error) und ohne die Prüfung des Passworts bleiben genau die Batches des Heredocs
    const body = script.split('\n').filter(line => !line.startsWith(':') && !line.startsWith('--')).join('\n')
    const [guard, ...batches] = body.split(/^GO$/m).map(normalize).filter(Boolean)
    expect(guard).toContain('RAISERROR')
    expect(batches).toEqual(heredocBatches())
  })

  it('script_refuses_to_run_without_a_password', () => {
    // sqlcmd setzt $(DB_PASSWORD) ein; steht noch der Platzhalter da, bricht :on error exit vor dem ersten Batch ab
    expect(script).toContain('IF N\'$(DB_PASSWORD)\' = N\'<PASSWORT HIER \' + N\'EINTRAGEN>\' RAISERROR(N\'Bitte zuerst DB_PASSWORD setzen\', 16, 1);\nGO')
    expect(script.indexOf('RAISERROR')).toBeGreaterThan(script.indexOf(':on error exit'))
    expect(script.indexOf('RAISERROR')).toBeLessThan(script.indexOf('CREATE DATABASE'))
  })

  it('script_guard_survives_replace_all', () => {
    // Wer den Platzhalter überall ersetzt (sed, PowerShell -replace), darf die Prüfung nicht mit ersetzen:
    // sonst verglichen sich zwei gleiche Passwörter, und das Skript bräche mit gültigem Passwort ab
    const replaced = script.replaceAll('<PASSWORT HIER EINTRAGEN>', 'Echtes-Pa55wort')
    expect(replaced).toContain(':setvar DB_PASSWORD "Echtes-Pa55wort"')
    expect(replaced).toContain('= N\'<PASSWORT HIER \' + N\'EINTRAGEN>\' RAISERROR')
  })

  it('script_stops_at_first_error', () => {
    expect(script).toContain(':on error exit')
    expect(script.indexOf(':on error exit')).toBeLessThan(script.indexOf('CREATE DATABASE'))
  })

  it('script_escapes_quotes_in_setvar', () => {
    expect(setupScript({ dbName: 'a"b', dbUser: 'u' })).toContain(':setvar DB_NAME "a""b"')
  })
})
