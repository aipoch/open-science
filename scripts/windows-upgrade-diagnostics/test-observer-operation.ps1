param([Parameter(Mandatory)][string]$Output, [switch]$Fallback)
$ErrorActionPreference = 'Stop'
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'HandoffObserver.cs'))
# Fault injection affects only the native image query; identity handles and exits remain real.
$query = 'if (!QueryFullProcessImageNameW(process.Handle, 0, buffer, ref size))'
if (-not $nativeSource.Contains($query)) { throw 'Image query seam changed' }
$nativeSource = $nativeSource.Replace('public class HandoffObserver : IDisposable {','public class HandoffObserver : IDisposable { public static bool DenyImage; public static int DenyPid; public static string RemoveRequestPath; public static Action BeforeInstallerExitRead;')
$nativeSource = $nativeSource.Replace($query,'if (DenyImage && identity.pid==DenyPid) throw new System.ComponentModel.Win32Exception(5); ' + $query)
$readRequest = 'var json=File.ReadAllText(requestPath);'
if (-not $nativeSource.Contains($readRequest)) { throw 'Request read seam changed' }
$nativeSource = $nativeSource.Replace($readRequest,'if (requestPath==RemoveRequestPath) { File.Delete(requestPath); RemoveRequestPath=null; } ' + $readRequest)
$exitRead = 'var process=known[installerPid].process;'
if (-not $nativeSource.Contains($exitRead)) { throw 'Installer lifetime seam changed' }
$nativeSource = $nativeSource.Replace($exitRead,'if(BeforeInstallerExitRead!=null) BeforeInstallerExitRead(); ' + $exitRead)
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Web.Extensions'
# Replay the observed slow-install timing without sleeping or changing product clocks.
$armed = [DateTime]::SpecifyKind([DateTime]'2026-10-19T12:00:00', [DateTimeKind]::Utc)
$budget = [HandoffObservationBudget]::new($armed)
$installStarted = $armed.AddSeconds(40)
$installExited = $installStarted.AddSeconds(285)
if ($budget.Check($armed.AddSeconds(39),$null,$null,$null,$false)) { throw 'Completed without installer' }
if ($budget.Check($installStarted.AddSeconds(280),$installStarted,$null,$null,$true)) { throw 'Visible successor bypassed live installer' }
if ($budget.Check($installExited.AddSeconds(10),$installStarted,$installExited,0,$false)) { throw 'Completed without ready successor' }
if (-not $budget.Check($installExited.AddSeconds(50),$installStarted,$installExited,0,$true)) { throw 'Healthy successor lost its startup budget' }
function RejectBudget([string]$Name,[DateTime]$Now,$Start,$Exit,$Code,[bool]$Ready) {
  $rejected=$false
  try { $budget.Check($Now,$Start,$Exit,$Code,$Ready) | Out-Null } catch { $rejected=$true }
  if (-not $rejected) { throw "Deadline accepted invalid completion: $Name" }
}
RejectBudget 'no installer' $armed.AddMinutes(2) $null $null $null $false
RejectBudget 'old installer' $armed.AddMinutes(1) $armed.AddSeconds(-1) $null $null $false
RejectBudget 'late installer submission' $armed.AddMinutes(3) $armed.AddMinutes(2) $null $null $false
RejectBudget 'live installer timeout' $installStarted.AddMinutes(6) $installStarted $null $null $true
RejectBudget 'late installer exit' $installStarted.AddMinutes(7) $installStarted $installStarted.AddMinutes(6) 0 $true
RejectBudget 'failed installer' $installExited $installStarted $installExited 7 $true
RejectBudget 'unconfirmed exit' $installExited $installStarted $installExited $null $true
RejectBudget 'ready timeout' $installExited.AddMinutes(2) $installStarted $installExited 0 $false
RejectBudget 'late ready must still fail' $installExited.AddMinutes(2) $installStarted $installExited 0 $true
# A repeated successful/unsuccessful sample never extends the event-anchored deadline.
RejectBudget 'repeated sample cannot renew budget' $installExited.AddMinutes(3) $installStarted $installExited 0 $true
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
$storage = if ($Fallback) { 'Open-Science-UpdateHandoffs' } else { 'Open-Science\UpdateHandoffs' }
$directory = Join-Path $fixture "$storage\$liveOperation"
[IO.Directory]::CreateDirectory($directory) | Out-Null
$liveHelper = Join-Path $directory 'helper.exe'
$resourceHelper = Join-Path $fixture 'fixture-resource.exe'
# Do not use an interactive shell command as the fixture's lifetime contract.
# A pipe protocol acknowledges readiness and normal exit in the observed process.
Add-Type -TypeDefinition @'
using System;
public static class OperationFixture {
  public static int Main() {
    Console.WriteLine("operation-fixture-ready");
    Console.Out.Flush();
    // Process.StandardInput can emit a preamble from the parent's console encoding.
    using (var input = new System.IO.StreamReader(Console.OpenStandardInput(), System.Text.Encoding.UTF8, true)) {
      System.Diagnostics.Process installer = null;
      try {
        string command;
        while ((command = input.ReadLine()) != null) {
          if (command == "exit") return 0;
          if (command.StartsWith("spawn:") && installer == null) {
            installer = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(command.Substring(6)) {
              UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true
            });
            var ready = installer.StandardOutput.ReadLineAsync();
            if (!ready.Wait(10000) || ready.Result != "operation-fixture-ready") return 43;
            Console.WriteLine("installer:" + installer.Id); Console.Out.Flush();
          } else return 42;
        }
        return 42;
      } finally {
        if (installer != null) {
          installer.StandardInput.WriteLine("exit");
          if (!installer.WaitForExit(10000) || installer.ExitCode != 0) throw new Exception("Fixture installer did not exit normally");
          installer.Dispose();
        }
      }
    }
  }
}
'@ -OutputAssembly $resourceHelper -OutputType ConsoleApplication
Copy-Item -LiteralPath $resourceHelper -Destination $liveHelper
$self = [Diagnostics.Process]::GetCurrentProcess()
$parentPath = $self.MainModule.FileName
$self.Dispose()
$parent = [ObservedProcess]::GetProcessById($PID)
$child = $null
$successor = $null
$failure = $null
$live = @()
$cleanup = @{forced=$false;exited=$false;directoryRemoved=$false}
try {
  $missingResourceRejected = $false
  try {
    $invalid = [HandoffObserver]::new($PID,$parent.StartTime.ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"),$parentPath,$installer,(Join-Path $fixture 'missing.exe'),$parentPath,$fixture)
    $invalid.Dispose()
  } catch {
    if ($_.Exception.GetBaseException() -isnot [IO.FileNotFoundException]) { throw }
    $missingResourceRejected = $true
  }
  if (-not $missingResourceRejected) { throw 'An explicitly configured missing legacy helper was accepted' }
  $live += @{scenario='reject-missing-legacy-resource';rejected=$true}
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
  $start = [Diagnostics.ProcessStartInfo]::new($liveHelper)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($start)
  $ready = $child.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(10000) -or $ready.Result -ne 'operation-fixture-ready' -or $child.HasExited) {
    throw 'Owned helper failed its readiness handshake; retaining fixture'
  }
  $live += @{scenario='helper-readiness';pid=$child.Id;acknowledgement=$ready.Result}
  $liveInstaller = Join-Path $fixture 'installer.exe'
  @{schema=1;operationId=$liveOperation;parentPid=$PID;helperPid=$child.Id;applicationPath=$parentPath;installerPath=$liveInstaller} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'request.json') -Encoding UTF8
  foreach ($scenario in @('matching-root','wrong-root','wrong-digest','native-only')) {
    $appData = if ($scenario -eq 'wrong-root') { Join-Path $fixture 'other-account' } else { $fixture }
    $resource = if ($scenario -eq 'wrong-digest') { $parentPath } else { $resourceHelper }
    if ($scenario -eq 'native-only') { $resource = $null }
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

  # ExecShellAsUser returns through Explorer: a genuine sibling process, not
  # a descendant of the old application or installer, must be receipt-bound.
  Copy-Item -LiteralPath $resourceHelper -Destination $liveInstaller
  $shellOperation = [guid]::NewGuid().ToString()
  $shellDirectory = Join-Path $fixture "$storage\$shellOperation"
  [IO.Directory]::CreateDirectory($shellDirectory) | Out-Null
  $created = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $observer = [HandoffObserver]::new($child.Id,$child.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"),$resourceHelper,$liveInstaller,$null,$liveHelper,$fixture)
  try {
    $child.StandardInput.WriteLine('spawn:' + $liveInstaller)
    $ack = $child.StandardOutput.ReadLineAsync()
    if (-not $ack.Wait(10000) -or $ack.Result -notmatch '^installer:(\d+)$') { throw 'Installer fixture not ready' }
    $installerPid = [int]$Matches[1]
    $sample = $observer.Sample()
    if (@($sample.identities | Where-Object { $_.pid -eq $installerPid -and $_.role -eq 'installer' }).Count -ne 1) { throw 'Installer identity missing' }
    # Force the actual installer to exit inside completion inspection, before its
    # native timestamps are read. A clock captured before this event is invalid.
    [HandoffObserver]::BeforeInstallerExitRead = [Action]{
      $child.StandardInput.WriteLine('exit')
      if (-not $child.WaitForExit(10000) -or $child.ExitCode -ne 0) { throw 'Original fixture did not exit normally' }
    }
    try {
      if ($observer.IsCompleteWithinDeadline($sample)) { throw 'Installer exit alone allowed completion' }
    } finally { [HandoffObserver]::BeforeInstallerExitRead=$null }
    $live += @{scenario='installer-exits-during-completion-inspection';normalExit=$true;forced=$false}
    $installedPath = Join-Path $shellDirectory 'installed.receipt'
    $readyPath = Join-Path $shellDirectory 'ready.receipt'
    [IO.File]::WriteAllText($installedPath,"$shellOperation`r`ninstalled`r`n")
    $start.FileName = $resourceHelper
    $successor = [Diagnostics.Process]::Start($start)
    $ack = $successor.StandardOutput.ReadLineAsync()
    if (-not $ack.Wait(10000) -or $ack.Result -ne 'operation-fixture-ready') { throw 'Sibling fixture not ready' }
    $requestPath = Join-Path $shellDirectory 'request.json'
    $shellRequest = @{schema=1;operationId=$shellOperation;createdAt=$created;parentPid=$child.Id;successorPid=$successor.Id;applicationPath=$resourceHelper;installerPath=$liveInstaller}
    $shellRequest | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
    [IO.File]::WriteAllText($readyPath,"$operation`r`nready`r`n")
    $sample = $observer.Sample()
    if (@($sample.identities | Where-Object { $_.pid -eq $successor.Id }).Count) { throw 'Wrong operation receipt accepted' }
    $live += @{scenario='reject-wrong-successor-receipt';rejected=$true}
    [IO.File]::WriteAllText($readyPath,"$shellOperation`r`nready`r`n")
    $validReadyAt = [IO.File]::GetLastWriteTimeUtc($readyPath)
    [IO.File]::SetLastWriteTimeUtc($readyPath,$successor.StartTime.ToUniversalTime().AddSeconds(-1))
    $sample = $observer.Sample()
    if (@($sample.identities | Where-Object { $_.pid -eq $successor.Id }).Count) { throw 'Reused PID with old ready receipt accepted' }
    $live += @{scenario='reject-successor-newer-than-receipt';rejected=$true}
    [IO.File]::SetLastWriteTimeUtc($readyPath,$validReadyAt)
    foreach ($entry in @(@('createdAt',0),@('parentPid',$PID),@('successorPid',$child.Id),@('applicationPath',$liveHelper),@('installerPath',$resourceHelper),@('operationId',[guid]::NewGuid().ToString()))) {
      $wrong = $shellRequest.Clone(); $wrong[$entry[0]]=$entry[1]
      $wrong | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
      $sample = $observer.Sample()
      if (@($sample.identities | Where-Object { $_.pid -eq $successor.Id }).Count) { throw "Wrong successor $($entry[0]) accepted" }
      $live += @{scenario=('reject-successor-' + $entry[0]);rejected=$true}
    }
    $unrelated = Join-Path $fixture ($storage + '\' + [guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($unrelated) | Out-Null
    foreach ($name in @('installed.receipt','ready.receipt')) { [IO.File]::WriteAllText((Join-Path $unrelated $name),'unrelated') }
    # Missing and corrupt requests from other operations cannot identify a process.
    $observer.Sample() | Out-Null
    [IO.File]::WriteAllText((Join-Path $unrelated 'request.json'),'{}')
    [HandoffObserver]::RemoveRequestPath=Join-Path $unrelated 'request.json'
    $observer.Sample() | Out-Null
    if ([HandoffObserver]::RemoveRequestPath -or (Test-Path -LiteralPath (Join-Path $unrelated 'request.json'))) { throw 'Request deletion race was not exercised' }
    $live += @{scenario='unrelated-request-deleted-during-read';rejected=$true}
    foreach ($invalidJson in @('[]','[1]','"bad"','null')) {
      [IO.File]::WriteAllText((Join-Path $unrelated 'request.json'),$invalidJson)
      $observer.Sample() | Out-Null
      $live += @{scenario='reject-unrelated-request-shape';json=$invalidJson;rejected=$true}
    }
    [IO.File]::WriteAllText((Join-Path $unrelated 'request.json'),'{')
    $shellRequest | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
    $otherStorage = if ($Fallback) { 'Open-Science\UpdateHandoffs' } else { 'Open-Science-UpdateHandoffs' }
    $duplicate = Join-Path $fixture "$otherStorage\$shellOperation"
    [IO.Directory]::CreateDirectory($duplicate) | Out-Null
    $ambiguousRejected = $false
    try { $observer.Sample() | Out-Null }
    catch {
      if ($_.Exception.GetBaseException().Message -ne 'Ambiguous update operation directory') { throw }
      $ambiguousRejected = $true
    }
    if (-not $ambiguousRejected) { throw 'Duplicate operation across roots was accepted' }
    [IO.Directory]::Delete($duplicate, $false)
    $live += @{scenario='reject-duplicate-operation-roots';rejected=$true}
    [HandoffObserver]::DenyPid=$successor.Id
    [HandoffObserver]::DenyImage=$true
    $sample = $observer.Sample()
    $pending = @($sample.identities | Where-Object { $_.pid -eq $successor.Id })
    if ($pending.Count -ne 1 -or $pending[0].path -or $pending[0].role -eq 'successor' -or $sample.unresolvedImages -ne 1) { throw 'Shell successor denial must retain unresolved identity' }
    $rejected=$false
    try { $observer.RequireResolvedImages() } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unresolved sibling allowed completion' }
    $known=[HandoffObserver].GetField('known',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($observer)
    $retainedHandle=$known[$successor.Id].process.Handle
    $live += @{scenario='shell-successor-persistent-denial';rejected=$true;identity=$pending[0]}
    [HandoffObserver]::DenyImage=$false
    $sample=$observer.Sample()
    $identity = @($sample.identities | Where-Object { $_.pid -eq $successor.Id })
    if ($identity.Count -ne 1 -or $identity[0].role -ne 'successor' -or $identity[0].parent -ne $PID -or -not $sample.oldExited) { throw 'Receipt-bound sibling successor was not classified' }
    if ($known[$successor.Id].process.Handle -ne $retainedHandle -or $identity[0].imageQueryFailures -lt 1 -or $identity[0].lastImageError -ne 5) { throw 'Sibling recovery replaced its handle or erased error evidence' }
    $observer.RequireResolvedImages()
    $live += @{scenario='shell-launched-successor';identity=$identity[0];originalPid=$child.Id;installerPid=$installerPid}
    $successor.StandardInput.WriteLine('exit')
    if (-not $successor.WaitForExit(10000) -or $successor.ExitCode -ne 0) { throw 'Sibling successor did not exit normally' }
    $sample = $observer.Sample()
    if (@($sample.identities | Where-Object { -not $_.exited }).Count) { throw 'Owned fixture processes remain' }
    $live += @{scenario='shell-successor-normal-exit';identities=$sample.identities;forced=$false}
  } finally { $observer.Dispose() }
} catch { $failure = $_ }
finally {
  $parent.Dispose()
  if ($successor) {
    try {
      if (-not $successor.HasExited) { $successor.StandardInput.WriteLine('exit') }
      if (-not $successor.WaitForExit(10000) -or $successor.ExitCode -ne 0) { throw 'Sibling successor remains or failed; retaining fixture' }
    } catch { $cleanup.successorError=$_.Exception.ToString(); if (-not $failure) { $failure=$_ } }
    finally { $successor.Dispose() }
  }
  if ($child) {
    try {
      if (-not $child.HasExited) { $child.StandardInput.WriteLine('exit') }
      if (-not $child.WaitForExit(10000)) { throw 'Owned helper remains alive; retaining fixture' }
      $cleanup.exited = $true
      $cleanup.exitCode = $child.ExitCode
      $cleanup.stderr = $child.StandardError.ReadToEnd()
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
