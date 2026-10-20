import { mkdir, writeFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import {
  createComputeExecution,
  createJobCancellation,
  createJobLifecycle
} from '@aipoch/compute/node'
import type { ComputeConnectionLease } from '@aipoch/compute/node'
import type { ComputeHostRepository } from '@aipoch/compute'
import { describe, expect, it, vi } from 'vitest'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeJobRepository } from './job-repository'
import { OptionalSecureStorageStringProtection } from './credential-vault'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'

const scope = { projectId: 'p', sessionId: 's', providerId: 'ssh:test' }
const gate = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const result = (stdout = '', exitCode = 0): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  stdout,
  exitCode,
  stderr: '',
  truncated: false,
  timedOut: false
})
const hosts = {
  get: async () => ({
    id: 'host',
    providerId: scope.providerId,
    displayName: 'Test',
    shape: 'direct_ssh',
    sshAlias: 'test',
    sshOverrides: undefined,
    concurrencyLimit: undefined,
    probeResult: undefined,
    detailsUpdatedAt: undefined,
    detailsUpdatedBy: undefined,
    scratchRoot: '/scratch',
    scratchPinned: false,
    detailsDoc: '',
    createdAt: 1,
    updatedAt: 1
  }),
  updateConcurrencyLimit: async () => undefined
} satisfies ComputeHostRepository

