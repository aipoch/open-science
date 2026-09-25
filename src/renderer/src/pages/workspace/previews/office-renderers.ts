import { i18next } from '../../../i18n'
import type { PptxViewer } from '@aiden0z/pptx-renderer'

import type { OfficeFileExtension } from './office-package'
import { extractPptxNotes, type PptxNotesBySlide } from './pptx-notes'

export type OfficeRenderCleanup = () => void | Promise<void>
export type OfficeRenderStatus = {
  phase: 'parsing' | 'rendering'
}

type RenderOfficeFileOptions = {
  bytes: Uint8Array
  extension: OfficeFileExtension
  name: string
  container: HTMLDivElement
  signal: AbortSignal
  onStatus?: (status: OfficeRenderStatus) => void
  onError?: (error: Error) => void
}

type TargetedOfficeRenderSession = {
  pageCount: number
  pageCountComplete: boolean
  availablePages: number[]
  preparePage(pageNumber: number): Promise<HTMLElement>
  dispose: OfficeRenderCleanup
}

type RenderTargetedOfficeFileOptions = Omit<
  RenderOfficeFileOptions,
  'extension' | 'name' | 'onStatus' | 'onError'
> & {
  extension: 'docx' | 'pptx'
  targetPages: number[]
}

const MAX_TARGETED_DOCX_PAGE = 512

const settleTargetImages = async (page: HTMLElement, signal: AbortSignal): Promise<void> => {
  const images = [...page.querySelectorAll('img')]
  for (let attempt = 0; images.some((image) => !image.src) && attempt < 120; attempt += 1) {
    if (signal.aborted)
      throw signal.reason ?? new DOMException('Office preview aborted', 'AbortError')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  await Promise.all(
    images.map(async (image) => {
      if (!image.src || typeof image.decode !== 'function') return
      try {
        await image.decode()
      } catch {
        // A broken embedded image stays visible as the renderer's native broken-image state.
      }
    })
  )
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}

// Collects renderer-owned Blob URLs from attributes and generated styles for deterministic cleanup.
const collectBlobUrls = (container: HTMLElement): Set<string> => {
  const urls = new Set<string>()
  const elements = [container, ...container.querySelectorAll<HTMLElement>('*')]

  for (const element of elements) {
    for (const attribute of element.getAttributeNames()) {
      for (const match of element.getAttribute(attribute)?.matchAll(/blob:[^)'"\s]+/g) ?? []) {
        urls.add(match[0])
      }
    }
  }
  for (const style of container.querySelectorAll('style')) {
    for (const match of style.textContent?.matchAll(/blob:[^)'"\s]+/g) ?? []) {
      urls.add(match[0])
    }
  }

  return urls
}

const clearContainer = (container: HTMLElement): void => {
  container.replaceChildren()
}

const DOCX_SCALE_PROPERTY = '--open-science-docx-scale'
const DOCX_MIN_SCALE = 0.25
const DOCX_MAX_SCALE = 1
const DOCX_FIT_STYLE = `
.docx-wrapper {
  background: transparent;
  padding: 0;
}
.docx-wrapper > section.docx {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  content-visibility: auto;
  contain-intrinsic-size: auto 1123px;
  zoom: var(${DOCX_SCALE_PROPERTY}, 1);
  transform-origin: top center;
}
`

// Fits the rendered paper width inside the preview viewport without reflowing Word page content.
const applyDocxFit = (container: HTMLElement, wrapper: HTMLElement): void => {
  const view = container.ownerDocument.defaultView
  const pages = wrapper.querySelectorAll<HTMLElement>('section.docx')
  if (!view || pages.length === 0) return

  const wrapperStyle = view.getComputedStyle(wrapper)
  const horizontalPadding =
    Number.parseFloat(wrapperStyle.paddingLeft) + Number.parseFloat(wrapperStyle.paddingRight)
  const availableWidth = container.clientWidth - horizontalPadding
  // Mixed portrait and landscape documents must fit against their widest rendered paper.
  const pageWidth = Math.max(
    ...Array.from(pages, (page) => Number.parseFloat(view.getComputedStyle(page).width))
  )
  if (!Number.isFinite(availableWidth) || availableWidth <= 0 || !Number.isFinite(pageWidth)) return

  const requestedScale = availableWidth / pageWidth
  const scale = Math.min(DOCX_MAX_SCALE, Math.max(DOCX_MIN_SCALE, requestedScale))
  // Center fitted pages, but keep the left edge reachable when minimum zoom still overflows.
  wrapper.style.alignItems = requestedScale < DOCX_MIN_SCALE ? 'flex-start' : 'center'
  wrapper.style.setProperty(DOCX_SCALE_PROPERTY, String(scale))
}

// Installs responsive paper fitting after docx-preview has populated its generated wrapper.
const installDocxFit = (container: HTMLElement, wrapper: HTMLElement): OfficeRenderCleanup => {
  const view = container.ownerDocument.defaultView
  const style = container.ownerDocument.createElement('style')
  style.dataset.openScienceDocxFit = 'true'
  style.textContent = DOCX_FIT_STYLE
  container.appendChild(style)
  wrapper.style.alignItems = 'center'
  applyDocxFit(container, wrapper)

  let animationFrame: number | undefined
  const scheduleFit = (): void => {
    if (!view || animationFrame !== undefined) return
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = undefined
      applyDocxFit(container, wrapper)
    })
  }
  const ResizeObserverCtor = view?.ResizeObserver
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleFit) : undefined
  resizeObserver?.observe(container)

  return () => {
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) view?.cancelAnimationFrame(animationFrame)
    wrapper.style.removeProperty(DOCX_SCALE_PROPERTY)
    wrapper.style.removeProperty('align-items')
    style.remove()
  }
}

type PptxViewerDimensions = {
  slideWidth: number
  slideHeight: number
  zoomPercent?: number
}

type PptxFitMetrics = {
  scale: number
  displayWidth: number
  displayHeight: number
}

type PptxReviewSurface = {
  root: HTMLDivElement
  thumbnails: HTMLDivElement
  stage: HTMLDivElement
  previous: HTMLButtonElement
  next: HTMLButtonElement
  toggleNavigation: HTMLButtonElement
  zoomOut: HTMLButtonElement
  zoomReset: HTMLButtonElement
  zoomIn: HTMLButtonElement
  counter: HTMLSpanElement
  notes: HTMLElement
  notesBody: HTMLParagraphElement
}

type PptxSlideHandle = {
  dispose: () => void
}

type PptxThumbnailHandle = PptxSlideHandle & {
  element?: HTMLElement
  ready: Promise<void>
}

