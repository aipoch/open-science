import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { CommandGatewayOptions } from '../runtime/src/gateway/command-gateway.js'
import type { NetworkRuntimeConfig } from '../runtime/src/notebook-runtime.js'

// Exercise the real runtime/context lifecycle, DestinationPolicy and ViolationLog.
// Only DNS completion, certificate availability and OS/socket construction are controlled.
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  open: vi.fn(),
  ca: vi.fn(),
  bundle: vi.fn(),
  launch: vi.fn(),
  close: vi.fn(async () => {}),
  resetConnections: vi.fn(),
  updateParentProxy: vi.fn()
}))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('../runtime/src/gateway/command-gateway.js', () => ({
  CommandGateway: { open: mocks.open }
}))
vi.mock('../runtime/src/gateway/local-ca.js', () => ({
  createLocalCertificateAuthority: mocks.ca,
  createClientTrustBundle: mocks.bundle,
  clientTrustEnvironment: () => ({})
}))
vi.mock('../runtime/src/platform/macos-isolation.js', () => ({
  macosLaunch: mocks.launch
}))
vi.mock('../runtime/src/platform/linux-isolation.js', () => ({
  checkLinuxTools: vi.fn(),
  linuxLaunch: mocks.launch
}))
vi.mock('../runtime/src/platform/windows-appcontainer.js', () => ({
  checkWindowsAppContainer: async () => ({ errors: ['fixture standard mode'], warnings: [] }),
  windowsStandardLaunch: mocks.launch,
  windowsLaunch: vi.fn(),
  readAppContainerStatus: vi.fn(),
  installWindowsAppContainer: vi.fn(),
  removeWindowsAppContainer: vi.fn(),
  setWindowsRuntimeAccess: vi.fn()
}))

import { NotebookNetworkRuntime as runtime } from '../runtime/src/notebook-runtime.js'

const config: NetworkRuntimeConfig = {
  allowedDomains: ['approved.example'],
  askDomains: ['explicit.example'],
  deniedDomains: ['forbidden.example'],
  installationId: 'public-read-test',
  windowsHostPath: '',
  windowsOwnershipRoot: ''
}
const commandId = 'public-read-command'
const approval = vi.fn(async () => false)
let gateway: CommandGatewayOptions

const wrap = async (): Promise<void> => {
  await runtime.wrap({
    commandId,
    command: 'fixture',
    cwd: process.cwd(),
    env: {},
    filesystem: {
      readOnlyRoots: [],
      readWriteRoots: [],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }
  })
  runtime.setCommandExecutionActive(commandId, true)
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.launch.mockImplementation(({ env }: { env: NodeJS.ProcessEnv }) => ({
    argv: ['fixture'],
    env
  }))
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  mocks.ca.mockResolvedValue({
    certificatePem: 'fixture certificate',
    getSecureContext: vi.fn(),
    dispose: vi.fn()
  })
  mocks.bundle.mockResolvedValue({
    path: resolve('fixture-ca.pem'),
    cleanup: vi.fn(async () => {})
  })
  mocks.open.mockImplementation(async (options: CommandGatewayOptions) => {
    gateway = options
    return {
      port: 12345,
      close: mocks.close,
      resetConnections: mocks.resetConnections,
      updateParentProxy: mocks.updateParentProxy
    }
  })
  approval.mockResolvedValue(false)
  await runtime.initialize(config, approval)
})

afterEach(async () => {
  await runtime.reset()
})

