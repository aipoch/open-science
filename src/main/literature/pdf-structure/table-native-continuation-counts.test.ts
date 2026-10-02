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
  captions: never[]
  rules: number[][]
}
export function fixture(): Fixture {
  const cuts = [0, 120, 160, 230, 320, 400, 445, 500],
    tokens = [] as {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }[]
  const add = (text: string, x: number, y: number, end: number): number =>
    tokens.push({ text, rect: [x, y, end, y + 10], baseline: y + 10, height: 10, horizontal: true })
  for (let s = 0; s < 3; s++) {
    const y = 5 + s * 60
    add(`Section ${s + 1}`, 5, y, 110)
    add('0.50', 330, y, 365)
    for (let r = 0; r < 2; r++) {
      const yy = y + 20 + r * 20
      add(`Choice ${r + 1}`, 10, yy, 100)
      add(String(4 + r), 130, yy, 145)
      add(`(${20 + r * 5}%)`, 170, yy, 210)
      add(`${6 + r} (${30 + r * 5}%)`, 240, yy, 310)
      add(String(8 + r), 410, yy, 425)
      add(`(${40 + r * 5}%)`, 450, yy, 490)
    }
  }
  return {
    table: {
      id: 'page-1-table-1',
      cropRect: [0, 0, 500, 190],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({ label: 'table column', rect: [cuts[c], 0, x, 190] })),
          ...[0, 1, 2, 3, 4, 5].map((n) => ({
            label: 'table row',
            rect: [0, n * 31, 500, (n + 1) * 31]
          }))
        ]
      }
    },
    tokens,
    captions: [],
    rules: [0, 60, 120, 190].map((y) => [0, y, 500, y])
  }
}
it('preserves native section probabilities while joining three count percent fields', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(t.grid[0].length).toBe(5)
  expect(
    t.grid.some(
      (r: string[]) =>
        r[0] === 'Choice 1' && r[1] === '4 (20%)' && r[2] === '6 (30%)' && r[4] === '8 (40%)'
    )
  ).toBe(true)
  expect(t.grid[0]).toEqual(['Section 1', '', '', '0.50', ''])
  expect(t.unassigned).toEqual([])
})
const { recoverClinicalCountSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['closing rule', 'section rule', 'complete fields', 'numeric ownership'])(
  'declines continuation lacking %s',
  (kind) => {
    const f = fixture()
    if (kind === 'closing rule') f.rules.pop()
    if (kind === 'section rule') f.rules.splice(1, 1)
    if (kind === 'complete fields') f.tokens = f.tokens.filter((i) => !i.text.includes('%'))
    if (kind === 'numeric ownership') f.tokens.find((i) => i.text === '4')!.text = 'prose'
    expect(recoverClinicalCountSections(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
it('uses the complete native continuation frame rather than the model banner margin', () => {
  const f = fixture()
  f.table.cropRect = [0, -30, 490, 185]
  const t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(t.cropRect).toEqual([0, 0, 500.5, 190.5])
  expect(t.grid.some((r: string[]) => r[0] === 'Choice 1' && r[4] === '8 (40%)')).toBe(true)
  expect(t.unassigned).toEqual([])
})
it('refuses to enlarge a continuation frame across a foreign native token', () => {
  const f = fixture()
  f.table.cropRect = [0, -30, 490, 185]
  f.tokens.push({
    text: 'Outside',
    rect: [492, 35, 498, 45],
    baseline: 45,
    height: 10,
    horizontal: true
  })
  expect(recoverClinicalCountSections(f.table, f.tokens, f.rules)).toBeUndefined()
})
