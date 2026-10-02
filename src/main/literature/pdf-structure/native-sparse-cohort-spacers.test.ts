import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { recoverSampleQualifiedSparseCohortGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  'native',
  'missing-caption',
  'missing-leaf',
  'wrong-overlap',
  'missing-sample',
  'reference-value',
  'different-cohort',
  'wrong-leading'
])('uses native sparse cohorts to remove model spacer records with %s proof', (variant) => {
  const f: {
    table: unknown
    items: Array<{ text: string; rect: number[]; baseline: number }>
    captions: unknown[]
    rules: number[][]
  } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-sparse-cohorts-with-model-spacer-rows.jsonl'
    )
  )
  if (variant === 'missing-caption') f.captions = []
  if (variant === 'missing-leaf') f.rules.splice(2, 1)
  if (variant === 'wrong-overlap') f.rules[3][0] += 2
  if (variant === 'missing-sample') f.items.find((i) => i.text.startsWith('Arm-A'))!.text = 'Arm-A'
  if (variant === 'reference-value')
    f.items.push({
      ...f.items.find((i) => i.text.startsWith('Arm-C'))!,
      text: '3',
      rect: [550, 212.24, 556, 223.48]
    })
  if (variant === 'different-cohort')
    f.items.find((i) => i.baseline > 260 && i.text.startsWith('Arm-A'))!.text = 'Arm-D (n = 33)'
  if (variant === 'wrong-leading') f.items.find((i) => i.text === 'Initial section')!.baseline += 5
  const snapshot = structuredClone(f),
    r = recoverSampleQualifiedSparseCohortGrid(f.table, f.items, f.captions, f.rules)
  expect(Boolean(r)).toBe(variant === 'native')
  if (r) {
    expect(r.rows).toHaveLength(14)
    expect(r.columns).toHaveLength(6)
    expect(r.ownedTokens.size).toBe(f.items.length)
  }
  expect(f).toEqual(snapshot)
})

it('retains adjacent native section baselines through full table refinement', () => {
  const f: {
    table: unknown
    items: Array<{
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }>
    captions: unknown[]
    rules: number[][]
  } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-sparse-cohorts-with-model-spacer-rows.jsonl'
    )
  )
  const result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.grid).toHaveLength(14)
  expect(result.grid.some((row: string[]) => row[0] === 'Additional section')).toBe(true)
  expect(result.grid.some((row: string[]) => row[0] === 'Scenario labela')).toBe(true)
  expect(
    result.grid.flat().some((text: string) => text.includes('Additional section Scenario label'))
  ).toBe(false)
  const owned = result.cells.flatMap((cell: { sourceRects: number[][] }) =>
    cell.sourceRects.map((rect) => JSON.stringify(rect))
  )
  expect(owned).toHaveLength(f.items.length)
  expect(new Set(owned).size).toBe(owned.length)
})
