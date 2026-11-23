#Requires -Version 7.2
<#
.SYNOPSIS
  Hilfsfunktionen für smoke.ps1 (per Dot-Sourcing geladen).

.DESCRIPTION
  Namen und Pfade stehen hier ein zweites Mal (neben names.rs bzw. Package.wxs): Der Smoke-Test prüft
  das installierte Produkt von außen und soll nicht dieselbe Quelle benutzen, die er prüft.

  Save-SmokeDiagnostics ist auch allein nutzbar (CI-Schritt mit `if: always()`):
    . windows/scripts/smoke-lib.ps1; Save-SmokeDiagnostics -LogDir <ordner> -Label ende
#>

Set-StrictMode -Version Latest

$script:ServiceName = 'pds'
$script:ServiceDisplayName = 'EPLAN Panel Data Service'
$script:ServiceAccount = 'NT SERVICE\pds'
$script:EventSource = 'pds'
$script:FirewallRuleName = 'EPLAN Panel Data Service (HTTP/HTTPS)'
$script:ProductName = 'EPLAN Panel Data Service'
$script:DataDir = Join-Path $env:ProgramData 'EPLAN Panel Data Service'
$script:InstallDir = Join-Path $env:ProgramFiles 'EPLAN Panel Data Service'
$script:Cli = Join-Path $script:InstallDir 'pds.exe'
$script:ConfigExe = Join-Path $script:InstallDir 'pds-config.exe'
# Startmenü für alle Benutzer; einfache Quotes wegen des Gedankenstrichs
$script:ConfigShortcut = Join-Path $env:ProgramData ('Microsoft\Windows\Start Menu\Programs\' + 'EPLAN Panel Data Service – Konfiguration.lnk')
$script:EventSourceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\$script:EventSource"
$script:ServiceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$script:ServiceName"
# Alle Ausgaben der CLI dieses Laufs; die Secret-Prüfung durchsucht sie mit
$script:CliTranscript = [System.Text.StringBuilder]::new()

function Write-SmokeStep([string] $Title) {
    Write-Host ''
    Write-Host "==> $Title"
}

function Write-SmokeOk([string] $Message) {
    Write-Host "    ok: $Message"
}

# Abbruch mit klarer Meldung; smoke.ps1 fängt sie ab und meldet sie als Fehler des Schritts
function Assert-Smoke([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw "PRÜFUNG FEHLGESCHLAGEN: $Message"
    }
}

# Wartet, bis $Condition einen wahren Wert liefert, und gibt ihn zurück. Ausnahmen im Block zählen als
# „noch nicht“; nach Ablauf bricht der Test mit $Description und dem letzten Fehler ab.
function Wait-Smoke([scriptblock] $Condition, [int] $TimeoutSeconds, [string] $Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ($true) {
        try {
            $result = & $Condition
            if ($result) {
                return $result
            }
        }
        catch {
            $lastError = $_.Exception.Message
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            $detail = if ($lastError) { " (zuletzt: $lastError)" } else { '' }
            throw "PRÜFUNG FEHLGESCHLAGEN: Zeitüberschreitung nach $TimeoutSeconds s: $Description$detail"
        }
        Start-Sleep -Seconds 1
    }
}

# Zeigt den Teil des MSI-Logs, der einen Fehlschlag erklärt (vor dem ersten „Return value 3“), damit
# die Ursache schon im Job-Log steht und nicht erst im Artefakt
function Show-MsiLogFailure([string] $Log) {
    if (-not (Test-Path -LiteralPath $Log)) {
        Write-Host "    (kein MSI-Log unter $Log)"
        return
    }
    $lines = @(Get-Content -LiteralPath $Log)
    if ($lines.Count -eq 0) {
        Write-Host "    (MSI-Log $Log ist leer)"
        return
    }
    $failure = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match 'Return value 3') {
            $failure = $i
            break
        }
    }
    $from = if ($failure -ge 0) { [Math]::Max(0, $failure - 80) } else { [Math]::Max(0, $lines.Count - 80) }
    $to = if ($failure -ge 0) { [Math]::Min($lines.Count - 1, $failure + 5) } else { $lines.Count - 1 }
    Write-Host "---- Auszug aus $([System.IO.Path]::GetFileName($Log)) (Zeilen $($from + 1)–$($to + 1)) ----"
    $lines[$from..$to] | ForEach-Object { Write-Host $_ }
    Write-Host '---- Ende des Auszugs ----'
}

