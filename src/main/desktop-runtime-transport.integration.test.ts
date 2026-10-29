import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../shared/web-rpc-contract'
import { PermissionApprovalPresence } from './permission-approval-presence'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { ApplicationCommandError } from '../shared/application-command-contract'
import { ApplicationEventHub } from './application-events'
import type { ApplicationInvocation } from './application-command-router'
import { connectToDesktopEndpoint } from './desktop-connection'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'
import { createRemoteNotificationDelivery } from './notifications/desktop-delivery'
import type { NativeTranslator } from './locale/main-process-messages'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function frames(socket: WebSocket): {
  next(): Promise<Record<string, unknown>>
} {
  const queued: Record<string, unknown>[] = []
  let waiting: ((value: Record<string, unknown>) => void) | undefined
  socket.on('message', (bytes) => {
    const message = parseRpcJson(bytes.toString()) as Record<string, unknown>
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve(message)
    } else queued.push(message)
  })
  return {
    next: () =>
      queued.length
        ? Promise.resolve(queued.shift()!)
        : new Promise((resolve) => {
            waiting = resolve
          })
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(
  handler: (invocation: ApplicationInvocation<readonly unknown[]>) => Promise<unknown>
) {
  const events = new ApplicationEventHub()
  const permissionApprovalPresence = new PermissionApprovalPresence()
  const invoke = vi.fn(
    async (_name: string, invocation: ApplicationInvocation<readonly unknown[]>) =>
      handler(invocation)
  )
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => ['projects:list'], invoke },
    events,
    permissionApprovalPresence
  })
  cleanups.push(server.close)
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const received = frames(socket)
  socket.send(
    JSON.stringify({ kind: 'bootstrap', desktopInstanceId: '77d62b13-8a19-491f-af43-af36c9824521' })
  )
  const bootstrap = await received.next()
  const clientId = randomUUID()
  let id = 0
  const request = (args: unknown[] = [], channel = 'projects:list'): void => {
    socket.send(
      stringifyRpcJson({ kind: 'invoke', protocolVersion: 1, id: ++id, clientId, channel, args })
    )
  }
  return {
    server,
    socket,
    received,
    bootstrap,
    clientId,
    request,
    events,
    invoke,
    permissionApprovalPresence
  }
}

it('rebinds notification actions to the recovered attachment and rejects old capabilities', async () => {
  const disconnected = vi.fn()
  const errors = vi.fn()
  const delivery = createRemoteNotificationDelivery(
    (request) => server.requestNative(request),
    ((key: string) => key) as NativeTranslator,
    errors
  )
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    onNotificationAction: delivery.handleAction,
    onDisconnect: () => {
      delivery.disconnect()
      disconnected()
    }
  })
  cleanups.push(server.close)
  const tokens: string[] = []
  const connect = (): ReturnType<typeof connectDesktopRuntime> =>
    connectDesktopRuntime({
      endpoint: server.endpoint,
      onNativeRequest: async ({ request }) => {
        if (request.operation === 'notification-show') {
          tokens.push(request.token)
          return null
        }
        return false
      },
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
  const old = await connect()
  const staleClick = vi.fn()
  delivery.show({ title: 'Fixture old', body: 'Generated', onClick: staleClick })
  await vi.waitFor(() => expect(tokens).toHaveLength(1))
  old.close()
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce())
  const current = await connect()
  const currentClick = vi.fn()
  delivery.show({ title: 'Fixture current', body: 'Generated', onClick: currentClick })
  await vi.waitFor(() => expect(tokens).toHaveLength(2))
  old.notificationAction(tokens[0], 'clicked')
  current.notificationAction(tokens[0], 'clicked')
  current.notificationAction(tokens[1], 'clicked')
  await vi.waitFor(() => {
    expect(errors.mock.calls).toEqual([])
    expect(disconnected).toHaveBeenCalledOnce()
    expect(currentClick).toHaveBeenCalledOnce()
  })
  expect(staleClick).not.toHaveBeenCalled()
  current.notificationAction(tokens[1], 'clicked')
  expect(await server.requestNative({ operation: 'notification-focus' })).toBe(false)
  expect(currentClick).toHaveBeenCalledOnce()
  expect(errors).not.toHaveBeenCalled()
  current.close()
})

