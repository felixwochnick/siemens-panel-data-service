# EPLAN Panel Data Service – Arbeitsweise

- Mit dem Nutzer Deutsch sprechen. Code-Bezeichner Englisch, Kommentare Deutsch (kurz, das *Warum*).
- Commits: Conventional Commits mit deutschem Betreff (`feat(web): …`, `fix(worker): …`), erklärender Text,
  Abschlusszeile `Co-Authored-By`. Scopes: core, ui, analyzer, worker, web, windows, docker, e2e, docs.
- Vor jedem Commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (SQL Server, braucht `pnpm db:up`) und
  `pnpm test:sqlite` grün; bei Änderungen unter `worker/` zusätzlich `dotnet build worker/Pds.EplanWorker.slnx` und
  `dotnet test worker/tests/Pds.EplanWorker.Tests`; unter `windows/` zusätzlich `cargo fmt --check`,
  `cargo clippy -- -D warnings`, `cargo test` in `windows/`.
- Jede sichtbare Änderung im Browser prüfen (Chromium `/usr/bin/chromium`, Playwright), Desktop und Mobil, hell
  und dunkel. Vor Interaktion auf `html[data-hydrated="true"]` warten (`state: 'attached'`).
- Design: `docs/superpowers/specs/2026-11-23-pds-monorepo-design.md`. Plan: `docs/superpowers/plans/2026-11-23-pds-monorepo.md`.
- Vorlage für alles, was es dort schon gibt: EPLAN Smart Wiring Controller (`~/WebstormProjects/eplan-smart-wiring-controler`).

## Struktur

- `worker/`: .NET-Framework-4.8.1-Worker `pds-eplan` (C#). **Nur EPLAN-Zugriffe**: Archiv wiederherstellen, Projekt
  öffnen, Rohdaten als JSON schreiben. Spricht JSON-Zeilen über `\\.\pipe\pds-eplan` (Dienst) oder stdin/stdout.
  Unter Linux baut er gegen Compile-Stubs der EPLAN-API (`worker/stubs`).
- `packages/analyzer`: Rohdaten → Zeilen (Verbindungen, Kabel, Schirme, Texte), rein, ohne Nuxt/DB/Node-APIs.
  Vertrag in `src/types.ts`.
- `packages/core` (Nuxt-Layer, aus dem ESWC): SQL Server oder SQLite (Kysely, `useDb()`), Migrationen
  (`registerMigrations`), OIDC-Login, Sessions, Benutzer, Login-Seite, Fehlercodes `errors.*`, OAuth-Server und
  MCP-Grundgerüst, Seiten `/oauth/authorize` und `/assistants`. Schalter `NUXT_PUBLIC_MCP_ENABLED`.
- `packages/ui` (Nuxt-Layer, aus dem ESWC): Nuxt UI im Siemens-Design, Siemens-Icons (`siemens:*`), Schriften, i18n.
- `apps/web`: Web-App. Schema `pds`, Services (`server/services`, ohne Nuxt-Abhängigkeit → direkt testbar), dünne
  API-Handler, Warteschlange und Zeitplaner (Nitro-Plugins), MCP-Werkzeuge (`server/mcp`).
- `tools/fake-worker`: Ersatz-Worker für Entwicklung und E2E (gleiches Protokoll, liefert Fixture-Rohdaten).
- `windows/`: Rust-Dienst und CLI (`pds`), Konfigurationsoberfläche (`pds-config`, Tauri 2 + Vue/Nuxt UI),
  Node-Werkzeuge, WiX-Installer; zusätzlich Einrichtung des Worker-Dienstes `pds-eplan`.

## Regeln

- **.NET nur, wo EPLAN zwingend ist.** Keine Auswertung, keine Datenbank, kein Zeitplan, kein Netzlaufwerk in C#.
- **Rollen**: alle angemeldeten Benutzer sehen Projekte/Ergebnisse, laden hoch und starten Analysen; Einstellungen,
  Protokolle, Zeitplan, Löschen nur Admins (`requireAuth(event, { admin: true })`, Dienste prüfen den Akteur).
- **Geheimnisse** (Netzlaufwerk-Passwort, Passwort des EPLAN-Kontos) nur verschlüsselt speichern, nie loggen, nie als
  Prozess-Argument übergeben, nach außen nur `{ set, readable }`.
- **Nur Siemens-Icons** (`siemens:*`), keine anderen Icon-Sets.
- **Alle Texte über i18n** (de + en). App-Texte je Bereich in `apps/web/i18n/locales/{de,en}/*.json`;
  Analyse-Ereignisse als Code (`analysisEvents.<code>`), nicht als Text.
- **MCP-Werkzeuge rufen nur Services auf (nie SQL).**
- Fehler als Code: `ServiceError(status, 'snake_case_code')` bzw. `createError({ message: 'code' })`; Übersetzung
  unter `errors.<code>`.
- **Datenbank**: Standard SQL Server (`mssql://…`), SQLite (`sqlite:<pfad>`) bleibt möglich. Abfragen im
  SQL-Server-Stil von Kysely (`top`, `offset/fetch`, `output('inserted.…')`, Tabellen `pds.connections`);
  `SqliteCompatPlugin` übersetzt sie (Tabellen `pds_connections`, LIMIT, RETURNING). Rohes SQL nur mit
  `sql.table()`/`sql.ref()` oder mit Zweig über `getDatabaseDialect(db)`.
- **SQLite hat eine Verbindung**: innerhalb von `db.transaction()` nur `trx` benutzen, nie `db`/`useDb()`.
- **SQL Server**: max. 2100 Parameter je Anweisung → `chunk()`; Zeitstempel als UTC (`datetime2(3)`).
- Ergebnisse einer Analyse in **einer** Transaktion schreiben; `current_analysis_id` erst danach setzen.
- Migrationen: neue Einträge, nie bestehende ändern, immer für beide Reihen (`MigrationSet.mssql` und `.sqlite`).
  Benannte Constraints (`pk_`, `fk_`, `uq_`, `ck_`, `df_`, `ix_`).
- Neue Tabellen/Services: Integrationstest gegen beide Datenbanken (`TEST_DATABASE=sqlite` für SQLite).
- Nuxt-Fallen: `UTable`-Spalten ohne `header: ''`; `useFetch` mit Refs im `query` braucht einen festen `key`;
  Datum/Zeit immer mit fester Zeitzone formatieren.
- Lokale Hostnamen immer `*.localhost`, nie `.local`.
- `packages/core`, `packages/ui` und `windows/` stammen aus dem ESWC: Fehlerbehebungen dort prüfen und bei Bedarf
  übernehmen.

## Befehle

`pnpm dev` (http://localhost:3400) · `pnpm db:up` / `pnpm sso:up` (SQL Server 1435, Dex 5558) · `pnpm test` ·
`pnpm test:sqlite` · `pnpm test:e2e` (Dev-Server auf 3500) · Test-Benutzer `anna` (Admin), `paul`, `lena`, `nina`,
Passwort `<name>-pass`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
