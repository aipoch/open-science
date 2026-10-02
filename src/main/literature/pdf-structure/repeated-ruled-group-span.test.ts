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
      'src/main/literature/pdf-structure/fixtures/repeated-ruled-group-with-partial-model-span.jsonl'
    )
  )
it('uses native group endpoints to include the first complete record', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    r.cells
      .filter((c: { column: number; row: number }) => c.column === 0 && c.row > 0)
      .map((c: { row: number; rowSpan: number; text: string }) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [1, 3, '2'],
    [4, 3, '3'],
    [7, 3, '4']
  ])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toHaveLength(
    x.tokens.length
  )
})
it.each([
  'missing-separator',
  'missing-value',
  'interior-divider',
  'off-center-category',
  'reordered-record',
  'competing-caption',
  'crossing-ink'
])('requires complete repeated native groups: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-separator') x.rules.splice(2, 1)
  if (mode === 'missing-value') x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '20')
  if (mode === 'interior-divider') x.rules.push([0, 48, 40, 48])
  if (mode === 'off-center-category') {
    const t = x.tokens.find((i: { text: string }) => i.text === '2')
    t.baseline += 9
    t.rect[1] += 9
    t.rect[3] += 9
  }
  if (mode === 'reordered-record') {
    const t = x.tokens.find(
      (i: { text: string; baseline: number }) => i.text === 'Case A' && i.baseline === 80
    )
    t.text = 'Case Z'
  }
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'crossing-ink')
    x.tokens.push({ ...x.tokens[0], text: 'Extra', rect: [30, 30, 50, 40], baseline: 40 })
  expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
    'native-body-records-recovered'
  )
})
