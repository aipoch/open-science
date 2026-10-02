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
  captions: { page: number; lines: string[]; rect: number[] }[]
}
function fixture(): Fixture {
  const cuts = [0, 140, 180, 250, 290, 360, 440],
    tokens = [] as {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }[]
  const add = (text: string, x: number, y: number, end: number): number =>
    tokens.push({ text, rect: [x, y, end, y + 10], baseline: y + 10, height: 10, horizontal: true })
  add('Characteristic', 5, 5, 130)
  add('Group A (n = 20)', 145, 5, 235)
  add('Group B (n = 20)', 255, 5, 350)
  add('p-value', 365, 5, 430)
  for (let n = 0; n < 3; n++) {
    const y = 30 + n * 20
    add(`Category ${n + 1}`, 5, y, 130)
    add(String(4 + n), 145, y, 158)
    add(`(${20 + n * 5}%)`, 185, y, 225)
    add(String(6 + n), 255, y, 268)
    add(`(${30 + n * 5}%)`, 305, y, 345)
    if (!n) add('0.50', 365, y, 405)
  }
  return {
    table: {
      id: 'page-1-table-1',
      cropRect: [0, 0, 440, 100],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({ label: 'table column', rect: [cuts[c], 0, x, 100] })),
          ...[0, 1, 2, 3].map((n) => ({ label: 'table row', rect: [0, n * 25, 440, (n + 1) * 25] }))
        ]
      }
    },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Characteristics.'], rect: [0, -30, 440, -10] }]
  }
}
it('keeps count and percent in the two sample-qualified source cohort fields', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], [])
  expect(t.grid[0].length).toBe(4)
  expect(t.grid[1]).toEqual(['Category 1', '4 (20%)', '6 (30%)', '0.50'])
  expect(t.unassigned).toEqual([])
})
const { recoverMixedCohortSummaries } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['unqualified group', 'independent percent heading', 'non numeric data', 'crossed gutter'])(
  'declines compact cohorts without %s proof',
  (kind) => {
    const f = fixture()
    if (kind === 'unqualified group') f.tokens[1].text = 'Group A'
    if (kind === 'independent percent heading') f.tokens[1].text = 'N %'
    if (kind === 'non numeric data') f.tokens.find((i) => i.text === '4')!.text = 'word'
    if (kind === 'crossed gutter') f.tokens.find((i) => i.text === '4')!.rect[0] = 120
    expect(recoverMixedCohortSummaries(f.table, f.tokens)).toBeUndefined()
  }
)
