import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createComputeExecution,
  createJobLifecycle,
  hasCleanupStopEvidence
} from '@aipoch/compute/node'
import type { ComputeConnectionLease } from '@aipoch/compute/node'
import type { ComputeHostRepository } from '@aipoch/compute'
import { describe, expect, it, vi } from 'vitest'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeJobRepository } from './job-repository'
import { OptionalSecureStorageStringProtection } from './credential-vault'

type RunResult = Awaited<ReturnType<ComputeConnectionLease['run']>>

const runCleanupShell = (command: string, storageRoot: string): RunResult => {
  if (process.platform !== 'win32') {
    const shell = spawnSync('sh', ['-c', command], { encoding: 'utf8' })
    return {
      stdout: shell.stdout,
      stderr: shell.stderr,
      exitCode: shell.status ?? 1,
      truncated: false,
      timedOut: false
    }
  }
  if (command.includes('echo owned')) {
    return { stdout: 'mismatch', stderr: '', exitCode: 0, truncated: false, timedOut: false }
  }
  // Windows runs the same durable owner/repository lifecycle through a transport adapter.
  // POSIX shell safety remains exercised on Unix and in the live Linux SSH certification.
  if (command.includes('rm -rf -- "$workdir"')) {
    for (const id of ['j', 'k']) {
      const workdir = join(storageRoot, `.open-science/jobs/${id}`).replaceAll('\\', '/')
      if (command.includes(workdir)) rmSync(workdir, { recursive: true, force: true })
    }
  }
  return { stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false }
}

const scope = { projectId: 'p', sessionId: 's', providerId: 'ssh:test' }

describe('remote cleanup retry after durable row deletion failure', () => {
  it.each([
    ['slurm', false],
    ['slurm', true],
    ['direct_ssh', false],
    ['direct_ssh', true],
    ['slurm', 'initially-absent']
  ] as const)('retries %s real shell cleanup across restart=%s', async (mode, restart) => {
    const db = await createMigratedComputeTestDatabase('compute-cleanup-retry-')
    try {
      const workdir = join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/')
      if (restart !== 'initially-absent') mkdirSync(workdir, { recursive: true })
      const jobs = db.repositories.jobs
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'scheduler_cluster',
        executionMode: mode,
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        remoteWorkdir: workdir,
        allowUnencryptedPersistence: true
      })
      await jobs.update('j', {
        remoteHandle: JSON.stringify(
          mode === 'slurm'
            ? {
                driver: 'slurm',
                version: 1,
                scheduler_job_id: '123',
                workdir,
                stdout_path: `${workdir}/stdout`,
                stderr_path: `${workdir}/stderr`
              }
            : {
                pid: process.pid,
                workdir,
                exit_code_path: `${workdir}/exit_code`,
                stdout_path: `${workdir}/stdout`,
                stderr_path: `${workdir}/stderr`
              }
        )
      })
      const run: ComputeConnectionLease['run'] = async (command) => {
        if (command.startsWith('scancel '))
          return { stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false }
        if (command.startsWith('squeue '))
          return { stdout: 'CANCELLED', stderr: '', exitCode: 0, truncated: false, timedOut: false }
        return runCleanupShell(command, db.storageRoot)
      }
      const deps = {
        hostRepository: {
          get: async () => ({ providerId: scope.providerId, scratchRoot: db.storageRoot })
        } as unknown as ComputeHostRepository,
        connectionBroker: { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) }
      }
      const owner = createComputeExecution().createDeletionOwner({ ...deps, jobRepository: jobs })
      await db.client.$executeRawUnsafe(
        "CREATE TRIGGER fail_cleanup_delete BEFORE DELETE ON ComputeJob BEGIN SELECT RAISE(ABORT, 'injected SQLite delete failure'); END"
      )
      await owner.prepareSessionJobDeletion('p', 's')
      await expect(owner.commitSessionJobDeletion('p', 's')).rejects.toThrow(
        'Foreign key constraint'
      )
      await db.client.$executeRawUnsafe('DROP TRIGGER fail_cleanup_delete')
      expect(existsSync(workdir)).toBe(false)
      expect(await jobs.get('j')).not.toBeNull()
      if (restart) {
        const recoveredJobs = new ComputeJobRepository(async () => db.client)
        const recovered = createComputeExecution().createDeletionOwner({
          ...deps,
          jobRepository: recoveredJobs
        })
        await recovered.prepareSessionJobDeletion('p', 's')
        await recovered.commitSessionJobDeletion('p', 's')
      } else await owner.commitSessionJobDeletion('p', 's')
      expect(await jobs.get('j')).toBeNull()
    } finally {
      await db.dispose()
    }
  })
})

