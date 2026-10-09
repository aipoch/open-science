import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  hasTableEvidence,
  proveCaptionedNativeClosedTableFrame,
  nativeSourceDuplicateTableIndices,
  isNativeRepeatedAuthorContactPanel,
  recoverNativeCenteredTableCaption
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
type NativeToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
type NativeEvidenceTable = {
  cropRect: number[]
  sourceViewport: { scale: number }
  grid: string[][]
  cells: {
    row: number
    column: number
    sourceRects: number[][]
    text?: string
    rowSpan?: number
    colSpan?: number
    rect?: number[]
  }[]
  unassigned: string[]
  clipped?: string[]
  issues?: string[]
}
type NativeEvidenceCaption = { page?: number; lines: string[]; rect: number[] }
type NativeEvidenceFixture = {
  items: NativeToken[]
  rules: number[][]
}
const token = (text: string, x: number, y: number, width: number, height = 10): NativeToken => ({
  text,
  rect: [x, y, x + width, y + height],
  baseline: y + height,
  height,
  horizontal: true
})

const assignedNativeMatrix = (): NativeEvidenceFixture & { table: NativeEvidenceTable } => {
  const grid = [
    ['An independent explanation precedes the display.', '', '', ''],
    ['M', '=', '', ''],
    ['1', '0', '0', 'x'],
    ['0', '1', '0', 'x'],
    ['0', '0', '1', 'x']
  ]
  const items = [
    token('M', 5, 63, 8),
    token('=', 20, 63, 8),
    ...['', '', '', ''].map((s, n) => token(s, 35, 40 + n * 14, 8)),
    ...['', '', '', ''].map((s, n) => token(s, 155, 40 + n * 14, 8)),
    ...grid.slice(2).flatMap((row, r) => row.map((s, c) => token(s, 48 + c * 25, 48 + r * 14, 6)))
  ]
  return {
    table: {
      cropRect: [0, 20, 175, 110],
      sourceViewport: { scale: 1 },
      grid,
      cells: [],
      unassigned: [],
      issues: []
    },
    items,
    rules: []
  }
}

it('keeps a complete paired-bracket matrix assignment in native mathematical prose', () => {
  const f = assignedNativeMatrix(),
    before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(false)
  expect(f).toEqual(before)
})

it.each(['caption', 'assignment', 'left-closing', 'right-wall', 'paired-font', 'native-divider'])(
  'retains a numeric grid without complete native assignment-display proof: %s',
  (missing) => {
    const f = assignedNativeMatrix()
    if (missing === 'assignment') f.items = f.items.filter((i) => i.text !== '=')
    if (missing === 'left-closing') f.items = f.items.filter((i) => i.text !== '')
    if (missing === 'right-wall') f.items = f.items.filter((i) => !''.includes(i.text))
    if (missing === 'paired-font') f.items.find((i) => i.text === '')!.height += 2
    if (missing === 'native-divider') f.rules.push([30, 59, 165, 59])
    expect(
      hasTableEvidence(
        f.table,
        missing === 'caption' ? { lines: ['Table 1: Measured numeric records.'] } : undefined,
        f.items,
        f.rules
      )
    ).toBe(true)
  }
)

const scientific = (): ReturnType<typeof JSON.parse> => ({
  table: {
    cropRect: [0, 30, 260, 145],
    grid: [
      ['Species', 'Count', 'N', 'T'],
      ...Array.from({ length: 5 }, () => ['AB3', '', '2.1+0.3×1017', '−'])
    ],
    unassigned: Array.from({ length: 20 }, () => '1'),
    issues: [],
    sourceViewport: { scale: 1 }
  },
  caption: { lines: ['Table B.2: Anonymous measured records.'], rect: [0, 8, 260, 20] },
  rules: [
    [0, 30, 260, 30],
    [0, 33, 260, 33],
    [0, 63, 260, 63],
    [0, 145, 260, 145]
  ],
  items: [
    token('Species', 2, 35, 35),
    token('No. of', 65, 35, 26),
    token('N', 110, 35, 8),
    token('T', 220, 35, 8),
    token('lines', 65, 49, 25),
    token('[cm', 110, 49, 18),
    token('−2', 128, 47, 8, 6),
    token(']', 136, 49, 3),
    token('[K]', 220, 49, 15),
    ...[68, 82, 96, 110, 124].flatMap((y, n) => [
      token(`AB${n}`, 2, y, 25),
      token(`${n + 2}`, 65, y, 8),
      token('2.1', 110, y, 18),
      token('+0.3', 128, y - 2, 13, 6),
      token('×10', 145, y, 20),
      token('17', 165, y - 2, 8, 6),
      token('−', 220, y, 8)
    ])
  ]
})