describe('desktop projection of application commands and events', () => {
  it.each(['renderer', 'host'] as const)(
    'rejects an oversized %s response without disconnecting other calls',
    async (caller) => {
      // The file fits the preview read cap, but JSON escapes expand it past the 16 MiB wire cap.
      const content = '\0'.repeat(3 * 1024 * 1024)
      const invoke = vi.fn(async (name: string) =>
        name === 'artifacts:read-preview'
          ? { content, encoding: 'utf8', size: content.length, truncated: false }
          : []
      )
      const commands = {
        commandNames: () => ['artifacts:read-preview', 'compute:jobs:list'],
        invoke
      }
      const events = new ApplicationEventHub()
      const server = await startDesktopRuntimeTransport({
        version: 'test',
        events,
        commands,
        hostCommands: commands
      })
      cleanups.push(server.close)
      const disconnected = vi.fn()
      const observed = vi.fn()
      const client = await connectDesktopRuntime({
        endpoint: server.endpoint,
        onEvent: observed,
        onDisconnect: disconnected
      })
      cleanups.push(async () => client.close())
      const document = randomUUID()
      const oversized =
        caller === 'renderer'
          ? client.invoke(document, 'artifacts:read-preview', [])
          : client.invokeHost('artifacts:read-preview')
      const other = client.invoke(document, 'compute:jobs:list', [])
      await expect(oversized).rejects.toMatchObject({
        code: 'command-failed',
        message: 'Desktop runtime response exceeds the transport byte budget.'
      })
      await expect(other).resolves.toEqual([])
      await expect(client.invoke(document, 'compute:jobs:list', [])).resolves.toEqual([])
      events.publish('runtime:policy-changed', undefined)
      await vi.waitFor(() =>
        expect(observed).toHaveBeenCalledWith({
          channel: 'runtime:policy-changed',
          payload: null
        })
      )
      expect(disconnected).not.toHaveBeenCalled()
      expect(invoke.mock.calls.filter(([name]) => name === 'artifacts:read-preview')).toHaveLength(
        1
      )
    }
  )

  it.each([undefined, null, false, 0])(
    'preserves the command result %s for renderer and host callers',
    async (result) => {
      const commands = { commandNames: () => ['projects:list'], invoke: async () => result }
      const server = await startDesktopRuntimeTransport({
        version: 'test',
        events: new ApplicationEventHub(),
        commands,
        hostCommands: commands
      })
      cleanups.push(server.close)
      const client = await connectDesktopRuntime({
        endpoint: server.endpoint,
        onEvent: vi.fn(),
        onDisconnect: vi.fn()
      })
      cleanups.push(async () => client.close())
      await expect(client.invoke(randomUUID(), 'projects:list', [])).resolves.toBe(result)
      await expect(client.invokeHost('projects:list')).resolves.toBe(result)
    }
  )

  it('connects the desktop client to the real transport and rejects pending calls on disconnect', async () => {
    const events = new ApplicationEventHub()
    const observed = vi.fn()
    const disconnected = vi.fn()
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: {
        commandNames: () => ['projects:list'],
        invoke: async (_name, invocation) => {
          if (invocation.args[0] === 'wait') {
            await new Promise<void>((resolve) =>
              invocation.callerLease.signal.addEventListener('abort', () => resolve(), {
                once: true
              })
            )
          }
          return invocation.args
        }
      }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: observed,
      onDisconnect: disconnected
    })
    const document = randomUUID()
    expect(client.commandNames()).toEqual(['projects:list'])
    await expect(
      client.invoke(document, 'projects:list', [Uint8Array.from([255])])
    ).resolves.toEqual([Uint8Array.from([255])])
    events.publish('runtime:policy-changed', undefined)
    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledWith({ channel: 'runtime:policy-changed', payload: null })
    )
    client.release(document)
    await expect(client.invoke(document, 'projects:list', [])).rejects.toThrow('released')
    const waiting = expect(client.invoke(randomUUID(), 'projects:list', ['wait'])).rejects.toThrow(
      'result of a submitted operation is unknown'
    )
    await server.close()
    await waiting
    expect(disconnected).toHaveBeenCalledOnce()
  })
  it('routes upload progress only to live invoking documents, outside broadcast and replay', async () => {
    const events = new ApplicationEventHub()
    const broadcasts = vi.fn()
    const progress = vi.fn()
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: broadcasts,
      onUploadProgress: progress,
      onDisconnect: vi.fn()
    })
    cleanups.push(async () => client.close())
    const document = randomUUID()
    const other = randomUUID()
    const payload = { transferId: 'transfer', name: 'data.csv', receivedBytes: 1, totalBytes: 2 }
    // Bootstrap alone does not grant a document an event target.
    server.reportUploadProgress(document, payload)
    await client.invoke(document, 'projects:list', [])
    expect(progress).not.toHaveBeenCalled()
    server.reportUploadProgress(document, payload)
    await client.invoke(other, 'projects:list', [])
    expect(progress).toHaveBeenCalledExactlyOnceWith(document, payload)
    expect(broadcasts).not.toHaveBeenCalled()
    client.release(document)
    await client.invoke(other, 'projects:list', [])
    server.reportUploadProgress(document, payload)
    server.reportUploadProgress(randomUUID(), payload)
    server.reportUploadProgress(other, { ...payload, receivedBytes: 2 })
    await client.invoke(other, 'projects:list', [])
    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenLastCalledWith(other, { ...payload, receivedBytes: 2 })
    // The first broadcast still starts at the first sequence; progress consumed no replay slots.
    events.publish('runtime:policy-changed', undefined)
    await client.invoke(other, 'projects:list', [])
    expect(broadcasts).toHaveBeenCalledExactlyOnceWith({
      channel: 'runtime:policy-changed',
      payload: null
    })
    expect(() => server.reportUploadProgress(other, { ...payload, receivedBytes: -1 })).toThrow()
    client.close()
    await vi.waitFor(() => expect(server.isConnected()).toBe(false))
    const recoveredProgress = vi.fn()
    const recovered = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: vi.fn(),
      onUploadProgress: recoveredProgress,
      onDisconnect: vi.fn()
    })
    const freshDocument = randomUUID()
    await recovered.invoke(freshDocument, 'projects:list', [])
    server.reportUploadProgress(other, payload)
    server.reportUploadProgress(document, payload)
    server.reportUploadProgress(freshDocument, payload)
    await recovered.invoke(freshDocument, 'projects:list', [])
    expect(recoveredProgress).toHaveBeenCalledExactlyOnceWith(freshDocument, payload)
    expect(progress).toHaveBeenCalledTimes(2)
    recovered.close()
    await server.close()
    server.reportUploadProgress(other, payload)
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it('keeps reproducibility events scoped to their document and outside public replay', async () => {
    const events = new ApplicationEventHub()
    const broadcast = vi.fn(),
      targeted = vi.fn()
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: broadcast,
      onDocumentEvent: targeted,
      onDisconnect: vi.fn()
    })
    cleanups.push(async () => client.close())
    const first = randomUUID(),
      second = randomUUID()
    const payload = {
      attemptId: 'attempt'
    } as import('../shared/artifact-reproducibility').ArtifactReproducibilityCheckState
    server.reportReproducibilityCheck(first, payload)
    await client.invoke(first, 'projects:list', [])
    expect(targeted).not.toHaveBeenCalled()
    server.reportReproducibilityCheck(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledExactlyOnceWith({
      kind: 'document-event',
      clientId: first,
      channel: 'artifacts:reproducibility-check-changed',
      payload
    })
    client.release(first)
    await client.invoke(second, 'projects:list', [])
    server.reportReproducibilityCheck(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('keeps marketplace events scoped to their document and outside public replay', async () => {
    const events = new ApplicationEventHub()
    const broadcast = vi.fn(),
      targeted = vi.fn()
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: broadcast,
      onDocumentEvent: targeted,
      onDisconnect: vi.fn()
    })
    cleanups.push(async () => client.close())
    const first = randomUUID(),
      second = randomUUID()
    const payload = {
      candidateToken: 'candidate',
      receivedBytes: 1
    } as unknown as import('../shared/specialist-marketplace').MarketplaceDownloadProgress
    server.reportMarketplaceProgress(first, payload)
    await client.invoke(first, 'projects:list', [])
    expect(targeted).not.toHaveBeenCalled()
    server.reportMarketplaceProgress(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledExactlyOnceWith({
      kind: 'document-event',
      clientId: first,
      channel: 'specialist:marketplace-download-progress',
      payload
    })
    client.release(first)
    await client.invoke(second, 'projects:list', [])
    server.reportMarketplaceProgress(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('keeps Office preview events scoped to their document and outside public replay', async () => {
    const events = new ApplicationEventHub()
    const broadcast = vi.fn(),
      targeted = vi.fn()
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: broadcast,
      onDocumentEvent: targeted,
      onDisconnect: vi.fn()
    })
    cleanups.push(async () => client.close())
    const first = randomUUID(),
      second = randomUUID()
    const payload = {
      sessionId: 'preview-session',
      phase: 'ready'
    } as import('../shared/office-preview').OfficePreviewRuntimeState
    server.reportOfficePreviewState(first, payload)
    await client.invoke(first, 'projects:list', [])
    expect(targeted).not.toHaveBeenCalled()
    server.reportOfficePreviewState(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledExactlyOnceWith({
      kind: 'document-event',
      clientId: first,
      channel: 'office-preview:state',
      payload
    })
    client.release(first)
    await client.invoke(second, 'projects:list', [])
    server.reportOfficePreviewState(first, payload)
    await client.invoke(second, 'projects:list', [])
    expect(targeted).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('counts only active renderer documents as permission responders and releases them on detach', async () => {
    const value = await setup(async () => undefined)
    expect(value.permissionApprovalPresence.isAvailable()).toBe(false)
    expect(value.server.hasActiveDocuments()).toBe(false)
    value.request()
    await value.received.next()
    value.request()
    await value.received.next()
    expect(value.permissionApprovalPresence.isAvailable()).toBe(true)
    expect(value.server.hasActiveDocuments()).toBe(true)
    value.socket.send(JSON.stringify({ kind: 'release', clientId: value.clientId }))
    await vi.waitFor(() => expect(value.permissionApprovalPresence.isAvailable()).toBe(false))
    expect(value.server.hasActiveDocuments()).toBe(false)
    value.socket.send(
      stringifyRpcJson({
        kind: 'invoke',
        protocolVersion: 1,
        id: 3,
        clientId: randomUUID(),
        channel: 'projects:list',
        args: []
      })
    )
    await value.received.next()
    expect(value.permissionApprovalPresence.isAvailable()).toBe(true)
    expect(value.server.hasActiveDocuments()).toBe(true)
    value.socket.terminate()
    await vi.waitFor(() => expect(value.permissionApprovalPresence.isAvailable()).toBe(false))
    expect(value.server.hasActiveDocuments()).toBe(false)
  })

  it('uses the existing binary codec and command results with an isolated Electron caller lease', async () => {
    const invocations: ApplicationInvocation<readonly unknown[]>[] = []
    const value = await setup(async (invocation) => {
      invocations.push(invocation)
      return invocation.args[0]
    })
    const bytes = Uint8Array.from([0, 128, 255])
    value.request([bytes])
    expect(await value.received.next()).toEqual({
      kind: 'response',
      id: 1,
      protocolVersion: 1,
      ok: true,
      result: bytes
    })
    value.request(['second'])
    await value.received.next()
    expect(invocations[0].callerLease).toBe(invocations[1].callerLease)
    expect(invocations[0].callerContext).toMatchObject({
      clientId: value.clientId,
      surface: 'electron',
      location: 'local',
      principalKind: 'human'
    })
    expect(invocations[0].callerContext.isAuthorizationCurrent()).toBe(true)
    value.socket.send(JSON.stringify({ kind: 'release', clientId: value.clientId }))
    value.request()
    expect(await value.received.next()).toMatchObject({
      ok: false,
      error: { code: 'command-unavailable' }
    })
    expect(invocations[0].callerLease.signal.aborted).toBe(true)
    expect(invocations[0].callerContext.isAuthorizationCurrent()).toBe(false)
    expect(value.invoke).toHaveBeenCalledTimes(2)
  })

  it('preserves cached PDF Buffer results over the desktop binary transport', async () => {
    const bytes = Uint8Array.from([37, 80, 68, 70, 45, 0, 128, 255])
    const pooled = Buffer.concat([Buffer.from('prefix'), Buffer.from(bytes), Buffer.from('suffix')])
    const value = await setup(async () => ({
      data: pooled.subarray(6, 6 + bytes.length),
      cacheHit: true,
      layoutFailures: []
    }))
    value.request()
    expect(await value.received.next()).toMatchObject({
      ok: true,
      result: { data: bytes, cacheHit: true, layoutFailures: [] }
    })
    // A JSON object that resembles Buffer.toJSON is still ordinary application data.
    const object = { type: 'Buffer', data: [1, 2] }
    expect(parseRpcJson(stringifyRpcJson(object))).toEqual(object)
    expect(parseRpcJson(stringifyRpcJson(Buffer.from(bytes)))).toEqual(bytes)
    expect(parseRpcJson(stringifyRpcJson([Buffer.from(bytes)]))).toEqual([bytes])
  })

  it('reuses domain error envelopes and never dispatches channels outside the desktop projection', async () => {
    const value = await setup(async () => {
      throw new ApplicationCommandError('session-revision-conflict', 'Save conflict')
    })
    value.request()
    expect(await value.received.next()).toMatchObject({
      ok: false,
      error: { code: 'session-revision-conflict', message: 'Save conflict' }
    })
    value.request([], 'window:close')
    expect(await value.received.next()).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    expect(value.invoke).toHaveBeenCalledOnce()
  })

  it('streams and replays the existing event protocol without losing desktop-only events', async () => {
    const value = await setup(async () => undefined)
    const cursor = value.bootstrap.eventStream as { streamId: string; latestSequence: number }
    value.events.publish('side-chat:relay-delivered', {
      projectId: 'project',
      parentSessionId: 'session',
      message: { id: 'message', role: 'assistant', content: 'hello' }
    } as never)
    const event = await value.received.next()
    expect(event).toMatchObject({
      kind: 'event',
      protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
      streamId: cursor.streamId,
      sequence: 1,
      channel: 'side-chat:relay-delivered'
    })
    value.socket.send(JSON.stringify({ kind: 'resume', streamId: cursor.streamId, after: 0 }))
    expect(await value.received.next()).toEqual(event)
    expect(await value.received.next()).toMatchObject({ kind: 'ready', latestSequence: 1 })
    value.socket.send(JSON.stringify({ kind: 'resume', streamId: randomUUID(), after: 1 }))
    expect(await value.received.next()).toMatchObject({
      kind: 'resync-required',
      reason: 'stream-changed'
    })
  })

  it('revokes and aborts pending caller work when the desktop disappears', async () => {
    let current: ApplicationInvocation<readonly unknown[]> | undefined
    const value = await setup(async (invocation) => {
      current = invocation
      await new Promise<void>((resolve) =>
        invocation.callerLease.signal.addEventListener('abort', () => resolve(), { once: true })
      )
    })
    value.request()
    await vi.waitFor(() => expect(current).toBeDefined())
    value.socket.terminate()
    await vi.waitFor(() => expect(current?.callerLease.signal.aborted).toBe(true))
    expect(current?.callerContext.isAuthorizationCurrent()).toBe(false)
  })

  it.each([
    'invalid json',
    JSON.stringify({ kind: 'invoke', id: 1 }),
    JSON.stringify({ kind: 'release', clientId: '../config' })
  ])('rejects malformed attachment frames before dispatch: %s', async (message) => {
    const value = await setup(async () => undefined)
    const closed = once(value.socket, 'close')
    value.socket.send(message)
    expect((await closed)[0]).toBe(1008)
    expect(value.invoke).not.toHaveBeenCalled()
  })
})

describe('native desktop requests over the authenticated connection', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function nativeSetup(
    onNativeRequest?: import('./desktop-native-contract').DesktopNativeHandler
  ) {
    const disconnected = vi.fn()
    const { currentDesktopCaller } = await import('./desktop-native-contract')
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['projects:list'],
        invoke: async (_name, invocation) => {
          if (invocation.args[0] === 'ping') return 'pong'
          const caller = currentDesktopCaller()!
          expect(caller.clientId).toBe(invocation.callerContext.clientId)
          return server.requestNative(
            { operation: 'save-dialog', options: {} },
            caller.clientId,
            caller.signal
          )
        }
      }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onNativeRequest,
      onEvent: () => {},
      onDisconnect: disconnected
    })
    return { server, client, document: randomUUID(), disconnected }
  }

  it('round-trips native selections through the original command and caller lease', async () => {
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const result = { canceled: false, filePath: join(tmpdir(), 'export.science') }
    const native = vi.fn(
      async (request: import('./desktop-native-contract').DesktopNativeRequest) => {
        expect(request.request.operation).toBe('save-dialog')
        return result
      }
    )
    const value = await nativeSetup(native)
    await expect(value.client.invoke(value.document, 'projects:list', [])).resolves.toEqual(result)
    expect(native.mock.calls[0][0]).toMatchObject({
      clientId: value.document,
      request: { operation: 'save-dialog' }
    })
    value.client.close()
  })

  it('reports unavailable native capability without silently accepting a destination', async () => {
    const value = await nativeSetup()
    await expect(value.client.invoke(value.document, 'projects:list', [])).rejects.toThrow(
      'unavailable'
    )
    value.client.close()
    await vi.waitFor(async () => {
      await expect(
        value.server.requestNative({ operation: 'save-dialog', options: {} })
      ).rejects.toThrow('connected')
    })
  })

  it('rejects malformed native results at the runtime boundary', async () => {
    const value = await nativeSetup(async () => ({
      canceled: false,
      filePath: 'relative-destination'
    }))
    await expect(value.client.invoke(value.document, 'projects:list', [])).rejects.toThrow(
      'absolute'
    )
    value.client.close()
  })

  it.each(['release', 'disconnect'] as const)(
    'cancels a pending native operation on document %s',
    async (reason) => {
      let signal: AbortSignal | undefined
      let finish!: (value: unknown) => void
      const value = await nativeSetup(async (_request, callerSignal) => {
        if (signal) return { canceled: true }
        signal = callerSignal
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const pending = expect(
        value.client.invoke(value.document, 'projects:list', [])
      ).rejects.toThrow()
      await vi.waitFor(() => expect(signal).toBeDefined())
      if (reason === 'release') value.client.release(value.document)
      else value.client.close()
      await pending
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))
      finish({ canceled: true })
      if (reason === 'release') {
        // A cancelled operation's late return must not corrupt the next document/command.
        await expect(value.client.invoke(randomUUID(), 'projects:list', ['ping'])).resolves.toBe(
          'pong'
        )
        await expect(value.client.invoke(randomUUID(), 'projects:list', [])).resolves.toEqual({
          canceled: true
        })
        expect(value.disconnected).not.toHaveBeenCalled()
        value.client.close()
      }
    }
  )

  it('bounds cancelled but unsettled native resources independently and releases them on settlement', async () => {
    const finishes: Array<() => void> = []
    let started!: (signal: AbortSignal) => void
    const handler = vi.fn(async (_request, signal: AbortSignal) => {
      started(signal)
      return new Promise((resolve) => finishes.push(() => resolve({ canceled: true })))
    })
    const value = await nativeSetup(handler)
    try {
      for (let index = 0; index < 64; index++) {
        const arrived = new Promise<AbortSignal>((resolve) => {
          started = resolve
        })
        const controller = new AbortController()
        const operation = value.server.requestNative(
          { operation: 'save-dialog', options: {} },
          undefined,
          controller.signal
        )
        const nativeSignal = await arrived
        const rejected = expect(operation).rejects.toThrow('cancelled')
        controller.abort()
        await rejected
        await vi.waitFor(() => expect(nativeSignal.aborted).toBe(true))
      }
      await expect(
        value.server.requestNative({ operation: 'save-dialog', options: {} })
      ).rejects.toThrow('resources are still busy')
      expect(handler).toHaveBeenCalledTimes(64)
      // A fresh attachment must not reset the real resource budget of retired handlers.
      value.client.close()
      await vi.waitFor(() => expect(value.server.isConnected()).toBe(false))
      value.client = await connectDesktopRuntime({
        endpoint: value.server.endpoint,
        onNativeRequest: handler,
        onEvent: () => {},
        onDisconnect: value.disconnected
      })
      await expect(
        value.server.requestNative({ operation: 'save-dialog', options: {} })
      ).rejects.toThrow('resources are still busy')
      expect(handler).toHaveBeenCalledTimes(64)
      await expect(value.client.invoke(randomUUID(), 'projects:list', ['ping'])).resolves.toBe(
        'pong'
      )
      finishes.shift()!()
      await new Promise((resolve) => setImmediate(resolve))
      handler.mockImplementation(async () => ({ canceled: true }))
      await expect(
        value.server.requestNative({ operation: 'save-dialog', options: {} })
      ).resolves.toEqual({ canceled: true })
      expect(value.disconnected).not.toHaveBeenCalled()
    } finally {
      for (const finish of finishes) finish()
      value.client.close()
    }
  })

  it('reclaims cancelled protocol slots before delayed handlers settle across repeated operations', async () => {
    let nextStarted!: (signal: AbortSignal) => void
    let completeNative = false
    const finishes: Array<() => void> = []
    const value = await nativeSetup(async (_request, signal) => {
      if (completeNative) return { canceled: true }
      nextStarted(signal)
      return new Promise((resolve) => {
        finishes.push(() => resolve({ canceled: true }))
      })
    })
    try {
      for (let index = 0; index < 70; index++) {
        const started = new Promise<AbortSignal>((resolve) => {
          nextStarted = resolve
        })
        const document = randomUUID()
        const operation = value.client.invoke(document, 'projects:list', [])
        // Race against rejection so exhausted client capacity fails promptly, not by timeout.
        const signal = await Promise.race([
          started,
          operation.then(() => {
            throw new Error('Native operation unexpectedly completed.')
          })
        ])
        const rejected = expect(operation).rejects.toThrow()
        value.client.release(document)
        await rejected
        await vi.waitFor(() => expect(signal.aborted).toBe(true))
        // Keep cleanup delayed past the next admission, but do not accumulate real resources.
        if (finishes.length > 2) finishes.shift()!()
      }
      await expect(value.client.invoke(randomUUID(), 'projects:list', ['ping'])).resolves.toBe(
        'pong'
      )
      for (const finish of finishes.splice(0)) finish()
      completeNative = true
      await expect(value.client.invoke(randomUUID(), 'projects:list', [])).resolves.toEqual({
        canceled: true
      })
      expect(value.disconnected).not.toHaveBeenCalled()
    } finally {
      for (const finish of finishes) finish()
      value.client.close()
    }
  })

  it('times out native dialogs, cancels the client operation and retains the command connection', async () => {
    let signal: AbortSignal | undefined
    const value = await nativeSetup(async (_request, callerSignal) => {
      if (signal) return { canceled: true }
      signal = callerSignal
      return new Promise(() => {})
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = expect(
        value.client.invoke(value.document, 'projects:list', [])
      ).rejects.toThrow('cancelled')
      while (!signal) await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(300_000)
      await pending
      while (!signal.aborted) await new Promise((resolve) => setImmediate(resolve))
      await expect(value.client.invoke(value.document, 'projects:list', ['ping'])).resolves.toBe(
        'pong'
      )
      await expect(value.client.invoke(value.document, 'projects:list', [])).resolves.toEqual({
        canceled: true
      })
      expect(value.disconnected).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      value.client.close()
    }
  })
})

