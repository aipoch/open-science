import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverSplitBorderHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/split-border-wrapped-parent-with-independent-leaves.jsonl'
  )
const recover = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverSplitBorderHeaderBands(f.source, f.cuts, f.rules, f.top, f.bottom)

it.each([
  'unsegmented-top',
  'missing-leaf',
  'shifted-parent',
  'top-gap',
  'misaligned-leaf',
  'off-center-title',
  'no-crossing-title',
  'overlapping-tiers',
  'missing-child',
  'duplicate-child',
  'staggered-child',
  'cross-gutter-child',
  'interior-rule',
  'duplicate-source',
  'rotated-source',
  'inconsistent-font',
  'unowned-source',
  'invalid-cut'
])('rejects a header partition without complete native evidence: %s', (change) => {
  const f = load()
  const parent = f.source.find((i: { text: string }) => i.text === 'patients')
  const child = f.source.find((i: { text: string }) => i.text === 'post')
  if (change === 'unsegmented-top')
    f.rules = [
      ...f.rules.filter((r: number[]) => r[1] === f.bottom),
      [f.cuts[0], 145.38, f.cuts.at(-1), 145.38]
    ]
  if (change === 'missing-leaf')
    f.rules.splice(
      f.rules.findIndex((r: number[]) => r[1] === f.bottom),
      1
    )
  if (change === 'shifted-parent') f.rules[5][2] += 4
  if (change === 'top-gap') f.rules[1][0] += 5
  if (change === 'misaligned-leaf') f.rules[14][2] -= 10
  if (change === 'off-center-title')
    for (const i of f.source.filter(
      (i: { rect: number[] }) => i.rect[0] >= f.cuts[5] && i.rect[3] <= parent.rect[3]
    )) {
      i.rect[0] -= 18
      i.rect[2] -= 18
    }
  if (change === 'no-crossing-title') parent.rect[2] = f.cuts[6] - 1
  if (change === 'overlapping-tiers') parent.rect[3] = child.rect[1] + 1
  if (change === 'missing-child')
    f.source = f.source.filter(
      (i: { rect: number[] }) =>
        !(i.rect[0] >= f.cuts[6] && i.rect[0] < f.cuts[7] && i.rect[1] >= child.rect[1])
    )
  if (change === 'duplicate-child') child.text = 'pre'
  if (change === 'staggered-child') child.rect[1] += 4
  if (change === 'cross-gutter-child') child.rect[0] = f.cuts[6] - 2
  if (change === 'interior-rule') f.rules.push([f.cuts[5], 179, f.cuts[7], 179])
  if (change === 'duplicate-source') f.source.push(parent)
  if (change === 'rotated-source') parent.horizontal = false
  if (change === 'inconsistent-font') parent.height *= 0.5
  if (change === 'unowned-source') f.source.push({ ...parent, rect: [220, 160, 229, 175] })
  if (change === 'invalid-cut') f.cuts[4] = Number.NaN
  expect(recover(f)).toBeUndefined()
})

it.each([0.7, 1, 1.8])('recovers a wrapped native parent and leaves at scale %s', (scale) => {
  const f = load()
  for (const i of f.source) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  f.cuts = f.cuts.map((v: number) => v * scale)
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  f.top *= scale
  f.bottom *= scale
  const t = recover(f)
  expect(t.rows).toHaveLength(2)
  expect(t.spans.find((s: { column: number }) => s.column === 5)).toEqual({
    row: 0,
    column: 5,
    rowSpan: 1,
    colSpan: 2
  })
  expect(
    t.spans
      .filter((s: { colSpan: number }) => s.colSpan === 1)
      .every((s: { rowSpan: number }) => s.rowSpan === 2)
  ).toBe(true)
})

it('retains complete parent, leaf and shared body fields through production refinement', () => {
  const f = readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/centered-shared-fields-between-cited-records.jsonl'
  )
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5)
  ).toMatchObject({ text: '% CTC positive patients', colSpan: 2, rowSpan: 1 })
  expect(t.grid[1].slice(5, 7)).toEqual(['pre NAC', 'post NAC'])
  expect(t.cells.find((c: { text: string }) => c.text === 'Blood volume (mL)')).toMatchObject({
    row: 0,
    rowSpan: 2,
    colSpan: 1
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'TrialAlpha')).toMatchObject({
    row: 2,
    rowSpan: 2
  })
  expect(
    t.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects.map((r) => JSON.stringify(r)))
      .sort()
  ).toEqual(f.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
