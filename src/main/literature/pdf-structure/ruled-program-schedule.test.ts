import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_SCHEDULE_REFINE_MODULE ??
        'resources/pdf-structure/literature-pdf-table-refine.mjs'
    )
  ).href
)
const { recoverRuledProgramGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-program-grid.mjs')).href
)
const seed = (crop: number[], cuts: number[], ys: number[]): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'anonymous-program',
    cropRect: crop,
    structure: {
      objects: [
        ...cuts.slice(1).map((x, c) => ({
          label: 'table column',
          score: 0.99,
          rect: [cuts[c] - crop[0], 0, x - crop[0], crop[3] - crop[1]]
        })),
        ...ys.slice(1).map((y, r) => ({
          label: 'table row',
          score: 0.99,
          rect: [0, ys[r] - crop[1], crop[2] - crop[0], y - crop[1]]
        }))
      ]
    }
  },
  tokens: [],
  captions: [{ lines: ['Table 1 Program schedule'], rect: [20, 0, 220, 10] }],
  rules: []
})
const add = (
  f: ReturnType<typeof seed>,
  text: string,
  x: number,
  y: number,
  width: number
): void => {
  f.tokens.push({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true
  })
}
const schedule = (): ReturnType<typeof seed> => {
  const f = seed(
    [20, 20, 540, 300],
    [20, 106, 151, 201, 251, 301, 361, 421, 481, 540],
    [20, 38, 64, 77, 90, 112, 130, 148, 166, 184, 202, 220, 238, 256, 274, 292]
  )
  add(f, 'Schedule window', 110, 26, 90)
  add(f, 'Initial stage', 110, 53, 72)
  for (const [text, x, y, w] of [
    ['Before', 255, 41, 37],
    ['sessions', 255, 51, 42],
    ['During', 305, 41, 36],
    ['sessions', 305, 51, 42],
    ['Visit one', 365, 53, 50],
    ['later', 365, 65, 25],
    ['Visit two', 425, 53, 50],
    ['later', 425, 65, 25],
    ['Visit three', 485, 53, 50],
    ['later', 485, 65, 25],
    ['Stage', 30, 65, 28],
    ['Start', 110, 65, 28],
    ['Assign', 155, 65, 34],
    ['Point', 30, 79, 27],
    ['–', 110, 79, 5],
    ['v0', 155, 79, 12],
    ['Arm A', 205, 79, 34],
    ['Arm B', 255, 79, 34],
    ['–', 305, 79, 5],
    ['v1', 365, 79, 12],
    ['v2', 425, 79, 12]
  ] as const)
    add(f, text, x, y, w)
  for (const [text, y] of [
    ['Intake', 96],
    ['Programs', 168],
    ['Checks', 222]
  ] as const)
    add(f, text, 30, y, 45)
  for (const [text, y] of [
    ['Consent', 114],
    ['Screen', 132],
    ['Assign', 150],
    ['Arm A', 186],
    ['Arm B', 204],
    ['Item A', 240],
    ['Item B', 258],
    ['Item C', 276]
  ] as const)
    add(f, text, 34, y, 60)
  for (const y of [114, 132]) add(f, 'X', 110, y, 6)
  add(f, 'X', 205, 150, 6)
  for (const y of [240, 258, 276]) for (const x of [155, 365, 425, 485]) add(f, 'X', x, y, 6)
  f.rules = [
    [110, 38, 535, 38],
    [110, 64, 240, 64],
    [25, 292, 535, 292],
    [303, 191, 350, 191],
    [303, 209, 350, 209]
  ]
  return f
}
const components = (): ReturnType<typeof seed> => {
  const f = seed(
    [20, 20, 460, 220],
    [20, 175, 245, 315, 385, 460],
    [20, 38, 54, 68, 84, 122, 158, 180, 210]
  )
  for (const [text, x, y, w] of [
    ['Program overview', 30, 26, 96],
    ['Frequency: repeated sessions', 30, 42, 190],
    ['First phase', 180, 58, 66],
    ['Second phase', 320, 58, 72],
    ['Components', 30, 70, 67],
    ['Duration', 180, 70, 48],
    ['Level', 250, 70, 30],
    ['Duration', 320, 70, 48],
    ['Level', 390, 70, 30],
    ['Component A', 30, 90, 100],
    ['continued label', 42, 101, 95],
    ['Component B', 30, 126, 80],
    ['Group X', 30, 162, 45],
    ['Method A', 90, 162, 72],
    ['Method B', 90, 184, 72]
  ] as const)
    add(f, text, x, y, w)
  for (const y of [90, 126, 162, 184])
    for (const [text, x] of [
      ['12', 180],
      ['low', 250],
      ['18', 320],
      ['high', 390]
    ] as const)
      add(f, text, x, y, 20)
  f.rules = [
    [30, 54, 440, 54],
    [180, 68, 290, 68],
    [320, 68, 440, 68],
    [25, 200, 455, 200]
  ]
  return f
}
const refine = (f: ReturnType<typeof seed>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('retains all four schedule header tiers and the native allocation mark', () => {
  const r = refine(schedule())
  expect(r.grid[0]).toEqual(['', 'Schedule window', '', '', '', '', '', '', ''])
  expect(r.grid[3]).toEqual(['Point', '–', 'v0', 'Arm A', 'Arm B', '–', 'v1', 'v2', ''])
  expect(r.grid.find((row: string[]) => row[0] === 'Assign')).toEqual([
    'Assign',
    '',
    '',
    'X',
    '',
    '',
    '',
    '',
    ''
  ])
  expect(r.cells).toContainEqual(expect.objectContaining({ row: 0, column: 1, colSpan: 8 }))
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 1, colSpan: 3, text: 'Initial stage' })
  )
  expect(r.unassigned).toEqual([])
})

