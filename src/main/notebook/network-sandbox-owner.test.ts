import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { promisify } from 'node:util'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import type { NotebookNetworkSettings } from '../../shared/notebook-network-settings'
import { flushLogs, initLogger, type Logger } from '@aipoch/diagnostics/node'
import type {
  NotebookSandboxCleanupReason,
  NotebookSandboxProcessOutcome,
  NotebookSandboxInvocation
} from './process-sandbox'

const backend = vi.hoisted(() => ({
  request: undefined as
    | ((request: {
        host: string
        protocol?: 'http' | 'https'
        port?: number
        purpose?: 'probe' | 'block'
        canResume?: () => boolean
        addresses?: readonly string[]
        policyAllowed?: boolean
      }) => Promise<boolean>)
    | undefined,
  initialize: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue({
    processesTerminated: true,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }),
  resetNetworkConnections: vi.fn(),
  setExecutionActive: vi.fn(),
  wrap: vi.fn(),
  updatePolicy: vi.fn(),
  updateConfiguration: vi.fn(),
  status: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
  installWindows: vi.fn().mockResolvedValue({ cancelled: false }),
  removeWindows: vi.fn().mockResolvedValue({ cancelled: false }),
  isWindowsProtectionConfigured: vi.fn().mockResolvedValue(true),
  getWindowsRuntimeAccess: vi.fn().mockResolvedValue({ authorized: true, registered: true }),
  setWindowsRuntimeAccess: vi.fn().mockResolvedValue({ cancelled: false }),
  rKernelProtocolProbe: vi.fn().mockResolvedValue(true),
  dispose: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    readFile: vi.fn(actual.readFile),
    mkdir: vi.fn(actual.mkdir),
    open: vi.fn(actual.open)
  }
})

vi.mock('@aipoch/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/environment')>()),
  rKernelProtocolProbe: backend.rKernelProtocolProbe
}))

vi.mock('@aipoch/notebook-network-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/notebook-network-sandbox')>()),
  NotebookNetworkSandbox: class {
    status = backend.status
    initialize = backend.initialize
    wrap = backend.wrap
    updatePolicy = backend.updatePolicy
    updateConfiguration = backend.updateConfiguration
    installWindows = backend.installWindows
    removeWindows = backend.removeWindows
    isWindowsProtectionConfigured = backend.isWindowsProtectionConfigured
    getWindowsRuntimeAccess = backend.getWindowsRuntimeAccess
    setWindowsRuntimeAccess = backend.setWindowsRuntimeAccess
    dispose = backend.dispose
  }
}))

