# EPLAN-Worker `pds-eplan`

.NET-Framework-4.8.1-Programm (x64), das nur macht, was EPLAN zwingend braucht: EPLAN starten, Archive (`.zw1`)
wiederherstellen, das Projekt öffnen und seine Rohdaten als `raw.json` schreiben. Die Auswertung (Verbindungen, Kabel,
Schirme, Texte) macht `packages/analyzer`.

Protokoll (JSON-Zeilen) und Rohdatenformat: `docs/superpowers/specs/2026-11-23-pds-monorepo-design.md`, Abschnitte
„Protokoll“ und „Rohdaten“; dieselben Rohdaten als TypeScript-Typen in `packages/analyzer/src/types.ts`.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `src/Pds.EplanWorker.Core` | `netstandard2.0`, ohne EPLAN: Protokoll, `Session`, `WorkerController` (Konfiguration, `busy`), Projektdateien, `raw.json`-Writer, Kommandozeile |
| `src/Pds.EplanWorker` | `pds-eplan.exe`: Hosting (Dienst/Konsole), Named-Pipe-Server mit ACL, `Eplan/` (EPLAN-Start auf STA-Thread, Öffnen, Lesen der Rohdaten) |
| `stubs/Eplan.EplApi.Stubs` | Compile-Stubs der verwendeten EPLAN-API-Mitglieder für Builds ohne EPLAN |
| `tests/Pds.EplanWorker.Tests` | xUnit (`net10.0`), Protokoll und JSON mit einem Ersatz für EPLAN |

## Bauen

Unter Windows mit EPLAN (echte DLLs aus `C:\Program Files\EPLAN\Platform\2025.0.3\Bin`, sonst
`-p:EplanBinPath=<Ordner>`):

```powershell
dotnet build worker/Pds.EplanWorker.slnx -c Release
```

Unter Linux (oder ohne EPLAN) baut dasselbe Kommando gegen `stubs/`. **So gebaut läuft der Worker nicht** – jeder
EPLAN-Zugriff wirft `NotImplementedException`, eine Analyse endet mit `eplan_start_failed`. Für die Auslieferung
immer gegen die echten DLLs bauen. Die .NET-Framework-Referenzassemblies kommen aus dem NuGet-Paket
`Microsoft.NETFramework.ReferenceAssemblies` (kein Developer Pack nötig).

Tests (ohne EPLAN, auch unter Linux):

```sh
dotnet test worker/tests/Pds.EplanWorker.Tests
```

Neue EPLAN-Zugriffe brauchen ein passendes Mitglied in `stubs/` (Signatur aus der EPLAN-API-Doku). Die EPLAN-DLLs
werden nicht ausgeliefert, nur `Eplan.EplApi.Starteru.dll` liegt neben der exe und lädt die übrigen zur Laufzeit aus
der EPLAN-Installation.

## Betriebsarten

```text
pds-eplan service [--pipe <name>] [--log-dir <ordner>]            Windows-Dienst, lauscht auf \\.\pipe\pds-eplan
pds-eplan run     [--pipe <name>] [--log-dir <ordner>] [--dialogs] dasselbe in der Konsole (Fehlersuche)
pds-eplan stdio   [--log-dir <ordner>] [--dialogs]                 eine Sitzung über stdin/stdout
```

- `--dialogs` erlaubt Dialoge von EPLAN (Lizenz, Anmeldung); als Dienst nie.
- Logs: `%ProgramData%\EPLAN Panel Data Service\logs\eplan-worker-<Datum>.log` und stderr, nie stdout.
- Pipe-ACL: `NT SERVICE\pds` (lesen/schreiben), `BUILTIN\Administrators` und das Konto des Workers (Vollzugriff).
  Immer nur ein Client; trennt er die Verbindung, wartet der Worker auf den nächsten (kurz gibt es dann keine
  Pipe-Instanz, der Client muss den Verbindungsaufbau wiederholen).
- EPLAN startet mit der ersten Analyse und bleibt geladen. `configure` mit anderen Pfaden danach ⇒
  `restart_required`; der Client schickt `exit`, der Dienst wird über die Wiederherstellungsaktionen neu gestartet.
- `exit` beendet den Prozess sofort mit dem Code (EPLAN wird vorher beendet, wenn keine Analyse läuft).
- Eine Analyse läuft weiter, wenn der Client die Verbindung trennt; bis zu ihrem Ende meldet `status` `busy: true`.

Debuggen in VS Code: `.vscode/launch.json` („EPLAN-Worker: run“, „… mit EPLAN-Dialogen“, „… stdio“), Logs dann in
`worker/logs`.
