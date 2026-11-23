#Requires -Version 7.2
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Smoke-Test des MSI auf einem frischen Windows (CI: windows-2022-Runner).

.DESCRIPTION
  Ändert den Rechner (Dienst, Firewall, Registry, %ProgramData%, SQL Server Express) und ist deshalb nur
  für kurzlebige Testmaschinen gedacht. Jede Prüfung ist eine Funktion und bricht mit klarer Meldung ab.

  Stufe 1 (Installation von -Msi, ohne Konfiguration):
    1. Stille Installation, Exit 0; das MSI wartet nicht auf den Dienststart, der Test schon (mit
       Zeitmessung: Startauftrag, Prozessanlage, erste Logzeile, Profil des virtuellen Kontos)
    2. Dienst: Konto, automatischer verzögerter Start, läuft; Wiederherstellung (sc qfailure/qfailureflag)
    3. `pds status --json` aus einer neuen Shell (PATH): Zustand unconfigured, Version
    4. ACL des Datenordners
    5. Firewall-Regel mit Ports 80 und 443
    6. Ereignisquelle registriert
    7. App-Secret in config.toml per DPAPI versiegelt
    7b. Konfigurationsoberfläche: EXE, Startmenü-Verknüpfung, Manifest mit requireAdministrator
    7c. Konfigurationsoberfläche starten: Hauptfenster mit WebView2 erscheint, Bildschirmfoto
    7d. SQLite (Standard einer frischen Konfiguration, ohne SQL Server): tls.mode off auf einem freien
        Port, Dienst gesund, Migrationen in data\pds.db, -wal/-shm daneben, Dienstkonto mit Ändern auf
        data\ (geerbt auf die Datei), Online-Sicherung mit db backup; danach die Konfiguration von
        vorher wieder importiert (nicht eingerichtet)
    8a. Deinstallation ohne REMOVE_DATA: Daten bleiben
  Stufe 2 (Laufzeit mit SQL Server Express, Upgrade von -BaselineMsi, Secrets). Sie beginnt mit der
  Basisversion X.Y.0; die echte Version aus Stufe 1 muss dafür weg sein (ein Downgrade sperrt das MSI),
  deshalb steht 8a davor:
    S1. SQL Server Express (choco), gemischte Anmeldung, TCP 1433
    S2. Basisversion über die erhaltenen Daten installieren
    S3. Konfiguration über die CLI (db.kind sqlserver, Secrets über stdin), tls.mode certificate mit
        importiertem PFX; das
        Testzertifikat kommt in LocalMachine\Root, damit die öffentliche Health-Prüfung (SChannel) ihm traut
    S4. db setup und db test
    S5. service restart --wait, Health über Caddy (curl und status.public), status, oidc test
    S6. Fehlkonfiguration: Datenbank nicht erreichbar (Backoff), Hostname leer (unconfigured)
    S7. Upgrade auf -Msi: Konfiguration unverändert, wieder gesund (auch status.public)
    S8. Kein Secret in Datenordner, MSI-Logs, Prozess-Befehlszeilen, Ereignisprotokoll und CLI-Ausgaben
    S9. Stop-Service/Start-Service mit Zeitmessung: wieder gesund (Ersatz für den Neustart des Rechners)
  Zum Schluss:
    8b. Deinstallation mit REMOVE_DATA=1: Dienst und Datenordner weg
  Das Testzertifikat verlässt LocalMachine\Root in jedem Fall wieder (finally).

  MSI-Logs und Diagnose landen in -LogDir.

.EXAMPLE
  pwsh windows/scripts/smoke.ps1 -Msi dist/pds-0.1.42-x64.msi `
    -BaselineMsi dist/pds-0.1.0-x64.msi -LogDir smoke-logs
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Msi,
    # Basisversion X.Y.0 für den Upgrade-Test (Stufe 2)
    [Parameter(Mandatory)]
    [string] $BaselineMsi,
    [string] $LogDir = (Join-Path ([System.IO.Path]::GetTempPath()) 'pds-smoke')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'smoke-lib.ps1')

foreach ($file in @($Msi, $BaselineMsi)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "MSI fehlt: $file"
    }
}
$Msi = (Resolve-Path -LiteralPath $Msi).Path
$BaselineMsi = (Resolve-Path -LiteralPath $BaselineMsi).Path
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogDir = (Resolve-Path -LiteralPath $LogDir).Path

$Version = Get-SmokeMsiVersion $Msi
$BaselineVersion = Get-SmokeMsiVersion $BaselineMsi
# MSI-Logs dieses Laufs; die Secret-Prüfung durchsucht sie
$MsiLogs = [System.Collections.Generic.List[string]]::new()

# Feste Test-Secrets mit eindeutigen Markern. Das DB-Passwort enthält Zeichen, die in URL und T-SQL
# besonders sind; das Admin-Passwort ist das sa-Passwort des SQL Servers.
$DbPassword = "Smoke-Db-7f3a'Pw@%!"
$ClientSecret = 'smoke-client-secret-91c2'
$PfxPassword = 'smoke-pfx-55aa'
$AdminPassword = 'Smoke-Sa-2c8e-Adm1n'
# Öffentliche Health-Adresse und HTTP-Port; weichen nur ab, wenn http.sys 443 bzw. 80 hält (siehe S3)
$HealthUrl = 'https://localhost/api/health'
$HttpPort = 80
# Port der SQLite-Stufe (7d, tls.mode off): weit weg von 80/443, die http.sys auf dem Runner halten kann
$SqliteHttpPort = 18080
# Fingerabdruck des Testzertifikats in LocalMachine\Root (S3); am Ende wieder entfernt
$RootThumbprint = $null
$TenantId = [guid]::NewGuid().ToString()
$ClientId = [guid]::NewGuid().ToString()
$Markers = [ordered]@{
    'DB-Passwort'   = @(
        $DbPassword,
        # wie render.rs/Rust (alles außer A-Z a-z 0-9 - . _ ~) und wie .NET
        [Uri]::EscapeDataString($DbPassword),
        # wie encodeURIComponent in JavaScript (' und ! bleiben)
        "Smoke-Db-7f3a'Pw%40%25!",
        # als T-SQL-Literal
        $DbPassword.Replace("'", "''")
    )
    'Client-Secret' = @($ClientSecret)
    'PFX-Passwort'  = @($PfxPassword)
    'Admin-Passwort' = @($AdminPassword)
}

# --- Stufe 1 ------------------------------------------------------------------------------------------

# Liefert das Ende von msiexec (UTC) für die Zeitmessung des Dienststarts
function Install-Product([string] $Package, [string] $LogName) {
    $log = Join-Path $LogDir $LogName
    $MsiLogs.Add($log)
    $code = Invoke-SmokeMsiexec -Arguments @('/i', $Package) -Log $log
    $ended = [DateTime]::UtcNow
    if ($code -ne 0) {
        Show-MsiLogFailure $log
    }
    Assert-Smoke ($code -eq 0) "msiexec /i $([System.IO.Path]::GetFileName($Package)) endete mit $code (Log: $LogName)"
    return $ended
}

# Das MSI startet den Dienst, wartet aber nicht darauf (ServiceControl Wait="no"): Ein langsamer erster
# Start soll die Installation nicht zurückrollen. Hier wird gewartet und die Dauer gezeigt.
function Wait-ServiceRunningAfterInstall([datetime] $InstallEnded, [string] $LogName, [string] $Label) {
    Wait-Smoke { (Get-Service -Name $ServiceName -ErrorAction Stop).Status -eq 'Running' } 120 `
        "Dienst $ServiceName läuft nach der Installation" | Out-Null
    $running = [DateTime]::UtcNow
    Write-SmokeOk "Dienst läuft $([math]::Round(($running - $InstallEnded).TotalSeconds, 1)) s nach dem Ende von msiexec"
    Show-SmokeStartTiming -Since $InstallEnded -Running $running -Label $Label -MsiLog (Join-Path $LogDir $LogName)
}

