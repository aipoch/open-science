import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { hasSystemRestarted, prefetchSystemBootIdentity } from '../system-boot-identity'
import {
  captureInstallationManifestAsync,
  verifyInstallationManifestAsync,
  type InstallationManifest
} from './installation-protection'
import type { ManualInstallerArtifact, ManualInstallerOptions } from './manual-install'

type Observation = {
  schema: 1
  attempt: string
  artifact: string
  installationRoot: string
  boot: string
  original: InstallationManifest
  state: 'prepared' | 'watching' | 'exited' | 'unknown'
  installerPid?: number
  exitCode?: number
}

// Watch the exact downloaded executable, retaining a kernel process handle through exit. The
// observer never starts an installer or reports success. Elevation, access denial, missed process
// creation and a zero exit with an unchanged app all remain unknown. NSIS's detached children must
// also have exited before a failure receipt is published.
export const WINDOWS_INSTALL_OBSERVER = String.raw`
$ErrorActionPreference = 'Stop'
$receipt = $env:OPEN_SCIENCE_INSTALL_OBSERVATION
$attempt = $env:OPEN_SCIENCE_INSTALL_OBSERVATION_ID
$target = [IO.Path]::GetFullPath($env:OPEN_SCIENCE_INSTALL_OBSERVATION_TARGET)
$record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
if ($record.attempt -ne $attempt) { exit 0 }
function Publish($state, $pidValue, $code) {
  $current = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if ($current.attempt -ne $attempt) { exit 0 }
  $record.state = $state
  $record | Add-Member -Force NoteProperty installerPid $pidValue
  $record | Add-Member -Force NoteProperty exitCode $code
  $temporary = "$receipt.$attempt.tmp"
  $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
  $file = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
  [IO.File]::Replace($temporary, $receipt, $null)
}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenScienceInstallObserver {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
  Get-CimInstance Win32_Process -Filter "ProcessId = $PID" | Out-Null
  Publish 'watching' 0 0
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  $handle = [IntPtr]::Zero
  $candidate = $null
  do {
    $rows = @(Get-CimInstance Win32_Process)
    $matches = @($rows | Where-Object {
      $_.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw 'Ambiguous installer identity' }
    if ($matches.Count -eq 1) {
      $candidate = $matches[0]
      $handle = [OpenScienceInstallObserver]::OpenProcess(0x00101000, $false, [uint32]$candidate.ProcessId)
    }
    if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 50 }
  } while ($handle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
  if ($handle -eq [IntPtr]::Zero) { throw 'Installer process could not be observed' }
  try {
    $known = New-Object 'System.Collections.Generic.HashSet[uint32]'
    [void]$known.Add([uint32]$candidate.ProcessId)
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    do {
      $rows = @(Get-CimInstance Win32_Process)
      do {
        $added = $false
        foreach ($row in $rows) {
          if ($known.Contains([uint32]$row.ParentProcessId)) {
            if ($known.Add([uint32]$row.ProcessId)) { $added = $true }
          }
        }
      } while ($added)
      $wait = [OpenScienceInstallObserver]::WaitForSingleObject($handle, 0)
      if ($wait -ne 0 -and $wait -ne 258) { throw 'Installer handle cannot be inspected' }
      $active = @($rows | Where-Object { $known.Contains([uint32]$_.ProcessId) })
      if ($wait -eq 0 -and $active.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($wait -ne 0 -or $active.Count -ne 0) { throw 'Installer has not settled' }
    [uint32]$code = 0
    if (-not [OpenScienceInstallObserver]::GetExitCodeProcess($handle, [ref]$code)) { throw 'Exit code unavailable' }
    Publish 'exited' ([uint32]$candidate.ProcessId) $code
  } finally { [void][OpenScienceInstallObserver]::CloseHandle($handle) }
} catch { Publish 'unknown' 0 0 }
`

const artifactKey = (artifact: ManualInstallerArtifact): string =>
  createHash('sha256')
    .update(JSON.stringify([artifact.identity, artifact.version, artifact.path, artifact.checksum]))
    .digest('hex')

async function writeObservation(path: string, value: Observation): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}

/** A completed failed process or a new kernel boot is evidence of settlement, never success. */
export function nativeInstallSettled(record: Observation, boot: string): boolean {
  return (
    hasSystemRestarted(record.boot, boot) ||
    (record.state === 'exited' &&
      Number.isSafeInteger(record.installerPid) &&
      record.installerPid! > 0 &&
      Number.isSafeInteger(record.exitCode) &&
      record.exitCode! > 0)
  )
}

export function createNativeInstallObservation(options: {
  path: string
  installationRoot: string
  currentVersion: string
  inspectOccupancy(): Promise<void>
}): Pick<ManualInstallerOptions, 'observeManualInstallHandoff' | 'manualInstallRecovery'> {
  return {
    observeManualInstallHandoff: async (artifact, operationId = randomUUID()) => {
      const record: Observation = {
        schema: 1,
        attempt: operationId,
        artifact: artifactKey(artifact),
        installationRoot: options.installationRoot,
        boot: await prefetchSystemBootIdentity(),
        original: await captureInstallationManifestAsync(
          options.installationRoot,
          options.currentVersion
        ),
        state: 'prepared'
      }
      await writeObservation(options.path, record)
      if (artifact.platform !== 'win32' || artifact.format !== 'nsis') return
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_INSTALL_OBSERVER, 'utf16le').toString('base64')
        ],
        {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            OPEN_SCIENCE_INSTALL_OBSERVATION: options.path,
            OPEN_SCIENCE_INSTALL_OBSERVATION_ID: record.attempt,
            OPEN_SCIENCE_INSTALL_OBSERVATION_TARGET: artifact.path
          }
        }
      )
      let failed = false
      child.on('error', () => {
        failed = true
      })
      child.unref()
      // Readiness means CIM and the process-handle API are ready before native handoff.
      const deadline = Date.now() + 15_000
      while (!failed && Date.now() < deadline) {
        const observed = JSON.parse(await readFile(options.path, 'utf8')) as Observation
        if (observed.attempt !== record.attempt)
          throw new Error('The native installation attempt changed.')
        if (observed.state === 'watching') return
        if (observed.state === 'unknown') break
        await delay(50)
      }
      // This exact child is ours; it never installs or controls another process. Its own hard
      // deadline also bounds it if termination is unavailable. No process-name cleanup is used.
      child.kill()
      throw new Error('The native installer observer could not become ready.')
    },
    manualInstallRecovery: async (artifact, operationId) => {
      try {
        const bytes = await readFile(options.path, 'utf8')
        if (bytes.length > 32 * 1024 * 1024) return 'pending'
        const record = JSON.parse(bytes) as Observation
        if (
          record.schema !== 1 ||
          (operationId !== undefined && record.attempt !== operationId) ||
          record.artifact !== artifactKey(artifact) ||
          record.installationRoot !== options.installationRoot ||
          record.original?.version !== options.currentVersion ||
          !nativeInstallSettled(record, await prefetchSystemBootIdentity())
        )
          return 'pending'
        await options.inspectOccupancy()
        if (!(await verifyInstallationManifestAsync(options.installationRoot, record.original)))
          return 'pending'
        // Repeat identity and occupancy after hashing the installation. A newer attempt cannot be
        // released by an old observer, and incomplete installation bytes never authorize a retry.
        if ((await readFile(options.path, 'utf8')) !== bytes) return 'pending'
        await options.inspectOccupancy()
        return 'failed'
      } catch {
        return 'pending'
      }
    }
  }
}
