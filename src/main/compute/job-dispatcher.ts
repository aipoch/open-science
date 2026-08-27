import { createHash } from 'node:crypto'

import type { ComputeJob } from '../../shared/compute'
import { createLogger, errorLogFields } from '../logger'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  redactConnectionOutputs,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { ComputeJobLifecycle } from './compute-job-lifecycle'

// Maximum number of bytes for the per-job dispatch SSH command (enough for base64 of large scripts).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024

// Timeout for the dispatch SSH connection (mkdir + write files + launch). Generous to accommodate
// slow cluster file systems; the job itself runs detached so the connection can close after.
const DISPATCH_TIMEOUT_MS = 120_000
const log = createLogger('compute')

// Remote handle stored in the DB once the job is launched.
export type RemoteHandle = {
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

export const REMOTE_PROCESS_OWNERSHIP_FUNCTION = [
  'process_owned_by_workdir() {',
  '  pid=$1',
  '  expected_workdir=$2',
  "  case $pid in ''|*[!0-9]*) return 1 ;; esac",
  '  [ -n "$expected_workdir" ] || return 1',
  '  process_workdir=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)',
  '  if [ -z "$process_workdir" ] && command -v lsof >/dev/null 2>&1; then',
  `    process_workdir=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
  '  fi',
  '  [ "$process_workdir" = "$expected_workdir" ]',
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

// Encodes a string to base64 for safe transfer via a single SSH command (avoids heredoc/quoting).
export const toBase64 = (content: string): string => Buffer.from(content).toString('base64')

// Computes the SHA-256 hash of a command string for auditing and deduplication.
export const hashCommand = (command: string): string =>
  createHash('sha256').update(command).digest('hex')

// Calculates the remote workdir path from the scratch root and job id.
// This is called both at submit time (to return immediately) and by the dispatcher.
export const computeRemoteWorkdir = (scratchRoot: string | undefined, jobId: string): string => {
  const root = scratchRoot?.trim() || '~'
  return `${root}/.openscience/jobs/${jobId}`
}

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export { quoteRemotePath } from './remote-path-security'

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | { kind: 'upload'; localPath: string; dstFilename: string; label: string }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  connection: ComputeConnectionLease
): Promise<void> => {
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
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running (success) or error (any failure).
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? sharedDispatchTracker
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    try {
      await dispatchJobInner(jobId, deps)
    } catch (error) {
      const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
      if (error instanceof ComputeConnectionError) {
        await lifecycle.dispatchError(jobId, {
          errorCode: error.code,
          stderrTail: error.message
        })
      } else {
        log.warn('remote Compute Job dispatch failed unexpectedly', {
          jobId,
          ...errorLogFields(error)
        })
        await lifecycle.dispatchError(jobId, {
          errorCode: 'dispatch_failed',
          stderrTail: 'The remote Compute Job dispatch failed unexpectedly.'
        })
      }
    }
  } finally {
    tracker.end(jobId)
  }
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { connectionBroker, hostRepository, jobRepository, onJobUpdated } = deps
  const lifecycle = new ComputeJobLifecycle(jobRepository, onJobUpdated)

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    await lifecycle.dispatchError(jobId, { errorCode: 'dispatch_failed' })
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
      errorCode: failure.code,
      stderrTail: failure.message
    })
    return
  }

  const workdir = job.remote_workdir ?? computeRemoteWorkdir(host.scratchRoot, jobId)
  const timeoutSecs = job.timeout_seconds ?? 86400 // default 24h

  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  if (job.input_manifest) {
    let entries: StagedInputEntry[]
    try {
      entries = JSON.parse(job.input_manifest) as StagedInputEntry[]
    } catch {
      await lifecycle.dispatchError(jobId, {
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
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`
      })
      return
    }
  }

  // Build scripts.
  const commandScript = job.command // raw command content written to command.sh
  const launcherScript = buildLauncherScript(timeoutSecs)

  // Encode to base64 to avoid all shell quoting/injection issues.
  const commandB64 = toBase64(commandScript)
  const launcherB64 = toBase64(launcherScript)

  // One SSH command: mkdir workdir, write scripts via base64 pipes, launch detached, echo pid.
  // Stdout = the pid (we echo it last).
  const quotedWorkdir = quoteRemotePath(workdir)
  const dispatchCmd = [
    `mkdir -p ${quotedWorkdir}`,
    `cd ${quotedWorkdir}`,
    // Write command.sh and launcher.sh via base64 to avoid heredoc/quoting issues.
    `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh`,
    `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh`,
    `chmod +x command.sh launcher.sh`,
    // Detached launch: nohup + setsid so the process survives SSH disconnect.
    `nohup setsid bash launcher.sh >/dev/null 2>&1 &`,
    // Write pid to file AND echo it so we can read it back in this round-trip.
    `LAUNCHED_PID=$!`,
    `echo $LAUNCHED_PID > job.pid`,
    `echo $LAUNCHED_PID`
  ].join('\n')

  const runResult = await connection.run(dispatchCmd, {
    timeoutMs: DISPATCH_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
  })

  const connectionFailure = classifyConnectionFailure(runResult, false)
  if (connectionFailure) throw connectionFailure

  // Non-connection failure (mkdir, base64, etc.)
  if (runResult.exitCode !== 0) {
    await lifecycle.dispatchError(jobId, {
      errorCode: 'dispatch_failed',
      stderrTail: 'The remote Compute Job launcher failed.'
    })
    return
  }

  // Parse pid from stdout (last non-empty line).
  const pid = Number.parseInt(runResult.stdout.trim().split('\n').pop() ?? '', 10)
  if (!Number.isFinite(pid) || pid <= 0) {
    const [safeStdout = ''] = await redactConnectionOutputs(connection, [runResult.stdout])
    await lifecycle.dispatchError(jobId, {
      errorCode: 'dispatch_failed',
      stderrTail: `Could not read pid from dispatch output: ${JSON.stringify(safeStdout)}`
    })
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