it.each(['persist', 'before-rm', 'after-rm', 'partial-job'] as const)(
  'recovers cleanup after %s failure without losing stopped evidence',
  async (fault) => {
    const db = await createMigratedComputeTestDatabase('compute-cleanup-window-')
    try {
      const jobs = db.repositories.jobs
      const ids = fault === 'partial-job' ? ['j', 'k'] : ['j']
      for (const id of ids) {
        const workdir = join(db.storageRoot, `.open-science/jobs/${id}`).replaceAll('\\', '/')
        mkdirSync(workdir, { recursive: true })
        await jobs.create({
          id,
          ...scope,
          shape: 'scheduler_cluster',
          executionMode: 'slurm',
          intent: 'test',
          command: 'true',
          commandHash: 'hash',
          initialStatus: 'submitted',
          remoteWorkdir: workdir,
          allowUnencryptedPersistence: true
        })
        await jobs.update(id, {
          remoteHandle: JSON.stringify({
            driver: 'slurm',
            version: 1,
            scheduler_job_id: id === 'j' ? '123' : '456',
            workdir,
            stdout_path: `${workdir}/stdout`,
            stderr_path: `${workdir}/stderr`
          })
        })
      }
      let armed = true
      const result = (stdout = '', exitCode = 0): RunResult => ({
        stdout,
        stderr: '',
        exitCode,
        truncated: false,
        timedOut: false
      })
      const run = vi.fn<ComputeConnectionLease['run']>(async (command) => {
        if (command.startsWith('scancel ')) return result()
        if (command.startsWith('squeue ')) return result('CANCELLED')
        const destructive = command.includes('rm -rf -- "$workdir"')
        const targetFault = destructive && (fault !== 'partial-job' || command.includes('/jobs/k'))
        if (armed && targetFault && (fault === 'before-rm' || fault === 'partial-job')) {
          armed = false
          throw new Error('injected before rm')
        }
        const shell = runCleanupShell(command, db.storageRoot)
        if (armed && targetFault && fault === 'after-rm') {
          armed = false
          throw new Error('injected response loss after rm')
        }
        return shell
      })
      const deps = {
        hostRepository: {
          get: async () => ({ providerId: scope.providerId, scratchRoot: db.storageRoot })
        } as unknown as ComputeHostRepository,
        connectionBroker: { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) }
      }
      const owner = createComputeExecution().createDeletionOwner({ ...deps, jobRepository: jobs })
      if (fault === 'persist')
        await db.client.$executeRawUnsafe(
          "CREATE TRIGGER fail_stop_evidence BEFORE UPDATE OF lastPollError ON ComputeJob BEGIN SELECT RAISE(ABORT, 'stop evidence write failure'); END"
        )
      await owner.prepareSessionJobDeletion('p', 's')
      await expect(owner.commitSessionJobDeletion('p', 's')).rejects.toThrow()
      expect(await jobs.get('j')).not.toBeNull()
      if (fault === 'persist') {
        expect(existsSync(join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/'))).toBe(
          true
        )
        expect(run.mock.calls.some(([command]) => command.includes('rm -rf -- "$workdir"'))).toBe(
          false
        )
        expect((await jobs.get('j'))?.last_poll_error).toBeUndefined()
        await db.client.$executeRawUnsafe('DROP TRIGGER fail_stop_evidence')
      } else {
        expect((await jobs.get('j'))?.last_poll_error).toContain('remote_cleanup_stopped_v1:')
        expect(existsSync(join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/'))).toBe(
          fault === 'before-rm'
        )
        // Neither a new poll result nor cancellation settlement may erase stopped evidence.
        await jobs.update('j', { lastPollError: 'transient transport error' })
        expect((await jobs.get('j'))?.last_poll_error).toContain('remote_cleanup_stopped_v1:')
      }
      if (fault === 'before-rm') {
        await owner.abortSessionJobDeletion('p', 's')
        expect(
          await jobs.updateIfStatus('j', ['submitted'], { lastPollError: null })
        ).not.toBeNull()
        expect(hasCleanupStopEvidence((await jobs.get('j'))!)).toBe(true)
      }
      if (fault === 'after-rm') {
        await db.repositories.operations.request('j', 'cancel', scope, new Date())
        expect(
          await db.repositories.operations.fulfillCancellationAfterRemoteCleanup(
            'j',
            scope,
            new Date()
          )
        ).toBe(true)
        expect(hasCleanupStopEvidence((await jobs.get('j'))!)).toBe(true)
      }
      const callsBeforeRestart = run.mock.calls.length
      const recoveredJobs = new ComputeJobRepository(async () => db.client)
      const recovered = createComputeExecution().createDeletionOwner({
        ...deps,
        jobRepository: recoveredJobs
      })
      await recovered.prepareSessionJobDeletion('p', 's')
      await recovered.commitSessionJobDeletion('p', 's')
      for (const id of ids) {
        expect(await recoveredJobs.get(id)).toBeNull()
        expect(
          existsSync(join(db.storageRoot, `.open-science/jobs/${id}`).replaceAll('\\', '/'))
        ).toBe(false)
      }
      if (fault !== 'persist')
        expect(
          run.mock.calls
            .slice(callsBeforeRestart)
            .every(([command]) => command.includes('rm -rf -- "$workdir"'))
        ).toBe(true)
    } finally {
      await db.dispose()
    }
  }
)

it.each(['update', 'updateIfStatus', 'observeRunning'] as const)(
  'does not erase encrypted stop evidence when %s cannot decrypt its snapshot',
  async (method) => {
    const db = await createMigratedComputeTestDatabase('compute-locked-stop-')
    let locked = false
    const protection = new OptionalSecureStorageStringProtection(
      {
        isEncryptionAvailable: () => !locked,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => {
          if (locked) throw new Error('keyring locked')
          return value.toString()
        }
      },
      'linux'
    )
    const jobs = new ComputeJobRepository(async () => db.client, protection)
    try {
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'direct_ssh',
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        remoteWorkdir: '/scratch/.open-science/jobs/j'
      })
      const observed = (await jobs.get('j'))!
      await jobs.recordRemoteCleanupStopped(observed, observed.remote_workdir!)
      const before = await db.client.computeJob.findUniqueOrThrow({ where: { id: 'j' } })
      locked = true
      const update =
        method === 'update'
          ? jobs.update('j', { lastPollError: null })
          : method === 'updateIfStatus'
            ? jobs.updateIfStatus('j', ['submitted'], { lastPollError: null })
            : createJobLifecycle(jobs).observeRunning('j', 'submitted', {
                stdoutTail: null,
                stderrTail: null
              })
      await expect(update).rejects.toThrow('unreadable')
      const after = await db.client.computeJob.findUniqueOrThrow({ where: { id: 'j' } })
      expect(after.lastPollError).toBe(before.lastPollError)
      expect(after.status).toBe(before.status)
      locked = false
      const recovered = new ComputeJobRepository(async () => db.client, protection)
      expect(hasCleanupStopEvidence((await recovered.get('j'))!)).toBe(true)
    } finally {
      await db.dispose()
    }
  }
)