it('preserves a captioned double-rule frame with separately printed wrapped/scripted leaf headers', () => {
  const f = scientific(),
    before = structuredClone(f)
  const proof = proveCaptionedNativeClosedTableFrame(f.table, f.caption, f.items, f.rules)
  expect(proof?.kind).toBe('native-closed-table-visual')
  expect(proof?.sourceTokens).toHaveLength(f.items.length)
  expect(hasTableEvidence(f.table, f.caption, f.items, f.rules)).toBe(true)
  expect(f).toEqual(before)
  f.rules.pop()
  expect(proveCaptionedNativeClosedTableFrame(f.table, f.caption, f.items, f.rules)).toBeUndefined()
  expect(hasTableEvidence(f.table, f.caption, f.items, f.rules)).toBe(false)
})

it('does not let a model score, a distant caption, or one continuous prose header prove a frame', () => {
  const f = scientific()
  f.table.score = 0.9999
  expect(hasTableEvidence(f.table, f.caption, f.items, [])).toBe(false)
  expect(
    proveCaptionedNativeClosedTableFrame(
      f.table,
      { ...f.caption, rect: [0, -100, 260, -80] },
      f.items,
      f.rules
    )
  ).toBeUndefined()
  const header = [token('An ordinary paragraph without separate leaf labels', 2, 35, 240)]
  expect(
    proveCaptionedNativeClosedTableFrame(
      f.table,
      f.caption,
      [...header, ...f.items.slice(9)],
      f.rules
    )
  ).toBeUndefined()
})

it('does not count subscript indices inside a fully assigned native coordinate frame as bibliography ordinals', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/captionless-ruled-coordinate-index-records.jsonl'
    )
  )
  const before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(true)
  expect(f).toEqual(before)
  expect(hasTableEvidence(f.table, undefined, f.items, [])).toBe(false)
})

it('rejects a continuation bibliography whose apparent measurements are independently owned affiliation markers', () => {
  const texts = [
    'Authora, A. 2020, Journal, 12, 34',
    'Authorb, B. 2021, Journal, 13, A35',
    'Authorc, C. 2022, Journal, 14, 36',
    'Authord, D. 2023, Journal, 15, 37'
  ]
  const items = texts.flatMap((text, n) => [
    token(text, 2, 30 + n * 20, 240),
    token(`${n + 8}`, 255, 30 + n * 20, 6, 6),
    token('Department of Science, Anonymous University', 268, 31 + n * 20, 240)
  ])
  const table = {
    cropRect: [0, 20, 264, 115],
    grid: texts.map((text, n) => [text, `${n + 8}`]),
    issues: [],
    unassigned: []
  }
  expect(hasTableEvidence(table, undefined, items, [])).toBe(false)
  // Native refinement can include the beginning of the neighboring line;
  // most of that institutional text still has an independent outside owner.
  expect(hasTableEvidence({ ...table, cropRect: [0, 20, 285, 115] }, undefined, items, [])).toBe(
    false
  )
  expect(
    hasTableEvidence(table, { text: 'Table 1: Measured reference comparison.' }, items, [])
  ).toBe(true)
  expect(
    hasTableEvidence(
      table,
      undefined,
      items.filter((i) => i.rect[0] < 268),
      []
    )
  ).toBe(true)
})

it('rejects a continuous numbered tuple display while retaining framed or captioned coordinate tables', () => {
  const items = [
    token('(2.1)', 2, 40, 20),
    token('(1, 2, 3), (2, 3, 4),', 40, 30, 200),
    token('(3, 4, 5), (4, 5, 6),', 40, 45, 200),
    token('(5, 6, 7), (6, 7, 8).', 40, 60, 200)
  ]
  const table = {
    cropRect: [0, 25, 250, 75],
    grid: [
      ['(1, 2, 3), (2,', '3, 4),'],
      ['(3, 4, 5), (4,', '5, 6),'],
      ['(5, 6, 7), (6,', '7, 8).']
    ],
    issues: [],
    unassigned: []
  }
  expect(hasTableEvidence(table, undefined, items, [])).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1: Coordinates.' }, items, [])).toBe(true)
  expect(
    hasTableEvidence(table, undefined, items, [
      [0, 25, 250, 25],
      [0, 75, 250, 75]
    ])
  ).toBe(true)
})

it('rejects a single mathematical arrow chain plus a prose explanation without suppressing labelled records', () => {
  const items = [
    token('E', 10, 35, 8),
    token('→', 30, 35, 8),
    token('P', 50, 35, 8),
    token('→', 70, 35, 8),
    token('Q', 90, 35, 8),
    token('→', 110, 35, 8),
    token('R', 130, 35, 8),
    token('A single chain explains the physical flow in the paragraph.', 10, 50, 230)
  ]
  const table = {
    cropRect: [0, 25, 250, 65],
    grid: [
      ['E', '→', 'P', '→', 'Q', '→', 'R'],
      ['A single chain', 'explains', 'the physical', 'flow in', 'the', 'paragraph.', '']
    ],
    unassigned: [],
    issues: []
  }
  expect(hasTableEvidence(table, undefined, items, [])).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1: Physical flow comparisons.' }, items, [])).toBe(
    true
  )
  expect(
    hasTableEvidence(table, undefined, items, [
      [0, 25, 250, 25],
      [0, 65, 250, 65],
      [0, 25, 0, 65],
      [250, 25, 250, 65]
    ])
  ).toBe(false)
  expect(hasTableEvidence(table, undefined, items, [[0, 48, 250, 48]])).toBe(true)
})

