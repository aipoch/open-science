import { applyComputeEnvironment } from './compute-environment'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  isConnectionStdoutTruncated,
  type ComputeConnectionLease,
  type ConnectionRunResult
} from './connection'
import type { ComputeJob } from './model'
import { toBase64, type SlurmRemoteHandle } from './remote-job-contract'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'

const SLURM_TIMEOUT_MS = 120_000
const SLURM_POLL_TIMEOUT_MS = 30_000
const TAIL_BYTES = 65_536
const SUBMISSION_ERROR_FILE = 'scheduler_submit_error'
const SUBMISSION_ERROR_MAX_BYTES = 4096

export type SlurmObservation =
  | { kind: 'active'; state: string; reason?: string }
  | {
      kind: 'terminal'
      state: string
      exitCode?: number
      stdout: string
      stderr: string
      diagnostic?: string
    }
  | { kind: 'unknown'; diagnostic: string; state?: string }
  | { kind: 'unavailable'; diagnostic: string }

export type SlurmCancellationResult =
  | { kind: 'cancelled'; diagnostic?: string }
  | {
      kind: 'completed'
      state: string
      exitCode?: number
      stdoutTail?: string
      stderrTail?: string
      diagnostic?: string
    }
  | { kind: 'rejected'; message: string }
  | {
      kind: 'unavailable'
      message: string
      cancellationError?: { code: 'cancel_request_rejected'; message: string }
    }
  | { kind: 'unconfirmed'; message?: string }

export class SlurmDriverError extends Error {
  constructor(
    readonly code: 'host_unreachable' | 'dispatch_failed' | 'invalid_resources',
    message: string
  ) {
    super(message)
    this.name = 'SlurmDriverError'
  }
}

const jobName = (jobId: string, workdir?: string): string =>
  `${workdir?.includes('/.openscience/jobs/') ? 'openscience' : 'open-science'}-${jobId}`

const normalizeState = (state: string): string =>
  state
    .trim()
    .replace(/\s+by\s+\d+$/i, '')
    .replace(/\+$/, '')
    .toUpperCase()

const terminalStates = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'OUT_OF_MEMORY',
  'NODE_FAIL',
  'BOOT_FAIL',
  'PREEMPTED',
  'DEADLINE',
  'REVOKED',
  'SPECIAL_EXIT'
])

const APP_OWNED_DIRECTIVE_GUIDANCE: Record<string, string> = {
  output: 'Remove it; Open-Science captures scheduler stdout in the Job result.',
  error: 'Remove it; Open-Science captures scheduler stderr in the Job result.',
  chdir: 'Remove it; Open-Science submits from the managed Job working directory.',
  'job-name': 'Remove it; Open-Science assigns the Job name used for tracking and recovery.',
  array: 'Submit independent Open-Science Jobs instead.',
  wrap: 'Put the workload command directly after the #SBATCH header instead.',
  clusters: 'Choose a Compute Host for the intended Slurm cluster instead.',
  'het-group': 'Submit each workload as a separate Open-Science Job instead.'
}

const appOwnedDirective = (line: string): { option: string; guidance: string } | undefined => {
  const match = line.match(
    /(?:^|\s)--(output|error|chdir|job-name|array|wrap|clusters|het-group)(?:=|\s|$)/i
  )
  if (!match?.[1]) return undefined
  const option = match[1].toLowerCase()
  return { option: `--${option}`, guidance: APP_OWNED_DIRECTIVE_GUIDANCE[option]! }
}

export const isTerminalSlurmState = (state: string): boolean =>
  terminalStates.has(normalizeState(state))

export const parseSbatchJobId = (output: string): string | undefined => {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    const match = line.trim().match(/^(?:Submitted batch job )?(\d+(?:_[0-9]+)?)(?:;[^\s]+)?$/)
    if (match) return match[1]
  }
  return undefined
}

