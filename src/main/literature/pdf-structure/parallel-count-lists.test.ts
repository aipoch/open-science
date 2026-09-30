import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverParallelCountLists } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/independently-wrapped-description-count-lanes.jsonl'
    )
  )

it('keeps each independent count with its complete paragraph through the production refiner', () => {
  const f = load()
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const right = t.cells.filter(
    (c: { row: number; column: number; text: string }) => c.row > 0 && c.column === 3 && c.text
  )
  expect(right.map((c: { text: string }) => c.text)).toEqual([
    '43',
    '0',
    '1',
    '1',
    '0',
    '2',
    '0',
    '0',
    '0',
    '3',
    '35',
    '10',
    '3',
    '0',
    '0',
    '0'
  ])
  expect(
    t.cells.some((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan > 1)
  ).toBe(true)
  expect(t.unassigned).toEqual([])
  const source = t.cells
    .flatMap((c: { sourceRects: number[][] }) => c.sourceRects.map((r) => JSON.stringify(r)))
    .sort()
  expect(source).toEqual(f.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each([
  'missing-border',
  'changed-segment',
  'missing-caption',
  'different-count-heading',
  'cross-gutter',
  'missing-count',
  'extra-count',
  'unowned-leading-text',
  'separated-paragraph',
  'internal-rule',
  'no-wrapped-witness'
])('keeps model fallback when independent lanes are not proved: %s', (variant) => {
  const f = load()
  if (variant === 'missing-border') f.rules.splice(8, 4)
  if (variant === 'changed-segment') f.rules[5][0] += 8
  if (variant === 'missing-caption') f.captions = []
  if (variant === 'different-count-heading')
    f.tokens.find((i: { text: string; rect: number[] }) => i.text === 'n' && i.rect[0] > 700).text =
      'mean'
  if (variant === 'cross-gutter')
    f.tokens.find((i: { text: string }) => i.text === 'Criterion details 1').rect[2] = 445
  if (variant === 'missing-count')
    f.tokens = f.tokens.filter(
      (i: { text: string; baseline: number }) => !(i.text === '35' && i.baseline > 500)
    )
  if (variant === 'extra-count')
    f.tokens.push({ ...f.tokens.find((i: { text: string }) => i.text === '43') })
  if (variant === 'unowned-leading-text') {
    const i = { ...f.tokens.find((i: { text: string }) => i.text === 'Criterion details 1') }
    i.baseline -= 8
    i.rect = [i.rect[0], i.rect[1] - 8, i.rect[2], i.rect[3] - 8]
    f.tokens.push(i)
  }
  if (variant === 'separated-paragraph') {
    const i = f.tokens.find((i: { text: string }) =>
      i.text.startsWith('continued criterion details')
    )
    i.rect[0] += 10
    i.rect[2] += 10
  }
  if (variant === 'internal-rule') f.rules.push([80, 400, 760, 400])
  if (variant === 'no-wrapped-witness')
    f.tokens = f.tokens.filter(
      (i: { rect: number[]; baseline: number; height: number }) =>
        i.rect[0] > 460 ||
        i.baseline < 216 ||
        f.tokens.some(
          (n: { text: string; rect: number[]; baseline: number }) =>
            /^\d+$/.test(n.text) &&
            n.rect[0] > 425 &&
            n.rect[0] < 460 &&
            Math.abs(n.baseline - i.baseline) < 2
        )
    )
  expect(recoverParallelCountLists(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([0.7, 1.8])('preserves owned paragraphs and spans under scale %s', (scale) => {
  const f = load()
  f.table.cropRect = f.table.cropRect.map((v: number) => v * scale)
  for (const o of f.table.structure.objects) o.rect = o.rect.map((v: number) => v * scale)
  for (const i of f.tokens) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  for (const c of f.captions) c.rect = c.rect.map((v: number) => v * scale)
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  const grid = recoverParallelCountLists(f.table, f.tokens, f.captions, f.rules)
  expect(grid?.ownedTokens.size).toBe(f.tokens.length)
  expect(grid?.spans.some((s: { rowSpan: number }) => s.rowSpan > 1)).toBe(true)
})
