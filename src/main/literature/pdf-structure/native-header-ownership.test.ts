import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const aligned = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.tokens = f.tokens.filter((i: { baseline: number }) => i.baseline > 50)
  for (const [c, x] of [8, 73, 113, 161, 203].entries())
    f.tokens.push({
      text: ['Category', 'Leaf A', 'Leaf B', 'Leaf C', 'Leaf D'][c],
      rect: [x, 22, x + 24, 32],
      baseline: 32,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  for (const i of f.tokens.filter((i: { baseline: number }) => i.baseline === 97))
    f.tokens.push({
      ...i,
      text: i.text === 'Item coral' ? 'Item lilac' : String(Number(i.text) + 7),
      rect: [i.rect[0], i.rect[1] + 17, i.rect[2], i.rect[3] + 17],
      baseline: 114
    })
  f.rules = [
    [0, 20, 240, 20],
    [0, 40, 240, 40],
    [0, 129, 240, 129]
  ]
  f.table.cropRect = [0, 20, 240, 129]
  const columns = f.table.structure.objects.filter(
    (o: { label: string }) => o.label === 'table column'
  )
  columns.at(-2).rect[2] = columns.at(-1).rect[2]
  f.table.structure.objects.splice(f.table.structure.objects.indexOf(columns.at(-1)), 1)
  return f
}
it('restores complete repeated source leaves when the model combines the last two header and value columns', () => {
  const f = aligned(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['Category', 'Leaf A', 'Leaf B', 'Leaf C', 'Leaf D'])
  expect(result.grid[4]).toEqual(['Item lilac', '52', '55', '58', '61'])
  expect(result.unassigned).toHaveLength(0)
  expect(result.clipped).toHaveLength(0)
})
it.each(['missing leaf', 'overlapping leaf ink', 'missing footer', 'header crosses outer edge'])(
  'declines unproved repeated leaf ownership: %s',
  (variant) => {
    const f = aligned()
    if (variant === 'missing leaf')
      f.tokens.splice(
        f.tokens.findIndex((i: { text: string }) => i.text === '31'),
        1
      )
    if (variant === 'overlapping leaf ink')
      f.tokens.find((i: { text: string }) => i.text === 'Leaf B').rect[0] = 85
    if (variant === 'missing footer') f.rules.pop()
    if (variant === 'header crosses outer edge')
      f.tokens.find((i: { text: string }) => i.text === 'Leaf D').rect[2] = 248
    const plan = recover(f.table, f.tokens, f.captions, f.rules)
    if (variant === 'missing leaf') expect(plan?.columns.length ?? 0).not.toBe(5)
    else expect(plan).toBeUndefined()
  }
)
const { recoverNativeHeaderOwnershipGrid: recover } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-underlined-two-tier-numeric-header.jsonl'
    )
  )

const centeredParents = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.rules = [20, 54, 112].map((y) => [0, y, 240, y])
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'Measure')
  return f
}

it('recovers centered parent tiers above independently populated body leaves', () => {
  const f = centeredParents()
  expect(recover(f.table, f.tokens, f.captions, f.rules)?.columns).toHaveLength(5)
})

it.each(['single shared statistic', 'shared category and statistic'])(
  'leaves unresolved body scope to existing span recovery: %s',
  (variant) => {
    const f = centeredParents()
    if (variant === 'single shared statistic')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) => !(i.baseline > 63 && i.rect[0] > 195)
      )
    if (variant === 'shared category and statistic')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) =>
          !(i.baseline === 80 && (i.rect[0] < 65 || i.rect[0] > 195))
      )
    expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('keeps two underlined parent header scopes above complete independent numeric leaves', () => {
  const f = load()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.slice(0, 2)).toEqual([
    ['Category', 'Cohort alpha', '', 'Cohort beta', ''],
    ['Measure', 'Low', 'High', 'Low', 'High']
  ])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, colSpan: 2, text: 'Cohort alpha' })
  )
  expect(result.grid.slice(2).map((row: string[]) => row.slice(1))).toEqual([
    ['31', '34', '37', '40'],
    ['38', '41', '44', '47'],
    ['45', '48', '51', '54']
  ])
})

it.each([
  'missing footer',
  'foreign edge',
  'nonfinite baseline',
  'large opening overhang',
  'competing caption',
  'foreign body baseline'
])('declines incomplete native header ownership: %s', (variant) => {
  const f = load()
  if (variant === 'missing footer')
    f.rules = f.rules.filter((r: number[]) => r[1] !== 112 || r[3] !== 112)
  if (variant === 'foreign edge')
    f.tokens.push({
      text: 'Foreign',
      rect: [230, 70, 250, 80],
      baseline: 80,
      height: 10,
      horizontal: true
    })
  if (variant === 'nonfinite baseline') f.tokens[0].baseline = NaN
  if (variant === 'large opening overhang') f.tokens[0].rect[1] = 15
  if (variant === 'competing caption')
    f.captions.push({ ...f.captions[0], lines: ['Table 8. Comparison.'] })
  if (variant === 'foreign body baseline')
    f.tokens.push({
      text: 'Foreign',
      rect: [10, 58, 50, 68],
      baseline: 68,
      height: 10,
      horizontal: true
    })
  expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
