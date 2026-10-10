import { z } from 'zod'
import type { CallerContext } from '../caller-context'
import { createLogger } from '../logger'

export type ElectronProjectCaptureInput = Readonly<{
  caller: CallerContext
  viewerOrigin: string
  projectOrigin: string
  signal: AbortSignal
}>
export type ElectronProjectCapture = (
  input: ElectronProjectCaptureInput
) => Promise<{ bytes: Uint8Array }>
export type CaptureFrame = Readonly<{
  url: string
  origin: string
  frameToken: string
  processId: number
  parent: CaptureFrame | null
  frames: readonly CaptureFrame[]
  detached: boolean
  visibilityState: string
  isDestroyed(): boolean
  executeJavaScript(code: string): Promise<unknown>
}>
export type CaptureContents = Readonly<{
  id: number
  mainFrame: CaptureFrame
  isDestroyed(): boolean
  getZoomFactor(): number
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<{
    isEmpty(): boolean
    getSize(): { width: number; height: number }
    toPNG(): Buffer
  }>
}>
export type ElectronProjectCaptureDependencies = Readonly<{
  reportDiagnostic?(diagnostic: ElectronProjectCaptureDiagnostic): void
  fromId(id: number): CaptureContents | undefined
  windowFor(contents: CaptureContents): {
    isDestroyed(): boolean
    isVisible(): boolean
    isMinimized(): boolean
    isFocused(): boolean
  } | null
}>
const rectangleSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  })
  .strict()
export const projectSurfaceMeasurementSchema = z
  .object({
    documentUrl: z.string(),
    sourceUrl: z.string(),
    devicePixelRatio: z.number().finite().positive(),
    viewportWidth: z.number().finite().positive(),
    viewportHeight: z.number().finite().positive(),
    rect: rectangleSchema
  })
  .strict()
type Measurement = z.infer<typeof projectSurfaceMeasurementSchema>
type MeasurementIdentityDetail = Readonly<{
  identityCheck:
    | 'root-document'
    | 'viewer-document'
    | 'viewer-origin'
    | 'project-origin'
    | 'pixel-ratio'
    | 'viewport-width'
    | 'viewport-height'
    | 'project-right'
    | 'project-bottom'
  expected?: number
  actual?: number
}>

/** Fixed identity labels and bounded geometry only; never persist document URLs or DOM content. */
export function projectSurfaceIdentityDiagnostic(
  measurements: { outer: Measurement; inner: Measurement },
  identity: { rootUrl: string; viewerUrl: string; viewerOrigin: string; projectOrigin: string },
  checkProjectBounds = true
): MeasurementIdentityDetail | undefined {
  const { outer, inner } = measurements
  const mismatch = (
    identityCheck: MeasurementIdentityDetail['identityCheck'],
    expected?: number,
    actual?: number
  ): MeasurementIdentityDetail => ({
    identityCheck,
    ...(expected !== undefined && Number.isFinite(expected) && Math.abs(expected) <= 10_000_000
      ? { expected }
      : {}),
    ...(actual !== undefined && Number.isFinite(actual) && Math.abs(actual) <= 10_000_000
      ? { actual }
      : {})
  })
  if (outer.documentUrl !== identity.rootUrl) return mismatch('root-document')
  if (inner.documentUrl !== identity.viewerUrl) return mismatch('viewer-document')
  if (originOf(outer.sourceUrl) !== identity.viewerOrigin) return mismatch('viewer-origin')
  if (originOf(inner.sourceUrl) !== identity.projectOrigin) return mismatch('project-origin')
  if (inner.devicePixelRatio !== outer.devicePixelRatio)
    return mismatch('pixel-ratio', outer.devicePixelRatio, inner.devicePixelRatio)
  if (Math.abs(outer.rect.width - inner.viewportWidth) > 1)
    return mismatch('viewport-width', outer.rect.width, inner.viewportWidth)
  if (Math.abs(outer.rect.height - inner.viewportHeight) > 1)
    return mismatch('viewport-height', outer.rect.height, inner.viewportHeight)
  if (checkProjectBounds && inner.rect.x + inner.rect.width > outer.rect.width)
    return mismatch('project-right', outer.rect.width, inner.rect.x + inner.rect.width)
  if (checkProjectBounds && inner.rect.y + inner.rect.height > outer.rect.height)
    return mismatch('project-bottom', outer.rect.height, inner.rect.y + inner.rect.height)
  return undefined
}
const measurementReasons = [
  'document-hidden',
  'iframe-ambiguous',
  'frame-outside-viewport',
  'ancestor-effect',
  'ancestor-clipped-x',
  'ancestor-clipped-y',
  'dom-budget',
  'overlapping-element',
  'hit-test-mismatch'
] as const
const failureSchema = z
  .object({
    unavailable: z.enum(measurementReasons),
    ancestorDepth: z.number().int().nonnegative().max(20000).optional(),
    excessPx: z.number().finite().nonnegative().max(10_000_000).optional()
  })
  .strict()
