import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { windowsSupervisedLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import type { NotebookNetworkRuntime } from '../../../packages/notebook-network-sandbox/runtime/src/index'

const backend = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
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

beforeEach(() => {
  backend.cleanupAfterCommand.mockReset().mockImplementation(async (...[, , outcome]) => ({
    processesTerminated: outcome.processesTerminated,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }))
})

it
  .skipIf(process.platform !== 'win32')
  .each(['valid', 'missing', 'error', 'late', 'receipt-retry'] as const)(
  'reconciles a failed REPL only with a valid native termination proof (%s)',
  async (proof) => {
    const root = await mkdtemp(join(tmpdir(), 'os-repl-termination-'))
    const sandbox = new NotebookNetworkSandbox({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    const nativeLaunches: ReturnType<typeof windowsSupervisedLaunch>[] = []
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
      let attempts = 0
      return {
        ...launch,
        confirmProcessTreeTermination: async () => {
          if (proof === 'missing') return false
          if (proof === 'error') throw new Error('Native proof unavailable')
          if (proof === 'late' && attempts++ === 0) return false
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
      let refused = false
      vi.spyOn(lifecycle, 'complete').mockImplementation((receipt, reaped) => {
        if (reaped && !refused) {
          refused = true
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
      const failed = await executor.execute(request)
      expect(failed.stderr).toContain('Notebook kernel process exited with exit code 1.')
      const spec = JSON.parse(Buffer.from(nativeLaunches[0].argv[2], 'base64url').toString('utf8'))
      // The native Job Object proof exists even though the already-exited leader cannot be
      // rediscovered by taskkill. Do not consume it before the production owner can use it.
      await expect(readFile(spec.terminationProofPath, 'utf8')).resolves.toBe(
        spec.terminationProofToken
      )
      const oldReceipts = lifecycle ? await readdir(join(root, 'runtime', 'kernel-processes')) : []
      if (lifecycle) expect(oldReceipts).toHaveLength(1)
      await executor.shutdown()
      const results = []
      for (let attempt = 0; attempt < 3; attempt++) results.push(await executor.execute(request))
      expect(results, JSON.stringify(results)).toEqual(
        Array.from({ length: 3 }, (_, attempt) =>
          proof === 'missing' ||
          proof === 'error' ||
          ((proof === 'late' || proof === 'receipt-retry') && attempt === 0)
            ? expect.objectContaining({
                status: 'failed',
                kernelDispatched: false,
                stderr: 'SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.'
              })
            : expect.objectContaining({
                status: 'completed',
                stdout: expect.stringContaining('REPL_RECOVERED')
              })
        )
      )
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
