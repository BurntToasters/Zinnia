#requires -Version 5.1
# Registers the sparse Win11 context-menu package. Called from NSIS post-install.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$MsixPath,
  [Parameter(Mandatory = $true)][string]$ExternalLocation,
  [Parameter(Mandatory = $true)][string]$LogPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
  Write-Host $line
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
if (Test-Path -LiteralPath $LogPath) {
  Remove-Item -LiteralPath $LogPath -Force
}

try {
  if (-not (Test-Path -LiteralPath $MsixPath)) {
    throw "MSIX not found: $MsixPath"
  }
  if (-not (Test-Path -LiteralPath $ExternalLocation)) {
    throw "ExternalLocation not found: $ExternalLocation"
  }
  $dll = Join-Path $ExternalLocation 'zinnia_shell.dll'
  if (-not (Test-Path -LiteralPath $dll)) {
    throw "Shell DLL not found next to ExternalLocation: $dll"
  }

  $existing = Get-AppxPackage -Name 'run.rosie.zinnia.contextmenu' -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Log "Removing existing package $($existing.PackageFullName)"
    $existing | Remove-AppxPackage -ErrorAction Stop
  }

  Write-Log "Add-AppxPackage -Path $MsixPath -ExternalLocation $ExternalLocation"
  Add-AppxPackage -Path $MsixPath -ExternalLocation $ExternalLocation -ErrorAction Stop
  Write-Log 'OK: Win11 context menu package registered.'
  exit 0
}
catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Log ($_ | Out-String)
  Write-Host 'WARNING: Win11 context menu registration failed. Classic menu verbs still work.'
  Write-Host "See log: $LogPath"
  # Non-zero so NSIS can DetailPrint a warning; install still continues.
  exit 1
}