it('projects database recovery before business commands and promotes only live documents when ready', async () => {
  const { createDatabaseStartupOwner } = await import('./database/database-startup-owner')
  const verify = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporarily unavailable'))
    .mockResolvedValue(undefined)
  const startup = createDatabaseStartupOwner({ verifyDatabase: verify, reportBlocked: vi.fn() })
  await startup.start()
  let ready = false
  const acquire = vi.fn(() => (ready ? vi.fn() : undefined))
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    startup,
    events: new ApplicationEventHub(),
    commands: {
      commandNames: () => (ready ? ['locale:initialize', 'projects:list'] : ['locale:initialize']),
      invoke: async () => null
    },
    permissionApprovalPresence: { acquire }
  })
  cleanups.push(server.close)
  const changed = vi.fn()
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onStartupState: changed,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanups.push(async () => client.close())
  expect(client.startupState()).toMatchObject({ phase: 'blocked', error: { retryable: true } })
  expect(client.commandNames()).toEqual(['locale:initialize'])
  const document = randomUUID()
  await client.invoke(document, 'locale:initialize', [])
  expect(acquire).toHaveBeenCalledOnce()
  await expect(client.retryStartup()).resolves.toEqual({ phase: 'starting' })
  ready = true
  startup.complete()
  await vi.waitFor(() => expect(client.startupState()).toEqual({ phase: 'ready' }))
  expect(client.commandNames()).toEqual(['locale:initialize', 'projects:list'])
  expect(acquire).toHaveBeenCalledTimes(2)
  await expect(client.invoke(document, 'projects:list', [])).resolves.toBeNull()
  expect(changed).toHaveBeenLastCalledWith({ phase: 'ready' })
})