it('retains the complete native closing rule when the model clips its right endpoint', () => {
  const f = schedule()
  f.tokens.find((t: { text: string }) => t.text === 'Visit three').rect[2] = 530
  f.table.cropRect[2] = 532
  expect(recoverRuledProgramGrid(f.table, f.tokens, f.captions, f.rules)?.cropRect?.[2]).toBe(535.5)
  const r = refine(f)
  expect(r.cropRect[2]).toBeGreaterThanOrEqual(535)
  expect(r.grid).toEqual(refine(schedule()).grid)
  expect(r.unassigned).toEqual([])
})

it.each([true, false])(
  'keeps the original crop when the proposed border strip contains foreign ink (horizontal=%s)',
  (horizontal) => {
    const f = schedule()
    f.tokens.find((t: { text: string }) => t.text === 'Visit three').rect[2] = 530
    f.table.cropRect[2] = 532
    add(f, 'Foreign', 533, 180, 2)
    f.tokens.at(-1).horizontal = horizontal
    expect(recoverRuledProgramGrid(f.table, f.tokens, f.captions, f.rules)?.cropRect).toEqual(
      f.table.cropRect
    )
    const r = refine(f)
    expect(r.cropRect).toEqual(f.table.cropRect)
    expect(r.grid).toEqual(refine(schedule()).grid)
    expect(r.unassigned).toEqual([])
  }
)

it('retains both overall titles and a two-row component parent in six native columns', () => {
  const r = refine(components())
  expect(r.grid[0]).toEqual(['Program overview', '', '', '', '', ''])
  expect(r.grid[1]).toEqual(['Frequency: repeated sessions', '', '', '', '', ''])
  expect(r.grid[3]).toEqual(['', '', 'Duration', 'Level', 'Duration', 'Level'])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 2, column: 0, colSpan: 2, rowSpan: 2, text: 'Components' })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 6, column: 0, rowSpan: 2, text: 'Group X' })
  )
  expect(r.grid[7][1]).toBe('Method B')
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    components()
      .tokens.map((i: { rect: number[] }) => i.rect)
      .sort()
  )
})

it.each([
  'missing subgroup',
  'missing closing',
  'competing closing',
  'distant closing endpoint',
  'missing timepoint',
  'foreign text',
  'misplaced X',
  'captionless'
])('declines a schedule with %s', (reason) => {
  const f = schedule()
  if (reason === 'missing subgroup') f.rules = f.rules.filter((r: number[]) => r[1] !== 64)
  if (reason === 'missing closing') f.rules = f.rules.filter((r: number[]) => r[1] !== 292)
  if (reason === 'competing closing') f.rules.push([25, 293, 535, 293])
  if (reason === 'distant closing endpoint') f.rules.find((r: number[]) => r[1] === 292)[2] = 560
  if (reason === 'missing timepoint')
    f.tokens = f.tokens.filter((t: { text: string }) => t.text !== 'v2')
  if (reason === 'foreign text') add(f, 'Unrelated paragraph', 160, 200, 170)
  if (reason === 'misplaced X')
    f.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === 'X' && t.rect[0] === 485
    ).rect = [450, 240, 456, 248]
  if (reason === 'captionless') f.captions = []
  expect(recoverRuledProgramGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  'missing underline',
  'missing closing',
  'mismatched leaf',
  'missing child',
  'shifted child',
  'foreign text',
  'captionless'
])('declines components with %s', (reason) => {
  const f = components()
  if (reason === 'missing underline') f.rules = f.rules.filter((r: number[]) => r[0] !== 320)
  if (reason === 'missing closing') f.rules = f.rules.filter((r: number[]) => r[1] !== 200)
  if (reason === 'mismatched leaf')
    f.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === 'Duration' && t.rect[0] === 320
    ).text = 'Other leaf'
  if (reason === 'missing child')
    f.tokens = f.tokens.filter((t: { text: string }) => t.text !== 'Method B')
  if (reason === 'shifted child')
    f.tokens.find((t: { text: string }) => t.text === 'Method B').rect = [110, 184, 182, 192]
  if (reason === 'foreign text') add(f, 'Unrelated paragraph', 100, 148, 180)
  if (reason === 'captionless') f.captions = []
  expect(recoverRuledProgramGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
