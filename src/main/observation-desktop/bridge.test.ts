import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../caller-context'
import { createDesktopObservationBridge } from './bridge'
import { createObservationNativeHost } from './native-host'
import { DesktopObservationFrameRegistry } from '../replay-viewer/desktop-frame-registry'
import { parseRpcJson, stringifyRpcJson } from '../rpc-json'
import type { ElectronSurfaceRecordingOptions } from '../browser-recordings/electron-surface-driver'
import type { ObservationNativeInvoke } from './contract'
import {
  MAX_NATIVE_SEGMENT_BYTES,
  observationNativeRequestSchema,
  parseObservationNativeResult
} from './contract'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const clientId = randomUUID()
  let current = true
  let document: { id: number; isDestroyed(): boolean } | undefined = {
    id: 37,
    isDestroyed: () => false
  }
  const caller = createCallerContext({
    clientId,
    lifecycleClientId: `desktop:${clientId}`,
    leaseId: randomUUID(),
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human',
    isAuthorizationCurrent: () => current
  })
  let driverInput!: ElectronSurfaceRecordingOptions
  const capture = vi.fn(async (input) => {
    expect(input.caller.clientId).toBe('37')
    return { bytes: Uint8Array.from([1, 2, 3]) }
  })
  const driver = {
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    diagnostics: () => ({ presentedFrames: 0, encodedFrames: 0, droppedFrames: 0 })
  }
  const registry = new DesktopObservationFrameRegistry()
  const native = createObservationNativeHost({
    documentFor: (id) => (id === clientId ? document : undefined),
    frames: registry,
    capture,
    startDriver: vi.fn(async (input) => {
      driverInput = input
      input.onStarted?.(1234)
      return driver
    })
  })
  cleanup.push(() => native.close())
  const invoke: ObservationNativeInvoke = async (operation, id, signal) => {
    // Match the private desktop JSON binary envelope, rather than passing same-process objects.
    const request = parseRpcJson(stringifyRpcJson(operation.request)) as typeof operation.request
    return parseRpcJson(
      stringifyRpcJson(
        await native.handle({ clientId: id, request }, signal ?? new AbortController().signal)
      )
    )
  }
  const bridge = createDesktopObservationBridge(invoke)
  cleanup.push(() => bridge.close())
  const surface = {
    caller,
    viewerOrigin: 'http://viewer-test.localhost:1234',
    projectOrigin: 'http://rv-test.localhost:1235',
    signal: new AbortController().signal
  }
  return {
    bridge,
    native,
    caller,
    clientId,
    surface,
    driver,
    registry,
    capture,
    input: () => driverInput,
    revoke: () => {
      current = false
      document = undefined
    },
    replaceDocument: () => {
      document = { id: 37, isDestroyed: () => false }
    }
  }
}
const segment = {
  bytes: Uint8Array.from([26, 69, 223, 163]),
  startMs: 0,
  endMs: 500,
  width: 100,
  height: 100,
  codec: 'vp8' as const,
  frameRate: 10
}

