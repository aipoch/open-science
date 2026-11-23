import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource, type PdfTranslationSource } from '../../src/reader/source.js'

it.each([0, 0.02])(
  'retains evenly spaced coordinate ticks around a raster plot (%s)',
  async (shift) => {
    const labels = [
      ...['03h12m23.30s', '23.20s', '23.10s', '23.00s'].map((text, i) => {
        const width = i ? 0.03 : 0.08
        return [text, 0.3 + i * 0.13 + (i === 2 ? shift : 0) - width / 2, 0.675, width] as const
      }),
      ...['18°24\'39.60"', '39.40"', '39.20"', '39.00"'].map((text, i) => {
        const width = i ? 0.04 : 0.08
        return [text, 0.23 - width, 0.25 + i * 0.1, width] as const
      }),
      ['Horizontal coordinate', 0.4, 0.73, 0.18] as const,
      ['Figure 1. The panels show the registered observations.', 0.13, 0.83, 0.55] as const
    ]
    const units: PdfTranslationSource['units'] = labels.map(([text, x, y, width], index) => ({
      id: String(index),
      source: text,
      fragments: [{ pageNumber: 1, rect: { x, y, width, height: 0.01 }, items: [{ index, text }] }]
    }))
    const source = createPdfTranslationSource({
      fingerprint: 'coordinate-axes',
      resourceRequestKey: 'coordinate-axes',
      pages: [{ width: 100, height: 100 }],
      units
    })
    const page = {
      rotate: 0,
      getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
      getOperatorList: async () => ({
        fnArray: [OPS.constructPath, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [[OPS.fill, [], [10, 20, 90, 81]], [], [60, 0, 0, 47, 24, 33], ['plot'], []]
      }),
      getTextContent: async () => ({ items: [] }),
      cleanup: () => {}
    } as unknown as PDFPageProxy
    const result = await preservePdfFigureSources({
      document: { getPage: async () => page },
      extraction: { source },
      operators: OPS,
      signal: new AbortController().signal,
      skipTranslation: false
    })
    expect(result.source.units.map(({ fragments }) => fragments)).toEqual(
      units.map(({ fragments }) => fragments)
    )
    expect(
      result.source.units.filter(({ sourceOnly }) => sourceOnly).map(({ source }) => source)
    ).toEqual(shift ? [] : labels.slice(0, 8).map(([label]) => label))
  }
)
