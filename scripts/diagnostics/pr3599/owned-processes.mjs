import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

export function selectOwnedProcesses(records, directory) {
  if (!win32.isAbsolute(directory)) throw new Error('Installation directory must be absolute')
  const root = win32.resolve(directory).replace(/[\\/]+$/, '').toLowerCase() + '\\'
  const owned = new Map(records.filter((p) => p.path && win32.resolve(p.path).toLowerCase().startsWith(root)).map((p) => [p.pid, p]))
  let changed
  do {
    changed = false
    for (const p of records) {
      if (!owned.has(p.pid) && owned.has(p.parent) && p.started >= owned.get(p.parent).started) {
        owned.set(p.pid, p)
        changed = true
      }
    }
  } while (changed)
  return [...owned.values()]
}

function powershell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const encodedScript = '$global:PR3599OutputEncodingBefore = [Console]::OutputEncoding.CodePage; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);\n' + script
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', encodedScript], { env: { ...process.env, ...env }, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process observer timed out: ${stderr}`)) }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Process observer exited ${code}: ${stdout}\n${stderr}`))
      else {
        try { JSON.parse(stdout); resolve(stdout) }
        catch (error) { reject(new Error(`Process observer JSON failed: ${error.message}; raw UTF-8 output base64=${Buffer.from(stdout).toString('base64')}`)) }
      }
    })
  })
}

export async function snapshotInstallation(directory) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
$records = @(Get-CimInstance Win32_Process | ForEach-Object {
  @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; path=$_.ExecutablePath; started=$_.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") }
})
ConvertTo-Json -InputObject $records -Compress
`, {}, 15000)
  const selected = selectOwnedProcesses(JSON.parse(output), directory)
  if (!selected.length) return selected
  const ownership = await powershell(`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$results = @()
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $owner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw "Installation process $($record.pid) is not owned by the validation account" }
  $results += @{pid=$record.pid;ownerSid=$owner.Sid}
}
ConvertTo-Json -InputObject $results -Compress
`, { PR3599_PROCESS_RECORDS: JSON.stringify(selected) }, 15000)
  const owners = new Map(JSON.parse(ownership).map((p) => [p.pid, p.ownerSid]))
  return selected.filter((p) => owners.has(p.pid)).map((p) => ({ ...p, ownerSid: owners.get(p.pid) }))
}

// Send the normal Windows close request only to a recorded installation process.
// This does not terminate it: lifecycle completion is checked separately.
export async function closeRecordedWindow(records) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    $null = $target.Handle
    if ($target.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { throw 'Window process identity changed' }
    if ($target.MainWindowHandle -ne [IntPtr]::Zero) {
      $sent = $target.CloseMainWindow()
      if (-not $sent) { throw 'The product window rejected the normal close request' }
      @{pid=$record.pid;closeRequested=$sent;forced=$false} | ConvertTo-Json -Compress
      exit 0
    }
  } finally { $target.Dispose() }
}
Write-Output 'null'
`, { PR3599_PROCESS_RECORDS: JSON.stringify(records) }, 15000)
  return JSON.parse(output)
}

