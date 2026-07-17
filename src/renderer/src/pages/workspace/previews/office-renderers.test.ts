// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderOfficeFile } from './office-renderers'

const mocks = vi.hoisted(() => ({
  renderDocx: vi.fn(),
  renderSpreadsheet: vi.fn(),
  constructPptx: vi.fn(),
  openPptx: vi.fn(),
  destroyPptx: vi.fn(),
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

    constructor() {
      super()
      ReadyWorker.instances.push(this)
    }

    postMessage(): void {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message')))
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
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
    expect(pageStyle.boxShadow).not.toBe('none')
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
            locale: 'zh-CN',
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

    const cleanup = await renderOfficeFile({
      bytes,
      extension: 'pptx',
      name: 'slides.pptx',
      container,
      signal
    })

    expect(mocks.constructPptx).toHaveBeenCalledWith(container, {
      zipLimits: mocks.zipLimits,
      lazySlides: true,
      lazyMedia: true,
      scrollContainer: container,
      pdfjs: false
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
