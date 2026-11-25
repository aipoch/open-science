import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource, type PdfTranslationSource } from '../../src/reader/source.js'

it.each(['aligned', 'caption above figure', 'open bibliography'] as const)(
  'restores the captions on a figure-only page following references (%s)',
  async (layout) => {
    const form = (
      id: string,
      text: string,
      pageNumber: number,
      index: number,
      x: number,
      y: number,
      width: number
    ): PdfTranslationSource['units'][number] => ({
      id,
      source: text,
      sourceOnly: true,
      preserve: 'reference' as const,
      fragments: [{ pageNumber, rect: { x, y, width, height: 0.02 }, items: [{ index, text }] }]
    })
    const units = [
      form('heading', 'References', 1, 0, 0.1, 0.2, 0.18),
      form('entry', '1. C. Example, Field Methods (2023).', 1, 1, 0.1, 0.25, 0.4),
      form('first-axis', 'Elapsed time', 2, 0, 0.4, 0.29, 0.18),
      form(
        'first-caption',
        'Fig. 1. The diagram shows how the observed rates vary across three independently sampled field locations.',
        2,
        1,
        0.08,
        layout === 'caption above figure' ? 0.05 : 0.36,
        0.84
      ),
      form('second-axis', 'Number of markers', 2, 2, 0.4, 0.66, 0.18),
      form(
        'second-caption',
        'Fig. 2. The panels show the comparison of the independently measured values and the corresponding residuals.',
        2,
        3,
        0.08,
        0.77,
        0.84
      ),
      ...(layout === 'open bibliography'
        ? [form('later-entry', '2. T. Example, Tracking Data (2024).', 2, 4, 0.1, 0.83, 0.5)]
        : [])
    ]
    const source = createPdfTranslationSource({
      fingerprint: 'two-figure-tail',
      resourceRequestKey: 'two-figure-tail',
      pages: [
        { width: 100, height: 100 },
        { width: 100, height: 100 }
      ],
      units
    })
    const page = (number: number): PDFPageProxy =>
      ({
        rotate: 0,
        getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
        getOperatorList: async () => ({
          fnArray: number === 2 ? [OPS.constructPath, OPS.constructPath] : [],
          argsArray:
            number === 2
              ? [
                  [OPS.fill, [], [16, 65, 84, 91]],
                  [OPS.fill, [], [16, 24, 84, 58]]
                ]
              : []
        }),
        cleanup: () => {}
      }) as unknown as PDFPageProxy
    const result = await preservePdfFigureSources({
      document: { getPage: async (number) => page(number) },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.map(({ fragments }) => fragments)).toEqual(
      source.units.map(({ fragments }) => fragments)
    )
    expect(result.source.units.filter((unit) => !unit.sourceOnly).map(({ id }) => id)).toEqual(
      layout === 'aligned' ? ['first-caption', 'second-caption'] : []
    )
  }
)

it.each(['stacked', 'separated', 'body below'] as const)(
  'restores a stacked raster caption between bibliography pages (%s)',
  async (kind) => {
    const runs = [
      { text: 'Figure 2.', x: 8, y: 18, width: 9, font: 'label' },
      {
        text: 'Two panels compare measurements for independently selected samples.',
        x: 18,
        y: 18,
        width: 74
      },
      {
        text: 'The solid curves show fitted values and the dashed curves show controls.',
        x: 8,
        y: 16,
        width: 84
      },
      { text: 'Both panels use the normalized time scale.', x: 8, y: 14, width: 66 }
    ]
    const [folio, ...caption] = [{ text: '2', x: 91, y: 94, width: 1 }, ...runs].map(
      ({ text, x, y, width, ...style }) => ({
        str: text,
        dir: 'ltr',
        width,
        height: 1,
        transform: [1, 0, 0, 1, x, y],
        fontName: 'font' in style ? style.font : 'body'
      })
    )
    const owner = (
      id: string,
      text: string,
      pageNumber: number,
      index = 0,
      x = 0.08,
      y = 0.88,
      width = 0.36
    ): PdfTranslationSource['units'][number] => ({
      id,
      source: text,
      sourceOnly: true,
      preserve: 'reference',
      fragments: [{ pageNumber, rect: { x, y, width, height: 0.011 }, items: [{ index, text }] }]
    })
    const label = owner('caption', runs.map((run) => run.text).join(' '), 2, 1, 0.08, 0.81, 0.84)
    const units = [
      owner('heading', 'References', 1),
      owner('folio', folio.str, 2, 0, 0.91, 0.05, 0.01),
      {
        ...label,
        fragments: [
          {
            ...label.fragments[0],
            rect: { ...label.fragments[0].rect, height: 0.06 },
            items: caption.map((run, index) => ({ index: index + 1, text: run.str }))
          }
        ]
      },
      owner('left', 'Hayes, E. 2020,', 2, 5),
      owner('left-tail', 'Field Notes, 4, 5', 2, 6, 0.1, 0.9),
      owner('right', 'Reed, D., Carson, F.', 2, 7, 0.52),
      owner(
        'right-tail',
        kind === 'body below' ? 'Ordinary prose.' : '2021, Test Reports, 6, 7',
        2,
        8,
        0.54,
        0.9
      ),
      owner('last', 'West, R. 2023, Reports, 8, 11', 3)
    ]
    const source = createPdfTranslationSource({
      fingerprint: 'stacked-caption',
      resourceRequestKey: 'stacked-caption',
      pages: Array.from({ length: 3 }, () => ({ width: 100, height: 100 })),
      units
    })
    const result = await preservePdfFigureSources({
      document: {
        getPage: async (number) =>
          ({
            rotate: 0,
            getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
            getOperatorList: async () =>
              number !== 2
                ? { fnArray: [], argsArray: [] }
                : {
                    fnArray: Array.from({ length: 2 }, () => [
                      OPS.save,
                      OPS.transform,
                      OPS.paintImageXObject,
                      OPS.restore
                    ]).flat(),
                    argsArray: [
                      [],
                      [55, 0, 0, 50, 22.5, 42],
                      ['top'],
                      [],
                      [],
                      [52, 0, 0, 22, 24, kind === 'separated' ? 18 : 19.8],
                      ['bottom'],
                      []
                    ]
                  },
            getTextContent: async () => ({ items: [folio, ...caption] }),
            cleanup: () => {}
          }) as unknown as PDFPageProxy
      },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.filter((unit) => !unit.sourceOnly).map(({ id }) => id)).toEqual(
      kind === 'stacked' ? ['caption'] : []
    )
    expect(result.source.units.find(({ id }) => id === 'caption')?.fragments).toEqual(
      units[2].fragments
    )
  }
)

it.each([
  'plot above caption',
  'plot intersects caption',
  'missing column evidence',
  'folio only',
  'folio with offset plot'
] as const)(
  'restores a final-page raster caption above continuing references (%s)',
  async (shape) => {
    const hasRunningTitle = shape !== 'folio only' && shape !== 'folio with offset plot'
    const header = hasRunningTitle ? [{ str: 'Short Running Title', x: 37, y: 94, width: 26 }] : []
    const captionStart = header.length + 1
    const captionY = hasRunningTitle ? 0.43 : 0.31
    const firstBaseline = hasRunningTitle ? 56 : 68
    const runs = [
      ...header,
      { str: '2', x: 91, y: 94, width: 1 },
      { str: 'Figure 1.', x: 8, y: firstBaseline, width: 8, font: 'label' },
      {
        str: 'The chart compares measurements for independently selected samples under three conditions.',
        x: 17,
        y: firstBaseline,
        width: 75
      },
      { str: 'The dotted line marks the reference value.', x: 8, y: firstBaseline - 2, width: 50 }
    ].map(({ str, x, y, width, ...style }) => ({
      str,
      width,
      height: 1,
      dir: 'ltr',
      fontName: 'font' in style ? style.font : 'body',
      transform: [1, 0, 0, 1, x, y]
    }))
    const owner = (
      id: string,
      text: string,
      pageNumber: number,
      index: number,
      x: number,
      y: number,
      width: number
    ): PdfTranslationSource['units'][number] => ({
      id,
      source: text,
      sourceOnly: true,
      preserve: 'reference',
      fragments: [{ pageNumber, rect: { x, y, width, height: 0.012 }, items: [{ index, text }] }]
    })
    const units = [
      owner('heading', 'References', 1, 0, 0.4, 0.7, 0.2),
      ...header.map(({ str }) => owner('running', str, 2, 0, 0.37, 0.05, 0.26)),
      owner('folio', runs[header.length].str, 2, header.length, 0.91, 0.05, 0.01),
      {
        id: 'caption',
        source: runs
          .slice(captionStart)
          .map((run) => run.str)
          .join(' '),
        sourceOnly: true,
        preserve: 'reference',
        fragments: [
          {
            pageNumber: 2,
            rect: { x: 0.08, y: captionY, width: 0.84, height: 0.035 },
            items: runs
              .slice(captionStart)
              .map((run, i) => ({ index: i + captionStart, text: run.str }))
          }
        ]
      } satisfies PdfTranslationSource['units'][number],
      ...[0.08, 0.52].flatMap((x, lane) => [
        owner(
          `entry-${lane}-first`,
          `Reader, A. 2021, Field Reports, 1, 2, doi: 10.9999/test-${lane}-a`,
          2,
          runs.length + lane * 2,
          x,
          captionY + 0.05,
          0.35
        ),
        owner(
          `entry-${lane}-second`,
          `Reader, B. 2022, Field Reports, 3, 4${shape === 'missing column evidence' && lane === 1 ? '' : `, doi: 10.9999/test-${lane}-b`}`,
          2,
          runs.length + lane * 2 + 1,
          x,
          captionY + 0.07,
          0.35
        )
      ])
    ]
    const source = createPdfTranslationSource({
      fingerprint: 'terminal-raster-caption',
      resourceRequestKey: 'terminal-raster-caption',
      pages: [
        { width: 100, height: 100 },
        { width: 100, height: 100 }
      ],
      units
    })
    const result = await preservePdfFigureSources({
      document: {
        getPage: async (number) =>
          ({
            rotate: 0,
            getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
            getOperatorList: async () =>
              number === 2
                ? {
                    fnArray: [OPS.transform, OPS.paintImageXObject],
                    argsArray: [
                      hasRunningTitle
                        ? [70, 0, 0, 33, 15, shape === 'plot intersects caption' ? 56 : 58]
                        : shape === 'folio only'
                          ? [84, 0, 0, 21, 8, 70]
                          : [82, 0, 0, 21, 9, 70],
                      ['plot']
                    ]
                  }
                : { fnArray: [], argsArray: [] },
            getTextContent: async () => ({ items: runs }),
            cleanup: () => {}
          }) as unknown as PDFPageProxy
      },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.filter((unit) => !unit.sourceOnly).map(({ id }) => id)).toEqual(
      shape === 'plot above caption' || shape === 'folio only' ? ['caption'] : []
    )
    expect(result.source.units.map((unit) => unit.fragments)).toEqual(
      units.map((unit) => unit.fragments)
    )
  }
)

it.each(['aligned', 'misplaced raster', 'repeated marker'] as const)(
  'keeps three independently witnessed raster panel labels separate (%s)',
  async (variant) => {
    const items = [
      ['(c)', 69.5, 399, 9],
      ['Amber sample', 81.5, 399, 74],
      [variant === 'repeated marker' ? '(c)' : '(d)', 208, 399, 9],
      ['Blue sample', 220, 399, 67],
      ['(e)', 351, 399, 9],
      ['Clear sample', 363, 399, 71],
      ['Fig. 1. Results by surface color after independent calibration.', 50, 385, 405]
    ].map(([text, x, y, width], index) => ({
      str: String(text),
      width: Number(width),
      height: 8,
      fontName: [0, 2, 4].includes(index) ? 'marker' : 'label',
      dir: 'ltr',
      transform: [8, 0, 0, 8, Number(x), Number(y)],
      hasEOL: index >= 5
    }))
    const unit = (id: string, indices: number[]): PdfTranslationSource['units'][number] => {
      const first = items[indices[0]],
        last = items[indices.at(-1)!]
      const [, , , , x, y] = first.transform
      return {
        id,
        source: indices.map((i) => items[i].str).join(' '),
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: x / 500,
              y: (600 - y - 6.4) / 600,
              width: (last.transform[4] + last.width - x) / 500,
              height: 8 / 600
            },
            items: indices.map((index) => ({ index, text: items[index].str }))
          }
        ]
      }
    }
    const source = createPdfTranslationSource({
      fingerprint: 'panel-labels',
      resourceRequestKey: 'panel-labels',
      pages: [{ width: 500, height: 600 }],
      units: [
        { ...unit('first-marker', [0]), sourceOnly: true, preserve: 'formula' },
        unit('joined', [1, 2, 3, 4, 5]),
        unit('caption', [6])
      ]
    })
    const images = [50, variant === 'misplaced raster' ? 210 : 185, 330]
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
        styles: { marker: { ascent: 0.8 }, label: { ascent: 0.8 } }
      }),
      getOperatorList: async () => ({
        fnArray: images.flatMap(() => [
          OPS.save,
          OPS.transform,
          OPS.paintImageXObject,
          OPS.restore
        ]),
        argsArray: images.flatMap((x) => [[], [125, 0, 0, 80, x, 410], ['raster', 125, 80], []])
      }),
      cleanup: () => {}
    } as unknown as PDFPageProxy
    const { source: prepared } = await preservePdfFigureSources({
      extraction: { source },
      document: { getPage: async () => page },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    if (variant !== 'aligned') {
      expect(prepared.units).toEqual(source.units)
      return
    }
    expect(prepared.units.map(({ source }) => source)).toEqual(items.map(({ str }) => str))
    expect(
      prepared.units.flatMap(({ fragments }) =>
        fragments.flatMap(({ items }) => items.map(({ index }) => index))
      )
    ).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(
      prepared.units.filter(({ sourceOnly }) => sourceOnly).map(({ source }) => source)
    ).toEqual(['(c)', '(d)', '(e)'])
    expect(prepared.units.filter(({ sourceOnly }) => !sourceOnly).map(({ id }) => id)).toEqual([
      'joined-panel-1',
      'joined-panel-3',
      'joined-panel-5',
      'caption'
    ])
    expect(prepared.units.at(-1)).toEqual(source.units.at(-1))
  }
)

