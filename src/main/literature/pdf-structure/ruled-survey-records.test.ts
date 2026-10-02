import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_SURVEY_REFINE_MODULE ??
        'resources/pdf-structure/literature-pdf-table-refine.mjs'
    )
  ).href
)
const { recoverRuledSurveyRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-survey-record-grid.mjs')).href
)

const fixture = (five = false): ReturnType<typeof JSON.parse> => {
  const cuts = five ? [20, 220, 370, 520, 680, 750] : [20, 220, 370, 520, 650],
    divider = five ? 92 : 80
  const f = {
    table: {
      id: 'anonymous-survey-records',
      cropRect: [15, 15, cuts.at(-1)! + 5, 294],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({
            label: 'table column',
            score: 0.99,
            rect: [cuts[c] - 15, 0, x - 15, 279]
          })),
          {
            label: 'table column header',
            score: 0.99,
            rect: [0, 0, cuts.at(-1)! - 15, divider - 15]
          },
          ...[divider, 128, 146, 182, 218, 254, 290].slice(1).map((y, r, a) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, (r ? a[r - 1] : divider) - 15, cuts.at(-1)! - 15, y - 15]
          }))
        ]
      }
    },
    tokens: [] as Record<string, unknown>[],
    captions: [{ lines: ['Table 1 Comparison records'], rect: [20, 0, 210, 10] }],
    rules: [] as number[][]
  }
  const add = (text: string, x: number, y: number, width: number, h = 12): void => {
    f.tokens.push({
      text,
      rect: [x, y, x + width, y + h],
      height: h,
      baseline: y + h,
      horizontal: true
    })
  }
  if (!five) {
    add('Record', 20, 24, 60)
    add('Set A', 220, 24, 40)
    add('Set B', 370, 24, 40)
    add('Expanded', 520, 24, 64)
    add('set', 520, 40, 22)
    add('N', 20, 62, 7)
    ;['44', '27', '17'].forEach((v, c) => add(v, cuts[c + 1], 62, 20))
  } else {
    add('Response', 20, 24, 70)
    add('Comparison', 220, 24, 85)
    add('Set A (0)', 220, 50, 65)
    add('Set B (1)', 370, 50, 65)
    add('OR (95% CI)', 520, 50, 85)
    add('p value', 680, 50, 48)
    add('Proportion (%) (n=44)', 220, 78, 125)
    add('Proportion (%) (n=42)', 370, 78, 125)
    f.rules.push([220, 44, 750, 44])
  }
  for (const y of [20, divider, 292])
    for (let c = 0; c < cuts.length - 1; c++) f.rules.push([cuts[c], y, cuts[c + 1], y])
  add('Section A', 20, divider + 4, 80)
  if (!five) {
    for (const [label, y, v] of [
      ['Option A', 110, ['21', '25', '18']],
      ['Option B', 128, ['31', '33', '28']],
      ['Option C', 164, ['48', '42', '54']],
      ['Option D', 200, ['12', '14', '10']],
      ['Option E', 236, ['19', '17', '22']],
      ['Option F', 272, ['69', '69', '68']]
    ] as const) {
      add(label, 28, y, 75)
      v.forEach((s, c) => add(s, cuts[c + 1] - 0.03, y, 20))
    }
    add('Section B', 20, 146, 80)
  } else {
    for (const [label, y, v] of [
      ['Reference', 110, ['18.2', '23.8', '1.00', '0.341']],
      ['Agree', 146, ['81.8', '76.2', '0.72 (0.31–1.67)', '']],
      ['Reference', 182, ['9.1', '14.3', '1.00', '']],
      ['Agree', 218, ['90.9', '85.7', '0.58 (0.17–1.98)', '0.392']],
      ['Agree', 272, ['84.1', '78.6', '0.69 (0.28–1.69)', '0.416']]
    ] as const) {
      add(label, 28, y, 70)
      v.forEach((s, c) => {
        if (s) add(s, cuts[c + 1] - 0.03, y, c === 2 ? 120 : 35)
      })
      if (label === 'Reference') add('b', 98, y - 1, 5, 8.4)
    }
    add('Statement B', 20, 164, 90)
    add('Statement C', 20, 254, 90)
  }
  return f
}

