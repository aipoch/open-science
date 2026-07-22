// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BoundedBlobUrlCache,
  collectReferencedPptxMediaUrls,
  MAX_PPTX_MEDIA_URLS,
  releaseDecodedPptxMedia,
  renderOfficeFile
} from './office-renderers'

const mocks = vi.hoisted(() => ({
  renderDocx: vi.fn(),
  renderSpreadsheet: vi.fn(),
  constructPptx: vi.fn(),
  openPptx: vi.fn(),
  destroyPptx: vi.fn(),
  exposePptxMediaCache: true,
  exposePptxMediaResolver: true,
  zipLimits: { maxEntries: 4000 }
}))

vi.mock('docx-preview', () => ({ renderAsync: mocks.renderDocx }))
vi.mock('@file-viewer/renderer-spreadsheet', () => ({
  renderFileViewerSpreadsheet: mocks.renderSpreadsheet
}))
vi.mock('@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker?worker&url', () => ({
  default: 'local-sheet-worker.js'
}))
vi.mock('@aiden0z/pptx-renderer', () => {
  class MockPptxViewer {
    static open = mocks.openPptx

    open = mocks.openPptx
    destroy = mocks.destroyPptx
    slideWidth = 960
    slideHeight = 540
    mediaUrlCache = mocks.exposePptxMediaCache ? new Map<string, string>() : undefined
    presentationData = mocks.exposePptxMediaResolver
      ? {
          mediaResolver: {
            media: new Map<string, Uint8Array>(),
            loadedPaths: new Set<string>()
          }
        }
      : { mediaResolver: {} }

    constructor(container: HTMLElement, options: unknown) {
      mocks.constructPptx(container, options)
    }
  }

  return { PptxViewer: MockPptxViewer, RECOMMENDED_ZIP_LIMITS: mocks.zipLimits }
})

