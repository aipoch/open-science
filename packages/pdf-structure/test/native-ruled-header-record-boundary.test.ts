import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

function wrappedOperatorRecord(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse> = []
  const runs: ReturnType<typeof JSON.parse> = []
  const operators: ReturnType<typeof JSON.parse> = {
    fnArray: [44, 40, 44, 40, 44],
    argsArray: [[], [50, -16], [], [50, 16], []]
  }
  const add = (text: string, x: number, y: number, op: number): void => {
    const rect = [x, y, x + text.length * 3, y + 8]
    items.push({
      text,
      rect,
      sourceItem: { pageNumber: 1, index: items.length, text },
      baseline: y + 8,
      height: 8,
      horizontal: true
    })
    runs.push({
      text,
      rect: [...rect],
      baseline: y + 8,
      height: 8,
      gaps: [],
      glyphRuns: [...text].map(() => op),
      literalGlyphs: [...text]
    })
  }
  add('A', 5, 10, 0)
  add('alpha', 55, 10, 0)
  add('beta', 55, 26, 2)
  add('5', 105, 10, 4)
  add('stable', 155, 10, 4)
  for (const [n, y] of [42, 62].entries()) {
    for (const [c, text] of [`B${n}`, 'gamma', '6', 'steady'].entries())
      add(text, c * 50 + 5, y, 10 + n)
  }
  for (const op of [0, 2, 4])
    operators.argsArray[op] = [
      runs
        .filter((r: { glyphRuns: number[] }) => r.glyphRuns[0] === op)
        .flatMap((r: { text: string }) => [...r.text].map((unicode) => ({ unicode, accent: null })))
    ]
  return {
    items,
    runs,
    operators,
    table: {
      cropRect: [0, 0, 200, 75],
      structure: {
        objects: [
          ...[0, 50, 100, 150].map((x) => ({ label: 'table column', rect: [x, 0, x + 50, 75] })),
          ...[
            [0, 21],
            [22, 53],
            [54, 75]
          ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 200, bottom] }))
        ]
      }
    }
  }
}

function runWrappedOperator(
  input: ReturnType<typeof wrappedOperatorRecord>
): ReturnType<typeof JSON.parse> {
  return refineTable(input.table, input.items, [], [], [], input.runs, undefined, undefined, {
    operators: input.operators
  })
}

it('marks a continuation assigned to a different row inside one complete native text-operator bracket', () => {
  const input = wrappedOperatorRecord()
  const result = runWrappedOperator(input)
  expect(result.issues).toContain('span-conflicts-with-source-rows')
  expect(result.grid).toEqual([
    ['A', 'alpha', '5', 'stable'],
    ['B0', 'beta gamma', '6', 'steady'],
    ['B1', 'gamma', '6', 'steady']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  ).toEqual(input.items.map((i: { sourceItem: unknown }) => i.sourceItem))
})

it.each([
  'font change',
  'return baseline',
  'glyph mismatch',
  'missing run',
  'extra native glyph',
  'independent lower stub',
  'source alias',
  'duplicate run'
])('does not infer a wrapped record from an incomplete native bracket: %s', (variant) => {
  const input = wrappedOperatorRecord()
  if (variant === 'font change') input.operators.fnArray[3] = 37
  if (variant === 'return baseline') input.operators.argsArray[3][1] = 15
  if (variant === 'glyph mismatch') input.runs[2].literalGlyphs = ['z']
  if (variant === 'missing run') input.runs.splice(2, 1)
  if (variant === 'extra native glyph') input.operators.argsArray[2][0].push({ unicode: 'z' })
  if (variant === 'independent lower stub')
    input.items.push({
      text: 'C',
      sourceItem: { pageNumber: 1, index: 30, text: 'C' },
      rect: [5, 26, 8, 34],
      baseline: 34,
      height: 8,
      horizontal: true
    })
  if (variant === 'source alias') input.items.push({ ...input.items[2], rect: [300, 10, 320, 18] })
  if (variant === 'duplicate run') input.runs.push(structuredClone(input.runs[2]))
  expect(runWrappedOperator(input).issues).not.toContain('span-conflicts-with-source-rows')
})

function mergedRuledRecord(scale = 1): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse> = []
  for (let column = 0; column < 3; column++) {
    for (let line = 0; line < 2; line++) {
      const text = column ? `${column + line * 10}` : ['Class', 'Measure'][line]
      items.push({
        text,
        sourceItem: { pageNumber: 1, index: items.length, text },
        rect: [5 + column * 40, 10 + line * 12, 25 + column * 40, 18 + line * 12],
        baseline: 18 + line * 12,
        height: 8,
        horizontal: true
      })
    }
  }
  items.push({
    text: '(unit)',
    sourceItem: { pageNumber: 1, index: 6, text: '(unit)' },
    rect: [5, 32, 25, 40],
    baseline: 40,
    height: 8,
    horizontal: true
  })
  for (const item of items) {
    item.rect = item.rect.map((v: number) => v * scale)
    item.baseline *= scale
    item.height *= scale
  }
  return {
    table: {
      cropRect: [0, 0, 120, 45].map((v) => v * scale),
      structure: {
        objects: [
          ...[0, 40, 80].map((x) => ({
            label: 'table column',
            rect: [x, 0, x + 40, 45].map((v) => v * scale)
          })),
          { label: 'table column header', rect: [0, 5, 120, 40].map((v) => v * scale) },
          { label: 'table row', rect: [0, 5, 120, 40].map((v) => v * scale) }
        ]
      }
    },
    items,
    rules: [[0, 20, 120, 20].map((v) => v * scale)],
    captions: []
  }
}

