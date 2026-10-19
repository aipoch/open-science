import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const {
  detectNativeTableAmbiguity,
  hasDisjointNativeTableSlots,
  hasNativeMergedFractionRecords,
  hasClippedNativeHeading
} = await import(pathToFileURL(resolve('resources/literature-pdf-native-table-ambiguity.mjs')).href)
type Data = ReturnType<typeof JSON.parse>

function closedSplitRecord(): Data {
  const entries: [string, number, number, number][] = [
    ['Complete description of one record.', 10, 10, 180],
    ['Reference A', 210, 10, 70],
    ['Reference B', 210, 25, 70],
    ['Reference C', 210, 40, 70],
    ['Another complete record.', 10, 70, 180],
    ['Reference D', 210, 70, 70],
    ['Final complete record.', 10, 100, 180],
    ['Reference E', 210, 100, 70]
  ]
  return {
    table: {
      id: 'closed-record',
      cropRect: [0, 0, 300, 120],
      structure: {
        objects: [
          ...[
            [0, 200],
            [200, 300]
          ].map(([l, r]) => ({ label: 'table column', rect: [l, 0, r, 120] })),
          ...[
            [0, 22],
            [22, 60],
            [60, 90],
            [90, 120]
          ].map(([t, b]) => ({ label: 'table row', rect: [0, t, 300, b] }))
        ]
      }
    },
    items: entries.map(([text, x, y, w], index) => ({
      text,
      rect: [x, y, x + w, y + 8],
      height: 8,
      baseline: y + 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    rules: [
      ...[0, 60, 90, 120].map((y) => [0, y, 300, y]),
      ...[0, 200, 300].map((x) => [x, 0, x, 120])
    ]
  }
}

it('flags logical record splitting inside a single complete native prose face', () => {
  const result = run(closedSplitRecord())
  expect(result.grid[0][0]).toBe('Complete description of one record.')
  expect(result.grid[1][0]).toBe('')
  expect(result.issues).toContain('native-table-structure-ambiguous')
})

function mergedFractionRecords(): Data {
  const entries: [string, number, number, number][] = [
    ['Index', 5, 5, 20],
    ['Value', 45, 5, 30],
    ...[0, 1, 2, 3].flatMap((n): [string, number, number, number][] => [
      [`${n + 5} ${n + 12345}`, 5, 25 + n * 16, 65],
      ['/', 70, 25 + n * 16, 5],
      ['6789', 75, 25 + n * 16, 20]
    ])
  ]
  return {
    table: {
      id: 'indexed-fractions',
      cropRect: [0, 0, 110, 100],
      structure: {
        objects: [
          ...[
            [0, 30],
            [30, 110]
          ].map(([l, r]) => ({ label: 'table column', rect: [l, 0, r, 100] })),
          ...[
            [0, 20],
            [20, 40],
            [40, 56],
            [56, 72]
          ].map(([t, b]) => ({ label: 'table row', rect: [0, t, 110, b] }))
        ]
      }
    },
    items: entries.map(([text, x, y, w], index) => ({
      text,
      rect: [x, y, x + w, y + 10],
      height: 10,
      baseline: y + 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    rules: [
      [0, 0, 110, 0],
      [0, 20, 110, 20],
      [0, 94, 110, 94]
    ]
  }
}

it('flags consecutive whole native fraction records merged into one logical row', () => {
  const result = run(mergedFractionRecords())
  expect(result.repairs).toContain('ruled-final-continuation-recovered')
  expect(result.issues).toContain('native-table-structure-ambiguous')
})

it.each([
  'open-face',
  'missing-divider',
  'independent-record',
  'crossing-ink',
  'foreign-alias',
  'extra-ink',
  'internal-rule'
])('retains existing review behavior without a complete prose face: %s', (kind) => {
  const f = closedSplitRecord()
  if (kind === 'open-face') f.rules = f.rules.filter((r: number[]) => r[0] !== 300 || r[2] !== 300)
  if (kind === 'missing-divider')
    f.rules = f.rules.filter((r: number[]) => r[0] !== 200 || r[2] !== 200)
  if (kind === 'independent-record')
    f.items.push({
      ...f.items[0],
      text: 'Independent entry.',
      rect: [10, 25, 190, 33],
      baseline: 33,
      sourceItem: { pageNumber: 1, index: 99, text: 'Independent entry.' }
    })
  if (kind === 'crossing-ink') f.items[3].rect[3] = 61
  if (kind === 'foreign-alias') f.items.push({ ...f.items[0], rect: [400, 400, 500, 408] })
  if (kind === 'extra-ink')
    f.items.push({
      text: 'Other',
      rect: [197, 30, 204, 38],
      baseline: 38,
      height: 8,
      horizontal: false
    })
  if (kind === 'internal-rule') f.rules.push([0, 22, 300, 22])
  expect(run(f).issues).not.toContain('native-table-structure-ambiguous')
})

it.each([
  'missing-footer',
  'independent-rule',
  'nonconsecutive',
  'different-pitch',
  'script',
  'unknown-source',
  'external-alias',
  'split-font-gap',
  'overlapping-fonts',
  'foreign-ink'
])('does not infer complete merged fraction records from %s evidence', (kind) => {
  const f = mergedFractionRecords()
  if (kind === 'missing-footer') f.rules.pop()
  if (kind === 'independent-rule') f.rules.push([0, 72, 110, 72])
  if (kind === 'nonconsecutive') f.items[11].text = f.items[11].sourceItem.text = '9 12348'
  if (kind === 'different-pitch')
    for (const i of f.items.slice(-3)) {
      i.rect[1] += 2
      i.rect[3] += 2
      i.baseline += 2
    }
  if (kind === 'script') f.items.at(-1).height = 5
  if (kind === 'unknown-source') delete f.items.at(-1).sourceItem
  if (kind === 'external-alias')
    f.items.push({
      text: '',
      rect: [400, 400, 500, 410],
      metadata: { sourceItems: [structuredClone(f.items.at(-1).sourceItem)] }
    })
  if (kind === 'split-font-gap') f.items.at(-2).rect[0] += 2
  if (kind === 'overlapping-fonts') f.items.at(-2).rect[0] -= 2
  if (kind === 'foreign-ink')
    f.items.push({
      text: 'Other',
      rect: [50, 70, 60, 75],
      height: 5,
      baseline: 75,
      horizontal: false
    })
  const result = run(f)
  expect(hasNativeMergedFractionRecords(result, f.items, f.rules)).toBe(false)
})

it('checks all expanded cell slots before proving a selected header component', () => {
  const table = {
    grid: [
      ['Heading', ''],
      ['A', '1'],
      ['B', '2']
    ],
    cells: [
      { row: 0, column: 0, rowSpan: 1, colSpan: 2 },
      { row: 1, column: 0, rowSpan: 1, colSpan: 1 },
      { row: 1, column: 1, rowSpan: 1, colSpan: 1 },
      { row: 2, column: 0, rowSpan: 1, colSpan: 1 },
      { row: 2, column: 1, rowSpan: 1, colSpan: 1 }
    ]
  }
  expect(hasDisjointNativeTableSlots(table)).toBe(true)
  table.cells[1].rowSpan = 2
  expect(hasDisjointNativeTableSlots(table)).toBe(false)
  table.cells[1].rowSpan = 1
  table.cells[4].column = 2
  expect(hasDisjointNativeTableSlots(table)).toBe(false)
})

function mathematicalTitle(): ReturnType<typeof JSON.parse> {
  const items = [
    ['q', 20, 10, 10],
    ['/u', 34, 10, 15],
    ['1.2', 10, 40, 12],
    ['2.4', 40, 40, 12],
    ['3.6', 10, 60, 12],
    ['4.8', 40, 60, 12]
  ].map(([text, x, y, width], index) => ({
    text,
    sourceItem: { pageNumber: 1, index, text },
    rect: [x, y, Number(x) + Number(width), Number(y) + 8],
    baseline: Number(y) + 8,
    height: 8,
    horizontal: true
  }))
  return {
    items,
    rules: [
      [0, 5, 65, 5],
      [0, 30, 65, 30],
      [0, 75, 65, 75]
    ],
    table: {
      cropRect: [0, 0, 65, 75],
      structure: {
        objects: [
          ...[
            [0, 32],
            [32, 65]
          ].map(([a, b]) => ({ label: 'table column', rect: [a, 0, b, 75] })),
          ...[
            [0, 30],
            [30, 50],
            [50, 75]
          ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 65, b] })),
          { label: 'table column header', rect: [0, 0, 65, 30] }
        ]
      }
    }
  }
}

function run(input: ReturnType<typeof mathematicalTitle>): ReturnType<typeof JSON.parse> {
  return refineTable(input.table, input.items, [], [], input.rules)
}

function sparseSectionHeading(): Data {
  const f = evidence(7, 4)
  f.table.cropRect = [0, 0, 240, 150]
  const rows = [
    ['Group', 'Rate', 'Count', 'Range'],
    ['First category', '', '', ''],
    ['A', '10', '20', '30'],
    ['B', '11', '21', '31'],
    ['Other category', '', '', ''],
    ['C', '12', '22', '32'],
    ['D', '13', '23', '33']
  ]
  for (const [row, texts] of rows.entries()) {
    for (const [column, text] of texts.entries()) {
      if (row === 4 && column > 0) continue
      const fonts = text
        ? [f.font(text, column * 60 + 10, row * 20 + 5, [1, 4].includes(row) ? 100 : 25)]
        : []
      f.cell(row, column, fonts, row === 4 ? 4 : 1)
    }
  }
  f.proved = f.proved.filter((p: Data) => p.fonts.length)
  f.rules = [0, 20, 40, 80, 100, 140].map((y) => [0, y, 240, y])
  return f
}

it('reviews a sparse section heading claiming one column across established lanes', () => {
  expect(reviewedKinds(sparseSectionHeading())).toContain('sparse-section-heading-overhang')
})

it.each([
  'no dividers',
  'short divider',
  'no full-width peer',
  'correct section span',
  'legitimate short sparse label',
  'different peer type size',
  'incomplete body proof',
  'misaligned body record',
  'crossing body lanes',
  'foreign section ink',
  'external source alias',
  'overlapping model slot'
])('does not certify a sparse section ambiguity without complete evidence: %s', (variant) => {
  const f = sparseSectionHeading(),
    title = f.proved.find((p: Data) => p.cell.row === 1),
    peer = f.proved.find((p: Data) => p.cell.row === 4),
    body = f.proved.find((p: Data) => p.cell.row === 2 && p.cell.column === 1)
  if (variant === 'no dividers') f.rules = []
  if (variant === 'short divider') f.rules.find((r: number[]) => r[1] === 40)[2] = 150
  if (variant === 'no full-width peer') peer.cell.colSpan = 1
  if (variant === 'correct section span') {
    title.cell.colSpan = 4
    f.table.cells = f.table.cells.filter((c: Data) => c.row !== 1 || c.column === 0)
  }
  if (variant === 'legitimate short sparse label') title.fonts[0].rect[2] = 35
  if (variant === 'different peer type size') peer.fonts[0].height = 9
  if (variant === 'incomplete body proof') f.proved = f.proved.filter((p: Data) => p !== body)
  if (variant === 'misaligned body record') body.fonts[0].baseline += 2
  if (variant === 'crossing body lanes') body.fonts[0].rect[0] = 20
  if (variant === 'foreign section ink') f.font('Unknown', 180, 25, 20)
  if (variant === 'external source alias')
    f.inventory.push({ ...title.fonts[0], rect: [500, 500, 600, 508] })
  if (variant === 'overlapping model slot') title.cell.rowSpan = 2
  expect(reviewedKinds(f)).not.toContain('sparse-section-heading-overhang')
})

it('retains a mathematical title and its native fields while flagging ambiguous leaf ownership', () => {
  const result = run(mathematicalTitle())
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.grid).toEqual([
    ['q', '/u'],
    ['1.2', '2.4'],
    ['3.6', '4.8']
  ])
  expect(result.cells.flatMap((cell: { sourceItems: unknown[] }) => cell.sourceItems)).toHaveLength(
    6
  )
})

it.each([
  'missing frame',
  'different title',
  'unknown header ink',
  'outside alias',
  'plural alias',
  'wrong literal'
])('rejects incomplete mathematical-title evidence: %s', (variant) => {
  const input = mathematicalTitle()
  if (variant === 'missing frame') input.rules = []
  if (variant === 'different title') {
    input.items[1].text = 'unit'
    input.items[1].sourceItem.text = 'unit'
  }
  if (variant === 'unknown header ink')
    input.items.push({
      text: '?',
      rect: [30, 10, 33, 18],
      baseline: 18,
      height: 8,
      horizontal: true
    })
  if (variant === 'outside alias')
    input.items.push({ ...input.items[0], rect: [200, 200, 210, 208] })
  if (variant === 'plural alias')
    input.items.push({
      text: 'Elsewhere',
      rect: [200, 200, 210, 208],
      sourceItems: [input.items[0].sourceItem]
    })
  if (variant === 'wrong literal') input.items[0].sourceItem.text = 'other'
  expect(run(input).issues).not.toContain('native-table-structure-ambiguous')
})

function evidence(rows: number, columns: number): Data {
  const inventory: Data[] = []
  const proved: Data[] = []
  const table = {
    grid: Array.from({ length: rows }, () => Array(columns).fill('')),
    cells: [] as Data[]
  }
  const font = (text: string, x: number, y: number, width = 12): Data => {
    const item = {
      text,
      rect: [x, y, x + width, y + 8],
      baseline: y + 8,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: inventory.length, text }
    }
    inventory.push(item)
    return item
  }
  const cell = (row: number, column: number, fonts: Data[], colSpan = 1, rowSpan = 1): Data => {
    const result = {
      row,
      column,
      rowSpan,
      colSpan,
      text: fonts.map((i) => i.text).join(' '),
      rect: [column * 60, row * 20, (column + colSpan) * 60, (row + rowSpan) * 20],
      sourceItems: fonts.map((i) => i.sourceItem),
      sourceRects: fonts.map((i) => i.rect)
    }
    table.grid[row][column] = result.text
    table.cells.push(result)
    proved.push({ cell: result, fonts })
    return result
  }
  return { inventory, proved, table, font, cell, rules: [] }
}

function reviewedKinds(input: Data): string[] {
  const before = JSON.stringify({
    table: input.table,
    inventory: input.inventory,
    rules: input.rules
  })
  const kinds = detectNativeTableAmbiguity(
    { proved: input.proved },
    input.table,
    input.inventory,
    input.rules,
    input.runs ?? []
  ).map((result: Data) => result.kind)
  expect(
    JSON.stringify({ table: input.table, inventory: input.inventory, rules: input.rules })
  ).toBe(before)
  return kinds
}

function omittedCompleteRecord(): Data {
  const f = evidence(3, 3)
  f.table.cropRect = [0, 0, 180, 80]
  for (let c = 0; c < 3; c++) {
    f.cell(0, c, [f.font(['Code', 'Reading', 'Class'][c], c * 60 + 5, 5, 30)])
    f.cell(1, c, [f.font(['11', '2.4', 'Group'][c], c * 60 + 5, 25, 20)])
    f.font(['12', '3.4', 'Group'][c], c * 60 + 5, 37, 20)
    f.cell(2, c, [f.font(['13', '4.4', 'Group'][c], c * 60 + 5, 49, 20)])
  }
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 70, 180, 70]
  ]
  return f
}

