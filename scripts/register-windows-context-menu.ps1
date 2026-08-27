#requires -Version 5.1
# Registers or unregisters both sparse Win11 context-menu packages.
# Called from NSIS post-install (register) and PREUNINSTALL (unregister).
[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Unregister')]
  [switch]$Unregister,
  [Parameter(ParameterSetName = 'Register', Mandatory = $true)][string]$MsixPath,
  [Parameter(ParameterSetName = 'Register', Mandatory = $true)][string]$ExtractMsixPath,
  [Parameter(ParameterSetName = 'Register', Mandatory = $true)][string]$ExternalLocation,
  [Parameter(ParameterSetName = 'Register', Mandatory = $true)][string]$ShellPayloadLocation,
  [Parameter(Mandatory = $true)][string]$LogPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  try {
    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8 -ErrorAction Stop
  }
  catch {
    # Logging is diagnostic only. Antivirus, an open text editor, or a stale
    # handle must not prevent package registration or its fallback cleanup.
    Write-Host "NOTICE: Could not write registration log: $($_.Exception.Message)"
  }
  Write-Host $line
}

function Find-PreviousShellPayloads([string]$CurrentLocation, [string]$InstallRoot) {
  $current = [System.IO.Path]::GetFullPath($CurrentLocation).TrimEnd('\')
  Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter 'shell-*' -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        return
      }
      $candidate = [System.IO.Path]::GetFullPath($_.FullName).TrimEnd('\')
      if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $current)) {
        return
      }
      $rootMsix = Join-Path $candidate 'ZinniaContextMenu.msix'
      $extractMsix = Join-Path $candidate 'ZinniaExtractContextMenu.msix'
      $rootDll = Join-Path $candidate 'zinnia_shell.dll'
      $extractDll = Join-Path $candidate 'zinnia_extract_shell.dll'
      if ((Test-Path -LiteralPath $rootMsix) -and (Test-Path -LiteralPath $extractMsix) -and
          (Test-Path -LiteralPath $rootDll) -and (Test-Path -LiteralPath $extractDll)) {
        return [pscustomobject]@{
          Location = $candidate
          RootMsix = $rootMsix
          ExtractMsix = $extractMsix
          SortName = $_.Name
        }
      }
    }
}

function Restore-PreviousShellPackages(
  [object]$PreviousPayload,
  [string]$ExternalLocation
) {
  if (-not $PreviousPayload) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $PreviousPayload.RootMsix) -or
      -not (Test-Path -LiteralPath $PreviousPayload.ExtractMsix)) {
    Write-Log "NOTICE: previous MSIX payloads are no longer on disk; cannot restore menus."
    return $false
  }
  Write-Log "Restoring previous packages from $($PreviousPayload.Location)"
  Add-AppxPackage -ForceUpdateFromAnyVersion -Path $PreviousPayload.RootMsix -ExternalLocation $ExternalLocation -ErrorAction Stop
  Add-AppxPackage -ForceUpdateFromAnyVersion -Path $PreviousPayload.ExtractMsix -ExternalLocation $ExternalLocation -ErrorAction Stop
  Write-Log 'OK: Restored previous Win11 context menu packages.'
  return $true
}

function Unregister-ZinniaShellPackages {
  $names = @('run.rosie.zinnia.contextmenu', 'run.rosie.zinnia.extractmenu')
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    foreach ($name in $names) {
      Get-AppxPackage -Name $name -ErrorAction SilentlyContinue |
        Remove-AppxPackage -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 1000
    $left = @()
    foreach ($name in $names) {
      $left += @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue)
    }
    if ($left.Count -eq 0) {
      Write-Log 'OK: Win11 sparse context-menu packages unregistered.'
      return
    }
    Write-Log "NOTICE: unregister attempt $($attempt + 1) still saw $(($left | ForEach-Object Name) -join ', ')"
  }
  $joined = (($left | ForEach-Object Name) -join ', ')
  throw "Zinnia AppX packages still registered after uninstall: $joined"
}

function Remove-StaleShellPayloads([string]$CurrentLocation) {
  $current = [System.IO.Path]::GetFullPath($CurrentLocation).TrimEnd('\')
  $installRoot = Split-Path -Parent $current
  $payloadFiles = @(
    'zinnia_shell.dll',
    'zinnia_extract_shell.dll',
    'ZinniaContextMenu.msix',
    'ZinniaExtractContextMenu.msix',
    'register-windows-context-menu.ps1'
  )
  Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'shell-*' -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Log "NOTICE: refusing to clean reparse-point shell directory: $($_.FullName)"
        return
      }
      $candidate = [System.IO.Path]::GetFullPath($_.FullName).TrimEnd('\')
      if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $current)) {
        return
      }
      $incomplete = $false
      foreach ($filename in $payloadFiles) {
        $file = Join-Path $candidate $filename
        if (-not (Test-Path -LiteralPath $file)) {
          continue
        }
        try {
          Remove-Item -LiteralPath $file -Force -ErrorAction Stop
        }
        catch {
          $incomplete = $true
        }
      }
      try {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction Stop
      }
      catch {
        $incomplete = $true
      }
      if ($incomplete) {
        # Explorer/dllhost may still have a DLL mapped, or the directory may
        # contain an unknown file. NSIS only schedules known payload files and
        # the empty directory, so unrelated content is never removed.
        Write-Log "NOTICE: stale shell payload was not fully removed; scheduling installer cleanup: $candidate"
      }
      else {
        Write-Log "Removed stale shell payload: $candidate"
      }
    }
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) -ErrorAction Stop | Out-Null
  if (Test-Path -LiteralPath $LogPath) {
    Remove-Item -LiteralPath $LogPath -Force -ErrorAction Stop
  }
}
catch {
  Write-Host "NOTICE: Could not reset registration log: $($_.Exception.Message)"
}

