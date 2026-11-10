param(
  [Parameter(Mandatory = $true)][ValidateSet('prepare', 'publish', 'cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallPath,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$ReportPath
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
$preparationCleanupErrors = @()
$diagnosticOperation = 'load-publication-helper'
$diagnosticPath = Join-Path $PSScriptRoot 'windows-install-publication.dll'

function Get-PublicationError([Exception]$Error) {
  $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult), 0)
  [ordered]@{
    operation = $(if ($Error.Data.Contains('operation')) { $Error.Data['operation'] } else { $script:diagnosticOperation })
    path = $(if ($Error.Data.Contains('path')) { $Error.Data['path'] } else { $script:diagnosticPath })
    exceptionType = $Error.GetType().FullName; message = $Error.Message
    hresult = ('0x{0:X8}' -f $hresult)
    nativeErrorCode = $(if ($Error -is [ComponentModel.Win32Exception]) { $Error.NativeErrorCode } else { $null })
    # Managed filesystem exceptions retain the HRESULT supplied by Windows. Preserve this
    # separately from a real Win32Exception, never infer it from a tool/process exit status.
    windowsErrorCode = $(if (($Error -is [IO.IOException] -or $Error -is [UnauthorizedAccessException]) -and ($hresult -band 0xFFFF0000L) -eq 0x80070000L) { $hresult -band 0xFFFF } else { $null })
  }
  if ($Error -is [AggregateException]) {
    foreach ($inner in $Error.InnerExceptions) { Get-PublicationError $inner }
  } elseif ($Error.InnerException) { Get-PublicationError $Error.InnerException }
}

function Write-PublicationReport($Errors, [string]$Status = 'failed', $PreparationCleanupErrors = @()) {
  if (!$ReportPath) { return }
  try {
    $phase = switch ($Action) { 'prepare' { 'prepare-new-program-files' }; 'publish' { 'publish-new-program-files' }; default { 'cleanup-payload-staging' } }
    $report = [ordered]@{
      timestamp = [DateTime]::UtcNow.ToString('o'); phase = $phase; status = $Status
      errorSource = 'publication-helper'; errors = @($Errors)
      preparationCleanupErrors = @($PreparationCleanupErrors)
    }
    [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
  } catch { [Console]::Error.WriteLine("Could not save publication diagnostic: $($_.Exception.Message)") }
}



function Get-Descriptor([string]$Path, [bool]$Directory) {
  $script:diagnosticOperation = 'read-permissions'; $script:diagnosticPath = $Path
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access, Owner, Group')
}

function Assert-OrdinaryTree([string]$Path, [bool]$CheckPermissions, $State, [bool]$CheckDestination) {
  $Path = '\\?\' + $Path
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $script:diagnosticOperation = 'enumerate-payload'; $script:diagnosticPath = $directory
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $script:diagnosticOperation = 'validate-payload-entry'; $script:diagnosticPath = $entry
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in payload: $entry" }
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      if ($CheckDestination) {
        # Robocopy excludes junctions, including destination entries. Reject overlapping links
        # before copying so a skipped payload cannot be reported as a successful installation.
        # Inspect only payload destinations; unrelated user-data trees remain untouched.
        $destination = '\\?\' + $State.root + $entry.Substring($Path.Length)
        $script:diagnosticOperation = 'validate-payload-destination'; $script:diagnosticPath = $destination
        try {
          $targetAttributes = [IO.File]::GetAttributes($destination)
          if (($targetAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point at payload destination: $destination" }
        } catch [IO.FileNotFoundException] {
          # The copy will create this file under the destination's existing permissions.
        } catch [IO.DirectoryNotFoundException] {
          # An absent parent will be created by the copy as well.
        }
      }
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
  $diagnosticOperation = 'validate-install-path'; $diagnosticPath = $InstallPath
  $root = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
  $diagnosticOperation = 'validate-install-path'; $diagnosticPath = $root
  if ($root -notmatch '^[A-Za-z]:\\.+' -or $root.Contains('"')) { throw 'Expected a local installation directory, not a volume root or UNC path' }
  $ancestors = [Collections.Generic.Stack[string]]::new()
  for ($path = $root; $path; $path = [IO.Path]::GetDirectoryName($path)) { $ancestors.Push($path) }
  while ($ancestors.Count -gt 0) {
    $diagnosticOperation = 'hold-install-directory'; $diagnosticPath = $ancestors.Pop()
    $handles.Add([InstallDirectory]::Hold($diagnosticPath))
  }
  $rootHandle = $handles[$handles.Count - 1]

  if ($Action -eq 'prepare') {
    $diagnosticOperation = 'create-publication-state'; $diagnosticPath = $StatePath
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
    $diagnosticOperation = 'create-payload-staging'; $diagnosticPath = $stage
    [InstallDirectory]::Create($stage)
    $createdStage = $stage
    $stageHandle = [InstallDirectory]::Hold($stage)
    $reference = [IO.Path]::Combine($root, '.open-science-acl-' + [Guid]::NewGuid().ToString('N'))
    $referenceCreated = $false
    $referenceFailure = $null
    try {
      $diagnosticOperation = 'create-permission-reference'; $diagnosticPath = $reference
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
      $diagnosticOperation = 'write-publication-state'; $diagnosticPath = $StatePath
      $stream = [IO.File]::Open($StatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    } catch {
      $referenceFailure = $_
      throw
    } finally {
      if ($referenceCreated) {
        try { [IO.File]::Delete($reference) } catch {
          $_.Exception.Data['operation'] = 'remove-permission-reference'
          $_.Exception.Data['path'] = $reference
          if ($referenceFailure) { $preparationCleanupErrors += @(Get-PublicationError $_.Exception) } else { throw }
        }
      }
    }
    [Console]::Out.Write($stage)
    exit 0
  }

  $diagnosticOperation = 'read-publication-state'; $diagnosticPath = $StatePath
  $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  $diagnosticOperation = 'validate-install-identity'; $diagnosticPath = $root
  if ($state.root -ine $root -or $state.rootIdentity -ne [InstallDirectory]::Identity($rootHandle)) { throw 'Installation identity changed' }
  if ($Action -eq 'publish' -and $state.rootAcl -cne (Get-Descriptor $root $true)) { throw 'Installation permissions changed' }
  $stage = [IO.Path]::GetFullPath($state.stage)
  $diagnosticOperation = 'validate-payload-staging'; $diagnosticPath = $stage
  $stageParent = if ($state.useMove) { $root } else { [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($StatePath)) }
  $validName = if ($state.useMove) { [IO.Path]::GetFileName($stage) -match '^\.open-science-install-[a-f0-9]{32}$' } else { [IO.Path]::GetFileName($stage) -ceq '7z-out' }
  if ([IO.Path]::GetDirectoryName($stage) -ine $stageParent -or !$validName) { throw 'Invalid staging path' }
  $stageHandle = [InstallDirectory]::Hold($stage)
  if ($state.stageIdentity -ne [InstallDirectory]::Identity($stageHandle)) { throw 'Staging identity changed' }
  if ($Action -eq 'publish' -and $state.directoryAcl -cne (Get-Descriptor $stage $true)) { throw 'Staging permissions changed' }
  Assert-OrdinaryTree $stage ($Action -eq 'publish' -and $state.useMove) $state ($Action -eq 'publish')

  if ($Action -eq 'publish') {
    if (!$state.useMove) { exit 0 }
    # Validate the entire extracted payload before the first move. Move only absent top-level
    # directories. A later error leaves the remaining source intact for NSIS retry or cleanup.
    foreach ($name in @('resources', 'locales')) {
      $source = [IO.Path]::Combine($stage, $name)
      if (![IO.Directory]::Exists($source)) { continue }
      $destination = [IO.Path]::Combine($root, $name)
      $diagnosticOperation = 'validate-payload-destination'; $diagnosticPath = $destination
      if (Test-Path -LiteralPath $destination) { throw "Publication destination already exists: $destination" }
      $diagnosticOperation = 'move-payload-directory'; $diagnosticPath = $source
      [IO.Directory]::Move($source, $destination)
      [Console]::Out.WriteLine("Published $name by directory move")
    }
  } else {
    # Only this installer's identity-checked directory is eligible for deletion. Never sweep
    # a previous installer's staging by prefix, and never follow reparse points while cleaning.
    $stageHandle.Dispose()
    $stageHandle = $null
    $diagnosticOperation = 'remove-payload-staging'; $diagnosticPath = $stage
    [IO.Directory]::Delete(('\\?\' + $stage), $true)
    $diagnosticOperation = 'remove-publication-state'; $diagnosticPath = $StatePath
    [IO.File]::Delete($StatePath)
    Write-PublicationReport @() 'succeeded'
  }
  exit 0
} catch {
  $originalErrors = @(Get-PublicationError $_.Exception)
  [Console]::Error.WriteLine($_.Exception.ToString())
  if ($createdStage -and ![IO.File]::Exists($StatePath)) {
    if ($null -ne $stageHandle) { $stageHandle.Dispose(); $stageHandle = $null }
    # Preparation has not extracted anything. Only remove this empty, exclusively created
    # directory; an unexpected entry keeps it on disk instead of being recursively erased.
    try { [IO.Directory]::Delete($createdStage, $false) } catch {
      $diagnosticOperation = 'remove-empty-payload-staging'; $diagnosticPath = $createdStage
      $preparationCleanupErrors += @(Get-PublicationError $_.Exception)
      [Console]::Error.WriteLine($_.Exception.ToString())
    }
  }
  Write-PublicationReport $originalErrors 'failed' $preparationCleanupErrors
  exit 20
} finally {
  if ($null -ne $stageHandle) { $stageHandle.Dispose() }
  for ($i = $handles.Count - 1; $i -ge 0; $i--) { $handles[$i].Dispose() }
}
