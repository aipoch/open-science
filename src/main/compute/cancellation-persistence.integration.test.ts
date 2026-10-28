import {
  createComputeExecution,
  createJobCancellation,
  createJobLifecycle,
  createSshRunner
} from '@aipoch/compute/node'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComputeHostUnavailableError } from '@aipoch/compute'

import type { ComputeConnectionBrokerAcquirer, ComputeConnectionLease } from '@aipoch/compute/node'
import { createProjectDbClient } from '../projects/prisma-client'

import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { OptionalSecureStorageStringProtection, type SecureStorageCipher } from './credential-vault'
import { ComputeJobRepository } from './job-repository'

let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
})

const scope = {
  projectId: 'project-1',
  sessionId: 'session-1',
  providerId: 'ssh:test'
} as const

const remoteHandle = JSON.stringify({
  pid: 4321,
  workdir: '~/.openscience/jobs/job-1',
  exit_code_path: '~/.openscience/jobs/job-1/exit_code',
  stdout_path: '~/.openscience/jobs/job-1/stdout',
  stderr_path: '~/.openscience/jobs/job-1/stderr'
})

const success = (stdout: string): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  exitCode: 0,
  stdout,
  stderr: '',
  truncated: false,
  timedOut: false
})

const encryptedFieldProtection = (): OptionalSecureStorageStringProtection => {
  const cipher: SecureStorageCipher = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(`ciphertext:${value}`),
    decryptString: (value) => value.toString('utf8').replace(/^ciphertext:/, '')
  }
  return new OptionalSecureStorageStringProtection(cipher, 'linux')
}

type CancellationTestSetup = Readonly<{
  client: ReturnType<typeof createProjectDbClient>
  jobs: ComputeJobRepository
  operations: ComputeJobOperationRepository
  createJob(
    status: 'queued' | 'submitted' | 'running' | 'success',
    handle?: typeof remoteHandle,
    executionMode?: 'direct_ssh' | 'slurm'
  ): Promise<void>
}>