function Uninstall-Product([string] $Package, [string] $LogName, [string[]] $Properties = @()) {
    $log = Join-Path $LogDir $LogName
    $MsiLogs.Add($log)
    $code = Invoke-SmokeMsiexec -Arguments (@('/x', $Package) + $Properties) -Log $log
    if ($code -ne 0) {
        Show-MsiLogFailure $log
    }
    Assert-Smoke ($code -eq 0) "msiexec /x $([System.IO.Path]::GetFileName($Package)) $Properties endete mit $code (Log: $LogName)"
}

function Wait-ServiceRunning {
    Wait-Smoke { (Get-Service -Name $ServiceName -ErrorAction Stop).Status -eq 'Running' } 60 `
        "Dienst $ServiceName läuft" | Out-Null
}

# Genau ein Produkt in „Programme und Features“, mit der erwarteten Version
function Assert-InstalledVersion([string] $Expected) {
    $products = @(Get-SmokeInstalledProducts)
    Assert-Smoke ($products.Count -eq 1) "Erwartet genau ein installiertes $ProductName, gefunden: $($products.Count) ($(($products | ForEach-Object DisplayVersion) -join ', '))"
    Assert-Smoke ($products[0].DisplayVersion -eq $Expected) "Installierte Version ist $($products[0].DisplayVersion), erwartet $Expected"
    Write-SmokeOk "installiert: Version $Expected"
}

# Die Dienst-EXE meldet ihre Version im Status; beide MSIs enthalten dieselbe EXE (Version von -Msi)
function Assert-StatusVersion($Report) {
    Assert-Smoke ($Report.status.productVersion -eq $Version) "status.productVersion ist '$($Report.status.productVersion)', erwartet $Version"
    Write-SmokeOk "status.productVersion = $Version"
}

# 1. Stille Installation
function Test-Install {
    Write-SmokeStep '1. Installation (msiexec /i /qn)'
    $ended = Install-Product $Msi 'install.log'
    Write-SmokeOk 'Exit-Code 0'
    Wait-ServiceRunningAfterInstall $ended 'install.log' 'erster Start nach der Erstinstallation'
}

# 2. Dienst: Konto, Starttyp, verzögerter Start, läuft
function Test-Service {
    Write-SmokeStep '2. Dienst'
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
    Assert-Smoke ($null -ne $service) "Dienst $ServiceName ist nicht installiert"
    Assert-Smoke ($service.StartName -eq $ServiceAccount) "Dienstkonto ist '$($service.StartName)', erwartet '$ServiceAccount'"
    Write-SmokeOk "Konto $($service.StartName)"
    Assert-Smoke ($service.StartMode -eq 'Auto') "Starttyp ist '$($service.StartMode)', erwartet 'Auto'"
    $delayed = Get-ItemPropertyValue -LiteralPath $ServiceKey -Name 'DelayedAutostart' -ErrorAction SilentlyContinue
    Assert-Smoke ($delayed -eq 1) "DelayedAutostart ist '$delayed', erwartet 1"
    Write-SmokeOk 'Start automatisch (verzögert)'
    Wait-ServiceRunning
    $state = (Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'").State
    Assert-Smoke ($state -eq 'Running') "Dienstzustand ist '$state', erwartet 'Running'"
    Write-SmokeOk 'läuft'
}

# 2b. Wiederherstellung: drei Neustarts, auch bei Fehlern ohne Absturz
function Test-ServiceRecovery {
    Write-SmokeStep '2b. Wiederherstellung des Dienstes'
    $failure = (& sc.exe qfailure $ServiceName) -join "`n"
    Assert-Smoke ($LASTEXITCODE -eq 0) "sc qfailure endete mit $LASTEXITCODE`n$failure"
    Write-Host $failure
    Assert-Smoke ($failure -match 'RESET_PERIOD[^:]*:\s*86400\b') 'Rücksetzzeit der Fehlerzählung ist nicht 86400 s'
    $restarts = '(?s)RESTART -- Delay = 10000 milliseconds.*RESTART -- Delay = 60000 milliseconds.*RESTART -- Delay = 300000 milliseconds'
    Assert-Smoke ($failure -match $restarts) 'Erwartet drei Neustarts nach 10 s, 60 s und 300 s'
    Write-SmokeOk 'Neustart nach 10 s / 60 s / 5 min, Rücksetzen nach 24 h'

    $flag = (& sc.exe qfailureflag $ServiceName) -join "`n"
    Assert-Smoke ($LASTEXITCODE -eq 0) "sc qfailureflag endete mit $LASTEXITCODE`n$flag"
    Write-Host $flag
    Assert-Smoke ($flag -match 'FAILURE_ACTIONS_ON_NONCRASH_FAILURES\s*:\s*(TRUE|1)\b') 'Fehleraktionen gelten nicht für Fehler ohne Absturz'
    Write-SmokeOk 'Fehleraktionen auch bei Fehlern ohne Absturz'
}

# 3. status --json über PATH aus einer neuen Shell
function Test-StatusUnconfigured {
    Write-SmokeStep '3. pds status --json (neue Shell)'
    $source = Invoke-SmokeNewShell '(Get-Command pds -CommandType Application | Select-Object -First 1).Source'
    $expected = Join-Path $InstallDir 'pds.exe'
    Assert-Smoke ($source.Trim() -eq $expected) "pds über PATH ist '$source', erwartet '$expected'"
    Write-SmokeOk "über PATH gefunden: $expected"

    # Der Dienst schreibt den Status kurz nach dem Start
    $report = Wait-Smoke {
        $json = Invoke-SmokeNewShell 'pds status --json'
        $parsed = $json | ConvertFrom-Json
        if ($null -ne $parsed.status) { $parsed }
    } 60 'status --json liefert einen Status'
    Write-Host ($report | ConvertTo-Json -Depth 8)
    Assert-Smoke ($report.status.state -eq 'unconfigured') "status.state ist '$($report.status.state)', erwartet 'unconfigured'"
    Assert-Smoke ($report.stale -eq $false) 'Status ist veraltet (Heartbeat älter als 30 s)'
    Write-SmokeOk 'Zustand unconfigured, Heartbeat frisch'

    # Die Angaben des SCM liest die CLI selbst (scm::query); hier gegen das Erwartete
    Assert-Smoke ($null -ne $report.service) 'status --json enthält keine Angaben des SCM'
    Assert-Smoke ($report.service.state -eq 'running') "service.state ist '$($report.service.state)'"
    Assert-Smoke ($report.service.startType -eq 'auto') "service.startType ist '$($report.service.startType)'"
    Assert-Smoke ($report.service.delayed -eq $true) 'service.delayed ist nicht true'
    Assert-Smoke ($report.service.account -eq $ServiceAccount) "service.account ist '$($report.service.account)'"
    Write-SmokeOk 'SCM-Angaben im Status stimmen'

    Assert-InstalledVersion $Version
    Assert-StatusVersion $report
}

# 4. ACL des Datenordners
function Test-DataDirAcl {
    Write-SmokeStep "4. ACL von $DataDir"
    $acl = Get-Acl -LiteralPath $DataDir
    Write-Host "    SDDL: $($acl.Sddl)"
    Assert-Smoke $acl.AreAccessRulesProtected 'Datenordner erbt Rechte (DACL nicht geschützt)'
    Write-SmokeOk 'geschützt (keine Vererbung)'

    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $forbidden = @{
        'S-1-5-32-545' = 'Users'
        'S-1-5-11'     = 'Authenticated Users'
        'S-1-1-0'      = 'Everyone'
    }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        Assert-Smoke (-not $forbidden.ContainsKey($sid)) "Datenordner hat einen Eintrag für $($forbidden[$sid])"
    }
    Write-SmokeOk 'kein Eintrag für Users, Authenticated Users, Everyone'

    $account = [System.Security.Principal.NTAccount]::new($ServiceAccount)
    $serviceSid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $serviceRules = @($rules | Where-Object { $_.IdentityReference.Value -eq $serviceSid })
    Assert-Smoke ($serviceRules.Count -gt 0) "Kein Eintrag für $ServiceAccount ($serviceSid)"
    Write-SmokeOk "Eintrag für $ServiceAccount vorhanden"
}

