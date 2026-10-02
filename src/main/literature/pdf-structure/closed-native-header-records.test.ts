import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/closed-population-header-above-complete-native-records.jsonl'
    )
  )

it('restores wrapped population titles above all three native header tiers in the complete refinement', () => {
  const f = load()
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid).toHaveLength(6)
  expect(r.grid[0][1]).toContain('All patients (treatment A [A]')
  expect(r.grid[0][5]).toContain('Selected population (treatment A [A]')
  expect(r.grid[1]).toEqual([
    '',
    'Number of events',
    '',
    'HR (95% CI)',
    'p-value',
    'Number of events',
    '',
    'HR (95% CI)',
    'p-value'
  ])
  expect(r.grid[2]).toEqual(['', 'A', 'T', '', '', 'A', 'T', '', ''])
  expect(r.grid[3]).toEqual([
    'Metric alpha',
    '575',
    '651',
    '0.87 (0.78, 0.97)',
    '0.01',
    '424',
    '497',
    '0.83 (0.73, 0.94)',
    '0.005'
  ])
  expect(
    r.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 4)
  ).toHaveLength(2)
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 2, column: 3, colSpan: 2, rowSpan: 1, text: '' })
  )
})

it('declines closed-header record recovery when body ink no longer fits the leaf grid', () => {
  const f = load()
  f.tokens.find((i: { text: string }) => i.text === '575').text = 'unrelated prose'
  expect(recoverNativeHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
