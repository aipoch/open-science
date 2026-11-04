import { createRequire } from 'node:module'

const requireNative = createRequire(__filename)
type Binding = typeof import('@aipoch/process-tree-native')

// Direct kernel reads replace per-call PowerShell launches, which exceeded their deadlines under
// CPU saturation. Missing processes return undefined; any other failure throws to the caller.
const binding = (): Binding => {
  const native = requireNative('@aipoch/process-tree-native') as Binding
  if (typeof native.getWindowsProcessCreationTime !== 'function')
    throw new Error('Windows process queries are unavailable.')
  return native
}

// .NET DateTime.Ticks counts from 0001-01-01; FILETIME counts from 1601-01-01, both in 100 ns.
const DOTNET_TICKS_AT_FILETIME_EPOCH = 504911232000000000n

/** Creation time as persisted by earlier releases: `(Get-Process).StartTime.ToUniversalTime().Ticks`. */
export function windowsProcessStartTicks(pid: number): string | undefined {
  const filetime = binding().getWindowsProcessCreationTime(pid)
  if (filetime === null) return undefined
  if (!/^\d+$/.test(filetime)) throw new Error('Invalid Windows process creation time.')
  return String(BigInt(filetime) + DOTNET_TICKS_AT_FILETIME_EPOCH)
}

export function windowsProcessCommandLine(pid: number): string | undefined {
  return binding().getWindowsProcessCommandLine(pid) ?? undefined
}

export function windowsParentProcessId(pid: number): number | undefined {
  const parent = binding().getWindowsParentProcessId(pid)
  if (parent === null) return undefined
  if (!Number.isSafeInteger(parent) || parent < 0)
    throw new Error('Invalid Windows parent process identifier.')
  return parent
}

export type WindowsProcessRow = { pid: number; ppid: number; executablePath: string | null }

export function listWindowsProcesses(): WindowsProcessRow[] {
  return binding().listWindowsProcesses()
}

export function splitWindowsCommandLine(commandLine: string): string[] {
  return binding().splitWindowsCommandLine(commandLine)
}

/** Restart Manager users of the given files. Read-only: grants no shutdown authority. */
export function listWindowsInstallationOccupants(files: readonly string[]): number[] {
  return binding().listWindowsInstallationOccupants(files)
}

export function listWindowsInstallationOccupantsAsync(files: readonly string[]): Promise<number[]> {
  return binding().listWindowsInstallationOccupantsAsync(files)
}
