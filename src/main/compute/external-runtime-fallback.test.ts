import { describe, expect, it, vi } from 'vitest'
import { createComputeExecution } from '@aipoch/compute/node'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ComputeConnectionBroker } from './connection-broker'
import type { ComputeHostRepository } from './repository'
import { createComputeJobRuntime } from './job-runtime'

describe('external runtime fallback', () => {
  it('runs one idle fallback pass after the active cadence stops', async () => {
    vi.useFakeTimers()
    const findKubernetesWork = vi.fn(async () => [])
    const findHostedWork = vi.fn(async () => [])
    const findModalWork = vi.fn(async () => [])
    const findRayWork = vi.fn(async () => [])
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          execution: createComputeExecution(),
          bindExternalJobRuntime: vi.fn(() => vi.fn()),
          bindJobHarvestRetry: vi.fn(() => vi.fn()),
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(),
          startQueueReconciliation: vi.fn(),
          stopQueueReconciliation: vi.fn()
        },
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {
          findKubernetesWork,
          findHostedWork,
          findModalWork,
          findRayWork
        } as unknown as ComputeJobRepository,
        operationRepository: {
          claimNext: vi.fn(async () => null)
        } as unknown as ComputeJobOperationRepository,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot: '/data'
      },
      {
        createPoller: () => ({
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
          pause: vi.fn(async () => undefined),
          resume: vi.fn()
        })
      }
    )
    try {
      await runtime.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(findKubernetesWork).toHaveBeenCalledOnce()
      expect(findHostedWork).toHaveBeenCalledOnce()
      expect(findModalWork).toHaveBeenCalledOnce()
      expect(findRayWork).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(5_001)
      expect(findKubernetesWork).toHaveBeenCalledOnce()
      expect(findHostedWork).toHaveBeenCalledOnce()
      expect(findModalWork).toHaveBeenCalledOnce()
      expect(findRayWork).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(54_999)
      expect(findKubernetesWork).toHaveBeenCalledTimes(2)
      expect(findHostedWork).toHaveBeenCalledTimes(2)
      expect(findModalWork).toHaveBeenCalledTimes(2)
      expect(findRayWork).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.stop()
      vi.useRealTimers()
    }
  })
})
