import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  rules: number[][]
}
function fixture(): Fixture {
  const cuts = [0, 120, 230, 340, 400, 497]
  const tokens: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  }[] = []
  const add = (text: string, x: number, y: number, end: number): number =>
    tokens.push({ text, rect: [x, y, end, y + 10], baseline: y + 10, height: 10, horizontal: true })
  add('Variable', 5, 5, 90)
  add('Group A (n=20)', 130, 5, 225)
  add('Group B', 240, 5, 315)
  add('(n=18)', 240, 20, 295)
  add('P value', 350, 5, 395)
  add('Group C', 410, 5, 485)
  add('(n=16)', 410, 20, 465)
  for (const [s, ys] of [
    [0, [40, 60, 80, 100]],
    [1, [125, 140, 155, 165]]
  ] as const) {
    add(`Section ${s + 1}`, 5, ys[0], 95)
    add('0.50', 350, ys[0], 385)
    for (let r = 1; r < ys.length; r++) {
      add(`Choice ${r}`, 5, ys[r], 95)
      add(`${3 + r} (${20 + r}%)`, 130, ys[r], 220)
      if (r < 3) {
        add(`${5 + r} (${30 + r}%)`, 240, ys[r], 330)
        add(`${7 + r} (${40 + r}%)`, 410, ys[r], 490)
      }
    }
  }
  return {
    table: {
      id: 'page-1-table-1',
      cropRect: [0, 0, 497, 177],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({ label: 'table column', rect: [cuts[c], 0, x, 177] })),
          ...[0, 40, 55, 75, 95, 120, 135, 150, 162].map((y, n, a) => ({
            label: 'table row',
            rect: [0, y, 497, a[n + 1] ?? 177]
          })),
          { label: 'table column header', rect: [0, 0, 497, 35] }
        ]
      }
    },
    tokens,
    rules: [2, 40, 125, 180].map((y) => [0, y, 500, y])
  }
}
it('retains the matching native right and closing borders without changing count ownership', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(t.cropRect).toEqual([0, 0, 500.5, 180.5])
  expect(
    t.grid.some(
      (r: string[]) =>
        r[0] === 'Choice 1' && r[1] === '4 (21%)' && r[2] === '6 (31%)' && r[4] === '8 (41%)'
    )
  ).toBe(true)
  expect(t.unassigned).toEqual([])
})
it.each([
  'missing footer',
  'competing footer',
  'mismatched frame',
  'mismatched section rule',
  'distant footer',
  'wrong sample lane',
  'header crosses lane',
  'invalid count',
  'foreign expanded ink'
])('does not expand %s', (kind) => {
  const f = fixture()
  if (kind === 'missing footer') f.rules.pop()
  if (kind === 'competing footer') f.rules.push([0, 179, 500, 179])
  if (kind === 'mismatched frame') f.rules[3][2] = 510
  if (kind === 'mismatched section rule') f.rules[2][2] = 504
  if (kind === 'distant footer') f.rules[3][1] = f.rules[3][3] = 195
  if (kind === 'wrong sample lane')
    f.tokens.find((i) => i.text === 'P value')!.text = 'Group D (n=12)'
  if (kind === 'header crosses lane')
    f.tokens.find((i) => i.text === 'Group A (n=20)')!.rect[2] = 233
  if (kind === 'invalid count') f.tokens.find((i) => i.text === '6 (31%)')!.text = 'free text'
  if (kind === 'foreign expanded ink')
    f.tokens.push({
      text: 'foreign',
      rect: [498, 160, 500, 170],
      baseline: 170,
      height: 10,
      horizontal: true
    })
  const t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(t.cropRect[2]).toBeLessThanOrEqual(497)
  expect(t.cropRect[3]).toBeLessThanOrEqual(177)
})
