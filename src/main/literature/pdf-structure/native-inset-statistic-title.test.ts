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
type Cell = { sourceRects: number[][] }
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
  const add = (text: string, x: number, y: number, w = 12): void => {
    tokens.push({ text, rect: [x, y - 10, x + w, y], height: 10, baseline: y, horizontal: true })
  }
  add('Statistics overview', 180, 24, 100)
  add('Group A', 149.5, 46, 50)
  add('Group B', 331, 46, 50)
  add('Contrast', 5, 68, 45)
  for (let c = 0; c < 8; c++) add(['b', 'SE', 't', 'p'][c % 4], 90 + c * 45, 68)
  for (let r = 0; r < 3; r++) {
    add('Record ' + String.fromCharCode(65 + r), 5, 92 + r * 22, 60)
    for (let c = 0; c < 8; c++) add(String(c + r + 2), 90 + c * 45, 92 + r * 22)
  }
  const objects = [{ label: 'table column header', score: 1, rect: [0, 10, 450, 73] }]
  for (let c = 0; c < 9; c++)
    objects.push({
      label: 'table column',
      score: 1,
      rect: [c ? 75 + (c - 1) * 45 : 0, 10, c === 8 ? 450 : 75 + c * 45, 140]
    })
  for (const [a, b] of [
    [10, 52],
    [52, 75],
    [75, 105],
    [105, 127],
    [127, 145]
  ])
    objects.push({ label: 'table row', score: 1, rect: [0, a, 450, b] })
  return {
    table: {
      id: 'synthetic-native-inset-title',
      cropRect: [0, 12, 450, 142],
      structure: { objects }
    },
    tokens,
    rules: [
      [0, 10, 450, 10],
      [0, 32, 450, 32],
      [82, 54, 267, 54],
      [272, 54, 440, 54],
      [0, 76, 450, 76],
      [0, 145, 450, 145]
    ],
    captions: [{ page: 1, rect: [0, 153, 450, 166], lines: ['Table 1 Synthetic statistics'] }]
  }
}
it('keeps an independently ruled full title above two four-leaf parents and complete records', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(6)
  expect(r.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 0, colSpan: 9, text: 'Statistics overview' }),
      expect.objectContaining({ row: 1, column: 1, colSpan: 4, text: 'Group A' }),
      expect.objectContaining({ row: 1, column: 5, colSpan: 4, text: 'Group B' })
    ])
  )
  expect(r.grid[2]).toEqual(['Contrast', 'b', 'SE', 't', 'p', 'b', 'SE', 't', 'p'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: Cell) => c.sourceRects)).toHaveLength(x.tokens.length)
})
it('keeps an explicit centered missing group across its four native underlined leaves', () => {
  const x = fixture()
  x.tokens = x.tokens.filter((i) => !(i.baseline === 92 && i.rect[0] >= 270))
  x.tokens.push({ text: '—', rect: [350, 82, 362, 92], height: 10, baseline: 92, horizontal: true })
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.cells).toEqual(
    expect.arrayContaining([expect.objectContaining({ row: 3, column: 5, colSpan: 4, text: '—' })])
  )
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: Cell) => c.sourceRects)).toHaveLength(x.tokens.length)
})
it('rejects an off-center or competing missing-group owner', () => {
  for (const mode of ['offcenter', 'competing']) {
    const x = fixture()
    x.tokens = x.tokens.filter((i) => !(i.baseline === 92 && i.rect[0] >= 270))
    x.tokens.push({
      text: '—',
      rect: [mode === 'offcenter' ? 370 : 350, 82, mode === 'offcenter' ? 382 : 362, 92],
      height: 10,
      baseline: 92,
      horizontal: true
    })
    if (mode === 'competing')
      x.tokens.push({
        text: '8',
        rect: [400, 82, 412, 92],
        height: 10,
        baseline: 92,
        horizontal: true
      })
    expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)?.headerRows).not.toEqual(
      [0, 1, 2]
    )
  }
})
it.each([
  'missing-title-rule',
  'missing-parent-rule',
  'missing-field',
  'crossing-field',
  'off-baseline',
  'foreign-title'
])('requires a complete native title and numerical matrix: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-title-rule') x.rules.splice(1, 1)
  if (mode === 'missing-parent-rule') x.rules.splice(2, 1)
  if (mode === 'missing-field')
    x.tokens.splice(
      x.tokens.findIndex((i) => i.text === '2'),
      1
    )
  if (mode === 'crossing-field') x.tokens.find((i) => i.text === '2')!.rect[2] = 142
  if (mode === 'off-baseline') {
    const t = x.tokens.find((i) => i.text === '2')!
    t.baseline += 7
    t.rect[1] += 7
    t.rect[3] += 7
  }
  if (mode === 'foreign-title')
    x.tokens.push({ ...x.tokens[0], text: 'External prose', rect: [2, 14, 75, 24] })
  const r = recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)
  expect(
    r?.spans.some((s: { row: number; colSpan: number }) => s.row === 0 && s.colSpan === 9)
  ).not.toBe(true)
})
