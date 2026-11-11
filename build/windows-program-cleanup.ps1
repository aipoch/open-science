param(
  [Parameter(Mandatory = $true)][string]$StagingPath,
  [string]$ReportPath,
  [switch]$Upgrade
)

$ErrorActionPreference = 'Stop'

function Format-ErrorDetails([Exception]$Error) {
  $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult), 0)
  $parts = @(
    "exceptionType=$($Error.GetType().FullName)"
    "message=$($Error.Message)"
    ('hresult=0x{0:X8}' -f $hresult)
  )
  $inner = $Error
  while ($inner) {
    $nativeCode = $inner.PSObject.Properties['NativeErrorCode']
    if ($nativeCode -and $null -ne $nativeCode.Value) {
      $parts += "nativeErrorCode=$([int]$nativeCode.Value)"
      break
    }
    $inner = $inner.InnerException
  }
  return ($parts -join ' ')
}

function Get-ErrorEvidence([Exception]$Error) {
  $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult), 0)
  [ordered]@{
    operation = $Error.Data['operation']
    path = $Error.Data['path']
    exceptionType = $Error.GetType().FullName
    message = $Error.Message
    hresult = ('0x{0:X8}' -f $hresult)
    # Only a real Win32Exception is evidence of a Win32 error; HRESULT low bits are not.
    nativeErrorCode = $(if ($Error -is [ComponentModel.Win32Exception]) { $Error.NativeErrorCode } else { $null })
  }
  foreach ($key in @('deletionCancellation', 'attributeRestoration')) {
    if ($Error.Data.Contains($key)) { $script:report[$key] = $Error.Data[$key] }
  }
  if ($Error -is [AggregateException]) {
    foreach ($inner in $Error.InnerExceptions) { Get-ErrorEvidence $inner }
  } elseif ($Error.InnerException) {
    Get-ErrorEvidence $Error.InnerException
  }
}

function Write-CleanupReport {
  if (!$ReportPath) { return }
  try {
    [IO.File]::WriteAllText($ReportPath, ($script:report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  } catch {
    [Console]::Error.WriteLine("Could not save cleanup diagnostic: $($_.Exception.Message)")
  }
}

function Test-RecoverableSharingError([Exception]$Error) {
  foreach ($key in @('deletionCancellation', 'attributeRestoration')) {
    if ($Error.Data.Contains($key) -and $Error.Data[$key] -ne 'succeeded') { return $false }
  }
  if ($Error -is [ComponentModel.Win32Exception] -and $Error.NativeErrorCode -notin @(32, 33)) { return $false }
  if ($Error -is [AggregateException]) {
    foreach ($key in @('deletionCancellation', 'attributeRestoration')) {
      if (!$Error.Data.Contains($key)) { return $false }
    }
    if (!$Error.InnerExceptions.Count) { return $false }
    foreach ($inner in $Error.InnerExceptions) {
      if (!(Test-RecoverableSharingError $inner)) { return $false }
    }
    return $true
  }
  if ($Error.InnerException) { return (Test-RecoverableSharingError $Error.InnerException) }
  return ($Error -is [ComponentModel.Win32Exception])
}

function Save-CleanupAttempt([int]$Number, [int]$Delay) {
  $script:report.attempts += [ordered]@{
    number = $Number
    timestamp = [DateTime]::UtcNow.ToString('o')
    status = $script:report.status
    deletionCancellation = $script:report.deletionCancellation
    attributeRestoration = $script:report.attributeRestoration
    errors = $script:report.errors
    retryDelaySeconds = $Delay
  }
  Write-CleanupReport
}

$report = [ordered]@{
  timestamp = [DateTime]::UtcNow.ToString('o')
  phase = 'remove-staged-program-files'
  stagingPath = $StagingPath
  status = 'failed'
  deletionCancellation = 'unknown'
  attributeRestoration = 'unknown'
  fileMoveBack = 'unknown'
  errors = @()
  attempts = @()
}

$directoryHandle = $null
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    $report.deletionCancellation = 'unknown'
    $report.attributeRestoration = 'unknown'
    try {
      if (!$directoryHandle) {
        $protectedPath = $StagingPath
        if (!$protectedPath.StartsWith('\\?\', [StringComparison]::Ordinal)) {
          $protectedPath = if ($protectedPath.StartsWith('\\', [StringComparison]::Ordinal)) {
            '\\?\UNC\' + $protectedPath.Substring(2)
          } else { '\\?\' + $protectedPath }
        }
        try { $directoryHandle = [InstallDirectory]::HoldForProgramCleanup($protectedPath) }
        catch {
          # Attach this synchronous hold's context to the actual failure, not PowerShell's
          # invocation wrapper, so its native reason stays paired with the operation.
          $failure = $_.Exception.GetBaseException()
          $failure.Data['operation'] = 'hold-staging-directory'
          $failure.Data['path'] = $StagingPath
          throw
        }
      }
      # Keep the no-delete-sharing directory handle across all calls and waits. The staging
      # name cannot be replaced between otherwise independently protected helper calls.
      [InstallDirectory]::RemoveStagedProgramFiles($StagingPath)
      $report.status = 'succeeded'
      $report.errors = @()
      $report.deletionCancellation = 'not-needed'
      $report.attributeRestoration = 'not-needed'
      Save-CleanupAttempt $attempt 0
      [Console]::WriteLine("Open-Science program cleanup attempt=$attempt result=succeeded")
      exit 0
    } catch {
      $report.errors = @(Get-ErrorEvidence $_.Exception)
      $delay = 0
      if ($Upgrade -and $attempt -lt 4 -and
          $report.deletionCancellation -eq 'succeeded' -and $report.attributeRestoration -eq 'succeeded' -and
          (Test-RecoverableSharingError $_.Exception)) { $delay = $attempt }
      Save-CleanupAttempt $attempt $delay
      [Console]::Error.WriteLine("Open-Science program cleanup attempt=$attempt result=failed deletionCancellation=$($report.deletionCancellation) attributeRestoration=$($report.attributeRestoration) $(Format-ErrorDetails $_.Exception)")
      [Console]::Error.WriteLine($_.Exception.ToString())
      if (!$delay) { exit 2 }
      [Console]::WriteLine("Open-Science program cleanup retry: waiting $delay second(s), next attempt=$($attempt + 1)")
      Start-Sleep -Seconds $delay
    }
  }
} catch {
  $report.errors = @(Get-ErrorEvidence $_.Exception)
  Write-CleanupReport
  [Console]::Error.WriteLine(
    "Open-Science windows-program-cleanup.ps1 failed phase=remove-staged-program-files stagingPath=`"$StagingPath`" $(Format-ErrorDetails $_.Exception)"
  )
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 2
} finally {
  if ($directoryHandle) { $directoryHandle.Dispose() }
}
