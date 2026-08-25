param([switch]$LoadFunctionsOnly)

$ErrorActionPreference = 'Stop'

# The uninstaller invokes the system Windows PowerShell explicitly. Load the ACL cmdlets from that
# same trusted installation instead of relying on a user-controlled PSModulePath/autoload lookup.
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -Force -ErrorAction Stop

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

function Remove-EmptyManagedParent([string]$Path, [string]$UserIdentity) {
  if (-not (Test-TrustedManagedParent $Path $UserIdentity)) { return }
  $markerPath = Join-Path $Path '.open-science-temp.json'
  $markerContents = Get-Content -LiteralPath $markerPath -Raw
  $entries = @(Get-ChildItem -LiteralPath $Path -Force)
  if ($entries.Count -ne 1 -or $entries[0].Name -ne '.open-science-temp.json') { return }
  Remove-Item -LiteralPath $markerPath -Force
  try {
    # Non-recursive removal fails safely if another app process adds a child after the empty check.
    Remove-Item -LiteralPath $Path -Force
  }
  catch {
    try {
      if (-not (Test-Path -LiteralPath $markerPath)) {
        [System.IO.File]::WriteAllText($markerPath, $markerContents)
      }
    }
    catch {}
    throw
  }
}

if ($LoadFunctionsOnly) { return }

$identityParts = @($env:USERDOMAIN, $env:USERNAME) |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$userIdentity = $identityParts -join '\'
$roots = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
[void]$roots.Add((Join-Path $env:USERPROFILE 'OpenScience\runtime'))
[void]$roots.Add((Join-Path $env:USERPROFILE '.open-science\runtime'))
$settingsPath = Join-Path $env:USERPROFILE '.open-science\settings.json'
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ([System.IO.Path]::IsPathRooted([string]$settings.dataRoot)) {
      [void]$roots.Add((Join-Path ([string]$settings.dataRoot) 'runtime'))
    }
  }
  catch {}
}

foreach ($root in $roots) {
  try {
    $canonicalRoot = Get-CanonicalPath $root
    $leaf = Get-CacheLeaf $canonicalRoot $userIdentity
    $compactLeaf = Get-CompactCacheLeaf $canonicalRoot $userIdentity
    $workingLeaf = Get-WorkingCacheLeaf $canonicalRoot $userIdentity
    $candidates = @(
      [pscustomobject]@{
        Path = (Join-Path ([System.IO.Path]::GetPathRoot($canonicalRoot)) $leaf)
        ManagedParent = $false
      }
      if (-not [string]::IsNullOrWhiteSpace($env:PUBLIC)) {
        [pscustomobject]@{ Path = (Join-Path $env:PUBLIC $leaf); ManagedParent = $false }
      }
      [pscustomobject]@{ Path = (Join-Path $env:USERPROFILE $leaf); ManagedParent = $false }
      [pscustomobject]@{ Path = (Join-Path $env:USERPROFILE $compactLeaf); ManagedParent = $false }
      $managedParents = @(
        (Join-Path ([System.IO.Path]::GetPathRoot($canonicalRoot)) 'OpenScienceTmp')
        foreach ($configuredTemp in @($env:TEMP, $env:TMP)) {
          if ($configuredTemp) {
            (Join-Path $configuredTemp 'OpenScienceTmp')
          }
        }
        (Join-Path $env:USERPROFILE 'os-tmp')
      ) | Select-Object -Unique
      foreach ($managedParent in $managedParents) {
        [pscustomobject]@{
          Path = (Join-Path $managedParent $workingLeaf)
          ManagedParent = $true
        }
      }
    ) | Select-Object -Property Path, ManagedParent -Unique
    foreach ($candidate in $candidates) {
      try {
        $candidatePath = [string]$candidate.Path
        $parent = Split-Path -Parent $candidatePath
        if ((Test-Path -LiteralPath $candidatePath) -and
            (-not $candidate.ManagedParent -or
              (Test-TrustedManagedParent $parent $userIdentity)) -and
            (Test-TrustedCache $candidatePath $canonicalRoot $userIdentity)) {
          Remove-Item -LiteralPath $candidatePath -Recurse -Force
          if ($candidate.ManagedParent) {
            Remove-EmptyManagedParent $parent $userIdentity
          }
        }
        elseif ($candidate.ManagedParent -and (Test-Path -LiteralPath $parent)) {
          # A prior cleanup may have removed the child but lost a race or lock while removing the now
          # marker-only parent. Revalidate it and retry the same non-recursive empty-parent cleanup.
          Remove-EmptyManagedParent $parent $userIdentity
        }
      }
      catch {}
    }
  }
  catch {}
}
