param(
  [Parameter(Mandatory=$true)][string]$Extractor,
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$ListDirectory,
  [string]$ReportPath
)
$ErrorActionPreference='Stop'
$toolFailures=@()
$errors=@()
$childErrors=@()
$diagnosticSource='powershell-extractor'
$diagnosticOperation='resolve-extraction-lists'
$diagnosticPath=$ListDirectory

function Get-ExtractionError([Exception]$Error) {
  $hresult=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult),0)
  [ordered]@{
    operation=$script:diagnosticOperation; path=$script:diagnosticPath; errorSource=$script:diagnosticSource
    exceptionType=$Error.GetType().FullName; message=$Error.Message; hresult=('0x{0:X8}' -f $hresult)
    nativeErrorCode=$(if ($Error -is [ComponentModel.Win32Exception]) { $Error.NativeErrorCode } else { $null })
  }
  if ($Error -is [AggregateException]) {
    foreach ($inner in $Error.InnerExceptions) { Get-ExtractionError $inner }
  } elseif ($Error.InnerException) { Get-ExtractionError $Error.InnerException }
}

function Start-Extractor([string]$Selectors) {
  $script:diagnosticSource='powershell-extractor'
  $script:diagnosticOperation='start-extractor'; $script:diagnosticPath=$Extractor
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$Extractor
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.Encoding]::UTF8
  $info.StandardErrorEncoding=[Text.Encoding]::UTF8
  $info.Arguments='x -y -bd -bso0 -bsp0 -bse1 -sccUTF-8 -spd "-o'+$Target+'" "'+$Archive+'" '+$Selectors
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$info
  try { [void]$process.Start() } catch { $process.Dispose(); throw }
  # Drain both pipes immediately, including workers we will wait for later. Waiting first
  # can deadlock when either pipe fills; inherited handles lose output under nsExec.
  $process | Add-Member -NotePropertyName CapturedStdout -NotePropertyValue ($process.StandardOutput.ReadToEndAsync())
  $process | Add-Member -NotePropertyName CapturedStderr -NotePropertyValue ($process.StandardError.ReadToEndAsync())
  return $process
}

function Get-ExtractorResult([Diagnostics.Process]$Process,[string]$Operation) {
  $result=[ordered]@{ operation=$Operation; errorSource='7za'; toolExitCode=$Process.ExitCode; archive=$Archive }
  foreach ($name in @('stdout','stderr')) {
    try {
      $task=if ($name -eq 'stdout') { $Process.CapturedStdout } else { $Process.CapturedStderr }
      $text=$task.GetAwaiter().GetResult()
      # Bound durable evidence, not the pipe reader: all children must still be drained.
      $result[$name]=$text.Substring(0,[Math]::Min($text.Length,16384))
      $result[$name+'Truncated']=$text.Length -gt 16384
    } catch {
      # Diagnostic capture must not replace the proven tool exit with a secondary read error.
      $result[$name+'ReadError']=$_.Exception.Message
    }
  }
  return $result
}

# Create archive directories first, including empty ones, so the file workers do not race
# on directory creation. Exclude every file: parent-directory selectors are recursive.
try {
$directories=Join-Path $ListDirectory 'all-directories.txt'
$files=Join-Path $ListDirectory 'all-files.txt'
$directoryProcess=Start-Extractor ('"-i@'+$directories+'" "-x@'+$files+'"')
try {
  $diagnosticOperation='wait-extractor'; $diagnosticPath=$Extractor
  $directoryProcess.WaitForExit()
  $directoryResult=Get-ExtractorResult $directoryProcess 'extract-directories'
  if ($directoryProcess.ExitCode -ne 0) {
    $toolFailures += $directoryResult
    $diagnosticSource='7za'; $diagnosticOperation='extract-directories'; $diagnosticPath=$null
    throw ('Directory extraction failed: '+$directoryProcess.ExitCode)
  }
} finally { $directoryProcess.Dispose() }

$children=@()
$failure=$null
try {
  for ($index=0; $index -lt 2; $index++) {
    $list=Join-Path $ListDirectory ('files-2-'+$index+'.txt')
    $diagnosticSource='powershell-extractor'
    $diagnosticOperation='read-extraction-list'; $diagnosticPath=$list
    # An empty partition must not be interpreted as an unrestricted archive selector.
    if ((Get-Item -LiteralPath $list).Length -eq 0) { continue }
    $children+=Start-Extractor ('"-i@'+$list+'"')
  }
} catch {
  # Capture the original failure before draining children changes the diagnostic context.
  $failure=$_; $failureSource=$diagnosticSource
  $errors=@(Get-ExtractionError $_.Exception)
} finally {
  # Even if starting a later child fails, wait for all earlier children before NSIS may
  # clean up staging. Nonzero warning exits are failures as well as fatal errors.
  foreach ($child in $children) {
    try {
      $diagnosticSource='powershell-extractor'
      $diagnosticOperation='wait-extractor'; $diagnosticPath=$Extractor
      $child.WaitForExit()
      $childResult=Get-ExtractorResult $child 'extract-files'
      if ($child.ExitCode -ne 0) {
        $toolFailures += $childResult
        $diagnosticSource='7za'; $diagnosticOperation='extract-files'; $diagnosticPath=$null
        throw ('File extraction failed: '+$child.ExitCode)
      }
    } catch {
      if (!$failure) {
        $failure=$_; $failureSource=$diagnosticSource
        $errors=@(Get-ExtractionError $_.Exception)
      } else { $childErrors+=@(Get-ExtractionError $_.Exception) }
    }
    finally { $child.Dispose() }
  }
}
if ($failure) { $diagnosticSource=$failureSource; throw $failure }
} catch {
  if ($ReportPath) {
    try {
      if ($errors.Count -eq 0) { $errors=@(Get-ExtractionError $_.Exception) }
      $report=[ordered]@{
        phase='extract-new-program-files'; status='failed'; errorSource=$diagnosticSource
        archive=$Archive; target=$Target; errors=$errors; toolFailures=$toolFailures; childErrors=$childErrors
      }
      [IO.File]::WriteAllText($ReportPath,($report | ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
    } catch { [Console]::Error.WriteLine("Could not save extraction diagnostic: $($_.Exception.Message)") }
  }
  throw
}
