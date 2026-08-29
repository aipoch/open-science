import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SshRunner } from './ssh-runner'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import {
  ComputeConnectionError,
  type ComputeConnectionBroker,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { ComputeService } from './compute-service'
import { DispatchTracker } from './dispatch-tracker'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import { ComputeHostRepository } from './repository'

const successfulRun = (stdout: string): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false
})

const serviceBroker = (run: ComputeConnectionLease['run']): ComputeConnectionBroker => ({
  acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() })),
  beginHostDeletion: vi.fn(async () => undefined),
  abortHostDeletion: vi.fn(),
  completeHostDeletion: vi.fn()
})

describe('ambiguous Compute Job dispatch recovery', () => {
  let storageRoot: string
  let client: PrismaClient
  let hostRepository: ComputeHostRepository
  let jobRepository: ComputeJobRepository
  let service: ComputeService

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-dispatch-recovery-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    hostRepository = new ComputeHostRepository(() => Promise.resolve(client))
    jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    await hostRepository.create({ sshAlias: 'recovery-host' })
    service = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository
    })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('adopts a launched submitted job after restart when its PID still owns the deterministic workdir', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-running'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-running',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const run = vi.fn(async () =>
      successfulRun(
        [
          'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
          'workdir:1',
          'exit_code:',
          'pid:4321',
          'cwd_match:1'
        ].join('\n')
      )
    )
    const connectionBroker = serviceBroker(run)
    const poller = new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    })

    await poller.tick()

    await expect(service.getJobStatus('job-running')).resolves.toMatchObject({ status: 'running' })
    const adopted = await jobRepository.get('job-running')
    expect(JSON.parse(adopted?.remote_handle ?? '')).toEqual({
      pid: 4321,
      exit_code_path: `${remoteWorkdir}/exit_code`,
      stdout_path: `${remoteWorkdir}/stdout`,
      stderr_path: `${remoteWorkdir}/stderr`,
      workdir: remoteWorkdir
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('adopts a launched job when lsof proves cwd on a host without procfs', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-lsof'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-lsof',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'portable restart recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const run = vi.fn<ComputeConnectionLease['run']>(async (command) =>
      successfulRun(
        [
          'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
          'workdir:1',
          'exit_code:',
          'pid:4321',
          command.includes('command -v lsof') ? 'cwd_match:1' : 'cwd_match:0'
        ].join('\n')
      )
    )

    await new JobPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    }).tick()

    await expect(service.getJobStatus('job-lsof')).resolves.toMatchObject({ status: 'running' })
  })

  it('converges an already-exited submitted job to terminal state and starts harvest after restart', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-exited'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-exited',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'exit 7',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () =>
          successfulRun(
            [
              'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
              'workdir:1',
              'exit_code:7',
              'pid:8765',
              'cwd_match:0'
            ].join('\n')
          )
        ),
        upload: vi.fn(),
        download: vi.fn()
      }))
    }
    const harvest = vi.fn(async () => undefined)
    const poller = new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker(),
      harvestFn: harvest
    })

    await poller.tick()

    await expect(service.getJobStatus('job-exited')).resolves.toMatchObject({
      status: 'failed',
      exit_code: 7
    })
    expect(harvest).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 'job-exited' }),
      undefined
    )
  })

  it('never adopts a reused PID whose cwd does not match the job workdir', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-vanished'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-vanished',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'run-and-vanish',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () =>
          successfulRun(
            [
              'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
              'workdir:1',
              'exit_code:',
              'pid:9999',
              'cwd_match:0'
            ].join('\n')
          )
        ),
        upload: vi.fn(),
        download: vi.fn()
      }))
    }
    const harvest = vi.fn(async () => undefined)

    await new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker(),
      harvestFn: harvest
    }).tick()

    await expect(service.getJobStatus('job-vanished')).resolves.toMatchObject({ status: 'failed' })
    const recovered = await jobRepository.get('job-vanished')
    expect(recovered).toMatchObject({
      remote_handle: undefined,
      error_code: 'process_vanished'
    })
    expect(harvest).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 'job-vanished' }),
      undefined
    )
  })

  it('keeps a submitted job recoverable when the recovery protocol is missing cwd_match', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-incomplete-protocol'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-incomplete-protocol',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () =>
          successfulRun(
            ['OPEN_SCIENCE_DISPATCH_RECOVERY_V1', 'workdir:1', 'exit_code:', 'pid:4321'].join('\n')
          )
        ),
        upload: vi.fn(),
        download: vi.fn()
      }))
    }
    const harvest = vi.fn(async () => undefined)

    await new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker(),
      harvestFn: harvest
    }).tick()

    await expect(service.getJobStatus('job-incomplete-protocol')).resolves.toMatchObject({
      status: 'submitted'
    })
    await expect(jobRepository.get('job-incomplete-protocol')).resolves.toMatchObject({
      last_poll_error: 'dispatch_recovery_ambiguous'
    })
    expect(harvest).not.toHaveBeenCalled()
  })

  it('does not include queued jobs in restart dispatch recovery', async () => {
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-queued',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'waiting for capacity',
      command: 'echo queued',
      commandHash: 'hash',
      remoteWorkdir: '/scratch/.openscience/jobs/job-queued',
      initialStatus: 'queued'
    })
    const acquire = vi.fn<ComputeConnectionBrokerAcquirer['acquire']>()

    await new JobPoller({
      connectionBroker: { acquire },
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    }).tick()

    await expect(service.getJobStatus('job-queued')).resolves.toMatchObject({ status: 'queued' })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('adopts the remote launch when the dispatcher loses its SSH response', async () => {
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockRejectedValueOnce(new ComputeConnectionError('host_unreachable'))
      .mockResolvedValueOnce(
        successfulRun(
          [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:1',
            'exit_code:',
            'pid:2468',
            'cwd_match:1'
          ].join('\n')
        )
      )
    const connectionBroker = serviceBroker(run)
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker,
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      'ambiguous launch response',
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(async () => {
      await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
        status: 'running'
      })
    })
    const recovered = await jobRepository.get(submitted.job_id)
    expect(JSON.parse(recovered?.remote_handle ?? '')).toMatchObject({
      pid: 2468,
      workdir: submitted.remote_workdir
    })
  })

  it('keeps a launched job recoverable when persisting its local handle fails', async () => {
    const recoveryOutput = [
      'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
      'workdir:1',
      'exit_code:',
      'pid:2468',
      'cwd_match:1'
    ].join('\n')
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValueOnce(successfulRun('2468'))
      .mockResolvedValueOnce(successfulRun(recoveryOutput))
    const originalUpdateIfStatus = jobRepository.updateIfStatus.bind(jobRepository)
    let rejectHandlePersistence = true
    vi.spyOn(jobRepository, 'updateIfStatus').mockImplementation(
      async (jobId, expectedStatuses, updates) => {
        if (rejectHandlePersistence && updates.status === 'running') {
          rejectHandlePersistence = false
          throw new Error('local persistence unavailable')
        }
        return originalUpdateIfStatus(jobId, expectedStatuses, updates)
      }
    )
    const connectionBroker = serviceBroker(run)
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker,
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      'lost local handle persistence',
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted'
    })

    await new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    }).tick()

    await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
      status: 'running'
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps a timed-out job active when its termination handle becomes untrustworthy', async () => {
    const jobId = 'job-untrustworthy-timeout-handle'
    const remoteWorkdir = `/scratch/.openscience/jobs/${jobId}`
    const handle = {
      pid: 2468,
      exit_code_path: `${remoteWorkdir}/exit_code`,
      stdout_path: `${remoteWorkdir}/stdout`,
      stderr_path: `${remoteWorkdir}/stderr`,
      workdir: remoteWorkdir
    }
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: jobId,
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'fail-closed timeout recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      timeoutSeconds: 10,
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    await jobRepository.updateIfStatus(jobId, ['submitted'], {
      status: 'running',
      remoteHandle: JSON.stringify(handle),
      startedAt: new Date(Date.now() - 71_000)
    })

    const nonce = 'timeout_review_'
    const pollOutput = [
      `${nonce}JOB_START:${jobId}`,
      `${nonce}alive:1`,
      `${nonce}exit:`,
      '',
      `${nonce}STDOUT_END:${jobId}`,
      '',
      `${nonce}STDERR_END:${jobId}`
    ].join('\n')
    const run = vi.fn<ComputeConnectionLease['run']>(async () => {
      await jobRepository.update(jobId, {
        remoteHandle: JSON.stringify({ ...handle, workdir: `${remoteWorkdir}-other` })
      })
      return successfulRun(pollOutput)
    })
    const harvest = vi.fn(async () => undefined)
    const onJobUpdated = vi.fn()

    await new JobPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository,
      harvestFn: harvest,
      onJobUpdated,
      makeNonce: () => nonce
    }).tick()

    await expect(service.getJobStatus(jobId)).resolves.toMatchObject({ status: 'running' })
    expect(onJobUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: jobId,
        status: 'running',
        last_poll_error: 'timeout_termination_unconfirmed'
      })
    )
    expect(run).toHaveBeenCalledOnce()
    expect(harvest).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'malformed', stdout: '2468junk\n', truncated: false },
    { name: 'truncated', stdout: '2468\n', truncated: true },
    { name: 'reserved process id', stdout: '1\n', truncated: false }
  ])('rejects a $name dispatch PID response unless recovery proves a launch', async (protocol) => {
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValueOnce({ ...successfulRun(protocol.stdout), truncated: protocol.truncated })
      .mockResolvedValueOnce(
        successfulRun(
          [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:0',
            'exit_code:',
            'pid:',
            'cwd_match:0'
          ].join('\n')
        )
      )
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker: serviceBroker(run),
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      `${protocol.name} PID response`,
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(async () => {
      await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
        status: 'error'
      })
    })
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      remote_handle: undefined,
      error_code: 'dispatch_failed'
    })
  })

  it('keeps a lost dispatcher response submitted when an immediate probe cannot prove it will not launch', async () => {
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockRejectedValueOnce(new ComputeConnectionError('host_unreachable'))
      .mockResolvedValueOnce(
        successfulRun(
          [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:0',
            'exit_code:',
            'pid:',
            'cwd_match:0'
          ].join('\n')
        )
      )
    const connectionBroker = serviceBroker(run)
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker,
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      'ambiguous launch response',
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted'
    })
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      remote_handle: undefined,
      error_code: undefined
    })
  })

  it('records a retryable diagnostic when the immediate recovery probe also fails', async () => {
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockRejectedValueOnce(new ComputeConnectionError('host_unreachable'))
      .mockRejectedValueOnce(new ComputeConnectionError('timeout'))
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker: serviceBroker(run),
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      'ambiguous launch and failed recovery probe',
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted',
      last_poll_error: 'timeout'
    })
  })

  it('keeps a fire-and-forget dispatch recoverable after a non-transport runner error', async () => {
    const run = vi.fn<ComputeConnectionLease['run']>().mockRejectedValue(new Error('boom'))
    const dispatchingService = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository,
      connectionBroker: serviceBroker(run),
      approvalBroker: {
        requestWithContext: vi.fn(async () => 'once')
      } as unknown as ComputeApprovalBroker
    })

    const submitted = await dispatchingService.submitJob(
      'ssh:recovery-host',
      'unexpected local dispatch failure',
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await expect(dispatchingService.getJobStatus(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted'
    })
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      error_code: undefined,
      last_poll_error: 'dispatch_recovery_probe_failed'
    })
  })

  it('keeps an existing but inconclusive remote workdir submitted for a later recovery tick', async () => {
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-inconclusive',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      remoteWorkdir: '/scratch/.openscience/jobs/job-inconclusive',
      initialStatus: 'submitted'
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () =>
          successfulRun(
            [
              'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
              'workdir:1',
              'exit_code:',
              'pid:',
              'cwd_match:0'
            ].join('\n')
          )
        ),
        upload: vi.fn(),
        download: vi.fn()
      }))
    }

    const poller = new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    })

    await poller.tick()

    await expect(service.getJobStatus('job-inconclusive')).resolves.toMatchObject({
      status: 'submitted'
    })
    await expect(jobRepository.get('job-inconclusive')).resolves.toMatchObject({
      last_poll_error: 'dispatch_recovery_pending'
    })

    await poller.tick()

    await expect(service.getJobStatus('job-inconclusive')).resolves.toMatchObject({
      status: 'error'
    })
    await expect(jobRepository.get('job-inconclusive')).resolves.toMatchObject({
      error_code: 'dispatch_failed'
    })
  })

  it('requires consecutive pending observations before settling interrupted dispatch', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-nonconsecutive'
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-nonconsecutive',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart recovery',
      command: 'sleep 60',
      commandHash: 'hash',
      remoteWorkdir,
      initialStatus: 'submitted'
    })
    const pendingOutput = [
      'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
      'workdir:1',
      'exit_code:',
      'pid:',
      'cwd_match:0'
    ].join('\n')
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValueOnce(successfulRun(pendingOutput))
      .mockRejectedValueOnce(new ComputeConnectionError('timeout'))
      .mockResolvedValueOnce(successfulRun(pendingOutput))
      .mockResolvedValueOnce(successfulRun(pendingOutput))
    const poller = new JobPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    })

    await poller.tick()
    await poller.tick()
    await poller.tick()

    await expect(service.getJobStatus('job-nonconsecutive')).resolves.toMatchObject({
      status: 'submitted'
    })

    await poller.tick()
    await expect(service.getJobStatus('job-nonconsecutive')).resolves.toMatchObject({
      status: 'error'
    })
  })

  it('keeps a legacy submitted row recoverable when its derived workdir cannot be probed', async () => {
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-legacy',
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'legacy restart recovery',
      command: 'echo legacy',
      commandHash: 'hash',
      initialStatus: 'submitted'
    })
    const acquire = vi.fn<ComputeConnectionBrokerAcquirer['acquire']>()

    await new JobPoller({
      connectionBroker: { acquire },
      hostRepository,
      jobRepository,
      dispatchTracker: new DispatchTracker()
    }).tick()

    await expect(service.getJobStatus('job-legacy')).resolves.toMatchObject({ status: 'submitted' })
    await expect(jobRepository.get('job-legacy')).resolves.toMatchObject({
      last_poll_error: 'host_unreachable'
    })
    expect(acquire).toHaveBeenCalledOnce()
  })
})