it.each([
  'active-slurm-no-launch',
  'settled-slurm-no-launch',
  'settled-direct',
  'recovered-slurm-handle'
] as const)('revalidates a retained cleanup plan after %s', async (transition) => {
  const db = await createMigratedComputeTestDatabase('compute-fresh-cleanup-')
  try {
    const jobs = db.repositories.jobs
    const mode = transition === 'settled-direct' ? 'direct_ssh' : 'slurm'
    const workdir = join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/')
    mkdirSync(workdir, { recursive: true })
    await jobs.create({
      id: 'j',
      ...scope,
      shape: mode === 'slurm' ? 'scheduler_cluster' : 'direct_ssh',
      executionMode: mode,
      intent: 'test',
      command: 'true',
      commandHash: 'hash',
      initialStatus: 'submitted',
      remoteWorkdir: workdir,
      allowUnencryptedPersistence: true
    })
    if (mode === 'direct_ssh')
      await jobs.update('j', {
        remoteHandle: JSON.stringify({
          pid: process.pid,
          workdir,
          exit_code_path: `${workdir}/exit_code`,
          stdout_path: `${workdir}/stdout`,
          stderr_path: `${workdir}/stderr`
        })
      })
    if (transition.includes('no-launch'))
      await jobs.update('j', { lastPollError: 'dispatch_definitely_not_started' })
    const run = vi.fn<ComputeConnectionLease['run']>(async (command) => {
      if (command.startsWith('scancel '))
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false }
      if (command.startsWith('squeue '))
        return { stdout: 'CANCELLED', stderr: '', exitCode: 0, timedOut: false, truncated: false }
      return runCleanupShell(command, db.storageRoot)
    })
    const connectionBroker = { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) }
    const hostRepository = {
      get: async () => ({ providerId: scope.providerId, scratchRoot: db.storageRoot })
    } as unknown as ComputeHostRepository
    const execution = createComputeExecution()
    const owner = execution.createDeletionOwner({
      jobRepository: jobs,
      hostRepository,
      connectionBroker
    })
    if (transition.startsWith('settled'))
      await db.repositories.operations.request('j', 'cancel', scope, new Date())
    await owner.prepareSessionJobDeletion('p', 's')
    if (transition === 'recovered-slurm-handle') {
      await jobs.update('j', {
        remoteHandle: JSON.stringify({
          driver: 'slurm',
          version: 1,
          scheduler_job_id: '123',
          workdir,
          stdout_path: `${workdir}/stdout`,
          stderr_path: `${workdir}/stderr`
        })
      })
    } else if (transition.startsWith('settled')) {
      await execution
        .createCancellationReaper(db.repositories.operations, jobs, connectionBroker)
        .runOnce()
      expect((await jobs.get('j'))?.status).toBe('failed')
    }
    await db.client.$executeRawUnsafe(
      "CREATE TRIGGER fail_fresh_delete BEFORE DELETE ON ComputeJob BEGIN SELECT RAISE(ABORT, 'retry deletion'); END"
    )
    await expect(owner.commitSessionJobDeletion('p', 's')).rejects.toThrow('Foreign key constraint')
    expect(hasCleanupStopEvidence((await jobs.get('j'))!)).toBe(true)
    expect(existsSync(workdir)).toBe(false)
    await db.client.$executeRawUnsafe('DROP TRIGGER fail_fresh_delete')
    await owner.commitSessionJobDeletion('p', 's')
    expect(await jobs.get('j')).toBeNull()
    if (transition.includes('no-launch'))
      expect(
        run.mock.calls.every(([command]) => !/squeue|sacct|scancel|scheduler_job_id/.test(command))
      ).toBe(true)
    if (transition === 'recovered-slurm-handle')
      expect(run.mock.calls.some(([command]) => command === 'scancel 123')).toBe(true)
  } finally {
    await db.dispose()
  }
})

