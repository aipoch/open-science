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
})
