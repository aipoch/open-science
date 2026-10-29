param(
  [Parameter(Mandatory=$true)][string]$Extractor,
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$ListDirectory
)
$ErrorActionPreference='Stop'

function Start-Extractor([string]$Selectors) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$Extractor
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.Arguments='x -y -bd -bso0 -bsp0 -bse1 -spd "-o'+$Target+'" "'+$Archive+'" '+$Selectors
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$info
  try { [void]$process.Start() } catch { $process.Dispose(); throw }
  return $process
}

# Create archive directories first, including empty ones, so the file workers do not race
# on directory creation. Exclude every file: parent-directory selectors are recursive.
$directories=Join-Path $ListDirectory 'all-directories.txt'
$files=Join-Path $ListDirectory 'all-files.txt'
$directoryProcess=Start-Extractor ('"-i@'+$directories+'" "-x@'+$files+'"')
try {
  $directoryProcess.WaitForExit()
  if ($directoryProcess.ExitCode -ne 0) { throw ('Directory extraction failed: '+$directoryProcess.ExitCode) }
} finally { $directoryProcess.Dispose() }

$children=@()
$failure=$null
try {
  for ($index=0; $index -lt 2; $index++) {
    $list=Join-Path $ListDirectory ('files-2-'+$index+'.txt')
    # An empty partition must not be interpreted as an unrestricted archive selector.
    if ((Get-Item -LiteralPath $list).Length -eq 0) { continue }
    $children+=Start-Extractor ('"-i@'+$list+'"')
  }
} finally {
  # Even if starting a later child fails, wait for all earlier children before NSIS may
  # clean up staging. Nonzero warning exits are failures as well as fatal errors.
  foreach ($child in $children) {
    try {
      $child.WaitForExit()
      if ($child.ExitCode -ne 0) { $failure='File extraction failed: '+$child.ExitCode }
    } catch { $failure=$_.Exception.Message }
    finally { $child.Dispose() }
  }
}
if ($failure) { throw $failure }
