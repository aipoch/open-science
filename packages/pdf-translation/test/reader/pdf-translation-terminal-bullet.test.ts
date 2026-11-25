import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each(['larger body type', 'shared body type', 'different bullet label type'] as const)(
  'uses the outdented body and preceding bullet to close the hanging list (%s)',
  async (shape) => {
    const sharedType = shape !== 'larger body type',
      bulletSize = sharedType ? 10.3 : 9,
      labelSize = sharedType ? 10 : 9
    const runs = [
      ['•', 'marker', 67, 709, 5, bulletSize, false],
      [
        'Inspect the calibration table (optional)',
        shape === 'shared body type' ? 'body' : 'list',
        76,
        709,
        180,
        labelSize,
        true
      ],
      ['•', 'marker', 67, 696, 5, bulletSize, false],
      [
        'Review the saved measurements (optional)',
        sharedType ? 'body' : 'list',
        76,
        696,
        276,
        labelSize,
        true
      ],
      [
        'The archive is updated monthly with independently validated measurements from the network',
        'body',
        60,
        680,
        501,
        10,
        true
      ],
      [
        'so that researchers can compare the observations across multiple seasons.',
        'body',
        51,
        668,
        410,
        10,
        true
      ]
    ] as const
    const items = runs.map(([str, fontName, x, y, width, height, hasEOL]) => ({
      str,
      fontName,
      width,
      hasEOL,
      dir: 'ltr',
      height,
      transform: [height, 0, 0, height, x, y]
    }))
    const metrics = { ascent: 0.85, descent: -0.25, vertical: false }
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] })),
      getTextContent: vi.fn().mockResolvedValue({
        items,
        styles: { body: metrics, list: metrics, marker: metrics }
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

    const lead = '• Review the saved measurements (optional)'
    const body =
      'The archive is updated monthly with independently validated measurements from the network so that researchers can compare the observations across multiple seasons.'
    const boundary = shape !== 'different bullet label type'
    expect(source.units.map((unit) => unit.source)).toEqual([
      '• Inspect the calibration table (optional)',
      ...(boundary ? [lead, body] : [lead + ' ' + body])
    ])
    expect(
      source.units.map(({ fragments }) =>
        fragments.flatMap(({ items }) => items.map(({ index }) => index))
      )
    ).toEqual([
      [0, 1],
      ...(boundary
        ? [
            [2, 3],
            [4, 5]
          ]
        : [[2, 3, 4, 5]])
    ])
  }
)
