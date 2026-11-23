# E2E-Tests (Playwright)

`pnpm db:up && pnpm sso:up`, laufende `pnpm dev`-Server der App beenden (gemeinsames `.nuxt`), dann `pnpm test:e2e`.
Playwright startet einen Dev-Server auf Port 3500 gegen die Datenbank `pds_e2e` und leert sie vorher. Mit
`E2E_DATABASE=sqlite` (`pnpm test:e2e:sqlite`) läuft derselbe Satz gegen eine SQLite-Datei im Temp-Ordner
(`pds-e2e-sqlite/pds.db`), die vor jedem Start des Dev-Servers gelöscht wird; Docker braucht dann nur der Test-IdP.
`global-setup.ts` legt einen Ordner mit `.epdz`-Dateien an und startet eine Nachbildung der EPLAN-API auf Port 3399
(`E2E_FAKE_EPLAN_PORT`); der Dev-Server bekommt einen Protokollordner (`NUXT_LOG_DIR`) mit Beispieldateien.

Die Tests bauen aufeinander auf (Dateien laufen in Namensreihenfolge, ein Worker).

- `01-auth.spec.ts`: Anmeldung, Admin-Zugang, „Kein Zugriff“ für Nicht-Admins.
- `02-console.spec.ts`: Einstellungen speichern (Prüfung, Passwort, Verbindungstest), Lauf gegen die Fake-API,
  Dateien vergessen, Zeitplan schalten, Protokolle, Mobilansicht.
- `09-mcp.spec.ts`: KI-Assistent (MCP) wie ein echtes Programm – Entdeckung der Anmeldung (mit den Funktionen des
  MCP-SDK), Registrierung, Zustimmung im Browser, Token-Austausch und Werkzeuge über einen kleinen JSON-RPC-Client.
