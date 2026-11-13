import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { separateCompleteScriptedRecord } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const original = JSON.parse(
  await readFile(resolve('test/fixtures/scripted-terminal-dimension-records.json'), 'utf8')
)

// The detector ends before two complete four-leaf records. Their ordinary
// text boxes are separate; a uniquely attached script overlaps the next box.
it('retains two complete terminal dimension records with their own whole sources', () => {
  const f = structuredClone(original)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.rows).toHaveLength(2)
  expect(result.cells.map((c: { text: string }) => c.text)).toEqual([
    'Record A vtb',
    '3',
    '(vx, vy, vz)',
    '(vx, −vy, vz)',
    'Record B at',
    '15',
    'Plain record commands',
    'Fa(at)'
  ])
  const claims = result.cells.flatMap((c: Fixture) => c.sourceItems ?? [])
  expect(claims).toHaveLength(f.tokens.length)
  expect(
    new Set(claims.map((s: { pageNumber: number; index: number }) => `${s.pageNumber}:${s.index}`))
      .size
  ).toBe(claims.length)
  expect(claims.sort((a: { index: number }, b: { index: number }) => a.index - b.index)).toEqual(
    f.tokens.map((t: { sourceItem: object }) => t.sourceItem)
  )
  expect(result.cells.every((c: { sourceSegments?: object[] }) => !c.sourceSegments)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
})

const boundary = (f: Fixture): number | undefined => {
  const group = f.tokens.filter((t: Fixture) => t.sourceItem.index >= 23)
  const previous = f.tokens.filter((t: Fixture) => t.sourceItem.index < 23)
  return separateCompleteScriptedRecord({
    row: { rect: [86, 260.5716, 833, 277.617] },
    group,
    items: [...previous, ...group],
    columnRects: [
      [86, 110, 298, 305],
      [298, 110, 336, 305],
      [336, 110, 632, 305],
      [632, 110, 833, 305]
    ],
    objects: []
  })
}

it.each([
  'missing-leaf',
  'wrapped-continuation',
  'duplicate-whole-source',
  'source-literal-mismatch',
  'partial-source',
  'crossing-whole-source',
  'base-font-overlap',
  'foreign-small-glyph',
  'ambiguous-script-owner',
  'incompatible-ordinary-font',
  'noninteger-dimension'
])('does not split a terminal row with incomplete or ambiguous record evidence: %s', (mode) => {
  const f = structuredClone(original)
  if (mode === 'missing-leaf') f.tokens = f.tokens.filter((t: Fixture) => t.sourceItem.index !== 27)
  if (mode === 'wrapped-continuation')
    f.tokens = f.tokens.filter((t: Fixture) => ![23, 24, 25, 26].includes(t.sourceItem.index))
  if (mode === 'duplicate-whole-source')
    f.tokens[26].sourceItem.index = f.tokens[4].sourceItem.index
  if (mode === 'source-literal-mismatch') f.tokens[26].sourceItem.text = '5'
  if (mode === 'partial-source') f.tokens[26].sourceSegment = { start: 0, end: 1 }
  if (mode === 'crossing-whole-source') f.tokens[27].rect[0] = 330
  if (mode === 'base-font-overlap') {
    for (const t of f.tokens.filter((t: Fixture) => t.sourceItem.index >= 23)) {
      t.baseline -= 3
      t.rect[1] -= 3
      t.rect[3] -= 3
    }
  }
  if (mode === 'foreign-small-glyph') {
    f.tokens.push({
      text: 'q',
      sourceItem: { pageNumber: 1, index: 34, text: 'q' },
      horizontal: true,
      height: 4,
      baseline: 280,
      rect: [500, 276, 504, 280]
    })
  }
  if (mode === 'ambiguous-script-owner') {
    // A script halfway between two possible bases cannot acquire a new owner.
    f.tokens[3].baseline = 282
    f.tokens[3].rect[1] = 273.0336
    f.tokens[3].rect[3] = 282
  }
  if (mode === 'incompatible-ordinary-font') f.tokens[27].height = 12
  if (mode === 'noninteger-dimension') {
    f.tokens[26].text = '1.5'
    f.tokens[26].sourceItem.text = '1.5'
  }
  expect(boundary(f)).toBeUndefined()
})

it('keeps ordinary wrapped continuation behavior without a new dimension-qualified stub', () => {
  const f = structuredClone(original)
  f.tokens = f.tokens.filter((t: Fixture) => ![23, 24, 25, 26].includes(t.sourceItem.index))
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.rows).toHaveLength(1)
  expect(result.cells.find((c: Fixture) => c.column === 2)?.text).toContain('Plain record commands')
})

it('retains existing footer refusal and model merged-cell ownership', () => {
  const f = structuredClone(original)
  const withoutFooter = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules.filter((r: number[]) => r[1] < 290)
  )
  expect(withoutFooter.rows).toHaveLength(1)
  const g = structuredClone(original)
  g.table.structure.objects.push({
    label: 'table spanning cell',
    rect: [0, 150, 747, 185],
    score: 1
  })
  const withMergedOwner = refineTable(g.table, g.tokens, g.captions, [], g.rules)
  expect(withMergedOwner.rows).toHaveLength(1)
})
