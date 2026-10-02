import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledSparseSummaryRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/ruled-sparse-summary-with-merged-model-records.jsonl'
    )
  )
it('keeps independent summaries and centered literal totals without losing source glyphs', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.cells.some((c: { text: string }) => c.text === '463')).toBe(true)
  expect(r.cells.some((c: { text: string }) => /Total size.*Resource line/s.test(c.text))).toBe(
    false
  )
  expect(r.cells.filter((c: { text: string }) => c.text === '336/422 (79%)')).toHaveLength(2)
  expect(r.unassigned).toEqual([])
  const rects = r.cells
    .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
    .map((v: number[]) => JSON.stringify(v))
  expect(rects).toHaveLength(x.tokens.length)
  expect(new Set(rects).size).toBe(x.tokens.length)
})
it.each([
  'missing-footer',
  'missing-section-edge',
  'competing-caption',
  'missing-measurement',
  'overlapping-label',
  'off-center-total'
])('declines incomplete sparse summary proof: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-footer') x.rules = x.rules.filter((r: number[]) => r[1] < 700)
  if (mode === 'missing-section-edge')
    x.rules = x.rules.filter((r: number[]) => r[1] < 434 || r[1] > 436)
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'missing-measurement')
    x.tokens = x.tokens.filter(
      (i: { baseline: number; rect: number[] }) =>
        !(i.baseline > 306 && i.baseline < 308 && i.rect[0] > 660)
    )
  if (mode === 'overlapping-label')
    x.tokens.push({
      ...x.tokens[0],
      text: 'Extra',
      baseline: 372.6461985,
      rect: [445, 359.47, 570, 372.6461985]
    })
  if (mode === 'off-center-total') {
    const t = x.tokens.find((i: { text: string }) => i.text === '463')
    t.rect[0] += 4
    t.rect[2] += 4
  }
  expect(recoverRuledSparseSummaryRecords(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
