param(
  [Parameter(Mandatory = $true)][ValidateSet('record', 'finalize')][string]$Action,
  [string]$ReportPath,
  [string]$ReportsDirectory,
  [string]$InstallPath,
  [string]$Phase = 'remove-old-program-files',
  [string]$Operation,
  [string]$FailedPath,
  [string]$ErrorSource,
  [string]$OutputPath,
  [string]$CleanupReportPath,
  [string]$CleanupExitCode,
  [string]$CleanupOutputPath,
  [string]$MessagePath,
  [ValidateSet('failed', 'recovered')][string]$Outcome = 'failed',
  [int]$NativeErrorCode = -1,
  [ValidateSet('unknown', 'succeeded', 'failed')][string]$MoveBack = 'unknown',
  [string]$ExitCode,
  [string]$AppVersion = 'unknown',
  [string]$ProductName = 'Open-Science',
  [int]$Language = 1033,
  [string]$LogDirectory
)

# Diagnostic evidence is private to one installer and never authorizes a file operation.
# Every write is best effort: it must not change the original installer result or recovery.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::Unicode
$report = $null
try {
  if ($ReportPath -and [IO.File]::Exists($ReportPath)) {
    $report = [IO.File]::ReadAllText($ReportPath) | ConvertFrom-Json
  }
} catch {
  [Console]::Error.WriteLine("Could not read cleanup diagnostic: $($_.Exception.Message)")
}

