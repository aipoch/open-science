import type { ComputeJob } from '../../shared/compute'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  isConnectionStdoutTruncated,
  redactConnectionOutputs,
  type ComputeConnectionLease
} from './connection-broker'
import { applyComputeEnvironment } from './compute-environment'
import { parsePollOutput } from './job-poll-output'
import type {
  ComputeJobDriver,
  DriverCancelContext,
  DriverCancelResult,
  DriverPollEntry,
  DriverPollOptions,
  DriverRecoveryContext,
  DriverSubmitContext
} from './job-driver'
import { classifyComputeJobExit, probeRemoteLaunch } from './remote-launch-recovery'
import { quoteRemotePath } from './remote-path-security'
import { remoteJobPidOwnershipFunctionLines } from './remote-job-process'
import {
  probeRemoteJobProcessOwnership,
  terminateRemoteJobProcessIfOwned
} from './remote-job-process'
import { toBase64, type RemoteHandle } from './remote-job-contract'

const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024
const DISPATCH_TIMEOUT_MS = 120_000
const POLL_TIMEOUT_MS = 30_000
const TAIL_MAX_BYTES = 65_536
const PER_JOB_POLL_BYTES = TAIL_MAX_BYTES * 2 + 1024

export const REMOTE_PROCESS_OWNERSHIP_FUNCTION = [
  ...remoteJobPidOwnershipFunctionLines(),
  'process_owned_by_workdir() {',
  '  workdir=$2',
  '  job_pid_is_owned "$1"',
  '}'
].join('\n')

