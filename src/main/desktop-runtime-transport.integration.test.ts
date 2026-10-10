import { ChildProcess } from 'node:child_process'
import { PermissionApprovalPresence } from './permission-approval-presence'
import { createHash, randomUUID } from 'node:crypto'
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
  socket.send(JSON.stringify({ kind: 'bootstrap' }))
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

it('keeps notification clicks on the authenticated attachment and clears them on disconnect', async () => {
  const onAction = vi.fn()
  const disconnected = vi.fn()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    onNotificationAction: onAction,
    onDisconnect: disconnected
  })
  cleanups.push(server.close)
  const native = vi.fn(async () => false)
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onNativeRequest: native,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  expect(server.isConnected()).toBe(true)
  expect(await server.requestNative({ operation: 'notification-focus' })).toBe(false)
  const token = randomUUID()
  client.notificationAction(token, 'clicked')
  await vi.waitFor(() => expect(onAction).toHaveBeenCalledExactlyOnceWith(token, 'clicked'))
  client.close()
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce())
  expect(server.isConnected()).toBe(false)
  client.notificationAction(token, 'clicked')
  expect(onAction).toHaveBeenCalledOnce()
})

describe('desktop projection of application commands and events', () => {
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
      'closed'
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
      protocolVersion: 3,
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

describe('desktop quit ownership', () => {
  async function host(
    requestShutdown = vi.fn()
  ): Promise<Awaited<ReturnType<typeof startDesktopRuntimeTransport>>> {
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      requestShutdown,
      commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
    })
    cleanups.push(server.close)
    return server
  }
  function child(pid = process.pid): ChildProcess {
    // Real OS sockets above; substitute only the launcher-held child process lifecycle.
    return Object.assign(new ChildProcess(), { pid, kill: vi.fn() })
  }
  it('quits an attached client without stopping the existing server', async () => {
    const shutdown = vi.fn()
    const server = await host(shutdown)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    await client.quit()
    expect(shutdown).not.toHaveBeenCalled()
    await vi.waitFor(async () => {
      const other = await connectDesktopRuntime({
        endpoint: server.endpoint,
        onEvent: vi.fn(),
        onDisconnect: vi.fn()
      })
      try {
        await expect(other.invoke(randomUUID(), 'projects:list', [])).resolves.toEqual([])
      } finally {
        other.close()
      }
    })
  })
  it('stops only its own runtime and waits for a clean child exit, once', async () => {
    const shutdown = vi.fn()
    const server = await host(shutdown)
    const startedProcess = child()
    const disconnected = vi.fn()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      startedProcess,
      onEvent: vi.fn(),
      onDisconnect: disconnected
    })
    const finished = vi.fn()
    const quit = client.quit()
    expect(client.quit()).toBe(quit)
    void quit.then(finished)
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    expect(finished).not.toHaveBeenCalled()
    Object.assign(startedProcess, { exitCode: 0 })
    startedProcess.emit('exit', 0, null)
    await quit
    expect(finished).toHaveBeenCalledOnce()
    expect(disconnected).not.toHaveBeenCalled()
    expect(startedProcess.kill).not.toHaveBeenCalled()
  })
  it('accepts orderly connection closure only after the owned child exits cleanly', async () => {
    const startedProcess = child()
    const server = await host(
      vi.fn(() => {
        void server.close().then(() => {
          Object.assign(startedProcess, { exitCode: 0 })
          startedProcess.emit('exit', 0, null)
        })
      })
    )
    const disconnected = vi.fn()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      startedProcess,
      onEvent: vi.fn(),
      onDisconnect: disconnected
    })
    await expect(client.quit()).resolves.toBeUndefined()
    expect(disconnected).not.toHaveBeenCalled()
    expect(startedProcess.kill).not.toHaveBeenCalled()
  })
  it('reports an abnormal child exit without force-kill or success', async () => {
    const shutdown = vi.fn()
    const server = await host(shutdown)
    const startedProcess = child()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      startedProcess,
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    const result = expect(client.quit()).rejects.toThrow('without completing a clean shutdown')
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    Object.assign(startedProcess, { exitCode: 1 })
    startedProcess.emit('exit', 1, null)
    await result
    expect(startedProcess.kill).not.toHaveBeenCalled()
    expect(startedProcess.listenerCount('exit')).toBe(0)
    client.close()
  })
  it.each(['lost-startup-race', 'exited-before-quit', 'detach', 'connection-loss'] as const)(
    'does not send shutdown for %s',
    async (scenario) => {
      const shutdown = vi.fn()
      const server = await host(shutdown)
      const startedProcess = child(scenario === 'lost-startup-race' ? process.pid + 1 : process.pid)
      const disconnected = vi.fn()
      const client = await connectDesktopRuntime({
        endpoint: server.endpoint,
        startedProcess,
        onEvent: vi.fn(),
        onDisconnect: disconnected
      })
      if (scenario === 'exited-before-quit') Object.assign(startedProcess, { exitCode: 0 })
      if (scenario === 'detach') client.close()
      else if (scenario === 'connection-loss') {
        await server.close()
        await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce())
      } else await client.quit()
      expect(shutdown).not.toHaveBeenCalled()
      expect(startedProcess.kill).not.toHaveBeenCalled()
    }
  )
  it('rejects stale generations and wrong PIDs and deduplicates accepted shutdown', async () => {
    const shutdown = vi.fn()
    const server = await host(shutdown)
    const socket = await connectToDesktopEndpoint(server.endpoint)
    const received = frames(socket)
    let id = 0
    for (const identity of [
      { generation: randomUUID(), pid: process.pid },
      { generation: server.endpoint.generation, pid: process.pid + 1 }
    ]) {
      socket.send(stringifyRpcJson({ kind: 'shutdown', id: ++id, ...identity }))
      expect(await received.next()).toMatchObject({
        ok: false,
        error: { code: 'command-unavailable' }
      })
    }
    expect(shutdown).not.toHaveBeenCalled()
    for (let attempt = 0; attempt < 2; attempt++) {
      socket.send(
        stringifyRpcJson({
          kind: 'shutdown',
          id: ++id,
          generation: server.endpoint.generation,
          pid: process.pid
        })
      )
      expect(await received.next()).toMatchObject({ ok: true })
    }
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    socket.terminate()
  })
  it('reports a shutdown timeout without killing the runtime or declaring success', async () => {
    const shutdown = vi.fn()
    const server = await host(shutdown)
    const startedProcess = child()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      startedProcess,
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const result = expect(client.quit()).rejects.toThrow('No process signal was sent')
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(startedProcess.kill).not.toHaveBeenCalled()
      expect(startedProcess.listenerCount('exit')).toBe(0)
      await expect(client.invoke(randomUUID(), 'projects:list', [])).resolves.toEqual([])
    } finally {
      client.close()
      vi.useRealTimers()
    }
  })
})

