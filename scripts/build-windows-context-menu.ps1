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
$versionHelper = Join-Path $root 'scripts\print-windows-package-version.js'
$appxVersion = (& node $versionHelper $PackageVersion | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($appxVersion)) {
  throw "Could not map '$PackageVersion' to an ordered Windows package version."
}
$shellDirectory = "shell-$PackageVersion"

function Escape-XmlAttribute([string]$Value) {
  return ($Value -replace '&', '&amp;' -replace '"', '&quot;' -replace "'", '&apos;' -replace '<', '&lt;' -replace '>', '&gt;')
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  # Windows PowerShell's Set-Content -Encoding UTF8 writes a BOM; makeappx
  # rejects BOM-prefixed AppxManifest.xml as "manifest is not valid".
  $encoding = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Assert-NoTemplateTokens([string]$Text, [string]$Source) {
  $match = [regex]::Match($Text, '__[A-Z0-9_]+__')
  if ($match.Success) {
    throw "Unresolved template token '$($match.Value)' in $Source"
  }
}

$PublisherDnXml = Escape-XmlAttribute $PublisherDn

# DLL side-by-side identity and Appx Identity.Publisher MUST be identical strings.
# Attribute values are XML-escaped; the logical DN must still match the cert Subject.
$identityIn = Join-Path $shellDir 'msix_identity.manifest.in'
$identityOut = Join-Path $shellDir 'msix_identity.manifest'
$identityText = (Get-Content -LiteralPath $identityIn -Raw).Replace('__PUBLISHER_DN__', $PublisherDnXml)
Assert-NoTemplateTokens $identityText $identityIn
Write-Utf8NoBom $identityOut $identityText
$extractIdentityIn = Join-Path $shellDir 'msix_extract_identity.manifest.in'
$extractIdentityOut = Join-Path $shellDir 'msix_extract_identity.manifest'
$extractIdentityText = (Get-Content -LiteralPath $extractIdentityIn -Raw).Replace('__PUBLISHER_DN__', $PublisherDnXml)
Assert-NoTemplateTokens $extractIdentityText $extractIdentityIn
Write-Utf8NoBom $extractIdentityOut $extractIdentityText

function Resolve-ZinniaCmakeVsGenerator {
  $cmakeHelp = & cmake --help 2>&1 | Out-String
  $hasVs18 = Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\18')
  $hasVs2022 = (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022')) -or
    (Test-Path -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022'))
  $cmakeListsVs18 = $cmakeHelp -match 'Visual Studio 18 2026'
  $cmakeListsVs17 = $cmakeHelp -match 'Visual Studio 17 2022'

  # Prefer the VS install on this machine (release VMs use VS 18 / 2026).
  if ($hasVs18 -and $cmakeListsVs18) { return 'Visual Studio 18 2026' }
  if ($hasVs2022 -and $cmakeListsVs17) { return 'Visual Studio 17 2022' }
  if ($cmakeListsVs18) { return 'Visual Studio 18 2026' }
  if ($cmakeListsVs17) { return 'Visual Studio 17 2022' }
  throw 'No supported Visual Studio CMake generator found. Install VS 2022 or VS 2026 C++ tools, and CMake 4.2+ for VS 18.'
}

Write-Host "Configuring shell DLL ($Arch / $Configuration)..."
$cmakeArch = if ($Arch -eq 'arm64') { 'ARM64' } else { 'x64' }
$cmakeGenerator = Resolve-ZinniaCmakeVsGenerator
Write-Host "Using CMake generator: $cmakeGenerator -A $cmakeArch"
# Drop stale cache when retargeting VS versions (e.g. old VS 2022 → VS 18).
if (Test-Path -LiteralPath $buildDir) {
  Remove-Item -LiteralPath $buildDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
& cmake -S $shellDir -B $buildDir -G $cmakeGenerator -A $cmakeArch
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed: $LASTEXITCODE" }

& cmake --build $buildDir --config $Configuration
if ($LASTEXITCODE -ne 0) { throw "cmake build failed: $LASTEXITCODE" }

$dll = Get-ChildItem -Path $buildDir -Recurse -Filter 'zinnia_shell.dll' | Select-Object -First 1
if (-not $dll) { throw 'zinnia_shell.dll was not produced.' }
Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $outDir 'zinnia_shell.dll') -Force
$extractDll = Get-ChildItem -Path $buildDir -Recurse -Filter 'zinnia_extract_shell.dll' | Select-Object -First 1
if (-not $extractDll) { throw 'zinnia_extract_shell.dll was not produced.' }
Copy-Item -LiteralPath $extractDll.FullName -Destination (Join-Path $outDir 'zinnia_extract_shell.dll') -Force

$staging = Join-Path $buildDir 'sparse-staging'
if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'Assets') | Out-Null
Copy-Item -Path (Join-Path $sparseDir 'Assets\*') -Destination (Join-Path $staging 'Assets') -Force
$appxTemplate = Join-Path $sparseDir 'AppxManifest.xml.template'
$appxPath = Join-Path $staging 'AppxManifest.xml'
$appxText = (Get-Content -LiteralPath $appxTemplate -Raw).
  Replace('__PUBLISHER_DN__', $PublisherDnXml).
  Replace('__PACKAGE_VERSION__', $appxVersion).
  Replace('__SHELL_DIRECTORY__', $shellDirectory)
Assert-NoTemplateTokens $appxText $appxTemplate
Write-Utf8NoBom $appxPath $appxText

$extractStaging = Join-Path $buildDir 'extract-sparse-staging'
if (Test-Path $extractStaging) { Remove-Item -LiteralPath $extractStaging -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $extractStaging 'Assets') | Out-Null
Copy-Item -Path (Join-Path $sparseDir 'Assets\*') -Destination (Join-Path $extractStaging 'Assets') -Force
$extractAppxTemplate = Join-Path $sparseDir 'ExtractAppxManifest.xml.template'
$extractAppxPath = Join-Path $extractStaging 'AppxManifest.xml'
$extractAppxText = (Get-Content -LiteralPath $extractAppxTemplate -Raw).
  Replace('__PUBLISHER_DN__', $PublisherDnXml).
  Replace('__PACKAGE_VERSION__', $appxVersion).
  Replace('__SHELL_DIRECTORY__', $shellDirectory)
Assert-NoTemplateTokens $extractAppxText $extractAppxTemplate
Write-Utf8NoBom $extractAppxPath $extractAppxText

$makeAppx = @(
  Get-ChildItem -Path ${env:ProgramFiles(x86)}, $env:ProgramFiles -Filter 'makeappx.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' }
) | Select-Object -First 1
if (-not $makeAppx) { throw 'makeappx.exe not found. Install the Windows SDK.' }

$msixPath = Join-Path $outDir 'ZinniaContextMenu.msix'
if (Test-Path $msixPath) { Remove-Item -LiteralPath $msixPath -Force }
# /nv is required for sparse packages: payload (zinnia.exe / shell DLL) lives
# outside the MSIX via AllowExternalContent + Add-AppxPackage -ExternalLocation.
Write-Host "Packing sparse MSIX with $($makeAppx.FullName) ..."
& $makeAppx.FullName pack /o /nv /d $staging /p $msixPath
if ($LASTEXITCODE -ne 0) {
  throw "makeappx failed: $LASTEXITCODE (manifest=$appxPath publisher=$PublisherDn version=$appxVersion)"
}

$extractMsixPath = Join-Path $outDir 'ZinniaExtractContextMenu.msix'
if (Test-Path $extractMsixPath) { Remove-Item -LiteralPath $extractMsixPath -Force }
Write-Host "Packing Extract sparse MSIX with $($makeAppx.FullName) ..."
& $makeAppx.FullName pack /o /nv /d $extractStaging /p $extractMsixPath
if ($LASTEXITCODE -ne 0) {
  throw "makeappx failed: $LASTEXITCODE (manifest=$extractAppxPath publisher=$PublisherDn version=$appxVersion)"
}

Write-Host "Built $(Join-Path $outDir 'zinnia_shell.dll')"
Write-Host "Built $(Join-Path $outDir 'zinnia_extract_shell.dll')"
Write-Host "Built $msixPath"
Write-Host "Built $extractMsixPath"
Write-Host "Publisher DN (DLL identity + Appx Identity): $PublisherDn"
Write-Host "Package version: $appxVersion"
