import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  BrowserWindow,
  NativeImage,
  WebContents,
  WebContentsDidStartNavigationEventParams,
  WebFrameMain
} from 'electron'
import type { CallerContext } from '../caller-context'
import {
  projectSurfaceMeasurementSchema,
  projectSurfaceMeasurementScript
} from '../run-observation/electron-capture'
import { createWebmEncoder, type RecordingMask, type WebmSegment } from './webm-encoder'
import { recordingDeadline } from './driver-deadline'

export type BrowserSurfaceEvent = Readonly<{
  offsetMs: number
  kind: 'click' | 'scroll' | 'navigation'
  source: 'browser-observed' | 'host-observed'
  x?: number
  y?: number
}>
export type BrowserSurfaceGap = Readonly<{
  startMs: number
  endMs: number
  reason: 'paused' | 'hidden' | 'source-lost' | 'capture-failed' | 'capacity' | 'interrupted'
}>
export type ElectronSurfaceRecordingOptions = Readonly<{
  caller: CallerContext
  viewerOrigin: string
  projectOrigin: string
  signal: AbortSignal
  onSegment(segment: WebmSegment): Promise<void>
  onEvent(event: BrowserSurfaceEvent): void
  onGap(gap: BrowserSurfaceGap): void
  onStarted?(startedAt: number): void
  onDroppedFrames?(count: number): void
  onEnded?(reason: 'source-lost' | 'capture-failed' | 'interrupted'): void
  frameRate?: number
  segmentDurationMs?: number
}>
export type ElectronSurfaceRecordingHandle = Readonly<{
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  diagnostics(): { presentedFrames: number; encodedFrames: number; droppedFrames: number }
}>

// One subscription per existing compositor. Never displace another recording subscription.
const subscriptions = new Set<number>()
const identity = (frame: WebFrameMain): string =>
  JSON.stringify([frame.processId, frame.frameToken, frame.origin])
type SurfaceMeasurement = ReturnType<typeof projectSurfaceMeasurementSchema.parse>
const geometryKey = (measurements: {
  outer: SurfaceMeasurement
  inner: SurfaceMeasurement
}): string =>
  JSON.stringify(
    [measurements.outer, measurements.inner].map((measurement) => ({
      devicePixelRatio: measurement.devicePixelRatio,
      viewportWidth: measurement.viewportWidth,
      viewportHeight: measurement.viewportHeight,
      rect: measurement.rect
    }))
  )
const origin = (value: string): string => {
  const parsed = new URL(value)
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname.endsWith('.localhost')
    )
  )
    throw new Error('Browser recording requires an owned local surface.')
  return value
}
const child = (parent: WebFrameMain, expected: string): WebFrameMain => {
  const matches = parent.frames.filter(
    (frame) =>
      frame.parent === parent && frame.origin === expected && new URL(frame.url).origin === expected
  )
  if (matches.length !== 1) throw new Error('Browser recording surface is unavailable.')
  return matches[0]
}
const safeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000

/** Fixed passive listeners in the exact project frame. No keys, input values, selectors, text,
 * URLs or DOM serialization enter the queue. Queue data remains untrusted and bounded in Main. */
function observationScript(key: string, mode: 'install' | 'read' | 'remove'): string {
  const selected = JSON.stringify(key)
  if (mode === 'remove')
    return `(()=>{const entry=globalThis[${selected}];if(entry){entry.remove();delete globalThis[${selected}];}})()`
  if (mode === 'read')
    return `(()=>{const entry=globalThis[${selected}];return entry?entry.read():null;})()`
  return `(()=>{
    const key=${selected}; if(globalThis[key]) return false;
    let queue=[];const privateTarget=target=>target instanceof Element&&!!target.closest('input,textarea,[contenteditable],[data-open-science-recording-private]');
    const click=event=>{if(event.isTrusted&&!privateTarget(event.target)&&queue.length<100)queue.push({kind:'click',x:event.clientX,y:event.clientY});};
    let lastScroll=0;const scroll=event=>{if(event.isTrusted&&!privateTarget(event.target)&&performance.now()-lastScroll>100&&queue.length<100){lastScroll=performance.now();queue.push({kind:'scroll',x:scrollX,y:scrollY});}};
    addEventListener('click',click,{capture:true,passive:true});addEventListener('scroll',scroll,{capture:true,passive:true});
    const masks=()=>{const nodes=[...document.querySelectorAll('input,textarea,[contenteditable],[data-open-science-recording-private]')];if(nodes.length>100)throw Error('Private region capacity exceeded');return nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x-2,y:r.y-2,width:r.width+4,height:r.height+4};});};
    globalThis[key]={read(){const events=queue;queue=[];return {events,masks:masks()};},remove(){removeEventListener('click',click,true);removeEventListener('scroll',scroll,true);}};return true;
  })()`
}

