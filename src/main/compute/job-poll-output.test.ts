import { describe, expect, it } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import { parsePollOutput } from './job-poll-output'

const nonce = 'NONCE_'
const job = { job_id: 'job-1', status: 'running' } as ComputeJob
const protocol = (exit = '', stdout = 'first line\nsecond line'): string =>
  [
    `${nonce}JOB_START:job-1`,
    `${nonce}alive:1`,
    `${nonce}exit:${exit}`,
    stdout,
    `${nonce}STDOUT_END:job-1`,
    'stderr',
    `${nonce}STDERR_END:job-1`
  ].join('\n')

describe('parsePollOutput', () => {
  it('preserves stdout from its first line', () => {
    expect(parsePollOutput(protocol('0'), [job], nonce)).toEqual([
      expect.objectContaining({
        status: 'complete',
        exitCode: 0,
        stdoutTail: 'first line\nsecond line',
        stderrTail: 'stderr'
      })
    ])
  })

  it.each([
    ['job', ''],
    ['alive', protocol().replace(`${nonce}alive:1\n`, '')],
    ['exit', protocol().replace(`${nonce}exit:\n`, '')],
    ['stdout-end', protocol().replace(`${nonce}STDOUT_END:job-1\n`, '')],
    ['stderr-end', protocol().replace(`${nonce}STDERR_END:job-1`, '')]
  ])('returns incomplete when the %s marker is missing', (_marker, output) => {
    expect(parsePollOutput(output, [job], nonce)).toEqual([
      expect.objectContaining({ status: 'incomplete', job })
    ])
  })

  it.each(['-1', '256', '1x', '9007199254740992'])(
    'rejects an invalid shell exit status: %s',
    (exitCode) => {
      expect(parsePollOutput(protocol(exitCode), [job], nonce)).toEqual([
        expect.objectContaining({ status: 'incomplete', job, reason: 'exit' })
      ])
    }
  )
})
