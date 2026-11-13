param([Parameter(Mandatory = $true)][string]$InstallPath)

$ErrorActionPreference = 'Stop'
# Reuse the existing owner/ACL and reparse checks. Do not execute runtime-cache cleanup here.
. (Join-Path $PSScriptRoot 'windows-runtime-cache-uninstall.ps1') -LoadFunctionsOnly
$appData = [Environment]::GetFolderPath('ApplicationData')
$roots = @(
  (Join-Path $appData 'Open-Science\UpdateHandoffs'),
  (Join-Path $appData 'Open-Science-UpdateHandoffs')
)
$roots = @($roots | Where-Object { Test-Path -LiteralPath $_ })
if ($roots.Count -eq 0) { exit 0 }
$installation = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
# Read-only process inventory. An unavailable inventory must not authorize deletion.
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
# Same token as process-birth-identity.ts: the kernel creation FILETIME at 100 ns resolution.
# WMI CreationDate is only microsecond-precise, so it can never prove or disprove that identity.
# Returns '' when the PID no longer exists and $null when the live process cannot be inspected.
function Get-LiveProcessBirthToken([int]$ProcessId) {
  try { $live = [Diagnostics.Process]::GetProcessById($ProcessId) }
  catch {
    $cause = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
    if ($cause -is [ArgumentException]) { return '' }
    return $null
  }
  try { return 'windows-creation-time:' + $live.StartTime.ToFileTimeUtc() }
  catch { return $null }
  finally { $live.Dispose() }
}
# $PID is a read-only automatic variable, so the recorded PID must not be named $Pid.
function Test-RecordedOwner($Process, $RecordedPid, $RecordedBirthToken) {
  if (-not $RecordedPid -or $Process.ProcessId -ne $RecordedPid) { return $false }
  # Records from older versions carry no birth identity; a matching PID remains possible ownership.
  if ([string]::IsNullOrWhiteSpace([string]$RecordedBirthToken)) { return $true }
  $actual = Get-LiveProcessBirthToken ([int]$RecordedPid)
  # An uninspectable live process is uncertainty, not proof that the owner is gone.
  if ($null -eq $actual) { return $true }
  return $actual -ceq [string]$RecordedBirthToken
}
# The uninstaller invokes this script as a child of its own process. A historical update PID can
# be reused by that process, and its executable identity may be hidden from the elevated WMI query.
# Exclude the current cleanup process and its observed ancestors before evaluating recorded owners.
$ancestors = [Collections.Generic.HashSet[uint32]]::new()
$cursor = $processes | Where-Object { $_.ProcessId -eq $PID } | Select-Object -First 1
while ($cursor -and $cursor.ParentProcessId -and $ancestors.Add([uint32]$cursor.ParentProcessId)) {
  $parentPid = $cursor.ParentProcessId
  $cursor = $processes | Where-Object { $_.ProcessId -eq $parentPid } | Select-Object -First 1
}
$uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
$otherInstallationHelpers = @()
$owned = "^(request\.json|config\.bin|helper\.exe|cancel|(accepted|installing|installed|failed|ready|closed|aborted|handoff|unconfirmed)\.receipt)(?:\.$uuid\.tmp|\.tmp)?$"
foreach ($root in $roots) {
try {
if (-not (Test-Path -LiteralPath $root)) { continue }
if (-not (Test-NoReparsePointInPath $root) -or -not (Test-TrustedAcl $root)) {
  Write-Output "Retained update records at '$root': storage ownership could not be verified."
  continue
}
foreach ($directory in @(Get-ChildItem -LiteralPath $root -Force)) {
  if (-not $directory.PSIsContainer -or $directory.Name -cnotmatch "^$uuid$" -or
      -not (Test-NoReparsePointInPath $directory.FullName) -or
      -not (Test-TrustedAcl $directory.FullName)) { continue }
  $files = @(Get-ChildItem -LiteralPath $directory.FullName -Force)
  # Never recursively erase unknown content or follow a reparse point.
  if (@($files | Where-Object {
      $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $_.Name -cnotmatch $owned -or -not (Test-TrustedAcl $_.FullName)
    }).Count -gt 0) { continue }
  $requestPath = Join-Path $directory.FullName 'request.json'
  try {
    if ((Get-Item -LiteralPath $requestPath).Length -gt 16384) { continue }
    $request = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($request.schema -ne 1 -or $request.operationId -cne $directory.Name -or
        -not [IO.Path]::IsPathRooted([string]$request.applicationPath) -or
        -not [IO.Path]::IsPathRooted([string]$request.installerPath) -or
        $request.parentPid -le 0) { continue }
    $requestInstallation = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($request.applicationPath)).TrimEnd('\')
  }
  catch { continue }
  $helper = Join-Path $directory.FullName 'helper.exe'
  if ($requestInstallation -ine $installation) {
    # Only a trusted record can establish that this helper belongs to a different installation.
    # Enumeration can expand 8.3 ancestors; retain the root spelling used by the fallback scan.
    $otherInstallationHelpers += Join-Path (Join-Path $root $directory.Name) 'helper.exe'
    continue
  }
  $active = @($processes | Where-Object {
    if ($_.ProcessId -eq $PID -or $ancestors.Contains([uint32]$_.ProcessId)) { return $false }
    # Historic PIDs can be reused by unrelated processes after an update or reboot. A readable
    # different executable is not an owner; preserve uncertainty only when its identity is hidden.
    # Legacy helpers predate birth identity and are matched by PID alone.
    $recordedOwner = (Test-RecordedOwner $_ $request.parentPid $request.parentBirthToken) -or
      (Test-RecordedOwner $_ $request.helperPid $null) -or
      (Test-RecordedOwner $_ $request.successorPid $request.successorBirthToken)
    if (-not $_.ExecutablePath) { $recordedOwner }
    else {
      $_.ExecutablePath -ieq $helper -or $_.ExecutablePath -ieq $request.applicationPath -or
        $_.ExecutablePath -ieq $request.installerPath
    }
  })
  if (@($active | Where-Object { -not $_.ExecutablePath }).Count -gt 0) {
    Write-Output "Could not inspect a recorded owner of update operation $($directory.Name). Retry uninstall after closing its update window."
    exit 1
  }
  if ($active.Count -gt 0) {
    Write-Output "Update operation $($directory.Name) is still active; close its presentation after installation finishes and retry uninstall."
    exit 2
  }
  # Remove the executable first (Windows refuses if still mapped), the request last so retry retains
  # its ownership evidence. Unknown outcomes may be removed only during an explicit product uninstall.
  if (Test-Path -LiteralPath $helper) { Remove-Item -LiteralPath $helper -Force }
  foreach ($file in $files) {
    if ($file.Name -ne 'request.json' -and $file.Name -ne 'helper.exe') {
      Remove-Item -LiteralPath $file.FullName -Force
    }
  }
  Remove-Item -LiteralPath $requestPath -Force
  [IO.Directory]::Delete($directory.FullName, $false)
}
}
catch {
  # Optional record cleanup must not trap product removal. Preserve remaining ownership evidence
  # for a later cleanup; never repair ACLs or recursively remove content we cannot verify.
  Write-Output "Retained update records at '$root': $($_.Exception.Message)"
}
}
# NSIS holds the installer mutex independently of these optional records. Older detached helpers
# have their own lifetime: identify them from the captured process inventory even when storage is
# untrusted, except where a verified record established a different installation above.
foreach ($process in $processes) {
  if ($process.ProcessId -eq $PID -or $ancestors.Contains([uint32]$process.ProcessId)) { continue }
  if (-not $process.ExecutablePath -or $otherInstallationHelpers -icontains $process.ExecutablePath) { continue }
  foreach ($root in $roots) {
    if ($process.ExecutablePath -imatch ('^' + [regex]::Escape($root) + "\\$uuid\\helper\.exe$")) {
      Write-Output "Update helper is still active: $($process.ExecutablePath)"
      exit 2
    }
  }
}
