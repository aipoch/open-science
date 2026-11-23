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

it.each(['plot above caption', 'plot intersects caption', 'missing column evidence'] as const)(
  'restores a final-page raster caption above continuing references (%s)',
  async (shape) => {
    const runs = [
      { str: 'Short Running Title', x: 37, y: 94, width: 26 },
      { str: '2', x: 91, y: 94, width: 1 },
      { str: 'Figure 1.', x: 8, y: 56, width: 8, font: 'label' },
      {
        str: 'The chart compares measurements for independently selected samples under three conditions.',
        x: 17,
        y: 56,
        width: 75
      },
      { str: 'The dotted line marks the reference value.', x: 8, y: 54, width: 50 }
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
      owner('running', runs[0].str, 2, 0, 0.37, 0.05, 0.26),
      owner('folio', runs[1].str, 2, 1, 0.91, 0.05, 0.01),
      {
        id: 'caption',
        source: runs
          .slice(2)
          .map((run) => run.str)
          .join(' '),
        sourceOnly: true,
        preserve: 'reference',
        fragments: [
          {
            pageNumber: 2,
            rect: { x: 0.08, y: 0.43, width: 0.84, height: 0.035 },
            items: runs.slice(2).map((run, i) => ({ index: i + 2, text: run.str }))
          }
        ]
      } satisfies PdfTranslationSource['units'][number],
      ...[0.08, 0.52].flatMap((x, lane) => [
        owner(
          `entry-${lane}-first`,
          `Reader, A. 2021, Field Reports, 1, 2, doi: 10.9999/test-${lane}-a`,
          2,
          5 + lane * 2,
          x,
          0.48,
          0.35
        ),
        owner(
          `entry-${lane}-second`,
          `Reader, B. 2022, Field Reports, 3, 4${shape === 'missing column evidence' && lane === 1 ? '' : `, doi: 10.9999/test-${lane}-b`}`,
          2,
          6 + lane * 2,
          x,
          0.5,
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
                      [70, 0, 0, 33, 15, shape === 'plot intersects caption' ? 56 : 58],
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
      shape === 'plot above caption' ? ['caption'] : []
    )
    expect(result.source.units.map((unit) => unit.fragments)).toEqual(
      units.map((unit) => unit.fragments)
    )
  }
)
