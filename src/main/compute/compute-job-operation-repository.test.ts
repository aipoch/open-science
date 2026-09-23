import { describe, expect, it, vi } from 'vitest'

import { ComputeJobOperationRepository } from './compute-job-operation-repository'

describe('Compute Job operation repository', () => {
  it('retries once when an interactive transaction expires before commit', async () => {
    const transaction = {
      computeJobOperation: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    }
    const transactionCalls: unknown[] = []
    const client = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => {
        transactionCalls.push(callback)
        if (transactionCalls.length === 1) throw { code: 'P2028' }
        return callback(transaction)
      }),
      computeJobOperation: {}
    }
    const repository = new ComputeJobOperationRepository(() => Promise.resolve(client as never))

    await expect(
      repository.claimNext(
        'cancel',
        new Date('2026-01-01T00:00:00.000Z'),
        30_000,
        'retry-transaction'
      )
    ).resolves.toBeNull()
    expect(client.$transaction).toHaveBeenCalledTimes(2)
  })

  it('refreshes the claim lease timestamp when retrying an expired transaction', async () => {
    vi.useFakeTimers()
    try {
      const initialNow = new Date('2026-01-01T00:00:00.000Z')
      const retryNow = new Date('2026-01-01T00:01:00.000Z')
      const expectedLease = new Date(retryNow.getTime() + 30_000)
      vi.setSystemTime(initialNow)
      const candidate = {
        id: 'operation-1',
        jobId: 'job-1',
        revision: 3,
        createdAt: initialNow
      }
      const updateMany = vi.fn().mockResolvedValue({ count: 1 })
      const transaction = {
        computeJobOperation: {
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(candidate),
          updateMany,
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...candidate,
            kind: 'cancel',
            phase: 'active',
            outcome: null,
            attemptCount: 4,
            eligibleAt: null,
            claimToken: 'retry-transaction',
            claimExpiresAt: expectedLease,
            settledAt: null,
            updatedAt: retryNow
          })
        }
      }
      let transactionCalls = 0
      const client = {
        $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => {
          transactionCalls += 1
          if (transactionCalls === 1) throw { code: 'P2028' }
          vi.setSystemTime(retryNow)
          return callback(transaction)
        }),
        computeJobOperation: {}
      }
      const repository = new ComputeJobOperationRepository(() => Promise.resolve(client as never))

      await expect(
        repository.claimNext('cancel', initialNow, 30_000, 'retry-transaction')
      ).resolves.toMatchObject({ operation: { claimExpiresAt: expectedLease } })
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ claimExpiresAt: expectedLease })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
