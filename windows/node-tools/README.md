# Node-Werkzeuge für den Windows-Betrieb

Node-Teile des EPLAN Panel Data Services unter Windows, die der Dienst mit dem mitgelieferten `node.exe` ausführt.

- `src/pds-entry.mjs`: Einstieg der App. `build-payload.ps1` legt ihn als `app\pds-entry.mjs` neben das
  unveränderte `.output`. Der Dienst startet `node.exe --use-system-ca app\pds-entry.mjs` und schließt zum
  Beenden stdin; der Einstieg löst dann Nitros geordneten Shutdown (`SIGTERM`-Handler) aus, weil es unter
  Windows kein SIGTERM gibt.
- `src/main.ts` + `src/tools.ts` und Module: Werkzeuge für Datenbank- und OIDC-Prüfung sowie die SQLite-Sicherung.
  `pnpm build` bündelt sie mit esbuild (samt `tedious` und der Datenbankschicht aus `@pds/core`; `node:sqlite` ist in
  Node eingebaut und bleibt außerhalb) zu `dist/pds-tools.mjs`; das
  Paket legt die Datei als `tools\pds-tools.mjs` ab. Aufruf: `node --use-system-ca pds-tools.mjs <befehl>`
  (Rust: `pds_common::tools::run_tool`).

## Protokoll von `pds-tools.mjs`

Eingaben nur über die Umgebung, nie über Argumente. Jede Zeile auf stdout ist ein JSON-Objekt:

```json
{"type":"step","ok":true,"code":"db_owner","message":"…","details":{}}
{"type":"result","ok":true,"code":"ok","message":"…","details":{}}
```

- Zwischenschritte (`step`): `code` ist die Kennung des Schritts (`connect`, `server_version`, `db_owner`,
  `read_committed_snapshot`, `migrations`, `open`, `writable`, `backup`, `discovery`, `issuer`, …). Scheitert
  ein Schritt, steht der Fehlercode in `details.error`. Eine Warnung ist ein Schritt mit `ok: false` und
  `details.warning: true`; sie lässt das Ergebnis ok.
- Abschluss (`result`): genau eine Zeile; `code` ist `ok` oder ein Fehlercode.
- Exit-Code: 0 ok, 3 Prüfung fehlgeschlagen, 1 Bedienfehler oder interner Fehler (`internal_error`).
- Geheimnisse (`NUXT_DATABASE_URL`, `PDS_ADMIN_DATABASE_URL`, `PDS_DB_PASSWORD`, `NUXT_OIDC_CLIENT_SECRET`) werden
  vor der Ausgabe aus allen Texten entfernt. Eine SQLite-URL (`sqlite:<pfad>`) enthält kein Geheimnis: Ihr Pfad steht
  in den Meldungen.

Datenbank-URL: `mssql://…` (SQL Server) oder `sqlite:<absoluter pfad>` – alles nach `sqlite:` ist der rohe Dateipfad,
ohne URL-Kodierung, z. B. `sqlite:C:\ProgramData\EPLAN Panel Data Service\data\pds.db`.

| Befehl | Umgebung | Schritte |
| --- | --- | --- |
| `db-test` (SQL Server) | `NUXT_DATABASE_URL=mssql://…` | `connect`, `server_version`, `db_owner`, `read_committed_snapshot`, `migrations` |
| `db-test` (SQLite) | `NUXT_DATABASE_URL=sqlite:<pfad>` | `open`, `writable`, `sqlite_version`, `migrations`, `legacy` (nur wenn die Tabelle `wiring_files` der .NET-Version existiert) |
| `db-setup` | `PDS_ADMIN_DATABASE_URL` (Admin an `master`), `PDS_DB_NAME`, `PDS_DB_USER`, `PDS_DB_PASSWORD` | `connect`, `database`, `read_committed_snapshot`, `login`, `db_owner`; mit `sqlite:` sofort `not_needed` |
| `db-script` | `PDS_DB_NAME`, `PDS_DB_USER` | – (`result.details.script`) |
| `db-backup` | `NUXT_DATABASE_URL=sqlite:<pfad>`, `PDS_BACKUP_FILE` (absoluter Pfad der neuen Datei) | `open`, `backup`, `verify`; mit `mssql://` sofort `not_supported` |
| `oidc-test` | `NUXT_OIDC_ISSUER`, optional `NUXT_OIDC_CLIENT_ID`, `NUXT_OIDC_CLIENT_SECRET`, `PDS_OIDC_CHECK_CLIENT=1` | `transport` (nur http), `discovery`, `issuer`, `endpoints`, `client` |

