[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SandboxRoot
)

function Test-CurrentUserIsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-SandboxHostProcesses([string]$Root) {
  $normalized = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      $_.ExecutablePath.StartsWith($normalized, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$hostPaths = @(
  (Join-Path $SandboxRoot 'x64\notebook-appcontainer-host.exe'),
  (Join-Path $SandboxRoot 'arm64\notebook-appcontainer-host.exe')
)
$installationId = '0f3cd2a44c3d4e4e9f1e2a5b'
$ownershipRoot = Join-Path $env:LOCALAPPDATA "Aipoch\Open-Science\notebook-sandbox\$installationId"
$legacyOwnershipRoot = Join-Path $env:LOCALAPPDATA "Aipoch\OpenScience\notebook-sandbox\$installationId"
function Test-OwnershipState([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return $false }
  # Include unexpected files so corrupt records cannot silently select a fresh location.
  return [bool](Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction Stop | Select-Object -First 1)
}
$isolatedRoot = [string]$env:OPEN_SCIENCE_E2E_STORAGE_ROOT
if (-not $isolatedRoot.Trim()) { $isolatedRoot = [string]$env:OPEN_SCIENCE_CONFIG_ROOT }
if ($isolatedRoot.Trim()) {
  $isolatedRoot = $isolatedRoot.Trim()
  if (-not [System.IO.Path]::IsPathRooted($isolatedRoot)) {
    Write-Error 'The config root must be an absolute path.'
    exit 1
  }
  $ownershipRoot = Join-Path $isolatedRoot "notebook-sandbox\$installationId"
} elseif (Test-OwnershipState $legacyOwnershipRoot) {
  if (Test-OwnershipState $ownershipRoot) {
    Write-Error "Notebook isolation ownership is ambiguous. Resolve both existing ownership directories before uninstalling. currentRoot=$ownershipRoot legacyRoot=$legacyOwnershipRoot"
    exit 1
  }
  $ownershipRoot = $legacyOwnershipRoot
}
$HostPath = $hostPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $HostPath) {
  $receipt = Join-Path $ownershipRoot 'receipt.json'
  $journal = Join-Path $ownershipRoot 'creating.json'
  $leaseRoot = Join-Path $ownershipRoot 'acl-leases'
  $hasLease = (Test-Path -LiteralPath $leaseRoot -PathType Container) -and (Get-ChildItem -LiteralPath $leaseRoot -Filter '*.json' -ErrorAction SilentlyContinue)
  $hasReceipt = Test-Path -LiteralPath $receipt -PathType Leaf
  $hasJournal = Test-Path -LiteralPath $journal -PathType Leaf
  if ($hasReceipt -or $hasJournal -or $hasLease) {
    Write-Error "The Notebook isolation host is missing while owned resources still require cleanup. sandboxRoot=$SandboxRoot ownershipRoot=$ownershipRoot receipt=$hasReceipt journal=$hasJournal aclLeases=$([bool]$hasLease)"
    exit 1
  }
  exit 0
}

# Start-Process joins its ArgumentList array with spaces. Quote each Windows argv element.
function ConvertTo-WindowsArgument([string]$Value) {
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-OwnedHost([string]$Command) {
  if (Test-CurrentUserIsAdministrator) {
    # Silent CI and already-elevated uninstalls cannot show a UAC prompt. Run in-process so the
    # host exits before NSIS deletes this install tree.
    & $HostPath $Command $installationId $ownershipRoot
    return [int]$LASTEXITCODE
  }
  $quotedArguments = (@($Command, $installationId, $ownershipRoot) | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
  $process = Start-Process `
    -FilePath $HostPath `
    -ArgumentList $quotedArguments `
    -Verb RunAs `
    -Wait `
    -PassThru
  return [int]$process.ExitCode
}

try {
  Stop-SandboxHostProcesses $SandboxRoot
  & $HostPath prepare-remove $installationId $ownershipRoot
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Notebook isolation preparation exited $LASTEXITCODE. host=$HostPath ownershipRoot=$ownershipRoot"
    exit $LASTEXITCODE
  }
  $removeCode = Invoke-OwnedHost 'remove'
  if ($removeCode -ne 0) {
    Write-Error "Notebook isolation removal exited $removeCode. host=$HostPath ownershipRoot=$ownershipRoot"
    exit $removeCode
  }
  & $HostPath finish-remove $installationId $ownershipRoot
  $finishCode = [int]$LASTEXITCODE
  if ($finishCode -ne 0) {
    Write-Error "Notebook isolation finalization exited $finishCode. host=$HostPath ownershipRoot=$ownershipRoot"
  }
  Stop-SandboxHostProcesses $SandboxRoot
  exit $finishCode
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223) {
    Write-Error 'AppContainer removal was cancelled by the user.'
    exit 1223
  }
  Write-Error $_
  exit 1
} finally {
  Stop-SandboxHostProcesses $SandboxRoot
}
