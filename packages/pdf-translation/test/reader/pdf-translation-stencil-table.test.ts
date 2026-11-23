import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'

it.each(['aligned', 'color', 'missing rule', 'row mismatch'] as const)(
  'uses only proven stencil table rules and native data for retention (%s)',
  async (variant) => {
    const items = [
      ['Date', 20, 86, 8],
      ['2021 Mar 8', 20, 75, 18],
      ['Scope N', 42, 75, 11],
      ['IR42', 60, 75, 8],
      ['F213Q', 74, 75, 8],
      ['Notes', 20, 72, 10],
      ['Table 1. Filter observations of a calibration field.', 20, 64, 65]
    ].map(([str, x, y, width]) => ({
      str: String(str),
      dir: 'ltr',
      fontName: 'body',
      transform: [3, 0, 0, 3, Number(x), Number(y)],
      height: 3,
      width: Number(width),
      hasEOL: false
    }))
    const units = [
      { id: 'header', indices: [0], y: 0.108, width: 0.08 },
      { id: 'data', indices: [1, 2, 3, 4], y: 0.218, width: 0.62 },
      { id: 'detail', indices: [5], y: 0.248, width: 0.1 },
      { id: 'caption', indices: [6], y: 0.328, width: 0.65 }
    ].map(({ id, indices, y, width }) => ({
      id,
      source: indices.map((index) => items[index].str).join(' '),
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.2, y, width, height: 0.03 },
          items: indices.map((index) => ({ index, text: items[index].str }))
        }
      ]
    }))
    const source = createPdfTranslationSource({
      resourceRequestKey: 'stencil',
      fingerprint: 'stencil',
      pages: [{ width: 100, height: 100 }],
      units
    })
    if (variant === 'row mismatch') items[3].str = 'changed'
    const rules = variant === 'missing rule' ? [90, 69] : [90, 84.5, 69]
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
        argsArray: [
          [variant === 'color' ? '#ff0000' : '#000000'],
          ...rules.flatMap((y) => [[], [80, 0, 0, -0.6, 10, y], [], []])
        ]
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
      variant === 'aligned' ? ['data'] : []
    )
    expect(result.source.originalRegions?.length ?? 0).toBe(
      variant === 'aligned' || variant === 'row mismatch' ? 1 : 0
    )
  }
)

it.each(['stacked', 'no bar', 'shifted bar', 'linear text'] as const)(
  'keeps the native tiers of a compact fraction when the stencil proves their grouping (%s)',
  async (variant) => {
    const items = [
      { str: '3', x: 20, y: 72, width: 4, fontName: 'digits' },
      { str: 'm', x: 24, y: 72, width: 4, fontName: 'italic' },
      {
        str: '8',
        x: variant === 'linear text' ? 28 : 22,
        y: variant === 'linear text' ? 72 : 65.4,
        width: 4,
        fontName: 'digits'
      }
    ].map(({ str, x, y, width, fontName }) => ({
      str,
      dir: 'ltr',
      transform: [6, 0, 0, 6, x, y],
      width,
      height: 6,
      fontName
    }))
    const source = createPdfTranslationSource({
      resourceRequestKey: 'fraction-stencil',
      fingerprint: 'fraction-stencil',
      pages: [{ width: 100, height: 100 }],
      units: [
        {
          id: 'fraction',
          source: '38m',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.2, y: 0.24, width: 0.14, height: 0.13 },
              items: items.map(({ str }, index) => ({ index, text: str }))
            }
          ]
        }
      ]
    })
    const result = await preservePdfFigureSources({
      extraction: { source },
      document: {
        getPage: async () =>
          ({
            rotate: 0,
            getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
            getTextContent: async () => ({ items }),
            getOperatorList: async () =>
              variant === 'no bar'
                ? { fnArray: [], argsArray: [] }
                : {
                    fnArray: [
                      OPS.setFillRGBColor,
                      OPS.save,
                      OPS.transform,
                      OPS.paintSolidColorImageMask,
                      OPS.restore
                    ],
                    argsArray: [
                      ['#243044'],
                      [],
                      [8, 0, 0, -0.48, variant === 'shifted bar' ? 23 : 20, 71],
                      [],
                      []
                    ]
                  },
            cleanup: () => {}
          }) as unknown as PDFPageProxy
      },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    const [unit] = result.source.units
    expect(unit.fragments).toEqual(source.units[0].fragments)
    expect(unit.figure).toBeUndefined()
    expect(unit.preserve).toBe(variant === 'stacked' ? 'formula' : undefined)
    expect(unit.sourceOnly).toBe(variant === 'stacked' ? true : undefined)
  }
)
