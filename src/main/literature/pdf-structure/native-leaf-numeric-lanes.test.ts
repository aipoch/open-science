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
const fixture = (): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  tokens: Token[]
  rules: number[][]
  captions: { page: number; lines: string[]; rect: number[] }[]
} => {
  const tokens: Token[] = [],
    objects = [
      { label: 'table column header', score: 1, rect: [0, 5, 250, 22] },
      { label: 'table row', score: 1, rect: [0, 5, 250, 22] }
    ]
  const add = (text: string, x: number, y: number, width: number): void => {
    tokens.push({
      text,
      rect: [x, y - 10, x + width, y],
      baseline: y,
      height: 10,
      horizontal: true
    })
  }
  for (const [n, text] of ['Record', 'Metric A', 'Metric B', 'x', 'y'].entries())
    add(text, n ? 85 + n * 35 : 5, 18, n === 0 ? 40 : n < 3 ? 30 : 8)
  for (let n = 0; n < 4; n++) {
    const y = 40 + n * 16
    add('Case ' + String.fromCharCode(65 + n), 5, y, 50)
    for (let c = 1; c < 5; c++) add(String(c * 7 + n) + '.2', 85 + c * 35, y, 24)
    objects.push({ label: 'table row', score: 1, rect: [0, y - 10, 250, y] })
  }
  objects.push(
    ...[
      [0, 100],
      [100, 152],
      [152, 187],
      [187, 250]
    ].map(([a, b]) => ({ label: 'table column', score: 1, rect: [a, 5, b, 98] }))
  )
  return {
    table: {
      id: 'synthetic-independent-leaves',
      cropRect: [0, 0, 250, 101],
      structure: { objects }
    },
    tokens,
    rules: [
      [0, 5, 250, 5],
      [0, 25, 250, 25],
      [0, 98, 250, 98]
    ],
    captions: [{ page: 1, lines: ['Table 1 Synthetic measurements'], rect: [0, -25, 250, -10] }]
  }
}
it('keeps every source leaf and complete numeric lane when the model merges the last pair', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toEqual(['Record', 'Metric A', 'Metric B', 'x', 'y'])
  expect(r.grid).toHaveLength(5)
  expect(r.grid[1]).toEqual(['Case A', '7.2', '14.2', '21.2', '28.2'])
  expect(r.unassigned).toEqual([])
})
it.each([
  'missing-value',
  'missing-rule',
  'crossing-text',
  'competing-caption',
  'different-baseline'
])('does not infer numeric lanes without complete source proof: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-value')
    x.tokens.splice(
      x.tokens.findIndex((i) => i.text === '28.2'),
      1
    )
  if (mode === 'missing-rule') x.rules.pop()
  if (mode === 'crossing-text')
    x.tokens.push({ ...x.tokens[0], text: 'Extra', baseline: 40, rect: [180, 30, 210, 40] })
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'different-baseline') {
    const t = x.tokens.find((i) => i.text === '28.2')!
    t.baseline += 5
    t.rect[1] += 5
    t.rect[3] += 5
  }
  expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
    'native-body-records-recovered'
  )
})
