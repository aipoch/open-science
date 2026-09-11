import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import type { Logger } from '../logger'
import type { NotebookSandboxCleanupReason, NotebookSandboxProcessOutcome } from './process-sandbox'

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
  getWindowsRuntimeAccess: vi.fn().mockResolvedValue({ authorized: true, registered: true }),
  setWindowsRuntimeAccess: vi.fn().mockResolvedValue({ cancelled: false }),
  rKernelProtocolProbe: vi.fn().mockResolvedValue(true),
  dispose: vi.fn().mockResolvedValue(undefined)
}))

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
    ).resolves.toEqual({ hostname: 'data.example.org', status: 'unavailable' })
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
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: '/resources',
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
    await expect(result).resolves.toEqual({ hostname: 'data.example.org', status: 'denied' })
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
    ).resolves.toBeUndefined()
  } finally {
    await executor.shutdown()
    await owner.dispose()
  }
})

describe('R startup authorization admission', () => {
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
      await expect(owner.ensureRuntimeAccess(request)).rejects.toThrow('local Open Science desktop')
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
      await expect(owner.ensureRuntimeAccess(request)).resolves.toBeUndefined()
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
