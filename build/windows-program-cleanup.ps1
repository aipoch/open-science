param([Parameter(Mandatory = $true)][string]$StagingPath)

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

try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  [InstallDirectory]::RemoveStagedProgramFiles($StagingPath)
  exit 0
} catch {
  [Console]::Error.WriteLine(
    "Open-Science windows-program-cleanup.ps1 failed phase=remove-staged-program-files stagingPath=`"$StagingPath`" $(Format-ErrorDetails $_.Exception)"
  )
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 2
}
