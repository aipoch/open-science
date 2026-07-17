// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('renders DOCX with active-content features disabled and cleans up Blob URLs', async () => {
    mocks.renderDocx.mockImplementation(async (_bytes, target: HTMLElement) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'docx-wrapper'
      const image = document.createElement('img')
      image.src = 'blob:word-image'
      wrapper.appendChild(image)
      target.appendChild(wrapper)
    })
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
    expect(container.querySelector<HTMLElement>('.docx-wrapper')?.style.alignItems).toBe(
      'flex-start'
    )

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
            spreadsheet: {
              worker: true,
              workerUrl: 'local-sheet-worker.js'
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
