param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'HandoffObserver.cs'))
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Web.Extensions'
$operation = 'd4b596b1-9356-498c-a1a0-b4c906117c82'
$root = 'C:\synthetic\UpdateHandoffs'
$helper = Join-Path $root "$operation\helper.exe"
$application = 'C:\synthetic\app\open-science.exe'
$installer = 'C:\synthetic\pending\setup.exe'
$request = @{schema=1;operationId=$operation;parentPid=100;helperPid=101;applicationPath=$application;installerPath=$installer}
$records = @()
function Check([string]$Name, [bool]$Expected, [hashtable]$Value, [string]$Path=$helper) {
  $actual = [HandoffObserver]::MatchesOperation(($Value | ConvertTo-Json -Compress),$Path,$root,100,101,$application,$installer)
  if ($actual -ne $Expected) { throw "Unexpected identity result: $Name" }
  $script:records += @{name=$Name;matched=$actual;expected=$Expected}
}
Check 'exact operation identity' $true $request
foreach ($entry in @(@('operationId',[guid]::NewGuid().ToString()),@('parentPid',99),@('helperPid',102),@('applicationPath','C:\other\open-science.exe'),@('installerPath','C:\other\setup.exe'),@('schema',2))) {
  $wrong = $request.Clone(); $wrong[$entry[0]] = $entry[1]
  Check ("reject wrong " + $entry[0]) $false $wrong
}
$pending = $request.Clone(); $pending.Remove('helperPid')
Check 'await helper acknowledgement' $false $pending
Check 'reject unmanaged helper path' $false $request "C:\other\$operation\helper.exe"
Check 'reject old basename' $false $request (Join-Path $root "$operation\open-science-update-progress.exe")
$malformedRejected = $false
try { [HandoffObserver]::MatchesOperation('{',$helper,$root,100,101,$application,$installer) | Out-Null }
catch { $malformedRejected = $true }
if (-not $malformedRejected) { throw 'Malformed request was silently accepted' }

# Exercise the real process-discovery and digest path, not only MatchesOperation.
$evidenceDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Output))
$fixture = Join-Path $evidenceDirectory ('operation-fixture-' + [guid]::NewGuid().ToString('N'))
$liveOperation = [guid]::NewGuid().ToString()
$directory = Join-Path $fixture "Open-Science\UpdateHandoffs\$liveOperation"
[IO.Directory]::CreateDirectory($directory) | Out-Null
$liveHelper = Join-Path $directory 'helper.exe'
Copy-Item -LiteralPath $env:ComSpec -Destination $liveHelper
$self = [Diagnostics.Process]::GetCurrentProcess()
$parentPath = $self.MainModule.FileName
$self.Dispose()
$parent = [ObservedProcess]::GetProcessById($PID)
$child = $null
$failure = $null
$live = @()
$cleanup = @{forced=$false;exited=$false;directoryRemoved=$false}
try {
  foreach ($invalidRoot in @('', 'synthetic', 'C:synthetic', '\synthetic')) {
    $rejected = $false
    try {
      $invalid = [HandoffObserver]::new($PID,$parent.StartTime.ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"),$parentPath,$installer,$env:ComSpec,$parentPath,$invalidRoot)
      $invalid.Dispose()
    } catch {
      $cause = $_.Exception.GetBaseException()
      if ($cause -isnot [ArgumentException] -or $cause.ParamName -ne 'handoffAppData') { throw }
      $rejected = $true
    }
    if (-not $rejected) { throw "Non-absolute handoff root was accepted: $invalidRoot" }
    $live += @{scenario='reject-non-absolute-root';appData=$invalidRoot;rejected=$true}
  }
  $start = [Diagnostics.ProcessStartInfo]::new($liveHelper,'/d /c set /p fixture=')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $child = [Diagnostics.Process]::Start($start)
  $liveInstaller = Join-Path $fixture 'installer.exe'
  @{schema=1;operationId=$liveOperation;parentPid=$PID;helperPid=$child.Id;applicationPath=$parentPath;installerPath=$liveInstaller} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'request.json') -Encoding UTF8
  foreach ($scenario in @('matching-root','wrong-root','wrong-digest')) {
    $appData = if ($scenario -eq 'wrong-root') { Join-Path $fixture 'other-account' } else { $fixture }
    $resource = if ($scenario -eq 'wrong-digest') { $parentPath } else { $env:ComSpec }
    $observer = [HandoffObserver]::new($PID,$parent.StartTime.ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"),$parentPath,$liveInstaller,$resource,$parentPath,$appData)
    try {
      $sample = $null
      $digestRejected = $false
      try { $sample = $observer.Sample() }
      catch {
        if ($scenario -ne 'wrong-digest' -or $_.Exception.GetBaseException().Message -ne 'Progress executable hash differs from packaged resource') { throw }
        $digestRejected = $true
      }
      if ($scenario -eq 'wrong-digest') {
        if (-not $digestRejected) { throw 'Mismatched helper digest was accepted' }
        $live += @{scenario=$scenario;digestRejected=$true}
      } else {
        $identity = @($sample.identities | Where-Object { $_.pid -eq $child.Id })
        $expected = if ($scenario -eq 'matching-root') { 'progress' } else { 'descendant' }
        if ($identity.Count -ne 1 -or $identity[0].role -ne $expected) { throw "Incorrect helper role for $scenario" }
        $live += @{scenario=$scenario;identity=$identity[0];appData=$appData}
      }
    } finally { $observer.Dispose() }
  }
} catch { $failure = $_ }
finally {
  $parent.Dispose()
  if ($child) {
    try {
      if (-not $child.HasExited) { $child.StandardInput.WriteLine('exit') }
      if (-not $child.WaitForExit(10000)) { throw 'Owned helper remains alive; retaining fixture' }
      $cleanup.exited = $true
      $cleanup.exitCode = $child.ExitCode
      if ($child.ExitCode -ne 0) { throw 'Owned helper exited unsuccessfully' }
    } catch { $cleanup.error = $_.Exception.ToString(); if (-not $failure) { $failure = $_ } }
    finally { $child.Dispose() }
  }
  if (-not $failure) {
    try {
      if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($fixture)) -ne $evidenceDirectory) { throw 'Fixture escaped evidence directory' }
      Remove-Item -LiteralPath $fixture -Recurse -Force
      $cleanup.directoryRemoved = $true
    } catch { $cleanup.error = $_.Exception.ToString(); $failure = $_ }
  }
  $status = if ($failure) { 'FAIL' } else { 'PASS' }
  @{status=$status;records=$records;malformedRejected=$true;live=$live;cleanup=$cleanup;fixture=$fixture;error=$(if ($failure) { $failure.Exception.ToString() })} |
    ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $Output
}
if ($failure) { throw $failure }
