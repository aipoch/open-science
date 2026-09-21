import { isConnectionStdoutTruncated } from './connection-broker'
import { quoteRemotePath } from './remote-path-security'
import type { ComputeConnectionLease } from './connection-broker'

export type RemoteJobProcessOwnership = 'owned' | 'mismatch' | 'absent' | 'unknown'

const validPid = (pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid remote process id.')
}

// Return status 0 only when the remote process cwd is observable and exactly matches the canonical
// Job workdir; mismatch and unavailable evidence remain distinct so the probe can fail closed.
export const remoteJobPidOwnershipFunctionLines = (): string[] => [
  'job_session_processes() {',
  '  process_table=$(ps -eo pid=,pgid=,sid=,stat= 2>/dev/null) || return 2',
  `  printf '%s\\n' "$process_table" | awk -v sid="$pid" '$3 == sid && $4 !~ /^[ZX]/ { print $1, $2 }'`,
  '}',
  'job_pid_is_owned() {',
  '  pid=$1',
  "  case $pid in ''|*[!0-9]*) return 2 ;; esac",
  '  [ -n "$workdir" ] || return 2',
  '  [ "$pid" -gt 1 ] || return 2',
  '  owner_pid=',
  '  process_workdir=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)',
  '  if [ -z "$process_workdir" ] && command -v lsof >/dev/null 2>&1; then',
  `    process_workdir=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
  '  fi',
  '  if [ -n "$process_workdir" ]; then',
  '    [ "$process_workdir" = "$workdir" ] || return 1',
  '    owner_pid=$pid; return 0',
  '  fi',
  // A dead/zombie launcher can leave timeout's separate group alive. An exact cwd witness in
  // the original session recovers ownership; lack of a witness never authorizes a signal.
  '  members=$(job_session_processes) || return 2',
  '  if [ -z "$members" ]; then',
  '    root_state=$(ps -o stat= -p "$pid" 2>/dev/null)',
  // ps returns 1 for no matching PID. Transport/tool failures must remain unknown, not absent.
  '    root_probe=$?',
  '    case "$root_probe:$root_state" in 1:|0:*Z*|0:*X*) return 3 ;; *) return 2 ;; esac',
  '  fi',
  `  for candidate in $(printf '%s\\n' "$members" | awk '{ print $1 }'); do`,
  '    candidate_workdir=$(readlink "/proc/$candidate/cwd" 2>/dev/null || true)',
  '    if [ "$candidate_workdir" = "$workdir" ]; then owner_pid=$candidate; return 0; fi',
  '  done',
  '  return 2',
  '}'
]

// A launcher is a session leader, but GNU timeout creates another process group inside that
// session. Keep a verified cwd witness alive until every other workload group is gone; killing
// only -pid leaves timeout and its descendants running. All consumers share this boundary.
export const remoteJobPidTerminationFunctionLines = (): string[] => [
  ...remoteJobPidOwnershipFunctionLines(),
  'kill_job_pid() {',
  '  pid=$1',
  "  case $pid in ''|*[!0-9]*) return 2 ;; esac",
  '  job_pid_is_owned "$pid"',
  '  ownership=$?',
  '  [ "$ownership" -eq 0 ] || return "$ownership"',
  // The cwd witness must also belong to the original setsid session. Freeze its group so it
  // anchors session identity until the other groups have exited, even for an orphaned launcher.
  '  members=$(job_session_processes) || return 2',
  `  anchor_group=$(printf '%s\\n' "$members" | awk -v owner="$owner_pid" '$1 == owner { print $2 }') || return 2`,
  '  [ -n "$anchor_group" ] || return 2',
  '  kill -STOP -- -$anchor_group 2>/dev/null || return 2',
  '  job_pid_is_owned "$pid" || return 2',
  '  members=$(job_session_processes) || return 2',
  `  groups=$(printf '%s\\n' "$members" | awk -v anchor="$anchor_group" '$2 != anchor { print $2 }' | sort -u) || return 2`,
  '  for group in $groups; do',
  // The stopped cwd witness anchors session identity throughout workload termination.
  '    job_pid_is_owned "$pid" || return 2',
  '    members=$(job_session_processes) || return 2',
  `    printf '%s\\n' "$members" | awk -v group="$group" '$2 == group { found=1 } END { exit !found }' || continue`,
  // Send one final signal: TERM followed immediately by KILL can destroy the group and
  // reuse its numeric PGID between signals. A session witness does not pin other PGIDs.
  '    kill -KILL -- -$group 2>/dev/null || true',
  '  done',
  // Confirm kernel-observed exit, not signal delivery. Zombies cannot execute or write files.
  '  for attempt in 1 2 3 4 5; do',
  '    members=$(job_session_processes) || return 2',
  `    remaining=$(printf '%s\\n' "$members" | awk -v anchor="$anchor_group" '$2 != anchor { print $1 }') || return 2`,
  '    [ -n "$remaining" ] || break',
  '    sleep 0.1',
  '  done',
  '  [ -z "$remaining" ] || return 2',
  '  job_pid_is_owned "$pid" || return 2',
  '  kill -KILL -- -$anchor_group 2>/dev/null || return 2',
  '  for attempt in 1 2 3 4 5; do',
  '    members=$(job_session_processes) || return 2',
  '    if [ -z "$members" ]; then echo terminated; return 0; fi',
  '    sleep 0.1',
  '  done',
  '  return 2',
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
  if (result.timedOut || isConnectionStdoutTruncated(result) || result.exitCode !== 0)
    return 'unknown'
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
    !isConnectionStdoutTruncated(result) &&
    result.exitCode === 0 &&
    result.stdout.trim() === 'terminated'
  )
}