# Startet msiexec mit /qn und ausführlichem Log und liefert den Exit-Code. 1618 (eine andere
# Installation läuft, auf frischen Runnern z. B. ein Update) wird ein paar Mal abgewartet.
function Invoke-SmokeMsiexec([string[]] $Arguments, [string] $Log) {
    $all = @($Arguments) + @('/qn', '/l*v', $Log)
    for ($attempt = 1; ; $attempt++) {
        $info = [System.Diagnostics.ProcessStartInfo]::new('msiexec.exe')
        foreach ($argument in $all) {
            $info.ArgumentList.Add($argument)
        }
        $info.UseShellExecute = $false
        Write-Host "    msiexec $($all -join ' ')"
        $process = [System.Diagnostics.Process]::Start($info)
        $process.WaitForExit()
        $code = $process.ExitCode
        if ($code -ne 1618 -or $attempt -ge 10) {
            return $code
        }
        Write-Host '    Eine andere Installation läuft (1618), neuer Versuch in 30 s'
        Start-Sleep -Seconds 30
    }
}

# Führt einen Befehl in einer neuen pwsh aus, deren PATH wie in einer frisch geöffneten Konsole aus
# der Registry kommt (Maschine + Benutzer). Der geerbte PATH des Runners kennt den Eintrag des MSI nicht.
function Invoke-SmokeNewShell([string] $Command) {
    $freshPath = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')
    ) | Where-Object { $_ }
    $saved = $env:Path
    try {
        $env:Path = $freshPath -join ';'
        $pwsh = (Get-Process -Id $PID).Path
        $output = @(& $pwsh -NoLogo -NoProfile -NonInteractive -Command $Command 2>&1)
        $code = $LASTEXITCODE
    }
    finally {
        $env:Path = $saved
    }
    # stderr kommt als ErrorRecord; nur stdout zurückgeben (JSON), stderr nur in der Fehlermeldung
    $stdout = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } |
            ForEach-Object { "$_" }) -join "`n"
    $stderr = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
            ForEach-Object { "$_" }) -join "`n"
    Assert-Smoke ($code -eq 0) "Befehl in neuer Shell endete mit Exit-Code ${code}: $Command`n$stdout`n$stderr"
    return $stdout
}

# Startet ein Programm mit Argumentliste (auch leere Argumente kommen an) und optional einer Zeile auf
# stdin. Liefert ExitCode, Stdout und Stderr. stdin geht als UTF-8 ohne BOM, sonst stünde ein BOM vor
# dem Secret.
function Invoke-SmokeProcess([string] $FilePath, [string[]] $Arguments = @(), [string] $Stdin = $null,
    [int] $TimeoutSeconds = 600) {
    $info = [System.Diagnostics.ProcessStartInfo]::new($FilePath)
    foreach ($argument in $Arguments) {
        $info.ArgumentList.Add($argument)
    }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        try {
            # [string]-Parameter machen aus $null einen Leerstring; leer heißt: nichts auf stdin
            if (-not [string]::IsNullOrEmpty($Stdin)) {
                $process.StandardInput.Write($Stdin + "`n")
            }
            $process.StandardInput.Close()
        }
        catch [System.IO.IOException] {
            # Das Programm hat schon geendet, ohne stdin zu lesen (z. B. Bedienfehler); zählt der Exit-Code
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw "PRÜFUNG FEHLGESCHLAGEN: $([System.IO.Path]::GetFileName($FilePath)) $($Arguments -join ' ') lief länger als $TimeoutSeconds s"
        }
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout   = $stdout.GetAwaiter().GetResult()
            Stderr   = $stderr.GetAwaiter().GetResult()
        }
    }
    finally {
        $process.Dispose()
    }
}

