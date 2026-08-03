import { describe, expect, it, vi, type Mock } from 'vitest'

import { createElectronRendererContractAdapter } from './electron-renderer-contract-adapter'

type MockPort = Readonly<{
  invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  on: Mock<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>
  removeListener: Mock<
    (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  >
}>

const createPort = (): MockPort => ({
  invoke: vi
    .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue(undefined),
  on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
  removeListener:
    vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>()
})

describe('electron renderer contract adapter', () => {
  it('resolves ACP session requests and supplies their default empty objects', async () => {
    const result = { status: 'connected' }
    const port = createPort()
    port.invoke.mockResolvedValue(result)
    const adapter = createElectronRendererContractAdapter(port)

    await expect(adapter.invoke('acp.connect')).resolves.toBe(result)
    await adapter.invoke('acp.connect', undefined)
    await adapter.invoke('acp.createSession')
    await adapter.invoke('acp.createSession', undefined)

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'acp:connect', {})
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'acp:connect', {})
    expect(port.invoke).toHaveBeenNthCalledWith(3, 'acp:create-session', {})
    expect(port.invoke).toHaveBeenNthCalledWith(4, 'acp:create-session', {})
  })

  it('preserves the optional notebook cancellation argument slot', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('notebookEnv.cancel')
    await adapter.invoke('notebookEnv.cancel', undefined)

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'notebook-env:cancel', undefined)
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'notebook-env:cancel', undefined)
  })

  it('encodes Electron runtime deviations without leaking them into preload callers', async () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)

    await adapter.invoke('runtime.setSelection', 'python', { kind: 'managed' })
    await adapter.invoke('runtime.listPackages', 'python', 'science')
    await adapter.invoke('runtime.getEnablement', 'r')
    await adapter.invoke('runtime.setEnvironmentEnabled', 'r', 'renv', true, false)
    await adapter.invoke('runtime.setInstallAuthorized', 'python', 'science', true)
    await adapter.invoke('runtime.registerInterpreter', 'python', '/usr/bin/python3')

    expect(port.invoke).toHaveBeenNthCalledWith(1, 'runtime:set-selection', {
      language: 'python',
      selection: { kind: 'managed' }
    })
    expect(port.invoke).toHaveBeenNthCalledWith(2, 'runtime:list-packages', {
      language: 'python',
      envId: 'science'
    })
    expect(port.invoke).toHaveBeenNthCalledWith(3, 'runtime:get-enablement', {
      language: 'r'
    })
    expect(port.invoke).toHaveBeenNthCalledWith(4, 'runtime:set-environment-enabled', {
      language: 'r',
      envId: 'renv',
      enabled: true,
      force: false
    })
    expect(port.invoke).toHaveBeenNthCalledWith(5, 'runtime:set-install-authorized', {
      language: 'python',
      envId: 'science',
      authorized: true
    })
    expect(port.invoke).toHaveBeenNthCalledWith(6, 'runtime:register-interpreter', {
      language: 'python',
      path: '/usr/bin/python3'
    })
  })

  it('strips Electron events and removes the exact wrapped listener on unsubscribe', () => {
    const port = createPort()
    const adapter = createElectronRendererContractAdapter(port)
    const listener = vi.fn()

    const unsubscribe = adapter.subscribe('specialist.onPendingSwitch', listener)
    const wrappedListener = port.on.mock.calls[0]?.[1]
    const payload = { specialistId: 'specialist-1' }

    wrappedListener?.({ sender: 'electron' }, payload)
    unsubscribe()

    expect(port.on).toHaveBeenCalledWith('specialist:pending-switch', wrappedListener)
    expect(listener).toHaveBeenCalledWith(payload)
    expect(port.removeListener).toHaveBeenCalledWith('specialist:pending-switch', wrappedListener)
  })
})
