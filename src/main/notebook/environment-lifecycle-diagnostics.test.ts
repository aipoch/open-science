import { describe, expect, it, vi } from 'vitest'

const loggerSpies = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerSpies.info,
      warn: vi.fn(),
      error: loggerSpies.error
    })
  }
})

import type { ProvisionProgress } from '@aipoch/environment/contracts'
import { runLoggedRuntimeOperation } from './environment-lifecycle-diagnostics'

describe('runLoggedRuntimeOperation', () => {
  it('projects every progress tick while redacting deduplicated diagnostics and preserving the error', async () => {
    const channel = 'https://user:basic-secret@example.com/t/path-secret/conda?token=query-secret'
    const failure = Object.assign(new Error(`micromamba timed out (${channel})`), {
      code: 'MICROMAMBA_TIMEOUT',
      data: { stderrTail: 'api_key=stderr-secret', stdoutTail: 'Bearer stdout-secret' }
    })
    const projected: ProvisionProgress[] = []

    await expect(
      runLoggedRuntimeOperation(
        'provision',
        'python',
        '/runtime',
        async (report) => {
          report({
            phase: 'fetch-python',
            event: { code: 'retrying-short-cache', environment: channel },
            progress: 0.1
          })
          report({
            phase: 'fetch-python',
            event: { code: 'downloading-python-runtime' },
            progress: 0.2
          })
          report({
            phase: 'fetch-python',
            event: { code: 'downloading-python-runtime' },
            progress: 0.2,
            download: {
              phase: 'reconnecting',
              transferred: 20,
              total: 100,
              percent: 20,
              bytesPerSecond: 0,
              attempt: 1
            }
          })
          report({
            phase: 'create-python',
            event: { code: 'environment-create', environment: 'default-python' },
            progress: 0.45
          })
          throw failure
        },
        (progress) => projected.push(progress)
      )
    ).rejects.toBe(failure)

    expect(projected).toHaveLength(5)
    expect(projected.at(-1)).toMatchObject({
      phase: 'error',
      progress: 0,
      language: 'python'
    })
    expect(projected.at(-1)?.diagnostic).not.toContain('basic-secret')
    expect(loggerSpies.info.mock.calls.map(([message]) => message)).toEqual([
      'runtime operation started',
      'runtime operation progress',
      'runtime operation progress',
      'runtime operation progress',
      'runtime operation progress'
    ])
    expect(loggerSpies.error).toHaveBeenCalledOnce()
    const persisted = JSON.stringify({
      info: loggerSpies.info.mock.calls,
      error: loggerSpies.error.mock.calls
    })
    for (const secret of [
      'basic-secret',
      'path-secret',
      'query-secret',
      'stderr-secret',
      'stdout-secret'
    ]) {
      expect(persisted).not.toContain(secret)
    }
    expect(persisted).toContain('[redacted]')
    expect(failure.message).toContain('basic-secret')
  })
})