it('reviews an unclaimed complete native record between two proved peer records', () => {
  expect(reviewedKinds(omittedCompleteRecord())).toContain('unclaimed-complete-native-record')
})

it.each([
  'missing field',
  'one numeric field',
  'script',
  'different pitch',
  'outside footer',
  'no footer',
  'short footer',
  'internal rule',
  'cross-column glyph',
  'unknown ink',
  'foreign alias',
  'missing peer'
])('rejects unsupported omitted-record evidence: %s', (variant) => {
  const f = omittedCompleteRecord()
  const missing = f.inventory.filter((i: Data) => i.rect[1] === 37)
  if (variant === 'missing field') f.inventory.splice(f.inventory.indexOf(missing[2]), 1)
  if (variant === 'one numeric field') missing[1].text = missing[1].sourceItem.text = 'Label'
  if (variant === 'script') missing[1].baseline -= 3
  if (variant === 'different pitch')
    for (const i of missing) {
      i.baseline += 2
      i.rect[1] += 2
      i.rect[3] += 2
    }
  if (variant === 'outside footer') f.rules[2][1] = f.rules[2][3] = 36
  if (variant === 'no footer') f.rules.pop()
  if (variant === 'short footer') f.rules[2][2] = 100
  if (variant === 'internal rule') f.rules.push([0, 36, 180, 36])
  if (variant === 'cross-column glyph') missing[0].rect[2] = 70
  if (variant === 'unknown ink') f.font('?', 40, 39, 3)
  if (variant === 'foreign alias')
    f.inventory.push({
      text: 'outside',
      rect: [300, 300, 320, 310],
      sourceSegment: { ...missing[0].sourceItem }
    })
  if (variant === 'missing peer') f.proved = f.proved.filter((p: Data) => p.cell.row !== 2)
  expect(reviewedKinds(f)).not.toContain('unclaimed-complete-native-record')
})