const framedProcedure = (): NativeEvidenceFixture & { table: NativeEvidenceTable } => {
  const rows = [
    ['1:', 'procedure MIX(A, B)', ''],
    ['2:', 'nA ← min (limit, |A|)', '▷ first buffer'],
    ['3:', 'nB ← limit − nA', '▷ second buffer'],
    ['4:', 'I ← SAMPLE(A, nA) ∪ SAMPLE(B, nB)', '▷ select'],
    ['5:', 'return I', '']
  ]
  const items = [
    token('Algorithm 4', 0, 10, 60),
    token('Rebuild the mixed set', 65, 10, 180),
    token('Hyperparameters: limit and ratio', 0, 34, 190),
    ...rows.flatMap((row, n) =>
      row.flatMap((text, c) =>
        text ? [token(text, [3, 23, 223][c], 50 + n * 14, [12, 195, 44][c])] : []
      )
    )
  ]
  return {
    table: {
      cropRect: [0, 28, 270, 124],
      sourceViewport: { scale: 1 },
      grid: rows,
      cells: items.slice(2).map((item, n) => ({ row: n, column: 0, sourceRects: [item.rect] })),
      unassigned: [],
      issues: []
    },
    items,
    rules: [
      [0, 10, 270, 10],
      [0, 30, 270, 30],
      [0, 122, 270, 122]
    ]
  }
}

it('rejects a complete native procedure whose explicit title lies above the detector grid', () => {
  const f = framedProcedure(),
    before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(false)
  expect(f).toEqual(before)
})

it.each(['title', 'opening', 'divider', 'closing', 'order', 'signature', 'return', 'assignments'])(
  'does not infer procedure ownership without its %s witness',
  (missing) => {
    const f = framedProcedure()
    if (missing === 'title') f.items[0].text = 'Indexed comparison'
    if (missing === 'opening') f.rules.shift()
    if (missing === 'divider') f.rules.splice(1, 1)
    if (missing === 'closing') f.rules.pop()
    if (missing === 'order') f.items.find((i) => i.text === '3:')!.text = '7:'
    if (missing === 'signature')
      f.items.find((i) => /^procedure/.test(i.text))!.text = 'Measured values'
    if (missing === 'return') f.items.find((i) => /^return/.test(i.text))!.text = 'Final setting'
    if (missing === 'assignments')
      for (const item of f.items) item.text = item.text.replace(/←/g, '=')
    expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(true)
  }
)

it('retains a captioned data table despite neighboring procedure vocabulary', () => {
  const f = framedProcedure()
  expect(
    hasTableEvidence(f.table, { text: 'Table 1: Indexed measurements.' }, f.items, f.rules)
  ).toBe(true)
})

const containedNativeSection = (): NativeEvidenceFixture & {
  tables: NativeEvidenceTable[]
  associations: { caption?: NativeEvidenceCaption }[]
} => {
  const grid = [
    ['Parameter', 'Value'],
    ...['Alpha', 'Beta', 'Gamma', 'Delta'].map((s, n) => [s, String(n + 1)])
  ]
  const items = grid.flatMap((row, r) =>
    row.map((text, c) => token(text, c ? 80 : 2, r ? 36 + r * 16 : 35, c ? 10 : 44))
  )
  const cells = items.map((i, n) => ({
    row: Math.floor(n / 2),
    column: n % 2,
    sourceRects: [i.rect]
  }))
  const whole = {
    grid,
    cells,
    cropRect: [0, 30, 120, 120],
    unassigned: [] as string[],
    clipped: [] as string[],
    sourceViewport: { scale: 1 }
  }
  return {
    tables: [
      { ...whole, grid: grid.slice(0, 3), cells: cells.slice(0, 6), cropRect: [0, 30, 120, 80] },
      whole
    ],
    associations: [
      {},
      { caption: { lines: ['Table 1: Anonymous measurements.'], rect: [0, 8, 120, 20] } }
    ] as { caption?: { lines: string[]; rect: number[] } }[],
    items,
    rules: [
      [0, 30, 120, 30],
      [0, 48, 120, 48],
      [0, 80, 120, 80],
      [0, 120, 120, 120]
    ]
  }
}

