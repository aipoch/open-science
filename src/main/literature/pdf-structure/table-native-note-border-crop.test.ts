import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { trimTableNoteCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
type Fixture = {
  cropRect: number[]
  table: {
    cropRect: number[]
    cells: { sourceRects: number[][] }[]
    unassigned: { rect: number[] }[]
  }
  notes: { rect: number[] }[]
  contentRect: number[]
  scale: number
  sourceRules: number[][]
}
function fixture(): Fixture {
  return {
    cropRect: [0, 0, 300, 110],
    table: {
      cropRect: [0, 0, 300, 110],
      cells: [
        {
          sourceRects: [
            [5, 50, 80, 60],
            [105, 70, 180, 80]
          ]
        }
      ],
      unassigned: [] as { rect: number[] }[]
    },
    notes: [{ rect: [5, 99.8, 295, 109.8] }],
    contentRect: [0, 0, 300, 80],
    scale: 1,
    sourceRules: [[0, 100, 300, 100]]
  }
}
it('retains the uniquely owned closing rule where a note font box slightly overlaps it', () => {
  const f = fixture()
  trimTableNoteCrop(f)
  expect(f.cropRect).toEqual([0, 0, 300, 100.5])
})
it.each([
  'no closing rule',
  'competing rules',
  'short rule',
  'outside original crop',
  'unresolved cell',
  'distant note'
])('does not use %s to enlarge a note crop', (kind) => {
  const f = fixture()
  if (kind === 'no closing rule') f.sourceRules = []
  if (kind === 'competing rules') f.sourceRules.push([0, 99.5, 300, 99.5])
  if (kind === 'short rule') f.sourceRules = [[50, 100, 250, 100]]
  if (kind === 'outside original crop') f.cropRect[3] = 96
  if (kind === 'unresolved cell') f.table.unassigned = [{ rect: [5, 90, 20, 100] }]
  if (kind === 'distant note') f.notes[0].rect = [5, 90, 295, 110]
  trimTableNoteCrop(f)
  expect(f.cropRect[3]).toBeLessThanOrEqual(kind === 'outside original crop' ? 96 : 98.8)
})
it('never cuts source cell ink crossing a proposed closing rule', () => {
  const f = fixture()
  f.table.cells[0].sourceRects.push([5, 95, 25, 105])
  trimTableNoteCrop(f)
  expect(f.cropRect[3]).toBe(110)
})

function insetFixture(): Fixture {
  return JSON.parse(
    readFileSync(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/native-inset-closing-rule-before-note.jsonl'
      ),
      'utf8'
    )
  )
}
it('retains a segmented native closing frame inset within detector padding', () => {
  const f = insetFixture()
  trimTableNoteCrop(f)
  expect(f.cropRect[3]).toBe(100.5)
})
it.each([
  'missing opening',
  'different opening endpoints',
  'excessive padding',
  'ink outside frame',
  'competing closing',
  'unresolved ink'
])('does not infer an inset closing frame with %s', (kind) => {
  const f = insetFixture()
  if (kind === 'missing opening') f.sourceRules = f.sourceRules.filter((r) => r[1] === 100)
  if (kind === 'different opening endpoints') f.sourceRules[0][0] = 18
  if (kind === 'excessive padding') f.cropRect[0] = -10
  if (kind === 'ink outside frame') f.table.cells[0].sourceRects[0][0] = 0
  if (kind === 'competing closing') f.sourceRules.push([8, 99.5, 296, 99.5])
  if (kind === 'unresolved ink') f.table.unassigned.push({ rect: [8, 80, 30, 90] })
  trimTableNoteCrop(f)
  expect(f.cropRect[3]).toBe(99.2)
})
