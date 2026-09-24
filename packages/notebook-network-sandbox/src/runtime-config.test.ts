import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const gateway = vi.hoisted(() => ({
  port: 4312,
  updateParentProxy: vi.fn(),
  resetConnections: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined)
}))
const wslRelease = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const wslBeginSpawn = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}))

vi.mock('../runtime/src/gateway/command-gateway.js', () => ({
  CommandGateway: { open: vi.fn().mockResolvedValue(gateway) }
}))

vi.mock('../runtime/src/platform/macos-isolation.js', () => ({
  macosLaunch: vi.fn(({ env }) => ({ argv: ['/sandboxed'], env }))
}))

vi.mock('../runtime/src/platform/linux-isolation.js', () => ({
  checkLinuxTools: vi.fn(() => ({ warnings: [], errors: [] })),
  linuxLaunch: vi.fn(async ({ env }) => ({
    argv: ['/sandboxed'],
    env,
    release: vi.fn().mockResolvedValue(undefined)
  }))
}))

vi.mock('../runtime/src/platform/wsl2-isolation.js', () => ({
  wsl2Launch: vi.fn(async ({ env }) => ({
    argv: ['C:\\Windows\\System32\\wsl.exe', '--exec', '/usr/bin/bwrap'],
    env,
    beginSpawn: wslBeginSpawn,
    release: wslRelease
  }))
}))

vi.mock('../runtime/src/platform/windows-appcontainer.js', () => ({
  windowsLaunch: vi.fn(({ env }) => ({
    argv: ['sandboxed.exe'],
    env,
    confirmProcessTreeTermination: async () => true
  })),
  windowsSupervisedLaunch: vi.fn(({ env }) => ({
    argv: ['supervised.exe'],
    env,
    confirmProcessTreeTermination: async () => true
  })),
  windowsStandardLaunch: vi.fn(({ env }) => ({ argv: ['powershell.exe'], env })),
  isWindowsProtectionConfigured: vi.fn().mockResolvedValue(true),
  getWindowsRuntimeAccess: vi.fn().mockResolvedValue({ authorized: true, registered: true }),
  checkWindowsAppContainer: vi.fn().mockResolvedValue({ warnings: [], errors: [] }),
  readAppContainerStatus: vi.fn().mockResolvedValue({ gatewayPort: 49700 }),
  installWindowsAppContainer: vi.fn(),
  setWindowsRuntimeAccess: vi.fn(),
  removeWindowsAppContainer: vi.fn()
}))

import {
  NotebookNetworkRuntime,
  installWindows,
  removeWindows,
  setWindowsRuntimeAccess,
  type NetworkWrapRequest,
  type NetworkRuntimeConfig
} from '../runtime/src/notebook-runtime.js'
import { CommandGateway } from '../runtime/src/gateway/command-gateway.js'
import {
  buildNotebookNetworkPolicy,
  normalizeNotebookNetworkSettings
} from '../../../src/shared/notebook-network.js'
import { createRuntimeConfig } from './config.js'
import { linuxLaunch } from '../runtime/src/platform/linux-isolation.js'
import { wsl2Launch } from '../runtime/src/platform/wsl2-isolation.js'
import { readAppContainerStatus } from '../runtime/src/platform/windows-appcontainer.js'
import {
  checkWindowsAppContainer,
  isWindowsProtectionConfigured,
  getWindowsRuntimeAccess,
  installWindowsAppContainer,
  windowsLaunch,
  windowsStandardLaunch,
  windowsSupervisedLaunch
} from '../runtime/src/platform/windows-appcontainer.js'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const hostWorkspace = join(tmpdir(), 'open-science-wsl-runtime-config-workspace')
const hostUvCache = join(hostWorkspace, 'cache', 'uv')

const config = (allowedDomains: readonly string[]): NetworkRuntimeConfig => ({
  allowedDomains,
  deniedDomains: [],
  installationId: '0123456789abcdef01234567',
  windowsHostPath: 'C:\\resources\\sandbox.exe',
  windowsOwnershipRoot: 'C:\\ownership'
})

beforeEach(async () => {
  vi.clearAllMocks()
  await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)
  await NotebookNetworkRuntime.wrap({
    command: 'curl https://example.com',
    commandId: 'command-1',
    cwd: '/workspace',
    env: {},
    filesystem: {
      readOnlyRoots: ['/usr/bin'],
      readWriteRoots: ['/workspace'],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }
  })
})

