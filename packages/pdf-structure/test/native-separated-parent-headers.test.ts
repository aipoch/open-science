import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderOwnershipGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve('test/fixtures/repeated-native-separated-numeric-parents.jsonl'))

function closedTitleFixture(clipped = false): ReturnType<typeof JSON.parse> {
  const entries: [string, number, number, number][] = [
    ['Complete comparison', 90, 170, 34],
    ['Item', 5, 30, 58],
    ['Group A', 85, 115, 54],
    ['Group B', 185, 215, 54],
    ['Low', 60, 80, 74],
    ['High', 110, 135, 74],
    ['Low', 160, 180, 74],
    ['High', 210, 235, 74],
    ...[94, 114, 134, 154].flatMap((y, row) =>
      [5, 60, 110, 160, 210].map((x, column): [string, number, number, number] => [
        column ? String(row * 5 + column) : ['Amber', 'Azure', 'Coral', 'Gold'][row],
        x,
        x + 25,
        y
      ])
    )
  ]
  const top = clipped ? 35 : 18
  return {
    table: {
      id: 'anonymous-comparison',
      cropRect: [0, top, 250, 166],
      readingRotation: 0,
      structure: {
        objects: [0, 50, 100, 150, 200].map((x) => ({
          label: 'table column',
          score: 0.9,
          rect: [x, 0, x + 50, 166 - top]
        }))
      }
    },
    tokens: entries.map(([text, x, end, baseline], index) => ({
      text,
      rect: [x, baseline - 12, end, baseline],
      baseline,
      height: 12,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    captions: [{ page: 1, lines: ['Table 1. Comparison.'], rect: [0, 0, 200, 12] }],
    rules: [
      [0, 20, 250, 20],
      [0, 40, 250, 40],
      [52, 60, 148, 60],
      [152, 60, 248, 60],
      [0, 80, 250, 80],
      [0, 166, 250, 166]
    ]
  }
}

it.each([false, true])(
  'keeps an independently closed title above both native child groups (clipped=%s)',
  (clipped) => {
    const f = closedTitleFixture(clipped)
    const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    const title = r.cells.filter((c: { text: string }) => c.text === 'Complete comparison')
    expect(title).toHaveLength(1)
    expect(title[0]).toMatchObject({ row: 0, column: 0, rowSpan: 1, colSpan: 5 })
    expect(r.grid.slice(-4)).toEqual([
      ['Amber', '1', '2', '3', '4'],
      ['Azure', '6', '7', '8', '9'],
      ['Coral', '11', '12', '13', '14'],
      ['Gold', '16', '17', '18', '19']
    ])
    expect(
      r.cells.filter((c: { text: string }) => ['Group A', 'Group B'].includes(c.text))
    ).toHaveLength(2)
    expect(r.unassigned).toEqual([])
    expect(r.cropRect[1]).toBeLessThanOrEqual(20)
  }
)

it.each([
  'no-opening',
  'no-divider',
  'short-divider',
  'crossing-font',
  'extra-ink',
  'vertical-divider',
  'foreign-alias',
  'nested-alias',
  'missing-source',
  'rotated-ink',
  'off-center',
  'incomplete-body'
])('does not establish a closed title tier with %s evidence', (kind) => {
  const f = closedTitleFixture(true)
  if (kind === 'no-opening') f.rules.shift()
  if (kind === 'no-divider') f.rules.splice(1, 1)
  if (kind === 'short-divider') f.rules[1][2] = 220
  if (kind === 'crossing-font') f.tokens[0].rect[3] = 41
  if (kind === 'extra-ink' || kind === 'rotated-ink')
    f.tokens.push({
      text: 'Other',
      rect: [10, 24, 35, 34],
      baseline: 34,
      height: 10,
      horizontal: kind !== 'rotated-ink',
      sourceItem: { pageNumber: 1, index: 100, text: 'Other' }
    })
  if (kind === 'vertical-divider') f.rules.push([125, 20, 125, 40])
  if (kind === 'foreign-alias') f.tokens.push({ ...f.tokens[0], rect: [400, 400, 480, 412] })
  if (kind === 'nested-alias')
    f.tokens.push({
      text: '',
      rect: [400, 400, 480, 412],
      metadata: { sourceSegments: [{ pageNumber: 1, index: 0, text: 'Complete comparison' }] }
    })
  if (kind === 'missing-source') delete f.tokens[0].sourceItem
  if (kind === 'off-center') f.tokens[0].rect = [5, 22, 85, 34]
  if (kind === 'incomplete-body') f.tokens.splice(9, 1)
  const before = structuredClone(f)
  const plan = recoverNativeHeaderOwnershipGrid(f.table, f.tokens, f.captions, f.rules)
  expect(
    plan?.headerRows.length === 3 &&
      plan?.spans.some(
        (s: { row: number; column: number; colSpan: number }) =>
          s.row === 0 && s.column === 0 && s.colSpan === 5
      )
  ).not.toBe(true)
  expect(f).toEqual(before)
})
it('keeps repeated literal separators in their numerical leaves without phantom columns or fragmenting parent scopes', () => {
  const f = load(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toEqual([
    ['Item', 'BandA', '', 'BandB', ''],
    ['Amber', '21 |', '24', '27 |', '30'],
    ['Azure', '28 |', '31', '34 |', '37'],
    ['Coral', '35 |', '38', '41 |', '44']
  ])
  expect(
    result.cells.filter(
      (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 2
    )
  ).toHaveLength(2)
  expect(result.unassigned).toHaveLength(0)
})
it.each([
  'missing separator',
  'unequal leaf count',
  'missing footer',
  'competing numeric baseline',
  'foreign edge ink',
  'miscentered parent'
])('declines unproved repeated numeric parent scopes: %s', (variant) => {
  const f = load()
  if (variant === 'missing separator')
    f.tokens.splice(
      f.tokens.findIndex((i: { text: string }) => i.text === '|'),
      1
    )
  if (variant === 'unequal leaf count')
    f.tokens.splice(
      f.tokens.findIndex((i: { text: string }) => i.text === '30'),
      1
    )
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'competing numeric baseline')
    f.tokens.push({
      text: '57',
      rect: [68, 68, 88, 78],
      baseline: 78,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  if (variant === 'foreign edge ink')
    f.tokens.push({
      text: 'Foreign',
      rect: [230, 72, 250, 82],
      baseline: 82,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  if (variant === 'miscentered parent') f.tokens[1].rect = [118, 24, 138, 34]
  expect(recoverNativeHeaderOwnershipGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
