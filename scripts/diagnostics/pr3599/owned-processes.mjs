import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

export function sameRecordedProcess(actual, expected) {
  return Boolean(actual && expected && actual.pid === expected.pid && actual.started === expected.started &&
    actual.path && expected.path && win32.resolve(actual.path).toLowerCase() === win32.resolve(expected.path).toLowerCase() &&
    actual.ownerSid === expected.ownerSid)
}

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
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  try { $owner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid }
  catch {
    # The recorded process may exit between reading its CIM instance and querying its owner.
    # Only confirmed absence of that identity is benign; a live identity keeps the error.
    $remainingIdentity = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
    if ($remainingIdentity -and $remainingIdentity.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -eq $record.started) { throw }
    continue
  }
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw "Installation process $($record.pid) is not owned by the validation account" }
  $results += @{pid=$record.pid;ownerSid=$owner.Sid}
}
ConvertTo-Json -InputObject $results -Compress
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(selected) }, 15000)
  const owners = new Map(JSON.parse(ownership).map((p) => [p.pid, p.ownerSid]))
  return selected.filter((p) => owners.has(p.pid)).map((p) => ({ ...p, ownerSid: owners.get(p.pid) }))
}

// Send the normal Windows close request only to a recorded installation process.
// This does not terminate it: lifecycle completion is checked separately.
export async function closeRecordedWindow(records) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
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
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(records) }, 15000)
  return JSON.parse(output)
}

export async function operateRecordedButton(records, pattern, invoke = false) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$matchesFound = @()
$observed = @()
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
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
      if ($state.ControlType -eq [Windows.Automation.ControlType]::Button -and $state.IsEnabled -and -not $state.IsOffscreen -and $state.Name -match $env:OPEN_SCIENCE_UPGRADE_TEST_BUTTON_NAME_PATTERN) { $matchesFound += $candidate }
    }
  } finally { $target.Dispose() }
}
if ($matchesFound.Count -gt 1) { throw 'Ambiguous product button match; refusing to act' }
$name = $null
$invoked = $false
if ($matchesFound.Count -eq 1) {
  $button = $matchesFound[0]
  $name = $button.Current.Name
  if ($env:OPEN_SCIENCE_UPGRADE_TEST_ACTIVATE_BUTTON -eq '1') {
    $action = $null
    if (-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$action)) { throw 'Product button has no accessibility invoke pattern' }
    ([Windows.Automation.InvokePattern]$action).Invoke()
    $invoked = $true
  }
}
@{matched=$name;invoked=$invoked;controls=$observed;outputEncodingBefore=$global:PR3599OutputEncodingBefore;outputEncodingAfter=[Console]::OutputEncoding.CodePage} | ConvertTo-Json -Depth 5 -Compress
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(records), OPEN_SCIENCE_UPGRADE_TEST_BUTTON_NAME_PATTERN: pattern, OPEN_SCIENCE_UPGRADE_TEST_ACTIVATE_BUTTON: invoke ? '1' : '0' }, 20000)
  return JSON.parse(output)
}

