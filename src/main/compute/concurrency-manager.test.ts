import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ConcurrencyManager } from './concurrency-manager'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeJob, ComputeHost } from '../../shared/compute'

// Mock repositories for isolated unit tests
const createMockJobRepo = (): ComputeJobRepository =>
  ({
    countActiveByProvider: vi.fn(),
    countActiveBySession: vi.fn(),
    countNonTerminalByProvider: vi.fn(),
    countNonTerminalBySession: vi.fn(),
    countQueuedJobs: vi.fn(),
    findQueuedJobs: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    findNonTerminal: vi.fn(),
    findNonTerminalByProvider: vi.fn(),
    findTerminalUnharvested: vi.fn(),
    hasActiveJobsForProvider: vi.fn(),
    findBySession: vi.fn(),
    findPendingNotifications: vi.fn(),
    markNotificationsConsumed: vi.fn()
  }) as unknown as ComputeJobRepository

const createMockHostRepo = (): ComputeHostRepository =>
  ({
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn()
  }) as unknown as ComputeHostRepository

const createMockDispatchJob = (): ((jobId: string) => Promise<void>) =>
  vi.fn(() => Promise.resolve())

describe('ConcurrencyManager', () => {
  let jobRepo: ComputeJobRepository
  let hostRepo: ComputeHostRepository
  let dispatchJob: ReturnType<typeof createMockDispatchJob>
  let manager: ConcurrencyManager

  beforeEach(() => {
    jobRepo = createMockJobRepo()
    hostRepo = createMockHostRepo()
    dispatchJob = createMockDispatchJob()
    manager = new ConcurrencyManager(jobRepo, hostRepo, dispatchJob)
  })

  describe('setSessionLimit', () => {
    it('stores session limit in memory', () => {
      manager.setSessionLimit('session-1', 5)
      // Verify via getStatus
      expect(manager['sessionLimits'].get('session-1')).toBe(5)
    })

    it('updates existing session limit', () => {
      manager.setSessionLimit('session-1', 3)
      manager.setSessionLimit('session-1', 7)
      expect(manager['sessionLimits'].get('session-1')).toBe(7)
    })
  })

  describe('enqueue - global queue limit', () => {
    it('returns queue_full when global queue >= 100', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(100)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('queue_full')
      expect(jobRepo.countQueuedJobs).toHaveBeenCalledOnce()
    })

    it('returns queue_full when global queue > 100', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(150)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('queue_full')
    })
  })

  describe('enqueue - session limit check', () => {
    it('returns should_queue when session limit reached', async () => {
      manager.setSessionLimit('session-1', 2)
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('should_queue')
      expect(jobRepo.countActiveBySession).toHaveBeenCalledWith('session-1')
    })

    it('returns can_dispatch when under session limit', async () => {
      manager.setSessionLimit('session-1', 5)
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(3)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(2)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('can_dispatch')
    })

    it('allows dispatch when no session limit is set', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(100)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(2)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('can_dispatch')
    })
  })

  describe('enqueue - provider ceiling check', () => {
    it('returns should_queue when provider ceiling reached', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(10)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('should_queue')
      expect(jobRepo.countActiveByProvider).toHaveBeenCalledWith('ssh:cluster-a')
    })

    it('uses default ceiling of 10 when host.concurrencyLimit is null', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(10)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: undefined
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('should_queue')
    })

    it('returns can_dispatch when under provider ceiling', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(5)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 20
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('can_dispatch')
    })
  })

  describe('enqueue - combined limits', () => {
    it('requires both session limit and provider ceiling to be satisfied', async () => {
      manager.setSessionLimit('session-1', 5)
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2) // under session limit
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(10) // at provider ceiling
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      const result = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })

      expect(result).toBe('should_queue')
    })
  })

  describe('onJobCompleted', () => {
    it('triggers tryDispatchNext when a job completes', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tryDispatchNextSpy = vi.spyOn(manager as any, 'tryDispatchNext')
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([])

      await manager.onJobCompleted()

      expect(tryDispatchNextSpy).toHaveBeenCalledOnce()
    })
  })

  describe('tryDispatchNext', () => {
    it('processes queued jobs in FIFO order (createdAt ASC)', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-2',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 2000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      await manager.onJobCompleted()

      // Should dispatch job-1 first (earlier createdAt)
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', { status: 'submitted' })
      expect(dispatchJob).toHaveBeenCalledWith('job-1')
    })

    it('re-checks both session limit and provider ceiling', async () => {
      manager.setSessionLimit('session-1', 2)
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(5)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      await manager.onJobCompleted()

      expect(jobRepo.countActiveBySession).toHaveBeenCalledWith('session-1')
      expect(jobRepo.countActiveByProvider).toHaveBeenCalledWith('ssh:cluster-a')
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', { status: 'submitted' })
      expect(dispatchJob).toHaveBeenCalledWith('job-1')
    })

    it('skips jobs that still violate session limit', async () => {
      manager.setSessionLimit('session-1', 2)
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2) // at limit
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(5)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      await manager.onJobCompleted()

      expect(jobRepo.update).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
    })

    it('skips jobs that still violate provider ceiling', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(10) // at ceiling
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      await manager.onJobCompleted()

      expect(jobRepo.update).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
    })

    it('dispatches multiple jobs if both limits allow', async () => {
      manager.setSessionLimit('session-1', 10)
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-2',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 2000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      await manager.onJobCompleted()

      expect(jobRepo.update).toHaveBeenCalledTimes(2)
      expect(dispatchJob).toHaveBeenCalledTimes(2)
      expect(dispatchJob).toHaveBeenNthCalledWith(1, 'job-1')
      expect(dispatchJob).toHaveBeenNthCalledWith(2, 'job-2')
    })
  })

  describe('getStatus', () => {
    it('returns accurate session status', async () => {
      manager.setSessionLimit('session-1', 5)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(3)
      vi.mocked(jobRepo.findBySession).mockResolvedValue([
        { provider_id: 'ssh:cluster-a', status: 'queued' } as ComputeJob,
        { provider_id: 'ssh:cluster-b', status: 'queued' } as ComputeJob
      ])
      vi.mocked(hostRepo.get)
        .mockResolvedValueOnce({ concurrencyLimit: 10 } as ComputeHost)
        .mockResolvedValueOnce({ concurrencyLimit: 20 } as ComputeHost)

      const status = await manager.getStatus('session-1')

      expect(status.session_limit).toBe(5)
      expect(status.active_count).toBe(3)
      expect(status.queued_count).toBe(2)
      expect(status.provider_ceilings).toEqual({
        'ssh:cluster-a': 10,
        'ssh:cluster-b': 20
      })
    })

    it('returns null session_limit when not set', async () => {
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.findBySession).mockResolvedValue([])

      const status = await manager.getStatus('session-1')

      expect(status.session_limit).toBeNull()
      expect(status.active_count).toBe(0)
      expect(status.queued_count).toBe(0)
    })

    it('uses default ceiling of 10 when host.concurrencyLimit is undefined', async () => {
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)
      vi.mocked(jobRepo.findBySession).mockResolvedValue([
        { provider_id: 'ssh:cluster-a', status: 'running' } as ComputeJob
      ])
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: undefined
      } as ComputeHost)

      const status = await manager.getStatus('session-1')

      expect(status.provider_ceilings).toEqual({
        'ssh:cluster-a': 10
      })
    })
  })

  describe('multi-session scenarios', () => {
    it('enforces session limits independently', async () => {
      manager.setSessionLimit('session-1', 2)
      manager.setSessionLimit('session-2', 3)

      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      // Session 1 at limit
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2)
      const result1 = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })
      expect(result1).toBe('should_queue')

      // Session 2 under limit
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2)
      const result2 = await manager.enqueue({
        jobId: 'job-2',
        sessionId: 'session-2',
        providerId: 'ssh:cluster-a'
      })
      expect(result2).toBe('can_dispatch')
    })
  })

  describe('multi-provider scenarios', () => {
    it('enforces provider ceilings independently', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(1)

      // Cluster A at ceiling
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(10)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      const result1 = await manager.enqueue({
        jobId: 'job-1',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-a'
      })
      expect(result1).toBe('should_queue')

      // Cluster B under ceiling
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(5)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 20
      } as ComputeHost)
      const result2 = await manager.enqueue({
        jobId: 'job-2',
        sessionId: 'session-1',
        providerId: 'ssh:cluster-b'
      })
      expect(result2).toBe('can_dispatch')
    })
  })

  describe('onJobCompleted - dispatch error handling', () => {
    it('marks job as error when dispatchJob throws', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      // Simulate dispatchJob failure
      vi.mocked(dispatchJob).mockRejectedValueOnce(new Error('SSH connection failed'))

      await manager.onJobCompleted()

      // Should mark job as submitted first
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', { status: 'submitted' })
      // Then mark as error after dispatch fails
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', {
        status: 'error',
        errorCode: 'dispatch_failed',
        finishedAt: expect.any(Date)
      })
    })

    it('continues processing next queued job after dispatch failure', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-2',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 2000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      // First job fails, second succeeds
      vi.mocked(dispatchJob)
        .mockRejectedValueOnce(new Error('SSH connection failed'))
        .mockResolvedValueOnce(undefined)

      await manager.onJobCompleted()

      // First job should be marked as error
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', {
        status: 'error',
        errorCode: 'dispatch_failed',
        finishedAt: expect.any(Date)
      })

      // Second job should still be dispatched
      expect(jobRepo.update).toHaveBeenCalledWith('job-2', { status: 'submitted' })
      expect(dispatchJob).toHaveBeenCalledWith('job-2')
    })

    it('prevents concurrent tryDispatchNext execution', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      // Make dispatchJob slow to simulate concurrent calls during dispatch
      let dispatchStarted = 0
      vi.mocked(dispatchJob).mockImplementation(async () => {
        dispatchStarted++
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      // Fire two concurrent onJobCompleted calls
      await Promise.all([manager.onJobCompleted(), manager.onJobCompleted()])

      // findQueuedJobs should only be called once (second call returns early)
      expect(jobRepo.findQueuedJobs).toHaveBeenCalledOnce()
      // dispatchJob should only be called once
      expect(dispatchStarted).toBe(1)
    })
  })

  describe('drainOnStartup', () => {
    it('drainOnStartup dispatches eligible queued jobs', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      vi.mocked(jobRepo.update).mockResolvedValue({} as ComputeJob)

      await manager.drainOnStartup()

      expect(jobRepo.update).toHaveBeenCalledWith('job-1', { status: 'submitted' })
      expect(dispatchJob).toHaveBeenCalledWith('job-1')
    })

    it('drainOnStartup is a no-op when no queued jobs exist', async () => {
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([])

      await manager.drainOnStartup()

      expect(jobRepo.update).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
    })

    it('drains every queued job up to the provider ceiling and leaves the rest queued', async () => {
      // Drain must iterate the WHOLE queue (not stop after one promotion) while still respecting
      // capacity: with a ceiling of 2 and 3 queued jobs, the first two are dispatched and the third
      // stays queued. The active counter mirrors what a real DB read returns after each reservation.
      const providerCeiling = 2
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: providerCeiling
      } as ComputeHost)

      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-2',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 2000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-3',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 3000,
          status: 'queued'
        } as ComputeJob
      ]
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)

      // Active count rises as each job is reserved (status → 'submitted'), mirroring a real DB read.
      let active = 0
      vi.mocked(jobRepo.countActiveBySession).mockImplementation(async () => active)
      vi.mocked(jobRepo.countActiveByProvider).mockImplementation(async () => active)
      vi.mocked(jobRepo.update).mockImplementation(async (_id, u) => {
        if ((u as { status?: string }).status === 'submitted') active++
        return {} as ComputeJob
      })

      await manager.drainOnStartup()

      // job-1 and job-2 won slots; job-3 hit the ceiling and was left queued.
      expect(jobRepo.update).toHaveBeenCalledWith('job-1', { status: 'submitted' })
      expect(jobRepo.update).toHaveBeenCalledWith('job-2', { status: 'submitted' })
      expect(jobRepo.update).not.toHaveBeenCalledWith('job-3', expect.anything())
      expect(dispatchJob).toHaveBeenCalledWith('job-1')
      expect(dispatchJob).toHaveBeenCalledWith('job-2')
      expect(dispatchJob).not.toHaveBeenCalledWith('job-3')
      expect(active).toBe(providerCeiling)
    })
  })

  describe('admit - atomic status decision + row commit', () => {
    it('calls commit with submitted when limits are clear', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 10 } as ComputeHost)
      const commit = vi.fn().mockResolvedValue(undefined)

      const result = await manager.admit({ sessionId: 's1', providerId: 'p1' }, commit)

      expect(result).toBe('submitted')
      expect(commit).toHaveBeenCalledWith('submitted')
    })

    it('calls commit with queued when session limit is reached', async () => {
      manager.setSessionLimit('s1', 2)
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(2)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 10 } as ComputeHost)
      const commit = vi.fn().mockResolvedValue(undefined)

      const result = await manager.admit({ sessionId: 's1', providerId: 'p1' }, commit)

      expect(result).toBe('queued')
      expect(commit).toHaveBeenCalledWith('queued')
    })

    it('returns queue_full and does NOT call commit when global queue is at capacity', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(100)
      const commit = vi.fn().mockResolvedValue(undefined)

      const result = await manager.admit({ sessionId: 's1', providerId: 'p1' }, commit)

      expect(result).toBe('queue_full')
      expect(commit).not.toHaveBeenCalled()
    })

    it('serializes concurrent admits so both cannot pass the same slot', async () => {
      // Two concurrent calls see activeByProvider=0 individually, but admit serializes them so
      // the second sees activeByProvider=1 (as committed by the first).
      manager.setSessionLimit('s1', 10)
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 1 } as ComputeHost)

      // Simulate DB counts that reflect committed rows from the first admit
      let committedCount = 0
      vi.mocked(jobRepo.countActiveBySession).mockImplementation(async () => committedCount)
      vi.mocked(jobRepo.countActiveByProvider).mockImplementation(async () => committedCount)

      const commit = vi.fn().mockImplementation(async () => {
        committedCount++
      })

      const [r1, r2] = await Promise.all([
        manager.admit({ sessionId: 's1', providerId: 'p1' }, commit),
        manager.admit({ sessionId: 's1', providerId: 'p1' }, commit)
      ])

      // First wins the slot, second sees the committed count and queues
      expect([r1, r2].sort()).toEqual(['queued', 'submitted'])
      expect(commit).toHaveBeenCalledTimes(2)
    })

    it('does not overrun a provider ceiling when admit() races queue promotion', async () => {
      // Regression for the P1 race: a new submission (admit) and a queued-job promotion
      // (onJobCompleted → tryDispatchNext) must not both claim the same free slot. With the reserve
      // step of tryDispatchNext sharing admit()'s lock, only one row flips to 'submitted'.
      const providerCeiling = 1
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: providerCeiling
      } as ComputeHost)

      // Both paths read active from the same committed counter; each commit (admit's commit callback
      // or the promotion's status update to 'submitted') increments it.
      let active = 0
      vi.mocked(jobRepo.countActiveBySession).mockImplementation(async () => active)
      vi.mocked(jobRepo.countActiveByProvider).mockImplementation(async () => active)

      // One queued job available for promotion.
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([
        {
          job_id: 'queued-1',
          session_id: 's1',
          provider_id: 'p1',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ])
      // The promotion's reserve commit (status → 'submitted') bumps the active counter.
      vi.mocked(jobRepo.update).mockImplementation(async (_id, u) => {
        if ((u as { status?: string }).status === 'submitted') active++
        return {} as ComputeJob
      })
      vi.mocked(dispatchJob).mockResolvedValue(undefined)

      // admit's commit callback also bumps the active counter when it writes a 'submitted' row.
      const commit = vi.fn().mockImplementation(async (status: string) => {
        if (status === 'submitted') active++
      })

      const [admitResult] = await Promise.all([
        manager.admit({ sessionId: 's1', providerId: 'p1' }, commit),
        manager.onJobCompleted()
      ])

      // Exactly one of the two paths won the single slot; active never exceeded the ceiling.
      expect(active).toBe(providerCeiling)
      const promotionSubmits = vi
        .mocked(jobRepo.update)
        .mock.calls.filter(([, u]) => (u as { status?: string }).status === 'submitted').length
      const admitSubmits = admitResult === 'submitted' ? 1 : 0
      expect(promotionSubmits + admitSubmits).toBe(1)
    })
  })
})
