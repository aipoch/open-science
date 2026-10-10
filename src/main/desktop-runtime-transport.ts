import type { DatabaseStartupOwner } from './database/database-startup-owner'
import {
  desktopLifecycleRequestSchema,
  type DesktopLifecycleRequest
} from './desktop-runtime-lifecycle'
import type { OfficePreviewRuntimeState } from '../shared/office-preview'
import type { MarketplaceDownloadProgress } from '../shared/specialist-marketplace'
import type { ArtifactReproducibilityCheckState } from '../shared/artifact-reproducibility'
import type { UploadTransferProgress } from '../shared/uploads'
import {
  desktopNativeResponseSchema,
  desktopNotificationActionSchema,
  desktopNotificationViewSchema,
  desktopUploadProgressSchema,
  withDesktopCaller,
  parseDesktopNativeResult,
  type DesktopNativeOperation
} from './desktop-native-contract'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { z } from 'zod'
import {
  WEB_RPC_PROTOCOL_VERSION,
  webRpcRequestSchema,
  type WebRpcResponse
} from '../shared/web-rpc-contract'
import { toApplicationCommandErrorEnvelope } from '../shared/application-command-contract'
import type { ApplicationCommandByNameDispatcher } from './application-command-composition'
import { createApplicationCommandClient } from './application-command-client'
import type { ApplicationEventSource } from './application-events'
import { createCallerContext, type CallerContext } from './caller-context'
import { listenForDesktop } from './desktop-connection'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'
import { InternalWebEventStream } from './web-service/internal-web-event-stream'

const clientId = z.string().uuid()
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bootstrap') }).strict(),
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
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256
const MAX_CLIENTS = 128

