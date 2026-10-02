import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_SCALE_REFINE_MODULE ??
        'resources/pdf-structure/literature-pdf-table-refine.mjs'
    )
  ).href
)
const { recoverRuledScaleCohortGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-scale-cohort-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const cuts = [20, 130, 180, 220, 290, 360, 440, 490],
    ys = [20, 64, 98, 118, 158, 178, 198, 218, 258, 278]
  const f = {
    table: {
      id: 'anonymous-paired-scales',
      cropRect: [20, 20, 490, 292],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({
            label: 'table column',
            score: 0.99,
            rect: [cuts[c] - 20, 0, x - 20, 272]
          })),
          ...ys.slice(1).map((y, r) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, ys[r] - 20, 470, y - 20]
          }))
        ]
      }
    },
    tokens: [] as Record<string, unknown>[],
    captions: [{ lines: ['Table 1 Paired scale measures'], rect: [20, 0, 220, 10] }],
    rules: [] as number[][]
  }
  const add = (text: string, x: number, y: number, width: number): void => {
    f.tokens.push({
      text,
      rect: [x, y, x + width, y + 12],
      baseline: y + 12,
      height: 12,
      horizontal: true
    })
  }
  for (const [text, x, y, w] of [
    ['Cohort', 130, 24, 38],
    ['N', 180, 24, 6],
    ['V1', 220, 24, 12],
    ['V2', 290, 24, 12],
    ['Change', 360, 24, 38],
    ['Mean (SD)', 220, 44, 58],
    ['Mean (SD)', 290, 44, 58],
    ['Mean (SD)', 360, 44, 58],
    ['p value', 440, 44, 42]
  ] as const)
    add(text, x, y, w)
  for (const [text, y] of [
    ['Scale A', 70],
    ['Scale B', 130],
    ['Scale C', 230]
  ] as const)
    add(text, 24, y, 70)
  for (const [label, y, values] of [
    ['Measure A', 90, ['27', '12.3 (4.5)', '15.2 (4.8)', '2.9 (3.2)', '0.37']],
    ['Measure B', 150, ['28', '18.4 (5.2)', '16.3 (5.1)', '−2.1 (4.1)', '0.42']],
    ['Measure C', 190, ['26', '13.8 (4.7)', '15.6 (4.9)', '1.8 (3.6)', '0.53']],
    ['Measure D', 250, ['29', '16.5 (5.1)', '17.2 (5.4)', '0.7 (3.9)', '0.64']]
  ] as const) {
    add(label, 30, y, 85)
    add('Set A', 130, y, 32)
    values.forEach((v, c) =>
      add(v, [180, 220, 290, 360, 440][c], y, c === 0 ? 16 : c === 4 ? 30 : 60)
    )
    add('Set B', 130, y + 20, 32)
    ;['30', '17.2 (5.3)', '18.1 (5.6)', '0.9 (4.2)'].forEach((v, c) =>
      add(v, [180, 220, 290, 360][c], y + 20, c === 0 ? 16 : 60)
    )
  }
  for (const y of [22, 64, 288])
    for (let c = 0; c < 7; c++) f.rules.push([cuts[c], y, cuts[c + 1], y])
  f.rules.push([360, 42, 490, 42])
  return f
}

it('keeps scale titles separate and each measure and probability over its two cohort records', () => {
  const f = fixture(),
    before = structuredClone(f),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(recoverRuledScaleCohortGrid(f.table, f.tokens, f.captions, f.rules)?.rows).toHaveLength(13)
  expect(r.grid).toHaveLength(13)
  expect(r.grid[2]).toEqual(['Scale A', '', '', '', '', '', ''])
  expect(r.grid[5]).toEqual(['Scale B', '', '', '', '', '', ''])
  expect(r.grid[10]).toEqual(['Scale C', '', '', '', '', '', ''])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 5, colSpan: 2, text: 'Change' })
  )
  for (const row of [3, 6, 8, 11])
    for (const column of [0, 6])
      expect(r.cells).toContainEqual(expect.objectContaining({ row, column, rowSpan: 2 }))
  expect(r.grid[3].slice(1)).toEqual([
    'Set A',
    '27',
    '12.3 (4.5)',
    '15.2 (4.8)',
    '2.9 (3.2)',
    '0.37'
  ])
  expect(r.grid[4].slice(1)).toEqual(['Set B', '30', '17.2 (5.3)', '18.1 (5.6)', '0.9 (4.2)', ''])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it.each([
  'missing closing',
  'mismatched band',
  'missing shared underline',
  'missing first heading',
  'shifted section',
  'missing mean',
  'different second cohort',
  'second probability',
  'foreign prose',
  'captionless'
])('declines incomplete scale ownership with %s', (reason) => {
  const f = fixture()
  if (reason === 'missing closing') f.rules = f.rules.filter((r: number[]) => r[1] !== 288)
  if (reason === 'mismatched band')
    f.rules.find((r: number[]) => r[1] === 288 && r[0] === 220)[2] += 2
  if (reason === 'missing shared underline') f.rules = f.rules.filter((r: number[]) => r[1] !== 42)
  if (reason === 'missing first heading')
    f.tokens = f.tokens.filter((t: { text: string }) => t.text !== 'Scale A')
  if (reason === 'shifted section')
    f.tokens.find((t: { text: string }) => t.text === 'Scale B').rect = [34, 130, 104, 138]
  if (reason === 'missing mean')
    f.tokens = f.tokens.filter((t: { text: string }) => t.text !== '12.3 (4.5)')
  if (reason === 'different second cohort')
    f.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === 'Set B' && t.rect[1] === 170
    ).text = 'Set C'
  if (reason === 'second probability')
    f.tokens.push({
      text: '0.26',
      rect: [440, 110, 470, 118],
      baseline: 118,
      height: 8,
      horizontal: true
    })
  if (reason === 'foreign prose')
    f.tokens.push({
      text: 'Unrelated paragraph',
      rect: [30, 138, 120, 146],
      baseline: 146,
      height: 8,
      horizontal: true
    })
  if (reason === 'captionless') f.captions = []
  expect(recoverRuledScaleCohortGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