type CaptureReason =
  | (typeof measurementReasons)[number]
  | 'caller-invalid'
  | 'origin-invalid'
  | 'contents-unavailable'
  | 'frame-binding'
  | 'frame-hidden'
  | 'window-hidden'
  | 'window-unfocused'
  | 'lease-revoked'
  | 'zoom-invalid'
  | 'measurement-invalid'
  | 'measurement-identity'
  | 'layout-changed'
  | 'crop-budget'
  | 'pixel-budget'
  | 'empty-image'
  | 'image-size'
  | 'image-bytes'
  | 'cancelled'
  | 'timeout'
  | 'host-error'
type CaptureStage =
  | 'authority'
  | 'frame-binding'
  | 'measure-root'
  | 'measure-viewer'
  | 'measure-identity'
  | 'crop'
  | 'capture-page'
  | 'image-validation'
export type ElectronProjectCaptureDiagnostic = Readonly<{
  stage: CaptureStage
  reason: CaptureReason
  measurement?: 'initial' | 'confirmed' | 'after'
  ancestorDepth?: number
  excessPx?: number
}> &
  Partial<MeasurementIdentityDetail>
class CaptureUnavailable extends Error {
  constructor(
    readonly reason: CaptureReason,
    readonly detail: {
      ancestorDepth?: number
      excessPx?: number
    } & Partial<MeasurementIdentityDetail> = {}
  ) {
    super('Visible project frame is unavailable or changed during capture.')
  }
}
const unavailable = (reason: CaptureReason = 'host-error'): CaptureUnavailable =>
  new CaptureUnavailable(reason)
const log = createLogger('observation-capture')
const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
function checkedOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw unavailable('origin-invalid')
  }
  // These are issued local service origins, never a caller-selected external browsing target.
  if (
    url.origin !== input ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    !(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.hostname.endsWith('.localhost')
    )
  )
    throw unavailable('origin-invalid')
  return url.origin
}

/** Fixed, read-only query in the trusted app/viewer only. No caller rectangle or project script.
 * Reject effects, clipping and overlapping siblings rather than guessing a transformed crop. */
