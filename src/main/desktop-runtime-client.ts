import { QuitScopeChangedError } from './lifecycle-shutdown'
import { terminateVerifiedService } from './verified-service-stop'
import {
  recoverStoppedServiceProcesses,
  StoppedServiceProcessRecoveryError
} from './service-process-recovery'
import {
  readServiceLifetime,
  serviceStopDeadline,
  LOCAL_SERVICE_STOP_ESCALATION_MS,
  type ServiceLifetimeSnapshot,
  type ServiceStopOptions
} from './local-service-lifetime'
import { DesktopRuntimeDisconnectedError } from '../shared/desktop-runtime-recovery'
import { randomUUID } from 'node:crypto'
import { desktopRuntimeInfoSchema, type DesktopRuntimeInfo } from './desktop-runtime-info'
import { waitForRuntimeStopped } from './runtime-stop-confirmation'
import type { RuntimeDirectoryLease } from './runtime-ownership'
const desktopInstanceId = randomUUID()
import { createSessionEventHydrator } from '../shared/session-event-hydrator'
import { createRuntimePayloadClient } from '../shared/runtime-payload-client'
import { RUNTIME_PAYLOAD_CAPABILITY } from '../shared/runtime-payload-transfer'
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
import {
  ApplicationCommandError,
  parseApplicationCommandError
} from '../shared/application-command-contract'
import { connectToDesktopEndpoint, type DesktopEndpoint } from './desktop-connection'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'
import { createLogger } from '@aipoch/diagnostics/node'

const logger = createLogger('desktop-runtime-client')
// Includes cancelled handlers from retired attachments until their real resources settle.
const unsettledNativeHandlers = new Set<AbortController>()
const MAX_UNSETTLED_NATIVE_HANDLERS = 64

export type DesktopDeliveryFailure = {
  kind: 'event' | 'startup' | 'document' | 'upload'
  clientId?: string
}
type DisconnectReason =
  | 'bootstrap-timeout'
  | 'invalid-frame'
  | 'invalid-bootstrap'
  | 'invalid-event'
  | 'callback-failure'
  | 'invalid-native-request'
  | 'native-capacity'
  | 'invalid-response'
  | 'response-identity'
  | 'event-history'
  | 'send-failure'
  | 'transport-close'
  | 'socket-error'
  | 'client-close'

type DisconnectPolicyReason =
  | 'invalid-request'
  | 'request-order-or-capacity'
  | 'document-capacity'
  | 'retired-document-capacity'

function classifyPolicyReason(reason: string): DisconnectPolicyReason | undefined {
  switch (reason) {
    case 'Invalid desktop request.':
      return 'invalid-request'
    case 'Invalid or excessive desktop requests.':
      return 'request-order-or-capacity'
    case 'Too many renderer documents.':
      return 'document-capacity'
    case 'Reconnect desktop attachment.':
      return 'retired-document-capacity'
    default:
      return undefined
  }
}

// JSON omits an undefined result. The private desktop transport preserves that Electron
// return value; public Web responses retain their required JSON result contract.
const responseSchema = z.discriminatedUnion('ok', [
  webRpcResponseSchema.options[0].partial({ result: true }),
  webRpcResponseSchema.options[1]
])