export const buildLauncherScript = (timeoutSeconds: number): string => {
  return (
    '#!/usr/bin/env bash\n' +
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -l -c 'if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; exec bash command.sh' > stdout 2> stderr\n` +
    'echo $? > exit_code.tmp && mv exit_code.tmp exit_code\n'
  )
}

export type DirectPollObservation =
  | {
      kind: 'complete'
      alive: boolean
      exitCode: number | null
      hasExitCode: boolean
      stdoutTail: string
      stderrTail: string
    }
  | { kind: 'unknown'; diagnostic: string }

const isDefinitivePreLaunchConnectionError = (error: unknown): boolean =>
  error instanceof ComputeConnectionError &&
  error.code !== 'host_unreachable' &&
  error.code !== 'timeout'

const isDefinitivePreLaunchResult = (
  result: { stderr: string },
  failure: ComputeConnectionError
): boolean => {
  if (failure.code !== 'host_unreachable' && failure.code !== 'timeout') return true
  if (failure.code === 'timeout') return false
  const stderr = result.stderr.toLowerCase()
  return (
    stderr.includes('connection refused') ||
    stderr.includes('network is unreachable') ||
    stderr.includes('no route to host') ||
    stderr.includes('could not resolve hostname')
  )
}

export class DirectSshDriver implements ComputeJobDriver<RemoteHandle, DirectPollObservation> {
  readonly id = 'direct_ssh' as const

  async submit({ job, connection, workdir, lifecycle }: DriverSubmitContext): Promise<void> {
    const commandScript = applyComputeEnvironment(job.command, job.environment)
    const timeoutSecs = job.timeout_seconds ?? 86_400
    const launcherScript = buildLauncherScript(timeoutSecs)
    const commandB64 = toBase64(commandScript)
    const launcherB64 = toBase64(launcherScript)
    const quotedWorkdir = quoteRemotePath(workdir)
    const dispatchCmd = [
      `mkdir -p ${quotedWorkdir}`,
      `cd ${quotedWorkdir}`,
      `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh`,
      `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh`,
      'chmod +x command.sh launcher.sh',
      'nohup setsid bash launcher.sh >/dev/null 2>&1 &',
      'LAUNCHED_PID=$!',
      'echo $LAUNCHED_PID > job.pid',
      'echo $LAUNCHED_PID'
    ].join('\n')

    let runResult
    try {
      runResult = await connection.run(dispatchCmd, {
        timeoutMs: DISPATCH_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
      })
    } catch (error) {
      if (isDefinitivePreLaunchConnectionError(error)) throw error
      await this.recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
      return
    }

    const connectionFailure = classifyConnectionFailure(runResult, false)
    if (connectionFailure) {
      if (isDefinitivePreLaunchResult(runResult, connectionFailure)) throw connectionFailure
      await this.recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
      return
    }

    if (runResult.exitCode !== 0) {
      await lifecycle.dispatchError(job.job_id, {
        errorCode: 'dispatch_failed',
        stderrTail: 'The remote Compute Job launcher failed.'
      })
      return
    }

    const pidOutput = runResult.stdout.trim()
    const pid = /^[1-9]\d*$/.test(pidOutput) ? Number(pidOutput) : Number.NaN
    if (isConnectionStdoutTruncated(runResult) || !Number.isSafeInteger(pid) || pid <= 1) {
      await this.recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle, runResult.stdout)
      return
    }

    const handle: RemoteHandle = {
      pid,
      exit_code_path: `${workdir}/exit_code`,
      stdout_path: `${workdir}/stdout`,
      stderr_path: `${workdir}/stderr`,
      workdir
    }
    await lifecycle.dispatchRunning(job.job_id, JSON.stringify(handle))
  }

  async recover({ job, connection }: DriverRecoveryContext): Promise<RemoteHandle | undefined> {
    const workdir = job.remote_workdir
    if (!workdir) return undefined
    const observation = await probeRemoteLaunch(connection, workdir)
    return observation.kind === 'running' ? observation.handle : undefined
  }

  async poll(
    entries: readonly DriverPollEntry<RemoteHandle>[],
    connection: ComputeConnectionLease,
    options: DriverPollOptions = {}
  ): Promise<Map<string, DirectPollObservation>> {
    const observations = new Map<string, DirectPollObservation>()
    if (entries.length === 0) return observations
    if (!options.nonce) throw new Error('Direct SSH polling requires a nonce.')

    const parts: string[] = [REMOTE_PROCESS_OWNERSHIP_FUNCTION]
    for (const { job, handle } of entries) {
      parts.push(
        `echo "${options.nonce}JOB_START:${job.job_id}"`,
        `workdir=$(cd -- ${quoteRemotePath(handle.workdir)} 2>/dev/null && pwd -P || true)`,
        `process_owned_by_workdir ${handle.pid} "$workdir"; case $? in 0) echo "${options.nonce}alive:1" ;; 1|3) echo "${options.nonce}alive:0" ;; *) echo "${options.nonce}alive:unknown" ;; esac`,
        `if [ -f ${quoteRemotePath(handle.exit_code_path)} ]; then POLL_EXIT_CODE=$(cat ${quoteRemotePath(handle.exit_code_path)}); else POLL_EXIT_CODE=; fi; printf '${options.nonce}exit:%s\\n' "$POLL_EXIT_CODE"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stdout_path)} 2>/dev/null || true`,
        `printf '\\n%s\\n' '${options.nonce}STDOUT_END:${job.job_id}'`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stderr_path)} 2>/dev/null || true`,
        `printf '\\n%s\\n' '${options.nonce}STDERR_END:${job.job_id}'`
      )
    }

    const result = await connection.run(parts.join('\n'), {
      timeoutMs: POLL_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: entries.length * PER_JOB_POLL_BYTES,
      signal: options.signal
    })
    const failure = classifyConnectionFailure(result, false)
    if (failure) throw failure
    if (isConnectionStdoutTruncated(result)) {
      for (const { job } of entries) {
        observations.set(job.job_id, {
          kind: 'unknown',
          diagnostic: 'poll_protocol_incomplete'
        })
      }
      return observations
    }

    for (const parsed of parsePollOutput(
      result.stdout,
      entries.map(({ job }) => job),
      options.nonce
    )) {
      observations.set(
        parsed.job.job_id,
        parsed.status === 'complete'
          ? {
              kind: 'complete',
              alive: parsed.alive,
              exitCode: parsed.exitCode,
              hasExitCode: parsed.hasExitCode,
              stdoutTail: parsed.stdoutTail,
              stderrTail: parsed.stderrTail
            }
          : { kind: 'unknown', diagnostic: 'poll_protocol_incomplete' }
      )
    }
    return observations
  }

  async cancel({
    job,
    handle: initialHandle,
    connection
  }: DriverCancelContext<RemoteHandle>): Promise<DriverCancelResult<RemoteHandle>> {
    let handle = initialHandle
    let recoveredHandle: RemoteHandle | undefined
    if (!handle && job.remote_workdir) {
      const observation = await probeRemoteLaunch(connection, job.remote_workdir)
      if (observation.kind === 'running') {
        handle = observation.handle
        recoveredHandle = observation.handle
      } else if (observation.kind === 'not_started') {
        return { confirmed: true, remoteWorkdirAbsent: true }
      } else if (observation.kind === 'exited' || observation.kind === 'vanished') {
        return { confirmed: true }
      } else {
        return { confirmed: false }
      }
    }
    if (!handle) return { confirmed: false }

    const ownership = await probeRemoteJobProcessOwnership(handle.pid, handle.workdir, connection)
    const result = (confirmed: boolean): DriverCancelResult<RemoteHandle> => ({
      confirmed,
      ...(recoveredHandle ? { recoveredHandle } : {})
    })
    if (ownership === 'mismatch' || ownership === 'absent') return result(true)
    if (ownership !== 'owned') return result(false)
    return result(await terminateRemoteJobProcessIfOwned(handle.pid, handle.workdir, connection))
  }

  private async recoverAmbiguousRemoteLaunch(
    job: ComputeJob,
    connection: ComputeConnectionLease,
    workdir: string,
    lifecycle: DriverSubmitContext['lifecycle'],
    invalidProtocolOutput?: string
  ): Promise<void> {
    let observation
    try {
      observation = await probeRemoteLaunch(connection, workdir)
    } catch (error) {
      await lifecycle.recordPollError(
        job.job_id,
        'submitted',
        error instanceof ComputeConnectionError ? error.code : 'dispatch_recovery_probe_failed'
      )
      return
    }

    if (observation.kind === 'running') {
      await lifecycle.dispatchRunning(job.job_id, JSON.stringify(observation.handle))
      return
    }
    if (observation.kind === 'exited') {
      const exitCode = observation.exitCode
      const { status, errorCode } = classifyComputeJobExit(job, exitCode)
      await lifecycle.finishPolled(job.job_id, {
        status,
        exitCode,
        errorCode,
        stdoutTail: null,
        stderrTail: null
      })
      return
    }
    if (observation.kind === 'vanished') {
      await lifecycle.finishPolled(job.job_id, {
        status: 'failed',
        errorCode: 'process_vanished',
        stdoutTail: null,
        stderrTail: null
      })
      return
    }
    if (observation.kind === 'not_started' && invalidProtocolOutput !== undefined) {
      const [safeStdout = ''] = await redactConnectionOutputs(connection, [invalidProtocolOutput])
      const stderrTail = `Could not read pid from dispatch output: ${JSON.stringify(safeStdout)}`
      await lifecycle.dispatchError(job.job_id, { errorCode: 'dispatch_failed', stderrTail })
      return
    }
    if (observation.kind === 'pending' || observation.kind === 'not_started') {
      await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_pending')
      return
    }
    if (observation.kind === 'ambiguous') {
      await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_ambiguous')
    }
  }
}

export const directSshDriver = new DirectSshDriver()