Fehlercodes: `invalid_url`, `dns_failed`, `connection_refused`, `timeout`, `tls_untrusted`, `login_failed`,
`database_missing`, `permission_denied`, `password_policy`, `discovery_failed`, `issuer_mismatch`,
`invalid_discovery`, `client_secret_invalid`, `client_secret_expired`, `client_id_unknown`, `internal_error`;
für SQLite `network_path`, `cannot_open`, `read_only`, `locked`, `not_a_database`, `corrupt`, `disk_full`, `io_error`,
`not_found`, `target_exists`; für einen Befehl, der zur gewählten Datenbank nicht passt, `not_needed` (`db-setup` mit
SQLite) und `not_supported` (`db-backup` mit SQL Server).

### SQLite

`db-test` legt **nie** etwas an: Es läuft als Administrator, und ein Ordner oder eine Datei, die es anlegte, bekäme nur
die geerbten (womöglich zu weiten) Rechte statt der strengen, die das Speichern der Konfiguration vergibt. Fehlt die
Datei, meldet es eine neue Datenbank (der Dienst legt sie an), fehlt schon der Ordner, dass das Speichern ihn anlegt;
beides ist ok, die Schritte `writable` und `legacy` entfallen dann. Eine vorhandene Datei öffnet es wie die App (WAL,
`busy_timeout` 5 s, Fremdschlüssel; wie `openSqliteFile`, aber ohne den Ordner anzulegen).

| Schritt | Ergebnis (`details`) |
| --- | --- |
| `open` | `{ path, exists, folderExists, created: false }`. Ein UNC-Pfad (`\\server\…`, `//server/…`) wird vorher abgelehnt: `network_path`; ein Teil des Pfads, der eine Datei ist, oder der Pfad als Ordner: `cannot_open`. |
| `writable` | `{ journalMode }`. Ein echter, festgeschriebener Schreibvorgang ohne Spur: In einer `BEGIN IMMEDIATE`-Transaktion bekommt `PRAGMA user_version` seinen eigenen Wert. SQLite schreibt dabei Seite 1 neu (in die `-wal`-Datei); Daten und Schema-Version bleiben gleich. Scheitert er: `read_only` (bzw. `locked`). Ist `journal_mode` nicht `wal`, ist der Schritt eine Warnung (`warnings: ['writable']`). |
| `sqlite_version` | `{ version }` |
| `migrations` | `{ core, pds }` aus `core_migrations` / `pds_migrations` (0, wenn die Tabelle fehlt) |
| `legacy` | `{ rows }` – nur, wenn `wiring_files` der .NET-Version in der Datei liegt; die Admin-Konsole kann sie übernehmen |