import {
  NotebookNetworkSandboxOwner,
  commandLine,
  type NotebookNetworkDecision
} from './network-sandbox-owner'
import { WindowsNotebookRuntimeManager } from './windows-runtime-manager'
import { WindowsRuntimeComponentStore } from './windows-runtime-components'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookKernelExecutor } from './kernel-executor'
import { runShellCommand } from './shell-process'
import { DEFAULT_R_ENV, envPrefix, legacyDefaultEnvPrefix, rScriptBin } from '@aipoch/environment'
import {
  beginMigration,
  beginMigrationPreparation,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

const fixtureDirectories: string[] = []
// A fallback test needs an actually whitespace-free parent, including on hosts whose TEMP
// contains the reported username pattern. Do not manufacture a candidate under that TEMP.
const rTemporaryTestParent = [join(process.cwd(), '.cache'), tmpdir()].find(
  (path) => !/\s/u.test(path)
)
let diagnosticLogRoot: string | undefined
afterAll(async () => {
  await flushLogs()
  if (diagnosticLogRoot) await rm(diagnosticLogRoot, { recursive: true, force: true })
})
type Verification = { argv: readonly string[]; env: NodeJS.ProcessEnv }
const runVerification = async (verification: Verification): Promise<void> => {
  await promisify(execFile)(verification.argv[0]!, [...verification.argv.slice(1)], {
    env: verification.env
  })
}

const createCapturingLogger = (): { logger: Logger; records: unknown[] } => {
  const records: unknown[] = []
  const capture = (message: string, data?: unknown): void => {
    records.push({ message, data })
  }
  return {
    logger: { debug: capture, info: capture, warn: capture, error: capture },
    records
  }
}

beforeEach(() => {
  backend.request = undefined
  vi.clearAllMocks()
  backend.status.mockResolvedValue({ kind: 'ready', warnings: [] })
  backend.isWindowsProtectionConfigured.mockResolvedValue(true)
  backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: true, registered: true })
  backend.setWindowsRuntimeAccess.mockImplementation(
    async (_executable, authorized: boolean, verification?: Verification) => {
      if (authorized && verification) await runVerification(verification)
      return { cancelled: false }
    }
  )
  backend.rKernelProtocolProbe.mockResolvedValue(true)
  backend.installWindows.mockResolvedValue({ cancelled: false })
  backend.removeWindows.mockResolvedValue({ cancelled: false })
  backend.cleanup.mockImplementation(async (processOutcome) => ({
    processesTerminated: processOutcome.processesTerminated,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }))
  backend.wrap.mockImplementation(
    async (command: {
      env?: NodeJS.ProcessEnv
      superviseProcessTree?: boolean
      onNetworkAccessRequest: (request: {
        host: string
        port?: number
        protocol?: 'http' | 'https'
        purpose?: 'probe' | 'block'
        addresses?: readonly string[]
        policyAllowed?: boolean
        signal: AbortSignal
      }) => Promise<boolean>
    }) => {
      if (command.env?.R_ENABLE_JIT === '0')
        return {
          argv: [
            process.execPath,
            '-e',
            `console.log(${JSON.stringify(tmpdir())}); process.exit(77)`
          ],
          env: process.env,
          annotateStderr: (stderr: string) => stderr,
          resetNetworkConnections: backend.resetNetworkConnections,

          setExecutionActive: backend.setExecutionActive,
          confirmProcessTreeTermination: async () => true,
          cleanup: (
            _reason: NotebookSandboxCleanupReason,
            outcome: NotebookSandboxProcessOutcome
          ) => backend.cleanup(outcome)
        }
      const controller = new AbortController()
      backend.request = ({ host, port, protocol, purpose, canResume, addresses, policyAllowed }) =>
        command.onNetworkAccessRequest({
          host,
          protocol,
          addresses,
          policyAllowed,
          purpose,
          ...(canResume ? { canResume } : {}),
          ...(port === undefined ? {} : { port }),
          signal: controller.signal
        })
      return {
        argv: ['/sandbox/sh', '-c', 'wrapped'],
        env: { HTTPS_PROXY: 'http://127.0.0.1:4567' },
        ...(command.superviseProcessTree
          ? { confirmProcessTreeTermination: async () => true }
          : {}),
        annotateStderr: (stderr: string) => stderr,
        resetNetworkConnections: backend.resetNetworkConnections,
        setExecutionActive: backend.setExecutionActive,
        cleanup: async (
          _reason: NotebookSandboxCleanupReason,
          processOutcome: NotebookSandboxProcessOutcome
        ) => {
          controller.abort(new Error('Notebook process ended.'))
          return backend.cleanup(processOutcome)
        }
      }
    }
  )
})

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('NotebookNetworkSandboxOwner', () => {
  it.each([
    { visitSettings: false, background: false, failure: undefined },
    { visitSettings: true, background: false, failure: undefined },
    { visitSettings: false, background: true, failure: undefined },
    { visitSettings: true, background: false, failure: 'mode-change' },
    { visitSettings: true, background: true, failure: 'mode-change' },
    { visitSettings: false, background: false, failure: 'components' }
  ])(
    'admits a protected PowerShell query after restart (Settings visited: $visitSettings, background: $background, failure: $failure)',
    async ({ visitSettings, background, failure }) => {
      const root = await mkdtemp(join(tmpdir(), 'os-cold-shell-'))
      fixtureDirectories.push(root)
      const select = vi
        .spyOn(WindowsRuntimeComponentStore.prototype, 'select')
        .mockImplementation(async (releases, request) => ({
          release: releases.find(
            (release) => release.component === request.component && release.source === 'patched'
          )!,
          root,
          executable: join(root, request.component === 'node' ? 'node.exe' : 'pwsh.exe')
        }))
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        windowsRuntimeRoot: join(root, 'protected-runtimes'),
        temporaryRoot: join(root, 'commands'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project',
        platform: 'win32',
        processSandbox: owner,
        shellBackgroundExecutionEnabled: true,
        shellRuntimeBinding: { kind: 'powershell', version: '7.6' }
      })
      // The component store models an already-installed verified runtime. Stop at the existing
      // native launch boundary, without changing machine protection or running a fixture binary.
      backend.wrap.mockRejectedValue(new Error('fixture reached native launch'))
      try {
        if (visitSettings) await owner.status()
        if (failure === 'mode-change')
          backend.isWindowsProtectionConfigured.mockResolvedValue(false)
        if (failure === 'components')
          select.mockRejectedValueOnce(new Error('Protected components missing'))
        const expectedError =
          failure === 'mode-change'
            ? 'Notebook protection changed. Retry in the same conversation after the Shell capability refresh completes.'
            : failure === 'components'
              ? 'Protected components missing'
              : 'fixture reached native launch'
        const request = {
          sessionId: 'cold-shell',
          executionInvocationId: 'shell-query',
          workspaceCwd: root,
          command: '$PSVersionTable.PSVersion.ToString()'
        }
        if (background) {
          const receipt = await service.executeShellBackground(request)
          await service.waitForBackgroundRun(receipt.runId)
          const result = await service.getBackgroundRun({ ...request, runId: receipt.runId })
          expect(result.run.text.stderr).toBe(expectedError)
        } else {
          const result = await service.executeShell(request)
          expect(result.stderr).toBe(expectedError)
          if (failure)
            expect(result).toMatchObject({
              runtimeStatus: 'unavailable',
              errorCode: 'shell-runtime-unavailable',
              recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
            })
        }
        if (failure) {
          const state = await service.state(request)
          expect(state.runs).toHaveLength(1)
          expect(state.runs[0]).toMatchObject({
            status: 'failed',
            text: { stderr: expectedError },
            shellRuntimeStatus: 'unavailable',
            shellErrorCode: 'shell-runtime-unavailable',
            recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
          })
          expect(backend.wrap).not.toHaveBeenCalled()
          // Restoring readiness must not execute an already admitted submission again.
          backend.isWindowsProtectionConfigured.mockResolvedValue(true)
          if (background) {
            const replay = await service.executeShellBackground(request)
            expect(replay.runId).toBe(state.runs[0].runId)
          } else {
            await expect(service.executeShell(request)).resolves.toMatchObject({
              stderr: expectedError,
              runtimeStatus: 'unavailable'
            })
          }
          expect((await service.state(request)).runs).toHaveLength(1)
          expect(backend.wrap).not.toHaveBeenCalled()
          const changedRequest = { ...request, command: 'Write-Output different' }
          await expect(
            background
              ? service.executeShellBackground(changedRequest)
              : service.executeShell(changedRequest)
          ).rejects.toThrow('NOTEBOOK_RUN_SUBMISSION_CONFLICT')
        } else {
          expect(select).toHaveBeenCalledTimes(2)
          expect(backend.wrap).toHaveBeenCalledOnce()
        }
        expect(select.mock.calls.every(([, request]) => !request.allowDownload)).toBe(true)
      } finally {
        await service.shutdownAll()
        await owner.dispose()
        select.mockRestore()
      }
    }
  )

  it.each(['parent', 'shared root'])(
    'skips an R temporary candidate with a preexisting junction at its %s',
    async (location) => {
      const root = await mkdtemp(join(tmpdir(), 'os-r-temp-junction-'))
      fixtureDirectories.push(root)
      const candidate = join(root, 'candidate')
      const safeParent = join(root, 'safe')
      const destination = join(root, 'existing-data')
      await mkdir(safeParent)
      await mkdir(destination)
      await writeFile(join(destination, 'keep.txt'), 'untouched')
      if (location === 'shared root') await mkdir(candidate)
      const link = location === 'parent' ? candidate : join(candidate, 'open-science-notebook')
      await symlink(destination, link, 'junction')
      vi.stubEnv('TMPDIR', candidate)
      vi.stubEnv('TMP', safeParent)
      vi.stubEnv('TEMP', safeParent)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, 'Test User', 'commands'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      let wrapped: Awaited<ReturnType<typeof owner.wrap>> | undefined
      try {
        wrapped = await owner.wrap({
          executable: process.execPath,
          args: [],
          env: {},
          cwd: root,
          commandText: 'temporary junction regression',
          sessionId: 'r-temp-junction',
          projectId: 'r-temp-junction',
          runtime: 'r',
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        const command = backend.wrap.mock.calls.at(-1)![0]
        const directory = command.env.TMPDIR as string
        expect(directory.startsWith(join(safeParent, 'open-science-notebook', 'command-'))).toBe(
          true
        )
        expect(command.filesystem.readWriteRoots).toEqual([directory])
        expect(await readdir(destination)).toEqual(['keep.txt'])
        await wrapped.cleanup('exit', { processesTerminated: true })
        expect(existsSync(directory)).toBe(false)
        expect(existsSync(`${directory}.receipt`)).toBe(false)
        expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('untouched')
      } finally {
        await wrapped?.cleanup('exit', { processesTerminated: true })
        await owner.dispose()
        vi.unstubAllEnvs()
        await unlink(link)
      }
    }
  )

  it.skipIf(!rTemporaryTestParent).each([
    { platform: 'win32' as const, runtime: 'r' as const, wsl: false, fallback: true },
    {
      platform: 'win32' as const,
      runtime: 'r' as const,
      wsl: false,
      fallback: true,
      temporaryParent: 'Temp With Spaces'
    },
    { platform: 'win32' as const, runtime: 'python' as const, wsl: false, fallback: false },
    { platform: 'linux' as const, runtime: 'r' as const, wsl: false, fallback: false },
    { platform: 'win32' as const, runtime: 'r' as const, wsl: true, fallback: false }
  ])('selects and cleans R temporary storage for %j', async (testCase) => {
    await mkdir(rTemporaryTestParent!, { recursive: true })
    const root = await mkdtemp(join(rTemporaryTestParent!, 'os-r-temp-policy-'))
    fixtureDirectories.push(root)
    const configured = join(root, 'Test User', 'commands')
    const temporaryParent = join(root, testCase.temporaryParent ?? '')
    await mkdir(temporaryParent, { recursive: true })
    const unavailable = join(root, 'not-a-directory')
    await writeFile(unavailable, 'preserve')
    vi.stubEnv('TMPDIR', unavailable)
    vi.stubEnv('TMP', temporaryParent)
    vi.stubEnv('TEMP', join(root, 'Other User'))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      temporaryRoot: configured,
      platform: testCase.platform,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      const wrapped = await owner.wrap({
        executable: process.execPath,
        args: [],
        env: {},
        cwd: root,
        commandText: 'temporary directory regression',
        sessionId: 'r-temp-policy',
        projectId: 'r-temp-policy',
        runtime: testCase.runtime,
        ...(testCase.wsl
          ? { target: { kind: 'wsl2' as const, profileId: 'test', distro: 'test', user: 'test' } }
          : {}),
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const command = backend.wrap.mock.calls.at(-1)![0]
      const directory = command.env.TMPDIR as string
      expect(directory).toMatch(new RegExp('command-[0-9a-f-]+$'))
      expect(
        directory.startsWith(
          join(
            testCase.fallback ? join(temporaryParent, 'open-science-notebook') : configured,
            'command-'
          )
        )
      ).toBe(true)
      expect(command.env.TMP).toBe(directory)
      expect(command.env.TEMP).toBe(directory)
      expect(command.filesystem.readWriteRoots).toContain(directory)
      const failure = "Fatal error: 'R_TempDir' contains space"
      expect(wrapped.annotateStderr(failure)).toBe(
        testCase.fallback
          ? `${failure}\nR could not use the selected temporary directory. Set TMPDIR to a writable directory without spaces and restart Open-Science.`
          : failure
      )
      backend.cleanup.mockResolvedValueOnce({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: false
      })
      await wrapped.cleanup('exit', { processesTerminated: false })
      expect(existsSync(directory)).toBe(true)
      expect(existsSync(`${directory}.receipt`)).toBe(true)
      backend.cleanup.mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      await wrapped.cleanup('exit', { processesTerminated: true })
      expect(existsSync(directory)).toBe(false)
      expect(existsSync(`${directory}.receipt`)).toBe(false)
      expect(await readFile(unavailable, 'utf8')).toBe('preserve')
    } finally {
      vi.unstubAllEnvs()
      await owner.dispose()
    }
  })

  it
    .skipIf(
      process.platform !== 'win32' ||
        !process.env.OPEN_SCIENCE_TEST_R_CONDA_PREFIX ||
        !rTemporaryTestParent
    )
    .for([
      { managedParent: 'plain', spacedHostTemp: false },
      { managedParent: 'Test User', spacedHostTemp: false },
      { managedParent: 'Test User', spacedHostTemp: true }
    ])(
    'verifies real R under $managedParent with spaced host temp=$spacedHostTemp',
    async ({ managedParent, spacedHostTemp }, context) => {
      const prefix = process.env.OPEN_SCIENCE_TEST_R_CONDA_PREFIX!
      await mkdir(rTemporaryTestParent!, { recursive: true })
      const root = await mkdtemp(join(rTemporaryTestParent!, 'r-temp-spaces-'))
      fixtureDirectories.push(root)
      let temporaryParent = root
      if (spacedHostTemp) {
        // The system volume may provide short names even when the app-data volume does not.
        temporaryParent = await mkdtemp(join(tmpdir(), 'R Temp With Spaces '))
        fixtureDirectories.push(temporaryParent)
        try {
          const { stdout } = await promisify(execFile)(
            join(prefix, 'Lib', 'R', 'bin', 'Rscript.exe'),
            ['--vanilla', '-e', 'cat(1 + 1)'],
            {
              env: {
                ...process.env,
                PATH: `${join(prefix, 'Library', 'bin')};${process.env.PATH ?? ''}`,
                TMPDIR: temporaryParent,
                TMP: temporaryParent,
                TEMP: temporaryParent
              },
              windowsHide: true,
              timeout: 15_000
            }
          )
          expect(stdout.trim()).toBe('2')
        } catch (error) {
          if ((error as { stderr?: string }).stderr?.includes("'R_TempDir' contains space")) {
            context.skip('The host filesystem does not provide an R-compatible spaced temp path')
          }
          throw error
        }
      }
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, temporaryParent)
      backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
      // Keep the real owner, environment and R process. Only native containment is replaced;
      // no administrator setup or persistent runtime authorization is needed for this path test.
      backend.wrap.mockImplementation(
        async (command: { executable: string; args: string[]; env: NodeJS.ProcessEnv }) => ({
          argv: [command.executable, ...command.args],
          env: command.env,
          annotateStderr: (value: string) => value,
          resetNetworkConnections: backend.resetNetworkConnections,
          setExecutionActive: backend.setExecutionActive,
          confirmProcessTreeTermination: async () => true,
          cleanup: (
            _reason: NotebookSandboxCleanupReason,
            outcome: NotebookSandboxProcessOutcome
          ) => backend.cleanup(outcome)
        })
      )
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, managedParent, 'notebook-command-temp'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      try {
        await expect(
          owner.ensureRuntimeAccess({
            runtime: 'r',
            executable: join(prefix, 'Lib', 'R', 'bin', 'Rscript.exe'),
            sessionId: 'r-temp-spaces'
          })
        ).resolves.toEqual({ windowsProtectionRequired: true, windowsRuntimeAccessRequired: false })
      } finally {
        vi.unstubAllEnvs()
        await owner.dispose()
      }
    }
  )

  it('preserves the failed R probe and gives guidance when no compatible temporary parent exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-r-temp-guidance-'))
    fixtureDirectories.push(root)
    const configured = join(root, 'Test User', 'commands')
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, configured)
    await mkdir(configured, { recursive: true })
    const stderr = "Fatal error: 'R_TempDir' contains space\r\n\r\n"
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    // Replay the captured R startup diagnostic through the existing public probe and a real
    // subprocess. This tests guidance, independently of whether this volume supports 8.3 paths.
    backend.wrap.mockImplementationOnce(async (command: { env: NodeJS.ProcessEnv }) => ({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(stderr)}); process.exit(2)`
      ],
      env: command.env,
      annotateStderr: (value: string) => value,
      resetNetworkConnections: backend.resetNetworkConnections,
      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      temporaryRoot: configured,
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      await expect(
        owner.ensureRuntimeAccess({
          runtime: 'r',
          executable: process.execPath,
          sessionId: 'r-temp-guidance'
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Set TMPDIR to a writable directory without spaces'),
        cause: expect.objectContaining({ code: 2, stderr })
      })
      const commandRoot = backend.wrap.mock.calls[0]![0].env.TMPDIR as string
      expect(commandRoot.startsWith(join(configured, 'open-science-notebook', 'command-'))).toBe(
        true
      )
      expect(existsSync(commandRoot)).toBe(false)
      expect(existsSync(`${commandRoot}.receipt`)).toBe(false)
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      await owner.dispose()
    }
  })

  it.each(
    (['darwin', 'linux', 'win32', 'wsl2'] as const).flatMap((target) =>
      (['python', 'r', 'repl', 'bash'] as const).map((runtime) => ({ target, runtime }))
    )
  )(
    'makes managed Skill resources read-only for $runtime on $target',
    async ({ target, runtime }) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-skill-resources-')))
      fixtureDirectories.push(root)
      const configRoot = join(root, 'config')
      const skills = join(configRoot, 'codex', 'skills')
      await mkdir(skills, { recursive: true })
      const owner = new NotebookNetworkSandboxOwner({
        configRoot,
        resourceRoot: root,
        temporaryRoot: join(root, 'tmp'),
        platform: target === 'wsl2' ? 'win32' : target,
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        // A broad user grant must not turn the built-in Skill read grant into write access.
        getGrantedLocalRoots: async () => [
          { id: 'config', name: 'config', path: configRoot, access: 'rw' }
        ],
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny'
      })
      try {
        const wrapped = await owner.wrap({
          ...(target === 'wsl2'
            ? {
                target: {
                  kind: 'wsl2',
                  profileId: 'wsl',
                  distro: 'Ubuntu',
                  user: 'researcher'
                } as const
              }
            : {}),
          executable: process.execPath,
          args: [],
          env: {},
          cwd: root,
          commandText: 'read Skill reference',
          sessionId: 'skill-session',
          projectId: 'skill-project',
          runtime,
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        const filesystem = backend.wrap.mock.calls.at(-1)![0].filesystem
        expect(filesystem.readOnlyRoots).toContain(skills)
        expect(filesystem.deniedWriteRoots).toContain(skills)
        expect(filesystem.readWriteRoots).not.toContain(skills)
        await wrapped.cleanup('exit', { processesTerminated: true })
      } finally {
        await owner.dispose()
      }
    }
  )

  it.each([true, false])(
    'parks a Shell network request, deduplicates it, and releases only a live connection (%s)',
    async (connectionLive) => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-network-approval-'))
      fixtureDirectories.push(root)
      const decision = Promise.withResolvers<'allowOnce'>()
      const requestDecision = vi.fn(() => decision.promise)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, 'tmp'),
        platform: 'linux',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision
      })
      const wrapped = await owner.wrap({
        executable: '/bin/sh',
        args: ['-c', 'sample-client request'],
        env: {},
        cwd: root,
        commandText: 'sample-client request',
        executionReference: 'run-fixture',
        sessionId: 'session-fixture',
        projectId: 'project-fixture',
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const waiting = vi.fn()
      const end = wrapped.beginExecution!({
        commandText: 'sample-client request',
        onNetworkWaitChange: waiting
      })
      const first = backend.request!({
        host: 'service.example.test',
        port: 443,
        purpose: 'block',
        canResume: () => connectionLive
      })
      const duplicate = backend.request!({
        host: 'service.example.test',
        port: 443,
        purpose: 'block',
        canResume: () => connectionLive
      })
      await vi.waitFor(() => expect(requestDecision).toHaveBeenCalledOnce())
      expect(requestDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: 'service.example.test',
          executionId: 'run-fixture',
          commandFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      )
      expect(waiting).toHaveBeenLastCalledWith(true)
      let settled = false
      void first.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      decision.resolve('allowOnce')
      await expect(first).resolves.toBe(connectionLive)
      await expect(duplicate).resolves.toBe(connectionLive)
      expect(waiting).toHaveBeenLastCalledWith(false)
      expect(wrapped.networkApprovalRetryRequired?.()).toBe(!connectionLive)
      end()
      await wrapped.cleanup('exit', { processesTerminated: true })
      await owner.dispose()
    }
  )

  it.each([undefined, true, false])(
    'projects folder restriction %s while preserving explicit roots',
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), 'os-folder-policy-'))
      fixtureDirectories.push(root)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, 'tmp'),
        platform: 'darwin',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        getFolderRestrictionEnabled: enabled === undefined ? undefined : async () => enabled,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny'
      })
      const wrapped = await owner.wrap({
        executable: '/bin/sh',
        args: ['-c', 'true'],
        env: {},
        cwd: root,
        commandText: 'true',
        sessionId: 's',
        projectId: 'p',
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [root],
          deniedReadRoots: [join(root, 'secret')],
          deniedWriteRoots: []
        }
      })
      expect(backend.wrap).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filesystem: expect.objectContaining({
            restrictFolders: enabled !== false,
            deniedReadRoots: [join(root, 'secret')]
          })
        })
      )
      await wrapped.cleanup('exit', { processesTerminated: true })
      await owner.dispose()
    }
  )

  it.each(
    [false, true].flatMap((configured) =>
      [false, true].flatMap((restrictFolders) =>
        (['python', 'r', 'repl', 'bash'] as const).map((runtime) => ({
          configured,
          restrictFolders,
          runtime
        }))
      )
    )
  )(
    'pins $runtime launch mode (protected: $configured, folder preference: $restrictFolders)',
    async ({ configured, restrictFolders, runtime }) => {
      backend.isWindowsProtectionConfigured.mockResolvedValue(configured)
      const root = await mkdtemp(join(tmpdir(), 'os-windows-mode-'))
      fixtureDirectories.push(root)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, 'commands'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        getFolderRestrictionEnabled: async () => restrictFolders,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      try {
        const wrapped = await owner.wrap({
          executable: process.execPath,
          args: [],
          env: {},
          cwd: root,
          commandText: 'query public database',
          sessionId: 's',
          projectId: 'p',
          runtime,
          superviseProcessTree: true,
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [root],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        expect(backend.wrap).toHaveBeenCalledWith(
          expect.objectContaining({
            windowsProtectionRequired: configured,
            superviseProcessTree: true,
            filesystem: expect.objectContaining({ restrictFolders: configured })
          })
        )
        expect(wrapped.env.HTTPS_PROXY).toBe('http://127.0.0.1:4567')
        expect(wrapped.beginSpawn).toBeTypeOf('function')
        expect(backend.installWindows).not.toHaveBeenCalled()
        await wrapped.cleanup('exit', { processesTerminated: true })
      } finally {
        await owner.dispose()
      }
    }
  )

  it('refuses explicit protected admission when protection is no longer configured', async () => {
    backend.isWindowsProtectionConfigured.mockResolvedValue(false)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/unused',
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getFolderRestrictionEnabled: async () => false,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    await expect(
      owner.wrap({
        executable: 'powershell.exe',
        args: [],
        env: {},
        cwd: 'C:\\workspace',
        commandText: 'true',
        sessionId: 's',
        projectId: 'p',
        runtime: 'bash',
        windowsProtectionRequired: true,
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    ).rejects.toThrow('require Windows protected mode')
    expect(backend.wrap).not.toHaveBeenCalled()
    await owner.dispose()
  })

  it.each([false, true])(
    'enforces installer admission with Windows protection configured: %s',
    async (configured) => {
      backend.isWindowsProtectionConfigured.mockResolvedValue(configured)
      const root = await mkdtemp(join(tmpdir(), 'os-installer-admission-'))
      fixtureDirectories.push(root)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        temporaryRoot: join(root, 'commands'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      const { sandboxedPackageSpawn } = await import('./package-process-sandbox')
      backend.wrap.mockRejectedValue(new Error('installer reached backend'))
      try {
        const spawn = sandboxedPackageSpawn({
          processSandbox: owner,
          request: { language: 'python', packages: ['example'] },
          runtimeRoot: root,
          storageRoot: root,
          platform: 'win32'
        })
        await expect(spawn(process.execPath, ['-m', 'pip', '--version'], {})).rejects.toThrow(
          'installer reached backend'
        )
        expect(backend.wrap).toHaveBeenCalledWith(
          expect.objectContaining({
            superviseProcessTree: true,
            windowsProtectionRequired: configured
          })
        )
      } finally {
        await owner.dispose()
      }
    }
  )

  it
    .runIf(process.platform === 'win32')
    .each(['directory', 'receipt', 'persistent-directory'] as const)(
    'keeps cleanup truthful when a Windows reader locks the command %s',
    async (resource) => {
      const fixture = await mkdtemp(join(tmpdir(), 'os-command-cleanup-lock-'))
      fixtureDirectories.push(fixture)
      const { logger, records } = createCapturingLogger()
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        temporaryRoot: join(fixture, 'commands'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn(),
        platform: 'win32',
        logger
      })
      const wrapped = await owner.wrap({
        executable: process.execPath,
        args: ['-e', ''],
        env: {},
        cwd: fixture,
        commandText: '',
        sessionId: 'session',
        projectId: 'project',
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [fixture],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
      const path = resource === 'receipt' ? `${root}.receipt` : join(root, 'temporary-file')
      if (resource !== 'receipt') await writeFile(path, 'temporary content')
      const holder = spawn(
        resolveWindowsPowerShellExecutable(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$file = [IO.File]::Open($env:TEST_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [Console]::WriteLine("locked"); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }'
        ],
        { env: { ...process.env, TEST_LOCK_PATH: path }, windowsHide: true }
      )
      const closed = once(holder, 'close')
      let release: ReturnType<typeof setTimeout> | undefined
      try {
        const [output] = await once(holder.stdout, 'data')
        expect(output.toString()).toContain('locked')
        const transient = resource !== 'persistent-directory'
        if (transient) release = setTimeout(() => holder.stdin.end('\n'), 750)
        await expect(wrapped.cleanup('exit', { processesTerminated: true })).resolves.toEqual({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: transient
        })
        expect(existsSync(root)).toBe(!transient)
        expect(existsSync(`${root}.receipt`)).toBe(!transient)
        expect(backend.cleanup).toHaveBeenCalledOnce()
        if (!transient) {
          expect(records).toContainEqual({
            message: 'sandbox cleanup completed',
            data: expect.objectContaining({
              result: 'incomplete',
              temporaryCleanupErrorCode: expect.stringMatching(/^(EBUSY|EPERM|ENOTEMPTY)$/)
            })
          })
        }
      } finally {
        clearTimeout(release)
        holder.stdin.end('\n')
        await closed
        await owner.dispose()
      }
    },
    15_000
  )
  it('keeps inherited PATH access optional only on native Windows while preserving explicit roots', async () => {
    const pathRoot = await mkdtemp(join(tmpdir(), 'open-science-path-root-'))
    fixtureDirectories.push(pathRoot)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      temporaryRoot: join(pathRoot, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: process.platform
    })
    try {
      for (const required of [false, true]) {
        const wrapped = await owner.wrap({
          executable: process.execPath,
          args: ['-e', 'console.log(1)'],
          env: { PATH: pathRoot },
          cwd: tmpdir(),
          commandText: 'console.log(1)',
          sessionId: 'path-test',
          projectId: 'path-test',
          runtime: 'repl',
          filesystem: {
            readOnlyRoots: required ? [pathRoot] : [],
            readWriteRoots: [],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        const request = backend.wrap.mock.calls.at(-1)![0]
        expect(request.env.PATH).toBe(pathRoot)
        expect(request.filesystem.readOnlyRoots.includes(pathRoot)).toBe(
          required || process.platform !== 'win32'
        )
        if (process.platform === 'win32') {
          expect(request.filesystem.optionalReadOnlyRoots).toContain(pathRoot)
        } else {
          expect(request.filesystem.optionalReadOnlyRoots).toBeUndefined()
        }
        await wrapped.cleanup('exit', { processesTerminated: true })
      }
    } finally {
      await owner.dispose()
    }
  })

  it.each([false, true])(
    'removes the managed R grant before path replacement (cancelled: %s)',
    async (cancelled) => {
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn(),
        platform: 'win32'
      })
      backend.setWindowsRuntimeAccess.mockResolvedValueOnce({ cancelled })
      const operation = owner.revokeManagedRAccess('/data/runtime')
      if (cancelled) await expect(operation).rejects.toThrow('permission removal was cancelled')
      else await expect(operation).resolves.toBeUndefined()
      expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(
        rScriptBin(envPrefix('/data/runtime', DEFAULT_R_ENV, 'win32'), 'win32'),
        false
      )
      if (!cancelled) {
        expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(
          rScriptBin(legacyDefaultEnvPrefix('/data/runtime', DEFAULT_R_ENV), 'win32'),
          false
        )
      }
      expect(backend.wrap).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'revokes historical R layout grants even if x64 is missing: %s',
    async (missing) => {
      const root = await mkdtemp(join(tmpdir(), 'os-r-revoke-x64-'))
      fixtureDirectories.push(root)
      const bin = join(envPrefix(root, DEFAULT_R_ENV, 'win32'), 'Lib', 'R', 'bin', 'x64')
      await mkdir(bin, { recursive: true })
      const executable = join(bin, 'Rscript.exe')
      if (!missing) await writeFile(executable, 'fixture')
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn(),
        platform: 'win32'
      })
      try {
        await owner.revokeManagedRAccess(root)
        expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(executable, false)
        for (const prefix of [
          envPrefix(root, DEFAULT_R_ENV, 'win32'),
          legacyDefaultEnvPrefix(root, DEFAULT_R_ENV)
        ]) {
          for (const architecture of ['', 'x64']) {
            expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(
              join(prefix, 'Lib', 'R', 'bin', architecture, 'Rscript.exe'),
              false
            )
          }
        }
      } finally {
        await owner.dispose()
      }
    }
  )

  it('does not pass parent secrets or R startup overrides to the runtime verification child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-r-verification-env-'))
    fixtureDirectories.push(root)
    const observation = join(root, 'child-environment.json')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-only-parent-secret')
    vi.stubEnv('R_HOME', 'test-only-parent-r-home')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: 'win32'
    })
    // Keep the existing sandbox adapter seam; a real child observes the environment supplied by
    // the public authorization/verification operation without requiring R or administrator access.
    backend.wrap.mockImplementationOnce(async (command: { env: NodeJS.ProcessEnv }) => ({
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ secret: process.env.AWS_SECRET_ACCESS_KEY ?? null, rHome: process.env.R_HOME ?? null })); console.log('OPEN_SCIENCE_R_ACCESS_OK')`
      ],
      env: command.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,
      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }))
    try {
      await expect(
        owner.setWindowsRuntimeAccess('D:\\external-r\\bin\\Rscript.exe', true)
      ).resolves.toEqual({ cancelled: false })
      expect(JSON.parse(await readFile(observation, 'utf8'))).toEqual({
        secret: null,
        rHome: null
      })
    } finally {
      vi.unstubAllEnvs()
      await owner.dispose()
    }
  })

  it('reconciles exact durable command temp receipts left by a prior host process', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-temp-recovery-'))
    fixtureDirectories.push(fixtureRoot)
    const managedRoot = join(fixtureRoot, 'managed-command-temp')
    const commandId = '01234567-89ab-4cde-8fab-0123456789ab'
    const commandRoot = join(managedRoot, `command-${commandId}`)
    const receipt = join(managedRoot, `command-${commandId}.receipt`)
    const nativeId = '11234567-89ab-4cde-8fab-0123456789ab'
    const nativeRoot = join(managedRoot, `command-${nativeId}`)
    const nativeReceipt = `${nativeRoot}.receipt`
    await mkdir(commandRoot, { recursive: true })
    await mkdir(nativeRoot, { recursive: true })
    await writeFile(
      receipt,
      `v1 command-${commandId} wsl2 profile-1 Ubuntu-22.04 open-science-spike\n`
    )
    await writeFile(nativeReceipt, `v1 command-${nativeId} native\n`)
    await writeFile(join(commandRoot, 'left-by-crash.txt'), 'temporary')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: fixtureRoot,
      temporaryRoot: managedRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })

    await owner.initialize()

    expect(existsSync(commandRoot)).toBe(true)
    const wrapped = await owner.wrap({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      executable: '/bin/bash',
      args: ['-c', 'true'],
      env: {},
      cwd: 'C:\\workspace',
      commandText: 'true',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash',
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(existsSync(commandRoot)).toBe(false)
    expect(existsSync(receipt)).toBe(false)
    expect(existsSync(nativeRoot)).toBe(true)
    expect(existsSync(nativeReceipt)).toBe(true)
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it('does not reconcile a live temp root during an overlapping same-profile WSL wrap', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-overlapping-wsl-'))
    fixtureDirectories.push(fixtureRoot)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: fixtureRoot,
      temporaryRoot: join(fixtureRoot, 'managed-command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const invocation = {
      target: {
        kind: 'wsl2' as const,
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      executable: '/bin/bash',
      args: ['-c', 'sleep 30'],
      env: {},
      cwd: 'C:\\workspace',
      commandText: 'sleep 30',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash' as const,
      filesystem: {
        readOnlyRoots: [] as string[],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [] as string[],
        deniedWriteRoots: [] as string[]
      }
    }

    const first = await owner.wrap(invocation)
    const firstRoot = backend.wrap.mock.calls.at(-1)?.[0].env.TMPDIR as string
    const second = await owner.wrap({ ...invocation, commandText: 'sleep 31' })

    expect(existsSync(firstRoot)).toBe(true)
    expect(existsSync(`${firstRoot}.receipt`)).toBe(true)
    await first.cleanup('cancel', { processesTerminated: true })
    expect(existsSync(firstRoot)).toBe(false)
    await second.cleanup('cancel', { processesTerminated: true })
    await owner.dispose()
  })

  it('removes durable command temp ownership after verified preparation cleanup', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-preparation-cleanup-'))
    fixtureDirectories.push(fixtureRoot)
    const managedRoot = join(fixtureRoot, 'managed-command-temp')
    let commandTempRoot = ''
    backend.wrap.mockImplementationOnce(async (command: { env: NodeJS.ProcessEnv }) => {
      commandTempRoot = command.env.TMPDIR!
      const cause = new Error('runtime unavailable')
      throw Object.assign(new Error(cause.message, { cause }), {
        name: 'NotebookSandboxPreparationError',
        cleanupComplete: true as const
      })
    })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: fixtureRoot,
      temporaryRoot: managedRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })

    await expect(
      owner.wrap({
        executable: '/bin/sh',
        args: ['-c', 'true'],
        env: {},
        cwd: '/workspace',
        commandText: 'true',
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['/workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    ).rejects.toThrow('runtime unavailable')
    expect(existsSync(commandTempRoot)).toBe(false)
    expect(existsSync(`${commandTempRoot}.receipt`)).toBe(false)
    await owner.dispose()
  })

  it('quotes executable arguments without allowing shell interpolation', () => {
    expect(
      commandLine(
        { executable: '/path with spaces/python', args: ["it's", '$(touch /tmp/nope)'] },
        'linux'
      )
    ).toBe(`'/path with spaces/python' 'it'"'"'s' '$(touch /tmp/nope)'`)
  })

  it('invokes quoted Windows executables through PowerShell', () => {
    expect(
      commandLine(
        {
          executable: 'C:\\Program Files\\Python\\python.exe',
          args: ["O'Brien", '$(Write-Error injected)']
        },
        'win32'
      )
    ).toBe("& 'C:\\Program Files\\Python\\python.exe' 'O''Brien' '$(Write-Error injected)'")
  })

  it('preserves the executable and arguments for a Windows sandbox launch', async () => {
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: 'win32'
    })

    const wrapped = await owner.wrap({
      executable: 'D:\\runtime\\python.exe',
      args: ['D:\\app\\python_loop.py'],
      env: { PATH: 'C:\\Windows\\System32' },
      cwd: 'D:\\workspace',
      commandText: 'python_loop.py',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python',
      superviseProcessTree: true,
      filesystem: {
        readOnlyRoots: ['D:\\runtime'],
        readWriteRoots: ['D:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(backend.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "& 'D:\\runtime\\python.exe' 'D:\\app\\python_loop.py'",
        executable: 'D:\\runtime\\python.exe',
        args: ['D:\\app\\python_loop.py'],
        superviseProcessTree: true
      })
    )
    await expect(wrapped.confirmProcessTreeTermination?.()).resolves.toBe(true)

    await wrapped.cleanup('exit', { processesTerminated: true })
  })

  it('scopes derived package mirror access to the installer process', async () => {
    const requestDecision = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'linux'
    })
    const invocation = {
      executable: '/usr/bin/python',
      args: ['script.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python script.py',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python' as const,
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }

    const installer = await owner.wrap({
      ...invocation,
      allowedNetworkHosts: ['packages.example.org']
    })
    const installerRequest = backend.request!
    const notebook = await owner.wrap(invocation)
    const notebookRequest = backend.request!

    const endInstaller = installer.beginExecution?.()
    await expect(installerRequest({ host: 'packages.example.org', port: 443 })).resolves.toBe(true)
    await expect(installerRequest({ host: 'redirect.example.org', port: 443 })).resolves.toBe(false)
    await expect(
      installerRequest({ host: 'packages.example.org', port: 443, purpose: 'probe' })
    ).resolves.toBe(true)
    endInstaller?.()
    await expect(
      installerRequest({ host: 'packages.example.org', port: 443, purpose: 'probe' })
    ).resolves.toBe(false)
    const endNotebook = notebook.beginExecution?.()
    await expect(notebookRequest({ host: 'packages.example.org', port: 443 })).resolves.toBe(false)
    endNotebook?.()
    expect(requestDecision).not.toHaveBeenCalled()
    expect(backend.updatePolicy).not.toHaveBeenCalled()

    await installer.cleanup('exit', { processesTerminated: true })
    await notebook.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it.each(['bash', 'python', 'r', 'repl'] as const)(
    'uses live session full access for %s without persisting or requesting approval',
    async (runtime) => {
      let fullSession: string | undefined = 'session-1'
      let onFullAccess: ((allowed: boolean) => void) | undefined
      const unsubscribe = vi.fn()
      const requestDecision = vi.fn().mockResolvedValue('deny')
      const persistAlwaysAllow = vi.fn()
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        hasFullAccess: (sessionId) => sessionId === fullSession,
        subscribeFullAccess: (sessionId, listener) => {
          expect(sessionId).toBe('session-1')
          onFullAccess = listener
          return unsubscribe
        },
        persistAlwaysAllow,
        requestDecision,
        platform: 'linux'
      })
      const controller = new AbortController()
      const wrapped = await owner.wrap({
        signal: controller.signal,
        executable: '/usr/bin/runtime',
        args: [],
        env: {},
        cwd: '/workspace',
        commandText: 'download dataset',
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime,
        executionReference: 'execution-1',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['/workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const request = backend.request!
      await expect(request({ host: 'data.example.org' })).resolves.toBe(false)
      const end = wrapped.beginExecution?.()
      await expect(request({ host: 'data.example.org' })).resolves.toBe(true)
      await expect(request({ host: 'data.example.org', purpose: 'probe' })).resolves.toBe(true)
      expect(requestDecision).not.toHaveBeenCalled()
      backend.resetNetworkConnections.mockClear()
      fullSession = 'other-session'
      onFullAccess!(false)
      expect(backend.resetNetworkConnections).toHaveBeenCalledOnce()
      await expect(request({ host: 'data.example.org', purpose: 'probe' })).resolves.toBe(false)
      fullSession = 'session-1'
      onFullAccess!(true)
      expect(backend.resetNetworkConnections).toHaveBeenCalledOnce()
      await expect(request({ host: 'data.example.org', purpose: 'probe' })).resolves.toBe(true)
      controller.abort()
      await expect(request({ host: 'data.example.org', purpose: 'probe' })).resolves.toBe(false)
      end?.()
      expect(unsubscribe).toHaveBeenCalledOnce()
      await expect(request({ host: 'data.example.org', purpose: 'probe' })).resolves.toBe(false)
      expect(persistAlwaysAllow).not.toHaveBeenCalled()
      expect(backend.updatePolicy).not.toHaveBeenCalled()
      await wrapped.cleanup('exit', { processesTerminated: true })
      await owner.dispose()
    }
  )

  it('answers explicit full-access requests without command context or durable grants', async () => {
    const requestDecision = vi.fn().mockResolvedValue('deny')
    const persistAlwaysAllow = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      hasFullAccess: (sessionId) => sessionId === 'full-session',
      persistAlwaysAllow,
      requestDecision
    })
    const request = {
      sessionId: 'full-session',
      projectId: 'project',
      hostname: 'data.example.org',
      reason: 'Download'
    }
    await expect(owner.requestNetworkAccess(request)).resolves.toMatchObject({
      status: 'alreadyAllowed'
    })
    expect(requestDecision).not.toHaveBeenCalled()
    await expect(
      owner.requestNetworkAccess({ ...request, hostname: 'localhost' })
    ).resolves.toMatchObject({ status: 'alreadyAllowed' })
    await expect(
      owner.requestNetworkAccess({ ...request, signal: AbortSignal.abort() })
    ).resolves.toMatchObject({ status: 'denied', decisionSource: 'aborted' })
    expect(requestDecision).not.toHaveBeenCalled()
    await expect(
      owner.requestNetworkAccess({ ...request, sessionId: 'other-session' })
    ).resolves.toMatchObject({ status: 'alreadyAllowed' })
    expect(requestDecision).not.toHaveBeenCalled()
    expect(persistAlwaysAllow).not.toHaveBeenCalled()
    expect(backend.updatePolicy).not.toHaveBeenCalled()
    await owner.dispose()
  })

  it('records only a fixed error category when sandbox initialization fails', async () => {
    const { logger, records } = createCapturingLogger()
    backend.initialize.mockRejectedValueOnce(
      new Error(
        'Could not run curl https://private.example.org from /Users/example/private-study/data.csv'
      )
    )
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/private/resources/notebook-sandbox',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'linux',
      logger
    })

    await expect(owner.initialize()).rejects.toThrow('Could not run curl')

    const serialized = JSON.stringify(records)
    expect(serialized).toContain('"errorCategory":"error"')
    for (const privateValue of [
      'private.example.org',
      'curl',
      '/Users/example/private-study/data.csv',
      '/private/resources/notebook-sandbox'
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    await owner.dispose()
  })

  it('records Windows setup and removal outcomes without native details', async () => {
    const { logger, records } = createCapturingLogger()
    backend.removeWindows.mockResolvedValueOnce({ cancelled: true })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: 'C:\\private\\notebook-sandbox',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32',
      logger
    })

    await expect(owner.installWindows()).resolves.toEqual({ cancelled: false })
    await expect(owner.removeWindows()).resolves.toEqual({ cancelled: true })

    const serialized = JSON.stringify(records)
    expect(serialized).toContain('notebook-network-windows-setup')
    expect(serialized).toContain('notebook-network-windows-remove')
    expect(serialized).toContain('"outcome":"completed"')
    expect(serialized).toContain('"outcome":"cancelled"')
    expect(serialized).not.toContain('C:\\\\private\\\\notebook-sandbox')
    await owner.dispose()
  })

  it('keeps standard execution offline and rejects stale capabilities in either switch direction', async () => {
    const prepare = vi
      .spyOn(WindowsNotebookRuntimeManager.prototype, 'prepare')
      .mockRejectedValue(new Error('Prepare protected mode in Settings'))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      windowsRuntimeRoot: join(tmpdir(), 'fixture-runtime'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: 'win32'
    })
    try {
      backend.isWindowsProtectionConfigured.mockResolvedValue(false)
      const legacy = Object.freeze({ kind: 'powershell' as const, version: '5.1' as const })
      await expect(
        owner.resolveWindowsRuntime({ runtime: 'bash', binding: legacy })
      ).resolves.toBeNull()
      await expect(owner.resolveWindowsRuntime({ runtime: 'repl' })).resolves.toBeNull()
      expect(prepare).not.toHaveBeenCalled()
      await expect(
        owner.resolveWindowsRuntime({
          runtime: 'bash',
          binding: { kind: 'powershell', version: '7.6' }
        })
      ).rejects.toThrow('Shell capability refresh')
      expect(prepare).not.toHaveBeenCalled()
      backend.isWindowsProtectionConfigured.mockResolvedValue(true)
      await expect(
        owner.resolveWindowsRuntime({ runtime: 'bash', binding: legacy })
      ).rejects.toThrow('Shell capability refresh')
      expect(legacy.version).toBe('5.1')
      await expect(owner.windowsProtectionReady()).rejects.toThrow('Prepare protected mode')
    } finally {
      prepare.mockRestore()
      await owner.dispose()
    }
  })

  it.each(['bash', 'repl'] as const)(
    'rejects removed protection after selecting the protected %s interpreter',
    async (runtimeKind) => {
      const root = await mkdtemp(join(tmpdir(), 'os-selected-runtime-mode-'))
      fixtureDirectories.push(root)
      const runtime = { root, node: process.execPath, powershell: process.execPath }
      const prepare = vi
        .spyOn(WindowsNotebookRuntimeManager.prototype, 'prepare')
        .mockImplementation(async () => {
          backend.isWindowsProtectionConfigured.mockResolvedValue(false)
          return runtime
        })
      const get = vi.spyOn(WindowsNotebookRuntimeManager.prototype, 'get').mockReturnValue(runtime)
      backend.wrap.mockRejectedValue(new Error('unexpected standard launch'))
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: root,
        windowsRuntimeRoot: join(root, 'protected-runtimes'),
        temporaryRoot: join(root, 'commands'),
        platform: 'win32',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn()
      })
      const executor = new NotebookKernelExecutor({ platform: 'win32', processSandbox: owner })
      try {
        const request = {
          cwd: root,
          runtimeRoot: root,
          sessionId: 'selected-mode',
          projectId: 'project'
        }
        const result =
          runtimeKind === 'bash'
            ? await runShellCommand({
                ...request,
                command: 'echo query',
                handoffDir: root,
                platform: 'win32',
                runtimeBinding: { kind: 'powershell', version: '7.6' },
                processSandbox: owner
              })
            : await executor.execute({
                ...request,
                kind: 'repl',
                language: 'python',
                code: 'console.log("query")',
                dataRoot: root,
                notebookSessionRoot: root
              })
        expect(result.stderr).toContain('require Windows protected mode')
        expect(backend.wrap).not.toHaveBeenCalled()
      } finally {
        await executor.shutdown()
        await owner.dispose()
        prepare.mockRestore()
        get.mockRestore()
      }
    }
  )

  it('pins protection before validating the prepared interpreter identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mode-identity-race-'))
    fixtureDirectories.push(root)
    const get = vi.spyOn(WindowsNotebookRuntimeManager.prototype, 'get').mockImplementation(() => {
      backend.isWindowsProtectionConfigured.mockResolvedValue(false)
      return { root, node: process.execPath, powershell: process.execPath }
    })
    backend.wrap.mockRejectedValue(new Error('unexpected standard launch'))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      windowsRuntimeRoot: join(root, 'protected-runtimes'),
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      await expect(
        owner.wrap({
          executable: process.execPath,
          args: [],
          env: {},
          cwd: root,
          commandText: 'query',
          sessionId: 's',
          projectId: 'p',
          runtime: 'repl',
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
      ).rejects.toThrow('require Windows protected mode')
      expect(backend.wrap).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
      get.mockRestore()
    }
  })

  it('downloads only after explicit setup and reports failed preparation without a standard-mode fallback', async () => {
    const prepare = vi
      .spyOn(WindowsNotebookRuntimeManager.prototype, 'prepare')
      .mockRejectedValue(new Error('download failed'))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      windowsRuntimeRoot: join(tmpdir(), 'fixture-runtime'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: 'win32'
    })
    try {
      await expect(owner.installWindows()).rejects.toThrow('download failed')
      expect(prepare).toHaveBeenCalledWith(true, expect.any(AbortSignal))
      await expect(owner.status()).resolves.toMatchObject({
        kind: 'error',
        reason: 'runtimeFailure'
      })
      expect(backend.removeWindows).not.toHaveBeenCalled()
      backend.installWindows.mockResolvedValueOnce({ cancelled: true })
      prepare.mockClear()
      await expect(owner.installWindows()).resolves.toEqual({ cancelled: true })
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      prepare.mockRestore()
      await owner.dispose()
    }
  })

  it('returns stable status reasons instead of backend prose', async () => {
    const { logger, records } = createCapturingLogger()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'linux',
      logger
    })
    const sandbox = (
      owner as unknown as { getOrCreateSandbox: () => { status: ReturnType<typeof vi.fn> } }
    ).getOrCreateSandbox()
    sandbox.status.mockResolvedValue({
      kind: 'setupRequired',
      platform: 'linux',
      reasons: ['Notebook isolation requires bubblewrap (bwrap)']
    })

    await expect(owner.status()).resolves.toEqual({
      kind: 'setupRequired',
      platform: 'linux',
      reasons: ['linuxBubblewrapMissing']
    })
    await owner.status()
    expect(
      records.filter(
        (record) => (record as { message?: string }).message === 'sandbox status changed'
      )
    ).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain('Notebook isolation requires bubblewrap')
    await owner.dispose()
  })

  it('denies requests after a wrapped process has been cleaned up', async () => {
    const requestDecision = vi.fn().mockResolvedValue('allowOnce')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'linux'
    })

    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['script.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python script.py',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python',
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const firstCleanup = wrapped.cleanup('exit', { processesTerminated: true })
    const secondCleanup = wrapped.cleanup('cancel', { processesTerminated: true })
    await expect(firstCleanup).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await expect(secondCleanup).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(firstCleanup).toBe(secondCleanup)
    expect(backend.cleanup).toHaveBeenCalledOnce()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    expect(requestDecision).not.toHaveBeenCalled()
    await owner.dispose()
  })

  it('retains the command temp root until backend teardown succeeds and retries the same root', async () => {
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'linux'
    })
    backend.cleanup
      .mockResolvedValueOnce({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    const wrapped = await owner.wrap({
      executable: '/bin/sh',
      args: ['-c', 'sleep 30'],
      env: {},
      cwd: '/workspace',
      commandText: 'sleep 30',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash',
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const commandTempRoot = backend.wrap.mock.calls.at(-1)?.[0].env.TMPDIR as string
    const commandTempReceipt = `${commandTempRoot}.receipt`

    await expect(wrapped.cleanup('cancel', { processesTerminated: false })).resolves.toEqual({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: false
    })
    expect(existsSync(commandTempRoot)).toBe(true)
    expect(existsSync(commandTempReceipt)).toBe(true)
    const next = await owner.wrap({
      executable: '/bin/sh',
      args: ['-c', 'true'],
      env: {},
      cwd: '/workspace',
      commandText: 'true',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash',
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    expect(existsSync(commandTempRoot)).toBe(false)
    expect(existsSync(commandTempReceipt)).toBe(false)
    await next.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it.each(['incomplete', 'throw'] as const)(
    'permanently retires an owner command after %s package cleanup',
    async (failure) => {
      const { NotebookNetworkSandbox } = await vi.importActual<
        typeof import('../../../packages/notebook-network-sandbox/src/index')
      >('../../../packages/notebook-network-sandbox/src/index')
      const { NotebookNetworkRuntime } =
        await import('../../../packages/notebook-network-sandbox/runtime/src/index')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: '/resources' }
      })
      const status = vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
      const initialize = vi.spyOn(NotebookNetworkRuntime, 'initialize').mockResolvedValue(undefined)
      const runtimeWrap = vi.spyOn(NotebookNetworkRuntime, 'wrap').mockResolvedValue({
        argv: ['/sandbox/sh'],
        env: {}
      })
      const complete = {
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }
      const runtimeCleanup = vi
        .spyOn(NotebookNetworkRuntime, 'cleanupAfterCommand')
        .mockResolvedValue(complete)
      if (failure === 'throw') runtimeCleanup.mockRejectedValueOnce(new Error('cleanup failed'))
      else runtimeCleanup.mockResolvedValueOnce({ ...complete, temporaryResourcesRemoved: false })
      const activate = vi.spyOn(NotebookNetworkRuntime, 'setCommandExecutionActive')
      const reset = vi.spyOn(NotebookNetworkRuntime, 'reset').mockResolvedValue(undefined)
      const fixture = await mkdtemp(join(tmpdir(), 'os-owner-retirement-'))
      fixtureDirectories.push(fixture)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        temporaryRoot: join(fixture, 'commands'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn().mockResolvedValue('deny')
      })
      const invocation = {
        executable: '/bin/sh',
        args: ['-c', 'true'],
        env: {},
        cwd: '/workspace',
        commandText: 'true',
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'bash' as const,
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['/workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      }
      try {
        await sandbox.initialize()
        backend.wrap.mockImplementation((command) => sandbox.wrap(command))
        const wrapped = await owner.wrap(invocation)
        const end = wrapped.beginExecution?.()
        const cleanup = wrapped.cleanup('exit', { processesTerminated: true })
        expect(() => wrapped.beginExecution?.()).toThrow('already closed')
        await expect(cleanup).resolves.toMatchObject({ temporaryResourcesRemoved: false })
        end?.()
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(() => wrapped.beginExecution?.()).toThrow('already closed')
        }
        expect(activate.mock.calls.filter(([, active]) => active)).toHaveLength(1)
        await expect(wrapped.cleanup('exit', { processesTerminated: true })).resolves.toEqual(
          complete
        )
        expect(() => wrapped.beginExecution?.()).toThrow('already closed')
        const fresh = await owner.wrap(invocation)
        const endFresh = fresh.beginExecution?.()
        endFresh?.()
        await fresh.cleanup('exit', { processesTerminated: true })
        expect(activate.mock.calls.filter(([, active]) => active)).toHaveLength(2)
      } finally {
        await owner.dispose()
        await sandbox.dispose()
        reset.mockRestore()
        activate.mockRestore()
        runtimeCleanup.mockRestore()
        runtimeWrap.mockRestore()
        initialize.mockRestore()
        status.mockRestore()
      }
    }
  )

  it.each(['directory', 'receipt'] as const)(
    'preserves production package cleanup proof while retrying a locked command %s',
    async (lockedResource) => {
      const { NotebookNetworkSandbox } = await vi.importActual<
        typeof import('../../../packages/notebook-network-sandbox/src/index')
      >('../../../packages/notebook-network-sandbox/src/index')
      const { NotebookNetworkRuntime } =
        await import('../../../packages/notebook-network-sandbox/runtime/src/index')
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-cleanup-proof-'))
      fixtureDirectories.push(fixtureRoot)
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: '/resources' }
      })
      const status = vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
      const initialize = vi.spyOn(NotebookNetworkRuntime, 'initialize').mockResolvedValue(undefined)
      const runtimeWrap = vi
        .spyOn(NotebookNetworkRuntime, 'wrap')
        .mockResolvedValue({ argv: ['/sandbox/sh', '-c', 'wrapped'], env: {} })
      const runtimeCleanup = vi
        .spyOn(NotebookNetworkRuntime, 'cleanupAfterCommand')
        .mockImplementation(async (_commandId, _reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: outcome.processesTerminated
        }))
      const reset = vi.spyOn(NotebookNetworkRuntime, 'reset').mockResolvedValue(undefined)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        temporaryRoot: join(fixtureRoot, 'commands'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision: vi.fn().mockResolvedValue('deny')
      })
      const invocation = {
        executable: '/bin/sh',
        args: ['-c', 'true'],
        env: {},
        cwd: fixtureRoot,
        commandText: 'true',
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'bash' as const,
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [fixtureRoot],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      }
      const confirmTermination = vi.fn().mockResolvedValue(true)
      const { rm: originalRm } =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      let lockedPath: string | undefined
      const remove = vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === lockedPath) throw new Error('Command temporary resource is locked')
        await originalRm(path, options)
      })
      try {
        await sandbox.initialize()
        backend.wrap.mockImplementation((command) => sandbox.wrap(command))
        const wrapped = await owner.wrap(invocation)
        const commandRoot = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
        const receipt = `${commandRoot}.receipt`
        lockedPath = lockedResource === 'directory' ? commandRoot : receipt
        await expect(
          wrapped.cleanup('cancel', { processesTerminated: false, confirmTermination })
        ).resolves.toEqual({
          processesTerminated: false,
          networkClosed: true,
          temporaryResourcesRemoved: false
        })
        expect(confirmTermination).not.toHaveBeenCalled()
        expect(existsSync(commandRoot)).toBe(true)
        expect(existsSync(receipt)).toBe(true)

        // The original process owner now proves termination, but application cleanup still fails.
        await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
        expect(confirmTermination).toHaveBeenCalledOnce()
        expect(runtimeCleanup).toHaveBeenCalledTimes(2)
        expect(existsSync(commandRoot)).toBe(lockedResource === 'directory')
        expect(existsSync(receipt)).toBe(true)

        // Repeated and concurrent admissions cannot discard the proof or bypass the locked resource.
        await expect(
          Promise.allSettled([owner.wrap(invocation), owner.wrap(invocation)])
        ).resolves.toEqual([
          {
            status: 'rejected',
            reason: expect.objectContaining({
              message: expect.stringContaining('SHELL_CLEANUP_INCOMPLETE')
            })
          },
          {
            status: 'rejected',
            reason: expect.objectContaining({
              message: expect.stringContaining('SHELL_CLEANUP_INCOMPLETE')
            })
          }
        ])
        expect(runtimeWrap).toHaveBeenCalledOnce()
        expect(runtimeCleanup).toHaveBeenCalledTimes(2)
        expect(confirmTermination).toHaveBeenCalledOnce()
        expect(existsSync(receipt)).toBe(true)

        lockedPath = undefined
        const next = await owner.wrap({ ...invocation, sessionId: 'session-2' })
        expect(existsSync(commandRoot)).toBe(false)
        expect(existsSync(receipt)).toBe(false)
        expect(runtimeWrap).toHaveBeenCalledTimes(2)
        expect(runtimeCleanup).toHaveBeenCalledTimes(2)
        expect(confirmTermination).toHaveBeenCalledOnce()
        await expect(wrapped.cleanup('cancel', { processesTerminated: false })).resolves.toEqual({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
        await next.cleanup('exit', { processesTerminated: true })
      } finally {
        lockedPath = undefined
        try {
          await owner.dispose()
          await sandbox.dispose()
        } finally {
          remove.mockImplementation(originalRm)
          reset.mockRestore()
          runtimeCleanup.mockRestore()
          runtimeWrap.mockRestore()
          initialize.mockRestore()
          status.mockRestore()
        }
      }
    }
  )

  it('does not block a native kernel when cleanup remains incomplete for the previous WSL2 kernel', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-wsl2-to-native-'))
    fixtureDirectories.push(fixtureRoot)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      temporaryRoot: fixtureRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32'
    })
    backend.cleanup.mockResolvedValue({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
    const invocation = {
      executable: '/bin/bash',
      args: ['-c', 'true'],
      env: {},
      cwd: 'C:\\workspace',
      commandText: 'true',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash' as const,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }

    const wsl2 = await owner.wrap({
      ...invocation,
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      }
    })
    await expect(wsl2.cleanup('timeout', { processesTerminated: false })).resolves.toEqual({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })

    await expect(
      owner.wrap({
        ...invocation,
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoProfile', '-Command', 'Write-Output ready'],
        commandText: 'Write-Output ready',
        target: { kind: 'native' }
      })
    ).resolves.toMatchObject({ executable: '/sandbox/sh' })
    expect(backend.cleanup).toHaveBeenCalledTimes(1)
    expect(backend.wrap).toHaveBeenCalledTimes(2)
    await owner.dispose()
  })

  it('retries only the old WSL2 resource and blocks another kernel for the same profile', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'os-network-same-wsl2-retry-'))
    fixtureDirectories.push(fixtureRoot)
    const cleanupTargets: string[] = []
    backend.wrap.mockImplementation(async (command: { target: { kind: string } }) => ({
      argv: ['/sandbox/sh', '-c', 'wrapped'],
      env: {},
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      cleanup: async () => {
        cleanupTargets.push(command.target.kind)
        return {
          processesTerminated: false,
          networkClosed: false,
          temporaryResourcesRemoved: false
        }
      }
    }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      temporaryRoot: fixtureRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32'
    })
    const invocation = {
      target: {
        kind: 'wsl2' as const,
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      },
      executable: '/bin/bash',
      args: ['-c', 'true'],
      env: {},
      cwd: 'C:\\workspace',
      commandText: 'true',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash' as const,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }
    const first = await owner.wrap(invocation)

    await first.cleanup('timeout', { processesTerminated: false })
    await expect(owner.wrap(invocation)).rejects.toThrow(
      'SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.'
    )
    expect(cleanupTargets).toEqual(['wsl2', 'wsl2'])
    expect(backend.wrap).toHaveBeenCalledTimes(1)
    await owner.dispose()
  })

  it('defaults to native and forwards an explicit WSL2 sandbox target', async () => {
    const { logger, records } = createCapturingLogger()
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-owner-target-test-'))
    fixtureDirectories.push(temporaryRoot)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      temporaryRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32',
      logger
    })
    const invocation = {
      executable: '/usr/bin/python',
      args: ['script.py'],
      env: { PATH: 'C:\\Windows\\System32' },
      pathEnvironment: { UV_CACHE_DIR: 'C:\\workspace\\cache\\uv' },
      cwd: 'C:\\workspace',
      commandText: 'python script.py',
      executionReference: 'execution-safe-reference',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python' as const,
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }

    const native = await owner.wrap(invocation)
    const target = {
      kind: 'wsl2' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu',
      user: 'researcher'
    }
    const wsl2 = await owner.wrap({ ...invocation, target })

    expect(backend.wrap.mock.calls[0]?.[0]).toMatchObject({ target: { kind: 'native' } })
    expect(backend.wrap.mock.calls[1]?.[0]).toMatchObject({
      target,
      pathEnvironment: { UV_CACHE_DIR: 'C:\\workspace\\cache\\uv' }
    })
    expect(backend.wrap.mock.calls[1]?.[0]?.command).toBe("'/usr/bin/python' 'script.py'")
    expect(backend.wrap.mock.calls[1]?.[0]?.filesystem.readOnlyRoots).not.toContain(
      'C:\\Windows\\System32'
    )
    await native.cleanup('exit', { processesTerminated: true })
    backend.cleanup.mockResolvedValueOnce({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
    await expect(wsl2.cleanup('timeout', { processesTerminated: false })).resolves.toEqual({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
    const diagnosticText = JSON.stringify(records)
    expect(diagnosticText).toContain('sandbox cleanup completed')
    expect(diagnosticText).toContain('sandbox process prepared')
    expect(diagnosticText).toContain('execution-safe-reference')
    expect(diagnosticText).toContain('"phase":"sandbox-cleanup"')
    expect(diagnosticText).toContain('"result":"incomplete"')
    expect(diagnosticText).toContain('"incompleteStageCount":3')
    for (const phase of ['sandbox-prepare', 'sandbox-cleanup']) {
      const measured = records as Array<{ data?: { phase?: string; durationMs?: number } }>
      const durations = measured.filter(({ data }) => data?.phase === phase)
      expect(durations).toHaveLength(2)
      for (const { data } of durations) {
        expect(data?.durationMs).toEqual(expect.any(Number))
        expect(Number.isFinite(data?.durationMs)).toBe(true)
        expect(data!.durationMs).toBeGreaterThanOrEqual(0)
      }
    }
    expect(diagnosticText).not.toContain('python script.py')
    expect(diagnosticText).not.toContain('C:\\\\workspace')
    expect(diagnosticText).not.toContain('researcher')
    await owner.dispose()
  })

  it('projects custom trust and local folder grants without making the trust file writable', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'open-science-owner-test-'))
    fixtureDirectories.push(fixtureDirectory)
    const caBundle = join(fixtureDirectory, 'complete.pem')
    const writableData = join(fixtureDirectory, 'writable-data')
    const gitDirectory = join(writableData, '.git')
    const gitConfig = join(gitDirectory, 'config')
    const gitHooks = join(gitDirectory, 'hooks')
    await mkdir(gitHooks, { recursive: true })
    await writeFile(gitConfig, '[core]\n', 'utf8')
    await writeFile(caBundle, rootCertificates.join('\n'), 'utf8')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getCaBundlePath: async () => caBundle,
      getGrantedLocalRoots: async () => [
        { id: 'read-only', name: 'Read only', path: '/read-only-data', access: 'ro' },
        { id: 'writable', name: 'Writable', path: writableData, access: 'rw' }
      ],
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'linux'
    })

    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['script.py'],
      env: { PATH: '/usr/bin' },
      localRpcSocketPath: '/tmp/open-science-notebook.sock',
      cwd: '/workspace',
      commandText: 'python script.py',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python',
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    const canonicalCaBundle = await realpath(caBundle)
    expect(backend.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ SSL_CERT_FILE: canonicalCaBundle }),
        localRpcSocketPath: '/tmp/open-science-notebook.sock',
        filesystem: expect.objectContaining({
          readOnlyRoots: expect.arrayContaining([
            canonicalCaBundle,
            '/read-only-data',
            writableData
          ]),
          readWriteRoots: expect.arrayContaining([writableData]),
          deniedWriteRoots: expect.arrayContaining([canonicalCaBundle, gitDirectory])
        })
      })
    )
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it('keeps a linked-worktree git pointer read-only', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'open-science-owner-test-'))
    fixtureDirectories.push(fixtureDirectory)
    const gitPointer = join(fixtureDirectory, '.git')
    await writeFile(gitPointer, 'gitdir: /repository/.git/worktrees/notebook\n', 'utf8')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'linux'
    })

    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['script.py'],
      env: { PATH: '/usr/bin' },
      cwd: fixtureDirectory,
      commandText: 'python script.py',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'python',
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: [fixtureDirectory],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(backend.wrap.mock.calls.at(-1)?.[0].filesystem.deniedWriteRoots).toContain(gitPointer)
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })
})

