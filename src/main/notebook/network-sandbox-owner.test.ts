import { existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { flushLogs, initLogger, type Logger } from '../logger'
import type {
  NotebookSandboxCleanupReason,
  NotebookSandboxProcessOutcome,
  NotebookSandboxInvocation
} from './process-sandbox'

const backend = vi.hoisted(() => ({
  request: undefined as
    | ((request: { host: string; port?: number; purpose?: 'probe' | 'block' }) => Promise<boolean>)
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

vi.mock('./r-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./r-command')>()),
  rKernelProtocolProbe: backend.rKernelProtocolProbe
}))

vi.mock('@aipoch/notebook-network-sandbox', () => ({
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

import { NotebookNetworkSandboxOwner, commandLine } from './network-sandbox-owner'
import { NotebookKernelExecutor } from './kernel-executor'
import { DEFAULT_R_ENV, envPrefix, legacyDefaultEnvPrefix, rScriptBin } from './runtime-paths'
import {
  beginMigration,
  beginMigrationPreparation,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

const fixtureDirectories: string[] = []
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
        purpose?: 'probe' | 'block'
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
      backend.request = ({ host, port, purpose }) =>
        command.onNetworkAccessRequest({
          host,
          purpose,
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

  it('applies allow-once to every matching connection in the next command only', async () => {
    const requestDecision = vi.fn().mockResolvedValue('allowOnce')
    const persistAlwaysAllow = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow,
      requestDecision,
      platform: 'linux'
    })

    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['loop.py'],
      env: { PATH: 'C:\\Windows\\System32' },
      cwd: '/workspace',
      commandText: 'python loop.py',
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
    expect(wrapped).toMatchObject({
      executable: '/sandbox/sh',
      args: ['-c', 'wrapped'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4567' }
    })
    expect(backend.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          TMPDIR: expect.stringContaining('open-science-notebook'),
          TEMP: expect.stringContaining('open-science-notebook'),
          TMP: expect.stringContaining('open-science-notebook')
        }),
        filesystem: expect.objectContaining({
          readWriteRoots: expect.arrayContaining([expect.stringContaining('open-science-notebook')])
        })
      })
    )
    await owner.initialize()
    expect(backend.initialize).toHaveBeenCalledOnce()

    const blockedExecution = wrapped.beginExecution?.()
    expect(backend.setExecutionActive).toHaveBeenLastCalledWith(true)
    await expect(
      backend.request?.({ host: 'auto.example.org', port: 443, purpose: 'probe' })
    ).resolves.toBe(false)
    requestDecision.mockResolvedValueOnce('deny')
    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'auto.example.org',
        reason: 'No actual block occurred.'
      })
    ).resolves.toMatchObject({ status: 'denied' })
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({ allowOnce: false }))
    requestDecision.mockClear()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    blockedExecution?.()
    expect(backend.resetNetworkConnections).toHaveBeenCalledTimes(2)

    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'data.example.org',
        reason: 'Download the requested dataset.'
      })
    ).resolves.toEqual({ hostname: 'data.example.org', status: 'allowedOnce' })
    expect(requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'data.example.org',
        runtime: 'python',
        reason: 'Download the requested dataset.'
      })
    )

    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    const endExecution = wrapped.beginExecution?.()
    const first = backend.request?.({ host: 'data.example.org', port: 443 })
    const second = backend.request?.({ host: 'data.example.org', port: 443 })
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(requestDecision).toHaveBeenCalledOnce()

    await expect(backend.request?.({ host: 'hooks.slack.com', port: 443 })).resolves.toBe(false)
    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'hooks.slack.com',
        reason: 'Post the requested result.',
        runtime: 'python',
        command: 'python loop.py'
      })
    ).resolves.toEqual({ hostname: 'hooks.slack.com', status: 'allowedOnce' })
    expect(requestDecision).toHaveBeenCalledTimes(2)
    endExecution?.()
    expect(backend.resetNetworkConnections).toHaveBeenCalledTimes(4)
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)

    const nextExecution = wrapped.beginExecution?.()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    nextExecution?.()
    await wrapped.cleanup('exit', { processesTerminated: true })

    const nextCommand = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['next.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python next.py',
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
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    await nextCommand.cleanup('exit', { processesTerminated: true })
    const commandTempRoot = backend.wrap.mock.calls[0]?.[0].env.TMPDIR as string
    await vi.waitFor(() => expect(existsSync(commandTempRoot)).toBe(false))
    await owner.dispose()
  })

  it.each(['user-decision', 'aborted'] as const)(
    'preserves the actual denial reason without granting access: %s',
    async (decisionSource) => {
      const requestDecision = vi.fn().mockResolvedValue('deny')
      const persistAlwaysAllow = vi.fn()
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow,
        requestDecision,
        platform: 'linux'
      })
      const commandText = 'curl data.example.org/a'
      let wrapped: Awaited<ReturnType<typeof owner.wrap>> | undefined
      try {
        wrapped = await owner.wrap({
          executable: '/usr/bin/bash',
          args: [],
          env: {},
          cwd: '/workspace',
          commandText,
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
        const finishBlockedExecution = wrapped.beginExecution?.()
        await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(
          false
        )
        finishBlockedExecution?.()
        const cancellation = new AbortController()
        if (decisionSource === 'aborted') cancellation.abort()
        const result = await owner.requestNetworkAccess({
          sessionId: 'session-1',
          projectId: 'project-1',
          hostname: 'data.example.org',
          reason: 'Download the dataset.',
          runtime: 'bash',
          command: commandText,
          signal: cancellation.signal
        })
        expect(result).toMatchObject({
          hostname: 'data.example.org',
          status: 'denied',
          decisionSource,
          message: expect.any(String)
        })
        expect(requestDecision).toHaveBeenCalledTimes(decisionSource === 'user-decision' ? 1 : 0)
        expect(persistAlwaysAllow).not.toHaveBeenCalled()
        const end = wrapped.beginExecution?.()
        await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(
          false
        )
        end?.()
      } finally {
        await wrapped?.cleanup('exit', { processesTerminated: true })
        await owner.dispose()
      }
    }
  )

  it('returns unavailable without creating a grant when no approval client is connected', async () => {
    const requestDecision = vi.fn().mockResolvedValue('unavailable')
    const { logger, records } = createCapturingLogger()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/private/resources/notebook-sandbox',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'linux',
      logger
    })
    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['loop.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/Users/example/private-study',
      commandText: 'python private-patient-analysis.py --token secret-value',
      sessionId: 'private-session-id',
      projectId: 'private-project-id',
      runtime: 'python',
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/Users/example/private-study'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const endExecution = wrapped.beginExecution?.()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endExecution?.()

    await expect(
      owner.requestNetworkAccess({
        sessionId: 'private-session-id',
        projectId: 'private-project-id',
        hostname: 'data.example.org',
        reason: 'Download private patient data.'
      })
    ).resolves.toEqual({
      hostname: 'data.example.org',
      status: 'unavailable',
      decisionSource: 'approval-surface-unavailable',
      message: expect.any(String)
    })
    expect(requestDecision).toHaveBeenCalledOnce()
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()

    const serialized = JSON.stringify(records)
    expect(serialized).toContain('approval-surface-unavailable')
    expect(serialized).toContain('"runtime":"python"')
    for (const privateValue of [
      'data.example.org',
      'private-patient-analysis.py',
      'secret-value',
      'private patient data',
      'private-session-id',
      'private-project-id',
      '/Users/example/private-study',
      '/private/resources/notebook-sandbox'
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
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

  it('fails closed instead of giving an ambiguous approval to the wrong runtime', async () => {
    const requestDecision = vi.fn().mockResolvedValue('allowOnce')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'linux'
    })
    const invocation = {
      executable: '/usr/bin/python',
      args: ['loop.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python loop.py',
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
    const python = await owner.wrap(invocation)
    const pythonRequest = backend.request!
    const bash = await owner.wrap({
      ...invocation,
      executable: '/bin/sh',
      args: ['-c', 'curl https://data.example.org'],
      commandText: 'curl https://data.example.org',
      runtime: 'bash'
    })
    const bashRequest = backend.request!

    const endPython = python.beginExecution?.()
    await expect(pythonRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endPython?.()
    const endBash = bash.beginExecution?.()
    await expect(bashRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endBash?.()

    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'data.example.org',
        reason: 'Download the requested dataset.',
        runtime: 'bash'
      })
    ).resolves.toEqual({ hostname: 'data.example.org', status: 'allowedOnce' })
    expect(requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'data.example.org', runtime: 'bash' })
    )

    await python.cleanup('exit', { processesTerminated: true })
    await bash.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it('binds a bash allow-once grant to the exact failed command', async () => {
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('allowOnce'),
      platform: 'linux'
    })
    const invocation = {
      executable: '/bin/sh',
      args: ['-c', 'curl https://data.example.org/a'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'curl https://data.example.org/a',
      sessionId: 'session-1',
      projectId: 'project-1',
      runtime: 'bash' as const,
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    }
    const first = await owner.wrap(invocation)
    const firstRequest = backend.request!
    const second = await owner.wrap({
      ...invocation,
      args: ['-c', 'curl https://data.example.org/b'],
      commandText: 'curl https://data.example.org/b'
    })
    const secondRequest = backend.request!

    const endFirst = first.beginExecution?.()
    await expect(firstRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endFirst?.()
    const endSecond = second.beginExecution?.()
    await expect(secondRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endSecond?.()

    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'data.example.org',
        reason: 'Download the requested dataset.',
        runtime: 'bash',
        command: invocation.commandText
      })
    ).resolves.toEqual({ hostname: 'data.example.org', status: 'allowedOnce' })

    const unrelated = await owner.wrap({
      ...invocation,
      args: ['-c', 'curl https://data.example.org/b'],
      commandText: 'curl https://data.example.org/b'
    })
    const unrelatedRequest = backend.request!
    const endUnrelated = unrelated.beginExecution?.()
    await expect(unrelatedRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    endUnrelated?.()

    const retry = await owner.wrap(invocation)
    const retryRequest = backend.request!
    const endRetry = retry.beginExecution?.()
    await expect(retryRequest({ host: 'data.example.org', port: 443 })).resolves.toBe(true)
    endRetry?.()

    await first.cleanup('exit', { processesTerminated: true })
    await second.cleanup('exit', { processesTerminated: true })
    await unrelated.cleanup('exit', { processesTerminated: true })
    await retry.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })

  it('persists and hot-applies an always-allow decision', async () => {
    const persistAlwaysAllow = vi.fn(async (hostname: string) => ({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: [hostname]
    }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow,
      requestDecision: vi.fn().mockResolvedValue('alwaysAllow'),
      platform: 'linux'
    })
    await owner.initialize()

    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['loop.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python loop.py',
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
    const blockedExecution = wrapped.beginExecution?.()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    blockedExecution?.()

    await expect(
      owner.requestNetworkAccess({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostname: 'data.example.org',
        reason: 'Download the requested dataset.'
      })
    ).resolves.toEqual({ hostname: 'data.example.org', status: 'alwaysAllowed' })
    expect(persistAlwaysAllow).toHaveBeenCalledWith('data.example.org')
    expect(backend.updatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: expect.arrayContaining(['data.example.org']) })
    )
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
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

  it('cancels a pending explicit decision with its RPC signal', async () => {
    let decisionSignal: AbortSignal | undefined
    const requestDecision = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<'deny'>((resolve) => {
          decisionSignal = signal
          signal.addEventListener('abort', () => resolve('deny'), { once: true })
        })
    )
    const persistAlwaysAllow = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow,
      requestDecision,
      platform: 'linux'
    })

    const cancellation = new AbortController()
    const wrapped = await owner.wrap({
      executable: '/usr/bin/python',
      args: ['loop.py'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      commandText: 'python loop.py',
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
    const blockedExecution = wrapped.beginExecution?.()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    blockedExecution?.()
    const result = owner.requestNetworkAccess({
      sessionId: 'session-1',
      projectId: 'project-1',
      hostname: 'data.example.org',
      reason: 'Download the requested dataset.',
      signal: cancellation.signal
    })
    await vi.waitFor(() => expect(requestDecision).toHaveBeenCalledOnce())
    cancellation.abort(new Error('Notebook tool ended.'))
    expect(decisionSignal?.aborted).toBe(true)
    await expect(result).resolves.toEqual({
      hostname: 'data.example.org',
      status: 'denied',
      decisionSource: 'aborted',
      message: expect.any(String)
    })
    expect(persistAlwaysAllow).not.toHaveBeenCalled()
    await wrapped.cleanup('exit', { processesTerminated: true })
    await owner.dispose()
  })
})

