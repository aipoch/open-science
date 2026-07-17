// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { PdfThumbnail } from './PdfThumbnail'

vi.mock('../managed-pdf-document', () => ({ createManagedPdfLoadingTask: vi.fn() }))

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

const createAbortablePendingLoadingTask = (): {
  promise: Promise<never>
  destroy: ReturnType<typeof vi.fn>
} => {
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject
  })
  const destroy = vi.fn().mockImplementation(() => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' })
    rejectPromise?.(error)
    return Promise.resolve()
  })

  return { promise, destroy }
}

describe('PdfThumbnail', () => {
  let container: HTMLDivElement
  let root: Root
  let getPage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    getPage = vi.fn().mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 140 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn()
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        getPage,
        destroy: vi.fn().mockResolvedValue(undefined)
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    window.api = {
      previewResources: {
        acquire: vi.fn(({ path }: { path: string }) =>
          Promise.resolve({
            id: `resource:${path}`,
            url: `open-science-preview://resource/${encodeURIComponent(path)}`,
            size: 40 * 1024 * 1024,
            mimeType: 'application/pdf',
            version: 1
          })
        ),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['rendered-page'], { type: 'image/png' }))
    })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:rendered-page'),
      revokeObjectURL: vi.fn()
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await flushMicrotasks()
    })
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads a large PDF through the range resource and renders only page one', async () => {
    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/session-1/report.pdf"
          name="report.pdf"
          source="upload"
          size={4096}
          mtimeMs={1}
        />
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      path: '/uploads/session-1/report.pdf'
    })
    expect(createManagedPdfLoadingTask).toHaveBeenCalledWith(
      expect.objectContaining({ size: 40 * 1024 * 1024 })
    )
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith(1)
    expect(container.querySelector('img[alt="Preview of report.pdf"]')?.getAttribute('src')).toBe(
      'blob:rendered-page'
    )
    expect(window.api.previewResources.release).toHaveBeenCalled()
  })

  it('recovers silently after a pending path disappears and the finalized path succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(window.api.previewResources.acquire)
      .mockRejectedValueOnce(new Error('ENOENT: pending upload moved'))
      .mockResolvedValueOnce({
        id: 'resource:/uploads/session-1/report.pdf',
        url: 'open-science-preview://resource/report.pdf',
        size: 40 * 1024 * 1024,
        mimeType: 'application/pdf',
        version: 2
      })

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/.pending/report.pdf"
          name="report.pdf"
          source="upload"
          size={4096}
          mtimeMs={1}
        />
      )
      await flushMicrotasks()
    })

    // Missing pending files are expected during finalization and should degrade to the icon quietly.
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to render PDF thumbnail',
      expect.any(Error)
    )

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/session-1/report.pdf"
          name="report.pdf"
          source="upload"
          size={4096}
          mtimeMs={2}
        />
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenLastCalledWith({
      source: 'upload',
      path: '/uploads/session-1/report.pdf'
    })
    expect(container.querySelector('img[alt="Preview of report.pdf"]')).not.toBeNull()
  })

  it('does not acquire or render until the thumbnail enters the preload viewport', async () => {
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

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/workspace/offscreen.pdf"
          name="offscreen.pdf"
          source="artifact"
          size={4096}
          mtimeMs={1}
        />
      )
      await flushMicrotasks()
    })
    expect(window.api.previewResources.acquire).not.toHaveBeenCalled()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith(1)
  })

  it('destroys an in-flight loading task when the thumbnail leaves the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    const pendingLoadingTask = createAbortablePendingLoadingTask()
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
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue(pendingLoadingTask as never)

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/workspace/cancel.pdf"
          name="cancel.pdf"
          source="artifact"
          size={4096}
          mtimeMs={1}
        />
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushMicrotasks()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushMicrotasks()
    })

    expect(pendingLoadingTask.destroy).toHaveBeenCalledTimes(1)
  })

  it('does not report PDF.js render cancellation as a thumbnail failure', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    let rejectRender: ((error: Error) => void) | undefined
    const cancelRender = vi.fn(() => {
      rejectRender?.(
        Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' })
      )
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        getPage: vi.fn().mockResolvedValue({
          getViewport: vi.fn(({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 140 * scale
          })),
          render: vi.fn(() => ({
            promise: new Promise((_, reject) => {
              rejectRender = reject
            }),
            cancel: cancelRender
          })),
          cleanup: vi.fn()
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/workspace/render-cancel.pdf"
          name="render-cancel.pdf"
          source="artifact"
          size={4096}
          mtimeMs={1}
        />
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushMicrotasks()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushMicrotasks()
    })

    expect(cancelRender).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('reacquires the same path when its version changes during rendering', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockImplementation(
      () => createAbortablePendingLoadingTask() as never
    )

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/workspace/changing.pdf"
          name="changing.pdf"
          source="artifact"
          size={4096}
          mtimeMs={1}
        />
      )
      await flushMicrotasks()
    })
    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/workspace/changing.pdf"
          name="changing.pdf"
          source="artifact"
          size={8192}
          mtimeMs={2}
        />
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight render for duplicate visible thumbnails', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue(
      createAbortablePendingLoadingTask() as never
    )

    await act(async () => {
      root.render(
        <>
          <PdfThumbnail
            path="/workspace/shared.pdf"
            name="shared.pdf"
            source="artifact"
            size={4096}
            mtimeMs={1}
          />
          <PdfThumbnail
            path="/workspace/shared.pdf"
            name="shared.pdf"
            source="artifact"
            size={4096}
            mtimeMs={1}
          />
        </>
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(createManagedPdfLoadingTask).toHaveBeenCalledTimes(1)
  })

  it('validates a cached thumbnail against the current filesystem version', async () => {
    vi.mocked(window.api.previewResources.acquire)
      .mockResolvedValueOnce({
        id: 'cached-v1',
        url: 'open-science-preview://cached-v1/cached.pdf',
        size: 4096,
        mimeType: 'application/pdf',
        version: 1
      })
      .mockResolvedValueOnce({
        id: 'cached-v2',
        url: 'open-science-preview://cached-v2/cached.pdf',
        size: 8192,
        mimeType: 'application/pdf',
        version: 2
      })
    const thumbnail = (
      <PdfThumbnail
        path="/workspace/cached.pdf"
        name="cached.pdf"
        source="artifact"
        size={4096}
        mtimeMs={1}
      />
    )

    await act(async () => {
      root.render(thumbnail)
      await flushMicrotasks()
    })
    await act(async () => root.render(<></>))
    await act(async () => {
      root.render(thumbnail)
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
    expect(createManagedPdfLoadingTask).toHaveBeenCalledTimes(2)
  })

  it('does not acquire a queued thumbnail after it leaves the viewport', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockImplementation(
      () => createAbortablePendingLoadingTask() as never
    )
    const thumbnail = (path: string): React.JSX.Element => (
      <PdfThumbnail
        key={path}
        path={path}
        name={path.split('/').at(-1) ?? path}
        source="artifact"
        size={4096}
        mtimeMs={1}
      />
    )

    await act(async () => {
      root.render(
        <>
          {thumbnail('/workspace/queued-1.pdf')}
          {thumbnail('/workspace/queued-2.pdf')}
          {thumbnail('/workspace/queued-3.pdf')}
        </>
      )
      await flushMicrotasks()
    })
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)

    await act(async () => {
      root.render(
        <>
          {thumbnail('/workspace/queued-1.pdf')}
          {thumbnail('/workspace/queued-2.pdf')}
        </>
      )
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh job when a same-key subscriber replaces an aborted job', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockImplementation(
      () => createAbortablePendingLoadingTask() as never
    )
    const thumbnail = (
      <PdfThumbnail
        path="/workspace/handoff.pdf"
        name="handoff.pdf"
        source="artifact"
        size={4096}
        mtimeMs={1}
      />
    )

    await act(async () => {
      root.render(thumbnail)
      await flushMicrotasks()
    })
    await act(async () => root.render(<></>))
    await act(async () => {
      root.render(thumbnail)
      await flushMicrotasks()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
  })

  it('regenerates a ready thumbnail after its cache entry is evicted', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/png' }))
    })
    const thumbnail = (path: string): React.JSX.Element => (
      <PdfThumbnail
        key={path}
        path={path}
        name={path.split('/').at(-1) ?? path}
        source="artifact"
        size={4096}
        mtimeMs={1}
      />
    )
    const first = thumbnail('/workspace/evicted-1.pdf')

    await act(async () => {
      root.render(first)
      await flushMicrotasks()
    })
    const allThumbnails = (): React.JSX.Element => (
      <>
        {thumbnail('/workspace/evicted-1.pdf')}
        {thumbnail('/workspace/evicted-2.pdf')}
        {thumbnail('/workspace/evicted-3.pdf')}
      </>
    )
    await act(async () => {
      root.render(allThumbnails())
    })
    await act(async () => {
      await flushMicrotasks()
      await vi.waitFor(() => expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(3))
      await flushMicrotasks()
    })
    await act(async () => {
      root.render(allThumbnails())
    })
    await act(async () => {
      await flushMicrotasks()
      await vi.waitFor(() => {
        const firstAcquires = vi
          .mocked(window.api.previewResources.acquire)
          .mock.calls.filter(([request]) => request.path === '/workspace/evicted-1.pdf')
        expect(firstAcquires).toHaveLength(2)
      })
    })

    const firstAcquires = vi
      .mocked(window.api.previewResources.acquire)
      .mock.calls.filter(([request]) => request.path === '/workspace/evicted-1.pdf')
    expect(firstAcquires).toHaveLength(2)
  })
})