describe('explicit access without a trusted block record', () => {
  it.each(['localhost', 'unknown.example', 'private.internal'])(
    'allows HTTPS %s without approval',
    async (hostname) => {
      const requestDecision = vi.fn()
      const persistAlwaysAllow = vi.fn()
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        platform: 'linux',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision,
        persistAlwaysAllow
      })
      expect(
        await owner.requestNetworkAccess({
          hostname,
          port: 80,
          protocol: 'https',
          projectId: 'p',
          sessionId: 's',
          reason: 'test'
        })
      ).toMatchObject({ hostname, port: 80, protocol: 'https', status: 'alreadyAllowed' })
      expect(requestDecision).not.toHaveBeenCalled()
      expect(persistAlwaysAllow).not.toHaveBeenCalled()
    }
  )
  it.each([
    ['localhost', 'http'],
    ['127.0.0.1', 'https'],
    ['[::1]', 'https']
  ] as const)('cannot create proactive authority for %s %s', async (hostname, protocol) => {
    const requestDecision = vi.fn()
    const persistAlwaysAllow = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      platform: 'linux',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision,
      persistAlwaysAllow
    })
    expect(
      await owner.requestNetworkAccess({
        hostname,
        port: 8080,
        protocol,
        projectId: 'p',
        sessionId: 's',
        reason: 'test'
      })
    ).toMatchObject({ port: 8080, protocol, status: 'blocked' })
    expect(requestDecision).not.toHaveBeenCalled()
    expect(persistAlwaysAllow).not.toHaveBeenCalled()
  })
})