describe('explicit network approval without a preceding failure', () => {
  it('offers a card without command context instead of treating it as a user denial', async () => {
    const requestDecision = vi.fn().mockResolvedValue('alwaysAllow')
    const settings = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, allowedDomains: ['data.example.org'] }
    const persistAlwaysAllow = vi.fn().mockResolvedValue(settings)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow,
      requestDecision
    })
    await expect(
      owner.requestNetworkAccess({
        sessionId: 's',
        projectId: 'p',
        hostname: 'data.example.org',
        reason: 'Explicit user approval'
      })
    ).resolves.toMatchObject({ status: 'alwaysAllowed' })
    expect(requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({ allowOnce: false, hostname: 'data.example.org' })
    )
    expect(persistAlwaysAllow).toHaveBeenCalledWith('data.example.org')
    await owner.dispose()
  })

  it('binds a proactive one-time approval to only the supplied command and session', async () => {
    const requestDecision = vi.fn().mockResolvedValue('allowOnce')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'linux'
    })
    await expect(
      owner.requestNetworkAccess({
        sessionId: 's',
        projectId: 'p',
        hostname: 'data.example.org',
        reason: 'Upload synthetic data',
        runtime: 'bash',
        command: 'curl --data marker https://data.example.org'
      })
    ).resolves.toMatchObject({ status: 'allowedOnce' })
    expect(requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({ allowOnce: true, runtime: 'bash' })
    )
    for (const [sessionId, commandText, expected] of [
      ['other', 'curl --data marker https://data.example.org', false],
      ['s', 'different command', false],
      ['s', 'curl --data marker https://data.example.org', true],
      ['s', 'curl --data marker https://data.example.org', false]
    ] as const) {
      const wrapped = await owner.wrap({
        executable: '/bin/sh',
        args: ['-c', commandText],
        env: {},
        cwd: '/workspace',
        commandText,
        sessionId,
        projectId: 'p',
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['/workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const end = wrapped.beginExecution?.()
      await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(
        expected
      )
      end?.()
      await wrapped.cleanup('exit', { processesTerminated: true })
    }
    await owner.dispose()
  })

  it('cannot turn an invalid once selection without command context into a grant', async () => {
    const persistAlwaysAllow = vi.fn()
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow,
      requestDecision: vi.fn().mockResolvedValue('allowOnce')
    })
    await expect(
      owner.requestNetworkAccess({
        sessionId: 's',
        projectId: 'p',
        hostname: 'data.example.org',
        reason: 'Explicit approval'
      })
    ).resolves.toMatchObject({ status: 'unavailable' })
    expect(persistAlwaysAllow).not.toHaveBeenCalled()
    await owner.dispose()
  })
  it.each(['python', 'r', 'repl'] as const)(
    'does not offer proactive once for caller-supplied %s source code',
    async (runtime) => {
      const requestDecision = vi.fn().mockResolvedValue('deny')
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: '/resources',
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: vi.fn(),
        requestDecision
      })
      await expect(
        owner.requestNetworkAccess({
          sessionId: 's',
          projectId: 'p',
          hostname: 'data.example.org',
          reason: 'Explicit approval',
          runtime,
          command: 'source code is not a kernel command'
        })
      ).resolves.toMatchObject({ status: 'denied' })
      expect(requestDecision).toHaveBeenCalledWith(
        expect.objectContaining({ allowOnce: false, runtime })
      )
      await owner.dispose()
    }
  )

  it('rejects an invalid once selection for unrecognized Kernel command context', async () => {
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('allowOnce')
    })
    await expect(
      owner.requestNetworkAccess({
        sessionId: 's',
        projectId: 'p',
        hostname: 'data.example.org',
        reason: 'Explicit approval',
        runtime: 'python',
        command: 'print(1)'
      })
    ).resolves.toMatchObject({ status: 'unavailable' })
    await owner.dispose()
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
  'dispatches %s R in unconfigured Windows standard mode without authorization',
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
      expect(result.stdout).toContain('15')
      expect(beginSpawn).toHaveBeenCalledOnce()
      expect(started).toHaveBeenCalledOnce()
      expect(notStarted).not.toHaveBeenCalled()
      expect(backend.wrap).toHaveBeenCalledWith(
        expect.objectContaining({ windowsProtectionRequired: false })
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
      (await vi.importActual<typeof import('./r-command')>('./r-command')).rKernelProtocolProbe
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
        await expect(owner.wrap(invocation)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
        const failedCommand = runtimeWrap.mock.calls[1][0]
        const failedRoot = failedCommand.env.TMPDIR!
        await expect(owner.wrap(invocation)).rejects.toThrow()
        expect(runtimeWrap).toHaveBeenCalledTimes(2)
        expect(cleanup).toHaveBeenCalledTimes(2)
        expect(existsSync(failedRoot)).toBe(true)
        expect(existsSync(failedRoot + '.receipt')).toBe(true)
        recovered = true
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
