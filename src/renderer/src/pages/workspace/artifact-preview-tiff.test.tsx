// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactPreview } from './artifact-preview'
import { decodeTiffFixture, LZW_RGB_TIFF } from './previews/tiff-test-fixtures'
import { decodeTiffPage } from './previews/tiff-preview'
import type {
  TiffDecodeWorkerRequest,
  TiffDecodeWorkerResponse
} from './previews/tiff-preview-worker-protocol'

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
    workerRequests.push(request)
    if (request.data) this.data = request.data
    queueMicrotask(() => {
      if (this.terminated) return
      if (!this.data) throw new Error('TIFF worker has no file data')
      const response: TiffDecodeWorkerResponse = {
        type: 'decoded',
        requestId: request.requestId,
        page: decodeTiffPage(this.data, request.pageIndex)
      }
      const event = { data: response } as MessageEvent<TiffDecodeWorkerResponse>
      for (const listener of this.listeners.get('message') ?? []) listener(event)
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

const workerRequests: TiffDecodeWorkerRequest[] = []

describe('TIFF artifact thumbnail', () => {
  let container: HTMLDivElement
  let root: Root
  let putImageData: ReturnType<typeof vi.fn>
  let getContext: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workerRequests.length = 0
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

  it('renders the first TIFF page in the generated artifact card', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ArtifactPreview
          artifact={{
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/chart.tiff',
            fileUrl: 'file:///workspace/chart.tiff',
            name: 'chart.tiff',
            mimeType: 'image/tiff',
            size: 152,
            mtimeMs: 1710000000000
          }}
        />
      )
    })

    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    expect(container.querySelector('canvas')?.className).toContain('object-cover')
    expect(container.querySelector('canvas')?.className).toContain('object-top')
    expect(fetch).toHaveBeenCalledWith(
      'open-science-preview://resource-1/chart.tiff',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 })
    )
    expect(workerRequests[0]).toEqual(
      expect.objectContaining({
        maxOutputDimension: 512,
        limits: {
          maxFileBytes: 20 * 1024 * 1024,
          maxPixels: 4_000_000,
          maxDecodedBytes: 128 * 1024 * 1024
        }
      })
    )
    expect(putImageData).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(window.api.previewResources.release).toHaveBeenCalledWith({
        resourceId: 'resource-1'
      })
    )
  })

  it('discards a completed thumbnail when it leaves the viewport', async () => {
    const artifact = {
      id: 'artifact-1',
      kind: 'managed-file' as const,
      path: '/workspace/chart.tiff',
      fileUrl: 'file:///workspace/chart.tiff',
      name: 'chart.tiff',
      mimeType: 'image/tiff',
      size: 152,
      mtimeMs: 1710000000000
    }
    root = createRoot(container)
    await act(async () => root.render(<ArtifactPreview artifact={artifact} isVisible />))
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    await act(async () => root.render(<ArtifactPreview artifact={artifact} isVisible={false} />))

    await vi.waitFor(() => expect(container.querySelector('canvas')).toBeNull())
    expect(container.textContent).toContain('TIFF')
  })

  it('falls back to the file tile when the thumbnail canvas is unavailable', async () => {
    getContext.mockReturnValue(null)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ArtifactPreview
          artifact={{
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/chart.tiff',
            fileUrl: 'file:///workspace/chart.tiff',
            name: 'chart.tiff',
            mimeType: 'image/tiff',
            size: 152,
            mtimeMs: 1710000000000
          }}
        />
      )
    })

    await vi.waitFor(() => expect(getContext).toHaveBeenCalled())
    await vi.waitFor(() => expect(container.querySelector('canvas')).toBeNull())
    expect(container.textContent).toContain('TIFF')
  })
})
