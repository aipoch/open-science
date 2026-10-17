param([Parameter(Mandatory)][int]$TargetPid,[Parameter(Mandatory)][string]$Started,[Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$utf8 = [Text.UTF8Encoding]::new($false)
$writer = [IO.StreamWriter]::new($Output,$false,$utf8)
$writer.AutoFlush = $true
function Record($value) { $writer.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress)) }
$target = [Diagnostics.Process]::GetProcessById($TargetPid)
try {
  $null = $target.Handle
  if ($target.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $Started) { throw 'Observed process identity changed' }
  Record @{event='ready';at=[DateTime]::UtcNow.ToString('o');pid=$TargetPid;started=$Started}
  [Console]::Out.WriteLine('PR3599_WINDOW_OBSERVER_READY')
  [Console]::Out.Flush()
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  while (-not $target.HasExited) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Window observation deadline exceeded' }
    $target.Refresh()
    $sample = @{event='sample';at=[DateTime]::UtcNow.ToString('o');pid=$TargetPid;windowPresent=$false;controls=@()}
    try {
      if ($target.MainWindowHandle -ne [IntPtr]::Zero) {
        $window = [Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
        $sample.windowPresent = $true
        $sample.title = $window.Current.Name
        $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        $sample.controls = @($elements | ForEach-Object {
          $state = $_.Current
          if ($state.Name) { @{name=$state.Name;offscreen=$state.IsOffscreen;type=$state.ControlType.ProgrammaticName} }
        })
      }
    } catch {
      $sample.observerError = $_.Exception.Message
      $sample.processExited = $target.HasExited
    }
    Record $sample
    # Sampling cadence only. No application action waits for this delay or uses it as acceptance.
    $null = $target.WaitForExit(100)
  }
  Record @{event='exit';at=[DateTime]::UtcNow.ToString('o');pid=$TargetPid;exitCode=$target.ExitCode}
} catch {
  Record @{event='observer-failure';at=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message}
  throw
} finally {
  $target.Dispose()
  $writer.Dispose()
}
