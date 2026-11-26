import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([0, 3])('retains a centered argument under a bracketed logarithm (%s)', (shift) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    width,
    height: 10,
    transform: [10, 0, 0, 10, x, y],
    fontName,
    fontAscent: fontName === 'Extension' ? 0.04 : 0.7,
    fontDescent: fontName === 'Extension' ? -2.2 : -0.18,
    fontVertical: false,
    hasEOL
  })
  const items = [
    item('The calculation gives the preceding relationship.', 64, 700, 242, 'Body', true),
    item('Q', 181, 660, 8, 'Math'),
    item('(', 189, 660, 4),
    item('R', 193, 660, 7, 'Math'),
    item(') =', 200, 660, 14),
    item('ln', 217, 660, 9, 'Math'),
    item('[', 228, 674, 5, 'Extension'),
    item('Q', 234, 666.8, 8, 'Math'),
    item('(', 242, 666.8, 4),
    item('R', 246, 666.8, 7, 'Math'),
    item(')', 253, 666.8, 4),
    item('R', 242 + shift, 653.2, 7, 'Math'),
    item(']', 258, 674, 5, 'Extension'),
    item('+', 267, 660, 8),
    item('K', 278, 660, 7, 'Math'),
    item('(1)', 520, 660, 14, 'Body', true),
    item('The result is used in the next calculation.', 64, 622, 232, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 792, rotation: 0, items }]
  })
  const denominator = units.find((unit) => unit.items.includes('1:11'))
  expect(denominator?.source).toBe('R')
  expect(denominator?.preserve).toBe(shift ? undefined : 'formula')
  expect(denominator?.sourceOnly).toBe(shift ? undefined : true)
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(
    items.map((_, index) => `1:${index}`).sort()
  )
})
