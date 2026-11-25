import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  size: number,
  face = 'text',
  hasEOL = false
): PdfLayoutTextItem {
  return {
    str,
    width,
    height: str.trim() ? size : 0,
    dir: 'ltr',
    transform: [size, 0, 0, size, x, y],
    fontName: face,
    fontAscent: face === 'sum' ? 0.04 : 0.7,
    fontDescent: face === 'sum' ? -0.6 : -0.2,
    fontVertical: false,
    hasEOL
  }
}

function unitsOf(items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages>['units'] {
  return groupPdfTranslationPages({
    pageCount: 1,
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  }).units
}

it.each([true, false])(
  'keeps an aligned set quantifier together before a separate summation (%s)',
  (aligned) => {
    const x = aligned ? 153.3 : 157.3
    const lead = 'The construction follows a simple example: for every set'
    const units = unitsOf([
      item('−', 182, 582, 7, 9, 'symbol'),
      item(lead, 153, 549, 267, 9),
      item('B', 423, 549, 7, 9, 'italic'),
      item('of', 433, 549, 7.4, 9),
      item('', x, 538, 0, 9, 'italic', true),
      item('j', x, 538, 4.8, 9, 'italic'),
      item(' ', x + 4.8, 538, 3.3, 9, 'italic'),
      item('teams,', x + 8.1, 538, 24.1, 9),
      item(' ', x + 32.2, 538, 29.7, 9),
      item('∑', x + 61.9, 534.3, 14.4, 10, 'sum')
    ])
    expect(units.find((unit) => unit.items.includes('1:1'))?.source).toBe(
      lead + (aligned ? ' B of j teams,' : ' B of')
    )
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe(
      aligned ? lead + ' B of j teams,' : 'j teams,'
    )
    expect(units.find((unit) => unit.items.includes('1:9'))?.preserve).toBe('formula')
  }
)

it.each([true, false])(
  'preserves a letter bound and its compact summand when the stack aligns (%s)',
  (aligned) => {
    const shift = aligned ? 0 : 3
    const units = unitsOf([
      item('r', 233.67, 577.66, 4.41, 7.97, 'script'),
      item('∑', 228.78, 574.67, 14.39, 9.96, 'sum'),
      item('j', 229.12, 552.8, 2.88, 7.97, 'script'),
      item('=1', 232.01, 552.8, 10.82, 7.97),
      item('s', 331.69 + shift, 577.66, 5.14, 7.97, 'script'),
      item('∑', 327.06, 574.67, 14.39, 9.96, 'sum'),
      item('j', 321.8, 552.53, 2.88, 7.97, 'script'),
      item('=', 324.69, 552.53, 6.59, 7.97),
      item('r', 331.27, 552.53, 4.41, 7.97, 'script'),
      item('+1', 335.9, 552.53, 10.82, 7.97),
      item('min', 348.53, 564.97, 18.18, 10.91),
      item('{', 366.79, 564.97, 5.45, 10.91, 'symbol'),
      item('r, u', 372.24, 564.97, 17.1, 10.91, 'italic'),
      item('j', 389.35, 563.33, 2.88, 7.97, 'script'),
      item('}', 392.73, 564.97, 5.45, 10.91, 'symbol'),
      item('.', 398.19, 564.97, 3.03, 10.91, 'italic')
    ])
    if (aligned) expect(units.find((unit) => unit.items.includes('1:0'))?.preserve).toBe('formula')
    for (const index of [4, 15]) {
      const owner = units.find((unit) => unit.items.includes('1:' + index))
      expect(owner?.preserve).toBe(aligned ? 'formula' : undefined)
      expect(!!owner?.sourceOnly).toBe(aligned)
    }
  }
)

it.each([true, false])(
  'preserves the modulus of an aligned absolute-difference congruence (%s)',
  (aligned) => {
    const y = aligned ? 305 : 300
    const units = unitsOf([
      item('|', 251, 305, 3, 11, 'symbol'),
      item('a', 254, 305, 5.5, 11, 'italic'),
      item(' − ', 259.5, 305, 13.3, 11, 'symbol'),
      item('b', 272.8, 305, 5, 11, 'italic'),
      item('| ≡', 278.2, 305, 14.6, 11, 'symbol'),
      item(' ', 292.8, 305, 3, 11, 'symbol'),
      item('a', 295.8, 305, 5.5, 11, 'italic'),
      item(' + ', 301.3, 305, 13.4, 11),
      item('b', 314.7, 305, 5, 11, 'italic'),
      item(' ', 319.7, 305, 11.3, 11, 'italic'),
      item('(mod 3)', 331, y, 38.5, 11),
      item('.', 369.5, y, 3, 11, 'italic')
    ])
    const owner = units.find((unit) => unit.items.includes('1:10'))
    expect(owner?.source).toBe('(mod 3).')
    expect(owner?.preserve).toBe(aligned ? 'formula' : undefined)
    expect(!!owner?.sourceOnly).toBe(aligned)
  }
)