it('does not automatically grant durable permissions to an agent-created R environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'os-r-named-access-'))
  fixtureDirectories.push(root)
  const ensureRuntimeAccess = vi.fn().mockRejectedValue(new Error('Unexpected UAC'))
  const wrap = vi.fn().mockRejectedValue(new Error('Named runtime reached sandbox'))
  const executor = new NotebookKernelExecutor({ processSandbox: { ensureRuntimeAccess, wrap } })
  try {
    await executor.execute({
      language: 'r',
      environment: 'analysis-env',
      code: 'cat(R.version.string)',
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: root,
      resolvedInterpreter: { command: process.execPath },
      sessionId: 'named',
      projectId: 'project'
    })
    expect(ensureRuntimeAccess).not.toHaveBeenCalled()
    expect(wrap).toHaveBeenCalledOnce()
  } finally {
    await executor.shutdown()
  }
})

it.each(['managed', 'external'] as const)(
  'runs %s R in unconfigured Windows standard mode without protection setup',
  async (selection) => {
    const root = await mkdtemp(join(tmpdir(), 'os-r-standard-'))
    fixtureDirectories.push(root)
    const bin = join(root, 'runtime', 'envs', '.r', 'Lib', 'R', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'R.exe'), '')
    await writeFile(join(bin, 'Rscript.exe'), '')
    backend.status.mockResolvedValue({ kind: 'setupRequired', platform: 'win32', reasons: [] })
    backend.isWindowsProtectionConfigured.mockResolvedValue(false)
    const started = vi.fn()
    const notStarted = vi.fn()
    const beginSpawn = vi.fn(() => ({ started, notStarted }))
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.wrap.mockImplementation(async (command: { env: NodeJS.ProcessEnv }) => ({
      argv: [
        process.execPath,
        '-e',
        `
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          console.log(JSON.stringify({ req_id: line.split(' ')[0], stdout: '15', stderr: '', error: null, figures: [] }));
        });
      `
      ],
      env: command.env,
      beginSpawn,
      annotateStderr: (value: string) => value,
      resetNetworkConnections: backend.resetNetworkConnections,
      setExecutionActive: backend.setExecutionActive,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      platform: 'win32',
      allowRuntimeAccessPrompt: false,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    const executor = new NotebookKernelExecutor({ processSandbox: owner, platform: 'win32' })
    try {
      const result = await executor.execute({
        language: 'r',
        code: 'sum(1:5)',
        cwd: root,
        notebookSessionRoot: root,
        dataRoot: root,
        runtimeRoot: join(root, 'runtime'),
        ...(selection === 'external' ? { resolvedInterpreter: { command: process.execPath } } : {}),
        sessionId: 'standard-r',
        projectId: 'project',
        timeoutMs: 5000
      })
      expect(result.status, result.stderr).toBe('completed')
      expect(result.stdout).toBe('15')
      expect(beginSpawn).toHaveBeenCalledOnce()
      expect(started).toHaveBeenCalledOnce()
      expect(notStarted).not.toHaveBeenCalled()
      expect(backend.wrap).toHaveBeenCalledWith(
        expect.objectContaining({
          windowsProtectionRequired: false,
          superviseProcessTree: true
        })
      )
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await executor.shutdown()
      await owner.dispose()
    }
  }
)

it('checks sandbox spawn admission before launching the R process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'os-r-spawn-admission-'))
  fixtureDirectories.push(root)
  const marker = join(root, 'spawned')
  const cleanup = vi.fn().mockResolvedValue({
    processesTerminated: true,
    networkClosed: true,
    temporaryResourcesRemoved: true
  })
  const beginSpawn = vi.fn(() => {
    throw new Error('Windows protection changed before R startup.')
  })
  const executor = new NotebookKernelExecutor({
    processSandbox: {
      wrap: async () => ({
        executable: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "started")'],
        env: process.env,
        beginSpawn,
        annotateStderr: (value: string) => value,
        cleanup
      })
    }
  })
  try {
    const result = await executor.execute({
      language: 'r',
      code: 'sum(1:5)',
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: root,
      resolvedInterpreter: { command: process.execPath },
      sessionId: 'r',
      projectId: 'p'
    })
    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('Windows protection changed')
    expect(result.kernelDispatched).toBe(false)
    expect(beginSpawn).toHaveBeenCalledOnce()
    expect(existsSync(marker)).toBe(false)
    expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
      processesTerminated: true,
      processState: 'never-started',
      confirmTermination: expect.any(Function)
    })
  } finally {
    await executor.shutdown()
  }
})