it('keeps native host commands outside renderer approval presence and revokes their leases on detach', async () => {
  const presence = new PermissionApprovalPresence()
  let hostInvocation: ApplicationInvocation<readonly unknown[]> | undefined
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events: new ApplicationEventHub(),
    commands: { commandNames: () => ['projects:list'], invoke: async () => [] },
    hostCommands: {
      commandNames: () => ['settings:get-settings'],
      invoke: async (_name, invocation) => {
        hostInvocation = invocation
        return { closePreference: 'minimize' }
      }
    },
    permissionApprovalPresence: presence
  })
  cleanups.push(server.close)
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onEvent: () => {},
    onDisconnect: () => {}
  })
  expect(await client.invokeHost('settings:get-settings')).toEqual({ closePreference: 'minimize' })
  expect(server.hasActiveDocuments()).toBe(false)
  expect(hostInvocation?.callerContext.surface).toBe('electron')
  expect(hostInvocation?.callerLease.signal.aborted).toBe(false)
  client.close()
  await vi.waitFor(() => expect(hostInvocation?.callerLease.signal.aborted).toBe(true))
})

it('keeps App holds and quit authority through stale snapshots and lost exit replies', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createLocalServiceLifetime } = await import('./local-service-lifetime')
  const { createDesktopRuntimeLifecycle } = await import('./desktop-runtime-lifecycle')
  const configRoot = await mkdtemp(join(tmpdir(), 'desktop-lifetime-'))
  cleanups.push(() => rm(configRoot, { recursive: true, force: true }))
  const stop = vi.fn()
  const lifetime = await createLocalServiceLifetime({
    configRoot,
    generation: randomUUID(),
    explicitStart: false,
    stop,
    report: vi.fn()
  })
  cleanups.push(async () => lifetime.close())
  const prepare = vi.fn(async () => 'completed' as const)
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    lifetime,
    startupOptions: {
      configRoot,
      dataRoot: configRoot,
      profilePath: configRoot,
      port: 0,
      host: '127.0.0.1',
      credentialStore: 'os'
    },
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    createLifecycle: () =>
      createDesktopRuntimeLifecycle({
        detectActiveSessions: () => [],
        hasActiveReviewerWork: () => false,
        getActiveSettingsInstallId: () => undefined,
        isMigrationInProgress: () => false,
        hasActivePackageTransfer: () => false,
        holdSettingsInstallAdmission: () => () => {},
        prepareForQuit: prepare,
        abortQuitPreparation: vi.fn()
      })
  })
  cleanups.push(server.close)
  const attach = (): ReturnType<typeof connectDesktopRuntime> =>
    connectDesktopRuntime({
      endpoint: server.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: () => {},
      onDisconnect: () => {}
    })
  const a = await attach()
  const b = await attach()
  cleanups.push(async () => {
    a.close()
    b.close()
  })
  expect(a.runtimeInfo().lifetime?.apps).toBe(1)
  const workA = (await a.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await a.lifecycle({ operation: 'prepare', fingerprint: workA.fingerprint })
  expect(prepare).not.toHaveBeenCalled()
  const appOnlyDecision = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await a.quit()
  await vi.waitFor(() => expect(lifetime.snapshot().apps).toBe(1))
  await expect(
    b.lifecycle({ operation: 'prepare', fingerprint: appOnlyDecision.fingerprint })
  ).resolves.toBe('scope-changed')
  expect(prepare).not.toHaveBeenCalled()
  await b.lifecycle({ operation: 'abort' })
  expect(b.runtimeInfo().lifetime?.apps).toBe(2)
  const workB = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await b.lifecycle({ operation: 'prepare', fingerprint: workB.fingerprint })
  expect(prepare).toHaveBeenCalledOnce()
  await expect(lifetime.start()).rejects.toThrow('stopping')
  await b.lifecycle({ operation: 'abort' })
  await lifetime.start()
  expect(lifetime.snapshot().explicit).toBe(true)
  const preserved = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await b.lifecycle({ operation: 'prepare', fingerprint: preserved.fingerprint })
  await lifetime.stop(false)
  await expect(b.quit()).rejects.toThrow('whole service')
  expect(lifetime.snapshot()).toMatchObject({ apps: 1, explicit: false, stopping: false })
  expect(stop).not.toHaveBeenCalled()
  await b.lifecycle({ operation: 'abort' })
  await lifetime.start()
  const preservedAgain = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await b.lifecycle({ operation: 'prepare', fingerprint: preservedAgain.fingerprint })
  const leave = lifetime.leave.bind(lifetime)
  vi.spyOn(lifetime, 'leave').mockImplementationOnce(async (...args) => {
    expect(await leave(...args)).toMatchObject({ apps: 1, explicit: true, stopping: false })
    return new Promise<never>(() => {}) // A successful App-only response is lost.
  })
  await expect(b.quit({ deadlineAt: Date.now() + 3600 })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  expect(server.isConnected()).toBe(true)
  expect(lifetime.snapshot().apps).toBe(1)
  await b.lifecycle({ operation: 'abort' })
  await lifetime.stop(false)
  expect(lifetime.snapshot()).toMatchObject({ apps: 1, explicit: false, stopping: false })
  expect(stop).not.toHaveBeenCalled()
  await lifetime.start()
  const preservedAfterRollback = (await b.lifecycle({ operation: 'inspect' })) as {
    fingerprint: string
  }
  await b.lifecycle({ operation: 'prepare', fingerprint: preservedAfterRollback.fingerprint })
  await lifetime.stop(false)
  vi.spyOn(lifetime, 'leave').mockImplementationOnce(async (...args) => {
    expect(await leave(...args)).toMatchObject({ scopeChanged: true })
    return new Promise<never>(() => {}) // The App never receives this scope-change response.
  })
  await expect(b.quit({ deadlineAt: Date.now() + 3600 })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  expect(lifetime.snapshot()).toMatchObject({ apps: 1, stopping: false })
  await b.lifecycle({ operation: 'abort' })
  const confirmed = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await b.lifecycle({ operation: 'prepare', fingerprint: confirmed.fingerprint })
  expect(prepare).toHaveBeenCalledTimes(2)
  await b.lifecycle({ operation: 'abort' })
  const c = await attach()
  cleanups.push(async () => c.close())
  const togetherB = (await b.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  const togetherC = (await c.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await b.lifecycle({ operation: 'prepare', fingerprint: togetherB.fingerprint })
  await c.lifecycle({ operation: 'prepare', fingerprint: togetherC.fingerprint })
  vi.spyOn(lifetime, 'leave').mockImplementationOnce(async (...args) => {
    expect(await leave(...args)).toMatchObject({ apps: 2, stopping: false })
    return new Promise<never>(() => {})
  })
  const lostTogether = expect(b.quit({ deadlineAt: Date.now() + 3600 })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  await vi.waitFor(async () =>
    expect(await c.lifecycle({ operation: 'inspect' })).toMatchObject({ preserveService: false })
  )
  await expect(c.quit()).rejects.toThrow('whole service')
  await c.lifecycle({ operation: 'abort' })
  const currentC = (await c.lifecycle({ operation: 'inspect' })) as { fingerprint: string }
  await c.lifecycle({
    operation: 'prepare',
    fingerprint: currentC.fingerprint,
    preserveService: false
  })
  await c.lifecycle({ operation: 'abort' })
  await lostTogether
  await b.lifecycle({ operation: 'abort' })
  expect(await c.lifecycle({ operation: 'inspect' })).toMatchObject({ preserveService: true })
  expect(lifetime.snapshot()).toMatchObject({ apps: 2, stopping: false })
  expect(stop).not.toHaveBeenCalled()
})

it.each(['abort', 'disconnect', 'expiry'] as const)(
  'does not start a delayed prepare after %s invalidates its attempt',
  async (mode) => {
    const deferred = Promise.withResolvers<boolean>()
    const generation = randomUUID()
    const lifecycle = {
      request: vi.fn<
        (
          operation: import('./desktop-runtime-lifecycle').DesktopLifecycleRequest
        ) => Promise<string>
      >(async () => 'completed'),
      disconnect: vi.fn(async () => {})
    }
    const lifetime = {
      preservesService: () => false,
      snapshot: () => ({
        version: 1 as const,
        generation,
        explicit: false,
        stopping: false,
        apps: 1
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      prepareLeave: vi.fn(() => deferred.promise),
      abortLeave: vi.fn(async () => {
        await deferred.promise
      }),
      leave: vi.fn(),
      start: vi.fn(),
      retireIfUnused: vi.fn(),
      stop: vi.fn(),
      close: vi.fn()
    }
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      lifetime,
      generation,
      commands: { commandNames: () => [], invoke: vi.fn() },
      events: new ApplicationEventHub(),
      createLifecycle: () => lifecycle
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: () => {},
      onDisconnect: () => {}
    })
    cleanups.push(async () => client.close())
    const preparing = client.lifecycle({
      operation: 'prepare',
      fingerprint: 'a'.repeat(64),
      deadlineAt: Date.now() + (mode === 'expiry' ? 3550 : 5000)
    })
    const rejected = expect(preparing).rejects.toThrow()
    await vi.waitFor(() => expect(lifetime.prepareLeave).toHaveBeenCalledOnce())
    let aborted: Promise<unknown> | undefined
    if (mode === 'abort') {
      aborted = client.lifecycle({ operation: 'abort' })
      await vi.waitFor(() =>
        expect(lifecycle.request).toHaveBeenCalledWith(
          expect.objectContaining({ operation: 'abort' })
        )
      )
    } else if (mode === 'disconnect') {
      client.close()
      await vi.waitFor(() => expect(lifecycle.disconnect).toHaveBeenCalledOnce())
    } else await new Promise((resolve) => setTimeout(resolve, 80))
    deferred.resolve(true)
    await rejected
    await aborted
    await vi.waitFor(() => expect(lifetime.abortLeave).toHaveBeenCalled())
    expect(
      lifecycle.request.mock.calls.some(([operation]) => operation.operation === 'prepare')
    ).toBe(false)
  }
)

it('passes an app-exit deadline even when the caller did not prepare an attempt', async () => {
  const generation = randomUUID()
  const snapshot = { version: 1 as const, generation, explicit: true, stopping: false, apps: 0 }
  const lifetime = {
    preservesService: () => true,
    snapshot: () => snapshot,
    connect: vi.fn(),
    disconnect: vi.fn(),
    prepareLeave: vi.fn(),
    abortLeave: vi.fn(),
    leave: vi.fn(async () => snapshot),
    start: vi.fn(),
    retireIfUnused: vi.fn(),
    stop: vi.fn(),
    close: vi.fn()
  }
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    generation,
    lifetime,
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub()
  })
  cleanups.push(server.close)
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const received = frames(socket)
  const appId = randomUUID()
  socket.send(stringifyRpcJson({ kind: 'bootstrap', desktopInstanceId: appId }))
  await received.next()
  const deadlineAt = Date.now() + 100
  socket.send(stringifyRpcJson({ kind: 'app-exit', id: 1, generation, deadlineAt }))
  expect(await received.next()).toMatchObject({ kind: 'response', ok: true })
  expect(lifetime.leave).toHaveBeenCalledWith(appId, expect.any(String), {
    deadlineAt,
    detachOnDisconnect: true
  })
  socket.close()
})

it('rolls back global desktop update preparation only when its controller disconnects', async () => {
  const generation = randomUUID()
  const lifetime = {
    preservesService: () => true,
    snapshot: () => ({
      version: 1 as const,
      generation,
      explicit: false,
      stopping: false,
      apps: 2
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    prepareLeave: vi.fn(),
    abortLeave: vi.fn(),
    leave: vi.fn(),
    start: vi.fn(),
    retireIfUnused: vi.fn(),
    stop: vi.fn(),
    close: vi.fn()
  }
  const onControllerDisconnect = vi.fn()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    lifetime,
    generation,
    controllerRetireDeadlineMs: 50,
    onControllerDisconnect,
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    createLifecycle: () => ({ request: vi.fn(), disconnect: vi.fn(async () => {}) })
  })
  cleanups.push(server.close)
  const attach = (): ReturnType<typeof connectDesktopRuntime> =>
    connectDesktopRuntime({
      endpoint: server.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: () => {},
      onDisconnect: () => {}
    })
  const controller = await attach()
  const secondary = await attach()
  cleanups.push(async () => {
    controller.close()
    secondary.close()
  })
  secondary.close()
  await vi.waitFor(() => expect(lifetime.disconnect).toHaveBeenCalledOnce())
  expect(onControllerDisconnect).not.toHaveBeenCalled()
  controller.close()
  await vi.waitFor(() => expect(onControllerDisconnect).toHaveBeenCalledOnce())
})