describe('desktop observation boundary', () => {
  it('resolves an opaque document on the native host and preserves bounded binary capture', async () => {
    const f = fixture()
    expect(await f.bridge.capture(f.surface)).toEqual({ bytes: Uint8Array.from([1, 2, 3]) })
    await expect(
      f.native.handle(
        {
          clientId: randomUUID(),
          request: {
            method: 'capture',
            viewerOrigin: f.surface.viewerOrigin,
            projectOrigin: f.surface.projectOrigin
          }
        },
        f.surface.signal
      )
    ).rejects.toThrow('document')
    expect(f.capture).toHaveBeenCalledTimes(1)
    f.revoke()
    await expect(f.bridge.capture(f.surface)).rejects.toThrow('document')
  })

  it('mirrors grants before returning and revokes navigation when the document is replaced', async () => {
    const f = fixture()
    const registration = await f.bridge.frames.registerViewer({
      origin: f.surface.viewerOrigin,
      caller: f.caller,
      expiresAt: Date.now() + 60_000,
      assertCurrent: () => undefined
    })
    const grant = 'a'.repeat(64)
    const url = `${f.surface.viewerOrigin}/__open_science_viewer?grant=${grant}`
    await registration.issueGrant(url, Date.now() + 30_000)
    const root = { frameTreeNodeId: 1, url: 'file:///app/index.html', parent: null }
    const frame = { frameTreeNodeId: 2, url, parent: root }
    expect(f.registry.allows({ url, webContentsId: 37, mainFrame: root, frame })).toBe(true)
    await registration.authenticateGrant(grant)
    expect(
      f.registry.allows({
        url: `${f.surface.viewerOrigin}/`,
        webContentsId: 37,
        mainFrame: root,
        frame
      })
    ).toBe(true)
    f.replaceDocument()
    expect(
      f.registry.allows({
        url: `${f.surface.viewerOrigin}/`,
        webContentsId: 37,
        mainFrame: root,
        frame
      })
    ).toBe(false)
    registration.close()
  })

  it('keeps browser/SDK runtime views independent of any desktop', async () => {
    const f = fixture()
    expect(
      await f.bridge.frames.registerRuntime({
        origin: f.surface.projectOrigin,
        parents: ['http://viewer-sdk.localhost:1236'],
        excludedPath: '/proof',
        expiresAt: Date.now() + 60_000,
        assertCurrent: () => undefined,
        allowsPath: () => true
      })
    ).toBeUndefined()
  })

  it('acknowledges one complete segment only after the backend Artifact sink accepts it', async () => {
    const f = fixture()
    const saving = deferred(),
      received = deferred()
    const onSegment = vi.fn(async () => {
      received.resolve()
      await saving.promise
    })
    const started = vi.fn()
    const driver = await f.bridge.startDriver({
      ...f.surface,
      onSegment,
      onEvent: () => undefined,
      onGap: () => undefined,
      onStarted: started
    })
    let acknowledged = false
    const publication = f
      .input()
      .onSegment(segment)
      .then(() => {
        acknowledged = true
      })
    await received.promise
    expect(acknowledged).toBe(false)
    expect(started).toHaveBeenCalledWith(1234)
    expect(onSegment.mock.calls).toHaveLength(1)
    saving.resolve()
    await publication
    expect(acknowledged).toBe(true)
    await driver.pause()
    await driver.resume()
    await driver.stop()
    expect(f.driver.pause).toHaveBeenCalledOnce()
    expect(f.driver.resume).toHaveBeenCalledOnce()
    expect(f.driver.stop).toHaveBeenCalledOnce()
  })

  it('rejects forged acknowledgements and cross-document controls', async () => {
    const f = fixture()
    const recordingId = (await f.native.handle(
      {
        clientId: f.clientId,
        request: {
          method: 'record-start',
          viewerOrigin: f.surface.viewerOrigin,
          projectOrigin: f.surface.projectOrigin
        }
      },
      f.surface.signal
    )) as string
    await expect(
      f.native.handle(
        { clientId: f.clientId, request: { method: 'record-poll', recordingId, ack: 99 } },
        f.surface.signal
      )
    ).rejects.toThrow('acknowledgement')
    await expect(
      f.native.handle(
        {
          clientId: randomUUID(),
          request: { method: 'record-control', recordingId, action: 'stop' }
        },
        f.surface.signal
      )
    ).rejects.toThrow('document')
  })

  it('cancels a pending publication and disposes the native driver after document loss', async () => {
    const f = fixture()
    const received = deferred(),
      saving = deferred()
    const ended = vi.fn()
    const driver = await f.bridge.startDriver({
      ...f.surface,
      onSegment: async () => {
        received.resolve()
        await saving.promise
      },
      onEvent: () => undefined,
      onGap: () => undefined,
      onEnded: ended
    })
    const publication = f.input().onSegment(segment)
    const rejected = expect(publication).rejects.toThrow('released')
    await received.promise
    f.revoke()
    await rejected
    saving.resolve()
    await driver.stop().catch(() => undefined)
    expect(f.driver.stop).toHaveBeenCalledOnce()
  })

  it('rejects oversized segments, origins outside issued loopback services and unknown operations', () => {
    expect(() =>
      parseObservationNativeResult(
        { method: 'record-poll', recordingId: randomUUID(), ack: 0 },
        {
          packets: [
            {
              kind: 'segment',
              sequence: 1,
              value: { ...segment, bytes: new Uint8Array(MAX_NATIVE_SEGMENT_BYTES + 1) }
            }
          ],
          stopped: false
        }
      )
    ).toThrow()
    expect(() =>
      observationNativeRequestSchema.parse({
        method: 'capture',
        viewerOrigin: 'https://example.com',
        projectOrigin: 'http://localhost:1234'
      })
    ).toThrow()
    expect(() => observationNativeRequestSchema.parse({ method: 'evaluate', code: '1' })).toThrow()
  })
})

it('Node observation command groups retain UUID caller and reject late replies after lease revocation', async () => {
  const { createRunObservationHandlers } = await import('../run-observation/ipc')
  const { createBrowserRecordingHandlers } = await import('../browser-recordings/ipc')
  const f = fixture()
  const lease = new AbortController()
  const reply = deferred()
  let observed: typeof f.caller | undefined
  const call = vi.fn(async (_method: unknown, _request: unknown, caller?: typeof f.caller) => {
    observed = caller
    await reply.promise
    return { ok: true, result: null }
  })
  const handlers = createRunObservationHandlers({ call } as unknown as Parameters<
    typeof createRunObservationHandlers
  >[0])
  const browser = createBrowserRecordingHandlers({ call } as unknown as Parameters<
    typeof createBrowserRecordingHandlers
  >[0])
  const invocation = {
    callerContext: f.caller,
    callerLease: {
      leaseId: f.caller.leaseId,
      generation: 1,
      signal: lease.signal,
      isCurrent: () => !lease.signal.aborted
    },
    args: [{ viewerId: 'example' }]
  }
  const pending = handlers['run-observation:open'](invocation)
  expect(observed?.clientId).toBe(f.clientId)
  expect(observed?.isAuthorizationCurrent()).toBe(true)
  lease.abort()
  reply.resolve()
  await expect(pending).rejects.toThrow('authorization ended')
  expect(observed?.isAuthorizationCurrent()).toBe(false)
  await expect(browser['project-recording:start'](invocation)).rejects.toThrow(
    'authorization ended'
  )
  expect(call).toHaveBeenCalledOnce()
})
