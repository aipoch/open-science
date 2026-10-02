import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/ruled-scientific-record-with-missing-model-row.jsonl'
    )
  )
it('retains a complete scientific record outside predicted row bands', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.map((v: string[]) => v[0])).toEqual([
    'Record',
    'Case A',
    'Case B',
    'Case C',
    'Case D'
  ])
  expect(r.unassigned).toEqual([])
  const rects = r.cells
    .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
    .map((v: number[]) => JSON.stringify(v))
  expect(new Set(rects).size).toBe(x.tokens.length)
})
it.each([
  'missing-footer',
  'missing-value',
  'competing-caption',
  'crossing-column',
  'detached-exponent'
])('declines incomplete scientific native proof: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-footer') x.rules.pop()
  if (mode === 'missing-value')
    x.tokens = x.tokens.filter(
      (i: { rect: number[]; baseline: number }) =>
        !(i.rect[0] > 395 && i.baseline > 299 && i.baseline < 306)
    )
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'crossing-column')
    x.tokens.push({ ...x.tokens[0], text: 'Extra', rect: [300, 294, 315, 304], baseline: 304 })
  if (mode === 'detached-exponent') {
    const i = x.tokens.find(
      (t: { height: number; baseline: number }) =>
        t.height < 10 && t.baseline > 295 && t.baseline < 304
    )
    expect(i).toBeDefined()
    if (i) {
      i.rect = i.rect.map((v: number, n: number) => (n % 2 === 0 ? v + 15 : v))
      i.baseline -= 5
    }
  }
  const r = recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)
  expect(r?.repair).not.toBe('native-body-records-recovered')
})
