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
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process observer timed out: ${stderr}`)) }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Process observer exited ${code}: ${stdout}\n${stderr}`))
      else resolve(stdout)
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
  return selectOwnedProcesses(JSON.parse(output), directory)
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
