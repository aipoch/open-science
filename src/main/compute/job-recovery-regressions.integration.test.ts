import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import {
  ComputeJobCancellationOwner,
  ComputeJobCancellationReaper
} from './compute-job-cancellation-owner'
import { resolveInputs } from './compute-job-workflow-owner'
import { ConcurrencyManager } from './concurrency-manager'
import type { ComputeConnectionBroker, ComputeConnectionLease } from './connection-broker'
import { DispatchTracker } from './dispatch-tracker'
import { harvestJob, type HarvestDeps } from './harvest-engine'
import { dispatchJob } from './job-dispatcher'
import { JobHarvestScheduler, RetryableHarvestError } from './job-harvest-scheduler'
import { JobPoller } from './job-poller'
import { createComputeJobRuntime } from './job-runtime'
import { ComputeHostRepository } from './repository'

const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const success = (stdout = ''): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false
})
const shell = async (
  command: string
): Promise<Awaited<ReturnType<ComputeConnectionLease['run']>>> => {
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', ['-c', command])
    return { ...success(stdout), stderr }
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string }
    return { ...success(result.stdout), stderr: result.stderr, exitCode: result.code }
  }
}
const broker = (
  run: ComputeConnectionLease['run'],
  download: ComputeConnectionLease['download'] = vi.fn(async () => ({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    bytesWritten: 0,
    exceeded: false
  }))
): ComputeConnectionBroker => ({
  acquire: vi.fn(async () => ({ run, upload: vi.fn(), download })),
  beginHostDeletion: vi.fn(async () => undefined),
  abortHostDeletion: vi.fn(),
  completeHostDeletion: vi.fn()
})