it.each([0.7, 1])(
  'marks a whole native divider swallowed by one logical row at scale %s',
  (scale) => {
    const input = mergedRuledRecord(scale)
    const result = run(input)
    expect(result.issues).toContain('span-conflicts-with-source-rows')
    expect(result.reviewCandidate).toBe(false)
    expect(result.grid).toEqual([['Class Measure (unit)', '1 11', '2 12']])
    expect(result.cropRect).toEqual(input.table.cropRect)
    expect(
      result.cells.map((cell: { rowSpan: number; colSpan: number }) => [cell.rowSpan, cell.colSpan])
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1]
    ])
    expect(
      result.cells
        .flatMap((cell: { sourceItems: { index: number }[] }) => cell.sourceItems)
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(input.items.map((item: { sourceItem: unknown }) => item.sourceItem))
  }
)

it.each([
  'no divider',
  'short underline',
  'segmented divider',
  'slanted divider',
  'touching glyph',
  'whole alias',
  'segment alias',
  'plural alias',
  'nested plural alias',
  'deep alias',
  'empty literal alias',
  'own plural metadata',
  'own deep metadata',
  'unassigned crossing glyph',
  'already separated'
])('does not certify a swallowed divider with incomplete proof: %s', (variant) => {
  const input = mergedRuledRecord()
  if (variant === 'no divider') input.rules = []
  if (variant === 'short underline') input.rules[0][2] = 30
  if (variant === 'segmented divider')
    input.rules = [
      [0, 20, 50, 20],
      [55, 20, 120, 20]
    ]
  if (variant === 'slanted divider') input.rules[0][3] = 20.1
  if (variant === 'touching glyph') input.items[0].rect[3] = 20
  const source = input.items[0].sourceItem
  if (variant === 'whole alias')
    input.items.push({ text: source.text, rect: [300, 10, 320, 18], sourceItem: { ...source } })
  if (variant === 'segment alias')
    input.items.push({ sourceSegment: { ...source, start: 0, end: 2 } })
  if (variant === 'plural alias') input.items.push({ sourceItems: [{ ...source }] })
  if (variant === 'nested plural alias')
    input.items.push({ sourceToken: { sourceItems: [{ ...source }] } })
  if (variant === 'deep alias')
    input.items.push({ unknown: { deep: { sourceTokens: [{ sourceItem: { ...source } }] } } })
  if (variant === 'empty literal alias')
    input.items.push({ sourceItems: [{ ...source, text: '' }] })
  if (variant === 'own plural metadata') input.items[0].sourceItems = []
  if (variant === 'own deep metadata') input.items[0].unknown = { deep: { sourceSegments: [] } }
  if (variant === 'unassigned crossing glyph')
    input.items.push({
      text: 'extra',
      rect: [30, 19, 35, 21],
      height: 2,
      baseline: 21,
      horizontal: true
    })
  if (variant === 'already separated') input.items.pop()
  // Aliases outside the crop still participate in native identity proof, but
  // remain ordinary well-formed page tokens for upstream geometry processing.
  for (const item of input.items) {
    item.text ??= 'alias'
    item.rect ??= [300, 10, 320, 18]
    item.height ??= 8
    item.baseline ??= 18
    item.horizontal ??= true
  }
  expect(run(input).issues).not.toContain('span-conflicts-with-source-rows')
})

