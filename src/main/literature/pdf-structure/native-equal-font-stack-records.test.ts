import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeEqualFontStackRecordGrid, recoverNativeStackedUncertainty } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-stacked-uncertainty.mjs'))
    .href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-twelve-leaf-records-with-equal-em-stack-pairs.jsonl'
    )
  )
it('keeps each equal-font stacked pair in one complete native record through the refiner', () => {
  const x = fixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(7)
  expect(r.grid[1][4]).toBe('1.6+0.6−0.7')
  expect(r.grid[6][11]).toBe('6.13+0.13−0.14')
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects?: number[][] }) => c.sourceRects ?? [])
      .map((q: number[]) => JSON.stringify(q))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(r.cropRect).toEqual(x.table.cropRect)
})
it('requires complete table proof before accepting equal font boxes as paired scripts', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    p = recoverNativeEqualFontStackRecordGrid(x.table, x.items, x.captions, x.rules)
  expect(p?.ownedTokens.size).toBe(x.items.length)
  expect(p?.equalFontStacks).toHaveLength(48)
  const group = [...p.equalFontStacks[0].tokens]
  expect(recoverNativeStackedUncertainty(group, x.rules)).toBeUndefined()
  expect(recoverNativeStackedUncertainty(group, x.rules, p.equalFontStacks)?.runs).toEqual([
    { text: '1.6', position: 'normal' },
    { text: '+0.6', position: 'superscript' },
    { text: '−0.7', position: 'subscript' }
  ])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'missing caption',
  'competing caption',
  'missing closing',
  'competing full rule',
  'missing leaf',
  'missing upper',
  'missing lower',
  'ambiguous source',
  'foreign row',
  'crossed column',
  'irregular leading',
  'wrong script offset',
  'different script font',
  'script separator',
  'interrupted frame'
])('declines incomplete native equal-em record proof: %s', (variant) => {
  const x = fixture()
  if (variant === 'missing caption') x.captions = []
  if (variant === 'competing caption') x.captions.push(structuredClone(x.captions[0]))
  if (variant === 'missing closing') x.rules.pop()
  if (variant === 'competing full rule') x.rules.push([20, 115, 800, 115])
  if (variant === 'missing leaf') x.items.splice(0, 1)
  if (variant === 'missing upper')
    x.items.splice(
      x.items.findIndex((i: { text: string }) => i.text === '+0.6'),
      1
    )
  if (variant === 'missing lower')
    x.items.splice(
      x.items.findIndex((i: { text: string }) => i.text === '−0.7'),
      1
    )
  if (variant === 'ambiguous source')
    x.items.push(x.items.find((i: { text: string }) => i.text === '+0.6'))
  if (variant === 'foreign row')
    x.items.push({
      text: 'Independent prose',
      rect: [21, 80, 700, 90],
      baseline: 90,
      height: 10,
      horizontal: true
    })
  if (variant === 'crossed column')
    x.items.find((i: { text: string }) => i.text === '+0.6').rect[2] += 60
  if (variant === 'irregular leading')
    for (const i of x.items.filter((i: { baseline: number }) => Math.abs(i.baseline - 115) < 8)) {
      i.baseline += 2
      i.rect[1] += 2
      i.rect[3] += 2
    }
  if (variant === 'wrong script offset')
    x.items.find((i: { text: string }) => i.text === '+0.6').baseline += 1
  if (variant === 'different script font')
    x.items.find((i: { text: string }) => i.text === '+0.6').height = 7
  if (variant === 'script separator') x.rules.push([280, 70, 340, 70])
  if (variant === 'interrupted frame') x.rules[2][2] -= 25
  expect(
    recoverNativeEqualFontStackRecordGrid(x.table, x.items, x.captions, x.rules)
  ).toBeUndefined()
})