const createPptxReviewSurface = (container: HTMLDivElement): PptxReviewSurface => {
  const document = container.ownerDocument
  const root = document.createElement('div')
  root.className = 'pptx-review'

  const toolbar = document.createElement('div')
  toolbar.className = 'pptx-review-toolbar'

  const toggleNavigation = document.createElement('button')
  toggleNavigation.className = 'pptx-review-button'
  toggleNavigation.type = 'button'
  toggleNavigation.textContent = '☰'
  toggleNavigation.setAttribute('aria-pressed', 'true')
  toggleNavigation.title = i18next.t('Hide navigation')
  toggleNavigation.setAttribute('aria-label', i18next.t('Hide navigation'))

  const previous = document.createElement('button')
  previous.className = 'pptx-review-button'
  previous.type = 'button'
  previous.textContent = '‹'
  previous.title = i18next.t('Previous')
  previous.setAttribute('aria-label', i18next.t('Previous'))

  const counter = document.createElement('span')
  counter.className = 'pptx-review-counter'
  counter.setAttribute('aria-live', 'polite')

  const next = document.createElement('button')
  next.className = 'pptx-review-button'
  next.type = 'button'
  next.textContent = '›'
  next.title = i18next.t('Next')
  next.setAttribute('aria-label', i18next.t('Next'))

  const zoomControls = document.createElement('div')
  zoomControls.className = 'pptx-review-zoom'

  const zoomOut = document.createElement('button')
  zoomOut.className = 'pptx-review-button'
  zoomOut.type = 'button'
  zoomOut.textContent = '−'
  zoomOut.title = i18next.t('Zoom out')
  zoomOut.setAttribute('aria-label', i18next.t('Zoom out'))

  const zoomReset = document.createElement('button')
  zoomReset.className = 'pptx-review-button pptx-review-zoom-reset'
  zoomReset.type = 'button'
  zoomReset.title = i18next.t('Reset zoom')
  zoomReset.setAttribute('aria-label', i18next.t('Reset zoom'))

  const zoomIn = document.createElement('button')
  zoomIn.className = 'pptx-review-button'
  zoomIn.type = 'button'
  zoomIn.textContent = '+'
  zoomIn.title = i18next.t('Zoom in')
  zoomIn.setAttribute('aria-label', i18next.t('Zoom in'))

  zoomControls.append(zoomOut, zoomReset, zoomIn)
  toolbar.append(toggleNavigation, previous, counter, next, zoomControls)

  const body = document.createElement('div')
  body.className = 'pptx-review-body'

  const thumbnails = document.createElement('div')
  thumbnails.className = 'pptx-review-thumbnails'
  thumbnails.setAttribute('aria-label', i18next.t('Pages'))

  const stage = document.createElement('div')
  stage.className = 'pptx-review-stage'
  stage.tabIndex = 0
  stage.setAttribute('role', 'document')
  stage.setAttribute('aria-label', i18next.t('Preview'))

  const content = document.createElement('div')
  content.className = 'pptx-review-content'

  const notes = document.createElement('aside')
  notes.className = 'pptx-review-notes'
  notes.hidden = false
  notes.setAttribute('aria-label', i18next.t('Notes'))
  const notesHeading = document.createElement('h2')
  notesHeading.className = 'pptx-review-notes-heading'
  notesHeading.textContent = i18next.t('Notes')
  const notesBody = document.createElement('p')
  notesBody.className = 'pptx-review-notes-body'
  notesBody.setAttribute('aria-live', 'polite')
  notesBody.setAttribute('aria-atomic', 'true')
  notes.append(notesHeading, notesBody)
  content.append(stage, notes)

  body.append(thumbnails, content)
  root.append(toolbar, body)
  container.replaceChildren(root)

  return {
    root,
    thumbnails,
    stage,
    previous,
    next,
    toggleNavigation,
    zoomOut,
    zoomReset,
    zoomIn,
    counter,
    notes,
    notesBody
  }
}

const PPTX_MIN_ZOOM = 50
const PPTX_MAX_ZOOM = 200
const PPTX_ZOOM_STEP = 25
// Ctrl/Cmd + trackpad pinch arrives as a stream of wheel events. Accumulate it once per frame
// so a single gesture produces one smooth zoom update instead of re-rendering for every event.
const PPTX_WHEEL_ZOOM_SENSITIVITY = 0.25
const PPTX_WHEEL_ZOOM_STEP = 5
const PPTX_PAN_THRESHOLD = 4

