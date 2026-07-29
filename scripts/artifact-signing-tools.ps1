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

function Get-ArtifactSigningKnownRootCandidates {
  @(
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:ProgramData) { Join-Path $env:ProgramData 'Microsoft\MicrosoftTrustedSigningClientTools' }),
    $(if ($env:ProgramData) { Join-Path $env:ProgramData 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:ProgramData) { Join-Path $env:ProgramData 'Microsoft\MicrosoftArtifactSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftTrustedSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftArtifactSigningClientTools' })
  ) | Where-Object { $_ } | Select-Object -Unique
}

function Get-ArtifactSigningClientRoots {
  @(Get-ArtifactSigningKnownRootCandidates) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
    Select-Object -Unique
}

function Get-ArtifactSigningExplicitCandidates {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LeafName
  )

  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($base in @(Get-ArtifactSigningKnownRootCandidates)) {
    $paths.Add((Join-Path $base "bin\x64\$LeafName")) | Out-Null
    $paths.Add((Join-Path $base "bin\x86\$LeafName")) | Out-Null
    $paths.Add((Join-Path $base "bin\$LeafName")) | Out-Null
    $paths.Add((Join-Path $base $LeafName)) | Out-Null
  }
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Get-Item -LiteralPath $path
    }
  }
}

function Find-ArtifactSigningInstalledProducts {
  $products = New-Object System.Collections.Generic.List[object]
  $uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if (-not $props) { return }
      $name = [string]$props.DisplayName
      if ($name -notmatch '(?i)(Artifact Signing|Trusted Signing).*Client Tools|Client Tools.*(Artifact Signing|Trusted Signing)') {
        return
      }
      $products.Add([PSCustomObject]@{
          DisplayName = $name
          DisplayVersion = [string]$props.DisplayVersion
          InstallLocation = [string]$props.InstallLocation
          UninstallString = [string]$props.UninstallString
          ProductCode = $_.PSChildName
        }) | Out-Null
    }
  }
  return @($products)
}

function Remove-UnsignedLegacyArtifactSigningTrees {
  $legacyRoots = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftArtifactSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftTrustedSigningClientTools' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique

  foreach ($root in $legacyRoots) {
    $dlibs = @(Get-ChildItem -LiteralPath $root -Filter 'Azure.CodeSigning.Dlib.dll' -File -Recurse -ErrorAction SilentlyContinue)
    if ($dlibs.Count -eq 0) { continue }
    $signed = @($dlibs | Where-Object { Test-MicrosoftSignedFile -Path $_.FullName })
    if ($signed.Count -gt 0) { continue }
    Write-Host "Removing unsigned Artifact Signing tree: $root"
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
  }
}

function Get-ArtifactSigningInstallDiagnostics {
  $lines = New-Object System.Collections.Generic.List[string]
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($file in @(Get-ArtifactSigningExplicitCandidates -LeafName 'Azure.CodeSigning.Dlib.dll')) {
    $paths.Add($file.FullName) | Out-Null
  }
  foreach ($root in @(Get-ArtifactSigningKnownRootCandidates)) {
    $paths.Add((Join-Path $root 'bin\x64\Azure.CodeSigning.Dlib.dll')) | Out-Null
    $paths.Add((Join-Path $root 'Azure.CodeSigning.Dlib.dll')) | Out-Null
  }
  foreach ($path in @($paths | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      $lines.Add("  missing: $path") | Out-Null
      continue
    }
    Import-BundledPowerShellSecurityModule
    $status = (Get-AuthenticodeSignature -LiteralPath $path).Status
    $lines.Add("  present ($status): $path") | Out-Null
  }
  $products = @(Find-ArtifactSigningInstalledProducts)
  if ($products.Count -eq 0) {
    $lines.Add('  registry: no Artifact/Trusted Signing Client Tools product found') | Out-Null
  } else {
    foreach ($product in $products) {
      $lines.Add(
        "  registry: $($product.DisplayName) $($product.DisplayVersion) code=$($product.ProductCode) location=$($product.InstallLocation)"
      ) | Out-Null
    }
  }
  return ($lines -join "`n")
}

