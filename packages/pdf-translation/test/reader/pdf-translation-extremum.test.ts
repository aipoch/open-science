import { expect, test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  fontName: string,
  height: number,
  x: number,
  y: number,
  width: number,
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height,
  transform: [height, 0, 0, height, x, y],
  fontName,
  fontAscent: 0.88,
  fontDescent: -0.21,
  fontVertical: false,
  hasEOL
})

test.each([true, false])(
  'preserves an extremum over a centered membership limit (%s)',
  (centered) => {
    const limit = centered ? 239 : 236
    const items = [
      item(
        'Survey values are bounded by the following expression.',
        'body',
        10,
        72,
        450,
        380,
        true
      ),
      item('max', 'roman', 10, 249.5, 406, 18, false),
      item('', 'index', 0, limit, 399, 0, true),
      item('k', 'index', 7, limit, 399, 3),
      item('∈{', 'symbol-small', 7, limit + 3, 399, 9),
      item('1', 'roman-small', 7, limit + 12, 399, 4),
      item(',...,p', 'index', 7, limit + 16, 399, 19),
      item('}', 'symbol-small', 7, limit + 35, 399, 4),
      item(' ', 'symbol-small', 0, limit + 39, 399, 1.7),
      item('|〈', 'symbol', 10, 279.7, 406, 6.6),
      item('u, v', 'italic', 10, 286.3, 406, 14.8),
      item('k', 'index', 7, 301.1, 404.6, 3),
      item('〉| ≤', 'symbol', 10, 304.3, 406, 17.2),
      item('D', 'italic', 10, 324.2, 406, 7.1),
      item('The upper bound is uniform over the sites.', 'body', 10, 72, 375, 380, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const operator = units.find((unit) => unit.items.includes('1:1'))
    expect(operator?.source).toBe('max')
    if (centered) {
      expect(operator?.sourceOnly).toBe(true)
      expect(operator?.preserve).toBe('formula')
    } else {
      expect(operator?.sourceOnly).not.toBe(true)
    }
  }
)
