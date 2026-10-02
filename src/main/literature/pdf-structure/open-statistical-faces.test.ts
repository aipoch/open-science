import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)

it.each([
  'native',
  'missing-probability',
  'wrong-script',
  'missing-inner-edge',
  'missing-caption',
  'incomplete-outer-side'
])('recovers an open-sided statistical matrix with %s evidence', (variant) => {
  const f: {
    table: unknown
    items: Array<{ text: string; rect: number[] }>
    captions: unknown[]
    rules: number[][]
  } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/open-sided-matrix-with-native-statistical-faces.jsonl'
    )
  )
  if (variant === 'missing-probability')
    f.items.find((i) => i.rect[1] > 550 && i.text.startsWith('p ='))!.text = 'Unknown'
  if (variant === 'wrong-script') f.items.find((i) => i.rect[1] > 575 && i.text === '2')!.text = '4'
  if (variant === 'missing-inner-edge')
    f.rules = f.rules.filter((r) => r[0] !== r[2] || Math.abs(r[0] - 399.11) > 1)
  if (variant === 'missing-caption') f.captions = []
  if (variant === 'incomplete-outer-side') f.rules.push([864, 367.55, 864, 695.298])
  const original = structuredClone(f)
  const result = recoverClosedCellGrid(f.table, f.items, f.captions, f.rules)
  expect(Boolean(result)).toBe(variant === 'native')
  if (result) {
    expect(result.columns).toHaveLength(7)
    expect(result.ownedTokens.size).toBe(f.items.length)
  }
  expect(f).toEqual(original)
})
