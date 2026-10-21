param(
  [Parameter(Mandatory = $true)][ValidateSet('prepare', 'publish', 'cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallPath,
  [Parameter(Mandatory = $true)][string]$StatePath
)

# This script is embedded in the signed installer and runs only for that installer. Its state
# lives in NSIS's private plugin directory, not in the installed application or user profile.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Unicode NSIS nsExec detects UTF-16LE. The default console code page loses profile characters.
[Console]::OutputEncoding = [Text.Encoding]::Unicode
$handles = [Collections.Generic.List[IDisposable]]::new()
$stageHandle = $null
$createdStage = $null



function Get-Descriptor([string]$Path, [bool]$Directory) {
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access, Owner, Group')
}

function Assert-OrdinaryTree([string]$Path, [bool]$CheckPermissions, $State) {
  $Path = '\\?\' + $Path
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in payload: $entry" }
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      if ($CheckPermissions) {
        $expected = if ($isDirectory) { $State.directoryAcl } else { $State.fileAcl }
        if ((Get-Descriptor $entry $isDirectory) -cne $expected) { throw "Unexpected payload permissions: $entry" }
      }
      if ($isDirectory) { $pending.Push($entry) }
    }
  }
}


try {
  # Load the installer-owned assembly; runtime compilation breaks under Unicode TEMP paths.
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  $root = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
  if ($root -notmatch '^[A-Za-z]:\\.+' -or $root.Contains('"')) { throw 'Expected a local installation directory, not a volume root or UNC path' }
  $ancestors = [Collections.Generic.Stack[string]]::new()
  for ($path = $root; $path; $path = [IO.Path]::GetDirectoryName($path)) { $ancestors.Push($path) }
  while ($ancestors.Count -gt 0) { $handles.Add([InstallDirectory]::Hold($ancestors.Pop())) }
  $rootHandle = $handles[$handles.Count - 1]

  if ($Action -eq 'prepare') {
    if ([IO.File]::Exists($StatePath)) { throw 'Publication state already exists' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $acl = [IO.Directory]::GetAccessControl($root)
    $useMove = !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value
    # A nested staging directory must not change how permissions propagate. Unusual ACLs keep
    # the existing copy path; never rewrite a user's ACL to make the optimization eligible.
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { $useMove = $false }
    }
    foreach ($name in @('resources', 'locales')) {
      if (Test-Path -LiteralPath ([IO.Path]::Combine($root, $name))) { $useMove = $false }
    }
    $stageParent = if ($useMove) { $root } else { [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($StatePath)) }
    # NSIS already gives each installer a private plugin directory. Keep the upstream short
    # fallback leaf: lengthening it can break CopyFiles even when the final path is supported.
    $stageName = if ($useMove) { '.open-science-install-' + [Guid]::NewGuid().ToString('N') } else { '7z-out' }
    $stage = [IO.Path]::Combine($stageParent, $stageName)
    [InstallDirectory]::Create($stage)
    $createdStage = $stage
    $stageHandle = [InstallDirectory]::Hold($stage)
    $reference = [IO.Path]::Combine($root, '.open-science-acl-' + [Guid]::NewGuid().ToString('N'))
    $referenceCreated = $false
    try {
      $file = [IO.File]::Open($reference, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $referenceCreated = $true
      $file.Dispose()
      $state = [ordered]@{
        root = $root; rootIdentity = [InstallDirectory]::Identity($rootHandle); rootAcl = Get-Descriptor $root $true
        stage = $stage; stageIdentity = [InstallDirectory]::Identity($stageHandle)
        directoryAcl = Get-Descriptor $stage $true; fileAcl = Get-Descriptor $reference $false
        useMove = $useMove
      }
      $json = $state | ConvertTo-Json -Compress
      $stream = [IO.File]::Open($StatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    } finally { if ($referenceCreated) { [IO.File]::Delete($reference) } }
    [Console]::Out.Write($stage)
    exit 0
  }

  $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  if ($state.root -ine $root -or $state.rootIdentity -ne [InstallDirectory]::Identity($rootHandle)) { throw 'Installation identity changed' }
  if ($Action -eq 'publish' -and $state.rootAcl -cne (Get-Descriptor $root $true)) { throw 'Installation permissions changed' }
  $stage = [IO.Path]::GetFullPath($state.stage)
  $stageParent = if ($state.useMove) { $root } else { [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($StatePath)) }
  $validName = if ($state.useMove) { [IO.Path]::GetFileName($stage) -match '^\.open-science-install-[a-f0-9]{32}$' } else { [IO.Path]::GetFileName($stage) -ceq '7z-out' }
  if ([IO.Path]::GetDirectoryName($stage) -ine $stageParent -or !$validName) { throw 'Invalid staging path' }
  $stageHandle = [InstallDirectory]::Hold($stage)
  if ($state.stageIdentity -ne [InstallDirectory]::Identity($stageHandle)) { throw 'Staging identity changed' }
  if ($Action -eq 'publish' -and $state.directoryAcl -cne (Get-Descriptor $stage $true)) { throw 'Staging permissions changed' }
  Assert-OrdinaryTree $stage ($Action -eq 'publish' -and $state.useMove) $state

  if ($Action -eq 'publish') {
    if (!$state.useMove) { exit 0 }
    # Validate the entire extracted payload before the first move. Move only absent top-level
    # directories. A later error leaves the remaining source intact for NSIS retry or cleanup.
    foreach ($name in @('resources', 'locales')) {
      $source = [IO.Path]::Combine($stage, $name)
      if (![IO.Directory]::Exists($source)) { continue }
      $destination = [IO.Path]::Combine($root, $name)
      if (Test-Path -LiteralPath $destination) { throw "Publication destination already exists: $destination" }
      [IO.Directory]::Move($source, $destination)
      [Console]::Out.WriteLine("Published $name by directory move")
    }
  } else {
    # Only this installer's identity-checked directory is eligible for deletion. Never sweep
    # a previous installer's staging by prefix, and never follow reparse points while cleaning.
    $stageHandle.Dispose()
    $stageHandle = $null
    [IO.Directory]::Delete(('\\?\' + $stage), $true)
    [IO.File]::Delete($StatePath)
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  if ($createdStage -and ![IO.File]::Exists($StatePath)) {
    if ($null -ne $stageHandle) { $stageHandle.Dispose(); $stageHandle = $null }
    # Preparation has not extracted anything. Only remove this empty, exclusively created
    # directory; an unexpected entry keeps it on disk instead of being recursively erased.
    try { [IO.Directory]::Delete($createdStage, $false) } catch { [Console]::Error.WriteLine($_.Exception.ToString()) }
  }
  exit 20
} finally {
  if ($null -ne $stageHandle) { $stageHandle.Dispose() }
  for ($i = $handles.Count - 1; $i -ge 0; $i--) { $handles[$i].Dispose() }
}
