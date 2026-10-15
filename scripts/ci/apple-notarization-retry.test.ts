import { describe, expect, it, vi } from 'vitest'
import {
  isRetryableAppleFailure,
  runAppleCommand,
  summarizeAppleNetworkLog
} from './apple-notarization-retry.mjs'

const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'
const failed = {
  code: 68,
  stdout: '',
  stderr: `${network}\nThe staple and validate action failed! Error 68.`
}
const success = { code: 0, stdout: 'validated', stderr: '' }

describe('Apple operation retries', () => {
  it('extracts only stapler protocol metrics without exporting headers, bodies or other processes', () => {
    const event = (process: string, eventMessage: string): string =>
      JSON.stringify({
        processImagePath: `/usr/bin/${process}`,
        processID: 42,
        eventMessage
      })
    const summary = summarizeAppleNetworkLog(
      [
        'stream startup banner',
        event(
          'stapler',
          'Task summary {protocol="h2", response_status=200, reused=0, transaction_duration_ms=12.5, Authorization=secret}'
        ),
        event('stapler', 'Request header Authorization: secret; body: private ticket'),
        event('notarytool', 'Task summary {protocol=h3, response_status=200}'),
        event('stapler', 'Task summary {protocol=http/1.1, response_status=0}')
      ].join('\n')
    )
    expect(summary).toEqual([
      { pid: 42, protocol: 'h2', response_status: 200, reused: 0, transaction_duration_ms: 12.5 },
      { pid: 42, protocol: 'http/1.1', response_status: 0 }
    ])
    expect(JSON.stringify(summary)).not.toMatch(/secret|private|h3/)
  })

  it('recognizes observed connection loss but never treats Error 68 alone as transient', () => {
    expect(isRetryableAppleFailure(failed.stderr)).toBe(true)
    expect(isRetryableAppleFailure('The staple and validate action failed! Error 68.')).toBe(false)
  })

  it.each([
    'Could not find ticket',
    'invalid signature',
    'ticket is invalid',
    'revoked',
    'HTTP 401',
    'HTTP status code: 403',
    'invalid credentials',
    'Error Domain=NSURLErrorDomain Code=-1202',
    'Error Domain=NSURLErrorDomain Code=-1001',
    '{"status":"Invalid"}',
    '{"status":"Rejected"}'
  ])('does not retry terminal or unclassified evidence: %s', async (message) => {
    const stderr =
      message.startsWith('Could') || message.includes('-1001') ? message : `${network}\n${message}`
    const run = vi.fn().mockResolvedValue({ ...failed, stderr })
    const delay = vi.fn()
    await expect(
      runAppleCommand(['stapler', 'validate', 'app'], { run, delay, log: vi.fn() })
    ).resolves.toMatchObject({ code: 68 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it.each(['staple', 'validate'])(
    'retries only the failing %s operation and preserves all attempt output',
    async (operation) => {
      const run = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(success)
      const delay = vi.fn()
      const log = vi.fn()
      await expect(
        runAppleCommand(['stapler', operation, '/tmp/App with spaces.app'], { run, delay, log })
      ).resolves.toEqual(success)
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        ['stapler', operation, '/tmp/App with spaces.app'],
        ['stapler', operation, '/tmp/App with spaces.app']
      ])
      expect(delay).toHaveBeenCalledExactlyOnceWith(10_000)
      expect(log).toHaveBeenCalledWith(failed.stderr)
      expect(log).toHaveBeenCalledWith(success.stdout)
    }
  )

  it('exhausts three attempts with bounded backoff and fails closed', async () => {
    const run = vi.fn().mockResolvedValue(failed)
    const delay = vi.fn()
    await expect(
      runAppleCommand(['stapler', 'staple', 'app'], { run, delay, log: vi.fn() })
    ).resolves.toEqual(failed)
    expect(run).toHaveBeenCalledTimes(3)
    expect(delay.mock.calls).toEqual([[10_000], [30_000]])
  })

  it('reuses the submission ID and remaining wait budget after a transport failure', async () => {
    let time = 0
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        time += 60_000
        return failed
      })
      .mockResolvedValueOnce({ ...success, stdout: '{"status":"Accepted"}' })
    const delay = vi.fn(async (ms: number) => {
      time += ms
    })
    await runAppleCommand(['notarytool', 'wait', 'existing-id', '--timeout', '15m'], {
      run,
      delay,
      now: () => time,
      log: vi.fn()
    })
    expect(run.mock.calls).toEqual([
      [['notarytool', 'wait', 'existing-id', '--timeout', '900s'], 900_000],
      [['notarytool', 'wait', 'existing-id', '--timeout', '830s'], 830_000]
    ])
  })

  it('does not restart the deadline or retry killed commands', async () => {
    let time = 0
    const run = vi.fn(async () => {
      time = 899_000
      return failed
    })
    const delay = vi.fn()
    await runAppleCommand(['notarytool', 'wait', 'id'], {
      run,
      delay,
      now: () => time,
      log: vi.fn()
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
    run.mockReset().mockResolvedValue({ ...failed, interrupted: true })
    await runAppleCommand(['stapler', 'staple', 'app'], { run, delay, log: vi.fn() })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['notarytool', 'submit'],
    ['spctl', '--assess'],
    ['codesign', '--verify']
  ])('never retries side-effecting or security gate command %s %s', async (tool, operation) => {
    const run = vi.fn()
    await expect(runAppleCommand([tool, operation], { run })).rejects.toThrow('Unsupported')
    expect(run).not.toHaveBeenCalled()
  })
})