const installPptxReviewControls = (
  surface: PptxReviewSurface,
  viewer: PptxViewer,
  onSlideSettled?: () => void,
  notesPromise?: Promise<PptxNotesBySlide>,
  zoomController?: { get: () => number; set: (percent: number) => void },
  onThumbnailDisposed?: () => void
): OfficeRenderCleanup => {
  const document = surface.root.ownerDocument
  let disposed = false
  let panStart:
    | {
        pointerId: number
        x: number
        y: number
        scrollLeft: number
        scrollTop: number
        dragging: boolean
      }
    | undefined
  let pendingPan: { scrollLeft: number; scrollTop: number } | undefined
  let panFrame: number | undefined
  let pendingWheelDelta = 0
  let wheelZoomRemainder = 0
  let wheelZoomPercent: number | undefined
  let wheelZoomFrame: number | undefined
  let activeThumbnail: HTMLButtonElement | undefined
  let thumbnailFrame: number | undefined
  let notesBySlide: PptxNotesBySlide = new Map()
  const thumbnailHandles = new Map<number, PptxThumbnailHandle>()
  const thumbnailItems = new Map<number, HTMLButtonElement>()
  const thumbnailQueue = new Set<number>()
  const updateThumbnailLayout = (index: number): void => {
    const handle = thumbnailHandles.get(index)
    const item = thumbnailItems.get(index)
    const host = item?.querySelector<HTMLElement>('.pptx-review-thumbnail-host')
    if (!handle || !host) return
    const width = Math.max(1, Math.floor(host.clientWidth || 142))
    const thumbnail = handle.element ?? host.firstElementChild
    const slide = thumbnail?.firstElementChild
    if (thumbnail instanceof HTMLElement) {
      thumbnail.style.width = `${width}px`
      thumbnail.style.height = `${width * (viewer.slideHeight / viewer.slideWidth)}px`
      thumbnail.style.flex = '0 0 auto'
    }
    if (slide instanceof HTMLElement && viewer.slideWidth > 0) {
      slide.style.transform = `scale(${width / viewer.slideWidth})`
      slide.style.transformOrigin = 'top left'
    }
  }
  const disposeThumbnail = (index: number): void => {
    thumbnailQueue.delete(index)
    const handle = thumbnailHandles.get(index)
    if (!handle) return
    handle.dispose()
    thumbnailHandles.delete(index)
    onThumbnailDisposed?.()
  }
  const thumbnailObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const index = Number(entry.target.getAttribute('data-slide'))
              if (entry.isIntersecting) scheduleThumbnail(index)
              else if (index !== viewer.currentSlideIndex) disposeThumbnail(index)
            }
          },
          { root: surface.thumbnails, rootMargin: '320px 0px' }
        )
      : undefined
  const thumbnailResizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          for (const index of thumbnailHandles.keys()) updateThumbnailLayout(index)
        })
      : undefined
  thumbnailResizeObserver?.observe(surface.thumbnails)

  const updateActiveSlide = (index: number): void => {
    const count = viewer.slideCount
    surface.counter.textContent = `${index + 1} / ${count}`
    surface.previous.disabled = index <= 0
    surface.next.disabled = index >= count - 1
    const activeItem = thumbnailItems.get(index)
    if (activeItem !== activeThumbnail) {
      activeThumbnail?.removeAttribute('data-active')
      activeThumbnail?.removeAttribute('aria-current')
      activeItem?.setAttribute('data-active', 'true')
      activeItem?.setAttribute('aria-current', 'true')
      activeThumbnail = activeItem
      if (activeItem && typeof activeItem.scrollIntoView === 'function') {
        activeItem.scrollIntoView({ block: 'nearest' })
      }
    }
    scheduleThumbnail(index)
    const note = notesBySlide.get(index) ?? ''
    surface.notesBody.textContent = note
    surface.notes.hidden = false
  }

  const mountThumbnail = (index: number): void => {
    if (thumbnailHandles.has(index)) return
    const item = thumbnailItems.get(index)
    const host = item?.querySelector<HTMLElement>('.pptx-review-thumbnail-host')
    if (!host) return
    // Match the renderer's intrinsic width to the slot after padding/borders have been applied.
    // A fixed width leaves the right edge of a thumbnail outside its host at narrow panel sizes.
    const width = Math.max(1, Math.floor(host.clientWidth || 142))
    const handle = viewer.renderThumbnailToContainer(index, host, {
      width
    }) as PptxThumbnailHandle | null
    if (!handle) return

    thumbnailHandles.set(index, handle)
    void handle.ready.catch(() => {
      // A retired thumbnail may finish after this page has acquired a replacement handle.
      if (disposed || thumbnailHandles.get(index) !== handle) return
      disposeThumbnail(index)
      host.replaceChildren()
    })
    // The vendor thumbnail API owns the DOM shape, but older renderer builds can leave the
    // returned slide at intrinsic size. Reapply the same scale to the returned slide so a
    // narrow rail cannot expose only the left edge of the slide.
    updateThumbnailLayout(index)
  }

  const flushThumbnailQueue = (): void => {
    thumbnailFrame = undefined
    const [index] = thumbnailQueue
    if (index === undefined) return
    thumbnailQueue.delete(index)
    mountThumbnail(index)
    if (thumbnailQueue.size > 0) scheduleThumbnailFrame()
  }

  const scheduleThumbnailFrame = (): void => {
    if (thumbnailFrame !== undefined) return
    const view = document.defaultView
    if (!view) {
      flushThumbnailQueue()
      return
    }
    thumbnailFrame = view.requestAnimationFrame(flushThumbnailQueue)
  }

  const scheduleThumbnail = (index: number): void => {
    if (thumbnailHandles.has(index)) return
    thumbnailQueue.add(index)
    scheduleThumbnailFrame()
  }

  const focusStage = (): void => {
    if (document.activeElement !== surface.stage) surface.stage.focus({ preventScroll: true })
  }

  const goToSlide = (index: number): void => {
    // Keep keyboard navigation on the review surface after a toolbar or thumbnail click. Without
    // this, the clicked button retains focus and the stage intentionally ignores arrow keys.
    focusStage()
    void Promise.resolve(viewer.goToSlide(index)).then(() => {
      if (!disposed) onSlideSettled?.()
    })
  }

  const updateZoomControls = (): void => {
    const zoom = Math.round(zoomController?.get() ?? viewer.zoomPercent)
    surface.zoomOut.disabled = zoom <= PPTX_MIN_ZOOM
    surface.zoomIn.disabled = zoom >= PPTX_MAX_ZOOM
    surface.zoomReset.disabled = zoom === 100
    surface.zoomReset.textContent = `${zoom}%`
  }

  const cancelPendingWheelZoom = (): void => {
    pendingWheelDelta = 0
    wheelZoomRemainder = 0
    if (wheelZoomFrame === undefined) return
    ;(document.defaultView ?? window).cancelAnimationFrame(wheelZoomFrame)
    wheelZoomFrame = undefined
  }

  const setZoom = (percent: number): void => {
    cancelPendingWheelZoom()
    wheelZoomPercent = undefined
    const update = zoomController ? zoomController.set(percent) : viewer.setZoom(percent)
    void Promise.resolve(update).then(() => {
      if (disposed) return
      updateZoomControls()
      onSlideSettled?.()
    })
  }

  const changeZoom = (delta: number): void => {
    const next = Math.min(
      PPTX_MAX_ZOOM,
      Math.max(
        PPTX_MIN_ZOOM,
        Math.round((zoomController?.get() ?? viewer.zoomPercent) / PPTX_ZOOM_STEP) *
          PPTX_ZOOM_STEP +
          delta
      )
    )
    setZoom(next)
  }

  const onZoomOut = (): void => changeZoom(-PPTX_ZOOM_STEP)
  const onZoomReset = (): void => setZoom(100)
  const onZoomIn = (): void => changeZoom(PPTX_ZOOM_STEP)

  const flushWheelZoom = (): void => {
    wheelZoomFrame = undefined
    const delta = pendingWheelDelta
    pendingWheelDelta = 0
    if (delta === 0) return
    wheelZoomRemainder -= delta * PPTX_WHEEL_ZOOM_SENSITIVITY
    const step =
      wheelZoomRemainder >= 0
        ? Math.floor(wheelZoomRemainder / PPTX_WHEEL_ZOOM_STEP) * PPTX_WHEEL_ZOOM_STEP
        : Math.ceil(wheelZoomRemainder / PPTX_WHEEL_ZOOM_STEP) * PPTX_WHEEL_ZOOM_STEP
    if (step === 0) return
    wheelZoomRemainder -= step
    const current = wheelZoomPercent ?? zoomController?.get() ?? viewer.zoomPercent
    const next = Math.min(PPTX_MAX_ZOOM, Math.max(PPTX_MIN_ZOOM, current + step))
    if (next === current) {
      wheelZoomRemainder = 0
      return
    }
    wheelZoomPercent = next
    const update = zoomController ? zoomController.set(next) : viewer.setZoom(next)
    void Promise.resolve(update).then(() => {
      if (disposed || wheelZoomPercent !== next) return
      wheelZoomPercent = undefined
      updateZoomControls()
      onSlideSettled?.()
    })
  }

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    pendingWheelDelta += event.deltaY
    wheelZoomFrame ??= (document.defaultView ?? window).requestAnimationFrame(flushWheelZoom)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (
      event.target instanceof Element &&
      event.target.closest(
        'a, button, input, textarea, select, [contenteditable="true"], [role="button"], [role="link"]'
      )
    ) {
      return
    }
    focusStage()
    panStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: surface.stage.scrollLeft,
      scrollTop: surface.stage.scrollTop,
      dragging: false
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!panStart || event.pointerId !== panStart.pointerId) return
    const deltaX = event.clientX - panStart.x
    const deltaY = event.clientY - panStart.y
    if (!panStart.dragging) {
      if (Math.hypot(deltaX, deltaY) < PPTX_PAN_THRESHOLD) return
      panStart.dragging = true
      surface.stage.setPointerCapture?.(event.pointerId)
      surface.stage.classList.add('pptx-review-stage--panning')
    }
    pendingPan = {
      scrollLeft: panStart.scrollLeft - deltaX,
      scrollTop: panStart.scrollTop - deltaY
    }
    if (panFrame === undefined) {
      const view = document.defaultView
      if (view) {
        panFrame = view.requestAnimationFrame(() => {
          panFrame = undefined
          if (!pendingPan) return
          surface.stage.scrollLeft = pendingPan.scrollLeft
          surface.stage.scrollTop = pendingPan.scrollTop
          pendingPan = undefined
        })
      }
    }
    event.preventDefault()
  }

  const stopPanning = (event?: PointerEvent): void => {
    if (!panStart || (event && event.pointerId !== panStart.pointerId)) return
    if (event && panStart.dragging) surface.stage.releasePointerCapture?.(event.pointerId)
    if (panFrame !== undefined) {
      document.defaultView?.cancelAnimationFrame(panFrame)
      panFrame = undefined
    }
    if (pendingPan) {
      surface.stage.scrollLeft = pendingPan.scrollLeft
      surface.stage.scrollTop = pendingPan.scrollTop
      pendingPan = undefined
    }
    panStart = undefined
    surface.stage.classList.remove('pptx-review-stage--panning')
  }

  for (let index = 0; index < viewer.slideCount; index += 1) {
    const item = document.createElement('button')
    item.className = 'pptx-review-thumbnail'
    item.type = 'button'
    item.setAttribute('data-slide', String(index))
    item.setAttribute('aria-label', `${i18next.t('Page')} ${index + 1}`)
    const host = document.createElement('span')
    host.className = 'pptx-review-thumbnail-host'
    const label = document.createElement('span')
    label.className = 'pptx-review-thumbnail-label'
    label.textContent = String(index + 1)
    item.append(host, label)
    item.addEventListener('click', () => goToSlide(index))
    surface.thumbnails.appendChild(item)
    thumbnailItems.set(index, item)
    if (thumbnailObserver) thumbnailObserver.observe(item)
    else if (index < 12) mountThumbnail(index)
  }

  const onSlideChange = (event: Event): void => {
    const index = (event as CustomEvent<{ index: number }>).detail.index
    updateActiveSlide(index)
  }
  viewer.addEventListener('slidechange', onSlideChange)

  const onPrevious = (): void => goToSlide(viewer.currentSlideIndex - 1)
  const onNext = (): void => goToSlide(viewer.currentSlideIndex + 1)
  const onToggleNavigation = (): void => {
    const hidden = surface.root.classList.toggle('pptx-review--nav-hidden')
    const label = i18next.t(hidden ? 'Show navigation' : 'Hide navigation')
    surface.toggleNavigation.setAttribute('aria-pressed', String(!hidden))
    surface.toggleNavigation.title = label
    surface.toggleNavigation.setAttribute('aria-label', label)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest('button, input, textarea, select, [contenteditable="true"]')
    ) {
      return
    }
    const last = viewer.slideCount - 1
    const nextIndex =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp'
        ? viewer.currentSlideIndex - 1
        : event.key === 'ArrowRight' ||
            event.key === 'ArrowDown' ||
            event.key === 'PageDown' ||
            event.key === ' '
          ? viewer.currentSlideIndex + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined
    if (nextIndex === undefined || nextIndex < 0 || nextIndex > last) return
    event.preventDefault()
    goToSlide(nextIndex)
  }

  surface.previous.addEventListener('click', onPrevious)
  surface.next.addEventListener('click', onNext)
  surface.toggleNavigation.addEventListener('click', onToggleNavigation)
  surface.zoomOut.addEventListener('click', onZoomOut)
  surface.zoomReset.addEventListener('click', onZoomReset)
  surface.zoomIn.addEventListener('click', onZoomIn)
  surface.stage.addEventListener('keydown', onKeyDown)
  surface.stage.addEventListener('wheel', onWheel, { passive: false })
  surface.stage.addEventListener('pointerdown', onPointerDown)
  surface.stage.addEventListener('pointermove', onPointerMove)
  surface.stage.addEventListener('pointerup', stopPanning)
  surface.stage.addEventListener('pointercancel', stopPanning)
  updateZoomControls()
  updateActiveSlide(viewer.currentSlideIndex)
  void notesPromise?.then((notes) => {
    if (disposed) return
    notesBySlide = notes
    updateActiveSlide(viewer.currentSlideIndex)
  })

  return () => {
    disposed = true
    viewer.removeEventListener('slidechange', onSlideChange)
    surface.previous.removeEventListener('click', onPrevious)
    surface.next.removeEventListener('click', onNext)
    surface.toggleNavigation.removeEventListener('click', onToggleNavigation)
    surface.zoomOut.removeEventListener('click', onZoomOut)
    surface.zoomReset.removeEventListener('click', onZoomReset)
    surface.zoomIn.removeEventListener('click', onZoomIn)
    surface.stage.removeEventListener('keydown', onKeyDown)
    surface.stage.removeEventListener('wheel', onWheel)
    surface.stage.removeEventListener('pointerdown', onPointerDown)
    surface.stage.removeEventListener('pointermove', onPointerMove)
    surface.stage.removeEventListener('pointerup', stopPanning)
    surface.stage.removeEventListener('pointercancel', stopPanning)
    stopPanning()
    if (panFrame !== undefined) document.defaultView?.cancelAnimationFrame(panFrame)
    panFrame = undefined
    pendingPan = undefined
    cancelPendingWheelZoom()
    if (thumbnailFrame !== undefined) document.defaultView?.cancelAnimationFrame(thumbnailFrame)
    thumbnailFrame = undefined
    thumbnailQueue.clear()
    thumbnailObserver?.disconnect()
    thumbnailResizeObserver?.disconnect()
    thumbnailHandles.forEach((handle) => handle.dispose())
    thumbnailHandles.clear()
    activeThumbnail = undefined
  }
}