describe('durable cancellation after authoritative no-launch response', () => {
  it.each([
    ['prepare', false],
    ['connection', false],
    ['prepare', true],
    ['connection', true]
  ] as const)(
    'converges after restart when cancellation wins %s failure (encrypted=%s)',
    async (failure, encrypted) => {
      const db = await createMigratedComputeTestDatabase('compute-no-launch-')
      try {
        const protection = new OptionalSecureStorageStringProtection(
          {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'gnome_libsecret',
            encryptString: (value) => Buffer.from(`ciphertext:${value}`),
            decryptString: (value) => value.toString('utf8').replace(/^ciphertext:/, '')
          },
          'linux'
        )
        const jobs = encrypted
          ? new ComputeJobRepository(async () => db.client, protection)
          : db.repositories.jobs
        await jobs.create({
          id: 'j',
          ...scope,
          shape: 'direct_ssh',
          intent: 'test',
          command: 'true',
          commandHash: 'hash',
          initialStatus: 'submitted',
          remoteWorkdir: `${process.platform === 'win32' ? '/scratch' : db.storageRoot}/.open-science/jobs/j`,
          allowUnencryptedPersistence: !encrypted
        })
        const stagedDirectory = `${db.storageRoot}/.open-science/jobs/j`
        if (failure === 'prepare' && process.platform !== 'win32') {
          await mkdir(stagedDirectory, { recursive: true })
          await writeFile(`${stagedDirectory}/staged-input`, 'retained until cleanup')
        }
        const entered = gate()
        const release = gate()
        const run = vi.fn<ComputeConnectionLease['run']>(async () => {
          entered.release()
          await release.promise
          return result('OPEN_SCIENCE_DISPATCH_PRE_LAUNCH_FAILED_V1', 73)
        })
        const broker = {
          acquire: async () => {
            if (failure === 'connection') {
              entered.release()
              await release.promise
              throw new Error('authentication failed')
            }
            return { run, upload: async () => undefined, download: vi.fn() }
          }
        }
        const execution = createComputeExecution()
        const dispatch = execution.dispatchJob('j', {
          jobRepository: jobs,
          hostRepository: hosts,
          connectionBroker: broker
        })
        await entered.promise
        await createJobCancellation(db.repositories.operations, jobs).request('j', scope)
        await execution
          .createCancellationReaper(db.repositories.operations, jobs, broker, {
            retryDelayMs: () => 0
          })
          .runOnce()
        expect(await db.repositories.operations.get('j', 'cancel')).toMatchObject({
          phase: 'active'
        })
        expect(await jobs.get('j')).toMatchObject({ status: 'submitted' })
        release.release()
        await dispatch
        expect(execution.isDispatching('j')).toBe(false)
        if (encrypted) {
          const row = await db.client.computeJob.findUniqueOrThrow({ where: { id: 'j' } })
          expect(row.lastPollError).not.toContain('dispatch_definitely_not_started')
        }
        const recoveredJobs = new ComputeJobRepository(
          async () => db.client,
          encrypted ? protection : undefined
        )
        const recoveredOperations = new ComputeJobOperationRepository(
          async () => db.client,
          encrypted ? protection : undefined
        )
        const cleanupRun = vi.fn(async () =>
          result('OPEN_SCIENCE_DISPATCH_RECOVERY_V1\nworkdir:0\nexit_code:\npid:\ncwd_match:0')
        )
        await createComputeExecution()
          .createCancellationReaper(recoveredOperations, recoveredJobs, {
            acquire: async () => ({ run: cleanupRun, upload: vi.fn(), download: vi.fn() })
          })
          .runOnce()
        expect(await recoveredOperations.get('j', 'cancel')).toMatchObject({
          phase: 'settled',
          outcome: 'fulfilled'
        })
        expect(await recoveredJobs.get('j')).toMatchObject({
          status: 'failed',
          last_poll_error: 'dispatch_definitely_not_started'
        })
        expect((await recoveredJobs.get('j'))?.harvested_at).toBeDefined()
        expect(await recoveredJobs.findTerminalUnharvested()).toEqual([])
        if (failure === 'prepare' && process.platform !== 'win32') {
          await expect(access(`${stagedDirectory}/staged-input`)).resolves.toBeUndefined()
        }
        expect((await recoveredJobs.get('j'))?.remote_cleanup_disposition).not.toBe('cleaned')
        expect(cleanupRun).not.toHaveBeenCalled()
        // POSIX shell enhancement; all durable race/claim assertions above run on Windows too.
        if (process.platform !== 'win32') {
          const deletion = createComputeExecution().createDeletionOwner({
            jobRepository: recoveredJobs,
            hostRepository: {
              ...hosts,
              get: async () => ({ ...(await hosts.get()), scratchRoot: db.storageRoot })
            },
            queueManager: { pauseOwner: async () => undefined, resumeOwner: () => undefined },
            connectionBroker: {
              acquire: async () => ({
                run: async (command) => {
                  const shell = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
                  return { ...result(shell.stdout, shell.status ?? 1), stderr: shell.stderr }
                },
                upload: vi.fn(),
                download: vi.fn()
              })
            }
          })
          await deletion.prepareSessionJobDeletion(scope.projectId, scope.sessionId)
          await deletion.commitSessionJobDeletion(scope.projectId, scope.sessionId)
          expect(await recoveredJobs.get('j')).toBeNull()
        }
      } finally {
        await db.dispose()
      }
    }
  )
})

