import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])('joins proven hanging steps (%s)', (aligned) => {
  const item = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
    str,
    width,
    height: 11,
    dir: 'ltr',
    transform: [11, 0, 0, 11, x, y],
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontName: 'Body',
    fontVertical: false,
    hasEOL: true
  })
  const items = [
    item('The following procedure compares two groups under fixed conditions.', 70, 749, 460),
    item('Step 1. Record the values observed in the first group and prepare', 55, 663, 475),
    item('a table with a measured value for each case in the first group.', 94, 649, 436),
    item('Step 2. Compare the values from both groups and determine', 55, 624, 475),
    item(
      'the smallest difference between the two sets of measured values.',
      aligned ? 94 : 105,
      610,
      436
    ),
    item('The final report describes the outcome in detail.', 70, 580, 320)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const owner = (index: number): (typeof units)[number] | undefined =>
    units.find((unit) => unit.items.includes(`1:${index}`))
  expect(owner(1) === owner(2)).toBe(aligned)
  expect(owner(1)).not.toBe(owner(3))
  expect(owner(4)).not.toBe(owner(5))
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => `1:${i}`))
})
