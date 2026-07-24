$ErrorActionPreference = 'Stop'

function Get-CanonicalPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $full) {
    return (Get-Item -LiteralPath $full -Force).FullName
  }
  return $full
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

function Test-TrustedCache([string]$Path, [string]$CanonicalRoot, [string]$UserIdentity) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }

  $marker = Get-Content -LiteralPath (Join-Path $Path '.open-science-cache.json') -Raw |
    ConvertFrom-Json
  if ($marker.schema -ne 1 -or
      $marker.canonicalRoot -ne $CanonicalRoot.ToLowerInvariant() -or
      $marker.userIdentity -ne $UserIdentity) { return $false }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne $identity.User.Value) { return $false }

  $trustedWriteSids = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
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
    $candidates = @(
      (Join-Path ([System.IO.Path]::GetPathRoot($canonicalRoot)) $leaf),
      (Join-Path $env:USERPROFILE $leaf),
      (Join-Path $env:USERPROFILE $compactLeaf)
    ) | Select-Object -Unique
    foreach ($candidate in $candidates) {
      try {
        if ((Test-Path -LiteralPath $candidate) -and
            (Test-TrustedCache $candidate $canonicalRoot $userIdentity)) {
          Remove-Item -LiteralPath $candidate -Recurse -Force
        }
      }
      catch {}
    }
  }
  catch {}
}