const bootstrapSchema = webRpcBootstrapSchema
  .pick({
    rpcProtocolVersion: true,
    rpcCapabilities: true,
    eventStream: true
  })
  .extend({
    kind: z.literal('bootstrap'),
    startup: desktopDatabaseStartupSchema.optional(),
    pid: z.number().int().positive(),
    rpcChannels: z.array(z.string()),
    ...desktopRuntimeInfoSchema.shape
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
  runtimeInfo(): DesktopRuntimeInfo
  refreshControl(): Promise<DesktopRuntimeInfo>
  waitForStopped(
    signal?: AbortSignal,
    requireCleanExit?: boolean,
    timeoutMs?: number
  ): Promise<RuntimeDirectoryLease>
  stopRuntime(
    reason?: 'restart' | 'update',
    options?: ServiceStopOptions
  ): Promise<RuntimeDirectoryLease>
  lifecycle(request: DesktopLifecycleRequest): Promise<unknown>
  loadSessionForEvent(request: { projectId: string; sessionId: string }): Promise<unknown>
  invokeHost(channel: string, args?: readonly unknown[]): Promise<unknown>
  invoke(clientId: string, channel: string, args: readonly unknown[]): Promise<unknown>
  release(clientId: string): void
  notificationAction(token: string, action: 'clicked' | 'closed'): void
  notificationView(reason: 'view' | 'focus' | 'window-created', visibleSessionId?: string): void
  close(): void
  quit(options?: ServiceStopOptions): Promise<RuntimeDirectoryLease | undefined>
}>

// No business state lives here. In-flight mutations are never automatically retried after a
// disconnect: the caller must reload current state before deciding whether to submit again.
export async function connectDesktopRuntime(options: {
  endpoint: DesktopEndpoint
  signal?: AbortSignal
  desktopInstanceId?: string
  // Only the launcher that actually spawned this child may supply its handle.
  startedProcess?: ChildProcess
  onNativeRequest?: DesktopNativeHandler
  onNativeResponseSent?: (request: Parameters<DesktopNativeHandler>[0], result: unknown) => void
  onStartupState?: (state: DatabaseStartupState) => void
  onDocumentEvent?: (event: z.infer<typeof desktopDocumentEventSchema>) => void
  onUploadProgress?: (clientId: string, progress: UploadTransferProgress) => void
  onEvent(event: { channel: string; payload: unknown }): void
  onDeliveryFailure?: (failure: DesktopDeliveryFailure) => void
  onDisconnect(error: Error): void
}): Promise<DesktopRuntimeClient> {
  const socket = await connectToDesktopEndpoint(options.endpoint, options.signal)
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const expiredRequests = new Set<number>()
  const native = new Map<number, AbortController>()
  let highestNativeId = 0
  const payloadClients = new Map<
    string,
    {
      controller: AbortController
      client: ReturnType<typeof createRuntimePayloadClient>
    }
  >()
  let supportsPayload = false
  let requestId = 0
  let channels: readonly string[] = []
  let cursor: { streamId: string; latestSequence: number } | undefined
  let startupState: DatabaseStartupState = { phase: 'checking' }
  let runtimePid = 0
  let runtimeInfo!: DesktopRuntimeInfo
  let refreshing:
    | {
        promise: Promise<DesktopRuntimeInfo>
        resolve(value: DesktopRuntimeInfo): void
        reject(error: Error): void
        timer: NodeJS.Timeout
      }
    | undefined
  let quitting = false
  let quitPromise: Promise<RuntimeDirectoryLease | undefined> | undefined
  let closed = false
  let disconnectCause: Error | undefined
  let disconnectDelivered = false
  const notifyDisconnect = (): void => {
    if (!initialized || !disconnectCause || disconnectDelivered) return
    disconnectDelivered = true
    options.onDisconnect(disconnectCause)
  }
  let initialized = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const fail = (
    error: Error,
    reason: DisconnectReason,
    closeCode?: number,
    policyReason?: DisconnectPolicyReason
  ): void => {
    if (closed) return
    closed = true
    disconnectCause = error
    if (reason !== 'client-close')
      logger[
        quitting &&
        reason === 'transport-close' &&
        pending.size === 0 &&
        (closeCode === 1000 || closeCode === 1001 || closeCode === 1006)
          ? 'info'
          : 'warn'
      ]('desktop runtime disconnected', {
        phase: quitting ? 'shutdown' : initialized ? 'connected' : 'bootstrap',
        reason,
        pendingRequests: Math.min(pending.size, 256),
        pendingNativeOperations: Math.min(native.size, 32),
        ...(policyReason ? { policyReason } : {}),
        ...(typeof closeCode === 'number' &&
        Number.isInteger(closeCode) &&
        closeCode >= 1000 &&
        closeCode <= 4999
          ? { closeCode }
          : {})
      })
    clearTimeout(timer)
    rejectReady(error)
    if (refreshing) {
      clearTimeout(refreshing.timer)
      refreshing.reject(error)
      refreshing = undefined
    }
    for (const request of pending.values())
      request.reject(
        new DesktopRuntimeDisconnectedError(
          'Desktop connection lost. The result of a submitted operation is unknown; it will not be retried.',
          { cause: error }
        )
      )
    pending.clear()
    for (const document of payloadClients.values()) document.controller.abort(error)
    payloadClients.clear()
    for (const operation of native.values()) operation.abort()
    native.clear()
    socket.terminate()
    if (!quitting) notifyDisconnect()
  }
  const timer = setTimeout(
    () => fail(new Error('Desktop runtime bootstrap timed out.'), 'bootstrap-timeout'),
    5_000
  )
  timer.unref()
  const send = (message: unknown, onSent?: () => void): void => {
    if (closed || socket.readyState !== WebSocket.OPEN)
      throw new DesktopRuntimeDisconnectedError('Desktop runtime is disconnected.', {
        cause: disconnectCause
      })
    const serialized = stringifyRpcJson(message)
    if (socket.bufferedAmount + Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
      throw new Error('Desktop runtime request exceeds the transport byte budget.')
    }
    socket.send(serialized, (error) => {
      if (error) fail(error, 'send-failure')
      else onSent?.()
    })
  }
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
  const boundedRequest = async (
    frame: Record<string, unknown>,
    deadlineAt: number
  ): Promise<unknown> => {
    const operation = request(frame)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation.response,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              pending.delete(operation.id)
              expiredRequests.add(operation.id)
              reject(new Error('Desktop lifecycle acknowledgement timed out.'))
            },
            Math.max(0, deadlineAt - Date.now())
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const deliver = (failure: DesktopDeliveryFailure, callback: () => void): void => {
    try {
      callback()
    } catch {
      logger.warn('desktop consumer delivery failed', {
        reason: 'callback-failure',
        kind: failure.kind
      })
      try {
        options.onDeliveryFailure?.(failure)
      } catch {
        logger.warn('desktop consumer invalidation failed', { reason: 'callback-failure' })
      }
    }
  }
  const eventController = new AbortController()
  const eventPayloadClient = createRuntimePayloadClient({
    invoke: (_channel, args, payloadOptions) =>
      request({
        kind: 'session-event-read',
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args,
        ...payloadOptions
      }).response,
    encode: stringifyRpcJson,
    decode: parseRpcJson,
    signal: () => eventController.signal
  })
  const eventHydrator = createSessionEventHydrator({
    load: (request) => eventPayloadClient.invoke('sessions:load-one', [request]),
    deliver: (event) => deliver({ kind: 'event' }, () => options.onEvent(event)),
    onFailure: () =>
      deliver({ kind: 'event' }, () => {
        throw new Error('Session event projection requires reload.')
      })
  })
  socket.once('close', () => {
    eventController.abort()
    eventHydrator.dispose()
  })
  socket.once('error', () => {
    eventController.abort()
    eventHydrator.dispose()
  })
  socket.on('message', (bytes, binary) => {
    if (closed) return
    let failureReason: DisconnectReason = 'invalid-frame'
    try {
      if (binary) throw new Error('Unexpected binary desktop frame.')
      const frame = parseRpcJson(bytes.toString())
      if (
        initialized &&
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'bootstrap'
      ) {
        if (!refreshing) throw new Error('Unrequested Desktop bootstrap.')
        const bootstrap = bootstrapSchema.parse(frame)
        if (
          bootstrap.pid !== runtimePid ||
          bootstrap.generation !== runtimeInfo.generation ||
          bootstrap.eventStream.streamId !== cursor?.streamId
        )
          throw new Error('The original Runtime identity changed during control refresh.')
        const next = desktopRuntimeInfoSchema.parse(
          Object.fromEntries(
            Object.keys(desktopRuntimeInfoSchema.shape).map((key) => [
              key,
              bootstrap[key as keyof typeof bootstrap]
            ])
          )
        )
        if (
          JSON.stringify(next.startupOptions) !== JSON.stringify(runtimeInfo.startupOptions) ||
          next.entryPath !== runtimeInfo.entryPath ||
          next.launch !== runtimeInfo.launch
        )
          throw new Error('The original Runtime configuration changed during control refresh.')
        runtimeInfo = next
        // Keep the existing event cursor, documents, native request IDs and pending requests.
        const completed = refreshing
        refreshing = undefined
        clearTimeout(completed.timer)
        completed.resolve(runtimeInfo)
        return
      }
      if (!initialized) {
        failureReason = 'invalid-bootstrap'
        const bootstrap = bootstrapSchema.parse(frame)
        startupState = bootstrap.startup ?? { phase: 'ready' }
        runtimePid = bootstrap.pid
        supportsPayload = bootstrap.rpcCapabilities?.includes(RUNTIME_PAYLOAD_CAPABILITY) ?? false
        channels = Object.freeze([...bootstrap.rpcChannels])
        cursor = bootstrap.eventStream
        runtimeInfo = desktopRuntimeInfoSchema.parse(
          Object.fromEntries(
            Object.keys(desktopRuntimeInfoSchema.shape).map((key) => [
              key,
              bootstrap[key as keyof typeof bootstrap]
            ])
          )
        )
        if (runtimeInfo.generation !== options.endpoint.generation)
          throw new Error('Desktop Runtime generation changed during bootstrap.')
        initialized = true
        clearTimeout(timer)
        resolveReady()
        return
      }
      failureReason = 'invalid-event'
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'startup-state') {
        const event = desktopStartupEventSchema.parse(frame)
        channels = Object.freeze([...event.rpcChannels])
        startupState = event.state
        failureReason = 'callback-failure'
        deliver({ kind: 'startup' }, () => options.onStartupState?.(event.state))
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'upload-progress'
      ) {
        const event = desktopUploadProgressSchema.parse(frame)
        failureReason = 'callback-failure'
        deliver({ kind: 'upload', clientId: event.clientId }, () =>
          options.onUploadProgress?.(event.clientId, event.progress)
        )
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'document-event'
      ) {
        const event = desktopDocumentEventSchema.parse(frame)
        failureReason = 'callback-failure'
        deliver({ kind: 'document', clientId: event.clientId }, () =>
          options.onDocumentEvent?.(event)
        )
        return
      }
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'native-cancel') {
        const cancelled = desktopNativeCancelSchema.parse(frame)
        const controller = native.get(cancelled.id)
        // Some native dialogs settle only after user interaction; cancelled work owns no slot.
        native.delete(cancelled.id)
        controller?.abort()
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        'kind' in frame &&
        frame.kind === 'native-request'
      ) {
        failureReason = 'invalid-native-request'
        const request = desktopNativeRequestSchema.parse(frame)
        failureReason = native.size >= 32 ? 'native-capacity' : 'invalid-native-request'
        if (request.id <= highestNativeId || native.size >= 32)
          throw new Error('Invalid or excessive native desktop requests.')
        highestNativeId = request.id
        if (unsettledNativeHandlers.size >= MAX_UNSETTLED_NATIVE_HANDLERS) {
          send({
            kind: 'native-response',
            id: request.id,
            outcome: {
              ok: false,
              message:
                'Native desktop resources are still busy. Close outstanding native operations and retry.'
            }
          })
          return
        }
        const controller = new AbortController()
        unsettledNativeHandlers.add(controller)
        native.set(request.id, controller)
        void (async () => {
          try {
            if (!options.onNativeRequest)
              throw new Error('Native desktop operations are unavailable.')
            const result = await options.onNativeRequest(request, controller.signal)
            if (!closed && !controller.signal.aborted)
              send({ kind: 'native-response', id: request.id, outcome: { ok: true, result } }, () =>
                options.onNativeResponseSent?.(request, result)
              )
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
            unsettledNativeHandlers.delete(controller)
          }
        })().catch((error) =>
          fail(error instanceof Error ? error : new Error(String(error)), 'send-failure')
        )
        return
      }
      if (frame && typeof frame === 'object' && 'kind' in frame && frame.kind === 'response') {
        const { id, kind: _kind, ...body } = frame as Record<string, unknown>
        void _kind
        failureReason = 'invalid-response'
        const response = responseSchema.parse(body)
        failureReason = 'response-identity'
        if (typeof id === 'number' && expiredRequests.delete(id)) return
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
      failureReason = 'event-history'
      if (event.kind === 'resync-required' || event.streamId !== cursor!.streamId) {
        throw new Error('Desktop runtime event history changed; reload required.')
      }
      if (event.kind === 'event') {
        if (event.sequence <= cursor!.latestSequence) return
        if (event.sequence !== cursor!.latestSequence + 1) {
          failureReason = 'send-failure'
          send({ kind: 'resume', streamId: cursor!.streamId, after: cursor!.latestSequence })
          return
        }
        failureReason = 'callback-failure'
        eventHydrator.receive(
          { channel: event.channel, payload: event.payload },
          Array.isArray(bytes)
            ? bytes.reduce((total, part) => total + part.byteLength, 0)
            : bytes.byteLength
        )
        cursor = { streamId: event.streamId, latestSequence: event.sequence }
      } else if (event.latestSequence > cursor!.latestSequence) {
        failureReason = 'send-failure'
        send({ kind: 'resume', streamId: cursor!.streamId, after: cursor!.latestSequence })
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)), failureReason)
    }
  })
  socket.once('close', (code, reason) =>
    fail(
      new DesktopRuntimeDisconnectedError('Desktop runtime connection closed.'),
      'transport-close',
      code,
      code === 1008 ? classifyPolicyReason(reason.toString()) : undefined
    )
  )
  socket.once('error', (error) =>
    fail(new DesktopRuntimeDisconnectedError(error.message, { cause: error }), 'socket-error')
  )
  try {
    send({ kind: 'bootstrap', desktopInstanceId: options.desktopInstanceId ?? desktopInstanceId })
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)), 'send-failure')
  }
  const canceled = (): void => fail(new Error('Desktop attachment canceled.'), 'client-close')
  options.signal?.addEventListener('abort', canceled, { once: true })
  if (options.signal?.aborted) canceled()
  try {
    await ready
  } finally {
    options.signal?.removeEventListener('abort', canceled)
  }
  const close = (): void => {
    initialized = false
    fail(new Error('Desktop runtime client closed.'), 'client-close')
  }
  const waitForStoppedEvidence = (
    signal?: AbortSignal,
    requireCleanExit = !runtimeInfo.lifetime,
    timeoutMs = runtimeInfo.lifetime ? 20_000 : 15_000,
    deadlineAt = Date.now() + timeoutMs
  ): Promise<RuntimeDirectoryLease> => {
    return waitForRuntimeStopped({
      configRoot: runtimeInfo.startupOptions.configRoot,
      generation: runtimeInfo.generation,
      pid: runtimePid,
      signal,
      timeoutMs,
      requireCleanExit,
      socketClosed: () => socket.readyState === WebSocket.CLOSED
    }).then(async (lease) => {
      if (!runtimeInfo.lifetime) return lease
      try {
        await recoverStoppedServiceProcesses({
          configRoot: runtimeInfo.startupOptions.configRoot,
          dataRoot: runtimeInfo.startupOptions.dataRoot,
          lease,
          deadlineAt
        })
        return lease
      } catch (error) {
        if (
          error instanceof StoppedServiceProcessRecoveryError &&
          error.code === 'service-process-recovery-incomplete'
        ) {
          logger.warn('Stopped local service has unresolved process receipts', {
            generation: runtimeInfo.generation,
            code: error.code
          })
          return lease
        }
        if (error instanceof StoppedServiceProcessRecoveryError && error.settlement)
          void error.settlement.then(() => lease.release())
        else lease.release()
        throw error
      }
    })
  }
  const waitForStopped = async (
    signal?: AbortSignal,
    requireCleanExit = !runtimeInfo.lifetime,
    timeoutMs = runtimeInfo.lifetime ? 20_000 : 15_000
  ): Promise<RuntimeDirectoryLease> => {
    if (!runtimeInfo.lifetime) return waitForStoppedEvidence(signal, requireCleanExit, timeoutMs)
    const deadlineAt = serviceStopDeadline(Date.now() + timeoutMs)
    try {
      return await waitForStoppedEvidence(
        signal,
        requireCleanExit,
        Math.max(1, deadlineAt - Date.now() - LOCAL_SERVICE_STOP_ESCALATION_MS),
        deadlineAt
      )
    } catch (error) {
      signal?.throwIfAborted()
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'runtime-stop-timeout'
      ))
        throw error
      // Observing an existing stop never creates permission to stop a running service. Only the
      // authenticated generation's durable grant authorizes this bounded escalation.
      await terminateVerifiedService({
        configRoot: runtimeInfo.startupOptions.configRoot,
        generation: runtimeInfo.generation,
        pid: runtimePid,
        birthToken: runtimeInfo.birthToken,
        deadlineAt,
        signal
      })
      signal?.throwIfAborted()
      return waitForStoppedEvidence(
        signal,
        requireCleanExit,
        Math.max(1, deadlineAt - Date.now()),
        deadlineAt
      )
    }
  }
  const ownsRuntime = (): boolean =>
    runtimeInfo.lifetime
      ? !runtimeInfo.lifetime.explicit && runtimeInfo.lifetime.apps <= 1
      : runtimeInfo.control === 'granted' && runtimeInfo.launch === 'desktop'
  let inspectedPreserveService = false
  let quitAttempt: { attemptId: string; deadlineAt: number; preserveService: boolean } | undefined
  let stopPromise: Promise<RuntimeDirectoryLease> | undefined
  const runStop = async (
    reason?: 'restart' | 'update',
    stopOptions: ServiceStopOptions = {}
  ): Promise<RuntimeDirectoryLease> => {
    if (runtimeInfo.control !== 'granted')
      throw new Error('This Desktop does not control the Runtime.')
    quitting = true
    const confirmation = new AbortController()
    let stopped: Promise<RuntimeDirectoryLease> | undefined
    const requestedDeadline = stopOptions.deadlineAt ?? quitAttempt?.deadlineAt
    const deadlineAt = runtimeInfo.lifetime
      ? serviceStopDeadline(requestedDeadline)
      : Math.min(requestedDeadline ?? Infinity, Date.now() + 15_000)
    const requireCleanExit = stopOptions.requireCleanExit ?? !runtimeInfo.lifetime
    try {
      // Start the total stop budget before waiting for the command acknowledgement. A
      // lost reply is ambiguous, so actual process/lock/exit-record evidence is authoritative.
      stopped = waitForStoppedEvidence(
        confirmation.signal,
        requireCleanExit,
        Math.max(
          1,
          deadlineAt - Date.now() - (runtimeInfo.lifetime ? LOCAL_SERVICE_STOP_ESCALATION_MS : 0)
        ),
        deadlineAt
      )
      const rejected = new Promise<never>((_resolve, reject) => {
        if (!closed) {
          void request({
            kind: 'shutdown',
            generation: runtimeInfo.generation,
            pid: runtimePid,
            ...(runtimeInfo.lifetime ? { deadlineAt } : {}),
            ...(reason && runtimeInfo.lifetime ? { reason } : {})
          }).response.catch((error) => {
            if (!closed) reject(error)
          })
        }
      })
      const lease = await Promise.race([stopped, rejected])
      close()
      return lease
    } catch (error) {
      confirmation.abort()
      await stopped?.then(
        (lease) => lease.release(),
        () => undefined
      )
      if (
        runtimeInfo.lifetime &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'runtime-stop-timeout'
      ) {
        await terminateVerifiedService({
          configRoot: runtimeInfo.startupOptions.configRoot,
          generation: runtimeInfo.generation,
          pid: runtimePid,
          birthToken: runtimeInfo.birthToken,
          deadlineAt
        })
        const lease = await waitForStoppedEvidence(
          undefined,
          false,
          Math.max(1, deadlineAt - Date.now()),
          deadlineAt
        )
        close()
        return lease
      }
      if (!closed) fail(new Error('Runtime stop confirmation timed out.'), 'client-close')
      notifyDisconnect()
      throw error
    } finally {
      confirmation.abort()
      quitting = false
    }
  }

  const stopRuntime = (
    reason?: 'restart' | 'update',
    stopOptions?: ServiceStopOptions
  ): Promise<RuntimeDirectoryLease> =>
    (stopPromise ??= runStop(reason, stopOptions).catch((error) => {
      stopPromise = undefined
      throw error
    }))

  return {
    refreshControl: () => {
      if (refreshing) return refreshing.promise
      let resolve!: (value: DesktopRuntimeInfo) => void
      let reject!: (error: Error) => void
      const promise = new Promise<DesktopRuntimeInfo>((yes, no) => {
        resolve = yes
        reject = no
      })
      const timer = setTimeout(
        () => fail(new Error('Desktop control refresh timed out.'), 'bootstrap-timeout'),
        5000
      )
      refreshing = { promise, resolve, reject, timer }
      try {
        send({
          kind: 'bootstrap',
          desktopInstanceId: options.desktopInstanceId ?? desktopInstanceId
        })
      } catch (error) {
        clearTimeout(timer)
        refreshing = undefined
        reject(error as Error)
      }
      return promise
    },
    commandNames: () => channels,
    startupState: () => startupState,
    retryStartup: async () =>
      desktopDatabaseStartupSchema.parse(await request({ kind: 'startup-retry' }).response),
    processId: () => runtimePid,
    ownsRuntime,
    runtimeInfo: () => runtimeInfo,
    waitForStopped,
    stopRuntime,
    lifecycle: async (operation) => {
      if (operation.operation === 'prepare')
        quitAttempt ??= {
          attemptId: randomUUID(),
          deadlineAt: serviceStopDeadline(operation.deadlineAt),
          preserveService: operation.preserveService ?? inspectedPreserveService
        }
      const attempt = quitAttempt
      try {
        const wireOperation =
          runtimeInfo.lifetime &&
          attempt &&
          (operation.operation === 'prepare' || operation.operation === 'abort')
            ? {
                ...operation,
                attemptId: attempt.attemptId,
                ...(operation.operation === 'prepare' ? { deadlineAt: attempt.deadlineAt } : {})
              }
            : operation
        const result = await boundedRequest(
          { kind: 'lifecycle', request: wireOperation },
          operation.operation === 'prepare'
            ? (attempt?.deadlineAt ?? serviceStopDeadline()) - LOCAL_SERVICE_STOP_ESCALATION_MS
            : Date.now() + 2000
        )
        if (
          operation.operation === 'inspect' &&
          result &&
          typeof result === 'object' &&
          'preserveService' in result
        )
          inspectedPreserveService = result.preserveService === true
        return result
      } finally {
        if (operation.operation === 'abort' && quitAttempt === attempt) quitAttempt = undefined
      }
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
    loadSessionForEvent: (request) => eventPayloadClient.invoke('sessions:load-one', [request]),
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
      const invoke: Parameters<typeof createRuntimePayloadClient>[0]['invoke'] = (
        channel,
        args,
        payloadOptions
      ) =>
        request({
          kind: 'invoke',
          protocolVersion: WEB_RPC_PROTOCOL_VERSION,
          clientId,
          channel,
          args,
          ...payloadOptions
        }).response
      if (!supportsPayload) return invoke(channel, args)
      let document = payloadClients.get(clientId)
      if (!document) {
        const controller = new AbortController()
        document = {
          controller,
          client: createRuntimePayloadClient({
            invoke,
            encode: stringifyRpcJson,
            decode: parseRpcJson,
            signal: () => controller.signal
          })
        }
        payloadClients.set(clientId, document)
      }
      return document.client.invoke(channel, args)
    },
    release: (clientId) => {
      payloadClients.get(clientId)?.controller.abort(new Error('Renderer document released.'))
      payloadClients.delete(clientId)
      if (closed) return
      try {
        send({ kind: 'release', clientId })
      } catch (error) {
        // If one document cannot be revoked reliably, revoke the entire attachment.
        fail(error instanceof Error ? error : new Error(String(error)), 'send-failure')
      }
    },
    close,
    // Called only after desktop confirmation and durability barriers; ordinary detach never stops.
    quit: (stopOptions = {}) =>
      (quitPromise ??= (
        runtimeInfo.lifetime
          ? (async () => {
              quitting = true
              try {
                const deadline = serviceStopDeadline(
                  stopOptions.deadlineAt ?? quitAttempt?.deadlineAt
                )
                let outcome: (ServiceLifetimeSnapshot & { scopeChanged?: true }) | undefined
                try {
                  outcome = (await boundedRequest(
                    {
                      kind: 'app-exit',
                      generation: runtimeInfo.generation,
                      ...(quitAttempt ? { attemptId: quitAttempt.attemptId } : {}),
                      deadlineAt: deadline
                    },
                    Math.min(Date.now() + 2000, deadline - LOCAL_SERVICE_STOP_ESCALATION_MS)
                  )) as ServiceLifetimeSnapshot & { scopeChanged?: true }
                } catch (error) {
                  // A lost reply cannot undo a committed stop. Consult the exact generation's
                  // durable intent, then use process exit and the directory lock as evidence.
                  const intent = await readServiceLifetime(runtimeInfo.startupOptions.configRoot)
                  if (intent?.generation !== runtimeInfo.generation || !intent.stopping) throw error
                  outcome = { ...intent, apps: 0 }
                }
                if (outcome.scopeChanged) throw new QuitScopeChangedError()
                if (outcome.stopping) {
                  let lease: RuntimeDirectoryLease
                  try {
                    lease = await waitForStoppedEvidence(
                      undefined,
                      false,
                      Math.max(1, deadline - LOCAL_SERVICE_STOP_ESCALATION_MS - Date.now()),
                      deadline
                    )
                  } catch (error) {
                    if (!(
                      error &&
                      typeof error === 'object' &&
                      'code' in error &&
                      error.code === 'runtime-stop-timeout'
                    ))
                      throw error
                    await terminateVerifiedService({
                      configRoot: runtimeInfo.startupOptions.configRoot,
                      generation: runtimeInfo.generation,
                      pid: runtimePid,
                      birthToken: runtimeInfo.birthToken,
                      deadlineAt: deadline
                    })
                    lease = await waitForStoppedEvidence(
                      undefined,
                      false,
                      Math.max(1, deadline - Date.now()),
                      deadline
                    )
                  }
                  close()
                  return lease
                }
                close()
                return undefined
              } catch (error) {
                if (error instanceof QuitScopeChangedError) throw error
                if (quitAttempt?.preserveService)
                  throw new ApplicationCommandError(
                    'command-unavailable',
                    'The App quit result could not be confirmed. Retry quitting.'
                  )
                // A desktop may leave even when the residual service cannot be identified safely.
                // Verified termination itself requires the exact durable stop intent.
                logger.warn('App exited with an unresolved local service', {
                  generation: runtimeInfo.generation,
                  message: error instanceof Error ? error.message : String(error)
                })
                close()
                return undefined
              } finally {
                quitting = false
              }
            })()
          : ownsRuntime()
            ? stopRuntime(undefined, stopOptions)
            : Promise.resolve(close()).then(() => undefined)
      ).catch((error) => {
        quitPromise = undefined
        throw error
      }))
  }
}