it.each(['diagnostic', 'status'] as const)(
  'keeps the stop CAS strict when %s changes during remote confirmation, then retries fresh',
  async (change) => {
    const db = await createMigratedComputeTestDatabase('compute-stop-cas-')
    try {
      const jobs = db.repositories.jobs
      const workdir = join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/')
      mkdirSync(workdir, { recursive: true })
      await jobs.create({
        id: 'j',
        ...scope,
        shape: 'direct_ssh',
        intent: 'test',
        command: 'true',
        commandHash: 'hash',
        initialStatus: 'submitted',
        remoteWorkdir: workdir,
        allowUnencryptedPersistence: true
      })
      await jobs.update('j', {
        remoteHandle: JSON.stringify({
          pid: process.pid,
          workdir,
          exit_code_path: `${workdir}/exit_code`,
          stdout_path: `${workdir}/stdout`,
          stderr_path: `${workdir}/stderr`
        })
      })
      let injected = false
      const run: ComputeConnectionLease['run'] = async (command) => {
        const result = runCleanupShell(command, db.storageRoot)
        if (!injected && !command.includes('rm -rf -- "$workdir"')) {
          injected = true
          await jobs.update(
            'j',
            change === 'status' ? { status: 'failed' } : { lastPollError: 'new observer' }
          )
        }
        return result
      }
      const owner = createComputeExecution().createDeletionOwner({
        jobRepository: jobs,
        hostRepository: {
          get: async () => ({ providerId: scope.providerId, scratchRoot: db.storageRoot })
        } as unknown as ComputeHostRepository,
        connectionBroker: { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) }
      })
      await owner.prepareSessionJobDeletion('p', 's')
      await expect(owner.commitSessionJobDeletion('p', 's')).rejects.toThrow('snapshot changed')
      expect(existsSync(workdir)).toBe(true)
      expect(hasCleanupStopEvidence((await jobs.get('j'))!)).toBe(false)
      await owner.commitSessionJobDeletion('p', 's')
      expect(existsSync(workdir)).toBe(false)
      expect(await jobs.get('j')).toBeNull()
    } finally {
      await db.dispose()
    }
  }
)

