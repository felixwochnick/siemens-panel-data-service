#Requires -Version 7.2
<#
.SYNOPSIS
  Signiert Dateien per Authenticode (signtool, SHA-256, RFC-3161-Zeitstempel).

.DESCRIPTION
  Umgebungsvariablen (in CI aus Secrets bzw. Variablen):
    WINDOWS_SIGN_PFX       Zertifikat mit privatem Schlüssel als base64-kodierte PFX
    WINDOWS_SIGN_PASSWORD  Passwort der PFX
    WINDOWS_SIGN_TSA       Zeitstempeldienst (Standard http://timestamp.digicert.com)
  Ohne WINDOWS_SIGN_PFX wird nichts signiert: Warnung „UNSIGNIERT“, Eintrag in der Job-Zusammenfassung,
  Exit 0. Unsignierte Builds sind erlaubt, müssen aber als solche erkennbar sein.

  Reihenfolge im Build: zuerst die eigenen EXEs und caddy.exe in der Payload, dann das MSI.
  node.exe trägt bereits die Signatur der OpenJS Foundation und bleibt unverändert.

  Das Passwort geht nie als Argument an einen Kindprozess und wird nie ausgegeben: Die PFX wird im
  Prozess (Import-PfxCertificate mit SecureString) nach Cert:\CurrentUser\My importiert, signtool wählt
  das Zertifikat per Fingerabdruck (/sha1 … /s My). PFX und Passwort werden gleich zu Beginn aus der
  Umgebung genommen, damit signtool sie nicht erbt. Die Temp-Datei der PFX wird direkt nach dem Import
  und sicherheitshalber im finally gelöscht. Das finally entfernt außerdem alles, was seit dem Import
  neu im Speicher liegt (samt privatem Schlüssel), auch nach einem abgebrochenen Teil-Import.

.EXAMPLE
  pwsh windows/scripts/sign.ps1 -Files windows/.payload/pds.exe windows/.payload/caddy.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string[]] $Files,
    # Nimmt weitere Pfade auf, damit auch `-Files a b c` funktioniert
    [Parameter(ValueFromRemainingArguments)]
    [string[]] $MoreFiles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Secrets nur noch als lokale Variablen: Kindprozesse (signtool) erben die Umgebung sonst samt Secret
$pfxBase64 = $env:WINDOWS_SIGN_PFX
$pfxPassword = $env:WINDOWS_SIGN_PASSWORD
Remove-Item -LiteralPath Env:WINDOWS_SIGN_PFX, Env:WINDOWS_SIGN_PASSWORD -ErrorAction SilentlyContinue

# Unter `pwsh -File` kommt `-Files a,b` als ein String an; Kommas daher auch hier als Trenner
$allFiles = @(@($Files) + @($MoreFiles) |
        Where-Object { $_ } |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ })

$resolved = foreach ($file in $allFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Datei zum Signieren fehlt: $file"
    }
    (Resolve-Path -LiteralPath $file).Path
}

function Add-StepSummary([string] $Markdown) {
    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Markdown -Encoding utf8
    }
}

$names = ($resolved | ForEach-Object { [System.IO.Path]::GetFileName($_) }) -join ', '

if ([string]::IsNullOrWhiteSpace($pfxBase64)) {
    Write-Warning "UNSIGNIERT: WINDOWS_SIGN_PFX ist nicht gesetzt, $names bleiben ohne Signatur"
    Add-StepSummary "### UNSIGNIERT`n`n**Kein Signaturzertifikat (WINDOWS_SIGN_PFX) – nicht signiert:** $names`n"
    exit 0
}

$tsa = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGN_TSA)) { 'http://timestamp.digicert.com' } else { $env:WINDOWS_SIGN_TSA }

# Neuestes signtool aus dem Windows SDK (x64)
$signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Parent.Name -as [version] } |
    Sort-Object { [version] $_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if (-not $signtool) {
    throw 'signtool.exe nicht gefunden (Windows SDK unter Windows Kits\10\bin\<version>\x64)'
}

$storePath = 'Cert:\CurrentUser\My'
$pfxPath = $null
$pfxBytes = $null
# Fingerabdrücke vor dem Import; $null heißt: noch nichts importiert, nichts aufzuräumen
$existing = $null
try {
    try {
        $pfxBytes = [System.Convert]::FromBase64String($pfxBase64.Trim())
    }
    catch {
        # Inhalt nicht in die Meldung übernehmen
        throw 'WINDOWS_SIGN_PFX ist kein gültiges base64'
    }
    $pfxPath = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)

    $importArgs = @{ FilePath = $pfxPath; CertStoreLocation = $storePath }
    if (-not [string]::IsNullOrEmpty($pfxPassword)) {
        # Nur im Prozess als SecureString, nie als Argument eines Kindprozesses
        $importArgs.Password = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
    }
    # Was vorher schon im Speicher lag, gehört nicht uns und bleibt beim Aufräumen unangetastet
    $existing = @(Get-ChildItem -LiteralPath $storePath | ForEach-Object { $_.Thumbprint })
    $imported = @(Import-PfxCertificate @importArgs)
    # Ab jetzt liegt der Schlüssel im Speicher; die Datei wird nicht mehr gebraucht
    Remove-Item -LiteralPath $pfxPath -Force

    $signing = @($imported | Where-Object { $_.HasPrivateKey })
    if ($signing.Count -ne 1) {
        throw "WINDOWS_SIGN_PFX muss genau ein Zertifikat mit privatem Schlüssel enthalten, gefunden: $($signing.Count)"
    }
    $thumbprint = $signing[0].Thumbprint

    $arguments = @('sign', '/sha1', $thumbprint, '/s', 'My', '/fd', 'SHA256', '/tr', $tsa, '/td', 'SHA256') + $resolved

    Write-Host "Signiere mit $($signtool.FullName) (Zertifikat $thumbprint): $names (Zeitstempel $tsa)"
    # Zeitstempeldienste fallen gelegentlich kurz aus; erneutes Signieren ersetzt die Signatur
    $attempts = 3
    for ($attempt = 1; ; $attempt++) {
        & $signtool.FullName @arguments
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ($attempt -ge $attempts) {
            throw "signtool ist mit Exit-Code $LASTEXITCODE fehlgeschlagen ($attempts Versuche)"
        }
        Write-Warning "signtool fehlgeschlagen (Exit-Code $LASTEXITCODE), neuer Versuch in 10 s"
        Start-Sleep -Seconds 10
    }
    Add-StepSummary "### Signiert`n`n$names (Zeitstempel $tsa)`n"
}
finally {
    try {
        # Alles, was seit dem Import neu im Speicher liegt, stammt von uns – auch wenn der Import
        # mittendrin abgebrochen ist. -DeleteKey löscht auch den privaten Schlüssel.
        if ($null -ne $existing) {
            $added = @(Get-ChildItem -LiteralPath $storePath |
                    Where-Object { $existing -notcontains $_.Thumbprint } |
                    ForEach-Object { $_.Thumbprint })
            foreach ($addedThumbprint in $added) {
                $item = "$storePath\$addedThumbprint"
                if ((Get-Item -LiteralPath $item).HasPrivateKey) {
                    Remove-Item -LiteralPath $item -DeleteKey
                }
                else {
                    Remove-Item -LiteralPath $item
                }
            }
        }
    }
    finally {
        if ($pfxBytes) {
            [System.Array]::Clear($pfxBytes, 0, $pfxBytes.Length)
        }
        if ($pfxPath -and (Test-Path -LiteralPath $pfxPath)) {
            Remove-Item -LiteralPath $pfxPath -Force
        }
    }
}
