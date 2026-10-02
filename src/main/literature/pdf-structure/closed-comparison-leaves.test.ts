import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverSegmentedComparisonLeafGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/closed-comparison-leaves-without-model-header.jsonl'
    )
  )

it('keeps all four native comparison leaves when the model omits its header', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toEqual(['', '≤ Median', '> Median', 'OR (95% CI)*', 'p-value'])
  expect(r.grid).toHaveLength(29)
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .filter((c: { row: number }) => c.row === 0)
      .every((c: { rowSpan: number; colSpan: number }) => c.rowSpan === 1 && c.colSpan === 1)
  ).toBe(true)
})

it.each(['opening', 'divider', 'footer', 'side'])('requires the complete native %s', (kind) => {
  const x = fixture()
  const horizontal = x.rules
    .filter((r: number[]) => r[1] === r[3])
    .sort((a: number[], b: number[]) => a[1] - b[1])
  const rule =
    kind === 'side'
      ? x.rules.find((r: number[]) => r[0] === r[2])
      : horizontal[kind === 'opening' ? 0 : kind === 'divider' ? 5 : 10]
  x.rules.splice(x.rules.indexOf(rule), 1)
  expect(recoverSegmentedComparisonLeafGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('rejects competing native opening and duplicate captions', () => {
  const x = fixture()
  x.rules.push(
    ...x.rules
      .filter((r: number[]) => r[1] === 413.4465 && r[3] === r[1])
      .map((r: number[]) => [r[0], r[1] + 1, r[2], r[3] + 1])
  )
  expect(recoverSegmentedComparisonLeafGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  const y = fixture()
  y.captions.push(structuredClone(y.captions[0]))
  expect(recoverSegmentedComparisonLeafGrid(y.table, y.tokens, y.captions, y.rules)).toBeUndefined()
})

it.each(['extra leaf', 'crossing divider', 'model header'])(
  'declines %s instead of inventing a single-tier header',
  (kind) => {
    const x = fixture()
    if (kind === 'model header')
      x.table.structure.objects.push({ label: 'table column header', rect: [0, 0, 357, 30] })
    else
      x.tokens.push({
        text: kind === 'extra leaf' ? 'Other' : 'Crossing',
        horizontal: true,
        height: 10.5,
        baseline: kind === 'extra leaf' ? 434 : 444,
        rect: kind === 'extra leaf' ? [580, 430, 600, 434] : [580, 435, 600, 444]
      })
    expect(
      recoverSegmentedComparisonLeafGrid(x.table, x.tokens, x.captions, x.rules)
    ).toBeUndefined()
  }
)
