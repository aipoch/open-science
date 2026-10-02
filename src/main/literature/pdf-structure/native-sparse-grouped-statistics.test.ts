import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
function fixture(): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  tokens: Token[]
  rules: number[][]
  captions: { page: number; rect: number[]; lines: string[] }[]
} {
  const tokens: Token[] = []
  const add = (text: string, x: number, y: number, w = 8): void => {
    tokens.push({ text, rect: [x, y - 10, x + w, y], height: 10, baseline: y, horizontal: true })
  }
  add('Group A', 87, 18, 46)
  add('Group B', 237, 18, 46)
  for (let c = 0; c < 8; c++) add(String.fromCharCode(65 + c), 52 + c * 30 + (c >= 4 ? 30 : 0), 37)
  add('Index', 5, 56, 30)
  for (let c = 0; c < 8; c++) add(String(c + 2), 52 + c * 30 + (c >= 4 ? 30 : 0), 56)
  add('Ratio', 5, 73, 30)
  add('7', 106, 73)
  add('9', 256, 73)
  const objects = [
    { label: 'table column header', score: 1, rect: [0, 5, 330, 42] },
    { label: 'table row', score: 1, rect: [0, 5, 330, 42] },
    { label: 'table row', score: 1, rect: [0, 45, 330, 76] }
  ]
  for (const [a, b] of [
    [0, 40],
    [40, 80],
    [80, 110],
    [110, 140],
    [140, 190],
    [190, 230],
    [230, 260],
    [260, 330]
  ])
    objects.push({ label: 'table column', score: 1, rect: [a, 5, b, 80] })
  return {
    table: { id: 'synthetic-sparse-groups', cropRect: [0, 0, 330, 84], structure: { objects } },
    tokens,
    rules: [
      [0, 5, 330, 5],
      [50, 23, 170, 23],
      [200, 23, 320, 23],
      [0, 43, 330, 43],
      [0, 80, 330, 80]
    ],
    captions: [
      { page: 1, rect: [0, -30, 330, -10], lines: ['Table 1 Synthetic grouped statistics'] }
    ]
  }
}
it('preserves eight native leaves, an independent sparse row and its two underlined group spans', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[1]).toEqual(['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  expect(r.grid[2]).toEqual(['Index', '2', '3', '4', '5', '6', '7', '8', '9'])
  expect(r.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 3, column: 1, colSpan: 4, text: '7' }),
      expect.objectContaining({ row: 3, column: 5, colSpan: 4, text: '9' })
    ])
  )
  expect(r.unassigned).toEqual([])
})
it.each(['missing-rule', 'missing-value', 'offcenter-value', 'crossing-ink', 'same-baseline'])(
  'requires complete independent native proof: %s',
  (mode) => {
    const x = fixture()
    if (mode === 'missing-rule') x.rules.splice(1, 1)
    if (mode === 'missing-value')
      x.tokens.splice(
        x.tokens.findIndex((i) => i.text === '2'),
        1
      )
    if (mode === 'offcenter-value') {
      const t = x.tokens.find((i) => i.text === '7' && i.baseline === 73)!
      t.rect = t.rect.map((v, n) => (n % 2 === 0 ? v + 18 : v))
    }
    if (mode === 'crossing-ink')
      x.tokens.push({ ...x.tokens[0], text: 'Extra', baseline: 73, rect: [158, 63, 210, 73] })
    if (mode === 'same-baseline') {
      const t = x.tokens.find((i) => i.text === '9' && i.baseline === 73)!
      t.rect = [t.rect[0], 46, t.rect[2], 56]
      t.baseline = 56
    }
    expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
      'native-body-records-recovered'
    )
  }
)