function mergedDescriptorLanes(): Data {
  const f = evidence(4, 2)
  f.cell(0, 0, [f.font('A', 5, 5, 6), f.font('B', 23, 5, 6)])
  for (let row = 1; row < 4; row++)
    f.cell(row, 0, [
      f.font(String(row + 10), 5, 15 + row * 14, 8),
      f.font('Ab', 23, 15 + row * 14, 9)
    ])
  f.rules = [
    [0, 0, 120, 0],
    [0, 20, 120, 20],
    [0, 80, 120, 80]
  ]
  return f
}

it('reviews two independently headed descriptor lanes consumed as one model column', () => {
  expect(reviewedKinds(mergedDescriptorLanes())).toContain('merged-native-descriptor-lanes')
})

it.each([
  'single heading',
  'touching heading',
  'single peer',
  'script',
  'no divider',
  'no footer',
  'unaligned field',
  'unknown ink',
  'foreign alias'
])('rejects unsupported descriptor-lane evidence: %s', (variant) => {
  const f = mergedDescriptorLanes(),
    head = f.proved[0].fonts
  if (variant === 'single heading') head[1].text = head[1].sourceItem.text = ''
  if (variant === 'touching heading') head[1].rect[0] = head[0].rect[2]
  if (variant === 'single peer') f.proved = f.proved.slice(0, 2)
  if (variant === 'script') f.proved[1].fonts[1].baseline -= 3
  if (variant === 'no divider') f.rules.splice(1, 1)
  if (variant === 'no footer') f.rules.pop()
  if (variant === 'unaligned field') f.proved[1].fonts[1].rect = [40, 29, 50, 37]
  if (variant === 'unknown ink') f.font('?', 18, 42, 2)
  if (variant === 'foreign alias')
    f.inventory.push({
      text: 'outside',
      rect: [300, 300, 320, 310],
      sourceItems: [head[0].sourceItem]
    })
  expect(reviewedKinds(f)).not.toContain('merged-native-descriptor-lanes')
})

function middleTier(): Data {
  const f = evidence(3, 8)
  f.cell(0, 0, [f.font('Family A', 50, 5, 30)], 4)
  f.cell(0, 4, [f.font('Family B', 190, 5, 30)], 4)
  for (let pair = 0; pair < 4; pair++) {
    const x = 10 + 70 * pair
    f.cell(1, pair * 2, [f.font('L', x, 40)])
    f.cell(1, pair * 2 + 1, [f.font('Descriptor', x + 20, 20, 28), f.font('R', x + 30, 40)])
  }
  f.rules = [
    [-5, 0, 290, 0],
    [-5, 60, 290, 60]
  ]
  return f
}

it('reviews a repeated unruled middle title tier without inventing a unique parent span', () => {
  expect(reviewedKinds(middleTier())).toContain('unruled-middle-tier-heading-ambiguity')
})

it.each([
  'one parent',
  'different leaves',
  'intervening glyph',
  'independent rule',
  'separate native tier'
])('rejects unsupported middle-tier evidence: %s', (variant) => {
  const f = middleTier()
  if (variant === 'one parent') f.proved = f.proved.filter((p: Data) => p.cell.column < 4)
  if (variant === 'different leaves') f.proved[2].fonts[0].text = 'Other'
  if (variant === 'intervening glyph') f.font('?', 35, 30, 3)
  if (variant === 'independent rule') f.rules.push([20, 35, 80, 35])
  if (variant === 'separate native tier')
    for (const p of f.proved.filter((p: Data) => p.cell.row === 1)) p.cell.row = 2
  expect(reviewedKinds(f)).not.toContain('unruled-middle-tier-heading-ambiguity')
})

function swallowedHeaderRecord(): Data {
  const f = evidence(4, 3)
  for (let c = 0; c < 3; c++) {
    f.cell(0, c, [f.font(`Metric ${c}`, c * 60 + 5, 10, 30), f.font(`0.${c + 1}`, c * 60 + 5, 30)])
    for (let row = 1; row < 4; row++)
      f.cell(row, c, [f.font(`${row}.${c}`, c * 60 + 5, 50 + row * 20)])
  }
  f.rules = [
    [0, 5, 180, 5],
    [0, 30.1, 180, 30.1],
    [0, 50, 180, 50],
    [0, 140, 180, 140]
  ]
  return f
}

