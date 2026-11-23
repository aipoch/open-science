import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([
  ['matched extension glyphs', true],
  ['shifted right rail', false],
  ['ordinary text face', false]
] as const)('protects an independently owned native fraction with %s', (shape, retained) => {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    size = 10,
    hasEOL = false
  ): PdfLayoutTextItem => {
    const extension = fontName === 'extension' && shape !== 'ordinary text face'
    return {
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontFamily: 'serif',
      fontVertical: false,
      hasEOL,
      fontAscent: extension ? 0.04 : 0.72,
      fontDescent: extension ? -0.6 : -0.2
    }
  }
  const items = [
    row('A general explanation starts above the expression.', 72, 610, 248, 'body', 10, true),
    row('Given', 88, 586, 25, 'body', 10, true),
    row('j', 117, 597.1, 5.3, 'extension'),
    row('H', 124, 589.95, 5.85, 'math', 7.3, true),
    row('p', 123.4, 582.55, 3.5, 'math', 7.3),
    row('2', 126.9, 581.55, 3.4, 'script', 5.5, true),
    row('k', 131.8, shape === 'shifted right rail' ? 599.6 : 597.1, 5.3, 'extension', 10, true),
    row('≥', 141.2, 586, 7.8, 'operator'),
    row('1, the process remains stable over the full range.', 153.4, 586, 239, 'body', 10, true),
    row('The next explanation remains independently editable.', 72, 556, 256, 'body', 10, true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const scopes = [['1:2'], ['1:6'], ['1:3', '1:4', '1:5']]
  for (const scope of scopes) {
    const unit = units.find(
      ({ items }) => items.length === scope.length && items.every((key) => scope.includes(key))
    )
    expect(unit).toBeDefined()
    expect(Boolean(unit?.sourceOnly)).toBe(retained)
    expect(unit?.preserve).toBe(retained ? 'formula' : undefined)
  }
  expect(units.find((unit) => unit.source === 'Given')?.sourceOnly).toBeUndefined()
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(
    items.map((_, index) => `1:${index}`).sort()
  )
})