function Get-ArtifactSigningInstallRank {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path -match '(?i)[\\/]Program Files( \(x86\))?[\\/]') { return 0 }
  if ($Path -match '(?i)[\\/]ProgramData[\\/]') { return 1 }
  if ($Path -match '(?i)[\\/]AppData[\\/]Local[\\/]') { return 3 }
  return 2
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
    'This usually means a manual or NuGet copy under AppData, not the official MSI. ' +
    'In an elevated PowerShell: npm run setup:win:artifact-signing:repair ' +
    '(or delete $env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools, then npm run setup:win:artifact-signing). ' +
    'Or set AZURE_ARTIFACT_SIGNING_DLIB_PATH to the signed Program Files (x86)\Microsoft\ArtifactSigningClientTools\bin\x64\Azure.CodeSigning.Dlib.dll. ' +
    "Rejected: $($rejected -join '; ')"
  )
}

function Get-ArtifactSigningFileCandidates {
  param(
    [AllowEmptyCollection()]
    [string[]]$ClientRoots = @(),
    [Parameter(Mandatory = $true)]
    [string]$LeafName
  )

  $seen = @{}
  $list = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  function Add-Candidate {
    param([System.IO.FileInfo[]]$Files)
    foreach ($file in $Files) {
      if (-not $file -or -not $file.FullName) { continue }
      if ($seen.ContainsKey($file.FullName)) { continue }
      $seen[$file.FullName] = $true
      $list.Add($file) | Out-Null
    }
  }
  Add-Candidate @(Get-ArtifactSigningExplicitCandidates -LeafName $LeafName)
  foreach ($root in @($ClientRoots)) {
    if (-not $root) { continue }
    Add-Candidate @(Get-ChildItem -LiteralPath $root -Filter $LeafName -File -Recurse -ErrorAction SilentlyContinue)
  }
  # Last-chance: MSI 1638 means a product is registered; files may live under
  # ProgramData with an older Trusted Signing layout we did not list above.
  if ($list.Count -eq 0 -and $env:ProgramData) {
    $programDataMicrosoft = Join-Path $env:ProgramData 'Microsoft'
    if (Test-Path -LiteralPath $programDataMicrosoft -PathType Container) {
      Add-Candidate @(Get-ChildItem -LiteralPath $programDataMicrosoft -Filter $LeafName -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
          $_.FullName -match '(?i)(ArtifactSigning|TrustedSigning|CodeSigning)'
        })
    }
  }
  return @($list)
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
    $dlibCandidates = @(Get-ArtifactSigningFileCandidates -ClientRoots $clientRoots -LeafName 'Azure.CodeSigning.Dlib.dll')
    if ($dlibCandidates.Count -gt 0) {
      $dlibPath = Select-MicrosoftSignedArtifactTool -Candidates $dlibCandidates -Label 'Artifact Signing dlib'
    }
  }

  if ($signToolOverride) {
    $signToolPath = $signToolOverride
  } else {
    $signToolCandidates = @(Get-ArtifactSigningFileCandidates -ClientRoots $clientRoots -LeafName 'signtool.exe')
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
    $diag = Get-ArtifactSigningInstallDiagnostics
    throw @(
      'Artifact Signing Client Tools were not found (or no Microsoft-signed dlib/signtool).'
      'Run elevated: npm run setup:win:artifact-signing:repair'
      'Expected signed dlib under Program Files (x86)\Microsoft\ArtifactSigningClientTools\ or ProgramData Trusted Signing layouts.'
      'Diagnostics:'
      $diag
    ) -join "`n"
  }
  if ($signToolPath -match '[\\/]x86[\\/]' -and $dlibPath -match '[\\/]x64[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  if ($signToolPath -match '[\\/]x64[\\/]' -and $dlibPath -match '[\\/]x86[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  Assert-MicrosoftSignedFile -Path $signToolPath -Label 'SignTool'
  Assert-MicrosoftSignedFile -Path $dlibPath -Label 'Artifact Signing dlib'
  return [PSCustomObject]@{
    SignToolPath = $signToolPath
    DlibPath = $dlibPath
  }
}