it('reviews a complete numeric first record owned by header cells across a native divider', () => {
  expect(reviewedKinds(swallowedHeaderRecord())).toContain('first-record-in-heading')
})

it('keeps em-box overlap review distinct from a reconstructed rule boundary', () => {
  const f = swallowedHeaderRecord()
  const adjacent = f.proved.find((p: Data) => p.cell.row === 1).fonts[0]
  adjacent.rect[1] = 49.9
  expect(reviewedKinds(f)).toContain('first-record-in-heading')
  f.inventory.push({
    text: 'unknown',
    rect: [40, 49.9, 50, 58],
    baseline: 58,
    height: 8,
    horizontal: true
  })
  expect(reviewedKinds(f)).not.toContain('first-record-in-heading')
})

it.each([
  'one leaf',
  'no divider',
  'short divider',
  'single peer',
  'unknown frame ink',
  'script lower line',
  'body rather than header'
])('rejects unsupported header-record evidence: %s', (variant) => {
  const f = swallowedHeaderRecord()
  if (variant === 'one leaf') f.proved = f.proved.filter((p: Data) => p.cell.column === 0)
  if (variant === 'no divider') f.rules.splice(1, 1)
  if (variant === 'short divider') f.rules[1][2] = 50
  if (variant === 'single peer') f.proved = f.proved.filter((p: Data) => p.cell.row < 2)
  if (variant === 'unknown frame ink') f.font('?', 100, 25, 2)
  if (variant === 'script lower line')
    for (const p of f.proved.filter((p: Data) => p.cell.row === 0)) p.fonts[1].baseline = 18
  if (variant === 'body rather than header') for (const p of f.proved) p.cell.row += 2
  expect(reviewedKinds(f)).not.toContain('first-record-in-heading')
})

function swallowedSection(): Data {
  const f = evidence(5, 3)
  f.cell(0, 0, [f.font('Earlier section', 5, 10, 35)], 3)
  f.cell(1, 0, [f.font('Following section', 5, 40, 45), f.font('Record A', 5, 55, 25)])
  f.cell(1, 1, [f.font('yes', 65, 55)])
  f.cell(1, 2, [f.font('no', 125, 55)])
  for (let row = 2; row < 5; row++)
    for (let c = 0; c < 3; c++) f.cell(row, c, [f.font(`entry${c}`, c * 60 + 5, 70 + row * 15, 25)])
  f.rules = [
    [0, 5, 180, 5],
    [0, 35, 180, 35],
    [0, 145, 180, 145]
  ]
  return f
}

it('reviews a section-like line merged with a complete following record', () => {
  expect(reviewedKinds(swallowedSection())).toContain('section-title-in-record')
})

it.each([
  'no earlier section',
  'only one word',
  'font mismatch',
  'independent divider',
  'missing peer field',
  'unknown section ink'
])('rejects unsupported section-record evidence: %s', (variant) => {
  const f = swallowedSection()
  if (variant === 'no earlier section') f.proved[0].cell.colSpan = 1
  if (variant === 'only one word') f.proved[1].fonts[0].text = 'Single'
  if (variant === 'font mismatch') f.proved[1].fonts[0].height = 5
  if (variant === 'independent divider') f.rules.push([0, 51, 180, 51])
  if (variant === 'missing peer field')
    f.proved = f.proved.filter((p: Data) => !(p.cell.column === 2 && p.cell.row > 1))
  if (variant === 'unknown section ink') f.font('?', 80, 42, 3)
  expect(reviewedKinds(f)).not.toContain('section-title-in-record')
})

function wrappedTail(): Data {
  const f = evidence(5, 3)
  for (let c = 0; c < 3; c++) f.cell(0, c, [f.font(`Header${c}`, c * 60 + 5, 5, 25)])
  for (let row = 1; row <= 3; row++) {
    const y = row * 35
    f.cell(row, 0, [f.font(`K${row}`, 5, y)])
    for (let c = 1; c < 3; c++)
      f.cell(row, c, [
        f.font('opening', c * 60 + 5, y, 30),
        f.font('continued;', c * 60 + 5, y + 12, 30)
      ])
  }
  for (let c = 1; c < 3; c++) f.cell(4, c, [f.font('ending', c * 60 + 5, 129, 25)])
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 145, 180, 145]
  ]
  return f
}

it('reviews a stubless terminal row continuing two complete wrapped record lanes', () => {
  expect(reviewedKinds(wrappedTail())).toContain('terminal-wrapped-record')
})

it.each([
  'own stub',
  'one continuation',
  'different pitch',
  'different font',
  'independent divider',
  'no closing frame',
  'unknown tail ink',
  'one peer'
])('rejects unsupported wrapped-tail evidence: %s', (variant) => {
  const f = wrappedTail()
  if (variant === 'own stub') f.cell(4, 0, [f.font('K4', 5, 129)])
  if (variant === 'one continuation')
    f.proved = f.proved.filter((p: Data) => !(p.cell.row === 4 && p.cell.column === 2))
  if (variant === 'different pitch')
    f.proved.find((p: Data) => p.cell.row === 4).fonts[0].baseline += 3
  if (variant === 'different font') f.proved.find((p: Data) => p.cell.row === 4).fonts[0].height = 6
  if (variant === 'independent divider') f.rules.push([0, 128, 180, 128])
  if (variant === 'no closing frame') f.rules.pop()
  if (variant === 'unknown tail ink') f.font('?', 30, 130, 3)
  if (variant === 'one peer') f.proved = f.proved.filter((p: Data) => p.cell.row !== 1)
  expect(reviewedKinds(f)).not.toContain('terminal-wrapped-record')
})

function widerRepeatedNumericLeaf(): Data {
  const f = evidence(4, 3)
  f.cell(0, 0, [f.font('Rate', 5, 5, 12)])
  f.cell(0, 1, [f.font('Gain', 35, 5, 12)])
  f.cell(0, 2, [f.font('Rate', 70, 5, 12), f.font('Gain', 94, 5, 12)])
  for (let row = 1; row < 4; row++) {
    const y = 5 + row * 18
    f.cell(row, 2, [
      f.font('0.4', row === 2 ? 65.5 : 66, y, row === 2 ? 21 : 20),
      f.font('0.8', 90, y, 20)
    ])
  }
  return f
}

it('reviews repeated native leaf lanes despite one wider value in a complete empty gutter', () => {
  expect(reviewedKinds(widerRepeatedNumericLeaf())).toContain('merged-repeated-native-leaves')
})

it.each([
  'missing record proof',
  'missing header proof',
  'different leaf',
  'operator',
  'alias',
  'closed gutter',
  'shifted value',
  'only two records'
])('does not review unproved repeated numeric lanes: %s', (variant) => {
  const f = widerRepeatedNumericLeaf()
  if (variant === 'missing record proof') f.proved.pop()
  if (variant === 'missing header proof') f.proved.shift()
  if (variant === 'different leaf')
    f.proved[0].fonts[0].text = f.proved[0].fonts[0].sourceItem.text = 'Other'
  if (variant === 'operator') f.font('±', 87, 41, 2)
  if (variant === 'alias')
    f.inventory.push({
      text: '',
      rect: [300, 300, 310, 310],
      metadata: { sourceItems: [f.inventory[0].sourceItem] }
    })
  if (variant === 'closed gutter') f.proved[4].fonts[0].rect[2] = 90
  if (variant === 'shifted value') f.proved[4].fonts[1].rect = [100, 41, 120, 49]
  if (variant === 'only two records') {
    f.proved.pop()
    f.table.cells.pop()
    f.table.grid.pop()
  }
  expect(reviewedKinds(f)).not.toContain('merged-repeated-native-leaves')
})