describe('Compute Job cancellation owner (SQLite + fake SSH)', () => {
  const setup = async (encrypted = false): Promise<CancellationTestSetup> => {
    const database = await createMigratedComputeTestDatabase('open-science-cancellation-owner-')
    const { client } = database
    disconnect = database.dispose
    const jobs = encrypted
      ? new ComputeJobRepository(() => Promise.resolve(client), encryptedFieldProtection())
      : database.repositories.jobs
    const operations = encrypted
      ? new ComputeJobOperationRepository(() => Promise.resolve(client), encryptedFieldProtection())
      : database.repositories.operations
    const createJob = async (
      status: 'queued' | 'submitted' | 'running' | 'success',
      handle = status === 'running' ? remoteHandle : undefined,
      executionMode: 'direct_ssh' | 'slurm' = 'direct_ssh'
    ): Promise<void> => {
      await jobs.create({
        id: 'job-1',
        providerId: scope.providerId,
        shape: 'direct_ssh',
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        intent: 'long calculation',
        command: 'sleep 100',
        commandHash: 'hash',
        executionMode,
        remoteWorkdir: '~/.openscience/jobs/job-1',
        initialStatus: status,
        allowUnencryptedPersistence: !encrypted
      })
      if (handle) await jobs.update('job-1', { remoteHandle: handle })
    }
    return { client, jobs, operations, createJob }
  }

  it('protects cancellation errors and immutable failure delivery snapshots like other job diagnostics', async () => {
    const { client, jobs, operations, createJob } = await setup(true)
    await createJob('running')
    await operations.request('job-1', 'cancel', scope, new Date())
    const claim = await operations.claimNext('cancel', new Date(), 30000, 'encrypted-failure')
    const error = {
      code: 'cancel_request_rejected',
      message: 'Permission denied for /private/workdir'
    }
    await operations.settle(claim!, new Date(), { outcome: 'failed', error })
    const storedOperation = await client.computeJobOperation.findUniqueOrThrow({
      where: { id: claim!.operation.id }
    })
    const storedEvent = await client.backgroundResultDelivery.findFirstOrThrow()
    expect(storedOperation.errorMessage).toContain('open-science:protected')
    expect(storedOperation.errorMessage).not.toContain('/private/workdir')
    expect(storedEvent.sourceSnapshot).toContain('open-science:protected')
    expect(storedEvent.sourceSnapshot).not.toContain('/private/workdir')
    expect(await createJobCancellation(operations, jobs).status('job-1', scope)).toMatchObject({
      status: 'running',
      cancellation: { status: 'failed', error }
    })
    await jobs.update('job-1', {
      status: 'error',
      errorCode: 'job_status_unavailable',
      errorMessage: 'No record for /private/workdir'
    })
    expect(
      (await client.computeJob.findUniqueOrThrow({ where: { id: 'job-1' } })).errorMessage
    ).not.toContain('/private/workdir')
    expect((await jobs.get('job-1'))?.error_message).toBe('No record for /private/workdir')
  })

  it.each(['running', 'exited', 'vanished'] as const)(
    'retains uncertain missing-directory cancellation until later %s evidence',
    async (laterEvidence) => {
      const { jobs, operations, createJob } = await setup()
      await createJob('submitted')
      const scratchRoot = await mkdtemp(join(tmpdir(), 'cancellation-missing-workdir-'))
      try {
        const localWorkdir = join(scratchRoot, '.openscience', 'jobs', 'job-1')
        // Remote paths always use POSIX syntax, independently of the SQLite host platform.
        const workdir = posix.join(
          process.platform === 'win32' ? '/scratch/cancellation-test' : scratchRoot,
          '.openscience',
          'jobs',
          'job-1'
        )
        await jobs.update('job-1', {
          remoteWorkdir: workdir,
          lastPollError: 'dispatch_may_have_started: host_unreachable'
        })
        let observation: 'not_started' | typeof laterEvidence = 'not_started'
        const run = vi.fn<ComputeConnectionLease['run']>(async (command) => {
          if (command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1'))
            return success(
              [
                'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
                `workdir:${observation === 'not_started' ? 0 : 1}`,
                `exit_code:${observation === 'exited' ? 0 : ''}`,
                `pid:${observation === 'not_started' || observation === 'exited' ? '' : 4321}`,
                `cwd_match:${observation === 'running' ? 1 : 0}`
              ].join('\n')
            )
          return success(command.includes('kill_job_pid') ? 'terminated' : 'owned')
        })
        const broker: ComputeConnectionBrokerAcquirer = {
          acquire: async () => ({
            run,
            upload: async () => undefined,
            download: async () => ({
              exitCode: 0,
              stderr: '',
              timedOut: false,
              bytesWritten: 0,
              exceeded: false
            })
          })
        }
        const cancellation = createJobCancellation(operations, jobs)
        const onConfirmed = vi.fn()
        let clock = Date.now() + 10_000
        const options = { now: () => new Date(clock), retryDelayMs: () => 1, onConfirmed }
        await cancellation.request('job-1', scope)
        await createComputeExecution()
          .createCancellationReaper(operations, jobs, broker, options)
          .runOnce()
        clock += 10
        await createComputeExecution()
          .createCancellationReaper(operations, jobs, broker, options)
          .runOnce()
        await expect(cancellation.status('job-1', scope)).resolves.toMatchObject({
          status: 'submitted',
          cancellation: { status: 'cancelling' }
        })
        await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
          phase: 'active',
          outcome: null,
          claimToken: null,
          attemptCount: 2
        })
        const uncertain = await jobs.get('job-1')
        expect(uncertain?.remote_cleanup_disposition).not.toBe('cleaned')
        expect(uncertain?.harvested_at).toBeUndefined()
        expect(uncertain?.last_poll_error).toContain('dispatch_may_have_started')
        expect(onConfirmed).not.toHaveBeenCalled()
        expect(run).toHaveBeenCalledTimes(2)

        const cleanupRun = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue({
          ...success(''),
          exitCode: 1,
          stderr: 'Remote workdir is absent.'
        })
        const queueManager = { pauseOwner: vi.fn(async () => undefined), resumeOwner: vi.fn() }
        const deletion = createComputeExecution().createDeletionOwner({
          jobRepository: jobs,
          hostRepository: { get: async () => null },
          queueManager,
          connectionBroker: {
            acquire: async () => ({
              run: cleanupRun,
              upload: async () => undefined,
              download: async () => ({
                exitCode: 0,
                stderr: '',
                timedOut: false,
                bytesWritten: 0,
                exceeded: false
              })
            })
          }
        })
        await deletion.prepareSessionJobDeletion(scope.projectId, scope.sessionId)
        await expect(
          deletion.commitSessionJobDeletion(scope.projectId, scope.sessionId)
        ).rejects.toThrow(/cleanup failed/)
        await expect(jobs.get('job-1')).resolves.not.toBeNull()
        expect(cleanupRun).toHaveBeenCalledOnce()
        expect(queueManager.resumeOwner).not.toHaveBeenCalled()
        await deletion.abortSessionJobDeletion(scope.projectId, scope.sessionId)

        observation = laterEvidence
        clock += 10
        await createComputeExecution()
          .createCancellationReaper(operations, jobs, broker, options)
          .runOnce()
        await expect(cancellation.status('job-1', scope)).resolves.toMatchObject({
          status: 'cancelled'
        })
        await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
          phase: 'settled',
          outcome: 'fulfilled'
        })
        expect(onConfirmed).toHaveBeenCalledOnce()
        expect((await jobs.get('job-1'))?.remote_cleanup_disposition).not.toBe('cleaned')
        expect((await jobs.get('job-1'))?.harvested_at).toBeUndefined()
        expect((await jobs.get('job-1'))?.last_poll_error).toBeUndefined()
        // Harvest has completed; cleanup must not demand a PID witness after definitive
        // cancellation evidence, even when job.pid was never a usable file.
        await jobs.update('job-1', { harvestedAt: new Date(clock) })
        await mkdir(join(localWorkdir, 'job.pid'), { recursive: true })
        await writeFile(join(localWorkdir, 'exit_code'), '0')
        cleanupRun.mockImplementation(async (command) => {
          expect(command).not.toContain('[ -z "$workdir" ] || [ -f ')
          // Keep the complete SQLite/owner protocol test portable; execute the generated
          // remote shell command locally only where this host provides Unix semantics.
          if (process.platform === 'win32') return success('')
          const result = await promisify(execFile)('sh', ['-c', command])
          return success(result.stdout)
        })
        await deletion.prepareSessionJobDeletion(scope.projectId, scope.sessionId)
        await deletion.commitSessionJobDeletion(scope.projectId, scope.sessionId)
        await expect(jobs.get('job-1')).resolves.toBeNull()
        expect(queueManager.resumeOwner).toHaveBeenCalled()
      } finally {
        await rm(scratchRoot, { recursive: true, force: true })
      }
    }
  )

  it('still confirms a missing workdir without an uncertain-launch witness', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('submitted')
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValue(
        success(
          [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:0',
            'exit_code:',
            'pid:',
            'cwd_match:0'
          ].join('\n')
        )
      )
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: async () => ({
        run,
        upload: async () => undefined,
        download: async () => ({
          exitCode: 0,
          stderr: '',
          timedOut: false,
          bytesWritten: 0,
          exceeded: false
        })
      })
    }
    const cancellation = createJobCancellation(operations, jobs)
    await cancellation.request('job-1', scope)
    await createComputeExecution().createCancellationReaper(operations, jobs, broker).runOnce()
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'settled',
      outcome: 'fulfilled'
    })
    await expect(jobs.get('job-1')).resolves.toMatchObject({
      status: 'failed',
      remote_cleanup_disposition: 'cleaned',
      harvested_at: expect.any(Number)
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(['owned', 'absent', 'mismatch', 'truncated-stdout', 'truncated-termination'] as const)(
    'uses complete stdout evidence with truncated SSH banners: %s',
    async (evidence) => {
      const { jobs, operations, createJob } = await setup()
      await createJob('running')
      const directory = await mkdtemp(join(tmpdir(), 'cancellation-transport-'))
      try {
        const executable = join(directory, 'ssh-fixture.cjs')
        // A real child process exercises SshRunner's per-stream byte accounting.
        const ownershipOutput =
          evidence === 'truncated-stdout'
            ? 'owned'.padEnd(100, ' ')
            : evidence === 'truncated-termination'
              ? 'owned'
              : evidence
        const terminationOutput =
          evidence === 'truncated-termination' ? 'terminated'.padEnd(100, ' ') : 'terminated'
        await writeFile(
          executable,
          `
          process.stderr.write('SSH diagnostic banner\\n'.repeat(100));
          const output = process.argv[2].includes('kill_job_pid')
            ? ${JSON.stringify(terminationOutput)}
            : ${JSON.stringify(ownershipOutput)};
          process.stdout.write(output + '\\n');
        `
        )
        const runner = createSshRunner()
        const run = vi.fn<ComputeConnectionLease['run']>((command, options) =>
          runner.run(
            { sshBinary: process.execPath, extraArgs: [], host: executable },
            command,
            options
          )
        )
        const broker = {
          acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
        }
        const owner = createJobCancellation(operations, jobs)
        const reaper = createComputeExecution().createCancellationReaper(operations, jobs, broker)
        await owner.request('job-1', scope)
        await reaper.runOnce()
        await expect(owner.status('job-1', scope)).resolves.toMatchObject({
          status: evidence.startsWith('truncated-') ? 'running' : 'cancelled',
          ...(evidence.startsWith('truncated-') ? { cancellation: { status: 'cancelling' } } : {})
        })
        expect(run).toHaveBeenCalledTimes(
          evidence === 'owned' || evidence === 'truncated-termination' ? 2 : 1
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('confirms queued cancellation transactionally without opening SSH', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('queued')
    const acquire = vi.fn()
    const owner = createJobCancellation(operations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      job_id: 'job-1',
      status: 'cancelled'
    })
    const reaper = createComputeExecution().createCancellationReaper(operations, jobs, {
      acquire
    } as unknown as ComputeConnectionBrokerAcquirer)
    await reaper.runOnce()

    expect(acquire).not.toHaveBeenCalled()
    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      status: 'cancelled'
    })
  })

  it.each(['owned', 'mismatch', 'absent'] as const)(
    'confirms a running cancellation when process evidence is %s',
    async (evidence) => {
      const { jobs, operations, createJob } = await setup()
      await createJob('running')
      const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValueOnce(success(evidence))
      if (evidence === 'owned') run.mockResolvedValueOnce(success('terminated'))
      const broker: ComputeConnectionBrokerAcquirer = {
        acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
      }
      const owner = createJobCancellation(operations, jobs)
      const onConfirmed = vi.fn()
      const reaper = createComputeExecution().createCancellationReaper(operations, jobs, broker, {
        onConfirmed
      })

      await expect(owner.request('job-1', scope)).resolves.toMatchObject({
        status: 'running',
        cancellation: { status: 'cancelling' }
      })
      expect(onConfirmed).not.toHaveBeenCalled()
      await reaper.runOnce()

      await expect(owner.status('job-1', scope)).resolves.toMatchObject({
        status: 'cancelled'
      })
      expect(run).toHaveBeenCalledTimes(evidence === 'owned' ? 2 : 1)
      expect(onConfirmed).toHaveBeenCalledWith('job-1')
    }
  )

  it('settles a requested cancellation after owned remote cleanup succeeds', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)
    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      cancellation: { status: 'cancelling' }
    })

    await expect(
      operations.fulfillCancellationAfterRemoteCleanup(
        'job-1',
        scope,
        new Date('2026-01-01T00:00:00.000Z')
      )
    ).resolves.toBe(true)
    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'cancelled'
    })
    await expect(
      operations.fulfillCancellationAfterRemoteCleanup(
        'job-1',
        scope,
        new Date('2026-01-01T00:00:01.000Z')
      )
    ).resolves.toBe(false)
  })

  it('does not terminalize an active Job without a cancellation request', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')

    await expect(
      operations.fulfillCancellationAfterRemoteCleanup(
        'job-1',
        scope,
        new Date('2026-01-01T00:00:00.000Z')
      )
    ).rejects.toThrow('Compute Job cancellation is not active.')
    await expect(jobs.get('job-1')).resolves.toMatchObject({ status: 'running' })
  })

  it('does not settle remote cleanup across a cancellation reaper lease', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)
    await owner.request('job-1', scope)
    const claim = await operations.claimNext(
      'cancel',
      new Date('2026-01-01T00:00:00.000Z'),
      30_000,
      'reaper-lease'
    )
    expect(claim).not.toBeNull()

    await expect(
      operations.fulfillCancellationAfterRemoteCleanup(
        'job-1',
        scope,
        new Date('2026-01-01T00:00:01.000Z')
      )
    ).rejects.toThrow('Cancellation fulfillment lost its ownership claim')
    await expect(jobs.get('job-1')).resolves.toMatchObject({ status: 'running' })
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'active',
      claimToken: 'reaper-lease'
    })
  })

  it.each([
    { ...success('unknown') },
    { ...success('owned'), timedOut: true },
    { ...success('owned'), truncated: true },
    { ...success('owned'), exitCode: 1 },
    {
      ...success('owned'),
      stdoutTruncated: false,
      stderrTruncated: true,
      truncated: true,
      exitCode: 1
    }
  ])('retries incomplete or failed evidence without confirming: %j', async (result) => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(result)
    const owner = createJobCancellation(operations, jobs)
    const reaper = createComputeExecution().createCancellationReaper(operations, jobs, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })

    await owner.request('job-1', scope)
    await reaper.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      cancellation: { status: 'cancelling' }
    })
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'active',
      attemptCount: 1,
      eligibleAt: expect.any(Date),
      claimToken: null
    })
  })

  it('does not cancel a name-matching Slurm candidate with mismatched ownership evidence', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running', undefined, 'slurm')
    const run = vi
      .fn<ComputeConnectionLease['run']>()
      .mockResolvedValue(
        success(
          'expected|/home/researcher/.openscience/jobs/job-1\n' +
            'active|456|openscience-job-1|/shared/other/.openscience/jobs/job-1\n'
        )
      )
    const owner = createJobCancellation(operations, jobs)
    const reaper = createComputeExecution().createCancellationReaper(operations, jobs, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })

    await owner.request('job-1', scope)
    await reaper.runOnce()

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.some(([command]) => command.startsWith('scancel '))).toBe(false)
    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'running',
      cancellation: { status: 'cancelling' }
    })
  })

  it('supersedes cancellation when the job was terminal first', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('success')
    const owner = createJobCancellation(operations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      status: 'success'
    })
    expect((await owner.status('job-1', scope)).cancellation).toBeUndefined()
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'settled',
      outcome: 'superseded'
    })
  })

  it('recovers an expired claim after restart', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)
    await owner.request('job-1', scope)
    await operations.claimNext('cancel', new Date('2026-01-01T00:00:00.000Z'), 1_000, 'dead-owner')
    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(success('absent'))
    const restarted = createComputeExecution().createCancellationReaper(
      operations,
      jobs,
      { acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease) },
      { now: () => new Date('2026-01-01T00:00:02.000Z') }
    )

    await restarted.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'cancelled'
    })
  })

  it('fences a stale claim after an expired lease is reclaimed', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)
    await owner.request('job-1', scope)
    const stale = await operations.claimNext(
      'cancel',
      new Date('2026-01-01T00:00:00.000Z'),
      1_000,
      'stale-owner'
    )
    const current = await operations.claimNext(
      'cancel',
      new Date('2026-01-01T00:00:02.000Z'),
      1_000,
      'current-owner'
    )
    expect(stale).not.toBeNull()
    expect(current).not.toBeNull()

    await expect(
      operations.retry(
        stale!,
        new Date('2026-01-01T00:00:02.100Z'),
        new Date('2026-01-01T00:00:10.000Z')
      )
    ).resolves.toBe(false)
    await expect(operations.fulfill(stale!, new Date('2026-01-01T00:00:02.200Z'))).resolves.toBe(
      false
    )
    await expect(jobs.get('job-1')).resolves.toMatchObject({ status: 'running' })
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      revision: current!.operation.revision,
      claimToken: 'current-owner'
    })

    await expect(operations.fulfill(current!, new Date('2026-01-01T00:00:03.000Z'))).resolves.toBe(
      true
    )
    await expect(jobs.get('job-1')).resolves.toMatchObject({ status: 'failed' })
  })

  it('reaps encrypted handles only after ComputeJobRepository reveals them', async () => {
    const { client, jobs, operations, createJob } = await setup(true)
    await createJob('running')
    const [{ remoteHandle, remoteWorkdir }] = await client.$queryRaw<
      Array<{ remoteHandle: string; remoteWorkdir: string }>
    >`SELECT "remoteHandle", "remoteWorkdir" FROM "ComputeJob" WHERE "id" = 'job-1'`
    expect(remoteHandle).toContain('open-science:protected')
    expect(remoteWorkdir).toContain('open-science:protected')
    expect(remoteHandle).not.toContain('"pid":4321')

    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(success('absent'))
    const owner = createJobCancellation(operations, jobs)
    const reaper = createComputeExecution().createCancellationReaper(operations, jobs, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })
    await owner.request('job-1', scope)

    await reaper.runOnce()

    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('.openscience/jobs/job-1'),
      expect.anything()
    )
    expect(run.mock.calls[0]?.[0]).toContain('job_pid_is_owned 4321')
    expect(JSON.stringify(run.mock.calls)).not.toContain('open-science:protected')
    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'cancelled'
    })
  })

  it('preserves an encrypted launch handle during cancellation without reviving execution', async () => {
    const { client, jobs, operations, createJob } = await setup(true)
    await createJob('submitted')
    const owner = createJobCancellation(operations, jobs)
    await owner.request('job-1', scope)
    const lifecycle = createJobLifecycle(jobs)
    await expect(lifecycle.dispatchRunning('job-1', remoteHandle)).resolves.toEqual({
      kind: 'ignored'
    })
    await expect(jobs.get('job-1')).resolves.toMatchObject({
      status: 'submitted',
      remote_handle: remoteHandle
    })
    const [stored] = await client.$queryRaw<
      Array<{ remoteHandle: string }>
    >`SELECT "remoteHandle" FROM "ComputeJob" WHERE "id" = 'job-1'`
    expect(stored.remoteHandle).toContain('open-science:protected')
    expect(stored.remoteHandle).not.toContain('4321')
    await lifecycle.dispatchRunning('job-1', remoteHandle.replace('4321', '5678'))
    expect((await jobs.get('job-1'))?.remote_handle).toBe(remoteHandle)
    await expect(
      lifecycle.finishPolled('job-1', {
        status: 'success',
        errorCode: null,
        stdoutTail: null,
        stderrTail: null
      })
    ).resolves.toEqual({ kind: 'ignored' })
    expect((await owner.status('job-1', scope)).cancellation?.status).toBe('cancelling')
  })

  it('linearizes request against a terminal poll CAS', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)

    const [requested, polled] = await Promise.all([
      owner.request('job-1', scope),
      jobs.updateIfStatus('job-1', ['running'], {
        status: 'success',
        finishedAt: new Date()
      })
    ])
    const cancellation = await operations.get('job-1', 'cancel')

    expect(
      (requested.cancellation?.status === 'cancelling' && polled === null) ||
        (requested.status === 'success' && cancellation?.outcome === 'superseded')
    ).toBe(true)
  })

  it('keeps concurrent cancellation requests idempotent through the operation singleton', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)

    const results = await Promise.all([
      owner.request('job-1', scope),
      owner.request('job-1', scope)
    ])

    expect(results).toEqual([
      expect.objectContaining({ cancellation: { status: 'cancelling' } }),
      expect.objectContaining({ cancellation: { status: 'cancelling' } })
    ])
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'active',
      revision: 1
    })
  })

  it('uses the same unavailable error for missing and mismatched owner tuples', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = createJobCancellation(operations, jobs)

    await expect(owner.request('missing', scope)).rejects.toBeInstanceOf(
      ComputeHostUnavailableError
    )
    await expect(
      owner.request('job-1', { ...scope, projectId: 'other-project' })
    ).rejects.toBeInstanceOf(ComputeHostUnavailableError)
  })
})

