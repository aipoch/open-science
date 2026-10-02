import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderOwnershipGrid: recover } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/centered-native-group-stubs.jsonl')
  )

it.each(['native dividers', 'unique larger leading gap'])(
  'owns centered group stubs by %s without merging numeric baselines',
  (variant) => {
    const f = load()
    if (variant === 'unique larger leading gap') f.rules.splice(2, 1)
    const p = recover(f.table, f.tokens, f.captions, f.rules)
    expect(p?.spans).toEqual([
      { row: 1, column: 0, rowSpan: 3, colSpan: 1 },
      { row: 4, column: 0, rowSpan: 3, colSpan: 1 }
    ])
    const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(result.grid).toEqual([
      ['Group', 'Leaf A', 'Leaf B', 'Leaf C'],
      ['Amber', '35', '39', '43'],
      ['', '44', '48', '52'],
      ['', '53', '57', '61'],
      ['Azure', '62', '66', '70'],
      ['', '71', '75', '79'],
      ['', '80', '84', '88']
    ])
    expect(result.unassigned).toHaveLength(0)
    expect(result.clipped).toHaveLength(0)
  }
)

it.each([
  'off-center label',
  'missing label',
  'crossing ink',
  'unequal leading',
  'absent boundary',
  'incomplete scalar record',
  'competing caption'
])('rejects ambiguous group ownership: %s', (variant) => {
  const f = load()
  if (variant === 'off-center label') {
    f.tokens.at(-1).baseline += 5
    f.tokens.at(-1).rect[1] += 5
    f.tokens.at(-1).rect[3] += 5
  }
  if (variant === 'missing label') f.tokens.pop()
  if (variant === 'crossing ink')
    f.tokens.push({
      text: 'Foreign',
      rect: [230, 55, 250, 65],
      baseline: 65,
      height: 10,
      horizontal: true
    })
  if (variant === 'unequal leading') {
    f.tokens
      .filter((i: { baseline: number }) => i.baseline === 50)
      .forEach((i: { baseline: number; rect: number[] }) => {
        i.baseline += 4
        i.rect[1] += 4
        i.rect[3] += 4
      })
  }
  if (variant === 'absent boundary') f.rules.pop()
  if (variant === 'incomplete scalar record') f.tokens.splice(4, 1)
  if (variant === 'competing caption')
    f.captions.push({ ...f.captions[0], lines: ['Table 8. Comparison.'] })
  const plan = recover(f.table, f.tokens, f.captions, f.rules)
  expect(plan?.spans.some((s: { rowSpan: number }) => s.rowSpan > 1) ?? false).toBe(false)
})
