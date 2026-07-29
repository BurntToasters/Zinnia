Set-StrictMode -Version Latest

function Import-BundledPowerShellSecurityModule {
  $moduleManifest = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
  if (-not (Test-Path -LiteralPath $moduleManifest -PathType Leaf)) {
    throw "The bundled Microsoft.PowerShell.Security module was not found: $moduleManifest"
  }
  Import-Module -Name $moduleManifest -Force -ErrorAction Stop
}

function Test-MicrosoftSignedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  Import-BundledPowerShellSecurityModule
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    return $false
  }
  $subject = $signature.SignerCertificate.Subject
  return [bool]($subject -match '(?i)(^|,\s*)O=Microsoft Corporation(,|$)')
}

function Assert-MicrosoftSignedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  Import-BundledPowerShellSecurityModule
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$Label does not have a valid Authenticode signature: $Path ($($signature.Status))"
  }
  $subject = $signature.SignerCertificate.Subject
  if ($subject -notmatch '(?i)(^|,\s*)O=Microsoft Corporation(,|$)') {
    throw "$Label is not signed by Microsoft Corporation: $Path ($subject)"
  }
}

function Get-ArtifactSigningClientRoots {
  @(
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft\ArtifactSigningClientTools' }),
    # Official MSI / winget default (machine-wide).
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\ArtifactSigningClientTools' }),
    # Legacy / NuGet-style per-user layout (often unsigned — discovery skips those).
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftArtifactSigningClientTools' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique
}

function Get-ArtifactSigningInstallRank {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path -match '(?i)[\\/]Program Files( \(x86\))?[\\/]') { return 0 }
  if ($Path -match '(?i)[\\/]AppData[\\/]Local[\\/]') { return 2 }
  return 1
}

function Get-ArtifactSigningArchitectureRank {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path -match '[\\/]x64[\\/]') { return 0 }
  if ($Path -match '[\\/]x86[\\/]') { return 2 }
  return 1
}

function Select-MicrosoftSignedArtifactTool {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo[]]$Candidates,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [string]$PreferredArchitecture = ''
  )

  if ($Candidates.Count -eq 0) { return $null }

  $ordered = @(
    $Candidates |
      Sort-Object `
        @{ Expression = { Get-ArtifactSigningInstallRank $_.FullName } },
        @{ Expression = {
          if ($PreferredArchitecture -eq 'x86') {
            if ($_.FullName -match '[\\/]x86[\\/]') { 0 }
            elseif ($_.FullName -match '[\\/]x64[\\/]') { 2 }
            else { 1 }
          } elseif ($PreferredArchitecture -eq 'x64') {
            if ($_.FullName -match '[\\/]x64[\\/]') { 0 }
            elseif ($_.FullName -match '[\\/]x86[\\/]') { 2 }
            else { 1 }
          } else {
            Get-ArtifactSigningArchitectureRank $_.FullName
          }
        } },
        @{ Expression = { $_.FullName }; Descending = ($PreferredArchitecture -eq 'x64') }
  )

  $rejected = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in $ordered) {
    if (Test-MicrosoftSignedFile -Path $candidate.FullName) {
      return $candidate.FullName
    }
    Import-BundledPowerShellSecurityModule
    $status = (Get-AuthenticodeSignature -LiteralPath $candidate.FullName).Status
    $rejected.Add("$($candidate.FullName) ($status)") | Out-Null
  }

  throw (
    "$Label candidates were found but none have a valid Microsoft Authenticode signature. " +
    "Install the official MSI/winget package with an elevated ``npm run setup:win:artifact-signing``, " +
    "or set AZURE_ARTIFACT_SIGNING_DLIB_PATH / AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH to the signed Program Files tools. " +
    "Rejected: $($rejected -join '; ')"
  )
}

function Get-ArtifactSigningTools {
  $signToolOverride = $env:AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH
  $dlibOverride = $env:AZURE_ARTIFACT_SIGNING_DLIB_PATH
  $signToolPath = $null
  $dlibPath = $null
  if ($signToolOverride) {
    if (-not (Test-Path -LiteralPath $signToolOverride -PathType Leaf)) {
      throw "Configured SignTool was not found: $signToolOverride"
    }
    $signToolOverride = (Resolve-Path -LiteralPath $signToolOverride).Path
  }
  if ($dlibOverride) {
    if (-not (Test-Path -LiteralPath $dlibOverride -PathType Leaf)) {
      throw "Configured Artifact Signing dlib was not found: $dlibOverride"
    }
    $dlibOverride = (Resolve-Path -LiteralPath $dlibOverride).Path
  }

  $clientRoots = @(Get-ArtifactSigningClientRoots)

  if ($dlibOverride) {
    $dlibPath = $dlibOverride
  } else {
    $dlibCandidates = @(
      foreach ($root in $clientRoots) {
        Get-ChildItem -LiteralPath $root -Filter 'Azure.CodeSigning.Dlib.dll' -File -Recurse -ErrorAction SilentlyContinue
      }
    )
    if ($dlibCandidates.Count -gt 0) {
      $dlibPath = Select-MicrosoftSignedArtifactTool -Candidates $dlibCandidates -Label 'Artifact Signing dlib'
    }
  }

  if ($signToolOverride) {
    $signToolPath = $signToolOverride
  } else {
    $signToolCandidates = @(
      foreach ($root in $clientRoots) {
        Get-ChildItem -LiteralPath $root -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue
      }
    )
    if ($signToolCandidates.Count -eq 0 -and ${env:ProgramFiles(x86)}) {
      $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
      if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
        $signToolCandidates = @(
          Get-ChildItem -LiteralPath $kitsRoot -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue
        )
      }
    }
    $preferredArchitecture = if ($dlibPath -and $dlibPath -match '[\\/]x86[\\/]') { 'x86' } else { 'x64' }
    $matchingSignTools = @($signToolCandidates | Where-Object {
      if ($preferredArchitecture -eq 'x86') { $_.FullName -notmatch '[\\/]x64[\\/]' }
      else { $_.FullName -notmatch '[\\/]x86[\\/]' }
    })
    if ($matchingSignTools.Count -eq 0) {
      $matchingSignTools = @($signToolCandidates)
    }
    if ($matchingSignTools.Count -gt 0) {
      $signToolPath = Select-MicrosoftSignedArtifactTool `
        -Candidates $matchingSignTools `
        -Label 'SignTool' `
        -PreferredArchitecture $preferredArchitecture
    }
  }

  if (-not $signToolPath -or -not $dlibPath) {
    throw 'Artifact Signing Client Tools were not found. Run npm run setup:win:artifact-signing first (elevated). Expected signed tools under Program Files (x86)\Microsoft\ArtifactSigningClientTools\.'
  }
  if ($signToolPath -match '[\\/]x86[\\/]' -and $dlibPath -match '[\\/]x64[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  if ($signToolPath -match '[\\/]x64[\\/]' -and $dlibPath -match '[\\/]x86[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  # Overrides still require Microsoft Authenticode; discovery already filtered.
  Assert-MicrosoftSignedFile -Path $signToolPath -Label 'SignTool'
  Assert-MicrosoftSignedFile -Path $dlibPath -Label 'Artifact Signing dlib'
  return [PSCustomObject]@{
    SignToolPath = $signToolPath
    DlibPath = $dlibPath
  }
}
