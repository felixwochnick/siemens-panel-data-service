# EPLAN Panel Data Service

Liest Daten aus **EPLAN-Electric-P8-Projekten** und stellt sie in **SQL Server** bereit: Verbindungen (mit #-Markierung,
Verdrillung und Abschirmung), Kabel mit Adern, Schirme und freie Texte. Benutzer laden Projekte in der **Web-App** hoch
(`.zw1`) oder wählen sie aus dem Projektordner bzw. Netzlaufwerk, lassen sie analysieren und sehen die Ergebnisse als
Tabellen wie in Excel (filtern, sortieren, kopieren, als `.xlsx`/CSV herunterladen). Jede Analyse bleibt als eigener
**Stand** erhalten; andere Systeme lesen den aktuellen Stand über die Sichten `pds.v_current_*`. KI-Assistenten greifen
über **MCP** (OAuth, Verbindung 30 Tage) darauf zu. Anmeldung per **Microsoft Entra ID**.

Aufgebaut und betrieben wie der EPLAN Smart Wiring Controller: pnpm-Monorepo mit Nuxt 4 + Nuxt UI im Siemens-Design,
Windows-Dienst per MSI, Einrichtung über eine Tauri-Oberfläche oder die Kommandozeile.

- Entwurf und Entscheidungen: [`docs/superpowers/specs/2026-11-23-pds-monorepo-design.md`](docs/superpowers/specs/2026-11-23-pds-monorepo-design.md)
- Betrieb unter Windows (Installation, Entra ID, Datenbank, EPLAN-Worker, Fehlersuche): [`docs/pds-windows.md`](docs/pds-windows.md)
- EPLAN-Worker (.NET): [`worker/README.md`](worker/README.md)

## Aufbau

```
Browser / KI-Assistent ──> Web-App (Nuxt, apps/web) ──> SQL Server (Schema pds)
                               │  Warteschlange, Zeitplan, Netzlaufwerk, Auswertung (packages/analyzer)
                               └──JSON-Zeilen über \\.\pipe\pds-eplan──> EPLAN-Worker pds-eplan (.NET, worker/)
                                                                            └──> EPLAN Platform + Electric P8
```

