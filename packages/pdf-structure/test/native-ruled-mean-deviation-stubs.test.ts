import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { ruledMeanDeviationStubs } = await import(
  pathToFileURL(resolve('test/fixtures/ruled-mean-deviation-stubs.mjs')).href
)
const run = (f: ReturnType<typeof ruledMeanDeviationStubs>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.pageItems, [], [], f.rules)
it('recovers the centered owned stub across a complete repeated mean/deviation cohort', () => {
  const f = ruledMeanDeviationStubs(),
    r = run(f)
  expect(
    r.cells
      .filter((c: { column: number; text: string }) => c.column === 0 && /^Set /.test(c.text))
      .map((c: { row: number; rowSpan: number; text: string }) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [2, 3, 'Set A'],
    [5, 3, 'Set B'],
    [8, 3, 'Set C']
  ])
  expect(r.repairs).toContain('native-ruled-mean-deviation-stub-span-recovered')
  expect(r.grid.slice(2).map((row: string[]) => row.slice(1))).toEqual(
    Array.from({ length: 9 }, (_, row) => [
      String(((row % 3) + 1) * 5),
      `${70 + Math.floor(row / 3) + (row % 3)}.1 ± 0.${(row % 3) + 1}`,
      `${70 + Math.floor(row / 3) + (row % 3)}.2 ± 0.${(row % 3) + 1}`
    ])
  )
  const key = (s: { pageNumber: number; index: number; text: string }): string => JSON.stringify(s)
  expect(
    r.cells
      .flatMap((c: { sourceItems?: Array<{ pageNumber: number; index: number; text: string }> }) =>
        (c.sourceItems ?? []).map(key)
      )
      .sort()
  ).toEqual(
    f.pageItems
      .map((i: { sourceItem: { pageNumber: number; index: number; text: string } }) =>
        key(i.sourceItem)
      )
      .sort()
  )
})

it.each([
  'missing separator',
  'internal separator',
  'unequal cohorts',
  'foreign source',
  'unpaired deviation',
  'partial whole source',
  'crossed native lane',
  'two incomplete spans'
])('retains the original ownership when proof is incomplete: %s', (variant) => {
  const f = ruledMeanDeviationStubs()
  if (variant === 'missing separator') f.rules = f.rules.filter((r: number[]) => r[1] !== 156)
  if (variant === 'internal separator') f.rules.push([100, 180, 145, 180])
  if (variant === 'unequal cohorts')
    f.pageItems = f.pageItems.filter((i: { baseline: number }) => i.baseline !== 226)
  if (variant === 'foreign source')
    f.pageItems.push({
      text: 'extra',
      rect: [178, 160, 186, 166],
      baseline: 166,
      height: 6,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 999, text: 'extra' }
    })
  if (variant === 'unpaired deviation') {
    const t = f.pageItems.find((i: { text: string }) => i.text === '±')!
    t.text = '+'
    t.sourceItem.text = '+'
  }
  if (variant === 'partial whole source')
    f.pageItems.find((i: { text: string }) => i.text === '70.1')!.sourceItem.text += ' hidden'
  if (variant === 'crossed native lane') {
    const t = f.pageItems.find((i: { text: string }) => i.text === '70.1')!
    t.rect[0] = 151
    t.rect[2] = 178
  }
  if (variant === 'two incomplete spans')
    f.table.structure.objects = f.table.structure.objects.filter(
      (o: { label: string; rect: number[] }) =>
        !(o.label === 'table spanning cell' && o.rect[1] === 92)
    )
  expect(run(f).repairs).not.toContain('native-ruled-mean-deviation-stub-span-recovered')
})
