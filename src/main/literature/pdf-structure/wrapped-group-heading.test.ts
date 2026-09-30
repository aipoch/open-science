import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { mergeWrappedStubTails } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-group-heading-beside-comparison-value.jsonl'
    )
  )
it('joins a wrapped group label beside its comparison value using repeated indented child records', () => {
  const f = fixture(),
    repairs: string[] = [],
    before = structuredClone(f)
  mergeWrappedStubTails({ ...f, repairs })
  expect(f.rows).toHaveLength(before.rows.length - 1)
  expect(repairs).toEqual(['wrapped-comparison-record-recovered'])
  const row = f.rows.find(
    (r: { rect: number[] }) => r.rect[1] < 866.36685 && r.rect[3] >= 894.11685
  )
  expect(row).toBeDefined()
  expect(f.items).toEqual(before.items)
})
it.each([
  'too few intact groups',
  'duplicate group labels',
  'different child categories',
  'incomplete child values',
  'unindented children',
  'comparison in a data column',
  'independent values on the tail',
  'native separator',
  'different tail font',
  'different tail alignment',
  'capitalized subgroup'
])('keeps the rows separate with %s', (kind) => {
  const f = fixture()
  const tail = f.items.find((i: { text: string }) => i.text === 'condition')
  if (kind === 'too few intact groups')
    f.items = f.items.filter((i: { text: string }) => i.text !== '0.85')
  if (kind === 'duplicate group labels')
    for (const i of f.items) if (i.text === 'Activity status') i.text = 'Group condition'
  if (kind === 'different child categories') {
    const child = f.items.find(
      (i: { text: string; baseline: number }) => i.text === 'Yes' && i.baseline > 900
    )
    child.text = 'Present'
  }
  if (kind === 'incomplete child values')
    f.items = f.items.filter(
      (i: { text: string; baseline: number }) => !(i.text === '79' && i.baseline > 900)
    )
  if (kind === 'unindented children')
    for (const i of f.items)
      if (['Yes', 'No'].includes(i.text) && i.baseline > 900) {
        i.rect[0] -= 9
        i.rect[2] -= 9
      }
  if (kind === 'comparison in a data column') {
    const comparison = f.items.find((i: { text: string }) => i.text === '0.44')
    comparison.rect[0] -= 100
    comparison.rect[2] -= 100
  }
  if (kind === 'independent values on the tail')
    f.items.push({
      ...structuredClone(tail),
      text: '7',
      rect: [500, tail.rect[1], 507, tail.rect[3]]
    })
  if (kind === 'native separator') f.rules.push([306, 880, 815, 880])
  if (kind === 'different tail font') tail.height *= 1.2
  if (kind === 'different tail alignment') {
    tail.rect[0] += 5
    tail.rect[2] += 5
  }
  if (kind === 'capitalized subgroup') tail.text = 'Condition'
  const before = structuredClone(f),
    repairs: string[] = []
  mergeWrappedStubTails({ ...f, repairs })
  expect(f.rows).toEqual(before.rows)
  expect(f.items).toEqual(before.items)
  expect(repairs).toEqual([])
})
it.each([0.7, 1.8])('uses font-relative evidence at scale %s', (scale) => {
  const f = fixture(),
    repairs: string[] = []
  for (const row of f.rows)
    row.rect = row.rect.map((v: number, n: number) => v * scale + (n % 2 ? 30 : -200))
  f.columnRects = f.columnRects.map((r: number[]) =>
    r.map((v, n) => v * scale + (n % 2 ? 30 : -200))
  )
  for (const i of f.items) {
    i.rect = i.rect.map((v: number, n: number) => v * scale + (n % 2 ? 30 : -200))
    i.height *= scale
    i.baseline = i.baseline * scale + 30
  }
  mergeWrappedStubTails({ ...f, repairs })
  expect(f.rows).toHaveLength(16)
  expect(repairs).toEqual(['wrapped-comparison-record-recovered'])
})