it.each(['aligned', 'shifted image', 'missing heading region'] as const)(
  'restores consecutive captions under appendix rasters (%s)',
  async (layout) => {
    const owner = (
      id: string,
      text: string,
      pageNumber: number,
      index: number,
      y: number,
      width = 0.77
    ): PdfTranslationSource['units'][number] => ({
      id,
      source: text,
      sourceOnly: true,
      preserve: 'reference',
      fragments: [
        { pageNumber, rect: { x: 0.12, y, width, height: 0.03 }, items: [{ index, text }] }
      ]
    })
    const heading = owner('appendix', 'Figures:', 2, 0, 0.14, 0.12)
    const units = [
      owner('entry', '1. N. Example. Introduction to sampling.', 1, 0, 0.61),
      layout === 'missing heading region' ? { ...heading, fragments: [] } : heading,
      owner(
        'first',
        'Figure 1 - The panels compare the sampling frames before adjustment.',
        2,
        1,
        0.61
      ),
      owner(
        'next',
        'Figure 2 - The lower panel shows the adjusted measurement schedule.',
        3,
        0,
        0.61
      )
    ]
    const source = createPdfTranslationSource({
      fingerprint: 'raster-appendix',
      resourceRequestKey: 'raster-appendix',
      pages: Array.from({ length: 3 }, () => ({ width: 100, height: 100 })),
      units
    })
    const result = await preservePdfFigureSources({
      document: {
        getPage: async (number) =>
          ({
            rotate: 0,
            getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
            getOperatorList: async () =>
              number === 1
                ? { fnArray: [], argsArray: [] }
                : {
                    fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
                    argsArray: [
                      [],
                      [62, 0, 0, 37, layout === 'shifted image' ? 16 : 12, 40],
                      ['raster'],
                      []
                    ]
                  },
            getTextContent: async () => ({
              items: units.flatMap((unit) =>
                unit.fragments.flatMap(({ pageNumber, rect, items }) =>
                  pageNumber === number
                    ? items.map(({ text }) => ({
                        str: text,
                        dir: 'ltr',
                        width: rect.width * 100,
                        height: 2,
                        transform: [2, 0, 0, 2, rect.x * 100, 98 - rect.y * 100]
                      }))
                    : []
                )
              )
            }),
            cleanup: () => {}
          }) as unknown as PDFPageProxy
      },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.map(({ fragments }) => fragments)).toEqual(
      source.units.map(({ fragments }) => fragments)
    )
    expect(result.source.units.filter((unit) => !unit.sourceOnly).map(({ id }) => id)).toEqual(
      layout === 'aligned' ? ['first', 'next'] : []
    )
  }
)

it.each([0.12, 0.18])(
  'joins a cross-page sum after its complete floating figure only on the original rail (%s)',
  async (rail) => {
    const unit = (
      id: string,
      pageNumber: number,
      index: number,
      x: number,
      y: number,
      width: number,
      height: number,
      ...runs: string[]
    ): PdfTranslationSource['units'][number] => ({
      id,
      source: runs.join(' '),
      fragments: [
        {
          pageNumber,
          rect: { x, y, width, height },
          items: runs.map((text, i) => ({ index: index + i, text }))
        }
      ]
    })
    const lead = unit(
      'lead',
      1,
      1,
      0.12,
      0.84,
      0.76,
      0.036,
      'The measurements are bounded. Thus, the sum of'
    )
    const tail = unit(
      'tail',
      2,
      2,
      rail,
      0.42,
      0.76,
      0.018,
      'this quantity over all',
      'j ∈ {1, 2, 3} is at most 7. Since the sets are nonempty, there is a'
    )
    const caption = unit(
      'caption',
      2,
      1,
      0.12,
      0.36,
      0.76,
      0.035,
      'Figure 2: Measurements and their groups.'
    )
    const source = createPdfTranslationSource({
      fingerprint: 'floating-figure',
      resourceRequestKey: 'floating-figure',
      pages: Array.from({ length: 2 }, () => ({ width: 100, height: 100 })),
      units: [
        unit('reference', 1, 0, 0.12, 0.7, 0.76, 0.018, 'See Figure 2 for the measurements.'),
        lead,
        {
          ...unit('folio', 1, 2, 0.49, 0.9, 0.02, 0.016, '1'),
          sourceOnly: true,
          preserve: 'literal'
        },
        {
          ...unit('label', 2, 0, 0.36, 0.16, 0.1, 0.018, '{2, 3}'),
          sourceOnly: true,
          preserve: 'literal'
        },
        caption,
        tail,
        {
          ...unit('formula', 2, 4, 0.12, 0.44, 0.26, 0.018, 'pair (a, b)'),
          sourceOnly: true,
          preserve: 'formula'
        }
      ]
    })
    const page = (number: number): PDFPageProxy =>
      ({
        rotate: 0,
        getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
        getOperatorList: async () => ({
          fnArray: number === 2 ? [OPS.constructPath] : [],
          argsArray: number === 2 ? [[OPS.stroke, [], [24, 68, 76, 89]]] : []
        }),
        cleanup: () => {}
      }) as unknown as PDFPageProxy
    const result = await preservePdfFigureSources({
      extraction: { source },
      document: { getPage: async (number) => page(number) },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    const merged = rail === 0.12
    expect(result.source.units.find((entry) => entry.id === 'lead')?.fragments).toEqual(
      merged ? [...lead.fragments, ...tail.fragments] : lead.fragments
    )
    expect(result.source.units.some((entry) => entry.id === 'tail')).toBe(!merged)
    expect(result.source.units.find((entry) => entry.id === 'caption')).toEqual(caption)
  }
)
