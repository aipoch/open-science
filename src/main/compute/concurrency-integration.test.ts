// Integration tests for ConcurrencyManager + ComputeService (issue 03).
// Tests the full submit→queue→auto-dispatch flow with real repositories and mocked SSH.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { ComputeService } from './compute-service'
import { ConcurrencyManager } from './concurrency-manager'
import { ComputeApprovalBroker } from './compute-approval-broker'
import type { SshRunner } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { computeProviderId } from '../../shared/compute'

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
  let onJobUpdatedSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'concurrency-int-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

    hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    jobRepo = new ComputeJobRepository(() => Promise.resolve(client))

    // Create test host
    await hostRepo.create({
      sshAlias: 'test-host',
      displayName: 'Test Host'
    })

    // Mock dispatch function for ConcurrencyManager
    const mockDispatch = vi.fn(async (jobId: string) => {
      // Simulate dispatch by updating job to 'submitted' then 'running'
      await jobRepo.update(jobId, { status: 'submitted', submittedAt: new Date() })
      // Don't immediately transition to running in the mock - let the test control this
    })

    concurrencyManager = new ConcurrencyManager(jobRepo, hostRepo, mockDispatch)

    onJobUpdatedSpy = vi.fn()

    service = new ComputeService(
      makeFakeRunner(),
      hostRepo,
      makeFakeBroker(),
      makeFakeScp(),
      undefined,
      jobRepo,
      onJobUpdatedSpy as any,
      undefined,
      storageRoot,
      concurrencyManager
    )
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

  it('should throw queue_full error when 100 jobs are already queued', async () => {
    const providerId = computeProviderId('test-host')

    // Set provider ceiling to 0 by setting a very high session limit and low provider limit
    // First set provider limit to 1, then submit a job, then reduce to 0 so remaining jobs queue
    await hostRepo.updateConcurrencyLimit(providerId, 1)

    // Submit first job (will be submitted)
    await service.submitJob(
      providerId,
      'active job',
      'echo test',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    // Now set provider limit to 0 so all future jobs queue
    await hostRepo.updateConcurrencyLimit(providerId, 0)

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

    // Trigger onJobCompleted
    const job1 = await jobRepo.get(result1.job_id)
    service.notifyJobCompleted(job1!)

    // Wait for async dispatch to complete
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Second job should now be submitted
    const job2Updated = await jobRepo.get(result2.job_id)
    expect(job2Updated?.status).toBe('submitted')
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
    service.notifyJobCompleted(job1!)

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
    service.notifyJobCompleted(job1!)

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
        finishedAt: new Date()
      })

      const job1 = await jobRepo.get(result1.job_id)
      service.notifyJobCompleted(job1!)

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Second job should be dispatched
      const job2 = await jobRepo.get(result2.job_id)
      expect(job2?.status).toBe('submitted')
    }
  })
})