const PPTX_FALLBACK_WIDTH = 960
const MAX_PPTX_MEDIA_URLS = 64

type PptxMediaResolverInternals = {
  media?: Map<string, Uint8Array>
  loadedPaths?: Set<string>
}

// Isolates the only pinned-version private hook and fails closed when the vendor shape changes.
const installPptxMediaUrlCache = (viewer: unknown, cache: Map<string, string>): void => {
  const contract = viewer as { mediaUrlCache?: unknown }
  if (!(contract.mediaUrlCache instanceof Map)) {
    throw new Error('PPTX renderer media cache contract changed')
  }
  contract.mediaUrlCache = cache
}

// Decoded-media eviction needs the lazy resolver's pinned internal stores to remain available.
const requirePptxMediaResolverInternals = (resolver: unknown): PptxMediaResolverInternals => {
  const contract = resolver as PptxMediaResolverInternals | undefined
  if (!(contract?.media instanceof Map) || !(contract.loadedPaths instanceof Set)) {
    throw new Error('PPTX renderer media resolver contract changed')
  }
  return contract
}

// Drops every alias for one decoded media buffer so the lazy resolver can decode it again later.
const releaseDecodedPptxMedia = (
  resolver: PptxMediaResolverInternals | undefined,
  mediaPath: string
): void => {
  const media = resolver?.media
  // EMF rendering stores derived Blob URLs under suffixed keys while decoded bytes use the path.
  const sourceMediaPath = mediaPath.replace(/:emf-(?:pdf|bitmap)$/, '')
  const decoded = media?.get(sourceMediaPath)
  if (!media || !decoded) return

  for (const [path, value] of media) {
    if (value !== decoded) continue
    media.delete(path)
    resolver.loadedPaths?.delete(path)
  }
}

// Uses a soft cap: the active viewport working set may exceed it, but inactive media cannot.
class BoundedBlobUrlCache extends Map<string, string> {
  private onEvict?: (key: string) => void

  setEvictionHandler(handler: (key: string) => void): void {
    this.onEvict = handler
  }

  override get(key: string): string | undefined {
    const value = super.get(key)
    if (value === undefined) return undefined
    super.delete(key)
    super.set(key, value)
    return value
  }

  override set(key: string, value: string): this {
    const previous = super.get(key)
    if (previous && previous !== value) URL.revokeObjectURL(previous)
    super.delete(key)
    super.set(key, value)
    return this
  }

  override clear(): void {
    for (const [key, url] of this) {
      URL.revokeObjectURL(url)
      this.onEvict?.(key)
    }
    super.clear()
  }

  trim(protectedUrls: ReadonlySet<string> = new Set()): void {
    while (this.size > MAX_PPTX_MEDIA_URLS) {
      const candidate = [...this.entries()].find(([, url]) => !protectedUrls.has(url))
      if (!candidate) break
      const [oldestKey, oldestUrl] = candidate
      super.delete(oldestKey)
      URL.revokeObjectURL(oldestUrl)
      this.onEvict?.(oldestKey)
    }
  }
}

// Reads rendered attributes so shared media stays alive while any mounted slide still references it.
const collectReferencedPptxMediaUrls = (
  container: HTMLElement,
  cache: ReadonlyMap<string, string>
): Set<string> => {
  const cachedUrls = new Set(cache.values())
  const referenced = new Set<string>()
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      for (const url of cachedUrls) {
        if (attribute.value.includes(url)) referenced.add(url)
      }
    }
  }
  return referenced
}

