import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledCategoricalRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-categories-with-centered-group-statistics.jsonl'
    )
  )

it('keeps paired category labels and centered group statistics with their complete groups', () => {
  const x = fixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toHaveLength(23)
  const spans = result.cells.filter((c: { rowSpan: number }) => c.rowSpan > 1)
  expect(
    spans
      .filter((c: { column: number }) => c.column === 0)
      .map((c: { text: string; rowSpan: number }) => [c.text, c.rowSpan])
  ).toEqual([
    ['Household status', 8],
    ['Work status', 6],
    ['Training status', 4],
    ['Treatment category', 4]
  ])
  expect(spans.filter((c: { column: number }) => c.column === 1)).toHaveLength(11)
  expect(
    spans
      .filter((c: { column: number }) => c.column === 6)
      .map((c: { text: string; rowSpan: number }) => [c.text, c.rowSpan])
  ).toEqual([
    ['0.713', 8],
    ['0.317', 6],
    ['1.000', 4],
    ['0.642', 4]
  ])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 19 && c.column === 5)
  ).toMatchObject({ text: '1', rowSpan: 4 })
  expect(result.grid.slice(19).map((r: string[]) => r.slice(2, 5))).toEqual([
    ['EG', '6', '37.5'],
    ['CG', '6', '37.5'],
    ['EG', '10', '62.5'],
    ['CG', '10', '62.5']
  ])
  expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toHaveLength(
    x.tokens.length
  )
})

it.each([
  'cohort-order',
  'count',
  'percentage',
  'degrees-of-freedom',
  'statistic-position',
  'missing-statistic',
  'duplicate',
  'category',
  'frame',
  'header'
])('refuses grouped spans when %s evidence is incomplete or contradictory', (variant) => {
  const x = fixture()
  const tokens = x.tokens as { text: string; rect: number[]; baseline: number }[]
  const stat = tokens.find((i) => i.text === '0.642')!
  if (variant === 'cohort-order') tokens.find((i) => i.text === 'CG')!.text = 'EG'
  if (variant === 'count')
    tokens.splice(
      tokens.findIndex((i) => i.text === '11'),
      1
    )
  if (variant === 'percentage') tokens.find((i) => i.text === '68.8')!.text = '60.8'
  if (variant === 'degrees-of-freedom')
    tokens.find((i) => i.rect[0] > 750 && i.text === '3')!.text = '2'
  if (variant === 'statistic-position') {
    stat.rect[1] -= 20
    stat.rect[3] -= 20
    stat.baseline -= 20
  }
  if (variant === 'missing-statistic') tokens.splice(tokens.indexOf(stat), 1)
  if (variant === 'duplicate') tokens.push(stat)
  if (variant === 'category') tokens.find((i) => i.text === 'sharing')!.text = 'Separate category'
  if (variant === 'frame') x.rules = []
  if (variant === 'header') tokens.find((i) => i.text === 'dF')!.text = 'Score'
  expect(recoverRuledCategoricalRecords(x.table, tokens, x.rules)).toBeUndefined()
})

const summaryFixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/indented-mean-deviation-section-labels.jsonl'
    )
  )

it('retains every outdented section before complete mean/deviation records', () => {
  const x = summaryFixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toHaveLength(21)
  expect(
    result.grid.filter((r: string[]) => /^Scale-/.test(r[0])).map((r: string[]) => r[0])
  ).toEqual(['Scale-A', 'Scale-B', 'Scale-C', 'Scale-D', 'Scale-E', 'Scale-F'])
  for (let n = 0; n < 6; n++) {
    expect(result.grid[4 + n * 3][0]).toBe('M')
    expect(result.grid[5 + n * 3][0]).toBe('SD')
    expect(
      result.cells.find(
        (c: { row: number; column: number }) => c.row === 3 + n * 3 && c.column === 0
      )
    ).toMatchObject({ colSpan: 13 })
  }
  expect(result.grid[19].slice(1)).toEqual([
    '1.32',
    '1.34',
    '1.62',
    '1.58',
    '1.87',
    '1.89',
    '1.71',
    '1.73',
    '2.45',
    '2.47',
    '1.86',
    '1.86'
  ])
})

const centeredFixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/fragmented-centered-count-section-headings.jsonl'
    )
  )

it('merges fragmented centered sample-size headings across their section width', () => {
  const x = centeredFixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(17)
  expect(result.grid[2][0].replace(/\s/g, '')).toBe('↑of>0.5frombaseline(n=11)')
  expect(result.grid[12][0].replace(/\s/g, '')).toBe('↓of>0.5frombaseline(n=6)')
  for (const row of [2, 7, 12])
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)
    ).toMatchObject({ colSpan: 6 })
  expect(result.grid[3]).toEqual(['200 mg', '0/3 (0)', '0/3 (0)', '1/3 (33)', '0/3 (0)', '0/3 (0)'])
  expect(result.unassigned).toEqual([])
})

it.each(['cycle', 'indent', 'incomplete-values'])(
  'does not infer summary sections from contradictory %s evidence',
  (variant) => {
    const x = summaryFixture()
    const first = x.tokens.find((i: { text: string }) => i.text === 'M')
    if (variant === 'cycle') first.text = 'Other'
    if (variant === 'indent') {
      first.rect[0] -= 12
      first.rect[2] -= 12
    }
    if (variant === 'incomplete-values')
      x.tokens.splice(
        x.tokens.findIndex((i: { text: string }) => i.text === '1.96'),
        1
      )
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.unassigned).toContain('Scale-B')
  }
)

it.each(['center', 'gap', 'model-header', 'incomplete-values'])(
  'does not merge fragmented section text without %s evidence',
  (variant) => {
    const x = centeredFixture()
    const first = x.tokens.find(
      (i: { text: string; rect: number[] }) => i.text === '↑' && i.rect[1] > 200
    )
    const group = x.tokens.filter(
      (i: { baseline: number }) => Math.abs(i.baseline - first.baseline) < 1
    )
    if (variant === 'center')
      for (const i of group) {
        i.rect[0] += 20
        i.rect[2] += 20
      }
    if (variant === 'gap') {
      first.rect[0] -= 8
      first.rect[2] -= 8
    }
    if (variant === 'model-header')
      x.table.structure.objects = x.table.structure.objects.filter(
        (o: { label: string }) => o.label !== 'table projected row header'
      )
    if (variant === 'incomplete-values')
      x.tokens.splice(
        x.tokens.findIndex(
          (i: { text: string; rect: number[] }) => i.text === '0/3 (0)' && i.rect[0] > 500
        ),
        1
      )
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(
      result.cells.some(
        (c: { text: string; colSpan: number }) => c.colSpan === 6 && c.text.startsWith('↑')
      )
    ).toBe(false)
  }
)