it.each(['claim', 'read', 'retry'] as const)(
  'contains background cancellation %s failures and permits another tick',
  async (stage) => {
    const failure = new Error('cancellation store unavailable')
    const failures: unknown[] = []
    const observe = (error: unknown): void => {
      failures.push(error)
    }
    const claimNext = vi.fn().mockResolvedValue(null)
    if (stage === 'claim') claimNext.mockRejectedValueOnce(failure)
    else claimNext.mockResolvedValueOnce({ jobId: 'job-1', operation: { attemptCount: 0 } })
    const retry = vi.fn().mockRejectedValue(failure)
    const get =
      stage === 'read'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue({ job_id: 'job-1', provider_id: 'host-1' })
    const reaper = createComputeExecution().createCancellationReaper(
      { claimNext, retry } as never,
      { get } as never,
      { acquire: vi.fn().mockRejectedValue(new Error('offline')) } as never,
      { intervalMs: 10 }
    )
    process.on('unhandledRejection', observe)
    try {
      reaper.start()
      await vi.waitFor(() => expect(claimNext.mock.calls.length).toBeGreaterThanOrEqual(2))
      if (stage === 'retry') expect(retry).toHaveBeenCalledOnce()
      expect(failures).toEqual([])
    } finally {
      await reaper.stop()
      process.off('unhandledRejection', observe)
    }
  }
)

it('reports an in-flight cancellation failure to stop without abandoning background error handling', async () => {
  let reject!: (error: Error) => void
  const failure = new Error('claim failed during stop')
  const claim = new Promise<null>((_resolve, rejectClaim) => {
    reject = rejectClaim
  })
  const reaper = createComputeExecution().createCancellationReaper(
    { claimNext: () => claim } as never,
    {} as never,
    {} as never
  )
  reaper.start()
  const stopped = expect(reaper.stop()).rejects.toBe(failure)
  reject(failure)
  await stopped
})
