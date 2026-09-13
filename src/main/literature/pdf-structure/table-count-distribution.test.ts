import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverCountDistributionGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/underlined-patient-header.jsonl'
    )
  )
it('keeps wrapped totals separate from the shared labels of their count distributions', () => {
  const x = load(),
    before = structuredClone(x),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(26)
  expect(t.grid[2]).toEqual([
    'Total number of days hospitalized during AFT and implant surgery',
    '',
    '112',
    '90',
    ''
  ])
  expect(t.grid[11]).toEqual([
    'Total number of days hospitalized during the study period. All causes',
    '',
    '157',
    '155',
    ''
  ])
  expect(t.cells).toContainEqual(
    expect.objectContaining({
      text: 'Days hospitalized during AFT and implant surgery',
      row: 3,
      column: 0,
      rowSpan: 8
    })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({
      text: 'Days hospitalized during the study period. All causes',
      row: 12,
      column: 0,
      rowSpan: 14
    })
  )
  expect(t.grid.at(-1)).toEqual(['', '20', '1', '0', ''])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})

it.each([
  'missing-frame',
  'missing-count',
  'missing-caption',
  'missing-total',
  'new-label',
  'reversed-categories',
  'duplicate-source'
])('does not rebuild ambiguous count distributions: %s', (kind) => {
  const x = load()
  if (kind === 'missing-frame')
    x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 736.4265) > 1)
  if (kind === 'missing-count')
    x.tokens = x.tokens.filter(
      (i: { text: string; baseline: number }) =>
        !(i.text === '8' && Math.abs(i.baseline - 806.93055) < 1)
    )
  if (kind === 'missing-caption') x.captions = []
  if (kind === 'missing-total')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '157')
  if (kind === 'new-label')
    x.tokens.find((i: { text: string }) => i.text === 'causes').text = 'Other category'
  if (kind === 'reversed-categories')
    x.tokens.find(
      (i: { text: string; baseline: number }) => i.text === '20' && i.baseline > 1000
    ).text = '1'
  if (kind === 'duplicate-source')
    x.tokens.push(structuredClone(x.tokens.find((i: { text: string }) => i.text === '157')))
  expect(recoverCountDistributionGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
