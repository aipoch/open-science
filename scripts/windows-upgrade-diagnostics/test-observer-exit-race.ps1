param(
  [Parameter(Mandatory)][string]$Output,
  [ValidateSet('before-open','after-open','exited-access-error','observation-error')][string]$Stage = 'before-open'
)
$ErrorActionPreference = 'Stop'
$observerPath = Join-Path $PSScriptRoot 'observe-handoff.ps1'
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'HandoffObserver.cs'))
$capture = 'var process = ObservedProcess.GetProcessById(pid);'
if (-not $nativeSource.Contains($capture)) { throw 'Capture seam changed' }
# Run the actual observer capture code, synchronizing the short-lived process exit
# at the discovery/open boundary instead of relying on timing or sleep.
$probe = $nativeSource
if ($Stage -eq 'before-open') { $probe = $probe.Replace($capture, 'using(var departing=Process.GetProcessById(pid)) { if(!departing.WaitForExit(10000)) throw new TimeoutException("Fixture remains alive"); } ' + $capture) }
else {
  $seam = 'var buffer = new StringBuilder(32768);'
  if (-not $probe.Contains($seam)) { throw 'Handle probe seam changed' }
  $injected = if ($Stage -eq 'after-open') { 'var retained = process.Handle; process.WaitForExit(); ' } elseif ($Stage -eq 'exited-access-error') { 'process.WaitForExit(); if(identity.pid>0) throw new System.ComponentModel.Win32Exception(5); ' } else { 'if(identity.pid>0) throw new System.ComponentModel.Win32Exception(5); ' }
  $probe = $probe.Replace($seam, $injected + $seam)
}
Add-Type -TypeDefinition $probe -ReferencedAssemblies 'System.Web.Extensions'
$method = [HandoffObserver].GetMethod('Capture', [Reflection.BindingFlags]'NonPublic,Static')
$records = @()
try {
  for ($iteration = 0; $iteration -lt 20; $iteration++) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $env:ComSpec
    $start.Arguments = if ($Stage -eq 'observation-error') { '/d /c set /p upgradeFixture=' } else { '/d /c exit 0' }
    $start.RedirectStandardInput = $true
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($start)
    try {
      $identity = $null
      $observedError = $false
      try { $identity = $method.Invoke($null, @([int]$child.Id, [int]$PID)) }
      catch {
        # Process.GetProcessById can reject a child already absent from the table.
        $cause = $_.Exception.GetBaseException()
        if ($Stage -eq 'observation-error' -and $cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) { $observedError = $true }
        elseif ($cause -isnot [ArgumentException]) { throw }
      }
      if ($identity) {
        try { if ($Stage -eq 'observation-error' -or -not $identity.process.HasExited) { throw 'Unexpected identity claim' } }
        finally { $identity.process.Dispose() }
      }
      if ($Stage -eq 'observation-error' -and -not $observedError) { throw 'Observation error was not preserved' }
      if ($Stage -eq 'observation-error') { $child.StandardInput.WriteLine('exit') }
      if (-not $child.WaitForExit(10000)) { throw 'Fixture remains alive; no forced cleanup' }
      $records += @{iteration=$iteration;pid=$child.Id;exited=$child.HasExited;exitCode=$child.ExitCode;forced=$false;observedError=$observedError}
    } finally {
      if ($Stage -eq 'observation-error' -and -not $child.HasExited) { $child.StandardInput.WriteLine('exit') }
      try { if (-not $child.WaitForExit(10000)) { throw 'Fixture remains alive; no forced cleanup' } }
      finally { $child.Dispose() }
    }
  }
  @{result='PASS';records=$records} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output
} catch {
  @{result='FAIL';error=$_.Exception.ToString();records=$records} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output
  throw
}
