import { describe, expect, it, vi } from 'vitest'

import { completeQuitPersistenceFlush } from './useQuitPersistenceFlush'

describe('completeQuitPersistenceFlush', () => {
  it('drains terminal runtime events before flushing and acknowledging', async () => {
    const calls: string[] = []

    await completeQuitPersistenceFlush(
      { requestId: 'flush-1' },
      {
        drainRuntimeEvents: async () => {
          calls.push('drain')
        },
        flushPersistence: async () => {
          calls.push('flush')
        },
        acknowledge: () => {
          calls.push('acknowledge')
        }
      }
    )

    expect(calls).toEqual(['drain', 'flush', 'acknowledge'])
  })

  it('always acknowledges so a failed renderer flush cannot strand app quit', async () => {
    const acknowledge = vi.fn()

    await expect(
      completeQuitPersistenceFlush(
        { requestId: 'flush-1' },
        {
          drainRuntimeEvents: async () => {
            throw new Error('renderer unavailable')
          },
          flushPersistence: async () => undefined,
          acknowledge
        }
      )
    ).rejects.toThrow('renderer unavailable')
    expect(acknowledge).toHaveBeenCalledWith({ requestId: 'flush-1' })
  })
})
