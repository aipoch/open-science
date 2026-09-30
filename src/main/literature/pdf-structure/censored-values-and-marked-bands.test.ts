import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('removes an overlapping empty band between native censored percentage records', () => {
  const x = fixture('duplicate-band-between-censored-percentage-records'),
    source = x.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
  removeEmptyOverlappingRows(x)
  expect(x.rows).toHaveLength(2)
  expect(x.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toEqual(source)
  expect(x.cells.map((c: { text: string }) => c.text)).toEqual([
    'Prior treatment category',
    '260 (>99%)',
    '262 (>99%)',
    'Treatment category',
    '260 (>99%)',
    '262 (>99%)'
  ])
})
it('uses cross marks and a ruled header to omit the phantom schedule row', () => {
  const x = fixture('cross-mark-schedule-with-empty-header-divider'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(10)
  expect(t.grid.every((row: string[]) => row.some(Boolean))).toBe(true)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(x.tokens.map((i: { text: string }) => i.text).sort())
  expect(
    t.grid.some((r: string[]) => r[0] === 'Intervention (total sessions range from #9 to 16)')
  ).toBe(true)
})
const { recoverRuledColumnGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
it.each(['<', '≤', '≥'])(
  'retains native %s comparison text while removing only the overlap',
  (symbol) => {
    const x = fixture('duplicate-band-between-censored-percentage-records')
    for (const c of x.cells) {
      c.text = c.text.replaceAll('>', symbol)
      for (const t of c.sourceTokens) t.text = t.text.replaceAll('>', symbol)
    }
    removeEmptyOverlappingRows(x)
    expect(x.rows).toHaveLength(2)
    expect(x.cells[1].text).toBe(`260 (${symbol}99%)`)
  }
)
it.each(['rule', 'unowned-token', 'span', 'text-value'])(
  'preserves the empty band with contradictory %s evidence',
  (variant) => {
    const x = fixture('duplicate-band-between-censored-percentage-records')
    if (variant === 'rule') x.rules.push([400, 688, 843, 688])
    if (variant === 'unowned-token')
      x.items.push({
        text: '*',
        rect: [500, 686, 504, 690],
        height: 4,
        baseline: 690,
        horizontal: true
      })
    if (variant === 'span') x.cells[0].rowSpan = 2
    if (variant === 'text-value') x.cells[1].text = 'not reported'
    const before = structuredClone(x)
    removeEmptyOverlappingRows(x)
    expect(x).toEqual(before)
  }
)
it.each([
  'numeric-value',
  'missing-header',
  'missing-divider',
  'duplicate-mark',
  'unmarked-record'
])('declines cross-mark recovery with %s', (variant) => {
  const x = fixture('cross-mark-schedule-with-empty-header-divider')
  if (variant === 'numeric-value') x.tokens.find((i: { text: string }) => i.text === 'X').text = '5'
  if (variant === 'missing-header')
    x.tokens = x.tokens.filter((i: { rect: number[] }) => !(i.rect[0] > 750 && i.rect[3] < 873))
  if (variant === 'missing-divider')
    x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 873.524) > 1)
  if (variant === 'duplicate-mark')
    x.tokens.push(structuredClone(x.tokens.find((i: { text: string }) => i.text === 'X')))
  if (variant === 'unmarked-record')
    x.tokens.push({
      text: 'Independent record',
      rect: [268, 1027, 400, 1040],
      height: 12.7,
      baseline: 1040,
      horizontal: true
    })
  expect(recoverRuledColumnGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
