import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { proveNativeAnchoredLeafHeader, proveNativePeerScalarLeafHeader } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const token = (
      text: string,
      x: number,
      end: number,
      y: number
    ): ReturnType<typeof JSON.parse> => ({
      text,
      rect: [x, y - 10, end, y],
      baseline: y,
      height: 10,
      horizontal: true
    }),
    items = [
      token('A', 5, 20, 31),
      token('B', 55, 70, 31),
      token('Long leaf', 105, 140, 31),
      token('continuation', 105, 145, 43),
      token('D', 165, 180, 31),
      token('E', 215, 230, 31)
    ]
  for (const y of [62, 88, 114])
    for (let c = 0; c < 5; c++)
      items.push(token(`R${c}`, [5, 55, 105, 165, 215][c], [30, 80, 130, 190, 240][c], y))
  items.push(token('wrapped stub', 5, 40, 74))
  return {
    table: { cropRect: [0, 15, 250, 132] },
    items,
    captions: [{ lines: ['Table 1: Anonymous literal fields.'], rect: [0, 0, 250, 12] }],
    rules: [
      [0, 20, 250, 20],
      [0, 49, 250, 49],
      [0, 128, 250, 128]
    ]
  }
}
it('keeps independently printed leaf starts and one wrapped header face with source-confirmed body gutters', () => {
  const f = fixture(),
    before = structuredClone(f),
    plan = proveNativeAnchoredLeafHeader(f.table, f.items, f.captions, f.rules)
  expect(plan.columns).toHaveLength(5)
  expect(plan.rows).toHaveLength(1)
  expect(plan.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'A',
    'B',
    'Long leaf continuation',
    'D',
    'E'
  ])
  expect(plan.bodyItems).toHaveLength(16)
  expect(plan.ownedTokens.size).toBe(6)
  expect(f).toEqual(before)
})
it.each([
  'missing closing rule',
  'crossed next leaf',
  'unowned continuation',
  'one peer',
  'no caption'
])('refuses inferred prose lanes with %s', (variant) => {
  const f = fixture()
  if (variant === 'missing closing rule') f.rules.pop()
  if (variant === 'crossed next leaf') f.items[6].rect[2] = 60
  if (variant === 'unowned continuation') f.items.at(-1).rect = [-5, 64, 40, 74]
  if (variant === 'one peer')
    f.items = f.items.filter((i: { baseline: number }) => i.baseline <= 74)
  if (variant === 'no caption') f.captions = []
  expect(proveNativeAnchoredLeafHeader(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('uses complete scalar peers without collapsing two independent prose stub leaves or reordering a raised degree glyph', () => {
  const token = (
      text: string,
      x: number,
      end: number,
      y: number,
      height = 10
    ): ReturnType<typeof JSON.parse> => ({
      text,
      rect: [x, y - height, end, y],
      baseline: y,
      height,
      horizontal: true
    }),
    items = [
      token('Stub', 5, 25, 38),
      token('Method', 55, 90, 38),
      token('Phase (', 110, 130, 38),
      token('◦', 130, 135, 34, 7),
      token('C)', 136, 145, 38),
      token('Phase', 160, 185, 29),
      token('Value', 160, 185, 46),
      token('Peak', 210, 235, 29),
      token('Value', 210, 235, 46)
    ]
  for (let r = 0; r < 3; r++) {
    const y = 65 + r * 45
    items.push(token(`G${r}`, 5, 25, y), token('Alpha', 55, 90, y))
    for (const x of [120, 170, 220]) items.push(token('1.23', x, x + 20, y))
    items.push(token('Beta', 55, 90, y + 15))
    for (const x of [120, 170, 220]) items.push(token('2.34', x, x + 20, y + 15))
  }
  const f = {
      table: { cropRect: [0, 18, 250, 187] },
      items,
      captions: [{ lines: ['Table 1: Anonymous independent leaves.'], rect: [0, 0, 250, 15] }],
      rules: [
        [0, 20, 250, 20],
        [0, 52, 250, 52],
        [0, 182, 250, 182]
      ]
    },
    before = structuredClone(f)
  const plan = proveNativePeerScalarLeafHeader(f.table, f.items, f.captions, f.rules)
  expect(plan.columns).toHaveLength(5)
  expect(plan.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'Stub',
    'Method',
    'Phase (◦C)',
    'Phase Value',
    'Peak Value'
  ])
  expect(
    new Set(plan.headerCells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).size
  ).toBe(items.filter((i) => i.baseline < 52).length)
  expect(f).toEqual(before)
  const bad = structuredClone(f)
  bad.items[1].rect[2] = 115
  expect(
    proveNativePeerScalarLeafHeader(bad.table, bad.items, bad.captions, bad.rules)
  ).toBeUndefined()
  for (const missing of [
    'rotated',
    'nonfinite',
    'missing peer',
    'missing closing',
    'foreign header'
  ]) {
    const sample = structuredClone(f)
    if (missing === 'rotated') sample.items[1].horizontal = false
    if (missing === 'nonfinite') sample.items[1].rect[0] = Number.NaN
    if (missing === 'missing peer')
      sample.items = sample.items.filter((i: { baseline: number }) => i.baseline < 145)
    if (missing === 'missing closing') sample.rules.pop()
    if (missing === 'foreign header') sample.items.push(token('foreign', 242, 255, 38))
    expect(
      proveNativePeerScalarLeafHeader(sample.table, sample.items, sample.captions, sample.rules)
    ).toBeUndefined()
  }
})
