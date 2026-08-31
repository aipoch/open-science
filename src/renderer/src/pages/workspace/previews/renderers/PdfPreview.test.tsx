// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { PdfPreviewContent, PdfPreviewRenderer } from './PdfPreview'
import { requestAnnotationReveal } from '../../annotations/annotation-reveal'

vi.mock('../managed-pdf-document', () => ({ createManagedPdfLoadingTask: vi.fn() }))
const { cancelTextLayer, renderTextLayer } = vi.hoisted(() => ({
  cancelTextLayer: vi.fn(),
  renderTextLayer: vi.fn()
}))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    readonly div = document.createElement('div')

    constructor(
      private readonly options: {
        pdfPage: {
          getTextContent: () => Promise<{
            items?: Array<{
              str?: string
              transform?: number[]
              width?: number
              height?: number
            }>
          }>
        }
        onAppend?: (div: HTMLDivElement) => void
      }
    ) {
      this.div.className = 'textLayer'
    }

    async render(): Promise<void> {
      const textContent = await this.options.pdfPage.getTextContent()
      renderTextLayer(this.options)
      for (const item of textContent.items ?? []) {
        const span = document.createElement('span')
        span.textContent = item.str ?? ''
        const left = item.transform?.[4] ?? 0
        const top = item.transform?.[5] ?? 0
        const width = item.width ?? 0
        const height = item.height ?? 0
        span.getBoundingClientRect = () =>
          ({
            x: left,
            y: top,
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            toJSON: () => ({})
          }) as DOMRect
        this.div.appendChild(span)
      }
      const end = document.createElement('div')
      end.className = 'endOfContent'
      this.div.appendChild(end)
      this.options.onAppend?.(this.div)
    }

    cancel(): void {
      cancelTextLayer()
    }
  }
}))
vi.mock('../pdfjs', () => ({
  pdfjsLib: {
    TextLayer: class {
      constructor(
        private readonly options: {
          textContentSource: { items?: Array<{ str?: string }> }
          container: HTMLElement
        }
      ) {}

      render(): Promise<void> {
        renderTextLayer(this.options)
        for (const item of this.options.textContentSource.items ?? []) {
          const span = document.createElement('span')
          span.textContent = item.str ?? ''
          this.options.container.appendChild(span)
        }
        return Promise.resolve()
      }

      cancel(): void {
        cancelTextLayer()
      }
    }
  }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dispatchPointer = (target: EventTarget, type: string, init: PointerEventInit): void => {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: init.button,
    clientX: init.clientX,
    clientY: init.clientY
  })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true }
  })
  target.dispatchEvent(event)
}

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
    Element.prototype.scrollIntoView = vi.fn()
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
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
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
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
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
          managedFileId="artifact-1"
        />
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(createManagedPdfLoadingTask).toHaveBeenCalled())
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(createManagedPdfLoadingTask).toHaveBeenCalledWith(
      expect.objectContaining({ size: 80 * 1024 * 1024 })
    )
    expect(container.querySelector('canvas')).not.toBeNull()
    await vi.waitFor(() => expect(renderTextLayer).toHaveBeenCalled())
    expect(container.querySelector('[data-pdf-text-layer]')?.textContent).toBe('Selectable text')
    const textLayer = container.querySelector('[data-pdf-text-layer]')
    expect(textLayer?.classList.contains('textLayer')).toBe(true)
    expect(textLayer?.classList.contains('pdf-text-layer')).toBe(true)
    expect(container.querySelector('[data-pdf-text-layer] .endOfContent')).not.toBeNull()

    await act(async () => root.unmount())
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    expect(destroyDocument).toHaveBeenCalled()
    expect(destroyDocument.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.previewResources.release).mock.invocationCallOrder[0] as number
    )
  })

  it('acquires the exact managed Artifact version selected by the preview item', async () => {
    await act(async () => {
      root.render(
        <PdfPreviewRenderer
          item={{
            id: 'artifact-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            title: 'report.pdf',
            type: 'file',
            source: 'artifact',
            path: 'artifact-version:stale-projection',
            name: 'report.pdf',
            format: 'pdf',
            managedFileId: 'artifact-1',
            selectedVersionId: 'artifact-v2'
          }}
        />
      )
    })

    await vi.waitFor(() =>
      expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        versionId: 'artifact-v2'
      })
    )
  })

  it('shows a native outline, expands nested sections, and navigates to their PDF pages', async () => {
    const getDestination = vi.fn().mockResolvedValue([{ num: 20, gen: 0 }])
    const getPageIndex = vi.fn(({ num }: { num: number }) => Promise.resolve(num / 10 - 1))
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          {
            title: 'Introduction',
            dest: [{ num: 10, gen: 0 }],
            items: [{ title: 'Method', dest: 'method', items: [] }]
          },
          { title: 'Results', dest: [{ num: 30, gen: 0 }], items: [] }
        ]),
        getDestination,
        getPageIndex,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/outline.pdf" name="outline.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const outlineToggle = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    expect(outlineToggle.title).toBe('Navigation')

    await act(async () => outlineToggle.click())
    const outline = container.querySelector<HTMLElement>('#pdf-navigation-sidebar')!
    expect(outline.style.width).toBe('240px')
    expect(container.querySelector<HTMLButtonElement>('[title="Introduction"]')).not.toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[title="Method"]')).not.toBeNull()
    expect(getDestination).toHaveBeenCalledWith('method')

    const introduction = container.querySelector<HTMLButtonElement>('[title="Introduction"]')!
    introduction.focus()
    await act(async () =>
      introduction.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    await vi.waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.title).toBe('Method')
    )

    const pageTwo = container.querySelector<HTMLElement>('[data-page-number="2"]')!
    const scrollIntoView = vi.spyOn(pageTwo, 'scrollIntoView')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Method"]')!.click())

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(container.querySelector('[title="Method"]')?.getAttribute('aria-selected')).toBe('true')
    expect(outlineToggle.getAttribute('aria-expanded')).toBe('true')

    const resizeHandle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resize navigation"]'
    )!
    resizeHandle.setPointerCapture = vi.fn()
    resizeHandle.hasPointerCapture = vi.fn(() => true)
    resizeHandle.releasePointerCapture = vi.fn()
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 7, clientX: 240, clientY: 0 })
    )
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointermove', { pointerId: 7, clientX: 120, clientY: 0 })
    )
    expect(outline.style.width).toBe('160px')
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointerup', { pointerId: 7, clientX: 120, clientY: 0 })
    )
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
    expect(outlineToggle.getAttribute('aria-label')).toBe('Show navigation')

    await act(async () => outlineToggle.click())
    const reopenedOutline = container.querySelector<HTMLElement>('#pdf-navigation-sidebar')!
    const reopenedResizeHandle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resize navigation"]'
    )!
    await act(async () =>
      reopenedResizeHandle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      )
    )
    expect(reopenedOutline.style.width).toBe('176px')

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hide navigation"]')!.click()
    )
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
    expect(outlineToggle.getAttribute('aria-label')).toBe('Show navigation')
  })

  it('keeps the outline control hidden when the PDF has no native outline', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/plain.pdf" name="plain.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Show navigation"]')).toBeNull()
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
  })

  it('offers lazy page thumbnails when a multi-page PDF has no outline', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        getPageLabels: vi.fn().mockResolvedValue(['i', '1']),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/plain.pdf" name="plain.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => navigation.click())
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Back"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Forward"]')
    ).toBeNull()

    const pageTwo = container.querySelector<HTMLElement>('[data-page-number="2"]')!
    const scrollIntoView = vi.spyOn(pageTwo, 'scrollIntoView')
    const thumbnail = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Page 2 · 1"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => thumbnail.click())
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(thumbnail.getAttribute('aria-current')).toBe('page')
  })

  it('contains a damaged page rejection while rendering navigation thumbnails', async () => {
    const damagedPage = new Error('Damaged PDF page')
    let pageOneLoads = 0
    const page = {
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    }
    const getDamagedPage = vi.fn((pageNumber: number) => {
      if (pageNumber === 1 && ++pageOneLoads === 2) return Promise.reject(damagedPage)
      return Promise.resolve(page)
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: getDamagedPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      await act(async () => {
        root.render(<PdfPreviewContent path="/workspace/damaged.pdf" name="damaged.pdf" />)
        await Promise.resolve()
        await Promise.resolve()
      })
      const navigation = await vi.waitFor(() => {
        const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
        expect(button).not.toBeNull()
        return button!
      })
      await act(async () => navigation.click())
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).not.toHaveBeenCalled()
      expect(container.querySelector('#pdf-navigation-sidebar')).not.toBeNull()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the page thumbnail DOM bounded for thousand-page PDFs', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1_000,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/thousand-pages.pdf" name="large.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => navigation.click())

    const thumbnails = container.querySelectorAll(
      '#pdf-navigation-sidebar button[aria-label^="Page "]'
    )
    expect(thumbnails.length).toBeGreaterThan(0)
    expect(thumbnails.length).toBeLessThanOrEqual(24)
  })

  it('scopes Cmd+F to the PDF and searches every page without opening a global search', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search.pdf" name="search.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => scroll.dispatchEvent(shortcut))
    expect(shortcut.defaultPrevented).toBe(true)

    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'selectable'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))

    const outsideShortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    document.body.dispatchEvent(outsideShortcut)
    expect(outsideShortcut.defaultPrevented).toBe(false)
  })

  it('preserves word gaps and line endings while searching PDF text items', async () => {
    const highlights = { delete: vi.fn(), set: vi.fn() }
    const constructedHighlights: Range[][] = []
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class {
        constructor(...ranges: Range[]) {
          constructedHighlights.push(ranges)
        }
      }
    )
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi.fn().mockResolvedValue({
        items: [
          {
            str: 'The method',
            transform: [10, 0, 0, 10, 0, 20],
            width: 50,
            height: 10
          },
          {
            str: 'uses retrieval',
            transform: [10, 0, 0, 10, 55, 20],
            width: 60,
            height: 10,
            hasEOL: true
          }
        ],
        styles: {}
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-spacing.pdf" name="search.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'method uses retrieval'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))
    await vi.waitFor(() => expect(highlights.set).toHaveBeenCalledWith('pdf-search-results', {}))
    expect(constructedHighlights.some((ranges) => ranges.length > 0)).toBe(true)
  })

  it('stops a stale full-document search before parsing the remaining pages', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    let resolveFirstPage: ((value: { items: Array<{ str: string }> }) => void) | undefined
    const cleanupSearchPage = vi.fn()
    const searchGetPage = vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: cleanupSearchPage,
        getTextContent: () =>
          pageNumber === 1
            ? new Promise<{ items: Array<{ str: string }> }>((resolve) => {
                resolveFirstPage = resolve
              })
            : Promise.resolve({ items: [{ str: 'needle' }] })
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage: searchGetPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-cancel.pdf" name="search.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    const setQuery = async (query: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          query
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    await setQuery('needle')
    await act(async () => vi.advanceTimersByTimeAsync(180))
    expect(searchGetPage).toHaveBeenCalledTimes(1)
    await setQuery('')
    await act(async () => {
      resolveFirstPage?.({ items: [{ str: 'needle' }] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchGetPage).toHaveBeenCalledTimes(1)
    expect(cleanupSearchPage).toHaveBeenCalledOnce()
  })

  it('publishes the first search result before the remaining pages finish parsing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    let resolveSecondPage: ((value: { items: Array<{ str: string }> }) => void) | undefined
    const searchGetPage = vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: vi.fn(),
        getTextContent: () =>
          pageNumber === 1
            ? Promise.resolve({ items: [{ str: 'needle' }] })
            : new Promise<{ items: Array<{ str: string }> }>((resolve) => {
                resolveSecondPage = resolve
              })
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: searchGetPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-progress.pdf" name="search.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'needle'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(180)
    })

    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))
    expect(resolveSecondPage).toBeDefined()

    await act(async () => {
      resolveSecondPage?.({ items: [] })
      await Promise.resolve()
    })
  })

  it('updates the active outline on a bounded interval while the PDF is still scrolling', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          {
            title: 'Chapter',
            dest: [0],
            items: [{ title: 'Later section', dest: [2], items: [] }]
          },
          { title: 'Middle section', dest: [1], items: [] }
        ]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/live.pdf" name="live.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const outlineToggle = await vi.waitFor(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
    )
    await act(async () => outlineToggle?.click())
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      const top = index * 700 - 1_400
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        top,
        bottom: top + 600,
        height: 600
      } as DOMRect)
    })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
    await act(async () => vi.advanceTimersByTimeAsync(99))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(container.querySelector('[title="Middle section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
  })

  it('keeps navigation and detected page aligned while the next page remains below midpoint', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          { title: 'First', dest: [0], items: [] },
          { title: 'Target', dest: [1], items: [] },
          { title: 'Next', dest: [2], items: [] }
        ]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/short-pages.pdf" name="short-pages.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
    )
    await act(async () => navigation?.click())
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 800,
      top: 0,
      bottom: 600,
      width: 800,
      height: 600
    } as DOMRect)
    const pageBounds = [
      { top: -260, bottom: -20 },
      { top: 0, bottom: 240 },
      { top: 320, bottom: 560 }
    ]
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 600,
        width: 600,
        height: 240,
        ...pageBounds[index]
      } as DOMRect)
    })

    await act(async () => container.querySelector<HTMLButtonElement>('[title="Target"]')!.click())
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(container.querySelector('[title="Target"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[title="Next"]')?.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[data-pdf-page-control]')?.textContent).toBe('2/3')
  })

  it('tracks the current page without an outline or Reading callback', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/no-outline.pdf" name="no-outline.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      const top = index * 700 - 700
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        top,
        bottom: top + 600,
        height: 600
      } as DOMRect)
    })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(container.querySelector('[data-pdf-page-control]')?.textContent).toBe('2/3')
  })

  it('matches the artifact image zoom action order and reset icon', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const zoomButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => ['Zoom in', 'Zoom out', 'Reset zoom'].includes(button.ariaLabel ?? '')
    )
    expect(zoomButtons.map((button) => button.ariaLabel)).toEqual([
      'Zoom in',
      'Zoom out',
      'Reset zoom'
    ])
    expect(zoomButtons.at(-1)?.querySelector('.lucide-shrink')).not.toBeNull()
    expect(container.querySelector('[data-pdf-controls="view"] [aria-label="Area"]')).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Back"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Forward"]')
    ).toBeNull()
    expect(
      Array.from(container.querySelectorAll('[data-pdf-controls] button')).every(
        (button) => button.getAttribute('data-size') === 'icon-sm'
      )
    ).toBe(true)
  })

  it('shows the current and total pages and navigates from an entered page number', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const pageControl = container.querySelector<HTMLElement>('[data-pdf-page-control]')!
    expect(pageControl.textContent).toBe('1/3')
    await act(async () =>
      pageControl.querySelector<HTMLButtonElement>('[aria-label="Page 1 of 3"]')?.click()
    )

    const input = pageControl.querySelector<HTMLInputElement>('input')!
    const pageThree = container.querySelector<HTMLElement>('[data-page-number="3"]')!
    const scrollIntoView = vi.spyOn(pageThree, 'scrollIntoView')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(pageControl.textContent).toBe('3/3')
  })

  it('defaults to Select and lets Hand drag the PDF viewport', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const interactionControls = container.querySelector('[data-pdf-controls="interaction"]')
    const select = interactionControls?.querySelector<HTMLButtonElement>('[aria-label="Select"]')
    const hand = interactionControls?.querySelector<HTMLButtonElement>('[aria-label="Hand"]')
    expect(select?.getAttribute('aria-pressed')).toBe('true')
    expect(hand?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => hand?.click())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    expect(scroll.dataset.pdfCursorMode).toBe('hand')
    scroll.scrollLeft = 100
    scroll.scrollTop = 200
    scroll.setPointerCapture = vi.fn()
    scroll.hasPointerCapture = vi.fn(() => true)
    scroll.releasePointerCapture = vi.fn()

    await act(async () => dispatchPointer(scroll, 'pointerdown', { clientX: 50, clientY: 60 }))
    expect(scroll.className).toContain('cursor-grabbing')
    act(() => dispatchPointer(scroll, 'pointermove', { clientX: 30, clientY: 20 }))
    expect(scroll.scrollLeft).toBe(120)
    expect(scroll.scrollTop).toBe(240)
    await act(async () => dispatchPointer(scroll, 'pointerup', { clientX: 30, clientY: 20 }))
    expect(scroll.className).toContain('cursor-grab')
    expect(scroll.className).not.toContain('cursor-grabbing')
  })

  it('marks PDF.js whitespace spans so native selection does not paint detached blocks', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Evidence' }, { str: ' ' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-pdf-text-layer] span:last-of-type')?.classList
      ).toContain('pdf-text-layer-whitespace')
    )
    expect(
      container.querySelector('[data-pdf-text-layer] span:first-of-type')?.classList
    ).not.toContain('pdf-text-layer-whitespace')
  })

  it('coalesces scroll signals into 100ms page updates and skips unchanged pages', async () => {
    vi.useFakeTimers()
    const onReadingPositionChange = vi.fn()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="/workspace/reading.pdf"
          name="reading.pdf"
          source="local"
          onReadingPositionChange={onReadingPositionChange}
        />
      )
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    let scrollOffset = 390
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const top = index * 700 - scrollOffset
        return {
          top,
          bottom: top + 600,
          height: 600
        } as DOMRect
      })
    })

    onReadingPositionChange.mockClear()
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).not.toHaveBeenCalled()

    scrollOffset = 410
    act(() => {
      scroll.dispatchEvent(new Event('scroll'))
      scroll.dispatchEvent(new Event('scroll'))
      scroll.dispatchEvent(new Event('scroll'))
    })

    expect(onReadingPositionChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(99))
    expect(onReadingPositionChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(onReadingPositionChange).toHaveBeenCalledOnce()
    expect(onReadingPositionChange).toHaveBeenCalledWith({ pageNumber: 2, pageCount: 3 })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).toHaveBeenCalledOnce()

    scrollOffset = 1_110
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).toHaveBeenCalledTimes(2)
    expect(onReadingPositionChange).toHaveBeenLastCalledWith({ pageNumber: 3, pageCount: 3 })
  })

  it('uses each PDF page aspect ratio instead of stretching it into a fixed frame', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 900, height: 450 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/landscape.pdf" name="landscape.pdf" source="local" />
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
      root.render(<PdfPreviewContent path="/workspace/sharp.pdf" name="sharp.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/zoom.pdf" name="zoom.pdf" source="local" />)
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

  it('keeps the PDF text layer on the same scale as the zoomed page', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale,
        scale
      })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/text-scale.pdf" name="text-scale.pdf" source="local" />
      )
    })
    await vi.waitFor(() =>
      expect(
        container
          .querySelector<HTMLElement>('[data-pdf-text-layer]')
          ?.style.getPropertyValue('--total-scale-factor')
      ).toBe('1')
    )

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })

    await vi.waitFor(() =>
      expect(
        container
          .querySelector<HTMLElement>('[data-pdf-text-layer]')
          ?.style.getPropertyValue('--total-scale-factor')
      ).toBe('1.25')
    )

    clientWidthSpy.mockRestore()
  })

  it('projects persisted PDF Evidence from normalized coordinates and exposes area selection', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const onRemoveAnnotation = vi.fn(() => queueMicrotask(() => outside.focus()))
    const onUndoAnnotation = vi.fn(() => true)
    const onRedoAnnotation = vi.fn(() => true)

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfEvidenceSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: [
              {
                id: 'region-1',
                kind: 'pdf',
                target: 'agent',
                source,
                selector: {
                  kind: 'region',
                  pageNumber: 1,
                  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                  pageRotation: 0,
                  image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
                }
              },
              {
                id: 'stale-region',
                kind: 'pdf',
                target: 'agent',
                source: { ...source, checksum: 'b'.repeat(64) },
                selector: {
                  kind: 'region',
                  pageNumber: 1,
                  rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
                  pageRotation: 0,
                  image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
                }
              }
            ],
            onAddAnnotation: vi.fn(),
            onRemoveAnnotation,
            onUndoAnnotation,
            onRedoAnnotation
          }}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const highlight = container.querySelector<HTMLElement>(
      '[data-pdf-evidence-highlight="region-1"]'
    )
    expect(highlight?.style.left).toBe('10%')
    expect(highlight?.style.top).toBe('20%')
    expect(highlight?.style.width).toBe('30%')
    expect(highlight?.style.height).toBe('40%')
    expect(container.querySelector('[data-pdf-evidence-highlight="stale-region"]')).toBeNull()
    await act(async () => highlight?.click())
    expect(highlight?.getAttribute('aria-pressed')).toBe('true')
    await act(async () =>
      container
        .querySelector('[data-pdf-preview-root]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    )
    expect(onRemoveAnnotation).toHaveBeenCalledWith('region-1')

    const removeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove PDF area"]'
    )!
    expect(removeButton.style.left).toBe('40%')
    expect(removeButton.style.top).toBe('20%')
    expect(removeButton.style.transform).toBe('translate(-50%, -50%)')
    onRemoveAnnotation.mockClear()
    await act(async () => removeButton.click())
    expect(onRemoveAnnotation).toHaveBeenCalledWith('region-1')
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector('[role="region"]'))
    )

    const preview = document.activeElement!
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    )
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'y',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    expect(onUndoAnnotation).toHaveBeenCalledTimes(1)
    expect(onRedoAnnotation).toHaveBeenCalledTimes(2)
    outside.remove()

    const revealScroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    revealScroll.mockClear()
    const regionAnnotation = {
      id: 'region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source,
      selector: {
        kind: 'region' as const,
        pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }
    await act(async () => {
      requestAnnotationReveal(regionAnnotation)
    })

    expect(revealScroll).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'smooth'
    })
    const revealed = container.querySelector<HTMLElement>(
      '[data-pdf-evidence-highlight="region-1"]'
    )
    expect(revealed?.dataset.pdfEvidenceRevealed).toBe('true')
    expect(revealed?.classList.contains('pdf-evidence-reveal')).toBe(true)

    revealScroll.mockClear()
    await act(async () => requestAnnotationReveal(regionAnnotation))
    expect(revealScroll).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'smooth'
    })
    expect(container.querySelector('[data-pdf-evidence-highlight="region-1"]')).not.toBe(revealed)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Area"]')?.click()
    })
    expect(container.querySelector('[data-pdf-region-selection="true"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-pdf-controls="interaction"] [aria-label="Area"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true')
    expect(container.querySelector('[data-pdf-controls="view"] [aria-label="Area"]')).toBeNull()

    const areaSelection = container.querySelector<HTMLElement>(
      '[data-pdf-region-selection="true"]'
    )!
    areaSelection.setPointerCapture = vi.fn()
    areaSelection.hasPointerCapture = vi.fn(() => true)
    Object.defineProperty(areaSelection, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 400, bottom: 560, width: 400, height: 560 })
    })
    await act(async () =>
      dispatchPointer(areaSelection, 'pointerdown', {
        pointerId: 9,
        button: 2,
        clientX: 40,
        clientY: 56
      })
    )
    await act(async () => {
      dispatchPointer(areaSelection, 'pointermove', {
        pointerId: 9,
        button: 2,
        clientX: 200,
        clientY: 280
      })
    })
    expect(container.querySelector('[data-pdf-region-draft="true"]')).toBeNull()

    clientWidthSpy.mockRestore()
  })

  it('reveals sent PDF Evidence after the composer draft annotations are cleared', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }
    const annotation = {
      id: 'sent-region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source,
      selector: {
        kind: 'region' as const,
        pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfRevealSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: []
          }}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    await act(async () => requestAnnotationReveal(annotation))

    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLElement>('[data-pdf-evidence-highlight="sent-region-1"]')
          ?.dataset.pdfEvidenceRevealed
      ).toBe('true')
    )

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
      root.render(<PdfPreviewContent path="/workspace/align.pdf" name="align.pdf" source="local" />)
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

  it('keeps the same page location at the viewport top-left when zooming', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/anchor.pdf" name="anchor.pdf" source="local" />
      )
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    scroll.scrollTop = 700
    scroll.scrollLeft = 50
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 400,
      top: 0,
      bottom: 600,
      width: 400,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const width = Number.parseFloat(page.style.width)
        const height = width * 1.4
        const top = 16 + index * (height + 12) - scroll.scrollTop
        return {
          left: 16 - scroll.scrollLeft,
          right: 16 - scroll.scrollLeft + width,
          top,
          bottom: top + height,
          width,
          height
        } as DOMRect
      })
    })

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
    )

    await vi.waitFor(() => expect(container.textContent).toContain('125%'))
    expect(scroll.scrollTop).toBe(868)
    expect(scroll.scrollLeft).toBe(58.5)

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
      root.render(<PdfPreviewContent path="/workspace/a11y.pdf" name="a11y.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/wide.pdf" name="wide.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/wheel.pdf" name="wheel.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="local" />)
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
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="local" />
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
      root.render(<PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="local" />)
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
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="local" />
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
        <PdfPreviewContent path="/workspace/resize.pdf" name="resize.pdf" source="local" />
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

  it('preserves the page-relative viewport location when the preview changes width', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
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
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 3, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/modal.pdf" name="modal.pdf" />)
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    scroll.scrollTop = 700
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 400,
      top: 0,
      bottom: 600,
      width: 400,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const width = Number.parseFloat(page.style.width)
        const height = width * 1.4
        const top = 16 + index * (height + 12) - scroll.scrollTop
        return { left: 16, right: 16 + width, top, bottom: top + height, width, height } as DOMRect
      })
    })

    await act(async () => {
      measuredWidth = 600
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })

    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
        '600px'
      )
    )
    expect(scroll.scrollTop).toBe(1036)

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
      root.render(<PdfPreviewContent path="/workspace/tall.pdf" name="tall.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/hidpi.pdf" name="hidpi.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/deep.pdf" name="deep.pdf" source="local" />)
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
        <PdfPreviewContent path="/workspace/scroll.pdf" name="scroll.pdf" source="local" />
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
        <PdfPreviewContent path="/workspace/broken.pdf" name="broken.pdf" source="local" />
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
    let intersectionCallback: IntersectionObserverCallback | undefined
    const observed: Element[] = []
    const createObserver = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn((element: Element) => observed.push(element))
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          createObserver()
          intersectionCallback = callback
        }
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/lazy-pages.pdf" name="lazy-pages.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createObserver).toHaveBeenCalledTimes(1)
    expect(getPage).not.toHaveBeenCalled()
    expect(container.querySelectorAll('canvas')).toHaveLength(0)

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true, target: observed[0] } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getPage).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith(1)
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('does not mount annotation and Evidence listeners for every page in a large PDF', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 120, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'large.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfEvidenceSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: [],
            onAddAnnotation: vi.fn(() => undefined)
          }}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(120)
    expect(container.querySelectorAll('[data-preview-text-annotation-surface]')).toHaveLength(0)
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
        <PdfPreviewContent path="/workspace/loading.pdf" name="loading.pdf" source="local" />
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
      root.render(<PdfPreviewContent path="/workspace/long.pdf" name="long.pdf" source="local" />)
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
      root.render(<PdfPreviewContent path="/workspace/late.pdf" name="late.pdf" source="local" />)
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
        <PdfPreviewContent path="/workspace/active.pdf" name="active.pdf" source="local" />
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
