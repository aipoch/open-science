import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { recoverRuledHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const fixture = (): {
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  cuts: number[]
  rules: number[][]
} => {
  const token = (
    text: string,
    x: number,
    right: number,
    y: number
  ): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
    text,
    rect: [x, y - 10, right, y],
    baseline: y,
    height: 10,
    horizontal: true
  })
  return {
    tokens: [
      token('Stub', 5, 65, 27),
      token('Parent A', 135, 255, 20),
      token('Parent B', 330, 430, 20),
      token('Long metric', 90, 160, 40),
      token('Metric A', 190, 230, 40),
      token('Metric B', 255, 290, 40),
      token('Metric C', 303, 370, 40),
      token('Metric D', 390, 450, 40)
    ],
    cuts: [0, 80, 170, 245, 300, 380, 460],
    rules: [
      [0, 5, 460, 5],
      [92, 25, 295, 25],
      [305, 25, 455, 25],
      [0, 45, 460, 45]
    ]
  }
}
it('retains a complete first leaf whose font box slightly overhangs the inset underline', () => {
  const x = fixture(),
    r = recoverRuledHeaderBands(x.tokens, x.cuts, x.rules, 5, 45)
  expect(r.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 3 })
  expect(r.spans).toContainEqual({ row: 0, column: 4, rowSpan: 1, colSpan: 2 })
})
it.each(['large-overhang', 'crossing-leaf', 'missing-rule'])(
  'does not borrow an unproved neighboring leaf: %s',
  (mode) => {
    const x = fixture()
    if (mode === 'large-overhang') x.tokens.find((t) => t.text === 'Long metric')!.rect[0] = 89.8
    if (mode === 'crossing-leaf') x.tokens.find((t) => t.text === 'Long metric')!.rect[2] = 180
    if (mode === 'missing-rule') x.rules = x.rules.filter((r) => r[0] !== 92)
    expect(recoverRuledHeaderBands(x.tokens, x.cuts, x.rules, 5, 45)?.spans).not.toContainEqual({
      row: 0,
      column: 1,
      rowSpan: 1,
      colSpan: 3
    })
  }
)
