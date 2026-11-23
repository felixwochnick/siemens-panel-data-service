#Requires -Version 7.2
<#
.SYNOPSIS
  Baut das MSI aus Payload und WebView2-Installer (WiX v5 über dotnet build).

.DESCRIPTION
  Ergebnis: <Out>/pds-<Version>-x64.msi
  Version immer X.Y.Z (Z = Build-Nummer); Windows Installer vergleicht nur diese drei Stellen.
  Danach das MSI mit sign.ps1 signieren.

.EXAMPLE
  pwsh windows/scripts/build-msi.ps1 -Payload windows/.payload `
    -WebView2 windows/.vendor/webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe -Version 0.1.42 -Out dist
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Payload,
    [Parameter(Mandatory)]
    [string] $WebView2,
    [Parameter(Mandatory)]
    [string] $Version,
    [Parameter(Mandatory)]
    [string] $Out
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# MSI-Grenzen: Major und Minor höchstens 255, Build höchstens 65535
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$' -or
    [int] $Matches[1] -gt 255 -or [int] $Matches[2] -gt 255 -or [int] $Matches[3] -gt 65535) {
    throw "Ungültige Version '$Version': erwartet X.Y.Z mit X, Y ≤ 255 und Z ≤ 65535"
}

if (-not (Test-Path -LiteralPath (Join-Path $Payload 'pds.exe') -PathType Leaf)) {
    throw "Payload unvollständig: $Payload enthält keine pds.exe – zuerst build-payload.ps1"
}
if (-not (Test-Path -LiteralPath $WebView2 -PathType Leaf)) {
    throw "WebView2-Installer fehlt: $WebView2 – zuerst fetch-vendor.ps1"
}

# Absolute Pfade ohne abschließenden Trenner: Ein \ vor dem schließenden Anführungszeichen würde das
# Quoting der MSBuild-Eigenschaft zerstören
$payloadPath = (Resolve-Path -LiteralPath $Payload).Path.TrimEnd('\', '/')
$webView2Path = (Resolve-Path -LiteralPath $WebView2).Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$outPath = (Resolve-Path -LiteralPath $Out).Path

$project = Join-Path $PSScriptRoot '..' 'installer' 'Pds.wixproj'
$installerDir = Split-Path -Parent (Resolve-Path -LiteralPath $project).Path
$binDir = Join-Path $installerDir 'bin'
# Alte Ergebnisse weg, damit unten genau ein MSI gefunden wird. Auch obj: Dort liegen Zwischenstände
# und der Cabinet-Cache des letzten Baus (andere Version oder Payload), die nicht mitwandern sollen.
Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $installerDir 'obj') -Recurse -Force -ErrorAction SilentlyContinue

$msiName = "pds-$Version-x64"
dotnet build $project `
    --configuration Release `
    "-p:PdsVersion=$Version" `
    "-p:PdsPayloadDir=$payloadPath" `
    "-p:PdsWebView2Installer=$webView2Path"
if ($LASTEXITCODE -ne 0) {
    throw "dotnet build des MSI ist mit Exit-Code $LASTEXITCODE fehlgeschlagen"
}

# Bei gesetzter Kultur liegt das MSI in einem Unterordner (bin\Release\de-DE\…)
$built = @(Get-ChildItem -LiteralPath $binDir -Recurse -File -Filter "$msiName.msi")
if ($built.Count -ne 1) {
    throw "Erwartet genau ein $msiName.msi unter $binDir, gefunden: $($built.Count)"
}
$target = Join-Path $outPath "$msiName.msi"
Copy-Item -LiteralPath $built[0].FullName -Destination $target -Force

$sizeMb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1)
Write-Host "MSI gebaut: $target ($sizeMb MB)"
