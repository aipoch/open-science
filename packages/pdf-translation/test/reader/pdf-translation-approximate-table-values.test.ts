import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource, type PdfTranslationSource } from '../../src/reader/source.js'

it.each([0, 1])('keeps a ruled table value on its verified column rail (%s)', async (shift) => {
  const items = [
    {
      str: 'Table 1. Calibration measurements for the controlled trials.',
      x: 10,
      y: 94,
      width: 70
    },
    { str: 'Quantity', x: 12, y: 87.8, width: 13 },
    { str: 'Value', x: 56, y: 87.8, width: 8 },
    ...[81.5, 77.8, 74.1, 70.4, 66.7].flatMap((y, n) => [
      { str: 'Sample ' + (n + 1), x: 12, y, width: 12 },
      { str: String(n + 1), x: 56, y, width: 2 }
    ]),
    { str: 'Stable response (ms)', x: 12, y: 63, width: 26 },
    { str: '≃', x: 56 + shift, y: 63, width: 2 },
    { str: '22–28', x: 59 + shift, y: 63, width: 8 }
  ].map(({ str, x, y, width }) => ({
    str,
    dir: 'ltr',
    fontName: 'Body',
    transform: [3, 0, 0, 3, x, y],
    width,
    height: 3,
    hasEOL: false
  }))
  const unit = (
    id: string,
    indices: number[],
    keep = false
  ): PdfTranslationSource['units'][number] => {
    const mapped = indices.map((index) => ({ index, text: items[index].str }))
    const members = indices.map((index) => items[index])
    const x = members[0].transform[4]
    const y = members[0].transform[5]
    const end = members.at(-1)!
    return {
      id,
      source: mapped.map(({ text }) => text).join(' '),
      ...(keep ? { sourceOnly: true as const } : {}),
      fragments: [
        {
          pageNumber: 1,
          rect: {
            x: x / 100,
            y: (97.6 - y) / 100,
            width: (end.transform[4] + end.width - x) / 100,
            height: 0.03
          },
          items: mapped
        }
      ]
    }
  }
  const units = [
    ...items
      .slice(0, 13)
      .map((_, index) => unit('native-' + index, [index], index > 3 && index % 2 === 0)),
    unit('row', [13, 14, 15])
  ]
  const page = {
    rotate: 0,
    getTextContent: async () => ({ items, styles: { Body: { ascent: 0.8 } } }),
    getViewport: () => ({
      width: 100,
      height: 100,
      transform: [1, 0, 0, -1, 0, 100],
      convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
    }),
    getOperatorList: async () => ({
      fnArray: [OPS.constructPath, OPS.constructPath, OPS.constructPath],
      argsArray: [90.2, 84.5, 60].map((y) => [OPS.stroke, [], [10, y, 90, y]])
    }),
    cleanup: () => {}
  }
  const result = await preservePdfFigureSources({
    extraction: {
      source: createPdfTranslationSource({
        resourceRequestKey: 'measured-values',
        fingerprint: 'measured-values',
        pages: [{ width: 100, height: 100 }],
        units
      })
    },
    document: { getPage: async () => page } as unknown as PDFDocumentProxy,
    operators: OPS,
    signal: new AbortController().signal,
    skipTranslation: false
  })
  const owners = result.source.units.filter((u) => u.id.startsWith('row'))
  expect(owners.map((u) => u.source)).toEqual(
    shift ? ['Stable response (ms) ≃ 22–28'] : ['Stable response (ms)', '≃ 22–28']
  )
  if (!shift) {
    expect(owners[1]).toMatchObject({ sourceOnly: true, preserve: 'literal' })
    expect(owners.map((u) => u.fragments[0].rect.x)).toEqual([0.12, 0.56])
  }
  expect(owners.flatMap((u) => u.fragments[0].items.map((item) => item.index))).toEqual([
    13, 14, 15
  ])
})
