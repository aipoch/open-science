import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([0, 8])('joins a two-row title with a separately drawn Greek symbol (%d)', (offset) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontName: string,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    hasEOL,
    fontName,
    fontAscent: 0.72,
    fontDescent: -0.22,
    fontVertical: false
  })
  const head = 'THE λ-CHAIN RULE FOR FINITE GRIDS'
  const tail = 'WITH ORDERED PRODUCT SPACES'
  const items = [
    item('THE', 141, 642, 28.5, 12, 'Title'),
    item('λ', 175.5, 642, 6.5, 12, 'Symbol'),
    item('-CHAIN RULE FOR FINITE GRIDS', 182, 642, 289, 12, 'Title', true),
    item(tail, 195, 628, 222, 12, 'Title'),
    item('', 417, 628, 0, 0, 'Title', true),
    item('ALICE RIVER AND LEON FOX', 216 + offset, 598, 180, 10, 'Author'),
    item('', 396, 598, 0, 0, 'Author', true),
    item('Abstract.', 126, 569, 50, 10, 'Label'),
    item(
      'The results establish a general ordering for the finite grid.',
      182,
      569,
      278,
      10,
      'Body'
    ),
    item('A short argument follows the main presentation.', 126, 557, 228, 10, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const title = units.find((unit) => unit.items.includes('1:0'))
  const continuation = units.find((unit) => unit.items.includes('1:3'))
  expect(title?.source).toBe(offset === 0 ? head + ' ' + tail : head)
  expect(continuation === title).toBe(offset === 0)
  expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe('ALICE RIVER AND LEON FOX')
  expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
    items.flatMap((run, index) => (run.str ? ['1:' + index] : [])).toSorted()
  )
})
