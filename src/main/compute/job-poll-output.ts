import type { ComputeJob } from '../../shared/compute'

export type ParsedPollObservation = {
  status: 'complete'
  job: ComputeJob
  alive: boolean
  exitCode: number | null
  hasExitCode: boolean
  stdoutTail: string
  stderrTail: string
}

export type IncompletePollObservation = {
  status: 'incomplete'
  job: ComputeJob
  reason: 'job' | 'alive' | 'exit' | 'stdout-end' | 'stderr-end'
}

export type ParsedPollResult = ParsedPollObservation | IncompletePollObservation

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stripProtocolDelimiter = (value: string): string =>
  value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value

// Returns one explicit observation for every expected Job. A missing or malformed structural field
// is retryable protocol incompleteness, never a negative/alive observation or an empty tail.
export const parsePollOutput = (
  output: string,
  jobs: readonly ComputeJob[],
  nonce: string
): ParsedPollResult[] => {
  const escapedNonce = escapeRegExp(nonce)
  const sections = output.split(new RegExp(`^${escapedNonce}JOB_START:`, 'm')).slice(1)
  const bodies = new Map<string, string | null>()

  for (const section of sections) {
    const firstNewline = section.indexOf('\n')
    if (firstNewline === -1) continue
    const jobId = section.slice(0, firstNewline).replace(/\r$/, '').trim()
    bodies.set(jobId, bodies.has(jobId) ? null : section.slice(firstNewline + 1))
  }

  return jobs.map((job): ParsedPollResult => {
    const body = bodies.get(job.job_id)
    if (body == null) return { status: 'incomplete', job, reason: 'job' }

    const alive = new RegExp(`^${escapedNonce}alive:([01])\\r?\\n`).exec(body)
    if (!alive) return { status: 'incomplete', job, reason: 'alive' }

    const afterAlive = body.slice(alive[0].length)
    const exit = new RegExp(`^${escapedNonce}exit:([^\\r\\n]*)\\r?\\n`).exec(afterAlive)
    if (!exit) return { status: 'incomplete', job, reason: 'exit' }
    const exitRaw = exit[1] ?? ''
    let exitCode: number | null = null
    if (exitRaw !== '') {
      if (!/^\d+$/.test(exitRaw)) return { status: 'incomplete', job, reason: 'exit' }
      const parsed = Number(exitRaw)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
        return { status: 'incomplete', job, reason: 'exit' }
      }
      exitCode = parsed
    }

    const streams = afterAlive.slice(exit[0].length)
    const stdoutMarker = new RegExp(
      `^${escapedNonce}STDOUT_END:${escapeRegExp(job.job_id)}\\r?$`,
      'm'
    ).exec(streams)
    if (!stdoutMarker) return { status: 'incomplete', job, reason: 'stdout-end' }
    const stdoutMarkerEnd = stdoutMarker.index + stdoutMarker[0].length
    if (streams[stdoutMarkerEnd] !== '\n') {
      return { status: 'incomplete', job, reason: 'stderr-end' }
    }

    const stderrStart = stdoutMarkerEnd + 1
    const stderrRegion = streams.slice(stderrStart)
    const stderrMarker = new RegExp(
      `^${escapedNonce}STDERR_END:${escapeRegExp(job.job_id)}\\r?$`,
      'm'
    ).exec(stderrRegion)
    if (!stderrMarker) return { status: 'incomplete', job, reason: 'stderr-end' }
    const trailing = stderrRegion.slice(stderrMarker.index + stderrMarker[0].length)
    if (trailing !== '' && trailing !== '\n') {
      return { status: 'incomplete', job, reason: 'stderr-end' }
    }

    return {
      status: 'complete',
      job,
      alive: alive[1] === '1',
      exitCode,
      hasExitCode: exitCode !== null,
      stdoutTail: stripProtocolDelimiter(streams.slice(0, stdoutMarker.index)),
      stderrTail: stripProtocolDelimiter(stderrRegion.slice(0, stderrMarker.index))
    }
  })
}