function pairedRuleRecords(scale = 1): ReturnType<typeof JSON.parse> {
  let index = 0
  const token = (
    text: string,
    column: number,
    baseline: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [10 + column * 50, baseline - 10, 36 + column * 50, baseline].map((v) => v * scale),
    height: 10 * scale,
    baseline: baseline * scale,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 200, 120].map((v) => v * scale),
      structure: {
        objects: [
          ...[0, 50, 100, 150].map((x) => ({
            label: 'table column',
            rect: [x, 24, x + 50, 114].map((v) => v * scale)
          })),
          ...[
            [24, 50],
            [56, 70],
            [70, 82],
            [88, 102],
            [102, 114]
          ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 200, b].map((v) => v * scale) })),
          { label: 'table column header', rect: [0, 24, 200, 50].map((v) => v * scale) }
        ]
      }
    },
    items: [
      ...['Group', 'Flag', 'Rate', 'Score'].map((text, column) => token(text, column, 15)),
      ...Array.from({ length: 3 }, (_, group) => [
        token(['Alpha', 'Beta', 'Gamma'][group], 0, 40 + group * 32),
        ...[34, 46].flatMap((y, row) => [
          token(row ? '–' : '✓', 1, y + group * 32),
          token(`${group + row + 1}.2`, 2, y + group * 32),
          token('0.0', 3, y + group * 32)
        ])
      ]).flat()
    ],
    rules: [2, 20, 52, 84, 118].map((y) => [0, y, 200, y].map((v) => v * scale)),
    captions: [
      {
        page: 1,
        lines: ['Table 1. Paired records.'],
        rect: [0, -20, 200, -5].map((v) => v * scale)
      }
    ]
  }
}

