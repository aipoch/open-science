import { createHash } from 'node:crypto'
import { assertSafeInputDestination } from './harvest-classifier'

import { applyComputeEnvironment } from './compute-environment'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  isConnectionStdoutTruncated,
  redactConnectionOutputs,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection'
import { DispatchTracker } from './dispatch-tracker'
import type { ComputeJob } from './model'
import type { ComputeHostRepository, ComputeJobRepository } from './ports'
import { toBase64, type RemoteHandle } from './remote-job-contract'
import { remoteJobPidOwnershipFunctionLines } from './remote-job-process'
import { classifyComputeJobExit, probeRemoteLaunch } from './remote-launch-recovery'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import { dispatchSlurmJob, SlurmDriverError } from './slurm-driver'

export {
  toBase64,
  type ComputeRemoteHandle,
  type RemoteHandle,
  type SlurmRemoteHandle
} from './remote-job-contract'

// Maximum number of bytes for the per-job dispatch SSH command (enough for base64 of large scripts).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024
const PRE_LAUNCH_FAILURE = 'OPEN_SCIENCE_DISPATCH_PRE_LAUNCH_FAILED_V1'

// Timeout for the dispatch SSH connection (mkdir + write files + launch). Generous to accommodate
// slow cluster file systems; the job itself runs detached so the connection can close after.
const DISPATCH_TIMEOUT_MS = 120_000

export const REMOTE_PROCESS_OWNERSHIP_FUNCTION = [
  ...remoteJobPidOwnershipFunctionLines(),
  'process_owned_by_workdir() {',
  '  workdir=$2',
  '  job_pid_is_owned "$1"',
  '}'
].join('\n')

