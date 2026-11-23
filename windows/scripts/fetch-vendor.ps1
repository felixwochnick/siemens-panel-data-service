#Requires -Version 7.2
<#
.SYNOPSIS
  Lädt die Fremdkomponenten aus windows/vendor.json, prüft ihre SHA-256 und entpackt sie.

.DESCRIPTION
  Ergebnis unter -OutDir (Standard windows/.vendor):
    node/node.exe, node/LICENSE
    caddy/caddy.exe, caddy/LICENSE
    webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe   (zusätzlich Authenticode geprüft)
  Downloads liegen in downloads/ und werden wiederverwendet, solange ihr Hash stimmt.
  Jede Abweichung vom Hash in vendor.json bricht ab.

  Aktualisieren (per PR, dann neu bauen):
  - Node: neueste 24-LTS aus https://nodejs.org/dist/index.json; URL
    https://nodejs.org/dist/v<v>/node-v<v>-win-x64.zip, Hash aus https://nodejs.org/dist/v<v>/SHASUMS256.txt.
  - Caddy: caddy_<v>_windows_amd64.zip aus den GitHub-Releases. caddy_<v>_checksums.txt enthält nur
    SHA-512: Datei laden, gegen den SHA-512 prüfen, dann SHA-256 berechnen und eintragen.
  - WebView2: Evergreen-Standalone x64 über https://go.microsoft.com/fwlink/?linkid=2124701. Die
    Weiterleitung auflösen (curl -sIL …, letzte Location) und die versionierte URL eintragen, Datei laden,
    SHA-256 berechnen. Die Runtime-Version steht im Namen der eingebetteten Datei
    MicrosoftEdgeWebview_X64_<version>.exe (z. B. 7z x auf die EXE, dann im entpackten Archiv suchen).
    Microsoft entfernt alte Dateien irgendwann vom CDN; dann schlägt der Download fehl und der Eintrag
    muss erneuert werden.
  - Danach `cargo test --workspace` in windows/ (vendor.json wird einkompiliert).

.EXAMPLE
  pwsh windows/scripts/fetch-vendor.ps1 -OutDir windows/.vendor
#>
[CmdletBinding()]
param(
    [string] $OutDir = (Join-Path $PSScriptRoot '..' '.vendor')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Fortschrittsanzeige bremst Invoke-WebRequest bei großen Dateien stark
$ProgressPreference = 'SilentlyContinue'

$vendorFile = Join-Path $PSScriptRoot '..' 'vendor.json'
$vendor = Get-Content -Raw -LiteralPath $vendorFile | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$downloads = Join-Path $OutDir 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-Sha256([string] $Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Lädt die Datei (falls nicht schon mit passendem Hash vorhanden) und prüft den SHA-256.
function Get-VerifiedDownload([string] $Name, [pscustomobject] $Entry) {
    $expected = $Entry.sha256.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw "vendor.json: $Name.sha256 ist kein SHA-256-Wert"
    }
    $fileName = [System.IO.Path]::GetFileName(([System.Uri] $Entry.url).AbsolutePath)
    $target = Join-Path $downloads $fileName

    if ((Test-Path -LiteralPath $target) -and (Get-Sha256 $target) -eq $expected) {
        Write-Host "$Name $($Entry.version): vorhanden, SHA-256 stimmt"
        return $target
    }

    Write-Host "$Name $($Entry.version): lade $($Entry.url)"
    $partial = "$target.partial"
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $Entry.url -OutFile $partial -MaximumRetryCount 3 -RetryIntervalSec 5

    $actual = Get-Sha256 $partial
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $partial -Force
        throw "SHA-256 von $Name stimmt nicht: erwartet $expected, erhalten $actual ($($Entry.url))"
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    Write-Host "$Name $($Entry.version): SHA-256 geprüft"
    return $target
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

# Holt einzelne Dateien aus dem ZIP. Bewusst nicht alles entpacken: Das Node-Archiv enthält npm mit
# tiefen Pfaden, die wir nicht brauchen.
function Export-ZipEntry([string] $Zip, [string] $EntryName, [string] $Destination) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $entry = $archive.GetEntry($EntryName)
        if ($null -eq $entry) {
            throw "Erwartete Datei fehlt im Archiv $([System.IO.Path]::GetFileName($Zip)): $EntryName"
        }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $Destination, $true)
    }
    finally {
        $archive.Dispose()
    }
}

function Initialize-EmptyDirectory([string] $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

# --- Node: nur node.exe und LICENSE, kein npm/npx/corepack -----------------------------------------
$nodeZip = Get-VerifiedDownload 'node' $vendor.node
$nodePrefix = "node-v$($vendor.node.version)-win-x64"
$nodeOut = Join-Path $OutDir 'node'
Initialize-EmptyDirectory $nodeOut
Export-ZipEntry $nodeZip "$nodePrefix/node.exe" (Join-Path $nodeOut 'node.exe')
Export-ZipEntry $nodeZip "$nodePrefix/LICENSE" (Join-Path $nodeOut 'LICENSE')

# --- Caddy -------------------------------------------------------------------------------------------
$caddyZip = Get-VerifiedDownload 'caddy' $vendor.caddy
$caddyOut = Join-Path $OutDir 'caddy'
Initialize-EmptyDirectory $caddyOut
Export-ZipEntry $caddyZip 'caddy.exe' (Join-Path $caddyOut 'caddy.exe')
Export-ZipEntry $caddyZip 'LICENSE' (Join-Path $caddyOut 'LICENSE')

# --- WebView2: Hash pinnt die Datei, die Signatur bestätigt zusätzlich die Herkunft --------------------
$webView2File = Get-VerifiedDownload 'webview2' $vendor.webview2
$signature = Get-AuthenticodeSignature -LiteralPath $webView2File
if ($signature.Status -ne 'Valid') {
    throw "Authenticode-Signatur des WebView2-Installers ist nicht gültig: $($signature.Status) – $($signature.StatusMessage)"
}
if ($signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "WebView2-Installer ist nicht von Microsoft signiert: $($signature.SignerCertificate.Subject)"
}
$webView2Out = Join-Path $OutDir 'webview2'
Initialize-EmptyDirectory $webView2Out
Copy-Item -LiteralPath $webView2File -Destination (Join-Path $webView2Out 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe')

Write-Host "Fremdkomponenten bereit in $OutDir"
