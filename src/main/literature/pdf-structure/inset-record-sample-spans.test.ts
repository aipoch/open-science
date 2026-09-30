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
      'src/main/literature/pdf-structure/fixtures/source-grids/inset-record-rules-with-centered-sample-spans.jsonl'
    )
  )
it('retains counts inside their ruled body groups and owns the intervening subgroup heading', () => {
  const x = fixture(),
    result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.cells.find((c: { text: string }) => c.text === '60')).toMatchObject({
    row: 2,
    column: 2,
    rowSpan: 3
  })
  expect(result.cells.find((c: { text: string }) => c.text === '27')).toMatchObject({
    row: 2,
    column: 3,
    rowSpan: 3
  })
  expect(result.cells.find((c: { text: string }) => c.text === '42')).toMatchObject({
    row: 6,
    column: 2,
    rowSpan: 4
  })
  expect(result.cells.find((c: { text: string }) => c.text === '9')).toMatchObject({
    row: 6,
    column: 3,
    rowSpan: 4
  })
  expect(
    result.cells.find((c: { text: string }) => c.text === 'Subgroup with additional measurements')
  ).toMatchObject({ row: 5, column: 0, colSpan: 12 })
  expect(result.cells.find((c: { text: string }) => c.text === 'Group A')).toMatchObject({
    column: 3,
    colSpan: 4
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Group B')).toMatchObject({
    column: 7,
    colSpan: 4
  })
  expect(
    result.cells
      .filter((c: { text: string }) => c.text === '33')
      .map((c: { row: number; rowSpan: number }) => [c.row, c.rowSpan])
  ).toEqual([
    [2, 3],
    [6, 4]
  ])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(x.tokens.map((i: { text: string }) => i.text).sort())
})
const { recoverInsetRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
it.each([
  'missing-leaf',
  'partial-edge',
  'crossed-rule',
  'count-label',
  'two-counts',
  'duplicate',
  'off-center-title',
  'broken-section-border'
])('declines incomplete or contradictory native faces: %s', (variant) => {
  const x = fixture()
  const tokens = x.tokens as { text: string; rect: number[]; baseline: number; height: number }[]
  if (variant === 'missing-leaf')
    tokens.splice(
      tokens.findIndex((i) => i.text === '0.7'),
      1
    )
  if (variant === 'partial-edge') x.rules.push([370, 278.247, 375, 278.247])
  if (variant === 'partial-edge')
    x.rules = x.rules.filter(
      (r: number[]) => !(r[1] > 278 && r[1] < 279 && r[0] < 360 && r[2] > 500)
    )
  if (variant === 'crossed-rule') tokens.find((i) => i.text === '0.7')!.rect[3] = 280
  if (variant === 'count-label') tokens.find((i) => i.text === '60')!.text = 'unknown'
  if (variant === 'two-counts')
    tokens.push({
      ...tokens.find((i) => i.text === '60')!,
      text: '61',
      rect: [285, 250, 299, 263],
      baseline: 263
    })
  if (variant === 'duplicate') tokens.push(tokens[0])
  if (variant === 'off-center-title') {
    const i = tokens.find((i) => i.text.startsWith('Subgroup'))!
    i.rect[0] -= 60
    i.rect[2] -= 60
  }
  if (variant === 'broken-section-border')
    x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 382.0455) > 0.1)
  expect(recoverInsetRecordFaces(x.table, tokens, x.captions, x.rules)).toBeUndefined()
})
it('accepts separately painted parent underlines with the same repeated leaf evidence', () => {
  const x = fixture()
  x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 198.0885) > 0.1)
  x.rules.push([314.604, 198.0885, 522.24, 198.0885], [530, 198.0885, 773.077, 198.0885])
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.cells.find((c: { text: string }) => c.text === '60')).toMatchObject({
    row: 2,
    rowSpan: 3
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Group A')).toMatchObject({
    colSpan: 4
  })
})
it('does not spread a top-aligned count across unseparated blank records', () => {
  const x = fixture(),
    count = x.tokens.find((i: { text: string }) => i.text === '60')
  count.rect = [285, 250, 299, 263]
  count.baseline = 263
  expect(recoverInsetRecordFaces(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
