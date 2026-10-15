import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenForDesktop } from './desktop-connection'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../shared/web-rpc-contract'
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each(['unanswered', 'closed'] as const)(
  'bounds the entire stop when shutdown is %s and reports disconnection once',
  async (mode) => {
    const configRoot = await mkdtemp(join(tmpdir(), 'desktop-stop-deadline-'))
    cleanup.push(() => rm(configRoot, { recursive: true, force: true }))
    const shutdown = vi.fn()
    const host = await listenForDesktop('test', (socket) => {
      socket.on('message', (bytes) => {
        const request = JSON.parse(bytes.toString())
        if (request.kind === 'bootstrap')
          socket.send(
            JSON.stringify({
              kind: 'bootstrap',
              pid: process.pid,
              generation: host.endpoint.generation,
              launch: 'desktop',
              control: 'granted',
              entryPath: process.execPath,
              startupOptions: {
                configRoot,
                dataRoot: configRoot,
                profilePath: configRoot,
                port: 0,
                host: '127.0.0.1',
                credentialStore: 'os'
              },
              rpcProtocolVersion: 1,
              rpcChannels: [],
              eventStream: {
                protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
                streamId: randomUUID(),
                latestSequence: 0
              }
            })
          )
        if (request.kind === 'shutdown') {
          shutdown()
          if (mode === 'closed') socket.close()
        }
      })
    })
    cleanup.push(host.close)
    const disconnected = vi.fn()
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      onEvent: vi.fn(),
      onDisconnect: disconnected
    })
    cleanup.push(client.close)
    const start = Date.now()
    const quit = client.quit()
    expect(client.quit()).toBe(quit)
    await expect(quit).rejects.toMatchObject({
      code: 'runtime-stop-timeout',
      evidence: { processExited: false, lockHeld: false }
    })
    expect(Date.now() - start).toBeLessThan(16_000)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
    client.close()
    expect(disconnected).toHaveBeenCalledOnce()
  },
  20_000
)
