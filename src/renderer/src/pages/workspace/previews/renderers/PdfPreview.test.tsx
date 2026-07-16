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
        <PdfPreviewContent path="/workspace/report.pdf" name="report.pdf" source="artifact" />
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(createManagedPdfLoadingTask).toHaveBeenCalled())
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/report.pdf'
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
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render: vi.fn(() => ({ promise: new Promise(() => undefined), cancel: cancelRender })),
      cleanup: cleanupPage
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/active.pdf" name="active.pdf" source="artifact" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledWith(1))

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
