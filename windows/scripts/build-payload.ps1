#Requires -Version 7.2
<#
.SYNOPSIS
  Stellt die Payload des MSI zusammen (alles, was nach %ProgramFiles%\EPLAN Panel Data Service kommt).

.DESCRIPTION
  Voraussetzungen:
    - pnpm --filter @pds/web build (apps/web/.output), unter Linux
      (CI-Job app): unter Windows gebaut enthält die Ausgabe Importe mit Windows-Pfaden
    - pnpm --filter @pds/node-tools build (windows/node-tools/dist)
    - pnpm --filter @pds/config-ui build, danach erst
      cargo build --release in windows/ (Tauri bettet ui/dist in pds-config.exe ein)
    - fetch-vendor.ps1 (Node, Caddy)
    - für den EPLAN-Worker (baut dieses Skript selbst, außer mit -SkipEplanWorker): .NET SDK (dotnet),
      .NET Framework 4.8.1 Developer Pack und ein installiertes EPLAN (API-DLLs in -EplanBinPath)
  Ergebnis:
    pds.exe, pds-config.exe, caddy.exe,
    node/node.exe, app/ (.output + pds-entry.mjs), tools/pds-tools.mjs,
    eplan/pds-eplan.exe (EPLAN-Worker mit seinen Abhängigkeiten, fehlt bei -SkipEplanWorker),
    licenses/ (node-LICENSE.txt, caddy-LICENSE.txt, WEBVIEW2-NOTICE.txt, pds-tools-THIRD-PARTY.txt)
  Die EPLAN-DLLs (Eplan.*) kommen nicht in die Payload: Sie gehören zur EPLAN-Installation, und der
  Worker lädt sie zur Laufzeit von dort. -EplanBinPath dient nur dem Übersetzen.
  Ohne EPLAN (z. B. CI) mit -SkipEplanWorker bauen: Das MSI enthält dann keinen Worker, und
  'pds eplan install' lehnt auf so installierten Rechnern ab; das Skript warnt deshalb deutlich.
  Der WebView2-Installer bleibt außerhalb; er kommt als Binary direkt ins MSI.
  Signiert wird danach mit sign.ps1 (eigene EXEs, eplan/pds-eplan.exe und caddy.exe), nicht hier.

.EXAMPLE
  pwsh windows/scripts/build-payload.ps1 -Vendor windows/.vendor -Out windows/.payload -Configuration release

.EXAMPLE
  pwsh windows/scripts/build-payload.ps1 -EplanBinPath 'D:\EPLAN\Platform\2025.0.3\Bin'
  EPLAN liegt nicht am Standardort; der Worker wird gegen die DLLs dort übersetzt.

.EXAMPLE
  pwsh windows/scripts/build-payload.ps1 -SkipEplanWorker
  Ohne EPLAN (CI): Payload und MSI ohne Worker.
#>
[CmdletBinding()]
param(
    [string] $Vendor = (Join-Path $PSScriptRoot '..' '.vendor'),
    [string] $Out = (Join-Path $PSScriptRoot '..' '.payload'),
    [ValidateSet('release', 'debug')]
    [string] $Configuration = 'release',
    # Bin-Ordner der EPLAN Platform; nur zum Übersetzen des Workers, ausgeliefert wird daraus nichts
    [string] $EplanBinPath = 'C:\Program Files\EPLAN\Platform\2025.0.3\Bin',
    # Ohne EPLAN (CI): Worker nicht bauen, eplan\ fehlt in Payload und MSI
    [switch] $SkipEplanWorker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$windowsDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $windowsDir '..')).Path
$Vendor = (Resolve-Path -LiteralPath $Vendor).Path

