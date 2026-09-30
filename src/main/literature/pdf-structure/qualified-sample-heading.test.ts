import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-qualified-sample-heading.jsonl'
    )
  )
it('keeps repeated qualifiers and sample sizes with their centered cohort labels inside a native table frame', () => {
  const f = fixture(),
    before = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toEqual([
    'Event category',
    'Control Every 6 Months (n=1709)',
    'Treatment Every 6 Months (n=1711)',
    'Total (N=3420)'
  ])
  expect(r.grid[1]).toEqual(['Any outcome', '368 (21.5)', '309 (18.1)', '677 (19.8)'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
  expect(f).toEqual(before)
})
it.each([
  'different qualifiers',
  'missing top frame',
  'missing closing frame',
  'missing model header',
  'internal header divider',
  'internal column divider',
  'incomplete body',
  'crossed column',
  'different qualifier font'
])('retains separate header bands with %s', (kind) => {
  const f = fixture()
  const qualifier = f.tokens.find((i: { text: string }) => i.text === '6 Months (n')
  if (kind === 'different qualifiers') qualifier.text = '9 Months (n'
  if (kind === 'missing top frame') f.rules = f.rules.filter((r: number[]) => r[1] > 362)
  if (kind === 'missing closing frame') f.rules = f.rules.filter((r: number[]) => r[1] < 950)
  if (kind === 'missing model header')
    f.table.structure.objects = f.table.structure.objects.filter(
      (o: { label: string }) => o.label !== 'table column header'
    )
  if (kind === 'internal header divider') f.rules.push([78, 382, 832, 382])
  if (kind === 'internal column divider') f.rules.push([560, 362, 560, 405])
  if (kind === 'incomplete body')
    f.tokens = f.tokens.filter((i: { rect: number[] }) => i.rect[1] < 440)
  if (kind === 'crossed column') qualifier.rect[2] = 600
  if (kind === 'different qualifier font') qualifier.height *= 1.2
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][1]).not.toContain('6 Months (n=1709)')
})
it('does not fabricate a missing cohort name when existing source recovery can still join the band', () => {
  const f = fixture()
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'Treatment Every')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cells.some((c: { text: string }) => c.text.includes('Treatment Every'))).toBe(false)
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
  expect(r.unassigned).toEqual([])
})
