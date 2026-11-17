import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)

function fixture(): {
  items: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
    sourceItem: { pageNumber: number; index: number; text: string }
  }[]
  rules: number[][]
  captions: { page: number; lines: string[]; rect: number[] }[]
  paint: Map<string, number[]>
} {
  const captions = [{ page: 1, lines: ['Table 1: Training controls'], rect: [0, 202, 400, 212] }]
  const rules = [
    [0, 164, 400, 164],
    ...[80, 160, 240, 320].flatMap((x) => [
      [x, 130, x, 163.8],
      [x, 164.2, x, 194]
    ])
  ]
  const paint = new Map(
    rules.map(([x, y, right, bottom]) => [
      [x, y, right, bottom].join(','),
      x === right ? [x - 0.25, y, right + 0.25, bottom] : [x, y - 0.25, right, bottom + 0.25]
    ])
  )
  const spec = [
    ['Source', 'Maximum', 'Update', 'Step', 'Decay'],
    ['Type', 'Epochs', 'Period', 'Size', 'Value'],
    ['Control', '20000', '4', '1.50e-04', '0.03'],
    ['Treatment', '20000', '8', '2.75e-04', '0.06']
  ]
  const items = spec.flatMap((row, r) =>
    row.map((text, c) => {
      const x = c * 80 + 24
      const y = [130, 144, 164.5, 179][r]
      return {
        text,
        rect: [x, y, x + 32, y + 10],
        baseline: y + 10,
        height: 10,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: r * 5 + c, text }
      }
    })
  )
  return { items, rules, captions, paint }
}

it('recovers a native open table from one separator and continuous vertical tracks', () => {
  const { items, rules, captions, paint } = fixture()
  const [table] = recoverCaptionedRuledTables(items, rules, captions, 1, [], paint)
  expect(table.cropRect).toEqual([0, 130, 400, 194])
  expect(table.caption).toEqual(captions[0])
  expect(table.structure.objects.map((o: { label: string }) => o.label)).toEqual([
    ...Array(3).fill('table row'),
    ...Array(5).fill('table column'),
    'table column header'
  ])
})

it.each(['broken divider', 'ink spanning a divider', 'missing source field'])(
  'does not infer a table with %s',
  (kind) => {
    const { items, rules, captions, paint } = fixture()
    if (kind === 'broken divider') rules.splice(3, 1)
    if (kind === 'ink spanning a divider') items[0].rect[2] = 81
    if (kind === 'missing source field') items.splice(19, 1)
    expect(recoverCaptionedRuledTables(items, rules, captions, 1, [], paint)).toEqual([])
  }
)