# Ruft die installierte CLI auf und schreibt Befehl und Ausgabe ins Log. Werte auf stdin (Secrets)
# erscheinen nie im Log. Mit -ExpectExit wird der Exit-Code geprüft.
function Invoke-SmokeCli([string[]] $Arguments, [string] $Stdin = $null, [int[]] $ExpectExit = @(),
    [int] $TimeoutSeconds = 600, [switch] $Quiet) {
    $shown = ($Arguments | ForEach-Object { if ($_ -eq '') { '""' } else { $_ } }) -join ' '
    $suffix = if (-not [string]::IsNullOrEmpty($Stdin)) { ' (Wert auf stdin)' } else { '' }
    Write-Host "    > pds $shown$suffix"
    $result = Invoke-SmokeProcess -FilePath $script:Cli -Arguments $Arguments -Stdin $Stdin -TimeoutSeconds $TimeoutSeconds
    [void] $script:CliTranscript.AppendLine($result.Stdout).AppendLine($result.Stderr)
    if (-not $Quiet) {
        foreach ($text in @($result.Stdout, $result.Stderr)) {
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                $text.TrimEnd() -split "`r?`n" | ForEach-Object { Write-Host "      $_" }
            }
        }
        Write-Host "      (Exit-Code $($result.ExitCode))"
    }
    if ($ExpectExit.Count -gt 0) {
        Assert-Smoke ($ExpectExit -contains $result.ExitCode) `
            "pds $shown endete mit $($result.ExitCode), erwartet $($ExpectExit -join ' oder ')`n$($result.Stdout)`n$($result.Stderr)"
    }
    return $result
}

# `status --json` der installierten CLI als Objekt
function Get-SmokeStatus {
    $result = Invoke-SmokeCli -Arguments @('status', '--json') -ExpectExit @(0) -Quiet
    return $result.Stdout | ConvertFrom-Json
}

# Health über Caddy (öffentliche Adresse). curl.exe aus System32 (SChannel); -k, weil die interne CA
# nicht im Vertrauensspeicher liegt (install_trust = false)
function Get-SmokeHealth([string] $Url = 'https://localhost/api/health') {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $result = Invoke-SmokeProcess -FilePath $curl -Arguments @('-k', '--ssl-no-revoke', '-sS', '--max-time', '10', $Url) -TimeoutSeconds 30
    return [pscustomobject]@{ ExitCode = $result.ExitCode; Body = $result.Stdout.Trim(); Error = $result.Stderr.Trim() }
}

# Wartet, bis die Health-Prüfung über Caddy {"status":"ok"} liefert, und gibt den Text zurück
function Wait-SmokeHealthy([string] $Url, [int] $TimeoutSeconds = 90) {
    $body = Wait-Smoke {
        $health = Get-SmokeHealth $Url
        if ($health.ExitCode -eq 0 -and $health.Body -eq '{"status":"ok"}') { $health.Body }
        else { throw "curl Exit $($health.ExitCode): $($health.Body) $($health.Error)" }
    } $TimeoutSeconds "$Url liefert {`"status`":`"ok`"}"
    return $body
}

# Version aus dem Dateinamen pds-<X.Y.Z>-x64.msi (so benennt build-msi.ps1)
function Get-SmokeMsiVersion([string] $Path) {
    $name = [System.IO.Path]::GetFileName($Path)
    if ($name -notmatch '^pds-(\d+\.\d+\.\d+)-x64\.msi$') {
        throw "MSI-Name ohne Version: $name"
    }
    return $Matches[1]
}

# Installierte Produkte laut „Programme und Features“ (64-Bit-Uninstall-Schlüssel)
function Get-SmokeInstalledProducts {
    $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    return @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $script:ProductName })
}

# Einfache Werte aus config.toml als 'abschnitt.feld' => Wert (nur Zeichenketten in "…", wie sie
# der Dienst schreibt; reicht für die Prüfung der Secret-Felder)
function Get-SmokeTomlValues([string] $Text) {
    $values = [ordered]@{}
    $section = ''
    foreach ($line in $Text -split "`r?`n") {
        if ($line -match '^\s*\[([A-Za-z0-9_.]+)\]\s*$') {
            $section = $Matches[1]
        }
        elseif ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$') {
            $values["$section.$($Matches[1])"] = $Matches[2]
        }
    }
    return $values
}

