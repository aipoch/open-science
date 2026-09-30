import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/leading-subgroup-inside-oversized-model-header.jsonl'
    )
  )
it('extends partial outcome sections through the final statistic column', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-outcome-sections-missing-final-column.jsonl'
    )
  ) as ReturnType<typeof JSON.parse>
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const label of ['Measured outcome C', 'Measured outcome E']) {
    expect(t.cells.find((c: { text: string }) => c.text === label)?.colSpan).toBe(6)
  }
  expect(t.grid).toHaveLength(36)
  expect(t.unassigned).toEqual([])
  expect(t.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens
      .filter((i: { text: string }) => !i.text.startsWith('(Table'))
      .map((i: { rect: number[] }) => i.rect)
      .sort()
  )
})
it('recovers the opening subgroup from repeated source records below a native header border', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === 'First measured outcome')?.colSpan).toBe(
    6
  )
  expect(t.unassigned).toEqual(['(Table 1 continues on next page)'])
  expect(t.grid).toHaveLength(23)
  expect(t.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens
      .filter((i: { text: string }) => !i.text.startsWith('(Table'))
      .map((i: { rect: number[] }) => i.rect)
      .sort()
  )
})
it.each([
  'missing-border',
  'unindented-record',
  'different-record',
  'missing-value',
  'extra-value',
  'missing-peer-spans',
  'text-crossing-border',
  'internal-divider'
])('preserves the opening slots with contradictory %s evidence', (variant) => {
  const x = fixture()
  const heading = x.tokens.find((i: { text: string }) => i.text === 'First measured outcome')
  const first = x.tokens.find((i: { text: string }) => i.text === 'Reference arm')
  if (variant === 'missing-border') x.rules = []
  if (variant === 'missing-peer-spans')
    x.table.structure.objects = x.table.structure.objects.filter(
      (o: { label: string }) => o.label !== 'table projected row header'
    )
  if (variant === 'text-crossing-border')
    x.tokens.push({
      text: '*',
      rect: [90, 740, 94, 748],
      height: 8,
      baseline: 748,
      horizontal: true
    })
  if (variant === 'unindented-record') {
    const dx = heading.rect[0] - first.rect[0]
    first.rect[0] += dx
    first.rect[2] += dx
  }
  if (variant === 'different-record') first.text = 'Unrelated arm'
  if (variant === 'missing-value')
    x.tokens = x.tokens.filter(
      (i: { rect: number[]; baseline: number }) =>
        !(Math.abs(i.baseline - first.baseline) < 1 && i.rect[0] > 590)
    )
  if (variant === 'extra-value')
    x.tokens.push({
      text: '4',
      rect: [280, heading.rect[1], 287, heading.rect[3]],
      height: heading.height,
      baseline: heading.baseline,
      horizontal: true
    })
  if (variant === 'internal-divider')
    x.rules.push([250, heading.rect[1] - 2, 250, heading.rect[3] + 2])
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.find((c: { text: string }) => c.text === 'First measured outcome')?.colSpan
  ).not.toBe(6)
})
