// Integration tests for ConcurrencyManager + ComputeService (issue 03).
// Tests the full submit→queue→auto-dispatch flow with real repositories and mocked SSH.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { ComputeService } from './compute-service'
import { ConcurrencyManager } from './concurrency-manager'
import { ComputeApprovalBroker } from './compute-approval-broker'
import type { SshRunner } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { computeProviderId, type ComputeJob } from '../../shared/compute'
import { createComputeJobRuntime } from './job-runtime'
import type { ComputeConnectionBroker, ComputeConnectionBrokerAcquirer } from './connection-broker'
import { JobPoller } from './job-poller'
import { DispatchTracker } from './dispatch-tracker'

// Mock the job-dispatcher module to prevent real SSH dispatches
vi.mock('./job-dispatcher', async () => {
  const actual = await vi.importActual('./job-dispatcher')
  return {
    ...actual,
    dispatchJob: vi.fn(() => Promise.resolve())
  }
})

// Fake SSH runner that always succeeds (no actual SSH connections).
const makeFakeRunner = (): SshRunner => ({
  run: vi.fn(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: 'pid=12345',
      stderr: '',
      timedOut: false,
      truncated: false
    })
  )
})

// Fake SCP runner that always succeeds.
const makeFakeScp = (): ScpRunner => ({
  copy: vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
})

// Fake approval broker that auto-approves all requests.
const makeFakeBroker = (): ComputeApprovalBroker =>
  ({
    request: vi.fn(() => Promise.resolve('once')),
    requestWithContext: vi.fn(() => Promise.resolve('once')),
    respond: vi.fn()
  }) as unknown as ComputeApprovalBroker

