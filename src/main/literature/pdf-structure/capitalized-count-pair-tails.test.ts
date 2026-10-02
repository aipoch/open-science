import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { recoverWrappedCountPairsGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-proportion-grid.mjs')).href
)
it.each([
  'native',
  'missing-caption',
  'missing-count',
  'independent-indent',
  'wrong-leading',
  'missing-closing-rule',
  'non-count-value'
])('uses complete paired native records for capitalized tails with %s proof', (variant) => {
  const f: {
    table: unknown
    items: Array<{ text: string; rect: number[]; baseline: number }>
    captions: unknown[]
    rules: number[][]
  } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/uniform-leading-capitalized-count-pair-tails.jsonl'
    )
  )
  if (variant === 'missing-caption') f.captions = []
  if (variant === 'missing-count')
    f.items = f.items.filter((i) => !(i.rect[0] > 750 && i.baseline > 210 && i.baseline < 230))
  if (variant === 'independent-indent') {
    const i = f.items.find((i) => i.baseline > 360 && i.baseline < 370)!
    i.rect[0] += 15
  }
  if (variant === 'wrong-leading')
    f.items.find((i) => i.baseline > 360 && i.baseline < 370)!.baseline += 5
  if (variant === 'missing-closing-rule') f.rules = f.rules.filter((r) => r[1] < 540)
  if (variant === 'non-count-value')
    f.items.find((i) => i.rect[0] > 750 && i.baseline > 210 && i.baseline < 230)!.text = '33'
  const snapshot = structuredClone(f),
    r = recoverWrappedCountPairsGrid(f.table, f.items, f.captions, f.rules)
  expect(Boolean(r)).toBe(variant === 'native')
  if (r) {
    expect(r.rows).toHaveLength(11)
    expect(r.columns).toHaveLength(3)
    expect(r.ownedTokens.size).toBe(f.items.length)
  }
  expect(f).toEqual(snapshot)
})