const crossForeignNativeTables = (): ReturnType<typeof containedNativeSection> => {
  const items: NativeToken[] = [],
    rules: number[][] = [],
    tables: NativeEvidenceTable[] = [],
    associations: { caption?: NativeEvidenceCaption }[] = []
  for (const [n, x, y] of [
    [0, 0, 30],
    [1, 0, 150],
    [2, 60, 280]
  ]) {
    const grid = [
      ['Label', 'Value'],
      ...['Alpha', 'Beta', 'Gamma'].map((text, r) => [text, `${n * 3 + r + 1}`])
    ]
    const source = grid.flatMap((row, r) =>
      row.map((text, c) =>
        token(text, x + (c ? 80 : 2), y + (r ? 25 + (r - 1) * 20 : 5), c ? 24 : 44)
      )
    )
    const caption = {
      page: 1,
      lines: [`Table ${n + 1}: Anonymous records.`],
      rect: [x, y - 22, x + 120, y - 12]
    }
    items.push(...source, token(caption.lines[0], x, y - 22, 120))
    rules.push([x, y, x + 120, y], [x, y + 18, x + 120, y + 18], [x, y + 80, x + 120, y + 80])
    tables.push({
      cropRect: [x, y, x + 120, y + 80],
      sourceViewport: { scale: 1 },
      grid,
      cells: source.map((item, i) => ({
        row: Math.floor(i / 2),
        column: i % 2,
        text: item.text,
        rowSpan: 1,
        colSpan: 1,
        rect: [...item.rect],
        sourceRects: [[...item.rect]]
      })),
      unassigned: [],
      clipped: []
    })
    associations.push({ caption })
  }
  const source = [...tables[1].cells.filter((cell) => cell.column === 1), ...tables[2].cells]
  tables.push({
    cropRect: [60, 150, 180, 360],
    sourceViewport: { scale: 1 },
    grid: Array.from({ length: 6 }, (_, r) =>
      source.slice(r * 2, r * 2 + 2).map((cell) => cell.text!)
    ),
    cells: source.map((cell, i) => ({
      ...structuredClone(cell),
      row: Math.floor(i / 2),
      column: i % 2
    })),
    unassigned: ['Unmapped fragment'],
    clipped: ['Sliced font']
  })
  tables[3].cells[0].sourceRects[0][2] -= 1
  associations.push(structuredClone(associations[0]))
  return { tables, associations, items, rules }
}

const wrappedNativeTitle = (): NativeEvidenceFixture & {
  table: NativeEvidenceTable
  tables: NativeEvidenceTable[]
  captions: NativeEvidenceCaption[]
  complete: NativeEvidenceCaption
  page: {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
  }
} => {
  const f = containedNativeSection()
  const shift = (rect: number[]): number[] => rect.map((value, axis) => value + (axis % 2 ? 90 : 0))
  const table = structuredClone(f.tables[1])
  table.cropRect = shift(table.cropRect)
  for (const cell of table.cells) cell.sourceRects = cell.sourceRects.map(shift)
  const body = f.items.map((item) => ({
    ...item,
    rect: shift(item.rect),
    baseline: item.baseline + 90
  }))
  for (const [index, item] of body.entries())
    if (index % 2) {
      item.rect[0] += 20
      item.rect[2] += 20
      table.cells[index].sourceRects = [[...item.rect]]
    }
  const lines = [
    'Table A.3: An independently printed source caption con-',
    'tinues across its complete native paragraph without losing text.',
    'Each source record belongs to the independently closed frame.',
    'Measured fields retain their own source boxes and printed values.',
    'The complete description ends at this literal sentence.'
  ]
  const title = lines.map((text, row) => token(text, -40, 20 + row * 16, row === 4 ? 180 : 200))
  const caption = { page: 1, lines: lines.slice(0, 1), rect: [...title[0].rect] }
  const complete = { page: 1, lines, rect: [-40, 20, 160, 94] }
  const items = [...title, ...body]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: items.map((item) => ({
      text: item.text,
      x: item.rect[0],
      y: item.rect[1],
      width: item.rect[2] - item.rect[0],
      height: item.height,
      fontSize: item.height
    }))
  }
  return {
    table,
    items,
    rules: f.rules.map(shift),
    page,
    captions: [caption],
    tables: [table],
    complete
  }
}

it('recovers the complete native hyphenated title paragraph above its independently closed table', () => {
  const f = wrappedNativeTitle(),
    before = structuredClone(f)
  expect(
    recoverNativeCenteredTableCaption(f.table, f.items, f.rules, f.page, f.captions, f.tables)
  ).toEqual(f.complete)
  expect(f).toEqual(before)
})