function omittedSharedSymbolRecord(): Data {
  const f = evidence(3, 4)
  f.table.cropRect = [0, 0, 240, 75]
  for (let c = 0; c < 4; c++)
    f.cell(0, c, [f.font(['Group', 'Name', 'A', 'B'][c], c * 60 + 5, 4, 20)])
  f.cell(1, 0, [f.font('Set', 5, 38, 20)], 1, 2)
  for (const [row, y] of [
    [1, 23],
    [2, 57]
  ]) {
    f.cell(row, 1, [f.font(row === 1 ? 'Alpha' : 'Gamma', 65, y, 24)])
    f.cell(row, 2, [f.font('✓', 130, y, 8)])
    f.cell(row, 3, [f.font('×', 190, y, 8)])
  }
  f.font('Beta', 65, 40, 24)
  f.font('△', 130, 40, 8)
  f.font('×', 190, 40, 8)
  f.rules = [
    [0, 0, 240, 0],
    [0, 20, 240, 20],
    [0, 75, 240, 75]
  ]
  return f
}
it('reviews a complete unclaimed symbol record inside a shared native group', () => {
  expect(reviewedKinds(omittedSharedSymbolRecord())).toContain('unclaimed-shared-symbol-record')
})

it.each([
  'missing field',
  'not a symbol',
  'outside group',
  'internal rule',
  'vertical rule',
  'unowned ink',
  'external alias',
  'partly claimed',
  'crossing font',
  'missing peer'
])('rejects incomplete shared-symbol row evidence: %s', (variant) => {
  const f = omittedSharedSymbolRecord(),
    missing = f.inventory.filter((i: Data) => i.rect[1] === 40)
  if (variant === 'missing field') f.inventory.splice(f.inventory.indexOf(missing[2]), 1)
  if (variant === 'not a symbol') missing[1].text = missing[1].sourceItem.text = 'note'
  if (variant === 'outside group') f.rules[2][1] = f.rules[2][3] = 39
  if (variant === 'internal rule') f.rules.push([0, 38, 240, 38])
  if (variant === 'vertical rule') f.rules.push([135, 22, 135, 70])
  if (variant === 'unowned ink') f.font('extra', 100, 41, 10)
  if (variant === 'external alias')
    f.inventory.push({
      text: '',
      rect: [300, 300, 310, 310],
      metadata: { sourceItems: [missing[0].sourceItem] }
    })
  if (variant === 'partly claimed') f.proved[5].fonts.push(missing[0])
  if (variant === 'crossing font') missing[0].rect[0] = 59
  if (variant === 'missing peer') f.proved.pop()
  expect(reviewedKinds(f)).not.toContain('unclaimed-shared-symbol-record')
})

function omittedUnderlinedParent(): Data {
  const f = evidence(4, 4)
  f.table.cropRect = [0, 0, 240, 90]
  for (let c = 0; c < 4; c++) f.cell(0, c, [f.font(c ? 'Leaf ' + c : 'Name', c * 60 + 8, 25, 30)])
  for (let r = 1; r < 4; r++)
    for (let c = 0; c < 4; c++)
      f.cell(r, c, [f.font(c ? String(r + c) : 'Item ' + r, c * 60 + 8, 25 + r * 16, c ? 12 : 30)])
  f.font('Combined metric', 85, 5, 100)
  f.rules = [
    [0, 0, 240, 0],
    [65, 20, 235, 20],
    [0, 38, 240, 38],
    [0, 90, 240, 90]
  ]
  return f
}
it('reviews a complete native underlined parent omitted above mapped leaf headings', () => {
  expect(reviewedKinds(omittedUnderlinedParent())).toContain('unclaimed-underlined-native-heading')
})
it.each([
  'no opening',
  'no underline',
  'no divider',
  'alias',
  'rotation',
  'crossing underline',
  'partial ownership',
  'unknown ink',
  'missing leaf',
  'non-numeric peers'
])('rejects incomplete omitted parent evidence: %s', (mode) => {
  const f = omittedUnderlinedParent(),
    parent = f.inventory.at(-1)
  if (mode === 'no opening') f.rules.shift()
  if (mode === 'no underline') f.rules.splice(1, 1)
  if (mode === 'no divider') f.rules.splice(2, 1)
  if (mode === 'alias') f.inventory.push({ ...parent, rect: [300, 5, 400, 13] })
  if (mode === 'rotation') parent.horizontal = false
  if (mode === 'crossing underline') parent.rect[3] = 21
  if (mode === 'partial ownership') f.proved[1].fonts.push(parent)
  if (mode === 'unknown ink')
    f.inventory.push({
      text: '?',
      rect: [100, 10, 110, 18],
      horizontal: true,
      height: 8,
      baseline: 18
    })
  if (mode === 'missing leaf') f.proved.splice(2, 1)
  if (mode === 'non-numeric peers')
    for (const p of f.proved.filter((p: Data) => p.cell.row > 0 && p.cell.column > 0))
      p.fonts[0].text = p.fonts[0].sourceItem.text = 'text'
  expect(reviewedKinds(f)).not.toContain('unclaimed-underlined-native-heading')
})

function repeatedBlankStubRows(): Data {
  const f = evidence(5, 3)
  f.table.cropRect = [0, 0, 180, 110]
  for (let c = 0; c < 3; c++)
    f.cell(0, c, [f.font(['Name', 'Description', 'Result'][c], c * 60 + 5, 5, 40)])
  for (let r = 1; r < 5; r++)
    for (let c = 0; c < 3; c++) {
      if (c === 0 && r % 2 === 0) {
        f.cell(r, c, [])
        continue
      }
      f.cell(r, c, [
        f.font(
          c === 0 ? 'Record ' + r : c === 1 ? 'Two words' : 'More words',
          c * 60 + 5,
          20 + r * 16,
          45
        )
      ])
    }
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 110, 180, 110]
  ]
  return f
}
it('reviews repeated native prose continuations split into blank-stub model records', () => {
  expect(reviewedKinds(repeatedBlankStubRows())).toContain('repeated-blank-stub-continuations')
})
it.each([
  'single continuation',
  'explicit divider',
  'spanned stub',
  'missing owner',
  'alias',
  'unknown ink',
  'numeric fields',
  'no closing'
])('keeps split-record review scoped to complete repeated native prose evidence: %s', (mode) => {
  const f = repeatedBlankStubRows()
  if (mode === 'single continuation') {
    const c = f.table.cells.find((c: Data) => c.row === 4 && c.column === 0)
    c.text = f.table.grid[4][0] = 'Independent'
    const i = f.font('Independent', 5, 84, 45)
    f.proved.find((p: Data) => p.cell === c).fonts = [i]
  }
  if (mode === 'explicit divider') f.rules.push([0, 65, 180, 65])
  if (mode === 'spanned stub')
    f.table.cells.find((c: Data) => c.row === 1 && c.column === 0).rowSpan = 2
  if (mode === 'missing owner') f.proved.pop()
  if (mode === 'alias') f.inventory.push({ ...f.inventory[4], rect: [300, 100, 345, 108] })
  if (mode === 'unknown ink')
    f.inventory.push({
      text: 'Other',
      rect: [150, 50, 170, 58],
      horizontal: true,
      baseline: 58,
      height: 8
    })
  if (mode === 'numeric fields')
    for (const p of f.proved.filter((p: Data) => p.cell.row > 0 && p.cell.column > 0)) {
      p.fonts[0].text = p.fonts[0].sourceItem.text = '123'
    }
  if (mode === 'no closing') f.rules.pop()
  expect(reviewedKinds(f)).not.toContain('repeated-blank-stub-continuations')
})

