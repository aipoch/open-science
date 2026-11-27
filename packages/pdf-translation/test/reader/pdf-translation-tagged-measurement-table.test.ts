import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource, type PdfTranslationSource } from '../../src/reader/source.js'

it.each(['complete', 'missing-carrier'] as const)(
  'keeps tagged measurement columns independent (%s)',
  async (mode) => {
    const item = (str: string, x: number, y: number, width: number): TextItem => ({
      str,
      dir: 'ltr',
      fontName: 'Body',
      transform: [8, 0, 0, 8, x, y],
      width,
      height: 8,
      hasEOL: false
    })
    const caption = item('TABLE I. Comparison of calibrated channels', 30, 260, 210)
    const header = ['Channel', 'Device', 'Process', 'Reading', 'Ref.'].map((str, column) =>
      item(str, 30 + column * 65, 235, 25)
    )
    const rows = [
      header.map((i) => [i]),
      ...Array.from({ length: 4 }, (_, row) => {
        const y = 215 - row * 28
        return [
          [item('AB-CD', 32, y, 22)],
          [item('RT', 99, y, 12)],
          [item('MX', 164, y, 13)],
          row === 3
            ? [item('−3 dB (X)', 220, y + 5, 39), item('−4 dB (Y)', 220, y - 5, 39)]
            : [item('−2 dB', 230, y, 26)],
          row === 3
            ? [item('This', 296, y + 5, 15), item('work', 296, y - 5, 17)]
            : [item('[' + (row + 1) + ']', 296, y, 13)]
        ]
      })
    ]
    const items = [
      caption,
      ...rows.flat(2),
      item('The data show the pressure change.', 30, 90, 160)
    ]
    const tree = {
      role: 'Table',
      children: rows.map((cells, row) => ({
        role: 'TR',
        children: cells.map((cell, column) => ({
          role: row && column ? 'TD' : 'TH',
          children: [
            {
              type: 'content',
              id:
                mode === 'missing-carrier' && row === 3 && column === 2
                  ? 'missing'
                  : `cell-${items.indexOf(cell[0])}`
            }
          ]
        }))
      }))
    }
    const marked = [
      caption,
      ...rows.flatMap((cells) =>
        cells.flatMap((cell) => [
          { type: 'beginMarkedContentProps', id: `cell-${items.indexOf(cell[0])}` },
          ...cell,
          { type: 'endMarkedContent' }
        ])
      ),
      items.at(-1)!
    ]
    const unit = (id: string, native: typeof items): PdfTranslationSource['units'][number] => {
      const [first] = native
      return {
        id,
        source: native.map(({ str }) => str).join(' '),
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: first.transform[4] / 360,
              y: (293.6 - first.transform[5]) / 300,
              width:
                (native.at(-1)!.transform[4] + native.at(-1)!.width - first.transform[4]) / 360,
              height: 9.6 / 300
            },
            items: native.map((carrier) => ({ index: items.indexOf(carrier), text: carrier.str }))
          }
        ]
      }
    }
    const units = [
      unit('caption', [caption]),
      unit('header', header),
      ...rows
        .slice(1)
        .flat(2)
        .map((i) => unit('data-' + items.indexOf(i), [i])),
      unit('body', [items.at(-1)!])
    ]
    const page = {
      rotate: 0,
      getStructTree: async () => tree,
      getTextContent: async ({ includeMarkedContent = false } = {}) => ({
        items: includeMarkedContent ? marked : items,
        styles: { Body: { ascent: 0.8, descent: -0.2, vertical: false } }
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({
        width: 360,
        height: 300,
        transform: [1, 0, 0, -1, 0, 300],
        convertToViewportPoint: (x: number, y: number) => [x, 300 - y]
      }),
      cleanup: () => {}
    }
    const source = createPdfTranslationSource({
      fingerprint: 'tagged-table',
      resourceRequestKey: 'tagged-table',
      pages: [{ width: 360, height: 300 }],
      units
    })
    const result = await preservePdfFigureSources({
      extraction: { source },
      document: { getPage: async () => page } as unknown as PDFDocumentProxy,
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    if (mode !== 'complete') {
      expect(result.source.units).toEqual(source.units)
      return
    }
    const headers = result.source.units.filter(({ id }) => id.startsWith('header'))
    expect(headers.map(({ source: text }) => text)).toEqual(header.map(({ str }) => str))
    expect(headers.map(({ fragments: [f] }) => f.rect.x)).toEqual(
      header.map((item) => item.transform[4] / 360)
    )
    expect(headers.filter(({ sourceOnly }) => sourceOnly).map(({ source }) => source)).toEqual([
      'Ref.'
    ])
    const data = result.source.units.filter(({ id }) => id.startsWith('data-'))
    expect(data.every(({ sourceOnly }) => sourceOnly)).toBe(true)
    expect(data.map(({ fragments }) => fragments)).toEqual(
      units.slice(2, -1).map((u) => u.fragments)
    )
    expect(result.source.units[0]).toEqual(source.units[0])
    expect(result.source.units.at(-1)).toEqual(source.units.at(-1))
  }
)
