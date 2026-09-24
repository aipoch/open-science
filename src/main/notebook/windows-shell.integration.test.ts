import { join } from 'node:path'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import * as processTree from '../process-tree'
import { build } from 'esbuild'

import { describe, expect, it, vi } from 'vitest'

import {
  NotebookShellProcessAdapter,
  runShellCommand,
  type NotebookShellProcessRequest
} from './shell-process'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'
import { createNotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import { windowsSupervisedLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookRunRepository } from './repository'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
import { createRootNotebookLane } from './lane-identity'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))

const POWERSHELL_PROCESS_TIMEOUT_MS = 30_000
const POWERSHELL_TEST_TIMEOUT_MS = POWERSHELL_PROCESS_TIMEOUT_MS + 5_000

// Use the production native supervisor when requested, while keeping the workload harmless and
// independent of machine PowerShell startup speed, network access, and AppContainer installation.
const fixtureSandbox = (
  root: string,
  code: string,
  observe?: (event: Record<string, unknown>) => void
): NotebookProcessSandbox => ({
  wrap: async (invocation) => {
    const launch = invocation.superviseProcessTree
      ? windowsSupervisedLaunch({
          executable: process.execPath,
          args: ['-e', code],
          command: '',
          cwd: root,
          env: { ...invocation.env, TEMP: root },
          gatewayPort: 1,
          gatewayCredentials: { username: 'unused', password: 'unused' },
          hostPath: join(
            process.cwd(),
            'packages/notebook-network-sandbox/vendor/windows',
            process.arch,
            'notebook-appcontainer-host.exe'
          )
        })
      : { argv: [process.execPath, '-e', code], env: invocation.env }
    return {
      executable: launch.argv[0],
      args: launch.argv.slice(1),
      env: launch.env,
      ...('confirmProcessTreeTermination' in launch
        ? {
            confirmProcessTreeTermination: async () => {
              const confirmed = await launch.confirmProcessTreeTermination()
              observe?.({ phase: 'native-proof', confirmed })
              return confirmed
            }
          }
        : {}),
      annotateStderr: (stderr) => stderr,
      cleanup: async (reason, outcome) => {
        observe?.({
          phase: 'sandbox-cleanup',
          reason,
          processesTerminated: outcome.processesTerminated,
          canReconcile: Boolean(outcome.confirmTermination)
        })
        return {
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        }
      }
    }
  }
})

const shellRequest = (root: string): NotebookShellProcessRequest => ({
  command: 'short-lived command',
  runId: 'notebook-run-short-process',
  cwd: root,
  handoffDir: root,
  runtimeRoot: root,
  projectId: 'project',
  sessionId: 'session',
  runtimeBinding: { kind: 'powershell', version: '5.1' },
  timeoutMs: POWERSHELL_PROCESS_TIMEOUT_MS
})

const runPowerShell = (command: string): ReturnType<typeof runShellCommand> =>
  runShellCommand({
    command,
    cwd: process.cwd(),
    handoffDir: process.cwd(),
    runtimeRoot: join(process.cwd(), '.open-science-test-runtime'),
    sessionId: 'windows-shell-session',
    projectId: 'windows-shell-project',
    // Cold Windows PowerShell 5.1 module discovery on hosted runners can exceed Vitest's 15-second
    // default, while native-only and parser-error paths finish in under a second. Production allows
    // 120 seconds; this tighter process budget still detects a genuinely stuck shell.
    timeoutMs: POWERSHELL_PROCESS_TIMEOUT_MS
  })

