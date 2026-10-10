import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { connect } from 'node:net'
import { stat } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { connectToDesktopEndpoint, listenForDesktop } from './desktop-connection'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

describe('private desktop process attachment', () => {
  it('uses an authenticated OS socket, permits one desktop and accepts a later reconnection', async () => {
    const attach = vi.fn((socket: WebSocket) => {
      socket.on('message', (bytes) => socket.send(bytes))
    })
    const host = await listenForDesktop('0.35.1', attach)
    cleanups.push(host.close)
    const client = await connectToDesktopEndpoint(host.endpoint)
    expect(attach).toHaveBeenCalledTimes(1)
    const reply = once(client, 'message')
    client.send('request')
    expect(String((await reply)[0])).toBe('request')
    await expect(connectToDesktopEndpoint(host.endpoint)).rejects.toThrow('409')
    const detached = once(attach.mock.calls[0][0], 'close')
    client.terminate()
    await detached
    const second = await connectToDesktopEndpoint(host.endpoint)
    expect(attach).toHaveBeenCalledTimes(2)
    second.terminate()
  })

  it.each(['secret', 'generation', 'version'] as const)(
    'rejects a mismatched %s before exposing the native attachment',
    async (field) => {
      const attach = vi.fn()
      const host = await listenForDesktop('0.35.1', attach)
      cleanups.push(host.close)
      await expect(
        connectToDesktopEndpoint({ ...host.endpoint, [field]: 'wrong' })
      ).rejects.toThrow('403')
      expect(attach).not.toHaveBeenCalled()
    }
  )

  it('rejects browser-origin handshakes even with a known desktop credential', async () => {
    const attach = vi.fn()
    const host = await listenForDesktop('0.35.1', attach)
    cleanups.push(host.close)
    const socket = new WebSocket('ws://localhost/desktop', {
      createConnection: () => connect(host.endpoint.path),
      headers: {
        origin: 'http://localhost:44100',
        authorization: `Bearer ${host.endpoint.secret}`,
        'x-open-science-generation': host.endpoint.generation,
        'x-open-science-version': host.endpoint.version
      }
    })
    const [error] = await once(socket, 'error')
    expect(error.message).toContain('403')
    expect(attach).not.toHaveBeenCalled()
  })

  it('closes attached sockets and removes only its own private endpoint on shutdown', async () => {
    const host = await listenForDesktop('0.35.1', () => undefined)
    cleanups.push(host.close)
    const client = await connectToDesktopEndpoint(host.endpoint)
    if (process.platform !== 'win32') {
      expect((await stat(host.endpoint.path)).mode & 0o777).toBe(0o600)
    }
    const closed = once(client, 'close')
    await host.close()
    await closed
    await host.close()
    if (process.platform !== 'win32') await expect(stat(host.endpoint.path)).rejects.toThrow()
    await expect(connectToDesktopEndpoint(host.endpoint)).rejects.toThrow()
  })
})
