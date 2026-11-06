export type DarwinProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  sid: number
  uniqueId: string
  // Optional kernel resource coalition; absence never proves non-ownership.
  coalitionId?: string
  parentUniqueId: string
}

export type DarwinProcessTable = {
  processes: DarwinProcessIdentity[]
  complete: boolean
}

export function getDarwinProcess(pid: number): DarwinProcessIdentity | null
export function getDarwinProcessArguments(pid: number): string[] | null
export function getDarwinEnvironmentValue(pid: number, name: string): string | false | null
export function listDarwinProcesses(): DarwinProcessTable | null

// Windows only. The opaque handle retains the non-inherited kill-on-close Job.
export function spawnWindowsOwnedProcess(
  jobName: string,
  executable: string,
  args: readonly string[],
  environment: readonly string[],
  cwd: string,
  verbatimArguments: boolean
): { handle: object; pid: number; fds: [number, number, number] }
export function windowsOwnedProcessExitCode(handle: object): number | null
export function windowsOwnedJobProcessIds(handle: object): number[]
export function windowsCurrentProcessDescendants(): number[]
export function reapWindowsOwnedJob(jobName: string): boolean

export type ResourceProcessIdentity = { pid: number; birth: string }
export type ResourceProcessSample = {
  pid: number
  parentPid: number
  birth?: string
  privateBytes?: number
  workingSetBytes?: number
  handleCount?: number
  error?: number
}
export type WindowsResourceSample = {
  supported: boolean
  complete: boolean
  startedAt: number
  endedAt: number
  system?: { committedBytes: number; commitLimitBytes: number; availableBytes: number }
  systemError?: number
  processes: ResourceProcessSample[]
}
/** Read-only, async. Birth is the lossless decimal FILETIME, never a JS timestamp. */
export function sampleWindowsResources(
  includeProcesses: boolean,
  retained: readonly ResourceProcessIdentity[]
): Promise<WindowsResourceSample>
/** Single process identity read; no process enumeration. Null means unavailable. */
export function readWindowsResourceBirth(pid: number): string | null

// Windows only. Each returns null for a missing or exited process and throws for any other
// query failure. The creation time is the decimal FILETIME (100 ns since 1601-01-01 UTC).
export function getWindowsProcessCreationTime(pid: number): string | null
export function getWindowsProcessCommandLine(pid: number): string | null
export function getWindowsParentProcessId(pid: number): number | null
// Windows only. Read-only Restart Manager query of processes using the given files.
export function listWindowsInstallationOccupants(files: readonly string[]): number[]
// Same query on the libuv thread pool; a cold Restart Manager query can take tens of seconds.
export function listWindowsInstallationOccupantsAsync(files: readonly string[]): Promise<number[]>
// Windows only. Process snapshot; executablePath is null when the image cannot be read.
export function listWindowsProcesses(): Array<{
  pid: number
  ppid: number
  executablePath: string | null
}>
// Windows only. Splits a command line with CommandLineToArgvW.
export function splitWindowsCommandLine(commandLine: string): string[]