it.each([
  'workdir',
  'provider',
  'command',
  'created',
  'mode',
  'invalid-handle',
  'replacement-handle'
] as const)('rejects a retained plan whose %s changes execution identity', async (change) => {
  const db = await createMigratedComputeTestDatabase('compute-cleanup-identity-')
  try {
    const jobs = db.repositories.jobs
    const workdir = join(db.storageRoot, '.open-science/jobs/j').replaceAll('\\', '/')
    mkdirSync(workdir, { recursive: true })
    await jobs.create({
      id: 'j',
      ...scope,
      shape: 'direct_ssh',
      intent: 'test',
      command: 'true',
      commandHash: 'hash',
      initialStatus: 'submitted',
      remoteWorkdir: workdir,
      allowUnencryptedPersistence: true
    })
    const handle = JSON.stringify({
      pid: process.pid,
      workdir,
      exit_code_path: `${workdir}/exit_code`,
      stdout_path: `${workdir}/stdout`,
      stderr_path: `${workdir}/stderr`
    })
    if (change === 'replacement-handle') await jobs.update('j', { remoteHandle: handle })
    const run = vi.fn<ComputeConnectionLease['run']>(async (command) =>
      runCleanupShell(command, db.storageRoot)
    )
    const owner = createComputeExecution().createDeletionOwner({
      jobRepository: jobs,
      hostRepository: {
        get: async () => ({ providerId: scope.providerId, scratchRoot: db.storageRoot })
      } as unknown as ComputeHostRepository,
      connectionBroker: { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) }
    })
    await owner.prepareSessionJobDeletion('p', 's')
    const before = await db.client.computeJob.findUniqueOrThrow({ where: { id: 'j' } })
    await db.client.computeJob.update({
      where: { id: 'j' },
      data:
        change === 'workdir'
          ? { remoteWorkdir: '/other/.open-science/jobs/j' }
          : change === 'provider'
            ? { providerId: 'ssh:other' }
            : change === 'command'
              ? { commandHash: 'other' }
              : change === 'created'
                ? { createdAt: new Date(before.createdAt.getTime() + 1) }
                : change === 'mode'
                  ? { executionMode: 'slurm' }
                  : change === 'invalid-handle'
                    ? { remoteHandle: '{}' }
                    : { remoteHandle: handle.replace(String(process.pid), String(process.pid + 1)) }
    })
    for (let retry = 0; retry < 2; retry++)
      await expect(owner.commitSessionJobDeletion('p', 's')).rejects.toThrow(
        /changed|Invalid recovered/
      )
    expect(existsSync(workdir)).toBe(true)
    expect(await jobs.get('j')).not.toBeNull()
    expect(run).not.toHaveBeenCalled()
  } finally {
    await db.dispose()
  }
})
