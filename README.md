# EPLAN Electric P8 Export

Konsolenanwendung bzw. Windows-Dienst, der EPLAN Electric P8 Projekte ohne Benutzeroberfläche öffnet und die
**Verbindungen** als Excel-Datei (`.xlsx`) exportiert. Projekte werden entweder einzeln auf Zuruf oder nach einem Cron-Zeitplan
aus einem Projektordner exportiert. Es werden nur neue oder seit dem letzten Export geänderte Projekte verarbeitet.

Unterstützt werden Projekte (`.elk` + gleichnamiger `.edb` Ordner) und Projektarchive (`.zw1`).

## Voraussetzungen

- Windows (x64) mit installiertem **EPLAN Electric P8 2025** inkl. gültiger Lizenz für den ausführenden Benutzer
- **.NET Framework 4.8.1** (Runtime; zum Bauen das Developer Pack)
- **.NET SDK** (für `dotnet build` / `dotnet run`)

Die EPLAN API DLLs werden zur Build-Zeit aus `C:\Program Files\EPLAN\Platform\2025.0.3\Bin` referenziert. Ein anderer
Pfad kann mit `dotnet build -p:EplanBinPath=...` angegeben werden. Zur Laufzeit werden die DLLs aus dem in der
`config.yaml` eingetragenen Platform-Ordner geladen.

## Bauen

```powershell
dotnet build
```

Die exe liegt danach in `src\EplanElectricP8Api\bin\Debug\net481\`, zusammen mit einer Beispiel-`config.yaml`.

## Verwendung

Der Start von EPLAN dauert je nach Rechner einige Minuten.

### Einzelnes Projekt exportieren

```powershell
dotnet run --project src/EplanElectricP8Api -- export 'C:\Projekte\Anlage.zw1' -o 'C:\Export'
```

| Option | Bedeutung |
|---|---|
| `<PROJECT>` | `.elk` Datei, `.edb` Ordner oder `.zw1` Archiv |
| `-o, --output` | Ausgabeordner (Standard: `export.output_folder` aus der config.yaml) |
| `-c, --config` | Pfad zur config.yaml (optional; ohne Datei gelten die Standardwerte) |

> In PowerShell einen Pfad mit Leerzeichen nicht mit `\` enden lassen (`"C:\Export\"`): das `\"` maskiert das
> Anführungszeichen. Einfache Anführungszeichen oder den Backslash weglassen.

### Alle Projekte eines Ordners exportieren

```powershell
EplanElectricP8Api.exe run --now     # einmal sofort exportieren und beenden
EplanElectricP8Api.exe run           # dauerhaft laufen und nach Cron-Zeitplan exportieren
```

| Option | Bedeutung |
|---|---|
| `-c, --config` | Pfad zur config.yaml (Standard: neben der exe) |
| `-l, --logging` | Log-Verzeichnis (überschreibt `logging.directory`) |
| `--now` | Export-Lauf sofort ausführen und beenden, Zeitplan wird ignoriert |

Ein Projekt wird übersprungen, wenn es seit dem letzten erfolgreichen Export nicht geändert wurde (neueste Datei aus
`.elk` und `.edb` Ordner). Der Stand wird in einer SQLite-Datenbank (`database.path`) gespeichert. Fehlgeschlagene
Projekte werden beim nächsten Lauf erneut versucht.

### Konfiguration erstellen

```powershell
EplanElectricP8Api.exe configure     # interaktiver Assistent, schreibt die config.yaml
```

### Als Windows-Dienst

Als Administrator ausführen:

```powershell
EplanElectricP8Api.exe service install --user DOMAIN\benutzer   # installieren und starten
EplanElectricP8Api.exe service uninstall                        # stoppen und entfernen
```

Der Dienst heißt `EplanP8ExportService` und startet automatisch. Ohne `--user` läuft er als LocalSystem; EPLAN
braucht dort ggf. eine eigene Lizenz und Einstellungen. Das Dienstkonto muss EPLAN lizenziert nutzen dürfen.

## Konfiguration (`config.yaml`)

Relative Pfade beziehen sich auf den Ordner der config.yaml.

