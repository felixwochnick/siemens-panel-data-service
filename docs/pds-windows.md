# EPLAN Panel Data Service unter Windows

Der **EPLAN Panel Data Service** (PDS) liest Daten aus EPLAN-Electric-P8-Projekten: **Verbindungen** (mit der
Markierung #, Verdrillung und Abschirmung), **Kabel** mit Adern, **Schirme** und freie **Texte**. Angemeldete Benutzer
laden Projekte in der **Web-App** hoch (`.zw1`) oder wählen sie aus dem Projektordner, lassen sie analysieren und sehen
die Ergebnisse als Tabellen, die sie filtern und als `.xlsx` oder CSV herunterladen. Jede Analyse bleibt als eigener
**Stand** in der Datenbank erhalten; andere Systeme lesen den jeweils aktuellen Stand über die Sichten `pds.v_current_*`.

Er läuft auf einem **Windows Server 2022 (x64)** mit zwei Windows-Diensten: dem **Web-Dienst** `pds` (Web-App,
Warteschlange, Zeitplan, HTTPS-Proxy) und dem **EPLAN-Worker** `pds-eplan`, der die Projekte mit der EPLAN-API öffnet und
dafür unter einem lizenzierten Benutzerkonto läuft. Ohne Docker und WSL, mit einer **SQLite-Datei** auf dem Server
(Standard der Konfiguration) oder einem **externen SQL Server** (empfohlen, sobald andere Systeme die Ergebnisse
weiterverarbeiten) und Anmeldung über **Microsoft Entra ID**. Die Installation erfolgt per MSI (interaktiv oder still,
auch über SCCM/Intune). Die Infrastruktur (Adresse, TLS, Datenbank, Anmeldung, EPLAN-Worker) richtet man mit einer
Konfigurationsoberfläche oder mit der Kommandozeile `pds` ein, die denselben Funktionsumfang hat; auf Server Core ist die
Kommandozeile der einzige Weg. Die fachlichen Einstellungen (Projektordner, Netzlaufwerk, EPLAN-Pfade, Zeitplan) setzen
Admins in der **Web-App** im Browser.

Einen produktiven Docker-Betrieb gibt es nicht; Docker dient nur der Entwicklung (Abschnitt 16). Entwurf und
Begründungen: `docs/superpowers/specs/2026-11-23-pds-monorepo-design.md`.

1. [Überblick](#1-überblick) · 2. [Installation](#2-installation) · 3. [Erste Einrichtung](#3-erste-einrichtung-schritt-für-schritt) ·
   4. [Entra-App-Registrierung](#4-entra-app-registrierung) · 5. [Datenbank](#5-datenbank) · 6. [Zertifikate](#6-zertifikate) ·
   7. [EPLAN-Worker](#7-eplan-worker) · 8. [Zugriff auf den Projektordner](#8-zugriff-auf-den-projektordner) ·
   9. [Web-App](#9-web-app) · 10. [KI-Assistenten (MCP)](#10-ki-assistenten-mcp) ·
   11. [Update, Deinstallation, Sichern](#11-update-deinstallation-sichern) · 12. [CLI-Referenz](#12-cli-referenz) ·
   13. [Sicherheit](#13-sicherheit) · 14. [Fehlersuche](#14-fehlersuche) ·
   15. [Abnahme-Checkliste](#15-abnahme-checkliste-windows-server-2022) · 16. [Für Entwickler](#16-für-entwickler)

## 1. Überblick

### Bestandteile

| Datei im Installationsordner | Aufgabe |
| --- | --- |
| `pds.exe` | Web-Dienst `pds` und Kommandozeile (`pds …`), auch für die Einrichtung des EPLAN-Workers (`pds eplan …`) |
| `pds-config.exe` | Konfigurationsoberfläche (Tauri, verlangt Administratorrechte, nicht auf Server Core) |
| `caddy.exe` | Proxy: TLS, HTTP/2, Weiterleitung zur App |
| `node\node.exe`, `app\` | Node 24 LTS und die App: Web-App, Warteschlange der Analysen, Zeitplan, MCP (Nuxt-`.output`, Einstieg `app\pds-entry.mjs`) |
| `eplan\pds-eplan.exe` | EPLAN-Worker (.NET Framework 4.8.1, x64) mit seinen Abhängigkeiten; läuft als Dienst `pds-eplan` (Abschnitt 7). Die EPLAN-DLLs gehören **nicht** dazu: Der Worker lädt sie zur Laufzeit aus der EPLAN-Installation des Servers. Fehlt in einem MSI, das ohne EPLAN-DLLs gebaut wurde (Abschnitt 16). |
| `tools\pds-tools.mjs` | Prüfungen, Einrichtung und Sicherung hinter `db test`, `db setup`, `db script`, `db backup` und `oidc test` |
| `licenses\` | Lizenzen von Node und Caddy, Drittanbieter-Lizenzen der Werkzeuge (`pds-tools-THIRD-PARTY.txt`), Hinweis zur WebView2-Runtime |

Die Versionen von Node und Caddy stehen in `windows/vendor.json` und erscheinen in `pds status`.

```
Browser ──443/80──> Caddy (TLS) ──127.0.0.1:3000──> Node (Web-App, Warteschlange, Zeitplan) ──Datei──> data\pds.db (SQLite)
                                                        │                                    oder ──1433──> SQL Server (extern)
                                                        ├──443──> Microsoft Entra ID
                                                        ├──Datei/SMB──> Projektordner (lokal oder Netzfreigabe), Kopie nach work\
                                                        └──Named Pipe \\.\pipe\pds-eplan──> pds-eplan.exe (Dienst pds-eplan, Worker-Konto)
                                                                                                │
                                                                                                └──> EPLAN Platform + Electric P8 (lokal installiert)
                                                                                                     liest uploads\ bzw. work\, schreibt work\<Analyse>\
```

Der Dienst `pds` startet Caddy und Node als Kindprozesse und überwacht sie. Endet ein Kind (Absturz, belegter Port,
SQL Server noch nicht erreichbar, SQLite-Datei gesperrt), startet er es mit wachsender Wartezeit neu (2 s, verdoppelt,
höchstens 5 min). Nach einem Neustart des Servers gibt er also nicht auf, wenn SQL Server später hochkommt. Den Zustand
schreibt er alle 10 s nach `state\status.json`. Den Worker-Dienst `pds-eplan` überwacht er **nicht**: Den startet Windows
selbst, und seine Wiederherstellungsaktionen starten ihn nach einem Fehler neu (Abschnitt 7).

Die eigentliche Arbeit läuft **in der Node-App**: Sie führt eine Warteschlange (höchstens eine Analyse gleichzeitig),
**kopiert** Projekte aus dem Projektordner in einen Arbeitsordner unter `work\` (so verändert EPLAN nie das Original, und
der Worker braucht keine Netzwerkrechte), lässt den Worker die Rohdaten lesen, wertet sie aus und speichert die
Ergebnisse **in einer Transaktion** als neuen Stand (Ablauf in Abschnitt 9).

### Drei Konfigurationsebenen

| Ebene | Inhalt | Wo | Wer ändert |
| --- | --- | --- | --- |
| Infrastruktur | Adresse, TLS, Ports, Datenbank, OIDC/Entra, MCP an/aus, App-Geheimnis (App-Secret), Proxy | `config.toml` im Datenordner (Secrets per DPAPI) | Konfigurationsoberfläche `pds-config.exe`, CLI `pds config …` |
| EPLAN-Worker | Dienst `pds-eplan`, sein Konto und dessen Passwort, Ordnerrechte des Kontos | Windows-Dienststeuerung (das Passwort verwahrt Windows als LSA-Secret), ACL im Datenordner | Konfigurationsoberfläche (Bereich **EPLAN-Worker**), CLI `pds eplan …` (Abschnitt 7) |
| Fachlich | Projektordner, Quelle lokal/Netzlaufwerk, Netzlaufwerk, Dateimuster, EPLAN-Pfade und Öffnungsmodus, Zeitplan (an/aus, Cron, Zeitzone), Zeitlimit, Aufbewahrung, Upload-Grenze | Tabelle `pds.settings` in der Datenbank (Netzlaufwerk-Passwort verschlüsselt mit einem aus dem App-Secret abgeleiteten Schlüssel) | Web-App (**Einstellungen**, nur Admins, Abschnitt 9), MCP ohne Geheimnisse (Abschnitt 10) |

- Die Infrastruktur muss stehen, bevor die Web-App erreichbar ist. Die fachlichen Einstellungen bleiben bei Update,
  Neuinstallation und Umzug in der Datenbank.
- Das **App-Secret** (`app.secret`) signiert Sitzungen und MCP-Zugänge und ist die Grundlage des Schlüssels für das
  Netzlaufwerk-Passwort. Wird es neu erzeugt, sind alle Sitzungen und MCP-Verbindungen ungültig, und ein Admin muss das
  Netzlaufwerk-Passwort neu eintragen (Abschnitt 9). Das Passwort des Worker-Kontos hängt **nicht** daran.
- Der **Zeitplan ist nach der Installation aus** (kein ungewollter erster Lauf über alle Projekte des Ordners).

### Ordner

| Ordner | Inhalt |
| --- | --- |
| `%ProgramFiles%\EPLAN Panel Data Service\` | Programme, nur lesend. Fest, nicht wählbar. Steht im System-`PATH` (neue Shell öffnen). |
| `%ProgramData%\EPLAN Panel Data Service\` | Alles Veränderliche, siehe unten |

Im Datenordner:

| Pfad | Inhalt |
| --- | --- |
| `config.toml` | Infrastruktur-Konfiguration; Secrets nur als `dpapi:<base64>` |
| `tls\certificate.pem`, `tls\key.dpapi` | Zertifikatskette (öffentlich) und privater Schlüssel (DPAPI) |
| `state\status.json` | Status des Dienstes für Oberfläche und CLI |
| `logs\` | `service.log`, `app.log` (Node), `caddy.log` (Caddy); je höchstens 10 MB, 5 Dateien (`.1` bis `.4` ältere). Dazu `eplan-worker-<Datum>.log` des Workers (eine Datei je Tag). Für Admins auch in der Web-App unter **Protokolle** |
| `caddy\` | Caddys Speicher (ACME-Konten und -Zertifikate, interne CA) |
| `data\` | SQLite-Datenbank `pds.db` (Standard, wenn `db.path` leer ist), im Betrieb mit `pds.db-wal` und `pds.db-shm` daneben (Abschnitt 5) |
| `uploads\` | Hochgeladene Projekte (`.zw1`), je Projekt ein Unterordner `uploads\<Projekt-ID>\`. Gehört zu den Daten (Abschnitt 11) |
| `work\` | Arbeitsordner je Analyse (`work\<Analyse-ID>\`: Kopie des Projekts, wiederhergestelltes Archiv, Rohdaten). Werden nach der Analyse gelöscht; nicht sichern |

Den Datenordner legt **ausschließlich** das MSI an (`setup install`, auch `uploads\` und `work\`) und setzt dabei seine
Rechte. Nie von Hand vorab anlegen: Ein vorhandener Ordner, der nicht eindeutig dem Produkt gehört (Besitzer nicht
Administratoren oder SYSTEM, Rechte vom Elternordner geerbt, Verweis statt Ordner, Rechte nicht lesbar), wird nach
`%ProgramData%\EPLAN Panel Data Service (unsicher <Zeitstempel>)` verschoben und neu angelegt (Warnung im
Ereignisprotokoll). **Mit ihm wandern `data\pds.db` und `uploads\`**: Dann den Dienst stoppen und beides von dort
**zurückkopieren** (Abschnitte 5 und 11). Ist nur `data\` kein echter Ordner (etwa eine Junction), bricht `setup install`
stattdessen ab, damit die Datenbank nicht verloren geht: durch einen echten Ordner ersetzen und wiederholen. Ein korrekt
angelegter Datenordner (Update, Deinstallation ohne `REMOVE_DATA=1`) wird übernommen und bekommt seine Rechte neu;
zusätzliche Berechtigungen, die ein Administrator dort eingetragen hat, fallen dabei weg (Warnung „Zusätzliche
Berechtigungen am Datenordner entfernt: …“, Abschnitt 11). Die Rechte des Worker-Kontos bleiben erhalten.

Für Entwicklung und Tests lassen sich beide Ordner mit `PDS_INSTALL_DIR` und `PDS_DATA_DIR` umlenken (Abschnitt 16).

### Dienste und Konten

- **Web-Dienst** `pds`, Anzeigename „EPLAN Panel Data Service“, Beschreibung „Analysiert EPLAN-Electric-P8-Projekte und
  stellt die Ergebnisse in der Datenbank bereit; startet und überwacht dazu die Web-App und den HTTPS-Proxy.“ Starttyp
  **automatisch, verzögert** (die Dienste-Verwaltung zeigt „Automatisch (Verzögerter Start)“), bei Fehlern Neustart nach
  10 s, 60 s und 5 min (Zähler nach 24 h zurückgesetzt). Legt das MSI an.
- Er läuft als `NT SERVICE\pds` (virtuelles Konto, kein Passwort, keine Verwaltung nötig). Auch die Node-App arbeitet mit
  diesem Konto: Sie liest und kopiert die Projekte aus dem Projektordner und verbindet das Netzlaufwerk. Es braucht deshalb
  **Leserechte auf den Projektordner** (Abschnitt 8). Im Netz tritt es als Computerkonto `DOMÄNE\COMPUTERNAME$` auf.
- **Worker-Dienst** `pds-eplan` („EPLAN Panel Data Service – EPLAN-Worker“) unter einem **lizenzierten Benutzerkonto**
  (Worker-Konto). Ihn legt nicht das MSI an, sondern `pds eplan install` (Abschnitt 7). Er spricht mit dem Web-Dienst über
  die Named Pipe `\\.\pipe\pds-eplan` (kein Port, kein Geheimnis) und braucht keinen Zugriff auf den Projektordner.

Rechte im Datenordner (SYSTEM und Administratoren haben überall Vollzugriff, andere Benutzer keinen Zugriff):

| Pfad | `NT SERVICE\pds` | Worker-Konto |
| --- | --- | --- |
| Datenordner selbst, `config.toml`, `tls\` | Lesen | – |
| `state\`, `caddy\`, `data\` | Ändern | – |
| `logs\` | Ändern | Ändern |
| `uploads\` | Ändern | Lesen |
| `work\` | Ändern | Ändern |

Deshalb zeigt `pds status` ohne Administratorrechte „Status nicht lesbar – bitte als Administrator ausführen“
(Abschnitt 14), und das Worker-Konto kann weder `config.toml` noch die Datenbank im Standardordner lesen.

### Ports und Firewall

| Richtung | Port | Zweck | Feld |
| --- | --- | --- | --- |
| eingehend | 443/TCP | HTTPS (Caddy): Web-App, MCP | `public.port` |
| eingehend | 80/TCP | HTTP, leitet auf HTTPS um | `listen.http_port` |
| nur lokal (127.0.0.1) | 3000/TCP | Node | `internal.port` |
| nur lokal | kein Port: Named Pipe `\\.\pipe\pds-eplan` | Web-App ↔ EPLAN-Worker | – |
| ausgehend | 1433/TCP (oder fester Port) | SQL Server (nur bei `db.kind = sqlserver`) | `db.port` |
| ausgehend | 443/TCP | `login.microsoftonline.com` (Entra ID) | – |
| ausgehend | 445/TCP | Dateiserver, wenn der Projektordner auf einer Netzfreigabe liegt (nur der Web-Dienst) | Web-App: Projektordner bzw. Netzlaufwerk |
| ausgehend | nach Vorgabe der EPLAN-Lizenzierung | Lizenzserver von EPLAN, falls das Worker-Konto eine Netzwerklizenz nutzt (nur der Worker) | EPLAN-Lizenzverwaltung |

Die Firewall braucht **nur TCP** (kein HTTP/3). Die Regel „EPLAN Panel Data Service (HTTP/HTTPS)“ (eingehend, Programm
`caddy.exe`) legt `setup install` an, jedes Speichern der Konfiguration gleicht ihre Ports an; scheitert das (etwa per GPO
verwaltete Firewall), ist es nur eine **Warnung**, dann die Ports von Hand freigeben. Ein ausgehender Proxy steht in
`proxy.url` (ohne Zugangsdaten, Oberfläche: **Anmeldung** → „Erweitert“); indirekt erprobt ihn `oidc test`.

### Voraussetzungen

- Windows Server 2022 x64, Desktop Experience oder Server Core; Administratorrechte zum Einrichten. Ob sich EPLAN auf
  Server Core installieren und betreiben lässt, regeln die Systemvoraussetzungen von EPLAN; im Zweifel Desktop
  Experience verwenden.
- **EPLAN Platform und EPLAN Electric P8** auf diesem Server installiert, in der Version, die in der Web-App unter
  **EPLAN-Pfade** eingetragen ist (Standard 2025.0.3), samt .NET Framework 4.8.1 (setzt EPLAN Platform 2025 ohnehin
  voraus; Windows Server 2022 bringt von Haus aus 4.8 mit).
- Ein **Benutzerkonto mit EPLAN-Lizenz** für den Worker (Domäne oder lokal), Anforderungen in Abschnitt 7.
- Nur für SQL Server: ein SQL Server mit **SQL-Login** (gemischter Modus); Windows-Authentifizierung wird nicht
  unterstützt. Mit SQLite (Standard) braucht es keinen Datenbankserver, nur Platz auf einem lokalen Laufwerk.
- Eine Entra-App-Registrierung (Abschnitt 4), ein DNS-Name für den Server und ein TLS-Zertifikat dafür (Abschnitt 6).
- Optional ein Projektordner, lokal oder auf einer Netzfreigabe, mit Leserechten für den Web-Dienst bzw. das
  Computerkonto oder ein eigenes Konto für das Netzlaufwerk (Abschnitt 8). Ohne Projektordner geht nur das Hochladen.

## 2. Installation

Das MSI heißt `pds-<version>-x64.msi`. Es enthält den WebView2-Offline-Installer und ist deshalb rund 300 MB groß; der
größte Teil davon bleibt dauerhaft im Installer-Cache von Windows liegen. **Für den Betrieb muss es den EPLAN-Worker
enthalten** (`eplan\pds-eplan.exe`): Ein MSI, das ohne EPLAN-DLLs gebaut wurde (`build-payload.ps1 -SkipEplanWorker`, so
baut es die CI), enthält ihn nicht, und `pds eplan install` lehnt dann ab. Woher ein MSI mit Worker kommt, steht in
Abschnitt 16; nach der Installation zeigt `pds status` in der Zeile „EPLAN-Worker“ „fehlt in dieser Installation“, wenn
er fehlt.

### Interaktiv

MSI als Administrator starten (Doppelklick), den Hinweis zu interner Software und Drittanbieter-Lizenzen bestätigen,
installieren. Der Ordner ist nicht wählbar. Das MSI

1. kopiert die Programme (auch `eplan\`), trägt den Ordner in den System-`PATH` ein und legt im Startmenü „EPLAN Panel
   Data Service – Konfiguration“ an,
2. registriert den Web-Dienst `pds` (Konto, verzögerter Start),
3. richtet den Datenordner ein (`setup install`) samt `uploads\` und `work\`, erzeugt das App-Secret (nur, wenn noch
   keins existiert; es wird nie angezeigt), registriert die Ereignisquelle `pds`, legt die Firewall-Regel an und setzt
   die Wiederherstellung des Dienstes,
4. startet den Dienst, ohne auf „läuft“ zu warten (der erste Start dauert rund 20 s, Abschnitt 14),
5. installiert die WebView2-Runtime, falls sie fehlt.

Den **Worker-Dienst `pds-eplan` legt das MSI nicht an**: Sein Konto ist erst bei der Einrichtung bekannt (Abschnitt 7).
Kurz danach steht der Web-Dienst im Zustand **nicht eingerichtet** (`unconfigured`): Das ist richtig, Caddy und Node
starten erst mit gültiger Konfiguration. Auch danach analysiert er nichts von selbst (Zeitplan aus, Worker fehlt).

### Still

```powershell
msiexec /i pds-<version>-x64.msi /qn /l*v C:\Temp\pds-install.log
```

Exit-Code 0 heißt Erfolg. Das MSI hat **bewusst keine Properties für die Konfiguration** (sie stünden in MSI-Log und
Prozessargumenten): Konfiguriert wird danach per CLI, auch der Worker. Die einzige Property ist `REMOVE_DATA` bei der
Deinstallation. Eine neuere Version über eine ältere installieren geht genauso (Abschnitt 11).

Weitere Exit-Codes von `msiexec`: **3010** (Erfolg, Neustart erforderlich) und **1641** (Erfolg, Neustart ausgelöst); SCCM
und Intune werten sie als Neustart-Codes, 1618 als „Wiederholen“. Das MSI fordert von sich aus keinen Neustart; die Codes
kämen nur bei gesperrten Dateien. Das Beispielskript unten lässt 3010 mit Warnung durch und bricht sonst ab.

### SCCM und Intune

Das MSI installiert nur. Die Konfiguration der Infrastruktur und die Einrichtung des Workers folgen als Skriptschritt im
Paket. Secrets gehören **nicht ins Paket**, sondern kommen aus der Secret-Verwaltung der Verteilung und gehen per stdin an
die CLI. Die fachlichen Einstellungen (Projektordner, EPLAN-Pfade, Zeitplan) sind nicht Teil der Verteilung: Sie liegen in
der Datenbank und werden danach in der Web-App gesetzt (Abschnitt 3). EPLAN selbst installiert das Paket ebenfalls nicht;
es muss vor der ersten Analyse auf dem Server sein und für das Worker-Konto lizenziert.

Konfigurationsdatei `pds.toml` im Paket (Exportformat von `config export`; Secrets stehen als `***` und behalten so
ihren Wert, auch das bei der Installation erzeugte App-Secret). Das Beispiel verwendet SQL Server; mit SQLite reicht im
Abschnitt `[db]` die Zeile `kind = "sqlite"` (und bei Bedarf `path = "D:\\PDS\\pds.db"`, in TOML mit doppelten
Backslashes), das Datenbankpasswort und Schritt 6 des Skripts entfallen dann bis auf `db test`:

```toml
schema = 1
[public]
host = "pds.example.com"
[tls]
mode = "certificate"
[db]
kind = "sqlserver"
server = "sql01.example.com"
database = "pds"
user = "pds_app"
password = "***"
[oidc]
tenant_id = "11111111-2222-3333-4444-555555555555"
client_id = "66666666-7777-8888-9999-000000000000"
client_secret = "***"
[app]
secret = "***"
```

`config import` ersetzt die **gesamte** Infrastruktur-Konfiguration: Fehlende Abschnitte und Felder erhalten ihren
**Standardwert** (Tabelle in Abschnitt 12), fehlende Secrets werden **gelöscht**. Deshalb alles, was vom Standard abweicht
(auch Ports oder `proxy.url`), in die Datei schreiben und Secrets, die bleiben sollen, als `***` (ein fehlendes
`app.secret` machte auch das Netzlaufwerk-Passwort in der Datenbank unlesbar). Der Worker gehört nicht in die Datei.

Beispielskript `install.ps1` (läuft als SYSTEM bzw. Administrator; `DEPLOY_DB_PASSWORD`, `DEPLOY_OIDC_CLIENT_SECRET`,
`DEPLOY_PFX_PASSWORD` und `DEPLOY_EPLAN_PASSWORD` liefert die Verteilung, zum Beispiel als geschützte
Umgebungsvariablen):

```powershell
$ErrorActionPreference = 'Stop'
$msi       = (Get-ChildItem -Path $PSScriptRoot -Filter 'pds-*-x64.msi').FullName
$config    = Join-Path $PSScriptRoot 'pds.toml'
$pfx       = Join-Path $PSScriptRoot 'pds.pfx'
$cli       = Join-Path $env:ProgramFiles 'EPLAN Panel Data Service\pds.exe'   # PATH gilt erst in neuen Shells
$folder    = 'D:\EPLAN\Projekte'                                               # Projektordner (Abschnitt 8), optional
$eplanUser = 'EXAMPLE\svc-eplan'                                               # Worker-Konto mit EPLAN-Lizenz (Abschnitt 7)

# Sonst gehen Umlaute und Sonderzeichen in Secrets auf dem Weg durch die Pipe verloren (Windows PowerShell 5.1)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Test-Exit([string] $step) {
    if ($LASTEXITCODE -ne 0) { throw "$step fehlgeschlagen (Exit-Code $LASTEXITCODE)" }
}

# 1. Installation, still und mit Log (3010 = Neustart erforderlich: kein Fehler, aber melden)
$install = Start-Process msiexec.exe -Wait -PassThru -ArgumentList '/i', "`"$msi`"", '/qn', '/l*v', "`"$env:TEMP\pds-install.log`""
switch ($install.ExitCode) {
    0       { }
    3010    { Write-Warning 'msiexec meldet 3010: Neustart erforderlich (die Einrichtung läuft trotzdem weiter)' }
    default { throw "msiexec endete mit Exit-Code $($install.ExitCode)" }
}

# 2. Konfiguration ohne Secrets, danach die Secrets einzeln über stdin
& $cli config import $config;                                                  Test-Exit 'config import'
$env:DEPLOY_DB_PASSWORD        | & $cli config set db.password --stdin;         Test-Exit 'db.password'
$env:DEPLOY_OIDC_CLIENT_SECRET | & $cli config set oidc.client_secret --stdin;  Test-Exit 'oidc.client_secret'

# 3. Zertifikat: PFX-Passwort über stdin
$env:DEPLOY_PFX_PASSWORD | & $cli tls import --pfx $pfx --password-stdin;      Test-Exit 'tls import'

# 4. Leserecht des Web-Dienstes auf den Projektordner
icacls $folder /grant 'NT SERVICE\pds:(OI)(CI)RX';                             Test-Exit 'icacls'

# 5. EPLAN-Worker: prüft die Anmeldung des Kontos, legt den Dienst pds-eplan an und startet ihn (Exit-Code 3 bei falschem Passwort)
$env:DEPLOY_EPLAN_PASSWORD | & $cli eplan install --user $eplanUser --password-stdin;   Test-Exit 'eplan install'

# 6. Datenbank prüfen (Exit-Code 3 bei Fehlschlag), dann übernehmen und auf die App warten
& $cli db test;                                                                Test-Exit 'db test'
& $cli service restart --wait --timeout 180;                                   Test-Exit 'service restart'
```

Hinweise:

- `service restart --wait` wartet einen noch laufenden ersten Start (rund 20 s, Abschnitt 14) ab und danach auf eine
  gesunde App.
- Mit SQL Server richten die DBAs Datenbank und Login vorher ein (Abschnitt 5), sonst scheitert `db test`. Mit SQLite legt
  `db test` nichts an; die Datei legt der Dienst beim Start an.
- Schritt 4 entfällt ohne Projektordner oder wenn er auf einer Netzfreigabe liegt (Rechte dann auf dem Dateiserver,
  Abschnitt 8). Schritt 5 ändert nichts, wenn die Anmeldung des Kontos scheitert (Exit-Code 3); ein MSI ohne Worker lässt
  ihn mit Exit-Code 1 scheitern.
- Updates: nur den `msiexec`-Schritt verteilen; Konfiguration, Zertifikat, Worker samt Konto und Datenbank bleiben.
- Erkennungsregel: die Datei `%ProgramFiles%\EPLAN Panel Data Service\pds.exe` (der ProductCode ändert sich mit jedem
  Build). PFX und Konfigurationsdatei danach aus dem Paketcache der Verteilung entfernen.

### WebView2 offline

Die Konfigurationsoberfläche braucht die WebView2-Runtime. Das MSI bringt den **Offline-Installer** (Evergreen Standalone,
x64) mit und führt ihn still aus, aber nur, wenn die Runtime fehlt (Registry-Prüfung). Ein Internetzugang ist nicht nötig.
Scheitert die Installation der Runtime, bricht das MSI nicht ab: Dienste und CLI funktionieren dann trotzdem. Danach hält
Windows bzw. Edge Update die Runtime aktuell.

### Server Core

Dort läuft WebView2 nicht, also auch die Oberfläche nicht. Installation still wie oben (die Runtime-Installation darf
scheitern), Einrichtung der Infrastruktur und des Workers **ausschließlich per CLI** (Abschnitt 3, rechte Spalte). Dateien
wie das PFX per `Copy-Item` über eine Remote-Sitzung oder per Dateifreigabe auf den Server bringen. Die Web-App öffnet man
im Browser eines anderen Rechners (`https://<Hostname>`). Zu EPLAN auf Server Core siehe Abschnitt 1, „Voraussetzungen“.

## 3. Erste Einrichtung Schritt für Schritt

Die Einrichtung hat zwei Teile: zuerst **Infrastruktur und EPLAN-Worker** am Server (Konfigurationsoberfläche oder CLI),
dann die **fachlichen Einstellungen** in der Web-App.

### Infrastruktur und Worker: Konfigurationsoberfläche oder CLI

Konfigurationsoberfläche: Startmenü „EPLAN Panel Data Service – Konfiguration“ (verlangt Administratorrechte,
UAC-Abfrage). Links die Bereiche **Status**, **Adresse und TLS**, **Datenbank**, **Anmeldung**, **KI-Assistenten** und
**EPLAN-Worker**, unten die Leiste mit **Speichern** und dem Prüfstatus. CLI: eine Eingabeaufforderung oder PowerShell als
Administrator.

| Schritt | Konfigurationsoberfläche | CLI |
| --- | --- | --- |
| 1. Adresse | **Adresse und TLS** → Hostname (ohne Schema und Port), Öffentlicher Port | `pds config set public.host pds.example.com` |
| 2. Zertifikat | **Adresse und TLS** → Modus „Zertifikat“ → „PFX-Datei …“, „PEM-Dateien …“ oder „Aus Zertifikatspeicher …“ (Abschnitt 6) | `pds tls import --pfx C:\Temp\pds.pfx` |
| 3. Datenbank wählen | **Datenbank** → „SQLite (Datei)“ (Standard; Datei leer lassen für `data\pds.db`) oder „SQL Server“ mit Server, Port, Datenbank, Benutzer (SQL-Login), Passwort (Abschnitt 5; SQL Server ist empfohlen, wenn andere Systeme die Ergebnisse lesen sollen) | SQLite: nichts (oder `pds config set db.path D:\PDS\pds.db`); SQL Server: `pds config set db.kind sqlserver`, `pds config set db.server sql01.example.com` (dazu `db.port`, `db.database`, `db.user`; Passwort: `config set db.password`) |
| 4. Datenbank einrichten | nur SQL Server: „Einrichten …“ → Admin-Login und Admin-Passwort (nur im Speicher) oder „SQL-Skript exportieren …“ für die DBAs | nur SQL Server: `pds db setup --admin-user sa` oder `pds db script C:\Temp\setup.sql` |
| 5. Datenbank prüfen | „Verbindung testen“ | `pds db test` |
| 6. Anmeldung | **Anmeldung** → Tenant-ID, Client-ID, Client-Secret, „Prüfen“ (Abschnitt 4) | `pds config set oidc.tenant_id <GUID>`, `… oidc.client_id <GUID>`, `config set oidc.client_secret`, `pds oidc test --check-client` |
| 7. KI-Assistenten (optional) | **KI-Assistenten** → „KI-Assistenten (MCP) zulassen“ (Standard aus, Datenschutzhinweis lesen, Abschnitt 10) | `pds config set mcp.enabled true` |
| 8. Prüfen | Prüfstatus in der unteren Leiste; **Adresse und TLS** → „Ports prüfen“ | `pds config validate`, `pds ports check` |
| 9. Übernehmen | **Speichern**: prüft, schreibt, startet den Dienst neu und wartet bis 90 s auf die App | `pds service restart --wait` |
| 10. Kontrollieren | **Status** | `pds status` |
| 11. EPLAN-Worker | **EPLAN-Worker** → Konto und Passwort → „Einrichten“ (Abschnitt 7) | `pds eplan install --user EXAMPLE\svc-eplan` (Passwort verdeckt) |
| 12. Ordnerrechte | – (Explorer → Eigenschaften → Sicherheit, Konto `NT SERVICE\pds`) | `icacls "D:\EPLAN\Projekte" /grant "NT SERVICE\pds:(OI)(CI)RX"` (Abschnitt 8) |
| 13. Web-App öffnen | **Status** → „Web-App öffnen“ | `https://<Hostname>` im Browser |

Hinweise:

- Passwörter und Secrets fragt die CLI **verdeckt** ab; in Skripten mit `--stdin` bzw. `--password-stdin` (Abschnitt 12).
- Die CLI speichert jede Änderung an `config.toml` sofort, wirksam wird sie erst mit `service restart`. So lassen sich
  mehrere Änderungen bündeln. `pds eplan install` wirkt dagegen sofort: Es legt den Worker-Dienst an bzw. ändert ihn und
  startet ihn.
- Die Prüfungen der Oberfläche („Verbindung testen“, „Einrichten …“, „Prüfen“) verwenden die Eingaben auf dem Bildschirm,
  auch wenn sie noch nicht gespeichert sind. `db test`, `db setup` und `oidc test` der CLI lesen dagegen die
  **gespeicherte** Konfiguration: zuerst `config set`, dann prüfen.
- Ein Zertifikatsimport wird sofort gespeichert und wirkt mit dem nächsten Neustart des Dienstes. Die Oberfläche prüft es
  gegen den Hostnamen im Formular (auch ungespeichert), die CLI gegen den gespeicherten `public.host` (Abschnitt 6).
- `db setup` erzeugt ein Datenbankpasswort, falls keins gesetzt ist, speichert es verschlüsselt und zeigt es **nie** an.
- „Web-App öffnen“ öffnet die gespeicherte App-Adresse im Standardbrowser, **nicht** erhöht (über `explorer.exe`).
- Wer die Web-App benutzen darf, regelt die Zuweisung in Entra ID; wer Admin ist, die App-Rolle `Admin` (Abschnitt 4).
- Den Worker (Schritt 11) kann man jederzeit nach dem MSI einrichten; EPLAN muss erst zur ersten Analyse installiert und
  lizenziert sein.

### Fachliche Einstellungen: Web-App

`https://<Hostname>` öffnen, „Mit Microsoft anmelden“ (Person mit der App-Rolle `Admin`). Dann unter **Einstellungen**
(Abschnitt 9):

1. **EPLAN**: Pfade zum Ordner `Bin` von EPLAN Platform und Electric P8 (Standard Version 2025.0.3), Application
   Modifier, Öffnungsmodus (Standard „ReadOnly“).
2. **Projektordner** (optional) mit Quelle „lokal“ oder „Netzlaufwerk“, Unterordner, Dateimuster; **Netzlaufwerk** nur
   bei Quelle „Netzlaufwerk“ (Abschnitt 8).
3. **Zeitplan**, **Grenzen** (Zeitlimit, Upload-Grenze) und **Aufbewahrung** prüfen (Standards in Abschnitt 9).
4. **Speichern**, dann „Verbindung testen“: prüft Netzlaufwerk (falls gewählt), Projektordner und den Worker.
5. Zur Probe eine `.zw1` hochladen und die Analyse abwarten (die erste nach dem Start des Workers dauert einige Minuten
   länger, weil EPLAN erst startet), dann die Tabellen ansehen.
6. Optional den **Zeitplan einschalten**, wenn der Projektordner regelmäßig analysiert werden soll.

## 4. Entra-App-Registrierung

Die Anmeldung an der Web-App (und an MCP) läuft über OpenID Connect mit Microsoft Entra ID. Im Azure-Portal
(Microsoft Entra ID):

1. **App-Registrierungen** → „Neue Registrierung“: Name z. B. „EPLAN Panel Data Service“, unterstützte Kontotypen
   „Nur Konten in diesem Organisationsverzeichnis“ (Einzelmandant), Umleitungs-URI Plattform **Web** mit
   **`<App-Adresse>/auth/callback`**. Die App-Adresse ist `https://<public.host>`; der Port steht nur dabei, wenn er
   nicht 443 ist (`https://pds.example.com:8443`), und bei `tls.mode = off` gilt `public.scheme`. Die Oberfläche zeigt
   sie unter **Adresse und TLS** → „App-Adresse“ und die fertige Redirect-URI unter **Anmeldung** → „Redirect-URI“ mit
   „Kopieren“. Der Hostname erscheint darin kleingeschrieben.
2. **Übersicht**: Anwendungs-ID (Client-ID) und Verzeichnis-ID (Mandanten-ID) übernehmen (Tabelle unten).
3. **Zertifikate & Geheimnisse** → „Neuer geheimer Clientschlüssel“: den **Wert** übernehmen (nicht die Geheimnis-ID);
   er wird nur einmal angezeigt. Ablaufdatum im Kalender der IT eintragen.
4. **App-Rollen** → „App-Rolle erstellen“: Anzeigename „Administrator“, Mitgliedstypen „Benutzer/Gruppen“, **Wert
   `Admin`** (muss in `oidc.admin_roles` stehen; kommt im Claim `roles` an, `oidc.roles_claim`). Die Web-App ist für
   **alle angemeldeten Personen** da; `Admin` schaltet zusätzlich Einstellungen, Protokolle, Löschen und „Worker neu
   starten“ frei. Für die übrigen eine zweite Rolle, etwa „Benutzer“ mit Wert `User` (nicht in `oidc.admin_roles`):
   Sobald es App-Rollen gibt, bietet das Azure-Portal bei der Zuweisung nur noch diese an.
5. **Unternehmensanwendungen** → die App → Eigenschaften → „Zuweisung erforderlich“ = Ja (empfohlen), dann unter
   „Benutzer und Gruppen“ Admins mit `Admin`, alle anderen mit `User` zuweisen (Gruppen setzen Entra ID P1/P2 voraus).
   Ohne „Zuweisung erforderlich“ kann jede Person des Mandanten die Web-App benutzen.
6. Optional: **Token-Konfiguration** → optionaler Claim `email` (ID-Token), falls der UPN keine E-Mail-Adresse ist.

| Wert im Azure-Portal | Feld | Oberfläche (**Anmeldung**) |
| --- | --- | --- |
| Verzeichnis-ID (Mandanten-ID) | `oidc.tenant_id`; der Issuer `https://login.microsoftonline.com/<Verzeichnis-ID>/v2.0` entsteht daraus | Tenant-ID |
| Anwendungs-ID (Client-ID) | `oidc.client_id` | Client-ID |
| Wert des geheimen Clientschlüssels | `oidc.client_secret` (Secret) | Client-Secret |
| Wert der Admin-Rolle | `oidc.admin_roles` (Standard `Admin`, mehrere kommagetrennt) | „Erweitert“ |
| Claim mit den Rollen | `oidc.roles_claim` (Standard `roles`) | „Erweitert“ |
| – | `oidc.provider_name` (Standard `Microsoft`): Beschriftung „Mit Microsoft anmelden“ | „Erweitert“ |

Prüfen: `pds oidc test` ruft das OpenID-Discovery-Dokument des Issuers ab (Proxy und Zertifikatspeicher wie bei der
App). Mit `--check-client` (Oberfläche: „Client-ID und Client-Secret mitprüfen“) fragt es zusätzlich bei Entra ID an, ob
Client-ID und -Secret gelten, und meldet ein abgelaufenes Secret (`client_secret_expired`), ein falsches
(`client_secret_invalid`) oder eine unbekannte Client-ID (`client_id_unknown`). Dabei geht das gespeicherte Secret an
Entra ID.

Client-Secrets laufen ab. Erneuern: neues Secret im Azure-Portal erzeugen, `pds config set oidc.client_secret
--stdin` (oder per Oberfläche), `pds service restart --wait`.

Alternativ zur Tenant-ID kann man unter „Erweitert“ einen eigenen Issuer (`oidc.issuer`) eintragen, etwa für einen anderen
OpenID-Connect-Anbieter. Dann bleibt `oidc.tenant_id` ungenutzt.

## 5. Datenbank

Die App speichert fachliche Einstellungen, Projekte, Analysen mit ihren Ereignissen, die **Ergebnisse jeder Analyse** und
die Änderungen durch Admins in **einer** Datenbank: einer **SQLite-Datei** auf diesem Server (Standard der Konfiguration,
`db.kind = sqlite`) oder einem **SQL Server** (`db.kind = sqlserver`). In der Oberfläche steht die Wahl oben auf der Seite
**Datenbank**.

### SQLite oder SQL Server

Die Ergebnisse sind dafür gedacht, dass **andere Systeme** sie weiterverarbeiten. Dafür ist **SQL Server** vorgesehen und
empfohlen: Dort lesen andere Systeme über ein eigenes Login die Sichten `pds.v_current_*` (unten). SQLite eignet sich für
Installationen, in denen nur die Web-App, die Downloads und MCP die Ergebnisse nutzen.

| | SQLite (Standard der Konfiguration) | SQL Server (empfohlen) |
| --- | --- | --- |
| Wann | ein Server ohne eigene Datenbank-Infrastruktur, Ergebnisse nur in der Web-App | Ergebnisse für andere Systeme; vorhandene SQL-Server-Landschaft: DBAs, zentrale Sicherung und Überwachung, Hochverfügbarkeit |
| Einrichten | nichts: der erste Start legt die Datei an, die Tabellen legt der Dienst beim Start an | Datenbank und Login mit `db setup` oder dem SQL-Skript der DBAs |
| Ort | eine Datei auf einem **lokalen** Laufwerk dieses Servers, nie auf einem Netzlaufwerk | beliebiger erreichbarer Server, TCP 1433 oder fester Port |
| Lesen durch andere Systeme | nicht vorgesehen: Die Datei liegt im geschützten Datenordner, nur Dienst und Administratoren haben Zugriff | über ein eigenes Login mit Leserechten auf die Sichten |
| Sicherung | `pds db backup` im laufenden Betrieb oder Kopie bei gestopptem Dienst (unten) | SQL-Server-Sicherung der DBAs |
| Felder | `db.kind`, `db.path` | `db.kind`, `db.server`, `db.port`, `db.database`, `db.user`, `db.password`, `db.encrypt`, `db.trust_server_certificate` |

Eine Datenbank gehört immer genau einem Dienst; die Felder der anderen Art bleiben gespeichert, gelten aber nicht.
**Art später wechseln** (`pds config set db.kind …`, dann `service restart --wait`): Die App beginnt mit einer **leeren
Datenbank**, nichts wird übertragen (ein Wechsel zurück findet die alten Daten wieder). Einstellungen neu eintragen,
Projekte neu analysieren. Deshalb die Art vor dem produktiven Betrieb festlegen; die Oberfläche warnt beim Wechsel.

Unterschiede im Verhalten: SQLite vergleicht Namen ohne Groß-/Kleinschreibung nur für A–Z (`Ä` und `ä` gelten als
verschieden, in SQL Server üblicherweise nicht). Und SQLite arbeitet mit einer Verbindung: Hält ein anderes Programm die
Schreibsperre (etwa eine Sicherung), wartet jede Abfrage bis zu 5 s, so lange stockt auch die Web-App.

### Inhalt

Die App legt ihre Tabellen beim Start selbst an und aktualisiert sie (Migrationen). In SQL Server liegen sie in den
Schemas `core` und `pds`, in SQLite (ohne Schemas) als Tabellen `core_<Tabelle>` und `pds_<Tabelle>`; die
Migrationen selbst stehen in `core.migrations` und `pds.migrations` bzw. `core_migrations` und `pds_migrations`.

| Schema | Inhalt |
| --- | --- |
| `core` | Benutzer, Sitzungen, OAuth-Zugänge der KI-Assistenten |
| `pds` | `settings` (fachliche Einstellungen, eine Zeile, Netzlaufwerk-Passwort verschlüsselt), `projects` (Projekte aus Upload oder Projektordner, mit Verweis auf den aktuellen Stand), `analyses` und `analysis_events` (Analysen mit Status, Stufe, Zählern und Ereignissen), Ergebnis-Tabellen `connections`, `cables`, `cable_wires`, `shields`, `shield_wires`, `texts` (je Analyse), `audit` (Änderungen durch Admins), dazu die Sichten `v_current_*` |

Zusammen mit `uploads\` ist die Datenbank der Bestand, den man sichert (unten und Abschnitt 11).

### Ergebnisse für andere Systeme: die Sichten `pds.v_current_*`

Jede Analyse schreibt einen neuen **Stand**; ältere bleiben, bis die Aufbewahrung sie löscht (Abschnitt 9). Für die
Weiterverarbeitung zeigen stabile Sichten je Projekt nur den **aktuellen** Stand (neueste erfolgreiche Analyse):
`pds.v_current_connections` (Verbindungen), `pds.v_current_cables` (Kabel und Schirme des Kabelnavigators),
`pds.v_current_cable_wires` (Adern), `pds.v_current_shields` (Schirme) und `pds.v_current_texts` (freie Texte), jeweils
mit `project_id`, `project_name` und `analysis_id`. Ein Stand wird in **einer Transaktion** geschrieben und erst danach
zum aktuellen: Ein Leser sieht nie einen halben Stand. Unter SQLite tragen die Objekte statt des Schemas das Präfix
`pds_`.

Andere Systeme lesen am besten über ein **eigenes SQL-Login mit Leserechten nur auf die Sichten**, nicht mit dem Login der
App (`db setup` legt nur dieses an). Beispiel für die DBAs (Namen frei wählbar, Passwort nach Richtlinie):

```sql
USE [master];
CREATE LOGIN [pds_reader] WITH PASSWORD = N'<PASSWORT>';
USE [pds];
CREATE USER [pds_reader] FOR LOGIN [pds_reader];
GRANT SELECT ON [pds].[v_current_connections] TO [pds_reader];
GRANT SELECT ON [pds].[v_current_cables]      TO [pds_reader];
GRANT SELECT ON [pds].[v_current_cable_wires] TO [pds_reader];
GRANT SELECT ON [pds].[v_current_shields]     TO [pds_reader];
GRANT SELECT ON [pds].[v_current_texts]       TO [pds_reader];
```

Mit eingeschaltetem `READ_COMMITTED_SNAPSHOT` (unten) blockieren solche Leser die App nicht. Kein Lese-Login auf das ganze
Schema `pds` geben: Dort stehen auch Einstellungen und das Änderungsprotokoll.

### SQLite: Datei und Rechte

Ohne Angabe (`db.path` leer) liegt die Datenbank in
`%ProgramData%\EPLAN Panel Data Service\data\pds.db`. Die App öffnet sie im WAL-Modus: Solange sie läuft, liegen
`pds.db-wal` und `pds.db-shm` daneben. Diese beiden gehören zur Datenbank; nie einzeln löschen, verschieben oder
kopieren.

Weil SQLite diese Dateien neben der Datenbank anlegt, braucht das Dienstkonto **Ändern auf dem Ordner**, nicht nur auf
der Datei. Für den Standardordner `data\` sorgt `setup install` (Vererbung getrennt, SYSTEM und
Administratoren Vollzugriff, `NT SERVICE\pds` Ändern, sonst niemand, auch nicht das Worker-Konto).

Ein **eigener Pfad** (`db.path`, etwa `D:\PDS\pds.db`, oder in der Oberfläche „Datenbankdatei“) muss

- vollständig sein, mit Laufwerksbuchstabe (`sqlite_path_not_absolute`), ohne `.`/`..`, ohne Zeichen, die Windows in
  Namen nicht erlaubt, ohne Gerätepfad `\\?\…`, ohne Kurznamen (8.3, etwa `PROGRA~1`) und mit Dateinamen am Ende
  (`invalid_path`);
- auf einem **lokalen** Laufwerk liegen: kein UNC-Pfad `\\server\freigabe\…`, kein verbundenes Netzlaufwerk
  (`sqlite_network_path`). Auf Netzfreigaben funktionieren Sperren und WAL nicht zuverlässig, die Datenbank kann
  beschädigt werden. Wer die Daten auf einem anderen Server haben will, nimmt SQL Server;
- außerhalb von Stellen liegen, deren Rechte nicht gelockert werden dürfen oder die bei Updates verschwinden
  (`sqlite_path_forbidden`): nicht im Stamm eines Laufwerks (`D:\pds.db`), nicht unter `Windows`, `Program Files`,
  `Program Files (x86)`, `$Recycle.Bin`, `System Volume Information` oder im Programmordner, nirgends unter
  `C:\Users` (Benutzerprofile, auch `Public`), nicht direkt in `C:\ProgramData` und nicht unter
  `C:\ProgramData\Microsoft` (dort liegt etwa der Autostart aller Benutzer; ein eigener Unterordner wie
  `C:\ProgramData\PDS` geht) und im Datenordner nur unter `data\`, weil daneben Konfiguration und Schlüssel liegen.

Geprüft wird auch, **wohin der Pfad tatsächlich führt** (Junction, Kurzname, `subst`-Laufwerk): Befund mit dem Hinweis
„führt tatsächlich nach …“. Ein fehlendes Laufwerk ist nur eine Warnung (`sqlite_drive_missing`), ein Ordner statt einer
Datei ein Fehler (`sqlite_path_is_directory`).

**Rechte für einen eigenen Pfad.** Jedes Speichern der Konfiguration als Administrator (Oberfläche, `config set db.path`
bzw. `db.kind`, `config import`) und `setup install` bei Update und Reparatur geben dem Dienstkonto, was es braucht: Ein
fehlender Ordner entsteht mit denselben strengen Rechten wie `data\`; ein **vorhandener** behält seine Rechte und bekommt
zusätzlich „Ändern“ für `NT SERVICE\pds` (wer dort schon Zugriff hat, sieht damit auch die Datenbank), ebenso vorhandene
Dateien `pds.db`, `-wal`, `-shm` und `-journal`. Verweise (Junction, symbolischer oder harter Link) werden abgelehnt.
Scheitert das, ist es eine **Warnung**, gespeichert ist trotzdem; von Hand:
`icacls "D:\PDS" /grant "NT SERVICE\pds:(OI)(CI)M"`.

`db test` legt **nichts** an (was es als Administrator anlegte, bekäme nicht die strengen Rechte): Fehlt die Datei oder ihr
Ordner, meldet es das, ohne Fehler. Eine vorhandene Datei öffnet es wie die App, prüft mit einem echten Schreibvorgang
Datei, `-wal` und `-shm`, nennt die SQLite-Version und zählt die Migrationen. Ob das **Dienstkonto** schreiben darf, zeigt
erst der Start des Dienstes („Datenbank nicht bereit (SQLite): …“, Abschnitt 14).

| Code (`db test`, SQLite) | Bedeutung und Maßnahme |
| --- | --- |
| `cannot_open` | Keine Berechtigung, ein Teil des Pfads ist eine Datei, der Pfad ist ein Ordner: Pfad und Rechte prüfen |
| `read_only` | Datei oder Ordner schreibgeschützt (Attribut, Rechte, Datenträger): Ändern auf dem Ordner vergeben |
| `locked` | Ein anderes Programm hält die Datei (etwa eine Sicherung, ein Virenscanner): später erneut |
| `not_a_database`, `corrupt` | Die Datei ist keine SQLite-Datenbank bzw. beschädigt: Pfad prüfen, Sicherung zurückspielen |
| `disk_full`, `io_error` | Laufwerk voll bzw. Ein-/Ausgabefehler |
| `network_path` | UNC-Pfad: nicht unterstützt |

### SQLite: Sicherung

Im **laufenden Betrieb**:

```powershell
pds db backup "D:\Sicherung\pds-$(Get-Date -Format yyyyMMdd).db"
```

Die Kopie ist in sich stimmig (auch wenn der Dienst gerade schreibt), mit `integrity_check` geprüft und eine einzelne Datei
ohne `-wal`. Die Zieldatei darf es noch nicht geben; eine missglückte Kopie wird wieder gelöscht. Exit-Code 3, wenn die
Sicherung scheitert. Regelmäßig: in der Aufgabenplanung als SYSTEM. Die Kopie enthält **alle Anwendungsdaten**: geschützt
ablegen. Zur vollständigen Sicherung gehört auch `uploads\` (Abschnitt 11).

**Ohne den Befehl**: `pds service stop`, dann `pds.db` zusammen mit `pds.db-wal` kopieren, falls diese noch da ist
(nach einem geordneten Stopp ist sie meist eingearbeitet und verschwunden), danach `pds service start --wait`. Nie nur
die `pds.db` eines laufenden Dienstes kopieren: Ihr fehlen die Änderungen im WAL.

**Zurückspielen**: `pds service stop`, `pds.db-wal` und `pds.db-shm` der aktuellen Datei löschen, die Sicherung als
`pds.db` an ihre Stelle **kopieren** (eine Kopie erbt die Rechte des Ordners, eine verschobene Datei nicht; sonst
einmal speichern oder `msiexec /fa`, siehe oben), `pds service start --wait`. Die Sicherung muss vom selben Server
stammen oder dasselbe App-Secret haben, sonst ist das Netzlaufwerk-Passwort neu einzugeben (Abschnitt 9). Den Stand von
`uploads\` aus derselben Sicherung zurückspielen (Abschnitt 11).

### SQL Server: Rechte

Die App arbeitet nur mit den Rechten ihrer **eigenen** Datenbank:

- ein SQL-Login (Standard `pds_app`) als Benutzer der Datenbank (Standard `pds`) in der Rolle **`db_owner`**: Die
  App legt ihre Tabellen, Sichten und Schemas beim Start selbst an und aktualisiert sie;
- `READ_COMMITTED_SNAPSHOT` der Datenbank **eingeschaltet**, damit Leser Schreiber nicht blockieren (auch die anderen
  Systeme, die die Sichten lesen). `db test` meldet beides (fehlendes `db_owner` und ausgeschaltetes
  `READ_COMMITTED_SNAPSHOT` als Hinweis).

Namen von Datenbank und Login dürfen weder `]` noch `'` enthalten. Eine Systemdatenbank (`master`, `model`, `msdb`, `tempdb`)
ist als Datenbankname ausgeschlossen.

### SQL Server: Einrichten mit einem Admin-Login

```powershell
pds config set db.kind sqlserver
pds config set db.server sql01.example.com
pds db setup --admin-user sa
```

`db setup` legt Datenbank, `READ_COMMITTED_SNAPSHOT`, Login, Benutzer und `db_owner` an, mit denselben Anweisungen wie
das SQL-Skript (`db script`). Das Admin-Passwort wird verdeckt abgefragt (`--admin-password-stdin` für Skripte) und
**nicht gespeichert**. Der Admin muss ein `sysadmin`-Login sein; als App-Benutzer lehnt die Einrichtung jedes
Administrator-Login und das Login des Admins selbst ab (`permission_denied`), weil sie dessen Passwort neu setzen würde.
Wiederholbar, aber jeder Lauf setzt das **Passwort des Logins neu** und trennt offene Verbindungen. Ist kein
`db.password` gesetzt, erzeugt `db setup` ein zufälliges (32 Zeichen); soll ein bestimmtes gelten, vorher
`config set db.password`. Das Lese-Login für andere Systeme (oben) legt `db setup` **nicht** an.

### SQL Server: SQL-Skript für DBAs

Wenn die DBAs die Datenbank selbst anlegen:

```powershell
pds config set db.kind sqlserver
pds config set db.database pds
pds config set db.user pds_app
pds db script C:\Temp\pds-setup.sql
```

Ohne Dateiangabe steht das Skript auf der Standardausgabe. Die DBAs setzen in der Zeile
`:setvar DB_PASSWORD "<PASSWORT HIER EINTRAGEN>"` ein Passwort ein (`'` und `"` darin verdoppeln), führen das Skript mit
einem `sysadmin`-Login aus (SSMS im SQLCMD-Modus oder `sqlcmd -S <server> -U <admin> -i pds-setup.sql`) und teilen das
Passwort dem Betreiber mit (`pds config set db.password`). Das Skript bricht beim ersten Fehler ab, ist wiederholbar,
legt mit dem Platzhalter nichts an und setzt bei jedem Lauf das Passwort des Logins neu.

### SQL Server: Verschlüsselung und Firmen-CA

`db.encrypt` ist standardmäßig `true`. Node prüft das Zertifikat des SQL Servers gegen den **Windows-Zertifikatspeicher des
Computers** (`node --use-system-ca`): Die ausstellende Firmen-CA muss unter „Vertrauenswürdige Stammzertifizierungsstellen“
des Computers (`LocalMachine\Root`) stehen, und `db.server` muss ein Name sein, den das Zertifikat abdeckt. Dann bleibt
`db.trust_server_certificate = false`. Ohne diese Vertrauensstellung meldet `db test` `tls_untrusted`. Nur für Tests schaltet
`db.trust_server_certificate = true` (`trustServerCertificate` in der Datenbank-URL der App) die Prüfung ab.

### SQL Server: Servernamen und benannte Instanzen

- `db.server` ist ein **Hostname oder eine IPv4-Adresse** (Unterstriche im Namen sind erlaubt), **ohne** Port und ohne
  `\Instanz`. IPv6 wird nicht unterstützt.
- **Benannte Instanzen** gehen nur über ihren **festen TCP-Port**: Die DBAs legen den Port fest (SQL Server Configuration
  Manager) und nennen ihn; dann `db.server` = Servername, `db.port` = dieser Port. Der SQL Browser wird nicht verwendet.
  `config validate` lehnt `server\instanz` mit `named_instance_not_supported` ab.

### SQL Server: Fehlercodes von `db test`

| Code | Bedeutung und Maßnahme |
| --- | --- |
| `dns_failed` | Servername nicht auflösbar: Schreibweise, DNS |
| `connection_refused`, `timeout` | Server nicht erreichbar: Dienst, Port, Firewall (Server und Netz) |
| `tls_untrusted` | Zertifikat des SQL Servers nicht vertrauenswürdig oder falscher Name: CA installieren, Namen prüfen |
| `login_failed` | Benutzer oder Passwort falsch, Login gesperrt: `db setup` oder Skript erneut, Passwort abgleichen |
| `database_missing` | Datenbank fehlt oder das Login hat keinen Zugriff darauf: einrichten |
| `permission_denied` | Rechte fehlen, bei `db setup` auch: App-Benutzer wäre ein Administrator-Login |
| `password_policy` | Passwort erfüllt die Kennwortrichtlinie des Servers nicht |
| `invalid_url` | Eingaben ergeben keine gültige Datenbank-Adresse |

## 6. Zertifikate

`tls.mode` wählt die Herkunft. Eine Änderung gilt nach `pds service restart`.

| Modus | Zweck |
| --- | --- |
| `certificate` (Standard) | Zertifikat der Firmen-PKI als Datei oder aus dem Zertifikatspeicher |
| `acme` | Caddy beantragt und erneuert das Zertifikat selbst (auch bei eigener CA) |
| `internal` | Caddy stellt es mit eigener CA aus. **Nur zum Testen**: Browser vertrauen ihm nicht. |
| `off` | Nur HTTP; TLS endet an einem vorgelagerten Proxy |

Das Zertifikat dieses Abschnitts gilt nur für die Web-App (und MCP).

### Modus `certificate`: Datei oder Zertifikatspeicher

Das Zertifikat muss zu `public.host` passen: als **DNS-Name** im Zertifikat (SAN; ein Platzhalter `*.example.com` deckt genau
ein Label ab), nicht abgelaufen sein und zum privaten Schlüssel passen. Eine **IP-Adresse** als Hostname geht in diesem
Modus nicht, denn IP-Adressen kann das Zertifikat nicht abdecken (`certificate_hostname_mismatch`).

```powershell
# PFX (auch ältere Windows-Exporte mit 3DES): Passwort verdeckt oder über stdin
pds tls import --pfx C:\Temp\pds.pfx
# PEM: Zertifikat samt Zwischenzertifikaten (Blatt zuerst) und Schlüssel ohne Passwort (RSA oder EC P-256/P-384)
pds tls import --pem C:\Temp\pds.pem C:\Temp\pds.key
# Zertifikatspeicher des Computers (LocalMachine\My): SHA-1-Fingerabdruck, Schlüssel muss exportierbar sein
pds tls import --store 0123456789ABCDEF0123456789ABCDEF01234567
pds tls show
```

- Der Import **prüft vor dem Speichern** (Ablauf, Hostname, Schlüssel). Besteht er nicht, bleibt die vorhandene Ablage
  unverändert und der Exit-Code ist 2. Gespeichert wird die Kette als PEM (öffentlich), der Schlüssel nur verschlüsselt
  (`tls\key.dpapi`). Ein PFX-Passwort wird nie gespeichert.
- Die Kette muss die **Zwischenzertifikate** enthalten, sonst melden Browser eine unvollständige Kette.
- `--store` kopiert das Zertifikat. Eine spätere Erneuerung im Zertifikatspeicher wird **nicht** automatisch übernommen:
  erneut importieren.
- Wirksam wird das Zertifikat mit `pds service restart`.
- **Hostname beim Import**: Die CLI prüft gegen den gespeicherten `public.host`, die Oberfläche gegen den Hostnamen im
  Formular (auch ungespeichert), speichert aber **nur das Zertifikat**. Wird der neue Hostname nicht gespeichert, passt das
  Zertifikat nicht mehr (`certificate_hostname_mismatch`), und die App startet nach dem nächsten Neustart nicht.

### Modus `acme`

```powershell
pds config set tls.mode acme
pds config set tls.acme_email pki@example.com
```

Ohne weitere Angaben nutzt Caddy seinen Standard (Let's Encrypt). Der Server muss dazu für die Challenges der CA auf Port
80 bzw. 443 erreichbar sein. Für eine **eigene CA** (Firmen-ACME-Server):

```powershell
pds config set tls.acme_ca_url https://acme.pki.example.com/directory
pds config set tls.acme_ca_root "C:\ProgramData\EPLAN Panel Data Service\tls\ca-root.pem"
pds config set tls.acme_eab_key_id <Key-ID>
pds config set tls.acme_eab_hmac        # Secret: verdeckte Abfrage bzw. --stdin
```

- `tls.acme_ca_root`: Stammzertifikat der CA als PEM-Datei, falls sie nicht öffentlich vertrauenswürdig ist. Das Dienstkonto
  muss sie lesen können (der Ordner `tls\` im Datenordner reicht dafür).
- **External Account Binding**: `tls.acme_eab_key_id` und `tls.acme_eab_hmac` nur **gemeinsam** (`acme_eab_incomplete`).
- Konten und Zertifikate liegen in `caddy\`. Dort schützt nur die ACL die Schlüssel (Caddys Speicherformat).

### Modus `internal` und `off`

- `internal`: Caddy stellt das Zertifikat mit einer eigenen CA aus und trägt sie **nicht** in den Vertrauensspeicher des
  Servers ein. Nur für Tests.
- `off`: Caddy nimmt nur HTTP auf `listen.http_port` an. `public.scheme` (`http` oder `https`, Standard `https`) und
  `public.port` bestimmen nur die öffentliche Adresse der App; bei `https` setzt die App das Sitzungs-Cookie mit
  `Secure`, bei `http` ohne. Gedacht für einen vorgelagerten Proxy, der TLS übernimmt.

### Erneuerung und Ablaufwarnung

- **Firmen-PKI**: Der Dienst erneuert nicht selbst: neues Zertifikat mit `tls import`, dann `pds service restart --wait`.
  **ACME**: Caddy erneuert selbst.
- **Warnung** ab 30 Tagen vor Ablauf (`certificate_expires_soon`) in `config validate`, `status`, Ereignisprotokoll und
  unter **Status** der Oberfläche.
- **Abgelaufen** (`certificate_expired`): **Nach dem nächsten Neustart des Dienstes (auch nach einem Reboot) startet die
  App nicht mehr**, und es laufen **keine Analysen**, bis ein gültiges Zertifikat importiert ist.

## 7. EPLAN-Worker

Der Worker ist das einzige Programm, das EPLAN braucht. Er öffnet die Projekte mit der EPLAN-API und liest Rohdaten; die
Auswertung (Zuordnung von #, Verdrillung, Schirmen, Kabelliste, Zeilenaufbau) macht die Node-App. EPLAN lässt sich je
Prozess nur einmal starten und braucht dafür Minuten; deshalb läuft der Worker als eigener, dauerhaft laufender Dienst und
hält EPLAN nach dem ersten Auftrag geladen.

### Aufbau

| | |
| --- | --- |
| Dienst | `pds-eplan`, Anzeigename „EPLAN Panel Data Service – EPLAN-Worker“ |
| Programm | `C:\Program Files\EPLAN Panel Data Service\eplan\pds-eplan.exe`, Argument `service` |
| Konto | ein lizenziertes Benutzerkonto (Worker-Konto), unten |
| Start | automatisch (verzögert) |
| Wiederherstellung | neu starten nach **10 s, 30 s, 60 s** (danach jeweils nach 60 s), Fehlerzähler nach 1 Tag zurückgesetzt; gilt auch für Fehler ohne Absturz (der Worker endet mit Fehlercode) |
| Verbindung | Named Pipe `\\.\pipe\pds-eplan`, JSON-Zeilen; Zugriff nur für `NT SERVICE\pds` (Lesen und Schreiben), Administratoren und das Worker-Konto (Vollzugriff); ein Client gleichzeitig |
| Log | `%ProgramData%\EPLAN Panel Data Service\logs\eplan-worker-<Datum>.log`, eine Datei je Tag, neben den Logs des Web-Dienstes |
| EPLAN | EPLAN Platform und Electric P8 aus der lokalen Installation; die Pfade kommen aus den Einstellungen der Web-App (**EPLAN-Pfade**, Standard 2025.0.3). Die EPLAN-DLLs liefert das MSI **nicht** mit. |

Der Web-Dienst findet den Worker über die Umgebungsvariable `NUXT_EPLAN_WORKER=pipe:\\.\pipe\pds-eplan`, die er der App
mitgibt (dazu `NUXT_PDS_DATA_DIR=<Datenordner>` und `NUXT_LOG_DIR=<Datenordner>\logs`). Läuft der Worker nicht, bleiben
Aufträge in der Warteschlange, und die Übersicht der Web-App zeigt „Worker nicht erreichbar“.

Betriebsarten von `pds-eplan.exe`:

| Aufruf | Zweck |
| --- | --- |
| `pds-eplan.exe service` | Windows-Dienst (so trägt ihn `pds eplan install` ein) |
| `pds-eplan.exe run [--dialogs]` | Derselbe Worker in der Konsole, lauscht auf derselben Pipe; die Web-App kann ihn also benutzen. `--dialogs` lässt die Dialoge von EPLAN zu (Lizenzauswahl, Fehlermeldungen). Zur Fehlersuche bei gestopptem Dienst (Abschnitt 14) |
| `pds-eplan.exe stdio` | Ein Client über stdin/stdout; nur für die Entwicklung |

### Anforderungen an das Worker-Konto

- [ ] Ein **Benutzerkonto**, Domäne (`EXAMPLE\svc-eplan`) oder lokal (`.\svc-eplan`). Virtuelle und eingebaute Konten
  (LocalSystem, `NT AUTHORITY\…`, `NT SERVICE\…`) und Konten mit `$` am Ende (gMSA, Computerkonten) lehnt
  `pds eplan install` ab: EPLAN braucht ein Benutzerkonto mit Lizenz.
- [ ] **EPLAN-Lizenz für dieses Konto**: der Lizenzserver ist erreichbar bzw. die Lizenz für den Benutzer aktiviert. Prüfen
  lässt sich das mit dem Worker in der Konsole (Abschnitt 14, „EPLAN-Lizenz unter dem Konto prüfen“).
- [ ] Das **Passwort läuft möglichst nicht ab** (Dienstkonto-Richtlinie der IT). Sonst nach jedem Passwortwechsel
  `pds eplan install` erneut ausführen; bis dahin scheitert der Dienststart mit Ereignis 7038 bzw. 7000 des Service
  Control Managers.
- [ ] Das Recht **„Als Dienst anmelden“** (`SeServiceLogonRight`) setzt `pds eplan install` selbst über die lokale
  Sicherheitsrichtlinie. Legt eine **Domänen-GPO** dieses Recht fest, ersetzt sie bei der nächsten Aktualisierung die
  lokale Liste und entfernt das Konto wieder: Dann das Konto (oder eine Gruppe, in der es ist) in diese GPO aufnehmen.
- [ ] Das Recht **„Auslassen der durchsuchenden Überprüfung“** (Standard: Jeder) muss das Konto haben: Es hat keinen
  Zugriff auf den Datenordner selbst, nur auf `uploads\`, `work\` und `logs\` darin, und erreicht diese über das
  Durchsuchen-Recht.
- [ ] Das **Profil** des Kontos legt Windows beim ersten Start des Dienstes an (`C:\Users\<Konto>`); dort liegen auch
  die benutzerbezogenen Einstellungen von EPLAN.
- [ ] **Kein Zugriff auf den Projektordner** nötig: Projekte aus dem Ordner kopiert der Web-Dienst nach `work\`. Das Konto
  braucht auch keine Netzwerkrechte, außer zum Lizenzserver.
- [ ] Ein eigenes Dienstkonto nehmen, kein persönliches, und es nicht interaktiv verwenden.

### Einrichten per CLI

Als Administrator:

```powershell
pds eplan install --user EXAMPLE\svc-eplan                 # Passwort wird verdeckt abgefragt
pds eplan status
```

In Skripten kommt das Passwort als **eine Zeile von stdin**:

```powershell
$env:DEPLOY_EPLAN_PASSWORD | pds eplan install --user EXAMPLE\svc-eplan --password-stdin
```

Das Konto steht als `DOMÄNE\Benutzer`, `.\Benutzer` (lokales Konto dieses Servers) oder `benutzer@domäne.tld` (UPN).
Das Passwort **nie als Argument**: Es gibt dafür keine Option; die CLI fragt es verdeckt ab oder liest es mit
`--password-stdin`.

`pds eplan install`

1. prüft den Kontonamen, dass `eplan\pds-eplan.exe` in dieser Installation vorhanden ist und dass der Datenordner
   existiert (sonst Exit-Code 1, nichts geändert),
2. löst das Konto auf; nur Benutzerkonten werden angenommen (oben),
3. gewährt dem Konto das Recht **„Als Dienst anmelden“** (`SeServiceLogonRight`, über die lokale Sicherheitsrichtlinie),
4. **prüft die Anmeldung** mit Konto und Passwort vorab (Anmeldetyp Dienst). Bei falschem Passwort, gesperrtem oder
   deaktiviertem Konto oder abgelaufenem Passwort bricht es ab, **ohne etwas am Dienst zu ändern** (Exit-Code 3),
5. legt den Dienst `pds-eplan` an oder ändert Konto und Passwort eines vorhandenen (stoppt ihn dafür),
6. setzt Start „automatisch (verzögert)“ und die Wiederherstellung (neu starten nach 10 s, 30 s, 60 s, Fehlerzähler nach
   1 Tag zurückgesetzt, auch bei Fehlern ohne Absturz),
7. gibt `NT SERVICE\pds` das Recht, den Dienst **abzufragen, zu starten und zu stoppen** (dafür braucht die Web-App es
   für „Worker neu starten“),
8. setzt die Ordnerrechte des Kontos (unten) und gibt sie an vorhandene Dateien in diesen Ordnern weiter,
9. startet den Dienst. Lassen sich Rechte nicht setzen oder startet der Dienst nicht, steht das als Warnung da; startet
   er nicht, endet der Befehl mit Exit-Code 1 (der Dienst ist dann trotzdem eingerichtet).

Erneut aufrufen ist der Weg, **Konto oder Passwort zu ändern** (etwa nach einem Passwortwechsel). Bei einem Kontowechsel
entfernt es die Ordnerrechte des alten Kontos. Das Recht „Als Dienst anmelden“ des alten Kontos bleibt (es kann anderen
Diensten gehören).

### Einrichten in der Konfigurationsoberfläche

Bereich **EPLAN-Worker**: oben der Status (Dienst, Konto, Start), darunter die Felder **Konto** und **Passwort** und der
Knopf **„Einrichten“** bzw., wenn der Dienst schon besteht, **„Konto ändern“**, dazu Starten, Stoppen und Neu starten. Die
Abläufe sind dieselben wie in der CLI, auch die Anmeldeprüfung vor jeder Änderung. Das Passwort geht nur an die
Windows-Dienststeuerung; die Oberfläche speichert es nicht. Fehlt der Worker in der Installation, sagt der Bereich das.

### Starten, Stoppen, Status

| Befehl | Wirkung |
| --- | --- |
| `pds eplan status [--json]` | Zustand des Dienstes, Starttyp, Konto und ob `pds-eplan.exe` in dieser Installation vorhanden ist |
| `pds eplan start`, `pds eplan stop`, `pds eplan restart` | Dienst starten, stoppen, neu starten |
| `pds status` | zeigt eine Zeile „EPLAN-Worker“, etwa `läuft (Start: automatisch, verzögert), Konto EXAMPLE\svc-eplan`, `nicht eingerichtet – pds eplan install --user <konto>` oder `fehlt in dieser Installation` |

Admins können den Worker auch in der Web-App neu starten (über das Dienstrecht aus Schritt 7). Stoppt er während einer
Analyse, scheitert diese; wartende Aufträge laufen, sobald er wieder erreichbar ist.

### Rechte des Worker-Kontos

| Ordner im Datenordner | Recht des Worker-Kontos | Wozu |
| --- | --- | --- |
| `uploads\` | Lesen | hochgeladene `.zw1` direkt öffnen |
| `work\` | Ändern | Archive wiederherstellen, Rohdaten schreiben |
| `logs\` | Ändern | `eplan-worker-<Datum>.log` schreiben |
| alles andere (`config.toml`, `tls\`, `state\`, `data\`, `caddy\`) | kein Zugriff | – |

Gesetzt werden die Rechte bei `pds eplan install` und an vorhandene Dateien in diesen drei Ordnern weitergegeben. Ein
Kontowechsel entfernt die Rechte des alten Kontos, `pds eplan uninstall` die des aktuellen. `setup install` (Update,
Reparatur) setzt die Rechte des Datenordners neu, **behält** aber die des Worker-Kontos. Kontrollieren:

```powershell
icacls 'C:\ProgramData\EPLAN Panel Data Service\uploads'   # Worker-Konto mit (RX)
icacls 'C:\ProgramData\EPLAN Panel Data Service\work'      # Worker-Konto mit (M)
icacls 'C:\ProgramData\EPLAN Panel Data Service\logs'      # Worker-Konto mit (M)
```

Fehlen sie (etwa nach einem Kopieren von Hand), stellt ein erneutes `pds eplan install` sie wieder her.

### EPLAN-Pfade, Öffnungsmodus und Neustart des Workers

- Vor jeder Analyse übergibt die App dem Worker die **EPLAN-Pfade** aus den Einstellungen. EPLAN startet beim ersten
  Auftrag und bleibt geladen. Die erste Analyse nach einem Start des Workers dauert deshalb einige Minuten länger (Stufe
  „EPLAN startet“).
- EPLAN lässt sich je Prozess nur einmal starten. Ändert ein Admin die Pfade, während EPLAN mit den alten geladen ist,
  antwortet der Worker mit `restart_required`; die App beendet ihn dann absichtlich, und Windows startet ihn über die
  Wiederherstellung neu (nach 10 s). Das ist kein Fehler.
- Überschreitet eine Analyse das **Zeitlimit** (Standard 60 min), bricht die App sie ab und beendet den Worker ebenso; er
  startet über die Wiederherstellung neu.
- Der **Öffnungsmodus** (`ReadOnly`, Standard; `Standard`; `Exclusive`) gilt für das Öffnen in EPLAN. Gearbeitet wird
  ohnehin auf einer Kopie bzw. auf der hochgeladenen Datei, nie auf dem Original im Projektordner.

### Entfernen

`pds eplan uninstall` stoppt und entfernt den Dienst und nimmt die Ordnerrechte des Kontos zurück. Das Recht „Als Dienst
anmelden“ bleibt beim Konto, weil es anderen Diensten gehören kann; bei Bedarf in `secpol.msc` (Lokale Richtlinien →
Zuweisen von Benutzerrechten → „Als Dienst anmelden“) entfernen. Bei der Deinstallation des Produkts (nicht beim Update)
entfernt `pds setup uninstall` den Dienst (Abschnitt 11); die Rechte im Datenordner bleiben dann stehen, bis er gelöscht
oder bei einer neuen Installation von `setup install` neu eingerichtet wird.

## 8. Zugriff auf den Projektordner

Der Projektordner ist optional; ohne ihn geht nur das Hochladen. Gelesen wird er **nur vom Web-Dienst** `NT SERVICE\pds`:
beim Scan („Aus Ordner wählen“, Zeitplan) und beim Kopieren eines Projekts nach `work\` vor der Analyse. Der Worker
braucht keinen Zugriff. Dieses Konto hat von sich aus keine Rechte auf fremde Ordner; sie müssen ausdrücklich vergeben
werden. Fehlt der Ordner oder darf das Konto ihn nicht lesen, scheitern Scan und Analysen von Ordner-Projekten;
„Verbindung testen“ in der Web-App nennt den Grund.

Es genügt **Lesen** (`(OI)(CI)RX`): Die App schreibt nie in den Projektordner, und EPLAN öffnet nur die Kopie.

### Lokaler Ordner

```powershell
icacls "D:\EPLAN\Projekte" /grant "NT SERVICE\pds:(OI)(CI)RX"
# Kontrollieren
icacls "D:\EPLAN\Projekte"
```

- Das virtuelle Konto gibt es erst, wenn der Dienst installiert ist (nach dem MSI).
- Im Explorer: Eigenschaften → Sicherheit → Bearbeiten → Hinzufügen, Speicherort **lokaler Computer**, Objektname
  `NT SERVICE\pds`.
- `(OI)(CI)` vererbt das Recht auf Unterordner und Dateien. Das braucht es, denn der Scan durchsucht standardmäßig auch
  Unterordner (Einstellung „Unterordner durchsuchen“), und ein `.elk`-Projekt besteht aus der Datei `.elk` und dem Ordner
  `.edb` daneben.

### Netzfreigabe über das Computerkonto (Quelle „lokal“ mit UNC-Pfad)

Der einfachste Weg zu einer Freigabe: Als Projektordner direkt den UNC-Pfad eintragen (z. B.
`\\files.example.com\eplan$\Projekte`), Quelle „lokal“. Das virtuelle Konto meldet sich im Netz als **Computerkonto** des
PDS-Servers an (`DOMÄNE\COMPUTERNAME$`). Auf dem Dateiserver brauchen deshalb das Computerkonto oder eine Gruppe, in der
es Mitglied ist, **Freigabe- und NTFS-Rechte** zum Lesen:

```powershell
# Auf dem Dateiserver (Beispiel: Freigabe eplan$, PDS-Server PDS01 in der Domäne EXAMPLE)
Grant-SmbShareAccess -Name 'eplan$' -AccountName 'EXAMPLE\PDS01$' -AccessRight Read -Force
icacls "E:\Shares\eplan\Projekte" /grant "EXAMPLE\PDS01$:(OI)(CI)RX"
```

Geht nur in einer Domäne; neue Gruppenmitgliedschaften des Computerkontos gelten erst nach einem Neustart des
PDS-Servers. Die Rechte gelten für **alle** Dienste des Servers, die als Computerkonto ins Netz gehen; wer das nicht
möchte (oder im Arbeitsgruppenbetrieb), nimmt ein eigenes Konto (unten).

### Netzlaufwerk mit eigenem Konto (Quelle „Netzlaufwerk“)

In der Web-App unter **Einstellungen**: Quelle „Netzlaufwerk“ und im Abschnitt **Netzlaufwerk** Laufwerksbuchstabe
(z. B. `P`), Netzwerkpfad (`\\files.example.com\eplan$`), Benutzer (`EXAMPLE\svc-pds-share`) und Passwort; als
Projektordner dann den Pfad auf dem Laufwerk (z. B. `P:\Projekte`).

- **Vor dem Zugriff** (Scan, Kopie für eine Analyse) verbindet der **Web-Dienst** das Laufwerk neu (PowerShell bzw.
  `net.exe`). Das Passwort geht dabei nur über **Umgebungsvariablen**, **nie als Prozessargument**; in der Datenbank
  liegt es verschlüsselt. Der Worker arbeitet nur auf der Kopie in `work\` und braucht keine Netzwerkrechte.
- Benutzer und Passwort gehören zusammen; ohne beide geht die App wieder als Computerkonto ins Netz (wie oben).
- Das Konto braucht nur Lesen. Ein eigenes Dienstkonto nehmen, kein persönliches, und nicht das Worker-Konto. Läuft sein
  Passwort ab, scheitern Scan und Analysen von Ordner-Projekten: in der Web-App neu eintragen.

### Interaktiv verbundene Laufwerke sieht der Dienst nicht

Laufwerksbuchstaben gelten je Anmeldesitzung. Ein Laufwerk, das ein Administrator im Explorer oder mit `net use`
verbunden hat, existiert für den Dienst nicht, und umgekehrt sieht der Administrator das Laufwerk des Dienstes nicht.
Steht als Projektordner `P:\…` ohne die Netzlaufwerk-Einstellungen, findet der Dienst den Ordner nicht. Deshalb immer
einen lokalen Pfad, einen UNC-Pfad oder die Netzlaufwerk-Einstellungen verwenden.

## 9. Web-App

Adresse: `https://<Hostname>` (die App-Adresse aus Abschnitt 4). Anmeldung über „Mit Microsoft anmelden“. Sitzungen enden
nach 12 Stunden. Die Web-App ist deutsch und englisch.

### Wer darf was

| Funktion | Alle angemeldeten Personen | Admins (App-Rolle aus `oidc.admin_roles`) |
| --- | --- | --- |
| Projekte ansehen, hochladen (`.zw1`), aus dem Projektordner wählen | ja | ja |
| Analyse starten bzw. erneut analysieren | ja | ja |
| Ergebnisse als Tabellen ansehen, filtern, sortieren, kopieren, als `.xlsx`/CSV herunterladen | ja | ja |
| KI-Assistenten (MCP) verbinden | ja | ja |
| Einstellungen (Projektordner, Netzlaufwerk, EPLAN-Pfade, Öffnungsmodus, Zeitplan, Aufbewahrung, Upload-Grenze) | – | ja |
| Zeitplan ein- und ausschalten | – | ja |
| Protokolle | – | ja |
| Projekte und Analysen löschen | – | ja |
| Worker neu starten | – | ja |

Der Server prüft die Rechte bei jeder Anfrage; Admin-Bereiche sind für andere Personen auch über direkte Adressen nicht
erreichbar.

### Bereiche

- **Übersicht**: Zustand des Workers („Worker nicht erreichbar“), Warteschlange, zuletzt analysierte Projekte; für Admins
  Hinweise (Einstellungen unvollständig, Zeitplan an/aus).
- **Projekte**: Liste mit Suche, „Hochladen“ (`.zw1`) und „Aus Ordner wählen“ (Mehrfachauswahl). Eine Datei mit demselben
  Namen erneut hochgeladen ergibt einen neuen Stand desselben Projekts.
- **Projekt** bzw. **Analyse**: Stände mit Status, Zählern und Ereignissen, „Erneut analysieren“, und die Ergebnisse des
  gewählten Stands (Standard: der neueste) in den Tabellen **Verbindungen**, **Kabel**, **Schirme** und **Texte**.
- **Protokolle** und **Einstellungen** (nur Admins), **KI-Assistenten** (Abschnitt 10).

Die **Tabellen** sind nur lesend und verhalten sich wie eine Tabellenkalkulation: Spaltenfilter, Sortieren, Suche,
Markieren und `Strg+C`, Zähler „x von y Zeilen“ und Export der **gefilterten** Zeilen als `.xlsx` oder CSV; Kabel als
Kabelnavigator mit ihren Adern.

### Ablauf einer Analyse

1. Ein Auftrag kommt in die Warteschlange (Hochladen, „Analysieren“, Zeitplan oder MCP). Ein Projekt hat höchstens einen
   offenen Auftrag; ein zweiter wird abgelehnt.
2. Es läuft immer nur eine Analyse. Vor dem Start legt die App `work\<Analyse-ID>\` an. Projekte aus dem Projektordner
   **kopiert** sie dorthin (`.zw1` bzw. `.elk` mit dem Ordner `.edb`), bei Quelle „Netzlaufwerk“ nach dem Verbinden des
   Laufwerks. Hochgeladene Projekte liest der Worker direkt aus `uploads\`.
3. Der Worker öffnet das Projekt (Stufen: EPLAN startet, Archiv wird wiederhergestellt, Projekt wird geöffnet, Daten
   werden gelesen, Daten werden geschrieben) und meldet Fortschritt und Hinweise; die App zeigt sie als Stufe und
   Ereignisse der Analyse.
4. Die App wertet die Rohdaten aus und speichert Ergebnisse, Zähler und Hinweise in einer Transaktion. Erst danach gilt
   die Analyse als erfolgreich und ihr Stand als der aktuelle des Projekts.
5. Die App löscht den Arbeitsordner. Analysen, die beim Start des Dienstes noch als „läuft“ stehen (etwa nach einem
   Absturz oder Update), setzt sie auf „abgebrochen“; wartende Aufträge bleiben.

Ohne erreichbaren Worker bleiben Aufträge „wartend“. Überschreitet eine Analyse das Zeitlimit, scheitert sie, und die App
startet den Worker neu (Abschnitt 7).

### Einstellungen

| Abschnitt | Felder | Standard |
| --- | --- | --- |
| Projektordner | Ordner (lokal, Laufwerk oder UNC; leer = keine Ordner-Projekte), Quelle (lokal/Netzlaufwerk), Unterordner durchsuchen, Dateimuster | leer, lokal, an, `*.elk` und `*.zw1` |
| Netzlaufwerk | Laufwerksbuchstabe, Netzwerkpfad (UNC), Benutzer, Passwort (Abschnitt 8) | leer |
| EPLAN | Pfad `Bin` der EPLAN Platform, Pfad `Bin` von EPLAN Electric P8, Application Modifier, Öffnungsmodus (`ReadOnly`, `Standard`, `Exclusive`) | `C:\Program Files\EPLAN\Platform\2025.0.3\Bin`, `C:\Program Files\EPLAN\Electric P8\2025.0.3\Bin`, leer, `ReadOnly` |
| Zeitplan | Cron-Ausdruck, Zeitzone (IANA); ein- und ausgeschaltet wird er gesondert | `0 0 2 * * ?` (täglich 2:00), `Europe/Berlin`, aus |
| Grenzen | Zeitlimit je Analyse (Minuten), Upload-Grenze (MB) | 60, 500 |
| Aufbewahrung | ältere Stände nach so vielen Tagen löschen | 180 |

**Netzlaufwerk-Passwort.** Die Web-App zeigt nur, ob ein Wert gesetzt ist; leer lassen heißt „unverändert“, nach einer
Änderung von Freigabe oder Benutzer muss es neu eingegeben werden. Jede Änderung der Einstellungen steht mit Person und
Zeit im Änderungsprotokoll (ohne Passwörter).

**EPLAN-Pfade.** Die beiden Pfade müssen zu der auf dem Server installierten EPLAN-Version passen. Eine Änderung startet
den Worker bei der nächsten Analyse neu, falls EPLAN schon mit den alten Pfaden geladen ist (Abschnitt 7).

**Zeitplan.** Cron im Quartz-Format mit 6 Feldern (`Sekunde Minute Stunde Tag Monat Wochentag`, Wochentage 1 bis 7 mit
Sonntag = 1) oder klassisch mit 5 Feldern (`Minute Stunde Tag Monat Wochentag`, Sonntag = 0 oder 7). Beispiele:
`0 0 2 * * ?` täglich um 2:00, `0 0 * * * ?` stündlich, `0 0/5 * * * ?` alle 5 Minuten. Die Zeitzone bestimmt, wann „2:00“
ist (Sommerzeit inklusive). Zu jedem Termin durchsucht die App den Projektordner nach den Dateimustern, legt neue Projekte
an bzw. aktualisiert vorhandene und reiht einen Auftrag ein für neue, geänderte (neueste Änderungszeit von `.elk` und
`.edb` bzw. der `.zw1`) und zuletzt gescheiterte Projekte. Nach der Installation ist der Zeitplan **aus**.

**Aufbewahrung.** Täglich und zu Beginn eines Zeitplan-Laufs löscht die App Analysen samt Ergebnissen, die älter als die
eingestellte Zahl von Tagen sind, **außer dem aktuellen Stand** jedes Projekts. Ältere hochgeladene Dateien eines Projekts
löscht sie ebenfalls; die Datei des aktuellen Stands bleibt für „Erneut analysieren“.

**Upload-Grenze.** Größte zulässige `.zw1`-Datei beim Hochladen. Die App prüft sie beim Empfang. Caddy lässt für den
Upload (`POST /api/projects/upload`) bis zu 2 GiB durch, ohne Zeitlimit für das Lesen der Anfrage; alle anderen Anfragen
begrenzt er auf 2 MB. Mehr als 2 GiB lassen sich deshalb auch mit einer höheren Upload-Grenze nicht hochladen.

**Verbindung testen** prüft das Netzlaufwerk (nur Quelle „Netzlaufwerk“), den Projektordner (vorhanden, lesbar) und den
Worker (erreichbar, Zustand) und nennt je Schritt das Ergebnis. Es analysiert nichts und ändert nichts.

### Netzlaufwerk-Passwort nach neuem App-Secret

Das Netzlaufwerk-Passwort ist mit einem Schlüssel verschlüsselt, der aus dem App-Secret abgeleitet ist. Nach
`config app-secret regenerate`, einem Umzug auf einen anderen Server oder einer Datenbank, die von einer anderen
Installation stammt, passen Schlüssel und Daten nicht mehr: Das Passwort ist nicht mehr lesbar, und Zugriffe auf den
Projektordner über das Netzlaufwerk scheitern. Das Passwort unter **Einstellungen** neu eintragen und speichern. Alle
Anmeldungen und MCP-Verbindungen sind in diesem Fall ebenfalls ungültig. Das Passwort des Worker-Kontos ist davon nicht
betroffen.

### Protokolle

Der Dienst gibt der App den Logordner mit (`NUXT_LOG_DIR` = `<Datenordner>\logs`). Die Seite **Protokolle** (nur Admins)
zeigt nur Dateien aus diesem Ordner (keine Pfade aus der Anfrage): `service.log` (Dienst), `app.log` (App), `caddy.log`
(Proxy); das Log des Workers (`eplan-worker-<Datum>.log`) liegt im selben Ordner. Die Ereignisse einer Analyse sind in der
Analyse selbst übersichtlicher; `app.log` hilft, wenn die App selbst nicht startet (dann ist die Web-App aber nicht
erreichbar: Logs am Server lesen, Abschnitt 14).

## 10. KI-Assistenten (MCP)

Über MCP (Model Context Protocol) können KI-Assistenten wie Claude Code die Ergebnisse abfragen und, wenn die Person es
zulässt, Analysen starten. **Standard: aus.**

- **Einschalten** (Infrastruktur): Konfigurationsoberfläche → **KI-Assistenten** → „KI-Assistenten (MCP) zulassen“ und
  Speichern, oder `pds config set mcp.enabled true` und `pds service restart --wait`. Ausgeschaltet antworten alle
  MCP-Endpunkte mit 404, bestehende Zugänge sind ungültig.
- **Datenschutz**: Was der Assistent liest (Projektnamen und Pfade, Verbindungs-, Kabel- und Schirmdaten, Texte aus den
  Projekten, Analysen), geht an den Anbieter der KI (bei Claude Code an Anthropic). Die Projektdaten können vertrauliche
  Kundendaten sein. Erst einschalten, wenn Datenschutz und ggf. Betriebsrat das freigegeben haben und der Assistent im
  Unternehmen zugelassen ist.
- **Endpunkt**: `<App-Adresse>/mcp` (die Oberfläche zeigt ihn als „MCP-Adresse“). Der Client braucht HTTPS-Zugang zum
  Server und muss dessen Zertifikat vertrauen.
- **Verbinden**: jede angemeldete Person. In der Web-App unter **KI-Assistenten** steht der Befehl zum Kopieren, etwa
  `claude mcp add --transport http pds https://pds.example.com/mcp`; danach in Claude Code `/mcp` → Server wählen →
  „Authenticate“. Die Anmeldung läuft über den Browser (OAuth der App selbst, dahinter die Entra-Anmeldung). Die Person
  wählt dabei die Stufe „Nur lesen“ oder „Lesen und ändern“ (`write`). Eine Verbindung gilt höchstens 30 Tage und lässt
  sich auf der Seite jederzeit trennen.

| Werkzeug | Stufe | Zweck |
| --- | --- | --- |
| `get_status` | lesen | Worker, Warteschlange, Zeitplan, Hinweise |
| `list_projects`, `get_project` | lesen | Projekte und ihre Stände |
| `list_folder_projects` | lesen | Projekte im Projektordner |
| `get_analysis` | lesen | eine Analyse mit Zählern und Ereignissen |
| `query_connections` | lesen | Verbindungen filtern (Seite, Kabel, Bezeichnung, Quelle/Ziel, #, verdrillt, geschirmt), seitenweise |
| `query_cables`, `list_shields`, `list_texts` | lesen | Kabel mit Adern, Schirme, Texte |
| `get_settings` | lesen, nur Admins | Einstellungen ohne Geheimnisse |
| `start_analysis` | `write` | Analyse eines Projekts oder eines Pfads im Projektordner einreihen (Auslöser „MCP“) |
| `set_scheduler`, `update_settings` | `write`, nur Admins | Zeitplan ein- oder ausschalten, Einstellungen ändern, **ohne** Geheimnisse |

Ohne Angabe liefern die Werkzeuge den aktuellen Stand eines Projekts; ein älterer lässt sich über die Analyse wählen.
Geheimnisse lassen sich über MCP **nie** setzen oder lesen. Was ein Assistent ändert, steht wie jede andere Änderung mit
der Person im Änderungsprotokoll. Ein neues App-Secret macht alle MCP-Verbindungen ungültig.

## 11. Update, Deinstallation, Sichern

### Update

Das neue MSI einfach über die alte Version installieren (interaktiv oder `msiexec /i … /qn`). Windows Installer
**stoppt beide Dienste** (`pds` und, falls eingerichtet, `pds-eplan`), bevor es die Dateien ersetzt, entfernt die alte
Version, installiert die neue und startet den Web-Dienst wieder. **Konfiguration, Zertifikat, Secrets und Logs
bleiben**, ebenso alles in der Datenbank (Einstellungen, Projekte, Analysen, Ergebnisse, Zustand des Zeitplans: ein
eingeschalteter Zeitplan läuft nach dem Update weiter) und `uploads\`.

Der **Worker-Dienst bleibt samt Konto und Passwort erhalten**: Das MSI legt ihn nicht neu an, und `setup install` startet
ihn nach dem Ersetzen der Dateien wieder (wenn er nicht deaktiviert ist) und behält seine Ordnerrechte. Eine Analyse, die
beim Stoppen lief, steht danach als abgebrochen; wartende Aufträge laufen nach dem Update weiter. Updates deshalb
möglichst nicht während eines Zeitplan-Laufs einspielen.

Die Einrichtung durch das MSI (`setup install`) läuft dabei noch einmal: Sie setzt die Rechte des Datenordners (und eines
eigenen SQLite-Ordners) erneut, registriert die Ereignisquelle und gleicht die Firewall-Regel an. Dabei fallen
**zusätzliche Berechtigungen** weg, die ein Administrator am Datenordner, an Unterordnern oder an `config.toml`
eingetragen hat (die des Worker-Kontos nicht); Ereignisprotokoll (Warnung, Event-ID 2) und `logs\service.log` nennen sie
mit Konto und SID. Sicherungsprogramme lesen den Ordner deshalb besser als SYSTEM oder mit dem Sicherungsrecht.
Konfiguration, Zertifikat und Secrets rührt sie nicht an; ist `config.toml` unlesbar, bleibt sie mit einer Warnung
unverändert, und das Update scheitert nicht. Die Rechte auf den Projektordner bleiben unberührt.

Die App aktualisiert die Datenbank beim Start selbst (Migrationen; SQL Server sperrt dabei per `sp_getapplock`, SQLite
über die Schreibtransaktion). Ein gleich- oder höherversioniertes MSI gilt als Update; ein **Downgrade ist gesperrt**.
Vorher die Datenbank sichern (SQLite: `pds db backup <Datei>`, Abschnitt 5).

Mit `pds status` kontrollieren (Zustand „läuft“, Versionen, Datenbank, Zeile „EPLAN-Worker“); ist der SQL Server gerade
nicht erreichbar oder die SQLite-Datei gesperrt, wartet der Dienst im Zustand „wartet auf erneuten Versuch“ und startet
von selbst. Ein Update **ohne** Worker (MSI ohne EPLAN-DLLs) über eine Installation mit eingerichtetem Worker lässt den
Dienst `pds-eplan` ohne Programm zurück: `pds status` meldet „fehlt in dieser Installation“; ein MSI mit Worker
installieren.

### Deinstallation

```powershell
msiexec /x pds-<version>-x64.msi /qn                  # Dienste, Programme, Firewall-Regel weg, Daten bleiben
msiexec /x pds-<version>-x64.msi /qn REMOVE_DATA=1    # zusätzlich %ProgramData%\EPLAN Panel Data Service\
```

Das MSI muss das der **installierten** Version sein (oder „Programme und Features“). Entfernt werden Web-Dienst,
Programme, `PATH`- und Startmenü-Eintrag, Firewall-Regel und Ereignisquelle; den **Worker-Dienst `pds-eplan`** stoppt das
MSI vorher, und `setup uninstall` entfernt ihn (nur bei der Deinstallation, nicht beim Update). Ohne `REMOVE_DATA=1`
bleiben Konfiguration, Zertifikat, Logs und `uploads\` für eine spätere Installation erhalten (den Worker dann mit
`pds eplan install` neu einrichten). Mit `REMOVE_DATA=1` verschwinden sie, **samt `data\pds.db` und den hochgeladenen
Projekten** (vorher sichern). Eine SQLite-Datei unter eigenem Pfad, die SQL-Server-Datenbank, der Projektordner und EPLAN
bleiben immer unberührt. Rechte für `NT SERVICE\pds` am Projektordner bleiben als verwaiste SID stehen (vorher mit
`icacls … /remove "NT SERVICE\pds"` entfernen), „Als Dienst anmelden“ beim Worker-Konto ebenso (Abschnitt 7).

### Sichern und Umziehen

Fachdaten liegen in der **Datenbank** (SQLite: `pds db backup`, Abschnitt 5; SQL Server: Sicherung der DBAs) und in
**`uploads\`** (die hochgeladenen `.zw1`, nötig für „Erneut analysieren“). Beide gehören zusammen: Die Unterordner von
`uploads\` heißen nach den Projekt-IDs der Datenbank. `work\` enthält nur Zwischenstände laufender Analysen und wird
**nicht** gesichert. Der übrige Datenordner enthält Infrastruktur-Konfiguration und Zertifikat; seine Secrets sind **an
den Computer gebunden** (DPAPI) und lassen sich nicht auf einen anderen Server kopieren. Eine SQLite-Datenbank dagegen
schon: Sie ist eine gewöhnliche Datei.

`uploads\` sichert man als SYSTEM oder mit dem Sicherungsrecht (etwa mit dem Sicherungsprogramm der IT oder
`robocopy … /B`), möglichst zur selben Zeit wie die Datenbank. Zurückgespielte Dateien nach `uploads\` **kopieren**, nicht
verschieben (eine Kopie erbt die Rechte des Ordners, auch die des Worker-Kontos); fehlen die Rechte trotzdem, gibt ein
erneutes `pds eplan install` sie an die vorhandenen Dateien weiter.

Für einen **Umzug**:

1. auf dem alten Server den Zeitplan in der Web-App ausschalten und `pds config export <datei>` (Secrets als `***`),
   dann beide Dienste stoppen (`pds service stop`, `pds eplan stop`);
2. auf dem neuen Server EPLAN Platform und Electric P8 in derselben Version installieren und für das Worker-Konto
   lizenzieren, das MSI installieren, `config import`, die Secrets neu setzen (`config set … --stdin`) und das
   Zertifikat neu importieren; die SQL-Server-Datenbank bleibt dieselbe (oder wird von den DBAs umgezogen), eine
   SQLite-Datenbank kommt als Sicherung (`db backup` auf dem alten Server) an ihren Platz auf dem neuen (bei gestopptem
   Dienst kopieren, siehe „Zurückspielen“ in Abschnitt 5);
3. den Inhalt von `uploads\` vom alten auf den neuen Server kopieren (als Administrator, etwa mit `robocopy … /E /B`);
4. den **Worker neu einrichten**: `pds eplan install --user <Konto>` (Dienst und Rechte gehören zum Server, nicht zu den
   Daten);
5. Leserechte auf den Projektordner für den neuen Server vergeben (Abschnitt 8; bei Netzfreigaben das neue
   Computerkonto);
6. in der Web-App das Netzlaufwerk-Passwort neu eintragen (der neue Server hat ein neues App-Secret, Abschnitt 9),
   „Verbindung testen“, Zeitplan wieder einschalten.

Wer das Netzlaufwerk-Passwort über einen Umzug retten will, setzt das App-Secret von Anfang an selbst (mindestens 32
Zeichen, `pds config set app.secret --stdin`), verwahrt es in der Secret-Verwaltung der IT und setzt auf dem neuen
Server denselben Wert. Ein später geändertes App-Secret beendet alle Sitzungen und MCP-Verbindungen. Die übrigen Secrets
(auch das Passwort des Worker-Kontos) verwaltet die IT ohnehin in ihrer Secret-Verwaltung.

## 12. CLI-Referenz

`pds <Befehl>`; Hilfe zu jedem Befehl mit `--help`. Meldungen sind deutsch. Wo ein Befehl `--json` kennt, ist die
Ausgabe für Skripte gedacht. Die meisten Befehle brauchen Administratorrechte (Datenordner, Dienststeuerung). Die CLI
verwaltet nur **Infrastruktur und Worker**; die fachlichen Einstellungen gibt es nur in der Web-App (Abschnitt 9) und
über MCP (Abschnitt 10).

### Exit-Codes

| Code | Bedeutung |
| --- | --- |
| 0 | OK |
| 1 | Fehler: falsche Bedienung (auch `db setup`/`db script` bei SQLite, `db backup` bei SQL Server), Datei oder Dienst nicht erreichbar, Datenordner fehlt, Timeout beim Stoppen; bei `eplan install` auch: Konto abgelehnt, `pds-eplan.exe` fehlt in dieser Installation |
| 2 | Validierungsfehler: `config validate` meldet Fehler, `tls import` lehnt das Zertifikat ab, oder `db …`/`oidc test` starten nicht, weil die Konfiguration Fehler hat |
| 3 | Prüfung oder Werkzeug fehlgeschlagen: `db test`, `db setup`, `db script`, `db backup` (das Node-Werkzeug scheitert), `oidc test`, `ports check`, `service start --wait`, `service restart --wait`; `eplan install`: Anmeldung des Kontos mit dem Passwort fehlgeschlagen (nichts geändert) |

`status` und `config show` enden mit 0, auch bei Befunden: sie berichten, sie prüfen nicht.

### Befehle

| Befehl | Zweck |
| --- | --- |
| `status [--json]` | Dienst (SCM), Zustand, Adresse, Datenbank (Art und Datei bzw. Server), Health intern und öffentlich, Versionen, Zertifikatsablauf, letzter Fehler, Befunde, EPLAN-Worker. Ein veralteter Status (Heartbeat älter als 30 s) erscheint als „Dienst läuft nicht (letztes Lebenszeichen vor … s)“. |
| `run` | Web-Dienst im Vordergrund starten (zum Fehlersuchen), Strg+C beendet geordnet. Geht nur bei gestopptem Dienst (`service stop`). Läuft mit dem angemeldeten Konto, nicht mit dem Dienstkonto: Ordnerrechte und Netzlaufwerke verhalten sich dabei anders als im Dienst. Den Worker startet `run` nicht. |
| `service start [--wait [--timeout <Sekunden>]]` | Web-Dienst starten; mit `--wait` warten, bis er läuft und die App antwortet (sonst Exit-Code 3) |
| `service stop [--timeout <Sekunden>]` | Web-Dienst stoppen und warten, bis er steht (`--wait` ist erlaubt, aber ohne Wirkung); eine laufende Analyse wird abgebrochen |
| `service restart [--wait [--timeout <Sekunden>]]` | Neu starten, übernimmt geänderte Konfiguration. Mit `--wait` Exit-Code 3 samt Grund bei Konfigurationsfehler, „nicht eingerichtet“ oder Zeitüberschreitung. Ein Status von **vor** dem Neustart zählt nicht. |
| `config show [--json]` | Alle Felder (Secrets als `***`, leere als `""`) mit den Befunden der Prüfung |
| `config set <Feld> <Wert>` | Ein Feld setzen (Tabelle unten), speichert sofort |
| `config set <Secret-Feld> [--stdin \| --clear]` | Secret setzen: verdeckte Abfrage oder eine Zeile von stdin; `--clear` entfernt es |
| `config validate [--json]` | Konfiguration prüfen, Exit-Code 2 bei Fehlern |
| `config export [<Datei>]` | Konfiguration als TOML (Secrets als `***`) |
| `config import <Datei>` | Konfiguration aus einer Datei im Exportformat übernehmen (siehe unten) |
| `config app-secret regenerate [--yes]` | Neues App-Secret. **Alle Sitzungen und MCP-Verbindungen werden ungültig, das gespeicherte Netzlaufwerk-Passwort ist nicht mehr lesbar** (in der Web-App neu eintragen, Abschnitt 9). Ohne Terminal ist `--yes` nötig. |
| `tls import --pfx <Datei> [--password-stdin]` | Zertifikat samt Schlüssel aus PFX |
| `tls import --pem <Zertifikat> <Schlüssel>` | … aus PEM-Dateien |
| `tls import --store <Fingerabdruck>` | … aus `LocalMachine\My` (SHA-1, nur Windows) |
| `tls show [--json]` | Aussteller, Namen, Ablauf des gespeicherten Zertifikats und ob es zu `public.host` passt |
| `db test [--json]` | Datenbank der gespeicherten Konfiguration prüfen. SQL Server: Verbindung, `db_owner`, `READ_COMMITTED_SNAPSHOT`, Migrationen; SQLite: vorhandene Datei öffnen (legt nie etwas an; fehlt sie oder ihr Ordner, meldet es das), beschreibbar mit WAL, Version, Migrationen |
| `db backup <Datei> [--json]` | Nur SQLite: Sicherung im laufenden Betrieb in eine neue Datei, danach geprüft (Abschnitt 5) |
| `db setup --admin-user <Login> [--admin-password-stdin] [--json]` | Nur SQL Server: Datenbank, Login und Benutzer einrichten (Abschnitt 5) |
| `db script [<Datei>]` | Nur SQL Server: SQL-Skript für DBAs (sqlcmd/SQLCMD-Modus); ohne Datei auf die Standardausgabe |
| `oidc test [--check-client] [--json]` | OpenID-Discovery des Ausstellers prüfen, optional Client-ID und -Secret |
| `ports check [--json]` | Prüfen, ob `listen.http_port`, `public.port` (nicht bei `tls.mode = off`) und `internal.port` frei sind; bei Belegung Besitzer, bei http.sys (PID 4) ein Hinweis |
| `eplan install --user <Konto> [--password-stdin]` | EPLAN-Worker einrichten bzw. Konto und Passwort ändern; prüft vorher die Anmeldung (Exit-Code 3 ohne Änderung). Ablauf in Abschnitt 7 |
| `eplan uninstall` | Dienst `pds-eplan` stoppen und entfernen, Ordnerrechte des Kontos zurücknehmen; „Als Dienst anmelden“ bleibt |
| `eplan status [--json]` | Zustand, Starttyp, Konto, ob `pds-eplan.exe` in dieser Installation vorhanden ist |
| `eplan start`, `eplan stop`, `eplan restart` | Worker-Dienst starten, stoppen, neu starten |

Die Befehle `setup install` und `setup uninstall` sind versteckt: Sie gehören dem MSI, ebenso `daemon` (Start durch den
Dienststeuerungs-Manager). `--version` zeigt die Produktversion.

**`--timeout`** gilt nur mit `--wait` (bei `service stop` allein): 1 bis 3600 Sekunden, Standard 90. Er zählt ab dem Start,
die Wartezeit auf die App also **nach** dem Stoppen; das Stoppen beim Neustart kann bis zu 60 s zusätzlich dauern.

**Secrets nie als Argument.** `config set` lehnt einen Wert für ein Secret-Feld (`db.password`, `oidc.client_secret`,
`tls.acme_eab_hmac`, `app.secret`) mit einer Fehlermeldung ab, ebenso `tls import --password` und `db setup
--admin-password`. Für das Passwort des Worker-Kontos gibt es keine Option, nur die verdeckte Abfrage oder
`--password-stdin`. Eine **leere** Eingabe oder fehlende Eingabe (Ende der Pipe) wird abgelehnt: Ein Secret löscht nur
`--clear`. `--stdin` bzw. `--password-stdin` liest genau eine Zeile.

**`config import`** erwartet eine **vollständige** Datei im Exportformat. Fehlende Schlüssel erhalten die Standardwerte,
fehlende Secrets werden gelöscht, `***` behält das vorhandene Secret, ein Klartext-Secret wird verschlüsselt gespeichert
(die Datei danach löschen). Eine unlesbare vorhandene Konfiguration lässt sich so ersetzen.

### Felder von `config set`

| Feld | Standard | Bedeutung |
| --- | --- | --- |
| `public.host` | – | Hostname der App, ohne Schema und Port; Pflicht |
| `public.port` | 443 | Öffentlicher HTTPS-Port (Teil der App-Adresse, wenn ≠ 443) |
| `public.scheme` | `https` | Nur bei `tls.mode = off`: Schema der öffentlichen Adresse (`http` oder `https`) |
| `listen.http_port` | 80 | HTTP-Port von Caddy (leitet auf HTTPS um; bei `off` der einzige Port) |
| `internal.port` | 3000 | Port von Node auf 127.0.0.1 |
| `tls.mode` | `certificate` | `certificate`, `acme`, `internal` oder `off` |
| `tls.acme_email`, `tls.acme_ca_url`, `tls.acme_ca_root`, `tls.acme_eab_key_id` | – | ACME (Abschnitt 6) |
| `tls.acme_eab_hmac` | – | Secret: EAB-HMAC-Schlüssel |
| `db.kind` | `sqlite` | `sqlite` oder `sqlserver` (Abschnitt 5); ohne Angabe in einer `config.toml` `sqlserver`, wenn `db.server` gesetzt ist |
| `db.path` | – | Nur SQLite: Datenbankdatei, vollständiger lokaler Pfad; leer = `data\pds.db` im Datenordner |
| `db.server` | – | Nur SQL Server: Hostname oder IPv4, ohne Port und Instanz; Pflicht |
| `db.port` | 1433 | Nur SQL Server: TCP-Port |
| `db.database` | `pds` | Nur SQL Server: Datenbankname |
| `db.user` | `pds_app` | Nur SQL Server: SQL-Login |
| `db.password` | – | Nur SQL Server: Secret, Passwort des SQL-Logins; Pflicht |
| `db.encrypt` | `true` | Nur SQL Server: Verbindung verschlüsseln |
| `db.trust_server_certificate` | `false` | Nur SQL Server: Serverzertifikat nicht prüfen (nur Tests) |
| `oidc.tenant_id` | – | Verzeichnis-ID (GUID); Pflicht, solange kein eigener Issuer gesetzt ist |
| `oidc.issuer` | – | Eigener Issuer (`https://…`), ersetzt die Tenant-ID |
| `oidc.client_id` | – | Anwendungs-ID (bei Entra eine GUID); Pflicht |
| `oidc.client_secret` | – | Secret; ohne meldet die Prüfung eine Warnung |
| `oidc.scopes` | `openid profile email` | Scopes |
| `oidc.roles_claim` | `roles` | Claim mit den App-Rollen |
| `oidc.admin_roles` | `Admin` | Rollen mit Admin-Rechten in der Web-App (kommagetrennt); alle anderen angemeldeten Personen sind Benutzer |
| `oidc.provider_name` | `Microsoft` | Anzeigename auf der Anmeldeseite |
| `proxy.url`, `proxy.no_proxy` | – | Ausgehender Proxy (`http(s)://host:port`, **ohne** Zugangsdaten) und Ausnahmen |
| `mcp.enabled` | `false` | KI-Assistenten (MCP), Abschnitt 10 |
| `app.secret` | bei Installation erzeugt | Secret: signiert Sitzungen und Zugänge, Schlüsselgrundlage des Netzlaufwerk-Passworts; mindestens 32 Zeichen |

Wahrheitswerte: `true` oder `false`. Der Worker hat keine Felder in `config.toml`; ihn steuern `pds eplan …` und die
EPLAN-Pfade in der Web-App. Der Dienst bildet aus den Feldern beim Start die Umgebung der App (`NUXT_DATABASE_URL`,
`NUXT_APP_SECRET`, `NUXT_PUBLIC_APP_URL`, `NUXT_OIDC_*`, `NUXT_PUBLIC_MCP_ENABLED` …) und ergänzt `NUXT_LOG_DIR`
(Logordner), `NUXT_PDS_DATA_DIR` (Datenordner mit `uploads\` und `work\`), `NUXT_EPLAN_WORKER`
(`pipe:\\.\pipe\pds-eplan`) und `PDS_VERSION` (Produktversion).

### Prüfregeln

`config validate`, `status` und der Start des Dienstes verwenden dieselben Regeln; jeder Befund hat Feldpfad und Code
(`db.server: … (named_instance_not_supported)`). Fehler verhindern den Start von Caddy und Node, Warnungen nicht.
Wichtig: **Hostname** aus Buchstaben, Ziffern, `-`, `.` oder eine IP; Ports 1–65535 und verschieden. **SQL Server**:
Hostname oder IPv4, **kein `\Instanz`, kein IPv6**, Namen ohne `]` und `'`, keine Systemdatenbank, Passwort gesetzt.
**SQLite** (`db.path`): lokaler vollständiger Pfad an erlaubter Stelle (Abschnitt 5). **Proxy**: `http(s)://` **ohne
Zugangsdaten**. **Zertifikat**: vorhanden, gültig, passt zu Schlüssel und DNS-Namen. **Entra**: Tenant- und Client-ID
als GUID; **ACME**: gültige E-Mail, CA-URL mit `https://`, EAB nur vollständig. **App-Secret**: mindestens 32 Zeichen.

Die fachlichen Einstellungen prüft die Web-App beim Speichern; fehlt etwas, zeigt die Übersicht „Einstellungen
unvollständig“.

## 13. Sicherheit

### Wo was liegt

| Was | Wo | Schutz |
| --- | --- | --- |
| DB-Passwort, Client-Secret, App-Secret, ACME-EAB-HMAC | `config.toml` als `dpapi:<base64>` | DPAPI im Maschinen-Scope mit festem Entropie-Wert; Datenordner-ACL |
| TLS-Zertifikatskette | `tls\certificate.pem` | öffentlich, Datenordner-ACL |
| TLS-Schlüssel | `tls\key.dpapi` | DPAPI, Datenordner-ACL |
| Passwort des Worker-Kontos | Dienststeuerungs-Manager (SCM) | von Windows verschlüsselt als LSA-Secret gespeichert; **nie** in `config.toml`, Logs, Datenbank oder Prozess-Argumenten |
| Netzlaufwerk-Passwort | Datenbank, `pds.settings` | AES-256-GCM, Schlüssel aus dem App-Secret abgeleitet; nach außen (Web-App, MCP) nur als „gesetzt“ |
| Projekte, Analysen, Ergebnisse, Ereignisse, Änderungen | Datenbank, Schema `pds` bzw. Tabellen `pds_…` der SQLite-Datei | SQL-Server-Rechte bzw. ACL von `data\` (oder des eigenen Ordners); enthalten keine Passwörter |
| Hochgeladene Projekte | `uploads\` | ACL: Administratoren, SYSTEM, `NT SERVICE\pds` (Ändern), Worker-Konto (Lesen) |
| Arbeitskopien während einer Analyse | `work\` | ACL: Administratoren, SYSTEM, `NT SERVICE\pds` und Worker-Konto (Ändern); nach der Analyse gelöscht |
| SQLite-Sicherungen (`db backup`) | wo der Admin sie ablegt | nur die Rechte des Zielordners: geschützt ablegen |
| PFX-Passwort, Admin-Zugang von `db setup` | nirgends | nur im Speicher, nur für den Vorgang |
| ACME-Konten und -Schlüssel (Modi `acme`, `internal`) | `caddy\` | nur die ACL (Caddys Speicherformat) |
| Status, Logs | `state\`, `logs\` | enthalten nie Secrets: Werte in der Ausgabe der Kindprozesse werden vor dem Schreiben durch `***` ersetzt |

### DPAPI und ACL

DPAPI im Maschinen-Scope kann **jeder lokale Benutzer** öffnen, der die Datei lesen kann. Der Schutz ist deshalb die **ACL**
des Datenordners: Besitzer Administratoren, Vererbung getrennt, SYSTEM und Administratoren Vollzugriff, das Dienstkonto
`NT SERVICE\pds` Lesen (Ändern nur auf `state\`, `logs\`, `caddy\`, `data\`, `uploads\` und `work\`), das Worker-Konto
nur auf `uploads\` (Lesen), `work\` und `logs\` (Ändern), sonst niemand. Diese Rechte nicht lockern und den Ordner nicht
freigeben. Aus demselben Grund legt ihn nur das MSI an (Abschnitt 1). Eine SQLite-Datei unter einem eigenen Pfad hat die
Rechte ihres Ordners (Abschnitt 5): Wer sie lesen kann, liest alle Anwendungsdaten.

Wer `config.toml` lesen kann, kann das App-Secret entschlüsseln und mit Zugriff auf die Datenbank auch das
Netzlaufwerk-Passwort. Beide Grenzen gehören zusammen: Datenordner nur für Administratoren, Datenbank nur für das
App-Login, die DBAs und (über die Sichten) die Leser der Ergebnisse.

### Trennung der Konten

- Der **Web-Dienst** (virtuelles Konto) hat nur, was ausdrücklich vergeben wird: Datenordner, Lesen auf dem Projektordner
  (nie Schreiben), ggf. ein eigener SQLite-Ordner.
- Nur der **Worker** hat das EPLAN-Konto. Er sieht weder Konfiguration noch Schlüssel noch Datenbank, liest nur `uploads\`,
  schreibt nur in `work\` und `logs\` und braucht kein Netz außer zum Lizenzserver. Die **Pipe** ist per ACL beschränkt,
  ohne Port und ohne Token.
- `NT SERVICE\pds` darf den Worker-Dienst nur **abfragen, starten und stoppen**, nicht umkonfigurieren.

### Secrets nie in Argumenten, Logs oder Dateien

- Die CLI lehnt Secrets als Argument ab (Abschnitt 12); das MSI hat keine Properties dafür; `config show` und `config export`
  zeigen `***`.
- Das **Passwort des Worker-Kontos** übergibt `pds eplan install` (bzw. die Oberfläche) nur an die Prüfung der Anmeldung
  und an den Dienststeuerungs-Manager. Es steht nie in `config.toml`, in Logs, in der Datenbank oder in den Argumenten
  eines Prozesses.
- An Node gehen Secrets nur über den **Umgebungsblock** des Kindprozesses, an Caddy nur über **stdin**: Der Dienst startet
  `caddy run --config -` und schreibt die JSON-Konfiguration (mit Zertifikat und Schlüssel) in dessen stdin; es gibt keine
  Caddyfile auf der Platte.
- Die Kinder erben nie die ganze Umgebung des Dienstes, nur eine kleine Windows-Grundumgebung und ihre eigenen Variablen
  (Node zusätzlich, was es braucht, um `powershell.exe` und `net.exe` für das Netzlaufwerk zu starten).
- Das Netzlaufwerk-Passwort geht nur über Umgebungsvariablen an PowerShell, nie als Argument; es steht daher nicht in den
  Befehlszeilen der Prozesse. Ereignisse der Analysen und `app.log` enthalten keine Passwörter.
- MCP liefert Passwörter nie aus und kann sie nicht setzen (Abschnitt 10).
- Caddy läuft ohne Admin-API (`admin.disabled`) und ohne Autosave (`admin.config.persist = false`): Es gibt keine
  `autosave.json` mit dem Schlüssel auf der Platte.

### Loopback-Grenze

Node lauscht nur auf `127.0.0.1:<internal.port>` und ist von außerhalb des Servers nicht erreichbar. **Lokal angemeldete
Benutzer** (RDP, Konsole) erreichen ihn trotzdem, denn Windows filtert Loopback nicht. Die Anmeldung der App gilt dabei
weiterhin; umgangen werden nur Caddys Header und seine Größengrenze für Anfragen. Interaktive Anmeldungen am Server
deshalb auf Administratoren beschränken (das Worker-Konto eingeschlossen: es soll sich nicht interaktiv anmelden).

### Bekannte Grenzen

- In der Oberfläche und bei `config import` bedeutet ein Secret von **genau `***`** „unverändert“; ein Passwort, das so
  lautet, lässt sich nur mit `config set <Secret-Feld>` setzen.
- Secrets sind an den Computer gebunden (DPAPI): `config.toml` lässt sich nicht auf einen anderen Server kopieren
  (Abschnitt 11). Das Netzlaufwerk-Passwort hängt am App-Secret (Abschnitt 9), das Passwort des Worker-Kontos am Dienst
  dieses Servers.
- Von Hand in `config.toml` eingetragene Klartext-Secrets lehnt der Dienst ab (Befund `config_unreadable`, Zustand „nicht
  eingerichtet“). Secrets immer über CLI oder Oberfläche setzen.
- Wer Administrator auf dem Server ist, kann den Worker-Dienst umkonfigurieren und damit Programme unter dem Worker-Konto
  starten. Das Worker-Konto deshalb nicht mit weiteren Rechten ausstatten als EPLAN braucht.

## 14. Fehlersuche

### Wo nachsehen

1. **`pds status`**: Zustand („nicht eingerichtet“, „startet“, „läuft“, „wartet auf erneuten Versuch“ (`backoff`),
   „Konfigurationsfehler“, „wird beendet“, „gestoppt“), Health, letzter Fehler, Befunde, Zeile „EPLAN-Worker“.
2. **`pds eplan status`**: Zustand des Worker-Dienstes, Starttyp, Konto, Programm vorhanden.
3. **Web-App**: **Übersicht** (Worker, Warteschlange, Hinweise), die **Analyse** (Stufe, Ereignisse, Fehlercode).
4. **Logs** in `%ProgramData%\EPLAN Panel Data Service\logs\`: `service.log`, `app.log`, `caddy.log`,
   `eplan-worker-<Datum>.log`, etwa `Get-Content '…\logs\app.log' -Tail 50 -Wait`. In der Oberfläche öffnet **Status** →
   „Logdatei öffnen …“ eine Datei im Editor; bewusst kein Explorer (der würde den Benutzer dauerhaft in die ACL des
   geschützten Ordners eintragen).
5. **Ereignisprotokoll**: Anwendung, Quelle `pds` (Zustandswechsel, Fehler, Zertifikatswarnung, Warnungen der
   Einrichtung: Firewall, beiseite gelegter Ordner, entfernte zusätzliche Berechtigungen); **System, Quelle Service
   Control Manager** für beide Dienste (Start gescheitert, unerwartet beendet).
   `Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'pds' } -MaxEvents 20 | Format-List TimeCreated, LevelDisplayName, Message`
   `Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = 7000, 7031, 7034, 7038 } -MaxEvents 20 | Format-List TimeCreated, Id, Message`
6. **Vordergrund**: `pds service stop`, dann `pds run`: der Web-Dienst mit Log auf der Konsole (mit dem eigenen Konto
   statt des Dienstkontos, Abschnitt 12). Für den Worker: `pds-eplan.exe run --dialogs` unter dem Worker-Konto (unten).
7. **MSI-Log** der Installation, falls mit `/l*v` aufgezeichnet.

### Typische Meldungen: Dienst und Infrastruktur

| Meldung oder Zustand | Ursache und Maßnahme |
| --- | --- |
| „Dienst läuft nicht (letztes Lebenszeichen vor … s)“ | Heartbeat älter als 30 s: Der Dienst ist gestoppt oder abgestürzt, `status.json` ist veraltet. `Get-Service pds`, Ereignisprotokoll und `service.log` ansehen, `service start --wait`. |
| „nicht eingerichtet“ mit Befunden | Die Konfiguration hat Fehler, Caddy und Node laufen nicht. `pds config validate` nennt Feld und Code; beheben, `service restart --wait`. |
| Befund `config_unreadable` | `config.toml` ist kaputt: TOML-Fehler, unbekanntes Feld, unbekannte Schema-Version, Klartext-Secret oder ein Secret, das sich nicht entschlüsseln lässt (anderer Computer). Kein Absturz, kein Neustart-Sturm. Reparieren mit `pds config import <Datei>`. |
| „Port 80 ist bereits belegt (z. B. durch IIS/http.sys)“, ebenso für Port 443 (`backoff`) | Ein anderer Prozess hält den Port. `pds ports check` nennt den Besitzer. **PID 4 „System (http.sys)“** ist IIS, WinRM oder eine andere URL-Reservierung; auf dem Windows-Runner der CI hält http.sys Port 80. `netsh http show servicestate` zeigt, welche URLs http.sys bedient. Die Reservierung bzw. IIS entfernen oder **einen anderen Port wählen**: `listen.http_port` (z. B. 8080; die Umleitung auf HTTPS gilt dann nur dort) bzw. `public.port` (ändert die App-Adresse und damit die Redirect-URI in Entra ID). Die Firewall-Regel zieht beim Speichern nach, dann `service restart --wait`. Wird der Port frei, startet der Dienst von selbst. |
| „Datenbank nicht bereit: …“ (`backoff`) | SQL Server nicht erreichbar oder Anmeldung abgelehnt. Das ist **kein** Konfigurationsfehler: Der Dienst versucht es mit wachsender Wartezeit (bis 5 min) weiter, auch nach einem Reboot. Ursache mit `pds db test` finden (Tabelle in Abschnitt 5). Solange läuft auch keine Analyse. |
| „Datenbank nicht bereit (SQLite): …“ (`backoff`) | Die App kann ihre SQLite-Datei nicht öffnen oder beschreiben. Der Text nennt die Ursache: Ordner fehlt oder dem Dienstkonto fehlt „Ändern“ (Konfiguration als Administrator speichern, `msiexec /fa` oder `icacls … /grant "NT SERVICE\pds:(OI)(CI)M"`, Abschnitt 5), Datei schreibgeschützt, von einem anderen Programm gesperrt (Sicherung, Virenscanner), keine SQLite-Datei, beschädigt (Sicherung zurückspielen) oder Laufwerk voll. Der Dienst versucht es weiter und startet von selbst, sobald die Ursache weg ist. `pds db test` läuft als Administrator und kann deshalb ok melden, obwohl das Dienstkonto nicht schreiben darf. |
| Befund `sqlite_network_path`, `sqlite_path_forbidden`, `sqlite_path_not_absolute`, `invalid_path` an `db.path` | Der eigene SQLite-Pfad liegt auf einem Netzlaufwerk, an einer verbotenen Stelle oder ist unvollständig (Abschnitt 5). Lokalen eigenen Ordner wählen, etwa `D:\PDS\pds.db`, oder das Feld leeren (Standard `data\pds.db`). |
| Warnung „Rechte für die SQLite-Datenbank … nicht gesetzt“ beim Speichern | Das Speichern konnte den Ordner nicht anlegen oder dem Dienstkonto kein Ändern geben (ohne Administratorrechte, Verweis statt Ordner). Gespeichert ist die Konfiguration trotzdem; Ursache beheben und erneut speichern oder die Rechte von Hand setzen (Abschnitt 5). |
| `db setup`/`db script`: „… gilt nur für SQL Server“, `db backup`: „… gilt nur für SQLite“ | Die gespeicherte `db.kind` passt nicht zum Befehl: `pds config show` zeigt sie. |
| `config_error` | Die App lehnt ihre Konfiguration ab (Meldung mit `[config]`, z. B. App-Secret zu kurz). Die Prüfung des Dienstes fängt das normalerweise vorher ab. **Kein automatischer Neustart**; nach der Korrektur `service restart --wait`. |
| `certificate_missing`, `certificate_expired`, `certificate_hostname_mismatch`, `certificate_key_mismatch` | Zertifikat fehlt, ist abgelaufen, gilt nicht für `public.host` (nur DNS-Namen, keine IP) oder passt nicht zum Schlüssel. Neu importieren (Abschnitt 6). `tls_wrong_password`: PFX-Passwort falsch. Nach einem Import in der Oberfläche mit einem **geänderten, aber nicht gespeicherten Hostnamen** ist `certificate_hostname_mismatch` zu erwarten: Der Import speichert nur das Zertifikat, nicht den Hostnamen. Den Hostnamen speichern oder das zum gespeicherten Hostnamen passende Zertifikat erneut importieren (Abschnitt 6). |
| Browser meldet Zertifikatsfehler | Zwischenzertifikate fehlen in PFX/PEM, oder die Firmen-CA fehlt im Browser. `tls show` zeigt Aussteller und Namen. |
| Seite leer oder Fehler unter IP-Adresse oder Kurzname | Caddy bedient nur den Namen aus `public.host`; die App prüft außerdem den `Origin` gegen die App-Adresse. Immer den konfigurierten Namen verwenden. |
| Entra meldet „redirect URI does not match“ (AADSTS50011) | Redirect-URI in der App-Registrierung weicht von `<App-Adresse>/auth/callback` ab (Schema, Hostname, Port). Unter **Anmeldung** → „Redirect-URI“ kopieren. |
| Entra meldet, die Person sei der Anwendung nicht zugewiesen (AADSTS50105) | „Zuweisung erforderlich“ ist an und die Person bzw. ihre Gruppe ist der Unternehmensanwendung nicht zugewiesen (Abschnitt 4). Auch normale Benutzer brauchen eine Zuweisung (Rolle `User`). |
| `service restart --wait` endet mit Exit-Code 3 | Der Grund steht dabei: Konfigurationsfehler, „nicht eingerichtet“ oder Zeitüberschreitung (dann `status` und Logs ansehen). Standard 90 s, mit `--timeout` bis 3600; beim Neustart kommt das Stoppen (bis 60 s) dazu. |
| „Das Werkzeug fehlt …“ bei `db …`/`oidc test` | `tools\pds-tools.mjs` oder `node\node.exe` fehlt im Installationsordner: Installation reparieren (`msiexec /fa <msi>`). |
| „Datenordner fehlt …“ | Der Datenordner wurde nie vom MSI angelegt oder gelöscht: Installation reparieren (`msiexec /fa <msi>`) oder als Administrator `pds setup install`. Nicht von Hand anlegen. |
| `tls import --store`: Schlüssel nicht exportierbar | Das Zertifikat im Speicher hat keinen exportierbaren privaten Schlüssel. Als PFX exportieren und mit `--pfx` importieren. |
| Ordner `EPLAN Panel Data Service (unsicher …)` in `%ProgramData%` | Ein bereits vorhandener Ordner gehörte nicht eindeutig dem Produkt (fremder Besitzer, geerbte Rechte, Verweis) und wurde beiseite gelegt (Ereignisprotokoll). Inhalt prüfen und nach Klärung löschen. Zusätzliche Berechtigungen allein führen nicht dazu, sie werden nur entfernt. **Lagen darin die SQLite-Datenbank** (`data\pds.db`) **oder hochgeladene Projekte** (`uploads\`), läuft der Dienst jetzt ohne sie: Dienst stoppen, beides aus dem beiseite gelegten Ordner zurückkopieren, starten (Abschnitt 1); danach `pds eplan install` für die Rechte des Worker-Kontos. |
| Einrichtung bricht ab: „…\data ist kein echter Ordner … wird nicht beiseite gelegt“ | `data\` im Datenordner ist eine Junction, ein Link oder eine Datei. Damit die SQLite-Datenbank nicht verloren geht, legt `setup install` ihn nicht beiseite. Durch einen echten Ordner mit demselben Inhalt ersetzen (oder die Datenbank an einen eigenen Ort legen, `db.path`) und die Installation wiederholen. |
| „Zusätzliche Berechtigungen am Datenordner entfernt: …“ (Warnung bei Installation oder Update) | Jemand hatte am Datenordner, an einem Unterordner oder an `config.toml` Rechte für weitere Konten eingetragen; `setup install` hat sie entfernt (Abschnitt 11). Nur Administratoren, SYSTEM, das Dienstkonto und (auf `uploads\`, `work\`, `logs\`) das Worker-Konto haben Zugriff. War darunter ein Konto mit **Schreibrecht**, die Konfiguration prüfen (`config show`, `tls show`). |
| `status`: „Status nicht lesbar – bitte als Administrator ausführen“, „Konfiguration nicht lesbar – …“ | `status` lief ohne Administratorrechte; der Datenordner ist nur für Administratoren lesbar. Die Shell „als Administrator“ öffnen. Steht statt des Hinweises ein Grund da (etwa „beschädigt“), ist die Datei kaputt: Der Dienst schreibt `status.json` beim nächsten Herzschlag neu, `config.toml` repariert `config import`. |
| Firewall-Warnung bei Installation oder beim Speichern | Die Regel „EPLAN Panel Data Service (HTTP/HTTPS)“ ließ sich nicht anlegen (Firewall-Dienst aus, GPO). Ports von Hand freigeben. |

### Typische Meldungen: EPLAN-Worker

| Meldung oder Zustand | Ursache und Maßnahme |
| --- | --- |
| `pds status`: EPLAN-Worker „nicht eingerichtet – pds eplan install --user <konto>“ | Der Dienst `pds-eplan` existiert nicht (frische Installation, nach `eplan uninstall` oder einem Umzug). Einrichten (Abschnitt 7). |
| „fehlt in dieser Installation“, `eplan install` lehnt mit Exit-Code 1 ab | Das MSI wurde ohne EPLAN-DLLs gebaut (`-SkipEplanWorker`, etwa aus der CI) und enthält `eplan\pds-eplan.exe` nicht. Ein MSI mit Worker installieren (Abschnitt 16). |
| `eplan install` lehnt das Konto ab | Kein Benutzerkonto: LocalSystem, `NT AUTHORITY\…`, `NT SERVICE\…` oder ein Konto mit `$` am Ende (gMSA, Computerkonto), oder das Konto lässt sich nicht auflösen (Schreibweise, Domäne erreichbar?). Ein Benutzerkonto in der Form `DOMÄNE\Benutzer`, `.\Benutzer` oder UPN angeben. |
| `eplan install` endet mit Exit-Code 3 (Anmeldung fehlgeschlagen) | Falsches Passwort, Konto gesperrt oder deaktiviert, Passwort abgelaufen oder muss bei der nächsten Anmeldung geändert werden. Am Dienst wurde **nichts** geändert. Konto in der Domäne prüfen, dann erneut. |
| Dienst startet nicht, System-Ereignis 7038 oder 7000 (Service Control Manager) | Anmeldung des Dienstes gescheitert: Passwort inzwischen geändert oder abgelaufen, Konto gesperrt, oder das Recht „Als Dienst anmelden“ fehlt wieder (eine Domänen-GPO hat es überschrieben, Abschnitt 7). `pds eplan install --user <Konto>` mit dem aktuellen Passwort; bei der GPO das Konto dort aufnehmen. |
| System-Ereignis 7031 oder 7034 (unerwartet beendet) | Der Worker-Prozess ist beendet worden. Nach einer Änderung der EPLAN-Pfade (`restart_required`) oder einer Zeitüberschreitung beendet die App ihn absichtlich, Windows startet ihn über die Wiederherstellung neu (10 s, 30 s, 60 s): kein Fehler. Sonst `eplan-worker-<Datum>.log` ansehen (Absturz von EPLAN beim Öffnen eines Projekts?). |
| Web-App: „Worker nicht erreichbar“, Aufträge bleiben „wartend“ | Der Worker-Dienst läuft nicht, startet gerade (verzögerter Start nach einem Reboot) oder ist nicht eingerichtet. `pds eplan status`; `pds eplan start`. Startet er nicht, Ereignisse wie oben. |
| „Worker neu starten“ in der Web-App scheitert | `NT SERVICE\pds` fehlt das Recht, den Dienst zu starten und zu stoppen (etwa weil der Dienst von Hand angelegt oder umkonfiguriert wurde). `pds eplan install` erneut ausführen; es setzt das Recht wieder. |
| Analyse hängt minutenlang in der Stufe „EPLAN startet“ | Normal bei der ersten Analyse nach einem Start des Workers. Dauert es bis zum Zeitlimit oder scheitert es mit `eplan_start_failed`: EPLAN nicht unter den eingestellten Pfaden installiert, falsche Version, fehlende Lizenz für das Worker-Konto oder ein EPLAN-Dialog, der im Dienst nicht erscheinen kann. EPLAN-Pfade prüfen, Lizenz wie unten prüfen. |
| Analyse scheitert mit `not_configured` | Der Worker hat keine EPLAN-Pfade bekommen: Einstellungen der Web-App prüfen (**EPLAN**). |
| Analyse scheitert mit `project_not_found` | Die Projektdatei fehlt in `work\` bzw. `uploads\` oder der Worker darf sie nicht lesen: Rechte des Worker-Kontos prüfen (Abschnitt 7, `icacls`), notfalls `pds eplan install` erneut. |
| Analyse scheitert mit `restore_failed` oder `archive_without_project` | Das `.zw1`-Archiv ließ sich nicht wiederherstellen bzw. enthält kein Projekt: Archiv in EPLAN prüfen, neu erzeugen. Schreibrecht des Worker-Kontos auf `work\` prüfen. |
| Analyse scheitert mit `open_failed` | EPLAN konnte das Projekt nicht öffnen (beschädigt, neuere EPLAN-Version, gesperrt). Öffnungsmodus prüfen; das Projekt mit EPLAN selbst öffnen. |
| Analyse scheitert mit `read_failed` oder `write_failed` | Fehler beim Lesen der Daten in EPLAN bzw. beim Schreiben der Rohdaten in `work\` (Rechte, Platz auf dem Laufwerk). `eplan-worker-<Datum>.log` ansehen. |
| `restart_required` | Die EPLAN-Pfade wurden geändert, während EPLAN mit den alten geladen war. Der Worker startet von selbst neu; die nächste Analyse läuft mit den neuen Pfaden. |
| Analyse scheitert nach dem Zeitlimit | Das Projekt braucht länger als das eingestellte Zeitlimit (Standard 60 min), oder EPLAN hängt (etwa an einem Dialog). Zeitlimit in den Einstellungen erhöhen bzw. mit `run --dialogs` nachsehen (unten). Die App startet den Worker danach neu. |
| `eplan-worker-<Datum>.log` fehlt | Das Worker-Konto darf nicht in `logs\` schreiben, oder der Dienst ist nie gestartet. `pds eplan install` erneut (setzt die Rechte), dann `pds eplan status`. |

### EPLAN-Lizenz unter dem Konto prüfen

Im Dienst kann EPLAN keine Dialoge zeigen. Ob Lizenz und Einstellungen für das Worker-Konto stimmen, zeigt deshalb der
Worker in der Konsole mit erlaubten Dialogen. In einer **Eingabeaufforderung (`cmd.exe`) als Administrator**:

```bat
pds eplan stop
runas /user:EXAMPLE\svc-eplan "\"C:\Program Files\EPLAN Panel Data Service\eplan\pds-eplan.exe\" run --dialogs"
```

- `runas` fragt das Passwort ab und startet den Worker als dieses Konto in einem eigenen Konsolenfenster. `run` ist
  derselbe Worker wie im Dienst und lauscht auf derselben Pipe: Die Web-App kann ihn benutzen. Jetzt eine Analyse
  starten; `--dialogs` lässt die Dialoge von EPLAN zu (Lizenzauswahl, Fehlermeldungen), die im Dienst unsichtbar
  blieben. Eine Lizenzauswahl speichert EPLAN im Profil des Kontos.
- Danach den Worker mit **Strg+C** beenden und den Dienst wieder starten: `pds eplan start`.
- `runas` setzt voraus, dass sich das Konto lokal anmelden darf („Lokal anmelden zulassen“). Den Befehl in `cmd.exe`
  ausführen, nicht in PowerShell (die Anführungszeichen sind für `cmd.exe` geschrieben).

Die weitere Betriebsart `pds-eplan.exe stdio` ist nur für die Entwicklung gedacht.

### Typische Meldungen: Web-App und Analysen

| Meldung oder Zustand | Ursache und Maßnahme |
| --- | --- |
| Einstellungen, Protokolle oder Löschen fehlen in der Web-App | Die Person hat die Admin-Rolle nicht, oder der Wert der Rolle passt nicht zu `oidc.admin_roles` bzw. der Claim nicht zu `oidc.roles_claim` (Abschnitt 4). Rolle zuweisen, abmelden, neu anmelden. |
| Zeitplan läuft nicht | Zeitplan aus (Standard nach der Installation), Cron-Ausdruck oder Zeitzone ungültig, oder die Einstellungen sind unvollständig (Hinweis auf der Übersicht). |
| „Aus Ordner wählen“ findet nichts, Analysen von Ordner-Projekten scheitern | Projektordner leer eingestellt, falscher Pfad, Dateimuster passen nicht, „Unterordner durchsuchen“ aus, oder `NT SERVICE\pds` darf den Ordner nicht lesen (Abschnitt 8). Ein interaktiv verbundenes Laufwerk (`P:\…`) sieht der Dienst nicht. „Verbindung testen“ nennt den Grund. |
| Netzlaufwerk lässt sich nicht verbinden | Netzwerkpfad, Benutzer, Passwort (abgelaufen?), Freigaberechte, Port 445. Systemfehler 1219 heißt: Zum selben Server besteht schon eine Verbindung mit anderem Konto (etwa ein UNC-Ordner über das Computerkonto); nur einen Weg verwenden. Nach einem neuen App-Secret: Passwort neu eintragen (Abschnitt 9). |
| Hochladen wird abgelehnt | Keine `.zw1`-Datei (`.elk` mit `.edb` geht nur über den Projektordner) oder größer als die Upload-Grenze (Einstellungen). |
| Analyse wird abgelehnt, weil schon ein Auftrag offen ist | Für das Projekt wartet oder läuft bereits eine Analyse. Abwarten. |
| Analyse „abgebrochen“ | Der Dienst wurde während der Analyse gestoppt (Update, Neustart, Absturz). Erneut analysieren. |
| Tabellen zeigen einen älteren Stand | Die neueste Analyse ist gescheitert; der aktuelle Stand bleibt die letzte erfolgreiche. Die Ereignisse der gescheiterten Analyse ansehen. |
| Seite **Protokolle** zeigt einen Hinweis statt der Dateien | Die App läuft ohne `NUXT_LOG_DIR`, also nicht als Windows-Dienst (Entwicklung). |

### Erster Dienststart nach der Installation

Der erste Start des Web-Dienstes nach der Erstinstallation dauert rund 20 s, und zwar **vor** dem Programmstart: Windows
legt das Profil des virtuellen Kontos an (`C:\Windows\ServiceProfiles\pds`). Spätere Starts brauchen unter 0,1 s; das
Profil bleibt auch nach einer Deinstallation. Der Smoke-Test der CI misst das bei jedem Lauf (Artefakt `smoke-logs`).
Das MSI wartet nicht eigens auf „läuft“ (`ServiceControl … Wait="no"`), der Startaufruf kehrt aber erst mit dem
Dienstprozess zurück; `msiexec` endet also erst nach diesen rund 20 s. Scheitert ein Start, steht im Systemprotokoll ein
SCM-Ereignis (7000, 7009 oder 7011); dann `pds service start --wait`.

Beim ersten Start des **Worker-Dienstes** legt Windows ebenso das Profil des Worker-Kontos an (`C:\Users\<Konto>`), und
die erste Analyse startet EPLAN; beides dauert einmalig länger.

## 15. Abnahme-Checkliste Windows Server 2022

Die CI prüft das MSI auf einem frischen Windows-Runner (Abschnitt 16), aber **ohne EPLAN-Worker**, ohne Reboot, echte
Entra-Anmeldung, PKI-Zertifikat, WebView2 offline, Server Core und Netzfreigaben. Die Gesamtabnahme läuft deshalb mit
dieser Liste auf einer **frischen VM** (Windows Server 2022 x64, Snapshot vorher) in der Domäne, mit installiertem und
lizenziertem EPLAN Platform und Electric P8, einem Worker-Konto mit Lizenz und einem MSI **mit** Worker. Der
Windows-Betrieb ist **fertig**, wenn die Kriterien A bis F erfüllt sind; darunter folgen weitere Prüfungen.

### A. Installation (interaktiv und still) und Start nach einem Reboot

- [ ] **A1 Interaktive Installation** (als Administrator): ohne Fehler. `Get-Service pds`: Anzeigename „EPLAN Panel Data
  Service“, Konto `NT SERVICE\pds`, „Automatisch (Verzögerter Start)“; Firewall-Regel, Startmenü-Eintrag (startet nach
  UAC), `eplan\pds-eplan.exe`, `uploads\` und `work\` vorhanden, **kein** Dienst `pds-eplan`. `pds status` in einer neuen
  Shell: „nicht eingerichtet“, EPLAN-Worker „nicht eingerichtet – pds eplan install --user <konto>“.
- [ ] **A2 Stille Installation** (frische VM bzw. Snapshot): `msiexec /i pds-<version>-x64.msi /qn /l*v
  C:\Temp\install.log` endet mit Exit-Code 0, alles aus A1 gilt; danach das Skript aus Abschnitt 2 samt Worker.
- [ ] **A3 Nach einem Reboot** (nach B und F), **ohne** Anmeldung: Nach wenigen Minuten liefert
  `https://<Hostname>/api/health` von einem anderen Rechner `{"status":"ok"}`, eine Analyse über die Web-App gelingt, ein
  eingeschalteter Zeitplan läuft; danach zeigt `pds status` „läuft“ für Dienst und Worker. Mit SQL Server, der später
  hochkommt: erst „wartet auf erneuten Versuch“, dann „läuft“, ohne Eingriff.

### B. Datenbank und Entra ID einstellen und testen, Health grün, Anmeldung

- [ ] **B0 SQLite (Standard)**: „Verbindung testen“ ⇒ ok („gibt es noch nicht“). Nach dem Speichern zeigt **Status**
  „SQLite: C:\ProgramData\…\data\pds.db“, daneben `-wal` und `-shm`, `icacls …\data` zeigt `NT SERVICE\pds:(OI)(CI)(M)`;
  `pds db backup C:\Temp\pds-test.db` ⇒ 0. Eigener Pfad `D:\PDS\pds.db` wird angelegt; ein UNC-Pfad wird abgelehnt
  (`sqlite_network_path`). Der Wechsel zu SQL Server (B1) warnt vor der leeren Datenbank.
- [ ] **B1 SQL Server in der Oberfläche**: „Einrichten …“ oder SQL-Skript der DBAs, dann „Verbindung testen“ ⇒ alle
  Schritte ok (Verbindung, `db_owner`, `READ_COMMITTED_SNAPSHOT`, Migrationen); falsches Passwort ⇒ `login_failed`.
- [ ] **B2 Entra ID**: **Anmeldung** → Tenant-ID, Client-ID, Client-Secret, „mitprüfen“, „Prüfen“ ⇒ ok; falsches Secret ⇒
  `client_secret_invalid`.
- [ ] **B3 Per CLI**: `pds db test` und `pds oidc test --check-client` ⇒ Exit-Code 0; falsches Datenbankpasswort ⇒
  Exit-Code 3 mit `login_failed`.
- [ ] **B4 Health grün**: **Speichern** bzw. `pds service restart --wait` ⇒ „läuft“, „Health intern“ und „Health
  öffentlich“ je „ok (HTTP 200)“; von außen `https://<Hostname>/api/health` ohne Zertifikatswarnung.
- [ ] **B5 Anmeldung**: „Web-App öffnen“ startet den Browser **nicht** erhöht. Eine Person mit `Admin` sieht
  Einstellungen und Protokolle; eine mit `User` sieht Projekte und Tabellen, aber keine Admin-Bereiche; eine nicht
  zugewiesene kann sich nicht anmelden.
- [ ] **B6 PKI-Zertifikat**: Browser ohne Warnung, `tls show` stimmt, Ablaufdatum unter **Status**.
- [ ] **B7 Sichten** (SQL Server): Mit einem Lese-Login wie in Abschnitt 5 liefert nach E3
  `SELECT TOP 10 * FROM pds.v_current_connections` Zeilen mit `project_id`, `project_name`, `analysis_id`; ein `SELECT`
  auf `pds.settings` wird abgelehnt.

### C. Update über ein neues MSI

- [ ] **C1 Konfiguration bleibt**: `Get-FileHash` von `config.toml` und `pds config export` vorher und nachher gleich,
  `tls show` unverändert, `pds status` „läuft“ mit neuer Version, Health ok. Ein älteres MSI wird abgelehnt.
- [ ] **C2 Migrationen**: `pds db test` meldet nachher gleiche oder höhere Zahlen („Migrationen ausgeführt: core N,
  pds M“); `logs\app.log` ohne Fehler seit dem Neustart, `status` ohne „Letzter Fehler“.
- [ ] **C3 Daten bleiben**: Einstellungen, Zustand des Zeitplans, Projekte, Stände und Tabellen sind nach dem Update
  unverändert, `uploads\` ebenso; das Netzlaufwerk-Passwort gilt als gesetzt; „Erneut analysieren“ eines hochgeladenen
  Projekts gelingt.
- [ ] **C4 Worker bleibt**: Vor dem Update `pds eplan status` (läuft, Konto `EXAMPLE\svc-eplan`) und `icacls` auf
  `uploads\`, `work\`, `logs\` notieren. Nach dem Update: Dienst `pds-eplan` mit **demselben Konto**, ohne erneute
  Passworteingabe wieder gestartet; die Rechte des Kontos sind unverändert; eine Analyse gelingt.

### D. Keine Secrets im Klartext (Datenträger, Datenbank, Logs, Prozessargumente)

- [ ] **D1 Marker-Suche**: Für diese Prüfung Test-Secrets mit eindeutigem Marker setzen (DB-Passwort, Client-Secret,
  PFX-Passwort, Netzlaufwerk-Passwort, **Passwort des Worker-Kontos**, z. B. `ZZ-Marker-Db-7431`), einrichten wie in B,
  E und F (der Worker mit `--password-stdin`), beide Dienste neu starten, eine Analyse über das Netzlaufwerk ausführen und
  jeden Marker suchen. **Keine der Abfragen darf etwas finden:**

  ```powershell
  $marker = 'ZZ-Marker-Db-7431'   # nacheinander für jedes Secret
  # Befehlszeilen aller Prozesse
  Get-CimInstance Win32_Process | Where-Object CommandLine -like "*$marker*"
  # Ereignisprotokolle (Anwendung, Quelle pds; System)
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'pds' } | Where-Object Message -like "*$marker*"
  Get-WinEvent -LogName System -MaxEvents 2000 | Where-Object Message -like "*$marker*"
  # MSI-Log der Installation
  Select-String -SimpleMatch $marker -Path C:\Temp\install.log
  # Datenordner samt logs\, caddy\, uploads\ (UTF-8 und UTF-16)
  Get-ChildItem 'C:\ProgramData\EPLAN Panel Data Service' -Recurse -File | Select-String -SimpleMatch $marker
  Get-ChildItem 'C:\ProgramData\EPLAN Panel Data Service' -Recurse -File | Select-String -SimpleMatch $marker -Encoding Unicode
  ```

  Sonderzeichen: zusätzlich die URL-kodierte Form suchen (`[uri]::EscapeDataString($marker)`). Gesperrte Logdateien: für
  die Suche beide Dienste stoppen. In der Datenbank (DBAs): `pds.settings`, `pds.analysis_events` und `pds.audit` ohne
  Marker.
- [ ] **D2 Positive Gegenprobe**: In `config.toml` steht bei `password`, `secret` und `hmac` nur `dpapi:<base64>` oder
  `""`; `tls\key.dpapi` beginnt mit `dpapi:`; in `pds.settings` steht das Netzlaufwerk-Passwort verschlüsselt. Die
  Befehlszeilen enthalten nur `…\node.exe --use-system-ca …\app\pds-entry.mjs`, `…\caddy.exe run --config -` und
  `…\pds-eplan.exe service`.
- [ ] **D3 Prozesserstellung**: Mit eingeschalteter Überwachung der Prozesserstellung samt Befehlszeile findet
  `Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688 } | Where-Object Message -like "*$marker*"` nichts,
  weder nach einer Analyse über das Netzlaufwerk (Ereignisse für `powershell.exe`/`net.exe` vorhanden) noch nach
  `pds eplan install --password-stdin`.

### E. Web-App und Analysen

- [ ] **E1 Zeitplan nach der Installation aus**; bis E5 entsteht keine Analyse von selbst.
- [ ] **E2 Einstellungen**: EPLAN-Pfade passend zur Installation, lokaler Projektordner, „Verbindung testen“ ⇒ Ordner und
  Worker ok. Gegenproben: Ordner ohne Recht für `NT SERVICE\pds` ⇒ Ordnerfehler; `pds eplan stop` ⇒ Worker nicht
  erreichbar. Das Änderungsprotokoll zeigt die Person, kein Passwort.
- [ ] **E3 Hochgeladenes Projekt**: `.zw1` hochladen ⇒ Analyse endet „erfolgreich“ mit Zählern; alle vier Tabellen zeigen
  Daten, Filter und Sortierung wirken, `.xlsx`/CSV enthalten genau die gefilterten Zeilen; die Datei liegt unter
  `uploads\<Projekt-ID>\`, `work\` ist danach leer. Erneut hochgeladen ⇒ derselbe Projekt-Eintrag, zweiter Stand.
- [ ] **E4 Projekt aus dem Ordner**: „Aus Ordner wählen“ findet auch Projekte in Unterordnern; zwei ausgewählte werden
  nacheinander analysiert, die Originale bleiben unverändert. Ebenso mit Quelle „Netzlaufwerk“ und mit UNC-Pfad über
  das Computerkonto.
- [ ] **E5 Zeitplan**: `0 0/5 * * * ?` und einschalten ⇒ neue und geänderte Projekte werden mit Auslöser „Zeitplan“
  analysiert, unveränderte nicht. Danach zurückstellen.
- [ ] **E6 Rechte**: Ohne Admin-Rolle keine Einstellungen, Protokolle und kein Löschen, auch nicht über direkte Adressen;
  Admins sehen unter **Protokolle** die Logdateien mit Filter und Download.

### F. EPLAN-Worker

- [ ] **F1 Falsches Passwort**: `pds eplan install --user EXAMPLE\svc-eplan` ⇒ Exit-Code 3, `pds-eplan` nicht angelegt
  (bzw. ein vorhandener unverändert). `NT AUTHORITY\NETWORK SERVICE` und ein Konto mit `$` am Ende werden abgelehnt.
- [ ] **F2 Richtiges Passwort ⇒ läuft**: Exit-Code 0; `pds eplan status` „läuft“, automatisch (verzögert), Konto;
  `sc.exe qc pds-eplan` zeigt `…\eplan\pds-eplan.exe service`; `sc.exe qfailure pds-eplan` Neustarts nach 10000, 30000,
  60000 ms, Reset 86400 s, `sc.exe qfailureflag pds-eplan` gesetzt; „Als Dienst anmelden“ in `secpol.msc`; `icacls`:
  Lesen auf `uploads\`, Ändern auf `work\` und `logs\`, nichts auf `config.toml`; `eplan-worker-<Datum>.log` entsteht;
  `pds status` zeigt „EPLAN-Worker: läuft (Start: automatisch, verzögert), Konto …“.
- [ ] **F3 Oberfläche**: **EPLAN-Worker** zeigt denselben Zustand; „Konto ändern“ auf ein zweites lizenziertes Konto ⇒
  läuft unter dem neuen, die Rechte des alten sind entfernt; Starten, Stoppen, Neu starten wirken.
- [ ] **F4 Neustart aus der Web-App**: „Worker neu starten“ (Admin) ⇒ neue Prozess-ID von `pds-eplan`, ohne Fehler; die
  nächste Analyse gelingt.
- [ ] **F5 Pfade ändern** (falls eine zweite EPLAN-Version installiert ist): nach einer Analyse die Pfade ändern ⇒ der
  Worker startet von selbst neu, die nächste Analyse gelingt mit den neuen Pfaden.
- [ ] **F6 Lizenzprüfung** wie in Abschnitt 14: `runas` startet den Worker, eine Analyse läuft über ihn, Strg+C,
  `pds eplan start` übernimmt wieder.
- [ ] **F7 Entfernen**: `pds eplan uninstall` entfernt Dienst und Ordnerrechte; nach `msiexec /x …` gibt es weder `pds`
  noch `pds-eplan`, der Datenordner mit `uploads\` bleibt.
- [ ] **F8 MSI ohne Worker** (aus der CI): `pds status` meldet „fehlt in dieser Installation“, `pds eplan install` endet
  mit Exit-Code 1.

### Weitere Prüfungen

- [ ] **Deinstallation ohne Daten**: Dienste und Firewall-Regel weg, `%ProgramData%\EPLAN Panel Data Service\` bleibt;
  erneute Installation übernimmt die Konfiguration, nach `pds eplan install` läuft der Worker wieder. **Mit
  `REMOVE_DATA=1`**: Datenordner samt `uploads\` weg. Datenbank auf dem SQL Server, Projektordner und EPLAN bleiben in
  beiden Fällen.
- [ ] **WebView2 offline**: VM ohne Internet und ohne WebView2-Runtime installieren; die Konfigurationsoberfläche startet.
- [ ] **Logdatei öffnen**: **Status** → „Logdatei öffnen …“ startet im Logordner; `service.log` öffnet im Editor mit
  Inhalt (kein „Datei nicht gefunden“, keine leere neue Datei).
- [ ] **Status ohne Administratorrechte**: In einer **nicht** erhöhten PowerShell zeigt `pds status` „Status nicht lesbar –
  bitte als Administrator ausführen“ und „Konfiguration nicht lesbar – …“.
- [ ] **Zusätzliche Berechtigung und Update**: `icacls 'C:\ProgramData\EPLAN Panel Data Service' /grant
  '*S-1-5-32-545:(OI)(CI)R'`, dann dasselbe MSI erneut installieren: kein Ordner „(unsicher …)“, kein Eintrag für
  Benutzer mehr (Ordner und `config.toml`), die Einträge des Worker-Kontos sind noch da, Warnung „Zusätzliche
  Berechtigungen am Datenordner entfernt: …“ im Ereignisprotokoll.
- [ ] **Server Core** (falls EPLAN dort unterstützt ist): stille Installation, Einrichtung vollständig per CLI
  (`config import`, `tls import`, `db setup`, `eplan install --password-stdin`, `service restart --wait`), Web-App von
  einem anderen Rechner erreichbar.
- [ ] **Port belegt** (z. B. IIS auf 443): „Port 443 ist bereits belegt …“, nach dem Freigeben startet der Dienst selbst.
  **Kaputte `config.toml`**: „nicht eingerichtet“ mit `config_unreadable`, kein Neustart-Sturm.
- [ ] **KI-Assistenten** (falls vorgesehen): MCP einschalten, in der Web-App unter **KI-Assistenten** mit Claude Code
  verbinden („Nur lesen“): `get_status`, `list_projects` und `query_connections` antworten, `start_analysis` wird
  abgelehnt; mit „Lesen und ändern“ reiht `start_analysis` eine Analyse mit Auslöser „MCP“ ein; `get_settings` geht nur
  für Admins und zeigt keine Passwörter. MCP ausschalten ⇒ `/mcp` antwortet mit 404.
- [ ] **SQLite-Rechte nach Verschieben**: eine `pds.db` nach `D:\PDS\` **verschieben**, `db.path` setzen und speichern ⇒
  `icacls D:\PDS\pds.db` zeigt `NT SERVICE\pds:(M)`, der Dienst läuft.
- [ ] **Passwortwechsel des Worker-Kontos**: Passwort in der Domäne ändern, Server neu starten ⇒ `pds-eplan` startet
  nicht (System-Ereignis 7038/7000), die Web-App zeigt „Worker nicht erreichbar“; `pds eplan install` mit dem neuen
  Passwort ⇒ läuft wieder.
- [ ] **Prüfungen der Entwicklung**: Die Workflows `ci.yml` und `windows.yml` (Abschnitt 16) sind für den abgenommenen
  Stand grün.

## 16. Für Entwickler

Aufbau des Repositorys:

| Ordner | Inhalt |
| --- | --- |
| `apps/web` | Nuxt-App (`@pds/web`): Projekte, Analysen, Tabellen, Einstellungen, Protokolle, Warteschlange (Nitro-Plugin), MCP-Werkzeuge, Schema `pds` |
| `packages/analyzer` | reines TS-Paket: Rohdaten des Workers → Zeilen (Verbindungen, Kabel, Schirme, Texte), Zähler, Hinweise; unter Linux testbar |
| `packages/core`, `packages/ui` | Nuxt-Layer: Datenbank (SQL Server und SQLite), Migrationen, OIDC, Sessions, OAuth/MCP-Grundgerüst bzw. Siemens-Design |
| `worker/` | .NET-Framework-4.8.1-Worker `pds-eplan` (EPLAN-API), Stubs für Builds ohne EPLAN, Tests |
| `windows/` | Windows-Betrieb (unten) |
| `docker/` | SQL Server, Dex und glauth (Test-LDAP) **nur für die Entwicklung** |
| `e2e/` | Playwright-Tests |
| `tools/fake-worker` | Ersatz-Worker (Node) für Entwicklung und E2E, spricht das Worker-Protokoll |

`windows/`, `packages/core`, `packages/ui` und das Gerüst von `e2e/` stammen aus dem EPLAN Smart Wiring Controller (ESWC)
und wurden umbenannt; Fehlerbehebungen dort prüfen und bei Bedarf übernehmen. Im Windows-Teil: `pds-common/`
(Konfiguration, Validierung, Secrets, TLS, Rendern, Status, Windows-Plattform), `pds/` (Dienst, Supervisor, CLI samt
`pds eplan …`), `pds-config/` (Tauri-Oberfläche, `ui/` = `@pds/config-ui`), `node-tools/` (`pds-tools.mjs`,
`pds-entry.mjs`), `installer/` (WiX v5), `scripts/` (Fremdkomponenten, Payload samt Worker, MSI, Signieren, Smoke-Test)
und `vendor.json`.

### Entwicklungsumgebung

Docker dient nur der Entwicklung; die Ports weichen von ESWC und Trainee Planner ab, damit alle nebeneinander laufen:

```bash
pnpm install
pnpm db:up            # SQL Server auf 127.0.0.1:1435
pnpm sso:up           # zusätzlich Dex (5558) und glauth (3895)
pnpm dev              # Web-App auf http://localhost:3400
pnpm test:e2e         # Playwright mit eigenem Dev-Server auf 3500
```

Unter Linux gibt es kein EPLAN: Die App spricht mit dem **Ersatz-Worker** (gleiches Protokoll, Beispiel-Rohdaten), etwa
`NUXT_EPLAN_WORKER='spawn:node tools/fake-worker/index.mjs' pnpm dev`. `spawn:<Befehl>` startet den Worker als
Kindprozess über stdin/stdout (unter Windows auch den echten im Modus `stdio`); im Betrieb steht dort
`pipe:\\.\pipe\pds-eplan`. Test-Benutzer (Dex): `anna` (Admin), `paul`, `lena`, `nina`, Passwort jeweils `<name>-pass`.
Außerhalb des Windows-Dienstes fehlt `NUXT_LOG_DIR`, und die Quelle „Netzlaufwerk“ geht nur unter Windows.

### Lokal bauen und testen

Die Rust-Logik ist plattformunabhängig und unter Linux testbar (ohne WebKit- und OpenSSL-Bibliotheken):

```bash
cd windows
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p pds -- --help                  # die CLI unter Linux ausprobieren
```

Den `cfg(windows)`-Code (Dienst, Plattform, Tauri, Worker-Dienst) prüft `cargo check` für das Windows-Ziel; es braucht
das gebaute Frontend (`ui/dist`) und einen Resource-Compiler (`llvm-windres` oder `x86_64-w64-mingw32-windres`):

```bash
pnpm --filter @pds/config-ui build
rustup target add x86_64-pc-windows-gnu                    # einmalig
cd windows
RC_x86_64_pc_windows_gnu=llvm-windres cargo check --workspace --target x86_64-pc-windows-gnu
```

Unter Linux liegen die Daten neben der EXE (`data/`), Secrets heißen `insecure:<base64>` (nur für Tests);
`PDS_DATA_DIR` und `PDS_INSTALL_DIR` lenken die Ordner um. Weitere Tests: `pnpm --filter @pds/node-tools test`
(SQL Server über `pnpm db:up`, mit `TEST_DATABASE=sqlite` ohne), `pnpm --filter @pds/config-ui dev` bzw. `test:screens`.
Die node-tools bekommen ihre Eingaben nur über die Umgebung (`NUXT_DATABASE_URL`, `PDS_DB_*`, `PDS_BACKUP_FILE`,
`PDS_ADMIN_DATABASE_URL`, `NUXT_OIDC_*`, `PDS_OIDC_CHECK_CLIENT=1`; Protokoll in `windows/node-tools/README.md`).

Der **Worker** baut auch unter Linux (`dotnet build` gegen Compile-Stubs der EPLAN-Typen, wenn die EPLAN-DLLs fehlen);
seine Tests für Protokoll, Pipe-/stdio-Server und JSON-Ausgabe laufen unter Linux. Ein Worker, der EPLAN wirklich
öffnen kann, entsteht nur unter Windows gegen die echten DLLs (unten).

### MSI bauen

Das **MSI** baut man unter Windows mit PowerShell ≥ 7.2, der MSVC-Rust-Toolchain, Node/pnpm und dem .NET SDK (für WiX und
den Worker). Für ein MSI **mit Worker** muss auf dem Build-Rechner zusätzlich **EPLAN Platform** installiert sein. Die
**App** (`apps/web/.output`) entsteht **unter Linux oder WSL**: Unter Windows gebaut enthält sie Importe mit `\`-Pfaden
und startet nicht (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); `build-payload.ps1` weist sie ab. Die Ausgabe ist reines
JavaScript und läuft unverändert unter Windows.

```bash
# Linux oder WSL: App bauen
pnpm install --frozen-lockfile
pnpm --filter @pds/web build                     # apps/web/.output
```

Den Ordner `apps/web/.output` danach an dieselbe Stelle im Windows-Checkout kopieren (auch die versteckten
Dateien unter `server/node_modules/.nitro`). Dann unter Windows:

```powershell
$version = '1.0.1'                                                        # X.Y.Z
$env:PDS_VERSION = $version                                               # Produktversion in status, --version und der App
$env:TAURI_CONFIG = "{`"version`":`"$version`"}"                          # Versionsressource der Konfigurations-EXE
pnpm install --frozen-lockfile
pnpm --filter @pds/node-tools build           # node-tools/dist/pds-tools.mjs
pnpm --filter @pds/config-ui build            # Frontend der Oberfläche
cd windows; cargo build --release --workspace; cd ..
./windows/scripts/fetch-vendor.ps1                                        # lädt Node, Caddy, WebView2, prüft SHA-256
./windows/scripts/build-payload.ps1 -Configuration release                # windows/.payload, samt Worker unter eplan\
./windows/scripts/sign.ps1 -Files windows/.payload/pds.exe, windows/.payload/pds-config.exe, windows/.payload/eplan/pds-eplan.exe, windows/.payload/caddy.exe   # optional
./windows/scripts/build-msi.ps1 -Payload windows/.payload `
  -WebView2 windows/.vendor/webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe -Version $version -Out dist
```

`build-payload.ps1` baut den Worker mit

```powershell
dotnet build worker/src/Pds.EplanWorker -c Release -p:EplanBinPath=<Bin-Ordner der EPLAN Platform>
```

(etwa `C:\Program Files\EPLAN\Platform\2025.0.3\Bin`) und legt ihn mit seinen Abhängigkeiten unter `eplan\` in die
Payload; die EPLAN-DLLs selbst kommen nicht hinein. Findet es die EPLAN-DLLs nicht, **bricht es ab**, außer mit
`-SkipEplanWorker`: Dann fehlt der Worker im MSI (so baut es die CI, deren Runner kein EPLAN hat). Wie der Pfad zur
EPLAN-Installation angegeben wird, steht im Kopf des Skripts.

`-Version` ist `X.Y.Z` (X, Y ≤ 255, Z ≤ 65535). Ohne `PDS_VERSION` und `TAURI_CONFIG` tragen die Programme die
Crate-Version. `windows/scripts/smoke.ps1` prüft ein MSI auf einer **Wegwerf-Maschine** (es ändert Dienst, Firewall und
`%ProgramData%` und installiert SQL Server Express).

### CI

**`.github/workflows/ci.yml`** prüft den JS-Workspace: `pnpm lint`, `pnpm typecheck` und `pnpm test` gegen einen
SQL-Server-2022-Service-Container und mit SQLite (`pnpm test:sqlite`).

**`.github/workflows/windows.yml`** läuft bei **Pushes**, die `windows/**` oder den Workflow ändern, bei Tags `v*` und
von Hand (`workflow_dispatch`). Änderungen nur an `apps/**` oder `packages/**` lösen ihn nicht aus (Windows-Minuten zählen
doppelt, `ci.yml` und E2E decken sie ab). Ein neuer Push bricht den laufenden Lauf derselben Ref ab. Jobs:

1. **linux** (`ubuntu-24.04`): `cargo fmt --check`, `cargo clippy`, `cargo test`, eingecheckte ts-rs-Bindings,
   node-tools gegen einen SQL-Server-Container, Tests der Konfigurationsoberfläche, CLI-Test mit `pds-tools.mjs`;
2. **app** (`ubuntu-24.04`): baut die App unter Linux und reicht `apps/web/.output` als Artefakt `app-output` weiter;
3. **build** (`windows-2022`): Oberfläche, node-tools, `cargo build --release`, `cargo test` samt Windows-Tests,
   Fremdkomponenten, Prüfung der Caddy-Konfiguration aller TLS-Modi mit `caddy validate`, Payload (**ohne Worker**,
   `-SkipEplanWorker`), Signieren, MSI (Version und Basisversion `X.Y.0`). Artefakt **`msi`**, ohne Signier-Secret
   **`msi-unsigniert`** (Branches 3 Tage, Tags 30 Tage);
4. **smoke** (`windows-2022`): `windows/scripts/smoke.ps1` (der Kopf des Skripts listet jeden Schritt): stille
   Installation mit Zeitmessung, Dienst, ACL, Firewall, Konfigurationsoberfläche, SQLite, dann mit SQL Server Express
   Einrichtung per CLI, Health über Caddy, Fehlkonfigurationen, **Upgrade**, **Secret-Suche**, Deinstallation. Auf dem
   Runner hält http.sys Port 80, der Test nimmt 8080. Logs und Ereignisse lädt die CI **immer** als Artefakt
   `smoke-logs` hoch (7 Tage).

Der Smoke-Test prüft weder den EPLAN-Worker noch EPLAN noch die Web-App nach der Anmeldung; das decken die Tests in
`apps/web` (gegen SQL Server und SQLite, mit Ersatz-Worker), `packages/analyzer`, `worker/`, E2E (mit Ersatz-Worker) und
die Abnahme (Abschnitt 15) ab. **Das MSI der CI ist deshalb nicht das MSI für den Betrieb**: Das entsteht wie in „MSI
bauen“ auf einem Build-Rechner mit EPLAN Platform.

**Version**: `X.Y.<run_number>`; `X.Y` aus `version` der Root-`package.json`, `run_number` vom Workflow, so ist jedes
neuere Build ein Update. Ein Tag `v*` kennzeichnet nur das Release. Der Workflow reicht die Version als `PDS_VERSION` und
`TAURI_CONFIG` an den Bau weiter. Ein MSI mit Worker für den Betrieb bekommt eine Version nach demselben Schema.

**Fremdkomponenten** (`windows/vendor.json`: Versionen, URLs und SHA-256 von Node 24 LTS, Caddy und WebView2):
`fetch-vendor.ps1` bricht bei jeder Abweichung ab; Updates per Pull Request nach der Anleitung im Kopf des Skripts, danach
`cargo test --workspace` (die Datei wird einkompiliert). EPLAN gehört nicht dazu.

### Signieren

`windows/scripts/sign.ps1` signiert per `signtool` (SHA-256, RFC-3161-Zeitstempel): die eigenen EXEs (auch
`eplan\pds-eplan.exe`), `caddy.exe` (offizielle Releases sind nicht signiert) und das MSI; `node.exe` trägt die Signatur
der OpenJS Foundation. Konfiguration in GitHub:

| Name | Art | Inhalt |
| --- | --- | --- |
| `WINDOWS_SIGN_PFX` | Secret | Zertifikat der Firmen-PKI samt Schlüssel als **base64-kodierte PFX** |
| `WINDOWS_SIGN_PASSWORD` | Secret | Passwort der PFX |
| `WINDOWS_SIGN_TSA` | Variable (optional) | Zeitstempeldienst; Standard `http://timestamp.digicert.com` |

Ohne `WINDOWS_SIGN_PFX` wird **nicht signiert**: Warnung „UNSIGNIERT“ in der Job-Zusammenfassung, Artefakt
`msi-unsigniert` (für Tests in Ordnung, für die Verteilung nicht). Den Signierpfad durchläuft die CI bei jedem Lauf mit
einem Wegwerf-Zertifikat an einer Kopie.

### WiX-Lizenz und UpgradeCode

Das MSI wird mit **WiX v5** gebaut (`WixToolset.Sdk` 5.0.x, MS-RL, ohne Gebühr). **Nie auf Version 6 oder höher
wechseln**, solange Siemens die Open Source Maintenance Fee nicht bezahlt; vorher Lizenz und Beschaffung klären. Der
`UpgradeCode` (`installer/Package.wxs`) ist eigens für den PDS erzeugt (nicht der des ESWC) und darf sich **nie** ändern,
sonst erkennt Windows ältere Versionen nicht mehr. Hersteller „Siemens LPD“, Startmenü-Verknüpfung am Registry-Wert
`HKLM\Software\Siemens LPD\EPLAN Panel Data Service`; im `wixproj` sind ICE61, ICE38, ICE43 und ICE57 mit Begründung
unterdrückt.
