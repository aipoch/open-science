import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gateway = vi.hoisted(() => ({
  port: 4312,
  updateParentProxy: vi.fn(),
  resetConnections: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined)
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

vi.mock('../runtime/src/platform/windows-appcontainer.js', () => ({
  windowsLaunch: vi.fn(({ env }) => ({ argv: ['sandboxed.exe'], env })),
  windowsStandardLaunch: vi.fn(({ env }) => ({ argv: ['powershell.exe'], env })),
  checkWindowsAppContainer: vi.fn().mockResolvedValue({ warnings: [], errors: [] }),
  readAppContainerStatus: vi.fn().mockResolvedValue({ gatewayPort: 49700 }),
  installWindowsAppContainer: vi.fn(),
  removeWindowsAppContainer: vi.fn()
}))

import {
  NotebookNetworkRuntime,
  type NetworkRuntimeConfig
} from '../runtime/src/notebook-runtime.js'
import { CommandGateway } from '../runtime/src/gateway/command-gateway.js'
import { linuxLaunch } from '../runtime/src/platform/linux-isolation.js'
import { readAppContainerStatus } from '../runtime/src/platform/windows-appcontainer.js'
import {
  checkWindowsAppContainer,
  windowsStandardLaunch
} from '../runtime/src/platform/windows-appcontainer.js'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

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
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('Notebook runtime configuration updates', () => {
  it('disconnects existing tunnels before they can outlive a policy change', () => {
    NotebookNetworkRuntime.updateConfig(config([]))

    expect(gateway.updateParentProxy).toHaveBeenCalledWith(undefined)
    expect(gateway.resetConnections).toHaveBeenCalledOnce()
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
      NotebookNetworkRuntime.cleanupAfterCommand('command-1')
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

    await NotebookNetworkRuntime.wrap({
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
  })
})
