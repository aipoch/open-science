import { describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so the handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const { registerNetworkIpcHandlers } = await import('./network-ipc')
type NetworkCommandOwner = import('./network-ipc').NetworkCommandOwner

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

describe('network IPC handler', () => {
  it('delegates to an injected owner instance', async () => {
    handlers.clear()
    const info = { connectionType: 'wifi', ipAddress: '192.168.1.42' } as const
    const owner: NetworkCommandOwner = {
      getInfo: vi.fn().mockResolvedValue(info),
      checkConnectivity: vi.fn().mockResolvedValue(false)
    }

    expect(registerNetworkIpcHandlers(owner)).toBe(owner)
    await expect(invoke('network:get-info')).resolves.toEqual(info)
    await expect(invoke('network:check-connectivity')).resolves.toBe(false)
  })

  it('registers both network channels', () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    expect(handlers.has('network:get-info')).toBe(true)
    expect(handlers.has('network:check-connectivity')).toBe(true)
  })

  it('default owner answers from local interface state', async () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    // No Electron app or network access needed: the default owner reads os.networkInterfaces(),
    // so any machine (including CI) answers with the NetworkInfo shape. checkConnectivity is
    // deliberately not invoked here — the default owner would issue real HTTPS probes.
    await expect(invoke('network:get-info')).resolves.toMatchObject({
      connectionType: expect.stringMatching(/^(wifi|ethernet|unknown)$/)
    })
  })
})
