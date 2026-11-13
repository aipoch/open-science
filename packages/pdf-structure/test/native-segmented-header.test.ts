import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousSegmentedHeaderRecords: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/segmented-header-records.mjs')).href
)
const { recoverNativeSegmentedHeaderRecords: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-segmented-header.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const plan = (f: ReturnType<typeof fixture>): ReturnType<typeof recover> =>
  recover(f.table, f.tokens, f.captions, f.rules, f.context)
const result = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )

it.each(['empty-stub', 'uncertainty'])(
  'rebuilds complete physical records from paired header segments: %s',
  (kind) => {
    const f = fixture(kind),
      p = plan(f)
    expect(p?.repair).toBe('native-segmented-header-records-recovered')
    const out = result(f)
    expect(out.grid).toHaveLength(5)
    expect(out.grid.every((r: string[]) => r.length === 4)).toBe(true)
    expect(out.repairs).toContain('native-segmented-header-records-recovered')
    expect(out.issues).toEqual([])
    const refs = out.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .map((s: { index: number }) => s.index)
    expect(new Set(refs).size).toBe(refs.length)
    expect(refs.sort((a: number, b: number) => a - b)).toEqual(
      f.tokens.slice(1).map((t: { sourceItem: { index: number } }) => t.sourceItem.index)
    )
    if (kind === 'empty-stub') expect(out.grid[0][0]).toBe('')
    else {
      expect(out.grid[4][0]).toBe('4')
      expect(out.grid[4][1]).toMatch(/10\s*±\s*1/u)
      expect(out.grid[4][2]).toBe('20 ± 2')
      expect(
        out.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)
          .textRuns
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ position: 'superscript', text: '2' })])
      )
    }
  }
)

it.each([
  'missing-outline',
  'crossed-field',
  'foreign-paint',
  'late-backdrop',
  'duplicate-source',
  'wrong-caption',
  'incomplete-rail'
])('does not certify incomplete or competing source evidence: %s', (fault) => {
  const f = fixture('uncertainty')
  if (fault === 'missing-outline') f.native.glyphBounds[0].glyphs.pop()
  if (fault === 'crossed-field') {
    const t = f.tokens[2]
    t.rect[2] = 140
  }
  if (fault === 'foreign-paint') f.fill([100, 120, 130, 125])
  if (fault === 'late-backdrop') f.fill([20, 80.25, 64, 95.75], '#ffffff')
  if (fault === 'duplicate-source') f.tokens.push({ ...f.tokens[2] })
  if (fault === 'wrong-caption') f.captions[0].lines = ['Figure 1: Values.']
  if (fault === 'incomplete-rail') f.rules.splice(0, 1)
  expect(plan(f)?.groups).toBeUndefined()
})

it('does not split a whole source object crossing a physical leaf boundary', () => {
  const f = fixture('uncertainty')
  f.text('whole object spans two leaves', 100, 145)
  expect(plan(f)?.groups).toBeUndefined()
})

it('retains the complete foreign glyph inventory when a margin token is omitted', () => {
  const f = fixture('uncertainty')
  f.text('Note', 20, 210)
  f.tokens.pop()
  expect(plan(f)?.repair).toBe('native-segmented-header-records-recovered')
})

it('marks a paired native frame with unavailable glyph proof for review', () => {
  const f = fixture('uncertainty')
  f.native.glyphBounds[0].glyphs.pop()
  const out = result(f)
  expect(out.reviewCandidate).toBe(false)
  expect(out.issues).toContain('native-table-structure-ambiguous')
})

it('leaves an incomplete rail family to the existing complete native grid', () => {
  const f = fixture('full-stub'),
    expected = result(f)
  // All source glyphs fit, but the final paired rail ends outside this seed.
  f.table.cropRect[2] = 222
  expect(plan(f)).toBeUndefined()
  const out = result(f)
  expect(out.grid).toEqual(expected.grid)
  expect(out.grid).toHaveLength(5)
  expect(out.grid.every((row: string[]) => row.length === 4)).toBe(true)
  expect(out.issues).toEqual([])
  expect(out.repairs).not.toContain('native-segmented-header-records-recovered')
  const refs = out.cells.flatMap(
    (cell: { sourceItems?: { index: number }[] }) => cell.sourceItems ?? []
  )
  expect(refs.map((item: { index: number }) => item.index).sort((a, b) => a - b)).toEqual(
    f.tokens.slice(1).map((token: { sourceItem: { index: number } }) => token.sourceItem.index)
  )
})

it('does not join a disjoint neighboring closing rail across its printed gap', () => {
  const f = fixture('full-stub')
  f.fill([250, 161.75, 270, 162.25])
  f.rules.push([250, 162, 270, 162])
  expect(plan(f)?.repair).toBe('native-segmented-header-records-recovered')
  expect(result(f).issues).toEqual([])
})

it.each(['foreign-paint', 'missing-outline', 'changed-native-source'])(
  'still flags incomplete native proof inside a complete rail family: %s',
  (fault) => {
    const f = fixture('full-stub')
    if (fault === 'foreign-paint') f.fill([100, 120, 130, 125])
    if (fault === 'missing-outline') f.native.glyphBounds[0].glyphs.pop()
    if (fault === 'changed-native-source') {
      f.context.sourceContent = structuredClone(f.context.sourceContent)
      f.context.sourceContent.items[1].str = 'changed'
    }
    expect(plan(f)?.ambiguous).toBe(true)
    expect(result(f).issues).toContain('native-table-structure-ambiguous')
  }
)
