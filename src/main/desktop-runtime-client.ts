import { desktopDatabaseStartupSchema, desktopStartupEventSchema } from './desktop-startup-contract'
import type { DatabaseStartupState } from '../shared/database-startup'
import type { DesktopLifecycleRequest } from './desktop-runtime-lifecycle'
import type { UploadTransferProgress } from '../shared/uploads'
import {
  desktopNativeRequestSchema,
  desktopNotificationViewSchema,
  desktopDocumentEventSchema,
  desktopUploadProgressSchema,
  desktopNativeCancelSchema,
  type DesktopNativeHandler
} from './desktop-native-contract'
import type { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { z } from 'zod'
import {
  WEB_RPC_PROTOCOL_VERSION,
  webRpcBootstrapSchema,
  webRpcEventSchema,
  webRpcEventReadySchema,
  webRpcEventHeartbeatSchema,
  webRpcEventResyncRequiredSchema,
  webRpcResponseSchema
} from '../shared/web-rpc-contract'
import { parseApplicationCommandError } from '../shared/application-command-contract'
import { connectToDesktopEndpoint, type DesktopEndpoint } from './desktop-connection'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'

const bootstrapSchema = webRpcBootstrapSchema
  .pick({
    rpcProtocolVersion: true,
    eventStream: true
  })
  .extend({
    kind: z.literal('bootstrap'),
    startup: desktopDatabaseStartupSchema.optional(),
    pid: z.number().int().positive(),
    rpcChannels: z.array(z.string())
  })
  .strict()
const eventSchema = z.discriminatedUnion('kind', [
  webRpcEventSchema.extend({ channel: z.string().min(1) }),
  webRpcEventReadySchema,
  webRpcEventHeartbeatSchema,
  webRpcEventResyncRequiredSchema
])

export type DesktopRuntimeClient = Readonly<{
  commandNames(): readonly string[]
  startupState(): DatabaseStartupState
  retryStartup(): Promise<DatabaseStartupState>
  processId(): number
  ownsRuntime(): boolean
  lifecycle(request: DesktopLifecycleRequest): Promise<unknown>
  invokeHost(channel: string, args?: readonly unknown[]): Promise<unknown>
  invoke(clientId: string, channel: string, args: readonly unknown[]): Promise<unknown>
  release(clientId: string): void
  notificationAction(token: string, action: 'clicked' | 'closed'): void
  notificationView(reason: 'view' | 'focus' | 'window-created', visibleSessionId?: string): void
  close(): void
  quit(): Promise<void>
}>

// No business state lives here. In-flight mutations are never automatically retried after a
// disconnect: the caller must reload current state before deciding whether to submit again.
export async function connectDesktopRuntime(options: {
  endpoint: DesktopEndpoint
  // Only the launcher that actually spawned this child may supply its handle.
  startedProcess?: ChildProcess
  onNativeRequest?: DesktopNativeHandler
  onStartupState?: (state: DatabaseStartupState) => void
  onDocumentEvent?: (event: z.infer<typeof desktopDocumentEventSchema>) => void
  onUploadProgress?: (clientId: string, progress: UploadTransferProgress) => void
  onEvent(event: { channel: string; payload: unknown }): void
  onDisconnect(error: Error): void
}): Promise<DesktopRuntimeClient> {
  const socket = await connectToDesktopEndpoint(options.endpoint)
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const native = new Map<number, AbortController>()
  let highestNativeId = 0
  let requestId = 0
  let channels: readonly string[] = []
  let cursor: { streamId: string; latestSequence: number } | undefined
  let startupState: DatabaseStartupState = { phase: 'checking' }
  let runtimePid = 0
  let ownedChild: ChildProcess | undefined
  let quitting = false
  let quitPromise: Promise<void> | undefined
  let closed = false
  let initialized = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const fail = (error: Error): void => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    rejectReady(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    for (const operation of native.values()) operation.abort()
    native.clear()
    socket.terminate()
    if (initialized && !quitting) options.onDisconnect(error)
  }
  const timer = setTimeout(() => fail(new Error('Desktop runtime bootstrap timed out.')), 5_000)
  timer.unref()
  const send = (message: unknown): void => {
    if (closed || socket.readyState !== WebSocket.OPEN)
      throw new Error('Desktop runtime is disconnected.')
    const serialized = stringifyRpcJson(message)
    if (socket.bufferedAmount + Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
      throw new Error('Desktop runtime request exceeds the transport byte budget.')
    }
    socket.send(serialized)
  }
  socket.on('message', (bytes, binary) => {
    try {
      if (binary) throw new Error('Unexpected binary desktop frame.')
      const frame = parseRpcJson(bytes.toString())
      if (!initialized) {
        const bootstrap = bootstrapSchema.parse(frame)
        startupState = bootstrap.startup ?? { phase: 'ready' }
        runtimePid = bootstrap.pid
        channels = Object.freeze([...bootstrap.rpcChannels])
        cursor = bootstrap.eventStream
        const child = options.startedProcess
        if (child?.pid === bootstrap.pid && child.exitCode === null && child.signalCode === null)
          ownedChild = child
        initialized = true
        clearTimeout(timer)
        resolveReady()
        return
      }
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'startup-state') {
        const event = desktopStartupEventSchema.parse(frame)
        channels = Object.freeze([...event.rpcChannels])
        startupState = event.state
        options.onStartupState?.(event.state)
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'upload-progress'
      ) {
        const event = desktopUploadProgressSchema.parse(frame)
        options.onUploadProgress?.(event.clientId, event.progress)
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'document-event'
      ) {
        const event = desktopDocumentEventSchema.parse(frame)
        options.onDocumentEvent?.(event)
        return
      }
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'native-cancel') {
        const cancelled = desktopNativeCancelSchema.parse(frame)
        native.get(cancelled.id)?.abort()
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'native-request'
      ) {
        const request = desktopNativeRequestSchema.parse(frame)
        if (request.id <= highestNativeId || native.size >= 32)
          throw new Error('Invalid or excessive native desktop requests.')
        highestNativeId = request.id
        const controller = new AbortController()
        native.set(request.id, controller)
        void (async () => {
          try {
            if (!options.onNativeRequest)
              throw new Error('Native desktop operations are unavailable.')
            const result = await options.onNativeRequest(request, controller.signal)
            if (!closed && !controller.signal.aborted)
              send({ kind: 'native-response', id: request.id, outcome: { ok: true, result } })
          } catch (error) {
            if (!closed && !controller.signal.aborted)
              send({
                kind: 'native-response',
                id: request.id,
                outcome: {
                  ok: false,
                  message: (error instanceof Error ? error.message : String(error)).slice(0, 32768)
                }
              })
          } finally {
            native.delete(request.id)
          }
        })().catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
        return
      }
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'response') {
        const { id, kind: _kind, ...body } = frame as Record<string, unknown>
        void _kind
        const response = webRpcResponseSchema.parse(body)
        if (typeof id !== 'number' || !pending.has(id))
          throw new Error('Unexpected desktop response identity.')
        const request = pending.get(id)!
        pending.delete(id)
        if (response.ok) request.resolve(response.result)
        else
          request.reject(
            parseApplicationCommandError(response.error) ?? new Error(response.error.message)
          )
        return
      }
      const event = eventSchema.parse(frame)
      if (event.kind === 'resync-required' || event.streamId !== cursor!.streamId) {
        throw new Error('Desktop runtime event history changed; reload required.')
      }
      if (event.kind === 'event') {
        if (event.sequence <= cursor!.latestSequence) return
        if (event.sequence !== cursor!.latestSequence + 1) {
          send({ kind: 'resume', streamId: cursor!.streamId, after: cursor!.latestSequence })
          return
        }
        options.onEvent({ channel: event.channel, payload: event.payload })
        cursor = { streamId: event.streamId, latestSequence: event.sequence }
      } else if (event.latestSequence > cursor!.latestSequence) {
        send({ kind: 'resume', streamId: cursor!.streamId, after: cursor!.latestSequence })
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  socket.once('close', () => fail(new Error('Desktop runtime connection closed.')))
  socket.once('error', fail)
  try {
    send({ kind: 'bootstrap' })
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
  await ready
  const request = (frame: Record<string, unknown>): { id: number; response: Promise<unknown> } => {
    if (pending.size >= 256) throw new Error('Too many pending desktop requests.')
    const id = ++requestId
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        send({ ...frame, id })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
    return { id, response }
  }
  const close = (): void => {
    initialized = false
    fail(new Error('Desktop runtime client closed.'))
  }
  const quit = async (): Promise<void> => {
    const child = ownedChild
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      close()
      return
    }
    quitting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let onExit!: (code: number | null, signal: NodeJS.Signals | null) => void
    const exited = new Promise<void>((resolve, reject) => {
      onExit = (code, signal) =>
        code === 0 && signal === null
          ? resolve()
          : reject(new Error('The owned runtime exited without completing a clean shutdown.'))
      child.once('exit', onExit)
      timer = setTimeout(
        () =>
          reject(
            new Error(
              'The owned runtime did not stop within 15 seconds. No process signal was sent.'
            )
          ),
        15_000
      )
    })
    let shutdownRequestId: number | undefined
    try {
      // The endpoint authenticates a fixed generation. Never rediscover or signal a PID here.
      const shutdown = request({
        kind: 'shutdown',
        generation: options.endpoint.generation,
        pid: child.pid
      })
      shutdownRequestId = shutdown.id
      await Promise.all([shutdown.response, exited])
      close()
    } finally {
      clearTimeout(timer)
      child.off('exit', onExit)
      if (shutdownRequestId !== undefined) pending.delete(shutdownRequestId)
      quitting = false
    }
  }
  return {
    commandNames: () => channels,
    startupState: () => startupState,
    retryStartup: async () =>
      desktopDatabaseStartupSchema.parse(await request({ kind: 'startup-retry' }).response),
    processId: () => runtimePid,
    ownsRuntime: () =>
      Boolean(ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null),
    lifecycle: async (operation) => {
      if (!ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode !== null)
        throw new Error('This desktop does not own the connected server lifecycle.')
      return request({ kind: 'lifecycle', request: operation }).response
    },
    notificationView: (reason, visibleSessionId) => {
      if (!closed)
        send(
          desktopNotificationViewSchema.parse({
            kind: 'notification-view',
            reason,
            visibleSessionId
          })
        )
    },
    notificationAction: (token, action) => {
      if (!closed) send({ kind: 'notification-action', token, action })
    },
    invokeHost: async (channel, args = []) =>
      request({
        kind: 'host-invoke',
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        channel,
        args
      }).response,
    invoke: async (clientId, channel, args) => {
      if (!channels.includes(channel))
        throw new Error(`Desktop runtime command is unavailable: ${channel}`)
      return request({
        kind: 'invoke',
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        clientId,
        channel,
        args
      }).response
    },
    release: (clientId) => {
      if (closed) return
      try {
        send({ kind: 'release', clientId })
      } catch (error) {
        // If one document cannot be revoked reliably, revoke the entire attachment.
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    },
    close,
    // Called only after desktop confirmation and durability barriers; ordinary detach never stops.
    quit: () =>
      (quitPromise ??= quit().catch((error) => {
        quitPromise = undefined
        throw error
      }))
  }
}
