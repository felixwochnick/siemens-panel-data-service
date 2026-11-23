# EPLAN Panel Data Service als Monorepo – Design

## Absicht

Mit dieser Anwendung werden Daten aus EPLAN-Electric-P8-Projekten abgefragt: Verbindungen (mit #-Markierung,
Verdrillung, Abschirmung), Kabel mit Adern, Schirme und freie Texte. Bisher war sie eine .NET-Konsole bzw. ein
Windows-Dienst, der Projekte eines Ordners nach Zeitplan öffnete und je Projekt eine `.xlsx` schrieb.

Sie wird wie der EPLAN Smart Wiring Controller (ESWC, `~/WebstormProjects/eplan-smart-wiring-controler`) gebaut und
betrieben:

- pnpm-Monorepo mit Nuxt 4 + Nuxt UI 4 im Siemens-Design,
- Anmeldung per OIDC (Microsoft Entra ID im Betrieb, Dex mit Test-LDAP in der Entwicklung),
- MCP-Server mit OAuth (Verbindung gilt 30 Tage),
- Windows-Dienst per MSI, Einrichtung über eine Konfigurationsoberfläche (Rust + Tauri + Vue/Nuxt UI) oder CLI.

Neu gegenüber der .NET-Version (Vorgaben des Nutzers):

- Projekte werden in der Web-App **hochgeladen** oder **aus dem Projektordner/Netzlaufwerk gewählt** und analysiert
  (Netzlaufwerk-Konfiguration wie beim ESWC).
- Die Ergebnisse landen **in MSSQL statt in Excel**; dort sollen sie später von anderen Systemen weiterverarbeitet
  werden.
- In der Web-App werden sie als **Tabellen wie in Excel** angezeigt (Vorbild: Tabellenansicht „sheet“ des Trainee
  Planners in `siemens-lpd-apps`).
- **Jede Analyse bleibt als eigener Stand erhalten** (Entscheidung des Nutzers, Variante B); die Tabellen zeigen
  standardmäßig den neuesten.
- **Die .NET-Anwendung bleibt, aber nur für das, was zwingend EPLAN braucht**; alles andere passiert in Nuxt.

## Ziele

- Gleiche fachliche Ergebnisse wie die .NET-Version (Spalten und Regeln der Blätter Verbindungen, Kabel, Schirme,
  Texte; siehe README der .NET-Version und `src/EplanElectricP8Api/*.cs` im Stand vor dem Umbau).
- Ergebnisse versioniert in SQL Server, mit stabilen Sichten (`pds.v_current_*`) für die Weiterverarbeitung.
- Web-App für alle angemeldeten Benutzer: hochladen, aus dem Ordner wählen, analysieren, Ergebnisse ansehen, filtern,
  sortieren, kopieren, als `.xlsx`/CSV herunterladen.
- Admins: Einstellungen (Ordner, Netzlaufwerk, EPLAN-Pfade, Zeitplan, Aufbewahrung), Protokolle.
- Alles Lesende auch über MCP; Analysen starten über MCP mit Stufe `write`.
- Betrieb unter Windows Server ohne Docker, identisch zum ESWC (Rust-Dienst, Caddy, Node) plus EPLAN-Worker.

## Nicht-Ziele

- Bearbeiten der Analyse-Ergebnisse in der Web-App (die nächste Analyse würde es überschreiben).
- Beschriftungs-Exporte über EPLAN-Schemas (`labels`) und die `.xlsx`-Ausgabe auf dem Server: entfallen.
- Vergleich zweier Analyse-Stände in der Oberfläche (das Datenmodell erlaubt ihn später).
- Linux-/macOS-Betrieb; Entwicklung läuft weiter unter Linux (mit einem Ersatz-Worker).
- Hochladen von `.elk` + `.edb` über den Browser: Hochladen nur als Archiv `.zw1`.

## Anti-Ziele

- Ein Zeitplan, der nach der Installation ungefragt alle Projekte analysiert: Der Zeitplan ist nach der Installation
  **aus**.
- Geheimnisse (Netzlaufwerk-Passwort, Passwort des EPLAN-Kontos) im Klartext in Datenbank, Logs, Prozess-Argumenten
  oder MCP-Antworten.
- Fachlogik (Zuordnung, Zeilenaufbau) doppelt in C# und TypeScript.
- EPLAN verändert das Original-Projekt im Projektordner (Analyse arbeitet auf einer Kopie).

## Ansätze

### Aufteilung .NET ↔ Nuxt

