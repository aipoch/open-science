import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import {
  createPdfTranslationSource,
  type PdfTranslationFragment,
  type PdfTranslationSource
} from '../../src/reader/source.js'

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

it.each([
  'closed evidence',
  'missing rule',
  'shifted peer',
  'inexact source',
  'third-row tail'
] as const)('separates prose at a witnessed table row start (%s)', async (evidence) => {
  const items = [
    ['TABLE II. Local sample descriptions.', 50, 570, 190, 'body'],
    ['Sample', 50, 539, 35, 'bold'],
    ['Setup', 125, 539, 25, 'bold'],
    ['Observation', 235, 539, 60, 'bold'],
    ['Comment', 345, 539, 40, 'bold'],
    ['R1 Alpha', 50, 518, 45, 'bold'],
    ['First trial', 125, 518, 42, 'body'],
    ['The surface', 235, 518, 51, 'body'],
    ['Appeared uniform', 345, 518, 78, 'body'],
    ['remained clear.', 235, 506, 63, 'body'],
    ['R2 Beta', 50, 472, 40, 'bold'],
    ['Second trial', 125, 472, 53, 'body'],
    ['The surface darkened', 235, 472, 96, 'body'],
    ['Became opaque', 345, evidence === 'shifted peer' ? 464 : 472, 68, 'body'],
    ['near the edge.', 235, 460, 62, 'body'],
    ['R3 Gamma', 50, 426, 53, 'bold'],
    ['Third trial', 125, 426, 46, 'body'],
    ['The surface cracked.', 235, 426, 91, 'body'],
    ['Sample failed', 345, 426, 57, 'body'],
    ['The discussion begins after the bottom rule.', 55, 350, 200, 'body'],
    ['below the coating.', 235, 414, 71, 'body']
  ].map(([str, x, y, width, fontName]) => ({
    str: String(str),
    dir: 'ltr',
    transform: [10, 0, 0, 10, Number(x), Number(y)],
    width: Number(width),
    height: 10,
    fontName: String(fontName),
    hasEOL: true
  }))
  const unit = (id: string, indices: number[]): PdfTranslationSource['units'][number] => ({
    id,
    source: indices.map((index) => items[index].str).join(' '),
    fragments: indices.map((index) => {
      const item = items[index]
      return {
        pageNumber: 1,
        rect: {
          x: item.transform[4] / 500,
          y: (600 - item.transform[5] - 8) / 600,
          width: item.width / 500,
          height: 10 / 600
        },
        items: [{ index, text: item.str }]
      }
    })
  })
  const joinedIndices = evidence === 'third-row tail' ? [7, 9, 12, 14, 20] : [7, 9, 12, 14]
  const native = unit('joined', joinedIndices)
  const joined =
    evidence === 'inexact source'
      ? { ...native, source: native.source.replace('clear', 'bright') }
      : native
  const units = [
    joined,
    ...items.flatMap((_, index) =>
      joinedIndices.includes(index) ? [] : [unit('peer-' + index, [index])]
    )
  ]
  const source = createPdfTranslationSource({
    resourceRequestKey: 'ruled',
    fingerprint: 'ruled',
    pages: [{ width: 500, height: 600 }],
    units
  })
  const rules = evidence === 'missing rule' ? [548, 375] : [548, 532, 375]
  const page = {
    rotate: 0,
    getViewport: () => ({
      width: 500,
      height: 600,
      transform: [1, 0, 0, -1, 0, 600],
      convertToViewportPoint: (x: number, y: number) => [x, 600 - y]
    }),
    getTextContent: async () => ({
      items,
      styles: { bold: { ascent: 0.8 }, body: { ascent: 0.8 } }
    }),
    getOperatorList: async () => ({
      fnArray: rules.flatMap(() => [OPS.save, OPS.transform, OPS.constructPath, OPS.restore]),
      argsArray: rules.flatMap((y) => [
        [],
        [1, 0, 0, 1, 50, y],
        [OPS.stroke, [new Float32Array([0, 0, 0, 1, 400, 0])], new Float32Array([0, 0, 400, 0])],
        []
      ])
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
  if (evidence === 'closed evidence') {
    const [first, second, ...peers] = result.source.units
    expect(first.source).toBe('The surface remained clear.')
    expect(second.source).toBe('The surface darkened near the edge.')
    expect(first.fragments).toEqual(joined.fragments.slice(0, 2))
    expect(second.fragments).toEqual(joined.fragments.slice(2))
    expect(peers).toEqual(source.units.slice(1))
    expect(result.source.originalRegions).toEqual([])
  } else {
    expect(result.source).toBe(source)
  }
})

it.each(['complete', 'shifted mark', 'missing mark'] as const)(
  'splits only the native text column of a fully witnessed marked table (%s)',
  async (evidence) => {
    const labels = ['Soft finish', 'Faint ridges', 'Firm edge', 'Smooth base']
    const item = (str: string, x: number, y: number, width: number): TextItem => ({
      str,
      dir: 'ltr',
      fontName: 'body',
      transform: [8, 0, 0, 8, x, y],
      width,
      height: 8,
      hasEOL: false
    })
    const heads = ['Sample', 'Surface note', 'Dry', 'Oiled', 'Cold', 'Warm']
    const items = [
      item('Table 1. Material inspection at four settings.', 50, 470, 180),
      ...heads.map((head, i) => item(head, [50, 140, 260, 320, 380, 440][i], 422, i < 2 ? 46 : 20)),
      ...labels.flatMap((label, i) => {
        const y = 406 - i * 10
        return [
          item('Trial ' + (i + 1), 50, y, 25),
          item(label, 140, y, 38 + i),
          ...[270, 330, 390, 450].flatMap((x, j) => {
            if (i === 1 && j === 2 && evidence === 'missing mark') return []
            const checked = (i + j) % 2 === 0
            return [
              item(
                checked ? '✓' : '–',
                x - (checked ? 3 : 2) + (i === 1 && j === 2 && evidence === 'shifted mark' ? 3 : 0),
                y,
                checked ? 6 : 4
              )
            ]
          })
        ]
      })
    ]
    const piece = (index: number): PdfTranslationFragment => {
      const native = items[index]
      return {
        pageNumber: 1,
        rect: {
          x: native.transform[4] / 500,
          y: (600 - native.transform[5] - 6.4) / 600,
          width: native.width / 500,
          height: 8 / 600
        },
        items: [{ index, text: native.str }]
      }
    }
    const column = items.flatMap(({ str }, index) => (labels.includes(str) ? [piece(index)] : []))
    const first = column[0],
      last = column.at(-1)!
    const combined = {
      id: 'column',
      source: labels.join(' '),
      fragments: [
        {
          ...first,
          rect: {
            ...first.rect,
            width: last.rect.width,
            height: last.rect.y + last.rect.height - first.rect.y
          },
          items: column.flatMap((fragment) => fragment.items)
        }
      ]
    }
    const source = createPdfTranslationSource({
      resourceRequestKey: 'marked-table',
      fingerprint: 'marked-table',
      pages: [{ width: 500, height: 600 }],
      units: [
        combined,
        ...items.flatMap(({ str }, index) =>
          labels.includes(str)
            ? []
            : [
                {
                  id: 'cell-' + index,
                  source: str,
                  ...(/^[✓–]$/u.test(str) ? { sourceOnly: true as const } : {}),
                  fragments: [piece(index)]
                }
              ]
        )
      ]
    })
    const rules = [440, 416, 366]
    const page = {
      rotate: 0,
      getTextContent: async () => ({ items, styles: { body: { ascent: 0.8 } } }),
      getViewport: () => ({
        width: 500,
        height: 600,
        transform: [1, 0, 0, -1, 0, 600],
        convertToViewportPoint: (x: number, y: number) => [x, 600 - y]
      }),
      getOperatorList: async () => ({
        fnArray: rules.flatMap(() => [OPS.save, OPS.transform, OPS.constructPath, OPS.restore]),
        argsArray: rules.flatMap((y) => [
          [],
          [1, 0, 0, 1, 50, y],
          [OPS.stroke, [new Float32Array([0, 0, 0, 1, 430, 0])], new Float32Array([0, 0, 430, 0])],
          []
        ])
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
    const owners = result.source.units.filter(({ id }) => id.startsWith('column'))
    expect(result.source.originalRegions).toHaveLength(1)
    if (evidence === 'complete') {
      expect(owners.map(({ source }) => source)).toEqual(labels)
      expect(owners.map(({ fragments }) => fragments[0].items)).toEqual(
        column.map(({ items }) => items)
      )
      expect(owners.every(({ fragments }) => fragments.length === 1)).toBe(true)
    } else {
      expect(owners).toHaveLength(1)
      expect(owners[0].source).toBe(combined.source)
      expect(owners[0].fragments).toEqual(combined.fragments)
    }
  }
)
