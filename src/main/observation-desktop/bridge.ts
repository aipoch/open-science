import type { CallerContext } from '../caller-context'
import type {
  BrowserRecordingDriver,
  BrowserRecordingDriverInput
} from '../browser-recordings/owner'
import type { ObservationFramePort, ObservationFrameRegistration } from './frame-port'
import {
  observationBatchSchema,
  parseObservationNativeResult,
  type ObservationNativeInvoke,
  type ObservationNativeRequest
} from './contract'

/** Node adapter. Documents are opaque UUIDs; only Electron resolves their current native surface. */
export function createDesktopObservationBridge(invoke: ObservationNativeInvoke): {
  frames: ObservationFramePort
  capture(input: {
    caller: CallerContext
    viewerOrigin: string
    projectOrigin: string
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array }>
  startDriver(input: BrowserRecordingDriverInput): Promise<BrowserRecordingDriver>
  close(): void
} {
  let closed = false
  const viewers = new Map<
    string,
    { caller: CallerContext; registration: ObservationFrameRegistration }
  >()
  const registrations = new Set<ObservationFrameRegistration>()
  const recordings = new Set<() => void>()
  const lifetime = new AbortController()
  const assertCaller = (caller: CallerContext): void => {
    if (
      closed ||
      caller.surface !== 'electron' ||
      caller.location !== 'local' ||
      !caller.isAuthorizationCurrent()
    )
      throw new Error('A current local desktop document is required for capture.')
  }
  const call = async (
    caller: CallerContext,
    request: ObservationNativeRequest,
    signal?: AbortSignal
  ): Promise<unknown> => {
    assertCaller(caller)
    const timeout = AbortSignal.timeout(15_000)
    const current = AbortSignal.any([lifetime.signal, timeout, ...(signal ? [signal] : [])])
    current.throwIfAborted()
    const result = await invoke({ operation: 'observation', request }, caller.clientId, current)
    current.throwIfAborted()
    assertCaller(caller)
    return parseObservationNativeResult(request, result)
  }
  const release = (caller: CallerContext, request: ObservationNativeRequest): void => {
    void invoke(
      { operation: 'observation', request },
      caller.clientId,
      AbortSignal.timeout(5_000)
    ).catch(() => undefined)
  }
  const register = async (
    caller: CallerContext,
    request: Extract<ObservationNativeRequest, { method: 'register-viewer' | 'register-runtime' }>,
    assertCurrent: () => void
  ): Promise<ObservationFrameRegistration> => {
    assertCurrent()
    const registrationId = (await call(caller, request)) as string
    let ended = false
    const registration: ObservationFrameRegistration = {
      async issueGrant(url, expiresAt) {
        if (ended) throw new Error('Desktop frame registration ended.')
        assertCurrent()
        await call(caller, { method: 'grant', registrationId, url, expiresAt })
        assertCurrent()
        if (ended) throw new Error('Desktop frame registration ended.')
      },
      async authenticateGrant(grant) {
        if (ended) throw new Error('Desktop frame registration ended.')
        assertCurrent()
        await call(caller, { method: 'authenticate', registrationId, grant })
        assertCurrent()
        if (ended) throw new Error('Desktop frame registration ended.')
      },
      close() {
        if (ended) return
        ended = true
        registrations.delete(registration)
        if (viewers.get(request.origin)?.registration === registration)
          viewers.delete(request.origin)
        release(caller, { method: 'unregister', registrationId })
      }
    }
    registrations.add(registration)
    try {
      assertCurrent()
      assertCaller(caller)
    } catch (error) {
      registration.close()
      throw error
    }
    return registration
  }
  const frames: ObservationFramePort = {
    async registerViewer(input) {
      const registration = await register(
        input.caller,
        { method: 'register-viewer', origin: input.origin, expiresAt: input.expiresAt },
        input.assertCurrent
      )
      viewers.set(input.origin, { caller: input.caller, registration })
      return registration
    },
    async registerRuntime(input) {
      const parents = input.parents.filter((origin) => viewers.has(origin))
      // A local SDK/browser viewer does not need or acquire native desktop navigation rights.
      if (!parents.length) return undefined
      const caller = viewers.get(parents[0])!.caller
      if (parents.some((parent) => viewers.get(parent)!.caller.clientId !== caller.clientId))
        throw new Error('Runtime parents must belong to one desktop document.')
      return register(
        caller,
        {
          method: 'register-runtime',
          origin: input.origin,
          parents,
          excludedPath: input.excludedPath,
          expiresAt: input.expiresAt
        },
        input.assertCurrent
      )
    }
  }
  return {
    frames,
    async capture(input) {
      return (await call(
        input.caller,
        { method: 'capture', viewerOrigin: input.viewerOrigin, projectOrigin: input.projectOrigin },
        input.signal
      )) as { bytes: Uint8Array }
    },
    async startDriver(input) {
      input.signal.throwIfAborted()
      const recordingId = (await call(
        input.caller,
        {
          method: 'record-start',
          viewerOrigin: input.viewerOrigin,
          projectOrigin: input.projectOrigin
        },
        input.signal
      )) as string
      let stopped = false,
        ended = false,
        ack = 0
      let stopping: Promise<void> | undefined
      const polling = new AbortController()
      const dispose = (): void => {
        if (stopped) return
        stopped = true
        polling.abort()
        recordings.delete(dispose)
        input.signal.removeEventListener('abort', dispose)
        release(input.caller, { method: 'record-control', recordingId, action: 'release' })
      }
      const assertCurrent = (): void => {
        input.signal.throwIfAborted()
        assertCaller(input.caller)
      }
      recordings.add(dispose)
      input.signal.addEventListener('abort', dispose, { once: true })
      if (input.signal.aborted) {
        dispose()
        input.signal.throwIfAborted()
      }
      const loop = (async (): Promise<void> => {
        try {
          while (!stopped) {
            assertCurrent()
            const batch = observationBatchSchema.parse(
              await call(input.caller, { method: 'record-poll', recordingId, ack }, polling.signal)
            )
            for (const packet of batch.packets) {
              assertCurrent()
              if (packet.sequence !== ack + 1) throw new Error('Native recording sequence changed.')
              switch (packet.kind) {
                case 'segment':
                  await input.onSegment(packet.value)
                  break
                case 'event':
                  input.onEvent(packet.value)
                  break
                case 'gap':
                  input.onGap(packet.value)
                  break
                case 'started':
                  input.onStarted?.(packet.value)
                  break
                case 'dropped':
                  input.onDroppedFrames?.(packet.value)
                  break
                case 'ended':
                  ended = true
                  input.onEnded?.(packet.value)
                  break
              }
              assertCurrent()
              ack = packet.sequence
            }
            if (batch.stopped && !batch.packets.length) return
          }
        } catch {
          if (!stopped && !ended) input.onEnded?.('interrupted')
          dispose()
        }
      })()
      return {
        async pause() {
          assertCurrent()
          await call(
            input.caller,
            { method: 'record-control', recordingId, action: 'pause' },
            input.signal
          )
        },
        async resume() {
          assertCurrent()
          await call(
            input.caller,
            { method: 'record-control', recordingId, action: 'resume' },
            input.signal
          )
        },
        stop() {
          stopping ??= (async (): Promise<void> => {
            try {
              if (!stopped) {
                await call(
                  input.caller,
                  { method: 'record-control', recordingId, action: 'stop' },
                  input.signal
                )
                await loop
              }
            } finally {
              dispose()
            }
          })()
          return stopping
        }
      }
    },
    close() {
      if (closed) return
      closed = true
      lifetime.abort()
      for (const stop of [...recordings]) stop()
      for (const registration of [...registrations]) registration.close()
      viewers.clear()
    }
  }
}
