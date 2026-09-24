import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { windowsSupervisedLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import type { NotebookNetworkRuntime } from '../../../packages/notebook-network-sandbox/runtime/src/index'

const backend = vi.hoisted(() => ({
  initialize: vi.fn<typeof NotebookNetworkRuntime.initialize>(async () => {}),
  wrap: vi.fn<typeof NotebookNetworkRuntime.wrap>(),
  updateConfig: vi.fn(),
  annotateStderr: vi.fn((_id: string, text: string) => text),
  resetCommandConnections: vi.fn(),
  setCommandExecutionActive: vi.fn(),
  cleanupAfterCommand: vi.fn(
    async (...[, , outcome]: Parameters<typeof NotebookNetworkRuntime.cleanupAfterCommand>) => ({
      processesTerminated: outcome.processesTerminated,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
  ),
  reset: vi.fn(async () => {})
}))
vi.mock('../../../packages/notebook-network-sandbox/runtime/src/index.js', async (original) => ({
  ...(await original<
    typeof import('../../../packages/notebook-network-sandbox/runtime/src/index.js')
  >()),
  NotebookNetworkRuntime: backend
}))

import { NotebookNetworkSandbox } from '../../../packages/notebook-network-sandbox/src/index'
import { NotebookKernelExecutor } from './kernel-executor'
import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookExecutionStopError } from '../../shared/notebook-execution-error'

it.skipIf(process.platform !== 'win32')(
  'uses the production standard launcher to prove a naturally exiting REPL',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../packages/notebook-network-sandbox/runtime/src/index.js')
    >('../../../packages/notebook-network-sandbox/runtime/src/index.js')
    await actual.NotebookNetworkRuntime.reset()
    backend.initialize.mockImplementation(actual.NotebookNetworkRuntime.initialize)
    backend.wrap.mockImplementation(actual.NotebookNetworkRuntime.wrap)
    backend.updateConfig.mockImplementation(actual.NotebookNetworkRuntime.updateConfig)
    backend.annotateStderr.mockImplementation(actual.NotebookNetworkRuntime.annotateStderr)
    backend.resetCommandConnections.mockImplementation(
      actual.NotebookNetworkRuntime.resetCommandConnections
    )
    backend.setCommandExecutionActive.mockImplementation(
      actual.NotebookNetworkRuntime.setCommandExecutionActive
    )
    backend.cleanupAfterCommand.mockImplementation(
      actual.NotebookNetworkRuntime.cleanupAfterCommand
    )
    backend.reset.mockImplementation(actual.NotebookNetworkRuntime.reset)
    const root = await mkdtemp(join(tmpdir(), 'os-repl-standard-exit-'))
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    const sandbox = new NotebookNetworkSandbox({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    const launchModes: string[] = []
    const port: NotebookProcessSandbox = {
      wrap: async (invocation) => {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: '',
          executable: invocation.executable,
          args: invocation.args,
          cwd: invocation.cwd,
          env: invocation.env,
          superviseProcessTree: invocation.superviseProcessTree,
          filesystem: invocation.filesystem,
          onNetworkAccessRequest: async () => false
        })
        launchModes.push(wrapped.argv[1])
        return {
          executable: wrapped.argv[0],
          args: wrapped.argv.slice(1),
          env: wrapped.env,
          confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination,
          beginSpawn: wrapped.beginSpawn,
          annotateStderr: wrapped.annotateStderr,
          cleanup: wrapped.cleanup
        }
      }
    }
    const lifecycle = new KernelProcessLifecycleOwner({ storageRoot: root })
    await lifecycle.ensureReady()
    const executor = new NotebookKernelExecutor({
      replLoopPath: resolve('src/main/notebook/fixtures/windows-exiting-repl-loop.cjs'),
      processHostPath: resolve('resources/notebook/kernel_process_host.js'),
      processSandbox: port,
      processLifecycle: lifecycle,
      laneKey: '["standard-exit","standard-exit","root",null,null]'
    })
    let descendantReaped = false
    try {
      await expect(
        executor.execute({
          language: 'python',
          kind: 'repl',
          code: 'unused',
          cwd: root,
          notebookSessionRoot: root,
          dataRoot: root,
          runtimeRoot: '',
          sessionId: 'standard-exit',
          projectId: 'standard-exit',
          timeoutMs: 10_000
        })
      ).resolves.toMatchObject({
        status: 'failed',
        stderr: expect.stringContaining('Notebook kernel process exited with exit code 23.')
      })
      await expect(readFile(join(root, 'fixture-started'), 'utf8')).resolves.toBe('started')
      expect(launchModes).toEqual(['supervise'])
      const descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'))
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' })
      )
      descendantReaped = true
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt === 1) await expect(executor.restart()).resolves.toBeUndefined()
        if (attempt === 2) await expect(executor.shutdown()).resolves.toEqual({ reaped: true })
        await expect(
          executor.execute({
            language: 'python',
            kind: 'repl',
            code: "console.log('REPL_RESTARTED')",
            cwd: root,
            notebookSessionRoot: root,
            dataRoot: root,
            runtimeRoot: '',
            sessionId: 'standard-exit',
            projectId: 'standard-exit',
            timeoutMs: 10_000
          })
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('REPL_RESTARTED')
        })
      }
      await expect(executor.shutdown()).resolves.toEqual({ reaped: true })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    } finally {
      await executor.shutdown().catch(() => undefined)
      let fixtureCleanupComplete = false
      try {
        // A red run can leave the fixture alive. Only it observes this private stop file;
        // never kill a saved PID, which may already belong to an unrelated process.
        if (!descendantReaped) {
          await writeFile(join(root, 'descendant.stop'), 'stop')
          const pid = await readFile(join(root, 'descendant.pid'), 'utf8').catch(() => undefined)
          if (pid) {
            await vi.waitFor(
              async () => {
                const stopped = await readFile(join(root, 'descendant.stopped'), 'utf8').catch(
                  () => undefined
                )
                if (stopped === 'stopped') return
                // This is a read-only absence check, never permission to signal that PID.
                expect(() => process.kill(Number(pid), 0)).toThrow(
                  expect.objectContaining({ code: 'ESRCH' })
                )
              },
              { timeout: 5000, interval: 50 }
            )
          }
        }
        fixtureCleanupComplete = true
      } finally {
        await sandbox.dispose().catch(() => undefined)
        await actual.NotebookNetworkRuntime.reset().catch(() => undefined)
        vi.unstubAllEnvs()
        // Preserve the exit signal if the fixture has not acknowledged it yet.
        if (fixtureCleanupComplete) await rm(root, { recursive: true, force: true })
      }
    }
  },
  30_000
)

