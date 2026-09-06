import type { ComputeJob } from '../../shared/compute'
import { classifyConnectionFailure, type ComputeConnectionLease } from './connection-broker'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import { toBase64, type SlurmRemoteHandle } from './remote-job-contract'
import { applyComputeEnvironment } from './compute-environment'

const SLURM_TIMEOUT_MS = 120_000
const SLURM_POLL_TIMEOUT_MS = 30_000
const TAIL_BYTES = 65_536
const SUBMISSION_ERROR_FILE = 'scheduler_submit_error'
const SUBMISSION_ERROR_MAX_BYTES = 4096

export type SlurmObservation =
  | { kind: 'active'; state: string; reason?: string }
  | { kind: 'terminal'; state: string; exitCode: number; stdout: string; stderr: string }
  | { kind: 'unknown'; diagnostic: string }

export class SlurmDriverError extends Error {
  constructor(
    readonly code: 'host_unreachable' | 'dispatch_failed' | 'invalid_resources',
    message: string
  ) {
    super(message)
    this.name = 'SlurmDriverError'
  }
}

const jobName = (jobId: string): string => `openscience-${jobId}`

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
  output: 'Remove it; Open Science captures scheduler stdout in the Job result.',
  error: 'Remove it; Open Science captures scheduler stderr in the Job result.',
  chdir: 'Remove it; Open Science submits from the managed Job working directory.',
  'job-name': 'Remove it; Open Science assigns the Job name used for tracking and recovery.',
  array: 'Submit independent Open Science Jobs instead.',
  wrap: 'Put the workload command directly after the #SBATCH header instead.',
  clusters: 'Choose a Compute Host for the intended Slurm cluster instead.',
  'het-group': 'Submit each workload as a separate Open Science Job instead.'
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
        `Slurm directive ${owned.option} is managed by Open Science. ${owned.guidance}`
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
  void workdir
  const timeout = job.timeout_seconds ?? 86_400
  const parsedDirectives = commandDirectives(applyComputeEnvironment(job.command, job.environment))
  return [
    '#!/usr/bin/env bash',
    `#SBATCH --job-name=${jobName(job.job_id)}`,
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
      result.truncated ||
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
        `SLURM_JOB_ID=$(sbatch --parsable --job-name=${jobName(job.job_id)} --output=stdout --error=stderr --chdir="$PWD" job.sbatch 2>${SUBMISSION_ERROR_FILE}.stderr.tmp)`,
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
      'Slurm submission may have succeeded, but its job id was not confirmed. Open Science will look up candidates and recover only a job whose recorded workdir proves ownership; it will not submit a duplicate.'
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
  const name = jobName(job.job_id)
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

export const pollSlurmJobs = async (
  jobs: Array<{ job: ComputeJob; handle: SlurmRemoteHandle }>,
  connection: ComputeConnectionLease
): Promise<Map<string, SlurmObservation>> => {
  const observations = new Map<string, SlurmObservation>()
  if (jobs.length === 0) return observations
  const ids = jobs.map(({ handle }) => handle.scheduler_job_id).join(',')
  const queue = await connection.run(
    `squeue --noheader --states=all -j ${ids} --format='%i|%T|%r'`,
    {
      timeoutMs: SLURM_POLL_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: jobs.length * 1024
    }
  )
  const queueFailure = classifyConnectionFailure(queue, false)
  if (queueFailure) throw queueFailure
  const queued = new Map<string, { state: string; reason?: string }>()
  if (queue.exitCode === 0 || /invalid job id|no jobs? in the system/i.test(queue.stderr)) {
    for (const line of queue.stdout.split(/\r?\n/)) {
      const [id, state, reason] = line.trim().split('|')
      if (id && state) queued.set(id, { state: normalizeState(state), reason: reason || undefined })
    }
  } else {
    throw new Error(queue.stderr || 'squeue failed.')
  }
  const terminalCandidates = jobs.filter(({ handle }) => {
    const row = queued.get(handle.scheduler_job_id)
    if (row && !isTerminalSlurmState(row.state)) {
      observations.set(handle.scheduler_job_id, {
        kind: 'active',
        state: row.state,
        reason: row.reason
      })
      return false
    }
    return true
  })
  if (terminalCandidates.length === 0) return observations
  const terminalIds = terminalCandidates.map(({ handle }) => handle.scheduler_job_id).join(',')
  const accounting = await connection.run(
    `sacct --parsable2 --noheader -j ${terminalIds} --format=JobIDRaw,State,ExitCode`,
    {
      timeoutMs: SLURM_POLL_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: terminalCandidates.length * 2048
    }
  )
  const accountingFailure = classifyConnectionFailure(accounting, false)
  if (accountingFailure) throw accountingFailure
  if (accounting.exitCode !== 0) {
    throw new Error(
      accounting.stderr.trim() || `sacct exited ${accounting.exitCode ?? 'without a code'}`
    )
  }
  const rows = new Map<string, { state: string; exitCode: number }>()
  for (const line of accounting.stdout.split(/\r?\n/)) {
    const [id, rawState, rawExit] = line.trim().split('|')
    if (!id || id.includes('.') || !rawState || rows.has(id)) continue
    const [codeText = '', signalText = ''] = (rawExit ?? '').split(':')
    const code = Number.parseInt(codeText, 10)
    const signal = Number.parseInt(signalText, 10)
    const exitCode = Number.isFinite(signal) && signal > 0 ? 128 + signal : code
    rows.set(id, {
      state: normalizeState(rawState),
      exitCode: Number.isFinite(exitCode) ? exitCode : 1
    })
  }
  for (const { handle } of terminalCandidates) {
    const row = rows.get(handle.scheduler_job_id)
    if (!row) {
      observations.set(handle.scheduler_job_id, {
        kind: 'unknown',
        diagnostic: 'slurm_accounting_pending'
      })
      continue
    }
    if (!isTerminalSlurmState(row.state)) {
      observations.set(handle.scheduler_job_id, { kind: 'active', state: row.state })
      continue
    }
    const readTail = async (path: string): Promise<string> => {
      const result = await connection.run(
        `tail -c ${TAIL_BYTES} ${quoteRemotePath(path)} 2>/dev/null || true`,
        { timeoutMs: SLURM_POLL_TIMEOUT_MS, loginShell: false, maxOutputBytes: TAIL_BYTES }
      )
      const failure = classifyConnectionFailure(result, false)
      if (failure) throw failure
      if (result.exitCode !== 0 || result.truncated) {
        throw new Error(
          result.truncated
            ? 'Slurm output tail exceeded the polling protocol limit.'
            : result.stderr.trim() || 'Slurm output tail could not be read.'
        )
      }
      return result.stdout
    }
    const stdout = await readTail(handle.stdout_path)
    const stderr = await readTail(handle.stderr_path)
    observations.set(handle.scheduler_job_id, {
      kind: 'terminal',
      state: row.state,
      exitCode: row.exitCode,
      stdout,
      stderr
    })
  }
  return observations
}

export const cancelSlurmJob = async (
  handle: SlurmRemoteHandle,
  connection: ComputeConnectionLease
): Promise<boolean> => {
  const cancel = await connection.run(`scancel ${handle.scheduler_job_id}`, {
    timeoutMs: SLURM_POLL_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: 1024
  })
  const failure = classifyConnectionFailure(cancel, false)
  if (failure) throw failure
  if (cancel.exitCode !== 0 && !/invalid job id/i.test(cancel.stderr)) return false

  // scancel exit 0 acknowledges the request; it does not prove that the allocation stopped.
  const queue = await connection.run(
    `squeue --noheader --states=all -j ${handle.scheduler_job_id} --format='%T'`,
    { timeoutMs: SLURM_POLL_TIMEOUT_MS, loginShell: false, maxOutputBytes: 1024 }
  )
  const queueFailure = classifyConnectionFailure(queue, false)
  if (queueFailure) throw queueFailure
  const queueStates = queue.stdout.split(/\r?\n/).map(normalizeState).filter(Boolean)
  if (queueStates.length > 0) return queueStates.every(isTerminalSlurmState)

  const accounting = await connection.run(
    `sacct --parsable2 --noheader -j ${handle.scheduler_job_id} --format=JobIDRaw,State`,
    { timeoutMs: SLURM_POLL_TIMEOUT_MS, loginShell: false, maxOutputBytes: 2048 }
  )
  const accountingFailure = classifyConnectionFailure(accounting, false)
  if (accountingFailure) throw accountingFailure
  if (accounting.exitCode !== 0) return false
  const parent = accounting.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split('|'))
    .find(([id]) => id === handle.scheduler_job_id)
  return parent?.[1] !== undefined && isTerminalSlurmState(parent[1])
}
