/* eslint-disable @typescript-eslint/explicit-function-return-type -- fixture geometry */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

function fixture(sparse: boolean) {
  const width = sparse ? 260 : 520
  const columnWidth = 130
  const borders = sparse ? [10, 30, 60, 100, 138, 161] : [10, 30, 58, 84, 114, 143]
  const structure = {
    objects: [
      ...Array.from({ length: width / columnWidth }, (_, column) => ({
        label: 'table column',
        rect: [column * columnWidth, 10, (column + 1) * columnWidth, borders.at(-2)!]
      })),
      { label: 'table column header', rect: [0, 10, width, 30] },
      ...borders.slice(0, -2).map((top, row) => ({
        label: 'table row',
        rect: [0, top - 5, width, borders[row + 1] - 5]
      }))
    ]
  }
  let index = 0
  const item = (text: string, x: number, y: number, textWidth = 68) => ({
    text,
    rect: [x, y - 10, x + textWidth, y],
    height: 10,
    horizontal: true,
    baseline: y,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const text = sparse ? ['Item', 'Options'] : ['Item', 'Input', 'Method', 'Outcome']
  const source = text.map((label, column) => item(label, column * columnWidth + 18, 24))
  for (let row = 1; row < borders.length - 2; row++)
    source.push(
      ...text.map((label, column) =>
        item(label + ' ' + row, column * columnWidth + 18, borders[row] + 17)
      )
    )
  if (sparse) source.push(item('Final category', 16, 154))
  else
    source.push(
      item('Final category', 18, 133),
      item('Input sample', 151, 127),
      item('(alternative)', 148, 141),
      item('Method label', 289, 127, 80),
      item('(revised)', 293, 141, 80),
      item('Reported outcome', 385, 133, 120)
    )
  return {
    source,
    raw: { id: 'terminal-band', cropRect: [0, 5, width, borders.at(-1)! + 5], structure },
    captions: [{ page: 1, lines: ['Table 1. Compared items.'], rect: [30, -10, 180, 3] }],
    rules: borders.map((y) => [0, y, width, y])
  }
}

it.each([false, true])('restores the final physical table row (sparse: %s)', (sparse) => {
  const { raw, source, captions, rules } = fixture(sparse)
  const result = refineTable(raw, source, captions, [], rules)
  expect(result.grid.at(-1)).toEqual(
    sparse
      ? ['Final category', '']
      : [
          'Final category',
          'Input sample (alternative)',
          'Method label (revised)',
          'Reported outcome'
        ]
  )
  expect(result.grid).toHaveLength(rules.length - 1)
  expect(result.unassigned).toEqual([])
})

it.each(['missing footer', 'partial divider', 'duplicate native token'])(
  'keeps terminal row recovery off with %s',
  (fault) => {
    const { raw, source, captions, rules } = fixture(false)
    if (fault === 'missing footer') rules.pop()
    if (fault === 'partial divider') rules.push([150, 132, 280, 132])
    if (fault === 'duplicate native token') source.push({ ...source.at(-1)! })
    expect(refineTable(raw, source, captions, [], rules).repairs).not.toContain(
      'native-terminal-ruled-band-recovered'
    )
  }
)