Ergebnis: `{ path, warnings, exists, folderExists }`. Fehlercodes aus den Ergebniscodes von SQLite (`errcode & 0xff`) bzw. des
Dateisystems: `cannot_open` (SQLITE_CANTOPEN, SQLITE_PERM, EACCES, EPERM, ENOENT, ENOTDIR, EISDIR, EEXIST),
`read_only` (SQLITE_READONLY, EROFS), `locked` (SQLITE_BUSY, SQLITE_LOCKED, EBUSY – z. B. der alte .NET-Dienst, eine
Sicherung oder ein Virenscanner hält die Datei), `not_a_database` (SQLITE_NOTADB), `corrupt` (SQLITE_CORRUPT),
`disk_full` (SQLITE_FULL, ENOSPC), `io_error` (SQLITE_IOERR, EIO), sonst `internal_error`. `details` nennt `path` und
`sqliteCode`/`sqliteMessage` bzw. `systemCode`. Bei Rechteproblemen weist die Meldung darauf hin, dass das Dienstkonto
`NT SERVICE\pds` „Ändern“ auf dem Ordner braucht (SQLite legt dort `-wal` und `-shm` an). Achtung: Das Werkzeug läuft
als Administrator; ein erfolgreicher Test beweist nicht, dass auch das Dienstkonto schreiben darf.

`db-backup` sichert im laufenden Betrieb über die Backup-API von SQLite (`backup()` aus `node:sqlite`, alle Seiten in
einem Schritt, also ein stimmiger Stand; der Dienst schreibt währenddessen weiter):

- `open`: Die Quelle muss existieren (`not_found`), sie wird weder angelegt noch umgestellt. `details: { path }`.
- `backup`: Die Zieldatei wird exklusiv angelegt (`wx`): Gibt es unter dem Namen schon etwas, auch einen Verweis ohne
  Ziel, ist das `target_exists`, nichts wird überschrieben. Ihr Ordner muss existieren (`cannot_open`). Die Sicherung
  füllt genau diese leere Datei; wurde sie zwischendurch ersetzt (andere Dateinummer), ist das `cannot_open`.
  `details: { pages }`.
- `verify`: Die Kopie wird auf `journal_mode = DELETE` gestellt (eine einzelne Datei ohne `-wal`/`-shm`) und mit
  `PRAGMA integrity_check` geprüft (`corrupt`).
- Ergebnis: `{ file, bytes }`. Scheitert `backup` oder `verify`, wird nur gelöscht, was dieser Aufruf angelegt hat
  und was noch dieselbe Datei ist (Begleitdateien, die schon vorher da waren, bleiben).

`src/setup-sql.ts` hält das T-SQL von `db-setup`/`db-script`; ein Test vergleicht es mit dem Heredoc in
`docker/mssql/init.sh`, damit Entwicklung (Docker) und Windows-Betrieb dasselbe tun. Das DBA-Skript bricht vor dem ersten Batch ab,
solange `DB_PASSWORD` noch der Platzhalter ist.

Schutz von `db-setup` (vor dem ersten Batch, sonst Ablehnung ohne Änderung):

- Der App-Benutzer darf kein Administrator-Login sein (`sysadmin`) und nicht das Login des Admins selbst:
  `permission_denied`, Schritt `login`, `details.reason` = `sysadmin` bzw. `same_as_admin`. Grund: `ALTER LOGIN` setzt
  das Passwort neu.
- Der Datenbankname darf keine Systemdatenbank sein (`master`, `model`, `msdb`, `tempdb`, ohne Beachtung von Groß-/
  Kleinschreibung): Bedienfehler, Exit 1. Dieselbe Regel gilt in Rust als Befund `system_database_not_allowed`.
- Eine einzelne Anweisung darf bis zu 120 s dauern (`CREATE`/`ALTER DATABASE`); Rust nutzt dafür
  `tools::SETUP_TIMEOUT`. Ein Überschreiten meldet `timeout` („Die Anweisung dauerte länger als …“).

`pnpm build` schreibt neben das Bündel `dist/pds-tools.mjs.LEGAL.txt` (Lizenzhinweise der gebündelten Pakete).

```sh
pnpm --filter @pds/node-tools build
pnpm --filter @pds/node-tools test   # braucht pnpm db:up
TEST_DATABASE=sqlite pnpm --filter @pds/node-tools test   # ohne Docker: die SQL-Server-Tests werden übersprungen
pnpm --filter @pds/node-tools lint
pnpm --filter @pds/node-tools typecheck
```