const getPptxFitMetrics = (
  container: HTMLElement,
  viewer: PptxViewerDimensions,
  zoomPercent = viewer.zoomPercent ?? 100
): PptxFitMetrics | undefined => {
  const view = container.ownerDocument.defaultView
  const computedStyle = view?.getComputedStyle(container)
  const paddingLeft = Number.parseFloat(computedStyle?.paddingLeft ?? '') || 0
  const paddingRight = Number.parseFloat(computedStyle?.paddingRight ?? '') || 0
  const paddingTop = Number.parseFloat(computedStyle?.paddingTop ?? '') || 0
  const paddingBottom = Number.parseFloat(computedStyle?.paddingBottom ?? '') || 0
  const availableWidth = container.clientWidth - paddingLeft - paddingRight
  const availableHeight = container.clientHeight - paddingTop - paddingBottom
  const { slideWidth, slideHeight } = viewer
  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(slideWidth) ||
    slideWidth <= 0 ||
    !Number.isFinite(slideHeight) ||
    slideHeight <= 0
  ) {
    return undefined
  }

  const zoomScale = Number.isFinite(zoomPercent) ? Math.max(0.1, zoomPercent / 100) : 1
  const widthScale = (availableWidth / slideWidth) * zoomScale
  const heightScale = availableHeight > 0 ? (availableHeight / slideHeight) * zoomScale : widthScale
  const scale = Math.min(widthScale, heightScale)
  return {
    scale,
    displayWidth: slideWidth * scale,
    displayHeight: slideHeight * scale
  }
}

const applyPptxSlideFit = (slide: HTMLElement, metrics: PptxFitMetrics): void => {
  const wrapper = slide.parentElement
  if (!wrapper) return

  wrapper.style.width = `${metrics.displayWidth}px`
  wrapper.style.height = `${metrics.displayHeight}px`
  slide.style.transform = `scale(${metrics.scale})`
  slide.style.transformOrigin = 'top left'
}

// Updates the vendor-owned slide wrappers without rebuilding parsed presentation content.
const applyPptxFit = (
  container: HTMLElement,
  viewer: PptxViewerDimensions,
  zoomPercent = viewer.zoomPercent ?? 100
): PptxFitMetrics | undefined => {
  const metrics = getPptxFitMetrics(container, viewer, zoomPercent)
  if (!metrics) return undefined

  const items = container.querySelectorAll<HTMLElement>('[data-slide-index]')
  if (items.length === 0) {
    const wrapper = container.firstElementChild
    if (wrapper instanceof HTMLElement) {
      wrapper.style.width = `${metrics.displayWidth}px`
      wrapper.style.height = `${metrics.displayHeight}px`
      wrapper.style.flex = '0 0 auto'
      const slide = wrapper.firstElementChild
      if (slide instanceof HTMLElement) applyPptxSlideFit(slide, metrics)
    }
    return metrics
  }

  for (const item of items) {
    item.style.width = `${metrics.displayWidth}px`
    item.style.height = `${metrics.displayHeight}px`
    item.style.flex = '0 0 auto'
    const wrapper = item.firstElementChild
    if (!(wrapper instanceof HTMLElement)) continue

    wrapper.style.width = `${metrics.displayWidth}px`
    wrapper.style.height = `${metrics.displayHeight}px`
    const slide = wrapper.firstElementChild
    if (slide instanceof HTMLElement) applyPptxSlideFit(slide, metrics)
  }

  return metrics
}

// Coalesces panel drag updates to one in-place fit per animation frame.
const installPptxFit = (
  container: HTMLElement,
  viewer: PptxViewerDimensions,
  onFit: (metrics: PptxFitMetrics) => void,
  getZoomPercent: () => number = () => viewer.zoomPercent ?? 100
): OfficeRenderCleanup => {
  const view = container.ownerDocument.defaultView
  const applyFit = (): void => {
    const metrics = applyPptxFit(container, viewer, getZoomPercent())
    if (metrics) onFit(metrics)
  }
  applyFit()

  let animationFrame: number | undefined
  let initialLayoutFrames = 0
  const settleInitialLayout = (): void => {
    if (!view || initialLayoutFrames >= 8) return
    initialLayoutFrames += 1
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = undefined
      applyFit()
      settleInitialLayout()
    })
  }
  // The iframe can acquire its final width after the first slide mounts (scrollbars and flex
  // parents settle asynchronously). Refit for a short burst so opening or changing slides never
  // requires a manual panel drag to reveal the complete slide.
  settleInitialLayout()
  const scheduleFit = (): void => {
    if (!view || animationFrame !== undefined) return
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = undefined
      applyFit()
    })
  }
  const ResizeObserverCtor = view?.ResizeObserver
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleFit) : undefined
  resizeObserver?.observe(container)
  if (container.parentElement) resizeObserver?.observe(container.parentElement)

  return () => {
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) view?.cancelAnimationFrame(animationFrame)
  }
}

// Keep bookmark activation local; never restore href navigation, external URLs, or pings.
const installDocxLinks = (container: HTMLElement): OfficeRenderCleanup => {
  const listeners: Array<() => void> = []
  const targets = new Map(
    Array.from(container.querySelectorAll<HTMLElement>('[id]'), (node) => [node.id, node])
  )
  container.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    const href = link.getAttribute('href')
    for (const attribute of ['href', 'target', 'rel', 'download', 'ping', 'referrerpolicy']) {
      link.removeAttribute(attribute)
    }
    if (!href?.startsWith('#')) return
    let id = href.slice(1)
    if (!targets.has(id)) {
      try {
        id = decodeURIComponent(id)
      } catch {
        return
      }
    }
    const target = targets.get(id)
    if (!target) return
    link.setAttribute('role', 'link')
    link.tabIndex = 0
    const activate = (event: Event): void => {
      event.preventDefault()
      if (!container.contains(target)) return
      target.scrollIntoView({ block: 'start' })
      // Chromium drops focus if tabindex is removed immediately after focusing a bookmark.
      if (!target.hasAttribute('tabindex')) {
        target.tabIndex = -1
        listeners.push(() => target.removeAttribute('tabindex'))
      }
      target.focus({ preventScroll: true })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') activate(event)
    }
    link.addEventListener('click', activate)
    link.addEventListener('keydown', onKeyDown)
    listeners.push(() => {
      link.removeEventListener('click', activate)
      link.removeEventListener('keydown', onKeyDown)
    })
  })
  return () => listeners.forEach((remove) => remove())
}

const SPREADSHEET_WORKER_STARTUP_TIMEOUT_MS = 5_000
const SPREADSHEET_STATUS_SCOPE_ATTRIBUTE = 'data-open-science-spreadsheet-preview'
const SPREADSHEET_STATUS_SCOPE = `[${SPREADSHEET_STATUS_SCOPE_ATTRIBUTE}]`
const SPREADSHEET_PARSING_STATUS: OfficeRenderStatus = {
  phase: 'parsing'
}
const RENDERING_STATUS: OfficeRenderStatus = {
  phase: 'rendering'
}
const SPREADSHEET_STATUS_STYLE = `
${SPREADSHEET_STATUS_SCOPE} .spreadsheet-empty {
  padding: 2rem;
  text-align: center;
  color: var(--text-100);
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .loading {
  display: none !important;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading {
  right: 12px;
  bottom: 12px;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-000);
  box-shadow: none;
  color: var(--text-100);
  font-size: 10px;
  font-weight: 500;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-dot {
  width: 4px;
  height: 4px;
  background: var(--primary);
  box-shadow: none;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-summary {
  color: var(--text-300);
}
@media (prefers-reduced-motion: reduce) {
  ${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-dot {
    animation: none;
  }
}
`

