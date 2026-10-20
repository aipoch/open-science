import { hasPendingLifecycleSettlement, waitForLifecycleSettlement } from './lifecycle-settlement'
import type { RuntimeStartupOptions } from './desktop-runtime-info'
import { createLogger } from '@aipoch/diagnostics/node'
import { RUNTIME_PAYLOAD_CAPABILITY } from '../shared/runtime-payload-transfer'
import { runtimePayloadTransfers } from './runtime-payload-transfers'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { toApplicationCommandErrorEnvelope } from '../shared/application-command-contract'
import type { ArtifactReproducibilityCheckState } from '../shared/artifact-reproducibility'
import type { OfficePreviewRuntimeState } from '../shared/office-preview'
import type { MarketplaceDownloadProgress } from '../shared/specialist-marketplace'
import type { UploadTransferProgress } from '../shared/uploads'
import {
  WEB_RPC_PROTOCOL_VERSION,
  webRpcRequestSchema,
  type WebRpcResponse
} from '../shared/web-rpc-contract'
import { createApplicationCommandClient } from './application-command-client'
import type { ApplicationCommandByNameDispatcher } from './application-command-composition-contract'
import type { ApplicationEventSource } from './application-events'
import { createCallerContext, type CallerContext } from './caller-context'
import type { DatabaseStartupOwner } from './database/database-startup-owner'
import { listenForDesktop } from './desktop-connection'
import {
  desktopNativeResponseSchema,
  desktopNotificationActionSchema,
  desktopNotificationViewSchema,
  desktopUploadProgressSchema,
  parseDesktopNativeResult,
  withDesktopCaller,
  type DesktopNativeOperation
} from './desktop-native-contract'
import {
  desktopLifecycleRequestSchema,
  type DesktopLifecycleRequest
} from './desktop-runtime-lifecycle'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'
import { InternalWebEventStream } from './web-service/internal-web-event-stream'
import { createWebSocketFrameSender } from './websocket-frame-sender'

const logger = createLogger('desktop-runtime-transport')

const isLifecycleNative = (operation: string): boolean =>
  ['runtime-relaunch', 'renderer-flush', 'renderer-flush-aborted'].includes(operation)