try {
  if ($Unregister) {
    Unregister-ZinniaShellPackages
    exit 0
  }

  $previousPayload = $null
  if (-not (Test-Path -LiteralPath $MsixPath)) {
    throw "MSIX not found: $MsixPath"
  }
  if (-not (Test-Path -LiteralPath $ExtractMsixPath)) {
    throw "Extract MSIX not found: $ExtractMsixPath"
  }
  if (-not (Test-Path -LiteralPath $ExternalLocation)) {
    throw "ExternalLocation not found: $ExternalLocation"
  }
  $appExecutable = Join-Path $ExternalLocation 'zinnia.exe'
  if (-not (Test-Path -LiteralPath $appExecutable)) {
    throw "Application executable not found in ExternalLocation: $appExecutable"
  }
  if (-not (Test-Path -LiteralPath $ShellPayloadLocation)) {
    throw "ShellPayloadLocation not found: $ShellPayloadLocation"
  }
  $externalRoot = [System.IO.Path]::GetFullPath($ExternalLocation).TrimEnd('\')
  $shellLocation = [System.IO.Path]::GetFullPath($ShellPayloadLocation).TrimEnd('\')
  $shellRoot = Split-Path -Parent $shellLocation
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($externalRoot, $shellRoot)) {
    throw "ShellPayloadLocation must be directly below ExternalLocation."
  }
  if ((Split-Path -Leaf $shellLocation) -notlike 'shell-*') {
    throw "ShellPayloadLocation must use a shell-* directory."
  }
  $shellItem = Get-Item -LiteralPath $ShellPayloadLocation -Force -ErrorAction Stop
  if ($shellItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "ShellPayloadLocation must not be a reparse point."
  }
  $dll = Join-Path $ShellPayloadLocation 'zinnia_shell.dll'
  if (-not (Test-Path -LiteralPath $dll)) {
    throw "Shell DLL not found in ShellPayloadLocation: $dll"
  }
  $extractDll = Join-Path $ShellPayloadLocation 'zinnia_extract_shell.dll'
  if (-not (Test-Path -LiteralPath $extractDll)) {
    throw "Extract shell DLL not found in ShellPayloadLocation: $extractDll"
  }

  $previousPayload = Find-PreviousShellPayloads -CurrentLocation $ShellPayloadLocation -InstallRoot $externalRoot |
    Sort-Object -Property SortName -Descending |
    Select-Object -First 1

  Write-Log "Add-AppxPackage -ForceUpdateFromAnyVersion -Path $MsixPath -ExternalLocation $ExternalLocation"
  Add-AppxPackage -ForceUpdateFromAnyVersion -Path $MsixPath -ExternalLocation $ExternalLocation -ErrorAction Stop
  Write-Log "Add-AppxPackage -ForceUpdateFromAnyVersion -Path $ExtractMsixPath -ExternalLocation $ExternalLocation"
  Add-AppxPackage -ForceUpdateFromAnyVersion -Path $ExtractMsixPath -ExternalLocation $ExternalLocation -ErrorAction Stop
  Write-Log 'OK: Win11 context menu packages registered.'
  try {
    Remove-StaleShellPayloads -CurrentLocation $ShellPayloadLocation
  }
  catch {
    # Registration is already complete. NSIS performs the same allowlisted
    # cleanup with /REBOOTOK, so cleanup failure must not remove valid packages.
    Write-Log "NOTICE: Cleanup of stale shell payloads was deferred: $($_.Exception.Message)"
  }
  exit 0
}
catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Log ($_ | Out-String)
  if (-not $Unregister -and $previousPayload) {
    try {
      $null = Restore-PreviousShellPackages -PreviousPayload $previousPayload -ExternalLocation $ExternalLocation
    }
    catch {
      Write-Log "ERROR: Could not restore previous Win11 context menu packages: $($_.Exception.Message)"
    }
  }
  if ($Unregister) {
    Write-Host "ERROR: Could not unregister Win11 context-menu packages. See log: $LogPath"
    exit 1
  }
  Write-Host 'WARNING: Win11 context menu registration failed. Classic menu verbs still work.'
  Write-Host "See log: $LogPath"
  # Non-zero so NSIS can DetailPrint a warning; install still continues.
  exit 1
}