function equationMatrixCandidate(): Data {
  const f = evidence(3, 4)
  f.table.cropRect = [0, 0, 240, 90]
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const fonts = [f.font(String(r === c ? 0 : 1), 60 + c * 30, 10 + r * 20, 8)]
      if (r === 1 && c === 0) fonts.unshift(f.font('=', 35, 30, 10))
      f.cell(r, c, fonts)
    }
  for (let r = 0; r < 3; r++) f.cell(r, 3, r === 1 ? [f.font('.', 155, 30, 3)] : [])
  return f
}
it('reviews a complete numeric matrix with an external equation operator misclassified as table fields', () => {
  expect(reviewedKinds(equationMatrixCandidate())).toContain('equation-matrix-fields')
})
it.each([
  'header',
  'missing number',
  'second equality',
  'foreign ink',
  'alias',
  'native rule',
  'shifted row'
])('does not infer equation matrix ambiguity without a complete native matrix: %s', (mode) => {
  const f = equationMatrixCandidate()
  if (mode === 'header') f.inventory[0].text = f.inventory[0].sourceItem.text = 'Heading'
  if (mode === 'missing number') f.proved[8].fonts = []
  if (mode === 'second equality') f.cell(1, 3, [f.font('=', 150, 30, 8)])
  if (mode === 'foreign ink')
    f.inventory.push({
      text: 'Other',
      rect: [75, 32, 95, 40],
      horizontal: true,
      height: 8,
      baseline: 40
    })
  if (mode === 'alias') f.inventory.push({ ...f.inventory[0], rect: [300, 10, 308, 18] })
  if (mode === 'native rule') f.rules.push([30, 20, 160, 20])
  if (mode === 'shifted row') f.inventory[6].baseline += 5
  expect(reviewedKinds(f)).not.toContain('equation-matrix-fields')
})

function croppedNativeHeading(): Data {
  const f = evidence(3, 3)
  f.table.cropRect = [0, 25, 180, 100]
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      f.cell(r, c, [
        f.font(c ? 'Value ' + (r + c) : String(r + 1), c * 60 + 5, 40 + r * 20, c ? 45 : 12)
      ])
  f.font('Index', 5, 20, 25)
  f.font('Combined field names', 65, 20, 105)
  const cap = f.font('Table 1. Summary', 20, 5, 130)
  f.captions = [{ page: 1, rect: cap.rect, lines: [cap.text] }]
  return f
}
it('reviews a complete native heading cut off above an otherwise mapped captioned grid', () => {
  const f = croppedNativeHeading()
  expect(hasClippedNativeHeading({ proved: f.proved }, f.table, f.inventory, f.captions)).toBe(true)
})
it.each([
  'no caption',
  'foreign caption',
  'header alias',
  'missing body',
  'unknown header ink',
  'below edge',
  'rotated header',
  'numeric header'
])('does not review a clipped heading without complete original ownership: %s', (mode) => {
  const f = croppedNativeHeading()
  if (mode === 'no caption') f.captions = []
  if (mode === 'foreign caption') f.captions[0].lines = ['Table 2. Other']
  if (mode === 'header alias') f.inventory.push({ ...f.inventory[9], rect: [300, 20, 325, 28] })
  if (mode === 'missing body') f.proved.pop()
  if (mode === 'unknown header ink')
    f.inventory.push({
      text: 'Other',
      rect: [100, 23, 130, 31],
      horizontal: true,
      baseline: 31,
      height: 8
    })
  if (mode === 'below edge') f.table.cropRect[1] = 19
  if (mode === 'rotated header') f.inventory[9].horizontal = false
  if (mode === 'numeric header')
    for (const i of f.inventory.slice(9, 11)) i.text = i.sourceItem.text = '123'
  expect(hasClippedNativeHeading({ proved: f.proved }, f.table, f.inventory, f.captions)).toBe(
    false
  )
})

function misplacedClosingStubTail(): Data {
  const f = evidence(4, 3)
  f.table.cropRect = [0, 0, 180, 120]
  for (let c = 0; c < 3; c++)
    f.cell(0, c, [f.font(['Name', 'Count', 'Rate'][c], c * 60 + 5, 5, 40)])
  f.cell(1, 0, [f.font('First', 5, 25, 30)])
  f.cell(1, 1, [f.font('3', 65, 25)])
  f.cell(1, 2, [f.font('4', 125, 25)])
  const before = [f.font('Second (part', 5, 45, 50), f.font('continued', 5, 60, 45)]
  f.cell(2, 0, before)
  f.cell(2, 1, [f.font('5', 65, 45)])
  f.cell(2, 2, [f.font('6', 125, 45)])
  const tail = f.font('end)', 5, 75, 30),
    next = f.font('Third', 5, 90, 30)
  f.cell(3, 0, [tail, next])
  f.cell(3, 1, [f.font('7', 65, 90)])
  f.cell(3, 2, [f.font('8', 125, 90)])
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 115, 180, 115]
  ]
  return f
}
it('reviews a native closing descriptor tail assigned before the next record header', () => {
  expect(reviewedKinds(misplacedClosingStubTail())).toContain('misassigned-native-stub-tail')
})
it.each([
  'closed previous',
  'open tail',
  'different sequence',
  'new record baseline',
  'independent divider',
  'alias',
  'foreign ink',
  'missing numeric peer'
])('requires independent native boundaries for a misplaced descriptor tail: %s', (mode) => {
  const f = misplacedClosingStubTail(),
    prev = f.proved.find((p: Data) => p.cell.row === 2 && p.cell.column === 0),
    next = f.proved.find((p: Data) => p.cell.row === 3 && p.cell.column === 0)
  if (mode === 'closed previous') prev.fonts[0].text = prev.fonts[0].sourceItem.text = 'Second part'
  if (mode === 'open tail') next.fonts[0].text = next.fonts[0].sourceItem.text = 'end'
  if (mode === 'different sequence') next.fonts[0].sourceItem.index = 99
  if (mode === 'new record baseline') {
    next.fonts[0].rect = [5, 90, 35, 98]
    next.fonts[0].baseline = 98
  }
  if (mode === 'independent divider') f.rules.push([0, 72, 180, 72])
  if (mode === 'alias') f.inventory.push({ ...next.fonts[0], rect: [300, 75, 330, 83] })
  if (mode === 'foreign ink')
    f.inventory.push({
      text: 'Other',
      rect: [100, 65, 130, 73],
      baseline: 73,
      height: 8,
      horizontal: true
    })
  if (mode === 'missing numeric peer') f.proved.pop()
  expect(reviewedKinds(f)).not.toContain('misassigned-native-stub-tail')
})