describe('Compute Job recovery behavior', () => {
  let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hosts: ComputeHostRepository
  const scope = { projectId: 'project-1', sessionId: 'session-1', providerId: 'ssh:recovery' }
  const createJob = async (
    status: 'submitted' | 'running' | 'success' = 'success',
    id = 'job-1',
    inputManifest?: string
  ): Promise<ComputeJob> => {
    await db.repositories.jobs.create({
      id,
      ...scope,
      shape: 'direct_ssh',
      intent: 'recovery',
      command: 'echo generated-command',
      commandHash: 'hash',
      initialStatus: status,
      allowUnencryptedPersistence: true,
      remoteWorkdir:
        process.platform === 'win32'
          ? `/scratch/.openscience/jobs/${id}`
          : join(db.storageRoot, '.openscience', 'jobs', id),
      inputManifest
    })
    return (await db.repositories.jobs.get(id))!
  }
  const deps = (connectionBroker = broker(vi.fn(async () => success()))): HarvestDeps => ({
    storageRoot: db.storageRoot,
    jobRepository: db.repositories.jobs,
    hostRepository: hosts,
    connectionBroker,
    getFreeDiskBytesFn: async () => 10 ** 12
  })
  beforeEach(async () => {
    db = await createMigratedComputeTestDatabase('compute-job-recovery-')
    hosts = new ComputeHostRepository(() => Promise.resolve(db.client))
    await hosts.create({ sshAlias: 'recovery' })
    await hosts.updateConcurrencyLimit(scope.providerId, 1)
  })
  afterEach(async () => {
    await db.dispose()
  })

  it.skipIf(process.platform === 'win32').each(['explicit', 'basename'])(
    'preserves a remote input that collides with a launcher filename (%s)',
    async (kind) => {
      const input = join(db.storageRoot, 'original', 'command.sh')
      await mkdir(dirname(input), { recursive: true })
      await writeFile(input, 'irreplaceable input')
      let rejection: unknown
      try {
        const { entries } = await resolveInputs(
          [{ remote_path: input, ...(kind === 'explicit' ? { dst_filename: 'command.sh' } : {}) }],
          undefined,
          undefined
        )
        await createJob('submitted', 'job-1', JSON.stringify(entries))
        const run = vi.fn<ComputeConnectionLease['run']>(async (command) => {
          // Execute the actual preparation script, stopping before detached process creation.
          const result = await shell(command.split('nohup setsid')[0]!)
          if (command.includes('nohup setsid') && result.exitCode === 0) return success('4242')
          return result
        })
        await dispatchJob('job-1', {
          connectionBroker: broker(run),
          hostRepository: hosts,
          jobRepository: db.repositories.jobs,
          dispatchTracker: new DispatchTracker()
        })
      } catch (error) {
        rejection = error
      }
      expect(await readFile(input, 'utf8')).toBe('irreplaceable input')
      expect(rejection).toBeInstanceOf(Error)
    }
  )

  it('completes cancellation when the launch response arrives after the cancellation request', async () => {
    const job = await createJob('submitted')
    const launchEntered = deferred()
    const launchResponse = deferred<ReturnType<typeof success>>()
    const run = vi.fn<ComputeConnectionLease['run']>(async (command) => {
      if (command.includes('nohup setsid')) {
        launchEntered.resolve()
        return launchResponse.promise
      }
      if (command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1')) {
        return success(
          'OPEN_SCIENCE_DISPATCH_RECOVERY_V1\nworkdir:1\nexit_code:\npid:4242\ncwd_match:1'
        )
      }
      return success(command.includes('kill -TERM') ? 'terminated' : 'absent')
    })
    const connectionBroker = broker(run)
    const dispatching = dispatchJob(job.job_id, {
      connectionBroker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      dispatchTracker: new DispatchTracker()
    })
    await launchEntered.promise
    const owner = new ComputeJobCancellationOwner(db.repositories.operations, db.repositories.jobs)
    await owner.request(job.job_id, scope)
    launchResponse.resolve(success('4242'))
    await dispatching
    const reaper = new ComputeJobCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      connectionBroker,
      { retryDelayMs: () => 0 }
    )
    for (let attempt = 0; attempt < 3; attempt++) await reaper.runOnce()
    expect(await db.repositories.jobs.findNonTerminal()).toEqual([])
    expect(await owner.status(job.job_id, scope)).toMatchObject({
      cancellation_status: 'cancelled'
    })
  })

  it.each(['not_started', 'running', 'pending'] as const)(
    'recovers cancellation after restart with %s launch evidence',
    async (evidence) => {
      const job = await createJob('submitted')
      const owner = new ComputeJobCancellationOwner(
        db.repositories.operations,
        db.repositories.jobs
      )
      await owner.request(job.job_id, scope)
      const observation =
        evidence === 'not_started'
          ? 'workdir:0\nexit_code:\npid:\ncwd_match:0'
          : evidence === 'running'
            ? 'workdir:1\nexit_code:\npid:4242\ncwd_match:1'
            : 'workdir:1\nexit_code:\npid:\ncwd_match:0'
      const run = vi.fn<ComputeConnectionLease['run']>(async (command) =>
        success(
          command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1')
            ? `OPEN_SCIENCE_DISPATCH_RECOVERY_V1\n${observation}`
            : 'absent'
        )
      )
      const reaper = new ComputeJobCancellationReaper(
        db.repositories.operations,
        db.repositories.jobs,
        broker(run)
      )
      await reaper.runOnce()
      expect((await owner.status(job.job_id, scope)).cancellation_status).toBe(
        evidence === 'pending' ? 'cancelling' : 'cancelled'
      )
      expect(run).toHaveBeenCalledTimes(evidence === 'running' ? 2 : 1)
    }
  )

  it('does not confirm a missing launch while dispatch is still in flight', async () => {
    const job = await createJob('submitted')
    const owner = new ComputeJobCancellationOwner(db.repositories.operations, db.repositories.jobs)
    await owner.request(job.job_id, scope)
    const tracker = new DispatchTracker()
    tracker.begin(job.job_id)
    const connectionBroker = broker(vi.fn(async () => success('')))
    const reaper = new ComputeJobCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      connectionBroker,
      { dispatchTracker: tracker }
    )
    await reaper.runOnce()
    expect(connectionBroker.acquire).not.toHaveBeenCalled()
    expect((await owner.status(job.job_id, scope)).cancellation_status).toBe('cancelling')
    tracker.end(job.job_id)
  })

  it('rejects a conflicting historical input manifest before staging any inputs', async () => {
    await createJob(
      'submitted',
      'job-1',
      JSON.stringify([
        {
          kind: 'symlink',
          remotePath: '/original/data.csv',
          dstFilename: 'data.csv',
          label: 'data.csv'
        },
        {
          kind: 'symlink',
          remotePath: '/original/script',
          dstFilename: 'launcher.sh',
          label: 'script'
        }
      ])
    )
    const run = vi.fn<ComputeConnectionLease['run']>(async () => success())
    await dispatchJob('job-1', {
      connectionBroker: broker(run),
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      dispatchTracker: new DispatchTracker()
    })
    expect(
      run.mock.calls.some(([command]) => command.includes('ln -s') || command.includes('nohup'))
    ).toBe(false)
    expect(await db.repositories.jobs.get('job-1')).toMatchObject({
      status: 'error',
      error_code: 'dispatch_failed'
    })
  })

  it('backs off transient harvest failures and clears the delay after recovery', async () => {
    const job = await createJob()
    let now = 0
    const harvest = vi
      .fn()
      .mockRejectedValueOnce(new RetryableHarvestError('Local free-space check failed.'))
      .mockResolvedValue(undefined)
    const scheduler = new JobHarvestScheduler(harvest, () => now)
    await scheduler.schedule(job)
    await scheduler.schedule(job)
    expect(harvest).toHaveBeenCalledTimes(1)
    now = 60_000
    await scheduler.schedule(job)
    await scheduler.schedule(job)
    expect(harvest).toHaveBeenCalledTimes(3)
    await scheduler.waitForIdle()
  })

  it.each([
    'command.sh',
    'launcher.sh',
    'exit_code',
    'exit_code.tmp',
    'job.pid',
    'stdout',
    'stderr',
    'job.sbatch',
    'scheduler_job_id',
    'scheduler_job_id.tmp',
    'scheduler_submit_error',
    'scheduler_submit_error.tmp',
    'scheduler_submit_error.stderr.tmp'
  ])('rejects reserved upload destination %s', async (name) => {
    await expect(
      resolveInputs([{ src: 'data.txt', dst_filename: name }], db.storageRoot, undefined)
    ).rejects.toThrow('reserved')
  })

  it.each(['session', 'provider'])(
    'keeps the %s concurrency limit occupied until remote cancellation is confirmed',
    async (limit) => {
      await createJob('running')
      const jobs = db.repositories.jobs
      const manager = new ConcurrencyManager(jobs, hosts, vi.fn())
      if (limit === 'session') {
        await manager.setSessionLimit(scope.sessionId, 1)
        await hosts.updateConcurrencyLimit(scope.providerId, 10)
      }
      await new ComputeJobCancellationOwner(db.repositories.operations, jobs).request(
        'job-1',
        scope
      )
      expect.soft(await jobs.countActiveBySession(scope.sessionId)).toBe(1)
      expect.soft(await jobs.countActiveByProvider(scope.providerId)).toBe(1)
      const admitted = await manager.admit(scope, async (initialStatus) => {
        await jobs.create({
          id: 'job-2',
          ...scope,
          shape: 'direct_ssh',
          intent: 'second job',
          command: 'true',
          commandHash: 'hash',
          initialStatus,
          allowUnencryptedPersistence: true
        })
      })
      expect.soft(await jobs.countActiveBySession(scope.sessionId)).toBe(1)
      expect.soft(await jobs.countActiveByProvider(scope.providerId)).toBe(1)
      expect(admitted).toBe('queued')
    }
  )

  it('finishes harvest and makes notification ready when cancellation proves no launch occurred', async () => {
    const job = await createJob('submitted')
    await db.repositories.jobs.update(job.job_id, { submittedAt: new Date() })
    await new ComputeJobCancellationOwner(db.repositories.operations, db.repositories.jobs).request(
      job.job_id,
      scope
    )
    const confirmed = deferred()
    const run = vi.fn<ComputeConnectionLease['run']>(async (command) =>
      command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1')
        ? success('OPEN_SCIENCE_DISPATCH_RECOVERY_V1\nworkdir:0\nexit_code:\npid:\ncwd_match:0')
        : { ...success(), exitCode: 1, stderr: 'No such file or directory' }
    )
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: async () => confirmed.resolve(),
          startQueueReconciliation: vi.fn(),
          stopQueueReconciliation: vi.fn(async () => undefined)
        },
        hostRepository: hosts,
        jobRepository: db.repositories.jobs,
        operationRepository: db.repositories.operations,
        connectionBroker: broker(run),
        storageRoot: db.storageRoot
      },
      {
        broadcast: vi.fn(),
        createPoller: () => ({
          start: () => undefined,
          stop: async () => undefined,
          pause: async () => undefined,
          resume: () => undefined
        })
      }
    )
    await runtime.start()
    try {
      await confirmed.promise
      const persisted = (await db.repositories.jobs.get(job.job_id))!
      expect.soft(persisted.harvested_at).toBeTruthy()
      expect.soft(persisted.harvest_error).toBeUndefined()
      expect.soft(persisted.remote_cleanup_disposition).toBe('cleaned')
      expect.soft(await db.repositories.jobs.findTerminalUnharvested()).toEqual([])
      expect
        .soft(
          (await db.repositories.jobs.findNotificationReadyUnnotified()).map((row) => row.job_id)
        )
        .toContain(job.job_id)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.stop()
    }
  })

  it('shares harvest execution between cancellation completion and the periodic scan', async () => {
    const job = await createJob('running')
    await db.repositories.jobs.update(job.job_id, {
      submittedAt: new Date(),
      remoteHandle: JSON.stringify({
        pid: 4242,
        workdir: job.remote_workdir,
        exit_code_path: `${job.remote_workdir}/exit_code`,
        stdout_path: `${job.remote_workdir}/stdout`,
        stderr_path: `${job.remote_workdir}/stderr`
      })
    })
    await new ComputeJobCancellationOwner(db.repositories.operations, db.repositories.jobs).request(
      job.job_id,
      scope
    )
    const entered = deferred()
    const release = deferred()
    const harvest = vi.fn(async () => {
      entered.resolve()
      await release.promise
    })
    let poller!: JobPoller
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(async () => undefined),
          startQueueReconciliation: vi.fn(),
          stopQueueReconciliation: vi.fn(async () => undefined)
        },
        hostRepository: hosts,
        jobRepository: db.repositories.jobs,
        operationRepository: db.repositories.operations,
        connectionBroker: broker(vi.fn(async () => success('absent'))),
        storageRoot: db.storageRoot
      },
      {
        harvest,
        broadcast: vi.fn(),
        createPoller: (pollerDeps) => {
          poller = new JobPoller(pollerDeps)
          return {
            start: () => undefined,
            stop: () => poller.stop(),
            pause: () => poller.pause(),
            resume: () => poller.resume()
          }
        }
      }
    )
    await runtime.start()
    try {
      await entered.promise
      await poller.tick()
      expect(harvest).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await runtime.stop()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'does not report an unreadable remote workdir as a successful empty harvest',
    async () => {
      const job = await createJob()
      const run = vi.fn<ComputeConnectionLease['run']>((command) => shell(command))
      const failure = await harvestJob(job, deps(broker(run))).catch((error: unknown) => error)
      expect(failure).toMatchObject({ message: 'Remote file enumeration failed.' })
      const persisted = (await db.repositories.jobs.get(job.job_id))!
      expect.soft(persisted.harvest_error).toBeTruthy()
      expect.soft(persisted.harvested_at).toBeUndefined()
      expect(
        (await db.repositories.jobs.findTerminalUnharvested()).map((row) => row.job_id)
      ).toContain(job.job_id)
    }
  )

  it('retries harvest after a transient local free-space query failure', async () => {
    const job = await createJob()
    const getFreeDiskBytesFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary filesystem failure'))
      .mockResolvedValue(10 ** 12)
    const harvestDeps = { ...deps(), getFreeDiskBytesFn }
    await harvestJob(job, harvestDeps).catch(() => undefined)
    const pending = await db.repositories.jobs.findTerminalUnharvested()
    expect.soft((await db.repositories.jobs.get(job.job_id))?.harvested_at).toBeUndefined()
    expect(pending.map((row) => row.job_id)).toContain(job.job_id)
    await harvestJob(pending[0]!, harvestDeps)
    expect((await db.repositories.jobs.get(job.job_id))?.harvest_error).toBeUndefined()
    expect(await db.repositories.jobs.findTerminalUnharvested()).toEqual([])
  })
})
