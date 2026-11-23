import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'retains the last bibliography across columns (matched archive=%s)',
  (matched) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      fontName = 'Body',
      height = 10
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const record = (number: number, x: number, y: number): PdfLayoutTextItem[] => [
      item(`[${number}]`, x, y, 11, false),
      item('A. Field and B. Sample. 2021. Measurements of ridge water flow.', x + 18, y, 208),
      item(`Journal of Observations, doi:10.5555/example.${number}`, x + 18, y - 12, 204)
    ]
    // Month 13 keeps both identifiers outside the archive's real namespace.
    const archiveId = ['9913', '12345'].join('.')
    const alternateId = ['9913', '76543'].join('.')
    const archiveLink = new URL('/abs/', 'https://arxiv.org')
    archiveLink.pathname += matched ? archiveId : alternateId
    const prefix = [
      item('The calibration results are described in the preceding sections.', 52, 654, 231),
      item('References', 52, 504, 76, false, 'Heading', 13),
      ...record(1, 55, 488),
      ...record(2, 55, 464),
      item('[3]', 55, 440, 11, false),
      item('A. Sample. 2022. Field observations of water', 73, 440, 169),
      item(`measurement. arXiv:${archiveId} [math.ST] ${archiveLink.href}`, 338, 760, 230)
    ]
    const items = [
      ...prefix,
      ...Array.from({ length: 6 }, (_, index) => record(4 + index, 320, 748 - index * 24)).flat()
    ]
    const evidence = {
      ascent: 0.8,
      descent: -0.2,
      vertical: false as const,
      nativeMetrics: true as const
    }
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items,
          nativeReferenceEvidence: {
            complete: true,
            rules: [],
            fonts: { Body: evidence, Heading: evidence }
          }
        }
      ]
    })
    const continuation = units.find((unit) => unit.items.includes(`1:${prefix.length - 1}`))
    expect(continuation?.preserve).toBe(matched ? 'reference' : undefined)
    if (matched)
      expect(units.find((unit) => unit.items.includes(`1:${prefix.length + 1}`))?.preserve).toBe(
        'reference'
      )
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap(({ items }) => items).sort()).toEqual(items.map((_, n) => `1:${n}`).sort())
  }
)