it('recovers an unfinished three-line native title without interpreting its prose', () => {
  const f = wrappedNativeTitle()
  const lines = [
    'Table A.3: An independently printed caption describes the',
    'complete native source records and their measured fields.',
    'All records remain together.'
  ]
  f.items[0].text = f.captions[0].lines[0] = lines[0]
  f.items[1].text = lines[1]
  f.items[2].text = lines[2]
  f.items.splice(3, 2)
  const shift = (rect: number[]): number[] => rect.map((value, axis) => value - (axis % 2 ? 32 : 0))
  f.table.cropRect = shift(f.table.cropRect)
  for (const cell of f.table.cells) cell.sourceRects = cell.sourceRects.map(shift)
  for (const item of f.items.slice(3)) {
    item.rect = shift(item.rect)
    item.baseline -= 32
  }
  f.rules = f.rules.map(shift)
  const expected = { page: 1, lines, rect: [-40, 20, 160, 62] }
  expect(
    recoverNativeCenteredTableCaption(f.table, f.items, f.rules, f.page, f.captions, f.tables)
  ).toEqual(expected)
})

it.each([
  'closing',
  'leading',
  'font',
  'foreign-ink',
  'caption',
  'complete-source',
  'terminal',
  'opening-corridor'
])('does not extend a native title paragraph without its %s witness', (missing) => {
  const f = wrappedNativeTitle()
  if (missing === 'closing') f.rules.pop()
  if (missing === 'leading') {
    f.items[2].rect[1] += 4
    f.items[2].rect[3] += 4
    f.items[2].baseline += 4
  }
  if (missing === 'font') f.items[2].height -= 2
  if (missing === 'foreign-ink') f.items.push(token('Unowned crossing text', 110, 100, 30))
  if (missing === 'caption') f.captions.push(structuredClone(f.captions[0]))
  if (missing === 'complete-source') f.items.pop()
  if (missing === 'terminal') f.items[4].text = f.items[4].text.slice(0, -1)
  if (missing === 'opening-corridor') f.rules.push([-40, 105, 160, 105])
  expect(
    recoverNativeCenteredTableCaption(f.table, f.items, f.rules, f.page, f.captions, f.tables)
  ).toBeUndefined()
})

const captionPollutedNativeSection = (): ReturnType<typeof wrappedNativeTitle> & {
  associations: { caption: NativeEvidenceCaption }[]
} => {
  const f = wrappedNativeTitle()
  const source = [...f.items.slice(1, 5), ...f.items.slice(5, 9)]
  const partial = {
    ...structuredClone(f.table),
    cropRect: [0, 32, 120, 165],
    grid: source.map((item) => [item.text, '']),
    cells: source.map((item, row) => ({ row, column: 0, sourceRects: [[...item.rect]] })),
    unassigned: ['Clipped title fragment'],
    clipped: ['Clipped caption box']
  }
  return {
    ...f,
    tables: [f.table, partial],
    associations: [{ caption: f.complete }, { caption: f.captions[0] }]
  }
}

it('suppresses only the partial aggregate whose ink belongs to a complete native table and its full title', () => {
  const f = captionPollutedNativeSection(),
    before = structuredClone(f)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([1])
  expect(f).toEqual(before)
  expect([
    ...nativeSourceDuplicateTableIndices(
      [...f.tables].reverse(),
      [...f.associations].reverse(),
      [...f.items].reverse(),
      [...f.rules].reverse()
    )
  ]).toEqual([0])
})

it.each([
  'full-title',
  'closing',
  'source-font',
  'source-box',
  'foreign-ink',
  'caption-literal',
  'caption-box',
  'ambiguous-owner',
  'complete-frame',
  'invalid-font-box'
])('retains a caption-overlapping partial grid without exact %s ownership', (missing) => {
  const f = captionPollutedNativeSection()
  if (missing === 'full-title') f.associations[0].caption = structuredClone(f.captions[0])
  if (missing === 'closing') f.rules.pop()
  if (missing === 'source-font') f.items[2].height -= 2
  if (missing === 'source-box') f.tables[1].cells[0].sourceRects.push([30, 102, 40, 112])
  if (missing === 'foreign-ink') f.items.push(token('Independent native ink', 30, 102, 40))
  if (missing === 'caption-literal') f.associations[1].caption.lines[0] += ' Other.'
  if (missing === 'caption-box') f.associations[1].caption.rect[2] -= 5
  if (missing === 'ambiguous-owner') {
    f.tables.push(structuredClone(f.table))
    f.associations.push(structuredClone(f.associations[0]))
  }
  if (missing === 'complete-frame') f.tables[1].cropRect[3] = f.table.cropRect[3]
  if (missing === 'invalid-font-box')
    f.items.push({ ...token('Unmeasured glyph', 30, 102, 40), rect: [NaN, 102, 70, 112] })
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([])
})