# 5. Firewall-Regel
function Test-FirewallRule {
    # Typografische Anführungszeichen beenden in PowerShell auch "…"-Strings, daher einfache Quotes
    Write-SmokeStep ('5. Firewall-Regel „' + $FirewallRuleName + '“')
    $rules = @(Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue)
    Assert-Smoke ($rules.Count -eq 1) "Erwartet genau eine Firewall-Regel, gefunden: $($rules.Count)"
    $rule = $rules[0]
    Assert-Smoke ("$($rule.Enabled)" -eq 'True') 'Regel ist nicht aktiv'
    Assert-Smoke ("$($rule.Direction)" -eq 'Inbound') "Richtung ist $($rule.Direction)"
    Assert-Smoke ("$($rule.Action)" -eq 'Allow') "Aktion ist $($rule.Action)"
    $ports = @(($rule | Get-NetFirewallPortFilter).LocalPort | ForEach-Object { "$_" } | Sort-Object)
    Assert-Smoke (($ports -join ',') -eq '443,80') "Ports sind '$($ports -join ',')', erwartet 80 und 443"
    Write-SmokeOk 'eingehend, erlaubt, TCP 80 und 443'
}

# 6. Ereignisquelle
function Test-EventSource {
    Write-SmokeStep "6. Ereignisquelle $EventSource"
    Assert-Smoke (Test-Path -LiteralPath $EventSourceKey) "Registry-Schlüssel fehlt: $EventSourceKey"
    $messageFile = Get-ItemPropertyValue -LiteralPath $EventSourceKey -Name 'EventMessageFile' -ErrorAction SilentlyContinue
    Assert-Smoke (-not [string]::IsNullOrEmpty($messageFile)) 'EventMessageFile fehlt'
    Write-SmokeOk "registriert (EventMessageFile $messageFile)"
    # Der Dienst meldet beim Start ohne Konfiguration eine Warnung
    $xpath = "*[System[Provider[@Name='$EventSource']]]"
    $events = Wait-Smoke { @(Get-WinEvent -LogName Application -FilterXPath $xpath -ErrorAction Stop) } 30 `
        'Einträge der Quelle im Anwendungsprotokoll'
    Write-SmokeOk "$(@($events).Count) Einträge im Anwendungsprotokoll"
}

# 7. App-Secret versiegelt
function Test-AppSecretSealed {
    Write-SmokeStep '7. config.toml'
    $config = Join-Path $DataDir 'config.toml'
    Assert-Smoke (Test-Path -LiteralPath $config -PathType Leaf) "config.toml fehlt: $config"
    $text = Get-Content -Raw -LiteralPath $config
    Assert-Smoke ($text.Contains('secret = "dpapi:')) 'config.toml enthält kein per DPAPI versiegeltes Secret (secret = "dpapi:…)'
    Assert-Smoke (-not $text.Contains('insecure:')) 'config.toml enthält ein insecure:-Secret'
    Write-SmokeOk 'App-Secret mit DPAPI versiegelt'
}

# 7b. Konfigurationsoberfläche und Werkzeuge: Dateien, Verknüpfung und das eingebettete Manifest. Den
# Start prüft 7c.
function Test-ConfigUi {
    Write-SmokeStep '7b. Konfigurationsoberfläche und Werkzeuge'
    Assert-Smoke (Test-Path -LiteralPath $ConfigExe -PathType Leaf) "Fehlt: $ConfigExe"
    $productVersion = (Get-Item -LiteralPath $ConfigExe).VersionInfo.ProductVersion
    Assert-Smoke ("$productVersion".StartsWith($Version)) "ProductVersion der Konfigurations-EXE ist '$productVersion', erwartet $Version"
    Write-SmokeOk "vorhanden: $ConfigExe (ProductVersion $productVersion)"
    foreach ($relative in 'tools\pds-tools.mjs', 'licenses\pds-tools-THIRD-PARTY.txt', 'node\node.exe', 'caddy.exe') {
        $path = Join-Path $InstallDir $relative
        Assert-Smoke (Test-Path -LiteralPath $path -PathType Leaf) "Fehlt: $path"
    }
    Write-SmokeOk 'tools\pds-tools.mjs und licenses\pds-tools-THIRD-PARTY.txt vorhanden'

    Assert-Smoke (Test-Path -LiteralPath $ConfigShortcut -PathType Leaf) "Startmenü-Verknüpfung fehlt: $ConfigShortcut"
    $shell = New-Object -ComObject WScript.Shell
    $target = $shell.CreateShortcut($ConfigShortcut).TargetPath
    Assert-Smoke ($target -eq $ConfigExe) "Verknüpfung zeigt auf '$target', erwartet '$ConfigExe'"
    Write-SmokeOk "Startmenü-Verknüpfung (alle Benutzer) zeigt auf $([System.IO.Path]::GetFileName($ConfigExe))"

    # Manifest-Ressource (RT_MANIFEST #1) mit mt.exe aus dem Windows SDK lesen; Kopie ohne Leerzeichen im Pfad
    $mt = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\mt.exe" -ErrorAction SilentlyContinue |
        Sort-Object { [version] $_.Directory.Parent.Name } -Descending | Select-Object -First 1
    Assert-Smoke ($null -ne $mt) 'mt.exe nicht gefunden (Windows SDK)'
    $work = Join-Path $LogDir 'manifest'
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $copy = Join-Path $work 'config.exe'
    Copy-Item -LiteralPath $ConfigExe -Destination $copy -Force
    $manifestFile = Join-Path $work 'pds-config.manifest'
    $result = Invoke-SmokeProcess -FilePath $mt.FullName -Arguments @('-nologo', "-inputresource:$copy;#1", "-out:$manifestFile") -TimeoutSeconds 60
    Remove-Item -LiteralPath $copy -Force
    Assert-Smoke ($result.ExitCode -eq 0) "mt.exe endete mit $($result.ExitCode): $($result.Stdout) $($result.Stderr)"
    $manifest = Get-Content -Raw -LiteralPath $manifestFile
    Write-Host $manifest
    Assert-Smoke ($manifest -match 'requestedExecutionLevel\s+level="requireAdministrator"') 'Manifest fordert keine Administratorrechte an (requireAdministrator)'
    Assert-Smoke ($manifest.Contains('Microsoft.Windows.Common-Controls')) 'Manifest ohne Common Controls v6'
    Write-SmokeOk 'Manifest: requireAdministrator, Common Controls v6'
}

# 7c. Die Konfigurationsoberfläche startet und zeigt ihr Hauptfenster. Der Runner ist erhöht, das
# Manifest (requireAdministrator) löst also keine UAC-Abfrage aus. Fehlt WebView2, zeigt die EXE statt
# des Fensters ein Meldungsfeld mit demselben Titel; das erkennt der Test am Fensterklassennamen.
function Test-ConfigUiStarts {
    Write-SmokeStep '7c. Konfigurationsoberfläche starten'
    $webView2 = Get-SmokeWebView2Version
    $webView2Text = if ($webView2) { "WebView2-Runtime $webView2" } else { 'keine WebView2-Runtime registriert' }
    Write-Host "    $webView2Text; Sitzung $((Get-Process -Id $PID).SessionId), interaktiv: $([Environment]::UserInteractive)"
    $hint = if ($webView2) { '' } else { ' – WebView2 fehlt auf dem Runner (das MSI hätte sie installieren sollen)' }
    $expectedTitle = 'EPLAN Panel Data Service ' + [char] 0x2013 + ' Konfiguration'

    $process = Start-Process -FilePath $ConfigExe -WorkingDirectory $InstallDir -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        $handle = [IntPtr]::Zero
        while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero -and -not [string]::IsNullOrEmpty($process.MainWindowTitle)) {
                $handle = $process.MainWindowHandle
                break
            }
            Start-Sleep -Milliseconds 500
        }
        if ($process.HasExited) {
            Assert-Smoke $false "Konfigurations-EXE endete vorzeitig mit Exit-Code $($process.ExitCode)$hint"
        }
        Assert-Smoke ($handle -ne [IntPtr]::Zero) "Kein Fenster der Konfigurations-EXE nach 60 s$hint"
        $title = $process.MainWindowTitle
        $class = Get-SmokeWindowClass $handle
        if ($class -eq '#32770') {
            $text = Get-SmokeMessageBoxText $handle
            Save-SmokeWindowScreenshot $handle (Join-Path $LogDir 'config-ui-fehler.png')
            Assert-Smoke $false "Statt des Hauptfensters zeigt die Konfigurations-EXE ein Meldungsfeld$($hint): $text"
        }
        Assert-Smoke ($title -eq $expectedTitle) "Fenstertitel ist '$title', erwartet '$expectedTitle'"
        Write-SmokeOk "Hauptfenster '$title' (Klasse $class) nach $([math]::Round(60 - ($deadline - [DateTime]::UtcNow).TotalSeconds, 1)) s"

        # WebView2 läuft wirklich: Der Browserprozess ist ein Kind der EXE
        $children = Wait-Smoke {
            @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$($process.Id)" |
                    Where-Object Name -eq 'msedgewebview2.exe')
        } 30 'WebView2-Prozess (msedgewebview2.exe) der Oberfläche'
        Write-SmokeOk "WebView2 läuft (msedgewebview2.exe, PID $(@($children)[0].ProcessId)); $webView2Text"
        Assert-Smoke (-not $process.HasExited) 'Konfigurations-EXE hat sich nach dem Öffnen beendet'
        # Etwas Zeit zum Zeichnen der Oberfläche, dann das Bild für das Artefakt smoke-logs
        Start-Sleep -Seconds 5
        Save-SmokeWindowScreenshot $handle (Join-Path $LogDir 'config-ui.png')
    }
    finally {
        if (-not $process.HasExited) {
            [void] $process.CloseMainWindow()
            if (-not $process.WaitForExit(10000)) {
                $process.Kill($true)
            }
        }
        $process.Dispose()
    }
    Write-SmokeOk 'Konfigurationsoberfläche wieder geschlossen'
}

# 7d. SQLite: Eine frische Konfiguration nutzt ohne weitere Angabe SQLite im Datenordner. Nur hier laufen
# node:sqlite und die Rechte des virtuellen Kontos auf data\ auf echtem Windows. Ohne Zertifikat
# (tls.mode off) auf einem eigenen Port; am Ende kommt die Konfiguration von vorher zurück.
function Test-SqliteDefault {
    Write-SmokeStep '7d. SQLite (Standard): Dienst mit data\pds.db'
    $work = Join-Path ([System.IO.Path]::GetTempPath()) "pds-smoke-sqlite-$PID"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $saved = Join-Path $work 'vorher.toml'
    Invoke-SmokeCli -Arguments @('config', 'export', $saved) -ExpectExit @(0) | Out-Null
    try {
        Test-SqliteRuntime $work
    }
    finally {
        # Konfiguration wie nach der Installation (App-Secret als *** bleibt), Dienst wieder unconfigured
        Invoke-SmokeCli -Arguments @('config', 'import', $saved) -ExpectExit @(0) | Out-Null
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    Invoke-SmokeCli -Arguments @('service', 'restart', '--wait', '--timeout', '60') -ExpectExit @(3) -TimeoutSeconds 300 | Out-Null
    $state = (Get-SmokeStatus).status.state
    Assert-Smoke ($state -eq 'unconfigured') "status.state ist nach dem Zurücksetzen '$state', erwartet 'unconfigured'"
    Write-SmokeOk 'Konfiguration von vorher wieder importiert, Dienst nicht eingerichtet'
}

function Test-SqliteRuntime([string] $Work) {
    $toml = Get-SmokeTomlValues (Read-SmokeTextShared (Join-Path $DataDir 'config.toml'))
    Assert-Smoke ($toml['db.kind'] -eq 'sqlite') "db.kind ist '$($toml['db.kind'])', erwartet 'sqlite' (Standard)"
    Assert-Smoke ($toml['db.path'] -eq '') "db.path ist '$($toml['db.path'])', erwartet leer (Standard)"
    Write-SmokeOk 'frische Konfiguration: db.kind sqlite, db.path leer'

    # Keine Datenbankangaben: SQLite braucht weder Server noch Passwort
    $settings = [ordered]@{
        'public.host'      = 'localhost'
        'tls.mode'         = 'off'
        'public.scheme'    = 'http'
        'public.port'      = "$SqliteHttpPort"
        'listen.http_port' = "$SqliteHttpPort"
        'oidc.tenant_id'   = $TenantId
        'oidc.client_id'   = $ClientId
    }
    foreach ($field in $settings.Keys) {
        Invoke-SmokeCli -Arguments @('config', 'set', $field, $settings[$field]) -ExpectExit @(0) | Out-Null
    }
    Invoke-SmokeCli -Arguments @('ports', 'check') -ExpectExit @(0) | Out-Null
    Invoke-SmokeCli -Arguments @('config', 'validate') -ExpectExit @(0) | Out-Null
    Write-SmokeOk "config validate ohne Fehler (tls.mode off, Port $SqliteHttpPort, ohne SQL Server)"

    # Der Dienst legt die Datei selbst an (nicht die CLI als Administrator): Das prüft die Rechte des Kontos
    $sqliteDir = Join-Path $DataDir 'data'
    $file = Join-Path $sqliteDir 'pds.db'
    Assert-Smoke (-not (Test-Path -LiteralPath $file)) "$file gibt es schon vor dem ersten Start"
    $started = [DateTime]::UtcNow
    Invoke-SmokeCli -Arguments @('service', 'restart', '--wait', '--timeout', '180') -ExpectExit @(0) -TimeoutSeconds 300 | Out-Null
    $seconds = [math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 1)
    Write-SmokeOk "Dienst läuft mit SQLite, Anwendung antwortet (erster Start mit Migrationen: $seconds s)"
    $body = Wait-SmokeHealthy "http://localhost:$SqliteHttpPort/api/health" 60
    Write-SmokeOk "Health über Caddy (http): $body"

    $report = Get-SmokeStatus
    Assert-Smoke ($report.status.state -eq 'running') "status.state ist '$($report.status.state)', erwartet 'running'"
    Assert-Smoke ($report.database -eq "SQLite: $file") "status.database ist '$($report.database)', erwartet 'SQLite: $file'"
    Write-SmokeOk "status: running, $($report.database)"

    # Die Datei hat der Dienst angelegt; WAL hält -wal und -shm daneben, solange die App sie offen hat
    foreach ($name in 'pds.db', 'pds.db-wal', 'pds.db-shm') {
        Assert-Smoke (Test-Path -LiteralPath (Join-Path $sqliteDir $name) -PathType Leaf) "$name fehlt in $sqliteDir"
    }
    Write-SmokeOk 'pds.db, pds.db-wal und pds.db-shm in data\'

    $test = Invoke-SmokeCli -Arguments @('db', 'test', '--json') -ExpectExit @(0)
    $result = $test.Stdout | ConvertFrom-Json
    Assert-Smoke ($result.ok -eq $true -and $result.code -eq 'ok') "db test: $($result.code) – $($result.message)"
    $migrations = @($result.steps | Where-Object { $_.code -eq 'migrations' })
    Assert-Smoke ($migrations.Count -eq 1) 'db test meldet keinen Schritt migrations'
    $counts = $migrations[0].details
    Assert-Smoke ([int] $counts.core -gt 0 -and [int] $counts.pds -gt 0) "Migrationen fehlen: core $($counts.core), pds $($counts.pds)"
    $writable = @($result.steps | Where-Object { $_.code -eq 'writable' })
    Assert-Smoke ($writable.Count -eq 1 -and $writable[0].ok -eq $true) 'db test: Datei nicht beschreibbar oder ohne WAL'
    Write-SmokeOk "db test: $($result.message) (Migrationen core $($counts.core), pds $($counts.pds))"

    Test-SqliteAcl $sqliteDir $file

    # Sicherung im laufenden Betrieb, danach wieder weg (die Kopie enthält Anwendungsdaten)
    $backup = Join-Path $Work 'pds-sicherung.db'
    $run = Invoke-SmokeCli -Arguments @('db', 'backup', $backup, '--json') -ExpectExit @(0) -TimeoutSeconds 300
    $result = $run.Stdout | ConvertFrom-Json
    Assert-Smoke ($result.ok -eq $true) "db backup: $($result.code) – $($result.message)"
    $size = (Get-Item -LiteralPath $backup).Length
    Assert-Smoke ($size -gt 0) 'Die Sicherung ist leer'
    Write-SmokeOk "db backup im laufenden Betrieb: $size Bytes, geprüft"
}

# Das Dienstkonto braucht Ändern auf dem Ordner (WAL legt -wal und -shm an), geerbt auf die Datei; sonst
# hat dort außer SYSTEM und Administratoren niemand Zugriff
function Test-SqliteAcl([string] $Dir, [string] $File) {
    $account = [System.Security.Principal.NTAccount]::new($ServiceAccount)
    $serviceSid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $modify = [System.Security.AccessControl.FileSystemRights]::Modify
    $forbidden = @{
        'S-1-5-32-545' = 'Users'
        'S-1-5-11'     = 'Authenticated Users'
        'S-1-1-0'      = 'Everyone'
    }
    $acl = Get-Acl -LiteralPath $Dir
    Write-Host "    SDDL data\: $($acl.Sddl)"
    Assert-Smoke $acl.AreAccessRulesProtected 'data\ erbt Rechte (DACL nicht geschützt)'
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        Assert-Smoke (-not $forbidden.ContainsKey($sid)) "data\ hat einen Eintrag für $($forbidden[$sid])"
    }
    $inherit = [System.Security.AccessControl.InheritanceFlags] 'ContainerInherit, ObjectInherit'
    $granted = @($rules | Where-Object {
            $_.IdentityReference.Value -eq $serviceSid -and "$($_.AccessControlType)" -eq 'Allow' -and
            ($_.FileSystemRights -band $modify) -eq $modify -and ($_.InheritanceFlags -band $inherit) -eq $inherit
        })
    Assert-Smoke ($granted.Count -gt 0) "data\ gibt $ServiceAccount ($serviceSid) kein vererbtes Ändern"
    Write-SmokeOk "data\ geschützt, $ServiceAccount mit Ändern (vererbt), kein Eintrag für Users, Authenticated Users, Everyone"

    $fileRules = @((Get-Acl -LiteralPath $File).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
            Where-Object { $_.IdentityReference.Value -eq $serviceSid -and ($_.FileSystemRights -band $modify) -eq $modify })
    Assert-Smoke ($fileRules.Count -gt 0) "pds.db gibt $ServiceAccount kein Ändern"
    Write-SmokeOk "pds.db: $ServiceAccount mit Ändern"
}

# 8. Deinstallation: ohne REMOVE_DATA bleiben die Daten, mit REMOVE_DATA=1 sind sie weg
function Test-UninstallKeepsData {
    Write-SmokeStep '8a. Deinstallation ohne REMOVE_DATA'
    Uninstall-Product $Msi 'uninstall.log'
    # Der SCM löscht den Dienst erst, wenn kein Handle mehr offen ist
    Wait-Smoke { -not (Test-SmokeServiceExists) } 60 "Dienst $ServiceName ist entfernt" | Out-Null
    Write-SmokeOk 'Dienst entfernt'
    $rules = @(Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue)
    Assert-Smoke ($rules.Count -eq 0) 'Firewall-Regel ist noch vorhanden'
    Write-SmokeOk 'Firewall-Regel entfernt'
    Assert-Smoke (-not (Test-Path -LiteralPath $EventSourceKey)) 'Ereignisquelle ist noch registriert'
    Write-SmokeOk 'Ereignisquelle entfernt'
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $entries = @($machinePath -split ';' | Where-Object { $_.TrimEnd('\') -eq $InstallDir })
    Assert-Smoke ($entries.Count -eq 0) 'Installationsordner steht noch im PATH'
    Write-SmokeOk 'PATH-Eintrag entfernt'
    Assert-Smoke (-not (Test-Path -LiteralPath $ConfigShortcut)) 'Startmenü-Verknüpfung ist noch vorhanden'
    Assert-Smoke (-not (Test-Path -LiteralPath $ConfigExe)) "Konfigurations-EXE ist noch vorhanden: $ConfigExe"
    Write-SmokeOk 'Konfigurations-EXE und Startmenü-Verknüpfung entfernt'
    # Typografische Anführungszeichen beenden in PowerShell auch "…"-Strings, daher einfache Quotes
    Assert-Smoke (@(Get-SmokeInstalledProducts).Count -eq 0) ($ProductName + ' steht noch in „Programme und Features“')
    Assert-Smoke (Test-Path -LiteralPath (Join-Path $DataDir 'config.toml') -PathType Leaf) 'Datenordner bzw. config.toml wurde gelöscht'
    Write-SmokeOk 'Datenordner mit config.toml bleibt'
}

# 8b. Nach Stufe 2 ist die echte Version installiert und konfiguriert; der Datenordner enthält jetzt
# auch Logs, Caddy-Ablage und Zertifikat
function Test-UninstallRemovesData {
    Write-SmokeStep '8b. Deinstallation mit REMOVE_DATA=1'
    Uninstall-Product $Msi 'uninstall-remove-data.log' @('REMOVE_DATA=1')
    Wait-Smoke { -not (Test-SmokeServiceExists) } 60 "Dienst $ServiceName ist entfernt" | Out-Null
    Assert-Smoke (-not (Test-Path -LiteralPath $DataDir)) "Datenordner ist noch vorhanden: $DataDir"
    Assert-Smoke (-not (Test-Path -LiteralPath $ConfigShortcut)) 'Startmenü-Verknüpfung ist noch vorhanden'
    Write-SmokeOk 'Dienst, Datenordner und Startmenü-Verknüpfung entfernt'
}

# --- Stufe 2 ------------------------------------------------------------------------------------------

# S1. SQL Server Express
function Install-SqlServer {
    Write-SmokeStep 'S1. SQL Server Express (choco), gemischte Anmeldung, TCP 1433'
    Install-SmokeSqlExpress -SaPassword $AdminPassword
}

# S2. Basisversion über die in 8a erhaltenen Daten installieren
function Test-BaselineInstall([string] $ConfigHash) {
    Write-SmokeStep "S2. Basisversion $BaselineVersion installieren (über die erhaltenen Daten)"
    $ended = Install-Product $BaselineMsi 'install-baseline.log'
    Wait-ServiceRunningAfterInstall $ended 'install-baseline.log' 'Start nach erneuter Installation'
    Assert-InstalledVersion $BaselineVersion
    $hash = Get-SmokeFileHash (Join-Path $DataDir 'config.toml')
    Assert-Smoke ($hash -eq $ConfigHash) 'config.toml hat sich durch Deinstallation und Neuinstallation geändert'
    Write-SmokeOk 'config.toml (samt App-Secret) unverändert übernommen'
}

# S3. Konfiguration über die CLI; Secrets nur über stdin
function Set-Configuration {
    Write-SmokeStep 'S3. Konfiguration über die CLI'
    $settings = [ordered]@{
        'public.host'                 = 'localhost'
        # Der Standardmodus: Zertifikat aus dem PFX unten
        'tls.mode'                    = 'certificate'
        # Ohne Angabe bliebe es beim Standard SQLite (7d), und die Stufe liefe gar nicht gegen SQL Server
        'db.kind'                     = 'sqlserver'
        'db.server'                   = '127.0.0.1'
        'db.port'                     = '1433'
        # SQL Server Express hat ein selbstsigniertes Zertifikat
        'db.trust_server_certificate' = 'true'
        'oidc.tenant_id'              = $TenantId
        'oidc.client_id'              = $ClientId
    }
    foreach ($field in $settings.Keys) {
        Invoke-SmokeCli -Arguments @('config', 'set', $field, $settings[$field]) -ExpectExit @(0) | Out-Null
    }
    Invoke-SmokeCli -Arguments @('config', 'set', 'oidc.client_secret', '--stdin') -Stdin $ClientSecret -ExpectExit @(0) | Out-Null
    Invoke-SmokeCli -Arguments @('config', 'set', 'db.password', '--stdin') -Stdin $DbPassword -ExpectExit @(0) | Out-Null
    Write-SmokeOk 'Felder gesetzt, Client-Secret und DB-Passwort über stdin'

    # Ports: Auf dem Runner hält http.sys Port 80 (Caddy: WSAEACCES, Lauf 44665165100). `ports check`
    # nennt belegte Ports samt Besitzer; nur bei http.sys weicht der Test auf 8080 bzw. 8443 aus, jeder
    # andere Besitzer ist ein Fehler.
    $check = Invoke-SmokeCli -Arguments @('ports', 'check', '--json') -ExpectExit @(0, 3)
    foreach ($entry in @(($check.Stdout | ConvertFrom-Json).ports)) {
        if ($entry.free -or $entry.ownedByService) {
            continue
        }
        $owner = "PID $($entry.ownerPid) $($entry.ownerName), http.sys: $($entry.httpSys)"
        Assert-Smoke ($entry.httpSys -eq $true) "Port $($entry.port) ($($entry.role)) ist belegt: $owner"
        switch ($entry.role) {
            'http' {
                Write-Host "    Port $($entry.port) ist belegt ($owner), weiche auf 8080 aus"
                Invoke-SmokeCli -Arguments @('config', 'set', 'listen.http_port', '8080') -ExpectExit @(0) | Out-Null
                $script:HttpPort = 8080
            }
            'public' {
                Write-Host "    Port $($entry.port) ist belegt ($owner), weiche auf 8443 aus"
                Invoke-SmokeCli -Arguments @('config', 'set', 'public.port', '8443') -ExpectExit @(0) | Out-Null
                $script:HealthUrl = 'https://localhost:8443/api/health'
            }
            default {
                Assert-Smoke $false "Port $($entry.port) ($($entry.role)) ist belegt: $owner"
            }
        }
    }
    Invoke-SmokeCli -Arguments @('ports', 'check') -ExpectExit @(0) | Out-Null
    Write-SmokeOk "Ports frei (HTTP $HttpPort, Health über $HealthUrl)"

    # PFX-Import mit Passwort über stdin; der Dienst läuft danach im Modus certificate mit diesem
    # Zertifikat. Geprüft wird auch, dass Passwort und Schlüssel nirgends im Klartext landen (S8).
    $work = Join-Path ([System.IO.Path]::GetTempPath()) "pds-smoke-pfx-$PID"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $pfxFile = Join-Path $work 'localhost.pfx'
    $cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation Cert:\LocalMachine\My `
        -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(30)
    try {
        $secure = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
        Export-PfxCertificate -Cert "Cert:\LocalMachine\My\$($cert.Thumbprint)" -FilePath $pfxFile -Password $secure | Out-Null
        # Nur der öffentliche Teil als vertrauenswürdige Stammzertifizierungsstelle: So traut die
        # öffentliche Health-Prüfung der CLI (SChannel, Speicher des Rechners) dem selbstsignierten Zertifikat
        $public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)
        $root = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
        $root.Open('ReadWrite')
        try {
            $root.Add($public)
            $script:RootThumbprint = $cert.Thumbprint
        }
        finally {
            $root.Close()
        }
    }
    finally {
        Remove-Item -LiteralPath "Cert:\LocalMachine\My\$($cert.Thumbprint)" -DeleteKey
    }
    Write-SmokeOk "Testzertifikat $($cert.Thumbprint) als vertrauenswürdig in LocalMachine\Root"
    try {
        Invoke-SmokeCli -Arguments @('tls', 'import', '--pfx', $pfxFile, '--password-stdin') -Stdin $PfxPassword -ExpectExit @(0) | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
    Write-SmokeOk "PFX importiert (Passwort über stdin, Fingerabdruck $($cert.Thumbprint))"

    Invoke-SmokeCli -Arguments @('config', 'validate') -ExpectExit @(0) | Out-Null
    $mode = (Get-SmokeTomlValues (Read-SmokeTextShared (Join-Path $DataDir 'config.toml')))['tls.mode']
    Assert-Smoke ($mode -eq 'certificate') "tls.mode ist '$mode', erwartet 'certificate'"
    Write-SmokeOk 'config validate ohne Fehler (tls.mode certificate)'
}