// Hides the vendor's blocking loader before it is inserted while retaining background progress.
const installSpreadsheetStatusStyle = (container: HTMLElement): OfficeRenderCleanup => {
  const style = container.ownerDocument.createElement('style')
  style.dataset.openScienceSpreadsheetStatus = 'true'
  style.textContent = SPREADSHEET_STATUS_STYLE
  container.setAttribute(SPREADSHEET_STATUS_SCOPE_ATTRIBUTE, 'true')
  container.ownerDocument.head.appendChild(style)

  return () => {
    style.remove()
    container.removeAttribute(SPREADSHEET_STATUS_SCOPE_ATTRIBUTE)
  }
}

// Canonicalizes Vite's relative worker asset so the vendor resolver and handshake compare one URL.
const resolveSpreadsheetWorkerUrl = (workerUrl: string, container: HTMLElement): string =>
  new URL(workerUrl, container.ownerDocument.baseURI).href

// Handshakes the local spreadsheet Worker before vendor code takes ownership, preventing a silent
// fallback to expensive workbook parsing on the renderer thread.
const createReadySpreadsheetWorker = async (
  workerUrl: string,
  container: HTMLElement,
  signal: AbortSignal
): Promise<Worker> => {
  const WorkerCtor = container.ownerDocument.defaultView?.Worker
  if (!WorkerCtor) throw new Error('Spreadsheet preview Worker is unavailable')

  let worker: Worker
  try {
    worker = new WorkerCtor(workerUrl, { type: 'module' })
  } catch (error) {
    throw new Error('Spreadsheet preview Worker could not start', { cause: error })
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        window.clearTimeout(timeout)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onMessage = (): void => settle(resolve)
      const onError = (): void =>
        settle(() => reject(new Error('Spreadsheet preview Worker could not load')))
      const onAbort = (): void =>
        settle(() =>
          reject(signal.reason ?? new DOMException('Spreadsheet preview aborted', 'AbortError'))
        )
      const timeout = window.setTimeout(() => {
        settle(() => reject(new Error('Spreadsheet preview Worker did not respond')))
      }, SPREADSHEET_WORKER_STARTUP_TIMEOUT_MS)

      worker.addEventListener('message', onMessage, { once: true })
      worker.addEventListener('error', onError, { once: true })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ type: 'parseWorkbook', payload: { workbook: new ArrayBuffer(0) } })
      } catch (error) {
        settle(() => reject(error))
      }
      if (signal.aborted) onAbort()
    })
    return worker
  } catch (error) {
    worker.terminate()
    throw error
  }
}

// Transfers the renderer-owned workbook copy into the parsing Worker instead of cloning it again.
const installTransferableSpreadsheetWorkbook = (worker: Worker): OfficeRenderCleanup => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(worker, 'postMessage')
  const originalPostMessage = worker.postMessage.bind(worker) as (
    message: unknown,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions
  ) => void
  const patchedPostMessage = (
    message: unknown,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions
  ): void => {
    const payload =
      typeof message === 'object' && message !== null && 'payload' in message
        ? message.payload
        : undefined
    const workbook =
      typeof payload === 'object' && payload !== null && 'workbook' in payload
        ? payload.workbook
        : undefined
    const isWorkbookParse =
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'parseWorkbook' &&
      workbook instanceof ArrayBuffer

    if (isWorkbookParse && transferOrOptions === undefined) {
      originalPostMessage(message, [workbook])
      return
    }
    originalPostMessage(message, transferOrOptions)
  }
  worker.postMessage = patchedPostMessage as Worker['postMessage']

  return () => {
    if (ownDescriptor) Object.defineProperty(worker, 'postMessage', ownDescriptor)
    else Reflect.deleteProperty(worker, 'postMessage')
  }
}

// Supplies the already-handshaken Worker to a vendor API that otherwise constructs its own Worker.
const renderWithReadySpreadsheetWorker = async <T>(
  workerUrl: string,
  container: HTMLElement,
  worker: Worker,
  render: () => Promise<T>
): Promise<{ instance: T; claimed: boolean }> => {
  const view = container.ownerDocument.defaultView
  const NativeWorker = view?.Worker
  if (!view || !NativeWorker) throw new Error('Spreadsheet preview Worker is unavailable')

  let claimed = false
  const InjectedWorker = function (scriptUrl: string | URL, options?: WorkerOptions): Worker {
    if (String(scriptUrl) === workerUrl) {
      if (claimed) throw new Error('Spreadsheet preview requested more than one Worker')
      claimed = true
      return worker
    }

    return new NativeWorker(scriptUrl, options)
  } as unknown as typeof Worker
  InjectedWorker.prototype = NativeWorker.prototype

  const ownDescriptor = Object.getOwnPropertyDescriptor(view, 'Worker')
  // The vendor reads window.Worker during its async factory. Keep the override bounded by this
  // try/finally; callers must not run spreadsheet factories concurrently in the same window.
  Object.defineProperty(view, 'Worker', {
    configurable: true,
    writable: true,
    value: InjectedWorker
  })

  try {
    return { instance: await render(), claimed }
  } finally {
    if (ownDescriptor) Object.defineProperty(view, 'Worker', ownDescriptor)
    else Reflect.deleteProperty(view, 'Worker')
  }
}

// Converts the spreadsheet renderer's DOM-only parse error state into the adapter's promise flow.
const getSpreadsheetParseError = (container: HTMLElement): Error | undefined => {
  const errorElement = container.querySelector<HTMLElement>('.excel-wrapper .error')
  if (!errorElement || errorElement.classList.contains('hidden')) return undefined

  const message = errorElement.textContent?.trim()
  return new Error(message || 'Spreadsheet preview could not parse this workbook')
}