```yaml
logging:
  # directory: 'logs'                # leer = 'logs' neben der exe
  level: Information                 # Verbose | Debug | Information | Warning | Error | Fatal

eplan:
  platform_bin: 'C:\Program Files\EPLAN\Platform\2025.0.3\Bin'
  product_bin: 'C:\Program Files\EPLAN\Electric P8\2025.0.3\Bin'
  application_modifier: ''           # leer = Variante aus der install.xml

database:
  path: 'exports.db'                 # merkt sich, welche Projekte mit welchem Stand exportiert wurden

export:
  project_folder: 'D:\EPLAN\Projekte'
  recursive: true
  file_patterns: ['*.elk', '*.zw1']
  output_folder: 'D:\EPLAN\Export'   # pro Projekt ein Unterordner mit dem Projektnamen
  cron_schedule: '0 0 2 * * ?'       # Quartz Cron: Sek Min Std Tag Monat Wochentag (hier täglich 02:00)
  open_mode: ReadOnly                # ReadOnly | Standard | Exclusive
  language: de_DE
  labels: []                         # optionale zusätzliche Exporte über EPLAN-Beschriftungsschemas
```

Beispiele für `cron_schedule`: `'0 0 * * * ?'` (stündlich), `'0 0/15 * * * ?'` (alle 15 Minuten),
`'0 0 6 ? * MON-FRI'` (werktags 06:00).

### Optionale Beschriftungs-Exporte

Zusätzlich zur Verbindungsliste können EPLAN-Beschriftungen (Action `label`) ausgeführt werden. Das Schema muss im
EPLAN des ausführenden Benutzers vorhanden sein, sonst schlägt der Export fehl.

```yaml
  labels:
    - name: Betriebsmittelliste
      config_scheme: Device tag list
      file_name: '{project}_Betriebsmittel.txt'   # {project} = Projektname
```

## Ausgabe: Verbindungsliste

Pro Projekt entsteht `<output_folder>\<Projektname>\<Projektname>_Verbindungen.xlsx`. Die Verbindungen werden direkt über
die EPLAN API gelesen; ein Beschriftungsschema ist dafür **nicht** nötig.

Exportiert werden die Verbindungen aus dem Schaltplan; 3D-Verbindungen aus dem Schaltschrankaufbau (Pro Panel) sind
Doppelungen davon und werden ausgelassen.

Die Datei enthält das Blatt „Verbindungen“ mit einer Excel-Tabelle: Jede Spalte lässt sich über die Kopfzeile filtern
und sortieren, die Kopfzeile bleibt beim Scrollen stehen. Alle Werte sind als Text gespeichert, Kennzeichen wie
`=VB030+LCM-Q20:1` werden also nicht als Formel ausgewertet.

| Spalte | Inhalt |
|---|---|
| Seite | Seite, auf der die Verbindung liegt, z.B. `=VB030+LCM&EFS/7` |
| Verbindungsbezeichnung | Eigenschaft <31011>, z.B. `VD_X500` (bei verdrillten Leitungen haben beide Adern dieselbe Bezeichnung) |
| Quelle / Ziel | Betriebsmittelkennzeichen und Anschluss, z.B. `=VB030+LCM-Q20:1` |
| Farbe/Nummer | z.B. `BK` |
| Querschnitt | z.B. `1,5 mm²` |
| Typ | Leitungstyp, z.B. `SIENOPYR(90)` |
| Länge | Leitungslänge |
| Artikelnummer | Artikelnummer(n) der Verbindung, mehrere durch Komma getrennt |
| #-Markierung | `ja`, wenn die Leitung im Schaltplan mit `#` markiert ist (siehe unten) |
| Verdrillung | `ja`, wenn die Leitung verdrillt ist (siehe unten) |
| Abgeschirmt | `ja`, wenn die Leitung abgeschirmt ist (siehe unten) |

### #-Markierung