describe('ConcurrencyManager integration with ComputeService', () => {
  let storageRoot: string
  let disconnect: () => Promise<void>
  let hostRepo: ComputeHostRepository
  let jobRepo: ComputeJobRepository
  let service: ComputeService
  let concurrencyManager: ConcurrencyManager
  let onJobUpdatedSpy: Mock<(job: ComputeJob) => void>

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'concurrency-int-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    jobRepo = new ComputeJobRepository(() => Promise.resolve(client))

    // Create test host
    await hostRepo.create({
      sshAlias: 'test-host',
      displayName: 'Test Host'
    })

    // Mock dispatch function for ConcurrencyManager
    const mockDispatch = vi.fn(async () => undefined)

    onJobUpdatedSpy = vi.fn()
    concurrencyManager = new ConcurrencyManager(jobRepo, hostRepo, mockDispatch, onJobUpdatedSpy)

    service = new ComputeService({
      runner: makeFakeRunner(),
      repository: hostRepo,
      approvalBroker: makeFakeBroker(),
      scpRunner: makeFakeScp(),
      jobRepository: jobRepo,
      storageRoot,
      concurrencyManager
    })
  })

  afterEach(async () => {
    await disconnect()
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('should submit job with status=submitted when under session limit', async () => {
    const providerId = computeProviderId('test-host')

    // Set session limit to 2
    await service.setSessionConcurrencyLimit('session-1', 2)

    const result = await service.submitJob(
      providerId,
      'test job',
      'echo hello',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result.status).toBe('submitted')

    const job = await jobRepo.get(result.job_id)
    expect(job?.status).toBe('submitted')
  })

  it('reconciles persisted queued jobs when the Compute Job runtime cold-starts', async () => {
    const providerId = computeProviderId('test-host')
    await jobRepo.create({
      allowUnencryptedPersistence: true,
      id: 'persisted-queued-job',
      providerId,
      shape: 'direct_ssh',
      sessionId: 'session-cold-start',
      projectId: 'project-1',
      intent: 'resume persisted queue',
      command: 'echo resumed',
      commandHash: 'hash',
      timeoutSeconds: 60,
      remoteWorkdir: '~/.openscience/jobs/persisted-queued-job',
      initialStatus: 'queued'
    })
    const poller = {
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(async () => undefined),
      resume: vi.fn()
    }
    const runtime = createComputeJobRuntime(
      {
        computeService: service,
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot
      },
      { createPoller: () => poller }
    )

    runtime.start()

    await vi.waitFor(async () => {
      expect((await jobRepo.get('persisted-queued-job'))?.status).toBe('submitted')
    })
    expect(poller.start).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('does not promote or launch queued work after runtime stop begins', async () => {
    const providerId = computeProviderId('test-host')
    await jobRepo.create({
      allowUnencryptedPersistence: true,
      id: 'queued-during-runtime-stop',
      providerId,
      shape: 'direct_ssh',
      sessionId: 'session-runtime-stop',
      projectId: 'project-1',
      intent: 'remain queued after stop',
      command: 'echo stopped',
      commandHash: 'hash-stop',
      timeoutSeconds: 60,
      remoteWorkdir: '~/.openscience/jobs/queued-during-runtime-stop',
      initialStatus: 'queued'
    })
    let releaseStartupScan: (() => void) | undefined
    const startupScanBlocked = new Promise<void>((resolve) => {
      releaseStartupScan = resolve
    })
    let markStartupScanStarted: (() => void) | undefined
    const startupScanStarted = new Promise<void>((resolve) => {
      markStartupScanStarted = resolve
    })
    const findQueuedJobs = jobRepo.findQueuedJobs.bind(jobRepo)
    jobRepo.findQueuedJobs = async () => {
      markStartupScanStarted?.()
      await startupScanBlocked
      return findQueuedJobs()
    }
    const dispatchQueuedJob = vi.fn(async () => undefined)
    const manager = new ConcurrencyManager(jobRepo, hostRepo, dispatchQueuedJob)
    const runtimeService = new ComputeService({
      runner: makeFakeRunner(),
      repository: hostRepo,
      approvalBroker: makeFakeBroker(),
      scpRunner: makeFakeScp(),
      jobRepository: jobRepo,
      storageRoot,
      concurrencyManager: manager
    })
    const poller = {
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(async () => undefined),
      resume: vi.fn()
    }
    const runtime = createComputeJobRuntime(
      {
        computeService: runtimeService,
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot
      },
      { createPoller: () => poller }
    )

    runtime.start()
    await startupScanStarted
    const stopping = runtime.stop()
    releaseStartupScan?.()
    await stopping

    expect((await jobRepo.get('queued-during-runtime-stop'))?.status).toBe('queued')
    expect(dispatchQueuedJob).not.toHaveBeenCalled()
  })

  it('holds dispatch handoff ownership while a queued promotion becomes poller-visible', async () => {
    const providerId = computeProviderId('test-host')
    await jobRepo.create({
      allowUnencryptedPersistence: true,
      id: 'queued-handoff-job',
      providerId,
      shape: 'direct_ssh',
      sessionId: 'session-handoff',
      projectId: 'project-1',
      intent: 'handoff race',
      command: 'echo handoff',
      commandHash: 'hash',
      timeoutSeconds: 60,
      remoteWorkdir: '~/.openscience/jobs/queued-handoff-job',
      initialStatus: 'queued'
    })
    const acquire = vi.fn()
    const dispatchTracker = new DispatchTracker()
    const poller = new JobPoller({
      connectionBroker: { acquire } as unknown as ComputeConnectionBrokerAcquirer,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      dispatchTracker
    })
    const updateIfStatus = jobRepo.updateIfStatus.bind(jobRepo)
    jobRepo.updateIfStatus = async (...args) => {
      const updated = await updateIfStatus(...args)
      if (args[2].status === 'submitted') await poller.tick()
      return updated
    }
    const manager = new ConcurrencyManager(
      jobRepo,
      hostRepo,
      async () => undefined,
      undefined,
      undefined,
      dispatchTracker
    )

    await manager.onJobCompleted()

    expect((await jobRepo.get('queued-handoff-job'))?.status).toBe('submitted')
    expect(acquire).not.toHaveBeenCalled()
    expect(dispatchTracker.has('queued-handoff-job')).toBe(false)
  })

  it('starts independent eligible queued work without waiting for older staging', async () => {
    const firstProviderId = computeProviderId('test-host')
    const secondHost = await hostRepo.create({
      sshAlias: 'second-host',
      displayName: 'Second Host'
    })
    for (const [jobId, providerId, sessionId] of [
      ['queued-slow-staging', firstProviderId, 'session-slow'],
      ['queued-independent', secondHost.providerId, 'session-independent']
    ] as const) {
      await jobRepo.create({
        allowUnencryptedPersistence: true,
        id: jobId,
        providerId,
        shape: 'direct_ssh',
        sessionId,
        projectId: 'project-1',
        intent: 'independent staging',
        command: 'echo queued',
        commandHash: `${jobId}-hash`,
        timeoutSeconds: 60,
        remoteWorkdir: `~/.openscience/jobs/${jobId}`,
        initialStatus: 'queued'
      })
    }
    let releaseSlowStaging: (() => void) | undefined
    const slowStaging = new Promise<void>((resolve) => {
      releaseSlowStaging = resolve
    })
    const started: string[] = []
    const manager = new ConcurrencyManager(jobRepo, hostRepo, async (jobId) => {
      started.push(jobId)
      if (jobId === 'queued-slow-staging') await slowStaging
    })

    const reconciling = manager.onJobCompleted()
    try {
      await vi.waitFor(
        () => expect(started).toEqual(['queued-slow-staging', 'queued-independent']),
        { timeout: 5_000 }
      )
    } finally {
      releaseSlowStaging?.()
    }
    await reconciling

    expect((await jobRepo.get('queued-slow-staging'))?.status).toBe('submitted')
    expect((await jobRepo.get('queued-independent'))?.status).toBe('submitted')
  })

  it('should submit job with status=queued when session limit reached', async () => {
    const providerId = computeProviderId('test-host')

    // Set session limit to 1
    await service.setSessionConcurrencyLimit('session-1', 1)

    // Submit first job (should be submitted)
    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    expect(result1.status).toBe('submitted')

    // Submit second job (should be queued)
    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    expect(result2.status).toBe('queued')

    const job2 = await jobRepo.get(result2.job_id)
    expect(job2?.status).toBe('queued')
  })

  it('should submit job with status=queued when provider ceiling reached', async () => {
    const providerId = computeProviderId('test-host')

    // Set provider ceiling to 1
    await hostRepo.updateConcurrencyLimit(providerId, 1)

    // Submit first job (should be submitted)
    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    expect(result1.status).toBe('submitted')

    // Submit second job from different session (should be queued due to provider ceiling)
    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-2', projectId: 'project-1' }
    )
    expect(result2.status).toBe('queued')

    const job2 = await jobRepo.get(result2.job_id)
    expect(job2?.status).toBe('queued')
  })

  it('promotes queued work when the provider ceiling is raised', async () => {
    const providerId = computeProviderId('test-host')
    await service.setConcurrencyLimit(providerId, 1)

    await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    const queued = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-2', projectId: 'project-1' }
    )
    expect(queued.status).toBe('queued')

    await service.setConcurrencyLimit(providerId, 2)

    await vi.waitFor(async () => {
      expect((await jobRepo.get(queued.job_id))?.status).toBe('submitted')
    })
  })

  it('promotes queued work when the session limit is raised', async () => {
    const providerId = computeProviderId('test-host')
    await service.setSessionConcurrencyLimit('session-1', 1)

    await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    const queued = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    expect(queued.status).toBe('queued')

    await service.setSessionConcurrencyLimit('session-1', 2)

    await vi.waitFor(async () => {
      expect((await jobRepo.get(queued.job_id))?.status).toBe('submitted')
    })
  })

  it('should throw queue_full error when 100 jobs are already queued', async () => {
    const providerId = computeProviderId('test-host')

    // Keep one active job in the provider's only slot so all future jobs queue.
    await hostRepo.updateConcurrencyLimit(providerId, 1)

    // Submit first job (will be submitted)
    await service.submitJob(
      providerId,
      'active job',
      'echo test',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    // Queue 100 jobs
    for (let i = 0; i < 100; i++) {
      await service.submitJob(
        providerId,
        `job ${i}`,
        'echo test',
        {},
        { sessionId: 'session-1', projectId: 'project-1' }
      )
    }

    // 101st job should throw queue_full error
    await expect(
      service.submitJob(
        providerId,
        'job 101',
        'echo test',
        {},
        { sessionId: 'session-1', projectId: 'project-1' }
      )
    ).rejects.toThrow(/queue is full/)
  })

  it('dispatches immediately when the queue is full but an active slot is available', async () => {
    const providerId = computeProviderId('test-host')
    for (let index = 0; index < 100; index++) {
      await jobRepo.create({
        allowUnencryptedPersistence: true,
        id: `full-queue-${index}`,
        providerId,
        shape: 'direct_ssh',
        sessionId: 'blocked-session',
        projectId: 'project-1',
        intent: 'fill queue',
        command: 'echo queued',
        commandHash: `hash-${index}`,
        timeoutSeconds: 60,
        remoteWorkdir: `~/.openscience/jobs/full-queue-${index}`,
        initialStatus: 'queued'
      })
    }

    const result = await service.submitJob(
      providerId,
      'use free active slot',
      'echo immediate',
      {},
      { sessionId: 'eligible-session', projectId: 'project-1' }
    )

    expect(result.status).toBe('submitted')
  })

  it('should auto-dispatch queued job when completed job frees a slot', async () => {
    const providerId = computeProviderId('test-host')

    // Set session limit to 1
    await service.setSessionConcurrencyLimit('session-1', 1)

    // Submit first job (submitted)
    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    // Submit second job (queued)
    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result2.status).toBe('queued')

    // Complete first job
    await jobRepo.update(result1.job_id, {
      status: 'success',
      finishedAt: new Date(),
      exitCode: 0
    })

    // Route the poller-observed update through the same authoritative sink used by dispatch.
    const job1 = await jobRepo.get(result1.job_id)
    service.handleJobUpdated(job1!)

    // Wait for async dispatch to complete
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(onJobUpdatedSpy).toHaveBeenCalledWith(job1)
    // Second job should now be submitted
    const job2Updated = await jobRepo.get(result2.job_id)
    expect(job2Updated?.status).toBe('submitted')
    expect(job2Updated?.submitted_at).toBeGreaterThan(0)
    expect(onJobUpdatedSpy).toHaveBeenCalledWith(job2Updated)
  })

  it('should dispatch queued jobs in FIFO order', async () => {
    const providerId = computeProviderId('test-host')

    // Set session limit to 1
    await service.setSessionConcurrencyLimit('session-1', 1)

    // Submit first job (submitted)
    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result1.status).toBe('submitted')

    // Small delay to ensure createdAt timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Submit second job (should be queued)
    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Submit third job (should be queued)
    const result3 = await service.submitJob(
      providerId,
      'job 3',
      'echo three',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result2.status).toBe('queued')
    expect(result3.status).toBe('queued')

    // Complete first job
    await jobRepo.update(result1.job_id, {
      status: 'success',
      finishedAt: new Date()
    })

    const job1 = await jobRepo.get(result1.job_id)
    service.handleJobUpdated(job1!)

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Job 2 (earliest queued) should be dispatched first
    const job2 = await jobRepo.get(result2.job_id)
    expect(job2?.status).toBe('submitted')

    // Job 3 should still be queued
    const job3 = await jobRepo.get(result3.job_id)
    expect(job3?.status).toBe('queued')
  })

  it('should return session status with correct counts', async () => {
    const providerId = computeProviderId('test-host')

    await service.setSessionConcurrencyLimit('session-1', 2)

    // Submit 2 jobs (should be submitted)
    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result1.status).toBe('submitted')
    expect(result2.status).toBe('submitted')

    // Submit 3rd job (should be queued)
    const result3 = await service.submitJob(
      providerId,
      'job 3',
      'echo three',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result3.status).toBe('queued')

    const status = await service.getSessionConcurrencyStatus('session-1')

    expect(status.session_limit).toBe(2)
    expect(status.active_count).toBe(2)
    expect(status.queued_count).toBe(1)
    expect(status.provider_ceilings[providerId]).toBe(10) // default ceiling
  })

  it('should not dispatch queued job if status is not terminal', async () => {
    const providerId = computeProviderId('test-host')

    await service.setSessionConcurrencyLimit('session-1', 1)

    const result1 = await service.submitJob(
      providerId,
      'job 1',
      'echo one',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    const result2 = await service.submitJob(
      providerId,
      'job 2',
      'echo two',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    // Update first job to running (not terminal)
    await jobRepo.update(result1.job_id, {
      status: 'running',
      startedAt: new Date()
    })

    const job1 = await jobRepo.get(result1.job_id)
    service.handleJobUpdated(job1!)

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Job 2 should still be queued
    const job2 = await jobRepo.get(result2.job_id)
    expect(job2?.status).toBe('queued')
  })

  it('should handle terminal states: success, failed, timeout, error', async () => {
    const providerId = computeProviderId('test-host')
    await service.setSessionConcurrencyLimit('session-1', 1)

    const terminalStates: Array<'success' | 'failed' | 'timeout' | 'error'> = [
      'success',
      'failed',
      'timeout',
      'error'
    ]

    for (const terminalState of terminalStates) {
      // Submit two jobs
      const result1 = await service.submitJob(
        providerId,
        'job active',
        'echo test',
        {},
        { sessionId: `session-${terminalState}`, projectId: 'project-1' }
      )

      await service.setSessionConcurrencyLimit(`session-${terminalState}`, 1)

      const result2 = await service.submitJob(
        providerId,
        'job queued',
        'echo test',
        {},
        { sessionId: `session-${terminalState}`, projectId: 'project-1' }
      )

      expect(result2.status).toBe('queued')

      // Complete first job with terminal state
      await jobRepo.update(result1.job_id, {
        status: terminalState,
        ...(terminalState === 'error' ? { errorCode: 'dispatch_failed' } : {}),
        finishedAt: new Date()
      })

      const job1 = await jobRepo.get(result1.job_id)
      service.handleJobUpdated(job1!)

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Second job should be dispatched
      const job2 = await jobRepo.get(result2.job_id)
      expect(job2?.status).toBe('submitted')
    }
  })
})