const commandDirectives = (
  command: string
): { directives: string[]; hasTime: boolean; workload: string } => {
  const directives: string[] = []
  const directiveLines = new Set<number>()
  const lines = command.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#!') || (line.startsWith('#') && !line.startsWith('#SBATCH')))
      continue
    if (!line.startsWith('#SBATCH')) break
    const owned = appOwnedDirective(line)
    if (owned) {
      throw new SlurmDriverError(
        'invalid_resources',
        `Slurm directive ${owned.option} is managed by Open-Science. ${owned.guidance}`
      )
    }
    if (
      !/^#SBATCH\s+--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\r\n`;|&$<>\\]+)?$/.test(line) ||
      /\s-{1,2}[A-Za-z0-9]/.test(line.slice('#SBATCH '.length))
    ) {
      const options = [
        ...line.slice('#SBATCH '.length).matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9-]*)/g)
      ]
        .map((match) => match[1])
        .filter((option): option is string => Boolean(option))
      throw new SlurmDriverError(
        'invalid_resources',
        options.length > 1
          ? `Slurm directive contains multiple options (${options.join(', ')}). Put each resource option on its own line using #SBATCH --option=value and long option names.`
          : `Unsupported Slurm directive${options[0] ? ` ${options[0]}` : ''}. Use one #SBATCH --option=value resource directive per line at the start of the command.`
      )
    }
    directives.push(line)
    directiveLines.add(index)
  }
  return {
    directives,
    hasTime: directives.some((line) => /^#SBATCH\s+--time(?:=|\s|$)/.test(line)),
    workload: lines.filter((_line, index) => !directiveLines.has(index)).join('\n')
  }
}

export const hasLeadingSlurmDirective = (command: string): boolean => {
  for (const rawLine of command.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || (line.startsWith('#') && !line.startsWith('#SBATCH'))) continue
    return line.startsWith('#SBATCH')
  }
  return false
}

export const validateSlurmCommand = (command: string): void => {
  commandDirectives(command)
}

export const buildSlurmScript = (
  job: Pick<ComputeJob, 'job_id' | 'command' | 'timeout_seconds'> & { environment?: string },
  workdir: string
): string => {
  const timeout = job.timeout_seconds ?? 86_400
  const parsedDirectives = commandDirectives(applyComputeEnvironment(job.command, job.environment))
  return [
    '#!/usr/bin/env bash',
    `#SBATCH --job-name=${jobName(job.job_id, workdir)}`,
    '#SBATCH --output=stdout',
    '#SBATCH --error=stderr',
    ...(parsedDirectives.hasTime ? [] : [`#SBATCH --time=${Math.max(1, Math.ceil(timeout / 60))}`]),
    ...parsedDirectives.directives,
    `timeout -s TERM -k 30s ${timeout} bash -l -c ${shellSingleQuote(`if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi\n${parsedDirectives.workload}`)}`,
    'exit "$?"',
    ''
  ].join('\n')
}

const handleFor = (workdir: string, schedulerJobId: string): SlurmRemoteHandle => ({
  driver: 'slurm',
  version: 1,
  scheduler_job_id: schedulerJobId,
  workdir,
  stdout_path: `${workdir}/stdout`,
  stderr_path: `${workdir}/stderr`
})

const readSubmissionError = async (
  workdir: string,
  connection: ComputeConnectionLease
): Promise<string | undefined> => {
  const path = quoteRemotePath(`${workdir}/${SUBMISSION_ERROR_FILE}`)
  try {
    const result = await connection.run(`if [ -f ${path} ]; then base64 < ${path}; fi`, {
      timeoutMs: SLURM_POLL_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: Math.ceil((SUBMISSION_ERROR_MAX_BYTES * 4) / 3) + 16
    })
    if (
      classifyConnectionFailure(result, false) ||
      result.exitCode !== 0 ||
      isConnectionStdoutTruncated(result) ||
      !/^[A-Za-z0-9+/=\r\n]*$/.test(result.stdout)
    ) {
      return undefined
    }
    const receipt = Buffer.from(result.stdout.replace(/\s/g, ''), 'base64').toString('utf8')
    const match = receipt.match(/^([1-9]\d{0,2})\n([\s\S]*)$/)
    if (!match || Number(match[1]) > 255) return undefined
    return match[2]?.trim() || `sbatch exited with status ${match[1]}.`
  } catch {
    return undefined
  }
}

