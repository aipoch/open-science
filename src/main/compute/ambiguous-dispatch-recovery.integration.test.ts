import { createComputeExecution } from '@aipoch/compute/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SshRunner } from '@aipoch/compute/node'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from '@aipoch/compute/node'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { type ComputeConnectionBroker } from './connection-broker'

import { ComputeService } from './compute-service'
import { ComputeJobRepository } from './job-repository'
import { ComputeHostRepository } from './repository'

const successfulRun = (stdout: string): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false
})

const serviceBroker = (
  run: ComputeConnectionLease['run'],
  redactSensitiveOutputs?: ComputeConnectionLease['redactSensitiveOutputs']
): ComputeConnectionBroker => ({
  acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn(), redactSensitiveOutputs })),
  beginHostDeletion: vi.fn(async () => undefined),
  abortHostDeletion: vi.fn(),
  completeHostDeletion: vi.fn()
})

describe('ambiguous Compute Job dispatch recovery', () => {
  let database: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hostRepository: ComputeHostRepository
  let jobRepository: ComputeJobRepository
  let service: ComputeService

  const createSubmittedJob = async ({
    id,
    remoteWorkdir,
    intent = 'restart recovery',
    command = 'sleep 60',
    timeoutSeconds
  }: {
    id: string
    remoteWorkdir?: string
    intent?: string
    command?: string
    timeoutSeconds?: number
  }): Promise<void> => {
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id,
      providerId: 'ssh:recovery-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent,
      command,
      commandHash: 'hash',
      timeoutSeconds,
      remoteWorkdir,
      initialStatus: 'submitted'
    })
  }

  beforeEach(async () => {
    database = await createMigratedComputeTestDatabase('open-science-dispatch-recovery-')
    hostRepository = new ComputeHostRepository(() => Promise.resolve(database.client))
    jobRepository = database.repositories.jobs
    await hostRepository.create({ sshAlias: 'recovery-host' })
    service = new ComputeService({
      runner: { run: vi.fn() } as unknown as SshRunner,
      repository: hostRepository,
      jobRepository
    })
  })

  afterEach(async () => {
    await database.dispose()
  })

  it('adopts a launched submitted job after restart when its PID still owns the deterministic workdir', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-running'
    await createSubmittedJob({
      id: 'job-running',
      remoteWorkdir
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
    const poller = createComputeExecution().createPoller({
      connectionBroker,
      hostRepository,
      jobRepository
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

  it.each(['running', 'exited', 'vanished'] as const)(
    'persists the historical fallback across %s recovery, restart, harvest, and deletion',
    async (observation) => {
      const jobId = `legacy-path-${observation}`
      const workdir = `~/.openscience/jobs/${jobId}`
      await createSubmittedJob({ id: jobId })
      await jobRepository.update(jobId, {
        lastPollError: 'dispatch_may_have_started: dispatch_recovery_pending'
      })
      const run = vi
        .fn<ComputeConnectionLease['run']>()
        .mockResolvedValue(
          successfulRun(
            [
              'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
              'workdir:1',
              `exit_code:${observation === 'exited' ? 0 : ''}`,
              'pid:4321',
              `cwd_match:${observation === 'running' ? 1 : 0}`
            ].join('\n')
          )
        )
      const harvestFn = vi.fn(async () => undefined)
      const connectionBroker = serviceBroker(run)
      const nonce = 'legacy_path_'
      let poller = createComputeExecution().createPoller({
        connectionBroker,
        hostRepository,
        jobRepository,
        harvestFn,
        makeNonce: () => nonce
      })
      await poller.tick()
      const restoredRepository = new ComputeJobRepository(() => Promise.resolve(database.client))
      await expect(restoredRepository.get(jobId)).resolves.toMatchObject({
        remote_workdir: workdir
      })
      if (observation === 'running') {
        const recovered = await restoredRepository.get(jobId)
        expect(recovered).toMatchObject({ status: 'running', last_poll_error: undefined })
        expect(JSON.parse(recovered!.remote_handle!)).toMatchObject({ pid: 4321, workdir })
        poller = createComputeExecution().createPoller({
          connectionBroker,
          hostRepository,
          jobRepository: restoredRepository,
          harvestFn,
          makeNonce: () => nonce
        })
        const output = (alive: number, exitCode: string): string =>
          [
            `${nonce}JOB_START:${jobId}`,
            `${nonce}alive:${alive}`,
            `${nonce}exit:${exitCode}`,
            '',
            `${nonce}STDOUT_END:${jobId}`,
            '',
            `${nonce}STDERR_END:${jobId}`
          ].join('\n')
        run.mockResolvedValue(successfulRun(output(1, '')))
        await poller.tick()
        await expect(restoredRepository.get(jobId)).resolves.toMatchObject({
          status: 'running',
          remote_workdir: workdir,
          error_code: undefined
        })
        run.mockResolvedValue(successfulRun(output(0, '0')))
        await poller.tick()
      }
      await poller.pause()
      const expectedStatus = observation === 'vanished' ? 'failed' : 'success'
      await expect(restoredRepository.get(jobId)).resolves.toMatchObject({
        status: expectedStatus,
        remote_workdir: workdir
      })
      expect(harvestFn).toHaveBeenCalledWith(
        expect.objectContaining({ status: expectedStatus, remote_workdir: workdir }),
        observation === 'running' ? expect.any(AbortSignal) : undefined
      )
      const cleanupRun = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(successfulRun(''))
      const owner = createComputeExecution().createDeletionOwner({
        jobRepository: restoredRepository,
        hostRepository,
        connectionBroker: serviceBroker(cleanupRun)
      })
      await owner.prepareSessionJobDeletion('project-1', 'session-1')
      await owner.commitSessionJobDeletion('project-1', 'session-1')
      expect(cleanupRun).toHaveBeenCalledWith(
        expect.stringContaining(`~/'.openscience/jobs/${jobId}'`),
        expect.anything()
      )
      await expect(restoredRepository.get(jobId)).resolves.toBeNull()
    }
  )

  it('adopts a launched job when lsof proves cwd on a host without procfs', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-lsof'
    await createSubmittedJob({
      id: 'job-lsof',
      intent: 'portable restart recovery',
      remoteWorkdir
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

    await createComputeExecution()
      .createPoller({
        connectionBroker: serviceBroker(run),
        hostRepository,
        jobRepository
      })
      .tick()

    await expect(service.getJobStatus('job-lsof')).resolves.toMatchObject({ status: 'running' })
  })

  it('converges an already-exited submitted job to terminal state and starts harvest after restart', async () => {
    const remoteWorkdir = '/scratch/.openscience/jobs/job-exited'
    await createSubmittedJob({
      id: 'job-exited',
      command: 'exit 7',
      remoteWorkdir
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
    const poller = createComputeExecution().createPoller({
      connectionBroker,
      hostRepository,
      jobRepository,

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
    await createSubmittedJob({
      id: 'job-vanished',
      command: 'run-and-vanish',
      remoteWorkdir
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

    await createComputeExecution()
      .createPoller({
        connectionBroker,
        hostRepository,
        jobRepository,

        harvestFn: harvest
      })
      .tick()

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
    await createSubmittedJob({
      id: 'job-incomplete-protocol',
      remoteWorkdir
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

    await createComputeExecution()
      .createPoller({
        connectionBroker,
        hostRepository,
        jobRepository,

        harvestFn: harvest
      })
      .tick()

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

    await createComputeExecution()
      .createPoller({
        connectionBroker: { acquire },
        hostRepository,
        jobRepository
      })
      .tick()

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

    await createComputeExecution()
      .createPoller({
        connectionBroker,
        hostRepository,
        jobRepository
      })
      .tick()

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
    await createSubmittedJob({
      id: jobId,
      intent: 'fail-closed timeout recovery',
      timeoutSeconds: 10,
      remoteWorkdir
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

    await createComputeExecution()
      .createPoller({
        connectionBroker: serviceBroker(run),
        hostRepository,
        jobRepository,
        harvestFn: harvest,
        onJobUpdated,
        makeNonce: () => nonce
      })
      .tick()

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
    { name: 'malformed', stdout: '2468junk dispatch-protocol-secret\n', truncated: false },
    { name: 'truncated', stdout: '2468\n', truncated: true },
    { name: 'reserved process id', stdout: '1\n', truncated: false }
  ])('keeps a $name dispatch PID response recoverable across later polling', async (protocol) => {
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValueOnce({ ...successfulRun(protocol.stdout), truncated: protocol.truncated })
      .mockResolvedValue(
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
    const connectionBroker = serviceBroker(run, async (outputs) =>
      outputs.map((output) => output.replaceAll('dispatch-protocol-secret', '[redacted]'))
    )
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
      `${protocol.name} PID response`,
      'sleep 60',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    await vi.waitFor(async () => {
      await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
        status: 'submitted',
        remote_handle: undefined,
        error_code: undefined,
        last_poll_error: expect.stringContaining('dispatch_may_have_started: Could not read pid')
      })
    })
    const dispatched = await jobRepository.get(submitted.job_id)
    expect(JSON.stringify(dispatched)).not.toContain('dispatch-protocol-secret')
    if (protocol.name === 'malformed') expect(dispatched?.last_poll_error).toContain('[redacted]')
    const restartedPoller = createComputeExecution().createPoller({
      connectionBroker,
      hostRepository,
      jobRepository
    })
    for (let attempt = 0; attempt < 3; attempt++) await restartedPoller.tick()
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted',
      remote_handle: undefined,
      error_code: undefined,
      last_poll_error: 'dispatch_may_have_started: dispatch_recovery_pending'
    })
    expect(JSON.stringify(await jobRepository.get(submitted.job_id))).not.toContain(
      'dispatch-protocol-secret'
    )
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
      .mockRejectedValue(new ComputeConnectionError('timeout'))
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
      last_poll_error: 'dispatch_may_have_started: timeout'
    })
    const restartedPoller = createComputeExecution().createPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository
    })
    await restartedPoller.tick()
    await restartedPoller.tick()
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted',
      error_code: undefined,
      last_poll_error: 'dispatch_may_have_started: timeout'
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
      last_poll_error: 'dispatch_may_have_started: dispatch_recovery_probe_failed'
    })
    const restartedPoller = createComputeExecution().createPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository
    })
    await restartedPoller.tick()
    await restartedPoller.tick()
    await expect(jobRepository.get(submitted.job_id)).resolves.toMatchObject({
      status: 'submitted',
      error_code: undefined,
      last_poll_error: 'dispatch_may_have_started: host_unreachable'
    })
  })

  it('keeps an existing but inconclusive remote workdir submitted for a later recovery tick', async () => {
    await createSubmittedJob({
      id: 'job-inconclusive',
      remoteWorkdir: '/scratch/.openscience/jobs/job-inconclusive'
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

    const poller = createComputeExecution().createPoller({
      connectionBroker,
      hostRepository,
      jobRepository
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
    await createSubmittedJob({
      id: 'job-nonconsecutive',
      remoteWorkdir
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
    const poller = createComputeExecution().createPoller({
      connectionBroker: serviceBroker(run),
      hostRepository,
      jobRepository
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

    await createComputeExecution()
      .createPoller({
        connectionBroker: { acquire },
        hostRepository,
        jobRepository
      })
      .tick()

    await expect(service.getJobStatus('job-legacy')).resolves.toMatchObject({ status: 'submitted' })
    await expect(jobRepository.get('job-legacy')).resolves.toMatchObject({
      last_poll_error: 'host_unreachable'
    })
    expect(acquire).toHaveBeenCalledOnce()
  })
})
