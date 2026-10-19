import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeScalarRecordPlan } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-scalar-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-complete-scalar-count-records.jsonl'))

it('keeps complete mean, deviation and count fields in their native lanes', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid).toEqual([
    ['Case', 'Mode', 'Result A', 'Result B', 'Result C'],
    ['Alpha', 'Group', '2.4 ± 1.2 (3)', '2.4 ± 1.2 (3)', '2.4 ± 1.2 (3)'],
    ['Beta', 'Group', '3.4 ± 1.2 (3)', '3.4 ± 1.2 (3)', '3.4 ± 1.2 (3)'],
    ['Gamma', 'Group', '4.4 ± 1.2 (3)', '4.4 ± 1.2 (3)', '4.4 ± 1.2 (3)']
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(JSON.stringify(x)).toBe(before)
})

it.each([
  'caption',
  'closure',
  'numeric field',
  'foreign baseline',
  'font',
  'header crossing',
  'overlapping rows'
])('declines incomplete source proof: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'closure') x.rules.pop()
  if (variant === 'numeric field')
    x.items = x.items.filter(
      (i: { rect: number[]; baseline: number }) => !(i.baseline === 70 && i.rect[0] >= 375)
    )
  if (variant === 'foreign baseline')
    x.items.push({
      text: 'Independent text',
      horizontal: true,
      height: 10,
      baseline: 61,
      rect: [170, 51, 250, 61]
    })
  if (variant === 'font') x.items[6].height = 18
  if (variant === 'header crossing') x.items[3].rect = [210, 15, 300, 25]
  if (variant === 'overlapping rows')
    x.items
      .filter((i: { baseline: number }) => i.baseline === 70)
      .forEach((i: { rect: number[] }) => {
        i.rect[1] = 45
      })
  expect(
    recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules),
    variant
  ).toBeUndefined()
})

it('preserves a model whose complete native records already fit', () => {
  const x = fixture(),
    p = recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)
  x.table.structure.objects = x.table.structure.objects
    .filter((o: { label: string }) => o.label !== 'table column')
    .concat(
      p.grid.columns.map((r: number[]) => ({
        label: 'table column',
        score: 1,
        rect: [r[0], r[1] - 10, r[2], r[3] - 10]
      }))
    )
  expect(recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})

it('projects a fused field tail only at its uniquely measured native whitespace', () => {
  const x = fixture(),
    at = x.items.findIndex(
      (i: { baseline: number; rect: number[] }) => i.baseline === 50 && i.rect[0] === 226
    )
  const fused = { ...x.items[at], text: '(3) 2', rect: [226, 40, 282, 50] }
  x.items.splice(at, 2, fused)
  const observation = {
    text: fused.text,
    rect: [...fused.rect],
    glyphRuns: [1, 1, 1, 1],
    gaps: [{ left: 243, right: 275, index: 3 }]
  }
  expect(recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  const p = recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules, [observation])
  expect(
    p?.pageItems
      .filter(
        (i: { baseline: number; rect: number[] }) =>
          i.baseline === 50 && i.rect[0] >= 226 && i.rect[2] <= 282
      )
      .map((i: { text: string; rect: number[] }) => [i.text, i.rect])
  ).toEqual([
    ['(3)', [226, 40, 243, 50]],
    ['2', [275, 40, 282, 50]]
  ])
  for (const variant of ['ambiguous run', 'outside gap', 'nonunique observation']) {
    const observations = structuredClone([observation])
    if (variant === 'ambiguous run') observations[0].glyphRuns[3] = 2
    if (variant === 'outside gap') observations[0].gaps[0].right = 300
    if (variant === 'nonunique observation') observations.push(structuredClone(observations[0]))
    expect(
      recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules, observations),
      variant
    ).toBeUndefined()
  }
})

it('requires three complete compound fields in each record for a two-record table', () => {
  const x = fixture()
  x.items = x.items.filter((i: { baseline: number }) => i.baseline !== 90)
  x.rules[2] = [0, 80, 500, 80]
  const p = recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)
  expect(p?.grid.rows).toHaveLength(3)
  x.items = x.items.filter((i: { rect: number[] }) => i.rect[0] < 375)
  expect(recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})

function closeDescriptorHeaders(): ReturnType<typeof JSON.parse> {
  const x = fixture()
  x.items[0].text = 'Case label'
  x.items[0].rect[2] = 105
  const cuts = [0, 108, 150, 250, 350, 500]
  x.table.structure.objects = x.table.structure.objects
    .filter((o: { label: string }) => o.label !== 'table column')
    .concat(
      cuts.slice(1).map((right, n) => ({
        label: 'table column',
        score: 1,
        rect: [cuts[n], 0, right, 91]
      }))
    )
  return x
}

it('does not erase a model descriptor boundary shared by complete header and body records', () => {
  const x = closeDescriptorHeaders()
  expect(recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid.map((r: string[]) => r.slice(0, 2))).toEqual([
    ['Case label', 'Mode'],
    ['Alpha', 'Group'],
    ['Beta', 'Group'],
    ['Gamma', 'Group']
  ])
  expect(result.grid.every((r: string[]) => r.length === 5)).toBe(true)
  expect(result.unassigned).toEqual([])
})

it.each(['no model boundary', 'header crosses boundary', 'record crosses boundary'])(
  'does not infer an independent descriptor lane from proximity alone: %s',
  (variant) => {
    const x = closeDescriptorHeaders()
    if (variant === 'no model boundary')
      x.table.structure.objects = x.table.structure.objects.filter(
        (o: { label: string; rect: number[] }) => !(o.label === 'table column' && o.rect[0] === 108)
      )
    if (variant === 'header crosses boundary') x.items[0].rect[2] = 109
    if (variant === 'record crosses boundary') x.items[5].rect[2] = 109
    expect(
      recoverNativeScalarRecordPlan(x.table, x.items, x.captions, x.rules)?.grid.columns
    ).toHaveLength(4)
  }
)