export const dispatchSlurmJob = async (
  job: ComputeJob,
  connection: ComputeConnectionLease,
  workdir: string
): Promise<SlurmRemoteHandle> => {
  const script = buildSlurmScript(job, workdir)
  const quoted = quoteRemotePath(workdir)
  let result
  try {
    result = await connection.run(
      [
        'set -e',
        `mkdir -p ${quoted}`,
        `cd ${quoted}`,
        `printf '%s' ${JSON.stringify(toBase64(script))} | base64 -d > job.sbatch`,
        `rm -f ${SUBMISSION_ERROR_FILE} ${SUBMISSION_ERROR_FILE}.tmp ${SUBMISSION_ERROR_FILE}.stderr.tmp`,
        'set +e',
        `SLURM_JOB_ID=$(sbatch --parsable --job-name=${jobName(job.job_id, workdir)} --output=stdout --error=stderr --chdir="$PWD" job.sbatch 2>${SUBMISSION_ERROR_FILE}.stderr.tmp)`,
        'SBATCH_EXIT=$?',
        'set -e',
        'if [ "$SBATCH_EXIT" -ne 0 ]; then',
        `  { printf '%s\\n' "$SBATCH_EXIT"; cat ${SUBMISSION_ERROR_FILE}.stderr.tmp; } > ${SUBMISSION_ERROR_FILE}.tmp`,
        `  mv ${SUBMISSION_ERROR_FILE}.tmp ${SUBMISSION_ERROR_FILE}`,
        `  cat ${SUBMISSION_ERROR_FILE}.stderr.tmp >&2`,
        `  rm -f ${SUBMISSION_ERROR_FILE}.stderr.tmp`,
        '  exit "$SBATCH_EXIT"',
        'fi',
        `rm -f ${SUBMISSION_ERROR_FILE}.stderr.tmp`,
        'printf \'%s\\n\' "$SLURM_JOB_ID" > scheduler_job_id.tmp',
        'mv scheduler_job_id.tmp scheduler_job_id',
        'printf \'%s\\n\' "$SLURM_JOB_ID"'
      ].join('\n'),
      {
        timeoutMs: SLURM_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: 4096
      }
    )
  } catch (error) {
    const submissionError = await readSubmissionError(workdir, connection)
    if (submissionError) throw new SlurmDriverError('dispatch_failed', submissionError)
    try {
      const recovered = await recoverSlurmJob(job, connection)
      if (recovered) return recovered
    } catch {
      // Recovery continues from the durable workdir on the poller's next tick.
    }
    throw new SlurmDriverError(
      'host_unreachable',
      error instanceof Error
        ? `Slurm submission response was interrupted: ${error.message}`
        : 'Slurm submission response was interrupted.'
    )
  }
  const failure = classifyConnectionFailure(result, false)
  if (failure) {
    const submissionError = await readSubmissionError(workdir, connection)
    if (submissionError) throw new SlurmDriverError('dispatch_failed', submissionError)
    try {
      const recovered = await recoverSlurmJob(job, connection)
      if (recovered) return recovered
    } catch {
      // Recovery continues from the durable workdir on the poller's next tick.
    }
    throw new SlurmDriverError('host_unreachable', failure.message)
  }
  if (result.exitCode !== 0)
    throw new SlurmDriverError('dispatch_failed', result.stderr || 'sbatch failed.')
  const id = parseSbatchJobId(result.stdout)
  if (!id) {
    const recovered = await recoverSlurmJob(job, connection)
    if (recovered) return recovered
    throw new SlurmDriverError(
      'host_unreachable',
      'Slurm submission may have succeeded, but its job id was not confirmed. Open-Science will look up candidates and recover only a job whose recorded workdir proves ownership; it will not submit a duplicate.'
    )
  }
  return handleFor(workdir, id)
}