# SHA-256 einer Datei (für „Konfiguration unverändert“)
function Get-SmokeFileHash([string] $Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

# Zählt die Starts der App laut app.log (Markerzeile des Supervisors je Start)
function Get-SmokeAppStarts {
    $log = Join-Path $script:DataDir 'logs\app.log'
    if (-not (Test-Path -LiteralPath $log)) {
        return 0
    }
    $text = Read-SmokeTextShared $log
    return ([regex]::Matches($text, 'Prozess gestartet')).Count
}

# Liest eine Datei, auch wenn der Dienst sie gerade zum Schreiben offen hat
function Read-SmokeBytesShared([string] $Path) {
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
        $buffer = [System.IO.MemoryStream]::new()
        $stream.CopyTo($buffer)
        return $buffer.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Read-SmokeTextShared([string] $Path) {
    return [System.Text.Encoding]::UTF8.GetString((Read-SmokeBytesShared $Path))
}

# SQL Server Express für Stufe 2: gemischte Anmeldung (sa mit Testpasswort), TCP fest auf 1433.
# Das choco-Paket installiert die benannte Instanz SQLEXPRESS (Windows-Anmeldung, der ausführende
# Admin wird sysadmin) mit dynamischem Port. Das sa-Passwort geht bewusst nicht über choco:
# Installationsargumente stehen in chocolatey.log, --install-arguments-sensitive gibt es nur in
# lizenzierten Ausgaben. Gemischter Modus und Port kommen danach über die Registry, das sa-Passwort per
# T-SQL über eine Windows-Anmeldung (Skript auf stdin, nicht in der Befehlszeile).
function Install-SmokeSqlExpress([string] $SaPassword) {
    $choco = (Get-Command choco.exe -CommandType Application | Select-Object -First 1).Source
    $arguments = @('install', 'sql-server-express', '--yes', '--no-progress', '--limit-output',
        '--install-arguments=/TCPENABLED=1')
    $instances = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
    $started = [DateTime]::UtcNow
    # choco endet auch mit 0, wenn der Feed nicht antwortet („installed 0/0 packages“, z. B. bei 503):
    # Erfolg zeigt erst die registrierte Instanz. Bei Fehlschlag einige Male mit Pause neu versuchen.
    for ($attempt = 1; ; $attempt++) {
        Write-Host "    choco install sql-server-express (TCP), Versuch $attempt"
        $result = Invoke-SmokeProcess -FilePath $choco -Arguments $arguments -TimeoutSeconds 1800
        ($result.Stdout + $result.Stderr) -split "`r?`n" | Where-Object { $_ } |
            Select-Object -Last 25 | ForEach-Object { Write-Host "      $_" }
        $installed = (Test-Path -LiteralPath $instances) -and
            ($null -ne (Get-ItemProperty -LiteralPath $instances -Name 'SQLEXPRESS' -ErrorAction SilentlyContinue))
        if ($installed) {
            break
        }
        Show-SmokeSqlSetupSummary
        Assert-Smoke ($attempt -lt 4) "SQL Server Express ist nach $attempt Versuchen nicht installiert (choco Exit $($result.ExitCode))"
        Write-Host "    Instanz SQLEXPRESS fehlt (choco Exit $($result.ExitCode)), neuer Versuch in $($attempt * 30) s"
        Start-Sleep -Seconds ($attempt * 30)
    }
    $minutes = [math]::Round(([DateTime]::UtcNow - $started).TotalMinutes, 1)
    Write-SmokeOk "SQL Server Express installiert ($minutes min, choco Exit $($result.ExitCode))"

    $instance = Get-ItemPropertyValue -LiteralPath $instances -Name 'SQLEXPRESS'
    $server = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$instance\MSSQLServer"
    # 2 = gemischte Anmeldung (Windows und SQL Server)
    Set-ItemProperty -LiteralPath $server -Name 'LoginMode' -Value 2
    Set-ItemProperty -LiteralPath "$server\SuperSocketNetLib\Tcp" -Name 'Enabled' -Value 1
    Set-ItemProperty -LiteralPath "$server\SuperSocketNetLib\Tcp\IPAll" -Name 'TcpDynamicPorts' -Value ''
    Set-ItemProperty -LiteralPath "$server\SuperSocketNetLib\Tcp\IPAll" -Name 'TcpPort' -Value '1433'
    Restart-Service -Name 'MSSQL$SQLEXPRESS' -Force
    Wait-Smoke {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $client.Connect('127.0.0.1', 1433)
            $true
        }
        finally {
            $client.Dispose()
        }
    } 120 'SQL Server nimmt Verbindungen auf 127.0.0.1:1433 an' | Out-Null

    # sa freischalten (Windows PowerShell 5.1 hat System.Data.SqlClient). Das Skript samt Passwort kommt
    # über stdin; Erfolg zeigen die Zeilen sa-gesetzt und sa-anmeldung (Anmeldung als sa mit Passwort).
    $literal = $SaPassword.Replace("'", "''")
    $lines = @(
        '$ErrorActionPreference = "Stop"'
        '$c = New-Object System.Data.SqlClient.SqlConnection "Server=127.0.0.1,1433;Database=master;Integrated Security=True;Encrypt=False"'
        '$c.Open(); $q = $c.CreateCommand()'
        ('$q.CommandText = "ALTER LOGIN [sa] WITH PASSWORD = N''' + $literal + '''; ALTER LOGIN [sa] ENABLE;"')
        '[void] $q.ExecuteNonQuery(); $c.Close(); "sa-gesetzt"'
        ('$c = New-Object System.Data.SqlClient.SqlConnection "Server=127.0.0.1,1433;Database=master;User ID=sa;Password=' + $SaPassword + ';Encrypt=False"')
        '$c.Open(); $c.Close(); "sa-anmeldung"'
    )
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sa = Invoke-SmokeProcess -FilePath $powershell -Arguments @('-NoProfile', '-NonInteractive', '-Command', '-') `
        -Stdin (($lines -join "`n") + "`n") -TimeoutSeconds 120
    $sa.Stderr -split "`r?`n" | Where-Object { $_ -and -not $_.Contains($SaPassword) } | ForEach-Object { Write-Host "      $_" }
    Assert-Smoke ($sa.Stdout -match 'sa-gesetzt' -and $sa.Stdout -match 'sa-anmeldung') 'sa ließ sich nicht freischalten (siehe stderr oben)'
    $loginMode = Get-ItemPropertyValue -LiteralPath $server -Name 'LoginMode'
    Assert-Smoke ($loginMode -eq 2) "LoginMode ist $loginMode, erwartet 2 (gemischt)"
    if ($env:ChocolateyInstall) {
        $chocoLog = Join-Path $env:ChocolateyInstall 'logs\chocolatey.log'
        if (Test-Path -LiteralPath $chocoLog) {
            Assert-Smoke (-not (Read-SmokeTextShared $chocoLog).Contains($SaPassword)) 'Das sa-Passwort steht in chocolatey.log'
        }
    }
    Write-SmokeOk "Instanz $instance, gemischte Anmeldung, sa aktiv (Passwort nicht über choco), TCP 1433 statisch"
}

# Zeigt das Ende der letzten SQL-Setup-Zusammenfassung (Summary.txt), wenn die Installation scheitert
function Show-SmokeSqlSetupSummary {
    $summary = Get-ChildItem -Path "$env:ProgramFiles\Microsoft SQL Server\*\Setup Bootstrap\Log\Summary.txt" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($summary) {
        Write-Host "    ---- $($summary.FullName) (Ende) ----"
        Get-Content -LiteralPath $summary.FullName -Tail 40 | ForEach-Object { Write-Host "      $_" }
    }
}

# Sucht Secrets: in Dateien binär (UTF-8 und UTF-16LE), in Texten wörtlich. $Markers bildet einen
# Namen auf alle Formen ab, in denen der Wert vorkommen könnte. Liefert die Fundstellen mit dem
# Namen des Markers, nie den Wert.
function Find-SmokeSecrets([System.Collections.IDictionary] $Markers, [string[]] $Files = @(),
    [System.Collections.IDictionary] $Texts = @{}) {
    $latin1 = [System.Text.Encoding]::Latin1
    $needles = [System.Collections.Generic.List[object]]::new()
    foreach ($name in $Markers.Keys) {
        $index = 0
        foreach ($form in $Markers[$name]) {
            $index++
            foreach ($encoding in @([System.Text.Encoding]::UTF8, [System.Text.Encoding]::Unicode)) {
                # Latin1 bildet jedes Byte auf genau ein Zeichen ab: Suche in Zeichen = Suche in Bytes
                $needles.Add([pscustomobject]@{
                        Label    = "$name (Form $index, $($encoding.WebName))"
                        Bytes    = $latin1.GetString($encoding.GetBytes($form))
                        Text     = $form
                        Encoding = $encoding.WebName
                    })
            }
        }
    }
    $hits = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $Files) {
        try {
            $content = $latin1.GetString((Read-SmokeBytesShared $file))
        }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
            # Zwischendateien (z. B. status.json beim atomaren Ersetzen) verschwinden während der Suche
            continue
        }
        catch {
            # Nicht lesbar heißt nicht geprüft: zählt als Fehlschlag
            $hits.Add("$file nicht lesbar: $($_.Exception.Message)")
            continue
        }
        foreach ($needle in $needles) {
            if ($content.IndexOf($needle.Bytes, [System.StringComparison]::Ordinal) -ge 0) {
                $hits.Add("${file}: $($needle.Label)")
            }
        }
    }
    foreach ($label in $Texts.Keys) {
        $text = [string] $Texts[$label]
        # Texte sind schon Zeichen: jede Form nur einmal
        foreach ($needle in @($needles | Where-Object Encoding -eq 'utf-8')) {
            if ($text.IndexOf($needle.Text, [System.StringComparison]::Ordinal) -ge 0) {
                $hits.Add("${label}: $($needle.Label)")
            }
        }
    }
    return @($hits | Select-Object -Unique)
}

# Zeitpunkt, zu dem msiexec laut MSI-Log den Start des Dienstes beim SCM angefordert hat
# (ServiceControl … Action=1, Zeit lokal), als UTC; $null, wenn nicht im Log
function Get-SmokeMsiStartRequest([string] $Log) {
    if (-not (Test-Path -LiteralPath $Log)) {
        return $null
    }
    $line = Get-Content -LiteralPath $Log | Where-Object {
        $_ -match "Executing op: ServiceControl\(.*Name=$([regex]::Escape($script:ServiceName)),Action=1(\D|$)"
    } | Select-Object -First 1
    if (-not $line -or $line -notmatch '\[(\d{2}):(\d{2}):(\d{2}):(\d{3})\]') {
        return $null
    }
    $local = (Get-Item -LiteralPath $Log).LastWriteTime.Date.Add(
        [timespan]::new(0, [int] $Matches[1], [int] $Matches[2], [int] $Matches[3], [int] $Matches[4]))
    return $local.ToUniversalTime()
}

# Was zwischen Startauftrag und „läuft“ geschah, ohne Prüfung: Startauftrag laut MSI-Log, Anlage des
# Dienstprozesses, erste Zeile „Dienst startet“ in service.log (der Dienst meldet „läuft“ direkt davor),
# Profil des virtuellen Kontos und Ereignisse von SCM und Benutzerprofildienst im Zeitfenster.
# $Since: frühester Zeitpunkt (UTC) des Starts; $Running: wann der Test „läuft“ sah (UTC).
function Show-SmokeStartTiming([datetime] $Since, [datetime] $Running, [string] $Label, [string] $MsiLog = '') {
    try {
        $format = 'HH:mm:ss.fff'
        Write-Host "    Zeitmessung ($Label), alle Zeiten UTC:"
        $requested = if ($MsiLog) { Get-SmokeMsiStartRequest $MsiLog } else { $null }
        $from = if ($requested) { $requested } else { $Since }
        if ($requested) {
            Write-Host "      $($requested.ToString($format))  Startauftrag an den SCM (MSI-Log, ServiceControl Action=1)"
        }
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$script:ServiceName'"
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($service.ProcessId)"
        $created = $process.CreationDate.ToUniversalTime()
        Write-Host "      $($created.ToString($format))  Dienstprozess angelegt (PID $($service.ProcessId), +$([math]::Round(($created - $from).TotalSeconds, 2)) s)"

        $log = Join-Path $script:DataDir 'logs\service.log'
        $logged = $null
        if (Test-Path -LiteralPath $log) {
            foreach ($line in ((Read-SmokeTextShared $log) -split "`r?`n")) {
                if ($line -match '^(\S+)\s+INFO\s+Dienst startet') {
                    $at = [DateTimeOffset]::Parse($Matches[1], [cultureinfo]::InvariantCulture).UtcDateTime
                    if ($at -ge $created.AddSeconds(-1)) {
                        $logged = $at
                        break
                    }
                }
            }
        }
        if ($logged) {
            # Typografische Anführungszeichen beenden auch "…"-Strings, daher hier ohne
            Write-Host "      $($logged.ToString($format))  service.log: 'Dienst startet' (+$([math]::Round(($logged - $created).TotalSeconds, 2)) s nach Prozessanlage)"
        }
        else {
            Write-Host '      (keine Zeile „Dienst startet“ nach der Prozessanlage in service.log)'
        }
        Write-Host "      $($Running.ToString($format))  Test sieht 'läuft' (+$([math]::Round(($Running - $from).TotalSeconds, 2)) s ab Startauftrag)"

        # Profil des virtuellen Kontos: Anlage und letzte Ladezeit laut ProfileList
        $sid = ([System.Security.Principal.NTAccount]::new($script:ServiceAccount)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
        if (Test-Path -LiteralPath $key) {
            $profileKey = Get-ItemProperty -LiteralPath $key
            $path = [Environment]::ExpandEnvironmentVariables($profileKey.ProfileImagePath)
            $profileCreated = if (Test-Path -LiteralPath $path) { (Get-Item -LiteralPath $path -Force).CreationTimeUtc.ToString($format) } else { 'fehlt' }
            $loaded = ''
            if ($profileKey.PSObject.Properties['LocalProfileLoadTimeHigh']) {
                # REG_DWORD kommt als Int32 (auch negativ); 0xFFFFFFFFL ist Int64
                $high = ([int64] $profileKey.LocalProfileLoadTimeHigh) -band 0xFFFFFFFFL
                $low = ([int64] $profileKey.LocalProfileLoadTimeLow) -band 0xFFFFFFFFL
                $fileTime = ($high -shl 32) -bor $low
                $loaded = ", zuletzt geladen $([DateTime]::FromFileTimeUtc($fileTime).ToString($format))"
            }
            Write-Host "      Profil $path (angelegt $profileCreated$loaded)"
        }
        else {
            Write-Host "      kein Profil für $sid in ProfileList"
        }

        $window = @{ StartTime = $from.ToLocalTime().AddSeconds(-5); EndTime = $Running.ToLocalTime().AddSeconds(5) }
        $profileEvents = @(Get-WinEvent -FilterHashtable (@{ LogName = 'Microsoft-Windows-User Profile Service/Operational' } + $window) -ErrorAction SilentlyContinue)
        foreach ($entry in ($profileEvents | Sort-Object TimeCreated)) {
            $first = "$($entry.Message)" -split "`r?`n" | Select-Object -First 1
            Write-Host "      $($entry.TimeCreated.ToUniversalTime().ToString($format))  Benutzerprofildienst Id $($entry.Id): $first"
        }
        $names = @($script:ServiceDisplayName, $script:ServiceName)
        $scmEvents = @(Get-WinEvent -FilterHashtable (@{ LogName = 'System'; ProviderName = 'Service Control Manager' } + $window) -ErrorAction SilentlyContinue |
                Where-Object { @($_.Properties | Where-Object { $names -contains "$($_.Value)" }).Count -gt 0 })
        foreach ($entry in ($scmEvents | Sort-Object TimeCreated)) {
            Write-Host "      $($entry.TimeCreated.ToUniversalTime().ToString($format))  SCM Id $($entry.Id): $($entry.Message)"
        }
    }
    catch {
        Write-Host "    Zeitmessung ($Label) unvollständig: $($_.Exception.Message)"
    }
}

# Klassenname und Text eines Fensters (Win32); für die Unterscheidung Hauptfenster vs. Meldungsfeld
function Initialize-SmokeWin32 {
    if (-not ('PdsSmoke.Win32' -as [type])) {
        Add-Type -Namespace PdsSmoke -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern uint GetDlgItemText(IntPtr hDlg, int id, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
    }
}

function Get-SmokeWindowClass([IntPtr] $Handle) {
    Initialize-SmokeWin32
    $name = [System.Text.StringBuilder]::new(256)
    [void] [PdsSmoke.Win32]::GetClassName($Handle, $name, $name.Capacity)
    return $name.ToString()
}

# Text eines Meldungsfelds (#32770): das Static-Element mit der ID 0xFFFF
function Get-SmokeMessageBoxText([IntPtr] $Handle) {
    Initialize-SmokeWin32
    $text = [System.Text.StringBuilder]::new(4096)
    [void] [PdsSmoke.Win32]::GetDlgItemText($Handle, 0xFFFF, $text, $text.Capacity)
    return $text.ToString()
}

# Bildschirmfoto eines Fensters als PNG; Fehler nur als Hinweis (optional)
function Save-SmokeWindowScreenshot([IntPtr] $Handle, [string] $Path) {
    try {
        Initialize-SmokeWin32
        Add-Type -AssemblyName System.Drawing
        [void] [PdsSmoke.Win32]::SetForegroundWindow($Handle)
        $rect = [PdsSmoke.Win32+RECT]::new()
        [void] [PdsSmoke.Win32]::GetWindowRect($Handle, [ref] $rect)
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -le 0 -or $height -le 0) {
            Write-Host "    Bildschirmfoto übersprungen: Fenstergröße $width x $height"
            return
        }
        $bitmap = [System.Drawing.Bitmap]::new($width, $height)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
            $graphics.Dispose()
            $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bitmap.Dispose()
        }
        Write-Host "    Bildschirmfoto: $Path ($width x $height)"
    }
    catch {
        Write-Host "    Bildschirmfoto nicht möglich: $($_.Exception.Message)"
    }
}

# Version der WebView2-Runtime (maschinenweit, wie das MSI sie sucht); leer, wenn keine
function Get-SmokeWebView2Version {
    $client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$client", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$client") {
        $version = Get-ItemPropertyValue -LiteralPath $key -Name 'pv' -ErrorAction SilentlyContinue
        if ($version -and $version -ne '0.0.0.0') {
            return $version
        }
    }
    return ''
}

# Fragt den SCM über sc.exe (eigener Prozess, hält keine Handles offen, die das Löschen verzögern)
function Test-SmokeServiceExists {
    $null = & sc.exe query $script:ServiceName
    # 1060: ERROR_SERVICE_DOES_NOT_EXIST
    return $LASTEXITCODE -ne 1060
}

# Kopiert, was bei einem Fehlschlag hilft: Logs und status.json des Dienstes, die Einträge der
# Ereignisquelle und den Dienstzustand. Scheitert nie (läuft auch nach Fehlern).
function Save-SmokeDiagnostics([string] $LogDir, [string] $Label) {
    try {
        $target = Join-Path $LogDir "diagnose-$Label"
        New-Item -ItemType Directory -Force -Path $target | Out-Null

        $logs = Join-Path $script:DataDir 'logs'
        if (Test-Path -LiteralPath $logs) {
            Copy-Item -LiteralPath $logs -Destination (Join-Path $target 'logs') -Recurse -Force
        }
        $status = Join-Path $script:DataDir 'state' 'status.json'
        if (Test-Path -LiteralPath $status) {
            Copy-Item -LiteralPath $status -Destination $target -Force
        }

        # Per XPath statt -ProviderName: Das geht auch, wenn die Quelle schon abgemeldet ist
        $xpath = "*[System[Provider[@Name='$script:EventSource']]]"
        $events = @(Get-WinEvent -LogName Application -FilterXPath $xpath -ErrorAction SilentlyContinue)
        $eventText = foreach ($entry in $events) {
            $message = if ($entry.Message) { $entry.Message } else { ($entry.Properties | ForEach-Object { $_.Value }) -join ' | ' }
            "[$($entry.TimeCreated.ToString('o'))] Id $($entry.Id) $($entry.LevelDisplayName)`n$message`n"
        }
        Set-Content -LiteralPath (Join-Path $target 'events.txt') -Value ($eventText -join "`n") -Encoding utf8

        # Dienstereignisse des SCM: Start-Zeitüberschreitung (7000/7009/7011), Absturz (7031/7034),
        # Zustandswechsel (7036). Gefiltert auf diesen Dienst über seinen Namen in den Parametern.
        $scmIds = 7000, 7009, 7011, 7031, 7034, 7036
        $names = @($script:ServiceDisplayName, $script:ServiceName)
        $scmEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = $scmIds } -ErrorAction SilentlyContinue |
                Where-Object { @($_.Properties | Where-Object { $names -contains "$($_.Value)" }).Count -gt 0 })
        $scmText = foreach ($entry in ($scmEvents | Sort-Object TimeCreated)) {
            "[$($entry.TimeCreated.ToString('o'))] Id $($entry.Id) $($entry.LevelDisplayName): $($entry.Message)"
        }
        Set-Content -LiteralPath (Join-Path $target 'system-scm-events.txt') -Value ($scmText -join "`n") -Encoding utf8

        # Abstürze der eigenen Prozesse (Application Error / Windows Error Reporting)
        $crashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001 } -ErrorAction SilentlyContinue |
                Where-Object { $_.Message -match 'pds|node\.exe|caddy\.exe' })
        $crashText = foreach ($entry in $crashes) {
            "[$($entry.TimeCreated.ToString('o'))] $($entry.ProviderName) Id $($entry.Id)`n$($entry.Message)`n"
        }
        Set-Content -LiteralPath (Join-Path $target 'application-crashes.txt') -Value ($crashText -join "`n") -Encoding utf8

        # Sicht der CLI (Secrets maskiert), solange sie installiert ist
        if (Test-Path -LiteralPath $script:Cli) {
            foreach ($command in @(@('status', '--json'), @('config', 'show'))) {
                try {
                    $result = Invoke-SmokeProcess -FilePath $script:Cli -Arguments $command -TimeoutSeconds 60
                    $file = Join-Path $target "cli-$($command[0]).txt"
                    Set-Content -LiteralPath $file -Value ($result.Stdout + "`n" + $result.Stderr) -Encoding utf8
                }
                catch {
                    Write-Warning "Diagnose: pds $($command -join ' '): $($_.Exception.Message)"
                }
            }
        }

        $service = @(
            & sc.exe query $script:ServiceName
            & sc.exe qc $script:ServiceName
            & sc.exe qfailure $script:ServiceName
            & sc.exe qfailureflag $script:ServiceName
        ) -join "`n"
        Set-Content -LiteralPath (Join-Path $target 'service.txt') -Value $service -Encoding utf8
        Write-Host "Diagnose gesichert: $target"
    }
    catch {
        Write-Warning "Diagnose ($Label) unvollständig: $($_.Exception.Message)"
    }
    finally {
        # sc.exe meldet für einen entfernten Dienst 1060; das darf den CI-Schritt nicht scheitern lassen
        $global:LASTEXITCODE = 0
    }
}
