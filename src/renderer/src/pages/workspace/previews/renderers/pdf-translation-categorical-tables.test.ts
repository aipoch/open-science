import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const matrix = (change = 'valid'): ReturnType<typeof groupPdfTranslationPages> => {
  const font = 6.3759,
    slots = [89.63, 134.81, 185.78, 241.51, 282.78, 329.55, 373.26],
    item = (
      str: string,
      x: number,
      y: number,
      width: number,
      size = font,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, 742 - y]
    }),
    count = change === 'two-rows' ? 2 : 3,
    items = Array.from({ length: count }, (_, row) => {
      const y = 100 + row * (change === 'distant-rows' ? 180 : 34.24),
        values = ['Unclear', 'unclear', 'No', 'Yes', 'Unclear', 'Yes', 'Unclear'],
        positions = change === 'three-columns' ? slots.slice(0, 3) : slots
      return [
        item(`Study ${String.fromCharCode(65 + row)}`, 44.96, y, 29.88),
        ...positions.map((x, column) =>
          item(
            change === 'unknown-states' ? 'Maybe' : values[column],
            x + (change === 'drifting-columns' ? row * 8 : 0),
            y,
            values[column].length > 3 ? 21.88 : 9.65,
            change === 'different-fonts' ? font + row : font
          )
        ),
        ...(change === 'intervening-prose' ? [item('because', 120, y, 13)] : []),
        item('High risk in', 456.6, y, 34.52, font, true),
        item('one or more domains', 456.6, y + 8.56, 42.68, font, true)
      ]
    }).flat()
  return groupPdfTranslationPages({
    pages: [{ page: 1, width: 544.252014, height: 742, rotation: 0, items }]
  })
}
it('separates native categorical columns and leaves narrative comments complete', () => {
  const result = matrix(),
    blocks = result.pages[0].blocks
  expect(blocks.filter((b) => b.tableCell && /^(?:Yes|No|Unclear)$/iu.test(b.source))).toHaveLength(
    21
  )
  expect(result.units.filter((u) => u.source === 'High risk in one or more domains')).toHaveLength(
    3
  )
  expect(result.units.some((u) => /Study [A-C].*(?:Yes|No|Unclear)/u.test(u.source))).toBe(false)
})
it.each([
  'two-rows',
  'distant-rows',
  'three-columns',
  'unknown-states',
  'drifting-columns',
  'different-fonts',
  'intervening-prose'
])('does not establish categorical columns from %s', (change) => {
  expect(matrix(change).pages[0].blocks.some((b) => b.tableCell)).toBe(false)
})

const centered = (change = 'valid'): ReturnType<typeof groupPdfTranslationPages> => {
  const font = 7,
    slots = [202, 254, 306, 352, 395, 451],
    item = (
      str: string,
      center: number,
      y: number,
      width: number,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: font,
      dir: 'ltr',
      hasEOL,
      transform: [font, 0, 0, font, center - width / 2, 800 - y]
    }),
    items = [
      ...slots.map((x, col) =>
        item(
          col < 2 ? 'Weight matrix' : col === 2 ? 'Weight vector' : 'Dataset',
          x,
          60,
          col < 3 ? 40 : 21,
          col === 5
        )
      ),
      ...slots.map((x, col) => item(col % 2 ? 're-centering' : 're-scaling', x, 68, 34, col === 5))
    ]
  for (let row = 0; row < (change === 'two-rows' ? 2 : 3); row++) {
    const y = 80 + row * 9
    items.push(item(['Batch norm', 'Weight norm', 'Layer norm'][row], 150, y, 35))
    for (const [col, x] of slots.entries()) {
      const state = (row + col) % 3 ? 'Invariant' : 'No'
      items.push(
        item(
          change === 'unknown-state' && col === 2 ? 'Sometimes' : state,
          x + (change === 'drifting-centers' ? row * 5 : 0),
          y,
          state === 'No' ? 8 : 25,
          col === 5
        )
      )
    }
  }
  items.push(item('Ordinary body continues after the comparison.', 260, 128, 310, true))
  return groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  })
}

it('keeps centered invariant states and their two header tiers in independent columns', () => {
  const blocks = centered().pages[0].blocks
  expect(blocks.filter((b) => b.tableCell && /^(?:Invariant|No)$/u.test(b.source))).toHaveLength(18)
  expect(
    blocks.filter(
      (b) =>
        b.tableCell &&
        /^(?:Weight matrix|Weight vector|Dataset|re-scaling|re-centering)$/u.test(b.source)
    )
  ).toHaveLength(12)
  for (const source of ['Batch norm', 'Weight norm', 'Layer norm'])
    expect(blocks.some((b) => b.tableCell && b.source === source)).toBe(true)
  expect(blocks.some((b) => !b.tableCell && /^Ordinary body/u.test(b.source))).toBe(true)
})

it.each(['two-rows', 'unknown-state', 'drifting-centers'])(
  'does not establish centered categorical columns from %s',
  (change) => expect(centered(change).pages[0].blocks.some((b) => b.tableCell)).toBe(false)
)
