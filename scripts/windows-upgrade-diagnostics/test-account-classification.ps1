param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'account-processes.ps1')
$sid='S-1-5-21-100-100-100-1001'
$path=Join-Path ([Environment]::SystemDirectory) 'DllHost.exe'
$record=@{pid=100;parent=50;created='2026-10-18T00:00:00.1234560Z';path=$path;commandLine=('"'+$path+'" /Processid:{3EB3C877-1F16-487C-9050-104DBCD66683}');sid=$sid}
# The signature boundary is substituted only for the classification unit cases.
# The disposable-account CI preflight uses real Authenticode and HKLM evidence.
function Get-WinInetExecutableEvidence { @{path=$path;sha256='verified-hash';publisher='Microsoft Windows'} }
$baseline=New-UpgradeEnvironmentBaseline @($record) $sid
$records=@()
function Check($Name,$Value,$Expected) {
  $result=Split-UpgradeResiduals @($Value) $baseline $sid
  if ($result.environmentResiduals.Count -ne $Expected -or $result.unconfirmedResiduals.Count -ne (1-$Expected)) { throw "Unexpected classification: $Name" }
  if ($result.accountEmpty) { throw 'An environmental process must not be reported as an empty account' }
  $script:records+=@{name=$Name;status='PASS'}
}
Check 'exact pre-product service' $record 1
foreach ($change in @(
  @('pid',101),@('parent',51),@('created','2026-10-18T00:00:00.1234570Z'),@('sid','S-1-5-18'),
  @('path','C:\synthetic\DllHost.exe'),@('commandLine',('"'+$path+'" /Processid:{00000000-0000-0000-0000-000000000000}')),
  @('commandLine',($record.commandLine+' --extra'))
)) {
  $wrong=$record.Clone(); $wrong[$change[0]]=$change[1]
  Check ('reject changed '+$change[0]) $wrong 0
}
$empty=@{schemaVersion=1;sid=$sid;services=@();executable=$null}
if ((Split-UpgradeResiduals @($record) $empty $sid).unconfirmedResiduals.Count -ne 1) { throw 'Post-baseline service was exempted' }
$baseline.executable.sha256='changed'
Check 'changed system executable' $record 0
function Get-WinInetExecutableEvidence { throw 'Invalid system signature' }
$rejected=$false
try { Split-UpgradeResiduals @($record) $baseline $sid | Out-Null } catch { $rejected=$true }
if (-not $rejected) { throw 'Signature failure was ignored' }
if (-not (Split-UpgradeResiduals @() $empty $sid).accountEmpty) { throw 'Empty account result incorrect' }
@{status='PASS';records=$records;postBaselineRejected=$true;signatureFailureRejected=$true;forced=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output