it.each([0.73, 1.5, 2])(
  'keeps caption and body ownership in native coordinates at viewport scale %s',
  (scale) => {
    const f = captionPollutedNativeSection()
    for (const table of f.tables) table.sourceViewport.scale = scale
    for (const association of f.associations)
      association.caption.rect = association.caption.rect.map((value) => value / scale)
    expect([
      ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
    ]).toEqual([1])
  }
)

it('suppresses a foreign-source aggregate only when two independently titled closed bodies own all its native ink', () => {
  const f = crossForeignNativeTables(),
    before = structuredClone(f)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([3])
  expect(f).toEqual(before)
  expect([
    ...nativeSourceDuplicateTableIndices(
      [...f.tables].reverse(),
      [...f.associations].reverse(),
      [...f.items].reverse(),
      [...f.rules].reverse()
    )
  ]).toEqual([0])
})

it.each([1, 1.5, 2])(
  'uses native source coordinates for aggregate ownership at viewport scale %s',
  (scale) => {
    const f = crossForeignNativeTables()
    const translated = (rect: number[]): number[] =>
      rect.map((value, axis) => value + (axis % 2 ? 9 : 17))
    for (const item of f.items) {
      item.rect = translated(item.rect)
      item.baseline += 9
    }
    f.rules = f.rules.map(translated)
    for (const table of f.tables) {
      table.sourceViewport.scale = scale
      table.cropRect = translated(table.cropRect)
      for (const cell of table.cells) {
        cell.rect = translated(cell.rect!)
        cell.sourceRects = cell.sourceRects.map(translated)
      }
    }
    for (const association of f.associations)
      association.caption!.rect = translated(association.caption!.rect).map(
        (value) => value / scale
      )
    expect([
      ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
    ]).toEqual([3])
  }
)

it.each([
  'title-owner',
  'opening',
  'closing',
  'caption-font',
  'caption-literal',
  'body-font',
  'foreign-ink',
  'unmeasured-native-font',
  'source-box',
  'caption',
  'ambiguous-title-owner',
  'ambiguous-body-owner',
  'shared-caption'
])('retains a multi-body candidate without its independent source witness: %s', (missing) => {
  const f = crossForeignNativeTables()
  if (missing === 'title-owner') {
    f.tables.splice(0, 1)
    f.associations.splice(0, 1)
  }
  if (missing === 'opening') f.rules = f.rules.filter((rule) => rule[1] !== 280)
  if (missing === 'closing') f.rules = f.rules.filter((rule) => rule[1] !== 360)
  if (missing === 'caption-font') f.items.push(structuredClone(f.items.at(-1)!))
  if (missing === 'caption-literal') f.associations[2].caption!.lines[0] += ' More.'
  if (missing === 'body-font') f.items.push(structuredClone(f.items.at(-2)!))
  if (missing === 'foreign-ink') f.items.push(token('Independent prose', 70, 240, 80))
  if (missing === 'unmeasured-native-font')
    f.items.push({ ...token('Unmeasured glyphs', 70, 240, 80), rect: [NaN, 240, 150, 250] })
  if (missing === 'source-box') f.tables[3].cells[0].sourceRects.push([70, 240, 150, 250])
  if (missing === 'caption') delete f.associations[3].caption
  if (missing === 'ambiguous-title-owner') {
    f.tables.push(structuredClone(f.tables[0]))
    f.associations.push(structuredClone(f.associations[0]))
  }
  if (missing === 'ambiguous-body-owner') {
    f.tables.push(structuredClone(f.tables[2]))
    f.associations.push(structuredClone(f.associations[2]))
  }
  if (missing === 'shared-caption')
    f.associations[2].caption = structuredClone(f.associations[3].caption)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([])
})

it('suppresses only the exact native upper-section subset of a complete captioned body', () => {
  const f = containedNativeSection(),
    before = structuredClone(f)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([0])
  expect(f).toEqual(before)
  expect([
    ...nativeSourceDuplicateTableIndices(
      [...f.tables].reverse(),
      [...f.associations].reverse(),
      [...f.items].reverse(),
      [...f.rules].reverse()
    )
  ]).toEqual([1])
})

it.each([
  'different-source',
  'caption',
  'unassigned',
  'duplicate-owner',
  'foreign-native',
  'opening',
  'closing'
])('preserves a candidate without exact-source duplicate proof: %s', (missing) => {
  const f = containedNativeSection()
  if (missing === 'different-source')
    f.tables[0].cells = f.tables[0].cells.map((c) => ({
      ...c,
      sourceRects: c.sourceRects.map((r) => r.map((v, n) => (n % 2 ? v : v + 1)))
    }))
  if (missing === 'caption')
    f.associations[0].caption = { lines: ['Table 2: Separate panel.'], rect: [0, 8, 120, 20] }
  if (missing === 'unassigned') f.tables[0].unassigned = ['An independently owned label']
  if (missing === 'duplicate-owner') f.tables[1].cells.push(structuredClone(f.tables[1].cells[0]))
  if (missing === 'foreign-native') f.items.push(token('Foreign ink', 100, 85, 10))
  if (missing === 'opening') f.rules.shift()
  if (missing === 'closing') f.rules.pop()
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([])
})

