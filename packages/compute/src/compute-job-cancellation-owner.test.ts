import { describe, expect, it, vi } from 'vitest'
import { ComputeJobCancellationReaper } from './compute-job-cancellation-owner'

describe('ComputeJobCancellationReaper', () => {
  it('keeps the active retry cadence after scheduling a deferred cancellation', async () => {
    vi.useFakeTimers()
    const claim = { jobId: 'job-1', operation: { attemptCount: 0 } }
    const claimNext = vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null)
    const retry = vi.fn().mockResolvedValue(true)
    const beginAttempt = vi.fn().mockResolvedValue(claim)
    const reaper = new ComputeJobCancellationReaper(
      { claimNext, retry, beginAttempt } as never,
      {
        get: vi.fn().mockResolvedValue({
          job_id: 'job-1',
          provider_id: 'host-1',
          execution_mode: 'direct_ssh'
        })
      } as never,
      { acquire: vi.fn().mockRejectedValue(new Error('offline')) } as never,
      { intervalMs: 100, fallbackIntervalMs: 60_000 }
    )
    try {
      reaper.start()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()
      expect(retry).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(99)
      expect(claimNext).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(claimNext).toHaveBeenCalledTimes(2)
    } finally {
      await reaper.stop()
      vi.useRealTimers()
    }
  })
})
