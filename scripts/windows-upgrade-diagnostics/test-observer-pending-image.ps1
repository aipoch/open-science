param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'HandoffObserver.cs'))
# Replay the captured Win32 error at the real image-query boundary. The process
# handle, creation time, wait signal and later successful query are all native.
$query = 'if (!QueryFullProcessImageNameW(process.Handle, 0, buffer, ref size))'
if (-not $nativeSource.Contains($query)) { throw 'Image query seam changed' }
$probe = $nativeSource.Replace('public class HandoffObserver : IDisposable {', 'public class HandoffObserver : IDisposable { public static bool DenyImage; public static int DenyPid;')
$probe = $probe.Replace($query, 'if (DenyImage && identity.pid==DenyPid) throw new System.ComponentModel.Win32Exception(5); ' + $query)
Add-Type -TypeDefinition $probe -ReferencedAssemblies 'System.Web.Extensions'
$capture = [HandoffObserver].GetMethod('CaptureDescendant',[Reflection.BindingFlags]'Static,NonPublic')
if (-not $capture) { $capture = [HandoffObserver].GetMethod('Capture',[Reflection.BindingFlags]'Static,NonPublic') }
$refresh = [HandoffObserver].GetMethod('RefreshImage',[Reflection.BindingFlags]'Static,Public')
$complete = [HandoffObserver].GetMethod('RequireResolvedImage',[Reflection.BindingFlags]'Static,Public')
$records = @()
foreach ($scenario in @('query-recovers','confirmed-exit','persistent-denial')) {
  [HandoffObserver]::DenyImage = $false
  $rootIdentity=[ObservedProcess]::GetProcessById($PID)
  $rootPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $observer=[HandoffObserver]::new($PID,$rootIdentity.StartTime.ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"),$rootPath,(Join-Path $env:TEMP 'synthetic-installer.exe'),$rootPath,$rootPath,$env:TEMP)
  $rootIdentity.Dispose()
  $start = [Diagnostics.ProcessStartInfo]::new($env:ComSpec,'/d /c set /p fixture=')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $child = [Diagnostics.Process]::Start($start)
  $identity = $null
  try {
    [HandoffObserver]::DenyImage = $true
    [HandoffObserver]::DenyPid = $child.Id
    $identity = $capture.Invoke($null,@([int]$child.Id,[int]$PID))
    if (-not $identity -or $identity.path -or $identity.imageError -ne 5) { throw 'Failed query must retain unresolved identity without a path claim' }
    $sample=$observer.Sample()
    if ($sample.unresolvedImages -lt 1 -or @($sample.identities | Where-Object { $_.pid -eq $child.Id -and $_.path }).Count) { throw 'Real tree sample did not preserve unresolved child' }
    if (@($sample.windows | Where-Object pid -eq $child.Id).Count) { throw 'Unresolved child was counted as a verified window' }
    if ($scenario -eq 'query-recovers') {
      [HandoffObserver]::DenyImage = $false
      $refresh.Invoke($null,@($identity)) | Out-Null
      if ($identity.imageError -ne 0 -or -not $identity.path) { throw 'Same retained handle did not resolve its image' }
      if ($identity.imageQueryFailures -ne 1 -or $identity.lastImageError -ne 5) { throw 'Recovery erased failure evidence' }
      if ($identity.process.StartTime.ToUniversalTime() -ne $child.StartTime.ToUniversalTime()) { throw 'Retained identity changed' }
      $complete.Invoke($null,@($identity)) | Out-Null
      $sample=$observer.Sample()
      if ($sample.unresolvedImages -ne 0) { throw 'Tree sample failed to recover' }
      $observer.RequireResolvedImages()
    } elseif ($scenario -eq 'confirmed-exit') {
      $child.StandardInput.Close()
      if (-not $child.WaitForExit(10000)) { throw 'Fixture failed normal exit' }
      $refresh.Invoke($null,@($identity)) | Out-Null
      if (-not $identity.process.HasExited -or $identity.path) { throw 'Exited candidate must not acquire a path claim' }
      $complete.Invoke($null,@($identity)) | Out-Null
      $observer.Sample() | Out-Null
      $observer.RequireResolvedImages()
    } else {
      $rejected = $false
      try { $complete.Invoke($null,@($identity)) | Out-Null }
      catch { if ($_.Exception.GetBaseException() -is [ComponentModel.Win32Exception]) { $rejected=$true } else { throw } }
      if (-not $rejected) { throw 'Live access denial must prevent acceptance' }
      $rejected=$false
      try { $observer.RequireResolvedImages() } catch { $rejected=$true }
      if (-not $rejected) { throw 'Whole-observer completion ignored live denial' }
    }
    $records += @{scenario=$scenario;pid=$child.Id;status='PASS'}
  } finally {
    if (-not $child.HasExited) { $child.StandardInput.Close() }
    if (-not $child.WaitForExit(10000)) { throw 'Owned fixture remains alive; no forced cleanup' }
    if ($identity) { $identity.process.Dispose() }
    $observer.Dispose()
    $child.Dispose()
  }
}
@{status='PASS';forced=$false;records=$records} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output
