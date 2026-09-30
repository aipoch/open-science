import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { reconcileSharedReferenceFields } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/centered-shared-fields-between-cited-records.jsonl'
  )

const cellsInput = (): ReturnType<typeof JSON.parse> => {
  const f = load()
  for (const c of f.cells) {
    c.sourceTokens = c.sourceTokenIndices.map((n: number) => f.tokens[n])
    c.sourceRects = c.sourceTokens.map((i: { rect: number[] }) => i.rect)
  }
  return { ...f, items: f.tokens, unassigned: [], repairs: [] }
}

it.each([
  'no-witness',
  'source-witness',
  'missing-current-reference',
  'fewer-references',
  'missing-borders',
  'off-center',
  'misaligned-field',
  'data-in-empty-slot',
  'duplicate-owner',
  'missing-native-source',
  'duplicate-native-source',
  'partial-results',
  'non-numeric-result',
  'misplaced-result',
  'cross-gutter',
  'unassigned-source',
  'row-rule',
  'column-rule',
  'incomplete-field',
  'conflicting-span'
])('keeps independent records without shared-field evidence: %s', (change) => {
  const f = cellsInput()
  const witness = f.cells.find((c: { text: string }) => c.text === 'TrialAlpha')
  const field = f.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 2)
  const empty = f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 2)
  const result = f.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 8)
  if (change === 'no-witness') witness.rowSpan = 1
  if (change === 'source-witness') witness.origin = 'source-ruled-stub'
  if (change === 'missing-current-reference')
    f.cells.find((c: { text: string }) => c.text.startsWith('ScholarBeta')).text =
      'unverified reference'
  if (change === 'fewer-references')
    for (const c of f.cells.filter((c: { text: string }) => /Scholar(?:Gamma|Delta)/.test(c.text)))
      c.text = 'unverified reference'
  if (change === 'missing-borders') f.rules = []
  if (change === 'off-center') witness.rect[1] -= 20
  if (change === 'misaligned-field') field.sourceTokens[0].baseline += 5
  if (change === 'data-in-empty-slot') {
    const value = {
      ...field.sourceTokens[0],
      text: 'alternative field',
      baseline: 240,
      rect: field.sourceTokens[0].rect.map((v: number, n: number) => (n % 2 ? v - 30 : v))
    }
    empty.text = value.text
    empty.sourceTokens.push(value)
    f.items.push(value)
  }
  if (change === 'duplicate-owner') empty.sourceTokens.push(field.sourceTokens[0])
  if (change === 'missing-native-source') f.items.pop()
  if (change === 'duplicate-native-source') f.items.push(f.items[0])
  if (change === 'partial-results') result.sourceTokens = []
  if (change === 'non-numeric-result') result.text = 'unverified result'
  if (change === 'misplaced-result') result.sourceTokens[0].rect[1] = 210
  if (change === 'cross-gutter') field.sourceTokens[0].rect[0] = 310
  if (change === 'unassigned-source') f.unassigned.push('unowned field')
  if (change === 'row-rule') f.rules.push([330, 285, 440, 285])
  if (change === 'column-rule') f.rules.push([350, 210, 350, 400])
  if (change === 'incomplete-field') field.text = ''
  if (change === 'conflicting-span') field.rowSpan = 2
  const before = structuredClone(f.cells)
  reconcileSharedReferenceFields(f)
  expect(f.cells).toEqual(before)
  expect(f.repairs).toEqual([])
})

it.each([0.7, 1.8])('preserves shared native field geometry at scale %s', (scale) => {
  const f = cellsInput()
  for (const i of f.items) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.baseline *= scale
    i.height *= scale
  }
  for (const c of f.cells) {
    c.rect = c.rect.map((v: number) => v * scale)
    c.sourceRects = c.sourceTokens.map((i: { rect: number[] }) => i.rect)
  }
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  reconcileSharedReferenceFields(f)
  for (const column of [2, 3, 4, 5, 6, 7])
    expect(
      f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === column)
        .rowSpan
    ).toBe(2)
})

it('retains shared study fields across two independent references through the production refiner', () => {
  const f = load(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const witness = t.cells.find((c: { text: string }) => c.text === 'TrialAlpha')
  expect(witness.rowSpan).toBe(2)
  for (const column of [2, 3, 4, 5, 6, 7]) {
    const shared = t.cells.find(
      (c: { row: number; column: number; text: string }) =>
        c.row >= witness.row && c.column === column && c.text
    )
    expect(shared.row).toBe(witness.row)
    expect(shared.rowSpan).toBe(2)
  }
  const regions = t.cells
    .flatMap((c: { sourceRects: number[][] }) => c.sourceRects.map((r) => JSON.stringify(r)))
    .sort()
  expect(regions).toEqual(f.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(t.unassigned).toEqual([])
})
