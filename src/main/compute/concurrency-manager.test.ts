import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
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
    updateIfStatus: vi.fn(),
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
    delete: vi.fn(),
    updateConcurrencyLimit: vi.fn()
  }) as unknown as ComputeHostRepository

const createMockDispatchJob = (): Mock<
  (jobId: string, onJobUpdated: (job: ComputeJob) => void) => Promise<void>
> =>
  vi.fn<(jobId: string, onJobUpdated: (job: ComputeJob) => void) => Promise<void>>(() =>
    Promise.resolve()
  )

describe('ConcurrencyManager', () => {
  let jobRepo: ComputeJobRepository
  let hostRepo: ComputeHostRepository
  let dispatchJob: ReturnType<typeof createMockDispatchJob>
  let onJobUpdated: Mock<(job: ComputeJob) => void>
  let manager: ConcurrencyManager

  beforeEach(() => {
    jobRepo = createMockJobRepo()
    hostRepo = createMockHostRepo()
    dispatchJob = createMockDispatchJob()
    onJobUpdated = vi.fn()
    vi.mocked(jobRepo.updateIfStatus).mockImplementation(
      async (jobId, _expected, updates) =>
        ({
          job_id: jobId,
          status: updates.status ?? 'queued',
          submitted_at: updates.submittedAt?.getTime()
        }) as ComputeJob
    )
    vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([])
    manager = new ConcurrencyManager(jobRepo, hostRepo, dispatchJob, onJobUpdated)
  })

  describe('setSessionLimit', () => {
    it('stores session limit in memory', async () => {
      await manager.setSessionLimit('session-1', 5)
      // Verify via getStatus
      expect(manager['sessionLimits'].get('session-1')).toBe(5)
    })

    it('updates existing session limit', async () => {
      await manager.setSessionLimit('session-1', 3)
      await manager.setSessionLimit('session-1', 7)
      expect(manager['sessionLimits'].get('session-1')).toBe(7)
    })
  })

  describe('setProviderLimit', () => {
    it('serializes a decrease ahead of a concurrent admission', async () => {
      let storedLimit = 2
      let releaseUpdate: (() => void) | undefined
      let updateStarted: (() => void) | undefined
      const updateEntered = new Promise<void>((resolve) => {
        updateStarted = resolve
      })

      vi.mocked(hostRepo.get).mockImplementation(
        async () =>
          ({
            providerId: 'ssh:cluster-a',
            concurrencyLimit: storedLimit
          }) as ComputeHost
      )
      vi.mocked(hostRepo.updateConcurrencyLimit).mockImplementation(async (_providerId, limit) => {
        updateStarted?.()
        await new Promise<void>((resolve) => {
          releaseUpdate = resolve
        })
        storedLimit = limit
      })
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)

      const changingLimit = manager.setProviderLimit('ssh:cluster-a', 1)
      await updateEntered
      const commit = vi.fn().mockResolvedValue(undefined)
      const admitting = manager.admit(
        { sessionId: 'session-1', providerId: 'ssh:cluster-a' },
        commit
      )
      releaseUpdate?.()

      await changingLimit
      await expect(admitting).resolves.toBe('queued')
      expect(commit).toHaveBeenCalledWith('queued')
    })

    it('rejects invalid limits before persistence', async () => {
      await expect(manager.setProviderLimit('ssh:cluster-a', 0)).rejects.toThrow(
        /integer in the range 1\.\.500/
      )
      expect(hostRepo.updateConcurrencyLimit).not.toHaveBeenCalled()
    })

    it('rejects a missing provider before persistence', async () => {
      vi.mocked(hostRepo.get).mockResolvedValue(null)

      await expect(manager.setProviderLimit('ssh:missing', 10)).rejects.toThrow(
        /No compute host found/
      )
      expect(hostRepo.updateConcurrencyLimit).not.toHaveBeenCalled()
    })
  })

  describe('enqueue - global queue limit', () => {
    it('returns queue_full when global queue >= 100', async () => {
      vi.mocked(jobRepo.countQueuedJobs).mockResolvedValue(100)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 1 } as ComputeHost)

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
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 1 } as ComputeHost)

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
      await manager.setSessionLimit('session-1', 2)
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
      await manager.setSessionLimit('session-1', 5)
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
      await manager.setSessionLimit('session-1', 5)
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

    it('drains an owner promotion before pausing and rejects later promotions', async () => {
      let releaseDispatch: (() => void) | undefined
      dispatchJob.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseDispatch = resolve
          })
      )
      const queuedJob = {
        job_id: 'job-1',
        project_id: 'project-1',
        session_id: 'session-1',
        provider_id: 'ssh:cluster-a',
        created_at: 1000,
        status: 'queued'
      } as ComputeJob
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([queuedJob])
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 10 } as ComputeHost)

      const dispatching = manager.onJobCompleted()
      await vi.waitFor(() => expect(dispatchJob).toHaveBeenCalledOnce())
      const pausing = manager.pauseOwner({ projectId: 'project-1', sessionId: 'session-1' })

      releaseDispatch?.()
      await Promise.all([dispatching, pausing])
      vi.mocked(jobRepo.updateIfStatus).mockClear()
      dispatchJob.mockClear()

      await manager.onJobCompleted()

      expect(jobRepo.updateIfStatus).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()

      manager.resumeOwner({ projectId: 'project-1', sessionId: 'session-1' })
      await vi.waitFor(() => expect(jobRepo.updateIfStatus).toHaveBeenCalledOnce())
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
      await manager.onJobCompleted()

      // Should dispatch job-1 first (earlier createdAt)
      expect(dispatchJob).toHaveBeenCalledWith('job-1', expect.any(Function))
    })

    it('re-checks both session limit and provider ceiling', async () => {
      await manager.setSessionLimit('session-1', 2)
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
      await manager.onJobCompleted()

      expect(jobRepo.countActiveBySession).toHaveBeenCalledWith('session-1')
      expect(jobRepo.countActiveByProvider).toHaveBeenCalledWith('ssh:cluster-a')
      expect(dispatchJob).toHaveBeenCalledWith('job-1', expect.any(Function))
    })

    it('skips jobs that still violate session limit', async () => {
      await manager.setSessionLimit('session-1', 2)
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

      expect(jobRepo.updateIfStatus).not.toHaveBeenCalled()
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

      expect(jobRepo.updateIfStatus).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
    })

    it('dispatches multiple jobs if both limits allow', async () => {
      await manager.setSessionLimit('session-1', 10)
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
      await manager.onJobCompleted()

      expect(jobRepo.updateIfStatus).toHaveBeenCalledTimes(2)
      expect(dispatchJob).toHaveBeenCalledTimes(2)
      expect(dispatchJob).toHaveBeenNthCalledWith(1, 'job-1', expect.any(Function))
      expect(dispatchJob).toHaveBeenNthCalledWith(2, 'job-2', expect.any(Function))
    })

    it('does not block another provider behind a slow dispatch', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          project_id: 'project-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob,
        {
          job_id: 'job-2',
          project_id: 'project-2',
          session_id: 'session-2',
          provider_id: 'ssh:cluster-b',
          created_at: 2000,
          status: 'queued'
        } as ComputeJob
      ]
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue(queuedJobs)
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 1 } as ComputeHost)

      let releaseFirstDispatch!: () => void
      dispatchJob.mockImplementation(async (jobId) => {
        if (jobId === 'job-1') {
          await new Promise<void>((resolve) => {
            releaseFirstDispatch = resolve
          })
        }
      })

      const reconciliation = manager.onJobCompleted()
      await vi.waitFor(() =>
        expect(dispatchJob).toHaveBeenCalledWith('job-1', expect.any(Function))
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      const secondStartedBeforeFirstFinished = dispatchJob.mock.calls.some(
        ([jobId]) => jobId === 'job-2'
      )
      releaseFirstDispatch()
      await reconciliation

      expect(secondStartedBeforeFirstFinished).toBe(true)
    })

    it('does not dispatch a queued projection after another writer changes its status', async () => {
      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ])
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 10 } as ComputeHost)
      vi.mocked(jobRepo.updateIfStatus).mockResolvedValue(null)

      await manager.onJobCompleted()

      expect(dispatchJob).not.toHaveBeenCalled()
      expect(onJobUpdated).not.toHaveBeenCalled()
    })
  })

  describe('getStatus', () => {
    it('returns accurate session status', async () => {
      await manager.setSessionLimit('session-1', 5)
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
      await manager.setSessionLimit('session-1', 2)
      await manager.setSessionLimit('session-2', 3)

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
    it('does not overwrite a terminal job when a promoted dispatch fails late', async () => {
      const queuedJob = {
        job_id: 'job-1',
        session_id: 'session-1',
        provider_id: 'ssh:cluster-a',
        created_at: 1000,
        status: 'queued'
      } as ComputeJob
      const submittedJob = { ...queuedJob, status: 'submitted' as const }

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValue([queuedJob])
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 10 } as ComputeHost)
      vi.mocked(jobRepo.updateIfStatus)
        .mockResolvedValueOnce(submittedJob)
        .mockResolvedValueOnce(null)
      vi.mocked(jobRepo.update).mockResolvedValue({
        ...submittedJob,
        status: 'error'
      } as ComputeJob)
      vi.mocked(dispatchJob).mockRejectedValueOnce(new Error('late dispatch failure'))

      await manager.onJobCompleted()

      expect(jobRepo.updateIfStatus).toHaveBeenLastCalledWith(
        'job-1',
        ['submitted'],
        expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
      )
      expect(jobRepo.update).not.toHaveBeenCalled()
      expect(onJobUpdated).toHaveBeenCalledTimes(1)
      expect(onJobUpdated).toHaveBeenCalledWith(submittedJob)
    })

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

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValueOnce(queuedJobs).mockResolvedValue([])
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)
      const failedJob = { ...queuedJobs[0], status: 'error' as const }
      vi.mocked(jobRepo.updateIfStatus)
        .mockResolvedValueOnce({ ...queuedJobs[0], status: 'submitted' })
        .mockResolvedValueOnce(failedJob)

      // Simulate dispatchJob failure
      vi.mocked(dispatchJob).mockRejectedValueOnce(new Error('SSH connection failed'))

      await manager.onJobCompleted()

      // Then mark as error after dispatch fails
      expect(jobRepo.updateIfStatus).toHaveBeenLastCalledWith('job-1', ['submitted'], {
        status: 'error',
        errorCode: 'dispatch_failed',
        finishedAt: expect.any(Date)
      })
      expect(onJobUpdated).toHaveBeenCalledWith(failedJob)
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

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValueOnce(queuedJobs).mockResolvedValue([])
      vi.mocked(jobRepo.countActiveBySession).mockResolvedValue(0)
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(0)
      vi.mocked(hostRepo.get).mockResolvedValue({
        concurrencyLimit: 10
      } as ComputeHost)

      // First job fails, second succeeds
      vi.mocked(dispatchJob)
        .mockRejectedValueOnce(new Error('SSH connection failed'))
        .mockResolvedValueOnce(undefined)

      await manager.onJobCompleted()

      // First job should be marked as error
      expect(jobRepo.updateIfStatus).toHaveBeenCalledWith('job-1', ['submitted'], {
        status: 'error',
        errorCode: 'dispatch_failed',
        finishedAt: expect.any(Date)
      })

      // Second job should still be dispatched
      expect(dispatchJob).toHaveBeenCalledWith('job-2', expect.any(Function))
    })

    it('coalesces concurrent reconciliation without dispatching the same job twice', async () => {
      const queuedJobs: ComputeJob[] = [
        {
          job_id: 'job-1',
          session_id: 'session-1',
          provider_id: 'ssh:cluster-a',
          created_at: 1000,
          status: 'queued'
        } as ComputeJob
      ]

      vi.mocked(jobRepo.findQueuedJobs).mockResolvedValueOnce(queuedJobs).mockResolvedValue([])
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

      // The concurrent request is retained as one follow-up scan, without a second dispatch.
      expect(jobRepo.findQueuedJobs).toHaveBeenCalledTimes(2)
      expect(dispatchStarted).toBe(1)
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
      await manager.setSessionLimit('s1', 2)
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
      vi.mocked(jobRepo.countActiveByProvider).mockResolvedValue(1)
      vi.mocked(hostRepo.get).mockResolvedValue({ concurrencyLimit: 1 } as ComputeHost)
      const commit = vi.fn().mockResolvedValue(undefined)

      const result = await manager.admit({ sessionId: 's1', providerId: 'p1' }, commit)

      expect(result).toBe('queue_full')
      expect(commit).not.toHaveBeenCalled()
    })

    it('serializes concurrent admits so both cannot pass the same slot', async () => {
      // Two concurrent calls see activeByProvider=0 individually, but admit serializes them so
      // the second sees activeByProvider=1 (as committed by the first).
      await manager.setSessionLimit('s1', 10)
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
      vi.mocked(jobRepo.updateIfStatus).mockImplementation(async (jobId, _expected, updates) => {
        if (updates.status === 'submitted') active++
        return {
          job_id: jobId,
          status: updates.status ?? 'queued',
          submitted_at: updates.submittedAt?.getTime()
        } as ComputeJob
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
        .mocked(jobRepo.updateIfStatus)
        .mock.calls.filter(([, , updates]) => updates.status === 'submitted').length
      const admitSubmits = admitResult === 'submitted' ? 1 : 0
      expect(promotionSubmits + admitSubmits).toBe(1)
    })
  })
})