describe('native desktop requests over the authenticated connection', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function nativeSetup(
    onNativeRequest?: import('./desktop-native-contract').DesktopNativeHandler,
    operation: import('./desktop-native-contract').DesktopNativeOperation = {
      operation: 'save-dialog',
      options: {}
    }
  ) {
    const { currentDesktopCaller } = await import('./desktop-native-contract')
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['projects:list'],
        invoke: async (_name, invocation) => {
          const caller = currentDesktopCaller()!
          expect(caller.clientId).toBe(invocation.callerContext.clientId)
          return server.requestNative(operation, caller.clientId, caller.signal)
        }
      }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onNativeRequest,
      onEvent: () => {},
      onDisconnect: () => {}
    })
    return { server, client, document: randomUUID() }
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

  it.each(['capture', 'record-poll'] as const)(
    'preserves observation %s bytes through the production native request and command transports',
    async (method) => {
      // This is transport evidence, not a media decoder test. Exercise non-text bytes and the
      // maximum finalized-segment payload through the actual authenticated WebSocket codecs.
      const bytes = Uint8Array.from(
        { length: method === 'record-poll' ? 8 * 1024 * 1024 : 1024 },
        (_, index) => index % 256
      )
      const result =
        method === 'capture'
          ? { bytes }
          : {
              packets: [
                {
                  kind: 'segment',
                  sequence: 1,
                  value: {
                    bytes,
                    startMs: 0,
                    endMs: 1000,
                    width: 1280,
                    height: 720,
                    codec: 'vp8',
                    frameRate: 30
                  }
                }
              ],
              stopped: false
            }
      const operation: import('./desktop-native-contract').DesktopNativeOperation = {
        operation: 'observation',
        request:
          method === 'capture'
            ? {
                method,
                viewerOrigin: 'http://viewer-fixture.localhost:1234',
                projectOrigin: 'http://rv-fixture.localhost:1234'
              }
            : { method, recordingId: randomUUID(), ack: 0 }
      }
      const native = vi.fn(async () => result)
      const value = await nativeSetup(native, operation)
      try {
        const received = (await value.client.invoke(value.document, 'projects:list', [])) as
          { bytes: Uint8Array } | { packets: Array<{ value: { bytes: Uint8Array } }> }
        const receivedBytes = 'bytes' in received ? received.bytes : received.packets[0].value.bytes
        expect(receivedBytes).toBeInstanceOf(Uint8Array)
        // Compare identity as a boolean: the matcher otherwise deep-compares the entire segment
        // to suggest an alternative assertion, even when the negated identity check passes.
        expect(receivedBytes === bytes).toBe(false)
        expect(receivedBytes.byteLength).toBe(bytes.byteLength)
        expect(createHash('sha256').update(receivedBytes).digest('hex')).toBe(
          createHash('sha256').update(bytes).digest('hex')
        )
        if (method === 'record-poll') {
          expect(received).toMatchObject({
            packets: [
              {
                kind: 'segment',
                sequence: 1,
                value: { startMs: 0, endMs: 1000, width: 1280, height: 720, codec: 'vp8' }
              }
            ],
            stopped: false
          })
        }
        expect(native).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ clientId: value.document, request: operation }),
          expect.any(AbortSignal)
        )
        value.client.release(value.document)
        await expect(value.client.invoke(value.document, 'projects:list', [])).rejects.toThrow(
          'released'
        )
        expect(native).toHaveBeenCalledOnce()
      } finally {
        value.client.close()
      }
    }
  )

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
        await vi.waitFor(() => expect(value.client.commandNames()).toContain('projects:list'))
        value.client.close()
      }
    }
  )

  it('times out native dialogs, cancels the client operation and retains the command connection', async () => {
    let signal: AbortSignal | undefined
    const value = await nativeSetup(async (_request, callerSignal) => {
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
      expect(value.client.commandNames()).toEqual(['projects:list'])
    } finally {
      vi.useRealTimers()
      value.client.close()
    }
  })
})