it.each([0.7, 1])(
  'recovers every ruled paired record instead of merging the first pair at scale %s',
  (scale) => {
    const input = pairedRuleRecords(scale)
    const result = run(input)
    expect(result.grid).toEqual([
      ['Group', 'Flag', 'Rate', 'Score'],
      ...['Alpha', 'Beta', 'Gamma'].flatMap((label, group) => [
        [label, '✓', `${group + 1}.2`, '0.0'],
        ['', '–', `${group + 2}.2`, '0.0']
      ])
    ])
    expect(
      result.cells
        .filter((cell: { column: number; row: number }) => cell.column === 0 && cell.row > 0)
        .map((cell: { rowSpan: number }) => cell.rowSpan)
    ).toEqual([2, 2, 2])
    expect(
      result.cells
        .flatMap((cell: { sourceItems: { index: number }[] }) => cell.sourceItems)
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(input.items.map((item: { sourceItem: unknown }) => item.sourceItem))
  }
)

it.each([
  'missing field',
  'missing fence',
  'partial fence',
  'crossing glyph',
  'crossing column',
  'shifted record',
  'shifted stub',
  'script',
  'duplicate whole source',
  'external segment alias',
  'external token alias',
  'non-horizontal'
])('does not infer paired records without complete native proof: %s', (change) => {
  const input = pairedRuleRecords()
  if (change === 'missing field') input.items.splice(7, 1)
  if (change === 'missing fence') input.rules.splice(2, 1)
  if (change === 'partial fence') input.rules[2][2] = 90
  if (change === 'crossing glyph') input.items[7].rect[3] = 53
  if (change === 'crossing column') input.items[6].rect[2] = 170
  if (change === 'shifted record') input.items[7].baseline += 4
  if (change === 'shifted stub') {
    input.items[4].baseline += 4
    input.items[4].rect[1] += 4
    input.items[4].rect[3] += 4
  }
  if (change === 'script') input.items[7].height = 6
  if (change === 'non-horizontal') input.items[7].horizontal = false
  if (change === 'duplicate whole source')
    input.items[7].sourceItem = { ...input.items[6].sourceItem }
  if (change === 'external segment alias' || change === 'external token alias') {
    const parent = input.items[7]
    input.items.push({
      text: parent.text,
      rect: [250, 20, 270, 30],
      height: 10,
      baseline: 30,
      horizontal: true,
      ...(change === 'external segment alias'
        ? { sourceSegment: { ...parent.sourceItem, start: 0, end: parent.text.length } }
        : { sourceToken: { ...parent } })
    })
  }
  expect(run(input)?.repairs ?? []).not.toContain('native-ruled-paired-records-recovered')
})

function fixture(scale = 1): ReturnType<typeof JSON.parse> {
  let index = 0
  const token = (text: string, column: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [10 + column * 100, y, 50 + column * 100, y + 10].map((v) => v * scale),
    height: 10 * scale,
    baseline: (y + 10) * scale,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 500, 80].map((v) => v * scale),
      structure: {
        objects: [
          ...[0, 100, 200, 300, 400].map((x) => ({
            label: 'table column',
            rect: [x, 17, x + 100, 80].map((v) => v * scale)
          })),
          ...[17, 37, 57].map((y) => ({
            label: 'table row',
            rect: [0, y, 500, y + 20].map((v) => v * scale)
          }))
        ]
      }
    },
    items: [
      ...['Name', 'Description', 'Dimension', 'Unit', 'Value'].map((text, column) =>
        token(text, column, 2)
      ),
      ...Array.from({ length: 3 }, (_, row) =>
        ['a' + row, 'Growth rate', 'time', 'hours', `${row + 1}.2`].map((text, column) =>
          token(text, column, 16 + row * 20)
        )
      ).flat()
    ],
    captions: [
      {
        page: 1,
        lines: ['Table 1. Example parameters.'],
        rect: [0, 85, 500, 95].map((v) => v * scale)
      }
    ],
    rules: [
      [0, 18, 500, 18],
      [0, 80, 500, 80]
    ].map((r) => r.map((v) => v * scale))
  }
}

