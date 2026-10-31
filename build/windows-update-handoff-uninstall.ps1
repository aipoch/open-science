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
# Validate both fixed roots before removing anything; retain historical configuration leases.
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  if (-not (Test-NoReparsePointInPath $root) -or -not (Test-TrustedAcl $root)) {
    throw 'Update presentation storage ownership could not be verified.'
  }
}
$installation = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
# Read-only process inventory. An unavailable inventory must not authorize deletion.
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
$owned = "^(request\.json|bound-request\.json|installer\.exe|installer-recovery\.exe(?:\.part(?:\.meta)?)?|config\.bin|helper\.exe|cancel|(accepted|installing|installed|failed|ready|closed|aborted|handoff|unconfirmed)\.receipt)(?:\.$uuid\.tmp|\.tmp)?$"
foreach ($root in $roots) {
if (-not (Test-Path -LiteralPath $root)) { continue }
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
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($request.applicationPath)).TrimEnd('\') -ine $installation -or
        $request.parentPid -le 0) { continue }
  }
  catch { continue }
  $helper = Join-Path $directory.FullName 'helper.exe'
  $installer = Join-Path $directory.FullName 'installer.exe'
  $active = @($processes | Where-Object {
    # Historic PIDs can be reused by unrelated processes after an update or reboot. A readable
    # different executable is not an owner; preserve uncertainty only when its identity is hidden.
    $recordedPid = $_.ProcessId -eq $request.parentPid -or
      ($request.helperPid -and $_.ProcessId -eq $request.helperPid) -or
      ($request.successorPid -and $_.ProcessId -eq $request.successorPid)
    if (-not $_.ExecutablePath) { $recordedPid }
    else {
      $_.ExecutablePath -ieq $helper -or $_.ExecutablePath -ieq $request.applicationPath -or
        $_.ExecutablePath -ieq $request.installerPath -or $_.ExecutablePath -ieq $installer
    }
  })
  if ($active.Count -gt 0) {
    throw "Update operation $($directory.Name) is still active; close its presentation after installation finishes and retry uninstall."
  }
  # Remove the executable first (Windows refuses if still mapped), the request last so retry retains
  # its ownership evidence. Unknown outcomes may be removed only during an explicit product uninstall.
  if (Test-Path -LiteralPath $helper) { Remove-Item -LiteralPath $helper -Force }
  if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
  foreach ($file in $files) {
    if ($file.Name -ne 'request.json' -and $file.Name -ne 'helper.exe' -and $file.Name -ne 'installer.exe') {
      Remove-Item -LiteralPath $file.FullName -Force
    }
  }
  Remove-Item -LiteralPath $requestPath -Force
  [IO.Directory]::Delete($directory.FullName, $false)
}
# The persistent entry is removed only by an explicit uninstall, never by an update's old
# uninstaller. Retaining older content-addressed entries during updates keeps existing pins usable.
$installations = Join-Path $root 'Installations'
if (Test-Path -LiteralPath $installations) {
  if (-not (Test-NoReparsePointInPath $installations) -or -not (Test-TrustedAcl $installations)) {
    throw 'Persistent launch storage ownership could not be verified.'
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $installations -Force)) {
    if (-not $directory.PSIsContainer -or $directory.Name -cnotmatch '^[0-9a-f]{64}$' -or
        -not (Test-NoReparsePointInPath $directory.FullName) -or -not (Test-TrustedAcl $directory.FullName)) { continue }
    $files = @(Get-ChildItem -LiteralPath $directory.FullName -Force)
    if (@($files | Where-Object {
      $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $_.Name -cnotmatch "^(launch\.ini|update\.ini|setup-[0-9a-f]{64}\.exe)(?:\.$uuid\.tmp|\.tmp)?$" -or
      -not (Test-TrustedAcl $_.FullName)
    }).Count -gt 0) { continue }
    $launch = Join-Path $directory.FullName 'launch.ini'
    try {
      if ((Get-Item -LiteralPath $launch).Length -gt 16384) { continue }
      $paths = @((Get-Content -LiteralPath $launch -Encoding Unicode) | Where-Object { $_ -cmatch '^applicationPath=' })
      if ($paths.Count -ne 1) { continue }
      $application = $paths[0].Substring('applicationPath='.Length)
      if (-not [IO.Path]::IsPathRooted($application) -or
          [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($application)).TrimEnd('\') -ine $installation) { continue }
    } catch { continue }
    if (@($processes | Where-Object {
      $_.ExecutablePath -and ($_.ExecutablePath -ieq $application -or
        $_.ExecutablePath.StartsWith($directory.FullName + '\', [StringComparison]::OrdinalIgnoreCase))
    }).Count -gt 0) { throw 'A persistent launch entry is still active; retry uninstall after it exits.' }
    # Executable mappings fail deletion rather than being terminated. Ownership evidence remains
    # until every file has been removed, so interrupted uninstall can safely resume.
    foreach ($file in @($files | Where-Object { $_.Name -like '*.exe' })) { Remove-Item -LiteralPath $file.FullName -Force }
    foreach ($file in @($files | Where-Object { $_.Name -notlike '*.exe' -and $_.Name -ne 'launch.ini' })) { Remove-Item -LiteralPath $file.FullName -Force }
    Remove-Item -LiteralPath $launch -Force
    [IO.Directory]::Delete($directory.FullName, $false)
  }
}
}