const nativeContactPanel = (): NativeEvidenceFixture & {
  table: { cropRect: number[]; grid: string[][] }
  page: number
  caption?: NativeEvidenceCaption
} => {
  const items = [120, 320, 520].flatMap((x, n) => [
    token(['Ada Scholar', 'Ben Researcher', 'Cara Analyst'][n], x - 40, 30, 80),
    token('ABC', x - 15, 42, 30),
    token(['one@example.org', 'two@example.org', 'three@example.org'][n], x - 60, 54, 120)
  ])
  items.push(token('Abstract', 280, 105, 80, 12))
  const table = {
    cropRect: [0, 20, 640, 130],
    grid: [Array(3).fill('author'), Array(3).fill('contact')]
  }
  return {
    table,
    items,
    rules: [] as number[][],
    page: 1,
    caption: undefined as NativeEvidenceCaption | undefined
  }
}

it('rejects a first-page native three-lane contact panel with an independent abstract heading', () => {
  const f = nativeContactPanel()
  expect(isNativeRepeatedAuthorContactPanel(f.table, f.items, f.page, f.caption, f.rules)).toBe(
    true
  )
  expect(
    isNativeRepeatedAuthorContactPanel(f.table, [...f.items].reverse(), f.page, f.caption, f.rules)
  ).toBe(true)
  f.items.push(token('∗', f.items[0].rect[2], 28, 3, 7))
  expect(isNativeRepeatedAuthorContactPanel(f.table, f.items, f.page, f.caption, f.rules)).toBe(
    true
  )
})

it.each([
  'later-page',
  'caption',
  'missing-abstract',
  'missing-email',
  'missing-name',
  'foreign-ink',
  'column-centre',
  'row-spacing',
  'ordinary-abstract-font',
  'clipped-source',
  'clipped-font-top',
  'native-rule',
  'duplicate-contact'
])('keeps incomplete contact-panel evidence eligible: %s', (difference) => {
  const f = nativeContactPanel()
  if (difference === 'later-page') f.page = 2
  if (difference === 'caption') f.caption = { lines: ['Table 1: contacts'], rect: [0, 0, 200, 15] }
  if (difference === 'missing-abstract') f.items.pop()
  if (difference === 'missing-email') f.items.splice(2, 1)
  if (difference === 'missing-name') f.items.splice(0, 1)
  if (difference === 'foreign-ink') f.items.push(token('Independent record', 10, 80, 100))
  if (difference === 'column-centre') {
    f.items[1].rect[0] += 10
    f.items[1].rect[2] += 10
  }
  if (difference === 'row-spacing') {
    f.items[1].rect[1] += 2
    f.items[1].rect[3] += 2
    f.items[1].baseline += 2
  }
  if (difference === 'ordinary-abstract-font') f.items.at(-1)!.height = 10
  if (difference === 'clipped-source') f.table.cropRect[0] = 65
  if (difference === 'clipped-font-top') f.table.cropRect[1] = 31
  if (difference === 'native-rule') f.rules.push([0, 28, 640, 28])
  if (difference === 'duplicate-contact') f.items.push(structuredClone(f.items[2]))
  expect(isNativeRepeatedAuthorContactPanel(f.table, f.items, f.page, f.caption, f.rules)).toBe(
    false
  )
})

const completeNativeClone = (): ReturnType<typeof containedNativeSection> => {
  const f = containedNativeSection()
  const complete = f.tables[1]
  for (const cell of complete.cells)
    Object.assign(cell, {
      text: complete.grid[cell.row][cell.column],
      rowSpan: 1,
      colSpan: 1,
      rect: [...cell.sourceRects[0]]
    })
  f.tables = [structuredClone(complete), complete]
  return f
}

it('suppresses an exact complete captionless clone only inside its independently owned frame', () => {
  const f = completeNativeClone(),
    before = structuredClone(f)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([0])
  expect(f).toEqual(before)
  expect([
    ...nativeSourceDuplicateTableIndices(
      [...f.tables].reverse(),
      [...f.associations].reverse(),
      [...f.items].reverse(),
      [...f.rules].reverse()
    )
  ]).toEqual([1])
})

