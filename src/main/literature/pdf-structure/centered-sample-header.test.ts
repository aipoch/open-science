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
      'src/main/literature/pdf-structure/fixtures/source-grids/centered-sample-header-with-independent-statistic.jsonl'
    )
  )
it('joins repeated centered sample headings inside the native frame', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0]).toEqual(['', 'Arm (N=15)', 'Control (N=15)', 'Pooled (N=30)', 'P-valuea'])
  expect(t.grid).toHaveLength(24)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(x.tokens.map((i: { text: string }) => i.text).sort())
})
it.each([
  'missing-frame',
  'divider',
  'wrong-sample',
  'missing-sample',
  'unowned-text',
  'misaligned-sample'
])('keeps distinct header bands with %s evidence', (variant) => {
  const x = fixture()
  if (variant === 'missing-frame')
    x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 180) > 1)
  if (variant === 'divider') x.rules.push([117, 205, 545.54, 205])
  if (variant === 'wrong-sample')
    x.tokens.find((i: { text: string }) => i.text === '(N=15)').text = '(other)'
  if (variant === 'missing-sample') {
    const sample = x.tokens.find((i: { text: string }) => i.text === '(N=15)')
    x.tokens = x.tokens.filter((i: unknown) => i !== sample)
  }
  if (variant === 'unowned-text')
    x.tokens.push({
      text: '*',
      rect: [250, 180, 253, 183],
      height: 3,
      baseline: 183,
      horizontal: true
    })
  if (variant === 'misaligned-sample') {
    const sample = x.tokens.find((i: { text: string }) => i.text === '(N=15)')
    sample.rect[0] += 16
    sample.rect[2] += 16
  }
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells.some((c: { text: string }) => c.text === 'Arm (N=15)')).toBe(false)
})
