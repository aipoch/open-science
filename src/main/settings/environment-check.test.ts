import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  runEnvironmentCheck,
  verifyStorageAccess,
  type EnvironmentCheckDeps
} from './environment-check'

const baseDeps = (): EnvironmentCheckDeps => ({
  platform: 'darwin' as const,
  architecture: 'arm64',
  verifyStorage: vi.fn().mockResolvedValue(undefined),
  resolveManagedPlatform: vi.fn().mockReturnValue({ key: 'darwin-arm64' }),
  findPython: vi.fn().mockResolvedValue({ command: 'python3', baseArgs: [] }),
  probeRegistry: vi.fn(async (registry: 'npmjs' | 'npmmirror') =>
    registry === 'npmmirror' ? 42 : 380
  ),
  now: () => 1234
})

describe('runEnvironmentCheck', () => {
  it('selects the fastest reachable trusted registry for a missing runtime', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: false },
      encryptionAvailable: true,
      deps: baseDeps()
    })

    expect(result.recommendedRegistry).toBe('npmmirror')
    expect(result.canAutoInstall).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.checks.find((check) => check.id === 'install-network')).toMatchObject({
      status: 'passed',
      summary: expect.stringContaining('npmmirror')
    })
  })

  it('blocks automatic installation when both trusted registries are unreachable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: false },
      encryptionAvailable: true,
      deps: { ...baseDeps(), probeRegistry: vi.fn().mockRejectedValue(new Error('offline')) }
    })

    expect(result.recommendedRegistry).toBeUndefined()
    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'install-network')).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('Neither the official registry')
    })
  })

  it('blocks automatic setup when the app data directory is not writable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/locked',
      claude: { found: false },
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        verifyStorage: vi.fn().mockRejectedValue(new Error('EACCES'))
      }
    })

    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'storage')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('EACCES')
    })
  })

  it('reports an available Python interpreter as an optional ready capability', async () => {
    const probeRegistry = vi.fn()
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: true, path: '/bin/claude', version: '2.1.0' },
      encryptionAvailable: true,
      deps: { ...baseDeps(), probeRegistry }
    })

    expect(probeRegistry).not.toHaveBeenCalled()
    expect(result.checks.find((check) => check.id === 'install-network')?.status).toBe('passed')
    expect(result.checks.find((check) => check.id === 'python')).toMatchObject({
      status: 'passed',
      detail: 'python3'
    })
    expect(result.ready).toBe(true)
    expect(result.canAutoInstall).toBe(false)
  })

  it('keeps missing Python non-blocking while explaining the Notebook limitation', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: true, path: '/bin/claude', version: '2.1.0' },
      encryptionAvailable: true,
      deps: { ...baseDeps(), findPython: vi.fn().mockResolvedValue(undefined) }
    })

    expect(result.checks.find((check) => check.id === 'python')).toMatchObject({
      status: 'warning',
      summary: expect.stringContaining('Core setup can continue'),
      detail: expect.stringContaining('Notebook execution will be unavailable')
    })
    expect(result.ready).toBe(true)
  })

  it('treats unavailable OS key encryption as a non-blocking warning', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: true, path: '/bin/claude' },
      encryptionAvailable: false,
      deps: baseDeps()
    })

    expect(result.checks.find((check) => check.id === 'secure-storage')?.status).toBe('warning')
    expect(result.ready).toBe(true)
  })

  it('blocks automatic installation on an unsupported platform when no runtime exists', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: false },
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        platform: 'freebsd' as NodeJS.Platform,
        architecture: 'x64',
        resolveManagedPlatform: () => {
          throw new Error('Unsupported platform for managed install')
        }
      }
    })

    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'system')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('Unsupported platform')
    })
  })

  it('keeps an existing runtime usable when only the managed installer is unsupported', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      claude: { found: true, path: '/opt/claude', version: '2.1.0' },
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        platform: 'freebsd' as NodeJS.Platform,
        resolveManagedPlatform: () => {
          throw new Error('Unsupported platform for managed install')
        }
      }
    })

    expect(result.checks.find((check) => check.id === 'system')?.status).toBe('warning')
    expect(result.ready).toBe(true)
  })

  it('verifies a real writable data directory without leaving probe files behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-environment-check-'))

    try {
      await verifyStorageAccess(root)
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