beforeEach(() => {
  backend.initialize.mockReset().mockResolvedValue(undefined)
  backend.wrap.mockReset()
  backend.updateConfig.mockReset()
  backend.annotateStderr.mockReset().mockImplementation((_id, text) => text)
  backend.resetCommandConnections.mockReset()
  backend.setCommandExecutionActive.mockReset()
  backend.reset.mockReset().mockResolvedValue(undefined)
  backend.cleanupAfterCommand.mockReset().mockImplementation(async (...[, , outcome]) => ({
    processesTerminated: outcome.processesTerminated,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }))
})

it
  .skipIf(process.platform !== 'win32')
  .each(
    (['valid', 'missing', 'error', 'late', 'receipt-retry'] as const).flatMap((proof) =>
      (['shutdown', 'restart', 'execute'] as const).map((recovery) => ({ proof, recovery }))
    )
  )(
  'reconciles a failed REPL only with a valid native termination proof ($proof/$recovery)',
  async ({ proof, recovery }) => {
    const root = await mkdtemp(join(tmpdir(), 'os-repl-termination-'))
    const sandbox = new NotebookNetworkSandbox({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    const nativeLaunches: ReturnType<typeof windowsSupervisedLaunch>[] = []
    // Automatic exit cleanup may retry before execute settles. Keep the injected fault active
    // until the caller observes quarantine instead of making it depend on a probe count.
    let recoveryAllowed = false
    backend.wrap.mockImplementation(async (request) => {
      const first = nativeLaunches.length === 0
      const launch = windowsSupervisedLaunch({
        command: '',
        executable: request.executable,
        args: first ? ['-e', 'process.exit(1)'] : request.args,
        cwd: root,
        env: { ...request.env, TEMP: root },
        hostPath: resolve(
          `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
        ),
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused', password: 'unused' }
      })
      nativeLaunches.push(launch)
      return {
        ...launch,
        confirmProcessTreeTermination: async () => {
          if (proof === 'missing') return false
          if (proof === 'error') throw new Error('Native proof unavailable')
          if (proof === 'late' && !recoveryAllowed) return false
          return launch.confirmProcessTreeTermination()
        }
      }
    })
    const port: NotebookProcessSandbox = {
      wrap: async (invocation) => {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: '',
          executable: invocation.executable,
          args: invocation.args,
          cwd: root,
          env: invocation.env,
          onNetworkAccessRequest: async () => false
        })
        return {
          executable: wrapped.argv[0],
          args: wrapped.argv.slice(1),
          env: wrapped.env,
          confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination,
          annotateStderr: wrapped.annotateStderr,
          cleanup: wrapped.cleanup
        }
      }
    }
    const lifecycle =
      proof === 'receipt-retry' ? new KernelProcessLifecycleOwner({ storageRoot: root }) : undefined
    if (lifecycle) {
      await lifecycle.ensureReady()
      const complete = lifecycle.complete.bind(lifecycle)
      vi.spyOn(lifecycle, 'complete').mockImplementation((receipt, reaped) => {
        if (reaped && !recoveryAllowed) {
          throw new Error('Transient receipt removal failure')
        }
        complete(receipt, reaped)
      })
    }
    const executor = new NotebookKernelExecutor({
      replLoopPath: resolve('resources/notebook/repl_loop.js'),
      processSandbox: port,
      ...(lifecycle
        ? { processLifecycle: lifecycle, laneKey: '["native-exit","native-exit","root",null,null]' }
        : {})
    })
    const request = {
      language: 'python' as const,
      kind: 'repl' as const,
      code: "console.log('REPL_RECOVERED')",
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: '',
      sessionId: 'native-exit',
      projectId: 'native-exit',
      timeoutMs: 10_000
    }
    try {
      const failed = executor.execute(request)
      if (proof === 'valid') {
        await expect(failed).resolves.toMatchObject({
          status: 'failed',
          stderr: expect.stringContaining('Notebook kernel process exited with exit code 1.')
        })
      } else {
        await expect(failed).rejects.toBeInstanceOf(NotebookExecutionStopError)
      }
      const oldReceipts = lifecycle ? await readdir(join(root, 'runtime', 'kernel-processes')) : []
      if (lifecycle) expect(oldReceipts).toHaveLength(1)
      recoveryAllowed = true
      const recoverable = proof !== 'missing' && proof !== 'error'
      if (recovery === 'shutdown') {
        await expect(executor.shutdown()).resolves.toEqual({ reaped: recoverable })
      } else if (recovery === 'restart') {
        if (recoverable) await expect(executor.restart()).resolves.toBeUndefined()
        else await expect(executor.restart()).rejects.toThrow('restart refused')
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (recoverable) {
          await expect(executor.execute(request)).resolves.toMatchObject({
            status: 'completed',
            stdout: expect.stringContaining('REPL_RECOVERED')
          })
        } else {
          await expect(executor.execute(request)).rejects.toBeInstanceOf(NotebookExecutionStopError)
        }
      }
      if (lifecycle) {
        const receipts = await readdir(join(root, 'runtime', 'kernel-processes'))
        expect(receipts).toHaveLength(1)
        expect(receipts).not.toContain(oldReceipts[0])
      }
    } finally {
      await executor.shutdown()
      // Only the first native launch fails in a red run. Verify its real proof before releasing
      // this test's socket-free backend fixture, without weakening the production gate.
      if (
        nativeLaunches.length === 1 &&
        (await nativeLaunches[0].confirmProcessTreeTermination())
      ) {
        backend.cleanupAfterCommand.mockResolvedValue({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      }
      await sandbox.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
