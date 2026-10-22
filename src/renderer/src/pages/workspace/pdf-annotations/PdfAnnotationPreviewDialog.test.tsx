// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfAnnotationPreviewDialog } from './PdfAnnotationPreviewDialog'
import { requestPdfAnnotationReveal } from '../annotations/annotation-reveal'
import { FilePreviewDialog } from '../FilePreviewDialog'
import { PdfAnnotationsProvider } from './PdfAnnotationsProvider'

vi.mock('../annotations/annotation-reveal', () => ({ requestPdfAnnotationReveal: vi.fn() }))
vi.mock('../FilePreviewDialog', () => ({ FilePreviewDialog: vi.fn(() => null) }))
vi.mock('./PdfAnnotationsProvider', () => ({
  PdfAnnotationsProvider: vi.fn(({ children }: { children: ReactNode }) => children)
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const annotation: ComponentProps<typeof PdfAnnotationPreviewDialog>['annotation'] = {
  id: 'saved-note',
  version: 1,
  origin: 'user',
  kind: 'page-note',
  note: 'Review',
  tagIds: [],
  projectId: 'project-1',
  sessionId: 'session-1',
  createdAt: '2026-09-21T00:00:00Z',
  updatedAt: '2026-09-21T00:00:00Z',
  target: {
    source: {
      kind: 'upload-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'file-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      path: 'upload-version:project-1/session-1/version-1',
      name: 'paper.pdf'
    },
    selector: { kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }
  }
}
const item: ComponentProps<typeof PdfAnnotationPreviewDialog>['item'] = {
  id: 'preview',
  type: 'file',
  sessionId: 'session-1',
  title: 'paper.pdf',
  path: annotation.target.source.path,
  format: 'pdf',
  name: 'paper.pdf'
}
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
it.each(['resolve', 'reject'] as const)(
  'cancels pending reveal and suppresses late %s after close',
  async (settlement) => {
    let resolve!: (value: 'revealed') => void
    let reject!: (error: Error) => void
    vi.mocked(requestPdfAnnotationReveal).mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    )
    const onError = vi.fn(),
      onClose = vi.fn()
    await act(async () =>
      root.render(
        <PdfAnnotationPreviewDialog
          annotation={annotation}
          item={item}
          onError={onError}
          onClose={onClose}
        />
      )
    )
    const options = vi.mocked(requestPdfAnnotationReveal).mock.calls[0][1]!
    expect(options.activatePreview).toBe(false)
    expect(options.signal?.aborted).toBe(false)
    expect(vi.mocked(FilePreviewDialog).mock.calls[0][0]).toMatchObject({
      item,
      onClose,
      allowReadingContext: false
    })
    expect(vi.mocked(PdfAnnotationsProvider).mock.calls[0][0]).toMatchObject({
      projectId: 'project-1',
      sourceFileId: 'file-1',
      versionId: 'version-1'
    })
    await act(async () => root.render(null))
    expect(options.signal?.aborted).toBe(true)
    await act(async () => {
      if (settlement === 'resolve') resolve('revealed')
      else reject(new Error('late failure'))
    })
    expect(onError).not.toHaveBeenCalled()
  }
)
it.each(['revealed', 'locator-unsupported', 'reject'] as const)(
  'reports active reveal outcome %s',
  async (outcome) => {
    if (outcome === 'reject')
      vi.mocked(requestPdfAnnotationReveal).mockRejectedValue(new Error('unavailable'))
    else vi.mocked(requestPdfAnnotationReveal).mockResolvedValue(outcome)
    const onError = vi.fn()
    await act(async () =>
      root.render(
        <PdfAnnotationPreviewDialog
          annotation={annotation}
          item={item}
          onError={onError}
          onClose={() => {}}
        />
      )
    )
    if (outcome === 'revealed') expect(onError).not.toHaveBeenCalled()
    else
      expect(onError).toHaveBeenCalledWith(
        outcome === 'reject'
          ? 'PDF annotations are unavailable for this source.'
          : 'The exact annotation location could not be found.'
      )
  }
)
