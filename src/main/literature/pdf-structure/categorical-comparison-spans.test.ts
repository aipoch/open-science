import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { reconcileCategoricalComparisons } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/centered-comparisons-across-complete-category-sections.jsonl'
  )
const source = (cells: ReturnType<typeof JSON.parse>): string[] =>
  cells
    .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    .map((i: { text: string; rect: number[] }) => JSON.stringify([i.text, i.rect]))
    .sort()

it.each([0.7, 1, 1.8])(
  'merges only complete categorical comparison scopes at scale %s',
  (scale) => {
    const f = load()
    for (const r of [
      ...f.cells.map((c: { rect: number[] }) => c.rect),
      ...f.items.map((i: { rect: number[] }) => i.rect),
      ...f.cells.flatMap((c: { sourceTokens: { rect: number[] }[] }) =>
        c.sourceTokens.map((i) => i.rect)
      ),
      ...f.rules
    ])
      for (let i = 0; i < 4; i++) r[i] *= scale
    for (const i of [
      ...f.items,
      ...f.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    ]) {
      i.height *= scale
      i.baseline *= scale
    }
    const before = source(f.cells)
    reconcileCategoricalComparisons(f)
    for (const row of [5, 8, 25, 28])
      for (const column of [4, 7, 10])
        expect(
          f.cells.find((c: { row: number; column: number }) => c.row === row && c.column === column)
            .rowSpan
        ).toBe(2)
    for (const row of [12, 22])
      for (const column of [4, 7, 10])
        expect(
          f.cells.find((c: { row: number; column: number }) => c.row === row && c.column === column)
            .rowSpan
        ).toBe(1)
    expect(source(f.cells)).toEqual(before)
    expect(f.repairs).toHaveLength(4)
  }
)

it.each([
  'unassigned',
  'rotated',
  'duplicate-source',
  'missing-source',
  'missing-frame',
  'different-leaf',
  'missing-parent',
  'unindented',
  'interior-rule',
  'blank-probability',
  'off-center',
  'independent-values',
  'partial-count'
])('does not merge statistically ambiguous scopes: %s', (mode) => {
  const f = load()
  const targets = f.cells.filter(
    (c: { row: number; column: number; sourceTokens: unknown[] }) =>
      c.column === 4 && c.sourceTokens.length && !f.headerRows.includes(c.row)
  )
  if (mode === 'unassigned') f.unassigned.push(f.items[0])
  if (mode === 'rotated') f.items[0].horizontal = false
  if (mode === 'duplicate-source') f.items.push(structuredClone(f.items[0]))
  if (mode === 'missing-source') f.items.pop()
  if (mode === 'missing-frame') f.rules = []
  if (mode === 'different-leaf')
    f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 7).text =
      'Significance'
  if (mode === 'missing-parent')
    f.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5).colSpan = 1
  if (mode === 'unindented')
    for (const c of f.cells.filter(
      (c: { column: number; row: number }) => c.column === 0 && c.row > 1
    ))
      c.sourceTokens.forEach((i: { rect: number[] }) => {
        i.rect[0] = 100
      })
  if (mode === 'interior-rule')
    for (const c of targets) f.rules.push([c.rect[0], c.rect[1] + 2, c.rect[2], c.rect[1] + 2])
  if (mode === 'blank-probability') for (const c of targets) c.text = ''
  if (mode === 'off-center')
    for (const c of targets)
      for (const i of c.sourceTokens) {
        i.rect[1] += 5
        i.rect[3] += 5
      }
  if (mode === 'independent-values')
    for (const row of [5, 8, 25, 28]) {
      const c = f.cells.find(
        (c: { row: number; column: number; sourceTokens: unknown[] }) =>
          c.row === row && c.column === 4 && !c.sourceTokens.length
      )
      if (c) {
        const i = structuredClone(targets[0].sourceTokens[0])
        i.text = '0.12'
        i.rect = [c.rect[0] + 2, c.rect[1] + 2, c.rect[0] + 25, c.rect[1] + 2 + i.height]
        i.baseline = i.rect[3]
        c.text = i.text
        c.sourceTokens.push(i)
      }
    }
  if (mode === 'partial-count')
    for (const c of f.cells.filter(
      (c: { column: number; row: number }) => c.column === 1 && c.row > 1
    ))
      c.text = 'Unknown'
  if (['unindented', 'off-center', 'independent-values'].includes(mode))
    f.items = structuredClone(f.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens))
  const before = structuredClone(f.cells)
  reconcileCategoricalComparisons(f)
  expect(f.cells).toEqual(before)
  expect(f.repairs).toEqual([])
})

it('applies the spans through production table refinement while retaining every native source rectangle', () => {
  const f = readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/segmented-cohort-header-with-detached-terminal-counts.jsonl'
  )
  const t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(
    t.cells.filter(
      (c: { column: number; rowSpan: number }) => [4, 7, 10].includes(c.column) && c.rowSpan === 2
    )
  ).toHaveLength(12)
  expect(t.unassigned).toEqual([])
  expect(t.cells.flatMap((c: { sourceRects: unknown[] }) => c.sourceRects)).toHaveLength(375)
})