# EPLAN-Voraussetzungen vor dem Leeren von -Out prüfen: Ohne EPLAN soll die alte Payload stehen bleiben
$workerProject = Join-Path $repoRoot 'worker' 'src' 'Pds.EplanWorker'
if (-not $SkipEplanWorker) {
    $skipHint = 'ohne EPLAN mit -SkipEplanWorker bauen; dann fehlt der Worker im MSI'
    $requiredEplanDlls = 'Eplan.EplApi.Baseu.dll', 'Eplan.EplApi.Starteru.dll'
    # Path.Combine statt Join-Path: Join-Path scheitert schon an einem nicht vorhandenen Laufwerk
    $missingEplanDlls = @($requiredEplanDlls | Where-Object {
            -not (Test-Path -LiteralPath ([System.IO.Path]::Combine($EplanBinPath, $_)) -PathType Leaf)
        })
    if ($missingEplanDlls.Count -gt 0) {
        $message = "EPLAN-API-DLLs fehlen in ${EplanBinPath}: $($missingEplanDlls -join ', '). " +
        "EPLAN installieren bzw. den Bin-Ordner mit -EplanBinPath angeben – oder $skipHint"
        throw $message
    }
    # Ohne abschließenden Trenner: Ein \ vor dem Anführungszeichen zerstört das Quoting der MSBuild-Eigenschaft
    $EplanBinPath = (Resolve-Path -LiteralPath $EplanBinPath).Path.TrimEnd('\', '/')
    if (-not (Get-Command -Name dotnet -CommandType Application -ErrorAction SilentlyContinue)) {
        throw ".NET SDK fehlt (dotnet nicht im PATH), es übersetzt den EPLAN-Worker – oder $skipHint"
    }
    if (-not (Test-Path -LiteralPath $workerProject -PathType Container)) {
        throw "Fehlt: $workerProject – gehört ins Repository"
    }
}

# Installationsordner so lang wie unter C:\Program Files; MSI kann keine Pfade über MAX_PATH anlegen
$installDirLength = 'C:\Program Files\EPLAN Panel Data Service\'.Length
$maxPath = 259

function Copy-Required([string] $Source, [string] $Destination, [string] $Hint) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Fehlt: $Source – $Hint"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination
}

# Sicherheitsnetz gegen ein falsches -Out: nur einen Ordner namens .payload (oder einen leeren) leeren
if (Test-Path -LiteralPath $Out) {
    $existing = Get-Item -LiteralPath $Out
    $isEmpty = -not (Get-ChildItem -LiteralPath $Out -Force | Select-Object -First 1)
    if ($existing.Name -ne '.payload' -and -not $isEmpty) {
        throw "Ausgabeordner $Out ist nicht leer und heißt nicht .payload – bitte prüfen"
    }
    Remove-Item -LiteralPath $Out -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path

# --- Eigene EXEs -------------------------------------------------------------------------------------
$targetDir = Join-Path $windowsDir 'target' $Configuration
$cargoHint = "zuerst in windows/ 'cargo build --$Configuration' ausführen"
if ($Configuration -eq 'debug') {
    $cargoHint = "zuerst in windows/ 'cargo build' ausführen"
}
Copy-Required (Join-Path $targetDir 'pds.exe') $Out $cargoHint
# Das MSI hat eine eigene Komponente samt Startmenü-Verknüpfung dafür, die EXE ist also Pflicht
Copy-Required (Join-Path $targetDir 'pds-config.exe') $Out `
    "$cargoHint (vorher die Oberfläche bauen: pnpm --filter @pds/config-ui build)"

# --- Fremdkomponenten --------------------------------------------------------------------------------
$vendorHint = 'zuerst fetch-vendor.ps1 ausführen'
Copy-Required (Join-Path $Vendor 'caddy' 'caddy.exe') $Out $vendorHint
$nodeOut = Join-Path $Out 'node'
New-Item -ItemType Directory -Path $nodeOut | Out-Null
Copy-Required (Join-Path $Vendor 'node' 'node.exe') $nodeOut $vendorHint

# --- App: .output unverändert, daneben der Einstieg ----------------------------------------------------
$appOutput = Join-Path $repoRoot 'apps' 'web' '.output'
if (-not (Test-Path -LiteralPath (Join-Path $appOutput 'server' 'index.mjs') -PathType Leaf)) {
    throw "Fehlt: $appOutput – zuerst 'pnpm --filter @pds/web build' ausführen"
}
# Unter Windows gebaut übernimmt Nitro Handler-Pfade aus Nuxt-Layern (D:\…) ohne Escaping in Importe
# ('D:asiemens…'); Node lehnt sie erst beim Start ab (ERR_UNSUPPORTED_ESM_URL_SCHEME). Hier abweisen.
$serverDir = Join-Path $appOutput 'server'
$serverCode = @(Get-Item -Path (Join-Path $serverDir '*.mjs')) +
    @(Get-ChildItem -LiteralPath (Join-Path $serverDir 'chunks') -Recurse -File -Filter *.mjs -ErrorAction SilentlyContinue)
$driveImports = @($serverCode | Select-String -CaseSensitive -Pattern '(?:\bfrom|\bimport)\s*\(?\s*[''"][A-Za-z]:' -List)
if ($driveImports.Count -gt 0) {
    $list = ($driveImports | ForEach-Object { "$([System.IO.Path]::GetRelativePath($appOutput, $_.Path)): $($_.Line.Trim())" }) -join "`n  "
    throw "Die App-Ausgabe importiert Windows-Pfade (unter Windows gebaut?). Die App unter Linux bauen (CI-Job app):`n  $list"
}
# Native Module liefen nur auf dem System, auf dem gebaut wurde (die App entsteht unter Linux)
$nativeModules = @(Get-ChildItem -LiteralPath $appOutput -Recurse -File -Force -Filter *.node)
if ($nativeModules.Count -gt 0) {
    $list = ($nativeModules | ForEach-Object { [System.IO.Path]::GetRelativePath($appOutput, $_.FullName) }) -join "`n  "
    throw "Die App-Ausgabe enthält native Node-Module, die unter Windows nicht laufen:`n  $list"
}

