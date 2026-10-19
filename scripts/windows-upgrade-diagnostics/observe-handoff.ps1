param(
  [Parameter(Mandatory)][int]$TargetPid,
  [Parameter(Mandatory)][string]$Started,
  [Parameter(Mandatory)][string]$HandoffAppData,
  [string]$Application = $env:OPEN_SCIENCE_UPDATE_OBSERVER_APPLICATION_PATH,
  [string]$Installer = $env:OPEN_SCIENCE_UPDATE_OBSERVER_INSTALLER_PATH,
  [string]$HelperResource = $env:OPEN_SCIENCE_UPDATE_OBSERVER_PROGRESS_EXECUTABLE_PATH,
  [Parameter(Mandatory)][string]$Output,
  [string]$ParentExecutable = $env:OPEN_SCIENCE_UPDATE_OBSERVER_PARENT_EXECUTABLE_PATH
)
$ErrorActionPreference = 'Stop'
# Independent read-only observer. It never creates a window or controls an application process.
Add-Type -Path (Join-Path $PSScriptRoot 'HandoffObserver.cs') -ReferencedAssemblies 'System.Web.Extensions'
$observer = $null
$writer = [IO.StreamWriter]::new($Output,$false,[Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
  if (-not $ParentExecutable) { $ParentExecutable = $Application }
  $observer = [HandoffObserver]::new($TargetPid,$Started,$Application,$Installer,$HelperResource,$ParentExecutable,$HandoffAppData)
  [Console]::Out.WriteLine('OPEN_SCIENCE_UPDATE_HANDOFF_OBSERVER_READY')
  [Console]::Out.Flush()
  do {
    if (Test-Path -LiteralPath ($Output + '.stop')) { throw 'Handoff observation cancelled after application failure' }
    $sample = $observer.Sample()
    $writer.WriteLine(($sample | ConvertTo-Json -Depth 7 -Compress))
    if ($observer.IsCompleteWithinDeadline($sample)) { $observer.RequireResolvedImages(); break }
    # Sampling cadence only; this never delays or controls a product transition.
    Start-Sleep -Milliseconds 100
  } while ($true)
} catch {
  $originalError = $_
  $record = @{at=[DateTime]::UtcNow.ToString('o');observerError=$_.Exception.ToString()}
  $failedPid = [regex]::Match($_.Exception.ToString(),'Cannot query retained process image: pid=(\d+)')
  if ($failedPid.Success) {
    try {
      $record.failedCandidate = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $failedPid.Groups[1].Value) -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine)
    } catch { $record.diagnosticError = $_.Exception.ToString() }
  }
  $writer.WriteLine(($record | ConvertTo-Json -Depth 5 -Compress))
  throw $originalError
} finally {
  if ($observer) { $observer.Dispose() }
  $writer.Dispose()
}