1. **.NET liest nur Rohdaten, TypeScript wertet aus** (gewählt, Vorgabe des Nutzers „.NET nur wo zwingend“): Der
   Worker stellt Archive wieder her, öffnet das Projekt und schreibt Rohdaten (Eigenschaften, Symbolpositionen, Texte
   mit Rahmen, Grafiklinien, Schirmsymbole) als JSON. Die Zuordnung (#, Verdrillung, Schirm), Quelle/Ziel-Aufbau,
   Kabelliste und alles weitere ist ein reines TS-Paket `packages/analyzer`, unter Linux testbar.
2. .NET wertet aus und liefert fertige Zeilen: weniger Umbau, aber die Logik bliebe in C# und wäre nur unter Windows
   mit EPLAN testbar. Verworfen (widerspricht der Vorgabe).
3. .NET schreibt direkt in SQL Server: zweite Datenbankschicht, zweite Konfiguration. Verworfen.

### Verbindung Nuxt ↔ Worker

EPLAN braucht ein **lizenziertes Benutzerkonto** und darf je Prozess nur einmal gestartet werden (STA-Thread, Start
dauert Minuten). Der Web-Dienst läuft wie beim ESWC als virtuelles Konto `NT SERVICE\pds`.

1. **Eigener Windows-Dienst `pds-eplan` unter dem EPLAN-Konto, JSON-Zeilen über eine Named Pipe** (gewählt,
   Entscheidung Claude): Das Web bleibt mit geringen Rechten, nur der Worker hat das EPLAN-Konto; EPLAN bleibt
   geladen; die Pipe ist per ACL auf `NT SERVICE\pds` und Administratoren beschränkt (kein Port, kein Geheimnis).
2. Node startet den Worker als Kindprozess (stdin/stdout): Node läuft als `NT SERVICE\pds` und könnte den Worker
   nicht unter einem anderen Konto starten. Für die **Entwicklung** bleibt dieser Weg als Transport erhalten (Ersatz-
   Worker bzw. echter Worker im Modus `stdio`), das Protokoll ist identisch.
3. Lokaler HTTP-Port mit Token: zusätzlicher Port und Geheimnis. Verworfen.

### Datenbank

SQL Server ist das Ziel (Vorgabe). Die aus dem ESWC übernommenen Bausteine (`packages/core`, `windows/`) können auch
SQLite; das bleibt erhalten (Tests ohne Container, kleine Installationen), **Standard ist aber SQL Server**
(Entscheidung Claude: Entfernen wäre ein tiefer Eingriff in Rust, Tauri und core). Migrationen deshalb wie beim ESWC
für beide Reihen (`MigrationSet.mssql`/`.sqlite`), Abfragen im SQL-Server-Stil (SqliteCompatPlugin).

### Gemeinsame Teile

`packages/core`, `packages/ui`, `windows/`, `docker/`, `e2e/`-Gerüst, Root-Konfiguration werden aus dem ESWC
**kopiert** und umbenannt (Entscheidung Claude, wie ESWC aus dem Trainee Planner): unabhängige Releases,
Fehlerbehebungen bei Bedarf von Hand nachziehen. Aus `packages/controller` des ESWC werden Netzlaufwerk (`drive.ts`),
Zeitplan-Hilfen (`schedule.ts`) und Protokoll-Hilfen (`log.ts`) übernommen.

## Aufbau und Namen

```
apps/web               Nuxt-App: Projekte, Analysen, Tabellen, Einstellungen, Protokolle, Warteschlange, MCP (Schema „pds“)
packages/analyzer      reines TS-Paket: Rohdaten → Zeilen (Verbindungen, Kabel, Schirme, Texte) + Zähler + Hinweise
packages/core          Nuxt-Layer aus dem ESWC: DB, Migrationen, OIDC, Sessions, OAuth-Server, MCP-Grundgerüst
packages/ui            Nuxt-Layer aus dem ESWC: Siemens-Design, Icons, Schriften, i18n-Basis
worker/                .NET-Framework-4.8.1-Worker „pds-eplan“ (EPLAN-API), Stubs für Linux-Builds, Tests
windows/               Rust-Dienst + CLI (pds), Tauri-Oberfläche (pds-config), Node-Werkzeuge, WiX-Installer
docker/                SQL Server, Dex, glauth für die Entwicklung
e2e/                   Playwright
tools/fake-worker      Ersatz-Worker (Node) für Entwicklung und E2E, spricht das Worker-Protokoll
```

- Produktname „EPLAN Panel Data Service“, Paket-Scope `@pds/*`, Web-Dienst `pds` (`pds.exe`, Konto
  `NT SERVICE\pds`), Worker-Dienst `pds-eplan` (`pds-eplan.exe`), Oberfläche `pds-config.exe`.
- Datenordner `%ProgramData%\EPLAN Panel Data Service` mit `uploads\`, `work\`, `logs\`, `data\` (SQLite).
- Entwicklungsports (ESWC und Trainee Planner laufen daneben): `pnpm dev` 3400, E2E 3500, SQL Server 1435,
  Dex 5558, glauth 3895. Lokale Hostnamen `*.localhost`.
- Neuer WiX-`UpgradeCode` (nie den des ESWC).

## Worker (`worker/`, C#, .NET Framework 4.8.1, x64)

Aus `src/EplanElectricP8Api` hervorgegangen. Behält: EPLAN-Start auf STA-Thread (`EplanWorker.cs`),
Archiv-Wiederherstellung (`Restore`), Öffnen (`ProjectManager.OpenProject` mit `LockingStep`), Serilog,
Windows-Dienst-Hosting. Entfällt: Excel, Quartz, SQLite, YAML-Konfiguration, Projektordner-Scan, Spectre-CLI-Assistent,
`sc.exe`-Installation (übernimmt Rust).

### Betriebsarten

- `pds-eplan.exe service` – Windows-Dienst, lauscht auf `\\.\pipe\pds-eplan`.
- `pds-eplan.exe run` – dasselbe in der Konsole (Fehlersuche; Dialoge von EPLAN erlaubt mit `--dialogs`).
- `pds-eplan.exe stdio` – ein Client über stdin/stdout (Entwicklung unter Windows: Nuxt startet den echten Worker).

Pipe-ACL: Vollzugriff für `NT SERVICE\pds`, `BUILTIN\Administrators` und das eigene Konto; sonst niemand. Ein
Client gleichzeitig; trennt er die Verbindung, wartet der Worker auf den nächsten. Logs: Serilog nach
`%ProgramData%\EPLAN Panel Data Service\logs\eplan-worker-.log` (täglich) und auf stderr.

### Protokoll (JSON-Zeilen, UTF-8, ohne BOM, `\n`)

Jede Zeile ein Objekt mit `type`. Der Worker bearbeitet Anfragen nacheinander (EPLAN ist einfädig); `status` und
`exit` beantwortet er auch während einer laufenden Analyse.

```jsonc
// Worker → Client sofort nach Verbindungsaufbau
{ "type": "hello", "protocol": 1, "version": "1.2.3" }

// Client → Worker
{ "type": "request", "id": "r1", "method": "configure", "params": {
    "platformBin": "C:\\Program Files\\EPLAN\\Platform\\2025.0.3\\Bin",
    "productBin": "C:\\Program Files\\EPLAN\\Electric P8\\2025.0.3\\Bin",
    "applicationModifier": "" } }
{ "type": "request", "id": "r2", "method": "status", "params": {} }
{ "type": "request", "id": "r3", "method": "analyze", "params": {
    "projectPath": "C:\\ProgramData\\EPLAN Panel Data Service\\work\\42\\Anlage.zw1",   // .elk oder .zw1
    "workFolder":  "C:\\ProgramData\\EPLAN Panel Data Service\\work\\42",              // Wiederherstellung nach <workFolder>\restore
    "outputFile":  "C:\\ProgramData\\EPLAN Panel Data Service\\work\\42\\raw.json",
    "openMode": "ReadOnly" } }                                                            // ReadOnly | Standard | Exclusive
{ "type": "request", "id": "r4", "method": "exit", "params": { "code": 3 } }         // Prozess beenden (Dienst startet neu)

// Worker → Client
{ "type": "progress", "id": "r3", "stage": "starting_eplan" }     // starting_eplan | restoring | opening | reading | writing
{ "type": "log", "id": "r3", "level": "warn", "code": "text_unreadable", "message": "…" }   // id optional
{ "type": "response", "id": "r2", "result": {
    "eplan": "not_started" | "starting" | "ready" | "failed",
    "eplanVersion": "2025.0.3" | null, "busy": false, "configured": true } }
{ "type": "response", "id": "r3", "result": { "outputFile": "…", "pages": 123, "connections": 4567 } }
{ "type": "response", "id": "r1", "error": { "code": "restart_required", "message": "…" } }
```

- `configure` vor dem ersten EPLAN-Zugriff; ist EPLAN schon mit **anderen** Pfaden gestartet ⇒ Fehler
  `restart_required` (EPLAN lässt sich je Prozess nur einmal starten) – der Client schickt `exit`, der Dienst wird
  über die Wiederherstellungsaktionen neu gestartet. Gleiche Pfade ⇒ ok. EPLAN wird beim ersten `analyze` gestartet
  und bleibt geladen.
- Fehlercodes (snake_case): `not_configured`, `eplan_start_failed`, `project_not_found`, `restore_failed`,
  `archive_without_project`, `open_failed`, `read_failed`, `write_failed`, `busy`, `invalid_request`,
  `restart_required`. `message` ist Rohtext (ohne Geheimnisse).
- Der Worker löscht `<workFolder>\restore` nach der Analyse; den übrigen Arbeitsordner räumt Nuxt auf.

### Rohdaten (`raw.json`, Format 1)

Der Worker liest nur, er entscheidet nichts. Strings nie `null`, fehlende/unlesbare Eigenschaften = `""` (wie
`ConnectionExporter.Value`: `IsEmpty ? "" : ToString()`, Ausnahme ⇒ `""`). Koordinaten in mm (Seitenkoordinaten, y
wächst nach oben), als Zahl. Mehrsprachige Texte: Deutsch (`L_de_DE`), sonst sprachneutral (`L___`), sonst Englisch
(`L_en_US`), getrimmt.

```jsonc
{
  "format": 1,
  "worker": "1.2.3", "eplanVersion": "2025.0.3",
  "project": { "name": "Anlage", "pageCount": 123 },
  "pages": [ { "name": "=VB030+LCM&EFS/7", "isReport": false } ],          // Reihenfolge wie project.Pages
  "connections": [ {                                                         // DMObjectsFinder.GetConnections(null), alle
      "id": "…",                                                             // StorableObject.ToStringIdentifier()
      "is3d": false,                                                         // Connection3D (Schaltschrankaufbau)
      "page": "=VB030+LCM&EFS/7",
      "definition": "Ader / Draht",                                          // FunctionDefinition.Name, lokalisiert
      "designation": "VD_X500",                                              // CONNECTION_DESIGNATION
      "sourceProperty": "", "destinationProperty": "",                       // CONNECTION_SOURCE / _DESTINATION
      "wireNumber": "BK", "crossSection": "1,5 mm²", "wireType": "SIENOPYR(90)", "length": "",
                                                                             // CONNECTION_WIRENUMBER, _WIRECROSSSECTION_WITH_UNIT, _WIRETYPE, _WIRELENGTH_FULL
      "partNumbers": ["…"],                                                  // ArticleReferences[].PartNr, nicht leer, Reihenfolge der API
      "cable": { "name": "-W817405", "type": "GSC-01", "wireCountAndCrossSection": "4x0,22" } | null,
                                                                             // CableDefinitionLine; FUNC_CABLETYPE, FUNC_CABLEWIRECOUNTANDCROSSSECTION
      "start": Pin | null, "end": Pin | null,                                // StartPin / EndPin
      "shieldings": [ { "page": "…", "x": 0, "y": 0, "name": "…" } ],        // Connection.Shieldings (Function.Location)
      "symbols": [ { "page": "…", "x": 0, "y": 0 } ],                        // SymbolReferences in API-Reihenfolge (Location)
      "startSymbol": SymbolEnd | null, "endSymbol": SymbolEnd | null         // StartSymbolReference + StartSymbolConnPoint usw.
  } ],
  "texts": [ {                                                               // page.AllPlacements.OfType<Text>(), alle Seiten
      "page": "…", "content": "#", "x": 0, "y": 0,                           // Location
      "box": [[x, y], …],                                                    // GetBoundingBox() (Ecken), [] wenn unlesbar
      "free": true } ],                                                      // Group == null (Ausnahme ⇒ false)
  "lines": [ { "page": "…", "x1": 0, "y1": 0, "x2": 0, "y2": 0 } ],          // page.AllPlacements.OfType<Line>()
  "shields": [ {                                                             // page.AllPlacements.OfType<Shield>()
      "page": "…", "name": "", "x": 0, "y": 0,
      "variant": 0,                                                          // SymbolVariant.VariantNr, -1 wenn unlesbar
      "width": 12.5 | null, "height": 4 | null } ],                          // RECTANGLE_WIDTH/HEIGHT.ToDouble(), null wenn unlesbar
  "cableDefinitions": [ {                                                    // page.AllPlacements.OfType<Function>() mit Cable oder Shield, Seitenreihenfolge, nicht entdoppelt
      "page": "…", "kind": "cable" | "shield", "name": "-W1", "x": 0, "y": 0,
      "definition": "Kabeldefinition",
      "sourceProperty": "", "destinationProperty": "",                       // FUNC_CABLE_SOURCE / _DESTINATION
      "type": "", "wireCountAndCrossSection": "", "length": "",              // FUNC_CABLETYPE, …WIRECOUNTANDCROSSSECTION, FUNC_CABLELENGTH_FULL
      "partNumbers": [],
      "wires": ["<connection id>", …] } ]                                    // Cable: CableConnections; Shield: Pins[].Connections (ids, entdoppelt)
}
// Pin       = { "functionName": "=VB030+LCM-Q20", "pinName": "1", "pinDesignation": "1",
//               "plugAutomatic": "", "plugManual": "", "parentIsShield": false }
//               ParentFunction.Name, Pin.Name, Pin.Designation, FUNC_PLCPLUG_DESIGNATION_AUTOMATIC/_MANUAL, ParentFunction is Shield
//               Pin ohne ParentFunction ⇒ functionName "" (Pin-Objekt trotzdem, damit „Anschluss vorhanden“ erkennbar bleibt)
// SymbolEnd = { "page": "…", "x": 0, "y": 0, "pinX": 0, "pinY": 0 }   // Location der SymbolReference, ConnPoint.Location (0/0 ohne ConnPoint)
```

Eine Ausnahme beim Lesen eines einzelnen Objekts bricht die Analyse nicht ab: Das Feld bekommt den Leerwert, der
Worker meldet einmal je Code eine `log`-Zeile mit Anzahl.

### Bauen und Testen ohne Windows

- `worker/stubs/Eplan.EplApi.Stubs`: Compile-Stubs genau der verwendeten EPLAN-Typen/Mitglieder (gleiche Namespaces
  und Signaturen wie die echten DLLs). Das csproj referenziert die echten DLLs, wenn `$(EplanBinPath)` existiert,
  sonst die Stubs; `Microsoft.NETFramework.ReferenceAssemblies` ermöglicht `dotnet build` für `net481` unter Linux.
- Protokoll, Pipe-/stdio-Server und JSON-Ausgabe sind von EPLAN getrennt (`IProjectReader`) und in einem
  Testprojekt (`net10.0`, xUnit) unter Linux getestet; die EPLAN-Implementierung nur auf Windows.

## Paket `packages/analyzer` (rein, ohne Nuxt/DB/Node-APIs)

Portiert die Regeln aus `ConnectionGeometry.cs`, `HashMarkFinder.cs`, `TwistFinder.cs`, `ShieldFinder.cs`,
`CableList.cs`, `TextList.cs`, `ConnectionExporter.cs` (Endpoint, Twist-Muster, Zähler) **1:1** inklusive Toleranzen
(# 2 mm, Verdrillung: Haken/Schrägstrich ≤ 3 mm, Mitte ≤ 1 mm, Epsilon 0,01), Sortierungen und Sonderfälle.

```ts
export const RAW_FORMAT = 1
export interface RawProject { … }                         // Typen exakt wie „Rohdaten“ oben
export function parseRawProject(json: unknown): RawProject  // prüft format/Struktur, wirft AnalyzerError('raw_invalid')

export interface ConnectionRow {
  idx: number, eplanId: string, page: string, definition: string, designation: string,
  source: string, destination: string, cable: string, wireNumber: string, crossSection: string,
  wireType: string, length: string, partNumbers: string,    // ", "-getrennt, entdoppelt
  hashMark: boolean, twisted: boolean, shielded: boolean,
}
export interface CableRow {                                 // Kabel bzw. Schirm (Kabelnavigator)
  idx: number, kind: 'cable' | 'shield', name: string, definition: string, page: string,
  source: string, destination: string, type: string, wireCountAndCrossSection: string, length: string,
  partNumbers: string, wires: CableWireRow[],
}
export interface CableWireRow {
  idx: number, connectionIdx: number | null, definition: string, page: string, source: string,
  destination: string, length: string, wireNumber: string, crossSection: string, partNumbers: string,
}
export interface ShieldRow {                                // Blatt „Schirme“
  idx: number, page: string, name: string, type: string, wireCountAndCrossSection: string,
  connectionIdx: number[],                                  // Indizes in connections, aufsteigend
}
export interface TextRow { idx: number, page: string, text: string }
export interface AnalysisCounts {
  connections: number, hashMarks: number, unmatchedHashMarks: number, twisted: number, twistSymbols: number,
  unmatchedTwistTicks: number, shielded: number, shields: number, cables: number, texts: number, pages: number,
}
export interface AnalyzerNotice { level: 'info' | 'warn', code: string, params?: Record<string, string | number> }
export interface AnalysisResult {
  connections: ConnectionRow[], cables: CableRow[], shields: ShieldRow[], texts: TextRow[],
  counts: AnalysisCounts, notices: AnalyzerNotice[],
}
export function analyze(raw: RawProject): AnalysisResult
```

- Verbindungen: alle mit `is3d === false` in Rohdaten-Reihenfolge (`idx` ab 0). Quelle/Ziel: `sourceProperty`, sonst
  aus `start` gebildet wie `ConnectionExporter.Endpoint` (Steckerbezeichnung, Anschlussname vs. Designation usw.).
  Verdrillt = Twist-Muster `^VD_[A-Za-z]\d+(_\d+)?$` auf der getrimmten Bezeichnung **oder** Symbol-Treffer.
- Leitungsweg: aus `symbols`; der erste Punkt, der `startSymbol` entspricht (Seite + Lage ±0,01), wird um
  `pinX/pinY` verschoben, ebenso Punkte von `endSymbol`; benachbarte Punkte derselben Seite bilden Abschnitte.
- #: Texte mit Inhalt genau `#` (alle Texte, auch in Gruppen und auf Auswertungsseiten, wie bisher) ⇒ Rahmen aus `box`
  ± 2 mm. Abweichung zur .NET-Version: Inhalt nimmt auch Englisch als letzte Stufe (vorher nur de/neutral) –
  vernachlässigbar, im Code vermerkt.
- Schirme: Gruppen wie `ShieldFinder` (logisch über `shieldings`, geometrisch über `shields`-Fläche je Variante,
  GSC-Kabel über `cable.type`), Schirmanschlüsse entfernt (`start`/`end` beide null oder `parentIsShield`). Sortiert
  nach Seite (Ordinal, stabil). Schirmname leer ⇒ „Abschirmung“.
- Kabel: `cableDefinitions` entdoppelt nach Name (leer ⇒ Seite|x|y), Adern über `wires` → Verbindung (auch 3D;
  `connectionIdx` = Index in `connections` oder `null` für 3D/unbekannt), Quelle/Ziel mit Anschluss wie
  `CableList.Precise`.
- Texte: nur freie Texte, nicht auf Auswertungsseiten, Inhalt nicht leer und nicht `#`; je Seite nach y absteigend,
  dann x aufsteigend.
- Hinweise: `unmatched_hash_marks` (n), `unmatched_twist_ticks` (n), `wire_not_found` (Kabel, id) usw.
- Tests (Vitest): je Regel synthetische Rohdaten; ein Gesamt-Fixture `fixtures/sample-raw.json`, das auch der
  Ersatz-Worker liefert.

## App `apps/web`

### Rollen

Alle angemeldeten Benutzer: Projekte, Analysen, Tabellen, Hochladen, Analyse starten, Downloads, MCP. Admins (Rolle
aus dem IdP, `NUXT_OIDC_ADMIN_ROLES`): zusätzlich Einstellungen, Protokolle, Zeitplan, Projekte/Analysen löschen,
Worker neu starten. Server prüft je Handler (`requireAuth(event)` bzw. `{ admin: true }`), Dienste prüfen den Akteur
zusätzlich (für MCP).

### Einstellungen (`pds.settings`, eine Zeile, JSON, Geheimnisse verschlüsselt wie ESWC)

```ts
interface PdsSettings {
  folder: string                    // Projektordner (lokal, Laufwerk oder UNC), leer = keine Ordner-Projekte
  source: 'local' | 'network'
  networkDrive: { mapping: string, networkPath: string, user: string, password: string }   // wie ESWC
  recursive: boolean                // true
  filePatterns: string[]            // ['*.elk', '*.zw1']
  eplan: { platformBin: string, productBin: string, applicationModifier: string,
           openMode: 'ReadOnly' | 'Standard' | 'Exclusive' }   // Standard: Pfade 2025.0.3 wie bisher, ReadOnly
  schedulerEnabled: boolean         // false (Anti-Ziel)
  cronSchedule: string              // '0 0 2 * * ?'
  timezone: string                  // 'Europe/Berlin'
  analysisTimeoutMinutes: number    // 60
  retentionDays: number             // 180 – ältere, nicht aktuelle Analysen löschen
  uploadMaxMb: number               // 500
}
```

Netzlaufwerk-Passwort: nur `{ set, readable }` nach außen (wie ESWC). Prüfung „Verbindung testen“: Laufwerk, Ordner,
Worker (`status`).

### Datenbank (Schema `pds`, unter SQLite `pds_*`)

- `pds.settings` (`id = 1`, `data`, `updated_at`, `updated_by`).
- `pds.projects`: `id`, `source` (`upload|folder`), `name` (ohne Endung), `path` (`folder`: relativ zum Projektordner;
  `upload`: NULL), `path_key` (eindeutig je Quelle: kleingeschrieben `path` bzw. `name`), `file_kind` (`elk|zw1`),
  `upload_file` (Dateiname unter `uploads\<projectId>\`, nur `upload`), `source_modified`, `current_analysis_id`
  (neueste erfolgreiche), `created_at`, `created_by`, `updated_at`. Hochladen mit gleichem Namen ⇒ derselbe Projekt-
  Eintrag, neuer Stand (Entscheidung Claude).
- `pds.analyses`: `id`, `project_id` (Cascade), `trigger` (`upload|manual|schedule|mcp`), `triggered_by`, `status`
  (`queued|running|succeeded|failed|aborted`), `stage`, `queued_at`, `started_at`, `finished_at`, `source_modified`,
  `eplan_project_name`, `eplan_version`, `worker_version`, Zähler aus `AnalysisCounts`, `error_code`,
  `error_detail`.
- `pds.analysis_events`: `id` (bigint identity), `analysis_id` (Cascade), `at`, `level`, `code`, `params` (JSON),
  `detail`.
- Ergebnis-Tabellen, Schlüssel `(analysis_id, idx)`, Cascade über `analysis_id`:
  `pds.connections` (Spalten wie `ConnectionRow`, `eplan_id`), `pds.cables` (`kind`, …), `pds.cable_wires`
  (`cable_idx`, `idx`, `connection_idx` NULL), `pds.shields`, `pds.shield_wires` (`shield_idx`, `idx`,
  `connection_idx`), `pds.texts`.
- Sichten für die Weiterverarbeitung: `pds.v_current_connections`, `v_current_cables`, `v_current_cable_wires`,
  `v_current_shields`, `v_current_texts` (Join über `projects.current_analysis_id`, mit `project_id`,
  `project_name`, `analysis_id`).
- `pds.audit` wie ESWC (`settings_updated`, `analysis_started`, `project_deleted`, `scheduler_toggled`, …).
- Schreiben der Ergebnisse in **einer Transaktion** (SQL Server: max. 2100 Parameter je Anweisung ⇒ `chunk()`); erst
  danach `status = succeeded` und `current_analysis_id` setzen. Ein Leser sieht nie einen halben Stand.

### Ablauf einer Analyse (Warteschlange, Nitro-Plugin)

1. Auftrag `queued` (Hochladen, „Analysieren“, Zeitplan, MCP). Ein Projekt hat höchstens einen offenen Auftrag
   (sonst 409 `analysis_already_queued`).
2. Eine Analyse gleichzeitig. Vor dem Start: Arbeitsordner `work\<analysisId>`; `folder`-Projekte werden dorthin
   **kopiert** (`.zw1` bzw. `.elk` + `.edb`), damit EPLAN das Original nicht verändert und der Worker keine
   Netzwerkrechte braucht; `upload`-Projekte werden direkt aus `uploads\` gelesen. Netzlaufwerk vorher verbinden
   (ESWC `drive.ts`).
3. Worker: `configure` (Einstellungen `eplan`), dann `analyze`; `progress` ⇒ `analyses.stage`; `log` ⇒
   `analysis_events`. Zeitlimit `analysisTimeoutMinutes` ⇒ `failed`/`timeout`, Worker `exit`.
4. `raw.json` lesen → `parseRawProject` → `analyze` → in einer Transaktion speichern, Zähler und Hinweise.
5. Arbeitsordner löschen. Beim Server-Start hängengebliebene `running` ⇒ `aborted`, `queued` bleiben.
6. Zeitplan (croner, wie ESWC): Projektordner scannen (Muster, rekursiv), Projekte anlegen/aktualisieren, für neue,
   geänderte (`source_modified` = neueste Datei aus `.elk` und `.edb`, bzw. `.zw1`) oder zuletzt gescheiterte
   Projekte einen Auftrag `schedule` einreihen.
7. Aufbewahrung (täglich und am Laufbeginn): Analysen älter als `retentionDays` löschen, außer der aktuellen je
   Projekt; ältere hochgeladene Dateien je Projekt löschen (die zum aktuellen Stand bleibt für „Erneut analysieren“).

Worker-Transport über `NUXT_EPLAN_WORKER`: `pipe:\\.\pipe\pds-eplan` (Standard unter Windows) oder
`spawn:<Befehl …>` (Entwicklung, z. B. `spawn:node tools/fake-worker/index.mjs`). Ohne Worker: Aufträge bleiben
`queued`, Übersicht zeigt „Worker nicht erreichbar“.

### Oberfläche (i18n de + en, nur Siemens-Icons)

- **Übersicht** `/`: Worker-Status, Warteschlange (laufend mit Stufe, wartend), zuletzt analysierte Projekte,
  Hinweise (Einstellungen unvollständig, Zeitplan an/aus mit nächsten Läufen – Admin).
- **Projekte** `/projects`: Liste (Quelle, Name, Pfad, letzter Stand, Status) mit Suche; „Hochladen“ (`.zw1`,
  Ziehen & Ablegen, Fortschritt); „Aus Ordner wählen“ (Dialog mit Liste der gefundenen Projekte aus dem Projektordner,
  Suche, Mehrfachauswahl ⇒ einreihen).
- **Projekt** `/projects/[id]`: Stände (Analysen) mit Status und Zählern, „Erneut analysieren“, aktueller Stand mit
  Tabs **Verbindungen**, **Kabel**, **Schirme**, **Texte**; Stand-Auswahl (Standard: neuester).
- **Analyse** `/analyses/[id]`: Details, Ereignisse, dieselben Tabs.
- **Tabellenansicht** (`DataSheet`-Komponente, Look wie „sheet“ im Trainee Planner, nur lesen): Gitterlinien,
  Zeilennummern, feste Kopfzeile, Spaltenfilter in der Kopfzeile (Text enthält bzw. Werteliste für ja/leer-Spalten),
  Sortieren per Klick (auf/ab/aus), Suche über alle Spalten, Zellbereich markieren und `Strg+C` als TSV, Spalten-
  breite ziehen, Zähler „x von y Zeilen“, Export `.xlsx`/CSV der gefilterten Zeilen (`write-excel-file`, wie Trainee
  Planner, Werte als Text). Virtuelles Scrollen für zehntausende Zeilen; Daten je Tab einmal komplett laden
  (`GET /api/analyses/:id/connections` usw.). Kabel als Kabelnavigator: Kabelzeile, darunter Adern (einklappbar).
  Schirme: Adern als Liste (Klick springt zur Verbindung im Tab Verbindungen).
- **Protokolle** `/logs` (Admin, wie ESWC). **Einstellungen** `/settings` (Admin). **KI-Assistenten** `/assistants`
  (core).

### API (Auszug, alle unter `/api`)

`GET status` · `GET projects` · `GET projects/:id` · `DELETE projects/:id` (Admin) · `POST projects/upload`
(multipart, `.zw1`, ⇒ Projekt + Auftrag) · `GET folder/projects` (Scan) · `POST analyses` (`{ projectId }` oder
`{ folderPaths: string[] }`) · `GET analyses` · `GET analyses/:id` · `DELETE analyses/:id` (Admin, nur
`queued`/beendet) · `GET analyses/:id/{connections,cables,shields,texts,events}` · `GET/PUT settings` ·
`POST settings/test` · `PUT scheduler` · `POST worker/restart` · `GET logs…`.

### MCP-Werkzeuge (`server/mcp`, nur über Dienste)

Lesen: `get_status`, `list_projects`, `get_project`, `list_folder_projects`, `get_analysis`,
`query_connections` (Filter: Seite, Kabel, Bezeichnung, Quelle/Ziel enthält, `hashMark`/`twisted`/`shielded`;
`limit`/`offset`), `query_cables`, `list_shields`, `list_texts`, `get_settings` (Admin, ohne Geheimnisse).
Schreiben (`write`): `start_analysis` (Projekt-ID oder Ordnerpfad), `set_scheduler` und `update_settings` (Admin,
ohne Geheimnisse). Standard: das aktuelle Ergebnis eines Projekts, optional `analysisId`. MCP-Verbindung gilt 30 Tage.

## Windows (`windows/`)

Übernahme aus dem ESWC mit neuen Namen. Zusätzlich der EPLAN-Worker:

- Payload enthält `eplan\pds-eplan.exe` mit Abhängigkeiten (Build auf Windows mit EPLAN-DLLs bzw. Stubs; die
  EPLAN-DLLs selbst werden **nicht** ausgeliefert, der Worker lädt sie zur Laufzeit aus der EPLAN-Installation).
- `pds eplan install --user <DOMAIN\Benutzer>` (Passwort per Abfrage oder stdin, nie als Argument): legt Dienst
  `pds-eplan` an bzw. ändert Konto/Passwort (Win32 `ChangeServiceConfig`), Start automatisch (verzögert),
  Wiederherstellung „neu starten“, Recht „Als Dienst anmelden“ (`LsaAddAccountRights`), ACL: Konto liest
  `uploads\`, ändert `work\` und `logs\`; `NT SERVICE\pds` darf den Dienst starten/stoppen/abfragen.
  `pds eplan uninstall`, `pds eplan status`, `pds eplan restart`.
- Tauri-Oberfläche: Abschnitt „EPLAN-Worker“ (Konto, Passwort, Status, Starten/Stoppen) über dieselben Funktionen.
- MSI: kopiert den Worker; stoppt `pds-eplan` vor dem Ersetzen der Dateien und entfernt ihn beim Deinstallieren; legt
  ihn **nicht** an (Konto ist erst nach der Einrichtung bekannt). `setup install` startet einen vorhandenen
  `pds-eplan` nach einem Upgrade wieder.
- Node-Umgebung des Web-Dienstes: `NUXT_EPLAN_WORKER=pipe:\\.\pipe\pds-eplan`, `NUXT_PDS_DATA_DIR` (Datenordner),
  `NUXT_LOG_DIR`.

## Tests

- `packages/analyzer`: Vitest je Regel + Gesamt-Fixture.
- `worker/`: `dotnet build` unter Linux (Stubs), xUnit für Protokoll/Server/JSON (`net10.0`).
- `apps/web`: Integrationstests gegen SQL Server und SQLite (Dienste: Einstellungen, Projekte, Upload, Warteschlange
  mit Ersatz-Worker, Speichern/Lesen der Ergebnisse, Aufbewahrung, Rechte, MCP-Werkzeuge).
- E2E (Playwright, Ersatz-Worker): Anmeldung, Hochladen ⇒ Analyse ⇒ Tabellen (Filtern, Sortieren, Export), Ordner-
  Auswahl, Einstellungen (Admin), Rechte (Nicht-Admin), MCP.
- Rust: wie im ESWC (Linux-Tests, `cargo check` für Windows), zusätzlich `pds eplan …` (reine Logik testbar).

## Dem Umsetzenden überlassen

Layout und Komponenten der Seiten (im Stil von ESWC/Trainee Planner), genaue Fehlercodes, Spaltenlängen, Seitengrößen,
Grenzwerte, Puffern der Ereignisse, Aufbau des Ersatz-Workers.

## Entscheidungen von Claude (zum Gegenlesen)

- Worker als eigener Dienst unter dem EPLAN-Konto mit Named Pipe statt Kindprozess (Konto-Trennung).
- Analyse auf einer Kopie im Arbeitsordner statt direkt im Projektordner.
- SQLite bleibt als Option erhalten, Standard ist SQL Server.
- Hochladen nur `.zw1`; gleicher Name ⇒ gleiches Projekt, neuer Stand.
- Ergebnisse normalisiert (Kabel/Adern, Schirme/Adern getrennt) plus `v_current_*`-Sichten.
- Name „EPLAN Panel Data Service“ / `pds`.
- Tabellenansicht: `Strg+C` kopiert einen Zellbereich als TSV ohne Kopfzeile (passt in bestehende Zeilen); ganze
  Spalten (`Strg+Leertaste`, `Strg+A`, Ecke links oben) mit Kopfzeile (wird meist als eigene Tabelle eingefügt).
- CSV-Export: Werte, die mit `=`, `+`, `-`, `@` beginnen, bekommen ein `'` davor (Schutz vor Formeln, Kennzeichen
  bleiben lesbar); der `.xlsx`-Export hat echte Textzellen ohne Zeichen davor und ist für Excel die erste Wahl.
- Kabel und Schirme als Baum (Hauptzeile, darunter eingerückt die Adern, einklappbar); Filter wie der Excel-Autofilter:
  Adern erscheinen nur, wenn sie selbst passen, eine passende Ader bringt ihre Hauptzeile mit. Der Export enthält Haupt-
  und Aderzeilen (auch zugeklappte); im Tab Schirme steht je Ader eine Zeile statt der Spalten „Ader 1…n“.
- Nicht-Admins sehen Einstellungen und Protokolle nicht in der Navigation; direkte Adressen zeigen „Kein Zugriff“ (403)
  mit Navigation.
