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
    const owner: NetworkCommandOwner = { getInfo: vi.fn().mockResolvedValue(info) }

    expect(registerNetworkIpcHandlers(owner)).toBe(owner)
    await expect(invoke('network:get-info')).resolves.toEqual(info)
  })

  it('registers the get-info channel', () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    expect(handlers.has('network:get-info')).toBe(true)
  })

  it('default owner answers from local interface state', async () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    // No Electron app or network access needed: the default owner reads os.networkInterfaces(),
    // so any machine (including CI) answers with the NetworkInfo shape.
    await expect(invoke('network:get-info')).resolves.toMatchObject({
      connectionType: expect.stringMatching(/^(wifi|ethernet|unknown)$/)
    })
  })
})
