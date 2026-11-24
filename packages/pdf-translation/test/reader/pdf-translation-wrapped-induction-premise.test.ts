import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each([false, true])(
  'joins a wrapped induction premise only on the same native body rail (%s)',
  async (offset) => {
    const left = offset ? 2 : 0
    const runs = [
      ['Proof.', 'bold', 72, 520, 30],
      ['The identity holds when', 'body', 108, 520, 169],
      ['n', 'italic', 281, 520, 7],
      ['= 1', 'number', 295, 520, 22],
      ['.', 'body', 317, 520, 3],
      ['Assume that the identity holds true', 'body', 328, 520, 206, true],
      ['for', 'body', 72 + left, 503, 14],
      ['n', 'italic', 90 + left, 503, 7],
      ['−', 'symbol', 101 + left, 503, 9],
      ['1', 'number', 114 + left, 503, 6],
      [', that is', 'body', 120 + left, 503, 38],
      ['a', 'small-italic', 163, 509, 4, false, 8],
      ['+', 'small-body', 172, 509, 7, false, 8],
      ['...', 'small-italic', 179, 509, 7, false, 8],
      ['n', 'small-italic', 179, 499, 5, false, 8],
      ['√', 'symbol', 244, 510, 10]
    ] as const
    const items = runs.map(([str, fontName, x, y, width, hasEOL = false, height = 12]) => ({
      str,
      fontName,
      width,
      height,
      hasEOL,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y]
    }))
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] })),
      getTextContent: vi.fn().mockResolvedValue({
        items,
        styles: Object.fromEntries(
          items.map(({ fontName }) => [fontName, { ascent: 0.75, descent: -0.25, vertical: false }])
        )
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
    const premise = source.units.find((unit) => unit.source.startsWith('Proof.'))!
    expect(premise.fragments).toHaveLength(offset ? 1 : 2)
    expect(premise.source.endsWith(offset ? 'holds true' : 'for n − 1, that is')).toBe(true)
    expect(source.units.find((unit) => unit.source === '√')).toMatchObject({
      sourceOnly: true,
      preserve: 'formula'
    })
    expect(
      source.units
        .flatMap(({ fragments }) =>
          fragments.flatMap(({ items }) => items.map(({ index }) => index))
        )
        .sort((a, b) => a - b)
    ).toEqual(items.map((_, i) => i))
  }
)