export const recoverSlurmJob = async (
  job: ComputeJob,
  connection: ComputeConnectionLease
): Promise<SlurmRemoteHandle | undefined> => {
  const workdir = job.remote_workdir
  if (!workdir) return undefined
  const name = jobName(job.job_id, workdir)
  const receiptPath = quoteRemotePath(`${workdir}/scheduler_job_id`)
  const scriptPath = quoteRemotePath(`${workdir}/job.sbatch`)
  const quotedWorkdir = quoteRemotePath(workdir)
  const result = await connection.run(
    [
      'receipt=',
      `if [ -f ${receiptPath} ]; then`,
      `  receipt=$(cat ${receiptPath})`,
      `  case "$receipt" in ''|*[!0-9_]*) exit 0 ;; esac`,
      `  printf 'receipt|%s\n' "$receipt"`,
      'fi',
      // A receipt is only a candidate identifier because the workload can write its working
      // directory. Scheduler-owned name and canonical workdir metadata remain the ownership proof.
      `[ -f ${scriptPath} ] || exit 0`,
      `expected_workdir=$(cd ${quotedWorkdir} && pwd -P) || exit 0`,
      `printf 'expected|%s\n' "$expected_workdir"`,
      `squeue --noheader --name=${shellSingleQuote(name)} --format='active|%A|%j|%Z' 2>/dev/null || true`,
      `sacct --parsable2 --noheader --allocations --name=${shellSingleQuote(name)} --starttime=1970-01-01 --format=JobIDRaw,JobName%256,WorkDir%1024 2>/dev/null | sed 's/^/accounting|/' || true`
    ].join('\n'),
    { timeoutMs: SLURM_POLL_TIMEOUT_MS, loginShell: false, maxOutputBytes: 4096 }
  )
  const failure = classifyConnectionFailure(result, false)
  if (failure) throw failure
  const lines = result.stdout.split(/\r?\n/)
  const receipt = lines.find((line) => line.startsWith('receipt|'))
  const receiptId = receipt ? parseSbatchJobId(receipt.slice('receipt|'.length)) : undefined
  const expectedWorkdir = lines
    .find((line) => line.startsWith('expected|'))
    ?.slice('expected|'.length)
  if (!expectedWorkdir) return undefined
  const ids = new Set<string>()
  for (const line of lines) {
    const parts = line.split('|')
    if (parts[0] !== 'active' && parts[0] !== 'accounting') continue
    const id = parseSbatchJobId(parts[1] ?? '')
    const candidateName = parts[2]
    const candidateWorkdir = parts[3]
    if (id && candidateName === name && candidateWorkdir === expectedWorkdir) ids.add(id)
  }
  if (receiptId) return ids.has(receiptId) ? handleFor(workdir, receiptId) : undefined
  if (ids.size !== 1) return undefined
  return handleFor(workdir, [...ids][0])
}

const activeStates = new Set([
  'PENDING',
  'RUNNING',
  'CONFIGURING',
  'COMPLETING',
  'SUSPENDED',
  'RESIZING',
  'REQUEUED',
  'REQUEUE_FED',
  'REQUEUE_HOLD',
  'SIGNALING',
  'STAGE_OUT',
  'STOPPED'
])
const knownState = (state: string): boolean => activeStates.has(state) || terminalStates.has(state)
const noSuchJob = (text: string): boolean =>
  /invalid job id|no jobs? in the system|job [^\r\n]*not found/i.test(text)
const accountingDisabled = (result: ConnectionRunResult): boolean =>
  (result.exitCode === 127 && /sacct.*(?:not found|no such file)/i.test(result.stderr)) ||
  /accounting (?:storage )?(?:is )?(?:disabled|not enabled)|accountingstorage(?:type)?(?:=|\s+)(?:none|accounting_storage\/none)|slurm accounting storage is disabled/i.test(
    result.stderr
  )

type SchedulerRow = { state: string; exitCode?: number; reason?: string }
type SlurmEntry = { job: ComputeJob; handle: SlurmRemoteHandle }
type Query =
  | { result: ConnectionRunResult; diagnostic?: never; disconnected?: never }
  | { result?: never; diagnostic: string; disconnected: boolean }
const query = async (
  connection: ComputeConnectionLease,
  command: string,
  maxOutputBytes: number
): Promise<Query> => {
  try {
    const result = await connection.run(command, {
      timeoutMs: SLURM_POLL_TIMEOUT_MS,
      loginShell: false,
      preserveRemoteCommandErrors: true,
      maxOutputBytes
    })
    const failure =
      result.timedOut || result.exitCode === 255 || result.exitCode === null
        ? classifyConnectionFailure(result, false)
        : undefined
    if (failure)
      return {
        diagnostic: `${command.split(' ')[0]}: ${result.stderr.trim() || failure.message}`,
        disconnected:
          result.exitCode === 255 ||
          ['authentication_failed', 'host_key_unknown', 'host_key_changed'].includes(failure.code)
      }
    if (isConnectionStdoutTruncated(result))
      return {
        diagnostic: `${command.split(' ')[0]} output exceeded the polling protocol limit.`,
        disconnected: false
      }
    return { result }
  } catch (error) {
    return {
      diagnostic: error instanceof Error ? error.message : 'Slurm query failed.',
      disconnected: error instanceof ComputeConnectionError && error.code !== 'timeout'
    }
  }
}
const parseExitCode = (text: string | undefined): number | undefined => {
  const match = text?.match(/^(\d+):(\d+)$/)
  if (!match) return undefined
  const code = Number(match[1])
  const signal = Number(match[2])
  return Number.isSafeInteger(code) && Number.isSafeInteger(signal)
    ? signal > 0
      ? 128 + signal
      : code
    : undefined
}
const usableRow = (row: SchedulerRow): boolean =>
  row.state !== 'COMPLETED' || row.exitCode !== undefined

