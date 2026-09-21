// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { usePdfExport } from './use-pdf-export'
import { usePdfExportAction } from './pdf-export-context'
import { PdfExportProvider } from './PdfExportProvider'
import { PdfAnnotationsContext, type PdfAnnotationPort } from './pdf-annotations-context'
import { runPdfExportWorker } from './pdf-export-client'
import { preparePdfExportMarks } from './pdf-export-prepare'
import type { PdfAnnotation, PdfAnnotationSource } from '../../../../../shared/pdf-annotations'

vi.mock('./pdf-export-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdf-export-client')>()),
  runPdfExportWorker: vi.fn().mockResolvedValue(new ArrayBuffer(10))
}))
vi.mock('./pdf-export-prepare', () => ({ preparePdfExportMarks: vi.fn().mockResolvedValue([]) }))
const source: PdfAnnotationSource = {
  kind: 'literature-attachment-version',
  sourceFileId: 'f',
  versionId: 'v',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: '/paper.pdf'
}
const item = {
  id: 'a',
  target: { source, selector: { kind: 'document-note' } },
  kind: 'document-note',
  tagIds: ['tag'],
  note: 'Saved note'
} as PdfAnnotation
const port = {
  forSource: () => [item],
  history: () => ({ busy: false }),
  loading: false
} as unknown as PdfAnnotationPort
let action: ReturnType<typeof usePdfExportAction>
let state: ReturnType<typeof usePdfExport>
const document = {
  getData: vi.fn().mockResolvedValue(new Uint8Array(4))
} as unknown as PDFDocumentProxy
const Probe = ({ path }: { path: string }): null => {
  const value = usePdfExport({ document, source, path, name: 'paper.pdf', size: 4 })
  useEffect(() => {
    state = value
  }, [value])
  return null
}
const Observe = (): null => {
  const value = usePdfExportAction()
  useEffect(() => {
    action = value
  }, [value])
  return null
}
const container = globalThis.document.createElement('div')
let root: ReturnType<typeof createRoot>
const mount = async (annotationPort = port): Promise<void> => {
  root = createRoot(container)
  window.api = {
    tags: { snapshot: vi.fn().mockResolvedValue({ tags: [{ id: 'tag', name: 'Reading' }] }) },
    pdfAnnotations: {
      list: vi.fn().mockResolvedValue({
        items: annotationPort.forSource(source),
        total: annotationPort.forSource(source).length
      })
    },
    saveBlobFile: vi.fn().mockResolvedValue({ saved: true })
  } as unknown as Window['api']
  await act(async () =>
    root.render(
      <PdfExportProvider>
        <PdfAnnotationsContext.Provider value={annotationPort}>
          <Probe path="/paper.pdf" />
          <Observe />
        </PdfAnnotationsContext.Provider>
      </PdfExportProvider>
    )
  )
}
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
})
it('exports the saved full snapshot with comments/tags and saves an independent PDF', async () => {
  await mount()
  await act(async () => action!.execute())
  expect(preparePdfExportMarks).toHaveBeenCalledWith(
    document,
    [item],
    expect.any(AbortSignal),
    expect.any(Function)
  )
  const describe = vi.mocked(preparePdfExportMarks).mock.calls[0][3]
  expect(describe(item)).toBe('Document note\n\nSaved note\n\nTags: Reading')
  expect(runPdfExportWorker).toHaveBeenCalledWith(
    expect.objectContaining({ checksum: source.checksum }),
    expect.any(AbortSignal)
  )
  expect(window.api.saveBlobFile).toHaveBeenCalledWith({
    data: expect.any(ArrayBuffer),
    mimeType: 'application/pdf',
    suggestedName: 'paper-annotated.pdf'
  })
  expect(state.message).toBe('Annotated PDF saved.')
})
it('never exports an incomplete or failed annotation snapshot', async () => {
  await mount({ ...port, loadError: 'failed' })
  expect(action!.disabled).toBe(true)
  await act(async () => action!.execute())
  expect(runPdfExportWorker).not.toHaveBeenCalled()
})
it('cancels before a delayed read completes and never saves a stale result', async () => {
  let release!: (bytes: Uint8Array) => void
  vi.mocked(document.getData).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = action!.execute()
    await Promise.resolve()
  })
  await act(async () => action!.cancel())
  await act(async () => {
    release(new Uint8Array(4))
    await pending
  })
  expect(runPdfExportWorker).not.toHaveBeenCalled()
  expect(window.api.saveBlobFile).not.toHaveBeenCalled()
  expect(state.busy).toBe(false)
})
it('unmount aborts the worker and prevents a late save', async () => {
  let finish!: (value: ArrayBuffer) => void
  vi.mocked(runPdfExportWorker).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = action!.execute()
    await Promise.resolve()
  })
  const signal = vi.mocked(runPdfExportWorker).mock.calls[0][1]
  await act(async () => root.unmount())
  expect(signal.aborted).toBe(true)
  await act(async () => {
    finish(new ArrayBuffer(5))
    await pending
  })
  expect(window.api.saveBlobFile).not.toHaveBeenCalled()
})
