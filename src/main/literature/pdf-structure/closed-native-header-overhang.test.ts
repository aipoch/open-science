import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
it.each([
  'native',
  'missing-caption',
  'missing-title',
  'large-overhang',
  'incomplete-side',
  'independent-prose'
])(
  'uses a complete closed native header to retain small font-box overhang with %s proof',
  (variant) => {
    const f: {
      table: unknown
      items: Array<{ text: string; rect: number[] }>
      captions: unknown[]
      rules: number[][]
    } = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/closed-native-leaves-with-opening-font-box-overhang.jsonl'
      )
    )
    if (variant === 'missing-caption') f.captions = []
    if (variant === 'missing-title') f.items = f.items.filter((i) => i.text !== 'All')
    if (variant === 'large-overhang') f.items.find((i) => i.text === 'All')!.rect[1] -= 3
    if (variant === 'incomplete-side')
      f.rules = f.rules.filter((r) => !(r[0] === r[2] && r[0] < 123 && r[1] < 160))
    if (variant === 'independent-prose')
      f.items.push({ ...f.items[0], text: 'Prior paragraph', rect: [130, 140, 280, 145] })
    const snapshot = structuredClone(f),
      r = recoverClosedCellGrid(f.table, f.items, f.captions, f.rules)
    expect(Boolean(r)).toBe(variant === 'native')
    if (r) {
      expect(r.columns).toHaveLength(5)
      expect(r.ownedTokens.size).toBe(f.items.length)
      expect(r.cropRect[2]).toBeGreaterThan(770)
    }
    expect(f).toEqual(snapshot)
  }
)
