import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([56, 57])('preserves a verified native binomial result, result=%s', (result) => {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, y],
    fontName,
    fontAscent: fontName === 'Bracket' ? 0.04 : 0.72,
    fontDescent: fontName === 'Bracket' ? -0.6 : -0.22,
    fontVertical: false,
    hasEOL
  })
  const items = [
    row(
      'In the first example the same construction applies to each candidate independently.',
      98,
      720,
      423,
      'Body',
      10,
      true
    ),
    row(
      'The resulting group is balanced without repeating any color at adjacent positions.',
      85,
      708,
      437,
      'Body',
      10,
      true
    ),
    row('This differs from the previous sequence because there are', 85, 696, 209),
    row('(', 297.3, 704, 4.56, 'Bracket'),
    row('8', 303.8, 700.4, 4, 'Script', 7, true),
    row('3', 303.8, 692.5, 4, 'Script', 7),
    row('', 309.7, 704, 0, 'Bracket', 0, true),
    row(')', 309.7, 704, 4.56, 'Bracket'),
    row(`= ${result} copies of`, 317.1, 696, 65),
    row('H', 386, 696, 8, 'Math'),
    row('3', 394, 694.5, 4, 'Script', 7),
    row('in', 402, 696, 8),
    row('H', 414, 696, 8, 'Math'),
    row('8', 422, 694.5, 4, 'Script', 7),
    row('.', 427, 696, 2.7, 'Body', 10, true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const tail = units.find((unit) => unit.items.includes('1:8'))
  expect(tail?.source).toBe(`= ${result} copies of H3 in H8.`)
  expect(tail?.sourceOnly).toBe(result === 56 ? true : undefined)
  expect(tail?.preserve).toBe(result === 56 ? 'formula' : undefined)
  expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
    items.flatMap(({ str }, index) => (str ? [`1:${index}`] : [])).toSorted()
  )
})

it.each([0, 3])('retains a native binomial numerator when it is centered (%s)', (offset) => {
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
    fontAscent: fontName === 'Extension' ? 0.04 : 0.72,
    fontDescent: fontName === 'Extension' ? -2.35 : -0.22,
    fontVertical: false,
    hasEOL
  })
  const items = [
    item('We obtain the following inequality.', 60, 535, 160, 'Body', true),
    item('≥', 238, 500, 8),
    item('(', 249, 514, 8, 'Extension'),
    item('a', 266.5 + offset, 507, 6, 'Math', true),
    item('b', 257, 493, 5, 'Math'),
    item('−', 265, 493, 7),
    item('c', 277, 493, 5, 'Math', true),
    item(')', 282, 514, 8, 'Extension'),
    item('Q.', 290, 500, 12, 'Math', true),
    item('The two sides are then compared.', 60, 470, 155, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 560, height: 650, rotation: 0, items }]
  })
  const numerator = units.find((unit) => unit.items.includes('1:3'))
  expect(numerator?.items).toEqual(['1:3'])
  expect(numerator?.sourceOnly ?? false).toBe(offset === 0)
  expect(numerator?.preserve).toBe(offset === 0 ? 'formula' : undefined)
})
