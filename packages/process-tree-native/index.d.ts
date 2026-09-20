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