describe.runIf(process.platform === 'win32')('Windows notebook shell integration', () => {
  it('persists two real standard REPL commands and releases their native owner on shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repl-native-persistence-'))
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'native-repl',
      repository: new NotebookRunRepository(root),
      processSandbox: owner
    })
    const wrap = owner.wrap.bind(owner)
    const launches: string[] = []
    const wrapping = vi.spyOn(owner, 'wrap').mockImplementation(async (invocation) => {
      const wrapped = await wrap(invocation)
      launches.push(wrapped.args[0])
      return wrapped
    })
    const scope = { sessionId: 'repl-persistence', workspaceCwd: root }
    const nonce = `REPL_${randomUUID()}`
    let cleanupVerified = false
    try {
      await expect(
        service.executeControl({
          ...scope,
          code: `globalThis.persistedNonce = ${JSON.stringify(nonce)}; console.log(persistedNonce)`
        })
      ).resolves.toMatchObject({ status: 'completed', stdout: `${nonce}\n` })
      await expect(
        service.executeControl({
          ...scope,
          code: 'console.log(persistedNonce + "_FOLLOWING")'
        })
      ).resolves.toMatchObject({ status: 'completed', stdout: `${nonce}_FOLLOWING\n` })
      expect(launches).toEqual(['supervise'])
      const persisted = await new NotebookRunRepository(root).loadOrCreate({
        ...scope,
        projectId: 'native-repl',
        lane: createRootNotebookLane(
          'native-repl',
          scope.sessionId,
          `root-frame-${scope.sessionId}`
        )
      })
      expect(persisted.runs).toHaveLength(2)
      expect(
        persisted.runs.map((run) => ({
          status: run.status,
          kernelKind: run.kernelKind,
          stdout: run.text.stdout
        }))
      ).toEqual([
        { status: 'completed', kernelKind: 'repl', stdout: `${nonce}\n` },
        { status: 'completed', kernelKind: 'repl', stdout: `${nonce}_FOLLOWING\n` }
      ])
      expect(new Set(persisted.runs.map((run) => run.runId)).size).toBe(2)
      await expect(service.shutdownAll()).resolves.toEqual({ reaped: true })
      expect(await readdir(join(root, 'commands'))).toEqual([])
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      cleanupVerified = true
    } finally {
      wrapping.mockRestore()
      const shutdown = await service.shutdownAll().catch(() => ({ reaped: false }))
      await service.dispose().catch(() => undefined)
      await owner.dispose().catch(() => undefined)
      vi.unstubAllEnvs()
      if (cleanupVerified || shutdown.reaped) await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([false, true])(
    'blocks B until A supplies its original native proof, then persists B exactly once (receipt retry: %s)',
    async (receiptRetry) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-native-admission-'))
      vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
      const info = vi.fn()
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
        temporaryRoot: join(root, 'commands'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny',
        logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() }
      })
      const registry = new ShellProcessOwnershipRegistry(root)
      const adapter = new NotebookShellProcessAdapter('win32', owner, registry)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'native-admission',
        repository: new NotebookRunRepository(root),
        shellProcess: adapter,
        shellRuntimeBinding: { kind: 'powershell', version: '5.1' }
      })
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await once(sentinel, 'spawn')
      const launch = NotebookNetworkSandbox.prototype.wrap
      let allowProof = false
      const proofs: Array<() => Promise<boolean>> = []
      const proofReads: number[] = []
      const native = vi
        .spyOn(NotebookNetworkSandbox.prototype, 'wrap')
        .mockImplementation(async function (this: NotebookNetworkSandbox, request) {
          const wrapped = await launch.call(this, request)
          expect(wrapped.argv[1]).toBe('supervise')
          expect(wrapped.confirmProcessTreeTermination).toBeTypeOf('function')
          const first = proofs.length === 0
          const index = proofs.length
          proofReads.push(0)
          let confirmed = false
          const confirm = async (): Promise<boolean> => {
            proofReads[index]++
            const result = await wrapped.confirmProcessTreeTermination!()
            confirmed ||= result
            return result
          }
          proofs.push(async () => confirmed || confirm())
          return {
            ...wrapped,
            // Inject only unavailable evidence. The real native Job and original receipt remain in use.
            confirmProcessTreeTermination: () =>
              first && !allowProof ? Promise.resolve(false) : confirm()
          }
        })
      const scope = (sessionId: string): { sessionId: string; workspaceCwd: string } => ({
        sessionId,
        workspaceCwd: root
      })
      const nonceA = `A_${randomUUID()}`
      const nonceB = `B_${randomUUID()}`
      let receiptRemoval: ReturnType<typeof vi.spyOn> | undefined
      let allNativeProofs = false
      try {
        const a = await service.executeShell({ ...scope('A'), command: `Write-Output '${nonceA}'` })
        expect(a).toMatchObject({ errorCode: 'shell-cleanup-incomplete' })
        expect(a.stdout).toContain(nonceA)
        expect(info).toHaveBeenCalledWith(
          'sandbox cleanup completed',
          expect.objectContaining({
            processesTerminated: false,
            networkClosed: true,
            temporaryResourcesRemoved: false
          })
        )
        expect(proofs).toHaveLength(1)
        const retained = await readdir(join(root, 'commands'))
        expect(retained).toHaveLength(2)
        const receiptName = retained.find((name) => name.endsWith('.receipt'))!
        const receipt = await readFile(join(root, 'commands', receiptName), 'utf8')
        expect(registry.hasReceipts()).toBe(true)
        for (let attempt = 0; attempt < 2; attempt++) {
          const blocked = await service.executeShell({
            ...scope('B'),
            command: `Write-Output '${nonceB}'`
          })
          expect(blocked).toMatchObject({
            errorCode: 'shell-cleanup-incomplete',
            recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
          })
          expect(blocked.stderr).toContain('SHELL_CLEANUP_INCOMPLETE')
          expect(proofs).toHaveLength(1)
          expect(await readdir(join(root, 'commands'))).toEqual(retained)
          expect(await readFile(join(root, 'commands', receiptName), 'utf8')).toBe(receipt)
          const blockedRuns = (await service.state(scope('B'))).runs
          expect(blockedRuns).toHaveLength(attempt + 1)
          expect(blockedRuns.every((run) => run.status === 'failed')).toBe(true)
          expect(sentinel.exitCode).toBeNull()
        }
        if (receiptRetry) {
          const remove = fsPromises.rm
          let rejected = false
          receiptRemoval = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
            if (!rejected && path === join(root, 'commands', receiptName)) {
              rejected = true
              throw new Error('Injected original command receipt removal failure')
            }
            return remove(path, options)
          })
        }
        allowProof = true
        if (receiptRetry) {
          const stillBlocked = await service.executeShell({
            ...scope('B'),
            command: `Write-Output '${nonceB}'`
          })
          expect(stillBlocked).toMatchObject({ errorCode: 'shell-cleanup-incomplete' })
          expect(proofs).toHaveLength(1)
          expect(await readFile(join(root, 'commands', receiptName), 'utf8')).toBe(receipt)
        }
        const b = await service.executeShell({ ...scope('B'), command: `Write-Output '${nonceB}'` })
        expect(b).toMatchObject({ exitCode: 0 })
        expect(b.errorCode).toBeUndefined()
        expect(b.stdout.trim()).toBe(nonceB)
        expect(proofs).toHaveLength(2)
        expect(proofReads).toEqual([1, 1])
        expect((await service.state(scope('A'))).runs).toHaveLength(1)
        const bRuns = (await service.state(scope('B'))).runs
        expect(bRuns).toHaveLength(receiptRetry ? 4 : 3)
        const completed = bRuns.filter((run) => run.status === 'completed')
        expect(completed).toHaveLength(1)
        expect(completed[0].text.stdout.trim()).toBe(nonceB)
        expect(await readdir(join(root, 'commands'))).toEqual([])
        expect(registry.hasReceipts()).toBe(false)
        expect(sentinel.exitCode).toBeNull()
      } finally {
        allowProof = true
        receiptRemoval?.mockRestore()
        allNativeProofs = (await Promise.all(proofs.map((confirm) => confirm()))).every(Boolean)
        native.mockRestore()
        const exited = once(sentinel, 'exit')
        sentinel.kill()
        await exited
        await service.dispose()
        await owner.dispose().catch(() => undefined)
        vi.unstubAllEnvs()
        // Preserve evidence when the original native owner cannot prove termination.
        if (allNativeProofs) await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.each([undefined, '0'])(
    'preserves the Shell workload Node-mode environment: %s',
    async (nodeMode) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-workload-env-'))
      try {
        const registry = new ShellProcessOwnershipRegistry(root)
        const adapter = new NotebookShellProcessAdapter(
          'win32',
          fixtureSandbox(root, 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "unset")'),
          registry
        )
        const result = await adapter.execute({
          ...shellRequest(root),
          environment: { ...process.env, ELECTRON_RUN_AS_NODE: nodeMode }
        })
        expect(result.stdout).toBe(nodeMode ?? 'unset')
        expect(result.exitCode).toBe(0)
        expect(registry.hasReceipts()).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  )

  it('allows updating after the application exits during shell identity capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-interrupted-owner-'))
    try {
      const controller = join(root, 'controller.cjs')
      await build({
        entryPoints: [join(__dirname, 'fixtures/windows-interrupted-shell-launch.ts')],
        outfile: controller,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        logLevel: 'silent'
      })
      await promisify(execFile)(
        join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
        [
          controller,
          root,
          join(
            process.cwd(),
            'packages/notebook-network-sandbox/vendor/windows',
            process.arch,
            'notebook-appcontainer-host.exe'
          ),
          join(process.cwd(), 'resources/notebook/kernel_process_host.js')
        ],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_PATH: join(process.cwd(), 'node_modules')
          },
          windowsHide: true,
          timeout: 20_000
        }
      ).catch((error) => {
        if (error.killed || error.code === 'ENOENT') throw error
      })
      expect(await readFile(join(root, 'workload-started'), 'utf8')).toBe('started')
      const restarted = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project'
      })
      try {
        await expect(restarted.shutdownAll()).resolves.toEqual({ reaped: true })
      } finally {
        await restarted.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30_000)

  it.each(['execute', 'prepare'] as const)(
    'keeps environment status recoverable after a short-lived shell process exits via %s',
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-status-short-process-'))
      const registry = new ShellProcessOwnershipRegistry(root)
      const adapter = new NotebookShellProcessAdapter(
        'win32',
        fixtureSandbox(root, 'process.stdout.write("finished")'),
        registry
      )
      try {
        const result =
          entry === 'execute'
            ? await adapter.execute(shellRequest(root))
            : await (await adapter.prepare(shellRequest(root))).execute()
        const lifecycle = createNotebookEnvironmentLifecycle({
          root,
          provisioner: undefined,
          projectProgress: () => undefined,
          waitForRecovery: () => new ShellProcessOwnershipRegistry(root).recover()
        })
        await expect(lifecycle.status(), JSON.stringify(result)).resolves.toMatchObject({
          provisioning: false
        })
        expect(result).toMatchObject({ stdout: 'finished', stderr: '', exitCode: 0 })
        expect(registry.hasReceipts()).toBe(false)
        const service = new NotebookRuntimeService({
          configRoot: root,
          dataRoot: root,
          projectId: 'project',
          repository: new NotebookRunRepository(root)
        })
        await expect(service.recoverInterruptedOperations()).resolves.toBeUndefined()
        await expect(service.shutdownAll()).resolves.toEqual({ reaped: true })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it('reports unconfirmed launch cleanup as a failure that requires cleanup verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-unconfirmed-launch-'))
    const registry = new ShellProcessOwnershipRegistry(root)
    const sandbox = fixtureSandbox(root, 'process.exit(0)')
    // Exercise the existing adapter contract when no native tree proof is available.
    const adapter = new NotebookShellProcessAdapter(
      'win32',
      { wrap: (invocation) => sandbox.wrap({ ...invocation, superviseProcessTree: false }) },
      registry
    )
    const info = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      repository: new NotebookRunRepository(root),
      shellProcess: adapter,
      shellRuntimeBinding: { kind: 'powershell', version: '5.1' },
      logger: { info, warn: vi.fn(), error: vi.fn() }
    })
    try {
      const request = { sessionId: 'session', workspaceCwd: root, command: 'short-lived command' }
      const result = await service.executeShell(request)
      expect(result).toMatchObject({
        errorCode: 'shell-cleanup-incomplete',
        recovery: { execution: 'may-have-run', retryAfter: 'cleanup-verified' }
      })
      expect((await service.state(request)).runs[0]).toMatchObject({ status: 'failed' })
      expect(info).toHaveBeenCalledWith(
        'shell execution completed',
        expect.objectContaining({ status: 'failed', cleanupState: 'incomplete' })
      )
      expect(registry.hasReceipts()).toBe(true)
      await expect(new ShellProcessOwnershipRegistry(root).recover()).rejects.toMatchObject({
        code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
      })
      await expect(service.shutdownAll()).resolves.toMatchObject({ reaped: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['exit', 'timeout', 'cancel'] as const)(
    'reaps a detached descendant before releasing ownership after %s',
    async (ending) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-owned-descendant-'))
      const pidPath = join(root, 'descendant.pid')
      const code = `
// Model cold startup beyond the old 500ms budget before the descendant exists.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
const child = require('node:child_process').spawn(process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
child.unref();
${ending === 'exit' ? '' : 'setInterval(() => {}, 1000);'}
`
      const events: Record<string, unknown>[] = []
      const observe = (event: Record<string, unknown>): void => {
        events.push(event)
      }
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      // Observe the real taskkill without changing its arguments, result or invocation count.
      vi.mocked(spawn).mockImplementation((...args) => {
        const child = actual.spawn(...args)
        if (args[0] === 'taskkill') {
          const event = {
            phase: 'taskkill',
            stdout: '',
            stderr: '',
            exitCode: null as number | null,
            signal: null as NodeJS.Signals | null
          }
          observe(event)
          child.stdout?.on('data', (chunk: Buffer) => {
            event.stdout = (event.stdout + chunk.toString()).slice(0, 4096)
          })
          child.stderr?.on('data', (chunk: Buffer) => {
            event.stderr = (event.stderr + chunk.toString()).slice(0, 4096)
          })
          child.once('exit', (code, signal) => {
            event.exitCode = code
            event.signal = signal
          })
        }
        return child
      })
      const terminate = processTree.terminateProcessTree
      const termination = vi
        .spyOn(processTree, 'terminateProcessTree')
        .mockImplementation(async (...args) => {
          const result = await terminate(...args)
          observe({ phase: 'terminate-result', ...result })
          return result
        })
      const registry = new ShellProcessOwnershipRegistry(root)
      const adapter = new NotebookShellProcessAdapter(
        'win32',
        fixtureSandbox(root, code, observe),
        registry
      )
      const controller = new AbortController()
      const execution = adapter.execute({
        ...shellRequest(root),
        timeoutMs: POWERSHELL_PROCESS_TIMEOUT_MS,
        signal: controller.signal
      })
      try {
        if (ending === 'cancel') {
          await vi.waitFor(async () => expect(await readFile(pidPath, 'utf8')).toMatch(/^\d+$/), {
            timeout: 10_000
          })
          controller.abort()
        }
        const result = await execution
        const pid = Number(await readFile(pidPath, 'utf8'))
        expect(pid).toBeGreaterThan(0)
        // Windows can acknowledge Job termination before the descendant's process object is
        // fully signalled. Wait for read-only absence; never signal a saved, possibly reused PID.
        await vi.waitFor(
          () =>
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })),
          { timeout: 4000 }
        )
        const diagnostic = JSON.stringify({
          ending,
          events,
          hasReceipts: registry.hasReceipts(),
          result: {
            errorCode: result.errorCode,
            ownedTreeReaped: result.ownedTreeReaped,
            cancelled: result.cancelled,
            exitCode: result.exitCode
          }
        })
        expect(result.errorCode, diagnostic).toBeUndefined()
        expect(result.ownedTreeReaped).not.toBe(false)
        if (ending === 'exit') expect(result.exitCode).toBe(0)
        if (ending === 'timeout')
          expect(result.stderr).toContain(`timed out after ${POWERSHELL_PROCESS_TIMEOUT_MS}ms`)
        if (ending === 'cancel') expect(result.cancelled).toBe(true)
        expect(registry.hasReceipts()).toBe(false)
        await expect(new ShellProcessOwnershipRegistry(root).recover()).resolves.toBeUndefined()
      } finally {
        controller.abort()
        await execution
        termination.mockRestore()
        vi.mocked(spawn).mockImplementation(actual.spawn)
        await rm(root, { recursive: true, force: true })
      }
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it('retains the receipt when the native termination proof cannot be verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-missing-proof-'))
    const registry = new ShellProcessOwnershipRegistry(root)
    const sandbox = fixtureSandbox(root, 'process.exit(0)')
    const adapter = new NotebookShellProcessAdapter(
      'win32',
      {
        wrap: async (invocation) => {
          const wrapped = await sandbox.wrap(invocation)
          return {
            ...wrapped,
            confirmProcessTreeTermination: async () => {
              // Reap the real fixture but model an unreadable proof at the existing system port.
              await wrapped.confirmProcessTreeTermination?.()
              return false
            }
          }
        }
      },
      registry
    )
    try {
      const result = await adapter.execute(shellRequest(root))
      expect(result).toMatchObject({
        errorCode: 'shell-cleanup-incomplete',
        ownedTreeReaped: false
      })
      expect(registry.hasReceipts()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves multi-chunk output from a normally exiting supervised command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-supervised-output-'))
    const registry = new ShellProcessOwnershipRegistry(root)
    const adapter = new NotebookShellProcessAdapter(
      'win32',
      fixtureSandbox(
        root,
        'process.stdout.write("x".repeat(256 * 1024)); process.stderr.write("y".repeat(12 * 1024))'
      ),
      registry
    )
    try {
      const result = await adapter.execute(shellRequest(root))
      expect(result).toMatchObject({
        stdout: 'x'.repeat(256 * 1024),
        stderr: 'y'.repeat(12 * 1024),
        exitCode: 0
      })
      expect(result.truncated).not.toBe(true)
      expect(registry.hasReceipts()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it(
    'stops after a failing cmdlet',
    async () => {
      const result = await runPowerShell(
        'Get-Item "missing-open-science-file"; Write-Output "continued"'
      )

      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('continued')
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'propagates a native process exit code',
    async () => {
      const executable = process.execPath.replaceAll("'", "''")
      const result = await runPowerShell(`& '${executable}' -e 'process.exit(7)' | Out-Null`)

      expect(result.exitCode).toBe(7)
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'preserves UTF-8 output with only standard machine module paths',
    async () => {
      const result = await runPowerShell(`
Write-Output "分析完成"
Write-Output "__OPEN_SCIENCE_PSMODULEPATH__=$env:PSModulePath"
Write-Output "__OPEN_SCIENCE_INTERNAL__=[$env:OPEN_SCIENCE_PSMODULEPATH]"
`)

      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain('分析完成')
      const programFiles = process.env.ProgramFiles
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
      expect(programFiles).toBeTruthy()
      expect(windowsRoot).toBeTruthy()
      if (!programFiles || !windowsRoot) throw new Error('Missing standard Windows path variables.')
      const modulePath = result.stdout.match(/^__OPEN_SCIENCE_PSMODULEPATH__=(.*)$/mu)?.[1]?.trim()
      expect(modulePath?.split(';').map((entry) => entry.toLowerCase())).toEqual([
        `${programFiles}\\WindowsPowerShell\\Modules`.toLowerCase(),
        `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`.toLowerCase()
      ])
      expect(result.stdout).toContain('__OPEN_SCIENCE_INTERNAL__=[]')
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'rejects a trailing continuation without consuming the wrapper',
    async () => {
      const result = await runPowerShell('Write-Output "isolated" `')

      expect(result.exitCode).toBeNull()
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/parse|syntax/i)
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )
})
