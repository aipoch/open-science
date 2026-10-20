param(
  [string]$Script,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [ValidateSet('basic','wininet')][string]$Probe = 'basic'
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Account provisioning is restricted to disposable GitHub-hosted runners'
}
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Only the runner controller may provision the isolated ordinary account'
}
. (Join-Path $PSScriptRoot 'account-processes.ps1')
$scriptPath = if ($Script) { (Resolve-Path -LiteralPath $Script).Path } else { $null }
$checkout = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
if ($scriptPath -and -not $scriptPath.StartsWith($checkout+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Probe must belong to the checked-out candidate' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$name = 'upgrade-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$password = 'A7!' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Write-Output "::add-mask::$password"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $secure -AccountNeverExpires -Description 'Disposable Windows upgrade diagnostic'
$root = Join-Path $env:RUNNER_TEMP $name
$process = $null
$remaining = @()
$baseline=$null
$validationError=$null
try {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  New-Item -ItemType Directory -Path $root,(Join-Path $root 'evidence'),(Join-Path $root 'temp') -Force | Out-Null
  & icacls.exe $checkout /grant "*$($account.SID.Value):(OI)(CI)RX" /Q
  if ($LASTEXITCODE) { throw 'Cannot grant read access to candidate' }
  & icacls.exe $root /grant "*$($account.SID.Value):(OI)(CI)M" /Q
  if ($LASTEXITCODE) { throw 'Cannot grant access to synthetic directory' }
  @{script=$scriptPath;preflight=(Join-Path $PSScriptRoot 'account-preflight.ps1');root=$root;probe=$Probe;node=(Get-Command node.exe).Source} | ConvertTo-Json | Set-Content (Join-Path $root 'config.json')
  $launcher = Join-Path $root 'launch.ps1'
  @'
param([switch]$Ready)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
if (-not $Ready) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AccountEnvironment {
  [DllImport("userenv.dll", SetLastError=true)] public static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr block);
}
"@
  $block=[IntPtr]::Zero
  if (-not [AccountEnvironment]::CreateEnvironmentBlock([ref]$block,[Security.Principal.WindowsIdentity]::GetCurrent().Token,$false)) { throw 'Cannot obtain isolated account environment' }
  $start=[Diagnostics.ProcessStartInfo]::new("$PSHOME\powershell.exe",('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Ready'))
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.EnvironmentVariables.Clear()
  try {
    $cursor=$block
    while ($true) {
      $entry=[Runtime.InteropServices.Marshal]::PtrToStringUni($cursor)
      if (-not $entry) { break }
      $separator=$entry.IndexOf('=')
      if ($separator -gt 0) { $start.EnvironmentVariables[$entry.Substring(0,$separator)]=$entry.Substring($separator+1) }
      $cursor=[IntPtr]::Add($cursor,($entry.Length+1)*2)
    }
  } finally { [void][AccountEnvironment]::DestroyEnvironmentBlock($block) }
  $start.EnvironmentVariables['TEMP']=Join-Path $config.root 'temp'
  $start.EnvironmentVariables['TMP']=$start.EnvironmentVariables['TEMP']
  $start.EnvironmentVariables['PATH']=(Split-Path $config.node)+';'+$start.EnvironmentVariables['PATH']
  $start.EnvironmentVariables['PSModulePath']=Join-Path $PSHOME 'Modules'
  $child=[Diagnostics.Process]::Start($start)
  try {
    if (-not $child.WaitForExit(300000)) { throw 'Ordinary probe exceeded deadline; retain all evidence' }
    exit $child.ExitCode
  } finally { $child.Dispose() }
}
$evidence=Join-Path $config.root 'evidence'
& $config.preflight -EvidenceDirectory $evidence -Probe $config.probe -Node $config.node
if (-not $?) { exit 1 }
[IO.File]::WriteAllText((Join-Path $config.root 'preflight.ready'),'ready')
$deadline=[DateTime]::UtcNow.AddSeconds(60)
while (-not (Test-Path -LiteralPath (Join-Path $config.root 'baseline.ready'))) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Controller did not bind pre-product environment baseline' }
  Start-Sleep -Milliseconds 100
}
if ($config.script) {
  & $config.script -EvidenceDirectory $evidence
  if (-not $?) { exit 1 }
}
'@ | Set-Content -LiteralPath $launcher
  $credential=[PSCredential]::new("$env:COMPUTERNAME\$name",$secure)
  $process=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$launcher+'"')) -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log') -WindowStyle Hidden -PassThru
  # Retain the handle before exit: Windows PowerShell's detached Process otherwise loses ExitCode.
  $null=$process.Handle
  $controllerDeadline=[DateTime]::UtcNow.AddSeconds(330)
  while (-not $process.WaitForExit(100)) {
    if (-not $baseline -and (Test-Path -LiteralPath (Join-Path $root 'preflight.ready'))) {
      $baseline=New-UpgradeEnvironmentBaseline @(Get-UpgradeAccountProcesses $account.SID.Value) $account.SID.Value
      $baseline | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'environment-baseline.json')
      [IO.File]::WriteAllText((Join-Path $root 'baseline.ready'),'ready')
    }
    if ([DateTime]::UtcNow -gt $controllerDeadline) { throw 'Ordinary account controller exceeded deadline' }
  }
  $process.Refresh()
  @{pid=$process.Id;exitCode=$process.ExitCode;forced=$false} | ConvertTo-Json | Set-Content (Join-Path $output 'controller.json')
  if ($process.ExitCode -ne 0) { throw 'Ordinary account probe failed' }
  if (-not $baseline) { throw 'Missing pre-product environment baseline' }
} catch {
  $validationError=$_.Exception.ToString()
  throw
} finally {
  if ($process) { $process.Dispose() }
  $auditError=$null
  $classification=$null
  $initial=@()
  if (-not $baseline) { $baseline=@{schemaVersion=1;sid=$account.SID.Value;services=@();executable=$null} }
  try {
    $remaining=@(Get-UpgradeAccountProcesses $account.SID.Value)
    $initial=$remaining
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    $classification=Split-UpgradeResiduals $remaining $baseline $account.SID.Value
    while ($classification.unconfirmedResiduals.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
      # Observe natural exit at the existing deadline; never force cleanup into PASS.
      Start-Sleep -Milliseconds 250
      $remaining=@(Get-UpgradeAccountProcesses $account.SID.Value)
      $classification=Split-UpgradeResiduals $remaining $baseline $account.SID.Value
    }
  } catch { if (-not $auditError) { $auditError=$_.Exception.ToString() } }
  $collectionError=$null
  try {
    foreach ($relative in @('evidence','stdout.log','stderr.log')) {
      $path=Join-Path $root $relative
      if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $output -Recurse }
    }
  } catch { $collectionError=$_.Exception.Message }
  # Save the final audit after collection. No recursive traversal of the OS profile.
  try {
    $remaining=@(Get-UpgradeAccountProcesses $account.SID.Value)
    $classification=Split-UpgradeResiduals $remaining $baseline $account.SID.Value
  } catch { if (-not $auditError) { $auditError=$_.Exception.ToString() } }
  $accountRemovalError=$null
  if (-not $auditError -and $remaining.Count -eq 0) {
    try { Remove-LocalUser -Name $name } catch { $accountRemovalError=$_.Exception.ToString() }
  }
  @{account=$name;sid=$account.SID.Value;root=$root;initial=$initial;processes=$remaining;classification=$classification;forced=$false;collectionError=$collectionError;auditError=$auditError;validationError=$validationError;accountRemovalError=$accountRemovalError} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'final-account-processes.json')
  if ($classification.environmentResiduals.Count -gt 0) { Write-Warning 'Verified pre-product Windows service remains; account is retained for VM disposal, not reported as empty' }
  if ($auditError -or $accountRemovalError -or $classification.unconfirmedResiduals.Count -gt 0 -or $collectionError) { throw 'Account cleanup unconfirmed; preserve directory, account and logs for VM disposal' }
}