export async function operateRecordedDraft(records, value, accessibleName = 'Ask anything') {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$editors = @()
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { continue }
  $target = [Diagnostics.Process]::GetProcessById($record.pid)
  try {
    if ($target.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $window = [Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) {
      if ($element.Current.Name -eq $env:OPEN_SCIENCE_UPGRADE_TEST_TEXT_FIELD_NAME -and -not $element.Current.IsOffscreen -and ($env:OPEN_SCIENCE_UPGRADE_TEST_TEXT_FIELD_NAME -eq 'Ask anything' -or $element.Current.ControlType -eq [Windows.Automation.ControlType]::Edit)) { $editors += $element }
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
  if ($env:OPEN_SCIENCE_UPGRADE_TEST_SET_COMPOSER_DRAFT -eq '1') {
    if ($valuePattern.Current.IsReadOnly -or -not $editor.Current.IsEnabled) { throw 'Composer is not editable' }
    # Chromium's accessibility SetValue changes this contenteditable's DOM without input events.
    # Drive the OS keyboard instead; never inject DOM text or a synthetic renderer event.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UpgradeTestKeyboard {
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput {
    public ushort key, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int x, y; public uint data, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public KeyboardInput keyboard;
    [FieldOffset(0)] public MouseInput mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type; public InputUnion data;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  public static uint ForegroundProcess() {
    uint process; GetWindowThreadProcessId(GetForegroundWindow(), out process); return process;
  }
  static Input Key(ushort key, ushort scan, uint flags) {
    return new Input { type=1, data=new InputUnion { keyboard=new KeyboardInput { key=key, scan=scan, flags=flags } } };
  }
  public static void Replace(string text, uint owner) {
    if (ForegroundProcess()!=owner) throw new InvalidOperationException("Owned editor lost foreground before typing");
    var inputs=new System.Collections.Generic.List<Input>();
    inputs.Add(Key(0x11,0,0)); inputs.Add(Key(0x41,0,0));
    inputs.Add(Key(0x41,0,2)); inputs.Add(Key(0x11,0,2));
    inputs.Add(Key(0x08,0,0)); inputs.Add(Key(0x08,0,2));
    foreach (char c in text) { inputs.Add(Key(0,c,4)); inputs.Add(Key(0,c,6)); }
    var batch=inputs.ToArray();
    if (SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input)))!=batch.Length)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if (ForegroundProcess()!=owner) throw new InvalidOperationException("Owned editor lost foreground while typing");
  }
}
'@
    $editor.SetFocus()
    $focused = [Windows.Automation.AutomationElement]::FocusedElement
    if (-not $editor.Current.HasKeyboardFocus -or $focused.Current.ProcessId -ne $editor.Current.ProcessId) { throw 'Owned editor did not receive keyboard focus' }
    [UpgradeTestKeyboard]::Replace($env:OPEN_SCIENCE_UPGRADE_TEST_COMPOSER_DRAFT_TEXT,[uint32]$editor.Current.ProcessId)
  }
  $valueText = $valuePattern.Current.Value
  $text = $valueText
} elseif ($env:OPEN_SCIENCE_UPGRADE_TEST_SET_COMPOSER_DRAFT -eq '1') { throw 'Composer does not expose an accessibility ValuePattern; no alternate injection permitted' }
if ($editor.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
  $documentText = ([Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(-1)
  $text = $documentText
}
if ($null -eq $text) { throw 'Composer text is not readable through accessibility' }
@{found=$true;text=$text;valueText=$valueText;documentText=$documentText;set=($env:OPEN_SCIENCE_UPGRADE_TEST_SET_COMPOSER_DRAFT -eq '1')} | ConvertTo-Json -Compress
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(records), OPEN_SCIENCE_UPGRADE_TEST_TEXT_FIELD_NAME: accessibleName, OPEN_SCIENCE_UPGRADE_TEST_SET_COMPOSER_DRAFT: value === undefined ? '0' : '1', OPEN_SCIENCE_UPGRADE_TEST_COMPOSER_DRAFT_TEXT: value ?? '' }, 20000)
  return JSON.parse(output)
}

export async function readRecordedWindows(records) {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$windows = @()
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
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
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(records) }, 15000)
  return JSON.parse(output)
}
// Wait on verified process handles. Never turn a timeout into success, and never act on reused PIDs.
export async function waitForRecordedExit(records, { force = false, timeoutMs = 60000 } = {}) {
  if (!records.length) return []
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$env:OPEN_SCIENCE_UPGRADE_TEST_EXIT_TIMEOUT_MS)
$results = @()
foreach ($record in ($env:OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES | ConvertFrom-Json)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
  if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) {
    $results += @{ pid=$record.pid; exited=$true; forced=$false; observed='original process absent' }
    continue
  }
  $target = $null
  try { $target = [Diagnostics.Process]::GetProcessById($record.pid); $null = $target.Handle }
  catch {
    if ($target) { $target.Dispose() }
    $cause = $_.Exception.GetBaseException()
    if ($cause -isnot [ArgumentException] -and $cause -isnot [InvalidOperationException]) { throw }
    # Exit can occur after the CIM identity check, before opening the handle.
    # Re-query; an alive matching identity remains a failure, never a presumed exit.
    $remainingIdentity = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
    if ($remainingIdentity -and $remainingIdentity.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -eq $record.started) { throw }
    $results += @{ pid=$record.pid; exited=$true; forced=$false; observed='original identity absent after handle-open race' }
    continue
  }
  try {
    # CIM exposes microseconds, while the native process handle exposes 100 ns ticks.
    if ($target.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") -ne $record.started) { throw 'Process identity changed while opening its handle' }
    $forced = $env:OPEN_SCIENCE_UPGRADE_TEST_FORCE_CLEANUP -eq '1'
    if ($forced -and -not $target.HasExited) { $target.Kill() }
    $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $target.WaitForExit($remaining)) { throw "Owned process $($record.pid) did not exit" }
    $results += @{ pid=$record.pid; exited=$true; forced=$forced; exitCode=$target.ExitCode }
  } finally { $target.Dispose() }
}
ConvertTo-Json -InputObject $results -Compress
`, { OPEN_SCIENCE_UPGRADE_TEST_PROCESS_IDENTITIES: JSON.stringify(records), OPEN_SCIENCE_UPGRADE_TEST_EXIT_TIMEOUT_MS: String(timeoutMs), OPEN_SCIENCE_UPGRADE_TEST_FORCE_CLEANUP: force ? '1' : '0' }, timeoutMs + 15000)
  return JSON.parse(output)
}
