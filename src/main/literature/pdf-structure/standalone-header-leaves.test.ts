import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { reconcileRuledLeafHeaderSpans } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/standalone-leaves-beside-nested-cohort-headers.jsonl'
    )
  )
it('joins independent leaf headers across the native band while keeping every nested horizontal span and script', () => {
  const f = fixture(),
    before = structuredClone(f),
    repairs: string[] = []
  reconcileRuledLeafHeaderSpans({ ...f, repairs })
  expect(
    [5, 10, 11].map(
      (column) =>
        f.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
          .rowSpan
    )
  ).toEqual([3, 3, 3])
  expect(f.cells.filter((c: { text: string }) => ['Initial', 'Final'].includes(c.text))).toEqual(
    before.cells.filter((c: { text: string }) => ['Initial', 'Final'].includes(c.text))
  )
  expect(
    f.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5).textRuns
  ).toEqual(
    before.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5)
      .textRuns
  )
  expect(
    f.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(
    before.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  )
  expect(f.items).toEqual(before.items)
  expect(f.rows).toEqual(before.rows)
  expect(repairs).toEqual(['header-span-inferred', 'header-span-inferred', 'header-span-inferred'])
})
it.each([
  'missing top border',
  'missing bottom border',
  'missing group underline',
  'different child labels',
  'different leaf labels',
  'partial partition',
  'independent lower label',
  'interior rule',
  'hidden source text',
  'vertical divider'
])('keeps standalone leaves separate with %s', (kind) => {
  const f = fixture()
  if (kind === 'missing top border') f.rules = f.rules.filter((r: number[]) => r[1] > 749)
  if (kind === 'missing bottom border') f.rules = f.rules.filter((r: number[]) => r[1] < 806)
  if (kind === 'missing group underline')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 767.6924) > 0.1)
  if (kind === 'different child labels')
    f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 6).text =
      'Other time'
  if (kind === 'different leaf labels')
    f.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 7).text =
      'Range'
  if (kind === 'partial partition')
    f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 8).colSpan = 1
  if (kind === 'independent lower label') {
    const c = f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 5)
    c.text = 'Separate'
    c.sourceRects = [[470, 773, 493, 785]]
  }
  if (kind === 'interior rule') f.rules.push([460, 775, 818, 775])
  if (kind === 'hidden source text')
    f.items.push({
      text: 'Independent',
      rect: [470, 774, 493, 786],
      baseline: 786,
      height: 12,
      horizontal: true
    })
  if (kind === 'vertical divider') f.rules.push([480, 748, 480, 806])
  const before = structuredClone(f),
    repairs: string[] = []
  reconcileRuledLeafHeaderSpans({ ...f, repairs })
  if (['independent lower label', 'hidden source text', 'vertical divider'].includes(kind))
    expect(
      f.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5).rowSpan
    ).toBe(1)
  else expect(f).toEqual(before)
})
it.each([0.7, 1.8])('uses font-relative native geometry at scale %s', (scale) => {
  const f = fixture(),
    repairs: string[] = []
  for (const c of [...f.rows, ...f.cells]) c.rect = c.rect.map((v: number) => v * scale)
  for (const c of f.cells) {
    c.sourceRects = c.sourceRects.map((r: number[]) => r.map((v) => v * scale))
    for (const i of c.sourceTokens) {
      i.rect = i.rect.map((v: number) => v * scale)
      i.height *= scale
      i.baseline *= scale
    }
  }
  for (const i of f.items) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  reconcileRuledLeafHeaderSpans({ ...f, repairs })
  expect(repairs).toHaveLength(3)
})
