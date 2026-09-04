// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_CAPABILITY_UPDATE_CLI_V1,
  WEB_RPC_PROTOCOL_VERSION
} from '../../shared/web-rpc-contract'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../shared/web-caller-location'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENTS_OPEN_EVENT
} from '../../shared/web-event-connection'
import type { SaveManagedFileRequest } from '../../shared/file-save'

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
  closed = false

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(name: SocketEventName, listener: SocketListener): void {
    const listeners = this.listeners.get(name) ?? new Set<SocketListener>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  emit(name: SocketEventName, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
}

type WebApi = {
  notebook: {
    execute: (request: unknown) => Promise<unknown>
  }
  projects: {
    create: (request: unknown) => Promise<unknown>
    onCreated: (listener: (payload: unknown) => void) => () => void
  }
  saveManagedFile: (request: SaveManagedFileRequest) => Promise<{ saved: boolean }>
}

const bootstrapPayload = {
  eventStream: {
    protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
    streamId: 'stream-1',
    latestSequence: 0
  },
  platform: 'test',
  webCallerLocation: 'local',
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

const heartbeatFrame = (latestSequence: number): string =>
  JSON.stringify({
    kind: 'heartbeat',
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
  document.documentElement.removeAttribute('data-open-science-notebook-network-unavailable')
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
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
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
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
  it('records the caller location returned by bootstrap', async () => {
    await loadBootstrap()

    expect(document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)).toBe('local')
  })

  it('recognizes an older local protocol-v1 Main from its local-only capability', async () => {
    const olderBootstrap = { ...bootstrapPayload, webCallerLocation: undefined }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...olderBootstrap,
              rpcCapabilities: [WEB_RPC_CAPABILITY_UPDATE_CLI_V1]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await loadBootstrap()

    expect(document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)).toBe('local')
  })

  it('marks Notebook network settings unavailable when the RPC is remote-restricted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...bootstrapPayload,
              restrictedRpcChannels: ['settings:get-notebook-network-status']
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await loadBootstrap()

    expect(
      document.documentElement.hasAttribute('data-open-science-notebook-network-unavailable')
    ).toBe(true)
  })

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
            { status: 400, headers: { 'content-type': 'application/json' } }
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

  it('settles a Web RPC when the remote response stops making progress', async () => {
    let rpcSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/bootstrap') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ...bootstrapPayload, rpcChannels: ['projects:create'] }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (String(input) === '/rpc/projects%3Acreate') {
          rpcSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            rpcSignal?.addEventListener(
              'abort',
              () => reject(rpcSignal?.reason ?? new DOMException('Request aborted', 'AbortError')),
              { once: true }
            )
          })
        }
        throw new Error(`Unexpected fetch: ${String(input)}`)
      })
    )

    const api = await loadBootstrap()
    const request = api.projects.create({ name: 'Never finishes' })
    const outcome = Promise.race([
      request.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      new Promise<'still-pending'>((resolve) =>
        window.setTimeout(() => resolve('still-pending'), 30_001)
      )
    ])

    await vi.advanceTimersByTimeAsync(30_001)

    await expect(outcome).resolves.toBe('rejected')
    expect(rpcSignal?.aborted).toBe(true)
  })

  it('lets a long Notebook execution finish under its own deadline', async () => {
    let rpcSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/bootstrap') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ...bootstrapPayload, rpcChannels: ['notebook:execute'] }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (String(input) === '/rpc/notebook%3Aexecute') {
          rpcSignal = init?.signal ?? undefined
          return new Promise<Response>((resolve, reject) => {
            const timeout = window.setTimeout(
              () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                      ok: true,
                      result: { runId: 'run-1', status: 'completed' }
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                  )
                ),
              60_000
            )
            rpcSignal?.addEventListener(
              'abort',
              () => {
                window.clearTimeout(timeout)
                reject(rpcSignal?.reason ?? new DOMException('Request aborted', 'AbortError'))
              },
              { once: true }
            )
          })
        }
        throw new Error(`Unexpected fetch: ${String(input)}`)
      })
    )

    const api = await loadBootstrap()
    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: readyFrame(0) })
    const request = api.notebook.execute({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'long_running_analysis()'
    })
    let settled = false
    void request.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(20_000)
    socket.emit('message', { data: heartbeatFrame(0) })
    await vi.advanceTimersByTimeAsync(10_001)

    expect(settled).toBe(false)
    expect(rpcSignal?.aborted ?? false).toBe(false)

    await vi.advanceTimersByTimeAsync(9_999)
    socket.emit('message', { data: heartbeatFrame(0) })
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(request).resolves.toEqual({ runId: 'run-1', status: 'completed' })
  })

  it('aborts a long Notebook request when its event connection disconnects', async () => {
    let rpcSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/bootstrap') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ...bootstrapPayload, rpcChannels: ['notebook:execute'] }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (String(input) === '/rpc/notebook%3Aexecute') {
          rpcSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            rpcSignal?.addEventListener(
              'abort',
              () => reject(rpcSignal?.reason ?? new DOMException('Request aborted', 'AbortError')),
              { once: true }
            )
          })
        }
        throw new Error(`Unexpected fetch: ${String(input)}`)
      })
    )

    const api = await loadBootstrap()
    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: readyFrame(0) })
    const request = api.notebook.execute({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'long_running_analysis()'
    })
    let outcome: unknown = 'still-pending'
    void request.then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )

    socket.emit('close')
    expect(rpcSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(DOMException))
  })

  it('does not abort an ordinary mutation when its event connection disconnects', async () => {
    let rpcSignal: AbortSignal | undefined
    let resolveRpc!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/bootstrap') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ...bootstrapPayload, rpcChannels: ['projects:create'] }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (String(input) === '/rpc/projects%3Acreate') {
          rpcSignal = init?.signal ?? undefined
          return new Promise<Response>((resolve, reject) => {
            resolveRpc = resolve
            rpcSignal?.addEventListener(
              'abort',
              () => reject(rpcSignal?.reason ?? new DOMException('Request aborted', 'AbortError')),
              { once: true }
            )
          })
        }
        throw new Error(`Unexpected fetch: ${String(input)}`)
      })
    )

    const api = await loadBootstrap()
    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: readyFrame(0) })
    const request = api.projects.create({ name: 'Committed once' })

    socket.emit('close')

    expect(rpcSignal?.aborted).toBe(false)
    resolveRpc(
      new Response(
        JSON.stringify({
          protocolVersion: WEB_RPC_PROTOCOL_VERSION,
          ok: true,
          result: { id: 'project-1', name: 'Committed once' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(request).resolves.toMatchObject({ id: 'project-1' })
  })

  it('streams a managed file to the browser-selected destination without buffering a Blob', async () => {
    const savedBytes: number[] = []
    const createWritable = vi.fn().mockResolvedValue(
      new WritableStream<Uint8Array>({
        write: (chunk) => {
          savedBytes.push(...chunk)
        }
      })
    )
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable })
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker)
    const resourceResponse = new Response(new Uint8Array([1, 2, 3]))
    const blob = vi.spyOn(resourceResponse, 'blob')
    let released = false
    let acquireRequest: unknown
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/bootstrap') {
          return new Response(JSON.stringify(bootstrapPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url === '/rpc/preview-resources%3Aacquire') {
          acquireRequest = JSON.parse(String(init?.body))
          return new Response(
            JSON.stringify({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: true,
              result: { id: 'resource-1', url: '/preview/resource-1', size: 3 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url === '/preview/resource-1') return resourceResponse
        if (url === '/rpc/preview-resources%3Arelease') {
          released = true
          return new Response(
            JSON.stringify({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: true,
              result: null
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:test')
        static revokeObjectURL = vi.fn()
      }
    )

    const api = await loadBootstrap()
    await expect(
      api.saveManagedFile({
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        versionId: 'version-3',
        path: 'artifact-version:project-1/session-1/artifact-1/version-3',
        suggestedName: 'report.bin'
      } as SaveManagedFileRequest)
    ).resolves.toEqual({ saved: true })

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'report.bin' })
    expect(createWritable).toHaveBeenCalledOnce()
    expect(blob).not.toHaveBeenCalled()
    expect(savedBytes).toEqual([1, 2, 3])
    expect(acquireRequest).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      args: [
        {
          source: 'artifact',
          projectId: 'project-1',
          fileId: 'artifact-1',
          versionId: 'version-3'
        }
      ]
    })
    expect(released).toBe(true)
  })

  it('rejects an oversized managed file before Blob fallback fetch and releases it', async () => {
    const previewFetch = vi.fn()
    let released = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/bootstrap') {
          return new Response(JSON.stringify(bootstrapPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url === '/rpc/preview-resources%3Aacquire') {
          return new Response(
            JSON.stringify({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: true,
              result: {
                id: 'resource-1',
                url: '/preview/resource-1',
                size: 512 * 1024 * 1024 + 1
              }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url === '/preview/resource-1') {
          previewFetch()
          return new Response(new Blob(['large file']))
        }
        if (url === '/rpc/preview-resources%3Arelease') {
          released = true
          return new Response(
            JSON.stringify({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: true,
              result: null
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:test')
        static revokeObjectURL = vi.fn()
      }
    )

    const api = await loadBootstrap()
    await expect(
      api.saveManagedFile({
        source: 'upload',
        projectId: 'project-1',
        fileId: 'upload-1',
        suggestedName: 'data.bin'
      })
    ).rejects.toMatchObject({ name: 'WebManagedFileSizeLimitError' })

    expect(previewFetch).not.toHaveBeenCalled()
    expect(released).toBe(true)
  })

  it('settles a stalled managed download and releases its acquired resource', async () => {
    let downloadSignal: AbortSignal | undefined
    let released = false
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/bootstrap') {
          return Promise.resolve(
            new Response(JSON.stringify(bootstrapPayload), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          )
        }
        if (url === '/rpc/preview-resources%3Aacquire') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: true,
                result: { id: 'resource-1', url: '/preview/resource-1' }
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (url === '/preview/resource-1') {
          downloadSignal = init?.signal ?? undefined
          return Promise.resolve({
            ok: true,
            blob: () =>
              new Promise<Blob>((_resolve, reject) => {
                downloadSignal?.addEventListener(
                  'abort',
                  () =>
                    reject(
                      downloadSignal?.reason ?? new DOMException('Download aborted', 'AbortError')
                    ),
                  { once: true }
                )
              })
          } as Response)
        }
        if (url === '/rpc/preview-resources%3Arelease') {
          released = true
          return Promise.resolve(
            new Response(
              JSON.stringify({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: true,
                result: null
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    const api = await loadBootstrap()
    const request = api.saveManagedFile({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      suggestedName: 'report.pdf'
    })
    const outcome = Promise.race([
      request.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      new Promise<'still-pending'>((resolve) =>
        window.setTimeout(() => resolve('still-pending'), 300_001)
      )
    ])

    await vi.advanceTimersByTimeAsync(300_001)

    await expect(outcome).resolves.toBe('rejected')
    expect(downloadSignal?.aborted).toBe(true)
    expect(released).toBe(true)
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
      after: '0',
      liveness: '1'
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

  it('closes a ready event socket that stops receiving liveness frames', async () => {
    await loadBootstrap()

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: readyFrame(0) })

    await vi.advanceTimersByTimeAsync(30_001)

    expect(socket.closed).toBe(true)
  })

  it('keeps a ready event socket alive while heartbeat frames continue', async () => {
    await loadBootstrap()

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: readyFrame(0) })
    await vi.advanceTimersByTimeAsync(20_000)
    socket.emit('message', { data: heartbeatFrame(0) })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(socket.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(socket.closed).toBe(true)
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
