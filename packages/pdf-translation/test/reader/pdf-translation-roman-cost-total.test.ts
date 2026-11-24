import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'

it.each(['aligned', 'shifted total', 'missing total rule'] as const)(
  'separates the last priced item and the total in a ruled cost table (%s)',
  async (shape) => {
    const width = 600,
      height = 800,
      size = 9
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body'
    ): {
      str: string
      width: number
      height: number
      transform: number[]
      dir: string
      fontName: string
    } => ({ str, width, height: size, transform: [size, 0, 0, size, x, y], dir: 'ltr', fontName })
    const items = [
      run('TABLE II. Estimated mounting costs.', 55, 351, 168),
      run('Component', 56, 326, 46),
      run('Approx. cost (US', 226, 326, 69),
      run('$', 295, 327, 4, 'symbol'),
      run(')', 299, 326, 3),
      ...['Mount', 'Wire', 'Frame', 'Clip', 'Bracket'].flatMap((label, i) => [
        run(label, 56, 313 - i * 13, 35),
        run('5', 263, 313 - i * 13, 4)
      ]),
      run('Sensor cradle', 56, 248, 55),
      run('8', 263, 248, 4),
      run('Total (excluding the enclosure)', 56, 235, 122),
      run('≈', shape === 'shifted total' ? 251 : 255, 235.5, 7, 'symbol'),
      run('33', shape === 'shifted total' ? 261 : 265, 235, 10)
    ]
    const fragments = items.map(({ str, transform: [, , , , x, y], width: w }, index) => ({
      pageNumber: 1,
      rect: { x: x / width, y: (height - y - 8) / height, width: w / width, height: size / height },
      items: [{ index, text: str }]
    }))
    const [item, subtotal] = [items[15], items[17]]
    const totalValue = items
      .slice(-2)
      .map(({ str }) => str)
      .join(' ')
    const merged = {
      ...fragments[17],
      rect: {
        ...fragments[17].rect,
        width: (items[19].transform[4] + items[19].width - 56) / width
      },
      items: fragments.slice(17).flatMap(({ items }) => items)
    }
    const source = createPdfTranslationSource({
      resourceRequestKey: 'cost-summary',
      fingerprint: 'cost-summary',
      pages: [{ width, height }],
      units: [
        ...items.slice(0, 15).map(({ str }, index) => ({
          id: String(index),
          source: str,
          fragments: [fragments[index]]
        })),
        {
          id: 'price',
          source: '8',
          sourceOnly: true,
          preserve: 'literal',
          fragments: [fragments[16]]
        },
        {
          id: 'joined',
          source: [item.str, subtotal.str, totalValue].join(' '),
          fragments: [fragments[15], merged]
        }
      ]
    })
    const rules = [337, 335, 317, ...(shape === 'missing total rule' ? [] : [243]), 223, 221]
    const page = {
      rotate: 0,
      getOperatorList: async () => ({
        fnArray: rules.map(() => OPS.constructPath),
        argsArray: rules.map((y) => [
          OPS.stroke,
          [Float32Array.of(0, 54, y, 1, 300, y)],
          Float32Array.of(54, y, 300, y)
        ])
      }),
      getViewport: () => ({
        width,
        height,
        transform: [1, 0, 0, -1, 0, height],
        convertToViewportPoint: (x: number, y: number) => [x, height - y]
      }),
      getTextContent: async () => ({
        items,
        styles: {
          body: { ascent: 0.8, descent: -0.2, vertical: false },
          symbol: { ascent: 0.8, descent: -0.2, vertical: false }
        }
      }),
      cleanup: () => {}
    } as unknown as PDFPageProxy
    const result = await preservePdfFigureSources({
      document: { getPage: async () => page },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(
      result.source.units.filter(({ id }) => id.startsWith('joined')).map(({ source }) => source)
    ).toEqual(
      shape === 'aligned' ? [item.str, subtotal.str, totalValue] : [source.units.at(-1)?.source]
    )
    expect(result.source.units.find(({ id }) => id === 'joined-total-value')?.sourceOnly).toBe(
      shape === 'aligned' ? true : undefined
    )
  }
)
