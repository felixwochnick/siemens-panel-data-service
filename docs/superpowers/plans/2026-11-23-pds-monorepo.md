# EPLAN Panel Data Service Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die .NET-Exportanwendung wird ein Monorepo wie der ESWC: .NET-Worker nur für EPLAN, Auswertung in TS,
Ergebnisse versioniert in SQL Server, Web-App mit Tabellenansicht, MCP, Windows-Installer.

**Architecture:** Nuxt-App (`apps/web`) verwaltet Projekte, Warteschlange und Ergebnisse; ein .NET-Worker-Dienst
(`worker/`) liest Rohdaten aus EPLAN und spricht JSON-Zeilen über eine Named Pipe; `packages/analyzer` macht aus
Rohdaten Zeilen. Gemeinsame Bausteine (`core`, `ui`, `windows/`) kommen aus dem ESWC.

**Tech Stack:** pnpm, Nuxt 4, Nuxt UI 4, Kysely (mssql/tedious + node:sqlite), Vitest, Playwright, .NET Framework
4.8.1 (C#), xUnit (net10.0), Rust (windows-service, Tauri 2), WiX 5.

**Spec:** `docs/superpowers/specs/2026-11-23-pds-monorepo-design.md`

## Global Constraints

- Mit dem Nutzer Deutsch; Code-Bezeichner Englisch, Kommentare Deutsch (kurz, das Warum).
- Commits: Conventional Commits mit deutschem Betreff, Scopes `core, ui, analyzer, worker, web, windows, docker, e2e,
  docs`, Abschlusszeile `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Namen: Produkt „EPLAN Panel Data Service“, Scope `@pds/*`, Dienst `pds`, Worker `pds-eplan`, `pds-config`.
- Ports: dev 3400, E2E 3500, SQL Server 1435, Dex 5558, glauth 3895. Lokale Hostnamen `*.localhost`.
- Nur Siemens-Icons (`siemens:*`), alle Texte über i18n (de + en), Fehler als Code (`errors.<code>`).
- Migrationen für SQL Server **und** SQLite; Abfragen im SQL-Server-Stil (SqliteCompatPlugin); max. 2100 Parameter.
- MCP-Werkzeuge rufen nur Services auf, nie SQL. Geheimnisse nie in Logs/argv/MCP.
- Worker-Protokoll und Rohdatenformat exakt wie im Spec (Abschnitte „Protokoll“ und „Rohdaten“).
- Nach Codeänderungen `graphify update .` (falls `graphify-out/graph.json` existiert).

## Review Focus

- Projekt mit 0 Verbindungen / leeren Seiten: Analyse gelingt, Tabellen zeigen „keine Zeilen“ (Task 1, 3).
- Großes Projekt (≥ 20 000 Verbindungen): Speichern in Stücken < 2100 Parameter, Tabelle scrollt flüssig (Task 3, 4).
- Worker nicht erreichbar oder stirbt mitten in der Analyse: Auftrag `failed` mit Code, nächster Auftrag läuft nach
  Wiederverbindung (Task 3).
- Gleiches Projekt erneut hochgeladen, während ein Auftrag wartet: 409 `analysis_already_queued`, keine Doppel-
  Einträge (Task 3).
- Werte, die wie Formeln aussehen (`=VB030+LCM-Q20:1`), bleiben im xlsx-Export Text (Task 4).

---

### Task 0: Monorepo-Gerüst aus dem ESWC

**Files:** Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.editorconfig`, `.gitattributes`, `.gitignore`,
`.env.example`, `playwright.config.ts`, `packages/core/**`, `packages/ui/**`, `docker/**`, `windows/**` (kopiert,
umbenannt), `packages/analyzer/src/types.ts` (Rohdaten- und Ergebnis-Typen aus dem Spec), `CLAUDE.md`.
Move: `src/EplanElectricP8Api/**` → `worker/src/Pds.EplanWorker/**` (Altstand, Task 2 baut um), `symbole/` → `docs/`.

**Interfaces:** Produces: Workspace-Pakete `@pds/core`, `@pds/ui`; Typen `RawProject`, `AnalysisResult` usw. in
`@pds/analyzer` (`packages/analyzer/src/types.ts`); `pnpm db:up` auf Port 1435.

- [ ] Kopieren, `eswc`/`ESWC`/`Eswc`/„EPLAN Smart Wiring Controller“ → `pds`/`PDS`/`Pds`/„EPLAN Panel Data Service“,
  Ports anpassen, neuer WiX-`UpgradeCode`.
- [ ] `pnpm install`, `pnpm --filter @pds/core test:sqlite` (bzw. `TEST_DATABASE=sqlite pnpm --filter @pds/core test`)
  grün; `cargo test` in `windows/` grün.
- [ ] Commit `chore: Monorepo aus dem ESWC aufsetzen`.

### Task 1: `packages/analyzer`

**Files:** Create `packages/analyzer/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.ts}`,
`src/{index.ts,raw.ts,geometry.ts,endpoint.ts,hash-marks.ts,twist.ts,shields.ts,cables.ts,texts.ts,analyze.ts}`,
`fixtures/sample-raw.json`, `tests/*.test.ts`.

**Interfaces:** Consumes: `types.ts` (Task 0). Produces: `parseRawProject(json: unknown): RawProject`,
`analyze(raw: RawProject): AnalysisResult`, `AnalyzerError` (`code: 'raw_invalid'`), Fixture
`@pds/analyzer/fixtures/sample-raw.json`.

- [ ] Tests je Regel (Port aus den C#-Dateien, Werte aus dem Spec): `endpoint` (Stecker-Einfügung `:X531:`,
  Anschluss enthalten/nicht enthalten, leere Funktion), `geometry` (Offset nur am ersten Start-Treffer, Seitenwechsel
  ohne Abschnitt), `hash-marks` (Treffer bei ≤ 2 mm, kein Treffer bei 2,1 mm, `unmatched`), `twist` (Balken > 6 mm,
  Haken ≤ 3 mm an beiden Enden, ≥ 2 Schrägstriche 45°, Treffer ≤ 1 mm, Muster `VD_X500`/`VD_F500_1` ja, `VD_500`
  nein), `shields` (Varianten 0–3 und gespiegelt, GSC-Kabel, Schirmanschlüsse entfernt, Sortierung nach Seite),
  `cables` (Entdoppeln, `Precise` eindeutig/mehrdeutig/andere Seite), `texts` (Auswertungsseite, Gruppe, `#`,
  Reihenfolge y↓ x↑), `analyze` (Gesamt-Fixture, Zähler).
- [ ] Implementieren bis grün; `pnpm --filter @pds/analyzer lint typecheck test`.
- [ ] Commit `feat(analyzer): Auswertung der EPLAN-Rohdaten in TypeScript`.

### Task 2: `worker/` (.NET)

**Files:** `worker/Pds.EplanWorker.slnx`, `worker/src/Pds.EplanWorker/` (Program, Hosting, `Protocol/*`,
`Server/{PipeServer,StdioServer,Session}.cs`, `Eplan/{EplanHost,ProjectReader,RawWriter}.cs`),
`worker/stubs/Eplan.EplApi.Stubs/`, `worker/tests/Pds.EplanWorker.Tests/`. Delete: Excel, Quartz, SQLite, YAML,
Spectre, `ServiceCommands`.

**Interfaces:** Produces: `pds-eplan.exe service|run|stdio`, Protokoll und `raw.json` laut Spec. Konsumiert nichts
aus anderen Tasks.

- [ ] xUnit-Tests (net10.0) mit Fake-`IProjectReader`: `hello` beim Verbinden, `status` während laufendem `analyze`,
  `configure` mit anderen Pfaden nach EPLAN-Start ⇒ `restart_required`, ungültige Zeile ⇒ `invalid_request`,
  `progress`-Reihenfolge, Fehler ⇒ `response.error.code`, JSON ohne BOM, eine Zeile je Nachricht.
- [ ] Protokoll/Server implementieren; EPLAN-Teil (`ProjectReader`, `RawWriter` mit `Utf8JsonWriter`) aus den
  bisherigen Klassen ableiten; Stubs so, dass `dotnet build worker -c Release` unter Linux gelingt.
- [ ] `dotnet test worker/tests/...` grün, `dotnet build` grün. Commit `feat(worker): EPLAN-Worker liefert Rohdaten
  über Named Pipe`.

### Task 3: `apps/web` Server

**Files:** `apps/web/{nuxt.config.ts,package.json,…}`, `server/database/{migrations,types.ts}`,
`server/services/{settings,projects,uploads,folder,analyses,queue,results,retention,scheduler,worker-client,access,
audit,logs,status}.ts`, `server/plugins/{01.migrations,02.queue,03.scheduler}.ts`, `server/api/**`, `server/mcp/**`,
`server/routes/mcp.ts`, `shared/types/api.ts`, `tools/fake-worker/index.mjs`, `tests/**`. Übernehmen/anpassen aus
ESWC `apps/web` und `packages/controller/src/{drive,schedule,log}.ts`.

**Interfaces:** Consumes: `parseRawProject`, `analyze` (Task 1; bis zum Merge gegen `types.ts` programmieren).
Produces: REST-API und Typen in `shared/types/api.ts` (Task 4), MCP-Werkzeuge laut Spec.

- [ ] Integrationstests (SQL Server und SQLite): Migrationen + Sichten `v_current_*`; Einstellungen (Verschlüsselung
  Netzlaufwerk-Passwort, `{ set, readable }`); Upload `.zw1` (anderes Format ⇒ 400 `upload_invalid_type`, Größe);
  gleicher Name ⇒ gleiches Projekt; Ordner-Scan (`.elk` ohne `.edb` übersprungen, `source_modified` = neueste Datei);
  Warteschlange mit Ersatz-Worker (erfolgreich, Worker-Fehler, Zeitlimit, Worker weg); Ergebnisse in einer
  Transaktion (20 000 Verbindungen), `current_analysis_id`; doppelter Auftrag ⇒ 409; Aufbewahrung; Rechte
  (Nicht-Admin: keine Einstellungen); MCP-Werkzeuge.
- [ ] Implementieren bis grün; `pnpm lint typecheck test test:sqlite`.
- [ ] Commit `feat(web): Projekte, Warteschlange und Ergebnisse in der Datenbank`.

### Task 4: `apps/web` Oberfläche + E2E

**Files:** `apps/web/app/{pages,components,composables,utils}/**`, `components/sheet/DataSheet.vue` (+ Hilfen),
`i18n/locales/{de,en}/*.json`, `e2e/*.spec.ts`.

**Interfaces:** Consumes: API aus Task 3 (`shared/types/api.ts`).

- [ ] Seiten laut Spec (Übersicht, Projekte mit Upload/Ordner-Dialog, Projekt, Analyse, Einstellungen, Protokolle).
- [ ] `DataSheet`: Filter je Spalte, Sortieren, Suche, Bereichsauswahl + `Strg+C`, Spaltenbreite, virtuelles
  Scrollen, Export xlsx/CSV (Text-Zellen). Vitest für Filter/Sortierung/TSV/Export-Werte.
- [ ] E2E: Login (Admin, Nicht-Admin), Upload ⇒ Analyse ⇒ Tabellen (Filter, Sortieren, Export), Ordner-Auswahl,
  Einstellungen, MCP. Browser-Prüfung Desktop/Mobil, hell/dunkel.
- [ ] Commit `feat(web): Oberfläche mit Tabellenansicht`, `test(e2e): …`.

### Task 5: `windows/` – EPLAN-Worker-Dienst

**Files:** `windows/pds-common/src/eplan.rs` (+ Plattform), `windows/pds/src/cli/eplan_cmd.rs`,
`windows/pds-config/{src,ui/src}` (Abschnitt EPLAN-Worker), `windows/installer/Package.wxs`, `windows/scripts/*`
(Payload mit `eplan\`), Umgebung `NUXT_EPLAN_WORKER`, `NUXT_PDS_DATA_DIR`.

**Interfaces:** Consumes: `pds-eplan.exe service` (Task 2), Pipe-Name `\\.\pipe\pds-eplan`.

- [ ] Reine Logik testen (Linux): Kontoname prüfen (`DOMAIN\user`, `.\user`, UPN), Passwort nie in argv,
  ACL-Plan (uploads lesen, work/logs ändern), Dienst-Parameter (Pfad, Argument `service`, verzögerter Autostart).
- [ ] Windows-Teil hinter `cfg(windows)`; `cargo check --target x86_64-pc-windows-gnu` (falls Ziel installiert),
  `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- [ ] Commit `feat(windows): EPLAN-Worker als eigener Dienst`.

### Task 6: Dokumentation und Abschluss

- [ ] `README.md` (Aufbau, Entwicklung, Betrieb), `docs/pds-windows.md` (Installation, Worker-Konto, Rechte),
  `CLAUDE.md` (Arbeitsweise wie ESWC).
- [ ] Gesamtprüfung: `pnpm lint typecheck test test:sqlite test:e2e`, `dotnet test`, `cargo test`; Review des
  gesamten Branches; PR.
