import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClosedNumericFrameCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/clipped-native-frame-above-separate-note.jsonl'
    )
  )

it('restores a captioned native frame cutting its header and keeps the following note outside the cells', () => {
  const f = load(),
    original = structuredClone(f),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cropRect).toEqual([460.03185, 99.00030000000015, 829.9123500000001, 186.00030000000015])
  expect(r.grid[0]).toEqual(['Primary outcome', 'Active', 'Placebo', 'P value*'])
  expect(r.grid).toHaveLength(3)
  expect(r.grid[2].slice(1)).toEqual(['125.5 (104 to 147)', '132.5 (121.5 to 143.5)', '0.18§'])
  expect(r.grid.flat().some((s: string) => s.includes('Uncorrected'))).toBe(false)
  expect(r.clipped).toEqual([])
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens
      .filter((i: { rect: number[] }) => i.rect[3] <= r.cropRect[3])
      .map((i: { rect: number[] }) => i.rect)
      .sort()
  )
  expect(f).toEqual(original)
})

it.each([
  'top',
  'bottom',
  'left',
  'right',
  'caption',
  'second numeric record',
  'wide detector gap'
])('does not widen an unproved frame without %s', (kind) => {
  const f = load()
  if (kind === 'top')
    f.rules = f.rules.filter((r: number[]) => !(r[1] === r[3] && Math.abs(r[1] - 99.0003) < 0.1))
  if (kind === 'bottom')
    f.rules = f.rules.filter((r: number[]) => !(r[1] === r[3] && Math.abs(r[1] - 186.0003) < 0.1))
  if (kind === 'left') f.rules = f.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] < 500))
  if (kind === 'right') f.rules = f.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] > 800))
  if (kind === 'caption') f.captions = []
  if (kind === 'second numeric record')
    f.tokens = f.tokens.filter((i: { rect: number[] }) => i.rect[1] < 154)
  if (kind === 'wide detector gap') f.table.cropRect[0] += 20
  expect(recoverClosedNumericFrameCrop(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
