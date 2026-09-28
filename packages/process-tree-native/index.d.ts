export type DarwinProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  sid: number
  uniqueId: string
  parentUniqueId: string
}

export type DarwinProcessTable = {
  processes: DarwinProcessIdentity[]
  complete: boolean
}

export function getDarwinProcess(pid: number): DarwinProcessIdentity | null
export function getDarwinEnvironmentValue(pid: number, name: string): string | false | null
export function listDarwinProcesses(): DarwinProcessTable | null

export type DarwinCoalitionUnavailable = { status: 'missing' | 'unavailable'; error?: number }
export function getDarwinProcessCoalition(
  pid: number
):
  { status: 'ok'; coalitionId: string; process: DarwinProcessIdentity } | DarwinCoalitionUnavailable
export type DarwinProcessSignalMode = 'atomic' | 'legacy'
// Modern macOS validates birth/exec identity in the kernel. Older systems lacking
// that API recheck birth identity before a single-PID signal; a PID-reuse race
// remains in that legacy path. API errors never trigger a downgrade.
// An intervening exec can return unavailable, which is not proof of disappearance.
export function signalDarwinProcess(
  pid: number,
  uniqueId: string,
  signal: number
): ({ status: 'ok' | 'mismatch' } | DarwinCoalitionUnavailable) & {
  signalMode?: DarwinProcessSignalMode
}

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
export function reapWindowsOwnedJob(jobName: string): boolean
