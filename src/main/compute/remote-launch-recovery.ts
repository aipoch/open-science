import { classifyConnectionFailure, type ComputeConnectionLease } from './connection-broker'
import { quoteRemotePath } from './remote-path-security'

import type { ComputeJob } from '../../shared/compute'
import type { RemoteHandle } from './job-dispatcher'
import { remoteJobPidOwnershipFunctionLines } from './remote-job-process'

const RECOVERY_PROTOCOL = 'OPEN_SCIENCE_DISPATCH_RECOVERY_V1'
const RECOVERY_TIMEOUT_MS = 30_000
const RECOVERY_MAX_OUTPUT_BYTES = 1024

export type RemoteLaunchObservation =
  | { kind: 'not_started' }
  | { kind: 'running'; handle: RemoteHandle; startedAt?: Date }
  | { kind: 'exited'; exitCode: number; pid?: number }
  | { kind: 'vanished'; pid: number }
  | { kind: 'pending' }
  | { kind: 'ambiguous' }

export type RecoveredExitState = {
  status: 'success' | 'failed' | 'timeout'
  errorCode: 'job_failed' | 'timeout' | null
}

const positiveInteger = (value: string): number | undefined => {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined
}

const exitCodeInteger = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined
}

export const remoteHandleFor = (workdir: string, pid: number): RemoteHandle => ({
  pid,
  exit_code_path: `${workdir}/exit_code`,
  stdout_path: `${workdir}/stdout`,
  stderr_path: `${workdir}/stderr`,
  workdir
})

export const classifyComputeJobExit = (
  job: Pick<ComputeJob, 'started_at' | 'submitted_at' | 'timeout_seconds'>,
  exitCode: number
): RecoveredExitState => {
  if (exitCode === 0) return { status: 'success', errorCode: null }
  if (exitCode === 124) return { status: 'timeout', errorCode: 'timeout' }
  if (exitCode !== 137) return { status: 'failed', errorCode: 'job_failed' }

  const startedAt = job.started_at ?? job.submitted_at
  const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0
  return elapsed >= (job.timeout_seconds ?? 86400)
    ? { status: 'timeout', errorCode: 'timeout' }
    : { status: 'failed', errorCode: 'job_failed' }
}

const buildRecoveryProbe = (workdir: string): string => {
  const quotedWorkdir = quoteRemotePath(workdir)
  const quotedPidFile = quoteRemotePath(`${workdir}/job.pid`)
  const quotedExitCodeFile = quoteRemotePath(`${workdir}/exit_code`)
  return [
    `echo ${RECOVERY_PROTOCOL}`,
    `[ ! -L ${quotedWorkdir} ] || { echo workdir:1; echo exit_code:; echo pid:; echo cwd_match:unknown; echo started_at:; exit 0; }`,
    `if [ -d ${quotedWorkdir} ]; then echo workdir:1; else echo workdir:0; echo exit_code:; echo pid:; echo cwd_match:0; echo started_at:; exit 0; fi`,
    `if [ -f ${quotedExitCodeFile} ]; then RECOVERY_EXIT_CODE=$(cat ${quotedExitCodeFile}); else RECOVERY_EXIT_CODE=; fi`,
    `printf 'exit_code:%s\n' "$RECOVERY_EXIT_CODE"`,
    `if [ -f ${quotedPidFile} ]; then RECOVERY_PID=$(cat ${quotedPidFile}); else RECOVERY_PID=; fi`,
    `printf 'pid:%s\n' "$RECOVERY_PID"`,
    `  RECOVERY_EXPECTED_CWD=$(cd ${quotedWorkdir} 2>/dev/null && pwd -P)`,
    'workdir=$RECOVERY_EXPECTED_CWD',
    ...remoteJobPidOwnershipFunctionLines(),
    `case "$RECOVERY_PID" in '' ) echo cwd_match:0 ;; *[!0-9]*) echo cwd_match:unknown ;; *)`,
    '  if ! kill -0 "$RECOVERY_PID" 2>/dev/null; then echo cwd_match:0',
    '  else job_pid_is_owned "$RECOVERY_PID"; case $? in 0) echo cwd_match:1 ;; 1) echo cwd_match:0 ;; *) echo cwd_match:unknown ;; esac; fi',
    ';; esac',
    `RECOVERY_STARTED_AT=$(stat -c %Y ${quotedPidFile} 2>/dev/null || stat -f %m ${quotedPidFile} 2>/dev/null || true)`,
    `printf 'started_at:%s\n' "$RECOVERY_STARTED_AT"`
  ].join('\n')
}

export const probeRemoteLaunch = async (
  connection: ComputeConnectionLease,
  workdir: string
): Promise<RemoteLaunchObservation> => {
  const result = await connection.run(buildRecoveryProbe(workdir), {
    timeoutMs: RECOVERY_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: RECOVERY_MAX_OUTPUT_BYTES
  })
  const connectionFailure = classifyConnectionFailure(result, false)
  if (connectionFailure) throw connectionFailure
  if (result.exitCode !== 0 || result.truncated) return { kind: 'ambiguous' }

  const lines = result.stdout.trimEnd().split('\n')
  if ((lines.length !== 5 && lines.length !== 6) || lines[0] !== RECOVERY_PROTOCOL) {
    return { kind: 'ambiguous' }
  }
  const workdirRaw = lines[1]?.startsWith('workdir:')
    ? lines[1].slice('workdir:'.length)
    : undefined
  const exitCodeRaw = lines[2]?.startsWith('exit_code:')
    ? lines[2].slice('exit_code:'.length)
    : undefined
  const pidRaw = lines[3]?.startsWith('pid:') ? lines[3].slice('pid:'.length) : undefined
  const cwdMatchRaw = lines[4]?.startsWith('cwd_match:')
    ? lines[4].slice('cwd_match:'.length)
    : undefined
  const startedAtRaw = lines[5]?.startsWith('started_at:')
    ? lines[5].slice('started_at:'.length)
    : undefined
  if (
    (workdirRaw !== '0' && workdirRaw !== '1') ||
    exitCodeRaw === undefined ||
    pidRaw === undefined ||
    (cwdMatchRaw !== '0' && cwdMatchRaw !== '1')
  ) {
    return { kind: 'ambiguous' }
  }
  const exitCode = exitCodeRaw === '' ? undefined : exitCodeInteger(exitCodeRaw)
  const pid = pidRaw === '' ? undefined : positiveInteger(pidRaw)
  const startedAtSeconds = startedAtRaw ? positiveInteger(startedAtRaw) : undefined
  if (
    (exitCodeRaw !== '' && exitCode === undefined) ||
    (pidRaw !== '' && pid === undefined) ||
    (startedAtRaw !== undefined && startedAtRaw !== '' && startedAtSeconds === undefined) ||
    (workdirRaw === '0' && (exitCodeRaw !== '' || pidRaw !== '' || cwdMatchRaw !== '0'))
  ) {
    return { kind: 'ambiguous' }
  }
  if (workdirRaw === '0') return { kind: 'not_started' }
  if (exitCode !== undefined) return { kind: 'exited', exitCode, ...(pid ? { pid } : {}) }
  if (!pid) return cwdMatchRaw === '0' ? { kind: 'pending' } : { kind: 'ambiguous' }
  return cwdMatchRaw === '1'
    ? {
        kind: 'running',
        handle: remoteHandleFor(workdir, pid),
        ...(startedAtSeconds === undefined
          ? {}
          : { startedAt: new Date(startedAtSeconds * 1000) })
      }
    : { kind: 'vanished', pid }
}
