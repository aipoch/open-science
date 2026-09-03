import { quoteRemotePath } from './remote-path-security'
import type { ComputeConnectionLease } from './connection-broker'

export type RemoteJobProcessOwnership = 'owned' | 'mismatch' | 'absent' | 'unknown'

const validPid = (pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid remote process id.')
}

// Return status 0 only when the remote process cwd is observable and exactly matches the canonical
// Job workdir; mismatch and unavailable evidence remain distinct so the probe can fail closed.
export const remoteJobPidOwnershipFunctionLines = (): string[] => [
  'job_pid_is_owned() {',
  '  pid=$1',
  "  case $pid in ''|*[!0-9]*) return 2 ;; esac",
  '  [ -n "$workdir" ] || return 2',
  '  kill -0 "$pid" 2>/dev/null || return 3',
  '  process_workdir=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)',
  '  if [ -z "$process_workdir" ] && command -v lsof >/dev/null 2>&1; then',
  `    process_workdir=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
  '  fi',
  '  [ -n "$process_workdir" ] || return 2',
  '  [ "$process_workdir" = "$workdir" ] || return 1',
  '}'
]

// Extracted from owner deletion and shared with timeout fallback. It rechecks cwd in the signalling
// operation itself, so PID reuse after the separate probe still cannot turn into an unguarded kill.
export const remoteJobPidTerminationFunctionLines = (): string[] => [
  ...remoteJobPidOwnershipFunctionLines(),
  'kill_job_pid() {',
  '  pid=$1',
  "  case $pid in ''|*[!0-9]*) return 2 ;; esac",
  '  job_pid_is_owned "$pid"',
  '  ownership=$?',
  '  [ "$ownership" -eq 0 ] || return "$ownership"',
  '  signal_delivered=0',
  '  kill -TERM -- -$pid 2>/dev/null && signal_delivered=1',
  '  kill -TERM $pid 2>/dev/null && signal_delivered=1',
  '  kill -KILL -- -$pid 2>/dev/null && signal_delivered=1',
  '  kill -KILL $pid 2>/dev/null && signal_delivered=1',
  '  [ "$signal_delivered" -eq 1 ] || return 2',
  '  echo terminated',
  '}'
]

const canonicalWorkdirLines = (workdir: string): string[] => {
  const quotedWorkdir = quoteRemotePath(workdir)
  return [
    `[ ! -L ${quotedWorkdir} ] || { echo unknown; exit 0; }`,
    `workdir=$(cd -- ${quotedWorkdir} 2>/dev/null && pwd -P || true)`
  ]
}

const ownershipProbeCommand = (pid: number, workdir: string): string => {
  validPid(pid)
  return [
    ...canonicalWorkdirLines(workdir),
    ...remoteJobPidOwnershipFunctionLines(),
    `job_pid_is_owned ${pid}`,
    'case $? in 0) echo owned ;; 1) echo mismatch ;; 3) echo absent ;; *) echo unknown ;; esac'
  ].join('\n')
}

const guardedTerminationCommand = (pid: number, workdir: string): string => {
  validPid(pid)
  return [
    ...canonicalWorkdirLines(workdir),
    ...remoteJobPidTerminationFunctionLines(),
    `kill_job_pid ${pid}`
  ].join('\n')
}

export const probeRemoteJobProcessOwnership = async (
  pid: number,
  workdir: string,
  connection: ComputeConnectionLease
): Promise<RemoteJobProcessOwnership> => {
  let result
  try {
    result = await connection.run(ownershipProbeCommand(pid, workdir), {
      timeoutMs: 10_000,
      loginShell: false,
      maxOutputBytes: 64
    })
  } catch {
    return 'unknown'
  }
  if (result.timedOut || result.truncated || result.exitCode !== 0) return 'unknown'
  const ownership = result.stdout.trim()
  return ownership === 'owned' || ownership === 'mismatch' || ownership === 'absent'
    ? ownership
    : 'unknown'
}

export const terminateRemoteJobProcessIfOwned = async (
  pid: number,
  workdir: string,
  connection: ComputeConnectionLease
): Promise<boolean> => {
  let result
  try {
    result = await connection.run(guardedTerminationCommand(pid, workdir), {
      timeoutMs: 10_000,
      loginShell: false,
      maxOutputBytes: 64
    })
  } catch {
    return false
  }
  return (
    !result.timedOut &&
    !result.truncated &&
    result.exitCode === 0 &&
    result.stdout.trim() === 'terminated'
  )
}
