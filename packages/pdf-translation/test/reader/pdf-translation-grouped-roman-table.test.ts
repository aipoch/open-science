import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'

it.each(['native fusion', 'separate cells', 'open footer'] as const)(
  'keeps the original three-column table only with grouped rules and a fused native cell (%s)',
  async (shape) => {
    const width = 600,
      height = 800,
      size = 10
    const row = (
      labels: string[],
      x: number[],
      y: number,
      widths: number[],
      fontName = 'body'
    ): {
      str: string
      width: number
      height: number
      transform: number[]
      dir: string
      fontName: string
    }[] =>
      labels.map((str, index) => ({
        str,
        width: widths[index],
        height: size,
        transform: [size, 0, 0, size, x[index], y],
        dir: 'ltr',
        fontName
      }))
    const x = [62, 142, 246]
    const items = [
      ...row(['Type', 'Operation', 'Description'], x, 692, [28, 54, 68], 'heading'),
      ...[666, 648, 614, 604].flatMap((y) =>
        row(['Group', 'Inspect', 'Read the calibrated sensor display.'], x, y, [35, 38, 163])
      ),
      ...(shape === 'separate cells'
        ? row(['Group', 'Read', 'Record the sensor reading.'], x, 584, [35, 22, 122])
        : row(['Group', 'Read Record the sensor reading.'], x, 584, [35, 227])),
      ...row(['TABLE I. Summary of readings.'], [110], 545, [170]),
      ...row(['Nearby prose has no effect on the measurements.'], [60], 490, [255])
    ]
    const source = createPdfTranslationSource({
      resourceRequestKey: 'grouped-rows',
      fingerprint: 'grouped-rows',
      pages: [{ width, height }],
      units: items.map(({ str, transform: [, , , , x, y], width: w }, index) => ({
        id: String(index),
        source: str,
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: x / width,
              y: (height - y - 8) / height,
              width: w / width,
              height: size / height
            },
            items: [{ index, text: str }]
          }
        ]
      }))
    })
    const rails = [704, 702, 681, 632, 563, ...(shape === 'open footer' ? [] : [561])]
    const page = {
      rotate: 0,
      getOperatorList: async () => ({
        fnArray: rails.map(() => OPS.constructPath),
        argsArray: rails.map((y) => [
          OPS.stroke,
          [Float32Array.of(0, 60, y, 1, 540, y)],
          Float32Array.of(60, y, 540, y)
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
          heading: { ascent: 0.8, descent: -0.2, vertical: false },
          body: { ascent: 0.8, descent: -0.2, vertical: false }
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
    expect(result.source.units.map((unit) => unit.fragments)).toEqual(
      source.units.map((unit) => unit.fragments)
    )
    expect(
      result.source.units.filter((unit) => !unit.sourceOnly).map(({ source }) => source)
    ).toEqual((shape === 'native fusion' ? items.slice(-2) : items).map(({ str }) => str))
  }
)
