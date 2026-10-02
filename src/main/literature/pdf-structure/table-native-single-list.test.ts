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
  const tokens = [
    'Topics',
    'First',
    'Second',
    'Third',
    'Fourth',
    'Fifth',
    'Sixth',
    'Seventh',
    'Eighth'
  ].map((text, n) => ({
    text,
    rect: [5, n * 15 + 3, 90, n * 15 + 13],
    baseline: n * 15 + 13,
    height: 10,
    horizontal: true
  }))
  const objects = [
    { label: 'table column', rect: [0, 0, 100, 140] },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
      label: 'table row',
      rect: [0, 15 + n * 15, 100, n === 7 ? 140 : 30 + n * 15]
    }))
  ]
  return {
    table: { id: 'page-1-table-1', cropRect: [0, 0, 100, 140], structure: { objects } },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Topics.'], rect: [0, -30, 100, -10] }],
    rules: [
      [0, 0, 100, 0],
      [0, 15, 100, 15],
      [0, 140, 100, 140]
    ]
  }
}
it('retains a ruled single-column header and every independent native list baseline', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toEqual(f.tokens.map((i) => [i.text]))
  expect(t.unassigned).toEqual([])
})
const { recoverStudyParagraphGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
it.each(['native closure', 'caption ownership', 'independent leading'])(
  'declines single native lists without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'native closure') f.rules.pop()
    if (kind === 'caption ownership') f.captions = []
    if (kind === 'independent leading') {
      const i = f.tokens[2]
      i.rect = [5, 29, 90, 39]
      i.baseline = 39
    }
    expect(recoverStudyParagraphGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