afterEach(async () => {
  await NotebookNetworkRuntime.reset()
  vi.unstubAllEnvs()
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('Notebook runtime configuration updates', () => {
  it('routes disabled overlapping domains through approval after a live policy update', async () => {
    const settings = normalizeNotebookNetworkSettings({
      disabledOpenScienceDomains: ['rest.uniprot.org']
    })
    const next = (value: typeof settings): NetworkRuntimeConfig =>
      createRuntimeConfig({
        resources: { root: '/resources' },
        policy: buildNotebookNetworkPolicy(value)
      })
    NotebookNetworkRuntime.updateConfig(next(settings))
    const decide = vi.mocked(CommandGateway.open).mock.calls[0]![0].decide
    await expect(decide('rest.uniprot.org', 443)).resolves.toMatchObject({ allowed: false })
    await expect(decide('www.uniprot.org', 443)).resolves.toMatchObject({ allowed: true })
    NotebookNetworkRuntime.updateConfig(next({ ...settings, allowedDomains: ['rest.uniprot.org'] }))
    await expect(decide('rest.uniprot.org', 443)).resolves.toMatchObject({ allowed: true })
  })

  it('routes an explicit WSL2 target through its command-scoped host gateway', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const target = {
      kind: 'wsl2' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu',
      user: 'researcher'
    }
    const wrapped = await NotebookNetworkRuntime.wrap({
      target,
      command: 'echo sandboxed',
      commandId: 'wsl2-command',
      cwd: hostWorkspace,
      env: {},
      pathEnvironment: { UV_CACHE_DIR: hostUvCache },
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [hostWorkspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    expect(wrapped).toEqual({
      argv: ['C:\\Windows\\System32\\wsl.exe', '--exec', '/usr/bin/bwrap'],
      env: {},
      beginSpawn: wslBeginSpawn
    })
    expect(wsl2Launch).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        command: 'echo sandboxed',
        cwd: hostWorkspace,
        pathEnvironment: { UV_CACHE_DIR: hostUvCache },
        gatewayPort: 4312,
        gatewayCredentials: expect.objectContaining({
          username: 'notebook-wsl2-command',
          password: expect.any(String)
        })
      })
    )
    expect(CommandGateway.open).toHaveBeenCalledTimes(2)
    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('wsl2-command', 'cancel', {
        processesTerminated: false
      })
    ).resolves.toMatchObject({ processesTerminated: true })
    await NotebookNetworkRuntime.cleanupAfterCommand('wsl2-command', 'timeout', {
      processesTerminated: true
    })
    expect(wslRelease).toHaveBeenCalledOnce()
    expect(wslRelease).toHaveBeenCalledWith('cancel')
  })

  it('fails the process and temporary-resource cleanup stages when exact WSL cleanup is incomplete', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslRelease
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
    await NotebookNetworkRuntime.wrap({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu',
        user: 'researcher'
      },
      command: 'sleep 30',
      commandId: 'incomplete-wsl2-command',
      cwd: hostWorkspace,
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [hostWorkspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('incomplete-wsl2-command', 'timeout', {
        processesTerminated: true
      })
    ).resolves.toEqual({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: false
    })
    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('incomplete-wsl2-command', 'cancel', {
        processesTerminated: false
      })
    ).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(wslRelease).toHaveBeenCalledTimes(2)
  })

  it('forwards cancellation into WSL preparation', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const controller = new AbortController()

    await NotebookNetworkRuntime.wrap({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu',
        user: 'researcher'
      },
      command: 'sleep 30',
      commandId: 'abortable-wsl2-command',
      cwd: hostWorkspace,
      env: {},
      signal: controller.signal,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [hostWorkspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(wsl2Launch).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    await NotebookNetworkRuntime.cleanupAfterCommand('abortable-wsl2-command', 'cancel', {
      processesTerminated: false
    })
  })
  it('disconnects existing tunnels before they can outlive a policy change', () => {
    NotebookNetworkRuntime.updateConfig(config([]))

    expect(gateway.updateParentProxy).toHaveBeenCalledWith(undefined)
    expect(gateway.resetConnections).toHaveBeenCalledOnce()
  })

  it('reports incomplete network cleanup without rejecting the completion path', async () => {
    gateway.close.mockRejectedValueOnce(new Error('private gateway detail'))

    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('command-1', 'exit', {
        processesTerminated: true
      })
    ).resolves.toEqual({
      processesTerminated: true,
      networkClosed: false,
      temporaryResourcesRemoved: true
    })
  })

  it('reports an incomplete WSL bridge cleanup independently from gateway cleanup', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslRelease.mockResolvedValueOnce({
      processesTerminated: true,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })

    await NotebookNetworkRuntime.wrap({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu',
        user: 'researcher'
      },
      command: 'echo sandboxed',
      commandId: 'wsl2-cleanup-command',
      cwd: hostWorkspace,
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [hostWorkspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('wsl2-cleanup-command', 'exit', {
        processesTerminated: true
      })
    ).resolves.toEqual({
      processesTerminated: true,
      networkClosed: false,
      temporaryResourcesRemoved: false
    })
  })

  it('closes the command gateway when WSL bridge preparation fails', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(wsl2Launch).mockRejectedValueOnce(new Error('private WSL detail'))

    await expect(
      NotebookNetworkRuntime.wrap({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu',
          user: 'researcher'
        },
        command: 'echo sandboxed',
        commandId: 'wsl2-failed-command',
        cwd: hostWorkspace,
        env: {},
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [hostWorkspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    ).rejects.toThrow('private WSL detail')
    expect(gateway.close).toHaveBeenCalledOnce()
  })

  it('retains an early WSL cleanup handle and prioritizes incomplete cleanup over abort', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslRelease
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
    vi.mocked(wsl2Launch).mockImplementationOnce(async (request) => {
      request.onCleanupReady?.(wslRelease)
      throw new DOMException('Aborted', 'AbortError')
    })

    await expect(
      NotebookNetworkRuntime.wrap({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu',
          user: 'researcher'
        },
        command: 'echo sandboxed',
        commandId: 'wsl2-aborted-bridge-command',
        cwd: hostWorkspace,
        env: {},
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: [hostWorkspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    ).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    expect(wslRelease).toHaveBeenCalledWith('spawn-failed')
    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('wsl2-aborted-bridge-command', 'spawn-failed', {
        processesTerminated: true
      })
    ).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
  })

  it('reports the observed process teardown outcome instead of assuming termination', async () => {
    await expect(
      NotebookNetworkRuntime.cleanupAfterCommand('command-1', 'timeout', {
        processesTerminated: false
      })
    ).resolves.toMatchObject({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
  })

  it('opens the next command only after the previous gateway has closed', async () => {
    let releaseClose: (() => void) | undefined
    gateway.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve
        })
    )

    try {
      void NotebookNetworkRuntime.cleanupAfterCommand('command-1', 'exit', {
        processesTerminated: true
      })
      const wrapping = NotebookNetworkRuntime.wrap({
        command: 'curl https://example.com',
        commandId: 'command-2',
        cwd: '/workspace',
        env: {},
        filesystem: {
          readOnlyRoots: ['/usr/bin'],
          readWriteRoots: ['/workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })

      expect(CommandGateway.open).toHaveBeenCalledTimes(1)
      expect(releaseClose).toBeTypeOf('function')
      releaseClose?.()
      await wrapping
      expect(CommandGateway.open).toHaveBeenCalledTimes(2)
    } finally {
      releaseClose?.()
    }
  })

  it('forwards inherited file descriptors to the Linux isolation launcher', async () => {
    await NotebookNetworkRuntime.reset()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)

    await NotebookNetworkRuntime.wrap({
      command: 'node repl_loop.js',
      commandId: 'repl-command',
      cwd: '/workspace',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      inheritedFileDescriptorCount: 1,
      filesystem: {
        readOnlyRoots: ['/usr/bin'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(linuxLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ inheritedFileDescriptorCount: 1 })
    )
  })

  it('uses the gateway port owned by the Windows AppContainer receipt', async () => {
    await NotebookNetworkRuntime.reset()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(readAppContainerStatus).mockResolvedValue({
      profileExists: true,
      loopbackAllowed: true,
      networkFenceReady: true,
      owned: true,
      ownershipState: 'owned',
      gatewayPort: 49700
    })
    await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)

    await NotebookNetworkRuntime.wrap({
      command: 'curl https://example.com',
      commandId: 'windows-command',
      cwd: '/workspace',
      env: {},
      filesystem: {
        readOnlyRoots: ['/runtime'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(CommandGateway.open).toHaveBeenCalledWith(expect.objectContaining({ sharedPort: 49700 }))
  })

  it('uses standard Windows execution when protected mode is not ready', async () => {
    await NotebookNetworkRuntime.reset()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(checkWindowsAppContainer).mockResolvedValue({
      warnings: [],
      errors: ['Notebook AppContainer profile is not installed']
    })
    await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)

    const wrapped = await NotebookNetworkRuntime.wrap({
      command: 'curl https://example.com',
      commandId: 'standard-windows-command',
      cwd: '/workspace',
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(CommandGateway.open).not.toHaveBeenCalledWith(
      expect.objectContaining({ sharedPort: expect.any(Number) })
    )
    expect(windowsStandardLaunch).toHaveBeenCalledOnce()
    expect(windowsSupervisedLaunch).not.toHaveBeenCalled()
    expect(wrapped.confirmProcessTreeTermination).toBeUndefined()
  })

  it('supervises an opted-in Windows process tree when protected mode is not ready', async () => {
    await NotebookNetworkRuntime.reset()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(checkWindowsAppContainer).mockResolvedValue({
      warnings: [],
      errors: ['Notebook AppContainer profile is not installed']
    })
    await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)

    const wrapped = await NotebookNetworkRuntime.wrap({
      command: 'curl https://example.com',
      commandId: 'supervised-windows-command',
      cwd: '/workspace',
      env: {},
      superviseProcessTree: true,
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    expect(windowsSupervisedLaunch).toHaveBeenCalledOnce()
    await expect(wrapped.confirmProcessTreeTermination?.()).resolves.toBe(true)
  })
})

describe('R admission launch protection', () => {
  const request = (windowsProtectionRequired: boolean): NetworkWrapRequest => ({
    command: 'Rscript.exe loop.R',
    executable: 'Rscript.exe',
    args: ['loop.R'],
    commandId: 'r-admission',
    cwd: '/workspace',
    env: {},
    windowsProtectionRequired,
    filesystem: {
      readOnlyRoots: [],
      readWriteRoots: ['/workspace'],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }
  })

  beforeEach(async () => {
    await NotebookNetworkRuntime.reset()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(checkWindowsAppContainer).mockResolvedValue({ warnings: [], errors: [] })
    vi.mocked(readAppContainerStatus).mockResolvedValue({ gatewayPort: 49700 } as Awaited<
      ReturnType<typeof readAppContainerStatus>
    >)
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(true)
    vi.mocked(getWindowsRuntimeAccess).mockResolvedValue({ authorized: true, registered: true })
    await NotebookNetworkRuntime.initialize(config(['example.com']), async () => false)
  })

  it('keeps the authenticated gateway for admitted standard R despite stale protected initialization', async () => {
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
    await NotebookNetworkRuntime.wrap(request(false))
    expect(windowsStandardLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'Rscript.exe',
        gatewayPort: gateway.port,
        gatewayCredentials: { username: 'notebook-r-admission', password: expect.any(String) }
      })
    )
    expect(CommandGateway.open).toHaveBeenCalledWith(
      expect.objectContaining({ decide: expect.any(Function) })
    )
    expect(CommandGateway.open).not.toHaveBeenCalledWith(
      expect.objectContaining({ sharedPort: expect.any(Number) })
    )
    expect(windowsLaunch).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'rejects a changed protection mode after admission (%s)',
    async (required) => {
      vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(!required)
      await expect(NotebookNetworkRuntime.wrap(request(required))).rejects.toThrow(
        'protection changed'
      )
      expect(windowsStandardLaunch).not.toHaveBeenCalled()
      expect(windowsLaunch).not.toHaveBeenCalled()
      expect(CommandGateway.open).not.toHaveBeenCalled()
    }
  )

  it('does not downgrade an admitted protected R launch after the network fence fails', async () => {
    vi.mocked(checkWindowsAppContainer).mockResolvedValue({
      warnings: [],
      errors: ['network fence failed']
    })
    await expect(NotebookNetworkRuntime.wrap(request(true))).rejects.toThrow(
      'protected mode is not ready'
    )
    expect(windowsStandardLaunch).not.toHaveBeenCalled()
    expect(windowsLaunch).not.toHaveBeenCalled()
  })

  it('retains the protected launcher when protection is still ready', async () => {
    await NotebookNetworkRuntime.wrap(request(true))
    expect(windowsLaunch).toHaveBeenCalledOnce()
    expect(windowsStandardLaunch).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'rejects a revoked durable R grant (registered: %s)',
    async (registered) => {
      vi.mocked(getWindowsRuntimeAccess).mockResolvedValue({ authorized: false, registered })
      await expect(
        NotebookNetworkRuntime.wrap({
          ...request(true),
          windowsRuntimeAccessRequired: true
        })
      ).rejects.toThrow('R runtime access changed')
      expect(windowsLaunch).not.toHaveBeenCalled()
      expect(windowsStandardLaunch).not.toHaveBeenCalled()
    }
  )

  it('preserves protected admission proven by OS access without a durable grant', async () => {
    vi.mocked(getWindowsRuntimeAccess).mockResolvedValue({ authorized: false, registered: false })
    await NotebookNetworkRuntime.wrap({ ...request(true), windowsRuntimeAccessRequired: false })
    expect(windowsLaunch).toHaveBeenCalledOnce()
    expect(windowsStandardLaunch).not.toHaveBeenCalled()
  })

  it('rejects setup starting while a standard R gateway is opening', async () => {
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
    vi.mocked(CommandGateway.open).mockImplementationOnce(async () => {
      await installWindows(config(['example.com']))
      return gateway as unknown as Awaited<ReturnType<typeof CommandGateway.open>>
    })
    await expect(NotebookNetworkRuntime.wrap(request(false))).rejects.toThrow('protection changed')
    expect(windowsStandardLaunch).not.toHaveBeenCalled()
    expect(gateway.close).toHaveBeenCalled()
  })

  it.each(['install', 'remove', 'authorize', 'revoke'] as const)(
    'rejects %s after wrapping but before the R process is spawned',
    async (operation) => {
      vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
      const wrapped = await NotebookNetworkRuntime.wrap(request(false))
      if (operation === 'install') await installWindows(config(['example.com']))
      else if (operation === 'remove') await removeWindows(config(['example.com']))
      else
        await setWindowsRuntimeAccess(
          config(['example.com']),
          'Rscript.exe',
          operation === 'authorize'
        )
      expect(() => wrapped.beginSpawn?.()).toThrow('protection changed')
    }
  )

  it('rejects R preparation while a settings mutation is pending', async () => {
    let finish!: (value: { cancelled: boolean }) => void
    vi.mocked(installWindowsAppContainer).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const pending = installWindows(config(['example.com']))
    try {
      await expect(NotebookNetworkRuntime.wrap(request(false))).rejects.toThrow(
        'protection changed'
      )
      expect(windowsStandardLaunch).not.toHaveBeenCalled()
    } finally {
      finish({ cancelled: true })
      await pending
    }
  })

  it('invalidates a prepared launch even if the intervening setup fails', async () => {
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
    const wrapped = await NotebookNetworkRuntime.wrap(request(false))
    vi.mocked(installWindowsAppContainer).mockRejectedValueOnce(new Error('setup failed'))
    await expect(installWindows(config(['example.com']))).rejects.toThrow('setup failed')
    expect(() => wrapped.beginSpawn?.()).toThrow('protection changed')
  })

  it('rejects a cancelled admission immediately before spawn', async () => {
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
    const controller = new AbortController()
    const wrapped = await NotebookNetworkRuntime.wrap({
      ...request(false),
      signal: controller.signal
    })
    controller.abort(new Error('R cancelled'))
    expect(() => wrapped.beginSpawn?.()).toThrow('R cancelled')
  })

  it('rejects pending ownership operations before a standard R launch', async () => {
    vi.mocked(isWindowsProtectionConfigured).mockResolvedValue(false)
    vi.mocked(getWindowsRuntimeAccess).mockRejectedValueOnce(
      new Error('pending protected-mode operation')
    )
    await expect(NotebookNetworkRuntime.wrap(request(false))).rejects.toThrow(
      'pending protected-mode operation'
    )
    expect(windowsStandardLaunch).not.toHaveBeenCalled()
  })
})