export async function operateRecordedButton(records, pattern, invoke = false) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$matchesFound = @()
$observed = @()
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    if ($target.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $element = [Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    $elements = $element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
    foreach ($candidate in $elements) {
      $state = $candidate.Current
      $observed += @{pid=$record.pid;name=$state.Name;type=$state.ControlType.ProgrammaticName;enabled=$state.IsEnabled;offscreen=$state.IsOffscreen}
      if ($state.ControlType -eq [Windows.Automation.ControlType]::Button -and $state.IsEnabled -and -not $state.IsOffscreen -and $state.Name -match $env:PR3599_BUTTON_PATTERN) { $matchesFound += $candidate }
    }
  } finally { $target.Dispose() }
}
if ($matchesFound.Count -gt 1) { throw 'Ambiguous product button match; refusing to act' }
$name = $null
$invoked = $false
if ($matchesFound.Count -eq 1) {
  $button = $matchesFound[0]
  $name = $button.Current.Name
  if ($env:PR3599_INVOKE_BUTTON -eq '1') {
    $action = $null
    if (-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$action)) { throw 'Product button has no accessibility invoke pattern' }
    ([Windows.Automation.InvokePattern]$action).Invoke()
    $invoked = $true
  }
}
@{matched=$name;invoked=$invoked;controls=$observed;outputEncodingBefore=$global:PR3599OutputEncodingBefore;outputEncodingAfter=[Console]::OutputEncoding.CodePage} | ConvertTo-Json -Depth 5 -Compress
`, { PR3599_PROCESS_RECORDS: JSON.stringify(records), PR3599_BUTTON_PATTERN: pattern, PR3599_INVOKE_BUTTON: invoke ? '1' : '0' }, 20000)
  return JSON.parse(output)
}

export async function operateRecordedDraft(records, value) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$editors = @()
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    if ($target.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $window = [Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) {
      if ($element.Current.Name -eq 'Ask anything' -and -not $element.Current.IsOffscreen) { $editors += $element }
    }
  } finally { $target.Dispose() }
}
if ($editors.Count -gt 1) { throw 'Ambiguous composer; refusing to edit' }
if ($editors.Count -eq 0) { Write-Output '{"found":false}'; exit 0 }
$editor = $editors[0]
$pattern = $null
$text = $null
$valueText = $null
$documentText = $null
if ($editor.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
  $valuePattern = [Windows.Automation.ValuePattern]$pattern
  if ($env:PR3599_SET_DRAFT -eq '1') {
    if ($valuePattern.Current.IsReadOnly -or -not $editor.Current.IsEnabled) { throw 'Composer is not editable' }
    $valuePattern.SetValue($env:PR3599_DRAFT_TEXT)
  }
  $valueText = $valuePattern.Current.Value
  $text = $valueText
} elseif ($env:PR3599_SET_DRAFT -eq '1') { throw 'Composer does not expose an accessibility ValuePattern; no alternate injection permitted' }
if ($editor.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
  $documentText = ([Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(-1)
  $text = $documentText
}
if ($null -eq $text) { throw 'Composer text is not readable through accessibility' }
@{found=$true;text=$text;valueText=$valueText;documentText=$documentText;set=($env:PR3599_SET_DRAFT -eq '1')} | ConvertTo-Json -Compress
`, { PR3599_PROCESS_RECORDS: JSON.stringify(records), PR3599_SET_DRAFT: value === undefined ? '0' : '1', PR3599_DRAFT_TEXT: value ?? '' }, 20000)
  return JSON.parse(output)
}

export async function readRecordedWindows(records) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$windows = @()
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    if ($target.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $element = [Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    $texts = @($element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | Select-Object -First 100 | ForEach-Object { $_.Current.Name })
    $windows += @{pid=$record.pid;title=$element.Current.Name;text=$texts}
  } finally { $target.Dispose() }
}
ConvertTo-Json -InputObject $windows -Depth 4 -Compress
`, { PR3599_PROCESS_RECORDS: JSON.stringify(records) }, 15000)
  return JSON.parse(output)
}
// Wait on verified process handles. Never turn a timeout into success, and never act on reused PIDs.
export async function waitForRecordedExit(records, { force = false, timeoutMs = 60000 } = {}) {
  if (!records.length) return []
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$env:PR3599_WAIT_MS)
$results = @()
foreach ($record in ($env:PR3599_PROCESS_RECORDS | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) {
    $results += @{ pid=$record.pid; exited=$true; forced=$false; observed='original process absent' }
    continue
  }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    $null = $target.Handle
    # CIM exposes microseconds, while the native process handle exposes 100 ns ticks.
    if ($target.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { throw 'Process identity changed while opening its handle' }
    $forced = $env:PR3599_FORCE -eq '1'
    if ($forced -and -not $target.HasExited) { $target.Kill() }
    $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $target.WaitForExit($remaining)) { throw "Owned process $($record.pid) did not exit" }
    $results += @{ pid=$record.pid; exited=$true; forced=$forced; exitCode=$target.ExitCode }
  } finally { $target.Dispose() }
}
ConvertTo-Json -InputObject $results -Compress
`, { PR3599_PROCESS_RECORDS: JSON.stringify(records), PR3599_WAIT_MS: String(timeoutMs), PR3599_FORCE: force ? '1' : '0' }, timeoutMs + 15000)
  return JSON.parse(output)
}
