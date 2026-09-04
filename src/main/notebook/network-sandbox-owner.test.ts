import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import type { Logger } from '../logger'

const backend = vi.hoisted(() => ({
  request: undefined as
    ((request: { host: string; port?: number }) => Promise<boolean>) | undefined,
  initialize: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn(),
  resetNetworkConnections: vi.fn(),
  wrap: vi.fn(),
  updatePolicy: vi.fn(),
  updateConfiguration: vi.fn(),
  status: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
  installWindows: vi.fn().mockResolvedValue({ cancelled: false }),
  removeWindows: vi.fn().mockResolvedValue({ cancelled: false }),
  dispose: vi.fn().mockResolvedValue(undefined)
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
    dispose = backend.dispose
  }
}))

import { NotebookNetworkSandboxOwner, commandLine } from './network-sandbox-owner'

const fixtureDirectories: string[] = []

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
  backend.installWindows.mockResolvedValue({ cancelled: false })
  backend.removeWindows.mockResolvedValue({ cancelled: false })
  backend.wrap.mockImplementation(
    async (command: {
      onNetworkAccessRequest: (request: {
        host: string
        port?: number
        signal: AbortSignal
      }) => Promise<boolean>
    }) => {
      const controller = new AbortController()
      let cleaned = false
      backend.request = ({ host, port }) =>
        command.onNetworkAccessRequest({
          host,
          ...(port === undefined ? {} : { port }),
          signal: controller.signal
        })
      return {
        argv: ['/sandbox/sh', '-c', 'wrapped'],
        env: { HTTPS_PROXY: 'http://127.0.0.1:4567' },
        annotateStderr: (stderr: string) => stderr,
        resetNetworkConnections: backend.resetNetworkConnections,
        cleanup: () => {
          if (cleaned) return
          cleaned = true
          controller.abort(new Error('Notebook process ended.'))
          backend.cleanup()
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
        args: ['D:\\app\\python_loop.py']
      })
    )

    wrapped.cleanup()
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
    expect(wrapped).toMatchObject({
      executable: '/sandbox/sh',
      args: ['-c', 'wrapped'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4567' }
    })
    expect(backend.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          TMPDIR: expect.stringContaining('open-science-notebook-'),
          TEMP: expect.stringContaining('open-science-notebook-'),
          TMP: expect.stringContaining('open-science-notebook-')
        }),
        filesystem: expect.objectContaining({
          readWriteRoots: expect.arrayContaining([
            expect.stringContaining('open-science-notebook-')
          ])
        })
      })
    )
    await owner.initialize()
    expect(backend.initialize).toHaveBeenCalledOnce()

    const blockedExecution = wrapped.beginExecution?.()
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
    wrapped.cleanup()

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
    nextCommand.cleanup()
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
    wrapped.cleanup()
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

    python.cleanup()
    bash.cleanup()
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

    first.cleanup()
    second.cleanup()
    unrelated.cleanup()
    retry.cleanup()
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
    wrapped.cleanup()
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
    wrapped.cleanup()
    wrapped.cleanup()
    expect(backend.cleanup).toHaveBeenCalledOnce()
    await expect(backend.request?.({ host: 'data.example.org', port: 443 })).resolves.toBe(false)
    expect(requestDecision).not.toHaveBeenCalled()
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
    wrapped.cleanup()
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
    wrapped.cleanup()
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
    wrapped.cleanup()
    await owner.dispose()
  })
})
