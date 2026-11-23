import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource, type PdfTranslationFragment } from '../../src/reader/source.js'

it.each(['complete', 'missing separator', 'text mismatch', 'header and data separated'] as const)(
  'retains a proved stencil table when an owner spans the header separator (%s)',
  async (variant) => {
    const items = [
      ['Table 1. Observed sources by month', 42, 68, 29],
      ['Observation', 50, 64, 6],
      ['Label', 63, 64, 3],
      ['Interval', 51, 63, 4],
      ['group', 63, 63, 3],
      ['April', 51, 61.8, 2],
      ['A3, A7', 63, 61.8, 4],
      ['2, 5', 73, 61.8, 2],
      ['May', 51, 60.35, 2],
      ['A3', 63, 60.35, 1],
      ['6', 73, 60.35, 0.5],
      ['June', 51, 58.91, 2],
      ['A7', 63, 58.91, 1],
      ['3', 73, 58.91, 0.5]
    ].map(([str, x, y, width]) => ({
      str: String(str),
      dir: 'ltr',
      fontName: 'body',
      transform: [1, 0, 0, 1, Number(x), Number(y)],
      height: 1,
      width: Number(width),
      hasEOL: false
    }))
    const fragment = (indices: number[]): PdfTranslationFragment => {
      const left = items[indices[0]].transform[4]
      const right = items[indices.at(-1)!].transform[4] + items[indices.at(-1)!].width
      return {
        pageNumber: 1,
        rect: {
          x: left / 100,
          y: (99.2 - items[indices[0]].transform[5]) / 100,
          width: (right - left) / 100,
          height: 0.01
        },
        items: indices.map((index) => ({ index, text: items[index].str }))
      }
    }
    const sets = [
      [[0]],
      [[1, 2]],
      ...(variant === 'header and data separated'
        ? [[[3, 4]], [[5, 6, 7]]]
        : [
            [
              [3, 4],
              [5, 6, 7]
            ]
          ]),
      [[8, 9, 10]],
      [[11, 12, 13]]
    ]
    const units = sets.map((rows, index) => ({
      id: String(index),
      source: rows
        .flat()
        .map((index) => items[index].str)
        .join(' '),
      fragments: rows.map(fragment)
    }))
    const source = createPdfTranslationSource({
      resourceRequestKey: 'stencil',
      fingerprint: 'stencil',
      pages: [{ width: 100, height: 100 }],
      units
    })
    if (variant === 'text mismatch') items[6].str = 'A3, A8'
    const rules = variant === 'missing separator' ? [65, 57] : [65, 62.2, 57]
    const page = {
      rotate: 0,
      getTextContent: async () => ({ items, styles: { body: { ascent: 0.8 } } }),
      getViewport: () => ({
        width: 100,
        height: 100,
        transform: [1, 0, 0, -1, 0, 100],
        convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
      }),
      getOperatorList: async () => ({
        fnArray: [
          OPS.setFillRGBColor,
          ...rules.flatMap(() => [
            OPS.save,
            OPS.transform,
            OPS.paintSolidColorImageMask,
            OPS.restore
          ])
        ],
        argsArray: [['#000000'], ...rules.flatMap((y) => [[], [30, 0, 0, -0.18, 48, y], [], []])]
      }),
      cleanup: () => {}
    } as unknown as PDFPageProxy

    const result = await preservePdfFigureSources({
      extraction: { source },
      document: { getPage: async () => page },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.map(({ fragments }) => fragments)).toEqual(
      source.units.map(({ fragments }) => fragments)
    )
    expect(result.source.units.filter(({ sourceOnly }) => sourceOnly).map(({ id }) => id)).toEqual(
      variant === 'complete' ? ['1', '2', '3', '4'] : []
    )
    expect(result.source.units[0].sourceOnly).toBeUndefined()
    expect(result.source.originalRegions?.length ?? 0).toBe(variant === 'missing separator' ? 0 : 1)
  }
)
