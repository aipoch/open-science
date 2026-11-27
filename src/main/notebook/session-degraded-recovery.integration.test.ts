import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import * as processTree from '../process-tree'
import { NotebookKernelExecutor } from './kernel-executor'
import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import type { NotebookSessionLifecycleOwner } from './session-lifecycle'

configureTestRuntimeMetadata()

const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const fixture = async (): Promise<{
  root: string
  scope: { projectId: string; sessionId: string; workspaceCwd: string }
  service: NotebookRuntimeService
}> => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-session-degraded-'))
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: scope.projectId,
    memoryPolicy: healthyNotebookMemoryPolicy()
  })
  return { root, scope, service }
}

const firstHostPid = (): (() => number | undefined) => {
  let pid: number | undefined
  const recordSpawned = KernelProcessLifecycleOwner.prototype.recordSpawned
  vi.spyOn(KernelProcessLifecycleOwner.prototype, 'recordSpawned').mockImplementationOnce(function (
    this: KernelProcessLifecycleOwner,
    intent,
    child
  ) {
    pid = child.pid
    return recordSpawned.call(this, intent, child)
  })
  return () => pid
}

afterEach(() => vi.restoreAllMocks())

describe.runIf(process.platform !== 'win32')('Notebook Session degraded recovery', () => {
  it('invalidates an approved execution on a stopped interpreter while its cleanup is pending', async () => {
    const oldHost = firstHostPid()
    const enteredCleanup = Promise.withResolvers<void>()
    const finishCleanup = Promise.withResolvers<void>()
    const enteredApproval = Promise.withResolvers<void>()
    const approve = Promise.withResolvers<boolean>()
    const enteredProjection = Promise.withResolvers<void>()
    const finishProjection = Promise.withResolvers<void>()
    const markTerminated = NotebookRunRepository.prototype.markKernelTerminated
    vi.spyOn(NotebookRunRepository.prototype, 'markKernelTerminated').mockImplementationOnce(
      async function (this: NotebookRunRepository, input) {
        enteredProjection.resolve()
        await finishProjection.promise
        return markTerminated.call(this, input)
      }
    )
    const terminate = processTree.terminateProcessTree
    vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (child) => {
      if (child.pid === oldHost()) {
        enteredCleanup.resolve()
        await finishCleanup.promise
      }
      return terminate(child)
    })
    const { root, scope, service } = await fixture()
    let stop: Promise<void> | undefined
    try {
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.originalValue = 5' })
      ).resolves.toMatchObject({ status: 'completed' })
      const [original] = (await service.getProcessMonitor()).instances
      const marker = join(root, 'approval-marker')
      await writeFile(marker, 'still here')
      service.setExecutionApproval(async () => {
        enteredApproval.resolve()
        return approve.promise
      })
      const approvedRun = service.executeControl({
        ...scope,
        code: `require('fs').rmSync(${JSON.stringify(marker)})`
      })
      await Promise.race([enteredApproval.promise, approvedRun])

      const nextCode = 'console.log(typeof originalValue); globalThis.newValue = 42'
      const nextRun = service.executeControl({ ...scope, code: nextCode })
      const nextRunStatus = async (): Promise<string | undefined> =>
        (await service.state(scope)).runs.find(({ script }) => script === nextCode)?.status
      await vi.waitFor(async () => expect(await nextRunStatus()).toBe('queued'))

      stop = service.terminateMonitoredProcess({ ...scope, id: original.id })
      await Promise.race([Promise.all([enteredCleanup.promise, enteredProjection.promise]), stop])
      approve.resolve(true)
      await expect(approvedRun).resolves.toMatchObject({
        status: 'failed',
        kernelDispatched: false,
        traceback: 'Notebook interpreter was stopped before execution. Run the code again.'
      })
      expect(await readFile(marker, 'utf8')).toBe('still here')
      expect(await nextRunStatus()).toBe('queued')
      finishProjection.resolve()
      await expect(nextRun).resolves.toMatchObject({ status: 'completed', stdout: 'undefined\n' })
      expect(() => process.kill(oldHost()!, 0)).not.toThrow()
      finishCleanup.resolve()
      await stop
      await expect(
        service.executeControl({ ...scope, code: 'console.log(newValue)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: '42\n' })
    } finally {
      approve.resolve(false)
      finishCleanup.resolve()
      finishProjection.resolve()
      await stop?.catch(() => undefined)
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('reclaims an idle kernel without waiting for proof or reusing its epoch', async () => {
    const oldHost = firstHostPid()
    let cleanupAttempts = 0
    const cleanup = Promise.withResolvers<void>()
    const terminate = processTree.terminateProcessTree
    vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (child) => {
      if (child.pid !== oldHost()) return terminate(child)
      const attempt = ++cleanupAttempts
      await cleanup.promise
      const result = await terminate(child)
      return attempt === 1 ? { reaped: false } : result
    })
    const { root, scope, service } = await fixture()
    try {
      const first = await service.executeControl({
        ...scope,
        code: 'globalThis.oldValue = 3; console.log(process.pid)'
      })
      expect(first.status, first.stderr).toBe('completed')
      const oldPid = Number(first.stdout.trim())
      expect(oldPid).toBeGreaterThan(0)
      const [original] = service.ownedResources(scope).filter(({ group }) => group === 'kernel')
      const { sessionLifecycle } = service as unknown as {
        sessionLifecycle: Pick<NotebookSessionLifecycleOwner, 'idleInterpreters'>
      }
      const idle = sessionLifecycle
        .idleInterpreters()
        .find(({ identity }) => identity === original.identity)
      expect(idle).toBeDefined()
      await expect(idle!.release(() => true)).resolves.toBe(true)
      await vi.waitFor(() => expect(cleanupAttempts).toBe(1))
      expect(() => process.kill(oldPid, 0)).not.toThrow()

      const next = await service.executeControl({
        ...scope,
        code: 'console.log(typeof oldValue); globalThis.newValue = 4'
      })
      expect(next).toMatchObject({ status: 'completed', stdout: 'undefined\n' })
      expect(service.ownedResources(scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ identity: original.identity, phase: 'cleanup-pending' }),
          expect.objectContaining({ phase: 'idle', kernelEpochId: expect.any(String) })
        ])
      )
      const live = service.ownedResources(scope).find(({ phase }) => phase === 'idle')
      expect(live?.kernelEpochId).not.toBe(original.kernelEpochId)
      cleanup.resolve()
      await expect(original.release()).resolves.toMatchObject({ reaped: true })
      expect(cleanupAttempts).toBe(2)
      await vi.waitFor(() =>
        expect(
          service.ownedResources(scope).some(({ identity }) => identity === original.identity)
        ).toBe(false)
      )
      await expect(
        service.executeControl({ ...scope, code: 'console.log(newValue)' })
      ).resolves.toMatchObject({
        status: 'completed',
        stdout: '4\n'
      })
    } finally {
      cleanup.resolve()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('retires a failed startup after receipt publication, preserving its evidence while a new run starts', async () => {
    let oldPid: number | undefined
    let oldReceipt: string | undefined
    let verifyOldCleanup = false
    const attemptedCleanup = Promise.withResolvers<void>()
    const recordSpawned = KernelProcessLifecycleOwner.prototype.recordSpawned
    vi.spyOn(KernelProcessLifecycleOwner.prototype, 'recordSpawned').mockImplementationOnce(
      function (this: KernelProcessLifecycleOwner, intent, child) {
        oldPid = child.pid
        oldReceipt = recordSpawned.call(this, intent, child).path
        throw new Error('registration failed after receipt publication')
      }
    )
    const terminate = processTree.terminateProcessTree
    vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (child) => {
      const result = await terminate(child)
      if (child.pid !== oldPid) return result
      attemptedCleanup.resolve()
      return verifyOldCleanup ? result : { reaped: false }
    })
    const { root, scope, service } = await fixture()
    const marker = join(root, 'unexpected-dispatch')
    try {
      const failed = await service.executeControl({
        ...scope,
        code: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
      })
      expect(failed).toMatchObject({
        status: 'failed',
        kernelDispatched: false,
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' },
        stderr: 'Notebook kernel could not start.'
      })
      await attemptedCleanup.promise
      expect(oldReceipt).toBeDefined()
      expect(existsSync(oldReceipt!)).toBe(true)
      expect(existsSync(marker)).toBe(false)

      await expect(
        service.executeControl({ ...scope, code: "console.log('fresh-after-startup')" })
      ).resolves.toMatchObject({ status: 'completed', stdout: 'fresh-after-startup\n' })
      const state = await service.state(scope)
      expect(state.runs.map(({ status }) => status)).toEqual(['failed', 'completed'])
      expect(state.runs[1].kernelEpochId).not.toBe(state.runs[0].kernelEpochId)
      expect(existsSync(oldReceipt!)).toBe(true)
      expect(existsSync(marker)).toBe(false)

      verifyOldCleanup = true
      await expect(service.dispose()).resolves.toEqual({ reaped: true })
      expect(existsSync(oldReceipt!)).toBe(false)
    } finally {
      verifyOldCleanup = true
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('settles a crashed run and lets the same FIFO and targeted restart proceed before tracked cleanup', async () => {
    const oldHost = firstHostPid()
    let cleanupAttempts = 0
    const finishInitialCleanup = Promise.withResolvers<void>()
    const finishTrackedRetry = Promise.withResolvers<void>()
    const terminate = processTree.terminateProcessTree
    vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (child) => {
      if (child.pid !== oldHost()) return terminate(child)
      cleanupAttempts++
      if (cleanupAttempts === 1) {
        await finishInitialCleanup.promise
        return { reaped: false }
      }
      await finishTrackedRetry.promise
      return terminate(child)
    })
    const { root, scope, service } = await fixture()
    const marker = join(root, 'crash-marker')
    const allowExit = join(root, 'allow-exit')
    try {
      const warm = await service.executeControl({ ...scope, code: 'console.log(process.pid)' })
      expect(warm.status, warm.stderr).toBe('completed')
      const [original] = service.ownedResources(scope).filter(({ group }) => group === 'kernel')
      const crash = service.executeControl({
        ...scope,
        code: [
          "const fs = require('node:fs')",
          `fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n')`,
          `while (!fs.existsSync(${JSON.stringify(allowExit)})) { await new Promise(r => setTimeout(r, 10)) }`,
          'process.exit(23)'
        ].join('\n')
      })
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
      const next = service.executeControl({ ...scope, code: "console.log('following-run')" })
      await vi.waitFor(async () =>
        expect(
          (await service.state(scope)).runs.find(({ script }) => script.includes('following-run'))
            ?.status
        ).toBe('queued')
      )
      await writeFile(allowExit, '')
      await expect(crash).resolves.toMatchObject({
        status: 'failed',
        kernelDispatched: true,
        recovery: {
          execution: 'may-have-run',
          retryAfter: 'runtime-ready',
          kernel: { exitCode: 23 }
        }
      })
      await expect(next).resolves.toMatchObject({ status: 'completed', stdout: 'following-run\n' })
      await expect(service.restart({ ...scope, kernel: 'repl' })).resolves.toBeDefined()
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.afterRestart = 72' })
      ).resolves.toMatchObject({
        status: 'completed'
      })
      expect(await readFile(marker, 'utf8')).toBe('ran\n')
      expect(cleanupAttempts).toBe(1)

      finishInitialCleanup.resolve()
      await vi.waitFor(() => expect(cleanupAttempts).toBe(2))
      const cleanupResource = service
        .ownedResources(scope)
        .find(({ identity }) => identity === original.identity)
      expect(cleanupResource?.phase).toBe('cleanup-pending')
      const release = cleanupResource!.release()
      finishTrackedRetry.resolve()
      await expect(release).resolves.toMatchObject({ reaped: true })
      await vi.waitFor(() =>
        expect(
          service.ownedResources(scope).some(({ identity }) => identity === original.identity)
        ).toBe(false)
      )
      expect(cleanupAttempts).toBe(2)
      await expect(
        service.executeControl({ ...scope, code: 'console.log(afterRestart)' })
      ).resolves.toMatchObject({
        status: 'completed',
        stdout: '72\n'
      })
    } finally {
      await writeFile(allowExit, '')
      finishInitialCleanup.resolve()
      finishTrackedRetry.resolve()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('discards a real prior spawn that returns after its replacement is executing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-post-spawn-'))
    const lifecycle = new KernelProcessLifecycleOwner({ storageRoot: root })
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      processLifecycle: lifecycle,
      laneKey: 'post-spawn'
    })
    const port = executor as unknown as {
      spawnLoop: (...args: never[]) => Promise<{ child: ChildProcess }>
    }
    const spawnLoop = port.spawnLoop.bind(executor)
    const started = Promise.withResolvers<number | undefined>()
    const returnOldSpawn = Promise.withResolvers<void>()
    vi.spyOn(port, 'spawnLoop').mockImplementationOnce(async (...args) => {
      const old = await spawnLoop(...args)
      started.resolve(old.child.pid)
      await returnOldSpawn.promise
      return old
    })
    const request = {
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: join(root, 'runtime'),
      kind: 'repl' as const
    }
    const oldRun = executor.execute({ ...request, code: "throw new Error('stale dispatch')" })
    try {
      const oldPid = await started.promise
      expect(oldPid).toBeTypeOf('number')
      await executor.restart()
      await expect(
        executor.execute({ ...request, code: 'globalThis.replacement = 81' })
      ).resolves.toMatchObject({
        status: 'completed'
      })
      const currentPid = executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid
      expect(currentPid).toBeTypeOf('number')
      expect(currentPid).not.toBe(oldPid)
      returnOldSpawn.resolve()
      await expect(oldRun).resolves.toMatchObject({ status: 'cancelled', kernelDispatched: false })
      await expect(
        executor.execute({ ...request, code: 'console.log(replacement)' })
      ).resolves.toMatchObject({
        status: 'completed',
        stdout: '81\n'
      })
      expect(executor.monitoredProcesses().find(({ status }) => status === 'idle')?.pid).toBe(
        currentPid
      )
    } finally {
      returnOldSpawn.resolve()
      await oldRun
      await executor.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(['restart', 'abort'] as const)(
    'releases the Session queue after an unpublished start is stopped by %s',
    async (stop) => {
      const port = NotebookKernelExecutor.prototype as unknown as {
        spawnLoop: (
          this: NotebookKernelExecutor,
          ...args: never[]
        ) => Promise<{ child: ChildProcess }>
      }
      const spawnLoop = port.spawnLoop
      const spawned = Promise.withResolvers<number | undefined>()
      const returnOldSpawn = Promise.withResolvers<void>()
      const cleanupStarted = Promise.withResolvers<void>()
      const finishCleanup = Promise.withResolvers<void>()
      let oldHost: number | undefined
      vi.spyOn(port, 'spawnLoop').mockImplementationOnce(async function (
        this: NotebookKernelExecutor,
        ...args
      ) {
        const old = await spawnLoop.apply(this, args)
        oldHost = old.child.pid
        spawned.resolve(oldHost)
        await returnOldSpawn.promise
        return old
      })
      const terminate = processTree.terminateProcessTree
      vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (child) => {
        if (child.pid === oldHost) {
          cleanupStarted.resolve()
          await finishCleanup.promise
        }
        return terminate(child)
      })
      const { root, scope, service } = await fixture()
      const controller = new AbortController()
      const oldRun = service.executeControl(
        { ...scope, code: 'throw Error("stale dispatch")' },
        controller.signal
      )
      try {
        expect(await spawned.promise).toBeTypeOf('number')
        if (stop === 'restart') await service.restart(scope)
        else controller.abort()
        const nextRun = service.executeControl({ ...scope, code: 'console.log(42)' })
        returnOldSpawn.resolve()
        await cleanupStarted.promise
        await expect(oldRun).resolves.toMatchObject({
          status: 'cancelled',
          kernelDispatched: false
        })
        await expect(nextRun).resolves.toMatchObject({ status: 'completed', stdout: '42\n' })
        expect(() => process.kill(oldHost!, 0)).not.toThrow()
      } finally {
        returnOldSpawn.resolve()
        finishCleanup.resolve()
        await service.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000
  )
})