# Öffentliche Health über Caddy aus Sicht der CLI: TLS über SChannel mit dem Zertifikatspeicher des
# Rechners, so wie Clients der Firmen-PKI vertrauen. Wartet, bis status --json public.ok meldet.
function Assert-PublicProbe {
    $report = Wait-Smoke {
        $current = Get-SmokeStatus
        if ($null -ne $current.public -and $current.public.ok -eq $true) { $current }
        else {
            $message = if ($null -eq $current.public) { 'nicht geprüft' } else { $current.public.message }
            throw "public: $message (appUrl $($current.appUrl))"
        }
    } 60 'status --json meldet public.ok (Health über Caddy mit Zertifikat aus tls.mode certificate)'
    Write-SmokeOk "status.public: $($report.public.message) über $($report.appUrl) (SChannel vertraut dem Zertifikat)"
}

# S4. Datenbank einrichten (sa über stdin) und prüfen
function Test-Database {
    Write-SmokeStep 'S4. db setup und db test'
    $setup = Invoke-SmokeCli -Arguments @('db', 'setup', '--admin-user', 'sa', '--admin-password-stdin', '--json') `
        -Stdin $AdminPassword -ExpectExit @(0) -TimeoutSeconds 300
    $result = $setup.Stdout | ConvertFrom-Json
    Assert-Smoke ($result.ok -eq $true) "db setup: $($result.code) – $($result.message)"
    Write-SmokeOk "db setup: $($result.message)"

    $test = Invoke-SmokeCli -Arguments @('db', 'test', '--json') -ExpectExit @(0)
    $result = $test.Stdout | ConvertFrom-Json
    Assert-Smoke ($result.ok -eq $true -and $result.code -eq 'ok') "db test: $($result.code) – $($result.message)"
    Write-SmokeOk "db test: $($result.message)"
}

# S5. Dienst mit Konfiguration: läuft, Health über Caddy, Status
function Test-Running {
    Write-SmokeStep 'S5. service restart --wait, Health, Status'
    $started = [DateTime]::UtcNow
    Invoke-SmokeCli -Arguments @('service', 'restart', '--wait') -ExpectExit @(0) -TimeoutSeconds 300 | Out-Null
    $seconds = [math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 1)
    Write-SmokeOk "Dienst läuft, Anwendung antwortet (erster Start mit Migrationen: $seconds s)"

    $body = Wait-SmokeHealthy $HealthUrl 60
    Write-SmokeOk "curl -k ${HealthUrl}: $body"

    # Caddy leitet HTTP auf HTTPS um (automatic_https auf listen.http_port)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $redirect = Invoke-SmokeProcess -FilePath $curl -TimeoutSeconds 30 -Arguments @(
        '-s', '-o', 'NUL', '--max-time', '10', '-w', '%{http_code} %{redirect_url}', "http://localhost:$HttpPort/")
    $answer = $redirect.Stdout.Trim()
    Assert-Smoke ($redirect.ExitCode -eq 0 -and $answer -match '^3\d\d https://') `
        "http://localhost:$HttpPort/ leitet nicht auf HTTPS um: '$answer' (curl Exit $($redirect.ExitCode) $($redirect.Stderr))"
    Write-SmokeOk "http://localhost:$HttpPort/ ⇒ $answer"

    $report = Get-SmokeStatus
    Write-Host ($report.status | ConvertTo-Json -Depth 6)
    Assert-Smoke ($report.status.state -eq 'running') "status.state ist '$($report.status.state)', erwartet 'running'"
    Assert-Smoke ($null -ne $report.status.health -and $report.status.health.ok -eq $true) 'status.health.ok ist nicht true'
    Assert-Smoke ($report.stale -eq $false) 'Status ist veraltet'
    Assert-StatusVersion $report
    Assert-Smoke ($report.database -eq 'SQL Server: 127.0.0.1:1433, Datenbank pds') "status.database ist '$($report.database)'"
    Write-SmokeOk "status: running, health.ok, $($report.database)"
    Assert-PublicProbe

    # Platzhalter-Tenant: Entra antwortet mit einem Fehler; erwartet ist ein strukturiertes Ergebnis
    $oidc = Invoke-SmokeCli -Arguments @('oidc', 'test', '--json') -ExpectExit @(0, 3) -TimeoutSeconds 120
    $result = $oidc.Stdout | ConvertFrom-Json
    Assert-Smoke ($result.ok -is [bool] -and -not [string]::IsNullOrEmpty($result.code)) 'oidc test --json liefert kein Ergebnis mit ok und code'
    Write-SmokeOk "oidc test: ok=$($result.ok), code=$($result.code)"
}

