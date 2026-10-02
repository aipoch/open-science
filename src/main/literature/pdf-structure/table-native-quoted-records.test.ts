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
  rules: number[][]
}
function fixture(): Fixture {
  const tokens = [] as {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  }[]
  const add = (text: string, x: number, y: number, end: number): number =>
    tokens.push({ text, rect: [x, y, end, y + 10], baseline: y + 10, height: 10, horizontal: true })
  add('Category', 5, 5, 90)
  add('Example quotes', 105, 5, 295)
  for (let n = 0; n < 3; n++) {
    add(`Category ${n + 1}`, 5, 35 + n * 40, 90)
    add('“A native quotation begins', 105, 35 + n * 40, 295)
    add(`and its full ending” (R${n + 1})`, 105, 50 + n * 40, 295)
  }
  return {
    table: {
      id: 'page-1-table-1',
      cropRect: [0, 0, 300, 145],
      structure: {
        objects: [
          { label: 'table column', rect: [0, 0, 100, 145] },
          { label: 'table column', rect: [100, 0, 300, 145] },
          { label: 'table row', rect: [0, 0, 300, 25] },
          { label: 'table row', rect: [0, 25, 300, 110] },
          { label: 'table row', rect: [0, 110, 300, 145] }
        ]
      }
    },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Feedback.'], rect: [0, -30, 300, -10] }],
    rules: [0, 25, 145].flatMap((y) => [
      [0, y, 100, y],
      [100, y, 300, y]
    ])
  }
}
it('keeps native quote tails with the category at their aligned first quotation', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toHaveLength(4)
  expect(t.grid[1][1]).toBe('“A native quotation begins and its full ending” (R1)')
  expect(t.grid[2][1]).toBe('“A native quotation begins and its full ending” (R2)')
  expect(t.unassigned).toEqual([])
})
const { recoverStudyParagraphGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
it.each(['quote heading', 'closing quotation', 'aligned category', 'native closure'])(
  'declines quotations lacking %s',
  (kind) => {
    const f = fixture()
    if (kind === 'quote heading') f.tokens.find((i) => i.text === 'Example quotes')!.text = 'Other'
    if (kind === 'closing quotation')
      f.tokens.find((i) => i.text.includes('R2'))!.text = 'Unclosed ending (R2)'
    if (kind === 'aligned category') {
      const i = f.tokens.find((i) => i.text === 'Category 2')!
      i.rect[1] += 8
      i.rect[3] += 8
      i.baseline += 8
    }
    if (kind === 'native closure') f.rules = f.rules.filter((r) => r[1] !== 145)
    expect(recoverStudyParagraphGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