if ($Action -eq 'record') {
  try {
    if (!$report) {
      $report = [pscustomobject]@{
        timestamp = [DateTime]::UtcNow.ToString('o')
        phase = $Phase
        status = 'failed'
        deletionCancellation = 'unknown'
        attributeRestoration = 'unknown'
        fileMoveBack = 'unknown'
        errors = @()
      }
    }
    if ($Phase -ne 'remove-old-program-files') { $report.phase = $Phase }
    if ($ErrorSource) {
      # The wrapper's exit status must not replace the extractor's proven failure source.
      if ($ErrorSource -ne 'powershell-extractor' -or !$report.errorSource) {
        $report | Add-Member -Force NoteProperty errorSource $ErrorSource
      }
      $report | Add-Member -Force NoteProperty exitCode $ExitCode
      $report | Add-Member -Force NoteProperty exitCodeSource $ErrorSource
      $report | Add-Member -Force NoteProperty installationIncomplete $true
      if (!$report.PSObject.Properties['diagnosticId']) {
        $report | Add-Member NoteProperty diagnosticId ([Guid]::NewGuid().ToString('N'))
      }
    }
    if ($OutputPath -and [IO.File]::Exists($OutputPath)) {
      $toolOutput = [IO.File]::ReadAllText($OutputPath, [Text.Encoding]::Unicode)
      $report | Add-Member -Force NoteProperty output $toolOutput
      if ($ErrorSource -eq 'robocopy') {
        # Robocopy's process code is a bitmask, not a Win32 error. Its per-file error line
        # includes an invariant hexadecimal Windows code even on localized systems. Only
        # that explicit evidence identifies a Windows reason and the failing file.
        $copyErrors = @()
        foreach ($match in [regex]::Matches($toolOutput, '(?m)^.*\(0x([0-9A-Fa-f]{8})\)[^\r\n]*?([A-Za-z]:\\[^\r\n]+)')) {
          $copyErrors += [pscustomobject]@{
            operation = 'copy-payload-entry'; path = $match.Groups[2].Value.TrimEnd()
            errorSource = 'robocopy-reported-win32'
            windowsErrorCode = [Convert]::ToUInt32($match.Groups[1].Value, 16)
            nativeErrorCode = $null; message = $match.Value
          }
        }
        $report.errors = $copyErrors
      }
    }
    if ($Operation) {
      $evidence = [pscustomobject]@{
        operation = $Operation
        path = $FailedPath
        exceptionType = $null
        hresult = $null
        nativeErrorCode = $(if ($NativeErrorCode -ge 0) { $NativeErrorCode } else { $null })
        message = $(if ($NativeErrorCode -ge 0) { [ComponentModel.Win32Exception]::new($NativeErrorCode).Message } else { 'NSIS reported a failed operation; native error unavailable.' })
      }
      if ($MoveBack -eq 'unknown') {
        $report.errors = @($report.errors) + @($evidence)
      } else {
        # Keep the original cleanup errors separate from later move-back errors.
        $report | Add-Member -Force NoteProperty moveBackError $evidence
      }
    }
    if ($MoveBack -ne 'unknown') { $report.fileMoveBack = $MoveBack }
    [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
  } catch {
    [Console]::Error.WriteLine("Could not save cleanup diagnostic: $($_.Exception.Message)")
  }
  exit 0
}

$savedPath = $null
if ($report -and $Outcome -eq 'recovered') {
  $report | Add-Member -Force NoteProperty finalOutcome 'recovered'
  $report | Add-Member -Force NoteProperty installationIncomplete $false
  $report.status = 'recovered'
  try { [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false)) } catch {
    [Console]::Error.WriteLine("Could not update recovered installer diagnostic: $($_.Exception.Message)")
  }
}
try {
  if (!$LogDirectory) {
    $LogDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Open-Science\logs\installer'
  }
  [IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
  # A copy Retry/Cancel notice can precede temporary cleanup. Refresh that same attempt's log
  # after cancellation instead of leaving the user with a stale cleanup outcome or two notices.
  $id = if ($report -and $report.PSObject.Properties['diagnosticId'] -and $report.diagnosticId -match '^[a-f0-9]{32}$') { $report.diagnosticId } else { [Guid]::NewGuid().ToString('N') }
  $candidate = Join-Path $LogDirectory ('install-failure-' + $id + '.log')
  $text = "$ProductName installer diagnostic`r`nversion=$AppVersion`r`ntime=$([DateTime]::UtcNow.ToString('o'))`r`nphase=$Phase`r`nexitCode=$ExitCode`r`noutcome=$Outcome`r`ninstallPath=$InstallPath`r`nfinalReport=$ReportPath`r`n"
  if ($CleanupExitCode) { $text += "temporaryCleanupExitCode=$CleanupExitCode`r`n" }
  if ($ReportsDirectory -and [IO.Directory]::Exists($ReportsDirectory)) {
    foreach ($path in [IO.Directory]::GetFiles($ReportsDirectory, 'cleanup-attempt-*.json') | Sort-Object) {
      $text += "`r`n--- $([IO.Path]::GetFileName($path)) ---`r`n" + [IO.File]::ReadAllText($path) + "`r`n"
    }
  }
  if ($report -and (!$ReportsDirectory -or [IO.Path]::GetDirectoryName($ReportPath) -ne $ReportsDirectory -or [IO.Path]::GetFileName($ReportPath) -notlike 'cleanup-attempt-*.json')) {
    $text += $report | ConvertTo-Json -Depth 16
  }
  if (!$report) { $text += "`r`nFinal child report missing or unreadable. Recovery state unknown.`r`n" }
  if ($CleanupReportPath -and [IO.File]::Exists($CleanupReportPath)) {
    $text += "`r`n--- Temporary payload cleanup (independent of original failure) ---`r`n" + [IO.File]::ReadAllText($CleanupReportPath) + "`r`n"
  }
  if ($CleanupOutputPath -and [IO.File]::Exists($CleanupOutputPath)) {
    $text += "`r`n--- Temporary payload cleanup output ---`r`n" + [IO.File]::ReadAllText($CleanupOutputPath, [Text.Encoding]::Unicode) + "`r`n"
  }
  [IO.File]::WriteAllText($candidate, $text, [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($candidate)) { $savedPath = $candidate }
} catch {
  [Console]::Error.WriteLine("Could not save persistent installer diagnostic: $($_.Exception.Message)")
}

# Keep the primary notice short enough for NSIS; complete paths and exception trees stay in the log.
$errors = @()
if ($report) { $errors = @($report.errors | Where-Object { $_.operation }) }
$failure = $errors | Select-Object -First 1
$file = if ($failure.path) { [IO.Path]::GetFileName($failure.path) } else { $null }
if ($file -and $file.Length -gt 80) { $file = $file.Substring(0, 77) + '...' }
$incomplete = $report -and ($report.deletionCancellation -eq 'failed' -or $report.attributeRestoration -eq 'failed' -or $report.fileMoveBack -eq 'failed')
$unknown = !$report -or $report.fileMoveBack -eq 'unknown'
$code = if ($failure) { $failure.nativeErrorCode } else { $null }
# Preserve tool results as tool results; they do not identify a Windows file error.
$source = if ($report.errorSource) { $report.errorSource } elseif ($Phase -eq 'remove-old-program-files') { 'uninstaller' } else { 'installer' }
$result = if ($report.exitCode) { $report.exitCode } else { $ExitCode }
# A secondary child's tool failure cannot replace an earlier script or process error.
$toolFailure = if ($report -and $source -eq '7za') { $report.toolFailures | Where-Object { $_.errorSource -eq $source -and $null -ne $_.toolExitCode } | Select-Object -First 1 }
if ($toolFailure) { $source = $toolFailure.errorSource; $result = $toolFailure.toolExitCode }
$sourceResult = ''
if ($null -ne $result -and [string]$result -ne '') {
  $sourceResult = "Error source: $source; result: $result."
  if ($Language -eq 2052) { $sourceResult = "错误来源：${source}；结果：${result}。" }
  elseif ($Language -eq 1028) { $sourceResult = "錯誤來源：${source}；結果：${result}。" }
}
$reason = 'Windows could not remove the old application files.'
$advice = 'Check the reported path, available disk space and security software records, then run the official installer again.'
if ($code -eq 32 -or $code -eq 33) {
  $reason = 'An application file is in use.'
  $advice = 'Close tasks using this file and run the installer again. If it persists, restart Windows and retry.'
} elseif ($code -eq 5) {
  $reason = 'Windows denied access to an application file.'
  $advice = 'Check access permissions and security software records. Use administrator access only if this installation folder requires it.'
}
$recovery = ''
if ($incomplete) {
  $recovery = 'Old files were not fully restored.'
  $advice = 'Keep the diagnostic and remaining temporary files, and contact support. The application may not start.'
} elseif ($unknown) {
  $recovery = 'Restoration of old files could not be confirmed.'
  $advice = 'Keep the diagnostic and remaining temporary files, and contact support before removing them.'
}
$log = if ($savedPath) { "Diagnostic: $savedPath" } else { 'The diagnostic could not be saved.' }
$title = "$ProductName could not finish updating."
if ($Language -eq 2052) {
  $title = "$ProductName 未能完成更新。"
  $reason = 'Windows 无法清理旧应用文件。'
  $advice = '请检查所报路径、磁盘空间和安全软件记录，然后重新运行官方安装包。'
  if ($code -eq 32 -or $code -eq 33) {
    $reason = '应用文件正在被占用。'
    $advice = '请关闭使用此文件的任务后重新运行安装包。若仍失败，请重启 Windows 后重试。'
  } elseif ($code -eq 5) {
    $reason = 'Windows 拒绝访问应用文件。'
    $advice = '请检查访问权限及安全软件记录。仅在安装目录需要管理员权限时，以管理员身份运行。'
  }
  if ($incomplete) {
    $recovery = '旧应用文件未能完整恢复。'
    $advice = '请保留诊断和剩余暂存文件，并联系支持。应用可能无法启动。'
  } elseif ($unknown) {
    $recovery = '无法确认旧应用文件是否已恢复。'
    $advice = '请保留诊断和剩余暂存文件，联系支持后再处理。'
  }
  $log = if ($savedPath) { "诊断文件：$savedPath" } else { '诊断未能保存。' }
} elseif ($Language -eq 1028) {
  $title = "$ProductName 未能完成更新。"
  $reason = 'Windows 無法清理舊應用程式檔案。'
  $advice = '請檢查所報路徑、磁碟空間和安全軟體記錄，然後重新執行官方安裝程式。'
  if ($code -eq 32 -or $code -eq 33) {
    $reason = '應用程式檔案正在使用中。'
    $advice = '請關閉使用此檔案的工作後重新執行安裝程式。若仍失敗，請重新啟動 Windows 後再試。'
  } elseif ($code -eq 5) {
    $reason = 'Windows 拒絕存取應用程式檔案。'
    $advice = '請檢查存取權限及安全軟體記錄。僅在安裝目錄需要管理員權限時，以管理員身分執行。'
  }
  if ($incomplete) {
    $recovery = '舊應用程式檔案未能完整還原。'
    $advice = '請保留診斷和剩餘暫存檔案，並聯絡支援。應用程式可能無法啟動。'
  } elseif ($unknown) {
    $recovery = '無法確認舊應用程式檔案是否已還原。'
    $advice = '請保留診斷和剩餘暫存檔案，聯絡支援後再處理。'
  }
  $log = if ($savedPath) { "診斷檔案：$savedPath" } else { '診斷未能儲存。' }
}
$fallback = if ($code -notin @(5, 32, 33)) { $sourceResult } else { '' }
$message = @($title, $recovery, $reason, $fallback, $file, $advice, $log) | Where-Object { $_ }
# Publication has already crossed the old-file deletion boundary. Never imply that old files
# were restored, nor treat an extractor/robocopy status as a Win32 file-occupancy error.
if ($Phase -like '*-new-program-files' -or $Phase -eq 'cleanup-payload-staging') {
  $windowsFailure = $errors | Where-Object { $null -ne $_.nativeErrorCode -or $null -ne $_.windowsErrorCode } | Select-Object -First 1
  $windowsCode = if ($windowsFailure -and $null -ne $windowsFailure.nativeErrorCode) { $windowsFailure.nativeErrorCode } elseif ($windowsFailure) { $windowsFailure.windowsErrorCode } else { $null }
  $cause = ''
  $stage = switch ($Phase) {
    'prepare-new-program-files' { 'preparing the new application files' }
    'extract-new-program-files' { 'extracting the new application files' }
    'publish-new-program-files' { 'publishing the new application files' }
    'copy-new-program-files' { 'copying the new application files' }
    default { 'removing the temporary payload files' }
  }
  $reason = "Failed while $stage."
  $advice = 'Check the reported path, available disk space and security software records, then run the same official installer again. If the archive is damaged, download it again from the official source.'
  $state = 'Installation is incomplete. The application may not start.'
  if ($windowsCode -eq 32 -or $windowsCode -eq 33) {
    $cause = 'Windows reports that an application file or directory is in use.'
    $advice = 'Close tasks using this file or directory, then run the same official installer again. If it persists, restart Windows and retry.'
  } elseif ($windowsCode -eq 5) {
    $cause = 'Windows denied access to the reported path.'
    $advice = 'Check access permissions and security software records, then run the same official installer again. Use administrator access only if this folder requires it.'
  } elseif ($windowsCode -eq 112) {
    $cause = 'Windows reports insufficient disk space.'
    $advice = 'Free space on the installation and temporary-file drives, then run the same official installer again.'
  }
  if ($Language -eq 2052) {
    $stage = switch ($Phase) {
      'prepare-new-program-files' { '准备新应用文件' }
      'extract-new-program-files' { '解压新应用文件' }
      'publish-new-program-files' { '发布新应用文件' }
      'copy-new-program-files' { '复制新应用文件' }
      default { '清理临时安装文件' }
    }
    $reason = "$stage 时失败。"
    $state = '安装尚未完成，应用可能无法启动。'
    $advice = '请检查所报路径、磁盘空间及安全软件记录，解决问题后重新运行同一个官方安装包。如安装包损坏，请从官方来源重新下载。'
    if ($windowsCode -eq 32 -or $windowsCode -eq 33) {
      $cause = 'Windows 报告应用文件或目录正在被占用。'
      $advice = '请关闭使用此文件或目录的任务，然后重新运行同一个官方安装包。若仍失败，请重启 Windows 后重试。'
    } elseif ($windowsCode -eq 5) {
      $cause = 'Windows 拒绝访问所报路径。'
      $advice = '请检查访问权限及安全软件记录，然后重新运行同一个官方安装包。仅在目录需要管理员权限时，以管理员身份运行。'
    } elseif ($windowsCode -eq 112) {
      $cause = 'Windows 报告磁盘空间不足。'
      $advice = '请清理安装目录和临时文件所在磁盘的空间，然后重新运行同一个官方安装包。'
    }
  } elseif ($Language -eq 1028) {
    $stage = switch ($Phase) {
      'prepare-new-program-files' { '準備新應用程式檔案' }
      'extract-new-program-files' { '解壓縮新應用程式檔案' }
      'publish-new-program-files' { '發佈新應用程式檔案' }
      'copy-new-program-files' { '複製新應用程式檔案' }
      default { '清理暫存安裝檔案' }
    }
    $reason = "$stage 時失敗。"
    $state = '安裝尚未完成，應用程式可能無法啟動。'
    $advice = '請檢查所報路徑、磁碟空間及安全軟體記錄，解決問題後重新執行同一個官方安裝程式。如安裝程式損壞，請從官方來源重新下載。'
    if ($windowsCode -eq 32 -or $windowsCode -eq 33) {
      $cause = 'Windows 報告應用程式檔案或目錄正在使用中。'
      $advice = '請關閉使用此檔案或目錄的工作，然後重新執行同一個官方安裝程式。若仍失敗，請重新啟動 Windows 後再試。'
    } elseif ($windowsCode -eq 5) {
      $cause = 'Windows 拒絕存取所報路徑。'
      $advice = '請檢查存取權限及安全軟體記錄，然後重新執行同一個官方安裝程式。僅在目錄需要管理員權限時，以管理員身分執行。'
    } elseif ($windowsCode -eq 112) {
      $cause = 'Windows 報告磁碟空間不足。'
      $advice = '請清理安裝目錄和暫存檔案所在磁碟的空間，然後重新執行同一個官方安裝程式。'
    }
  }
  $fallback = if (!$cause) { $sourceResult } else { '' }
  $message = @($title, $state, $reason, $cause, $fallback, $file, $advice, $log) | Where-Object { $_ }
}
$messageText = $message -join "`r`n`r`n"
if ($MessagePath) {
  try { [IO.File]::WriteAllText($MessagePath, $messageText, [Text.UnicodeEncoding]::new($false, $false)) } catch {
    [Console]::Error.WriteLine("Could not save installer notice: $($_.Exception.Message)")
  }
} else { [Console]::Write($messageText) }
exit 0
