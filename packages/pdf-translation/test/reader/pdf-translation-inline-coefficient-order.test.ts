import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from './src/reader/extraction.js'
const runs = [
  ['Observe that the', 'prose', 11.96, 70.97, 128.41, 615.39, false],
  [' ', 'prose', 0, 4.44, 199.38, 615.39, false],
  ['r', 'italic', 11.96, 5.28, 203.82, 615.39, false],
  [' ', 'italic', 0, 4.57, 209.09, 615.39, false],
  ['= 1', 'math', 11.96, 19.19, 213.66, 615.39, false],
  [' ', 'math', 0, 4.44, 232.85, 615.39, false],
  ['term is exactly', 'prose', 11.96, 77.22, 237.28, 615.39, false],
  [' ', 'prose', 0, 4.44, 314.5, 615.39, false],
  ['\u0000', 'delimiter', 11.96, 5.48, 318.94, 625.08, false],
  ['n', 'small-italic', 7.97, 5.14, 324.42, 620.7, true],
  ['k', 'small-italic', 7.97, 4.41, 324.68, 611.27, false],
  ['', 'delimiter', 0, 0, 329.56, 625.08, true],
  ['\u0001', 'delimiter', 11.96, 5.48, 329.56, 625.08, false],
  ['/n', 'italic', 11.96, 12.84, 335.03, 615.39, false],
  [', while the other terms have', 'prose', 11.96, 151.53, 347.88, 615.39, true],
  ['a trivial upper bound', 'prose', 11.96, 112.28, 110.85, 598.93, false],
  [' ', 'prose', 0, 4.59, 223.13, 598.93, false],
  ['k', 'italic', 11.96, 6.09, 227.72, 598.93, false],
  ['\u0000', 'delimiter', 11.96, 5.48, 234.22, 608.61, false],
  ['n/', 'small-italic', 7.97, 9.37, 239.7, 604.23, false],
  ['2', 'small-numeral', 7.97, 4.23, 249.07, 604.23, false],
  ['', 'small-italic', 0, 0, 239.96, 594.81, true],
  ['k/', 'small-italic', 7.97, 8.86, 239.96, 594.81, false],
  ['2', 'small-numeral', 7.97, 4.23, 248.81, 594.81, false],
  ['', 'delimiter', 0, 0, 253.3, 608.61, true],
  ['\u0001', 'delimiter', 11.96, 5.48, 253.3, 608.61, false],
  [' ', 'delimiter', 0, 4.59, 258.78, 608.61, false],
  ['(here one may assume that both', 'prose', 11.96, 169.71, 263.38, 598.93, false],
  [' ', 'prose', 0, 4.59, 433.09, 598.93, false],
  ['n', 'italic', 11.96, 6.99, 437.68, 598.93, false],
  [' ', 'italic', 0, 4.59, 444.67, 598.93, false],
  ['and', 'prose', 11.96, 18.85, 449.26, 598.93, false],
  [' ', 'prose', 0, 4.6, 468.11, 598.93, false],
  ['k', 'italic', 11.96, 6.09, 472.72, 598.93, false],
  [' ', 'italic', 0, 4.99, 478.8, 598.93, false],
  ['are', 'prose', 11.96, 15.61, 483.79, 598.93, true],
  ['even.) One only needs to prove that', 'prose', 11.96, 180.75, 110.85, 582.85, false]
] as const

it.each([false, true])(
  'keeps native clause order only with matching coefficient delimiters (%s)',
  async (mismatch) => {
    const items = runs.map(([str, font, height, width, x, y, hasEOL], index) => ({
      str,
      fontName: mismatch && index === 25 ? 'unrelated-delimiter' : font,
      height,
      width,
      transform: [height || 11.96, 0, 0, height || 11.96, x, y],
      dir: 'ltr',
      hasEOL
    }))
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({
        width: 612,
        height: 792,
        transform: [1, 0, 0, -1, 0, 792]
      })),
      getTextContent: vi.fn().mockResolvedValue({
        items,
        styles: Object.fromEntries(
          [...new Set(items.map(({ fontName }) => fontName))].map((font) => [
            font,
            {
              ascent: font.endsWith('delimiter') ? 0.04 : 0.69,
              descent: font.endsWith('delimiter') ? -0.6 : -0.194,
              vertical: false
            }
          ])
        )
      }),
      cleanup: vi.fn()
    }
    const document = {
      numPages: 1,
      fingerprints: ['synthetic'],
      getPage: vi.fn().mockResolvedValue(page)
    }
    const { source } = await extractPdfTranslationSource({
      document: document as unknown as PDFDocumentProxy,
      resourceRequestKey: 'synthetic',
      signal: new AbortController().signal
    })
    const prose = source.units.filter((unit) => !unit.sourceOnly).map((unit) => unit.source)
    const repaired = [
      'Observe that the r = 1 term is exactly',
      ', while the other terms have a trivial upper bound',
      '(here one may assume that both n and k are even.) One only needs to prove that'
    ]
    if (mismatch) {
      expect(prose).not.toEqual(expect.arrayContaining(repaired))
    } else {
      expect(prose.filter((text) => repaired.includes(text))).toEqual(repaired)
    }
    expect(
      source.units
        .flatMap(({ fragments }) => fragments.flatMap(({ items }) => items))
        .map(({ index }) => index)
        .sort((a, b) => a - b)
    ).toEqual(items.flatMap(({ str }, index) => (str.trim() ? [index] : [])))
  }
)
