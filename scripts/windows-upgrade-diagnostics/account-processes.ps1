# Dot-source from the disposable runner controller. This module never terminates processes.
$cacheAppId = '{3EB3C877-1F16-487C-9050-104DBCD66683}'
function Get-UpgradeAccountProcesses([string]$Sid) {
  @(Get-CimInstance Win32_Process | ForEach-Object {
    $candidate=$_
    if ($candidate.ProcessId -in @(0,4)) { return }
    $owner=Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if (-not $owner -or $owner.ReturnValue -ne 0) {
      $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)"
      if ($current -and $current.CreationDate -eq $candidate.CreationDate) { throw "Cannot determine owner of retained process $($candidate.ProcessId)" }
      return
    }
    if ($owner.Sid -eq $Sid) {
      $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)"
      if ($current -and $current.CreationDate -eq $candidate.CreationDate) {
        @{pid=$candidate.ProcessId;parent=$candidate.ParentProcessId;created=$candidate.CreationDate.ToUniversalTime().ToString('o');path=$candidate.ExecutablePath;commandLine=$candidate.CommandLine;sid=$Sid}
      } elseif ($current) { throw 'Process identity changed during account observation' }
    }
  })
}
function Test-WinInetIdentity($Record, [string]$Sid, [string]$SystemDirectory) {
  $expected=Join-Path $SystemDirectory 'DllHost.exe'
  $command='^"?'+[regex]::Escape($expected)+'"?\s+/Processid:'+ [regex]::Escape($cacheAppId)+'$'
  return $Record.sid -eq $Sid -and $Record.path -ieq $expected -and $Record.commandLine -imatch $command
}
function Get-WinInetExecutableEvidence {
  $file=Join-Path ([Environment]::SystemDirectory) 'DllHost.exe'
  # HKLM avoids trusting per-user COM registration overrides.
  $registration=Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Classes\AppID\'+$cacheAppId)
  if ($registration.'(default)' -ne 'WinInetCacheServer') { throw 'WinINet AppID registration mismatch' }
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Windows(?: Publisher)?, O=Microsoft Corporation,') {
    throw 'System surrogate signature is not valid Microsoft Windows code'
  }
  @{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;publisher=$signature.SignerCertificate.Subject;appId=$cacheAppId}
}
function New-UpgradeEnvironmentBaseline([object[]]$Records,[string]$Sid) {
  $services=@($Records | Where-Object { Test-WinInetIdentity $_ $Sid ([Environment]::SystemDirectory) })
  $executable=if ($services.Count) { Get-WinInetExecutableEvidence } else { $null }
  @{schemaVersion=1;capturedAt=[DateTime]::UtcNow.ToString('o');sid=$Sid;services=$services;executable=$executable}
}
function Split-UpgradeResiduals([object[]]$Records, $Baseline, [string]$Sid) {
  if ($Baseline.schemaVersion -ne 1 -or $Baseline.sid -ne $Sid) { throw 'Invalid environment baseline' }
  $environment=@()
  $unconfirmed=@()
  $currentExecutable=$null
  foreach ($record in $Records) {
    $same=@($Baseline.services | Where-Object {
      $_.pid -eq $record.pid -and $_.created -ceq $record.created -and $_.parent -eq $record.parent -and
      $_.sid -eq $record.sid -and $_.path -ieq $record.path -and $_.commandLine -ceq $record.commandLine
    })
    if ($same.Count -eq 1 -and (Test-WinInetIdentity $record $Sid ([Environment]::SystemDirectory))) {
      if (-not $currentExecutable) { $currentExecutable=Get-WinInetExecutableEvidence }
      if ($Baseline.executable -and $currentExecutable.sha256 -eq $Baseline.executable.sha256 -and $currentExecutable.publisher -eq $Baseline.executable.publisher) {
        $environment+=$record
        continue
      }
    }
    $unconfirmed+=$record
  }
  @{environmentResiduals=$environment;unconfirmedResiduals=$unconfirmed;accountEmpty=($Records.Count -eq 0)}
}
