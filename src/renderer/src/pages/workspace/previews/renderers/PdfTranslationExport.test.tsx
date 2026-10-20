// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfTranslationExport } from './PdfTranslationExport'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('saves the verified PDF with a distinct name and preserves cancellation and retry', async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce({ saved: false })
    .mockRejectedValueOnce(new Error('disk'))
    .mockResolvedValue({ saved: true })
  Object.assign(window, { api: { saveBlobFile: save } })
  const bytes = new Uint8Array([37, 80, 68, 70])
  const document = { getData: vi.fn(async () => bytes) } as unknown as PDFDocumentProxy
  render(<PdfTranslationExport document={document} name="paper.PDF" hasRetainedOriginalText />)
  const retained = 'Some passages retain the original text. View their translations in the sidebar.'
  expect(screen.getByText(retained)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'About the translated PDF' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Export translated PDF' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByText('Saving translated PDF…')).toBeNull())
  expect(save.mock.calls[0][0]).toMatchObject({
    suggestedName: 'paper-translated.pdf',
    mimeType: 'application/pdf'
  })
  expect(new Uint8Array(save.mock.calls[0][0].data)).toEqual(bytes)
  expect(screen.queryByText('Translated PDF saved.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Export translated PDF' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Export translated PDF' }))
  await waitFor(() => expect(screen.getByText('Translated PDF saved.')).toBeTruthy())
})

it('keeps sidebar export registration visually silent until a save result', () => {
  const document = { getData: vi.fn() } as unknown as PDFDocumentProxy
  const { container } = render(
    <PdfTranslationExport
      document={document}
      name="paper.pdf"
      hasRetainedOriginalText
      showExportButton={false}
    />
  )
  expect(container.childElementCount).toBe(0)
  expect(
    screen.queryByText(
      'Some passages retain the original text. View their translations in the sidebar.'
    )
  ).toBeNull()
  expect(screen.queryByRole('button', { name: 'Export translated PDF' })).toBeNull()
})

it('deduplicates exports and rejects a late read after the document closes', async () => {
  const save = vi.fn()
  Object.assign(window, { api: { saveBlobFile: save } })
  let resolve!: (bytes: Uint8Array) => void
  const getData = vi.fn(
    () =>
      new Promise<Uint8Array>((r) => {
        resolve = r
      })
  )
  const { unmount } = render(
    <PdfTranslationExport document={{ getData } as unknown as PDFDocumentProxy} name="paper.pdf" />
  )
  const button = screen.getByRole('button', { name: 'Export translated PDF' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(getData).toHaveBeenCalledTimes(1)
  unmount()
  await act(async () => resolve(new Uint8Array([1])))
  expect(save).not.toHaveBeenCalled()
})