describe('private desktop lifecycle authority', () => {
  it.each([true, false])(
    'only a client with its actual started child can prepare quit (owned=%s)',
    async (owned) => {
      const lifecycle = {
        request: vi.fn().mockResolvedValue({ fingerprint: 'a'.repeat(64) }),
        disconnect: vi.fn()
      }
      const server = await startDesktopRuntimeTransport({
        version: 'test',
        events: new ApplicationEventHub(),
        commands: { commandNames: () => [], invoke: async () => undefined },
        createLifecycle: () => lifecycle
      })
      cleanups.push(server.close)
      const client = await connectDesktopRuntime({
        endpoint: server.endpoint,
        ...(owned
          ? { startedProcess: Object.assign(new ChildProcess(), { pid: process.pid }) }
          : {}),
        onEvent: vi.fn(),
        onDisconnect: vi.fn()
      })
      cleanups.push(async () => client.close())
      expect(client.processId()).toBe(process.pid)
      expect(client.ownsRuntime()).toBe(owned)
      if (owned) {
        await expect(client.lifecycle({ operation: 'inspect' })).resolves.toEqual({
          fingerprint: 'a'.repeat(64)
        })
        expect(lifecycle.request).toHaveBeenCalledExactlyOnceWith({ operation: 'inspect' })
      } else {
        await expect(
          client.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) })
        ).rejects.toThrow('does not own')
        expect(lifecycle.request).not.toHaveBeenCalled()
      }
      client.close()
      await vi.waitFor(() => expect(lifecycle.disconnect).toHaveBeenCalledOnce())
    }
  )
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