it.each([
  'literal-grid',
  'literal-cell',
  'cell-span',
  'crop',
  'source-owner',
  'caption',
  'unassigned',
  'clipped',
  'foreign-native',
  'opening',
  'closing'
])('retains a full candidate without complete clone equivalence: %s', (difference) => {
  const f = completeNativeClone()
  if (difference === 'literal-grid') f.tables[0].grid[1][1] = 'A different literal'
  if (difference === 'literal-cell') Object.assign(f.tables[0].cells[2], { text: 'Other' })
  if (difference === 'cell-span') Object.assign(f.tables[0].cells[0], { colSpan: 2 })
  if (difference === 'crop') f.tables[0].cropRect[0] -= 1
  if (difference === 'source-owner') f.tables[0].cells[0].sourceRects[0][0] += 1
  if (difference === 'caption')
    f.associations[0].caption = { lines: ['Table 2: Separate panel.'], rect: [0, 8, 120, 20] }
  if (difference === 'unassigned') f.tables[0].unassigned = ['Unowned source']
  if (difference === 'clipped') f.tables[0].clipped = ['Clipped source']
  if (difference === 'foreign-native') f.items.push(token('Independent ink', 100, 85, 10))
  if (difference === 'opening') f.rules.shift()
  if (difference === 'closing') f.rules.pop()
  const before = structuredClone(f)
  expect([
    ...nativeSourceDuplicateTableIndices(f.tables, f.associations, f.items, f.rules)
  ]).toEqual([])
  expect(f).toEqual(before)
})

const centeredNativeTitle = (): NativeEvidenceFixture & {
  table: NativeEvidenceTable
  tables: NativeEvidenceTable[]
  captions: NativeEvidenceCaption[]
  page: {
    pageNumber: number
    width: number
    height: number
    lines: {
      text: string
      x: number
      y: number
      width: number
      height: number
      fontSize: number
    }[]
  }
} => {
  const f = containedNativeSection()
  const shift = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 80 : 200))
  const table = structuredClone(f.tables[1])
  table.cropRect = shift(table.cropRect)
  for (const cell of table.cells) cell.sourceRects = cell.sourceRects.map(shift)
  const items = f.items.map((i) => ({ ...i, rect: shift(i.rect), baseline: i.baseline + 80 }))
  for (const [n, item] of items.entries())
    if (n % 2) {
      item.rect[0] += 25
      item.rect[2] += 25
      table.cells[n].sourceRects = [item.rect]
    }
  const caption = {
    page: 1,
    lines: ['Table 2 | Independent comparison settings.'],
    rect: [60, 86, 250, 96]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: caption.lines[0], x: 60, y: 86, width: 190, height: 10, fontSize: 10 },
      ...[0, 1, 2].map((n) => ({
        text: 'An independent paragraph describes ordinary source records within the same printed column.',
        x: 60,
        y: 214 + n * 14,
        width: 400,
        height: 10,
        fontSize: 10
      }))
    ]
  }
  return { table, items, rules: f.rules.map(shift), page, captions: [caption], tables: [table] }
}

it('recovers a left-column title only for a complete native table centered in that same column', () => {
  const f = centeredNativeTitle(),
    before = structuredClone(f)
  expect(
    recoverNativeCenteredTableCaption(f.table, f.items, f.rules, f.page, f.captions, f.tables)
  ).toBe(f.captions[0])
  expect(f).toEqual(before)
})

it.each([
  'column',
  'alignment',
  'peer',
  'overlapping-peers',
  'frame',
  'source',
  'caption',
  'table',
  'corridor',
  'crossing-opening-corridor',
  'gap',
  'unassigned'
])('does not borrow a left-column title without independent %s proof', (missing) => {
  const f = centeredNativeTitle()
  if (missing === 'column') for (const l of f.page.lines.slice(1)) l.width -= 70
  if (missing === 'alignment') for (const l of f.page.lines.slice(1)) l.x += 5
  if (missing === 'peer') f.page.lines.pop()
  if (missing === 'overlapping-peers')
    for (const [n, l] of f.page.lines.slice(1).entries()) l.y = 214 + n * 0.1
  if (missing === 'frame') f.rules.shift()
  if (missing === 'source') f.items.push(token('Foreign native ink', 300, 170, 10))
  if (missing === 'caption') f.captions.push(structuredClone(f.captions[0]))
  if (missing === 'table') f.tables.push(structuredClone(f.table))
  if (missing === 'corridor')
    f.page.lines.push({
      text: 'Intervening text',
      x: 100,
      y: 99,
      width: 120,
      height: 10,
      fontSize: 10
    })
  if (missing === 'crossing-opening-corridor') {
    f.page.lines.push({
      text: 'Independent column text',
      x: 100,
      y: 106,
      width: 70,
      height: 10,
      fontSize: 10
    })
    f.items.push(token('Independent column text', 100, 106, 70))
  }
  if (missing === 'gap') {
    f.captions[0].rect[1] -= 30
    f.captions[0].rect[3] -= 30
    f.page.lines[0].y -= 30
  }
  if (missing === 'unassigned') f.table.unassigned.push('An independently unowned field')
  expect(
    recoverNativeCenteredTableCaption(f.table, f.items, f.rules, f.page, f.captions, f.tables)
  ).toBeUndefined()
})