type JobQueryEvidence = {
  row?: SchedulerRow
  queueMissing: boolean
  controllerMissing: boolean
  diagnostics: string[]
}
const mergeSchedulerRow = (item: JobQueryEvidence, row: SchedulerRow): void => {
  if (item.row && isTerminalSlurmState(item.row.state)) {
    if (!isTerminalSlurmState(row.state)) return
    // Natural completion already obtained takes priority over a conflicting cancellation record.
    if (item.row.state !== 'CANCELLED' && row.state === 'CANCELLED') return
    if (
      item.row.state === row.state &&
      row.exitCode === undefined &&
      item.row.exitCode !== undefined
    )
      return
  }
  item.row = row
}

// Keep source evidence separate from the observation. Only successful/recognized absence from
// both live sources plus disabled accounting proves that this query path has no remaining result.
const querySlurmJobs = async (
  jobs: SlurmEntry[],
  connection: ComputeConnectionLease
): Promise<{
  observations: Map<string, SlurmObservation>
  evidence: Map<string, JobQueryEvidence>
  disconnectedDiagnostic?: string
}> => {
  const observations = new Map<string, SlurmObservation>()
  const evidence = new Map<string, JobQueryEvidence>()
  if (jobs.length === 0) return { observations, evidence }
  const ids = jobs.map(({ handle }) => handle.scheduler_job_id)
  for (const id of ids)
    evidence.set(id, { queueMissing: false, controllerMissing: false, diagnostics: [] })
  const queue = await query(
    connection,
    `squeue --noheader --states=all -j ${ids.join(',')} --format='%i|%T|%r'`,
    jobs.length * 1024
  )
  if (!queue.result && queue.disconnected) {
    // A dead connection should cost one timeout for this host, not one for every Job.
    for (const id of ids) observations.set(id, { kind: 'unknown', diagnostic: queue.diagnostic })
    return { observations, evidence, disconnectedDiagnostic: queue.diagnostic }
  }
  let queueMalformed = false
  const malformedQueueIds = new Set<string>()
  if (queue.result) {
    for (const line of queue.result.stdout.split(/\r?\n/).filter((line) => line.trim())) {
      const [id, rawState, reason] = line.trim().split('|')
      const item = id ? evidence.get(id) : undefined
      const state = normalizeState(rawState ?? '')
      if (!item || !knownState(state)) {
        queueMalformed = true
        if (item && id) malformedQueueIds.add(id)
        continue
      }
      item.row = { state, reason: reason || undefined }
    }
  }
  const queueSucceeded = queue.result?.exitCode === 0 && !queueMalformed
  const queueRejectedId = queue.result !== undefined && noSuchJob(queue.result.stderr)
  const candidates: SlurmEntry[] = []
  let disconnectedDiagnostic: string | undefined
  for (const entry of jobs) {
    const id = entry.handle.scheduler_job_id
    const item = evidence.get(id)!
    item.queueMissing =
      !item.row &&
      !malformedQueueIds.has(id) &&
      (queueSucceeded || (queueRejectedId && jobs.length === 1))
    if (item.row && activeStates.has(item.row.state)) {
      observations.set(id, { kind: 'active', ...item.row })
      continue
    }
    if (!queueSucceeded && !item.row)
      item.diagnostics.push(
        queue.diagnostic ??
          queue.result?.stderr.trim() ??
          'squeue returned an unrecognized response.'
      )
    candidates.push(entry)
    if (disconnectedDiagnostic) {
      item.diagnostics.push(disconnectedDiagnostic)
      continue
    }
    const control = await query(connection, `scontrol show job ${id} --oneliner`, 16 * 1024)
    if (!control.result) {
      item.diagnostics.push(control.diagnostic)
      if (control.disconnected) disconnectedDiagnostic = control.diagnostic
      continue
    }
    const result = control.result
    if (noSuchJob(result.stderr) || /^\s*No jobs? in the system\s*$/i.test(result.stdout)) {
      item.controllerMissing = true
      // A batch containing an expired ID can fail before looking up its siblings. Confirm this
      // missing Job individually instead of treating every omitted row as an empty queue.
      if (queueRejectedId && jobs.length > 1 && !item.row && !malformedQueueIds.has(id)) {
        const single = await query(
          connection,
          `squeue --noheader --states=all -j ${id} --format='%i|%T|%r'`,
          1024
        )
        if (single.disconnected) disconnectedDiagnostic = single.diagnostic
        item.queueMissing =
          single.result !== undefined &&
          ((single.result.exitCode === 0 && !single.result.stdout.trim()) ||
            (!single.result.stdout.trim() && noSuchJob(single.result.stderr)))
        if (!item.queueMissing)
          item.diagnostics.push(
            single.diagnostic ?? single.result?.stderr ?? 'squeue absence was not confirmed.'
          )
      }
      continue
    }
    const state = result.stdout.match(/(?:^|\s)JobState=(\S+)/)?.[1]
    const returnedId = result.stdout.match(/(?:^|\s)JobId=(\S+)/)?.[1]
    if (
      result.exitCode !== 0 ||
      returnedId !== id ||
      !state ||
      !knownState(normalizeState(state))
    ) {
      item.diagnostics.push(result.stderr.trim() || 'scontrol returned an unrecognized response.')
      continue
    }
    const row = {
      state: normalizeState(state),
      exitCode: parseExitCode(result.stdout.match(/(?:^|\s)ExitCode=(\S+)/)?.[1])
    }
    // An already observed terminal state cannot be replaced by a stale active record.
    mergeSchedulerRow(item, row)
    if (item.row && activeStates.has(item.row.state))
      observations.set(id, { kind: 'active', ...item.row })
  }
  const accountingCandidates = candidates.filter(({ handle }) => {
    const row = evidence.get(handle.scheduler_job_id)!.row
    return !row || (isTerminalSlurmState(row.state) && row.exitCode === undefined)
  })
  let accounting: Query | undefined
  if (accountingCandidates.length > 0 && !disconnectedDiagnostic) {
    accounting = await query(
      connection,
      `sacct --parsable2 --noheader -j ${accountingCandidates.map(({ handle }) => handle.scheduler_job_id).join(',')} --format=JobIDRaw,State,ExitCode`,
      accountingCandidates.length * 2048
    )
    if (accounting.disconnected) disconnectedDiagnostic = accounting.diagnostic
    if (accounting.result?.exitCode === 0) {
      for (const line of accounting.result.stdout.split(/\r?\n/).filter((line) => line.trim())) {
        const [id, rawState, rawExit] = line.trim().split('|')
        if (!id || id.includes('.')) continue
        const item = evidence.get(id)
        if (!item) continue
        const state = normalizeState(rawState ?? '')
        if (!knownState(state)) {
          item.diagnostics.push(`sacct returned an unrecognized state: ${rawState ?? ''}.`)
          continue
        }
        const row = { state, exitCode: parseExitCode(rawExit) }
        mergeSchedulerRow(item, row)
      }
    }
  }
  for (const { handle } of candidates) {
    const id = handle.scheduler_job_id
    const item = evidence.get(id)!
    const row = item.row
    if (row && usableRow(row)) {
      if (activeStates.has(row.state)) observations.set(id, { kind: 'active', ...row })
      else
        observations.set(id, {
          kind: 'terminal',
          state: row.state,
          exitCode: row.exitCode,
          stdout: '',
          stderr: '',
          ...(item.diagnostics.length > 0 ? { diagnostic: item.diagnostics.join(' ') } : {})
        })
      continue
    }
    const disabled = accounting?.result !== undefined && accountingDisabled(accounting.result)
    if (item.queueMissing && item.controllerMissing && disabled && !row) {
      observations.set(id, {
        kind: 'unavailable',
        diagnostic: `Unable to obtain the final status of Slurm job ${id}: squeue and scontrol report no record, and accounting is unavailable (${accounting!.result!.stderr.trim()}). Automatic status checks have ended. The remote process may still be running; inspect the scheduler and output files before deciding what to do next.`
      })
      continue
    }
    const accountingDiagnostic =
      disconnectedDiagnostic ?? accounting?.diagnostic ?? accounting?.result?.stderr.trim()
    observations.set(id, {
      kind: 'unknown',
      ...(row ? { state: row.state } : {}),
      diagnostic: [
        ...item.diagnostics,
        accountingDiagnostic,
        row
          ? `Slurm scheduler state: ${row.state}; a valid exit code is not yet available.`
          : 'slurm_accounting_pending'
      ]
        .filter(Boolean)
        .join(' ')
    })
  }
  return { observations, evidence, disconnectedDiagnostic }
}