# S6a. Datenbank nicht erreichbar: Backoff mit Meldung, gebremste Neustarts
function Test-DatabaseUnreachable {
    Write-SmokeStep 'S6a. Fehlkonfiguration db.port = 1'
    Invoke-SmokeCli -Arguments @('config', 'set', 'db.port', '1') -ExpectExit @(0) | Out-Null
    $restart = Invoke-SmokeCli -Arguments @('service', 'restart', '--wait', '--timeout', '30') -TimeoutSeconds 300
    Assert-Smoke ($restart.ExitCode -ne 0) 'service restart --wait meldet Erfolg trotz nicht erreichbarer Datenbank'
    Write-SmokeOk "service restart --wait endet mit $($restart.ExitCode)"

    $report = Wait-Smoke {
        $current = Get-SmokeStatus
        if ($current.status.state -eq 'backoff' -and $null -ne $current.status.lastError -and
            $current.status.lastError.message -match 'Datenbank nicht bereit') { $current }
    } 180 'status zeigt backoff mit „Datenbank nicht bereit“'
    Write-Host ($report.status | ConvertTo-Json -Depth 6)
    Write-SmokeOk "backoff: $($report.status.lastError.message)"

    $before = [int] $report.status.app.restarts
    Start-Sleep -Seconds 30
    $after = [int] (Get-SmokeStatus).status.app.restarts
    $starts = $after - $before
    Assert-Smoke ($starts -le 4) "In 30 s $starts App-Starts (app.restarts $before → $after), erlaubt höchstens 4"
    Write-SmokeOk "in 30 s $starts App-Starts (app.restarts $before → $after)"

    Invoke-SmokeCli -Arguments @('config', 'set', 'db.port', '1433') -ExpectExit @(0) | Out-Null
}