describe('renderOfficeFile', () => {
  const bytes = new Uint8Array([1, 2, 3])
  let container: HTMLDivElement
  let signal: AbortSignal

  class ReadyWorker extends EventTarget {
    static instances: ReadyWorker[] = []

    terminate = vi.fn()
    messages: Array<{ message: unknown; transfer?: Transferable[] }> = []

    constructor() {
      super()
      ReadyWorker.instances.push(this)
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
      this.messages.push({ message, transfer })
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message')))
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.exposePptxMediaCache = true
    mocks.exposePptxMediaResolver = true
    ReadyWorker.instances = []
    vi.stubGlobal('Worker', ReadyWorker)
    container = document.createElement('div')
    signal = new AbortController().signal
  })

  afterEach(() => {
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('waits for slide unmount before evicting PPTX media Blob URLs', () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const cache = new BoundedBlobUrlCache()
    const onEvict = vi.fn()
    cache.setEvictionHandler(onEvict)

    for (let index = 0; index <= MAX_PPTX_MEDIA_URLS; index += 1) {
      cache.set(`media-${index}`, `blob:media-${index}`)
    }

    expect(cache.size).toBe(MAX_PPTX_MEDIA_URLS + 1)
    expect(revokeObjectUrl).not.toHaveBeenCalled()

    cache.trim(new Set(['blob:media-0']))

    expect(cache.size).toBe(MAX_PPTX_MEDIA_URLS)
    expect(cache.has('media-0')).toBe(true)
    expect(cache.has('media-1')).toBe(false)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:media-1')
    expect(onEvict).toHaveBeenCalledWith('media-1')

    cache.set('media-overflow', 'blob:media-overflow')
    cache.trim(new Set(cache.values()))
    expect(cache.size).toBe(MAX_PPTX_MEDIA_URLS + 1)
    expect(revokeObjectUrl).not.toHaveBeenCalledWith('blob:media-0')
  })

  it('releases every decoded resolver alias when a PPTX media URL is evicted', () => {
    const decoded = new Uint8Array([1, 2, 3])
    const resolver = {
      media: new Map([
        ['ppt/media/image%201.png', decoded],
        ['ppt/media/image 1.png', decoded],
        ['ppt/media/other.png', new Uint8Array([4])]
      ]),
      loadedPaths: new Set(['ppt/media/image%201.png', 'ppt/media/other.png'])
    }

    releaseDecodedPptxMedia(resolver, 'ppt/media/image%201.png')

    expect(resolver.media.has('ppt/media/image%201.png')).toBe(false)
    expect(resolver.media.has('ppt/media/image 1.png')).toBe(false)
    expect(resolver.media.has('ppt/media/other.png')).toBe(true)
    expect(resolver.loadedPaths.has('ppt/media/image%201.png')).toBe(false)
  })

  it.each([':emf-pdf', ':emf-bitmap'])(
    'releases decoded media for the %s derived URL',
    (suffix) => {
      const mediaPath = 'ppt/media/vector.emf'
      const decoded = new Uint8Array([1, 2, 3])
      const resolver = {
        media: new Map([[mediaPath, decoded]]),
        loadedPaths: new Set([mediaPath])
      }

      releaseDecodedPptxMedia(resolver, `${mediaPath}${suffix}`)

      expect(resolver.media.has(mediaPath)).toBe(false)
      expect(resolver.loadedPaths.has(mediaPath)).toBe(false)
    }
  )

  it('detects Blob URLs still referenced by mounted PPTX slide elements', () => {
    const cache = new Map([
      ['image', 'blob:active-image'],
      ['background', 'blob:active-background'],
      ['old', 'blob:inactive-image']
    ])
    container.innerHTML =
      '<img src="blob:active-image"><div style="background-image:url(blob:active-background)"></div>'

    expect(collectReferencedPptxMediaUrls(container, cache)).toEqual(
      new Set(['blob:active-image', 'blob:active-background'])
    )
  })

  it('renders DOCX with active-content features disabled and cleans up Blob URLs', async () => {
    mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'docx-wrapper'
      wrapper.style.paddingLeft = '30px'
      wrapper.style.paddingRight = '30px'
      const page = document.createElement('section')
      page.className = 'docx'
      page.style.width = '800px'
      const image = document.createElement('img')
      image.src = 'blob:word-image'
      page.appendChild(image)
      const link = document.createElement('a')
      link.href = 'https://example.com/reference'
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = 'Reference'
      page.appendChild(link)
      wrapper.appendChild(page)
      target.appendChild(wrapper)
    })
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 460 })
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'docx',
      name: 'report.docx',
      container,
      signal
    })

    expect(mocks.renderDocx).toHaveBeenCalledWith(bytes, container, container, {
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderAltChunks: false,
      renderComments: false,
      useBase64URL: true
    })
    const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
    expect(wrapper?.style.alignItems).toBe('center')
    expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe('0.5')
    expect(container.querySelector('style[data-open-science-docx-fit]')?.textContent).toContain(
      'zoom: var(--open-science-docx-scale, 1)'
    )
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(container.querySelector('a')?.hasAttribute('target')).toBe(false)
    expect(container.querySelector('a')?.hasAttribute('rel')).toBe(false)

    await cleanup()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:word-image')
    expect(container.childNodes).toHaveLength(0)
  })

  it('uses inline DOCX resources so a failure cannot leak detached Blob URLs', async () => {
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:detached-word-image')
    mocks.renderDocx.mockImplementation(async (_bytes, _target, _styles, options) => {
      expect(options?.useBase64URL).toBe(true)
      throw new Error('invalid document')
    })
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'docx',
        name: 'broken.docx',
        container,
        signal
      })
    ).rejects.toThrow(/invalid document/i)

    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(revokeObjectUrl).not.toHaveBeenCalled()
    expect(container.childNodes).toHaveLength(0)
  })

  it('removes the DOCX wrapper frame while preserving paper styling', async () => {
    document.body.append(container)
    mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
      const vendorStyle = document.createElement('style')
      vendorStyle.textContent = `
        .docx-wrapper { background: gray; padding: 30px; padding-bottom: 0; }
        .docx-wrapper > section.docx {
          background: white;
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
          margin-bottom: 30px;
        }
      `
      const wrapper = document.createElement('div')
      wrapper.className = 'docx-wrapper'
      const page = document.createElement('section')
      page.className = 'docx'
      page.style.width = '800px'
      wrapper.appendChild(page)
      target.append(vendorStyle, wrapper)
    })
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 800 })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'docx',
      name: 'edge-to-edge.docx',
      container,
      signal
    })

    const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
    const page = container.querySelector<HTMLElement>('section.docx')
    const wrapperStyle = getComputedStyle(wrapper!)
    const pageStyle = getComputedStyle(page!)
    expect(wrapperStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(wrapperStyle.paddingLeft).toBe('0px')
    expect(wrapperStyle.paddingRight).toBe('0px')
    expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe('1')
    expect(pageStyle.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(pageStyle.boxShadow).toBe('0 2px 8px rgba(0, 0, 0, 0.15)')
    expect(container.querySelector('style[data-open-science-docx-fit]')?.textContent).toContain(
      'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15)'
    )
    expect(container.querySelector('style[data-open-science-docx-fit]')?.textContent).toContain(
      'content-visibility: auto'
    )
    expect(container.querySelector('style[data-open-science-docx-fit]')?.textContent).toContain(
      'contain-intrinsic-size: auto'
    )
    expect(pageStyle.marginBottom).toBe('30px')

    await cleanup()
  })

  it('fits mixed DOCX page sizes using the widest rendered page', async () => {
    mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'docx-wrapper'
      wrapper.style.paddingLeft = '30px'
      wrapper.style.paddingRight = '30px'
      for (const width of [600, 1000]) {
        const page = document.createElement('section')
        page.className = 'docx'
        page.style.width = `${width}px`
        wrapper.appendChild(page)
      }
      target.appendChild(wrapper)
    })
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 460 })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'docx',
      name: 'mixed-layout.docx',
      container,
      signal
    })

    expect(
      container
        .querySelector<HTMLElement>('.docx-wrapper')
        ?.style.getPropertyValue('--open-science-docx-scale')
    ).toBe('0.4')

    await cleanup()
  })

  it.each([
    { containerWidth: 1260, expectedScale: '1', expectedAlignment: 'center' },
    { containerWidth: 160, expectedScale: '0.25', expectedAlignment: 'flex-start' }
  ])(
    'clamps automatic DOCX fit for a $containerWidth px viewport',
    async ({ containerWidth, expectedScale, expectedAlignment }) => {
      mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
        const wrapper = document.createElement('div')
        wrapper.className = 'docx-wrapper'
        wrapper.style.paddingLeft = '30px'
        wrapper.style.paddingRight = '30px'
        const page = document.createElement('section')
        page.className = 'docx'
        page.style.width = '800px'
        wrapper.appendChild(page)
        target.appendChild(wrapper)
      })
      Object.defineProperty(container, 'clientWidth', {
        configurable: true,
        value: containerWidth
      })

      const cleanup = await renderOfficeFile({
        bytes,
        extension: 'docx',
        name: 'bounded-layout.docx',
        container,
        signal
      })

      const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
      expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe(expectedScale)
      expect(wrapper?.style.alignItems).toBe(expectedAlignment)

      await cleanup()
    }
  )

  it('updates DOCX fit after resize and disposes pending layout work', async () => {
    let resizeCallback: ResizeObserverCallback | undefined
    let frameCallback: FrameRequestCallback | undefined
    let frameId = 0
    const observe = vi.fn()
    const disconnect = vi.fn()
    const cancelAnimationFrame = vi.fn()
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }

      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback
        frameId += 1
        return frameId
      })
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)

    let containerWidth = 860
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => containerWidth
    })
    mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'docx-wrapper'
      wrapper.style.paddingLeft = '30px'
      wrapper.style.paddingRight = '30px'
      const page = document.createElement('section')
      page.className = 'docx'
      page.style.width = '800px'
      wrapper.appendChild(page)
      target.appendChild(wrapper)
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'docx',
      name: 'responsive.docx',
      container,
      signal
    })
    const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
    expect(observe).toHaveBeenCalledWith(container)
    expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe('1')

    containerWidth = 460
    resizeCallback?.([], {} as ResizeObserver)
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe('1')
    frameCallback?.(0)
    expect(wrapper?.style.getPropertyValue('--open-science-docx-scale')).toBe('0.5')

    resizeCallback?.([], {} as ResizeObserver)
    await cleanup()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2)
  })

  it.each(['xls', 'xlsx'] as const)(
    'renders %s in the local spreadsheet Worker',
    async (extension) => {
      const unmount = vi.fn()
      mocks.renderSpreadsheet.mockImplementation(async (_buffer, _target, _type, context) => {
        new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
        queueMicrotask(() => context?.onProgressiveRender?.())
        return { unmount }
      })

      const cleanup = await renderOfficeFile({
        bytes,
        extension,
        name: `results.${extension}`,
        container,
        signal
      })

      expect(mocks.renderSpreadsheet).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        container,
        extension,
        {
          filename: `results.${extension}`,
          signal,
          onProgressiveRender: expect.any(Function),
          options: {
            locale: 'en-US',
            spreadsheet: {
              worker: true,
              workerUrl: new URL('local-sheet-worker.js', document.baseURI).href
            }
          }
        }
      )

      await cleanup()
      expect(unmount).toHaveBeenCalledOnce()
      expect(ReadyWorker.instances).toHaveLength(1)
      expect(container.childNodes).toHaveLength(0)
    }
  )

  it('transfers spreadsheet workbook ownership to the parsing Worker', async () => {
    const unmount = vi.fn()
    let workbook: ArrayBuffer | undefined
    mocks.renderSpreadsheet.mockImplementation(async (buffer, _target, _type, context) => {
      workbook = buffer
      const worker = new Worker(context?.options?.spreadsheet?.workerUrl, {
        type: 'module'
      }) as unknown as ReadyWorker
      worker.postMessage({ type: 'parseWorkbook', payload: { workbook: buffer } })
      queueMicrotask(() => context?.onProgressiveRender?.())
      return { unmount }
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'results.xlsx',
      container,
      signal
    })

    const parseMessage = ReadyWorker.instances[0]?.messages.find(
      ({ message }) =>
        typeof message === 'object' &&
        message !== null &&
        'payload' in message &&
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'workbook' in message.payload &&
        message.payload.workbook === workbook
    )
    expect(workbook).toBe(bytes.buffer)
    expect(parseMessage?.transfer).toEqual([workbook])

    await cleanup()
  })

  it('hides the vendor blocking loader before parsing while preserving background progress', async () => {
    const unmount = vi.fn()
    const onStatus = vi.fn()
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, target, _type, context) => {
      const statusStyle = document.head.querySelector<HTMLStyleElement>(
        'style[data-open-science-spreadsheet-status]'
      )
      expect(target.hasAttribute('data-open-science-spreadsheet-preview')).toBe(true)
      expect(statusStyle?.textContent).toContain(
        '[data-open-science-spreadsheet-preview] .excel-wrapper .loading'
      )
      expect(statusStyle?.textContent).toContain('display: none !important')
      expect(statusStyle?.textContent).toContain('.excel-wrapper .sheet-loading')
      expect(statusStyle?.textContent).not.toContain('.excel-wrapper .loading-card')

      new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
      const wrapper = document.createElement('div')
      wrapper.className = 'excel-wrapper'
      wrapper.innerHTML = [
        '<div class="loading"><div class="loading-card"></div></div>',
        '<div class="sheet-loading"><span class="sheet-loading-dot"></span></div>'
      ].join('')
      target.appendChild(wrapper)
      queueMicrotask(() => context?.onProgressiveRender?.())
      return { unmount }
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'results.xlsx',
      container,
      signal,
      onStatus
    })

    const style = document.head.querySelector<HTMLStyleElement>(
      'style[data-open-science-spreadsheet-status]'
    )
    expect(onStatus).toHaveBeenCalledWith({
      phase: 'parsing',
      title: 'Parsing the Excel workbook',
      description: 'Preparing worksheets, styles, and virtualized viewport data.'
    })
    expect(onStatus).toHaveBeenCalledWith({
      phase: 'rendering',
      title: 'Rendering the preview',
      description: 'Building the document view.'
    })
    expect(getComputedStyle(container.querySelector<HTMLElement>('.loading')!).display).toBe('none')
    expect(style?.textContent).toContain('.excel-wrapper .sheet-loading')
    expect(style?.textContent).toContain('box-shadow: none')
    expect(style?.textContent).toContain('@media (prefers-reduced-motion: reduce)')

    await cleanup()
    expect(document.head.querySelector('style[data-open-science-spreadsheet-status]')).toBeNull()
    expect(container.hasAttribute('data-open-science-spreadsheet-preview')).toBe(false)
  })

  it('unmounts a spreadsheet Worker when rendering is aborted before first paint', async () => {
    const controller = new AbortController()
    const unmount = vi.fn()
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, _target, _type, context) => {
      new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
      return { unmount }
    })

    const rendering = renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'slow.xlsx',
      container,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(mocks.renderSpreadsheet).toHaveBeenCalledOnce())
    controller.abort(new Error('timed out'))

    await expect(rendering).rejects.toThrow(/timed out/i)
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('rejects immediately when the spreadsheet renderer reports a parse error', async () => {
    const controller = new AbortController()
    const unmount = vi.fn()
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, target, _type, context) => {
      new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
      const wrapper = document.createElement('div')
      wrapper.className = 'excel-wrapper'
      const error = document.createElement('div')
      error.className = 'error hidden'
      wrapper.appendChild(error)
      target.appendChild(wrapper)
      queueMicrotask(() => {
        error.textContent = 'Workbook data is invalid'
        error.classList.remove('hidden')
      })
      return { unmount }
    })

    const rendering = renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'broken.xlsx',
      container,
      signal: controller.signal
    })
    const outcome = await Promise.race([
      rendering.then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      new Promise<'pending'>((resolve) => window.setTimeout(() => resolve('pending'), 20))
    ])
    controller.abort()
    await rendering.catch(() => undefined)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/Workbook data is invalid/i)
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('preserves a spreadsheet parse error when vendor cleanup also fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unmount = vi.fn().mockRejectedValue(new Error('cleanup failed'))
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, target, _type, context) => {
      new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
      const wrapper = document.createElement('div')
      wrapper.className = 'excel-wrapper'
      const error = document.createElement('div')
      error.className = 'error'
      error.textContent = 'Workbook data is invalid'
      wrapper.appendChild(error)
      target.appendChild(wrapper)
      return { unmount }
    })

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'xlsx',
        name: 'broken.xlsx',
        container,
        signal
      })
    ).rejects.toThrow(/Workbook data is invalid/i)

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to dispose spreadsheet preview',
      expect.objectContaining({ message: 'cleanup failed' })
    )
    expect(ReadyWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
    expect(container.childNodes).toHaveLength(0)
  })

  it('reuses the handshaken Worker when another native construction would fail', async () => {
    let nativeConstructions = 0
    class SingleUseWorker extends ReadyWorker {
      constructor() {
        if (nativeConstructions > 0) throw new Error('second native Worker rejected')
        super()
        nativeConstructions += 1
      }
    }
    vi.stubGlobal('Worker', SingleUseWorker)
    const unmount = vi.fn()
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, _target, _type, context) => {
      new Worker(context?.options?.spreadsheet?.workerUrl, { type: 'module' })
      queueMicrotask(() => context?.onProgressiveRender?.())
      return { unmount }
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'results.xlsx',
      container,
      signal
    })

    expect(nativeConstructions).toBe(1)
    await cleanup()
  })

  it('reuses the handshaken Worker after the vendor resolves its URL', async () => {
    const unmount = vi.fn()
    mocks.renderSpreadsheet.mockImplementation(async (_buffer, _target, _type, context) => {
      const configuredUrl = context?.options?.spreadsheet?.workerUrl
      new Worker(new URL(configuredUrl, document.baseURI), { type: 'module' })
      queueMicrotask(() => context?.onProgressiveRender?.())
      return { unmount }
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'xlsx',
      name: 'results.xlsx',
      container,
      signal
    })

    expect(ReadyWorker.instances).toHaveLength(1)
    await cleanup()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('rejects when the spreadsheet renderer does not claim the handshaken Worker', async () => {
    const unmount = vi.fn()
    mocks.renderSpreadsheet.mockResolvedValue({ unmount })

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'xlsx',
        name: 'results.xlsx',
        container,
        signal
      })
    ).rejects.toThrow(/did not claim/i)

    expect(unmount).toHaveBeenCalledOnce()
    expect(ReadyWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('rejects spreadsheet rendering when a local Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined)

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'xlsx',
        name: 'results.xlsx',
        container,
        signal
      })
    ).rejects.toThrow(/Worker is unavailable/i)

    expect(mocks.renderSpreadsheet).not.toHaveBeenCalled()
  })

  it('renders PPTX with upstream ZIP limits and lazy windowing', async () => {
    mocks.openPptx.mockResolvedValue(undefined)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 800 })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'pptx',
      name: 'slides.pptx',
      container,
      signal
    })

    expect(mocks.constructPptx).toHaveBeenCalledWith(container, {
      width: 800,
      zipLimits: mocks.zipLimits,
      lazySlides: true,
      lazyMedia: true,
      scrollContainer: container,
      pdfjs: false,
      onRenderStart: expect.any(Function),
      onSlideUnmounted: expect.any(Function),
      onSlideRendered: expect.any(Function)
    })
    expect(mocks.openPptx).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      renderMode: 'list',
      listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
      lazySlides: true,
      lazyMedia: true,
      signal
    })

    await cleanup()
    expect(mocks.destroyPptx).toHaveBeenCalledOnce()
    expect(container.childNodes).toHaveLength(0)
  })

  it('rejects an incompatible PPTX media-cache contract before opening the file', async () => {
    mocks.exposePptxMediaCache = false

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'pptx',
        name: 'slides.pptx',
        container,
        signal
      })
    ).rejects.toThrow(/media cache contract changed/i)

    expect(mocks.openPptx).not.toHaveBeenCalled()
    expect(mocks.destroyPptx).toHaveBeenCalledOnce()
  })

  it('rejects an incompatible PPTX media-resolver contract after opening the file', async () => {
    mocks.exposePptxMediaResolver = false

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'pptx',
        name: 'slides.pptx',
        container,
        signal
      })
    ).rejects.toThrow(/media resolver contract changed/i)

    expect(mocks.openPptx).toHaveBeenCalledOnce()
    expect(mocks.destroyPptx).toHaveBeenCalledOnce()
  })

  it('uses the provided Office scroll container for windowed PPTX mounting', async () => {
    const scrollContainer = document.createElement('div')
    mocks.openPptx.mockResolvedValue(undefined)

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'pptx',
      name: 'scrollable-slides.pptx',
      container,
      scrollContainer,
      signal
    })

    expect(mocks.constructPptx).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ scrollContainer })
    )
    expect(mocks.constructPptx.mock.calls[0]?.[1].scrollContainer).toBe(scrollContainer)

    await cleanup()
  })

  it('fits PPTX slides in place while the preview panel is resized', async () => {
    let containerWidth = 800
    let resizeCallback: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }

      observe = vi.fn()
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    const scheduledFrames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        const frame = nextFrame++
        scheduledFrames.set(frame, callback)
        return frame
      })
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((frame) => {
        scheduledFrames.delete(frame)
      })
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => containerWidth
    })

    let initialItem: HTMLDivElement | undefined
    let initialWrapper: HTMLDivElement | undefined
    let initialSlide: HTMLDivElement | undefined
    mocks.openPptx.mockImplementation(async () => {
      initialItem = document.createElement('div')
      initialItem.dataset.slideIndex = '0'
      initialWrapper = document.createElement('div')
      initialSlide = document.createElement('div')
      initialWrapper.appendChild(initialSlide)
      initialItem.appendChild(initialWrapper)
      container.appendChild(initialItem)
    })

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'pptx',
      name: 'responsive-slides.pptx',
      container,
      signal
    })

    expect(initialWrapper?.style.width).toBe('800px')
    expect(initialWrapper?.style.height).toBe('450px')
    expect(initialSlide?.style.transform).toBe('scale(0.8333333333333334)')

    containerWidth = 480
    resizeCallback?.([], {} as ResizeObserver)
    resizeCallback?.([], {} as ResizeObserver)

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(initialWrapper?.style.width).toBe('800px')
    const [resizeFrame, resizeTask] = Array.from(scheduledFrames.entries())[0] ?? []
    expect(resizeTask).toBeDefined()
    scheduledFrames.delete(resizeFrame)
    resizeTask?.(0)

    expect(mocks.openPptx).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-slide-index="0"]')).toBe(initialItem)
    expect(initialWrapper?.style.width).toBe('480px')
    expect(initialWrapper?.style.height).toBe('270px')
    expect(initialSlide?.style.transform).toBe('scale(0.5)')

    // Windowed slides mounted after a resize must use the current scale before the next paint.
    const lateItem = document.createElement('div')
    lateItem.dataset.slideIndex = '1'
    const lateWrapper = document.createElement('div')
    const lateSlide = document.createElement('div')
    lateWrapper.appendChild(lateSlide)
    lateItem.appendChild(lateWrapper)
    container.appendChild(lateItem)
    const viewerOptions = mocks.constructPptx.mock.calls[0]?.[1] as {
      onSlideRendered?: (index: number, element: HTMLElement) => void
    }
    viewerOptions.onSlideRendered?.(1, lateSlide)

    expect(lateWrapper.style.width).toBe('480px')
    expect(lateWrapper.style.height).toBe('270px')
    expect(lateSlide.style.transform).toBe('scale(0.5)')

    containerWidth = 360
    resizeCallback?.([], {} as ResizeObserver)
    expect(scheduledFrames.size).toBe(1)

    const pendingItem = document.createElement('div')
    pendingItem.dataset.slideIndex = '2'
    const pendingWrapper = document.createElement('div')
    const pendingSlide = document.createElement('div')
    pendingWrapper.appendChild(pendingSlide)
    pendingItem.appendChild(pendingWrapper)
    container.appendChild(pendingItem)
    viewerOptions.onSlideRendered?.(2, pendingSlide)

    expect(pendingWrapper.style.width).toBe('360px')
    expect(pendingWrapper.style.height).toBe('202.5px')
    expect(pendingSlide.style.transform).toBe('scale(0.375)')

    await cleanup()

    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2)
    expect(scheduledFrames.size).toBe(0)
    expect(mocks.destroyPptx).toHaveBeenCalledOnce()
  })

  it('destroys a PPTX viewer when opening the presentation fails', async () => {
    mocks.openPptx.mockRejectedValue(new Error('invalid presentation'))

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'pptx',
        name: 'broken.pptx',
        container,
        signal
      })
    ).rejects.toThrow(/invalid presentation/i)

    expect(mocks.constructPptx).toHaveBeenCalledOnce()
    expect(mocks.destroyPptx).toHaveBeenCalledOnce()
    expect(container.childNodes).toHaveLength(0)
  })

  it('preserves a PPTX open error when viewer destruction also fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.openPptx.mockImplementation(async () => {
      container.appendChild(document.createElement('div'))
      throw new Error('invalid presentation')
    })
    mocks.destroyPptx.mockImplementation(() => {
      throw new Error('cleanup failed')
    })

    await expect(
      renderOfficeFile({
        bytes,
        extension: 'pptx',
        name: 'broken.pptx',
        container,
        signal
      })
    ).rejects.toThrow(/invalid presentation/i)

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to dispose PPTX preview',
      expect.objectContaining({ message: 'cleanup failed' })
    )
    expect(container.childNodes).toHaveLength(0)
  })
})
