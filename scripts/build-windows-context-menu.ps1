#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Configuration = 'Release',
  [string]$Arch = 'x64',
  [string]$PublisherDn = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN,
  [string]$PublisherCn = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER,
  [string]$PackageVersion = '',
  # Optional: read Subject from an already-signed binary (recommended for Azure Artifact Signing).
  [string]$PublisherFromSignedFile = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'build-windows-context-menu.ps1 must run on Windows.' }

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$shellDir = Join-Path $root 'src-tauri\windows\shell'
$sparseDir = Join-Path $root 'src-tauri\windows\sparse-package'
$outDir = Join-Path $shellDir 'out'
$buildDir = Join-Path $shellDir "build-$Arch"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if ($PublisherFromSignedFile -and (Test-Path -LiteralPath $PublisherFromSignedFile)) {
  $sig = Get-AuthenticodeSignature -LiteralPath $PublisherFromSignedFile
  if (-not $sig.SignerCertificate) {
    throw "No signer certificate on $PublisherFromSignedFile"
  }
  $PublisherDn = $sig.SignerCertificate.Subject
  Write-Host "Publisher DN from signed file: $PublisherDn"
}

if (-not $PublisherDn -or [string]::IsNullOrWhiteSpace($PublisherDn)) {
  throw @'
Set AZURE_ARTIFACT_SIGNING_PUBLISHER_DN to the signing certificate Subject
(exact DN from Azure Artifact Signing profile / a signed zinnia.exe Subject),
or pass -PublisherFromSignedFile path\to\signed.exe.

CN-only AZURE_ARTIFACT_SIGNING_PUBLISHER is not accepted: it often fails MSIX
signing with 0x8007000B when the cert Subject includes O=/C= fields.
'@
}
if ($PublisherCn -and $PublisherDn -notlike "*$($PublisherCn.Trim())*") {
  Write-Warning "Publisher DN does not contain AZURE_ARTIFACT_SIGNING_PUBLISHER ('$($PublisherCn.Trim())'). Double-check the Subject."
}
$PublisherDn = $PublisherDn.Trim()
if ($PublisherDn -match '^CN=[^,]+$' -and $PublisherDn -notmatch '[,]') {
  Write-Warning "Publisher DN looks CN-only ('$PublisherDn'). If signtool fails with 0x8007000B, use the full certificate Subject."
}

if (-not $PackageVersion) {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $PackageVersion = [string]$pkg.version
}
$parts = @(($PackageVersion -replace '[^0-9.]', '') -split '\.' | Where-Object { $_ -ne '' })
while ($parts.Count -lt 4) { $parts += '0' }
$appxVersion = ($parts[0..3] -join '.')

function Escape-XmlAttribute([string]$Value) {
  return ($Value -replace '&', '&amp;' -replace '"', '&quot;' -replace "'", '&apos;' -replace '<', '&lt;' -replace '>', '&gt;')
}
$PublisherDnXml = Escape-XmlAttribute $PublisherDn

# DLL side-by-side identity and Appx Identity.Publisher MUST be identical strings.
# Attribute values are XML-escaped; the logical DN must still match the cert Subject.
$identityIn = Join-Path $shellDir 'msix_identity.manifest.in'
$identityOut = Join-Path $shellDir 'msix_identity.manifest'
$identityText = (Get-Content -LiteralPath $identityIn -Raw).Replace('__PUBLISHER_DN__', $PublisherDnXml)
Set-Content -LiteralPath $identityOut -Value $identityText -Encoding UTF8

Write-Host "Configuring shell DLL ($Arch / $Configuration)..."
$cmakeArch = if ($Arch -eq 'arm64') { 'ARM64' } else { 'x64' }
& cmake -S $shellDir -B $buildDir -G 'Visual Studio 17 2022' -A $cmakeArch
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed: $LASTEXITCODE" }

& cmake --build $buildDir --config $Configuration
if ($LASTEXITCODE -ne 0) { throw "cmake build failed: $LASTEXITCODE" }

$dll = Get-ChildItem -Path $buildDir -Recurse -Filter 'zinnia_shell.dll' | Select-Object -First 1
if (-not $dll) { throw 'zinnia_shell.dll was not produced.' }
Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $outDir 'zinnia_shell.dll') -Force

$staging = Join-Path $buildDir 'sparse-staging'
if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'Assets') | Out-Null
Copy-Item -LiteralPath (Join-Path $sparseDir 'Assets\*') -Destination (Join-Path $staging 'Assets') -Force
$appxTemplate = Join-Path $sparseDir 'AppxManifest.xml.template'
$appxText = (Get-Content -LiteralPath $appxTemplate -Raw).
  Replace('__PUBLISHER_DN__', $PublisherDnXml).
  Replace('__PACKAGE_VERSION__', $appxVersion)
Set-Content -LiteralPath (Join-Path $staging 'AppxManifest.xml') -Value $appxText -Encoding UTF8

$makeAppx = @(
  Get-ChildItem -Path ${env:ProgramFiles(x86)}, $env:ProgramFiles -Filter 'makeappx.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' }
) | Select-Object -First 1
if (-not $makeAppx) { throw 'makeappx.exe not found. Install the Windows SDK.' }

$msixPath = Join-Path $outDir 'ZinniaContextMenu.msix'
if (Test-Path $msixPath) { Remove-Item -LiteralPath $msixPath -Force }
& $makeAppx.FullName pack /o /d $staging /nv /p $msixPath
if ($LASTEXITCODE -ne 0) { throw "makeappx failed: $LASTEXITCODE" }

Write-Host "Built $(Join-Path $outDir 'zinnia_shell.dll')"
Write-Host "Built $msixPath"
Write-Host "Publisher DN (DLL identity + Appx Identity): $PublisherDn"
Write-Host "Package version: $appxVersion"
