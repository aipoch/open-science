#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Preview,
  [string]$DataRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force

# CACHE OWNERSHIP FUNCTIONS BEGIN
function Get-CanonicalPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $full) {
    return (Get-Item -LiteralPath $full -Force).FullName
  }
  return $full
}

function Test-NoReparsePointInPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) { return $false }
  $current = $root
  $relative = $full.Substring($root.Length)
  foreach ($segment in $relative.Split(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
    $current = Join-Path $current $segment
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      return $false
    }
  }
  return $true
}

function Get-CacheLeaf([string]$RuntimeRoot, [string]$UserIdentity) {
  $key = $UserIdentity.ToLowerInvariant() + [char]0 + $RuntimeRoot.ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($key)
    $hex = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    return 'osp' + $hex.Substring(0, 10)
  }
  finally {
    $sha.Dispose()
  }
}

function Get-CompactCacheLeaf([string]$RuntimeRoot, [string]$UserIdentity) {
  $key = $UserIdentity.ToLowerInvariant() + [char]0 + $RuntimeRoot.ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($key)
    $digest = $sha.ComputeHash($bytes)
    $alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
    $encoded = ''
    $value = 0
    $bits = 0
    foreach ($byte in $digest[0..4]) {
      $value = ($value -shl 8) -bor $byte
      $bits += 8
      while ($bits -ge 5) {
        $bits -= 5
        $encoded += $alphabet[($value -shr $bits) -band 31]
        $value = $value -band ((1 -shl $bits) - 1)
      }
    }
    return 'os' + $encoded
  }
  finally {
    $sha.Dispose()
  }
}

function Get-WorkingCacheLeaf([string]$RuntimeRoot, [string]$UserIdentity) {
  $key = $UserIdentity.ToLowerInvariant() + [char]0 + $RuntimeRoot.ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($key)
    $digest = $sha.ComputeHash($bytes)
    $alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
    $encoded = ''
    $value = 0
    $bits = 0
    foreach ($byte in $digest[0..4]) {
      $value = ($value -shl 8) -bor $byte
      $bits += 8
      while ($bits -ge 5) {
        $bits -= 5
        $encoded += $alphabet[($value -shr $bits) -band 31]
        $value = $value -band ((1 -shl $bits) - 1)
      }
    }
    return 'm-' + $encoded
  }
  finally {
    $sha.Dispose()
  }
}

function Test-TrustedAcl([string]$Path) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  $trustedOwnerSids = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($trustedOwnerSids -notcontains $ownerSid) { return $false }

  $trustedWriteSids = @($trustedOwnerSids + 'S-1-3-0')
  # Keep this complete dangerous-rights set in sync with micromamba-cache.ts. A foreign principal
  # with any of these rights can replace content or grant itself full control.
  $writeMask = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl -bor
    [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -eq 'Allow' -and
        $trustedWriteSids -notcontains $sid -and
        ($rule.FileSystemRights -band $writeMask) -ne 0) { return $false }
  }
  return $true
}