const clientId = z.string().uuid()
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bootstrap'), desktopInstanceId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('startup-retry'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z
    .object({
      kind: z.literal('lifecycle'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      request: desktopLifecycleRequestSchema
    })
    .strict(),
  desktopNativeResponseSchema,
  desktopNotificationActionSchema,
  desktopNotificationViewSchema,
  webRpcRequestSchema.extend({
    kind: z.literal('session-event-read'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }),
  webRpcRequestSchema.extend({
    kind: z.literal('host-invoke'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    channel: z.string().min(1).max(256)
  }),
  webRpcRequestSchema.extend({
    kind: z.literal('invoke'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    clientId,
    channel: z.string().min(1).max(256)
  }),
  z
    .object({
      kind: z.literal('shutdown'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      generation: z.string().uuid(),
      pid: z.number().int().positive()
    })
    .strict(),
  z.object({ kind: z.literal('release'), clientId }).strict(),
  z.object({ kind: z.literal('resume'), streamId: z.string().uuid(), after: z.number() }).strict()
])
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256
const MAX_CLIENTS = 128
const CONTROLLER_RETIRE_DEADLINE_MS = 15_000

// This is a projection of the same command owners and event source used by Web and Task.
// Only a process authenticated over the OS-local endpoint may assert Electron caller identity.
export async function startDesktopRuntimeTransport(options: {
  version: string
  generation?: string
  launch?: 'desktop' | 'cli'
  entryPath?: string
  startupOptions?: RuntimeStartupOptions
  commands: ApplicationCommandByNameDispatcher
  events: ApplicationEventSource
  permissionApprovalPresence?: { acquire(): (() => void) | undefined }
  hostCommands?: ApplicationCommandByNameDispatcher
  startup?: Pick<DatabaseStartupOwner, 'getState' | 'retry' | 'subscribe'>
  requestShutdown?: () => void
  createLifecycle?: () => {
    request(operation: DesktopLifecycleRequest): Promise<unknown>
    disconnect(): void | Promise<void>
  }
  onNotificationAction?: (token: string, action: 'clicked' | 'closed') => void
  // True once the owning process has begun stopping; new Desktops must not adopt it.
  isStopping?: () => boolean
  // Upper bound for retiring a disconnected controller; defaults to CONTROLLER_RETIRE_DEADLINE_MS.
  controllerRetireDeadlineMs?: number
  onDisconnect?: () => void
  onConnect?: () => void
  onNotificationView?: (state: z.infer<typeof desktopNotificationViewSchema>) => Promise<void>
  onNotificationError?: (error: unknown) => void
}): Promise<
  Awaited<ReturnType<typeof listenForDesktop>> & {
    isConnected(): boolean
    hasActiveDocuments(): boolean
    reportOfficePreviewState(clientId: string, state: OfficePreviewRuntimeState): void
    reportMarketplaceProgress(clientId: string, progress: MarketplaceDownloadProgress): void
    reportReproducibilityCheck(clientId: string, state: ArtifactReproducibilityCheckState): void
    reportUploadProgress(clientId: string, progress: UploadTransferProgress): void
    requestNative(
      request: DesktopNativeOperation,
      clientId?: string,
      signal?: AbortSignal
    ): Promise<unknown>
  }
> {
  const commands: ApplicationCommandByNameDispatcher = {
    commandNames: () => options.commands.commandNames(),
    invoke: (name, invocation) =>
      withDesktopCaller(
        { clientId: invocation.callerContext.clientId, signal: invocation.callerLease.signal },
        () => options.commands.invoke(name, invocation)
      )
  }
  const stream = new InternalWebEventStream()
  const connections = new Map<WebSocket, Map<string, CallerContext>>()
  let controller:
    | {
        id: string
        sockets: Set<WebSocket>
        lifecycle: ReturnType<NonNullable<typeof options.createLifecycle>> | undefined
        retiring: boolean
        operations: Set<Promise<unknown>>
      }
    | undefined
  const nativeConnections = new Map<
    WebSocket,
    (request: DesktopNativeOperation, clientId?: string, signal?: AbortSignal) => Promise<unknown>
  >()
  let shutdownRequested = false
  const isStopping = (): boolean => shutdownRequested || (options.isStopping?.() ?? false)
  const activeSocket = (): WebSocket | undefined =>
    [...(controller?.sockets ?? []), ...connections.keys()].find(
      (socket) => socket.readyState === WebSocket.OPEN
    )
  // The retiring fence is bounded and never sticky: a stuck operation, a never-converging teardown or a
  // throwing disconnect is logged and abandoned so the next Desktop can take control.
  const retireController = async (previous: NonNullable<typeof controller>): Promise<void> => {
    const deadline = options.controllerRetireDeadlineMs ?? CONTROLLER_RETIRE_DEADLINE_MS
    const bounded = async (label: string, work: () => Promise<unknown>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          work(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              logger.warn('desktop controller retirement step timed out', { step: label })
              resolve()
            }, deadline)
            timer.unref?.()
          })
        ])
      } catch (error) {
        logger.warn('desktop controller retirement step failed', {
          step: label,
          message: error instanceof Error ? error.message : String(error)
        })
      } finally {
        clearTimeout(timer)
      }
    }
    await bounded('operations', () => Promise.allSettled([...previous.operations]))
    await bounded('settlement', () => waitForLifecycleSettlement({ timeoutMs: deadline }))
    await bounded('disconnect', async () => previous.lifecycle?.disconnect())
    if (controller === previous) controller = undefined
  }
  const senders = new WeakMap<WebSocket, ReturnType<typeof createWebSocketFrameSender>>()
  const send = (socket: WebSocket, frame: string, onSent?: () => void): void => {
    senders.get(socket)?.send(frame, onSent)
  }
  const reportDocument = (clientId: string, channel: string, payload: unknown): void => {
    for (const [socket, documents] of connections)
      if (documents.has(clientId))
        send(socket, stringifyRpcJson({ kind: 'document-event', clientId, channel, payload }))
  }
  const unsubscribe = options.events.subscribe((event) => {
    const frame = stream.publish(event)
    for (const socket of connections.keys()) send(socket, frame)
  })
  try {
    const listener = await listenForDesktop(
      options.version,
      (socket) => {
        senders.set(
          socket,
          createWebSocketFrameSender(socket, (failure) => {
            logger.warn('desktop runtime transport terminated', failure)
          })
        )
        let unsubscribeStartup: (() => void) | undefined
        let desktopInstanceId: string | undefined
        const controls = (): boolean =>
          Boolean(
            controller &&
            !controller.retiring &&
            controller.id === desktopInstanceId &&
            controller.sockets.has(socket)
          )
        const connectionId = randomUUID()
        const client = createApplicationCommandClient()
        const hostCaller = createCallerContext({
          clientId: `host:${connectionId}`,
          lifecycleClientId: `electron:host:${connectionId}`,
          leaseId: `host:${connectionId}`,
          surface: 'electron',
          location: 'local',
          principalKind: 'human',
          actionOrigin: 'human',
          isAuthorizationCurrent: () => !closed
        })
        const callers = new Map<string, CallerContext>()
        const approvalPresence = new Map<string, () => void>()
        const acquirePresence = (id: string): void => {
          if (approvalPresence.has(id)) return
          const release = options.permissionApprovalPresence?.acquire()
          if (release) approvalPresence.set(id, release)
        }
        const pending = new Set<number>()
        let nativeId = 0
        const native = new Map<
          number,
          { clientId?: string; resolve(value: unknown): void; reject(error: Error): void }
        >()
        const invokeNative = async (
          request: DesktopNativeOperation,
          clientId?: string,
          signal?: AbortSignal
        ): Promise<unknown> => {
          if (
            closed ||
            (isLifecycleNative(request.operation) ? !controls() : !connections.has(socket))
          )
            throw new Error('Desktop is not connected.')
          if (clientId && !callers.has(clientId))
            throw new Error('Desktop document is no longer available.')
          signal?.throwIfAborted()
          if (native.size >= 32) throw new Error('Too many pending native desktop operations.')
          const id = ++nativeId
          let timer: ReturnType<typeof setTimeout> | undefined
          const abort = (): void => {
            send(socket, stringifyRpcJson({ kind: 'native-cancel', id }))
            native.get(id)?.reject(new Error('Native desktop operation was cancelled.'))
          }
          try {
            const result = await new Promise<unknown>((resolve, reject) => {
              native.set(id, { clientId, resolve, reject })
              signal?.addEventListener('abort', abort, { once: true })
              timer = setTimeout(
                abort,
                request.operation === 'conversation-pdf'
                  ? request.timeoutMs + 1000
                  : request.operation === 'reviewer-render'
                    ? 121_000
                    : request.operation.startsWith('notification-') ||
                        request.operation === 'office-frame' ||
                        request.operation === 'process-memory'
                      ? 5_000
                      : 300_000
              )
              send(socket, stringifyRpcJson({ kind: 'native-request', id, clientId, request }))
            })
            signal?.throwIfAborted()
            if (closed || (clientId && !callers.has(clientId)))
              throw new Error('Desktop document is no longer available.')
            return parseDesktopNativeResult(request, result)
          } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            native.delete(id)
          }
        }
        let highestRequestId = 0
        let closed = false
        let shutdownPending = false
        // A released renderer document never regains authority on this attachment.
        const released = new Set<string>()
        const cleanup = (): void => {
          if (closed) return
          closed = true
          const wasAttached = connections.delete(socket)
          if (wasAttached && connections.size === 0) options.onDisconnect?.()
          for (const operation of native.values())
            operation.reject(new Error('Desktop disconnected during a native operation.'))
          native.clear()
          for (const release of approvalPresence.values()) release()
          approvalPresence.clear()
          callers.clear()
          unsubscribeStartup?.()
          client.dispose()
          nativeConnections.delete(socket)
          const previous = controller
          if (
            previous?.sockets.delete(socket) &&
            previous.sockets.size === 0 &&
            !shutdownRequested
          ) {
            previous.retiring = true
            void retireController(previous)
          }
        }
        socket.once('close', cleanup)
        socket.once('error', cleanup)
        socket.on('message', (bytes, binary) => {
          if (closed) return
          let message: z.infer<typeof requestSchema>
          try {
            if (binary) throw new Error('Expected a JSON text frame.')
            message = requestSchema.parse(parseRpcJson(bytes.toString()))
          } catch {
            socket.close(1008, 'Invalid desktop request.')
            cleanup()
            return
          }
          if (message.kind === 'bootstrap') {
            if (desktopInstanceId && desktopInstanceId !== message.desktopInstanceId) {
              socket.close(1008)
              return
            }
            desktopInstanceId = message.desktopInstanceId
            controller ??= {
              id: desktopInstanceId,
              sockets: new Set(),
              lifecycle: options.createLifecycle?.(),
              retiring: false,
              operations: new Set()
            }
            if (controller.id === desktopInstanceId && !controller.retiring)
              controller.sockets.add(socket)
            nativeConnections.set(socket, invokeNative)
            connections.set(socket, callers)
            send(
              socket,
              stringifyRpcJson({
                kind: 'bootstrap',
                launch: options.launch ?? 'cli',
                control: controls() && !isStopping() ? 'granted' : 'held',
                ...(!controls() || isStopping()
                  ? {
                      controlReason: isStopping()
                        ? 'runtime-stopping'
                        : controller?.retiring
                          ? 'operation-pending'
                          : 'controller-held'
                    }
                  : {}),
                generation: listener.endpoint.generation,
                entryPath: options.entryPath ?? process.execPath,
                startupOptions: options.startupOptions ?? {
                  configRoot: process.cwd(),
                  dataRoot: process.cwd(),
                  profilePath: process.cwd(),
                  port: 0,
                  host: '127.0.0.1',
                  credentialStore: 'os'
                },
                rpcCapabilities: [RUNTIME_PAYLOAD_CAPABILITY],
                pid: process.pid,
                ...(options.startup ? { startup: options.startup.getState() } : {}),
                rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
                rpcChannels: options.commands.commandNames(),
                eventStream: stream.cursor()
              })
            )
            unsubscribeStartup?.()
            unsubscribeStartup = options.startup?.subscribe((state) => {
              if (state.phase === 'ready') for (const id of callers.keys()) acquirePresence(id)
              send(
                socket,
                stringifyRpcJson({
                  kind: 'startup-state',
                  state,
                  rpcChannels: options.commands.commandNames()
                })
              )
            })
            options.onConnect?.()
            return
          }
          if (message.kind === 'notification-view') {
            if (activeSocket() === socket)
              void options
                .onNotificationView?.(message)
                .catch((error) => options.onNotificationError?.(error))
            return
          }
          if (message.kind === 'notification-action') {
            if (activeSocket() === socket)
              options.onNotificationAction?.(message.token, message.action)
            return
          }
          if (message.kind === 'native-response') {
            const operation = native.get(message.id)
            // A cancelled dialog can finish later. Its result must never reach a new request.
            if (operation) {
              if (message.outcome.ok) operation.resolve(message.outcome.result)
              else operation.reject(new Error(message.outcome.message))
            }
            return
          }
          if (message.kind === 'resume') {
            for (const frame of stream.resume(message)) send(socket, frame)
            return
          }
          if (message.kind === 'release') {
            released.add(message.clientId)
            for (const [id, operation] of native) {
              if (operation.clientId !== message.clientId) continue
              send(socket, stringifyRpcJson({ kind: 'native-cancel', id }))
              operation.reject(
                new Error('Desktop document was released during a native operation.')
              )
            }
            // Bound retired document identities as well as active ones.
            if (released.size > 4096) {
              socket.close(1008, 'Reconnect desktop attachment.')
              cleanup()
              return
            }
            approvalPresence.get(message.clientId)?.()
            approvalPresence.delete(message.clientId)
            callers.delete(message.clientId)
            client.releaseClient('electron', message.clientId)
            return
          }
          if (message.id <= highestRequestId || pending.size >= MAX_PENDING_REQUESTS) {
            socket.close(1008, 'Invalid or excessive desktop requests.')
            cleanup()
            return
          }
          highestRequestId = message.id
          const request = message
          let responseFailureReason: 'response-serialization' | 'response-send-failure' =
            'response-serialization'
          const respond = (response: WebRpcResponse, onSent?: () => void): void => {
            responseFailureReason = 'response-serialization'
            let frame = stringifyRpcJson({ kind: 'response', id: request.id, ...response })
            // A command result can grow during JSON encoding. Reject only this response;
            // do not drop unrelated in-flight commands or retry a completed mutation.
            const frameBytes = Buffer.byteLength(frame)
            if (frameBytes > MAX_FRAME_BYTES) {
              logger.warn('desktop runtime response exceeds transport budget', {
                channel: 'channel' in request ? request.channel : request.kind,
                requestId: request.id,
                byteLength: frameBytes,
                maxFrameBytes: MAX_FRAME_BYTES
              })
              frame = stringifyRpcJson({
                kind: 'response',
                id: request.id,
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: false,
                error: {
                  code: 'command-failed',
                  message: 'Desktop runtime response exceeds the transport byte budget.'
                }
              })
            }
            responseFailureReason = 'response-send-failure'
            send(socket, frame, onSent)
          }
          const requiresControl =
            request.kind === 'shutdown' ||
            (request.kind === 'lifecycle' && request.request.operation !== 'inspect') ||
            (request.kind === 'host-invoke' &&
              ['desktop:update-gate', 'desktop:update-abort'].includes(request.channel))
          // Recovery and rollback commands are never blocked by a pending settlement: the lifecycle
          // owner defers reopening admission until it is safe, and settlement waits are bounded.
          // Only starting new preparation (prepare/hold/update-gate) waits for a live teardown.
          const isRecovery =
            request.kind === 'shutdown' ||
            (request.kind === 'lifecycle' &&
              ['abort', 'release'].includes(request.request.operation)) ||
            (request.kind === 'host-invoke' && request.channel === 'desktop:update-abort')
          // Shutdown is the last-resort escape hatch and is allowed even over a running operation.
          const overlapsOperation =
            request.kind !== 'shutdown' && Boolean(controller?.operations.size)
          if (
            requiresControl &&
            (!controls() || overlapsOperation || (!isRecovery && hasPendingLifecycleSettlement()))
          ) {
            respond({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: false,
              error: {
                code: 'command-unavailable',
                message:
                  'Another Desktop controls this Runtime, or its lifecycle operation is still settling.'
              }
            })
            return
          }
          if ((shutdownPending || shutdownRequested) && request.kind !== 'shutdown') {
            respond({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: false,
              error: { code: 'command-unavailable', message: 'Desktop runtime is shutting down.' }
            })
            return
          }
          if (request.kind === 'startup-retry') {
            pending.add(request.id)
            void (async () => {
              try {
                if (!options.startup) throw new Error('Startup recovery is unavailable.')
                const result = await options.startup.retry()
                respond({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, ok: true, result })
              } catch (error) {
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: false,
                  error: toApplicationCommandErrorEnvelope(error)
                })
              } finally {
                pending.delete(request.id)
              }
            })()
            return
          }
          if (request.kind === 'lifecycle') {
            pending.add(request.id)
            const owner = request.request.operation === 'inspect' ? undefined : controller
            const operation = (async () => {
              try {
                const lifecycle = controller?.lifecycle
                if (!lifecycle) throw new Error('Desktop quit coordination is unavailable.')
                const result = await lifecycle.request(request.request)
                respond({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, ok: true, result })
              } catch (error) {
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: false,
                  error: toApplicationCommandErrorEnvelope(error)
                })
              } finally {
                pending.delete(request.id)
              }
            })()
            owner?.operations.add(operation)
            void operation.finally(() => owner?.operations.delete(operation)).catch(() => undefined)
            return
          }
          if (request.kind === 'shutdown') {
            if (
              request.generation !== listener.endpoint.generation ||
              request.pid !== process.pid ||
              !options.requestShutdown
            ) {
              respond({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: false,
                error: {
                  code: 'command-unavailable',
                  message: 'The owned desktop runtime cannot be stopped through this attachment.'
                }
              })
              return
            }
            shutdownPending = true
            respond({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, ok: true, result: null }, () => {
              if (!shutdownRequested) {
                shutdownRequested = true
                setImmediate(options.requestShutdown!)
              }
            })
            return
          }
          if (request.kind === 'host-invoke' || request.kind === 'session-event-read') {
            pending.add(request.id)
            const owner = requiresControl ? controller : undefined
            const operation = (async () => {
              try {
                const eventRead = request.kind === 'session-event-read'
                const dispatcher = eventRead ? commands : options.hostCommands
                if (!dispatcher) throw new Error('Desktop host commands are unavailable.')
                const result = await client.invoke(
                  dispatcher,
                  eventRead ? 'sessions:load-one' : request.channel,
                  hostCaller,
                  request.args,
                  request
                )
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: true,
                  result
                })
              } catch (error) {
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: false,
                  error: toApplicationCommandErrorEnvelope(error)
                })
              } finally {
                pending.delete(request.id)
              }
            })()
            owner?.operations.add(operation)
            void operation.finally(() => owner?.operations.delete(operation)).catch(() => undefined)
            return
          }
          if (released.has(request.clientId)) {
            respond({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: false,
              error: {
                code: 'command-unavailable',
                message: 'The renderer document has been released.'
              }
            })
            return
          }
          if (!options.commands.commandNames().includes(request.channel)) {
            respond({
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: false,
              error: {
                code: 'method_not_found',
                message: 'Unknown desktop application command.'
              }
            })
            return
          }
          let caller = callers.get(request.clientId)
          if (!caller) {
            if (callers.size >= MAX_CLIENTS) {
              socket.close(1008, 'Too many renderer documents.')
              cleanup()
              return
            }
            caller = createCallerContext({
              clientId: request.clientId,
              lifecycleClientId: `electron:${connectionId}:${request.clientId}`,
              leaseId: `${connectionId}:${request.clientId}`,
              surface: 'electron',
              location: 'local',
              principalKind: 'human',
              actionOrigin: 'human',
              isAuthorizationCurrent: () => !closed && !released.has(request.clientId)
            })
            callers.set(request.clientId, caller)
            acquirePresence(request.clientId)
          }
          pending.add(request.id)
          void client
            .invoke(commands, request.channel, caller, request.args, request)
            .then(
              (result) =>
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: true,
                  result
                }),
              (error: unknown) =>
                respond({
                  protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                  ok: false,
                  error: toApplicationCommandErrorEnvelope(error)
                })
            )
            .catch(() => {
              logger.warn('desktop runtime transport terminated', { reason: responseFailureReason })
              socket.terminate()
              cleanup()
            })
            .finally(() => pending.delete(request.id))
        })
      },
      options.generation
    )
    return {
      endpoint: listener.endpoint,
      hasActiveDocuments: () =>
        [...connections].some(
          ([socket, documents]) => socket.readyState === WebSocket.OPEN && documents.size > 0
        ),
      isConnected: () => activeSocket() !== undefined,
      reportOfficePreviewState: (clientId, payload) =>
        reportDocument(clientId, 'office-preview:state', payload),
      reportMarketplaceProgress: (clientId, payload) =>
        reportDocument(clientId, 'specialist:marketplace-download-progress', payload),
      reportReproducibilityCheck: (clientId, payload) =>
        reportDocument(clientId, 'artifacts:reproducibility-check-changed', payload),
      reportUploadProgress: (clientId, progress) => {
        for (const [socket, documents] of connections)
          if (documents.has(clientId))
            send(
              socket,
              stringifyRpcJson(
                desktopUploadProgressSchema.parse({ kind: 'upload-progress', clientId, progress })
              )
            )
      },
      requestNative: async (request, clientId, signal) => {
        if (isLifecycleNative(request.operation)) {
          const socket =
            controller && !controller.retiring
              ? [...controller.sockets].find((socket) => socket.readyState === WebSocket.OPEN)
              : undefined
          if (!socket) throw new Error('No lifecycle controller is connected.')
          return nativeConnections.get(socket)!(request, clientId, signal)
        }
        const socket = clientId
          ? [...connections].find(([, documents]) => documents.has(clientId))?.[0]
          : activeSocket()
        const requestNative = socket && nativeConnections.get(socket)
        if (!requestNative)
          throw new Error('This operation requires a connected Open-Science desktop.')
        return requestNative(request, clientId, signal)
      },
      close: async () => {
        unsubscribe()
        await listener.close()
        await runtimePayloadTransfers.settleReleased()
      }
    }
  } catch (error) {
    unsubscribe()
    throw error
  }
}
