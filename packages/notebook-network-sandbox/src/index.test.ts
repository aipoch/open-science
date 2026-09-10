import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  initialize: vi.fn(),
  wrap: vi.fn(),
  updateConfig: vi.fn(),
  annotateStderr: vi.fn(),
  resetCommandConnections: vi.fn(),
  cleanupAfterCommand: vi.fn(),
  refreshWindowsProtection: vi.fn(),
  reset: vi.fn()
}))

vi.mock('../runtime/src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/src/index.js')>()),
  NotebookNetworkRuntime: backend
}))

import { NotebookNetworkSandbox, NotebookSandboxPreparationError } from './index.js'
import type { NotebookNetworkSandboxOptions } from './types.js'

const options = (): NotebookNetworkSandboxOptions => ({
  policy: { allowedDomains: ['openalex.org'], deniedDomains: [] },
  resources: { root: '/app/resources/notebook-network-sandbox' }
})
const denyNetwork = async (): Promise<boolean> => false

beforeEach(() => {
  vi.restoreAllMocks()
  for (const mock of Object.values(backend)) mock.mockReset()
  backend.initialize.mockResolvedValue(undefined)
  backend.refreshWindowsProtection.mockResolvedValue({ warnings: [], errors: [] })
  backend.cleanupAfterCommand.mockImplementation(async (_commandId, _reason, processOutcome) => ({
    processesTerminated: processOutcome.processesTerminated,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }))
  backend.reset.mockResolvedValue(undefined)
})