it('retains an explicit N row and a subsection separately from its preceding numeric category', () => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[1]).toEqual(['N', '44', '27', '17'])
  expect(r.grid.find((v: string[]) => v[0] === 'Section B')).toEqual(['Section B', '', '', ''])
  expect(r.grid.find((v: string[]) => v[0] === 'Option B')).toEqual(['Option B', '31', '33', '28'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('retains three native header tiers, reference markers and P on its printed physical row', () => {
  const f = fixture(true),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[2].slice(1, 3)).toEqual(['Proportion (%) (n=44)', 'Proportion (%) (n=42)'])
  expect(r.grid.find((v: string[]) => v[0] === 'Referenceb')).toEqual([
    'Referenceb',
    '18.2',
    '23.8',
    '1.00',
    '0.341'
  ])
  expect(r.grid.find((v: string[]) => v[0] === 'Agree')).toEqual([
    'Agree',
    '81.8',
    '76.2',
    '0.72 (0.31–1.67)',
    ''
  ])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('owns raised standalone data markers only through one complete proportion record', () => {
  const f = fixture(true)
  f.tokens = f.tokens.filter(
    (i: { text: string; rect: number[] }) =>
      !(i.rect[1] === 110 && (i.text === '1.00' || i.text === '0.341'))
  )
  for (const x of [520, 680])
    f.tokens.push({
      text: 'a',
      rect: [x, 108.8, x + 5, 117.2],
      height: 8.4,
      baseline: 117.2,
      horizontal: true
    })
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid.find((v: string[]) => v[0] === 'Referenceb')).toEqual([
    'Referenceb',
    '18.2',
    '23.8',
    'a',
    'a'
  ])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it.each([
  'missing caption',
  'missing closing',
  'mismatched frame',
  'missing N',
  'lost numeric lane',
  'wide numeric overhang',
  'extra prose in data lane',
  'duplicate token',
  'missing parent underline',
  'missing proportion',
  'unsupported interval',
  'detached marker'
])('rejects incomplete source proof: %s', (kind) => {
  const five = [
      'missing parent underline',
      'missing proportion',
      'unsupported interval',
      'detached marker'
    ].includes(kind),
    f = fixture(five)
  if (kind === 'missing caption') f.captions = []
  if (kind === 'missing closing') f.rules = f.rules.filter((r: number[]) => r[1] !== 292)
  if (kind === 'mismatched frame') f.rules.find((r: number[]) => r[1] === 292)![2] += 4
  if (kind === 'missing N') f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'N')
  if (kind === 'lost numeric lane')
    f.tokens = f.tokens.filter((i: { rect: number[] }) => i.rect[0] < 520)
  if (kind === 'wide numeric overhang') {
    const i = f.tokens.find((i: { text: string }) => i.text === '21')!
    i.rect[0] -= 4
  }
  if (kind === 'extra prose in data lane')
    f.tokens.push({
      text: 'Article prose',
      rect: [221, 148, 310, 160],
      height: 12,
      baseline: 160,
      horizontal: true
    })
  if (kind === 'duplicate token') f.tokens.push(f.tokens[0])
  if (kind === 'missing parent underline') f.rules = f.rules.filter((r: number[]) => r[1] !== 44)
  if (kind === 'missing proportion')
    f.tokens = f.tokens.filter((i: { text: string }) => !i.text.startsWith('Proportion'))
  if (kind === 'unsupported interval')
    f.tokens.find((i: { text: string }) => i.text.startsWith('0.72'))!.text = 'uncertain'
  if (kind === 'detached marker') {
    const i = f.tokens.find((i: { text: string }) => i.text === 'b')!
    i.rect = [690, 129, 695, 137.4]
    i.baseline = 137.4
  }
  expect(recoverRuledSurveyRecordGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