// Builds the launcher.sh script content for a given job.
// Uses timeout(1) with SIGTERM then SIGKILL after 30s grace. The login shell loads profile
// configuration, then attempts to source a readable .bashrc (non-interactive bash does not do so
// itself). A missing .bashrc is a no-op; a source failure returns through the normal exit-code
// lifecycle. A .bashrc may deliberately return early for non-interactive shells. exec then replaces
// the initialized shell with the user workload shell.
// exit_code is written via a tmp→rename atomic pattern so the poller never reads a partial value.
export const buildLauncherScript = (timeoutSeconds: number): string => {
  return (
    '#!/usr/bin/env bash\n' +
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -l -c 'if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; exec bash command.sh' > stdout 2> stderr\n` +
    'echo $? > exit_code.tmp && mv exit_code.tmp exit_code\n'
  )
}

// Computes the SHA-256 hash of a command string for auditing and deduplication.
export const hashCommand = (command: string): string =>
  createHash('sha256').update(command).digest('hex')

// Calculates the remote workdir path from the scratch root and job id.
// This is called both at submit time (to return immediately) and by the dispatcher.
export const computeRemoteWorkdir = (scratchRoot: string | undefined, jobId: string): string => {
  const root = scratchRoot?.trim() || '~'
  return `${root}/.open-science/jobs/${jobId}`
}

export const computeLegacyRemoteWorkdir = (
  scratchRoot: string | undefined,
  jobId: string
): string => `${scratchRoot?.trim() || '~'}/.openscience/jobs/${jobId}`

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export { quoteRemotePath } from './remote-path-security'

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | {
      kind: 'upload'
      localPath: string
      dstFilename: string
      label: string
      generationId?: string
      checksum?: string
      sizeBytes?: number
    }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  connection: ComputeConnectionLease
): Promise<void> => {
  // Validate the complete persisted manifest before the first upload or symlink.
  for (const entry of entries) assertSafeInputDestination(entry.dstFilename)
  for (const entry of entries) {
    if (entry.kind === 'upload') {
      const remoteDest = `${workdir}/${entry.dstFilename}`
      await connection.upload(entry.localPath, remoteDest)
    } else {
      // Remote symlink: ln -s /abs/path workdir/dst_filename
      const quoted = shellSingleQuote(entry.remotePath)
      const destQ = quoteRemotePath(`${workdir}/${entry.dstFilename}`)
      const lnCmd = `ln -s ${quoted} ${destQ}`
      const result = await connection.run(lnCmd, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      const connectionFailure = classifyConnectionFailure(result, false)
      if (connectionFailure) throw connectionFailure
      if (result.exitCode !== 0) {
        throw new Error(`ln -s failed for ${entry.label}.`)
      }
    }
  }
}

// Dependency interface for the dispatcher. Tests inject a fake SshRunner.
export type DispatcherDeps = {
  connectionBroker: ComputeConnectionBrokerAcquirer
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted (Phase 3a).
  onJobUpdated?: (job: ComputeJob) => void
  // Tracks this dispatch as in-flight so the poller won't mistake a job that is still staging
  // inputs for a restart-orphaned one. Defaults to the process-wide shared tracker.
  dispatchTracker?: DispatchTracker
  resolveInputPath?: (path: string) => string
  finalizeDispatchError?: (jobId: string) => Promise<void>
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running/terminal when remote launch state is proven, or error when a
// failure is definitive. Ambiguous launch responses remain submitted for non-destructive recovery.
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? new DispatchTracker()
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    try {
      await dispatchJobInner(jobId, deps)
    } catch (error) {
      // Unknown failures may occur after the remote launcher has started but before its handle is
      // durable. Leave that row submitted so deterministic restart recovery can adopt it; only a
      // transport failure already proven to be pre-launch is safe to terminalize here.
      if (error instanceof SlurmDriverError) {
        const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
        if (error.code === 'host_unreachable') {
          await lifecycle.recordPollError(jobId, 'submitted', error.message, false)
          return
        }
        await lifecycle.dispatchError(jobId, {
          definitelyNotStarted: true,
          errorCode: error.code,
          stderrTail: error.message
        })
        return
      }
      if (!(error instanceof ComputeConnectionError)) return
      const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
      await lifecycle.dispatchError(jobId, {
        definitelyNotStarted: true,
        errorCode: error.code,
        stderrTail: error.message
      })
    }
  } finally {
    try {
      await deps.finalizeDispatchError?.(jobId)
    } finally {
      tracker.end(jobId)
    }
  }
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { connectionBroker, hostRepository, jobRepository, onJobUpdated } = deps
  const lifecycle = new ComputeJobLifecycle(jobRepository, onJobUpdated)

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    await lifecycle.dispatchError(jobId, {
      definitelyNotStarted: true,
      errorCode: 'dispatch_failed'
    })
    return
  }

  // The lease captures one Host/authentication-revision snapshot for this entire dispatch.
  let connection: ComputeConnectionLease
  try {
    connection = await connectionBroker.acquire(job.provider_id, { intent: 'job_dispatch' })
  } catch (err) {
    const failure =
      err instanceof ComputeConnectionError
        ? { code: err.code, message: err.message }
        : { code: 'host_unreachable', message: 'The Compute Host could not be reached.' }
    await lifecycle.dispatchError(jobId, {
      definitelyNotStarted: true,
      errorCode: failure.code,
      stderrTail: failure.message
    })
    return
  }

  const workdir = job.remote_workdir ?? computeLegacyRemoteWorkdir(host.scratchRoot, jobId)
  const timeoutSecs = job.timeout_seconds ?? 86400 // default 24h

  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  if (job.input_manifest) {
    let entries: StagedInputEntry[]
    try {
      entries = (JSON.parse(job.input_manifest) as StagedInputEntry[]).map((entry) =>
        entry.kind === 'upload'
          ? {
              ...entry,
              localPath: deps.resolveInputPath
                ? deps.resolveInputPath(entry.localPath)
                : entry.localPath
            }
          : entry
      )
    } catch {
      await lifecycle.dispatchError(jobId, {
        definitelyNotStarted: true,
        errorCode: 'dispatch_failed',
        stderrTail: 'Failed to parse inputManifest JSON'
      })
      return
    }

    // Mkdir workdir first so symlinks and uploads have a destination.
    const mkdirResult = await connection.run(`mkdir -p ${quoteRemotePath(workdir)}`, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    const mkdirConnectionFailure = classifyConnectionFailure(mkdirResult, false)
    if (mkdirConnectionFailure) throw mkdirConnectionFailure
    if (mkdirResult.exitCode !== 0) {
      await lifecycle.dispatchError(jobId, {
        definitelyNotStarted: true,
        errorCode: 'dispatch_failed',
        stderrTail: 'Could not prepare the remote Compute Job directory.'
      })
      return
    }

    try {
      await stageInputs(entries, workdir, connection)
    } catch (err) {
      if (err instanceof ComputeConnectionError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      await lifecycle.dispatchError(jobId, {
        definitelyNotStarted: true,
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`
      })
      return
    }
  }

  const commandScript = applyComputeEnvironment(job.command, job.environment)

  if (job.execution_mode === 'slurm') {
    const handle = await dispatchSlurmJob(job, connection, workdir)
    await lifecycle.dispatchSubmitted(jobId, JSON.stringify(handle))
    return
  }

  // Build scripts.
  const launcherScript = buildLauncherScript(timeoutSecs)

  // Encode to base64 to avoid all shell quoting/injection issues.
  const commandB64 = toBase64(commandScript)
  const launcherB64 = toBase64(launcherScript)

  // One SSH command: mkdir workdir, write scripts via base64 pipes, launch detached, echo pid.
  // Stdout = the pid (we echo it last).
  const quotedWorkdir = quoteRemotePath(workdir)
  const preparationFailure = ` || { printf '%s\\n' '${PRE_LAUNCH_FAILURE}'; exit 73; }`
  const dispatchCmd = [
    `mkdir -p ${quotedWorkdir}` + preparationFailure,
    `cd ${quotedWorkdir}` + preparationFailure,
    // Write command.sh and launcher.sh via base64 to avoid heredoc/quoting issues.
    `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh` + preparationFailure,
    `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh` + preparationFailure,
    `chmod +x command.sh launcher.sh` + preparationFailure,
    // Detached launch: nohup + setsid so the process survives SSH disconnect.
    `nohup setsid bash launcher.sh >/dev/null 2>&1 &`,
    // Write pid to file AND echo it so we can read it back in this round-trip.
    `LAUNCHED_PID=$!`,
    `echo $LAUNCHED_PID > job.pid || { echo $LAUNCHED_PID; exit 74; }`,
    `echo $LAUNCHED_PID`
  ].join('\n')

  const dispatchAttempt = await lifecycle.beginRemoteDispatch(jobId, workdir)
  if (dispatchAttempt.kind === 'ignored') return

  let runResult
  try {
    runResult = await connection.run(dispatchCmd, {
      timeoutMs: DISPATCH_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
    })
  } catch (error) {
    if (isDefinitivePreLaunchConnectionError(error)) throw error
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
    return
  }

  const connectionFailure = classifyConnectionFailure(runResult, false)
  if (connectionFailure) {
    if (isDefinitivePreLaunchResult(runResult, connectionFailure)) throw connectionFailure
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
    return
  }

  // Only this preparation-only response proves that detached launch was never reached.
  if (
    runResult.exitCode === 73 &&
    !isConnectionStdoutTruncated(runResult) &&
    runResult.stdout.trim() === PRE_LAUNCH_FAILURE
  ) {
    await lifecycle.dispatchError(jobId, {
      definitelyNotStarted: true,
      errorCode: 'dispatch_failed',
      stderrTail: 'The remote Compute Job launcher failed.'
    })
    return
  }

  if (runResult.exitCode !== 0 && runResult.exitCode !== 74) {
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
    return
  }

  // The dispatch protocol is exactly one positive integer line. Partial output and permissive
  // parseInt prefixes are ambiguous because adopting the wrong PID can later target another job.
  const pidOutput = runResult.stdout.trim()
  const pid = /^[1-9]\d*$/.test(pidOutput) ? Number(pidOutput) : Number.NaN
  if (isConnectionStdoutTruncated(runResult) || !Number.isSafeInteger(pid) || pid <= 1) {
    await recoverAmbiguousRemoteLaunch(
      job,
      connection,
      workdir,
      lifecycle,
      runResult.exitCode === 74 ? undefined : runResult.stdout
    )
    return
  }

  // Build the remote handle JSON.
  const handle: RemoteHandle = {
    pid,
    exit_code_path: `${workdir}/exit_code`,
    stdout_path: `${workdir}/stdout`,
    stderr_path: `${workdir}/stderr`,
    workdir
  }

  await lifecycle.dispatchRunning(jobId, JSON.stringify(handle))
}

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

const recoverAmbiguousRemoteLaunch = async (
  job: ComputeJob,
  connection: ComputeConnectionLease,
  workdir: string,
  lifecycle: ComputeJobLifecycle,
  invalidProtocolOutput?: string
): Promise<void> => {
  let observation
  try {
    observation = await probeRemoteLaunch(connection, workdir)
  } catch (error) {
    // A failed recovery probe cannot distinguish "not launched" from "launched but unreachable".
    // Keep the durable submitted row for the poller to retry instead of inventing a terminal error.
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
    await lifecycle.recordPollError(job.job_id, 'submitted', stderrTail)
    return
  }
  if (observation.kind === 'pending' || observation.kind === 'not_started') {
    await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_pending')
    return
  }
  if (observation.kind === 'ambiguous') {
    await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_ambiguous')
  }
  // An inconclusive workdir — including one not created yet immediately after response loss — is
  // genuinely ambiguous. The poller retries the same non-destructive probe on its next tick.
}