function run(input: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> {
  return refineTable(input.table, input.items, input.captions, [], input.rules, [])
}

it.each([0.7, 1])(
  'keeps a native ruled header separate from the first record at scale %s',
  (scale) => {
    const input = fixture(scale)
    const expected = input.items.map((item: { sourceItem: unknown }) => item.sourceItem)
    const result = run(input)
    expect(result.grid).toEqual([
      ['Name', 'Description', 'Dimension', 'Unit', 'Value'],
      ...Array.from({ length: 3 }, (_, row) => [
        'a' + row,
        'Growth rate',
        'time',
        'hours',
        `${row + 1}.2`
      ])
    ])
    expect(result.cells.flatMap((cell: { sourceItems: unknown[] }) => cell.sourceItems)).toEqual(
      expected
    )
  }
)

it.each([
  'absent',
  'partial',
  'below baseline',
  'vertical',
  'missing baseline',
  'non-horizontal token'
])('retains the existing wrapped header when a separating rule is %s', (variant) => {
  const input = fixture()
  if (variant === 'absent') input.rules.shift()
  if (variant === 'partial') input.rules[0] = [0, 18, 200, 18]
  if (variant === 'below baseline') input.rules[0] = [0, 28, 500, 28]
  if (variant === 'vertical') input.rules[0] = [0, 18, 0, 28]
  if (variant === 'missing baseline') delete input.items[5].baseline
  if (variant === 'non-horizontal token') input.items[5].horizontal = false
  const withoutDivider = structuredClone(input)
  withoutDivider.rules = [[0, 80, 500, 80]]
  const result = run(input)
  expect(result.grid).toEqual(run(withoutDivider).grid)
  expect(result.grid).toHaveLength(3)
  expect(result.grid[0]).toEqual([
    variant === 'non-horizontal token' ? 'Name' : 'Name a0',
    'Description Growth rate',
    'Dimension time',
    'Unit hours',
    'Value 1.2'
  ])
})

// Append to native-ruled-header-record-boundary.test.ts; uses its actual run/refine seam.
function collapsedNativeVerticalFields(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, y: number, width = 8): void => {
    items.push({
      text,
      rect: [x, y, x + width, y + 8],
      baseline: y + 8,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  for (let row = 0; row < 3; row++) {
    const y = 15 + row * 25
    add(`R${row}`, 10, y, 12)
    add(String(row + 1), 42, y)
    add(String(row + 4), 68, y)
    add(`kind${row}`, 95, y, 24)
  }
  return {
    table: {
      cropRect: [0, 0, 130, 90],
      structure: {
        objects: [
          ...[0, 30, 85].map((x, c) => ({
            label: 'table column',
            rect: [x, 0, [30, 85, 130][c], 90]
          })),
          ...[5, 30, 55].map((y) => ({ label: 'table row', rect: [0, y, 130, y + 25] }))
        ]
      }
    },
    items,
    captions: [],
    rules: [[57, 0, 57, 90]]
  }
}

it('marks repeated single cells that swallow a complete native vertical divider', () => {
  const input = collapsedNativeVerticalFields()
  const result = run(input)
  expect(result.issues).toContain('span-conflicts-with-source-columns')
  expect(result.grid).toEqual([
    ['R0', '1 4', 'kind0'],
    ['R1', '2 5', 'kind1'],
    ['R2', '3 6', 'kind2']
  ])
  expect(result.cells.flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)).toEqual(
    input.items.map((i: { sourceItem: unknown }) => i.sourceItem)
  )
})

it.each([
  'absent',
  'partial',
  'gapped',
  'diagonal',
  'touching ink',
  'external plural alias',
  'external segment alias',
  'independent columns'
])('does not certify a vertical conflict without native proof: %s', (variant) => {
  const input = collapsedNativeVerticalFields()
  if (variant === 'absent') input.rules = []
  if (variant === 'partial') input.rules = [[57, 16, 57, 24]]
  if (variant === 'gapped')
    input.rules = [
      [57, 0, 57, 24],
      [57, 35, 57, 49],
      [57, 60, 57, 90]
    ]
  if (variant === 'diagonal') input.rules = [[56, 0, 57, 90]]
  if (variant === 'touching ink') for (const i of [1, 5, 9]) input.items[i].rect[2] = 57
  if (variant === 'external plural alias' || variant === 'external segment alias')
    for (const i of [1, 5, 9])
      input.items.push({
        text: 'alias',
        rect: [300, 300, 310, 308],
        height: 8,
        baseline: 308,
        horizontal: true,
        ...(variant === 'external plural alias'
          ? { sourceItems: [input.items[i].sourceItem] }
          : { sourceSegment: { ...input.items[i].sourceItem, start: 0, end: 1 } })
      })
  if (variant === 'independent columns')
    input.table.structure.objects = [
      ...[0, 30, 57, 85].map((x, c) => ({
        label: 'table column',
        rect: [x, 0, [30, 57, 85, 130][c], 90]
      })),
      ...input.table.structure.objects.filter((o: { label: string }) => o.label === 'table row')
    ]
  expect(run(input).issues).not.toContain('span-conflicts-with-source-columns')
})

function nativeWrappedSetFields(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, y: number, width: number): void => {
    items.push({
      text,
      rect: [x, y, x + width, y + 8],
      height: 8,
      baseline: y + 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  add('Record', 2, 0, 24)
  add('Choices', 40, 0, 28)
  for (let row = 0; row < 2; row++) {
    const y = 20 + row * 35
    add(`R${row}`, 2, y, 8)
    add('{alpha,', 40, y, 28)
    add('beta,', 90, y, 20)
    add('gamma,', 140, y, 24)
    add('delta}', 40, y + 10, 24)
  }
  return {
    table: {
      cropRect: [0, -2, 180, 85],
      structure: {
        objects: [
          ...[0, 35, 85, 135].map((x, c) => ({
            label: 'table column',
            rect: [x, -2, [35, 85, 135, 180][c], 85]
          })),
          ...[
            [-2, 15],
            [15, 50],
            [50, 85]
          ].map(([y, bottom]) => ({ label: 'table row', rect: [0, y, 180, bottom] }))
        ]
      }
    },
    items,
    captions: [],
    rules: []
  }
}

it('marks a complete native wrapped set split across artificial leaves without rewriting it', () => {
  const input = nativeWrappedSetFields(),
    result = run(input)
  expect(result.issues).toContain('span-conflicts-with-source-columns')
  expect(result.grid).toEqual([
    ['Record', 'Choices', '', ''],
    ['R0', '{alpha, delta}', 'beta,', 'gamma,'],
    ['R1', '{alpha, delta}', 'beta,', 'gamma,']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  ).toEqual(input.items.map((i: { sourceItem: unknown }) => i.sourceItem))
})

it.each([
  'one whole cell',
  'independent leaf header',
  'numeric matrix',
  'open list',
  'noncomma leaf',
  'native column fence',
  'external segment alias'
])('retains the existing grid without a proved split wrapped set: %s', (variant) => {
  const input = nativeWrappedSetFields()
  if (variant === 'one whole cell')
    input.table.structure.objects = [
      ...input.table.structure.objects.filter((o: { label: string }) => o.label !== 'table column'),
      { label: 'table column', rect: [0, -2, 35, 85] },
      { label: 'table column', rect: [35, -2, 180, 85] }
    ]
  if (variant === 'independent leaf header')
    input.items.push({
      text: 'Leaf',
      rect: [90, 0, 106, 8],
      height: 8,
      baseline: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 99, text: 'Leaf' }
    })
  const change = (indices: number[], text: string): void => {
    for (const i of indices) {
      input.items[i].text = text
      input.items[i].sourceItem.text = text
    }
  }
  if (variant === 'numeric matrix') change([3, 8], '{1,')
  if (variant === 'open list') change([6, 11], 'delta')
  if (variant === 'noncomma leaf') change([4, 9], 'beta')
  if (variant === 'native column fence') input.rules = [[85, 10, 85, 90]]
  if (variant === 'external segment alias')
    input.items.push({
      text: 'x',
      rect: [300, 300, 308, 308],
      height: 8,
      baseline: 308,
      horizontal: true,
      sourceToken: { sourceSegment: { ...input.items[3].sourceItem, start: 0, end: 1 } }
    })
  const result = run(input)
  expect(result.issues).not.toContain('span-conflicts-with-source-columns')
  if (variant === 'one whole cell')
    expect(result.grid).toEqual([
      ['Record', 'Choices'],
      ['R0', '{alpha, beta, gamma, delta}'],
      ['R1', '{alpha, beta, gamma, delta}']
    ])
})

function isolatedStubBelowHeader(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, y: number): void => {
    items.push({
      text,
      sourceItem: { pageNumber: 1, index: items.length, text },
      rect: [x, y, x + 25, y + 8],
      baseline: y + 8,
      height: 8,
      horizontal: true
    })
  }
  add('Category', 5, 10)
  add('Some record', 5, 30)
  add('Flag', 45, 10)
  add('Value', 85, 10)
  add('Alpha', 5, 50)
  add('Yes', 45, 50)
  add('2', 85, 50)
  return {
    table: {
      cropRect: [0, 0, 120, 80],
      structure: {
        objects: [
          ...[0, 40, 80].map((x) => ({ label: 'table column', rect: [x, 0, x + 40, 80] })),
          { label: 'table column header', rect: [0, 5, 120, 40] },
          ...[5, 45].map((y) => ({ label: 'table row', rect: [0, y, 120, y + 35] }))
        ]
      }
    },
    items,
    rules: [[0, 25, 120, 25]],
    captions: []
  }
}

it('marks an independent stub below the complete header divider without rewriting sources', () => {
  const input = isolatedStubBelowHeader(),
    result = run(input)
  expect(result.issues).toContain('span-conflicts-with-source-rows')
  expect(result.reviewCandidate).toBe(false)
  expect(result.grid).toEqual([
    ['Category Some record', 'Flag', 'Value'],
    ['Alpha', 'Yes', '2']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  ).toEqual(input.items.map((i: { sourceItem: unknown }) => i.sourceItem))
})
it.each([
  'no divider',
  'short divider',
  'slanted divider',
  'glyph crosses',
  'script',
  'shifted stub',
  'single word',
  'extra ink',
  'alias'
])('does not mark a header tail without complete native proof: %s', (variant) => {
  const input = isolatedStubBelowHeader()
  if (variant === 'no divider') input.rules = []
  if (variant === 'short divider') input.rules[0][2] = 60
  if (variant === 'slanted divider') input.rules[0][3] = 26
  if (variant === 'glyph crosses') input.items[1].rect[1] = 24
  if (variant === 'script') input.items[1].height = 5
  if (variant === 'shifted stub') input.items[1].rect[0] = 6
  if (variant === 'single word') {
    input.items[1].text = 'Record'
    input.items[1].sourceItem.text = 'Record'
  }
  if (variant === 'extra ink')
    input.items.push({
      text: 'outside',
      rect: [31, 22, 36, 28],
      height: 6,
      baseline: 28,
      horizontal: true
    })
  if (variant === 'alias') input.items.push({ ...input.items[1], rect: [300, 30, 325, 38] })
  expect(run(input).issues).not.toContain('span-conflicts-with-source-rows')
})

function partialParentRuleFixture(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, y: number, width: number): void => {
    items.push({
      text,
      rect: [x, y, x + width, y + 8],
      height: 8,
      baseline: y + 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  add('Group A', 25, 10, 25)
  add('Group B', 115, 10, 25)
  for (let c = 0; c < 4; c++) add('Leaf ' + c, [12, 62, 102, 152][c], 32, 20)
  return {
    table: {
      cropRect: [0, 0, 190, 70],
      structure: {
        objects: [
          ...[0, 50, 100, 150].map((x, c) => ({
            label: 'table column',
            rect: [x, 0, [50, 100, 150, 190][c], 70]
          })),
          ...[
            [0, 26],
            [26, 50],
            [50, 70]
          ].map(([y, bottom]) => ({ label: 'table row', rect: [0, y, 190, bottom] }))
        ]
      }
    },
    items,
    rules: [
      [0, 5, 190, 5],
      [10, 25, 90, 25],
      [100, 25, 180, 25],
      [0, 50, 190, 50]
    ]
  }
}

it('marks single-leaf parent ownership contradicted by independent native partial rules', () => {
  const f = partialParentRuleFixture()
  const result = refineTable(f.table, f.items, [], [], f.rules, [])
  expect(result.issues).toContain('span-conflicts-with-source-columns')
  expect(result.grid.slice(0, 2)).toEqual([
    ['Group A', '', 'Group B', ''],
    ['Leaf 0', 'Leaf 1', 'Leaf 2', 'Leaf 3']
  ])
})

it.each([
  ['missing independent rule domain', (f: ReturnType<typeof JSON.parse>) => f.rules.splice(2, 1)],
  ['missing lower frame rule', (f: ReturnType<typeof JSON.parse>) => f.rules.pop()],
  ['missing upper frame rule', (f: ReturnType<typeof JSON.parse>) => f.rules.shift()],
  [
    'overlapping rule domains',
    (f: ReturnType<typeof JSON.parse>) => {
      f.rules[1][2] = 110
    }
  ],
  [
    'source alias outside the table',
    (f: ReturnType<typeof JSON.parse>) => {
      f.items.push({ ...f.items[0], rect: [300, 300, 325, 308] })
    }
  ],
  [
    'plural source alias outside the table',
    (f: ReturnType<typeof JSON.parse>) => {
      f.items.push({
        text: 'outside',
        rect: [300, 300, 325, 308],
        height: 8,
        baseline: 308,
        horizontal: true,
        sourceSegments: [{ sourceItem: { ...f.items[0].sourceItem } }]
      })
    }
  ],
  [
    'different parent baselines',
    (f: ReturnType<typeof JSON.parse>) => {
      f.items[1].baseline += 1
    }
  ]
] as const)('does not infer a parent conflict with %s', (_name, change) => {
  const f = partialParentRuleFixture()
  change(f)
  expect(refineTable(f.table, f.items, [], [], f.rules, []).issues).not.toContain(
    'span-conflicts-with-source-columns'
  )
})