it('authorizes missing R access before the original Notebook cell is dispatched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'os-r-notebook-access-'))
  fixtureDirectories.push(root)
  const granted = join(root, 'access-granted')
  backend.getWindowsRuntimeAccess.mockImplementation(async () => ({
    authorized: existsSync(granted),
    registered: existsSync(granted)
  }))
  backend.setWindowsRuntimeAccess.mockImplementation(
    async (_executable, _authorized, verification?: Verification) => {
      await writeFile(granted, '')
      if (verification) await runVerification(verification)
      return { cancelled: false }
    }
  )
  backend.wrap.mockImplementation(async (command: { args?: string[]; env: NodeJS.ProcessEnv }) => {
    const verification = command.args?.some((arg) => arg.includes('OPEN_SCIENCE_R_ACCESS_OK'))
    const script = `
      if (!require('node:fs').existsSync(${JSON.stringify(granted)})) {
        if (process.env.R_ENABLE_JIT === '0') { console.log(${JSON.stringify(root)}); process.exit(77); }
        console.error('Error in normalizePath(path.expand(path), winslash, mustWork): Access is denied');
        process.exit(1);
      }
      ${
        verification
          ? "console.log('OPEN_SCIENCE_R_ACCESS_OK')"
          : `
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          console.log(JSON.stringify({ req_id: line.split(' ')[0], stdout: 'R_CELL_COMPLETED', stderr: '', error: null, figures: [] }));
        });
      `
      }
    `
    return {
      argv: [process.execPath, '-e', script],
      env: command.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }
  })
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: root,
    platform: 'win32',
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn(),
    allowRuntimeAccessPrompt: true
  })
  const executor = new NotebookKernelExecutor({ processSandbox: owner })
  try {
    const result = await executor.execute({
      language: 'r',
      code: 'cat(R.version.string)',
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: join(root, 'runtime'),
      resolvedInterpreter: { command: process.execPath, args: [] },
      sessionId: 'r-session',
      projectId: 'project',
      timeoutMs: 5_000
    })
    expect(result.status, result.stderr).toBe('completed')
    expect(result.stdout).toContain('R_CELL_COMPLETED')
    expect(backend.wrap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        windowsProtectionRequired: true,
        windowsRuntimeAccessRequired: true
      })
    )
    expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      true,
      expect.objectContaining({ argv: expect.any(Array), env: expect.any(Object) })
    )
  } finally {
    await executor.shutdown()
    await owner.dispose()
  }
})

it('opens the existing administrator authorization flow when the R ACL preflight is denied', async () => {
  backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
  backend.wrap.mockRejectedValueOnce(
    new Error('grant AppContainer access to D:\\R-4.6.1: WINDOWS_ACL_ACCESS_DENIED: access denied')
  )
  backend.wrap.mockImplementationOnce(async (command: { env: NodeJS.ProcessEnv }) => ({
    argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
    env: command.env,
    annotateStderr: (value: string) => value,
    resetNetworkConnections: backend.resetNetworkConnections,
    setExecutionActive: backend.setExecutionActive,
    confirmProcessTreeTermination: async () => true,
    cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
      backend.cleanup(outcome)
  }))
  backend.setWindowsRuntimeAccess.mockResolvedValue({ cancelled: false })
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: tmpdir(),
    platform: 'win32',
    allowRuntimeAccessPrompt: true,
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn()
  })
  try {
    await expect(
      owner.ensureRuntimeAccess({
        runtime: 'r',
        executable: 'D:\\R-4.6.1\\bin\\x64\\Rscript.exe',
        sessionId: 'r-acl-denied'
      })
    ).resolves.toEqual({ windowsProtectionRequired: true, windowsRuntimeAccessRequired: true })
    expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(
      'D:\\R-4.6.1\\bin\\x64\\Rscript.exe',
      true,
      expect.anything()
    )
  } finally {
    await owner.dispose()
  }
})

it('opens the administrator authorization flow when cleanup wraps the ACL preflight error', async () => {
  backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
  backend.wrap.mockRejectedValueOnce(
    new Error('R runtime verification cleanup could not be confirmed.', {
      cause: new Error(
        'grant AppContainer access to D:\\R-4.6.1: WINDOWS_ACL_ACCESS_DENIED: access denied'
      )
    })
  )
  backend.wrap.mockImplementationOnce(async (command: { env: NodeJS.ProcessEnv }) => ({
    argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
    env: command.env,
    annotateStderr: (value: string) => value,
    resetNetworkConnections: backend.resetNetworkConnections,
    setExecutionActive: backend.setExecutionActive,
    confirmProcessTreeTermination: async () => true,
    cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
      backend.cleanup(outcome)
  }))
  backend.setWindowsRuntimeAccess.mockResolvedValue({ cancelled: false })
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: tmpdir(),
    platform: 'win32',
    allowRuntimeAccessPrompt: true,
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn()
  })
  try {
    await expect(
      owner.ensureRuntimeAccess({
        runtime: 'r',
        executable: 'D:\\R-4.6.1\\bin\\x64\\Rscript.exe',
        sessionId: 'r-acl-cleanup-cause'
      })
    ).resolves.toEqual({ windowsProtectionRequired: true, windowsRuntimeAccessRequired: true })
    expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledWith(
      'D:\\R-4.6.1\\bin\\x64\\Rscript.exe',
      true,
      expect.anything()
    )
  } finally {
    await owner.dispose()
  }
})

it('does not authorize when an ACL marker appears only in the runtime path', async () => {
  backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
  const failure = new Error(
    'grant AppContainer access to D:\\WINDOWS_ACL_ACCESS_DENIED\\R: The system cannot find the path specified'
  )
  backend.wrap.mockRejectedValueOnce(failure)
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: tmpdir(),
    platform: 'win32',
    allowRuntimeAccessPrompt: true,
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn()
  })
  try {
    await expect(
      owner.ensureRuntimeAccess({
        runtime: 'r',
        executable: 'D:\\WINDOWS_ACL_ACCESS_DENIED\\R\\bin\\Rscript.exe',
        sessionId: 'r-path-marker'
      })
    ).rejects.toBe(failure)
    expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
  } finally {
    await owner.dispose()
  }
})

it('does not repeat a cancelled UAC prompt and reports cancellation before cell dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'os-r-uac-cancel-'))
  fixtureDirectories.push(root)
  backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
  backend.setWindowsRuntimeAccess.mockResolvedValue({ cancelled: true })
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: root,
    platform: 'win32',
    allowRuntimeAccessPrompt: true,
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn()
  })
  const executor = new NotebookKernelExecutor({ processSandbox: owner })
  const request = {
    language: 'r' as const,
    code: 'cat(R.version.string)',
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: join(root, 'runtime'),
    resolvedInterpreter: { command: process.execPath, args: [] },
    sessionId: 'r-session',
    projectId: 'project',
    timeoutMs: 5_000
  }
  try {
    for (let retry = 0; retry < 2; retry++) {
      const result = await executor.execute(request)
      expect(result.status).toBe('cancelled')
      expect(result.kernelDispatched).toBe(false)
      expect(result.stderr).toContain('authorization was cancelled')
    }
    expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce()
    expect(backend.wrap).toHaveBeenCalledTimes(2)
    // Authorization applied elsewhere is authoritative; a remembered refusal is not an ACL.
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: true, registered: true })
    await expect(
      owner.ensureRuntimeAccess({
        runtime: 'r',
        executable: process.execPath,
        sessionId: 'r-session'
      })
    ).resolves.toEqual({ windowsProtectionRequired: true, windowsRuntimeAccessRequired: true })
  } finally {
    await executor.shutdown()
    await owner.dispose()
  }
})

