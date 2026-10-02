import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
function fixture(): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  tokens: Token[]
  rules: number[][]
  captions: { page: number; lines: string[]; rect: number[] }[]
} {
  const tokens: Token[] = []
  const add = (text: string, x: number, y: number, w: number): void => {
    tokens.push({ text, rect: [x, y - 10, x + w, y], baseline: y, height: 10, horizontal: true })
  }
  for (const [n, s] of ['Index', 'Comparator', 'Limit A', 'Limit B'].entries())
    add(s, [5, 60, 145, 230][n], 18, [20, 50, 35, 35][n])
  for (let r = 0; r < 4; r++) {
    const y = 40 + r * 18
    add(String(r + 2), 5, y, 15)
    add('Case ' + String.fromCharCode(65 + r), 60, y, 50)
    for (const x of [140, 225]) {
      add('−0.21', x, y, 20)
      add('[−0.3,', x + 24, y, 20)
      add('−0.1]', x + 46, y, 20)
    }
  }
  const objects = [
    { label: 'table column header', score: 1, rect: [0, 5, 330, 25] },
    { label: 'table row', score: 1, rect: [0, 5, 330, 25] }
  ]
  for (let n = 0; n < 4; n++)
    objects.push({ label: 'table row', score: 1, rect: [0, 30 + n * 18, 330, 40 + n * 18] })
  for (const [a, b] of [
    [0, 40],
    [40, 125],
    [125, 210],
    [210, 260],
    [260, 330]
  ])
    objects.push({ label: 'table column', score: 1, rect: [a, 5, b, 104] })
  return {
    table: {
      id: 'synthetic-complete-interval-lanes',
      cropRect: [0, 0, 330, 104],
      structure: { objects }
    },
    tokens,
    rules: [
      [0, 5, 330, 5],
      [0, 25, 330, 25],
      [0, 100, 330, 100]
    ],
    captions: [{ page: 1, lines: ['Table 1 Synthetic limits'], rect: [0, -30, 330, -10] }]
  }
}
it('keeps complete estimate-and-interval records in each native leaf lane', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toEqual(['Index', 'Comparator', 'Limit A', 'Limit B'])
  expect(r.grid[1]).toEqual(['2', 'Case A', '−0.21 [−0.3, −0.1]', '−0.21 [−0.3, −0.1]'])
  expect(r.unassigned).toEqual([])
})
it.each([
  'missing-field',
  'missing-footer',
  'crossing-header',
  'different-baseline',
  'competing-caption'
])('does not choose source lanes without complete native proof: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-field')
    x.tokens = x.tokens.filter((i) => !(i.baseline === 40 && i.rect[0] > 220))
  if (mode === 'missing-footer') x.rules.pop()
  if (mode === 'crossing-header') x.tokens[2].rect[2] = 250
  if (mode === 'different-baseline') {
    x.tokens[7].baseline += 7
    x.tokens[7].rect[1] += 7
    x.tokens[7].rect[3] += 7
  }
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
    'native-body-records-recovered'
  )
})
