// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeTiffFixture, LZW_MULTIPAGE_TIFF, LZW_RGB_TIFF } from '../tiff-test-fixtures'
import { decodeTiffPage } from '../tiff-preview'
import type {
  TiffDecodeWorkerRequest,
  TiffDecodeWorkerResponse
} from '../tiff-preview-worker-protocol'
import { TiffPreviewContent, TiffPreviewRenderer } from './TiffPreview'

let workerResponseOverride:
  ((request: TiffDecodeWorkerRequest) => TiffDecodeWorkerResponse | undefined) | undefined

class TestTiffWorker {
  private data: ArrayBuffer | undefined
  private readonly listeners = new Map<string, Set<EventListener>>()
  private terminated = false

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(request: TiffDecodeWorkerRequest): void {
    if (request.data) this.data = request.data
    queueMicrotask(() => {
      if (this.terminated) return
      let response: TiffDecodeWorkerResponse
      try {
        if (!this.data) throw new Error('TIFF worker has no file data')
        response =
          workerResponseOverride?.(request) ??
          ({
            type: 'decoded',
            requestId: request.requestId,
            page: decodeTiffPage(this.data, request.pageIndex)
          } satisfies TiffDecodeWorkerResponse)
      } catch (error) {
        response = {
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        }
      }

      const event = { data: response } as MessageEvent<TiffDecodeWorkerResponse>
      for (const listener of this.listeners.get('message') ?? []) listener(event)
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('TiffPreviewContent', () => {
  let container: HTMLDivElement
  let root: Root
  let putImageData: ReturnType<typeof vi.fn>
  let getContext: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workerResponseOverride = undefined
    const bytes = decodeTiffFixture(LZW_RGB_TIFF)
    container = document.createElement('div')
    document.body.appendChild(container)
    putImageData = vi.fn()
    getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
      }),
      putImageData
    } as unknown as CanvasRenderingContext2D)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) }
        })
      )
    )
    vi.stubGlobal('Worker', TestTiffWorker)
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/chart.tiff',
          size: bytes.byteLength,
          mimeType: 'image/tiff',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    getContext.mockRestore()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('renders an LZW TIFF page with the same zoom surface as other images', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<TiffPreviewContent path="/workspace/chart.tiff" name="chart.tiff" />)
    })

    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const canvas = container.querySelector('canvas')
    expect(fetch).toHaveBeenCalledWith(
      'open-science-preview://resource-1/chart.tiff',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 40 * 1024 * 1024 })
    )
    expect(canvas?.width).toBe(2)
    expect(canvas?.height).toBe(2)
    expect(canvas?.className).toContain('object-contain')
    expect(canvas?.className).not.toContain('object-cover')
    expect(putImageData).toHaveBeenCalledOnce()
    expect(container.querySelector('[aria-label="Zoom in"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Reset zoom"]')).not.toBeNull()
  })

  it('acquires the exact managed Upload version selected by the preview item', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <TiffPreviewRenderer
          item={{
            id: 'upload:upload-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            title: 'chart.tiff',
            type: 'file',
            source: 'upload',
            path: 'upload-version:stale-projection',
            name: 'chart.tiff',
            format: 'tiff',
            managedFileId: 'upload-1',
            selectedVersionId: 'upload-v3'
          }}
        />
      )
    })

    await vi.waitFor(() =>
      expect(window.api.previewResources.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'upload',
          projectId: 'project-1',
          sessionId: 'session-1',
          fileId: 'upload-1',
          versionId: 'upload-v3'
        })
      )
    )
  })

  it('renders a left-aligned intrinsic thumbnail without the full zoom frame', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <TiffPreviewContent
          path="/workspace/chart.tiff"
          name="chart.tiff"
          variant="thumbnail"
          align="start"
        />
      )
    })

    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const canvas = container.querySelector('canvas')
    expect(canvas?.parentElement?.className).toContain('justify-start')
    expect(canvas?.parentElement?.className).toContain('[&_canvas]:rounded-lg')
    expect(canvas?.parentElement?.className).toContain('[&_canvas]:border-border-200')
    expect(canvas?.className).toContain('max-h-full')
    expect(canvas?.className).toContain('max-w-full')
    expect(canvas?.className).toContain('h-auto')
    expect(canvas?.className).toContain('w-auto')
    expect(canvas?.classList.contains('size-full')).toBe(false)
    expect(container.querySelector('[aria-label="Zoom in"]')).toBeNull()
  })

  it('navigates between pages in a multi-page TIFF', async () => {
    const bytes = decodeTiffFixture(LZW_MULTIPAGE_TIFF)
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(bytes.slice(0), {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) }
        })
    )
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'resource-2',
      url: 'open-science-preview://resource-2/stack.tiff',
      size: bytes.byteLength,
      mimeType: 'image/tiff',
      version: 1
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TiffPreviewContent path="/workspace/stack.tiff" name="stack.tiff" />)
    })

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 2'))
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Previous TIFF page"]')?.disabled
    ).toBe(true)
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Next TIFF page"]')?.disabled
    ).toBe(false)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Next TIFF page"]')?.click()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('Page 2 of 2'))
    expect(fetch).toHaveBeenCalledOnce()
    expect(putImageData).toHaveBeenCalledTimes(2)
    const secondPage = putImageData.mock.calls[1]?.[0] as ImageData
    expect(Array.from(secondPage.data)).toEqual([0, 0, 255, 255])
  })

  it('keeps page controls available after one page fails and returns to a valid page', async () => {
    const bytes = decodeTiffFixture(LZW_MULTIPAGE_TIFF)
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(bytes.slice(0), {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) }
        })
    )
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'resource-page-error',
      url: 'open-science-preview://resource-page-error/stack.tiff',
      size: bytes.byteLength,
      mimeType: 'image/tiff',
      version: 1
    })
    workerResponseOverride = (request) =>
      request.pageIndex === 1
        ? { type: 'error', requestId: request.requestId, message: 'Unsupported TIFF test page' }
        : undefined

    root = createRoot(container)
    await act(async () => {
      root.render(<TiffPreviewContent path="/workspace/stack.tiff" name="stack.tiff" />)
    })

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 2'))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Next TIFF page"]')?.click()
    })

    await vi.waitFor(() =>
      expect(container.textContent).toContain("This TIFF encoding isn't supported for preview")
    )
    expect(container.textContent).toContain('Page 2 of 2')
    expect(window.api.previewResources.release).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Previous TIFF page"]')?.click()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 2'))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('shows stable preview copy instead of decoder internals for an invalid TIFF', async () => {
    const bytes = Uint8Array.of(0, 1, 2, 3).buffer
    vi.mocked(fetch).mockResolvedValue(new Response(bytes, { status: 200 }))
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'resource-invalid',
      url: 'open-science-preview://resource-invalid/broken.tiff',
      size: bytes.byteLength,
      mimeType: 'image/tiff',
      version: 1
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TiffPreviewContent path="/workspace/broken.tiff" name="broken.tiff" />)
    })

    await vi.waitFor(() =>
      expect(container.textContent).toContain("TIFF couldn't be decoded for preview")
    )
    expect(container.textContent).not.toContain('byte order')
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-invalid'
    })
  })

  it('shows the preview error card when the decoded page cannot be drawn', async () => {
    putImageData.mockImplementationOnce(() => {
      throw new Error('canvas allocation failed')
    })
    root = createRoot(container)
    await act(async () => {
      root.render(<TiffPreviewContent path="/workspace/chart.tiff" name="chart.tiff" />)
    })

    await vi.waitFor(() =>
      expect(container.textContent).toContain("TIFF couldn't be decoded for preview")
    )
    expect(container.querySelector('canvas')).toBeNull()
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })
  })
})
