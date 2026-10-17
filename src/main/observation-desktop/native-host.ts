import { randomUUID } from 'node:crypto'
import type { CallerContext } from '../caller-context'
import { createCallerContext } from '../caller-context'
import { isRuntimeViewPath } from '../../shared/runtime-view'
import type {
  ElectronSurfaceRecordingOptions,
  ElectronSurfaceRecordingHandle
} from '../browser-recordings/electron-surface-driver'
import type { ElectronProjectCapture } from '../run-observation/electron-capture'
import type {
  DesktopObservationFrameRegistry,
  DesktopObservationRegistration
} from '../replay-viewer/desktop-frame-registry'
import {
  observationNativeRequestSchema,
  observationPacketSchema,
  parseObservationNativeResult,
  type ObservationNativeRequest,
  type ObservationPacket
} from './contract'

type Document = { id: number; isDestroyed(): boolean }
type Binding = {
  document: Document
  clientId: string
  caller: CallerContext
  lifetime: AbortController
}
type FrameRegistration = Binding & {
  origin: string
  expiresAt: number
  registration: DesktopObservationRegistration
}
type Recording = Binding & {
  driver?: ElectronSurfaceRecordingHandle
  packets: ObservationPacket[]
  sequence: number
  ack: number
  delivered: number
  heartbeat: number
  ended: boolean
  stopped: boolean
  polling: boolean
  segment?: { sequence: number; resolve(): void; reject(error: Error): void }
  wake?: () => void
  stop?: Promise<void>
}

