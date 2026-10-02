import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const {
  getNativePairedTextContextDirection,
  recoverNativePairedTextRecordGrid,
  recoverNativePairedTextCaption
} = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-bounded-text-record-grid.mjs')
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-terminal-paired-text-records.jsonl'
    )
  )
function wrappedFixture(): ReturnType<typeof JSON.parse> {
  const x = fixture(),
    p = x.previous
  p.height = x.current.height = 340
  p.tokens.forEach((i: { rect: number[]; baseline: number }) => {
    i.rect[1] += 20
    i.rect[3] += 20
    i.baseline += 20
    if (i.baseline >= 290) {
      i.rect[1] += 12
      i.rect[3] += 12
      i.baseline += 12
    }
  })
  p.rules.forEach((r: number[]) => {
    r[1] += 20
    r[3] += 20
  })
  p.captions[0].rect[1] += 20
  p.captions[0].rect[3] += 20
  p.table.cropRect = [10, 230, 230, 334]
  p.tokens[4].rect[2] = 101
  p.tokens.push({
    text: 'Short native tail',
    rect: [20, 280, 40, 290],
    height: 10,
    baseline: 290,
    horizontal: true
  })
  return x
}
it('retains a unique short left-field wrap before the next complete pair', () => {
  const x = wrappedFixture(),
    p = x.previous,
    context = { ...x.current, currentHeight: p.height }
  const g = recoverNativePairedTextRecordGrid(p.table, p.tokens, p.captions, p.rules, context)
  expect(g?.rows).toHaveLength(5)
  const r = refineTable(p.table, p.tokens, p.captions, [], p.rules, [], context)
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0)?.sourceRects
  ).toContainEqual(p.tokens.at(-1).rect)
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((a: number[]) => JSON.stringify(a))
      .sort()
  ).toEqual(p.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})
it.each(['short prior field', 'long tail', 'value-only tail', 'second tail'])(
  'rejects a wrap without unique continuation geometry: %s',
  (variant) => {
    const x = wrappedFixture(),
      p = x.previous
    if (variant === 'short prior field') p.tokens[4].rect[2] = 60
    if (variant === 'long tail') p.tokens.at(-1).rect[2] = 65
    if (variant === 'value-only tail') p.tokens.at(-1).rect = [110, 280, 130, 290]
    if (variant === 'second tail')
      p.tokens.push({ ...p.tokens.at(-1), rect: [20, 292, 40, 302], baseline: 302 })
    expect(
      recoverNativePairedTextRecordGrid(p.table, p.tokens, p.captions, p.rules, {
        ...x.current,
        currentHeight: p.height
      })
    ).toBeUndefined()
  }
)
it('recovers complete page-local pairs only after both native frames and the original formal title agree', () => {
  const x = fixture()
  for (const [current, adjacent, direction] of [
    [x.previous, x.current, 1],
    [x.current, x.previous, -1]
  ]) {
    const context = { ...adjacent, currentHeight: current.height }
    expect(
      getNativePairedTextContextDirection(
        current.table,
        current.tokens,
        current.captions,
        current.rules,
        current.height
      )
    ).toBe(direction)
    const g = recoverNativePairedTextRecordGrid(
      current.table,
      current.tokens,
      current.captions,
      current.rules,
      context
    )
    expect(g?.rows).toHaveLength(5)
    const r = refineTable(
      current.table,
      current.tokens,
      current.captions,
      [],
      current.rules,
      [],
      context
    )
    expect(r.grid).toHaveLength(5)
    expect(r.unassigned).toEqual([])
    expect(
      r.cells
        .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
        .map((r: number[]) => JSON.stringify(r))
        .sort()
    ).toEqual(current.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  }
  const c = recoverNativePairedTextCaption(
    x.current.table,
    x.current.tokens,
    x.current.captions,
    x.current.rules,
    { ...x.previous, currentHeight: x.current.height }
  )
  expect(c).toBe(x.previous.captions[0])
  expect(
    recoverNativePairedTextCaption(
      x.previous.table,
      x.previous.tokens,
      x.previous.captions,
      x.previous.rules,
      { ...x.current, currentHeight: x.previous.height }
    )
  ).toBeUndefined()
})
it.each([
  'missing context',
  'missing prior title',
  'competing prior title',
  'new local title',
  'different header',
  'different endpoints',
  'different leading',
  'different font',
  'missing value',
  'other page',
  'nonfinite height',
  'foreign terminal ink',
  'crossing ink'
])('does not infer continuation from incomplete or competing proof: %s', (variant) => {
  const x = fixture(),
    a = x.current,
    b = { ...x.previous, currentHeight: x.current.height }
  if (variant === 'missing prior title') b.captions = []
  if (variant === 'competing prior title')
    b.captions.push({ ...b.captions[0], lines: ['Table 8: Separate native entries.'] })
  if (variant === 'new local title')
    a.captions = [{ page: 4, lines: ['Table 8: New native entries.'], rect: [10, 6, 225, 16] }]
  if (variant === 'different header') b.tokens[0].text = 'Other'
  if (variant === 'different endpoints') b.rules[0][2] += 1
  if (variant === 'different leading') b.tokens[4].baseline += 2
  if (variant === 'different font') b.tokens[4].height = 12
  if (variant === 'missing value') a.tokens.splice(5, 1)
  if (variant === 'other page') b.pageNumber = 2
  if (variant === 'nonfinite height') b.currentHeight = NaN
  if (variant === 'foreign terminal ink')
    b.tokens.push({
      text: 'Extra prose',
      rect: [110, 290, 190, 300],
      height: 10,
      baseline: 300,
      horizontal: true
    })
  if (variant === 'crossing ink')
    a.tokens.push({
      text: 'Foreign',
      rect: [5, 50, 20, 60],
      height: 10,
      baseline: 60,
      horizontal: true
    })
  const context = variant === 'missing context' ? undefined : b
  expect(
    recoverNativePairedTextRecordGrid(a.table, a.tokens, a.captions, a.rules, context)
  ).toBeUndefined()
  expect(
    recoverNativePairedTextCaption(a.table, a.tokens, a.captions, a.rules, context)
  ).toBeUndefined()
})