$appOut = Join-Path $Out 'app'
Copy-Item -LiteralPath $appOutput -Destination $appOut -Recurse -Force
Copy-Required (Join-Path $windowsDir 'node-tools' 'src' 'pds-entry.mjs') $appOut 'gehört ins Repository'

# --- Werkzeuge: gebündeltes pds-tools.mjs (DB-Test, DB-Einrichtung, SQL-Skript, OIDC-Prüfung) ---------
$toolsDist = Join-Path $windowsDir 'node-tools' 'dist'
$toolsHint = "zuerst 'pnpm --filter @pds/node-tools build' ausführen"
$toolsOut = Join-Path $Out 'tools'
New-Item -ItemType Directory -Path $toolsOut | Out-Null
Copy-Required (Join-Path $toolsDist 'pds-tools.mjs') $toolsOut $toolsHint

# --- EPLAN-Worker: eplan\pds-eplan.exe mit Abhängigkeiten, ohne die DLLs der EPLAN-Installation -------
if (-not $SkipEplanWorker) {
    # Frischer Ausgabeordner je Lauf: keine Reste früherer Builds (z. B. entfallene Abhängigkeiten)
    $workerBuild = Join-Path ([System.IO.Path]::GetTempPath()) "pds-eplan-worker-$([guid]::NewGuid().ToString('N'))"
    try {
        # UseEplanStubs=false: Ohne die DLLs fiele das csproj sonst still auf die Compile-Stubs zurück,
        # und ein nicht lauffähiger Worker landete im MSI
        dotnet build $workerProject `
            --configuration Release `
            "-p:EplanBinPath=$EplanBinPath" `
            '-p:UseEplanStubs=false' `
            --output $workerBuild
        if ($LASTEXITCODE -ne 0) {
            throw "dotnet build des EPLAN-Workers ist mit Exit-Code $LASTEXITCODE fehlgeschlagen"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $workerBuild 'pds-eplan.exe') -PathType Leaf)) {
            throw "Die Ausgabe des Worker-Builds enthält keine pds-eplan.exe ($workerBuild) – AssemblyName im csproj prüfen"
        }
        $workerFiles = @(Get-ChildItem -LiteralPath $workerBuild -Recurse -File -Force)
        # Gegen die Compile-Stubs übersetzt liefe der Worker mit keinem echten EPLAN
        $stubs = @($workerFiles | Where-Object Name -Like 'Eplan.*Stub*')
        if ($stubs.Count -gt 0) {
            $message = "Der Worker wurde gegen die EPLAN-Stubs übersetzt ($(($stubs | ForEach-Object Name) -join ', ')), nicht gegen " +
            "$EplanBinPath – UseEplanStubs im csproj prüfen"
            throw $message
        }

        # Nicht ausliefern, was zur EPLAN-Installation gehört (Lizenz; der Worker lädt es zur Laufzeit von
        # dort): alle Eplan.*-Dateien, also API-DLLs samt XML-Doku, PDB und Satelliten in Unterordnern
        $eplanOut = Join-Path $Out 'eplan'
        $omitted = [System.Collections.Generic.List[string]]::new()
        foreach ($file in $workerFiles) {
            $relative = [System.IO.Path]::GetRelativePath($workerBuild, $file.FullName)
            if ($file.Name -like 'Eplan.*') {
                $omitted.Add($relative)
                continue
            }
            $target = Join-Path $eplanOut $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $target
        }
        $workerCount = @(Get-ChildItem -LiteralPath $eplanOut -Recurse -File -Force).Count
        Write-Host "EPLAN-Worker: $workerCount Dateien nach eplan\ (übersetzt gegen $EplanBinPath)"
        if ($omitted.Count -gt 0) {
            Write-Host "  nicht ausgeliefert (gehören zur EPLAN-Installation):`n    $($omitted -join "`n    ")"
        }
        else {
            Write-Host '  keine EPLAN-DLLs in der Build-Ausgabe'
        }
    }
    finally {
        Remove-Item -LiteralPath $workerBuild -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Lizenzen ------------------------------------------------------------------------------------------
$licensesOut = Join-Path $Out 'licenses'
New-Item -ItemType Directory -Path $licensesOut | Out-Null
Copy-Required (Join-Path $Vendor 'node' 'LICENSE') (Join-Path $licensesOut 'node-LICENSE.txt') $vendorHint
Copy-Required (Join-Path $Vendor 'caddy' 'LICENSE') (Join-Path $licensesOut 'caddy-LICENSE.txt') $vendorHint
Copy-Required (Join-Path $windowsDir 'licenses' 'WEBVIEW2-NOTICE.txt') $licensesOut 'gehört ins Repository'
# Lizenzhinweise der in pds-tools.mjs gebündelten Pakete (esbuild legalComments)
Copy-Required (Join-Path $toolsDist 'pds-tools.mjs.LEGAL.txt') (Join-Path $licensesOut 'pds-tools-THIRD-PARTY.txt') $toolsHint

# --- Prüfen --------------------------------------------------------------------------------------------
$files = @(Get-ChildItem -LiteralPath $Out -Recurse -File -Force)
$tooLong = @($files | Where-Object {
        $installDirLength + [System.IO.Path]::GetRelativePath($Out, $_.FullName).Length -gt $maxPath
    })
if ($tooLong.Count -gt 0) {
    $list = ($tooLong | ForEach-Object { [System.IO.Path]::GetRelativePath($Out, $_.FullName) }) -join "`n  "
    throw "Pfade zu lang für den Installationsordner (MAX_PATH):`n  $list"
}

$sizeMb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "Payload in ${Out}: $($files.Count) Dateien, $sizeMb MB"

# Zum Schluss, damit es nicht in der Ausgabe davor untergeht; in GitHub Actions zusätzlich als Annotation
if ($SkipEplanWorker) {
    $warning = 'Payload OHNE EPLAN-Worker (-SkipEplanWorker): Das MSI enthält kein eplan\pds-eplan.exe, ' +
    '"pds eplan install" lehnt auf damit installierten Rechnern ab. ' +
    'Für ein vollständiges MSI auf einem Rechner mit EPLAN ohne -SkipEplanWorker bauen.'
    Write-Warning $warning
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "::warning title=EPLAN-Worker::$warning"
    }
}
