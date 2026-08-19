import type { ComputeJob } from '../../shared/compute'

export type ParsedPollObservation = {
  job: ComputeJob
  alive: boolean
  exitCode: number | null
  hasExitCode: boolean
  stdoutTail: string
  stderrTail: string
}

// Parses nonce-prefixed poll SSH stdout into per-job observations. Structural markers carry the
// per-tick nonce so adversarial job tail content cannot collide with them.
export const parsePollOutput = (
  output: string,
  jobs: readonly ComputeJob[],
  nonce: string
): ParsedPollObservation[] => {
  const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sections = output.split(new RegExp(`^${escapedNonce}JOB_START:`, 'm'))
  const parsedResults: ParsedPollObservation[] = []

  for (const section of sections) {
    if (!section.trim()) continue
    const firstNewline = section.indexOf('\n')
    if (firstNewline === -1) continue
    const jobId = section.slice(0, firstNewline).trim()
    const body = section.slice(firstNewline + 1)

    const job = jobs.find((candidate) => candidate.job_id === jobId)
    if (!job) continue

    const aliveMatch = body.match(new RegExp(`^${escapedNonce}alive:([01])`, 'm'))
    const alive = aliveMatch?.[1] === '1'

    const alivePrefix = `${nonce}alive:`
    const lines = body.split('\n')
    let exitCodeRaw = ''
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.startsWith(alivePrefix)) {
        exitCodeRaw = lines[i + 1]?.trim() ?? ''
        break
      }
    }
    const exitCode = exitCodeRaw.trim() === '' ? null : Number.parseInt(exitCodeRaw.trim(), 10)
    const hasExitCode = exitCode !== null && Number.isFinite(exitCode)

    const stdoutEndMarker = `${nonce}STDOUT_END:${jobId}`
    const stderrEndMarker = `${nonce}STDERR_END:${jobId}`
    const stdoutStart = body.indexOf('\n', body.indexOf('\n', body.indexOf('\n') + 1) + 1) + 1
    const stdoutEnd = body.indexOf(stdoutEndMarker)
    const stdoutTail =
      stdoutEnd > stdoutStart ? body.slice(stdoutStart, stdoutEnd).replace(/\n$/, '') : ''

    const stderrStart = body.indexOf('\n', stdoutEnd + stdoutEndMarker.length) + 1
    const stderrEnd = body.indexOf(stderrEndMarker)
    const stderrTail =
      stderrEnd > stderrStart ? body.slice(stderrStart, stderrEnd).replace(/\n$/, '') : ''

    parsedResults.push({ job, alive, exitCode, hasExitCode, stdoutTail, stderrTail })
  }

  return parsedResults
}