const { hasUnclaimedUnderlinedHeading, hasEquationMatrixFields } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-ambiguity.mjs')).href
)
it.each(['heading', 'equation'])(
  'limits degenerate-font refusal to the completely located evidence domain: %s',
  (kind) => {
    const f = kind === 'heading' ? omittedUnderlinedParent() : equationMatrixCandidate()
    const check = kind === 'heading' ? hasUnclaimedUnderlinedHeading : hasEquationMatrixFields
    const outside = {
      text: 'Accent',
      rect: [300, 300, 310, 300],
      horizontal: true,
      height: 0,
      baseline: 300
    }
    f.inventory.push(outside)
    expect(check({ proved: f.proved }, f.table, f.inventory, f.rules)).toBe(true)
    outside.rect = kind === 'heading' ? [100, 10, 110, 10] : [75, 35, 85, 35]
    expect(check({ proved: f.proved }, f.table, f.inventory, f.rules)).toBe(false)
    outside.rect = [NaN, 300, 310, 300]
    expect(check({ proved: f.proved }, f.table, f.inventory, f.rules)).toBe(false)
  }
)

function repeatedNumericLanes(): Data {
  const f = evidence(4, 2)
  f.table.cropRect = [0, 0, 180, 100]
  f.cell(0, 0, [f.font('Kind', 5, 5, 30)])
  f.cell(0, 1, [f.font('Values', 65, 5, 50)])
  for (let r = 1; r < 4; r++) {
    f.cell(r, 0, [f.font('Row ' + r, 5, r * 20 + 5, 30)])
    f.cell(r, 1, [f.font(String(r), 70, r * 20 + 5), f.font(String(r + 4), 130, r * 20 + 5)])
  }
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 90, 180, 90]
  ]
  return f
}
it('reviews repeated complete numeric lanes collapsed into one model column', () => {
  expect(reviewedKinds(repeatedNumericLanes())).toContain('collapsed-native-numeric-lanes')
})
it.each([
  'one row',
  'comma values',
  'misaligned',
  'missing closing',
  'alias',
  'foreign ink',
  'missing proof'
])('requires complete native repeated numeric lanes: %s', (mode) => {
  const f = repeatedNumericLanes()
  if (mode === 'one row')
    for (const p of f.proved.filter((p: Data) => p.cell.row > 1 && p.cell.column === 1))
      p.fonts[1].text = p.fonts[1].sourceItem.text = 'Value'
  if (mode === 'comma values')
    for (const p of f.proved.filter((p: Data) => p.cell.row > 0 && p.cell.column === 1))
      p.fonts[0].text = p.fonts[0].sourceItem.text = '1,'
  if (mode === 'misaligned') f.proved.at(-1).fonts[1].baseline += 3
  if (mode === 'missing closing') f.rules.pop()
  if (mode === 'alias') f.inventory.push({ ...f.inventory[3], rect: [200, 25, 212, 33] })
  if (mode === 'foreign ink') f.font('±', 105, 45, 8)
  if (mode === 'missing proof') f.proved.pop()
  expect(reviewedKinds(f)).not.toContain('collapsed-native-numeric-lanes')
})

function numberedNativeEquations(): Data {
  const f = evidence(3, 3)
  for (let r = 0; r < 3; r++) {
    f.cell(r, 0, [f.font('a := b + c', 5, 10 + r * 20, 60)])
    f.cell(r, 1, [f.font('∀x ∈ S', 90, 10 + r * 20, 40)])
    f.cell(r, 2, [f.font('(Eq' + (r + 1) + ')', 160, 10 + r * 20, 30)])
  }
  return f
}
it('reviews a headerless block of numbered constraints consumed as table cells', () => {
  expect(reviewedKinds(numberedNativeEquations())).toContain('native-equation-block')
})
it.each([
  'caption',
  'ordinary header',
  'closed table frame',
  'missing proof',
  'alias',
  'foreign ink'
])('requires the complete headerless native equation domain: %s', (mode) => {
  const f = numberedNativeEquations()
  if (mode === 'caption') f.table.caption = { lines: ['Table 1. Equations'], rect: [0, 0, 190, 5] }
  if (mode === 'ordinary header') {
    const p = f.proved[0]
    p.fonts[0].text = p.fonts[0].sourceItem.text = p.cell.text = f.table.grid[0][0] = 'Description'
  }
  if (mode === 'closed table frame')
    f.rules = [
      [0, 0, 200, 0],
      [0, 80, 200, 80]
    ]
  if (mode === 'missing proof') f.proved.pop()
  if (mode === 'alias') f.inventory.push({ ...f.inventory[0], rect: [300, 10, 360, 18] })
  if (mode === 'foreign ink') f.font('Extra', 70, 30, 15)
  expect(reviewedKinds(f)).not.toContain('native-equation-block')
})

const { hasNativeFolioOnlyTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-ambiguity.mjs')).href
)
function folioOnly(): Data {
  const f = evidence(2, 3)
  f.cell(1, 1, [f.font('1', 94, 190, 12)])
  f.font('Complete body sentence', 10, 140, 150)
  f.context = { viewport: { width: 200, height: 200, rotation: 0 } }
  return f
}
it('reviews a footer numeral alone in an otherwise empty model grid', () => {
  const f = folioOnly()
  expect(
    hasNativeFolioOnlyTable({ proved: f.proved }, f.table, f.inventory, f.rules, f.context)
  ).toBe(true)
})
it.each([
  'caption',
  'inside body',
  'different number',
  'unknown viewport',
  'other footer',
  'rule',
  'alias'
])('does not classify a singleton as a folio without native margin proof: %s', (mode) => {
  const f = folioOnly()
  if (mode === 'caption') f.table.caption = { lines: ['Table 1. Value'] }
  if (mode === 'inside body') f.context.viewport.height = 300
  if (mode === 'different number')
    f.inventory[0].text =
      f.inventory[0].sourceItem.text =
      f.proved[0].cell.text =
      f.table.grid[1][1] =
        '2'
  if (mode === 'unknown viewport') f.context = {}
  if (mode === 'other footer') f.font('Footnote', 10, 190, 50)
  if (mode === 'rule') f.rules.push([90, 188, 110, 188])
  if (mode === 'alias') f.inventory.push({ ...f.inventory[0], rect: [20, 10, 32, 18] })
  expect(
    hasNativeFolioOnlyTable({ proved: f.proved }, f.table, f.inventory, f.rules, f.context)
  ).toBe(false)
})

