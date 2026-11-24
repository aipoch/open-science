import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([0, 12])('joins a coordinate restriction on its native rail (offset %s)', (offset) => {
  const rows = [
    ['is mapped by this isomorphism to', 361.31, 153.37, 163.1, 'Body', false],
    ['(', 70.87, 140.42, 4.24, 'Symbol', false],
    ['α', 75.11, 140.42, 6.22, 'Math', false],
    ['(', 81.72, 140.42, 4.24, 'Symbol', false],
    ['z', 85.96, 140.42, 5.29, 'Math', false],
    [')', 91.64, 140.42, 4.24, 'Symbol', false],
    [', β', 95.88, 140.42, 11.22, 'Math', false],
    ['(', 107.1, 140.42, 4.24, 'Symbol', false],
    ['z', 111.34, 140.42, 5.29, 'Math', false],
    ['))', 117.02, 140.42, 8.49, 'Symbol', false],
    ['∈', 129.62, 140.42, 7.27, 'Operator', false],
    ['V', 141.01, 140.42, 6.36, 'Math', false],
    ['(', 149.8, 140.42, 4.24, 'Symbol', false],
    ['J', 154.04, 140.42, 9.07, 'Math', false],
    [')', 164.0, 140.42, 4.24, 'Symbol', false],
    ['×', 171.1, 140.42, 8.49, 'Operator', false],
    ['V', 182.44, 140.42, 6.36, 'Math', false],
    ['(', 191.23, 140.42, 4.24, 'Symbol', false],
    ['Q', 195.47, 140.42, 7.0, 'Math', false],
    [')', 203.99, 140.42, 4.24, 'Symbol', false],
    ['.', 208.23, 140.42, 3.03, 'Body', false],
    ['Restricting', 218.07, 140.42, 52.36, 'Body', false],
    ['J', 274.72, 140.42, 9.07, 'Math', false],
    ['to the subgraph induced by the second coordinates', 288.96, 140.42, 235.44, 'Body', true],
    ['used by', 70.87, 127.47, 36.43, 'Body', false],
    ['R', 110.93, 127.47, 6.38, 'Math', false],
    [', we may assume that', 118.82, 127.47, 104.06, 'Body', false],
    ['J', 226.51, 127.47, 9.07, 'Math', false],
    ['is connected.', 240.1, 127.47, 61.27, 'Body', false]
  ] as const
  const items: PdfLayoutTextItem[] = rows.map(([str, x, y, width, fontName, hasEOL]) => ({
    str,
    width,
    height: 10.91,
    dir: 'ltr',
    transform: [10.91, 0, 0, 10.91, y < 140 ? x + offset : x, y],
    fontName,
    fontFamily: 'sans-serif',
    fontAscent: fontName === 'Operator' ? 0.75 : fontName === 'Math' ? 0.694 : 0.689,
    fontDescent: -0.194,
    fontVertical: false,
    hasEOL
  }))
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 595.276, height: 841.89, rotation: 0, items }]
  })
  const lead = units.find((unit) => unit.items.includes('1:23'))
  expect(lead?.items.includes('1:24')).toBe(offset === 0)
  expect(units.find((unit) => unit.items.includes('1:1'))?.preserve).toBe('formula')
})