const readSlurmTails = async (
  observation: Extract<SlurmObservation, { kind: 'terminal' }>,
  handle: SlurmRemoteHandle,
  connection: ComputeConnectionLease
): Promise<string | undefined> => {
  const diagnostics: string[] = []
  let disconnectedDiagnostic: string | undefined
  for (const [key, path] of [
    ['stdout', handle.stdout_path],
    ['stderr', handle.stderr_path]
  ] as const) {
    const tail = await query(
      connection,
      `tail -c ${TAIL_BYTES} ${quoteRemotePath(path)}`,
      TAIL_BYTES
    )
    if (tail.result?.exitCode === 0) observation[key] = tail.result.stdout
    else
      diagnostics.push(
        tail.diagnostic || tail.result?.stderr.trim() || 'Slurm output tail could not be read.'
      )
    if (tail.disconnected) {
      disconnectedDiagnostic = tail.diagnostic
      break
    }
  }
  if (diagnostics.length > 0)
    observation.diagnostic = [observation.diagnostic, ...diagnostics].filter(Boolean).join(' ')
  return disconnectedDiagnostic
}

export const pollSlurmJobs = async (
  jobs: SlurmEntry[],
  connection: ComputeConnectionLease
): Promise<Map<string, SlurmObservation>> => {
  const queried = await querySlurmJobs(jobs, connection)
  const { observations } = queried
  let disconnectedDiagnostic = queried.disconnectedDiagnostic
  for (const { handle } of jobs) {
    const observation = observations.get(handle.scheduler_job_id)
    if (observation?.kind === 'terminal') {
      if (disconnectedDiagnostic)
        observation.diagnostic = [observation.diagnostic, disconnectedDiagnostic]
          .filter(Boolean)
          .join(' ')
      else disconnectedDiagnostic = await readSlurmTails(observation, handle, connection)
    }
  }
  return observations
}