describe('no-launch evidence fences', () => {
  it.each([
    'settled-operation',
    'terminal',
    'handle',
    'changed-diagnostic',
    'changed-scope',
    'changed-workdir',
    'changed-command',
    'changed-created-at',
    'changed-mode',
    'deleted-row'
  ] as const)('does not overwrite %s', async (scenario) => {
    const db = await createMigratedComputeTestDatabase('compute-no-launch-fence-')
    try {
      const jobs = db.repositories.jobs
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'direct_ssh',
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        allowUnencryptedPersistence: true
      })
      await jobs.update('j', { lastPollError: 'dispatch_may_have_started' })
      const expected = (await jobs.get('j'))!
      await db.repositories.operations.request('j', 'cancel', scope, new Date())
      if (scenario === 'settled-operation')
        await db.client.computeJobOperation.updateMany({
          data: { phase: 'settled', outcome: 'superseded', settledAt: new Date() }
        })
      if (scenario === 'terminal')
        await db.client.computeJob.update({ where: { id: 'j' }, data: { status: 'success' } })
      if (scenario === 'handle')
        await db.client.computeJob.update({
          where: { id: 'j' },
          data: {
            remoteHandle: JSON.stringify({
              pid: 123,
              workdir: '/scratch/.open-science/jobs/j',
              exit_code_path: '/scratch/.open-science/jobs/j/exit_code',
              stdout_path: '/scratch/.open-science/jobs/j/stdout',
              stderr_path: '/scratch/.open-science/jobs/j/stderr'
            })
          }
        })
      if (scenario === 'changed-diagnostic')
        await db.client.computeJob.update({
          where: { id: 'j' },
          data: { lastPollError: 'new observer' }
        })
      if (scenario === 'changed-scope')
        await db.client.computeJob.update({ where: { id: 'j' }, data: { sessionId: 'other' } })
      if (scenario === 'changed-workdir')
        await db.client.computeJob.update({
          where: { id: 'j' },
          data: { remoteWorkdir: '/another/.open-science/jobs/j' }
        })
      if (scenario === 'changed-command')
        await db.client.computeJob.update({ where: { id: 'j' }, data: { commandHash: 'other' } })
      if (scenario === 'changed-created-at')
        await db.client.computeJob.update({ where: { id: 'j' }, data: { createdAt: new Date(1) } })
      if (scenario === 'changed-mode')
        await db.client.computeJob.update({ where: { id: 'j' }, data: { executionMode: 'slurm' } })
      if (scenario === 'deleted-row') await jobs.beginOwnerDeletion(scope)
      if (scenario === 'deleted-row') await jobs.deleteByOwner(scope)
      const before = await jobs.get('j')
      await jobs.recordDispatchNoLaunch(expected)
      expect(await jobs.get('j')).toEqual(before)
    } finally {
      await db.dispose()
    }
  })

  it('keeps cancellation requested after definitive failure superseded', async () => {
    const db = await createMigratedComputeTestDatabase('compute-no-launch-order-')
    try {
      const jobs = db.repositories.jobs
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'direct_ssh',
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        allowUnencryptedPersistence: true
      })
      await createJobLifecycle(jobs).dispatchError('j', {
        errorCode: 'dispatch_failed',
        definitelyNotStarted: true
      })
      await db.repositories.operations.request('j', 'cancel', scope, new Date())
      expect(await db.repositories.operations.get('j', 'cancel')).toMatchObject({
        phase: 'settled',
        outcome: 'superseded'
      })
      expect(await jobs.get('j')).toMatchObject({ status: 'error', error_code: 'dispatch_failed' })
    } finally {
      await db.dispose()
    }
  })

  it('retains active claim ownership and rejects a stale claimant', async () => {
    const db = await createMigratedComputeTestDatabase('compute-no-launch-claim-')
    try {
      const { jobs, operations } = db.repositories
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'direct_ssh',
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        allowUnencryptedPersistence: true
      })
      await operations.request('j', 'cancel', scope, new Date(0))
      const first = await operations.claimNext('cancel', new Date(1), 10, 'first')
      const second = await operations.claimNext('cancel', new Date(12), 10, 'second')
      const before = await operations.get('j', 'cancel')
      await createJobLifecycle(jobs).dispatchError('j', {
        errorCode: 'dispatch_failed',
        definitelyNotStarted: true
      })
      expect(await operations.get('j', 'cancel')).toEqual(before)
      expect(await jobs.get('j')).toMatchObject({
        status: 'submitted',
        last_poll_error: 'dispatch_definitely_not_started'
      })
      expect(await operations.fulfill(first!, new Date(13))).toBe(false)
      expect(await operations.fulfill(second!, new Date(13))).toBe(true)
    } finally {
      await db.dispose()
    }
  })
})