export function projectSurfaceMeasurementScript(origin: string): string {
  return String.raw`(() => {
    const origin = ${JSON.stringify(origin)};
    if (document.visibilityState !== 'visible') return {unavailable:'document-hidden'};
    const matches = [...document.querySelectorAll('iframe')].filter(element => {
      try { return new URL(element.src).origin === origin; } catch { return false; }
    });
    if (matches.length !== 1) return {unavailable:'iframe-ambiguous'};
    const frame = matches[0];
    const bounds = frame.getBoundingClientRect();
    const css = getComputedStyle(frame);
    const number = value => Number.parseFloat(value) || 0;
    const left = number(css.borderLeftWidth) + number(css.paddingLeft);
    const top = number(css.borderTopWidth) + number(css.paddingTop);
    const right = number(css.borderRightWidth) + number(css.paddingRight);
    const bottom = number(css.borderBottomWidth) + number(css.paddingBottom);
    const rect = { x: bounds.left + left, y: bounds.top + top,
      width: bounds.width - left - right, height: bounds.height - top - bottom };
    const endX = rect.x + rect.width, endY = rect.y + rect.height;
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || endX > innerWidth || endY > innerHeight) return {unavailable:'frame-outside-viewport'};
    let ancestorDepth = 0;
    for (let element = frame; element; element = element.parentElement, ancestorDepth++) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1 ||
          style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' ||
          style.clipPath !== 'none' || (style.maskImage && style.maskImage !== 'none') ||
          !['1', 'normal', ''].includes(style.zoom)) return {unavailable:'ancestor-effect',ancestorDepth};
      if (element !== frame) {
        const parent = element.getBoundingClientRect();
        const x = parent.left + element.clientLeft, y = parent.top + element.clientTop;
        if (style.overflowX !== 'visible' && (rect.x < x || endX > x + element.clientWidth)) return {unavailable:'ancestor-clipped-x',ancestorDepth,excessPx:Math.max(x-rect.x,endX-x-element.clientWidth)};
        if (style.overflowY !== 'visible' && (rect.y < y || endY > y + element.clientHeight)) return {unavailable:'ancestor-clipped-y',ancestorDepth,excessPx:Math.max(y-rect.y,endY-y-element.clientHeight)};
      }
    }
    // Prove only empty CSS clips, not whether a decorative box happens to paint a background.
    // Computed percentage-only inset shapes use the element's reference box; opposing insets
    // covering an entire axis leave no painted area. Unknown shapes/units remain conservative.
    const hasEmptyClip = style => {
      if (/^inset\(\d+(?:\.\d+)?%(?:\s+\d+(?:\.\d+)?%){0,3}\)$/.test(style.clipPath)) {
        const values = style.clipPath.slice(6, -1).trim().split(/\s+/).map(Number.parseFloat);
        const [top, right = top, bottom = top, left = right] = values;
        if (top + bottom >= 100 || left + right >= 100) return true;
      }
      // Legacy clip only applies to positioned boxes. Do not interpret auto, calc, SVG or
      // partially clipped shapes as invisible, nor alter the target iframe's own checks.
      if (['absolute', 'fixed'].includes(style.position) &&
          /^rect\(-?\d+(?:\.\d+)?px,\s*-?\d+(?:\.\d+)?px,\s*-?\d+(?:\.\d+)?px,\s*-?\d+(?:\.\d+)?px\)$/.test(style.clip)) {
        const [top, right, bottom, left] = style.clip.slice(5, -1).split(',').map(Number.parseFloat);
        return bottom <= top || right <= left;
      }
      return false;
    };
    // Include pointer-events:none overlays, which elementFromPoint alone would miss. Trusted
    // layouts with overlapping decorative layers deliberately report unavailable instead of
    // saving a screenshot whose visible evidence is uncertain.
    const elements = document.querySelectorAll('body *');
    if (elements.length > 20000) return {unavailable:'dom-budget'};
    for (const element of elements) {
      if (element === frame || element.contains(frame) || frame.contains(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.right <= rect.x || box.bottom <= rect.y || box.left >= endX || box.top >= endY) continue;
      const style = getComputedStyle(element);
      if (style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) !== 0 && !hasEmptyClip(style)) return {unavailable:'overlapping-element'};
    }
    for (const x of [rect.x + 0.5, rect.x + rect.width / 2, endX - 0.5]) {
      for (const y of [rect.y + 0.5, rect.y + rect.height / 2, endY - 0.5]) {
        if (document.elementFromPoint(x, y) !== frame) return {unavailable:'hit-test-mismatch'};
      }
    }
    return { documentUrl: location.href, sourceUrl: frame.src,
      devicePixelRatio, viewportWidth: innerWidth, viewportHeight: innerHeight, rect };
  })()`
}
const fingerprint = (frame: CaptureFrame): string =>
  JSON.stringify([frame.frameToken, frame.processId, frame.url, frame.origin])
