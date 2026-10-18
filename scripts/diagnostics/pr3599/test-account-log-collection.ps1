param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'run-as-standard-user.ps1'))
$start = $source.IndexOf('    $accountLogRoots =')
if ($start -lt 0) { $start = $source.IndexOf('    Get-ChildItem -LiteralPath $accountProfile.LocalPath -Recurse') }
$end = $source.IndexOf('    @{sid=$account.SID.Value;', $start)
if ($start -lt 0 -or $end -lt 0) { throw 'Account log collection boundary missing' }
$collect = [scriptblock]::Create($source.Substring($start, $end - $start))
$fixture = Join-Path ([IO.Path]::GetFullPath((Split-Path -Parent $Output))) ('log-fixture-' + [guid]::NewGuid())
$accountProfile = @{LocalPath=(Join-Path $fixture 'account')}
$logs = Join-Path $fixture 'collected'
$systemLog = Join-Path $accountProfile.LocalPath 'AppData\Local\Microsoft\Windows\WebCache\V01.log'
$productLog = Join-Path $accountProfile.LocalPath 'AppData\Roaming\Open-Science\desktop-logs\main.log'
New-Item -ItemType Directory -Force -Path (Split-Path $systemLog),(Split-Path $productLog),$logs | Out-Null
[IO.File]::WriteAllText($systemLog,'locked operating-system log')
[IO.File]::WriteAllText($productLog,'product evidence')
$lock = [IO.File]::Open($systemLog,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  & $collect
  $files = @(Get-ChildItem -LiteralPath $logs -File)
  if ($files.Count -ne 1 -or [IO.File]::ReadAllText($files[0].FullName) -ne 'product evidence') { throw 'Product log missing or unrelated log copied' }
} finally { $lock.Dispose() }
$lock = [IO.File]::Open($productLog,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$rejected = $false
try { & $collect } catch { $rejected = $true } finally { $lock.Dispose() }
if (!$rejected) { throw 'Locked product evidence was silently skipped' }
@{status='PASS';unrelatedLockedLogExcluded=$true;productLogCopied=$true;lockedProductLogFails=$true;fixture=$fixture} | ConvertTo-Json | Set-Content -LiteralPath $Output
