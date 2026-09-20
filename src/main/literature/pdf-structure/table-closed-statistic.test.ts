import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/closed-statistic.jsonl')
  )
it('preserves a source-closed statistic shared by two independent count records', () => {
  const x = load(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === '0.32')).toMatchObject({
    row: 6,
    column: 3,
    rowSpan: 2,
    colSpan: 1
  })
  expect(t.grid.slice(6, 8)).toEqual([
    ['Left sided, N (%)', '145 (52.5%)', '8 (38.1%)', '0.32'],
    ['Bilateral, N (%)', '11 (4.0%)', '0 (0.0%)', '']
  ])
  expect(x).toEqual(load())
})
it.each([
  'open-left',
  'open-right',
  'open-top',
  'open-bottom',
  'interior-stroke',
  'second-value',
  'missing-count'
])('does not infer a shared statistic with contradictory evidence: %s', (condition) => {
  const x = load()
  const value = x.tokens.find((i: { text: string }) => i.text === '0.32')
  const edges = x.rules.filter(
    (r: number[]) => r[1] === r[3] && r[0] <= value.rect[0] && r[2] >= value.rect[2]
  )
  const top = edges
    .filter((r: number[]) => r[1] < value.rect[1])
    .sort((a: number[], b: number[]) => b[1] - a[1])[0]
  const bottom = edges
    .filter((r: number[]) => r[1] > value.rect[3])
    .sort((a: number[], b: number[]) => a[1] - b[1])[0]
  if (condition === 'open-top' || condition === 'open-bottom')
    x.rules = x.rules.filter((r: number[]) => r !== (condition === 'open-top' ? top : bottom))
  if (condition === 'open-left' || condition === 'open-right')
    x.rules = x.rules.filter(
      (r: number[]) =>
        !(
          r[0] === r[2] &&
          Math.abs(r[0] - (condition === 'open-left' ? top[0] : top[2])) < 1.2 &&
          r[1] > top[1] &&
          r[3] < bottom[1]
        )
    )
  if (condition === 'interior-stroke')
    x.rules.push([top[0], (top[1] + bottom[1]) / 2, top[0] + 12, (top[1] + bottom[1]) / 2])
  if (condition === 'second-value') {
    const other = structuredClone(value)
    other.rect[1] += 30
    other.rect[3] += 30
    other.baseline += 30
    x.tokens.push(other)
  }
  if (condition === 'missing-count')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '145 (52.5%)')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.repairs).not.toContain('closed-statistic-span-recovered')
})