function child(parent: CaptureFrame, origin: string): CaptureFrame {
  const matches = parent.frames.filter(
    (frame) => frame.parent === parent && originOf(frame.url) === origin && frame.origin === origin
  )
  if (matches.length !== 1) throw unavailable('frame-binding')
  return matches[0]
}
function live(frame: CaptureFrame): void {
  if (frame.detached || frame.isDestroyed() || frame.visibilityState !== 'visible')
    throw unavailable('frame-hidden')
}
async function bounded<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(unavailable('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(unavailable('timeout')), 5000)
    timer.unref()
  })
  try {
    return await Promise.race([read, cancelled])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Uses an existing visible Electron window. It never creates a browser, navigates or weakens webSecurity. */
export function createElectronProjectCapture(
  dependencies?: ElectronProjectCaptureDependencies
): ElectronProjectCapture {
  return async (input) => {
    let stage: CaptureStage = 'authority'
    let measurement: ElectronProjectCaptureDiagnostic['measurement']
    try {
      const { caller, signal } = input
      if (
        !caller.isAuthorizationCurrent() ||
        caller.surface !== 'electron' ||
        caller.location !== 'local' ||
        !/^[1-9]\d*$/.test(caller.clientId)
      )
        throw unavailable('caller-invalid')
      const id = Number(caller.clientId)
      if (!Number.isSafeInteger(id)) throw unavailable('caller-invalid')
      const viewerOrigin = checkedOrigin(input.viewerOrigin),
        projectOrigin = checkedOrigin(input.projectOrigin)
      if (viewerOrigin === projectOrigin) throw unavailable('origin-invalid')
      const electron = dependencies ? undefined : await import('electron')
      const adapter: ElectronProjectCaptureDependencies = dependencies ?? {
        fromId: (id) => electron!.webContents.fromId(id),
        windowFor: (contents) =>
          electron!.BrowserWindow.fromWebContents(contents as Electron.WebContents)
      }
      stage = 'frame-binding'
      const contents = adapter.fromId(id)
      if (!contents) throw unavailable('contents-unavailable')
      const window = adapter.windowFor(contents)
      const lease = [caller.clientId, caller.leaseId, caller.lifecycleClientId].join('\0')
      const root = contents.mainFrame,
        viewer = child(root, viewerOrigin),
        project = child(viewer, projectOrigin)
      const identities = [fingerprint(root), fingerprint(viewer), fingerprint(project)]
      const zoom = contents.getZoomFactor()
      if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) throw unavailable('zoom-invalid')
      const assertCurrent = (): void => {
        signal.throwIfAborted()
        if (
          !caller.isAuthorizationCurrent() ||
          lease !== [caller.clientId, caller.leaseId, caller.lifecycleClientId].join('\0')
        )
          throw unavailable('lease-revoked')
        if (
          contents.isDestroyed() ||
          adapter.fromId(id) !== contents ||
          contents.id !== id ||
          !window ||
          adapter.windowFor(contents) !== window ||
          window.isDestroyed()
        )
          throw unavailable('contents-unavailable')
        if (!window.isVisible() || window.isMinimized()) throw unavailable('window-hidden')
        if (!window.isFocused()) throw unavailable('window-unfocused')
        if (contents.getZoomFactor() !== zoom) throw unavailable('zoom-invalid')
        if (
          contents.mainFrame !== root ||
          child(root, viewerOrigin) !== viewer ||
          child(viewer, projectOrigin) !== project ||
          identities.some(
            (identity, index) => identity !== fingerprint([root, viewer, project][index])
          )
        )
          throw unavailable('frame-binding')
        for (const frame of [root, viewer, project]) live(frame)
      }
      const readMeasurement = async (frame: CaptureFrame, origin: string): Promise<Measurement> => {
        const value = await bounded(
          frame.executeJavaScript(projectSurfaceMeasurementScript(origin)),
          signal
        )
        const failure = failureSchema.safeParse(value)
        if (failure.success) {
          const { unavailable: reason, ...detail } = failure.data
          throw new CaptureUnavailable(reason, detail)
        }
        const parsed = projectSurfaceMeasurementSchema.safeParse(value)
        if (!parsed.success) throw unavailable('measurement-invalid')
        return parsed.data
      }
      const measure = async (
        pass: NonNullable<typeof measurement>
      ): Promise<{ outer: Measurement; inner: Measurement }> => {
        measurement = pass
        assertCurrent()
        stage = 'measure-root'
        const outer = await readMeasurement(root, viewerOrigin)
        assertCurrent()
        stage = 'measure-viewer'
        const inner = await readMeasurement(viewer, projectOrigin)
        assertCurrent()
        stage = 'measure-identity'
        const mismatch = projectSurfaceIdentityDiagnostic(
          { outer, inner },
          { rootUrl: root.url, viewerUrl: viewer.url, viewerOrigin, projectOrigin }
        )
        if (mismatch) throw new CaptureUnavailable('measurement-identity', mismatch)
        return { outer, inner }
      }
      assertCurrent()
      const initial = await measure('initial')
      stage = 'crop'
      // DOM coordinates are CSS px in their respective documents. Sum offsets first; apply the
      // Electron page zoom once to obtain root-view DIPs. Never multiply by devicePixelRatio.
      const x = Math.ceil((initial.outer.rect.x + initial.inner.rect.x) * zoom)
      const y = Math.ceil((initial.outer.rect.y + initial.inner.rect.y) * zoom)
      const rect = {
        x,
        y,
        width:
          Math.floor(
            (initial.outer.rect.x + initial.inner.rect.x + initial.inner.rect.width) * zoom
          ) - x,
        height:
          Math.floor(
            (initial.outer.rect.y + initial.inner.rect.y + initial.inner.rect.height) * zoom
          ) - y
      }
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.width > 4096 ||
        rect.height > 4096 ||
        rect.width * rect.height > 4_194_304
      )
        throw unavailable('crop-budget')
      // capturePage accepts DIPs but returns a physical-pixel bitmap on Retina displays. The
      // trusted root DPR contains page zoom, so divide it out only for output-size verification.
      const displayScale = initial.outer.devicePixelRatio / zoom
      if (
        displayScale < 0.5 ||
        displayScale > 4 ||
        rect.width * rect.height * displayScale ** 2 > 16_777_216
      )
        throw unavailable('pixel-budget')
      const confirmed = await measure('confirmed')
      if (JSON.stringify(initial) !== JSON.stringify(confirmed)) throw unavailable('layout-changed')
      assertCurrent()
      stage = 'capture-page'
      const image = await bounded(contents.capturePage(rect), signal)
      assertCurrent()
      const after = await measure('after')
      if (JSON.stringify(initial) !== JSON.stringify(after)) throw unavailable('layout-changed')
      stage = 'image-validation'
      if (image.isEmpty()) throw unavailable('empty-image')
      const size = image.getSize()
      if (
        Math.abs(size.width - rect.width * displayScale) > 1 ||
        Math.abs(size.height - rect.height * displayScale) > 1
      )
        throw unavailable('image-size')
      const bytes = image.toPNG()
      assertCurrent()
      if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw unavailable('image-bytes')
      return { bytes: Uint8Array.from(bytes) }
    } catch (error) {
      // Never log arbitrary DOM, URLs, origin grants or exception strings. The diagnostic is a
      // fixed private vocabulary; public callers continue to receive the same generic failure.
      const diagnostic: ElectronProjectCaptureDiagnostic = {
        stage,
        reason:
          error instanceof CaptureUnavailable
            ? error.reason
            : input.signal.aborted
              ? 'cancelled'
              : 'host-error',
        ...(measurement ? { measurement } : {}),
        ...(error instanceof CaptureUnavailable ? error.detail : {})
      }
      try {
        if (dependencies?.reportDiagnostic) dependencies.reportDiagnostic(diagnostic)
        else log.warn('Project image capture rejected', diagnostic)
      } catch {
        /* Diagnostics cannot change capture admission. */
      }
      throw new Error('Visible project frame is unavailable or changed during capture.')
    }
  }
}

/** Stable production entry point; importing this module does not initialize Electron. */
export const captureElectronObservationView: ElectronProjectCapture = createElectronProjectCapture()
