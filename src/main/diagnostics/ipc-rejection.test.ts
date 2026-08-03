import { describe, expect, it, vi } from 'vitest'

import { createWebCallerContext } from '../caller-context'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'

describe('invokeWithIpcRejectionDiagnostics', () => {
  it('records only allowlisted caller metadata for a rejection and rethrows the same value', async () => {
    const warn = vi.fn()
    const secretError = Object.assign(new Error('secret provider failure'), {
      code: 'EACCES',
      data: { token: 'secret-token' }
    })
    const invoke = vi.fn(async (_payload: unknown) => {
      void _payload
      throw secretError
    })
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(34)

    const rejected = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('secret-client-id', {
        location: 'remote',
        principalKind: 'automation',
        actionOrigin: 'agent-session'
      }),
      invoke: () => invoke({ path: '/private/research.txt', token: 'secret-token' }),
      log: { warn },
      now
    })

    await expect(rejected).rejects.toBe(secretError)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('ipc handler rejected', {
      channel: 'projects:list',
      surface: 'web',
      location: 'remote',
      principalKind: 'automation',
      actionOrigin: 'agent-session',
      durationMs: 24,
      errorCategory: 'permission'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-client-id')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/research.txt')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret provider failure')
  })

  it('preserves successful synchronous values without writing diagnostics', () => {
    const warn = vi.fn()
    const result = { secretResult: true }

    expect(
      invokeWithIpcRejectionDiagnostics({
        channel: 'projects:list',
        callerContext: createWebCallerContext('client-a'),
        invoke: () => result,
        log: { warn }
      })
    ).toBe(result)
    expect(warn).not.toHaveBeenCalled()
  })

  it('records rejected custom thenables without changing the rejection value', async () => {
    const warn = vi.fn()
    const rejection = new Error('private thenable failure')
    const thenable = {
      then: (_onFulfilled: unknown, onRejected: (reason: unknown) => unknown): void => {
        onRejected(rejection)
      }
    }

    const result = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('client-a'),
      invoke: () => thenable,
      log: { warn }
    })

    await expect(Promise.resolve(result)).rejects.toBe(rejection)
    expect(warn).toHaveBeenCalledWith(
      'ipc handler rejected',
      expect.objectContaining({ channel: 'projects:list', errorCategory: 'error' })
    )
  })

  it('reads a side-effectful then getter once and preserves its original rejection', async () => {
    const warn = vi.fn()
    const rejection = new Error('original private rejection')
    const replacement = new Error('second getter must not win')
    let reads = 0
    const thenable = Object.defineProperty({}, 'then', {
      get: () => {
        reads += 1
        if (reads > 1) throw replacement
        return (_resolve: unknown, reject: (reason: unknown) => void): void => reject(rejection)
      }
    })

    const result = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('client-a'),
      invoke: () => thenable,
      log: { warn }
    })

    await expect(Promise.resolve(result)).rejects.toBe(rejection)
    expect(reads).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('does not let diagnostic sink or clock failures change a synchronous rejection', () => {
    const rejection = new TypeError('private detail')

    expect(() =>
      invokeWithIpcRejectionDiagnostics({
        channel: 'projects:list',
        callerContext: createWebCallerContext('client-a'),
        invoke: () => {
          throw rejection
        },
        log: {
          warn: () => {
            throw new Error('sink unavailable')
          }
        },
        now: () => {
          throw new Error('clock unavailable')
        }
      })
    ).toThrow(rejection)
  })
})
