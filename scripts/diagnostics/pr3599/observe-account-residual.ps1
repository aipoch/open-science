param([Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath (Join-Path $EvidenceDirectory 'final-account-processes.json') -Raw | ConvertFrom-Json
$observations = @()
foreach ($record in @($state.processes)) {
  if ($record.path -ine (Join-Path $env:SystemRoot 'System32\DllHost.exe') -or $record.commandLine -notmatch '/Processid:\{3EB3C877-1F16-487C-9050-104DBCD66683\}$') { throw 'Unexpected residual; retain it without intervention' }
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (!$current -or $current.CreationDate.ToUniversalTime() -ne ([datetime]$record.created).ToUniversalTime()) {
    $observations += @{identity=$record;originalAbsent=$true;forced=$false}
    continue
  }
  $owner = Invoke-CimMethod -InputObject $current -MethodName GetOwner
  if ($owner.User -ne $state.account) { throw 'Residual account identity changed' }
  $process = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    $null = $process.Handle
    if ($process.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne ([datetime]$record.created).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'")) { throw 'Residual creation time changed' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $exited = $process.WaitForExit(180000)
    $observations += @{identity=$record;exited=$exited;exitCode=if($exited){$process.ExitCode}else{$null};observedWaitMs=$timer.ElapsedMilliseconds;observedAt=[datetime]::UtcNow.ToString('o');forced=$false}
  } finally { $process.Dispose() }
}
@{diagnosticOnly=$true;originalAcceptanceRemainsFailed=$true;observations=$observations} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'residual-natural-exit-observation.json')