/** Records compositor presentations of the actual visible project iframe. No timer takes a
 * screenshot; a hidden encoder only receives validated cropped pixels. Loss of the exact surface
 * or visibility is a recorded gap, never permission to open or capture another page. */
export async function startElectronSurfaceRecording(
  options: ElectronSurfaceRecordingOptions
): Promise<ElectronSurfaceRecordingHandle> {
  const { caller, signal } = options
  signal.throwIfAborted()
  if (
    caller.surface !== 'electron' ||
    caller.location !== 'local' ||
    !caller.isAuthorizationCurrent() ||
    !/^[1-9]\d*$/.test(caller.clientId)
  )
    throw new Error('Browser recording requires the current Electron surface.')
  const { webContents, BrowserWindow } = await import('electron')
  const contents: WebContents | undefined = webContents.fromId(Number(caller.clientId))
  if (!contents || subscriptions.has(contents.id))
    throw new Error('Browser recording surface is busy or unavailable.')
  const window: BrowserWindow | null = BrowserWindow.fromWebContents(contents)
  if (!window) throw new Error('Browser recording surface is unavailable.')
  const root = contents.mainFrame
  const viewer = child(root, origin(options.viewerOrigin))
  const project = child(viewer, origin(options.projectOrigin))
  const frames = [root, viewer, project]
  const identities = frames.map(identity)
  const navigationIds = frames.map((frame) => [frame.processId, frame.routingId])
  // A same-origin RenderFrame can survive a real document navigation. Browser navigation
  // events, not just frame tokens or a renderer-controlled URL, fence that document boundary.
  let eventsSuspended = true
  let documentChanged = false,
    pendingNavigations = 0
  const onNavigation = (details: WebContentsDidStartNavigationEventParams): void => {
    const frame = details.frame
    if (frame && !frames.includes(frame)) return
    if (!details.isSameDocument || !frame) documentChanged = true
    else if (
      frame === project &&
      !eventsSuspended &&
      window.isVisible() &&
      !window.isMinimized() &&
      project.visibilityState === 'visible'
    )
      pendingNavigations = Math.min(100, pendingNavigations + 1)
  }
  const onDocumentNavigation = (
    _event: unknown,
    _url: string,
    _responseCode: number,
    _statusText: string,
    isMainFrame: boolean,
    processId: number,
    routingId: number
  ): void => {
    // Also fence a navigation which had already started when recording was requested.
    if (isMainFrame || navigationIds.some(([p, r]) => p === processId && r === routingId))
      documentChanged = true
  }
  const detachNavigation = (): void => {
    contents.off('did-start-navigation', onNavigation)
    contents.off('did-frame-navigate', onDocumentNavigation)
  }
  const zoom = contents.getZoomFactor()
  const frameRate = options.frameRate ?? 10
  const segmentDurationMs = options.segmentDurationMs ?? 3000
  if (
    !Number.isInteger(frameRate) ||
    frameRate < 1 ||
    frameRate > 30 ||
    !Number.isInteger(segmentDurationMs) ||
    segmentDurationMs < 500 ||
    segmentDurationMs > 10_000
  )
    throw new Error('Invalid browser recording options.')
  const assertSurface = (): void => {
    signal.throwIfAborted()
    if (
      !caller.isAuthorizationCurrent() ||
      documentChanged ||
      contents.isDestroyed() ||
      window.isDestroyed() ||
      webContents.fromId(contents.id) !== contents ||
      contents.mainFrame !== root
    )
      throw new Error('surface-ended')
    if (!window.isVisible() || window.isMinimized()) throw new Error('surface-hidden')
    if (
      contents.getZoomFactor() !== zoom ||
      frames.some(
        (frame, index) =>
          frame.detached || frame.isDestroyed() || identity(frame) !== identities[index]
      )
    )
      throw new Error('surface-changed')
    if (frames.some((frame) => frame.visibilityState !== 'visible'))
      throw new Error('surface-hidden')
    if (
      child(root, options.viewerOrigin) !== viewer ||
      child(viewer, options.projectOrigin) !== project
    )
      throw new Error('surface-changed')
  }
  const measure = async (): Promise<{
    outer: ReturnType<typeof projectSurfaceMeasurementSchema.parse>
    inner: ReturnType<typeof projectSurfaceMeasurementSchema.parse>
  }> => {
    assertSurface()
    const outer = projectSurfaceMeasurementSchema.parse(
      await recordingDeadline(
        root.executeJavaScript(projectSurfaceMeasurementScript(options.viewerOrigin))
      )
    )
    const inner = projectSurfaceMeasurementSchema.parse(
      await recordingDeadline(
        viewer.executeJavaScript(projectSurfaceMeasurementScript(options.projectOrigin))
      )
    )
    assertSurface()
    if (
      outer.documentUrl !== root.url ||
      inner.documentUrl !== viewer.url ||
      new URL(outer.sourceUrl).origin !== options.viewerOrigin ||
      new URL(inner.sourceUrl).origin !== options.projectOrigin ||
      outer.devicePixelRatio !== inner.devicePixelRatio ||
      Math.abs(outer.rect.width - inner.viewportWidth) > 1 ||
      Math.abs(outer.rect.height - inner.viewportHeight) > 1
    )
      throw new Error('surface-changed')
    return { outer, inner }
  }
  contents.on('did-start-navigation', onNavigation)
  contents.on('did-frame-navigate', onDocumentNavigation)
  const initial = await measure().catch((error: unknown) => {
    detachNavigation()
    throw error
  })
  const initialKey = geometryKey(initial)
  const ratio = Math.min(
    1,
    1280 / (initial.inner.rect.width * initial.outer.devicePixelRatio),
    720 / (initial.inner.rect.height * initial.outer.devicePixelRatio)
  )
  const width = Math.max(
    2,
    Math.floor((initial.inner.rect.width * initial.outer.devicePixelRatio * ratio) / 2) * 2
  )
  const height = Math.max(
    2,
    Math.floor((initial.inner.rect.height * initial.outer.devicePixelRatio * ratio) / 2) * 2
  )
  if (subscriptions.has(contents.id)) {
    detachNavigation()
    throw new Error('Browser recording surface is busy.')
  }
  subscriptions.add(contents.id)
  const encoder = await createWebmEncoder({ width, height, frameRate }).catch((error: unknown) => {
    subscriptions.delete(contents.id)
    detachNavigation()
    throw error
  })
  const eventKey = `__openScienceRecording${randomBytes(12).toString('hex')}`
  const started = performance.now()
  eventsSuspended = false
  options.onStarted?.(Date.now())
  const now = (): number => Math.max(0, Math.round(performance.now() - started))
  let stopped = false,
    paused = false,
    busy = false
  let presentedFrames = 0,
    encodedFrames = 0,
    droppedFrames = 0
  let consecutiveFailures = 0
  let segmentStart: number | undefined,
    lastFrame = -Infinity,
    lastAttempt = -Infinity
  let pending: Promise<void> = Promise.resolve()
  let sampleTimer: ReturnType<typeof setTimeout> | undefined
  let subscriptionActive = false,
    subscriptionGeneration = 0
  const disarm = (): void => {
    if (sampleTimer) clearTimeout(sampleTimer)
    sampleTimer = undefined
    subscriptionGeneration++
    if (subscriptionActive && !contents.isDestroyed()) contents.endFrameSubscription()
    subscriptionActive = false
  }
  let stopping: Promise<void> | undefined
  let reportedEnd = false
  const notifyEnded = (reason: 'source-lost' | 'capture-failed' | 'interrupted'): void => {
    if (reportedEnd) return
    reportedEnd = true
    options.onEnded?.(reason)
  }
  let gap: { startMs: number; reason: BrowserSurfaceGap['reason'] } | undefined
  const beginGap = (reason: BrowserSurfaceGap['reason'], startMs = now()): void => {
    eventsSuspended = true
    pendingNavigations = 0
    if (!gap) gap = { startMs, reason }
  }
  const endGap = (): void => {
    if (!gap) return
    const endMs = now()
    if (endMs > gap.startMs) options.onGap({ ...gap, endMs })
    gap = undefined
    eventsSuspended = false
  }
  const finishSegment = async (endMs = gap?.startMs ?? now()): Promise<void> => {
    if (segmentStart === undefined) return
    const segment = await encoder.finish(segmentStart, Math.max(segmentStart + 1, endMs))
    segmentStart = undefined
    if (segment) await options.onSegment(segment)
  }
  const processFrame = async (image: NativeImage): Promise<void> => {
    const stamp = now()
    if (stopped || paused || stamp - lastFrame < 1000 / frameRate) return
    if (busy) {
      if (stamp - lastFrame > 500) beginGap('capture-failed')
      return
    }
    busy = true
    lastAttempt = stamp
    try {
      assertSurface()
      if (geometryKey(await measure()) !== initialKey) throw Error('layout-changed')
      const size = image.getSize(),
        dpr = initial.outer.devicePixelRatio
      if (
        Math.abs(size.width - initial.outer.viewportWidth * dpr) > 2 ||
        Math.abs(size.height - initial.outer.viewportHeight * dpr) > 2
      )
        throw Error('frame-size-changed')
      const x = Math.ceil((initial.outer.rect.x + initial.inner.rect.x) * dpr),
        y = Math.ceil((initial.outer.rect.y + initial.inner.rect.y) * dpr)
      const cropWidth =
        Math.floor((initial.outer.rect.x + initial.inner.rect.x + initial.inner.rect.width) * dpr) -
        x
      const cropHeight =
        Math.floor(
          (initial.outer.rect.y + initial.inner.rect.y + initial.inner.rect.height) * dpr
        ) - y
      if (
        x < 0 ||
        y < 0 ||
        cropWidth < 1 ||
        cropHeight < 1 ||
        x + cropWidth > size.width ||
        y + cropHeight > size.height
      )
        throw Error('invalid-crop')
      const cropped = image.crop({ x, y, width: cropWidth, height: cropHeight })
      // Only this cropped image can cross into the encoder. The full window is never serialized.
      const png = cropped.toPNG()
      const data: unknown = await recordingDeadline(
        project.executeJavaScript(observationScript(eventKey, 'read'))
      )
      const record = data as { events?: unknown; masks?: unknown } | null
      if (
        !record ||
        !Array.isArray(record.events) ||
        !Array.isArray(record.masks) ||
        record.events.length > 100 ||
        record.masks.length > 100
      )
        throw Error('event-observer-unavailable')
      const masks: RecordingMask[] = []
      for (const entry of record.masks) {
        const m = entry as RecordingMask
        if (!m || ![m.x, m.y, m.width, m.height].every(safeNumber) || m.width < 0 || m.height < 0)
          throw Error('invalid-private-region')
        masks.push({
          x: (m.x / initial.inner.rect.width) * width,
          y: (m.y / initial.inner.rect.height) * height,
          width: (m.width / initial.inner.rect.width) * width,
          height: (m.height / initial.inner.rect.height) * height
        })
      }
      if (geometryKey(await measure()) !== initialKey) throw Error('layout-changed')
      assertSurface()
      if (stopped || paused) return
      // This read drains the passive DOM queue, including actions performed during a gap.
      // Discard that first batch on resumption instead of assigning it a new capture time.
      const discardEvents = eventsSuspended
      if (gap) await finishSegment(gap.startMs)
      if (segmentStart !== undefined && stamp - segmentStart >= segmentDurationMs)
        await finishSegment()
      if (stopped || paused) return
      assertSurface()
      endGap()
      if (segmentStart === undefined) segmentStart = now()
      await encoder.write(png, masks)
      encodedFrames++
      consecutiveFailures = 0
      lastFrame = stamp
      const navigations = !discardEvents && !eventsSuspended ? pendingNavigations : 0
      for (let remaining = navigations; remaining > 0; remaining--)
        options.onEvent({ kind: 'navigation', source: 'host-observed', offsetMs: stamp })
      pendingNavigations = 0
      if (discardEvents || eventsSuspended) return
      for (const entry of record.events) {
        const e = entry as { kind?: unknown; x?: unknown; y?: unknown }
        if (e && (e.kind === 'click' || e.kind === 'scroll') && safeNumber(e.x) && safeNumber(e.y))
          options.onEvent({
            kind: e.kind,
            x: e.x,
            y: e.y,
            source: 'browser-observed',
            offsetMs: stamp
          })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      const sourceLost = [
        'surface-ended',
        'surface-changed',
        'layout-changed',
        'frame-size-changed'
      ].includes(reason)
      beginGap(
        reason === 'surface-hidden' ? 'hidden' : sourceLost ? 'source-lost' : 'capture-failed'
      )
      await finishSegment().catch(() => undefined)
      if (reason !== 'surface-hidden' && (sourceLost || ++consecutiveFailures >= 3))
        queueMicrotask(() => {
          const notify = (): void => notifyEnded(sourceLost ? 'source-lost' : 'capture-failed')
          void stop().then(notify, notify)
        })
    } finally {
      busy = false
      if (!paused && !stopped) {
        // Count target sampling opportunities lost to our own processing time, not the
        // source's higher refresh rate or time deliberately paused/hidden by the user.
        const missed = Math.floor((now() - lastAttempt) / (1000 / frameRate))
        if (missed > 0) {
          droppedFrames += missed
          options.onDroppedFrames?.(missed)
        }
      }
    }
  }
  const scheduleCapture = (): void => {
    if (stopped || paused || busy || sampleTimer || subscriptionActive) return
    // A subscription allocates a full NativeImage on every compositor presentation, even if
    // its callback discards that frame. Subscribe only when the next real frame is due. This
    // timer admits a future presentation; it never takes a screenshot or repeats old pixels.
    sampleTimer = setTimeout(
      () => {
        sampleTimer = undefined
        if (stopped || paused || busy) return
        try {
          assertSurface()
          const generation = ++subscriptionGeneration
          subscriptionActive = true
          contents.beginFrameSubscription(false, (image) => {
            if (!subscriptionActive || generation !== subscriptionGeneration) return
            disarm()
            onFrame(image)
          })
        } catch (error) {
          subscriptionActive = false
          const hidden = error instanceof Error && error.message === 'surface-hidden'
          beginGap(hidden ? 'hidden' : 'source-lost')
          if (!hidden) {
            const notify = (): void => notifyEnded('source-lost')
            void stop().then(notify, notify)
          }
        }
      },
      Math.max(0, 1000 / frameRate - (now() - lastAttempt))
    )
    sampleTimer.unref()
  }
  const onFrame = (image: NativeImage): void => {
    presentedFrames++
    if (stopped || paused) return
    if (busy) {
      if (now() - lastAttempt >= 1000 / frameRate) {
        droppedFrames++
        options.onDroppedFrames?.(1)
        if (Number.isFinite(lastFrame) && now() - lastFrame > 500)
          beginGap(
            'capture-failed',
            Math.max(segmentStart ?? 0, lastFrame + Math.ceil(1000 / frameRate))
          )
      }
      return
    }
    pending = processFrame(image).finally(scheduleCapture)
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      stopped = true
      if (heartbeat) clearInterval(heartbeat)
      signal.removeEventListener('abort', abort)
      disarm()
      detachNavigation()
      subscriptions.delete(contents.id)
      await pending
      try {
        await finishSegment()
        endGap()
      } finally {
        encoder.close()
        if (!project.detached && !project.isDestroyed())
          await recordingDeadline(
            project.executeJavaScript(observationScript(eventKey, 'remove'))
          ).catch(() => undefined)
      }
    })()
    return stopping
  }
  const abort = (): void => {
    void stop().catch(() => undefined)
  }
  try {
    assertSurface()
    if (
      (await recordingDeadline(
        project.executeJavaScript(observationScript(eventKey, 'install'))
      )) !== true
    )
      throw Error('event-observer-unavailable')
    scheduleCapture()
    // This timer checks lifecycle only. It neither captures nor fabricates compositor frames.
    heartbeat = setInterval(() => {
      if (stopped) return
      try {
        assertSurface()
        scheduleCapture()
      } catch (error) {
        disarm()
        const reason = error instanceof Error ? error.message : ''
        if (paused && reason === 'surface-hidden') return
        beginGap(reason === 'surface-hidden' ? 'hidden' : 'source-lost')
        if (!busy) {
          busy = true
          pending = finishSegment()
            .catch(() => undefined)
            .finally(() => {
              busy = false
            })
        }
        if (reason !== 'surface-hidden') {
          const notify = (): void => notifyEnded('source-lost')
          void stop().then(notify, notify)
        }
      }
    }, 250)
    heartbeat.unref()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  } catch (error) {
    await stop()
    throw error
  }
  return {
    async pause() {
      if (stopped) return
      paused = true
      disarm()
      beginGap('paused')
      await pending
      await finishSegment()
    },
    async resume() {
      if (stopped) throw Error('Browser recording stopped.')
      assertSurface()
      if (geometryKey(await measure()) !== initialKey)
        throw Error('Browser recording layout changed.')
      paused = false
      scheduleCapture()
    },
    stop,
    diagnostics: () => ({ presentedFrames, encodedFrames, droppedFrames })
  }
}
