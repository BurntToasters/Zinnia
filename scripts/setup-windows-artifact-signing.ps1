#requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Force
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Artifact Signing Client Tools setup must run on Windows.' }

. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')

if (-not $Force) {
  try {
    $tools = Get-ArtifactSigningTools
    Write-Host 'Artifact Signing Client Tools are already installed.'
    Write-Host "SignTool: $($tools.SignToolPath)"
    Write-Host "Dlib: $($tools.DlibPath)"
    exit 0
  } catch {
    Write-Host "Artifact Signing tools are missing or not trusted: $($_.Exception.Message)"
    Write-Host 'Installing or repairing official Microsoft Artifact Signing Client Tools...'
  }
} else {
  Write-Host 'Force reinstall: removing legacy unsigned trees, then installing official tools...'
}

Remove-UnsignedLegacyArtifactSigningTrees

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw @(
    'Installing Artifact Signing Client Tools requires an elevated PowerShell session.'
    'Open PowerShell as Administrator, cd to the repo, then run:'
    '  npm run setup:win:artifact-signing'
    'If a broken NuGet copy was left under AppData, use:'
    '  npm run setup:win:artifact-signing:repair'
  ) -join "`n"
}

$installed = $false
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if ($winget) {
  & $winget.Source install -e --id Microsoft.Azure.ArtifactSigningClientTools `
    --scope machine `
    --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -eq 0) {
    $installed = $true
  } else {
    Write-Warning "winget failed with exit code $LASTEXITCODE; falling back to Microsoft's MSI."
  }
}

if (-not $installed) {
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) "ArtifactSigningClientTools-$PID.msi"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/70ad2c3b-761f-4aa9-a9de-e7405aa2b4c1/ArtifactSigningClientTools.msi' -OutFile $msiPath
    Assert-MicrosoftSignedFile -Path $msiPath -Label 'Artifact Signing Client Tools MSI'
    $process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
      '/i', ('"{0}"' -f $msiPath), '/quiet', '/norestart', 'ALLUSERS=1'
    )
    if ($process.ExitCode -notin @(0, 1641, 3010)) {
      throw "Artifact Signing Client Tools MSI failed with exit code $($process.ExitCode)"
    }
    if ($process.ExitCode -in @(1641, 3010)) {
      Write-Warning 'Installation succeeded and Windows requested a restart.'
    }
  } finally {
    Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  }
}

Remove-UnsignedLegacyArtifactSigningTrees

try {
  $tools = Get-ArtifactSigningTools
} catch {
  $diag = Get-ArtifactSigningInstallDiagnostics
  throw @(
    $_.Exception.Message
    ''
    'Post-install diagnostics:'
    $diag
    ''
    'Expected signed dlib (after official install):'
    '  C:\Program Files (x86)\Microsoft\ArtifactSigningClientTools\bin\x64\Azure.CodeSigning.Dlib.dll'
    'Set AZURE_ARTIFACT_SIGNING_DLIB_PATH to that file if discovery still fails.'
  ) -join "`n"
}

Write-Host 'Artifact Signing Client Tools are ready.'
Write-Host "SignTool: $($tools.SignToolPath)"
Write-Host "Dlib: $($tools.DlibPath)"
