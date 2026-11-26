import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { terminateProcessTree } from '../process-tree'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { NotebookKernelExecutor } from './kernel-executor'
import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { NotebookRunRepository } from './repository'
import {
  NotebookRuntimeService,
  type NotebookExecutionRequest,
  type NotebookExecutionResult
} from './runtime-service'

const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

type KernelReceipt = ReturnType<KernelProcessLifecycleOwner['recordSpawned']>

const moveToLegacyName = async (
  receipt: KernelReceipt,
  scope: { laneKey: string; processKey: string },
  pid: number
): Promise<KernelReceipt> => {
  const prefix = createHash('sha256').update(`${scope.laneKey}\0${scope.processKey}`).digest('hex')
  const path = join(dirname(receipt.path), `${prefix}.active.${pid}.${receipt.receiptId}.json`)
  await rename(receipt.path, path)
  return { ...receipt, path }
}

const roots: string[] = []
const createStorageRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

describe('kernel degraded recovery', () => {
  it('degraded recovery admits a new kernel epoch without deleting an unknown old receipt', async () => {
    const root = await createStorageRoot('kernel-degraded-lifecycle-')
    const scope = {
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'r:default-r',
      kernelEpochId: 'epoch-old'
    }
    const previous = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await previous.ensureReady()
    const oldReceipt = await moveToLegacyName(
      previous.recordSpawned(previous.beginSpawn(scope), {
        pid: 4242,
        posixBirthToken: 'fixture-birth'
      }),
      scope,
      4242
    )

    const recovered = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })
    await expect(recovered.recover({ allowUnverifiedReceipts: true })).resolves.toBeUndefined()

    const next = recovered.beginSpawn({ ...scope, kernelEpochId: 'epoch-new' })
    expect(next.record.kernelEpochId).toBe('epoch-new')
    expect(existsSync(oldReceipt.path)).toBe(true)
    expect(() => recovered.beginSpawn(scope)).toThrow('KERNEL_STARTUP_FENCE')
    expect(() => recovered.beginSpawn({ ...scope, kernelEpochId: 'epoch-new' })).toThrow(
      'KERNEL_STARTUP_FENCE'
    )
    recovered.abandonSpawn(next)
    expect(existsSync(oldReceipt.path)).toBe(true)
  })

  it('degraded recovery auto-provisions default R and executes with a legacy unknown Windows receipt', async () => {
    const root = await createStorageRoot('kernel-degraded-provision-')
    const previous = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    const oldScope = {
      laneKey: 'old-session',
      processKey: 'r:default-r',
      kernelEpochId: 'old-epoch'
    }
    const oldReceipt = await moveToLegacyName(
      previous.recordSpawned(previous.beginSpawn(oldScope), { pid: 4242 }),
      oldScope,
      4242
    )
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      platform: 'win32',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: 'provisioned-r-ok',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const provisionR = vi.fn(async () => undefined)
    service.setDefaultEnvProvisioner({ provisionPython: vi.fn(), provisionR })

    try {
      await expect(service.recoverInterruptedOperations()).resolves.toBeUndefined()
      const run = await service.execute({
        sessionId: 'new-session',
        workspaceCwd: root,
        code: '1',
        language: 'r'
      })

      expect(run.status, run.text.traceback).toBe('completed')
      expect(run.text.stdout).toContain('provisioned-r-ok')
      expect(provisionR).toHaveBeenCalledOnce()
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({ language: 'r', environment: 'default-r' })
      expect(existsSync(oldReceipt.path)).toBe(true)
    } finally {
      await service.dispose()
    }
  })

  it('blocks removing only the managed environment with an unresolved cold-start receipt', async () => {
    const root = await createStorageRoot('kernel-degraded-environment-removal-')
    const previous = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    const scope = {
      laneKey: 'old-session',
      processKey: 'r:old-environment',
      kernelEpochId: 'old-epoch'
    }
    const oldReceipt = await moveToLegacyName(
      previous.recordSpawned(previous.beginSpawn(scope), { pid: 4242 }),
      scope,
      4242
    )
    const removeEnvironment = vi.fn()
    const service = new NotebookRuntimeService({
      platform: 'win32',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentManager: {
        createNamedEnvironment: vi.fn(),
        listEnvironments: () => [],
        removeEnvironment
      }
    })

    try {
      await service.recoverInterruptedOperations()
      await expect(service.manageEnvironments({ action: 'list' })).resolves.toEqual({
        environments: []
      })
      await expect(
        service.manageEnvironments({ action: 'remove', name: 'old-environment' })
      ).rejects.toThrow('Notebook processes using this environment could not be stopped.')
      await expect(
        service.manageEnvironments({ action: 'remove', name: 'OLD-ENVIRONMENT.' })
      ).rejects.toThrow('Notebook processes using this environment could not be stopped.')
      expect(existsSync(oldReceipt.path)).toBe(true)
      expect(removeEnvironment).not.toHaveBeenCalled()

      await expect(
        service.manageEnvironments({ action: 'remove', name: 'unrelated-environment' })
      ).resolves.toEqual({ removed: { name: 'unrelated-environment' } })
      expect(removeEnvironment).toHaveBeenCalledExactlyOnceWith('unrelated-environment')
    } finally {
      await service.dispose()
    }
  })

  it('blocks a package uninstall only in the environment with unresolved kernel cleanup', async () => {
    const root = await createStorageRoot('kernel-degraded-package-uninstall-')
    const previous = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    const intent = previous.beginSpawn({
      laneKey: 'old-session',
      processKey: 'python:default-python',
      kernelEpochId: 'old-epoch'
    })
    const receipt = previous.recordSpawned(intent, { pid: 4242 })
    const installPackagesImpl = vi.fn(async () => ({ ok: true, needsRestart: false, log: '' }))
    const markPackageMutationDirty = vi.fn(async () => undefined)
    const service = new NotebookRuntimeService({
      platform: 'win32',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      environmentStateTracker: {
        prepareRun: vi.fn(),
        captureCompletedRun: vi.fn(),
        inspectPackages: vi.fn(),
        markPackageMutationDirty,
        refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
      },
      installPackagesImpl
    })
    try {
      await service.recoverInterruptedOperations()
      await expect(
        service.managePackages({ language: 'python', packages: ['numpy'], operation: 'uninstall' })
      ).resolves.toMatchObject({
        ok: false,
        error: 'Notebook processes using this environment could not be stopped.'
      })
      expect(existsSync(receipt.path)).toBe(true)
      expect(installPackagesImpl).not.toHaveBeenCalled()
      expect(markPackageMutationDirty).not.toHaveBeenCalled()

      await expect(
        service.managePackages({ language: 'r', packages: ['ggplot2'], operation: 'uninstall' })
      ).resolves.toMatchObject({ ok: true })
      expect(installPackagesImpl).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ environment: 'default-r', operation: 'uninstall' }),
        expect.any(Object)
      )
    } finally {
      await service.dispose()
    }
  })

  it('degraded recovery does not await or reject foreground recovery when background cleanup fails', async () => {
    const root = await createStorageRoot('kernel-degraded-background-')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const service = new NotebookRuntimeService({
      memoryPolicy: healthyNotebookMemoryPolicy(),
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      logger
    })
    const lifecycle = (
      service as unknown as { kernelProcessLifecycle: KernelProcessLifecycleOwner }
    ).kernelProcessLifecycle
    let rejectGlobal!: (error: Error) => void
    const globalCleanup = new Promise<void>((_resolve, reject) => {
      rejectGlobal = reject
    })
    const recover = vi.spyOn(lifecycle, 'recover').mockReturnValue(globalCleanup)
    const ensureReady = vi.spyOn(lifecycle, 'ensureReady')

    try {
      await expect(service.recoverInterruptedOperations()).resolves.toBeUndefined()
      await vi.waitFor(() =>
        expect(recover).toHaveBeenCalledWith({ allowUnverifiedReceipts: true })
      )
      expect(logger.warn).not.toHaveBeenCalled()

      let rejectLane!: (error: Error) => void
      const laneCleanup = new Promise<void>((_resolve, reject) => {
        rejectLane = reject
      })
      const laneRecovery = vi
        .spyOn(lifecycle, 'ensureReadyForLane')
        .mockReturnValueOnce(laneCleanup)
        .mockResolvedValue(undefined)
      for (let admission = 0; admission < 4; admission += 1) {
        await expect(service.ensureRecovered()).resolves.toBeUndefined()
        await expect(service.ensureRecovered('degraded-lane')).resolves.toBeUndefined()
      }
      expect(laneRecovery).not.toHaveBeenCalled()
      expect(ensureReady).not.toHaveBeenCalled()

      rejectGlobal(new Error('degraded-recovery-global-sentinel'))
      await vi.waitFor(() => expect(laneRecovery).toHaveBeenCalledWith('degraded-lane'))
      expect(logger.warn).toHaveBeenCalledWith(
        'Notebook kernel process recovery failed',
        expect.objectContaining({
          lane: 'global',
          error: 'degraded-recovery-global-sentinel'
        })
      )
      expect(logger.warn).toHaveBeenCalledTimes(1)
      await service.ensureRecovered('degraded-lane')
      expect(recover).toHaveBeenCalledOnce()
      expect(laneRecovery).toHaveBeenCalledOnce()

      rejectLane(new Error('degraded-recovery-lane-sentinel'))
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          'Notebook kernel process recovery failed',
          expect.objectContaining({
            lane: 'degraded-lane',
            error: 'degraded-recovery-lane-sentinel'
          })
        )
      )
      await service.ensureRecovered('degraded-lane')
      await vi.waitFor(() => expect(laneRecovery).toHaveBeenCalledTimes(2))
    } finally {
      await service.dispose()
    }
  })

  it('stops current Sessions during a legacy scan and preserves strict shutdown results', async () => {
    const root = await createStorageRoot('kernel-degraded-drain-')
    const shutdownExecutor = vi.fn(async () => ({ reaped: true }))
    const service = new NotebookRuntimeService({
      memoryPolicy: healthyNotebookMemoryPolicy(),
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async () => [],
      executorFactory: () => ({
        execute: vi.fn(),
        shutdown: shutdownExecutor
      })
    })
    const lifecycle = (
      service as unknown as { kernelProcessLifecycle: KernelProcessLifecycleOwner }
    ).kernelProcessLifecycle
    lifecycle.recordSpawned(
      lifecycle.beginSpawn({
        laneKey: 'old-session',
        processKey: 'repl',
        kernelEpochId: 'old-epoch'
      }),
      { pid: 4242, posixBirthToken: 'fixture-birth' }
    )
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const recover = vi
      .spyOn(lifecycle, 'recover')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(second.promise)
    const laneRecovery = vi.spyOn(lifecycle, 'ensureReadyForLane')
    const currentSession = { sessionId: 'current-session', workspaceCwd: root }
    const afterShutdown = vi.fn(async () => undefined)
    let shutdownSettled = false
    let disposeSettled = false
    let shutdown: ReturnType<NotebookRuntimeService['shutdownAll']> | undefined

    try {
      await expect(service.recoverInterruptedOperations()).resolves.toBeUndefined()
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1))
      await service.listRuntimes(currentSession)
      shutdown = service.shutdownAll({ afterShutdown })
      void shutdown.then(
        () => {
          shutdownSettled = true
        },
        () => {
          shutdownSettled = true
        }
      )
      await vi.waitFor(() => expect(shutdownExecutor).toHaveBeenCalledOnce())
      expect(shutdownSettled).toBe(false)

      first.resolve()
      await expect(shutdown).rejects.toThrow('Notebook processes could not be stopped')
      expect(afterShutdown).not.toHaveBeenCalled()
      expect(laneRecovery).not.toHaveBeenCalled()
      await expect(service.shutdownAll()).resolves.toEqual({ reaped: false })

      await service.ensureRecovered()
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3))
      await service.listRuntimes(currentSession)
      const disposal = service.dispose().then((result) => {
        disposeSettled = true
        return result
      })
      await vi.waitFor(() => expect(shutdownExecutor).toHaveBeenCalledTimes(2))
      expect(disposeSettled).toBe(false)

      second.resolve()
      await expect(disposal).resolves.toEqual({ reaped: false })
      expect(laneRecovery).not.toHaveBeenCalled()
      expect(lifecycle.hasReceipts()).toBe(true)
    } finally {
      first.resolve()
      second.resolve()
      await shutdown?.catch(() => undefined)
      await service.dispose()
    }
  })

  it('degraded recovery keeps a newer start when an older gated start settles', async () => {
    const root = await createStorageRoot('kernel-degraded-generation-')
    const lifecycle = new KernelProcessLifecycleOwner({ storageRoot: root })
    await lifecycle.ensureReady()
    let admissionStarted = false
    let releaseAdmission!: () => void
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    let shutdownPid: number | undefined
    let shutdownStarted = false
    let releaseShutdown!: () => void
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    const terminatedPids = new Set<number>()
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      processLifecycle: lifecycle,
      laneKey: '["project-1","session-1","root",null,null]',
      terminateTree: async (child) => {
        if (child.pid === shutdownPid) {
          shutdownStarted = true
          await shutdownGate
        }
        const result = await terminateProcessTree(child)
        if (child.pid !== undefined) terminatedPids.add(child.pid)
        return result
      }
    })
    const request = {
      cwd: root,
      notebookSessionRoot: join(root, 'nb'),
      inputRoot: join(root, 'inputs'),
      dataRoot: join(root, 'nb', 'data'),
      runtimeRoot: join(root, 'runtime'),
      kind: 'repl' as const,
      sessionId: 'session-1',
      projectId: 'project-1'
    }

    try {
      const older = executor.execute({
        ...request,
        code: "console.log('stale-start')",
        executionAdmission: {
          prepare: async () => {
            admissionStarted = true
            await admissionGate
          },
          assertCurrent: () => undefined
        }
      })
      await vi.waitFor(() => expect(admissionStarted).toBe(true))
      await expect(executor.restart()).resolves.toBeUndefined()
      await expect(
        executor.execute({ ...request, code: "console.log('current-start')" })
      ).resolves.toMatchObject({ status: 'completed' })
      const currentPid = executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid
      expect(currentPid).toBeTypeOf('number')

      releaseAdmission()
      await expect(older).resolves.toMatchObject({ status: 'cancelled' })
      await expect(
        executor.execute({ ...request, code: "console.log('current-reused')" })
      ).resolves.toMatchObject({ status: 'completed' })
      expect(executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid).toBe(
        currentPid
      )

      shutdownPid = currentPid
      let shutdownSettled = false
      const shutdown = executor.shutdown().then((result) => {
        shutdownSettled = true
        return result
      })
      await vi.waitFor(() => expect(shutdownStarted).toBe(true))
      expect(shutdownSettled).toBe(false)
      releaseShutdown()
      await expect(shutdown).resolves.toEqual({ reaped: true })
      expect(terminatedPids).toContain(currentPid)
    } finally {
      releaseAdmission()
      releaseShutdown()
      await executor.shutdown()
    }
  }, 20_000)

  it('strict terminate waits for the current and retained owners of the same process key', async () => {
    const root = await createStorageRoot('kernel-degraded-terminate-')
    const lifecycle = new KernelProcessLifecycleOwner({ storageRoot: root })
    const oldCleanup = Promise.withResolvers<void>()
    const oldPids = new Set<number>()
    let retryAllowed = false
    const terminateTree = vi.fn(async (child: ChildProcess) => {
      if (child.pid !== undefined && oldPids.has(child.pid)) {
        await oldCleanup.promise
        const result = await terminateProcessTree(child)
        return retryAllowed ? result : { reaped: false }
      }
      return terminateProcessTree(child)
    })
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      processLifecycle: lifecycle,
      laneKey: '["project-1","session-1","root",null,null]',
      terminateTree
    })
    const request = {
      cwd: root,
      notebookSessionRoot: join(root, 'nb'),
      inputRoot: join(root, 'inputs'),
      dataRoot: join(root, 'nb', 'data'),
      runtimeRoot: join(root, 'runtime'),
      kind: 'repl' as const,
      sessionId: 'session-1',
      projectId: 'project-1'
    }

    try {
      await expect(
        executor.execute({ ...request, code: "console.log('terminate-old')" })
      ).resolves.toMatchObject({ status: 'completed' })
      for (let generation = 0; generation < 2; generation++) {
        const oldPid = executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid
        expect(oldPid).toBeTypeOf('number')
        oldPids.add(oldPid!)
        await executor.restartProcess('repl', '')
        await expect(
          executor.execute({ ...request, code: "console.log('terminate-new')" })
        ).resolves.toMatchObject({ status: 'completed' })
      }
      expect(oldPids.size).toBe(2)
      const newPid = executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid
      expect(newPid).toBeTypeOf('number')
      expect(oldPids.has(newPid!)).toBe(false)

      let settled = false
      const stopping = executor.terminate('repl', '').catch((error: unknown) => error)
      void stopping.then(() => (settled = true))
      await vi.waitFor(() =>
        expect(terminateTree.mock.calls.map(([child]) => child.pid)).toContain(newPid)
      )
      expect(settled).toBe(false)
      oldCleanup.resolve()
      expect(await stopping).toMatchObject({ message: expect.stringContaining('was not reaped') })
      expect(executor.monitoredProcesses()).toEqual(
        Array.from(oldPids, (pid) => expect.objectContaining({ pid, status: 'cleanup-failed' }))
      )

      retryAllowed = true
      await expect(executor.terminate('repl', '')).resolves.toBeUndefined()
      expect(executor.monitoredProcesses()).toEqual([])
      await expect(executor.shutdown()).resolves.toEqual({ reaped: true })
    } finally {
      retryAllowed = true
      oldCleanup.resolve()
      await executor.shutdown()
    }
  }, 20_000)

  it('degraded recovery restarts the real REPL twice without losing old cleanup owners', async () => {
    const root = await createStorageRoot('kernel-degraded-repl-')
    const lifecycle = new KernelProcessLifecycleOwner({ storageRoot: root })
    await lifecycle.ensureReady()
    const degradedPids = new Set<number>()
    const terminationAttempts = new Map<number, number>()
    const terminateTree = vi.fn(async (child: ChildProcess) => {
      if (child.pid !== undefined) {
        terminationAttempts.set(child.pid, (terminationAttempts.get(child.pid) ?? 0) + 1)
      }
      const result = await terminateProcessTree(child)
      return child.pid !== undefined && degradedPids.has(child.pid) ? { reaped: false } : result
    })
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      processLifecycle: lifecycle,
      laneKey: '["project-1","session-1","root",null,null]',
      terminateTree
    })
    const request = {
      cwd: root,
      notebookSessionRoot: join(root, 'nb'),
      inputRoot: join(root, 'inputs'),
      dataRoot: join(root, 'nb', 'data'),
      runtimeRoot: join(root, 'runtime'),
      kind: 'repl' as const,
      sessionId: 'session-1',
      projectId: 'project-1'
    }

    try {
      const first = await executor.execute({
        ...request,
        code: "console.log('degraded-recovery-first')"
      })
      expect(first).toMatchObject({
        status: 'completed',
        stdout: expect.stringContaining('degraded-recovery-first')
      })
      const firstPid = executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid
      expect(firstPid).toBeTypeOf('number')
      if (firstPid === undefined) throw new Error('First REPL pid was not published')
      degradedPids.add(firstPid)

      await expect(executor.restart()).resolves.toBeUndefined()
      const second = await executor.execute({
        ...request,
        code: "console.log('degraded-recovery-second')"
      })
      expect(second).toMatchObject({
        status: 'completed',
        stdout: expect.stringContaining('degraded-recovery-second')
      })
      const secondPid = executor
        .monitoredProcesses()
        .find(({ status, pid }) => status === 'idle' && pid !== firstPid)?.pid
      expect(secondPid).toBeTypeOf('number')
      if (secondPid === undefined) throw new Error('Second REPL pid was not published')
      degradedPids.add(secondPid)

      await expect(executor.restart()).resolves.toBeUndefined()
      const third = await executor.execute({
        ...request,
        code: "console.log('degraded-recovery-third')"
      })
      expect(third).toMatchObject({
        status: 'completed',
        stdout: expect.stringContaining('degraded-recovery-third')
      })
      const thirdPid = executor
        .monitoredProcesses()
        .find(({ status, pid }) => status === 'idle' && !degradedPids.has(pid ?? -1))?.pid
      expect(thirdPid).toBeTypeOf('number')
      expect(new Set([firstPid, secondPid, thirdPid]).size).toBe(3)
      expect(JSON.stringify([first, second, third])).not.toContain('KERNEL_STARTUP_FENCE')
      expect(JSON.stringify([first, second, third])).not.toContain(
        'persistent process tree was not reaped'
      )

      const kernelResources = executor.resources().filter(({ group }) => group === 'kernel')
      const cleanupOwners = kernelResources.filter(({ phase }) => phase === 'cleanup-pending')
      expect(cleanupOwners).toHaveLength(2)
      expect(new Set(cleanupOwners.map(({ identity }) => identity)).size).toBe(2)
      expect(kernelResources.every(({ kernelEpochId }) => typeof kernelEpochId === 'string')).toBe(
        true
      )
      expect(new Set(kernelResources.map(({ kernelEpochId }) => kernelEpochId)).size).toBe(3)

      const attemptsBeforeShutdown = new Map(
        [...degradedPids].map((pid) => [pid, terminationAttempts.get(pid) ?? 0])
      )
      await expect(executor.shutdown()).resolves.toEqual({ reaped: false })
      for (const pid of degradedPids) {
        expect(terminationAttempts.get(pid) ?? 0).toBeGreaterThan(
          attemptsBeforeShutdown.get(pid) ?? 0
        )
      }
    } finally {
      await executor.shutdown()
    }
  }, 20_000)
})

configureTestRuntimeMetadata()
