import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['s', 't'])('joins an indexed subject only after its assignment (index %s)', (index) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10,
    fontName = 'Body',
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, y],
    fontName,
    fontAscent: 0.75,
    fontDescent: -0.25,
    fontVertical: false,
    hasEOL
  })
  const predicate =
    'is a stable sequence on a finite neighborhood. These conditions give the next comparison.'
  const items = [
    item(
      'Define the indexed sequence by the operator shown below, and put',
      65,
      430,
      395,
      10,
      'Body',
      true
    ),
    item(`w${index} = 0`, 290, 410, 45, 10, 'Math', true),
    item('Thus', 65, 380, 22),
    item('(', 90.3, 380, 4, 10, 'Symbols'),
    item('w', 94.3, 380, 5, 10, 'Math'),
    item('s', 99.3, 378.5, 5, 7, 'Subscript'),
    item(')', 104.8, 380, 4, 10, 'Symbols'),
    item(predicate, 112.1, 380, 421, 10, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  expect(units[1]).toMatchObject({ source: `w${index} = 0`, preserve: 'formula', sourceOnly: true })
  if (index === 's') {
    expect(units).toHaveLength(3)
    expect(units[2].source).toBe(`Thus (ws) ${predicate}`)
    expect(units[2].sourceOnly).toBeUndefined()
  } else {
    expect(units).toHaveLength(4)
    expect(units[2]).toMatchObject({ source: 'Thus (ws)', preserve: 'formula', sourceOnly: true })
    expect(units[3].source).toBe(predicate)
  }
  expect(units.flatMap(({ originalStrings }) => originalStrings)).toEqual(
    items.map(({ str }) => str)
  )
})
