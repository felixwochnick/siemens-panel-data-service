# E2E-Tests (Playwright)

`pnpm sso:up` (SQL Server 1435 und Test-IdP Dex 5558), laufende `pnpm dev`-Server der App beenden (gemeinsames
`.nuxt`) und prüfen, dass Port 3500 frei ist (`ss -ltnp`) – sonst nutzt Playwright einen fremden Server weiter. Dann
`pnpm test:e2e`. Playwright startet einen Dev-Server auf Port 3500 gegen die Datenbank `pds_e2e` und leert sie vorher.
Mit `E2E_DATABASE=sqlite` (`pnpm test:e2e:sqlite`) läuft derselbe Satz gegen eine SQLite-Datei im Temp-Ordner
(`pds-e2e-sqlite/pds.db`), die vor jedem Start des Dev-Servers gelöscht wird; Docker braucht dann nur der Test-IdP.

Statt EPLAN antwortet der Ersatz-Worker (`NUXT_EPLAN_WORKER=spawn:node tools/fake-worker/index.mjs`) mit der Fixture
`packages/analyzer/fixtures/sample-raw.json` (20 Verbindungen, 5 Kabel, 2 Schirme, 8 Texte). Der Datenordner der App
(`NUXT_PDS_DATA_DIR`, Temp-Ordner `pds-e2e-data`) wird vor jedem Start geleert. `global-setup.ts` legt einen
Projektordner mit Ersatz-Projekten an (`pds-e2e-projects`: `.elk` mit `.edb`, `.zw1`, `.elk` ohne `.edb`); der
Dev-Server bekommt einen Protokollordner (`NUXT_LOG_DIR`) mit Beispieldateien.

Die Tests bauen aufeinander auf (Dateien laufen in Namensreihenfolge, ein Worker).

- `01-auth.spec.ts`: Anmeldung, Navigation für Admins, Rechte für Nicht-Admins (keine Einstellungen, API 403).
- `02-projects.spec.ts`: Hochladen ⇒ Analyse ⇒ Tabellen: Zähler, Filter, Suche, Sortieren, Kopieren (TSV), Export
  (.xlsx mit Textzellen, eingelesen mit `read-excel-file`; CSV), Kabelnavigator, Sprung aus den Schirmen, Stände,
  Analyse mit Ereignissen.
- `03-settings.spec.ts`: Einstellungen (Prüfung, Cron-Vorschau, Speichern, Verbindungstest, Netzlaufwerk), Zeitplan
  auf der Übersicht, Protokolle.
- `04-folder.spec.ts`: Projekte aus dem Projektordner wählen und analysieren (Nicht-Admin).
- `05-mobile.spec.ts`: Mobilansicht ohne Seitenüberlauf.
- `09-mcp.spec.ts`: KI-Assistent (MCP) wie ein echtes Programm – Entdeckung der Anmeldung (mit den Funktionen des
  MCP-SDK), Registrierung, Zustimmung im Browser, Token-Austausch und Werkzeuge über einen kleinen JSON-RPC-Client.
- `99-screenshots.spec.ts`: nur mit `E2E_SCREENSHOTS=1`; schreibt die Bilder in `docs/screenshots/`.