Im Schaltplan werden Leitungen mit einem `#` gekennzeichnet (z.B. „# Kurzschlußsichere Verlegung“). Dieses `#` ist
**keine Eigenschaft der Verbindung**, sondern ein freier Text, der auf die Leitung gelegt wurde. Die Zuordnung erfolgt
deshalb geometrisch:

1. Auf jeder Seite werden alle Texte gesucht, deren Inhalt genau `#` ist (Legendentexte wie „# Kurzschlußsichere
   Verlegung“ zählen nicht).
2. Für jede Verbindung wird der Leitungsweg aus ihren Symbolen gebildet (Gerätanschluss, Winkel, Unterbrechungsstellen).
3. Liegt ein `#` höchstens 2 mm neben einem Abschnitt dieses Wegs auf derselben Seite, gilt die Verbindung als markiert.

Bei Leitungen über mehrere Seiten genügt ein `#` auf einem Abschnitt. Kann ein `#` keiner Verbindung zugeordnet werden,
erscheint im Log eine Warnung. Da die Zuordnung über die Lage erfolgt, sind Fehlzuordnungen möglich, wenn ein `#`
ungewöhnlich weit neben der Leitung oder sehr nah an einer anderen Leitung steht.

### Verdrillung

Verdrillte Adern haben eine gemeinsame Verbindungsbezeichnung nach dem Muster `VD_` + Buchstabe + Ziffern, optional
gefolgt von `_` + Ziffern (z.B. `VD_X500`, `VD_A61`, `VD_F500_1`). Verbindungen mit einer solchen Bezeichnung werden
als verdrillt markiert; welche Adern zusammengehören, zeigt die gemeinsame Bezeichnung in der Spalte
„Verbindungsbezeichnung“.

### Abschirmung

Ein Schirm wird im Schaltplan als gestrichelte Linie quer über die Adern gezogen und meist an einem Ende geerdet.
EPLAN verknüpft die Adern nicht in jedem Projekt mit dem Schirm, daher gilt eine Verbindung als abgeschirmt, wenn

1. ihr in EPLAN ein Schirm zugeordnet ist, oder
2. sie die gezeichnete Schirmlinie kreuzt. Die Länge der Linie steht am Schirmsymbol in den Eigenschaften
   „Breite“/„Höhe“ (`RECTANGLE_WIDTH`/`RECTANGLE_HEIGHT`), die Richtung vom Symbolpunkt aus ergibt sich aus der
   Symbolvariante (0 = rechts, 1 = oben, 2 = links, 3 = unten; bei gespiegelten Varianten werden beide Seiten geprüft).

Die Schirmanschlüsse selbst (Leitung vom Schirm zur Erdung bzw. Schirmklemme) gelten nicht als abgeschirmt.

## Aufbau des Codes

| Datei | Aufgabe |
|---|---|
| `Program.cs` | Kommandozeile (`run`, `export`, `configure`, `service`) |
| `ExportCommand.cs` | Einzel-Export eines Projekts |
| `RunCommand.cs` | Dienst/Zeitplan (Quartz) und `--now` |
| `ExportJob.cs` | Ein Export-Lauf über den Projektordner, überspringt unveränderte Projekte |
| `ExportDatabase.cs` | SQLite-Protokoll der Exporte |
| `EplanWorker.cs` | Startet EPLAN einmal pro Prozess und führt alle API-Aufrufe auf einem STA-Thread aus |
| `ProjectExporter.cs` | Archiv wiederherstellen, Projekt öffnen, Exporte ausführen |
| `ConnectionExporter.cs` | Schreibt die Verbindungsliste als Excel-Datei (ClosedXML) |
| `HashMarkFinder.cs` | Ordnet `#`-Texte geometrisch den Verbindungen zu |
| `ShieldFinder.cs` | Erkennt abgeschirmte Verbindungen |
| `ConnectionGeometry.cs` | Leitungsweg einer Verbindung aus ihren Symbolen (für die geometrische Zuordnung) |
| `ProjectFiles.cs` | Hilfsfunktionen für `.elk` / `.edb` / `.zw1` |
| `ConfigModel.cs`, `ConfigLoader.cs`, `ConfigureCommand.cs` | config.yaml lesen, schreiben und interaktiv bearbeiten |
| `ServiceCommands.cs` | Windows-Dienst installieren/entfernen (`sc.exe`) |
| `LoggingSetup.cs` | Serilog (Konsole und tägliche Log-Datei) |

Archive (`.zw1`) werden nach `%TEMP%\EplanElectricP8Api\<Dateiname>` wiederhergestellt und nach dem Export gelöscht.

## Debuggen in VS Code

In `.vscode/launch.json` gibt es zwei Konfigurationen („Einzelnes Projekt exportieren“ und „Export-Lauf sofort“).
Da die Anwendung auf .NET Framework läuft, wird der `clr` Debugger verwendet.

TEST
