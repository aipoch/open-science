// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_PROTOCOL_VERSION
} from '../../shared/web-rpc-contract'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENTS_OPEN_EVENT
} from '../../shared/web-event-connection'

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

  close(): void {
    this.emit('close')
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
  eventStream: {
    protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
    streamId: 'stream-1',
    latestSequence: 0
  },
  platform: 'test',
  versions: { electron: '1', chrome: '1', node: '1' },
  rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
  rpcChannels: []
}

const eventFrame = (sequence: number, channel: string, payload: unknown): string =>
  JSON.stringify({
    kind: 'event',
    protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
    streamId: 'stream-1',
    sequence,
    channel,
    payload
  })

const readyFrame = (latestSequence: number): string =>
  JSON.stringify({
    kind: 'ready',
    protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
    streamId: 'stream-1',
    latestSequence
  })

const loadBootstrap = async (): Promise<WebApi> => {
  const bootstrapImport = import('./bootstrap')
  await vi.waitFor(() => expect((window as unknown as { api?: WebApi }).api).toBeDefined())
  window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
  await bootstrapImport
  return (window as unknown as { api: WebApi }).api
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
  document.body.innerHTML = `
    <div id=open-science-connection-state role=status>
      <div class=open-science-connection-panel>
        <span id=open-science-connection-logo></span>
        <p id=open-science-connection-message>Connecting to remote computer…</p>
      </div>
    </div>
  `
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
  localStorage.clear()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('Web bootstrap event connection', () => {
  // Bootstrap owns this pre-React connection surface, so its copy must use the initialized i18n.
  it('localizes the initial connection message with the initialized locale', async () => {
    localStorage.setItem('open-science-language', 'zh-Hans')

    const bootstrapImport = import('./bootstrap')
    await vi.waitFor(() => expect((window as unknown as { api?: WebApi }).api).toBeDefined())

    expect(document.getElementById('open-science-connection-message')?.textContent).toBe(
      '正在连接远程计算机…'
    )
    window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
    await bootstrapImport
  })

  it('localizes bootstrap reconnect progress with the initialized locale', async () => {
    localStorage.setItem('open-science-language', 'zh-Hans')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(
        new Response(JSON.stringify(bootstrapPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const bootstrapImport = import('./bootstrap')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(document.getElementById('open-science-connection-message')?.textContent).toBe(
        '正在重新连接远程计算机…（2/8）'
      )
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect((window as unknown as { api?: WebApi }).api).toBeDefined())
    window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
    await bootstrapImport
  })

  it('localizes bootstrap failure and retry controls with the initialized locale', async () => {
    localStorage.setItem('open-science-language', 'zh-Hans')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    )

    await import('./bootstrap')

    expect(document.getElementById('open-science-connection-state')?.getAttribute('role')).toBe(
      'alert'
    )
    expect(document.getElementById('open-science-connection-message')?.textContent).toBe(
      '主电脑上的远程访问已关闭。请在 Open Science 中重新启用远程访问模式，然后重试。'
    )
    expect(document.querySelector('button')?.textContent).toBe('重试')
  })

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

  it('waits for renderer consumers before opening the event stream', async () => {
    const bootstrapImport = import('./bootstrap')
    await vi.waitFor(() => expect((window as unknown as { api?: WebApi }).api).toBeDefined())

    expect(FakeWebSocket.instances).toHaveLength(0)
    window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
    await bootstrapImport
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('opens the initial event socket with the stable Web client id', async () => {
    await loadBootstrap()

    const url = new URL(FakeWebSocket.instances[0].url)
    expect(url.pathname).toBe('/events')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: 'web-client-1',
      eventProtocol: String(WEB_EVENT_STREAM_PROTOCOL_VERSION),
      stream: 'stream-1',
      after: '0'
    })
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

  it('resets reconnect backoff after a socket becomes ready', async () => {
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('open')
    FakeWebSocket.instances[1].emit('message', { data: readyFrame(0) })
    FakeWebSocket.instances[1].emit('close')

    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('stops reconnecting and requests a reload after eight consecutive closes', async () => {
    const phases: string[] = []
    const stateListener = (event: Event): void => {
      phases.push((event as CustomEvent<{ phase: string }>).detail.phase)
    }
    window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, stateListener)
    await loadBootstrap()

    const reconnectDelays = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]
    for (const delay of reconnectDelays) {
      FakeWebSocket.instances.at(-1)?.emit('close')
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(FakeWebSocket.instances).toHaveLength(8)

    FakeWebSocket.instances.at(-1)?.emit('close')
    await vi.advanceTimersByTimeAsync(20_000)

    expect(phases.at(-1)).toBe('reload-required')
    expect(FakeWebSocket.instances).toHaveLength(8)
    window.removeEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, stateListener)
  })

  it('signals stores to refresh only after replay reaches the live cursor', async () => {
    const listener = vi.fn()
    window.addEventListener(WEB_EVENTS_OPEN_EVENT, listener)
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('open')
    expect(listener).not.toHaveBeenCalled()
    FakeWebSocket.instances[0].emit('message', { data: readyFrame(0) })
    expect(listener).toHaveBeenCalledTimes(1)
    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('open')
    expect(listener).toHaveBeenCalledTimes(1)
    FakeWebSocket.instances[1].emit('message', { data: readyFrame(0) })
    expect(listener).toHaveBeenCalledTimes(2)
    window.removeEventListener(WEB_EVENTS_OPEN_EVENT, listener)
  })

  it('keeps existing event subscriptions active after reconnecting', async () => {
    const api = await loadBootstrap()
    const listener = vi.fn()
    const unsubscribe = api.projects.onCreated(listener)

    FakeWebSocket.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWebSocket.instances[1].emit('message', {
      data: eventFrame(1, 'project:created', { id: 'project-1' })
    })

    expect(listener).toHaveBeenCalledWith({ id: 'project-1' })
    unsubscribe()
    FakeWebSocket.instances[1].emit('message', { data: readyFrame(1) })
    FakeWebSocket.instances[1].emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(new URL(FakeWebSocket.instances[2].url).searchParams.get('after')).toBe('1')
  })

  it('stops reconnecting and requests a reload when replay cannot satisfy the cursor', async () => {
    const phases: string[] = []
    const stateListener = (event: Event): void => {
      phases.push((event as CustomEvent<{ phase: string }>).detail.phase)
    }
    window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, stateListener)
    await loadBootstrap()

    FakeWebSocket.instances[0].emit('open')
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        kind: 'resync-required',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        latestSequence: 4,
        reason: 'cursor-expired'
      })
    })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(phases).toContain('reload-required')
    expect(FakeWebSocket.instances).toHaveLength(1)
    window.removeEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, stateListener)
  })
})
