import { afterEach, expect, it, vi } from 'vitest'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { createNodeRuntimeNetwork } from './runtime-network-node'
type Callback = (error: Error | null, socket: Socket | null) => void
type Connector = (options: unknown, callback: Callback) => Socket | undefined
const fixture = vi.hoisted(() => ({
  direct: vi.fn<Connector>(),
  delivered: [] as Socket[],
  connect: undefined as Connector | undefined
}))
vi.mock('undici', () => ({
  buildConnector: () => fixture.direct,
  Agent: class {
    constructor(options: { connect: Connector }) {
      fixture.connect = options.connect
    }
    async destroy(): Promise<void> {
      await Promise.all(
        fixture.delivered.splice(0).map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once('close', resolve)
              socket.destroy()
            })
        )
      )
    }
    async close(): Promise<void> {
      return undefined
    }
  },
  fetch: async () =>
    new Promise<Response>((resolve, reject) => {
      fixture.connect!(
        { protocol: 'https:', hostname: '127.0.0.1', port: '443' },
        (error, socket) => {
          if (error) reject(error)
          else {
            if (socket) fixture.delivered.push(socket)
            resolve(new Response('ok'))
          }
        }
      )
    })
}))
const networks: ReturnType<typeof createNodeRuntimeNetwork>[] = []
afterEach(async () => {
  for (const network of networks.splice(0)) await network.close()
  vi.clearAllMocks()
})
function network(): ReturnType<typeof createNodeRuntimeNetwork> {
  const owner = createNodeRuntimeNetwork({})
  networks.push(owner)
  return owner
}
it('tracks a synchronous successful callback before the connector returns its socket', async () => {
  const socket = new Socket().on('error', () => undefined)
  fixture.direct.mockImplementation((_options, callback) => {
    callback(null, socket)
    return socket
  })
  const owner = network()
  await owner.fetch('https://127.0.0.1')
  await owner.close()
  expect(socket.closed).toBe(true)
})
it.each([false, true])(
  'does not await an already closed event when callback errors (closed=%s)',
  async (alreadyClosed) => {
    const socket = new Socket().on('error', () => undefined)
    if (alreadyClosed) {
      const closed = once(socket, 'close')
      socket.destroy()
      await closed
    }
    fixture.direct.mockImplementation((_options, callback) => {
      if (!alreadyClosed) socket.destroy()
      callback(new Error('fixture connect failed'), null)
      return socket
    })
    const owner = network()
    await expect(owner.fetch('https://127.0.0.1')).rejects.toThrow('fixture connect failed')
    await owner.close()
    expect(socket.closed).toBe(true)
  }
)
it('settles a closed connector without its callback and rejects a late success', async () => {
  const socket = new Socket().on('error', () => undefined)
  let finish!: Callback
  fixture.direct.mockImplementation((_options, callback) => {
    finish = callback
    return socket
  })
  const owner = network()
  const request = owner.fetch('https://127.0.0.1').catch((error: Error) => error)
  let completed = false
  const closing = owner.close().then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(socket.closed).toBe(true)
  expect(completed).toBe(true)
  finish(null, socket)
  await closing
  expect(await request).toMatchObject({ message: 'Connection closed before it was established.' })
  expect(socket.destroyed).toBe(true)
})
it('settles its connector fence when connector construction throws', async () => {
  fixture.direct.mockImplementation(() => {
    throw new Error('fixture construction failed')
  })
  const owner = network()
  await expect(owner.fetch('https://127.0.0.1')).rejects.toThrow('fixture construction failed')
  await owner.close()
})
