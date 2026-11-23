// T-SQL zum Einrichten von Datenbank und App-Login. Inhaltsgleich mit dem Heredoc in
// docker/mssql/init.sh (ein Test vergleicht beide), damit Entwicklung (Docker) und Windows-Betrieb dasselbe tun.

export interface SetupValues {
  dbName: string
  dbUser: string
  dbPassword: string
}

// Eine Anweisungsgruppe je GO. Platzhalter im sqlcmd-Stil: im Skript bleiben sie stehen, bei der
// Ausführung durch das Werkzeug werden sie ersetzt.
const BATCHES = [
  `IF DB_ID(N'$(DB_NAME)') IS NULL
  CREATE DATABASE [$(DB_NAME)];`,
  `-- Leser blockieren Schreiber nicht (Zeilenversionierung)
ALTER DATABASE [$(DB_NAME)] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;`,
  `IF SUSER_ID(N'$(DB_USER)') IS NULL
  CREATE LOGIN [$(DB_USER)] WITH PASSWORD = N'$(DB_PASSWORD)';
ELSE
  ALTER LOGIN [$(DB_USER)] WITH PASSWORD = N'$(DB_PASSWORD)';`,
  `USE [$(DB_NAME)];
IF USER_ID(N'$(DB_USER)') IS NULL
  CREATE USER [$(DB_USER)] FOR LOGIN [$(DB_USER)];
ALTER ROLE db_owner ADD MEMBER [$(DB_USER)];`,
]

/** Kennungen der Batches, in der Reihenfolge von {@link setupBatches} */
export const SETUP_STEPS = ['database', 'read_committed_snapshot', 'login', 'db_owner'] as const

/**
 * Systemdatenbanken fasst die Einrichtung nie an: In `model` würde sie Snapshot-Einstellung und
 * db_owner-Benutzer in jede künftig angelegte Datenbank vererben, `master` und `msdb` gehören dem Server.
 */
export const SYSTEM_DATABASES = ['master', 'model', 'msdb', 'tempdb']

/** Namen landen in Bezeichnern ([…]) und Literalen ('…'); beides bricht bei ] bzw. ' */
export function assertValidNames(dbName: string, dbUser: string): void {
  const entries = [['DB_NAME', dbName], ['DB_USER', dbUser]] as const
  for (const [label, value] of entries) {
    if (!value) throw new Error(`${label} fehlt`)
    if (/[\]'\0]/.test(value)) throw new Error(`${label} darf weder ] noch ' enthalten`)
  }
  // SQL Server vergleicht Namen ohne Groß-/Kleinschreibung und ohne Leerzeichen am Ende
  if (SYSTEM_DATABASES.includes(dbName.trim().toLowerCase())) {
    throw new Error(`DB_NAME darf keine SQL-Server-Systemdatenbank sein (${SYSTEM_DATABASES.join(', ')}): bitte eine eigene Datenbank für den EPLAN Panel Data Service verwenden`)
  }
}

function substitute(template: string, values: SetupValues): string {
  // Eine Funktion als Ersatz: Sonderfolgen wie $& im Passwort bleiben wörtlich, und ein
  // eingesetzter Wert wird nicht noch einmal durchsucht
  return template.replace(/\$\((DB_NAME|DB_USER|DB_PASSWORD)\)/g, (_, name: string) => {
    if (name === 'DB_NAME') return values.dbName
    if (name === 'DB_USER') return values.dbUser
    return values.dbPassword
  })
}

/** Die vier Batches mit eingesetzten Werten (Passwort für ein N'…'-Literal: ' verdoppelt) */
export function setupBatches(values: SetupValues): string[] {
  assertValidNames(values.dbName, values.dbUser)
  if (!values.dbPassword) throw new Error('DB_PASSWORD fehlt')
  const quoted = { ...values, dbPassword: values.dbPassword.replaceAll('\'', '\'\'') }
  return BATCHES.map(batch => substitute(batch, quoted))
}

/** Passwortplatzhalter im Skript: Die DBAs tragen das Passwort ein, das der Betreiber bekommt */
const PLACEHOLDER_PARTS = ['<PASSWORT HIER ', 'EINTRAGEN>'] as const
export const PASSWORD_PLACEHOLDER = PLACEHOLDER_PARTS.join('')

/** In einem sqlcmd-Wert in Anführungszeichen steht " doppelt */
function sqlcmdValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** Dieselben Anweisungen als sqlcmd-Skript (SSMS im SQLCMD-Modus oder `sqlcmd -i`) */
export function setupScript(values: { dbName: string, dbUser: string }): string {
  assertValidNames(values.dbName, values.dbUser)
  const lines = [
    '-- EPLAN Panel Data Service: Datenbank und Login einrichten (sqlcmd-Skript).',
    '-- Die Anweisungen entsprechen docker/mssql/init.sh des Projekts.',
    '--',
    '-- Ausführen mit einem Login mit sysadmin-Rechten: in SSMS im SQLCMD-Modus (Abfrage > SQLCMD-Modus)',
    '-- oder mit  sqlcmd -S <server> -U <admin> -i <datei>',
    '-- Vorher DB_PASSWORD setzen und das Passwort dem Betreiber des EPLAN Panel Data Services mitteilen.',
    '-- Im Passwort Hochkommas verdoppeln (\'\') und Anführungszeichen verdoppeln ("").',
    '-- Das Skript ist wiederholbar. Ein weiterer Lauf setzt das Passwort des Logins neu und trennt',
    '-- dabei offene Verbindungen zur Datenbank.',
    `:setvar DB_NAME ${sqlcmdValue(values.dbName)}`,
    `:setvar DB_USER ${sqlcmdValue(values.dbUser)}`,
    `:setvar DB_PASSWORD ${sqlcmdValue(PASSWORD_PLACEHOLDER)}`,
    // Wie -b bei sqlcmd: beim ersten Fehler abbrechen statt mit halbem Stand weiterzumachen
    ':on error exit',
    '',
    // Ohne eingetragenes Passwort würde das Login mit dem Platzhalter als Passwort angelegt: vor dem ersten Batch
    // abbrechen. Der Platzhalter ist hier geteilt, damit „alles ersetzen“ (Skript, Pipeline) die Prüfung nicht
    // mit ersetzt: Sonst stünde dort das echte Passwort, und das Skript bräche ausgerechnet dann ab.
    `IF N'$(DB_PASSWORD)' = N'${PLACEHOLDER_PARTS[0]}' + N'${PLACEHOLDER_PARTS[1]}' RAISERROR(N'Bitte zuerst DB_PASSWORD setzen', 16, 1);`,
    'GO',
  ]
  for (const batch of BATCHES) lines.push(batch, 'GO')
  return `${lines.join('\n')}\n`
}