describe('NotebookNetworkSandbox', () => {
  it('shares one termination verification across concurrent admissions', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    await sandbox.initialize()
    const command = { command: 'true', cwd: '/workspace', onNetworkAccessRequest: denyNetwork }
    const first = await sandbox.wrap(command)
    let confirm!: (value: boolean) => void
    const confirmTermination = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve
        })
    )
    await first.cleanup('exit', { processesTerminated: false, confirmTermination })
    const next = Promise.all([sandbox.wrap(command), sandbox.wrap(command)])
    await vi.waitFor(() => expect(confirmTermination).toHaveBeenCalledOnce())
    confirm(true)
    const commands = await next
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(2)
    await Promise.all(
      commands.map((wrapped) => wrapped.cleanup('exit', { processesTerminated: true }))
    )
    await sandbox.dispose()
  })
  it('reconciles native cleanup only when the original process owner supplies new evidence', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    await sandbox.initialize()
    const command = { command: 'true', cwd: '/workspace', onNetworkAccessRequest: denyNetwork }
    const first = await sandbox.wrap(command)
    const confirmTermination = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await first.cleanup('exit', { processesTerminated: false, confirmTermination })
    expect(confirmTermination).not.toHaveBeenCalled()
    await expect(sandbox.wrap(command)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    expect(backend.wrap).toHaveBeenCalledTimes(1)
    const second = await sandbox.wrap(command)
    expect(confirmTermination).toHaveBeenCalledTimes(2)
    expect(backend.cleanupAfterCommand).toHaveBeenLastCalledWith(expect.any(String), 'exit', {
      processesTerminated: true
    })
    await second.cleanup('exit', { processesTerminated: true })
    await sandbox.dispose()
  })
  it('keeps native execution blocked without new termination evidence', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    await sandbox.initialize()
    const command = { command: 'true', cwd: '/workspace', onNetworkAccessRequest: denyNetwork }
    const first = await sandbox.wrap(command)
    await first.cleanup('exit', { processesTerminated: false })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(sandbox.wrap(command)).rejects.toThrow(
        'SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.'
      )
    }
    expect(backend.wrap).toHaveBeenCalledTimes(1)
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(4)
    for (const call of backend.cleanupAfterCommand.mock.calls) {
      expect(call[2]).toEqual({ processesTerminated: false })
    }
    // Release the module singleton after reproducing the retained failure.
    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await sandbox.dispose()
  })
  it('reports unsupported platforms without starting a backend', async () => {
    const sandbox = new NotebookNetworkSandbox(options())

    await expect(sandbox.status('aix')).resolves.toEqual({ kind: 'unsupported', platform: 'aix' })
    expect(backend.initialize).not.toHaveBeenCalled()
  })

  it('fails closed before initialization', async () => {
    const sandbox = new NotebookNetworkSandbox(options())

    await expect(
      sandbox.wrap({
        command: 'python notebook.py',
        cwd: '/workspace',
        onNetworkAccessRequest: denyNetwork
      })
    ).rejects.toThrow('Notebook network sandbox is not initialized.')
    expect(() => sandbox.updatePolicy({ allowedDomains: [], deniedDomains: [] })).toThrow(
      'Notebook network sandbox is not initialized.'
    )
  })

  it('awaits one backend cleanup when command preparation fails', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockRejectedValue(new Error('preparation failed'))

    await sandbox.initialize()
    const failure = sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    await expect(failure).rejects.toBeInstanceOf(NotebookSandboxPreparationError)
    await expect(failure).rejects.toMatchObject({
      message: 'preparation failed',
      cleanupComplete: true,
      cause: expect.objectContaining({ message: 'preparation failed' })
    })
    expect(backend.cleanupAfterCommand).toHaveBeenCalledOnce()
    await sandbox.dispose()
  })

  it('aborts and awaits in-flight preparation before disposing it as never spawned', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )

    await sandbox.initialize()
    const wrapping = sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    await vi.waitFor(() => expect(backend.wrap).toHaveBeenCalledOnce())
    const disposal = sandbox.dispose()

    await expect(wrapping).rejects.toThrow('Notebook process ended.')
    await expect(disposal).resolves.toBeUndefined()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledOnce()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledWith(expect.any(String), 'spawn-failed', {
      processesTerminated: true
    })
  })

  it('surfaces incomplete preparation cleanup before the backend failure classification', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockRejectedValue(new Error('runtime unavailable'))
    backend.cleanupAfterCommand
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })

    await sandbox.initialize()
    await expect(
      sandbox.wrap({
        command: 'python notebook.py',
        cwd: '/workspace',
        onNetworkAccessRequest: denyNetwork
      })
    ).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    await expect(sandbox.dispose()).resolves.toBeUndefined()
  })

  it('owns one process sandbox, wraps commands, and releases ownership', async () => {
    const first = new NotebookNetworkSandbox(options())
    const second = new NotebookNetworkSandbox(options())
    vi.spyOn(first, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    vi.spyOn(second, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    const beginSpawn = vi.fn()
    backend.wrap.mockResolvedValue({
      argv: ['/bin/sh', '-c', 'sandboxed'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4123' },
      confirmProcessTreeTermination: async () => true,
      beginSpawn
    })

    await first.initialize()
    await expect(second.initialize()).rejects.toThrow(
      'Only one Notebook network sandbox owner may be active in a process.'
    )
    const wrapped = await first.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      superviseProcessTree: true,
      onNetworkAccessRequest: denyNetwork
    })
    expect(wrapped).toMatchObject({
      argv: ['/bin/sh', '-c', 'sandboxed'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4123' }
    })
    expect(wrapped.annotateStderr).toBeTypeOf('function')
    expect(wrapped.resetNetworkConnections).toBeTypeOf('function')
    expect(wrapped.cleanup).toBeTypeOf('function')
    expect(wrapped.beginSpawn).toBe(beginSpawn)
    await expect(wrapped.confirmProcessTreeTermination?.()).resolves.toBe(true)
    expect(backend.wrap).toHaveBeenCalledWith(
      expect.objectContaining({ superviseProcessTree: true })
    )

    first.updatePolicy({ allowedDomains: ['api.crossref.org'], deniedDomains: [] })
    expect(backend.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDomains: ['api.crossref.org']
      })
    )

    await wrapped.cleanup('exit', { processesTerminated: true })
    await first.dispose()
    await expect(second.initialize()).resolves.toBeUndefined()
    await second.dispose()
    expect(backend.reset).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent initialization for the same owner', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })

    await Promise.all([sandbox.initialize(), sandbox.initialize()])

    expect(backend.initialize).toHaveBeenCalledOnce()
    await sandbox.dispose()
  })

  it('forwards unknown destinations to the application decision callback', async () => {
    let decisionSignal: AbortSignal | undefined
    const onNetworkAccessRequest = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      decisionSignal = signal
      return true
    })
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })

    await sandbox.initialize()
    const wrapped = await sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest
    })
    const commandId = backend.wrap.mock.calls[0]?.[0]?.commandId
    expect(commandId).toEqual(expect.any(String))
    const decision = backend.initialize.mock.calls[0]?.[1]
    await expect(decision?.({ host: 'new.example.org', port: 443, commandId })).resolves.toBe(true)
    await expect(
      decision?.({ host: 'new.example.org', port: 443, commandId: 'unknown' })
    ).resolves.toBe(false)
    expect(onNetworkAccessRequest).toHaveBeenCalledWith({
      host: 'new.example.org',
      port: 443,
      signal: expect.any(AbortSignal)
    })
    expect(decisionSignal?.aborted).toBe(false)
    await wrapped.cleanup('exit', { processesTerminated: true })
    expect(decisionSignal?.aborted).toBe(true)
    await expect(decision?.({ host: 'new.example.org', port: 443, commandId })).resolves.toBe(false)
    await sandbox.dispose()
  })

  it('fails closed when a live process decision handler rejects', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })

    await sandbox.initialize()
    const wrapped = await sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: async () => {
        throw new Error('approval unavailable')
      }
    })
    const commandId = backend.wrap.mock.calls[0]?.[0]?.commandId
    const decision = backend.initialize.mock.calls[0]?.[1]

    await expect(decision?.({ host: 'new.example.org', port: 443, commandId })).resolves.toBe(false)
    await wrapped.cleanup('exit', { processesTerminated: true })
    await sandbox.dispose()
  })

  it('ignores an approval that resolves after its process is cleaned up', async () => {
    let resolveDecision: ((allowed: boolean) => void) | undefined
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })

    await sandbox.initialize()
    const wrapped = await sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: () =>
        new Promise<boolean>((resolve) => {
          resolveDecision = resolve
        })
    })
    const commandId = backend.wrap.mock.calls[0]?.[0]?.commandId
    const decision = backend.initialize.mock.calls[0]?.[1]?.({
      host: 'new.example.org',
      port: 443,
      commandId
    })

    await wrapped.cleanup('exit', { processesTerminated: true })
    resolveDecision?.(true)

    await expect(decision).resolves.toBe(false)
    await sandbox.dispose()
  })

  it('surfaces sandbox denial annotations and cleans up each command once', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.annotateStderr.mockReturnValue('annotated stderr')

    await sandbox.initialize()
    const wrapped = await sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    expect(wrapped.annotateStderr('curl failed')).toBe('annotated stderr')
    wrapped.resetNetworkConnections()
    expect(backend.resetCommandConnections).toHaveBeenCalledWith(expect.any(String))
    const firstCleanup = wrapped.cleanup('timeout', { processesTerminated: false })
    const secondCleanup = wrapped.cleanup('cancel', { processesTerminated: true })
    await expect(firstCleanup).resolves.toEqual({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await expect(secondCleanup).resolves.toEqual({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(firstCleanup).toBe(secondCleanup)
    expect(backend.cleanupAfterCommand).toHaveBeenCalledOnce()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledWith(expect.any(String), 'timeout', {
      processesTerminated: false
    })
    backend.cleanupAfterCommand.mockResolvedValueOnce({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await wrapped.cleanup('cancel', { processesTerminated: true })
    await sandbox.dispose()
  })

  it('retains command ownership and retries incomplete backend cleanup', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand
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

    await sandbox.initialize()
    const wrapped = await sandbox.wrap({
      command: 'sleep 30',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    await expect(wrapped.cleanup('cancel', { processesTerminated: false })).resolves.toMatchObject({
      processesTerminated: false,
      temporaryResourcesRemoved: false
    })
    const next = await sandbox.wrap({
      command: 'echo next',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(2)
    expect(backend.cleanupAfterCommand.mock.calls[1]?.[0]).toBe(
      backend.cleanupAfterCommand.mock.calls[0]?.[0]
    )
    await next.cleanup('exit', { processesTerminated: true })
    await sandbox.dispose()
  })

  it('keeps disposal retryable when an active command cleanup is incomplete', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand
      .mockResolvedValueOnce({
        processesTerminated: false,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })

    await sandbox.initialize()
    await sandbox.wrap({
      command: 'sleep 30',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })

    await expect(sandbox.dispose()).rejects.toThrow(
      'Notebook network sandbox cleanup was incomplete.'
    )
    expect(backend.reset).not.toHaveBeenCalled()
    await expect(sandbox.dispose()).resolves.toBeUndefined()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(2)
    expect(backend.reset).toHaveBeenCalledOnce()
  })

  it('allows a native wrap while cleanup remains incomplete for a previous WSL2 profile', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand
      .mockResolvedValueOnce({
        processesTerminated: false,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    const wslTarget = {
      kind: 'wsl2' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }

    await sandbox.initialize()
    const wsl2 = await sandbox.wrap({
      target: wslTarget,
      command: 'sleep 30',
      cwd: 'C:\\workspace',
      onNetworkAccessRequest: denyNetwork
    })
    await expect(wsl2.cleanup('timeout', { processesTerminated: false })).resolves.toMatchObject({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })

    const nativeOutcome = await sandbox
      .wrap({
        target: { kind: 'native' },
        command: 'Write-Output ready',
        cwd: 'C:\\workspace',
        onNetworkAccessRequest: denyNetwork
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, error })
      )
    const wrapCallCountBeforeCleanup = backend.wrap.mock.calls.length
    const cleanupCallCountBeforeCleanup = backend.cleanupAfterCommand.mock.calls.length
    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    if (nativeOutcome.status === 'fulfilled') {
      await nativeOutcome.value.cleanup('exit', { processesTerminated: true })
    }
    await sandbox.dispose()

    expect(nativeOutcome).toMatchObject({ status: 'fulfilled' })
    expect(wrapCallCountBeforeCleanup).toBe(2)
    expect(cleanupCallCountBeforeCleanup).toBe(1)
  })

  it('blocks another wrap for the same WSL2 profile while its previous cleanup is incomplete', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: false,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
    const target = {
      kind: 'wsl2' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }
    const command = {
      target,
      command: 'sleep 30',
      cwd: 'C:\\workspace',
      onNetworkAccessRequest: denyNetwork
    }

    await sandbox.initialize()
    const first = await sandbox.wrap(command)
    await first.cleanup('timeout', { processesTerminated: false })

    await expect(
      sandbox.wrap({
        ...command,
        target: { ...target, profileId: 'profile-id-was-regenerated' }
      })
    ).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.')
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(2)
    expect(backend.wrap).toHaveBeenCalledTimes(1)

    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await sandbox.dispose()
  })

  it('allows a different WSL2 distro and user while previous profile cleanup is incomplete', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand
      .mockResolvedValueOnce({
        processesTerminated: false,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    const oldTarget = {
      kind: 'wsl2' as const,
      profileId: 'old-profile-id',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }

    await sandbox.initialize()
    const old = await sandbox.wrap({
      target: oldTarget,
      command: 'sleep 30',
      cwd: 'C:\\workspace',
      onNetworkAccessRequest: denyNetwork
    })
    await old.cleanup('timeout', { processesTerminated: false })

    const different = await sandbox.wrap({
      target: {
        kind: 'wsl2',
        profileId: 'different-profile-id',
        distro: 'Debian',
        user: 'analyst'
      },
      command: 'true',
      cwd: 'C:\\workspace',
      onNetworkAccessRequest: denyNetwork
    })
    expect(backend.wrap).toHaveBeenCalledTimes(2)
    expect(backend.cleanupAfterCommand).toHaveBeenCalledTimes(1)

    await different.cleanup('exit', { processesTerminated: true })
    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    await sandbox.dispose()
  })

  it('defaults omitted targets to native and forwards explicit WSL2 targets', async () => {
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })
    backend.cleanupAfterCommand.mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })

    await sandbox.initialize()
    const native = await sandbox.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    const target = {
      kind: 'wsl2' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu',
      user: 'researcher'
    }
    const wsl2 = await sandbox.wrap({
      target,
      command: 'python notebook.py',
      cwd: 'C:\\workspace',
      pathEnvironment: { UV_CACHE_DIR: 'C:\\workspace\\cache\\uv' },
      onNetworkAccessRequest: denyNetwork
    })

    expect(backend.wrap.mock.calls[0]?.[0]).toMatchObject({ target: { kind: 'native' } })
    expect(backend.wrap.mock.calls[1]?.[0]).toMatchObject({
      target,
      pathEnvironment: { UV_CACHE_DIR: 'C:\\workspace\\cache\\uv' }
    })
    await native.cleanup('exit', { processesTerminated: true })
    await wsl2.cleanup('exit', { processesTerminated: true })
    await sandbox.dispose()
  })

  it('supports concurrent Windows commands with independent runtime gateways', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const sandbox = new NotebookNetworkSandbox(options())
    vi.spyOn(sandbox, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({ argv: ['sandboxed'], env: {} })

    try {
      await sandbox.initialize()
      const first = await sandbox.wrap({
        command: 'python first.py',
        cwd: 'C:\\workspace',
        onNetworkAccessRequest: denyNetwork
      })
      const second = await sandbox.wrap({
        command: 'python second.py',
        cwd: 'C:\\workspace',
        onNetworkAccessRequest: denyNetwork
      })

      await first.cleanup('exit', { processesTerminated: true })
      await second.cleanup('exit', { processesTerminated: true })
      expect(backend.wrap).toHaveBeenCalledTimes(2)
    } finally {
      await sandbox.dispose()
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })

  it('initializes Windows standard mode when protected mode is not set up', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const sandbox = new NotebookNetworkSandbox(options())
    const initialStatus = vi.spyOn(sandbox, 'status').mockResolvedValueOnce({
      kind: 'setupRequired',
      platform: 'win32',
      reasons: ['Notebook AppContainer profile is not installed']
    })

    try {
      await expect(sandbox.initialize()).resolves.toBeUndefined()
      expect(backend.initialize).toHaveBeenCalledOnce()
      initialStatus.mockRestore()
      backend.refreshWindowsProtection.mockResolvedValue({
        warnings: [],
        errors: ['Notebook AppContainer profile is not installed']
      })

      await expect(sandbox.status()).resolves.toEqual({
        kind: 'setupRequired',
        platform: 'win32',
        reasons: ['Notebook AppContainer profile is not installed']
      })
    } finally {
      await sandbox.dispose()
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })

  it('refreshes the active Windows fence when Settings checks status', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const sandbox = new NotebookNetworkSandbox(options())
    const initialStatus = vi
      .spyOn(sandbox, 'status')
      .mockResolvedValueOnce({ kind: 'ready', warnings: [] })

    try {
      await sandbox.initialize()
      initialStatus.mockRestore()
      backend.refreshWindowsProtection.mockResolvedValue({
        warnings: [],
        errors: ['Notebook AppContainer loopback network fence is not installed']
      })

      await expect(sandbox.status()).resolves.toEqual({
        kind: 'setupRequired',
        platform: 'win32',
        reasons: ['Notebook AppContainer loopback network fence is not installed']
      })
      expect(backend.refreshWindowsProtection).toHaveBeenCalledOnce()
    } finally {
      await sandbox.dispose()
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })

  it.runIf(process.platform !== 'win32')('never starts Windows setup off Windows', async () => {
    const sandbox = new NotebookNetworkSandbox(options())

    await expect(sandbox.installWindows()).rejects.toThrow(
      'Windows sandbox installation is only available on Windows.'
    )
    await expect(sandbox.removeWindows()).rejects.toThrow(
      'Windows sandbox removal is only available on Windows.'
    )
  })
})
