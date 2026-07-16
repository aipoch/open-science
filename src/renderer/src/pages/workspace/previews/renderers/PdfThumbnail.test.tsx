// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readPdfBytes } from '../pdf-bytes'
import { pdfjsLib } from '../pdfjs'
import { PdfThumbnail } from './PdfThumbnail'

vi.mock('../pdf-bytes', () => ({ readPdfBytes: vi.fn() }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument: vi.fn() } }))

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('PdfThumbnail', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(readPdfBytes).mockReset()
    vi.mocked(pdfjsLib.getDocument).mockReset()

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,rendered-page'
    )
    vi.mocked(pdfjsLib.getDocument).mockReturnValue({
      promise: Promise.resolve({
        getPage: vi.fn().mockResolvedValue({
          getViewport: vi.fn(({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 140 * scale
          })),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
          cleanup: vi.fn()
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      })
    } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('recovers after a pending upload path fails and the finalized path succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(readPdfBytes)
      .mockRejectedValueOnce(new Error('ENOENT: pending upload moved'))
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/.pending/report.pdf"
          name="report.pdf"
          source="upload"
          version="pending"
        />
      )
      await flushMicrotasks()
    })
    // The pending path fails with ENOENT — an expected "unavailable" case during recovery — so it
    // is handled silently (icon fallback) rather than logged as an error.
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
          version="finalized"
        />
      )
      await flushMicrotasks()
    })

    expect(readPdfBytes).toHaveBeenLastCalledWith('/uploads/session-1/report.pdf', 'upload')
    expect(container.querySelector('img[alt="Preview of report.pdf"]')).not.toBeNull()
  })

  it('invalidates a cached thumbnail when the same PDF path has a new version', async () => {
    vi.mocked(readPdfBytes).mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.mocked(HTMLCanvasElement.prototype.toDataURL)
      .mockReturnValueOnce('data:image/png;base64,old-page')
      .mockReturnValueOnce('data:image/png;base64,new-page')

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/session-1/versioned.pdf"
          name="versioned.pdf"
          source="upload"
          version="v1"
        />
      )
      await flushMicrotasks()
    })
    expect(container.querySelector('img')?.getAttribute('src')).toContain('old-page')

    await act(async () => {
      root.render(
        <PdfThumbnail
          path="/uploads/session-1/versioned.pdf"
          name="versioned.pdf"
          source="upload"
          version="v2"
        />
      )
      await flushMicrotasks()
    })

    expect(readPdfBytes).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toContain('new-page')
  })
})
