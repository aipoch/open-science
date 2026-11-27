import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each([false, true])(
  'joins an inline definition after a displayed equation only if its closing prose shares the native row (%s)',
  async (detached) => {
    const runs = [
      ['The measurement supplies the following relationship:', 'prose', 51, 319, 261, false],
      ['R', 'italic', 272, 297, 6, false],
      ['=', 'prose', 282, 297, 8, false],
      ['η', 'italic', 302, 304, 4, true],
      ['P', 'italic', 294, 290, 7, false],
      ['(', 'prose', 301, 290, 4, false],
      ['β', 'italic', 305, 290, 4, false],
      [')', 'prose', 310, 290, 4, false],
      ['· ', 'symbol', 318, 297, 5, false],
      ['√', 'symbol', 323, 306, 8, false],
      ['N', 'italic', 331, 297, 8, false],
      ['(2)', 'prose', 550, 297, 12, true],
      ['where', 'prose', 51, 276, 25, false],
      ['P', 'italic', 80, 276, 7, false],
      ['(', 'prose', 88, 276, 4, false],
      ['β', 'italic', 92, 276, 4, false],
      [
        ') represents the measurement near the selected calibration time.',
        'prose',
        97,
        detached ? 265 : 276,
        300,
        true
      ]
    ] as const
    const items = runs.map(([str, fontName, x, y, width, hasEOL]) => ({
      str,
      fontName,
      width,
      hasEOL,
      dir: 'ltr',
      height: 10,
      transform: [10, 0, 0, 10, x, y]
    }))
    const metrics = { ascent: 0.69, descent: -0.194, vertical: false }
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] })),
      getTextContent: vi.fn().mockResolvedValue({
        items,
        styles: { prose: metrics, italic: metrics, symbol: metrics }
      }),
      cleanup: vi.fn()
    }
    const { source } = await extractPdfTranslationSource({
      document: {
        numPages: 1,
        fingerprints: ['synthetic'],
        getPage: vi.fn().mockResolvedValue(page)
      } as unknown as PDFDocumentProxy,
      resourceRequestKey: 'synthetic',
      signal: new AbortController().signal
    })
    const definition = source.units.find((unit) => unit.source.startsWith('where'))!
    expect(definition.source).toBe(
      detached
        ? 'where P(β'
        : 'where P(β) represents the measurement near the selected calibration time.'
    )
    expect(source.units.find((unit) => unit.source === '(2)')).toMatchObject({
      sourceOnly: true,
      preserve: 'formula'
    })
    expect(
      source.units
        .flatMap(({ fragments }) =>
          fragments.flatMap(({ items }) => items.map(({ index }) => index))
        )
        .sort((a, b) => a - b)
    ).toEqual(items.map((_, index) => index))
  }
)