describe('owner deletion keeps dispatch no-launch authority', () => {
  it.each(
    (
      [
        ['prepare', false],
        ['prepare', true],
        ['slurm-auth', false],
        ['slurm-auth', true],
        ['unknown', false],
        ['unknown', true]
      ] as const
    ).flatMap(([failure, cancel]) =>
      [false, true].map((restart) => [failure, cancel, restart] as const)
    )
  )(
    'settles %s with cancellation=%s after owner fence (restart=%s)',
    async (failure, cancel, restart) => {
      const db = await createMigratedComputeTestDatabase('compute-owner-no-launch-')
      try {
        const jobs = db.repositories.jobs
        const workdir = `${process.platform === 'win32' ? '/scratch' : db.storageRoot}/.open-science/jobs/j`
        await jobs.create({
          id: 'j',
          ...scope,
          shape: failure === 'slurm-auth' ? 'scheduler_cluster' : 'direct_ssh',
          executionMode: failure === 'slurm-auth' ? 'slurm' : 'direct_ssh',
          intent: 'test',
          command: 'true',
          commandHash: 'hash',
          initialStatus: 'submitted',
          remoteWorkdir: workdir,
          allowUnencryptedPersistence: true
        })
        const entered = gate(),
          release = gate(),
          fenced = gate()
        const execution = createComputeExecution()
        const originalBegin = jobs.beginOwnerDeletion.bind(jobs)
        jobs.beginOwnerDeletion = async (owner) => {
          await originalBegin(owner)
          fenced.release()
        }
        const dispatch = execution.dispatchJob('j', {
          jobRepository: jobs,
          hostRepository: hosts,
          connectionBroker: {
            acquire: async () => {
              if (failure === 'slurm-auth') {
                entered.release()
                await release.promise
                throw new Error('auth denied')
              }
              return {
                run: async () => {
                  entered.release()
                  await release.promise
                  if (failure === 'unknown') throw new Error('response lost')
                  return result('OPEN_SCIENCE_DISPATCH_PRE_LAUNCH_FAILED_V1', 73)
                },
                upload: vi.fn(),
                download: vi.fn()
              }
            }
          }
        })
        await entered.promise
        if (cancel) await db.repositories.operations.request('j', 'cancel', scope, new Date())
        const cleanupBroker = {
          acquire: async () => ({
            run: async (command: string) => {
              const shell = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
              return { ...result(shell.stdout, shell.status ?? 1), stderr: shell.stderr }
            },
            upload: vi.fn(),
            download: vi.fn()
          })
        }
        const ownerDeps = {
          jobRepository: jobs,
          hostRepository: {
            ...hosts,
            get: async () => ({ ...(await hosts.get()), scratchRoot: db.storageRoot })
          },
          connectionBroker: cleanupBroker
        }
        const owner = execution.createDeletionOwner(ownerDeps)
        const prepare = owner.prepareSessionJobDeletion(scope.projectId, scope.sessionId)
        await fenced.promise
        release.release()
        await dispatch
        await prepare
        expect((await jobs.get('j'))?.last_poll_error).toBe(
          failure === 'unknown' ? 'dispatch_may_have_started' : 'dispatch_definitely_not_started'
        )
        expect((await jobs.get('j'))?.status).toBe('submitted')
        if (process.platform !== 'win32') {
          if (failure === 'unknown') {
            await expect(
              owner.commitSessionJobDeletion(scope.projectId, scope.sessionId)
            ).rejects.toThrow()
            expect(await jobs.get('j')).not.toBeNull()
          } else {
            const recovered = new ComputeJobRepository(async () => db.client)
            const restartedOwner = restart
              ? createComputeExecution().createDeletionOwner({
                  ...ownerDeps,
                  jobRepository: recovered
                })
              : owner
            if (restart)
              await restartedOwner.prepareSessionJobDeletion(scope.projectId, scope.sessionId)
            await restartedOwner.commitSessionJobDeletion(scope.projectId, scope.sessionId)
            expect(await recovered.get('j')).toBeNull()
          }
        }
      } finally {
        await db.dispose()
      }
    }
  )
})
