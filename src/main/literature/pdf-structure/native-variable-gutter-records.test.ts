import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { proveNativeVariableGutterLeafGrid } = await import(
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
      rect: [x, y - 9, end, y],
      height: 9,
      baseline: y,
      horizontal: true
    }),
    items = [
      token('Ref', 5, 20, 31),
      token('Field', 45, 65, 31),
      token('Wording', 68, 100, 31),
      token('Kind', 170, 187, 31),
      token('Year', 210, 232, 31)
    ]
  for (let r = 0; r < 4; r++) {
    const y = 50 + r * 12,
      end = 80 + r * 12
    items.push(
      token(`[${r + 1}]`, 5, 22, y),
      token('Literal name', 45, end, y),
      token('Literal quoted title', end + 3, 160, y),
      token('C', 176, 183, y),
      token('2020', 210, 232, y)
    )
  }
  return {
    table: { cropRect: [0, 18, 240, 98] },
    items,
    rules: [
      [0, 20, 240, 20],
      [0, 37, 240, 37],
      [0, 94, 240, 94]
    ],
    captions: [{ lines: ['Table 1: Anonymous native fields.'], rect: [0, 0, 240, 16] }]
  }
}
it('preserves row-local native field boundaries proved by one repeated literal header gap', () => {
  const f = fixture(),
    before = structuredClone(f),
    plan = proveNativeVariableGutterLeafGrid(f.table, f.items, f.captions, f.rules)
  expect(plan.cuts).toHaveLength(6)
  expect(plan.groups).toHaveLength(5)
  expect(plan.spans).toHaveLength(20)
  expect(
    plan.spans.every(
      (s: { colSpan: number; rowSpan: number }) => s.colSpan === 1 && s.rowSpan === 1
    )
  ).toBe(true)
  expect(plan.consumed).toHaveLength(f.items.length)
  expect(
    plan.spans
      .filter((s: { column: number }) => s.column === 2)
      .map((s: { rect: number[] }) => s.rect[0])
  ).toEqual([83, 95, 107, 119])
  expect(f).toEqual(before)
})
it.each([
  'second matching gap',
  'wrong header gap',
  'missing terminal field',
  'no caption',
  'missing closing fence'
])('refuses row-local field guessing with %s', (variant) => {
  const f = fixture()
  if (variant === 'second matching gap') {
    const i = f.items[7]
    i.rect[2] = 130
    f.items.push({ ...i, text: 'extra', rect: [133, 41, 160, 50] })
  }
  if (variant === 'wrong header gap') f.items[2].rect[0] = 74
  if (variant === 'missing terminal field') f.items.splice(9, 1)
  if (variant === 'no caption') f.captions = []
  if (variant === 'missing closing fence') f.rules.pop()
  expect(proveNativeVariableGutterLeafGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
