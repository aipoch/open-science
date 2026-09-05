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

import { NotebookNetworkSandbox } from './index.js'
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
  backend.reset.mockResolvedValue(undefined)
})

describe('NotebookNetworkSandbox', () => {
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

  it('owns one process sandbox, wraps commands, and releases ownership', async () => {
    const first = new NotebookNetworkSandbox(options())
    const second = new NotebookNetworkSandbox(options())
    vi.spyOn(first, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    vi.spyOn(second, 'status').mockResolvedValue({ kind: 'ready', warnings: [] })
    backend.wrap.mockResolvedValue({
      argv: ['/bin/sh', '-c', 'sandboxed'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4123' }
    })

    await first.initialize()
    await expect(second.initialize()).rejects.toThrow(
      'Only one Notebook network sandbox owner may be active in a process.'
    )
    const wrapped = await first.wrap({
      command: 'python notebook.py',
      cwd: '/workspace',
      onNetworkAccessRequest: denyNetwork
    })
    expect(wrapped).toMatchObject({
      argv: ['/bin/sh', '-c', 'sandboxed'],
      env: { HTTPS_PROXY: 'http://127.0.0.1:4123' }
    })
    expect(wrapped.annotateStderr).toBeTypeOf('function')
    expect(wrapped.resetNetworkConnections).toBeTypeOf('function')
    expect(wrapped.cleanup).toBeTypeOf('function')

    first.updatePolicy({ allowedDomains: ['api.crossref.org'], deniedDomains: [] })
    expect(backend.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDomains: ['api.crossref.org']
      })
    )

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
    wrapped.cleanup()
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
    wrapped.cleanup()
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

    wrapped.cleanup()
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
    wrapped.cleanup()
    wrapped.cleanup()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledOnce()
    expect(backend.cleanupAfterCommand).toHaveBeenCalledWith(expect.any(String))
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

      first.cleanup()
      second.cleanup()
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
