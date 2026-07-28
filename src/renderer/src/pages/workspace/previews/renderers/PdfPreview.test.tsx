// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { PdfPreviewContent } from './PdfPreview'

vi.mock('../managed-pdf-document', () => ({ createManagedPdfLoadingTask: vi.fn() }))

describe('PdfPreviewContent', () => {
  let container: HTMLDivElement
  let root: Root
  const destroyDocument = vi.fn().mockResolvedValue(undefined)
  let getPage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    destroyDocument.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/report.pdf',
          size: 80 * 1024 * 1024,
          mimeType: 'application/pdf',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    )
    getPage = vi.fn().mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders through the managed range resource and releases it on unmount', async () => {
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="artifact-version:version-1"
          name="report.pdf"
          source="artifact"
          projectId="project-1"
          sessionId="session-1"
        />
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(createManagedPdfLoadingTask).toHaveBeenCalled())
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      sessionId: 'session-1',
      path: 'artifact-version:version-1'
    })
    expect(createManagedPdfLoadingTask).toHaveBeenCalledWith(
      expect.objectContaining({ size: 80 * 1024 * 1024 })
    )
    expect(container.querySelector('canvas')).not.toBeNull()

    await act(async () => root.unmount())
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    expect(destroyDocument).toHaveBeenCalled()
    expect(destroyDocument.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.previewResources.release).mock.invocationCallOrder[0] as number
    )
  })

  it('uses each PDF page aspect ratio instead of stretching it into a fixed frame', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 900, height: 450 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/landscape.pdf" name="landscape.pdf" source="artifact" />
      )
    })
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.aspectRatio
        ).toBe('2 / 1')
      )
    })

    expect(getPage).toHaveBeenCalledWith(1)
  })

  it('rasterizes at the on-screen width times device pixel ratio, not the page point size', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(700)
    vi.stubGlobal('devicePixelRatio', 2)
    // Base page is 350pt wide; a 700px frame at 2x should back the canvas at 1400px (scale 4).
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 350 * scale,
        height: 500 * scale
      })),
      render,
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/sharp.pdf" name="sharp.pdf" source="artifact" />
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const canvas = container.querySelector<HTMLCanvasElement>('canvas')
    expect(canvas?.width).toBe(1400)
    expect(canvas?.height).toBe(2000)

    clientWidthSpy.mockRestore()
  })

  it('re-rasterizes at a higher resolution when the user zooms in', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/zoom.pdf" name="zoom.pdf" source="artifact" />
      )
    })
    // At fit width (100%) the 400pt page backs the canvas at its own width.
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)
    )

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })

    // 125% zoom widens the page and re-rasterizes rather than upscaling the old bitmap.
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(500)
    )
    expect(container.textContent).toContain('125%')
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.height).toBe(700)

    clientWidthSpy.mockRestore()
  })

  it('left-aligns pages once zoomed past fit so the left edge stays reachable', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/align.pdf" name="align.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    // At fit width the pages column is centered.
    const column = container.querySelector('[data-page-number]')?.parentElement
    expect(column?.className).toContain('items-center')
    expect(column?.className).not.toContain('items-start')

    // Zoomed wider than the pane, it must left-align so scrollLeft=0 reaches the true left edge.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(container.querySelector('[data-page-number]')?.parentElement?.className).toContain(
        'items-start'
      )
    )
    expect(container.querySelector('[data-page-number]')?.parentElement?.className).not.toContain(
      'items-center'
    )

    clientWidthSpy.mockRestore()
  })

  it('exposes the scroll container as a keyboard-focusable region', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/a11y.pdf" name="a11y.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    // The inner scroller (parent of the measurement probe) owns overflow, so it must be reachable
    // by keyboard — the outer surface that gets focus is not the scrollable element.
    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    expect(scroll?.getAttribute('tabindex')).toBe('0')
    expect(scroll?.getAttribute('role')).toBe('region')
    expect(scroll?.getAttribute('aria-label')).toContain('a11y.pdf')

    clientWidthSpy.mockRestore()
  })

  it('keeps a zoomed page centered on a wide pane until it overflows the real viewport', async () => {
    // Pane is 1200px wide — well past the 768 reading-width cap. fitWidth caps at 768 but the
    // overflow decision must use the real 1200px viewport, not the cap.
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(1200)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/wide.pdf" name="wide.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    const columnClass = (): string =>
      container.querySelector('[data-page-number]')?.parentElement?.className ?? ''

    // 125% (page 768*1.25 = 960px) still fits the 1200px pane → stays centered (regression check).
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))
    expect(columnClass()).toContain('items-center')
    expect(columnClass()).not.toContain('items-start')

    // 150% (960 -> 1152px) still fits → still centered.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('150%'))
    expect(columnClass()).toContain('items-center')

    // 175% (768*1.75 = 1344px) overflows the 1200px pane → now left-aligns.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('175%'))
    expect(columnClass()).toContain('items-start')
    expect(columnClass()).not.toContain('items-center')

    clientWidthSpy.mockRestore()
  })

  it('coalesces same-frame Ctrl/Cmd+wheel into one proportional zoom and ignores plain scroll', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    // Controllable rAF: capture the scheduled callback so same-frame events can be coalesced and
    // flushed once on demand, rather than running synchronously per event.
    let scheduled: { id: number; cb: FrameRequestCallback } | null = null
    let nextRafId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      scheduled = { id: nextRafId, cb }
      return nextRafId++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (scheduled?.id === id) scheduled = null
    })
    const flushFrame = (): void => {
      const pending = scheduled
      scheduled = null
      pending?.cb(0)
    }
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/wheel.pdf" name="wheel.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    // The scroll container owns the wheel listener; it is the parent of the measurement probe.
    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    expect(scroll).toBeTruthy()

    // A plain wheel scroll schedules nothing and must not zoom.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
    })
    expect(scheduled).toBeNull()
    expect(container.textContent).toContain('100%')

    // Two Ctrl+wheel events in the same frame coalesce: only one frame is scheduled and their
    // deltas sum (-200 * 0.0025 = +0.5), so a single flush yields 150%, not two separate steps.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      flushFrame()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('150%'))

    // The Cmd (metaKey) branch also zooms: deltaY +100 * 0.0025 = -0.25 (150% -> 125%).
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, metaKey: true, bubbles: true, cancelable: true })
      )
      flushFrame()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))

    clientWidthSpy.mockRestore()
  })

  it('drops a queued wheel zoom when the file switches before the frame flushes', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    // Faithful rAF/cancel: a canceled frame cannot be flushed, mirroring the browser.
    let scheduled: { id: number; cb: FrameRequestCallback } | null = null
    let nextRafId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      scheduled = { id: nextRafId, cb }
      return nextRafId++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (scheduled?.id === id) scheduled = null
    })
    const flushFrame = (): void => {
      const pending = scheduled
      scheduled = null
      pending?.cb(0)
    }
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    // Queue a Ctrl+wheel zoom but do NOT flush the frame yet.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
    })
    expect(scheduled).not.toBeNull()
    expect(container.textContent).toContain('100%')

    // Switch files in place before the frame runs: the wheel effect restarts on requestKey and
    // cancels the queued frame, so the stale delta cannot re-apply on top of the reset.
    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="artifact" />
      )
    })
    await act(async () => {
      flushFrame()
      await Promise.resolve()
    })

    // The new document stays at fit (100%); the queued 25% was dropped, not re-applied.
    expect(container.textContent).toContain('100%')
    expect(container.textContent).not.toContain('125%')

    clientWidthSpy.mockRestore()
  })

  it('resets zoom to fit when the previewed file changes in place (dialog path)', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))

    // The Files-tab dialog swaps the file in place (same component instance, no remount / key).
    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="artifact" />
      )
    })

    // The new file must open fit-to-width, not inherit the previous document's zoom.
    await vi.waitFor(() => expect(container.textContent).toContain('100%'))
    expect(container.textContent).not.toContain('125%')

    clientWidthSpy.mockRestore()
  })

  it('re-rasterizes a widened page without reloading it through the range transport', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
      }
    )
    let measuredWidth = 400
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => measuredWidth)
    vi.stubGlobal('devicePixelRatio', 1)
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render,
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/resize.pdf" name="resize.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)

    // Widening the panel must re-rasterize the already-loaded page, not fetch it again.
    // Both widths stay under the fit-width cap so pageWidth tracks the measured width directly.
    await act(async () => {
      measuredWidth = 600
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(600)
    expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
      '600px'
    )

    // Narrowing the panel (or returning from full screen) must shrink the displayed page back to
    // fit, not leave it pinned at the old larger width forcing horizontal scroll at 100%.
    await act(async () => {
      measuredWidth = 300
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
        '300px'
      )
    )
    expect(getPage).toHaveBeenCalledTimes(1)
    // Displayed width is responsive (300px), while the backing store never drops below the page's
    // intrinsic 400px width — the crisp bitmap simply downscales via CSS.
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)

    clientWidthSpy.mockRestore()
  })

  it('clamps the backing store to browser canvas limits for a tall, narrow page', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(700)
    vi.stubGlobal('devicePixelRatio', 2)
    // A 200x12000 page in a 700px frame at 2x would want scale 4 → a 48000px-tall canvas,
    // far past Chromium's limits. The clamp must keep both dimensions within bounds.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 12000 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/tall.pdf" name="tall.pdf" source="artifact" />
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('canvas')?.height).toBeGreaterThan(0))
    })

    const canvas = container.querySelector<HTMLCanvasElement>('canvas')
    expect(canvas?.height).toBeLessThanOrEqual(8192)
    expect(canvas?.width).toBeLessThanOrEqual(8192)
    // Sanity: without the clamp this page would have been ~48000px tall.
    expect(canvas?.height).toBeLessThan(12000)

    clientWidthSpy.mockRestore()
  })

  it('rasterizes zoom at full high-DPI resolution, not clipped to a fixed 4x cap', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(768)
    vi.stubGlobal('devicePixelRatio', 2)
    // A4-like page (595pt wide) at the 768px fit width, zoomed to 175% on a 2x display needs a
    // backing width of 768 * 1.75 * 2 = 2688px to stay sharp. A fixed 4x cap would clip it to
    // 595 * 4 = 2380px and the browser would upscale — the blur this removal fixes.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/hidpi.pdf" name="hidpi.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    // Zoom to 175% (100 -> 125 -> 150 -> 175 via three button steps).
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
        await Promise.resolve()
      })
    }
    await vi.waitFor(() => expect(container.textContent).toContain('175%'))

    const width = container.querySelector<HTMLCanvasElement>('canvas')?.width ?? 0
    // Backing reaches the physical on-screen pixels (~2688), well past the old 2380 (4x) ceiling,
    // and stays within the browser canvas limit.
    expect(width).toBeGreaterThan(2380)
    expect(width).toBeLessThanOrEqual(2688)
    expect(width).toBeLessThanOrEqual(8192)

    clientWidthSpy.mockRestore()
  })

  it('caps the backing scale at the deepest zoom to bound per-page memory', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(768)
    vi.stubGlobal('devicePixelRatio', 2)
    // A4-like page (595x842) at 768px fit, 300% zoom, 2x DPI: the physical target scale is
    // 768*3*2/595 = 7.74, and even the area clamp alone would allow ~5.79 (595*5.79 = 3443px).
    // The MAX_RENDER_SCALE=5 ceiling caps it to 595*5 = 2975px so a page cannot take the full
    // canvas-area budget.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/deep.pdf" name="deep.pdf" source="artifact" />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    // Zoom to the 300% max (eight 25% button steps).
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
        await Promise.resolve()
      })
    }
    await vi.waitFor(() => expect(container.textContent).toContain('300%'))

    const width = container.querySelector<HTMLCanvasElement>('canvas')?.width ?? 0
    // Scale is capped at 5 → 595*5 = 2975, below the ~3443 the area clamp alone would permit.
    expect(width).toBe(2975)
    expect(width).toBeLessThan(3443)

    clientWidthSpy.mockRestore()
  })

  it('treats a render canceled by scroll-out as teardown, not a page failure', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // A render whose promise rejects with PDF.js's cancellation error when cancel() is called.
    const cancelRender = vi.fn()
    let rejectRender: ((error: Error) => void) | undefined
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale
      })),
      render: vi.fn(() => ({
        promise: new Promise((_, reject) => {
          rejectRender = reject
        }),
        cancel: () => {
          cancelRender()
          rejectRender?.(
            Object.assign(new Error('Rendering cancelled'), {
              name: 'RenderingCancelledException'
            })
          )
        }
      })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/scroll.pdf" name="scroll.pdf" source="artifact" />
      )
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    // Scroll the page out: its acquire effect disposes and cancels the in-flight render.
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cancelRender).toHaveBeenCalled()
    // The cancellation must not be logged as a render failure nor shown as a page error.
    const loggedRenderFailure = consoleError.mock.calls.some((call) =>
      String(call[0]).includes('Failed to render PDF page')
    )
    expect(loggedRenderFailure).toBe(false)
    expect(container.textContent).not.toContain('could not be rendered')

    consoleError.mockRestore()
  })

  it('destroys the loading task when PDF parsing fails', async () => {
    const destroyLoadingTask = vi.fn().mockResolvedValue(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectLoadingTask: ((error: Error) => void) | undefined
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: new Promise((_, reject) => {
        rejectLoadingTask = reject
      }),
      destroy: destroyLoadingTask
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/broken.pdf" name="broken.pdf" source="artifact" />
      )
      await Promise.resolve()
    })
    await act(async () => {
      rejectLoadingTask?.(new Error('Invalid PDF'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain("This PDF couldn't be rendered for preview")
    expect(destroyLoadingTask).toHaveBeenCalledTimes(1)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })
    expect(destroyLoadingTask.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.previewResources.release).mock.invocationCallOrder[0] as number
    )
    consoleError.mockRestore()
  })

  it('does not render PDF pages until their containers approach the viewport', async () => {
    const intersectionCallbacks: IntersectionObserverCallback[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback)
        }
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="/workspace/lazy-pages.pdf"
          name="lazy-pages.pdf"
          source="artifact"
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(intersectionCallbacks).toHaveLength(2)
    expect(getPage).not.toHaveBeenCalled()
    expect(container.querySelectorAll('canvas')).toHaveLength(0)

    await act(async () => {
      intersectionCallbacks[0]?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getPage).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith(1)
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('uses the compact status for a page that is still loading', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    getPage.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/loading.pdf" name="loading.pdf" source="artifact" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[data-preview-status="compact-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('loading.pdf')
  })

  it('creates lazy page containers beyond page thirty', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 31, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/long.pdf" name="long.pdf" source="artifact" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(31)
  })

  it('cleans up a page that resolves after its container leaves the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    let resolvePage: ((page: unknown) => void) | undefined
    const cleanupPage = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    getPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/late.pdf" name="late.pdf" source="artifact" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      resolvePage?.({
        getViewport: vi.fn(),
        render: vi.fn(),
        cleanup: cleanupPage
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cleanupPage).toHaveBeenCalledTimes(1)
  })

  it('cancels active page work before destroying the parent document', async () => {
    const cancelRender = vi.fn()
    const cleanupPage = vi.fn()
    const render = vi.fn(() => ({ promise: new Promise(() => undefined), cancel: cancelRender }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render,
      cleanup: cleanupPage
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/active.pdf" name="active.pdf" source="artifact" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // Wait until rasterization is in flight so the render task exists to be canceled.
    await act(async () => {
      await vi.waitFor(() => expect(render).toHaveBeenCalled())
    })

    await act(async () => root.unmount())

    expect(cancelRender).toHaveBeenCalledTimes(1)
    expect(cleanupPage).toHaveBeenCalledTimes(1)
    expect(cancelRender.mock.invocationCallOrder[0]).toBeLessThan(
      destroyDocument.mock.invocationCallOrder[0] as number
    )
    expect(cleanupPage.mock.invocationCallOrder[0]).toBeLessThan(
      destroyDocument.mock.invocationCallOrder[0] as number
    )
  })
})
