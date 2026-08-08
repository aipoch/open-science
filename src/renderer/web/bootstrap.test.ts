// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WEB_RPC_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'

const themeMocks = vi.hoisted(() => ({
  applyTheme: vi.fn(),
  resolveInitialTheme: vi.fn(() => 'light')
}))

vi.mock('@/lib/theme', () => themeMocks)
vi.mock('../src/main', () => ({}))
vi.mock('../../main/remote-access/openscience-logo.svg?raw', () => ({
  default: '<svg viewBox="0 0 1 1"></svg>'
}))

type SocketEventName = 'open' | 'message' | 'close'
type SocketEvent = { data?: unknown }
type SocketListener = (event: SocketEvent) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly listeners = new Map<SocketEventName, Set<SocketListener>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(name: SocketEventName, listener: SocketListener): void {
    const listeners = this.listeners.get(name) ?? new Set<SocketListener>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  emit(name: SocketEventName, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
}

type WebApi = {
  projects: {
    create: (request: unknown) => Promise<unknown>
    onCreated: (listener: (payload: unknown) => void) => () => void
  }
}

const bootstrapPayload = {
  platform: 'test',
  versions: { electron: '1', chrome: '1', node: '1' },
  rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
  rpcChannels: []
}

const loadBootstrap = async (): Promise<WebApi> => {
  await import('./bootstrap')
  return (window as unknown as { api: WebApi }).api
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
  sessionStorage.clear()
  sessionStorage.setItem('open-science-web-client', 'web-client-1')
  delete (window as unknown as { api?: unknown }).api
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/bootstrap') throw new Error(`Unexpected fetch: ${String(input)}`)
      return new Response(JSON.stringify(bootstrapPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('Web bootstrap event connection', () => {
  it('reconstructs Application Command errors returned by Web RPC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/bootstrap') {
          return new Response(
            JSON.stringify({ ...bootstrapPayload, rpcChannels: ['projects:create'] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (String(input) === '/rpc/projects%3Acreate') {
          return new Response(
            JSON.stringify({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: false,
              error: {
                code: 'invalid-command-arguments',
                message: 'Invalid project request.'
              }
            }),
            { status: 500, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error(`Unexpected fetch: ${String(input)}`)
      })
    )

    const api = await loadBootstrap()
    await expect(api.projects.create({ name: 42 })).rejects.toMatchObject({
      name: 'ApplicationCommandError',
      code: 'invalid-command-arguments',
      message: 'Invalid project request.'
    })
  })

  it('opens the initial event socket with the stable Web client id', async () => {
    await loadBootstrap()

    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([
      `ws://${location.host}/events?client=web-client-1`
    ])
  })

  it('reconnects with exponential backoff after consecutive closes', async () => {
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1].emit('close')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('resets reconnect backoff after a socket opens', async () => {
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('open')
    FakeWebSocket.instances[1].emit('close')

    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('signals stores to refresh whenever the event socket opens', async () => {
    const listener = vi.fn()
    window.addEventListener('open-science:web-events-open', listener)
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('open')
    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('open')

    expect(listener).toHaveBeenCalledTimes(2)
    window.removeEventListener('open-science:web-events-open', listener)
  })

  it('keeps existing event subscriptions active after reconnecting', async () => {
    const api = await loadBootstrap()
    const listener = vi.fn()
    const unsubscribe = api.projects.onCreated(listener)

    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('message', {
      data: JSON.stringify({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        channel: 'project:created',
        payload: { id: 'project-1' }
      })
    })

    expect(listener).toHaveBeenCalledWith({ id: 'project-1' })
    unsubscribe()
  })
})
