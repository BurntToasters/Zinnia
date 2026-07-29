#requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Force
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Artifact Signing Client Tools setup must run on Windows.' }

. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')

function Install-ArtifactSigningClientToolsMsi {
  param(
    [Parameter(Mandatory = $true)]
    [string]$MsiPath,
    [switch]$Repair
  )

  Assert-MicrosoftSignedFile -Path $MsiPath -Label 'Artifact Signing Client Tools MSI'
  $args = @('/i', ('"{0}"' -f $MsiPath), '/quiet', '/norestart', 'ALLUSERS=1')
  if ($Repair) {
    $args += @('REINSTALL=ALL', 'REINSTALLMODE=vomus')
  }
  $process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList $args
  return [int]$process.ExitCode
}

function Get-ArtifactSigningToolsOrNull {
  try {
    return Get-ArtifactSigningTools
  } catch {
    return $null
  }
}

if (-not $Force) {
  $existing = Get-ArtifactSigningToolsOrNull
  if ($existing) {
    Write-Host 'Artifact Signing Client Tools are already installed.'
    Write-Host "SignTool: $($existing.SignToolPath)"
    Write-Host "Dlib: $($existing.DlibPath)"
    exit 0
  }
  Write-Host 'Artifact Signing tools are missing or not trusted.'
  Write-Host 'Installing or repairing official Microsoft Artifact Signing Client Tools...'
} else {
  Write-Host 'Force reinstall: removing legacy unsigned trees and registered products, then installing official tools...'
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

if ($Force) {
  Uninstall-ArtifactSigningClientToolsProducts
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
    # -1978335216: no applicable package / already present / source mismatch.
    Write-Warning "winget failed with exit code $LASTEXITCODE; falling back to Microsoft's MSI."
  }
}

if (-not $installed) {
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) "ArtifactSigningClientTools-$PID.msi"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/70ad2c3b-761f-4aa9-a9de-e7405aa2b4c1/ArtifactSigningClientTools.msi' -OutFile $msiPath

    $exitCode = Install-ArtifactSigningClientToolsMsi -MsiPath $msiPath
    if ($exitCode -eq 1638) {
      # ERROR_PRODUCT_VERSION: another version already installed.
      Write-Warning 'MSI exit 1638 (product already installed). Checking whether tools are discoverable...'
      $already = Get-ArtifactSigningToolsOrNull
      if ($already) {
        Write-Host 'Existing Microsoft-signed Artifact Signing tools are usable; skipping reinstall.'
        Write-Host "SignTool: $($already.SignToolPath)"
        Write-Host "Dlib: $($already.DlibPath)"
        exit 0
      }
      Write-Warning 'Tools not discoverable. Attempting MSI repair (REINSTALL=ALL)...'
      $exitCode = Install-ArtifactSigningClientToolsMsi -MsiPath $msiPath -Repair
      if ($exitCode -notin @(0, 1641, 3010)) {
        Write-Warning "Repair exited $exitCode. Uninstalling registered products, then installing fresh..."
        Uninstall-ArtifactSigningClientToolsProducts
        $exitCode = Install-ArtifactSigningClientToolsMsi -MsiPath $msiPath
      }
    }
    if ($exitCode -notin @(0, 1641, 3010)) {
      # Last chance: broken MSI state but files may still be present.
      $fallback = Get-ArtifactSigningToolsOrNull
      if ($fallback) {
        Write-Warning "MSI exited $exitCode, but discoverable Microsoft-signed tools were found; continuing."
        Write-Host "SignTool: $($fallback.SignToolPath)"
        Write-Host "Dlib: $($fallback.DlibPath)"
        exit 0
      }
      throw "Artifact Signing Client Tools MSI failed with exit code $exitCode"
    }
    if ($exitCode -in @(1641, 3010)) {
      Write-Warning 'Installation succeeded and Windows requested a restart.'
    }
  } finally {
    Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  }
}

Remove-UnsignedLegacyArtifactSigningTrees

$tools = Get-ArtifactSigningToolsOrNull
if (-not $tools) {
  $diag = Get-ArtifactSigningInstallDiagnostics
  throw @(
    'Artifact Signing Client Tools are still missing after install/repair.'
    ''
    'Post-install diagnostics:'
    $diag
    ''
    'Manual recovery:'
    '  1. Apps and Features: uninstall Artifact Signing / Trusted Signing Client Tools'
    '  2. Elevated: npm run setup:win:artifact-signing:repair'
    '  3. Or set AZURE_ARTIFACT_SIGNING_DLIB_PATH to a Microsoft-signed Azure.CodeSigning.Dlib.dll'
  ) -join "`n"
}

Write-Host 'Artifact Signing Client Tools are ready.'
Write-Host "SignTool: $($tools.SignToolPath)"
Write-Host "Dlib: $($tools.DlibPath)"