export const cancelSlurmJob = async (
  handle: SlurmRemoteHandle,
  connection: ComputeConnectionLease
): Promise<SlurmCancellationResult> => {
  const cancel = await query(connection, `scancel ${handle.scheduler_job_id}`, 1024)
  if (!cancel.result) return { kind: 'unconfirmed', message: cancel.diagnostic }
  let rejection: { code: 'cancel_request_rejected'; message: string } | undefined
  if (cancel.result.exitCode !== 0 && !noSuchJob(cancel.result.stderr)) {
    const message = cancel.result.stderr.trim() || 'scancel failed.'
    if (
      /permission|access denied|not authorized|unauthori[sz]ed|not permitted|security violation/i.test(
        message
      )
    )
      rejection = { code: 'cancel_request_rejected', message }
    else return { kind: 'unconfirmed', message }
  }
  const { observations, evidence, disconnectedDiagnostic } = await querySlurmJobs(
    [{ job: { job_id: handle.scheduler_job_id } as ComputeJob, handle }],
    connection
  )
  const observation = observations.get(handle.scheduler_job_id)!
  if (observation.kind === 'terminal') {
    if (observation.state === 'CANCELLED')
      return { kind: 'cancelled', diagnostic: 'Slurm reported CANCELLED.' }
    if (!disconnectedDiagnostic) await readSlurmTails(observation, handle, connection)
    return {
      kind: 'completed',
      state: observation.state,
      exitCode: observation.exitCode,
      stdoutTail: observation.stdout,
      stderrTail: observation.stderr,
      diagnostic: observation.diagnostic
    }
  }
  const item = evidence.get(handle.scheduler_job_id)!
  if (cancel.result.exitCode === 0 && item.queueMissing && item.controllerMissing && !item.row) {
    return {
      kind: 'cancelled',
      diagnostic:
        'Cancellation inferred: scancel succeeded and the job disappeared from both squeue and scontrol; no contrary terminal result was observed.'
    }
  }
  if (observation.kind === 'unavailable')
    return {
      kind: 'unavailable',
      message: observation.diagnostic,
      ...(rejection ? { cancellationError: rejection } : {})
    }
  if (rejection) return { kind: 'rejected', message: rejection.message }
  return {
    kind: 'unconfirmed',
    message:
      observation.kind === 'unknown'
        ? observation.diagnostic
        : `Slurm scheduler state: ${observation.state}.`
  }
}