// This is a projection of the same command owners and event source used by Web and Task.
// Only a process authenticated over the OS-local endpoint may assert Electron caller identity.
export async function startDesktopRuntimeTransport(options: {
  version: string
  commands: ApplicationCommandByNameDispatcher
  events: ApplicationEventSource
  permissionApprovalPresence?: { acquire(): (() => void) | undefined }
  hostCommands?: ApplicationCommandByNameDispatcher
  startup?: Pick<DatabaseStartupOwner, 'getState' | 'retry' | 'subscribe'>
  requestShutdown?: () => void
  createLifecycle?: () => {
    request(operation: DesktopLifecycleRequest): Promise<unknown>
    disconnect(): void
  }
  onNotificationAction?: (token: string, action: 'clicked' | 'closed') => void
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
  let active: WebSocket | undefined
  let currentDocuments: Map<string, CallerContext> | undefined
  let reportUploadProgress:
    ((clientId: string, progress: UploadTransferProgress) => void) | undefined
  let reportOfficePreviewState:
    ((clientId: string, state: OfficePreviewRuntimeState) => void) | undefined
  let reportMarketplaceProgress:
    ((clientId: string, progress: MarketplaceDownloadProgress) => void) | undefined
  let reportReproducibilityCheck:
    ((clientId: string, state: ArtifactReproducibilityCheckState) => void) | undefined
  let shutdownRequested = false
  let requestNative:
    | ((
        request: DesktopNativeOperation,
        clientId?: string,
        signal?: AbortSignal
      ) => Promise<unknown>)
    | undefined
  const send = (socket: WebSocket, frame: string): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES) {
      socket.terminate()
      return
    }
    socket.send(frame)
  }
  const unsubscribe = options.events.subscribe((event) => {
    const frame = stream.publish(event)
    if (active) send(active, frame)
  })
  try {
    const listener = await listenForDesktop(options.version, (socket) => {
      let unsubscribeStartup: (() => void) | undefined
      const lifecycle = options.createLifecycle?.()
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
        if (closed || active !== socket) throw new Error('Desktop is not connected.')
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
      // A released renderer document never regains authority on this attachment.
      const released = new Set<string>()
      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (active === socket) {
          active = undefined
          currentDocuments = undefined
          requestNative = undefined
          reportUploadProgress = undefined
          reportOfficePreviewState = undefined
          reportMarketplaceProgress = undefined
          reportReproducibilityCheck = undefined
          options.onDisconnect?.()
        }
        for (const operation of native.values())
          operation.reject(new Error('Desktop disconnected during a native operation.'))
        native.clear()
        for (const release of approvalPresence.values()) release()
        approvalPresence.clear()
        callers.clear()
        unsubscribeStartup?.()
        client.dispose()
        if (!shutdownRequested) lifecycle?.disconnect()
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
          active = socket
          currentDocuments = callers
          requestNative = invokeNative
          reportOfficePreviewState = (clientId, payload) => {
            if (closed || active !== socket || !callers.has(clientId)) return
            send(
              socket,
              stringifyRpcJson({
                kind: 'document-event',
                clientId,
                channel: 'office-preview:state',
                payload
              })
            )
          }
          reportMarketplaceProgress = (clientId, payload) => {
            if (closed || active !== socket || !callers.has(clientId)) return
            send(
              socket,
              stringifyRpcJson({
                kind: 'document-event',
                clientId,
                channel: 'specialist:marketplace-download-progress',
                payload
              })
            )
          }
          reportReproducibilityCheck = (clientId, payload) => {
            if (closed || active !== socket || !callers.has(clientId)) return
            send(
              socket,
              stringifyRpcJson({
                kind: 'document-event',
                clientId,
                channel: 'artifacts:reproducibility-check-changed',
                payload
              })
            )
          }
          reportUploadProgress = (clientId, progress) => {
            if (closed || active !== socket || !callers.has(clientId)) return
            send(
              socket,
              stringifyRpcJson(
                desktopUploadProgressSchema.parse({
                  kind: 'upload-progress',
                  clientId,
                  progress
                })
              )
            )
          }
          send(
            socket,
            stringifyRpcJson({
              kind: 'bootstrap',
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
          if (active === socket)
            void options
              .onNotificationView?.(message)
              .catch((error) => options.onNotificationError?.(error))
          return
        }
        if (message.kind === 'notification-action') {
          if (active === socket) options.onNotificationAction?.(message.token, message.action)
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
            operation.reject(new Error('Desktop document was released during a native operation.'))
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
        const respond = (response: WebRpcResponse): void => {
          send(socket, stringifyRpcJson({ kind: 'response', id: request.id, ...response }))
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
          void (async () => {
            try {
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
          respond({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, ok: true, result: null })
          if (!shutdownRequested) {
            shutdownRequested = true
            setImmediate(options.requestShutdown)
          }
          return
        }
        if (request.kind === 'host-invoke') {
          pending.add(request.id)
          void (async () => {
            try {
              if (!options.hostCommands) throw new Error('Desktop host commands are unavailable.')
              const result = await client.invoke(
                options.hostCommands,
                request.channel,
                hostCaller,
                request.args
              )
              respond({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: true,
                result: result ?? null
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
          .invoke(commands, request.channel, caller, request.args)
          .then(
            (result) =>
              respond({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: true,
                result: result ?? null
              }),
            (error: unknown) =>
              respond({
                protocolVersion: WEB_RPC_PROTOCOL_VERSION,
                ok: false,
                error: toApplicationCommandErrorEnvelope(error)
              })
          )
          .catch(() => {
            socket.terminate()
            cleanup()
          })
          .finally(() => pending.delete(request.id))
      })
    })
    return {
      endpoint: listener.endpoint,
      hasActiveDocuments: () =>
        Boolean(active?.readyState === WebSocket.OPEN && currentDocuments?.size),
      isConnected: () => active?.readyState === WebSocket.OPEN,
      reportOfficePreviewState: (clientId, state) => reportOfficePreviewState?.(clientId, state),
      reportMarketplaceProgress: (clientId, progress) =>
        reportMarketplaceProgress?.(clientId, progress),
      reportReproducibilityCheck: (clientId, state) =>
        reportReproducibilityCheck?.(clientId, state),
      reportUploadProgress: (clientId, progress) => reportUploadProgress?.(clientId, progress),
      requestNative: async (request, clientId, signal) => {
        if (!requestNative)
          throw new Error('This operation requires a connected Open-Science desktop.')
        return requestNative(request, clientId, signal)
      },
      close: async () => {
        unsubscribe()
        await listener.close()
      }
    }
  } catch (error) {
    unsubscribe()
    throw error
  }
}
