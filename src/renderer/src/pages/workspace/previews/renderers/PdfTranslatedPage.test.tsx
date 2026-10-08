// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfTranslatedPage } from './PdfTranslatedPage'
import { renderPdfTranslationInline } from './pdf-translation-inline'
import type { PdfTranslation } from './pdf-translation'
vi.mock('../useNearViewport', () => ({ useNearViewport: () => [() => undefined, true] }))
vi.mock('./pdf-translation-inline', () => ({ renderPdfTranslationInline: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const translation: PdfTranslation = {
  resourceRequestKey: 'r',
  fingerprint: 'f',
  pages: [{ width: 600, height: 800 }],
  units: []
}
const documentProxy = {
  getPage: vi.fn(async () => ({})),
  destroy: vi.fn()
} as unknown as PDFDocumentProxy
it('keeps the fallback and aborts pending rendering before owner disposal; late results never appear', async () => {
  let dispose!: () => void, finish!: (result: undefined) => void
  const unregister = vi.fn(),
    registerDisposer = vi.fn((fn) => {
      dispose = fn
      return unregister
    })
  vi.mocked(renderPdfTranslationInline).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(
    <PdfTranslatedPage
      document={documentProxy}
      pageNumber={1}
      translation={translation}
      fallback={<p>Original</p>}
      registerDisposer={registerDisposer}
    />
  )
  await waitFor(() => expect(renderPdfTranslationInline).toHaveBeenCalled())
  const signal = vi.mocked(renderPdfTranslationInline).mock.calls.at(-1)![3]
  expect(view.getByText('Original')).toBeTruthy()
  dispose()
  expect(signal.aborted).toBe(true)
  await act(async () => finish(undefined))
  expect(view.container.querySelector('[data-pdf-inline-ready="true"]')).toBeNull()
  view.unmount()
  expect(unregister).toHaveBeenCalledOnce()
  expect(documentProxy.destroy).not.toHaveBeenCalled()
})
it('publishes selectable translated text only for the current source and frees intermediate canvas', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  const intermediate = document.createElement('canvas')
  intermediate.width = 1200
  intermediate.height = 1600
  vi.mocked(renderPdfTranslationInline)
    .mockResolvedValueOnce({
      canvas: intermediate,
      layouts: [
        {
          id: 'u',
          text: '完整译文',
          size: 10,
          rect: { x: 10, y: 10, width: 100, height: 20 },
          lines: [{ text: '完整译文', x: 10, y: 20 }]
        }
      ]
    })
    .mockResolvedValue(undefined)
  const registerDisposer = vi.fn(() => vi.fn())
  const view = render(
    <PdfTranslatedPage
      document={documentProxy}
      pageNumber={1}
      translation={translation}
      fallback={<p>Original</p>}
      registerDisposer={registerDisposer}
    />
  )
  await waitFor(() => expect(view.getByText('完整译文')).toBeTruthy())
  expect(view.queryByText('Original')).toBeNull()
  // The page-sized text layer must not shadow fragment-specific navigation anchors.
  expect(view.container.querySelector('[data-translation-source]')).toBeNull()
  const range = document.createRange()
  range.selectNodeContents(view.getByText('完整译文'))
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  expect(document.getSelection()?.toString()).toBe('完整译文')
  expect(intermediate.width).toBe(0)
  view.rerender(
    <PdfTranslatedPage
      document={documentProxy}
      pageNumber={1}
      translation={{ ...translation }}
      fallback={<p>Original</p>}
      registerDisposer={registerDisposer}
    />
  )
  expect(view.queryByText('完整译文')).toBeNull()
  expect(view.getByText('Original')).toBeTruthy()
})
