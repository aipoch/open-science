import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { proveNativeCaptionRaisedGlyphOwnership } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-caption-raised-glyphs.mjs'))
    .href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
function fixture(): {
  table: { cropRect: number[] }
  items: Token[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
  page: {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
  }
} {
  const item = (text: string, x: number, y: number, width = 8): Token => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const body = [20, 50, 75, 100, 125].flatMap((y, row) =>
    [20, 120, 220, 320].map((x, column) => item(row === 0 ? `Label${column}` : '1', x, y, 25))
  )
  const caption = [
    item('Table 1 Description of recorded labels, including ', 10, 162, 208),
    item('R', 220, 162),
    item('t,', 228, 162),
    item('S', 244, 162),
    item('t,', 252, 162),
    item('T', 268, 162),
    item('t are defined', 276, 162, 70),
    item('by replacing values with ', 10, 175, 86),
    item('U', 100, 175),
    item('t.', 108, 175),
    item('ˆ', 222, 159.5, 4),
    item('ˆ', 246, 159.5, 4),
    item('ˆ', 270, 159.5, 4),
    item('ˆ', 102, 172.5, 4)
  ]
  const items = [...body, ...caption]
  const lines = [
    ...body,
    caption[0],
    item('Rt,', 220, 162, 16),
    item('St,', 244, 162, 16),
    item('Tt are defined', 268, 162, 78),
    caption[7],
    item('Ut.', 100, 175, 16),
    ...caption.slice(10)
  ].map((i) => ({
    text: i.text,
    x: i.rect[0],
    y: i.rect[1],
    width: i.rect[2] - i.rect[0],
    height: i.height,
    fontSize: i.height
  }))
  return {
    table: { cropRect: [0, 15, 400, 165] },
    items,
    captions: [
      {
        page: 1,
        lines: [
          'Table 1 Description of recorded labels, including Rt, St, Tt are defined',
          'by replacing values with Ut.'
        ],
        rect: [10, 162, 378, 185]
      }
    ],
    rules: [
      [0, 18, 400, 18],
      [0, 40, 400, 40],
      [0, 160, 400, 160]
    ],
    page: { pageNumber: 1, width: 420, height: 250, lines }
  }
}
it('keeps three caption-owned raised font boxes outside the closed table without changing inputs', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  const p = proveNativeCaptionRaisedGlyphOwnership(x.table, x.items, x.captions, x.rules)
  expect([...p.tokens]).toEqual(x.items.filter((i) => i.text === 'ˆ').slice(0, 3))
  expect(p.closing).toBe(x.rules[2])
  expect(p.caption).toBe(x.captions[0])
  expect(p.bodyTokens.size).toBe(20)
  expect(JSON.stringify(x)).toBe(before)
})
it('orders each original literal caption accent with its unique base and preserves the caption rectangle', () => {
  const x = fixture()
  const caps = findCaptionCandidates([x.page], new Map([[1, x.rules]]))
  expect(caps).toHaveLength(1)
  expect(caps[0].lines.join(' ')).toContain('ˆRt, ˆSt, ˆTt are defined')
  expect(caps[0].lines.join(' ')).toMatch(/with\s+ˆUt\./u)
  expect(caps[0].rect[1]).toBe(162)
})
it('excludes only the proven caption hats from full table refinement and keeps every body owner', () => {
  const x = fixture()
  const rows = [
    [18, 40],
    [40, 70],
    [70, 95],
    [95, 120],
    [120, 150]
  ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top - 15, 400, bottom - 15] }))
  const columns = [0, 100, 200, 300].map((left) => ({
    label: 'table column',
    rect: [left, 3, left + 100, 145]
  }))
  const table = {
    ...x.table,
    id: 'layout',
    structure: {
      objects: [...rows, ...columns, { label: 'table column header', rect: [0, 3, 400, 25] }]
    }
  }
  const r = refineTable(table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.every((row: string[]) => row.length === 4)).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(r.clipped).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.items
      .slice(0, 20)
      .map((i) => i.rect)
      .sort()
  )
})
it.each([
  'missing closing',
  'competing closing',
  'duplicate caption',
  'foreign crossing',
  'body crossing',
  'missing opening',
  'missing header',
  'competing base',
  'only two repeated hats',
  'same baseline',
  'invalid baseline',
  'nonliteral accent'
])('refuses raised caption ownership with %s', (variant) => {
  const x = fixture()
  if (variant === 'missing closing') x.rules.pop()
  if (variant === 'competing closing') x.rules.push([0, 159.8, 400, 159.8])
  if (variant === 'duplicate caption') x.captions.push(structuredClone(x.captions[0]))
  if (variant === 'foreign crossing')
    x.items.push({ ...x.items[0], text: 'Foreign', rect: [30, 159, 70, 169], baseline: 169 })
  if (variant === 'body crossing') x.items[19].rect[3] = 161
  if (variant === 'missing opening') x.rules.shift()
  if (variant === 'missing header') x.rules.splice(1, 1)
  if (variant === 'competing base')
    x.items.push({ ...x.items.find((i) => i.text === 'R')!, text: 'V' })
  if (variant === 'only two repeated hats')
    x.items = x.items.filter((i) => !(i.text === 'ˆ' && i.rect[0] === 270))
  if (variant === 'same baseline')
    x.items
      .filter((i) => i.text === 'ˆ')
      .forEach((i) => {
        i.baseline += 2.5
      })
  if (variant === 'invalid baseline') x.items.find((i) => i.text === 'ˆ')!.baseline = NaN
  if (variant === 'nonliteral accent') x.items.find((i) => i.text === 'ˆ')!.text = '^'
  expect(
    proveNativeCaptionRaisedGlyphOwnership(x.table, x.items, x.captions, x.rules)
  ).toBeUndefined()
})
