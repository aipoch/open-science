import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemSshRunner } from './ssh-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComputeHostUnavailableError } from '../../shared/compute'
import { createProjectDbClient } from '../projects/prisma-client'
import type { ComputeConnectionBrokerAcquirer, ComputeConnectionLease } from './connection-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import {
  ComputeJobCancellationOwner,
  ComputeJobCancellationReaper
} from './compute-job-cancellation-owner'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
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
    const operations = database.repositories.operations
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

  it.each(['owned', 'absent', 'mismatch', 'truncated-stdout', 'truncated-termination'] as const)(
    'uses complete stdout evidence with truncated SSH banners: %s',
    async (evidence) => {
      const { jobs, operations, createJob } = await setup()
      await createJob('running')
      const directory = await mkdtemp(join(tmpdir(), 'cancellation-transport-'))
      try {
        const executable = join(directory, 'ssh-fixture.cjs')
        // A real child process exercises SystemSshRunner's per-stream byte accounting.
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
        const runner = new SystemSshRunner()
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
        const owner = new ComputeJobCancellationOwner(operations, jobs)
        const reaper = new ComputeJobCancellationReaper(operations, jobs, broker)
        await owner.request('job-1', scope)
        await reaper.runOnce()
        await expect(owner.status('job-1', scope)).resolves.toMatchObject({
          status: evidence.startsWith('truncated-') ? 'running' : 'failed',
          cancellation_status: evidence.startsWith('truncated-') ? 'cancelling' : 'cancelled'
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
    const owner = new ComputeJobCancellationOwner(operations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      job_id: 'job-1',
      status: 'failed',
      cancellation_status: 'cancelled'
    })
    const reaper = new ComputeJobCancellationReaper(operations, jobs, {
      acquire
    } as unknown as ComputeConnectionBrokerAcquirer)
    await reaper.runOnce()

    expect(acquire).not.toHaveBeenCalled()
    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelled'
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
      const owner = new ComputeJobCancellationOwner(operations, jobs)
      const onConfirmed = vi.fn()
      const reaper = new ComputeJobCancellationReaper(operations, jobs, broker, { onConfirmed })

      await expect(owner.request('job-1', scope)).resolves.toMatchObject({
        status: 'running',
        cancellation_status: 'cancelling'
      })
      expect(onConfirmed).not.toHaveBeenCalled()
      await reaper.runOnce()

      await expect(owner.status('job-1', scope)).resolves.toMatchObject({
        status: 'failed',
        cancellation_status: 'cancelled'
      })
      expect(run).toHaveBeenCalledTimes(evidence === 'owned' ? 2 : 1)
      expect(onConfirmed).toHaveBeenCalledWith('job-1')
    }
  )

  it('settles a requested cancellation after owned remote cleanup succeeds', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelling'
    })

    await expect(
      operations.fulfillCancellationAfterRemoteCleanup(
        'job-1',
        scope,
        new Date('2026-01-01T00:00:00.000Z')
      )
    ).resolves.toBe(true)
    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'failed',
      cancellation_status: 'cancelled'
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
    const owner = new ComputeJobCancellationOwner(operations, jobs)
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
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    const reaper = new ComputeJobCancellationReaper(operations, jobs, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })

    await owner.request('job-1', scope)
    await reaper.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelling'
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
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    const reaper = new ComputeJobCancellationReaper(operations, jobs, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })

    await owner.request('job-1', scope)
    await reaper.runOnce()

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.some(([command]) => command.startsWith('scancel '))).toBe(false)
    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      status: 'running',
      cancellation_status: 'cancelling'
    })
  })

  it('supersedes cancellation when the job was terminal first', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('success')
    const owner = new ComputeJobCancellationOwner(operations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      status: 'success',
      cancellation_status: undefined
    })
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'settled',
      outcome: 'superseded'
    })
  })

  it('recovers an expired claim after restart', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    await owner.request('job-1', scope)
    await operations.claimNext('cancel', new Date('2026-01-01T00:00:00.000Z'), 1_000, 'dead-owner')
    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(success('absent'))
    const restarted = new ComputeJobCancellationReaper(
      operations,
      jobs,
      { acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease) },
      { now: () => new Date('2026-01-01T00:00:02.000Z') }
    )

    await restarted.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelled'
    })
  })

  it('fences a stale claim after an expired lease is reclaimed', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)
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
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    const reaper = new ComputeJobCancellationReaper(operations, jobs, {
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
      cancellation_status: 'cancelled'
    })
  })

  it('preserves an encrypted launch handle during cancellation without reviving execution', async () => {
    const { client, jobs, operations, createJob } = await setup(true)
    await createJob('submitted')
    const owner = new ComputeJobCancellationOwner(operations, jobs)
    await owner.request('job-1', scope)
    const lifecycle = new ComputeJobLifecycle(jobs)
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
    expect((await owner.status('job-1', scope)).cancellation_status).toBe('cancelling')
  })

  it('linearizes request against a terminal poll CAS', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)

    const [requested, polled] = await Promise.all([
      owner.request('job-1', scope),
      jobs.updateIfStatus('job-1', ['running'], {
        status: 'success',
        finishedAt: new Date()
      })
    ])
    const cancellation = await operations.get('job-1', 'cancel')

    expect(
      (requested.cancellation_status === 'cancelling' && polled === null) ||
        (requested.status === 'success' && cancellation?.outcome === 'superseded')
    ).toBe(true)
  })

  it('keeps concurrent cancellation requests idempotent through the operation singleton', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)

    const results = await Promise.all([
      owner.request('job-1', scope),
      owner.request('job-1', scope)
    ])

    expect(results).toEqual([
      expect.objectContaining({ cancellation_status: 'cancelling' }),
      expect.objectContaining({ cancellation_status: 'cancelling' })
    ])
    await expect(operations.get('job-1', 'cancel')).resolves.toMatchObject({
      phase: 'active',
      revision: 1
    })
  })

  it('uses the same unavailable error for missing and mismatched owner tuples', async () => {
    const { jobs, operations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(operations, jobs)

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
    const reaper = new ComputeJobCancellationReaper(
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
  const reaper = new ComputeJobCancellationReaper(
    { claimNext: () => claim } as never,
    {} as never,
    {} as never
  )
  reaper.start()
  const stopped = expect(reaper.stop()).rejects.toBe(failure)
  reject(failure)
  await stopped
})