// Dynamically loads the selected renderer and returns one cleanup function that owns all generated
// DOM, workers, Blob URLs, and vendor instances for that preview generation.
export const renderOfficeFile = async ({
  bytes,
  extension,
  name,
  container,
  signal,
  onStatus,
  onError
}: RenderOfficeFileOptions): Promise<OfficeRenderCleanup> => {
  if (extension === 'docx') {
    // Keep active-content features disabled and inline media so detached Blob URLs cannot leak.
    const { renderAsync } = await import('docx-preview')

    try {
      onStatus?.(RENDERING_STATUS)
      await renderAsync(bytes, container, container, {
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        renderComments: false,
        useBase64URL: true
      })
    } catch (error) {
      collectBlobUrls(container).forEach((url) => URL.revokeObjectURL(url))
      clearContainer(container)
      throw error
    }
    const disposeLinks = installDocxLinks(container)
    const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
    const disposeFit = wrapper ? installDocxFit(container, wrapper) : undefined
    const blobUrls = collectBlobUrls(container)

    return () => {
      disposeLinks()
      disposeFit?.()
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
      clearContainer(container)
    }
  }

  if (extension === 'xls' || extension === 'xlsx') {
    // Spreadsheet parsing stays in the bundled Worker; readiness means a real first paint occurred.
    const [{ renderFileViewerSpreadsheet }, { default: importedWorkerUrl }] = await Promise.all([
      import('@file-viewer/renderer-spreadsheet'),
      import('@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker?worker&url')
    ])
    const workerUrl = resolveSpreadsheetWorkerUrl(importedWorkerUrl, container)
    const readyWorker = await createReadySpreadsheetWorker(workerUrl, container, signal)
    const disposeTransferableWorkbook = installTransferableSpreadsheetWorkbook(readyWorker)
    const MutationObserverCtor = container.ownerDocument.defaultView?.MutationObserver
    if (!MutationObserverCtor) {
      disposeTransferableWorkbook()
      readyWorker.terminate()
      throw new Error('Spreadsheet preview error observer is unavailable')
    }

    let disposed = false
    let sessionReady = false
    let fatalError: Error | undefined
    let firstPaintSettled = false
    let resolveFirstPaint: () => void = () => undefined
    let rejectFirstPaint: (error: Error) => void = () => undefined
    const firstPaint = new Promise<void>((resolve, reject) => {
      resolveFirstPaint = resolve
      rejectFirstPaint = reject
    })
    // The renderer factory may still be pending when a DOM parse error rejects this promise.
    void firstPaint.catch(() => undefined)
    // Upstream does not call onProgressiveRender for parse errors, so observe its error node early.
    const errorObserver = new MutationObserverCtor(() => {
      const error = getSpreadsheetParseError(container)
      if (!error || fatalError || disposed || signal.aborted) return
      fatalError = error
      errorObserver.disconnect()
      if (!firstPaintSettled) {
        firstPaintSettled = true
        rejectFirstPaint(error)
      }
      if (sessionReady) {
        void dispose().catch((cleanupError) =>
          console.error('Failed to dispose spreadsheet preview', cleanupError)
        )
        onError?.(error)
      }
    })
    const markFirstPaint = (): void => {
      if (firstPaintSettled) return
      firstPaintSettled = true
      onStatus?.(RENDERING_STATUS)
      resolveFirstPaint()
    }
    errorObserver.observe(container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    })
    const disposeStatusStyle = installSpreadsheetStatusStyle(container)
    let instance: Awaited<ReturnType<typeof renderFileViewerSpreadsheet>>
    let claimed = false
    try {
      onStatus?.(SPREADSHEET_PARSING_STATUS)
      const rendered = await renderWithReadySpreadsheetWorker(
        workerUrl,
        container,
        readyWorker,
        () =>
          renderFileViewerSpreadsheet(toArrayBuffer(bytes), container, extension, {
            filename: name,
            signal,
            onProgressiveRender: markFirstPaint,
            options: {
              locale: 'en-US',
              messages: {
                'state.empty.title': i18next.isInitialized
                  ? i18next.t('This workbook has no worksheets.')
                  : 'This workbook has no worksheets.',
                'state.empty.message': i18next.isInitialized
                  ? i18next.t('This workbook has no visible worksheets.')
                  : 'This workbook has no visible worksheets.'
              },
              spreadsheet: {
                worker: true,
                workerUrl
              }
            }
          })
      )
      instance = rendered.instance
      claimed = rendered.claimed
    } catch (error) {
      errorObserver.disconnect()
      disposeStatusStyle()
      disposeTransferableWorkbook()
      readyWorker.terminate()
      clearContainer(container)
      throw error
    }

    // Cleanup is idempotent because timeout, abort, file replacement, and unmount can race.
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      errorObserver.disconnect()
      try {
        if ('unmount' in instance) await instance.unmount()
        else if ('$destroy' in instance) await instance.$destroy()
        else await instance.destroy()
      } finally {
        disposeStatusStyle()
        disposeTransferableWorkbook()
        readyWorker.terminate()
        clearContainer(container)
      }
    }

    if (!claimed) {
      errorObserver.disconnect()
      await dispose()
      throw new Error('Spreadsheet renderer did not claim the required Worker')
    }

    const reportedError = getSpreadsheetParseError(container)
    if (reportedError && !firstPaintSettled) {
      firstPaintSettled = true
      errorObserver.disconnect()
      rejectFirstPaint(reportedError)
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const rejectAfterDispose = (error: unknown): void => {
        if (settled) return
        settled = true
        errorObserver.disconnect()
        signal.removeEventListener('abort', onAbort)
        void dispose().then(
          () => reject(error),
          (cleanupError) => {
            console.error('Failed to dispose spreadsheet preview', cleanupError)
            reject(error)
          }
        )
      }
      const onAbort = (): void =>
        rejectAfterDispose(
          signal.reason ?? new DOMException('Spreadsheet preview aborted', 'AbortError')
        )

      signal.addEventListener('abort', onAbort, { once: true })
      firstPaint.then(() => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, rejectAfterDispose)
      if (signal.aborted) onAbort()
    })

    if (fatalError) {
      await dispose()
      throw fatalError
    }
    sessionReady = true
    return dispose
  }

  // Construct explicitly so a failed open still leaves an instance that can be destroyed.
  const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
  const surface = createPptxReviewSurface(container)
  const viewerDimensionsRef: { current?: PptxViewerDimensions } = {}
  const mediaUrlCache = new BoundedBlobUrlCache()
  const trimPptxMediaCache = (): void => {
    mediaUrlCache.trim(collectReferencedPptxMediaUrls(container, mediaUrlCache))
  }
  const view = container.ownerDocument.defaultView
  let pptxZoomPercent = 100
  let currentFit: PptxFitMetrics | undefined
  let refitFrame: number | undefined
  let refitPptx: () => void = () => undefined
  let queueSlideFit: () => void = () => undefined
  let slideFitQueued = false
  let viewerDestroyed = false
  let disposeReview: OfficeRenderCleanup | undefined
  let reportedRendering = false
  const reportRendering = (): void => {
    if (reportedRendering) return
    reportedRendering = true
    onStatus?.(RENDERING_STATUS)
  }
  const viewer = new PptxViewer(surface.stage, {
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazySlides: true,
    lazyMedia: true,
    // The review surface owns fit/zoom through CSS transforms. Disable the vendor's
    // container-width fitting so panel layout changes do not rebuild the slide DOM.
    fitMode: 'none',
    scrollContainer: surface.stage,
    pdfjs: false,
    onRenderStart: reportRendering,
    onSlideUnmounted: trimPptxMediaCache,
    // Windowed slides can mount after a resize, so apply the latest fit before their next paint.
    onSlideRendered: (_index, element) => {
      const viewerDimensions = viewerDimensionsRef.current
      const metrics = viewerDimensions
        ? getPptxFitMetrics(container, viewerDimensions, pptxZoomPercent)
        : currentFit
      if (!metrics) return

      currentFit = metrics
      applyPptxSlideFit(element, metrics)
      // The renderer dispatches before appending the slide wrapper. Refit in one microtask after
      // the append, while coalescing bursts of slide mounts into a single layout pass.
      queueSlideFit()
    }
  })
  viewerDimensionsRef.current = viewer
  queueSlideFit = (): void => {
    if (slideFitQueued) return
    slideFitQueued = true
    queueMicrotask(() => {
      slideFitQueued = false
      if (viewerDestroyed) return
      const metrics = applyPptxFit(surface.stage, viewer, pptxZoomPercent)
      if (metrics) currentFit = metrics
    })
  }
  refitPptx = (): void => {
    if (!view) {
      const metrics = applyPptxFit(surface.stage, viewer, pptxZoomPercent)
      if (metrics) currentFit = metrics
      return
    }
    if (refitFrame !== undefined) return
    refitFrame = view.requestAnimationFrame(() => {
      refitFrame = undefined
      const metrics = applyPptxFit(surface.stage, viewer, pptxZoomPercent)
      if (metrics) currentFit = metrics
    })
  }
  let disposeFit: OfficeRenderCleanup | undefined
  const destroyViewer = (): void => {
    viewerDestroyed = true
    slideFitQueued = false
    if (refitFrame !== undefined) view?.cancelAnimationFrame(refitFrame)
    refitFrame = undefined
    disposeFit?.()
    disposeFit = undefined
    disposeReview?.()
    disposeReview = undefined
    try {
      viewer.destroy()
    } finally {
      mediaUrlCache.clear()
      clearContainer(container)
    }
  }

  try {
    installPptxMediaUrlCache(viewer, mediaUrlCache)
    await viewer.open(toArrayBuffer(bytes), {
      renderMode: 'slide',
      lazySlides: true,
      lazyMedia: true,
      signal
    })
    reportRendering()
    const notesPromise = extractPptxNotes(bytes, signal).catch(() => new Map())
    const resolver = requirePptxMediaResolverInternals(viewer.presentationData?.mediaResolver)
    mediaUrlCache.setEvictionHandler((mediaPath) => releaseDecodedPptxMedia(resolver, mediaPath))
    disposeFit = installPptxFit(
      surface.stage,
      viewer,
      (metrics) => {
        currentFit = metrics
      },
      () => pptxZoomPercent
    )
    disposeReview = installPptxReviewControls(
      surface,
      viewer,
      () => {
        trimPptxMediaCache()
        refitPptx()
      },
      notesPromise,
      {
        get: () => pptxZoomPercent,
        set: (percent) => {
          pptxZoomPercent = percent
          refitPptx()
        }
      },
      trimPptxMediaCache
    )
    trimPptxMediaCache()
  } catch (error) {
    try {
      destroyViewer()
    } catch (cleanupError) {
      console.error('Failed to dispose PPTX preview', cleanupError)
    }
    throw error
  }

  return destroyViewer
}

