import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

type NativeToken = { text: string; rect: number[]; baseline: number }

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-hierarchical-section-directory.jsonl'
    )
  )

it('excludes a hierarchical native section directory between outer page separators', () => {
  const sample = input()
  const before = structuredClone(sample)
  expect(hasTableEvidence(sample.table, undefined, sample.items, sample.rules)).toBe(false)
  expect(sample).toEqual(before)
})

it.each(['title', 'distant-title', 'nested', 'sequence', 'page-lane', 'internal-rule', 'caption'])(
  'retains records without the complete directory proof: %s',
  (missing) => {
    const sample = input()
    if (missing === 'title')
      sample.items.find((i: NativeToken) => i.text === 'Contents').text = 'Measured records'
    if (missing === 'distant-title') {
      const title = sample.items.find((i: NativeToken) => i.text === 'Contents')
      title.rect[1] -= 180
      title.rect[3] -= 180
      title.baseline -= 180
    }
    if (missing === 'nested') {
      for (const i of sample.items.filter((i: NativeToken) => /^\d+\.\d+$/.test(i.text)))
        i.text = 'Category'
    }
    if (missing === 'sequence') {
      const ordinal = sample.items.find((i: NativeToken) => i.text === '3' && i.rect[0] < 200)
      ordinal.text = '9'
    }
    if (missing === 'page-lane') {
      for (const i of sample.items.filter((i: NativeToken) => i.rect[0] > 750)) {
        i.rect[0] -= 180
        i.rect[2] -= 180
      }
      for (const cell of sample.table.cells.filter((c: { column: number }) => c.column === 1)) {
        cell.rect[0] -= 180
        cell.rect[2] -= 180
      }
    }
    if (missing === 'internal-rule') sample.rules.push([130, 350, 780, 350])
    const caption = missing === 'caption' ? { lines: ['Table 2. Measured categories.'] } : undefined
    expect(hasTableEvidence(sample.table, caption, sample.items, sample.rules)).toBe(true)
  }
)

it('uses source positions regardless of detector row grouping or input order', () => {
  const sample = input()
  sample.items.reverse()
  sample.rules.reverse()
  sample.table.grid.reverse()
  sample.table.cells.reverse()
  expect(hasTableEvidence(sample.table, undefined, sample.items, sample.rules)).toBe(false)
})

it('does not reject a neighboring candidate using directory ink outside its horizontal bounds', () => {
  const sample = input()
  sample.table.cropRect[0] = 450
  sample.table.grid = Array.from({ length: 10 }, (_, n) => [`Metric ${n}`, String(n + 0.5)])
  sample.table.cells = []
  sample.table.unassigned = []
  expect(hasTableEvidence(sample.table, undefined, sample.items, sample.rules)).toBe(true)
  sample.items.find((i: NativeToken) => i.text === 'Contents').text = 'Overview'
  expect(hasTableEvidence(sample.table, undefined, sample.items, sample.rules)).toBe(true)
})
