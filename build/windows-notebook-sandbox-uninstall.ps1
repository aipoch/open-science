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
$ownershipRoot = Join-Path $env:LOCALAPPDATA "Aipoch\OpenScience\notebook-sandbox\$installationId"
$HostPath = $hostPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $HostPath) {
  $receipt = Join-Path $ownershipRoot 'receipt.json'
  $journal = Join-Path $ownershipRoot 'creating.json'
  $leaseRoot = Join-Path $ownershipRoot 'acl-leases'
  $hasLease = (Test-Path -LiteralPath $leaseRoot -PathType Container) -and (Get-ChildItem -LiteralPath $leaseRoot -Filter '*.json' -ErrorAction SilentlyContinue)
  if ((Test-Path -LiteralPath $receipt -PathType Leaf) -or (Test-Path -LiteralPath $journal -PathType Leaf) -or $hasLease) {
    Write-Error 'The Notebook isolation host is missing while owned resources still require cleanup.'
    exit 1
  }
  exit 0
}

function Invoke-OwnedHost([string]$Command) {
  if (Test-CurrentUserIsAdministrator) {
    # Silent CI and already-elevated uninstalls cannot show a UAC prompt. Run in-process so the
    # host exits before NSIS deletes this install tree.
    & $HostPath $Command $installationId $ownershipRoot
    return [int]$LASTEXITCODE
  }
  $process = Start-Process `
    -FilePath $HostPath `
    -ArgumentList @($Command, $installationId, $ownershipRoot) `
    -Verb RunAs `
    -Wait `
    -PassThru
  return [int]$process.ExitCode
}

try {
  Stop-SandboxHostProcesses $SandboxRoot
  & $HostPath prepare-remove $installationId $ownershipRoot
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Notebook isolation preparation exited $LASTEXITCODE."
    exit $LASTEXITCODE
  }
  $removeCode = Invoke-OwnedHost 'remove'
  if ($removeCode -ne 0) {
    exit $removeCode
  }
  & $HostPath finish-remove $installationId $ownershipRoot
  $finishCode = [int]$LASTEXITCODE
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