| Ordner | Inhalt |
| --- | --- |
| `apps/web` | Web-App: Projekte, Hochladen, Ordner-Auswahl, Analysen, Tabellenansicht, Einstellungen, Protokolle, Warteschlange, Zeitplan, MCP-Werkzeuge |
| `packages/analyzer` | Auswertung in TypeScript: aus den Rohdaten des Workers werden die Zeilen (Zuordnung #, Verdrillung, Schirm; Quelle/Ziel; Kabelliste) |
| `packages/core` | Nuxt-Layer: Datenbank (SQL Server, SQLite), Migrationen, OIDC-Anmeldung, Sessions, OAuth-Server und MCP-Grundgerüst |
| `packages/ui` | Nuxt-Layer: Nuxt UI im Siemens-Design, Siemens-Icons, Schriften, Sprachen |
| `worker/` | EPLAN-Worker `pds-eplan` (C#, .NET Framework 4.8.1): **nur** EPLAN-Zugriffe – Archiv wiederherstellen, Projekt öffnen, Rohdaten als JSON |
| `windows/` | Rust-Dienst und CLI `pds`, Konfigurationsoberfläche `pds-config` (Tauri), Node-Werkzeuge, WiX-Installer |
| `tools/fake-worker` | Ersatz-Worker für Entwicklung und E2E-Tests (gleiches Protokoll, liefert Beispiel-Rohdaten) |
| `docker/` | SQL Server, Dex und glauth für die Entwicklung |
| `e2e/` | Playwright-Tests |

### Ablauf einer Analyse

1. Auftrag entsteht durch Hochladen, „Analysieren“, Zeitplan oder MCP und wartet in der Warteschlange (eine Analyse
   gleichzeitig, ein offener Auftrag je Projekt).
2. Projekte aus dem Projektordner werden in einen Arbeitsordner kopiert; EPLAN verändert das Original nie.
3. Der Worker öffnet das Projekt mit der EPLAN-API und schreibt die Rohdaten (`raw.json`).
4. `packages/analyzer` bildet daraus die Zeilen; sie werden in **einer** Transaktion gespeichert, erst danach gilt der
   Stand als aktuell.

## Daten für die Weiterverarbeitung

Jede Analyse ist ein Stand (`pds.analyses`); die Ergebnisse liegen in `pds.connections`, `pds.cables`,
`pds.cable_wires`, `pds.shields`, `pds.shield_wires` und `pds.texts` (Schlüssel `analysis_id`, `idx`). Für andere
Systeme gibt es Sichten auf den **aktuellen** Stand jedes Projekts (mit `project_id`, `project_name`, `analysis_id`):

| Sicht | Inhalt |
| --- | --- |
| `pds.v_current_connections` | Verbindungen: Seite, Funktionsdefinition, Verbindungsbezeichnung, Quelle, Ziel, Kabel, Farbe/Nummer, Querschnitt, Typ, Länge, Artikelnummer, #-Markierung, Verdrillung, Abgeschirmt |
| `pds.v_current_cables` | Kabel und Schirme (Kabelnavigator) |
| `pds.v_current_cable_wires` | Adern je Kabel bzw. Anschlussleitungen je Schirm |
| `pds.v_current_shields` | Schirme und geschirmte Kabel |
| `pds.v_current_shield_wires` | abgeschirmte Adern je Schirm |
| `pds.v_current_texts` | freie Texte der Seiten |

Die Regeln für #-Markierung, Verdrillung (Bezeichnung `VD_…` oder gezeichnetes Symbol, siehe
[`docs/symbole/Verdrillung.png`](docs/symbole/Verdrillung.png)) und Abschirmung stehen im Code von `packages/analyzer`
(`hash-marks.ts`, `twist.ts`, `shields.ts`) und sind gegenüber der früheren .NET-Exportanwendung unverändert.
Die EPLAN-Kennung `eplan_id` gilt nur innerhalb einer Analyse.

## Entwicklung

Voraussetzungen: Node ≥ 24, pnpm, Docker; für den Worker das .NET SDK (baut unter Linux gegen Compile-Stubs der
EPLAN-API); für `windows/` Rust.

```sh
pnpm install
cp .env.example .env      # Ersatz-Worker, SQL Server auf 1435, Dex auf 5558
pnpm sso:up               # SQL Server + Test-IdP (Benutzer anna = Admin, paul, lena, nina; Passwort <name>-pass)
pnpm dev                  # http://localhost:3400
```

| Befehl | Zweck |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | alle Pakete |
| `pnpm test` / `pnpm test:sqlite` | Unit- und Integrationstests gegen SQL Server bzw. SQLite |
| `pnpm test:e2e` / `pnpm test:e2e:sqlite` | Playwright (eigener Dev-Server auf 3500, Ersatz-Worker) |
| `dotnet build worker/Pds.EplanWorker.slnx` / `dotnet test worker/tests/Pds.EplanWorker.Tests` | EPLAN-Worker |
| `cargo test --workspace` (in `windows/`) | Dienst, CLI, Konfigurationsoberfläche |

Mit echtem EPLAN (Windows): Worker in Visual Studio Code mit „EPLAN-Worker: run (Named Pipe)“ starten und in `.env`
`NUXT_EPLAN_WORKER=pipe:\\.\pipe\pds-eplan` setzen, oder Nuxt startet ihn selbst:
`NUXT_EPLAN_WORKER=spawn:worker\src\Pds.EplanWorker\bin\Debug\net481\pds-eplan.exe stdio`.

Arbeitsweise und Regeln für Änderungen: [`CLAUDE.md`](CLAUDE.md).