/** Private desktop host. Native objects never cross this adapter; callers cannot supply window IDs. */
export function createObservationNativeHost(dependencies: {
  documentFor(clientId: string): Document | undefined
  frames: DesktopObservationFrameRegistry
  capture: ElectronProjectCapture
  startDriver(input: ElectronSurfaceRecordingOptions): Promise<ElectronSurfaceRecordingHandle>
}): {
  handle(
    input: { clientId?: string; request: ObservationNativeRequest },
    signal: AbortSignal
  ): Promise<unknown>
  close(): Promise<void>
} {
  const frames = new Map<string, FrameRegistration>()
  const recordings = new Map<string, Recording>()
  let closed = false
  const isCurrent = (binding: Binding): boolean =>
    !closed &&
    !binding.lifetime.signal.aborted &&
    dependencies.documentFor(binding.clientId) === binding.document &&
    !binding.document.isDestroyed()
  const bind = (clientId: string | undefined): Binding => {
    if (!clientId || closed) throw new Error('A current desktop document is required.')
    const document = dependencies.documentFor(clientId)
    if (!document || document.isDestroyed())
      throw new Error('Desktop document is no longer available.')
    const lifetime = new AbortController()
    const binding = { document, clientId, lifetime } as Binding
    // Numeric native IDs exist only in this trusted Electron-local adapter for the existing driver.
    binding.caller = createCallerContext({
      clientId: String(document.id),
      lifecycleClientId: clientId,
      leaseId: clientId,
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human',
      isAuthorizationCurrent: () => isCurrent(binding)
    })
    return binding
  }
  const assertCurrent = (binding: Binding): void => {
    if (!isCurrent(binding)) throw new Error('Desktop document authorization ended.')
  }
  const removeFrame = (id: string): void => {
    const frame = frames.get(id)
    if (!frame) return
    frames.delete(id)
    frame.lifetime.abort()
    frame.registration.close()
  }
  const stop = (record: Recording): Promise<void> => {
    record.stop ??= (async (): Promise<void> => {
      try {
        await record.driver?.stop()
      } finally {
        record.stopped = true
        record.wake?.()
      }
    })()
    return record.stop
  }
  const release = (id: string): void => {
    const record = recordings.get(id)
    if (!record) return
    recordings.delete(id)
    record.lifetime.abort()
    record.segment?.reject(new Error('Native recording was released.'))
    record.segment = undefined
    record.packets.length = 0
    record.wake?.()
    void stop(record).catch(() => undefined)
  }
  const sweep = setInterval(() => {
    for (const [id, frame] of frames)
      if (!isCurrent(frame) || frame.expiresAt <= Date.now()) removeFrame(id)
    for (const [id, record] of recordings)
      if (!isCurrent(record) || Date.now() - record.heartbeat > 30_000) release(id)
  }, 250)
  sweep.unref()
  const requireRecording = (id: string, clientId?: string): Recording => {
    const record = recordings.get(id)
    if (!record || record.clientId !== clientId)
      throw new Error('Recording does not belong to this document.')
    assertCurrent(record)
    record.heartbeat = Date.now()
    return record
  }
  return {
    async handle(input, signal) {
      signal.throwIfAborted()
      const request = observationNativeRequestSchema.parse(input.request)
      const binding = bind(input.clientId)
      let result: unknown = null
      if (request.method === 'register-viewer' || request.method === 'register-runtime') {
        if (
          frames.size >= 128 ||
          request.expiresAt <= Date.now() ||
          request.expiresAt > Date.now() + 24 * 60 * 60 * 1000
        )
          throw new Error('Desktop frame registration exceeds capacity or lifetime.')
        if (
          request.method === 'register-runtime' &&
          request.parents.some(
            (origin) =>
              ![...frames.values()].some(
                (frame) =>
                  frame.origin === origin && frame.clientId === input.clientId && isCurrent(frame)
              )
          )
        )
          throw new Error('Runtime parent belongs to another desktop document.')
        const assert = (): void => assertCurrent(binding)
        const registration =
          request.method === 'register-viewer'
            ? dependencies.frames.registerViewer({
                ...request,
                caller: binding.caller,
                assertCurrent: assert
              })
            : dependencies.frames.registerRuntime({
                ...request,
                assertCurrent: assert,
                allowsPath: (path) => {
                  try {
                    const pathname = decodeURIComponent(new URL(path, request.origin).pathname)
                    return (
                      isRuntimeViewPath(path) &&
                      pathname !== request.excludedPath &&
                      !pathname.startsWith(`${request.excludedPath}/`)
                    )
                  } catch {
                    return false
                  }
                }
              })
        const registrationId = randomUUID()
        frames.set(registrationId, {
          ...binding,
          origin: request.origin,
          expiresAt: request.expiresAt,
          registration
        })
        if (signal.aborted || !isCurrent(binding)) {
          removeFrame(registrationId)
          signal.throwIfAborted()
          assertCurrent(binding)
        }
        result = registrationId
      } else if (
        request.method === 'grant' ||
        request.method === 'authenticate' ||
        request.method === 'unregister'
      ) {
        const frame = frames.get(request.registrationId)
        if (!frame || frame.clientId !== input.clientId)
          throw new Error('Frame registration does not belong to this document.')
        assertCurrent(frame)
        if (request.method === 'grant')
          frame.registration.issueGrant(request.url, request.expiresAt)
        else if (request.method === 'authenticate')
          frame.registration.authenticateGrant(request.grant)
        else removeFrame(request.registrationId)
      } else if (request.method === 'capture') {
        result = await dependencies.capture({
          ...request,
          caller: binding.caller,
          signal: AbortSignal.any([signal, binding.lifetime.signal])
        })
      } else if (request.method === 'record-start') {
        if (recordings.size >= 8) throw new Error('Native recording capacity exceeded.')
        const recordingId = randomUUID()
        const record: Recording = {
          ...binding,
          packets: [],
          sequence: 0,
          ack: 0,
          delivered: 0,
          heartbeat: Date.now(),
          ended: false,
          stopped: false,
          polling: false
        }
        recordings.set(recordingId, record)
        const push = (packet: Omit<ObservationPacket, 'sequence'>): number => {
          assertCurrent(record)
          if (record.packets.length >= 256) {
            release(recordingId)
            throw new Error('Native recording event capacity exceeded.')
          }
          const sequence = ++record.sequence
          record.packets.push(observationPacketSchema.parse({ ...packet, sequence }))
          record.wake?.()
          return sequence
        }
        try {
          record.driver = await dependencies.startDriver({
            ...request,
            caller: binding.caller,
            signal: record.lifetime.signal,
            onSegment: (value) =>
              new Promise<void>((resolve, reject) => {
                try {
                  if (record.segment)
                    throw new Error('A native segment is already awaiting acknowledgement.')
                  const sequence = push({
                    kind: 'segment',
                    value: { ...value, bytes: Uint8Array.from(value.bytes) }
                  })
                  record.segment = { sequence, resolve, reject }
                } catch (error) {
                  reject(error as Error)
                }
              }),
            onStarted: (value) => {
              push({ kind: 'started', value })
            },
            onEvent: (value) => {
              push({ kind: 'event', value })
            },
            onGap: (value) => {
              push({ kind: 'gap', value })
            },
            onDroppedFrames: (value) => {
              push({ kind: 'dropped', value })
            },
            onEnded: (value) => {
              if (!isCurrent(record)) return
              record.ended = true
              push({ kind: 'ended', value })
              if (record.driver) void stop(record).catch(() => undefined)
            }
          })
          if (record.ended) void stop(record).catch(() => undefined)
          if (signal.aborted || !isCurrent(record)) {
            release(recordingId)
            await record.driver.stop()
            signal.throwIfAborted()
            assertCurrent(record)
          }
          result = recordingId
        } catch (error) {
          release(recordingId)
          throw error
        }
      } else {
        const record = requireRecording(request.recordingId, input.clientId)
        if (request.method === 'record-control') {
          if (request.action === 'release') release(request.recordingId)
          else if (request.action === 'stop') await stop(record)
          else {
            if (record.stopped) throw new Error('Recording ended.')
            await record.driver![request.action]()
          }
        } else {
          if (record.polling || request.ack < record.ack || request.ack > record.delivered)
            throw new Error('Invalid recording acknowledgement or concurrent poll.')
          record.polling = true
          try {
            record.ack = request.ack
            record.packets = record.packets.filter((packet) => packet.sequence > request.ack)
            if (record.segment && record.segment.sequence <= request.ack) {
              record.segment.resolve()
              record.segment = undefined
            }
            if (!record.packets.length && !record.stopped)
              await new Promise<void>((resolve) => {
                const timer = setTimeout(finish, 500)
                function finish(): void {
                  clearTimeout(timer)
                  signal.removeEventListener('abort', finish)
                  record.wake = undefined
                  resolve()
                }
                record.wake = finish
                signal.addEventListener('abort', finish, { once: true })
                if (signal.aborted) finish()
              })
            signal.throwIfAborted()
            assertCurrent(record)
            const packets = record.packets.slice(0, 64)
            record.delivered = packets.at(-1)?.sequence ?? record.ack
            result = { packets, stopped: record.stopped }
          } finally {
            record.polling = false
          }
        }
      }
      signal.throwIfAborted()
      assertCurrent(binding)
      return parseObservationNativeResult(request, result)
    },
    async close() {
      if (closed) return
      const pending = [...recordings.values()]
      for (const id of [...frames.keys()]) removeFrame(id)
      for (const id of [...recordings.keys()]) release(id)
      closed = true
      clearInterval(sweep)
      await Promise.allSettled(pending.map(stop))
    }
  }
}