function Test-TrustedCache([string]$Path, [string]$CanonicalRoot, [string]$UserIdentity) {
  if (-not (Test-NoReparsePointInPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }

  $marker = Get-Content -LiteralPath (Join-Path $Path '.open-science-cache.json') -Raw |
    ConvertFrom-Json
  if ($marker.schema -ne 1 -or
      $marker.canonicalRoot -ne $CanonicalRoot.ToLowerInvariant() -or
      $marker.userIdentity -ne $UserIdentity) { return $false }

  return (Test-TrustedAcl $Path)
}

function Test-TrustedManagedParent([string]$Path, [string]$UserIdentity) {
  if (-not (Test-NoReparsePointInPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }

  $marker = Get-Content -LiteralPath (Join-Path $Path '.open-science-temp.json') -Raw |
    ConvertFrom-Json
  if ($marker.schema -ne 1 -or
      $marker.kind -ne 'micromamba-working-cache-parent' -or
      $marker.userIdentity -ne $UserIdentity) { return $false }
  return (Test-TrustedAcl $Path)
}
# CACHE OWNERSHIP FUNCTIONS END

function Get-ResetCacheIdentity {
  # Match cache creation and the installer; the OS identity is only used for ACL checks.
  $parts = @($env:USERDOMAIN, $env:USERNAME) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  return $parts -join '\'
}

function Get-ResetPath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw "A local absolute path is required: $Path" }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-Within([string]$Parent, [string]$Child) {
  return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
    $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ResetTarget([string]$Path, [string]$Profile) {
  $full = Get-ResetPath $Path
  $protected = @($Profile, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)
  if ($full.Length -le 3) { throw "Refusing a drive root: $full" }
  foreach ($boundary in $protected) {
    if (-not $boundary) { continue }
    $boundary = Get-ResetPath $boundary
    if ((Test-Within $full $boundary) -or
        ($boundary -ne $Profile -and (Test-Within $boundary $full))) {
      throw "Refusing a protected path: $full"
    }
  }
  if (Test-Within $full $PSCommandPath) { throw 'Move the reset scripts outside the folders being removed.' }
  # Check every existing ancestor, including junctions and redirected profile directories.
  $cursor = $full
  while ($cursor) {
    $item = $null
    if (Test-Path -LiteralPath $cursor) { $item = Get-Item -LiteralPath $cursor -Force }
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "A target or ancestor is a reparse point: $cursor"
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if (Test-Path -LiteralPath $full) {
    if (-not (Get-Item -LiteralPath $full -Force).PSIsContainer) { throw "Not a directory: $full" }
  }
  return $full
}

function Get-ResetCacheCandidates([string]$Runtime, [string]$Identity, [string]$Profile,
    [string]$PublicRoot, [string[]]$TempRoots) {
  $leaf = Get-CacheLeaf $Runtime $Identity
  $compact = Get-CompactCacheLeaf $Runtime $Identity
  $working = Get-WorkingCacheLeaf $Runtime $Identity
  @(
    (Join-Path ([IO.Path]::GetPathRoot($Runtime)) $leaf)
    if ($PublicRoot) { Join-Path $PublicRoot $leaf }
    (Join-Path $Profile $leaf)
    (Join-Path $Profile $compact)
  ) | ForEach-Object { [pscustomobject]@{ Path = $_; ManagedParent = $false } }
  $parents = @(
    (Join-Path $Profile 'os-tmp')
    foreach ($name in @('Open-ScienceTmp', 'OpenScienceTmp')) {
      Join-Path ([IO.Path]::GetPathRoot($Runtime)) $name
      foreach ($tempRoot in $TempRoots) {
        if ($tempRoot) { Join-Path $tempRoot $name }
      }
    }
  ) | Select-Object -Unique
  foreach ($parent in $parents) {
    [pscustomobject]@{ Path = (Join-Path $parent $working); ManagedParent = $true }
  }
}

function Get-ResetPlan([string]$Profile, [string]$AppData, [string]$ExplicitDataRoot,
    [string]$Identity, [string]$PublicRoot, [string[]]$TempRoots) {
  $Profile = Get-ResetPath $Profile
  $config = Assert-ResetTarget (Join-Path $Profile '.open-science') $Profile
  $defaults = @('Open-Science', 'OpenScience') | ForEach-Object {
    Assert-ResetTarget (Join-Path $Profile $_) $Profile
  }
  $electronProfiles = @('Open-Science', 'Open Science') | ForEach-Object {
    Assert-ResetTarget (Join-Path $AppData $_) $Profile
  }
  $settingsPath = Join-Path $config 'settings.json'
  $selected = $null
  if ($ExplicitDataRoot) {
    $selected = $ExplicitDataRoot
  }
  elseif (Test-Path -LiteralPath $config) {
    # Crash-recovery candidates may contain a newer custom root. Do not guess which won.
    if (@(Get-ChildItem -LiteralPath $config -Filter 'settings.json.*.tmp' -Force).Count) {
      throw 'Settings recovery files exist. Review the data location and supply -DataRoot explicitly.'
    }
    if (Test-Path -LiteralPath $settingsPath) {
      $file = Get-Item -LiteralPath $settingsPath -Force
      if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Settings is a reparse point.' }
      if ($file.Length -gt 16MB) { throw 'Settings is too large. Review the data location and supply -DataRoot.' }
      try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $settings -or $settings -isnot [pscustomobject] -or
            ($null -ne $settings.dataRoot -and $settings.dataRoot -isnot [string])) {
          throw 'Invalid settings object.'
        }
        $selected = $settings.dataRoot
      }
      catch { throw 'Cannot read settings. Review the data location and supply -DataRoot explicitly.' }
    }
  }
  $dataRoots = @($defaults) + @($config)
  if ($selected) {
    $selected = Assert-ResetTarget $selected $Profile
    if ($selected -ne $config -and @('Open-Science', 'OpenScience') -notcontains [IO.Path]::GetFileName($selected)) {
      throw 'Custom data must be an Open-Science or legacy OpenScience folder. Nonstandard historical paths require manual review.'
    }
    $dataRoots += $selected
  }
  $dataRoots = @($dataRoots | Select-Object -Unique)
  $targets = @()
  foreach ($root in $dataRoots) {
    $runtime = Get-CanonicalPath (Join-Path $root 'runtime')
    foreach ($candidate in (Get-ResetCacheCandidates $runtime $Identity $Profile $PublicRoot $TempRoots)) {
      if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
      $cache = Assert-ResetTarget $candidate.Path $Profile
      if (($candidate.ManagedParent -and
          -not (Test-TrustedManagedParent (Split-Path $cache -Parent) $Identity)) -or
          -not (Test-TrustedCache $cache $runtime $Identity)) {
        throw "Cache ownership could not be verified; nothing was removed: $cache"
      }
      $targets += [pscustomobject]@{ Path = $cache; Kind = 'Managed cache'; Runtime = $runtime }
    }
  }
  foreach ($root in $dataRoots) {
    if ($root -ne $config) {
      $targets += [pscustomobject]@{ Path = $root; Kind = 'Data and runtime'; Runtime = $null }
    }
  }
  foreach ($electron in $electronProfiles) {
    $targets += [pscustomobject]@{ Path = $electron; Kind = 'Electron profile'; Runtime = $null }
  }
  # Configuration is last, so a failed data/cache deletion retains custom-root discovery metadata.
  $targets += [pscustomobject]@{ Path = $config; Kind = 'Configuration and legacy data'; Runtime = $null }
  return @($targets | Sort-Object -Property Path -Unique | Sort-Object { $_.Path -eq $config })
}

function Assert-OpenScienceStopped($Plan) {
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  if (-not $processes.Count) { throw 'Process inspection returned no results; cleanup is blocked.' }
  # Parent shells carry -DataRoot in their command line. Exempt only this reset's
  # observed ancestor chain, not arbitrary shells that may be running Notebook work.
  $ancestors = [Collections.Generic.HashSet[uint32]]::new()
  $cursor = $processes | Where-Object { $_.ProcessId -eq $PID } | Select-Object -First 1
  while ($cursor -and $cursor.ParentProcessId -and $ancestors.Add([uint32]$cursor.ParentProcessId)) {
    $parentId = $cursor.ParentProcessId
    $cursor = $processes | Where-Object { $_.ProcessId -eq $parentId } | Select-Object -First 1
  }
  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    $name = [string]$process.Name
    $path = [string]$process.ExecutablePath
    $command = [string]$process.CommandLine
    if ($ancestors.Contains([uint32]$process.ProcessId) -and $path -and
        $name -match '^(cmd|powershell|pwsh)\.exe$') { continue }
    $blocked = $name -match '^(open-science|notebook-appcontainer-host|wsl)\.exe$'
    $runtimeProcess = $name -match '^(electron|node|pythonw?|python[0-9.]+|R|Rscript|Rterm|micromamba(-compat)?|claude|codex|opencode|codebuddy)\.exe$'
    if ($runtimeProcess -and (-not $path -or -not $command)) { $blocked = $true }
    if ($runtimeProcess -and ($path -match '(?i)[\\/]open[- ]science[\\/]' -or
        $command -match '(?i)open-science|notebook-appcontainer-host')) { $blocked = $true }
    foreach ($target in $Plan) {
      if (($path -and (Test-Within $target.Path $path)) -or
          ($command -and $command.IndexOf($target.Path, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        $blocked = $true
      }
    }
    if ($blocked) { throw "Close Open-Science and its runtime processes, then retry. Detected: $name (PID $($process.ProcessId))." }
  }
}

function Remove-ResetTree([string]$Path, [string]$Boundary) {
  $full = Get-ResetPath $Path
  if (-not (Test-Within $Boundary $full)) { throw "Deletion escaped its approved target: $full" }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # Unlink only. Never recurse through a junction or symbolic link into external project files.
    if ($item.PSIsContainer) { [IO.Directory]::Delete($full) }
    else { [IO.File]::Delete($full) }
    return
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
    # Materialized Skills are intentionally read-only. Clear only that attribute before removing
    # the owned tree; preserve hidden/system flags until the node itself is deleted.
    [IO.File]::SetAttributes(
      $full,
      $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    )
  }
  if ($item.PSIsContainer) {
    # Retain settings until other children succeed, including in the legacy configuration root.
    $children = @(Get-ChildItem -LiteralPath $full -Force | Sort-Object { $_.Name -like 'settings.json*' })
    foreach ($child in $children) { Remove-ResetTree $child.FullName $Boundary }
    [IO.Directory]::Delete($full)
  }
  else { Remove-Item -LiteralPath $full -Force -ErrorAction Stop }
}

function Invoke-Reset($Plan, [string]$Profile, [string]$Identity, [switch]$PreviewOnly) {
  Assert-OpenScienceStopped $Plan
  Write-Host 'Open-Science - reset all local application data'
  Write-Host 'This permanently deletes settings, conversations, managed files, models and runtimes.'
  Write-Host 'Back up needed files first. Keep Open-Science closed throughout this operation.'
  Write-Host 'External projects/runtimes and Windows sandbox ownership records are preserved.'
  Write-Host ''
  foreach ($target in $Plan) {
    $exists = Test-Path -LiteralPath $target.Path
    Write-Host ("[{0}] {1}: {2}" -f $(if ($exists) { 'DELETE' } else { 'absent' }), $target.Kind, $target.Path)
  }
  if ($PreviewOnly) { Write-Host 'Preview only. Nothing was removed.'; return }
  Write-Host ''
  if ((Read-Host 'Type RESET OPEN-SCIENCE to permanently delete the listed data') -cne 'RESET OPEN-SCIENCE') {
    Write-Host 'Cancelled. Nothing was removed.'
    return
  }
  foreach ($target in $Plan) {
    Assert-OpenScienceStopped $Plan
    $path = Assert-ResetTarget $target.Path $Profile
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ($target.Runtime -and -not (Test-TrustedCache $path $target.Runtime $Identity)) {
      throw "Cache ownership changed; cleanup stopped: $path"
    }
    Write-Host "Removing: $path"
    Remove-ResetTree $path $path
    if (Test-Path -LiteralPath $path) { throw "Directory remains: $path" }
  }
  Write-Host 'Reset completed. Start Open-Science and configure it again. Managed runtimes will need installation.'
}

# Dot-sourcing exposes the same functions to isolated fixture tests without running a reset.
if ($MyInvocation.InvocationName -eq '.') { return }
try {
  $profilePath = [Environment]::GetFolderPath('UserProfile')
  $appDataPath = [Environment]::GetFolderPath('ApplicationData')
  $identity = Get-ResetCacheIdentity
  $plan = @(Get-ResetPlan $profilePath $appDataPath $DataRoot $identity $env:PUBLIC @($env:TEMP, $env:TMP))
  Invoke-Reset $plan $profilePath $identity -PreviewOnly:$Preview
  exit 0
}
catch {
  [Console]::Error.WriteLine('Reset stopped: ' + $_.Exception.Message)
  [Console]::Error.WriteLine('Cleanup may be incomplete if deletion already started. Resolve the error and retry.')
  exit 1
}
