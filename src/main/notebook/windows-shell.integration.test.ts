import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

const POWERSHELL_PROCESS_TIMEOUT_MS = 30_000
const POWERSHELL_TEST_TIMEOUT_MS = POWERSHELL_PROCESS_TIMEOUT_MS + 5_000

// Use the production native supervisor when requested, while keeping the workload harmless and
// independent of machine PowerShell startup speed, network access, and AppContainer installation.
const fixtureSandbox = (root: string, code: string): NotebookProcessSandbox => ({
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
        ? { confirmProcessTreeTermination: launch.confirmProcessTreeTermination }
        : {}),
      annotateStderr: (stderr) => stderr,
      cleanup: async (_reason, outcome) => ({
        processesTerminated: outcome.processesTerminated,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
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
const child = require('node:child_process').spawn(process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
child.unref();
${ending === 'exit' ? '' : 'setInterval(() => {}, 1000);'}
`
      const registry = new ShellProcessOwnershipRegistry(root)
      const adapter = new NotebookShellProcessAdapter('win32', fixtureSandbox(root, code), registry)
      const controller = new AbortController()
      const execution = adapter.execute({
        ...shellRequest(root),
        timeoutMs: ending === 'timeout' ? 500 : POWERSHELL_PROCESS_TIMEOUT_MS,
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
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(result.errorCode).toBeUndefined()
        expect(result.ownedTreeReaped).not.toBe(false)
        if (ending === 'exit') expect(result.exitCode).toBe(0)
        if (ending === 'timeout') expect(result.stderr).toContain('timed out after 500ms')
        if (ending === 'cancel') expect(result.cancelled).toBe(true)
        expect(registry.hasReceipts()).toBe(false)
        await expect(new ShellProcessOwnershipRegistry(root).recover()).resolves.toBeUndefined()
      } finally {
        controller.abort()
        await execution
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