describe('public-read runtime decision lifecycle', () => {
  it('closes networking and retains failed preparation cleanup for retry', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('certificate removal failed'))
      .mockResolvedValue(undefined)
    mocks.bundle.mockResolvedValueOnce({ path: resolve('fixture-ca.pem'), cleanup })
    mocks.launch.mockImplementationOnce(() => {
      throw new Error('launch preparation failed')
    })

    await expect(wrap()).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(gateway.inspection?.isExecutionActive()).toBe(false)
    await expect(
      runtime.cleanupAfterCommand(commandId, 'spawn-failed', { processesTerminated: true })
    ).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it.each(['endExecution', 'updateConfig', 'cleanup'] as const)(
    '%s invalidates an outstanding DNS lookup before it can request approval or log a block',
    async (transition) => {
      await wrap()
      let complete!: (answers: Array<{ address: string; family: number }>) => void
      mocks.lookup.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
      const decision = gateway.decide('unknown.example', 443, 'block')
      expect(mocks.lookup).toHaveBeenCalledWith('unknown.example', { all: true, verbatim: true })
      if (transition === 'endExecution') runtime.setCommandExecutionActive(commandId, false)
      else if (transition === 'updateConfig') runtime.updateConfig(config)
      else await runtime.cleanupAfterCommand(commandId, 'exit', { processesTerminated: true })
      complete([{ address: '8.8.8.8', family: 4 }])

      await expect(decision).resolves.toEqual({
        allowed: false,
        message: expect.stringContaining('Execution context expired')
      })
      expect(approval).not.toHaveBeenCalled()
      expect(runtime.annotateStderr(commandId, '')).toBe('')
    }
  )

  it('keeps an old lookup expired even after the next execution begins', async () => {
    await wrap()
    let complete!: (answers: Array<{ address: string; family: number }>) => void
    mocks.lookup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const old = gateway.decide('unknown.example', 443, 'block')
    runtime.setCommandExecutionActive(commandId, false)
    runtime.setCommandExecutionActive(commandId, true)
    complete([{ address: '8.8.8.8', family: 4 }])
    await expect(old).resolves.toMatchObject({ allowed: false })
    expect(approval).not.toHaveBeenCalled()
    expect(runtime.annotateStderr(commandId, '')).toBe('')
    await expect(gateway.decide('approved.example', 443, 'probe')).resolves.toEqual({
      allowed: true,
      address: '8.8.8.8'
    })
  })

  it('queries unknown permission without recording a failed command until actually blocked', async () => {
    await wrap()
    await expect(gateway.decide('unknown.example', 443, 'probe')).resolves.toEqual({
      allowed: false,
      source: 'unknown',
      address: '8.8.8.8'
    })
    expect(approval).toHaveBeenLastCalledWith({
      host: 'unknown.example',
      port: 443,
      commandId,
      purpose: 'probe'
    })
    expect(runtime.annotateStderr(commandId, '')).toBe('')
    await expect(gateway.decide('unknown.example', 443, 'block')).resolves.toMatchObject({
      allowed: false,
      message: expect.stringContaining('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    })
    expect(approval).toHaveBeenLastCalledWith({
      host: 'unknown.example',
      port: 443,
      commandId,
      purpose: 'block'
    })
    expect(runtime.annotateStderr(commandId, '')).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
  })

  it('does not turn forbidden destinations into approvable blocks', async () => {
    await wrap()
    await expect(gateway.decide('forbidden.example', 443, 'probe')).resolves.toMatchObject({
      allowed: false,
      message: expect.stringContaining('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
    })
    expect(approval).not.toHaveBeenCalled()
    expect(runtime.annotateStderr(commandId, '')).not.toContain(
      'OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED'
    )
  })

  it('discards an approval result arriving after the execution ended', async () => {
    await wrap()
    let complete!: (allowed: boolean) => void
    approval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const pending = gateway.decide('unknown.example', 443, 'block')
    await vi.waitFor(() => expect(approval).toHaveBeenCalledTimes(1))
    runtime.setCommandExecutionActive(commandId, false)
    complete(true)
    await expect(pending).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining('Execution context expired')
    })
    expect(runtime.annotateStderr(commandId, '')).toBe('')
  })

  it('preserves target permissions and ordinary approval when CA initialization fails', async () => {
    mocks.ca.mockRejectedValueOnce(new Error('certificate initialization unavailable'))
    await wrap()
    expect(gateway.inspection).toBeUndefined()
    expect(mocks.bundle).not.toHaveBeenCalled()
    await expect(gateway.decide('approved.example', 443)).resolves.toEqual({
      allowed: true,
      address: '8.8.8.8'
    })
    expect(approval).not.toHaveBeenCalled()
    await expect(gateway.decide('unknown.example', 443, 'block')).resolves.toMatchObject({
      allowed: false,
      message: expect.stringContaining('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    })
    expect(approval).toHaveBeenCalledWith({
      host: 'unknown.example',
      port: 443,
      commandId,
      purpose: 'block'
    })
    expect(runtime.annotateStderr(commandId, '')).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    approval.mockResolvedValueOnce(true)
    await expect(gateway.decide('unknown.example', 443, 'block')).resolves.toEqual({
      allowed: true,
      address: '8.8.8.8'
    })
  })
})