// Reviewer previews use this target-driven path so Office renderers never mount an entire
// document merely to capture a few admitted pages. DOCX pagination is necessarily sequential,
// but non-target pages are detached as soon as the next physical page starts and layout stops
// before the page following the highest target. PPTX parsing remains lazy and only renderSlide()
// materializes an admitted slide.
export const renderTargetedOfficeFile = async ({
  bytes,
  extension,
  container,
  signal,
  targetPages
}: RenderTargetedOfficeFileOptions): Promise<TargetedOfficeRenderSession> => {
  const targets = [...new Set(targetPages)].sort((left, right) => left - right)
  if (
    targets.length === 0 ||
    targets.some((page) => !Number.isSafeInteger(page) || page < 1) ||
    (extension === 'docx' && targets.at(-1)! > MAX_TARGETED_DOCX_PAGE)
  ) {
    throw new Error('Office preview targets exceed the bounded page range.')
  }
  const targetSet = new Set(targets)
  const assertActive = (): void => {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException('Office preview aborted', 'AbortError')
    }
  }
  assertActive()

  if (extension === 'pptx') {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS, buildPresentation, parseZipLazyMedia } =
      await import('@aiden0z/pptx-renderer')
    assertActive()
    const files = await parseZipLazyMedia(toArrayBuffer(bytes), RECOMMENDED_ZIP_LIMITS)
    assertActive()
    const presentation = buildPresentation(files, { lazySlides: true })
    const viewer = new PptxViewer(container, {
      width: container.clientWidth || PPTX_FALLBACK_WIDTH,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      scrollContainer: container,
      pdfjs: false
    })
    viewer.load(presentation)
    let disposed = false
    return {
      pageCount: viewer.slideCount,
      pageCountComplete: true,
      availablePages: targets.filter((page) => page <= viewer.slideCount),
      preparePage: async (pageNumber) => {
        assertActive()
        if (!targetSet.has(pageNumber) || pageNumber > viewer.slideCount) {
          throw new Error(`Slide ${pageNumber} was not admitted for this Office preview.`)
        }
        await viewer.renderSlide(pageNumber - 1)
        assertActive()
        const item = container.querySelector<HTMLElement>(`[data-slide-index="${pageNumber - 1}"]`)
        const slide = item?.firstElementChild?.firstElementChild
        if (!(slide instanceof HTMLElement)) {
          throw new Error(`Rendered presentation does not contain slide ${pageNumber}.`)
        }
        return slide
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        viewer.destroy()
        clearContainer(container)
      }
    }
  }

  const { defaultOptions, parseAsync, renderDocument } = await import('docx-preview')
  const maxTarget = targets.at(-1)!
  const pages = new Map<number, HTMLElement>()
  const styles = new Set<HTMLStyleElement>()
  let pageOrdinal = 0
  let pageCountComplete = true
  let previousPage: { number: number; element: HTMLElement } | undefined
  const stop = new Error('Targeted DOCX page limit reached.')
  const baseOptions = {
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    renderComments: false,
    useBase64URL: true
  }
  const documentModel = await parseAsync(bytes, baseOptions)
  assertActive()
  const boundedElementFactory: typeof defaultOptions.h = (descriptor) => {
    assertActive()
    if (
      typeof descriptor === 'object' &&
      !(descriptor instanceof Node) &&
      descriptor.tagName === 'section' &&
      descriptor.className?.split(/\s+/).includes('docx')
    ) {
      if (previousPage && !targetSet.has(previousPage.number)) {
        previousPage.element.replaceChildren()
      }
      pageOrdinal += 1
      if (pageOrdinal > maxTarget) throw stop
    }
    const node = defaultOptions.h(descriptor)
    if (node instanceof HTMLStyleElement) styles.add(node)
    if (
      node instanceof HTMLElement &&
      node.tagName === 'SECTION' &&
      node.classList.contains('docx')
    ) {
      previousPage = { number: pageOrdinal, element: node }
      if (targetSet.has(pageOrdinal)) pages.set(pageOrdinal, node)
    }
    return node
  }

  try {
    await renderDocument(documentModel, { ...baseOptions, h: boundedElementFactory })
  } catch (error) {
    if (error !== stop) throw error
    pageCountComplete = false
  }
  if (previousPage && !targetSet.has(previousPage.number)) previousPage.element.replaceChildren()
  assertActive()
  clearContainer(container)
  for (const style of styles) {
    if (!style.parentNode) container.appendChild(style)
  }
  const wrapper = container.ownerDocument.createElement('div')
  wrapper.className = 'docx-wrapper'
  for (const pageNumber of targets) {
    const page = pages.get(pageNumber)
    if (page) wrapper.appendChild(page)
  }
  container.appendChild(wrapper)
  const disposeLinks = installDocxLinks(container)
  const disposeFit = pages.size > 0 ? installDocxFit(container, wrapper) : undefined
  const blobUrls = collectBlobUrls(container)
  let disposed = false
  return {
    pageCount: Math.min(pageOrdinal, maxTarget),
    pageCountComplete,
    availablePages: targets.filter((page) => pages.has(page)),
    preparePage: async (pageNumber) => {
      assertActive()
      const page = targetSet.has(pageNumber) ? pages.get(pageNumber) : undefined
      if (!page) throw new Error(`Rendered document does not contain page ${pageNumber}.`)
      await settleTargetImages(page, signal)
      assertActive()
      return page
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeLinks()
      disposeFit?.()
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
      clearContainer(container)
      pages.clear()
    }
  }
}

export {
  BoundedBlobUrlCache,
  collectReferencedPptxMediaUrls,
  installPptxMediaUrlCache,
  MAX_PPTX_MEDIA_URLS,
  MAX_TARGETED_DOCX_PAGE,
  releaseDecodedPptxMedia
}
export type { RenderTargetedOfficeFileOptions, TargetedOfficeRenderSession }