describe('R startup authorization admission', () => {
  it('keeps the original verification failure and cleanup when diagnostic logging throws', async () => {
    backend.wrap.mockResolvedValueOnce({
      argv: [process.execPath, '-e', 'process.exit(77)'],
      env: process.env,
      annotateStderr: (value: string) => value,
      resetNetworkConnections: backend.resetNetworkConnections,
      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: tmpdir(),
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: () => {
          throw new Error('sink failed')
        }
      }
    })
    try {
      await expect(owner.setWindowsRuntimeAccess(process.execPath, true)).rejects.toMatchObject({
        code: 77
      })
      expect(backend.cleanup).toHaveBeenCalledOnce()
    } finally {
      await owner.dispose()
    }
  })

  it('retains host child diagnostics when the protocol probe converts a process failure to false', async () => {
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.rKernelProtocolProbe.mockImplementationOnce(
      (await vi.importActual<typeof import('@aipoch/environment')>('@aipoch/environment'))
        .rKernelProtocolProbe
    )
    const { logger, records } = createCapturingLogger()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: tmpdir(),
      platform: 'win32',
      logger,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      // The contained fixture returns77; the real host Node process rejects R's --vanilla flag.
      await expect(
        owner.ensureRuntimeAccess({
          runtime: 'r',
          executable: process.execPath,
          sessionId: 'host-probe-log'
        })
      ).rejects.toThrow('protocol dependencies failed')
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'R runtime verification host process failed',
            data: expect.objectContaining({
              phase: 'host-probe',
              code: 9,
              stderr: expect.objectContaining({ text: expect.stringContaining('--vanilla') })
            })
          })
        ])
      )
    } finally {
      await owner.dispose()
    }
  })

  it('persists bounded R verification stderr and its failure stage in main.log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-r-access-log-'))
    diagnosticLogRoot = root
    initLogger({ logDir: root, mirrorToConsole: false })
    const stderr = `token=private-token\n${'x'.repeat(12_000)}\nnormalizePath: library/compiler access denied`
    backend.wrap.mockImplementationOnce(async () => ({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(stderr)}); process.exit(77)`
      ],
      env: process.env,
      annotateStderr: (value: string) => value,
      resetNetworkConnections: backend.resetNetworkConnections,
      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: tmpdir(),
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      await expect(owner.setWindowsRuntimeAccess(process.execPath, true)).rejects.toMatchObject({
        code: 77
      })
      await flushLogs()
      const serialized = await readFile(join(root, 'main.log'), 'utf8')
      const records = serialized
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const failure = records.find((record) => record.msg === 'R runtime verification probe failed')
      expect(failure).toMatchObject({
        data: {
          phase: 'authorize',
          code: 77,
          stderr: {
            truncated: true,
            text: expect.stringContaining('normalizePath: library/compiler access denied')
          }
        }
      })
      expect(failure.data.stderr.text.length).toBeLessThan(8_000)
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: 'operation failed',
            data: expect.objectContaining({
              operation: 'r-runtime-verification',
              operationId: failure.data.operationId,
              failurePhase: 'authorize'
            })
          }),
          expect.objectContaining({
            msg: 'operation failed',
            data: expect.objectContaining({
              operation: 'r-runtime-access',
              operationId: failure.data.parentOperationId
            })
          })
        ])
      )
      expect(serialized).not.toContain('private-token')
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: 'operation failed',
            data: expect.objectContaining({ operation: 'r-runtime-access' })
          })
        ])
      )
    } finally {
      await owner.dispose()
      await flushLogs()
    }
  })

  it('reproduces R verification refusal before authorization when protection is not ready', async () => {
    backend.status.mockResolvedValue({
      kind: 'setupRequired',
      platform: 'win32',
      reasons: ['windowsProfileMissing']
    })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: tmpdir(),
      platform: 'win32',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })
    try {
      await expect(owner.setWindowsRuntimeAccess(process.execPath, true)).rejects.toThrow(
        'Enable protected mode before verifying R access.'
      )
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  const request = { runtime: 'r' as const, executable: process.execPath, sessionId: 'r-admission' }
  const createOwner = (
    platform: NodeJS.Platform = 'win32',
    allowRuntimeAccessPrompt = true
  ): NotebookNetworkSandboxOwner =>
    new NotebookNetworkSandboxOwner({
      resourceRoot: tmpdir(),
      platform,
      allowRuntimeAccessPrompt,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn()
    })

  it.skipIf(process.platform !== 'win32')(
    'waits for a transient Windows directory lock after probe cleanup',
    async () => {
      const owner = createOwner()
      let lockClosed: Promise<void> | undefined
      backend.wrap.mockImplementationOnce(async (command: { cwd: string }) => ({
        argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
        env: process.env,
        annotateStderr: (stderr: string) => stderr,
        resetNetworkConnections: backend.resetNetworkConnections,
        setExecutionActive: backend.setExecutionActive,
        confirmProcessTreeTermination: async () => true,
        cleanup: async () => {
          fixtureDirectories.push(command.cwd)
          // Model a separate Windows process briefly retaining a current-directory handle even
          // after the contained probe has exited. Its release must not turn verification into EBUSY.
          const holder = spawn(
            process.execPath,
            ['-e', 'console.log("ready"); setTimeout(() => {}, 300)'],
            {
              cwd: command.cwd,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'ignore']
            }
          )
          lockClosed = new Promise<void>((resolve) => holder.once('close', () => resolve()))
          await new Promise<void>((resolve, reject) => {
            holder.once('error', reject)
            holder.stdout!.once('data', () => resolve())
          })
          return { processesTerminated: true, networkClosed: true, temporaryResourcesRemoved: true }
        }
      }))
      try {
        await expect(owner.setWindowsRuntimeAccess(request.executable, true)).resolves.toEqual({
          cancelled: false
        })
      } finally {
        await lockClosed
        await owner.dispose()
      }
    }
  )

  it('does not report verified R access when sandbox cleanup remains incomplete', async () => {
    const owner = createOwner()
    backend.wrap.mockResolvedValue({
      argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
      env: process.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    backend.cleanup.mockResolvedValue({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
    try {
      await expect(owner.setWindowsRuntimeAccess(request.executable, true)).rejects.toThrow()
    } finally {
      await owner.dispose()
    }
  })

  it('retains the probe directory and blocks admission without process termination proof', async () => {
    const owner = createOwner()
    const confirm = vi.fn().mockResolvedValue(false)
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.wrap.mockResolvedValue({
      argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
      env: process.env,
      confirmProcessTreeTermination: confirm,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow(
        'cleanup could not be confirmed'
      )
      const cwd = backend.wrap.mock.calls[0]![0].cwd as string
      fixtureDirectories.push(cwd)
      expect(existsSync(cwd)).toBe(true)
      expect(confirm).toHaveBeenCalledOnce()
      expect(backend.cleanup).toHaveBeenCalledWith({
        processesTerminated: false,
        confirmTermination: confirm
      })
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('cleans up cancellation before a contained probe starts without requiring a termination proof', async () => {
    const owner = createOwner()
    const confirm = vi.fn().mockResolvedValue(false)
    backend.setWindowsRuntimeAccess.mockResolvedValue({ cancelled: true })
    backend.wrap.mockResolvedValue({
      argv: ['never-launched.exe'],
      env: process.env,
      confirmProcessTreeTermination: confirm,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    try {
      await expect(owner.setWindowsRuntimeAccess(request.executable, true)).resolves.toEqual({
        cancelled: true
      })
      const cwd = backend.wrap.mock.calls[0]![0].cwd as string
      expect(existsSync(cwd)).toBe(false)
      expect(confirm).not.toHaveBeenCalled()
      expect(backend.cleanup).toHaveBeenCalledWith({
        processesTerminated: true,
        confirmTermination: confirm
      })
    } finally {
      await owner.dispose()
    }
  })

  it('retains temporary resources after a started authorization verifier fails without proof', async () => {
    const owner = createOwner()
    const confirm = vi.fn().mockResolvedValue(false)
    backend.wrap.mockResolvedValue({
      argv: [process.execPath, '-e', 'console.log("OPEN_SCIENCE_R_ACCESS_OK")'],
      env: process.env,
      confirmProcessTreeTermination: confirm,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    backend.setWindowsRuntimeAccess.mockImplementation(
      async (_executable, _authorized, verification: Verification) => {
        await runVerification(verification)
        throw new Error('verification interrupted after elevation')
      }
    )
    try {
      await expect(owner.setWindowsRuntimeAccess(request.executable, true)).rejects.toThrow(
        'cleanup could not be confirmed'
      )
      const cwd = backend.wrap.mock.calls[0]![0].cwd as string
      fixtureDirectories.push(cwd)
      expect(existsSync(cwd)).toBe(true)
      expect(confirm).toHaveBeenCalledOnce()
      expect(backend.cleanup).toHaveBeenCalledWith({
        processesTerminated: false,
        confirmTermination: confirm
      })
    } finally {
      await owner.dispose()
    }
  })

  it('does not prompt while data migration is preparing', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    const migration = beginMigrationPreparation()
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow('moving your data')
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      migration.finish()
      clearMigrationPending()
      await owner.dispose()
    }
  })

  it('holds the migration writer drain and queues revocation until the UAC operation settles', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    let settle!: (value: { cancelled: boolean }) => void
    backend.setWindowsRuntimeAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const authorization = owner.ensureRuntimeAccess(request).catch(() => undefined)
    let drained = false
    try {
      await vi.waitFor(() => expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce())
      beginMigration()
      const drain = waitForDataRootWriters().then(() => {
        drained = true
      })
      const revocation = owner.setWindowsRuntimeAccess(request.executable, false)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(drained).toBe(false)
      expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledTimes(1)
      settle({ cancelled: true })
      await authorization
      await drain
      await revocation
      expect(backend.setWindowsRuntimeAccess).toHaveBeenNthCalledWith(2, request.executable, false)
      expect(drained).toBe(true)
    } finally {
      settle?.({ cancelled: true })
      clearMigrationPending()
      await authorization
      await owner.dispose()
    }
  })

  it('invalidates a prepared R launch as soon as a settings revocation is queued', async () => {
    const owner = createOwner()
    const invocation = {
      ...request,
      args: [],
      env: {},
      cwd: tmpdir(),
      commandText: 'cat(1)',
      projectId: 'project',
      windowsProtectionRequired: true,
      windowsRuntimeAccessRequired: true,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }
    const prepared = await owner.wrap(invocation)
    let settle!: (value: { cancelled: boolean }) => void
    backend.setWindowsRuntimeAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const authorization = owner.setWindowsRuntimeAccess(request.executable, true)
    let revocation: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce())
      revocation = owner.setWindowsRuntimeAccess(request.executable, false)
      expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledTimes(1)
      expect(() => prepared.beginSpawn?.()).toThrow('R runtime access changed before startup')
      const pending = await owner.wrap(invocation)
      try {
        expect(() => pending.beginSpawn?.()).toThrow('R runtime access changed before startup')
      } finally {
        await pending.cleanup('spawn-failed', { processesTerminated: true })
      }
      settle({ cancelled: true })
      await authorization
      await revocation
      expect(() => prepared.beginSpawn?.()).toThrow('R runtime access changed before startup')
      const fresh = await owner.wrap(invocation)
      try {
        expect(() => fresh.beginSpawn?.()).not.toThrow()
      } finally {
        await fresh.cleanup('spawn-failed', { processesTerminated: true })
      }
    } finally {
      settle?.({ cancelled: true })
      await authorization
      await revocation
      await prepared.cleanup('spawn-failed', { processesTerminated: true })
      await owner.dispose()
    }
  })

  it('does not grant permissions when protected execution is unavailable', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.status.mockResolvedValue({ kind: 'error', message: 'Invalid trust bundle' })
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow()
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
      expect(backend.wrap).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('does not open UAC when cancelled during the protected-mode readiness check', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    const controller = new AbortController()
    let settle!: (value: { kind: string; warnings: string[] }) => void
    backend.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const result = owner.ensureRuntimeAccess({ ...request, signal: controller.signal })
    const outcome = result.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(backend.status).toHaveBeenCalledOnce())
      controller.abort()
      settle({ kind: 'ready', warnings: [] })
      expect(await outcome).toBeInstanceOf(Error)
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      settle?.({ kind: 'ready', warnings: [] })
      await outcome
      await owner.dispose()
    }
  })

  it('cancels a queued session while another conversation is still answering UAC', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    let settle!: (value: { cancelled: boolean }) => void
    backend.setWindowsRuntimeAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const first = owner.ensureRuntimeAccess(request).catch(() => undefined)
    const controller = new AbortController()
    let cancelled = false
    try {
      await vi.waitFor(() => expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce())
      const second = owner.ensureRuntimeAccess({
        ...request,
        sessionId: 'other',
        signal: controller.signal
      })
      void second.catch(() => {
        cancelled = true
      })
      controller.abort()
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 200 })
      expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce()
    } finally {
      settle?.({ cancelled: true })
      await first
      await owner.dispose()
    }
  })

  it('does not elevate an already authorized runtime or a non-Windows/R command', async () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const owner = createOwner(platform)
      try {
        await owner.ensureRuntimeAccess(request)
        await owner.ensureRuntimeAccess({ ...request, runtime: 'python' })
      } finally {
        await owner.dispose()
      }
    }
    expect(backend.getWindowsRuntimeAccess).toHaveBeenCalledOnce()
    expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
  })

  it('does not attempt invisible elevation without a local desktop host', async () => {
    const owner = createOwner('win32', false)
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow('local Open-Science desktop')
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('runs an unregistered R with existing OS access without asking for UAC', async () => {
    const owner = createOwner('win32', false)
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.wrap.mockResolvedValue({
      argv: [process.execPath, '-e', "console.log('OPEN_SCIENCE_R_ACCESS_OK')"],
      env: process.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    try {
      await expect(owner.ensureRuntimeAccess(request)).resolves.toEqual({
        windowsProtectionRequired: true,
        windowsRuntimeAccessRequired: false
      })
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it.each([1, 77])('does not elevate a broken R installation (probe exit %s)', async (code) => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.wrap.mockResolvedValue({
      argv: [
        process.execPath,
        '-e',
        `console.log(${JSON.stringify(join(tmpdir(), 'missing-r-library', 'compiler'))}); process.exit(${code})`
      ],
      env: process.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    })
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow()
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('does not grant persistent access when denied R paths also hide broken protocol dependencies', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.rKernelProtocolProbe.mockResolvedValue(false)
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow(
        'The R kernel protocol dependencies failed to load.'
      )
      expect(backend.rKernelProtocolProbe).toHaveBeenCalledOnce()
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('does not retain new runtime access when host protocol succeeds but contained verification fails', async () => {
    const owner = createOwner()
    let authorized = false
    backend.getWindowsRuntimeAccess.mockImplementation(async () => ({
      authorized,
      registered: authorized
    }))
    backend.setWindowsRuntimeAccess.mockImplementation(
      async (_executable, next: boolean, verification?: Verification) => {
        if (verification) await runVerification(verification)
        authorized = next
        return { cancelled: false }
      }
    )
    backend.wrap.mockImplementation(async (command: { env: NodeJS.ProcessEnv }) => ({
      argv: [
        process.execPath,
        '-e',
        command.env.R_ENABLE_JIT === '0'
          ? `console.log(${JSON.stringify(tmpdir())}); process.exit(77)`
          : 'console.error("there is no package called jsonlite inside containment"); process.exit(1)'
      ],
      env: process.env,
      annotateStderr: (stderr: string) => stderr,
      resetNetworkConnections: backend.resetNetworkConnections,

      setExecutionActive: backend.setExecutionActive,
      confirmProcessTreeTermination: async () => true,
      cleanup: (_reason: NotebookSandboxCleanupReason, outcome: NotebookSandboxProcessOutcome) =>
        backend.cleanup(outcome)
    }))
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow(
        'there is no package called jsonlite inside containment'
      )
      expect(backend.rKernelProtocolProbe).toHaveBeenCalledOnce()
      expect(await backend.getWindowsRuntimeAccess(request.executable)).toEqual({
        authorized: false,
        registered: false
      })
    } finally {
      await owner.dispose()
    }
  })

  it('does not open UAC when cancelled during host R protocol verification', async () => {
    const owner = createOwner()
    const controller = new AbortController()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    backend.rKernelProtocolProbe.mockImplementation(async () => {
      controller.abort()
      return true
    })
    try {
      await expect(
        owner.ensureRuntimeAccess({ ...request, signal: controller.signal })
      ).rejects.toThrow('cancelled')
      expect(backend.rKernelProtocolProbe).toHaveBeenCalledOnce()
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })

  it('shares one cancelled prompt across simultaneous requests in the same conversation', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockResolvedValue({ authorized: false, registered: false })
    let settle!: (value: { cancelled: boolean }) => void
    backend.setWindowsRuntimeAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const results = Promise.allSettled([
      owner.ensureRuntimeAccess(request),
      owner.ensureRuntimeAccess(request)
    ])
    try {
      await vi.waitFor(() => expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce())
      settle({ cancelled: true })
      const outcomes = await results
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
      expect(backend.setWindowsRuntimeAccess).toHaveBeenCalledOnce()
      expect(backend.wrap).toHaveBeenCalledTimes(2)
    } finally {
      settle?.({ cancelled: true })
      await results
      await owner.dispose()
    }
  })

  it('does not open UAC after the session was cancelled during its access check', async () => {
    const owner = createOwner()
    const controller = new AbortController()
    let settle!: (value: { authorized: boolean; registered: boolean }) => void
    backend.getWindowsRuntimeAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const result = owner.ensureRuntimeAccess({ ...request, signal: controller.signal })
    const cancelled = expect(result).rejects.toThrow('preparation was cancelled')
    try {
      await vi.waitFor(() => expect(backend.getWindowsRuntimeAccess).toHaveBeenCalledOnce())
      controller.abort()
      settle({ authorized: false, registered: false })
      await cancelled
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      settle?.({ authorized: false, registered: false })
      await cancelled
      await owner.dispose()
    }
  })

  it('does not turn an ownership-status failure into a permission prompt', async () => {
    const owner = createOwner()
    backend.getWindowsRuntimeAccess.mockRejectedValue(
      new Error('Complete pending protected-mode operation')
    )
    try {
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow(
        'pending protected-mode operation'
      )
      expect(backend.setWindowsRuntimeAccess).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
    }
  })
})

describe('macOS retained cleanup admission', () => {
  const makeFixture = async (
    onGrantedRoots?: () => void | Promise<void>
  ): Promise<{
    owner: NotebookNetworkSandboxOwner
    invocation: NotebookSandboxInvocation
    directory: string
    managed: string
  }> => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'os-owner-retained-')))
    fixtureDirectories.push(directory)
    const managed = join(directory, 'commands')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      temporaryRoot: managed,
      platform: 'darwin',
      getGrantedLocalRoots: async () => {
        await onGrantedRoots?.()
        return []
      },
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny')
    })
    const invocation = {
      executable: '/bin/bash',
      args: ['-c', 'true'],
      env: {},
      cwd: directory,
      commandText: 'true',
      sessionId: 'session',
      projectId: 'project',
      runtime: 'bash' as const,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }
    return { owner, invocation, directory, managed }
  }
  const retain = (): void => {
    backend.cleanup.mockResolvedValue({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: true,
      admission: 'independent-command-allowed'
    })
  }

  it('allows healthy concurrent command registration', async () => {
    const { owner, invocation } = await makeFixture()
    await Promise.all([owner.wrap(invocation), owner.wrap(invocation), owner.wrap(invocation)])
    expect(backend.wrap).toHaveBeenCalledTimes(3)
    await owner.dispose()
  })

  it('queues a healthy successor while the preceding receipt identity is still being recorded', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let reachedSecondAdmission!: () => void
    const secondAdmission = new Promise<void>((resolve) => {
      reachedSecondAdmission = resolve
    })
    let admissions = 0
    const { owner, invocation } = await makeFixture(() => {
      admissions += 1
      if (admissions === 2) reachedSecondAdmission()
    })
    let releaseStat!: () => void
    let enteredStat!: () => void
    const waiting = new Promise<void>((resolve) => {
      enteredStat = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseStat = resolve
    })
    let firstReceipt = true
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (firstReceipt) {
        firstReceipt = false
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          enteredStat()
          await released
          return stat()
        })
      }
      return handle
    })
    try {
      const first = owner.wrap(invocation)
      await waiting
      const second = owner.wrap(invocation)
      // Keep receipt registration in flight across the successor's asynchronous admission.
      const outcomes = Promise.allSettled([first, second])
      await Promise.race([second.catch(() => undefined), secondAdmission])
      releaseStat()
      expect((await outcomes).map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(backend.wrap).toHaveBeenCalledTimes(2)
    } finally {
      releaseStat?.()
      vi.mocked(open).mockImplementation(actual.open)
      await owner.dispose()
    }
  })

  it('admits concurrent successors beside retained cleanup debt', async () => {
    const { owner, invocation } = await makeFixture()
    const a = await owner.wrap(invocation)
    retain()
    await a.cleanup('cancel', { processesTerminated: false })
    const results = await Promise.allSettled([owner.wrap(invocation), owner.wrap(invocation)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0)
    expect(backend.wrap).toHaveBeenCalledTimes(3)
    await owner.dispose()
  })

  it.each(['command-invalid'])(
    'rejects malformed owned directory %s without adopting it',
    async (name) => {
      const { owner, invocation, managed } = await makeFixture()
      await mkdir(managed)
      const orphan = join(managed, name)
      await mkdir(orphan)
      await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
      expect(backend.wrap).not.toHaveBeenCalled()
      expect(existsSync(orphan)).toBe(true)
      await owner.dispose()
      expect(existsSync(orphan)).toBe(true)
    }
  )

  it('admits a successor beside a legacy UUID directory without adopting or deleting it', async () => {
    const { owner, invocation, managed } = await makeFixture()
    await mkdir(managed)
    const legacy = join(managed, 'command-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
    await mkdir(legacy)
    const sentinel = join(legacy, 'legacy-workload-data')
    await writeFile(sentinel, 'must survive')
    const b = await owner.wrap(invocation)
    expect(await readFile(sentinel, 'utf8')).toBe('must survive')
    expect(existsSync(`${legacy}.receipt`)).toBe(false)
    await b.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
    expect(await readFile(sentinel, 'utf8')).toBe('must survive')
    expect(existsSync(`${legacy}.receipt`)).toBe(false)
  })

  it.each(['legacy', 'receipt'] as const)(
    'preserves recovered %s roots without limiting current-owner admission',
    async (kind) => {
      const { owner, invocation, managed } = await makeFixture()
      await mkdir(managed)
      const legacy = join(managed, 'command-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
      await mkdir(legacy)
      const receipt = `${legacy}.receipt`
      const content = 'v1 command-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa native\n'
      if (kind === 'receipt') await writeFile(receipt, content)
      const contenders = await Promise.allSettled([owner.wrap(invocation), owner.wrap(invocation)])
      const admitted = contenders.filter((result) => result.status === 'fulfilled')
      expect(admitted).toHaveLength(2)
      expect(contenders.filter((result) => result.status === 'rejected')).toHaveLength(0)
      expect(backend.wrap).toHaveBeenCalledTimes(2)
      for (const command of admitted)
        await command.value.cleanup('exit', { processesTerminated: true })
      const successor = await owner.wrap(invocation)
      await successor.cleanup('exit', { processesTerminated: true })
      await owner.dispose()
      expect(existsSync(legacy)).toBe(true)
      expect(existsSync(receipt)).toBe(kind === 'receipt')
      if (kind === 'receipt') expect(await readFile(receipt, 'utf8')).toBe(content)
    }
  )

  it.each(['file', 'symlink'] as const)(
    'rejects an unreceipted UUID %s without touching its target',
    async (kind) => {
      const { symlink } = await import('node:fs/promises')
      const { owner, invocation, managed, directory } = await makeFixture()
      await mkdir(managed)
      const legacy = join(managed, 'command-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
      const external = join(directory, 'external-data')
      await mkdir(external)
      const sentinel = join(external, 'keep')
      await writeFile(sentinel, 'external')
      if (kind === 'file') await writeFile(legacy, 'not a directory')
      else await symlink(external, legacy, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
      await owner.dispose()
      expect(existsSync(legacy)).toBe(true)
      expect(await readFile(sentinel, 'utf8')).toBe('external')
    }
  )

  it('rejects a changed recovered receipt independently of command count', async () => {
    const { owner, invocation, managed } = await makeFixture()
    await mkdir(managed)
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const oldRoot = join(managed, `command-${id}`)
    await mkdir(oldRoot)
    await writeFile(`${oldRoot}.receipt`, `v1 command-${id} native\n`)
    const command = await owner.wrap(invocation)
    await command.cleanup('exit', { processesTerminated: true })
    await writeFile(`${oldRoot}.receipt`, 'replaced receipt content')
    await expect(owner.wrap(invocation)).rejects.toThrow('Command temporary identity changed')
    expect(backend.wrap).toHaveBeenCalledOnce()
    await owner.dispose()
    expect(existsSync(oldRoot)).toBe(true)
    expect(existsSync(`${oldRoot}.receipt`)).toBe(true)
    expect(await readFile(`${oldRoot}.receipt`, 'utf8')).toBe('replaced receipt content')
  })

  it('retains failed directory creation and receipt deletion without blocking independent commands', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { owner, invocation } = await makeFixture()
    let locked = true
    let failedMkdir = false
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      if (!failedMkdir && /[\\/]command-/.test(String(path))) {
        failedMkdir = true
        throw new Error('mkdir fixture failure')
      }
      return actual.mkdir(path, options as never)
    })
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (locked && String(path).endsWith('.receipt')) throw new Error('receipt locked')
      return actual.rm(path, options)
    })
    try {
      await expect(owner.wrap(invocation)).rejects.toThrow('mkdir fixture failure')
      await expect(owner.wrap(invocation)).resolves.toBeDefined()
      expect(backend.wrap).toHaveBeenCalledOnce()
      locked = false
      await owner.wrap(invocation)
      await owner.wrap(invocation)
      expect(backend.wrap).toHaveBeenCalledTimes(3)
      await owner.dispose()
    } finally {
      vi.mocked(mkdir).mockImplementation(actual.mkdir)
      vi.mocked(rm).mockImplementation(actual.rm)
    }
  })

  it('accounts for a created receipt when writing it fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { owner, invocation } = await makeFixture()
    let locked = true
    let failWrite = true
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (failWrite) {
        failWrite = false
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('receipt write failed'))
      }
      return handle
    })
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (locked && String(path).endsWith('.receipt')) throw new Error('receipt locked')
      return actual.rm(path, options)
    })
    try {
      await expect(owner.wrap(invocation)).rejects.toThrow('receipt write failed')
      await expect(owner.wrap(invocation)).resolves.toBeDefined()
      expect(backend.wrap).toHaveBeenCalledOnce()
      locked = false
      await owner.wrap(invocation)
      await owner.dispose()
    } finally {
      vi.mocked(open).mockImplementation(actual.open)
      vi.mocked(rm).mockImplementation(actual.rm)
    }
  })

  it.each(['incomplete', 'throw'] as const)(
    'retries exact preparation cleanup after a transient %s failure without touching another session',
    async (failure) => {
      const { NotebookNetworkSandbox } = await vi.importActual<
        typeof import('../../../packages/notebook-network-sandbox/src/index')
      >('../../../packages/notebook-network-sandbox/src/index')
      const { NotebookNetworkRuntime } =
        await import('../../../packages/notebook-network-sandbox/runtime/src/index')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: '/resources' }
      })
      // Runtime lifecycle is mocked below; do not probe the host's sandbox dependencies.
      const status = vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
      const initialize = vi.spyOn(NotebookNetworkRuntime, 'initialize').mockResolvedValue(undefined)
      const runtimeWrap = vi.spyOn(NotebookNetworkRuntime, 'wrap').mockResolvedValue({
        argv: ['/sandbox/sh'],
        env: {}
      })
      const complete = {
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }
      let recovered = false
      const cleanup = vi
        .spyOn(NotebookNetworkRuntime, 'cleanupAfterCommand')
        .mockImplementation(async () => {
          if (recovered) return complete
          if (failure === 'throw') throw new Error('temporary cleanup failure')
          return { ...complete, networkClosed: false }
        })
      const reset = vi.spyOn(NotebookNetworkRuntime, 'reset').mockResolvedValue(undefined)
      const { owner, invocation } = await makeFixture()
      try {
        await sandbox.initialize()
        backend.wrap.mockImplementation((command) => sandbox.wrap(command))
        const other = await owner.wrap({ ...invocation, sessionId: 'other-session' })
        const otherRoot = runtimeWrap.mock.calls[0][0].env.TMPDIR!
        await writeFile(join(otherRoot, 'sentinel'), 'other session')
        runtimeWrap.mockRejectedValueOnce(new Error('transient preparation failure'))
        const preparationError = await owner.wrap(invocation).catch((error) => error)
        expect(preparationError.message).toContain('SHELL_CLEANUP_INCOMPLETE')
        expect(preparationError.retryCleanup).toBeTypeOf('function')
        const failedCommand = runtimeWrap.mock.calls[1][0]
        const failedRoot = failedCommand.env.TMPDIR!
        await expect(owner.wrap(invocation)).rejects.toThrow()
        expect(runtimeWrap).toHaveBeenCalledTimes(2)
        expect(cleanup).toHaveBeenCalledTimes(2)
        expect(existsSync(failedRoot)).toBe(true)
        expect(existsSync(failedRoot + '.receipt')).toBe(true)
        recovered = true
        expect(await preparationError.retryCleanup()).toBe(true)
        expect(runtimeWrap).toHaveBeenCalledTimes(2)
        const next = await owner.wrap(invocation)
        expect(runtimeWrap).toHaveBeenCalledTimes(3)
        expect(cleanup.mock.calls.map(([id]) => id)).toEqual([
          failedCommand.commandId,
          failedCommand.commandId,
          failedCommand.commandId
        ])
        expect(existsSync(failedRoot)).toBe(false)
        expect(existsSync(failedRoot + '.receipt')).toBe(false)
        expect(await readFile(join(otherRoot, 'sentinel'), 'utf8')).toBe('other session')
        await next.cleanup('exit', { processesTerminated: true })
        await other.cleanup('exit', { processesTerminated: true })
      } finally {
        recovered = true
        await owner.dispose()
        await sandbox.dispose()
        reset.mockRestore()
        cleanup.mockRestore()
        runtimeWrap.mockRestore()
        initialize.mockRestore()
        status.mockRestore()
      }
    }
  )

  it.each(['incomplete', 'throw', 'undefined'] as const)(
    'releases concurrent rejected admission roots while retaining original %s cleanup debt',
    async (failure) => {
      const { NotebookNetworkSandbox } = await vi.importActual<
        typeof import('../../../packages/notebook-network-sandbox/src/index')
      >('../../../packages/notebook-network-sandbox/src/index')
      const { NotebookNetworkRuntime } =
        await import('../../../packages/notebook-network-sandbox/runtime/src/index')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: '/resources' }
      })
      // Runtime lifecycle is mocked below; do not probe the host's sandbox dependencies.
      const status = vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
      const initialize = vi.spyOn(NotebookNetworkRuntime, 'initialize').mockResolvedValue(undefined)
      const runtimeWrap = vi.spyOn(NotebookNetworkRuntime, 'wrap').mockResolvedValue({
        argv: ['/sandbox/sh'],
        env: {}
      })
      const complete = {
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }
      let recovered = false
      const cleanup = vi
        .spyOn(NotebookNetworkRuntime, 'cleanupAfterCommand')
        .mockImplementation(async () => {
          if (recovered) return complete
          if (failure === 'throw') throw new Error('temporary cleanup failure')
          if (failure === 'undefined') return Promise.reject(undefined)
          return { ...complete, networkClosed: false }
        })
      const reset = vi.spyOn(NotebookNetworkRuntime, 'reset').mockResolvedValue(undefined)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let releaseAdmission!: () => void
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      let holdAdmission = false
      let admissionArrivals = 0
      let arrivals = 0
      const { owner, invocation } = await makeFixture(async () => {
        if (++arrivals <= 3) await gate
      })
      try {
        await sandbox.initialize()
        backend.wrap.mockImplementation(async (command) => {
          if (holdAdmission) {
            admissionArrivals++
            await admissionGate
          }
          return sandbox.wrap(command)
        })
        const waiting = Promise.allSettled(
          [1, 2, 3].map((id) => owner.wrap({ ...invocation, sessionId: `waiting-${id}` }))
        )
        await vi.waitFor(() => expect(arrivals).toBe(3))
        runtimeWrap.mockRejectedValueOnce(new Error('transient preparation failure'))
        await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
        const failed = runtimeWrap.mock.calls[0][0]
        const failedRoot = failed.env.TMPDIR!
        await writeFile(join(failedRoot, 'sentinel'), 'original owner')
        // Register all concurrent roots before a rejected caller removes its receipt. Otherwise
        // a later registration may correctly fail closed while observing that cleanup in progress,
        // before reaching the package admission boundary this test is intended to exercise.
        holdAdmission = true
        release()
        await vi.waitFor(() => expect(admissionArrivals).toBe(3), { timeout: 5_000 })
        holdAdmission = false
        releaseAdmission()
        const rejected = await waiting
        expect(rejected.every((result) => result.status === 'rejected')).toBe(true)
        expect(backend.wrap).toHaveBeenCalledTimes(4)
        expect(runtimeWrap).toHaveBeenCalledTimes(1)
        for (const [command] of backend.wrap.mock.calls) {
          if (command.env.TMPDIR === failedRoot) continue
          expect(existsSync(command.env.TMPDIR)).toBe(false)
          expect(existsSync(command.env.TMPDIR + '.receipt')).toBe(false)
        }
        const [stillBlocked] = await Promise.allSettled([owner.wrap(invocation)])
        expect(stillBlocked.status).toBe('rejected')
        expect(runtimeWrap).toHaveBeenCalledTimes(1)
        expect(await readFile(join(failedRoot, 'sentinel'), 'utf8')).toBe('original owner')
        expect(existsSync(failedRoot + '.receipt')).toBe(true)
        expect(cleanup.mock.calls.every(([id]) => id === failed.commandId)).toBe(true)
        recovered = true
        const next = await owner.wrap({ ...invocation, sessionId: 'recovered' })
        expect(runtimeWrap).toHaveBeenCalledTimes(2)
        expect(existsSync(failedRoot)).toBe(false)
        expect(existsSync(failedRoot + '.receipt')).toBe(false)
        await next.cleanup('exit', { processesTerminated: true })
      } finally {
        release()
        releaseAdmission()
        recovered = true
        await owner.dispose()
        await sandbox.dispose()
        reset.mockRestore()
        cleanup.mockRestore()
        runtimeWrap.mockRestore()
        initialize.mockRestore()
        status.mockRestore()
      }
    }
  )

  it('keeps unverified preparation failures fenced even without a cleanup closure', async () => {
    const { owner, invocation } = await makeFixture()
    backend.wrap.mockRejectedValueOnce(new Error('unverified preparation'))
    await expect(owner.wrap(invocation)).rejects.toThrow('unverified preparation')
    await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    expect(backend.wrap).toHaveBeenCalledTimes(1)
    await owner.dispose()
  })

  it('preserves replacement files when a failed command cleanup arrives after owner disposal', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { owner, invocation } = await makeFixture()
    const a = await owner.wrap(invocation)
    const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
    vi.mocked(rm).mockImplementationOnce(async () => {
      throw new Error('temporary root locked')
    })
    await expect(a.cleanup('exit', { processesTerminated: true })).resolves.toMatchObject({
      temporaryResourcesRemoved: false
    })
    vi.mocked(rm).mockImplementation(actual.rm)
    await owner.dispose()
    await mkdir(root)
    const sentinel = join(root, 'belongs-to-another-owner')
    await writeFile(sentinel, 'preserve me')
    await a.cleanup('exit', { processesTerminated: true }).catch(() => undefined)
    expect(existsSync(sentinel)).toBe(true)
  })

  it('never lets a stale cleanup retry remove a replacement after application cleanup succeeds', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { owner, invocation } = await makeFixture()
    backend.cleanup.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true,
      admission: 'independent-command-allowed'
    })
    const a = await owner.wrap(invocation)
    const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
    let failuresRemaining = 2
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === root && failuresRemaining-- > 0) throw new Error('temporary root locked')
      return actual.rm(path, options)
    })
    try {
      await expect(a.cleanup('exit', { processesTerminated: true })).resolves.toMatchObject({
        temporaryResourcesRemoved: false
      })
      await owner.wrap({ ...invocation, sessionId: 'session-b' })
      // A different owner replaces the old path after B's admission. A must never delete it.
      await actual.rm(root, { recursive: true, force: true })
      await mkdir(root)
      const sentinel = join(root, 'belongs-to-another-owner')
      await writeFile(sentinel, 'preserve me')
      await Promise.allSettled([owner.wrap({ ...invocation, sessionId: 'session-c' })])
      expect(existsSync(sentinel)).toBe(true)
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm)
      await owner.dispose().catch(() => undefined)
    }
  })

  it('admits a healthy successor when a validated predecessor receipt is concurrently removed', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { owner, invocation } = await makeFixture()
    const a = await owner.wrap(invocation)
    const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
    let reached!: () => void
    const observed = new Promise<void>((resolve) => {
      reached = resolve
    })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let deferRead = true
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
      if (deferRead && String(args[0]) === `${root}.receipt`) {
        deferRead = false
        reached()
        await paused
      }
      return actual.readFile(...args)
    })
    try {
      const next = owner.wrap(invocation)
      await observed
      await a.cleanup('exit', { processesTerminated: true })
      expect(existsSync(`${root}.receipt`)).toBe(false)
      release()
      await expect(next).resolves.toBeDefined()
      await owner.dispose()
    } finally {
      release()
      vi.mocked(readFile).mockImplementation(actual.readFile)
    }
  })

  it('preserves healthy admission before and after the last debt settles', async () => {
    const { owner, invocation } = await makeFixture()
    const a = await owner.wrap(invocation)
    retain()
    await a.cleanup('cancel', { processesTerminated: false })
    await expect(owner.wrap(invocation)).resolves.toBeDefined()
    backend.cleanup.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await a.cleanup('cancel', { processesTerminated: true })
    await Promise.all([owner.wrap(invocation), owner.wrap(invocation)])
    expect(backend.wrap).toHaveBeenCalledTimes(4)
    await owner.dispose()
  })

  it.each(['root', 'parent'] as const)(
    'never follows a replacement %s symlink into external files',
    async (replacement) => {
      const { rename, symlink } = await import('node:fs/promises')
      const { owner, invocation, managed, directory } = await makeFixture()
      const wrapped = await owner.wrap(invocation)
      const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
      const external = join(directory, 'outside')
      await mkdir(external)
      const sentinel = join(external, 'must-survive')
      await writeFile(sentinel, 'external fixture')
      const path = replacement === 'root' ? root : managed
      await rename(path, `${path}.original`)
      await symlink(external, path, process.platform === 'win32' ? 'junction' : 'dir')
      const result = await wrapped.cleanup('exit', { processesTerminated: true })
      expect(result.temporaryResourcesRemoved).toBe(false)
      expect(await readFile(sentinel, 'utf8')).toBe('external fixture')
      await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
      await expect(owner.dispose()).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
      expect(await readFile(sentinel, 'utf8')).toBe('external fixture')
    }
  )

  it('detects receipt content changes even when its inode remains the same', async () => {
    const { owner, invocation } = await makeFixture()
    const wrapped = await owner.wrap(invocation)
    const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
    await writeFile(`${root}.receipt`, 'changed ownership')
    expect(
      (await wrapped.cleanup('exit', { processesTerminated: true })).temporaryResourcesRemoved
    ).toBe(false)
    expect(await readFile(`${root}.receipt`, 'utf8')).toBe('changed ownership')
    await expect(owner.dispose()).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
  })

  it.each(['root', 'parent', 'receipt'] as const)(
    'retains replaced %s instead of deleting a new filesystem object',
    async (replacement) => {
      const { rename } = await import('node:fs/promises')
      const { owner, invocation, managed } = await makeFixture()
      const wrapped = await owner.wrap(invocation)
      const root = backend.wrap.mock.calls.at(-1)![0].env.TMPDIR as string
      const path =
        replacement === 'root' ? root : replacement === 'parent' ? managed : `${root}.receipt`
      await rename(path, `${path}.original`)
      if (replacement === 'receipt') await writeFile(path, 'replacement must survive')
      else await mkdir(path)
      const result = await wrapped.cleanup('exit', { processesTerminated: true })
      expect(result.temporaryResourcesRemoved).toBe(false)
      expect(existsSync(path)).toBe(true)
      await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
      await expect(owner.dispose()).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    }
  )
})

it.each([false, true])(
  'cancels component preparation with cleanup failure = %s',
  async (cleanupFailure) => {
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const prepare = vi
      .spyOn(WindowsNotebookRuntimeManager.prototype, 'prepare')
      .mockImplementation(async (_download, signal) => {
        started()
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true })
        )
        await cleanup
        if (cleanupFailure) throw new Error('cleanup not confirmed')
        signal!.throwIfAborted()
        throw new Error('expected cancellation')
      })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      windowsRuntimeRoot: join(tmpdir(), 'cancel-runtime'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn(),
      platform: 'win32'
    })
    try {
      expect(owner.cancelWindowsSetup()).toBe(false)
      const installation = owner.installWindows()
      const result = installation.then(
        (value) => value,
        (error: Error) => error
      )
      await start
      expect(owner.cancelWindowsSetup()).toBe(true)
      expect(owner.cancelWindowsSetup()).toBe(false)
      await expect(owner.installWindows()).rejects.toThrow('already running')
      await expect(owner.removeWindows()).rejects.toThrow('finish cancelling')
      await expect(owner.status()).resolves.toMatchObject({
        kind: 'checking',
        windowsRuntimeSetup: { canCancel: false }
      })
      finishCleanup()
      if (cleanupFailure) expect(await result).toMatchObject({ message: 'cleanup not confirmed' })
      else expect(await result).toEqual({ cancelled: true })
      expect(backend.removeWindows).not.toHaveBeenCalled()
    } finally {
      prepare.mockRestore()
      await owner.dispose()
    }
  }
)

it('reports the manual HTTP rule scope and standard port without treating it as HTTPS', async () => {
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: '/resources',
    platform: 'linux',
    persistAlwaysAllow: vi.fn(),
    requestDecision: vi.fn(),
    getSettings: async () => ({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [
        { hostname: 'localhost', protocol: 'http', port: 80, approvedAddresses: [] }
      ]
    })
  })
  await expect(
    owner.requestNetworkAccess({
      sessionId: 'session',
      projectId: 'project',
      hostname: 'localhost',
      protocol: 'http',
      reason: 'Read the local service'
    })
  ).resolves.toMatchObject({
    status: 'alreadyAllowed',
    hostname: 'localhost',
    protocol: 'http',
    port: 80,
    scope: 'global'
  })
  await expect(
    owner.requestNetworkAccess({
      sessionId: 'session',
      projectId: 'project',
      hostname: 'localhost',
      protocol: 'http',
      port: 8080,
      reason: 'Read another service'
    })
  ).resolves.toMatchObject({ status: 'blocked', protocol: 'http', port: 8080 })
  await owner.dispose()
})

it('allows HTTPS domains independently of preview domain preferences', async () => {
  const requestDecision = vi.fn()
  const persistAlwaysAllow = vi.fn()
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: '/resources',
    getSettings: async () => ({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['lab.internal.example']
    }),
    persistAlwaysAllow,
    requestDecision,
    platform: 'linux'
  })
  await expect(
    owner.requestNetworkAccess({
      sessionId: 'session-1',
      projectId: 'project-1',
      hostname: 'lab.internal.example',
      reason: 'Access the research service.'
    })
  ).resolves.toMatchObject({
    status: 'alreadyAllowed',
    message: expect.stringContaining('HTTPS domain access does not require approval')
  })
  expect(requestDecision).not.toHaveBeenCalled()
  expect(persistAlwaysAllow).not.toHaveBeenCalled()
})

configureTestRuntimeMetadata()

describe('trusted gateway destination records', () => {
  type DecisionRequest = Parameters<
    ConstructorParameters<typeof NotebookNetworkSandboxOwner>[0]['requestDecision']
  >[0]
  type Fixture = {
    root: string
    owner: NotebookNetworkSandboxOwner
    wrapped: Awaited<ReturnType<NotebookNetworkSandboxOwner['wrap']>>
    requestDecision: Mock<(request: DecisionRequest) => Promise<NotebookNetworkDecision>>
    connect: (addresses?: string[], port?: number, protocol?: 'http' | 'https') => Promise<boolean>
    end: () => void
    setSettings: (value: NotebookNetworkSettings) => Promise<void>
  }
  const setup = async (fullAccess = false, restrictFolders = true): Promise<Fixture> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'destination-grants-')))
    await mkdir(join(root, 'workspace'))
    await mkdir(join(root, 'sessions'))
    await writeFile(join(root, 'settings.json'), 'original')
    fixtureDirectories.push(root)
    let settings: NotebookNetworkSettings = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS }
    const requestDecision = vi
      .fn<(request: DecisionRequest) => Promise<NotebookNetworkDecision>>()
      .mockResolvedValue('retryRequired')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: root,
      configRoot: root,
      temporaryRoot: join(root, 'tmp'),
      platform: 'linux',
      getSettings: async () => settings,
      persistAlwaysAllow: async () => settings,
      requestDecision,
      hasFullAccess: () => fullAccess,
      getFolderRestrictionEnabled: async () => restrictFolders
    })
    const wrapped = await owner.wrap({
      executable: '/bin/sh',
      args: [],
      env: {},
      cwd: root,
      commandText: 'request fixture',
      executionReference: 'execution-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash',
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [root, join(root, 'workspace')],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const end = wrapped.beginExecution!({
      executionReference: 'execution-1',
      commandText: 'request fixture'
    })
    const connect = (
      addresses = ['127.0.0.1'],
      port = 8443,
      protocol: 'http' | 'https' = 'http'
    ): Promise<boolean> =>
      backend.request!({ host: 'local.test', port, protocol, purpose: 'block', addresses })
    return {
      root,
      owner,
      wrapped,
      requestDecision,
      connect,
      end,
      setSettings: async (value: typeof settings) => {
        settings = value
        owner.applySettings(value)
      }
    }
  }

  it('deduplicates records, keeps the original connection blocked and rejects forged ownership', async () => {
    const f = await setup()
    const [first, duplicate] = await Promise.all([f.connect(), f.connect()])
    expect([first, duplicate]).toEqual([false, false])
    expect(f.requestDecision).toHaveBeenCalledTimes(1)
    const request = f.requestDecision.mock.calls[0]![0]
    expect(request).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      hostname: 'local.test',
      protocol: 'http' as const,
      port: 8443,
      evidence: {
        addresses: ['127.0.0.1'],
        risks: [],
        recordId: expect.any(String)
      }
    })
    const recordId = request.evidence!.recordId
    expect(f.wrapped.annotateStderr('', '')).toContain(recordId)
    for (const [projectId, sessionId, id] of [
      ['project-2', 'session-1', recordId],
      ['project-1', 'session-2', recordId],
      ['project-1', 'session-1', 'forged']
    ]) {
      const result = await f.owner.requestNetworkAccess({
        projectId,
        sessionId,
        recordId: id,
        hostname: 'attacker.test',
        reason: 'fixture'
      })
      expect(result.status).toBe('blocked')
    }
    expect(
      (
        await f.owner.requestNetworkAccess({
          projectId: 'project-1',
          sessionId: 'session-1',
          recordId,
          hostname: '',
          reason: 'fixture'
        })
      ).status
    ).toBe('allowedOnce')
    f.end()
    await f.owner.dispose()
  })

  it.each(['project', 'global'] as const)(
    'returns committed %s scope when queried before approval completes',
    async (scope) => {
      const f = await setup()
      const pending = Promise.withResolvers<NotebookNetworkDecision>()
      f.requestDecision.mockReturnValueOnce(pending.promise)
      const connection = f.connect([], 8080)
      // Empty DNS evidence cannot create a record; retry with actual gateway evidence.
      expect(await connection).toBe(false)
      const blocked = f.connect(['127.0.0.1'], 8080)
      await vi.waitFor(() => expect(f.requestDecision).toHaveBeenCalledOnce())
      const recordId = f.requestDecision.mock.calls[0]![0].evidence!.recordId
      const request = {
        projectId: 'project-1',
        sessionId: 'session-1',
        recordId,
        hostname: '',
        reason: 'query'
      }
      const query = f.owner.requestNetworkAccess(request)
      const grant = {
        id: recordId,
        recordId,
        hostname: 'local.test',
        port: 8080,
        protocol: 'http' as const,
        scope,
        projectId: 'project-1',
        sessionId: 'session-1',
        approvedAddresses: [],
        createdAt: 1
      }
      await f.setSettings({ ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, destinationGrants: [grant] })
      pending.resolve('retryRequired')
      expect(await blocked).toBe(false)
      expect(await query).toMatchObject({
        hostname: 'local.test',
        port: 8080,
        protocol: 'http',
        scope,
        status: scope === 'project' ? 'projectAllowed' : 'alwaysAllowed'
      })
      await f.setSettings({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        destinationGrants: [{ ...grant, revokedAt: 2 }]
      })
      expect(await f.owner.requestNetworkAccess(request)).toMatchObject({
        status: 'denied',
        protocol: 'http',
        port: 8080,
        scope
      })
      f.end()
      await f.owner.dispose()
    }
  )

  it('allows HTTPS localhost/domain evidence without opening an approval even on port 80', async () => {
    const f = await setup()
    expect(await f.connect(['127.0.0.1', '8.8.8.8'], 80, 'https')).toBe(true)
    expect(f.requestDecision).not.toHaveBeenCalled()
    f.end()
    await f.owner.dispose()
  })

  it('uses full access as the existing explicit exemption, including sensitive addresses', async () => {
    const f = await setup(true)
    expect(await f.connect()).toBe(true)
    expect(f.requestDecision).not.toHaveBeenCalled()
    f.end()
    await f.owner.dispose()
  })

  it('enforces host, port and project scope on every connection, then revokes', async () => {
    const f = await setup()
    const grant = {
      id: 'grant',
      scope: 'project' as const,
      projectId: 'project-1',
      sessionId: 'source',
      recordId: 'source-record',
      createdAt: 1,
      hostname: 'local.test',
      protocol: 'http' as const,
      port: 8443,
      approvedAddresses: ['127.0.0.1', '10.0.0.1']
    }
    await f.setSettings({ ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, destinationGrants: [grant] })
    expect(await f.connect()).toBe(true)
    expect(await f.connect(['10.0.0.1'])).toBe(true)
    expect(f.requestDecision).not.toHaveBeenCalled()
    expect(await f.connect(['127.0.0.1', '10.0.0.2'])).toBe(true)
    expect(await f.connect(['127.0.0.1'], 443)).toBe(false)
    await f.setSettings({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [{ ...grant, projectId: 'project-2' }]
    })
    expect(await f.connect()).toBe(false)
    await f.setSettings({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [{ ...grant, projectId: 'project-2', scope: 'global' }]
    })
    expect(await f.connect()).toBe(true)
    await f.setSettings({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [{ ...grant, revokedAt: 2 }]
    })
    expect(await f.connect()).toBe(false)
    const filesystem = backend.wrap.mock.calls.at(-1)![0].filesystem
    expect(filesystem.deniedWriteRoots).toEqual(
      expect.arrayContaining([join(f.root, 'settings.json'), join(f.root, 'sessions')])
    )
    f.end()
    await f.owner.dispose()
  })

  it.skipIf(process.platform !== 'darwin').each([true, false])(
    'protects live settings, future staging and sessions with folder restrictions %s',
    async (restricted) => {
      const f = await setup(false, restricted)
      const { seatbeltProfile } =
        await import('../../../packages/notebook-network-sandbox/runtime/src/platform/macos-isolation')
      const filesystem = backend.wrap.mock.calls.at(-1)![0].filesystem
      const profile = seatbeltProfile({
        command: '',
        shell: '/bin/sh',
        gatewayPort: 1,
        gatewayCredentials: { username: 'unused', password: 'unused' },
        env: process.env,
        filesystem
      })
      const attempt = (path: string): Promise<{ stdout: string; stderr: string }> =>
        promisify(execFile)(
          '/usr/bin/sandbox-exec',
          ['-p', profile, '/bin/sh', '-c', 'printf forged > "$1"', 'fixture', path],
          { cwd: join(f.root, 'workspace') }
        )
      await expect(attempt(join(f.root, 'settings.json'))).rejects.toThrow()
      await expect(attempt(join(f.root, 'settings.json.123-test.tmp'))).rejects.toThrow()
      await expect(attempt(join(f.root, 'sessions', 'forged.json'))).rejects.toThrow()
      await expect(attempt(join(f.root, 'workspace', 'output.txt'))).resolves.toMatchObject({
        stderr: ''
      })
      expect(await readFile(join(f.root, 'settings.json'), 'utf8')).toBe('original')
      f.end()
      await f.owner.dispose()
    }
  )

  it('retains the whole consumed once snapshot for subsequent connections in the same execution', async () => {
    const f = await setup()
    f.requestDecision.mockImplementationOnce(async (request) => {
      request.onOnceGrant?.(['127.0.0.1', '10.0.0.1'])
      return 'allowOnce'
    })
    expect(await f.connect(['127.0.0.1'])).toBe(true)
    expect(await f.connect(['10.0.0.1'])).toBe(true)
    expect(f.requestDecision).toHaveBeenCalledTimes(1)
    f.end()
    await f.owner.dispose()
  })
})