function pairedRecordsInOneRow(): Data {
  const f = evidence(4, 2)
  f.table.cropRect = [0, 0, 180, 110]
  f.cell(0, 0, [f.font('Name', 5, 5, 30)])
  f.cell(0, 1, [f.font('Value', 90, 5, 30)])
  for (let r = 1; r <= 2; r++) {
    f.cell(r, 0, [f.font('Entry', 5, r * 20 + 5, 30)])
    f.cell(r, 1, [f.font(String(r), 90, r * 20 + 5)])
  }
  f.cell(3, 0, [f.font('Alpha', 5, 65, 30), f.font('Beta', 5, 85, 30)])
  f.cell(3, 1, [f.font('3, 4', 90, 65, 30), f.font('5', 90, 85)])
  f.rules = [
    [0, 0, 180, 0],
    [0, 20, 180, 20],
    [0, 105, 180, 105]
  ]
  return f
}
it('reviews two complete native name/value records swallowed by one logical row', () => {
  expect(reviewedKinds(pairedRecordsInOneRow())).toContain('merged-native-paired-records')
})
it.each([
  'wrapped label',
  'prose value',
  'missing peer',
  'missing closing',
  'misaligned',
  'foreign ink',
  'alias'
])('requires paired complete native records, not wrapping: %s', (mode) => {
  const f = pairedRecordsInOneRow(),
    right = f.proved.at(-1)
  if (mode === 'wrapped label') {
    right.fonts.pop()
    right.cell.sourceItems.pop()
    right.cell.sourceRects.pop()
    f.inventory.pop()
  }
  if (mode === 'prose value') right.fonts[1].text = right.fonts[1].sourceItem.text = 'continued'
  if (mode === 'missing peer') f.proved.splice(3, 1)
  if (mode === 'missing closing') f.rules.pop()
  if (mode === 'misaligned') right.fonts[1].baseline += 3
  if (mode === 'foreign ink') f.font('Other', 55, 75, 25)
  if (mode === 'alias') f.inventory.push({ ...right.fonts[1], rect: [210, 85, 222, 93] })
  expect(reviewedKinds(f)).not.toContain('merged-native-paired-records')
})
function terminalSymbolInNumericColumn(): Data {
  const f = evidence(5, 3)
  for (let c = 0; c < 3; c++)
    f.cell(0, c, [f.font(['Kind', 'Total', 'Rate'][c], c * 70 + 5, 5, 30)])
  for (let r = 1; r < 4; r++) {
    f.cell(r, 0, [f.font('Item', 5, 20 * r + 5, 30)])
    f.cell(r, 1, [f.font(String(r + 2), 90, 20 * r + 5)])
    f.cell(r, 2, [f.font('0.5', 150, 20 * r + 5, 24)])
  }
  f.cell(4, 0, [f.font('Final relation', 5, 85, 60)])
  f.cell(4, 1, [f.font('q', 69, 85, 8)])
  f.cell(4, 2, [f.font('0.7', 150, 85, 24)])
  f.rules = [
    [0, 0, 190, 0],
    [0, 80, 190, 80],
    [0, 100, 190, 100]
  ]
  return f
}
it('reviews a terminal symbol shifted out of a repeated numeric lane into its descriptor', () => {
  expect(reviewedKinds(terminalSymbolInNumericColumn())).toContain('terminal-native-field-drift')
})
it.each([
  'numeric value',
  'aligned symbol',
  'different baseline',
  'missing divider',
  'no numeric peers',
  'alias',
  'foreign ink'
])('does not infer terminal field drift without native lane and face evidence: %s', (mode) => {
  const f = terminalSymbolInNumericColumn(),
    p = f.proved.at(-2)
  if (mode === 'numeric value')
    p.fonts[0].text = p.fonts[0].sourceItem.text = p.cell.text = f.table.grid[4][1] = '7'
  if (mode === 'aligned symbol') {
    p.fonts[0].rect = [90, 85, 98, 93]
  }
  if (mode === 'different baseline') p.fonts[0].baseline += 3
  if (mode === 'missing divider') f.rules.splice(1, 1)
  if (mode === 'no numeric peers')
    f.proved[4].fonts[0].text =
      f.proved[4].fonts[0].sourceItem.text =
      f.proved[4].cell.text =
      f.table.grid[1][1] =
        'n'
  if (mode === 'alias') f.inventory.push({ ...p.fonts[0], rect: [250, 85, 258, 93] })
  if (mode === 'foreign ink') f.font('Other', 105, 85, 30)
  expect(reviewedKinds(f)).not.toContain('terminal-native-field-drift')
})
const { hasNativeEquationBlock } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-ambiguity.mjs')).href
)
function nativeDefinitions(): Data {
  const f = evidence(2, 3)
  f.cell(0, 0, [f.font('a := b', 5, 15, 50)])
  f.cell(0, 1, [f.font('c := d', 70, 15, 50)])
  f.cell(0, 2, [f.font('Σ x', 135, 15, 25)])
  f.cell(1, 2, [f.font('j', 135, 30, 8)])
  return f
}
it.each(['plain', 'degenerate outside'])(
  'reviews complete definitions split into an uncaptioned grid: %s',
  (mode) => {
    const f = nativeDefinitions()
    if (mode === 'degenerate outside')
      f.inventory.push({
        text: '~',
        rect: [300, 300, 300, 310],
        height: 10,
        baseline: 310,
        horizontal: true
      })
    expect(hasNativeEquationBlock({ proved: f.proved }, f.table, f.inventory, f.rules)).toBe(true)
  }
)
it.each(['header', 'caption', 'frame', 'foreign degenerate', 'unknown position'])(
  'does not review definitions without a complete uncaptioned native domain: %s',
  (mode) => {
    const f = nativeDefinitions()
    if (mode === 'header') {
      const p = f.proved[0]
      p.fonts[0].text = p.fonts[0].sourceItem.text = p.cell.text = f.table.grid[0][0] = 'Definition'
    }
    if (mode === 'caption') f.table.caption = { lines: ['Table 1. Formulas'] }
    if (mode === 'frame')
      f.rules = [
        [0, 0, 180, 0],
        [0, 50, 180, 50]
      ]
    if (mode === 'foreign degenerate')
      f.inventory.push({
        text: '~',
        rect: [60, 15, 60, 25],
        height: 10,
        baseline: 25,
        horizontal: true
      })
    if (mode === 'unknown position')
      f.inventory.push({
        text: '~',
        rect: [NaN, 300, 300, 310],
        height: 10,
        baseline: 310,
        horizontal: true
      })
    expect(hasNativeEquationBlock({ proved: f.proved }, f.table, f.inventory, f.rules)).toBe(false)
  }
)
it('preserves ordinary wrapped descriptions and explicit numeric sequences', () => {
  const f = pairedRecordsInOneRow(),
    right = f.proved.at(-1)
  right.fonts[0].text = right.fonts[0].sourceItem.text = '3 items'
  right.fonts[1].text = right.fonts[1].sourceItem.text = '5 records'
  right.cell.text = f.table.grid[3][1] = '3 items 5 records'
  expect(reviewedKinds(f)).not.toContain('merged-native-paired-records')
  const n = repeatedNumericLanes()
  for (const p of n.proved.filter((p: Data) => p.cell.row > 0 && p.cell.column === 1)) {
    p.fonts[0].text = p.fonts[0].sourceItem.text = '[1,'
    p.fonts[1].text = p.fonts[1].sourceItem.text = '2]'
    p.cell.text = n.table.grid[p.cell.row][1] = '[1, 2]'
  }
  expect(reviewedKinds(n)).not.toContain('collapsed-native-numeric-lanes')
})