# S6b. Hostname leer: unconfigured mit Befund, keine App-Starts
function Test-Unconfigured {
    Write-SmokeStep 'S6b. Fehlkonfiguration public.host = ""'
    Invoke-SmokeCli -Arguments @('config', 'set', 'public.host', '') -ExpectExit @(0) | Out-Null
    # Vor dem Neustart zählen: app.restarts zählt nur Neustarts, nicht den ersten Start nach dem
    # Dienststart; die Markerzeilen in app.log zählen jeden Start (die Datei wird nie geleert)
    $startsBefore = Get-SmokeAppStarts
    $restart = Invoke-SmokeCli -Arguments @('service', 'restart', '--wait') -TimeoutSeconds 300
    Assert-Smoke ($restart.ExitCode -ne 0) 'service restart --wait meldet Erfolg ohne Hostname'

    $report = Get-SmokeStatus
    Write-Host ($report.status | ConvertTo-Json -Depth 6)
    Assert-Smoke ($report.status.state -eq 'unconfigured') "status.state ist '$($report.status.state)', erwartet 'unconfigured'"
    $hostFindings = @($report.status.findings | Where-Object { $_.field -eq 'public.host' })
    Assert-Smoke ($hostFindings.Count -gt 0) 'Kein Befund zu public.host'
    Write-SmokeOk "unconfigured, Befund public.host: $($hostFindings[0].code)"

    # Ein paar Sekunden beobachten: Der Dienst darf die App gar nicht erst starten
    Start-Sleep -Seconds 10
    $report = Get-SmokeStatus
    $startsAfter = Get-SmokeAppStarts
    Assert-Smoke ($report.status.state -eq 'unconfigured') "status.state wechselte zu '$($report.status.state)'"
    Assert-Smoke ($report.status.app.restarts -eq 0 -and $report.status.app.running -eq $false -and $null -eq $report.status.app.pid) `
        "App läuft oder wurde neu gestartet: $($report.status.app | ConvertTo-Json -Compress)"
    Assert-Smoke ($startsAfter -eq $startsBefore) "app.log meldet $($startsAfter - $startsBefore) App-Starts seit dem Neustart"
    Write-SmokeOk "0 App-Starts seit dem Neustart (app.log: $startsBefore Starts davor und danach)"

    Invoke-SmokeCli -Arguments @('config', 'set', 'public.host', 'localhost') -ExpectExit @(0) | Out-Null
    Invoke-SmokeCli -Arguments @('service', 'restart', '--wait') -ExpectExit @(0) -TimeoutSeconds 300 | Out-Null
    Wait-SmokeHealthy $HealthUrl 60 | Out-Null
    Write-SmokeOk 'zurückgesetzt, Dienst wieder gesund'
}

# S7. Upgrade auf die echte Version
function Test-Upgrade {
    Write-SmokeStep "S7. Upgrade $BaselineVersion → $Version"
    $config = Join-Path $DataDir 'config.toml'
    $before = Get-SmokeFileHash $config
    $ended = Install-Product $Msi 'upgrade.log'
    Wait-ServiceRunningAfterInstall $ended 'upgrade.log' 'Start nach dem Upgrade'
    Assert-InstalledVersion $Version
    $after = Get-SmokeFileHash $config
    Assert-Smoke ($after -eq $before) 'config.toml hat sich beim Upgrade geändert'
    Write-SmokeOk "config.toml unverändert (SHA-256 $after)"
    # Der Admin führt nur das MSI aus: Der Dienst muss danach ohne weiteren Befehl gesund werden
    $body = Wait-SmokeHealthy $HealthUrl 120
    Write-SmokeOk "direkt nach dem Upgrade gesund: $body"

    Invoke-SmokeCli -Arguments @('service', 'restart', '--wait') -ExpectExit @(0) -TimeoutSeconds 300 | Out-Null
    $body = Wait-SmokeHealthy $HealthUrl 60
    Write-SmokeOk "nach service restart --wait gesund: $body"
    Assert-StatusVersion (Get-SmokeStatus)
    Assert-PublicProbe
}

# S8. Kein Secret im Klartext (auch nicht URL-kodiert) an den Orten, die Admins und Werkzeuge sehen
function Test-NoSecretLeaks {
    Write-SmokeStep 'S8. Secret-Prüfung'
    # Alle gesetzten Secrets liegen per DPAPI versiegelt: config.toml ohne insecure:, die Secret-Felder
    # und die Schlüsseldatei des Zertifikats mit dpapi:
    $configText = Read-SmokeTextShared (Join-Path $DataDir 'config.toml')
    Assert-Smoke (-not $configText.Contains('insecure:')) 'config.toml enthält ein insecure:-Secret'
    $values = Get-SmokeTomlValues $configText
    foreach ($field in 'db.password', 'oidc.client_secret', 'app.secret') {
        $value = if ($values.Contains($field)) { $values[$field] } else { '' }
        # Nur das Schema nennen, nie den Wert: Wäre er Klartext, stünde er sonst im Log
        $scheme = if ($value -match '^([a-z]+):') { $Matches[1] } elseif ($value -eq '') { 'leer' } else { 'ohne Schema' }
        Assert-Smoke ($value -match '^dpapi:[A-Za-z0-9+/=]{16,}$') "$field ist nicht per DPAPI versiegelt ($scheme)"
    }
    $keyText = (Read-SmokeTextShared (Join-Path $DataDir 'tls\key.dpapi')).Trim()
    Assert-Smoke ($keyText -match '^dpapi:[A-Za-z0-9+/=]{16,}$') 'tls\key.dpapi ist nicht per DPAPI versiegelt'
    Write-SmokeOk 'db.password, oidc.client_secret, app.secret und tls\key.dpapi mit dpapi:, kein insecure:'

    $dataFiles = @(Get-ChildItem -LiteralPath $DataDir -Recurse -File -Force | ForEach-Object FullName)
    $msiLogs = @($MsiLogs | Where-Object { Test-Path -LiteralPath $_ })
    $texts = [ordered]@{}
    $snapshot = @(Get-CimInstance -ClassName Win32_Process)
    foreach ($process in $snapshot) {
        if ($process.CommandLine) {
            $texts["Befehlszeile $($process.Name) (PID $($process.ProcessId))"] = $process.CommandLine
        }
    }
    $processCount = $texts.Count
    # Die Suche in Befehlszeilen zählt nur, wenn die Kinder des Dienstes darin vorkommen
    foreach ($child in (Join-Path $InstallDir 'node\node.exe'), (Join-Path $InstallDir 'caddy.exe')) {
        $found = @($snapshot | Where-Object { $_.ExecutablePath -eq $child -and -not [string]::IsNullOrEmpty($_.CommandLine) })
        Assert-Smoke ($found.Count -gt 0) "Kein Prozess $child mit lesbarer Befehlszeile im Prozess-Schnappschuss"
        Write-Host "    Befehlszeile (PID $($found[0].ProcessId)): $($found[0].CommandLine)"
    }
    $xpath = "*[System[Provider[@Name='$EventSource']]]"
    $events = @(Get-WinEvent -LogName Application -FilterXPath $xpath -ErrorAction SilentlyContinue)
    foreach ($entry in $events) {
        $properties = ($entry.Properties | ForEach-Object { "$($_.Value)" }) -join "`n"
        $texts["Ereignis $($entry.RecordId) (Id $($entry.Id))"] = "$($entry.Message)`n$properties"
    }
    $texts['CLI-Ausgaben dieses Laufs'] = $CliTranscript.ToString()

    $hits = @(Find-SmokeSecrets -Markers $Markers -Files ($dataFiles + $msiLogs) -Texts $texts)
    Write-Host "    durchsucht: $($dataFiles.Count) Dateien im Datenordner, $($msiLogs.Count) MSI-Logs, $processCount Befehlszeilen, $($events.Count) Ereignisse, CLI-Ausgaben"
    Assert-Smoke ($hits.Count -eq 0) "Secrets gefunden:`n  $($hits -join "`n  ")"
    Write-SmokeOk "keiner der $($Markers.Count) Marker gefunden (DB-Passwort auch URL-kodiert und als T-SQL-Literal)"
}

# S9. Neustart des Dienstes über den SCM (Ersatz für den Neustart des Rechners), mit Zeitmessung zum
# Vergleich mit dem ersten Start
function Test-RestartService {
    Write-SmokeStep 'S9. Stop-Service, Start-Service'
    Stop-Service -Name $ServiceName
    $since = [DateTime]::UtcNow
    Start-Service -Name $ServiceName
    $running = [DateTime]::UtcNow
    Write-SmokeOk "Start-Service kehrt nach $([math]::Round(($running - $since).TotalSeconds, 1)) s zurück (Dienst läuft)"
    Show-SmokeStartTiming -Since $since -Running $running -Label 'Start-Service'
    $body = Wait-SmokeHealthy $HealthUrl 120
    $report = Wait-Smoke {
        $current = Get-SmokeStatus
        if ($current.status.state -eq 'running' -and $current.stale -eq $false) { $current }
    } 60 'status running nach Restart-Service'
    Write-SmokeOk "wieder gesund: $body (status $($report.status.state))"
}

function Invoke-Stage2([string] $ConfigHash) {
    Install-SqlServer
    Test-BaselineInstall $ConfigHash
    Set-Configuration
    Test-Database
    Test-Running
    Test-DatabaseUnreachable
    Test-Unconfigured
    Test-Upgrade
    Test-NoSecretLeaks
    Test-RestartService
}

# --- Ablauf -------------------------------------------------------------------------------------------

try {
    Test-Install
    Test-Service
    Test-ServiceRecovery
    Test-StatusUnconfigured
    Test-DataDirAcl
    Test-FirewallRule
    Test-EventSource
    Test-AppSecretSealed
    Test-ConfigUi
    Test-ConfigUiStarts
    # Vor SQL Server Express: der Standard einer frischen Konfiguration
    Test-SqliteDefault
    # Vor dem Deinstallieren sichern, danach sind Logs und Status weg
    Save-SmokeDiagnostics -LogDir $LogDir -Label 'installiert'
    $configHash = Get-SmokeFileHash (Join-Path $DataDir 'config.toml')
    Test-UninstallKeepsData
    Write-Host ''
    Write-Host 'Smoke-Test Stufe 1 bestanden'

    Invoke-Stage2 $configHash
    Save-SmokeDiagnostics -LogDir $LogDir -Label 'stufe2'
    Test-UninstallRemovesData
}
catch {
    Save-SmokeDiagnostics -LogDir $LogDir -Label 'fehler'
    Write-Host "::error title=Smoke-Test::$($_.Exception.Message -replace "`r?`n", '%0A')"
    Write-Host $_.ScriptStackTrace
    exit 1
}
finally {
    # Das Testzertifikat darf dem Rechner nicht als Stammzertifizierungsstelle bleiben
    if ($RootThumbprint) {
        Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$RootThumbprint" -ErrorAction SilentlyContinue
        $left = @(Get-ChildItem -LiteralPath Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $RootThumbprint)
        if ($left.Count -gt 0) {
            Write-Host "::warning title=Smoke-Test::Testzertifikat $RootThumbprint ist noch in LocalMachine\Root"
        }
        else {
            Write-Host "Testzertifikat $RootThumbprint aus LocalMachine\Root entfernt"
        }
    }
}

Write-Host ''
Write-Host 'Smoke-Test Stufe 1 und 2 bestanden'
# Sonst gälte der Exit-Code des letzten sc.exe (1060 für den entfernten Dienst) als Ergebnis
exit 0
