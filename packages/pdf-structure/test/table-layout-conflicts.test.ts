import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { reviewFinalNativeTableSources } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { nativeTableLayoutConflicts: conflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function detachedScientificScript() {
  const f = fixture()
  for (let row = 1; row <= 3; row++)
    f.add(row, 1, [
      ...((row % 2
        ? [
            ['2', 40, 20 + row * 20, 6, 10],
            ['×', 50, 20 + row * 20, 6, 10]
          ]
        : []) as [string, number, number, number, number][]),
      ['10', 60, 20 + row * 20, 12, 10],
      [String(row), 72, 16.4 + row * 20, 4, 7.3]
    ])
  const base = f.add(4, 1, [['10', 60, 100, 12, 10]])
  f.cells.pop()
  const script = f.add(4, 1, [['4', 72, 96.4, 4, 7.3]])
  f.cells.pop()
  const target = f.cells.at(-1)!
  target.text += ' 4'
  target.sourceItems.push(...script.sourceItems)
  target.sourceRects.push(...script.sourceRects)
  for (const font of f.tokens) Object.assign(font, { fontAscent: 0.8, fontDescent: -0.2 })
  for (const font of f.tokens.filter((t) => t.text === '×'))
    Object.assign(font, { fontAscent: 0.75, fontDescent: -0.25 })
  return { ...f, base, script, target, table: { ...f.table(), page: 1, unassigned: ['10'] } }
}

it('rejects a preceding record that owns the next native scientific exponent', () => {
  const f = detachedScientificScript()
  expect(conflicts(f.table, f.tokens, [])).toContain('native-script-crosses-record-owner')
  const checked = reviewFinalNativeTableSources(f.table, f.tokens, [])
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect(checked.cells).toBe(f.cells)
  expect(checked.cropRect).toBe(f.table.cropRect)
})

it.each([
  'missing base',
  'base already owned',
  'duplicate source',
  'source literal mismatch',
  'intervening source',
  'non-horizontal source',
  'different font metrics',
  'missing font metrics',
  'different page',
  'detached geometry',
  'ordinary font size',
  'subscript',
  'irregular record spacing',
  'only one independent record',
  'different numeric lane',
  'explicit spanning cell',
  'measured source partition',
  'unassigned absent',
  'non-scientific base'
])('does not infer a detached exponent contradiction with %s', (mode) => {
  const f = detachedScientificScript(),
    base = f.tokens.find((t) => t.sourceItem === f.base.sourceItems[0])!,
    script = f.tokens.find((t) => t.sourceItem === f.script.sourceItems[0])!
  if (mode === 'missing base') f.tokens.splice(f.tokens.indexOf(base), 1)
  if (mode === 'base already owned') f.cells.push(f.base)
  if (mode === 'duplicate source') f.tokens.push(structuredClone(base))
  if (mode === 'source literal mismatch') base.sourceItem.text = 'another'
  if (mode === 'intervening source') {
    script.sourceItem.index++
    f.tokens.push({
      ...base,
      text: 'x',
      sourceItem: { pageNumber: 1, index: script.sourceItem.index - 1, text: 'x' }
    })
  }
  if (mode === 'non-horizontal source') base.horizontal = false
  if (mode === 'different font metrics') Object.assign(script, { fontAscent: 0.9 })
  if (mode === 'missing font metrics') Object.assign(base, { fontDescent: undefined })
  if (mode === 'different page') base.sourceItem.pageNumber = 2
  if (mode === 'detached geometry') base.rect[2] -= 3
  if (mode === 'ordinary font size') script.height = 10
  if (mode === 'subscript') {
    script.baseline += 8
    script.rect[1] += 8
    script.rect[3] += 8
  }
  if (mode === 'irregular record spacing') {
    base.baseline += 8
    base.rect[1] += 8
    base.rect[3] += 8
  }
  if (mode === 'only one independent record') f.cells.shift()
  if (mode === 'different numeric lane') f.cells[0].column = 2
  if (mode === 'explicit spanning cell') f.target.rowSpan = 2
  if (mode === 'measured source partition')
    f.target.sourceSegments = [{ ...script.sourceItem, start: 0, end: 1, rect: script.rect }]
  if (mode === 'unassigned absent') f.table.unassigned = []
  if (mode === 'non-scientific base') {
    base.text = '12'
    base.sourceItem.text = '12'
    f.table.unassigned = ['12']
  }
  expect(conflicts(f.table, f.tokens, [])).not.toContain('native-script-crosses-record-owner')
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  type Source = { pageNumber: number; index: number; text: string }
  type Font = {
    text: string
    horizontal: boolean
    height: number
    baseline: number
    rect: number[]
    sourceItem: Source
  }
  type Cell = {
    row: number
    column: number
    rowSpan: number
    colSpan: number
    text: string
    sourceItems: Source[]
    sourceRects: number[][]
    sourceSegments?: (Source & { start: number; end: number; rect: number[] })[]
  }
  const tokens: Font[] = [],
    cells: Cell[] = []
  const add = (
    row: number,
    column: number,
    runs: [string, number, number, number?, number?][],
    colSpan = 1
  ): Cell => {
    const fonts = runs.map(([text, x, y, width = 20, height = 10]) => {
      const f = {
        text,
        horizontal: true,
        height,
        baseline: y,
        rect: [x, y - height, x + width, y],
        sourceItem: { pageNumber: 1, index: tokens.length, text }
      }
      tokens.push(f)
      return f
    })
    const cell = {
      row,
      column,
      rowSpan: 1,
      colSpan,
      text: fonts.map((f) => f.text).join(' '),
      sourceItems: fonts.map((f) => f.sourceItem),
      sourceRects: fonts.map((f) => f.rect)
    }
    cells.push(cell)
    return cell
  }
  return {
    tokens,
    cells,
    add,
    table: () => ({
      cropRect: [0, 0, 400, 400],
      grid: Array.from({ length: 8 }, () => Array(8).fill('')),
      cells
    })
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function topAnchoredOrdinalRecords() {
  const f = fixture()
  f.add(0, 0, [['vi.', 20, 20, 10]])
  f.cells.pop()
  f.add(0, 1, [['A complete prior record starts here', 50, 20, 160]])
  f.cells.pop()
  const preceding = f.add(0, 1, [['The same record continues here', 50, 32, 160]])
  const tail = f.add(1, 1, [['The prior record ends here.', 50, 44, 160]])
  f.cells.pop()
  f.add(0, 0, [])
  for (const [row, marker] of ['vii.', 'viii.', 'ix.'].entries()) {
    const y = 56 + row * 36
    f.add(row + 1, 0, [[marker, 20, y, 10]])
    const body = f.add(row + 1, 1, [
      ['An independent record starts here', 50, y, 160],
      ['This record has another full line', 50, y + 12, 160],
      ['Its complete final line ends here.', 50, y + 24, 160]
    ])
    if (row === 0) {
      body.sourceItems.unshift(...tail.sourceItems)
      body.sourceRects.unshift(...tail.sourceRects)
      body.text = tail.text + ' ' + body.text
    }
  }
  const content = {
    items: f.tokens.map((t) => ({
      str: t.text,
      dir: 'ltr',
      width: t.rect[2] - t.rect[0],
      height: t.height,
      transform: [t.height, 0, 0, t.height, t.rect[0], 200 - t.baseline],
      fontName: 'native'
    })),
    styles: { native: { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  return {
    ...f,
    preceding,
    tail,
    context: { sourceContent: content, viewport: { transform: [1, 0, 0, -1, 0, 200] } },
    table: {
      ...f.table(),
      page: 1,
      grid: Array.from({ length: 4 }, () => ['', '']),
      unassigned: ['vi.', 'A complete prior record starts here'],
      issues: [],
      reviewCandidate: true
    }
  }
}

it.each(['crossed tail', 'correct owner', 'centered marker'])(
  'checks a complete top-anchored native ordinal packet with %s',
  (mode) => {
    const f = topAnchoredOrdinalRecords(),
      body = f.cells.find((c) => c.row === 1 && c.column === 1)!
    if (mode === 'correct owner') {
      f.preceding.sourceItems.push(...f.tail.sourceItems)
      f.preceding.sourceRects.push(...f.tail.sourceRects)
      f.preceding.text += ' ' + f.tail.text
      body.sourceItems.shift()
      body.sourceRects.shift()
      body.text = body.text.slice(f.tail.text.length + 1)
    }
    if (mode === 'centered marker') {
      const marker = f.tokens.find((t) => t.text === 'vii.')!
      marker.baseline += 6
      marker.rect[1] += 6
      marker.rect[3] += 6
      f.context.sourceContent.items[marker.sourceItem.index].transform[5] -= 6
    }
    const before = structuredClone(f.table),
      found = conflicts(f.table, f.tokens, [], [], f.context)
    if (mode === 'crossed tail') {
      expect(found).toContain('native-ordinal-record-tail-crosses-row')
      const checked = reviewFinalNativeTableSources(f.table, f.tokens, [], [], f.context)
      expect(checked.issues).toContain('native-table-structure-ambiguous')
      expect(checked.reviewCandidate).toBe(false)
      expect(checked.cells).toBe(f.table.cells)
      expect(checked.cropRect).toBe(f.table.cropRect)
    } else expect(found).not.toContain('native-ordinal-record-tail-crosses-row')
    expect(f.table).toEqual(before)
  }
)

// Native ownership witnesses are anonymous and do not propose replacement cells.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function residualNativeOwnership(kind: string) {
  const f = fixture()
  const rules: number[][] = []
  let tag = ''
  if (kind === 'crossed dividers') {
    tag = 'native-dividers-cross-leaf-record'
    for (const row of [1, 2])
      for (const column of [0, 1])
        f.add(row, column, [
          ['first', 10 + column * 60, row * 50 - 10],
          ['second', 10 + column * 60, row * 50 + 10]
        ])
    for (const y of [50, 100]) rules.push([0, y, 120, y])
  } else if (kind === 'ruled stub') {
    tag = 'native-calibrated-ruled-stub-span'
    for (const group of [0, 1]) {
      const start = 1 + group * 3
      f.add(group ? start : start + 1, 0, [['Group', 10, 50 + group * 80]]).rowSpan = group ? 3 : 1
      for (let row = start; row < start + 3; row++)
        for (const column of [1, 2, 3])
          f.add(row, column, [['12', 10 + column * 60, 30 + group * 80 + (row - start) * 20]])
      for (const y of [15 + group * 80, 85 + group * 80]) rules.push([0, y, 220, y])
    }
  } else if (kind === 'source group') {
    tag = 'native-group-span-crosses-source-block'
    for (const group of [0, 1, 2]) {
      const start = 1 + group * 3
      f.add(start + 1, 0, [['Group', 10, 50 + group * 80]]).rowSpan = 3
      for (let row = start; row < start + 3; row++)
        for (const column of [1, 2, 3])
          f.add(row, column, [['12', 10 + column * 60, 30 + group * 80 + (row - start) * 20]])
    }
  } else if (kind === 'closed leaf') {
    tag = 'native-closed-leaf-face-split'
    for (const column of [0, 1]) {
      f.add(1, column, [
        ['12', 10 + column * 50, 10],
        ['34', 10 + column * 50, 24]
      ])
      f.add(2, column, [['56', 10 + column * 50, 60]])
      f.add(3, column, [['78', 10 + column * 50, 74]])
    }
    for (const y of [0, 30, 50, 80]) rules.push([0, y, 100, y])
    for (const x of [0, 50, 100])
      for (const [top, bottom] of [
        [0, 30],
        [50, 80]
      ])
        rules.push([x, top, x, bottom])
  } else if (kind === 'empty leaf') {
    tag = 'native-run-crosses-empty-leaf'
    f.add(1, 0, [['Method', 10, 30]])
    f.add(1, 1, [['Count', 60, 30]])
    f.add(1, 2, [['Decision', 110, 30]])
    f.add(2, 0, [['Case', 10, 50]])
    f.add(2, 1, [])
    f.add(2, 2, [['100 Ready', 60, 50, 80]])
    for (const row of [3, 4, 5]) {
      f.add(row, 0, [['Case', 10, 10 + row * 20]])
      f.add(row, 1, [['1000', 60, 10 + row * 20]])
      f.add(row, 2, [['Ready', 110, 10 + row * 20]])
    }
    rules.push([0, 40, 160, 40], [0, 130, 160, 130])
  } else {
    tag = 'native-label-source-block-split'
    for (const row of [1, 2]) {
      for (const column of [0, 1, 2]) f.add(row, column, [['Anchor', 10 + column * 60, row * 40]])
      f.add(row, 3, [
        ['First', 210, row * 40 - 10],
        ['Last', 210, row * 40 + 10]
      ])
    }
    for (const column of [0, 1, 2]) f.add(3, column, [['Anchor', 10 + column * 60, 140]])
    f.add(3, 3, [['First', 210, 130]])
    const target = f.add(4, 3, [['Tail', 210, 150]])
    for (const column of [0, 1, 2]) f.add(4, column, [['Anchor', 10 + column * 60, 190]])
    const next = f.add(4, 3, [['Next', 210, 190]])
    f.cells.pop()
    target.text += ' ' + next.text
    target.sourceItems.push(...next.sourceItems)
    target.sourceRects.push(...next.sourceRects)
  }
  for (const font of f.tokens)
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [font.rect[0], font.baseline - 8, font.rect[2], font.baseline + 2]
    })
  return { ...f, rules, tag }
}

it.each([
  'crossed dividers',
  'ruled stub',
  'source group',
  'closed leaf',
  'empty leaf',
  'centered tail'
])('retains a native-proved %s contradiction without replacing source cells', (kind) => {
  const f = residualNativeOwnership(kind)
  expect(conflicts(f.table(), f.tokens, f.rules)).toContain(f.tag)
  const table = f.table()
  const result = reviewFinalNativeTableSources(table, f.tokens, f.rules)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.cells).toBe(table.cells)
  expect(result.grid).toBe(table.grid)
  expect(result.cropRect).toBe(table.cropRect)
})

it.each(
  [
    'crossed dividers',
    'ruled stub',
    'source group',
    'closed leaf',
    'empty leaf',
    'centered tail'
  ].flatMap((kind) =>
    [
      'missing descent',
      kind === 'empty leaf'
        ? 'merged calibration peer'
        : kind === 'ruled stub' || kind === 'source group'
          ? 'duplicate record column'
          : 'foreign source'
    ].map((mode) => ({ kind, mode }))
  )
)('requires complete exclusive native proof for $kind with $mode', ({ kind, mode }) => {
  const f = residualNativeOwnership(kind)
  if (mode === 'missing descent')
    for (const font of f.tokens) Object.assign(font, { fontDescent: undefined })
  else if (mode === 'merged calibration peer')
    for (const cell of f.cells.filter((cell) => cell.row > 2 && cell.column === 2)) cell.rowSpan = 2
  else if (mode === 'duplicate record column')
    for (const cell of f.cells.filter(
      (cell) => cell.column === 3 && (kind === 'source group' || cell.row % 3 === 1)
    ))
      cell.column = 2
  else
    f.tokens.push(
      ...structuredClone(f.tokens).map((font) => ({
        ...font,
        text: 'Foreign',
        sourceItem: { ...font.sourceItem, index: font.sourceItem.index + 1000, text: 'Foreign' }
      }))
    )
  expect(conflicts(f.table(), f.tokens, f.rules)).not.toContain(f.tag)
})

// Anonymous native records exercise contradiction proofs, never replacement grids.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function closedFaces(split = false) {
  const f = fixture()
  for (let row = 1; row <= 3; row++)
    for (let col = 0; col < 3; col++)
      f.add(row, col, [[col ? '12' : 'Label', 10 + col * 60, 5 + row * 30, 20]])
  const unassigned = split ? [] : f.cells.splice(3, 3).map((c) => c.text)
  if (split) for (const col of [1, 2]) f.add(4, col, [['tail', 10 + col * 60, 104, 20]])
  const rules = [20, 50, 80, 110].flatMap((y) => [
    [0, y, 100, y],
    [100, y, 200, y]
  ])
  for (const x of [0, 200]) rules.push([x, 20, x, 110])
  return { ...f, rules, table: { ...f.table(), unassigned } }
}

it.each(['missing record', 'split tail', 'missing fence', 'only one peer'])(
  'checks segmented native faces with %s',
  (mode) => {
    const f = closedFaces(mode === 'split tail')
    if (mode === 'missing fence') f.rules.splice(-1)
    if (mode === 'only one peer') f.cells.splice(-3)
    const tag =
      mode === 'split tail'
        ? 'closed-record-face-split-across-rows'
        : 'unassigned-closed-native-record'
    expect(conflicts(f.table, f.tokens, f.rules).includes(tag)).toBe(
      mode === 'missing record' || mode === 'split tail'
    )
  }
)

it.each(['complete metrics', 'missing metrics', 'missing divider'])(
  'checks a header divider against verified native label metrics: %s',
  (mode) => {
    const f = fixture()
    for (let col = 0; col < 3; col++)
      f.add(0, col, [
        ['Header', 10 + col * 60, 20],
        ['Body', 10 + col * 60, 35]
      ])
    if (mode !== 'missing metrics')
      for (const font of f.tokens)
        Object.assign(font, {
          fontAscent: 0.4,
          nativeLabelRect: [font.rect[0], font.baseline - 4, font.rect[2], font.baseline + 6]
        })
    expect(
      conflicts(f.table(), f.tokens, mode === 'missing divider' ? [] : [[5, 30, 160, 30]]).includes(
        'printed-header-rule-inside-row'
      )
    ).toBe(mode === 'complete metrics')
  }
)

it.each([true, false])(
  'requires complete native stream proof for one displaced stub: %s',
  (valid) => {
    const f = fixture()
    f.add(1, 0, [
      ['Record', 10, 40],
      ['long', 10, 52]
    ])
    f.add(2, 0, [
      ['tail', 10, 64],
      ['Next', 10, 80]
    ])
    for (const row of [1, 2])
      for (const col of [1, 2]) f.add(row, col, [['12', 80 + col * 30, row * 40]])
    const order = [0, 1, 2, 5, 3, 4, 6, 7]
    f.tokens.forEach((font, i) => {
      font.sourceItem.index = order[i]
    })
    if (!valid) f.tokens[2].sourceItem.index = 99
    expect(conflicts(f.table(), f.tokens).includes('stub-continuation-crosses-record-row')).toBe(
      valid
    )
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function labelBlock(span = false) {
  const f = fixture()
  f.add(1, 0, [
    ['Wrapped', 10, 40],
    ['label', 10, 52]
  ])
  f.add(1, 1, [['12', 100, 40]])
  f.add(1, 2, [['13', 150, 40]])
  f.add(2, 0, [['Wrapped', 10, 80]])
  const tail = f.add(3, 0, [['label', 10, 92]], span ? 3 : 1)
  if (!span) f.cells.pop()
  f.add(2, 1, [['14', 100, 80]])
  f.add(2, 2, [['15', 150, 80]])
  return { ...f, tail, table: { ...f.table(), unassigned: span ? [] : ['label'] } }
}

it.each(['unassigned tail', 'split span', 'missing calibration', 'foreign next source'])(
  'requires a closed calibrated native label block: %s',
  (mode) => {
    const f = labelBlock(mode === 'split span')
    if (mode === 'missing calibration') f.cells.splice(0, 3)
    if (mode === 'foreign next source') {
      const index = f.tail.sourceItems[0].index + 1
      for (const font of f.tokens) if (font.sourceItem.index >= index) font.sourceItem.index++
      f.tokens.push({
        ...f.tokens[0],
        text: 'Foreign',
        sourceItem: { pageNumber: 1, index, text: 'Foreign' }
      })
    }
    expect(conflicts(f.table, f.tokens).includes('native-label-source-block-split')).toBe(
      mode === 'unassigned tail' || mode === 'split span'
    )
  }
)

it.each(['empty', 'inside', 'top crossing', 'bottom crossing'])(
  'requires an empty independently headed estimate gutter: %s',
  (foreign) => {
    const f = fixture()
    f.add(0, 0, [
      ['Gain', 80, 20, 20],
      ['Interval', 140, 20, 20]
    ])
    for (let row = 1; row <= 3; row++)
      f.add(row, 0, [
        ['12', 90, 20 + row * 20, 10],
        ['[1, 2]', 120, 20 + row * 20, 40]
      ])
    if (foreign !== 'empty') {
      f.add(7, 7, [
        [
          'Foreign',
          105,
          foreign === 'top crossing' ? 15 : foreign === 'bottom crossing' ? 85 : 50,
          10
        ]
      ])
      f.cells.pop()
    }
    expect(
      conflicts(f.table(), f.tokens, [
        [0, 5, 200, 5],
        [0, 95, 200, 95]
      ]).includes('independently-headed-estimate-interval-lanes')
    ).toBe(foreign === 'empty')
  }
)

it.each(['complete groups', 'missing sibling', 'explicit spans'])(
  'requires independent native parent and child heading groups: %s',
  (mode) => {
    const f = fixture()
    for (const start of [0, 2]) {
      f.add(0, start, [['Left', 10 + start * 50, 40, 20]])
      f.add(0, start + 1, [
        ['Parent', 10 + start * 50, 20, 70],
        ['Right', 60 + start * 50, 40, 20]
      ])
      for (const row of [1, 2])
        for (const col of [start, start + 1])
          f.add(row, col, [['12', 10 + col * 50, 60 + row * 20, 20]])
    }
    if (mode === 'missing sibling') f.cells.splice(0, 1)
    if (mode === 'explicit spans')
      for (const cell of f.cells.filter((c) => c.row === 0)) cell.colSpan = 2
    expect(
      conflicts(f.table(), f.tokens, [[0, 30, 230, 30]]).includes(
        'native-parent-heading-consumed-by-child-leaf'
      )
    ).toBe(mode === 'complete groups')
  }
)

it('rejects a missing native heading between a parent and ruled leaf headers', () => {
  const f = fixture()
  f.add(0, 2, [
    ['Outcome:', 100, 25, 55],
    ['(2)', 120, 55, 15]
  ])
  f.add(0, 1, [['(1)', 60, 55, 15]])
  f.add(0, 3, [['(3)', 180, 55, 15]])
  const missing = f.add(0, 4, [['Measured response', 60, 40, 135]])
  f.cells.pop()
  for (let row = 1; row <= 3; row++)
    for (let col = 1; col <= 3; col++) f.add(row, col, [['1', col * 60, 65 + row * 15]])
  const table = { ...f.table(), unassigned: [missing.text] }
  const rules = [
    [40, 10, 220, 10],
    [40, 60, 220, 60]
  ]
  expect(conflicts(table, f.tokens, rules)).toContain('unassigned-parent-header-band')
  expect(conflicts({ ...table, unassigned: [] }, f.tokens, rules)).not.toContain(
    'unassigned-parent-header-band'
  )
  expect(conflicts(table, f.tokens, [])).not.toContain('unassigned-parent-header-band')
})

it('rejects separately headed numeric lanes collapsed into one leaf column', () => {
  const f = fixture()
  f.add(0, 0, [['Label', 10, 25]])
  f.add(0, 1, [
    ['Mean', 100, 25, 25],
    ['Rate', 165, 25, 25]
  ])
  for (let row = 1; row <= 4; row++) {
    f.add(row, 0, [['Group', 10, 40 + row * 15]])
    f.add(row, 1, [
      ['1.2', 100, 40 + row * 15, 25],
      ['8.4', 165, 40 + row * 15, 25]
    ])
  }
  const rules = [
    [0, 10, 210, 10],
    [0, 35, 210, 35],
    [0, 115, 210, 115]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('independent-numeric-lanes-in-leaf')
  expect(conflicts(f.table(), f.tokens, [])).not.toContain('independent-numeric-lanes-in-leaf')
  f.cells[1].text = 'Mean and rate'
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('independent-numeric-lanes-in-leaf')
})

it('retains an ambiguous centered group value instead of inventing its missing row span', () => {
  const f = fixture()
  f.add(1, 0, [['Class', 10, 70, 25]]).rowSpan = 3
  for (const col of [1, 2])
    for (const row of [1, 2, 3]) f.add(row, col, row === 2 ? [['8', col * 55, 70, 15]] : [])
  for (const row of [1, 2, 3]) f.add(row, 3, [['2', 180, 40 + row * 15, 15]])
  const rules = [
    [0, 40, 220, 40],
    [0, 95, 220, 95]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('centered-shared-value-missing-span')
  expect(conflicts(f.table(), f.tokens, [...rules, [0, 62, 220, 62]])).not.toContain(
    'centered-shared-value-missing-span'
  )
  f.cells.find((c) => c.row === 2 && c.column === 1)!.rowSpan = 3
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('centered-shared-value-missing-span')
})

it('does not map a captionless numbered derivation and its connective prose as table cells', () => {
  const f = fixture()
  f.add(0, 0, [['A = B', 80, 30, 50]])
  f.add(0, 2, [['(Q4)', 250, 30, 25]])
  f.add(1, 0, [['When all conditions hold we obtain', 20, 55, 180]])
  f.add(2, 0, [['B = C', 80, 80, 50]])
  f.add(2, 2, [['(Q5)', 250, 80, 25]])
  const table = {
    ...f.table(),
    grid: [
      ['A = B', '', '(Q4)'],
      ['prose', '', ''],
      ['B = C', '', '(Q5)']
    ]
  }
  expect(conflicts(table, f.tokens, [])).toContain('numbered-derivation-mapped-as-table')
  expect(conflicts({ ...table, caption: { text: 'Table 1' } }, f.tokens, [])).not.toContain(
    'numbered-derivation-mapped-as-table'
  )
  expect(conflicts(table, f.tokens, [[0, 15, 280, 15]])).not.toContain(
    'numbered-derivation-mapped-as-table'
  )
})

it('rejects an unmeasured split that creates an unheaded stub column', () => {
  const f = fixture()
  f.add(0, 0, [['Name', 10, 25, 30]])
  f.add(0, 2, [['Score', 100, 25, 30]])
  f.add(1, 0, [['First kind', 10, 50, 60]])
  f.add(2, 0, [['Other kind', 10, 70, 60]])
  const split = f.add(3, 0, [['Variant 4', 10, 90, 60]])
  const parent = split.sourceItems[0]
  split.text = 'Variant'
  split.sourceRects = [[10, 80, 45, 90]]
  f.cells.push({ ...split, column: 1, text: '4', sourceRects: [[45, 80, 70, 90]] })
  for (let row = 1; row <= 3; row++) f.add(row, 2, [['2', 100, 30 + row * 20, 20]])
  const rules = [
    [0, 10, 140, 10],
    [0, 35, 140, 35],
    [0, 105, 140, 105]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('unmeasured-source-creates-stub-column')
  const changed = structuredClone(f.tokens)
  changed.find((t) => t.sourceItem.index === parent.index)!.sourceItem.text =
    'Different native value'
  expect(conflicts(f.table(), changed, rules)).not.toContain(
    'unmeasured-source-creates-stub-column'
  )
  split.sourceSegments = [{ ...parent, start: 0, end: 7, rect: [10, 80, 45, 90] }]
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'unmeasured-source-creates-stub-column'
  )
})

it('retains original cells but rejects two numeric lanes collapsing independently labelled records', () => {
  const f = fixture()
  for (const row of [1, 2]) {
    const y = 4 + row * 36
    f.add(row, 0, [['Group', 10, y + 6, 25]])
    f.add(row, 1, [
      ['First', 50, y, 25],
      ['Second', 50, y + 12, 25]
    ])
    f.add(row, 2, [
      ['1', 100, y],
      ['2', 100, y + 12]
    ])
    f.add(row, 3, [
      ['3', 150, y],
      ['4', 150, y + 12]
    ])
  }
  const rules = [25, 60, 95].map((y) => [0, y, 180, y])
  const t = f.table(),
    before = structuredClone(t)
  const out = reviewFinalNativeTableSources(t, f.tokens, rules)
  expect(out.issues).toContain('native-table-structure-ambiguous')
  expect(out.cells).toEqual(before.cells)
  expect(out.grid).toEqual(before.grid)
  expect(t).toEqual(before)
  expect(conflicts(t, f.tokens, [])).not.toContain('labelled-numeric-records-collapsed')
  f.cells
    .filter((c) => c.column === 1)
    .forEach((c) => {
      c.rowSpan = 2
    })
  expect(conflicts(t, f.tokens, rules)).not.toContain('labelled-numeric-records-collapsed')
})

it('requires a top group span to contain its two independently ruled child groups', () => {
  const f = fixture()
  f.add(0, 2, [['Combined', 95, 20, 50]])
  f.add(1, 1, [['Left', 50, 40, 25]], 2)
  f.add(1, 3, [['Right', 155, 40, 25]], 2)
  for (const row of [2, 3])
    for (let col = 1; col <= 4; col++)
      f.add(row, col, [[String(col), 20 + col * 40, 40 + row * 20, 10]])
  const rules = [
    [45, 25, 200, 25],
    [45, 45, 115, 45],
    [135, 45, 200, 45]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-parent-group-span')
  expect(conflicts(f.table(), f.tokens, rules.slice(1))).not.toContain('native-parent-group-span')
  f.cells[0].column = 1
  f.cells[0].colSpan = 4
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('native-parent-group-span')
})

it('flags an unassigned unknown native atom closing an owned formula gap without decoding it', () => {
  const f = fixture()
  f.add(1, 1, [
    ['a=', 40, 50, 20],
    ['x', 65, 50, 10]
  ])
  f.tokens[1].sourceItem.index = 2
  f.tokens.push({
    text: '\0',
    sourceItem: { pageNumber: 1, index: 1, text: '\0' },
    rect: [60, 32, 65, 42],
    height: 10,
    baseline: 42,
    horizontal: true
  })
  const t = { ...f.table(), unassigned: ['\0'] }
  expect(conflicts(t, f.tokens, [])).toContain('unassigned-native-formula-atom')
  f.tokens[2].rect = [200, 32, 205, 42]
  expect(conflicts(t, f.tokens, [])).not.toContain('unassigned-native-formula-atom')
})

it.each(['leading', 'trailing'])(
  'rejects a separately headed %s lane merged with prose',
  (side) => {
    const f = fixture(),
      leading = side === 'leading',
      col = leading ? 0 : 7
    f.add(0, col, [
      ['Code', 10, 20, 20],
      ['Description', 60, 20, 60]
    ])
    for (let row = 1; row <= 3; row++) {
      const y = 20 + row * 30
      f.add(
        row,
        col,
        leading
          ? [
              [String(row), 10, y, 10],
              ['Alpha', 60, y, 30],
              ['Beta', 60, y + 12, 30]
            ]
          : [
              ['Alpha', 10, y, 30],
              ['Beta', 10, y + 12, 30],
              ['0', 110, y, 10]
            ]
      )
      f.add(row, leading ? 1 : 6, [['Peer', 200, y, 20]])
    }
    const rules = [[0, 25, 250, 25]]
    expect(conflicts(f.table(), f.tokens, rules)).toContain('independent-headed-native-lane')
    expect(conflicts(f.table(), f.tokens, [])).not.toContain('independent-headed-native-lane')
    f.cells[0].sourceItems = []
    expect(conflicts(f.table(), f.tokens, rules)).not.toContain('independent-headed-native-lane')
  }
)

it('rejects whole adjacent values crossing a repeatedly empty, independently headed column', () => {
  const f = fixture()
  f.add(0, 0, [['Name', 10, 20, 25]])
  f.add(0, 1, [['Count', 70, 20, 25]])
  f.add(0, 2, [['Value', 120, 20, 35]])
  for (let row = 1; row <= 3; row++) {
    f.add(row, 0, [['Row', 10, 20 + row * 20, 25]])
    f.add(row, 1, [])
    f.add(row, 2, [['100 1-9', 65, 20 + row * 20, 90]])
  }
  const rules = [[0, 25, 180, 25]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-run-crosses-empty-leaf')
  f.cells
    .filter((c) => c.row > 0 && c.column === 2)
    .forEach((c) => {
      c.column = 1
      c.colSpan = 2
    })
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('native-run-crosses-empty-leaf')
})

it('rejects a touching mathematical group split between independently labelled header leaves', () => {
  const f = fixture()
  f.add(0, 1, [
    ['10', 80, 20, 12],
    ['A', 70, 40, 10]
  ])
  f.add(0, 2, [
    ['x', 92, 20, 10],
    ['B', 110, 40, 10]
  ])
  for (const row of [1, 2]) {
    f.add(row, 1, [['1', 70, 40 + row * 20, 10]])
    f.add(row, 2, [['2', 110, 40 + row * 20, 10]])
  }
  expect(conflicts(f.table(), f.tokens, [[0, 45, 200, 45]])).toContain('native-math-group-split')
  f.cells[0].colSpan = 2
  expect(conflicts(f.table(), f.tokens, [[0, 45, 200, 45]])).not.toContain(
    'native-math-group-split'
  )
})

it('rejects an unmeasured leaf header crossing independently printed header groups', () => {
  const f = fixture()
  f.add(1, 2, [['One Two Three', 105, 45, 180]])
  for (const row of [2, 3]) {
    f.add(row, 1, [['12', 110, 30 + row * 20]])
    f.add(row, 2, [['34', 180, 30 + row * 20]])
    f.add(row, 3, [['56', 250, 30 + row * 20]])
  }
  const rules = [
    [100, 30, 140, 30],
    [150, 30, 300, 30]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-header-crosses-printed-groups')
  f.cells[0].colSpan = 3
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'native-header-crosses-printed-groups'
  )
})

it('rejects a wide first header represented as a section over independently aligned fields', () => {
  const f = fixture()
  f.add(
    0,
    0,
    [
      ['Field', 10, 20, 30],
      ['Mode Score Count', 90, 20, 210]
    ],
    4
  )
  for (const row of [1, 2]) {
    f.add(row, 0, [['Label', 10, 20 + row * 20, 35]])
    f.add(row, 1, [['yes', 90, 20 + row * 20, 20]])
    f.add(row, 2, [['1.2', 190, 20 + row * 20, 20]])
    f.add(row, 3, [['2.3', 270, 20 + row * 20, 20]])
  }
  expect(conflicts(f.table(), f.tokens, [[0, 25, 320, 25]])).toContain(
    'native-leaf-header-collapsed-to-section'
  )
  f.cells[0].sourceItems = [f.cells[0].sourceItems[0]]
  f.cells[0].sourceRects = [f.cells[0].sourceRects[0]]
  f.cells[0].text = 'Field'
  expect(conflicts(f.table(), f.tokens, [[0, 25, 320, 25]])).not.toContain(
    'native-leaf-header-collapsed-to-section'
  )
})

it('rejects two record rows inside one closed printed face after complete peer faces', () => {
  const f = fixture()
  for (const row of [1, 2, 3])
    for (const col of [0, 1, 2, 3])
      f.add(row, col, [[col < 2 ? 'Key' : 'Long field', 10 + col * 100, 15 + row * 30, 50]])
  f.add(4, 2, [['tail', 210, 115, 25]])
  f.add(4, 3, [['tail', 310, 115, 25]])
  const rules = [30, 60, 90, 120].map((y) => [0, y, 400, y])
  for (const x of [0, 100, 200, 300, 400])
    for (const y of [30, 60, 90]) rules.push([x, y, x, y + 30])
  expect(conflicts(f.table(), f.tokens, rules)).toContain('closed-record-face-split-across-rows')
  rules.push([0, 110, 400, 110])
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'closed-record-face-split-across-rows'
  )
})

it('rejects a centered native multiline stub split into staggered record rows', () => {
  const f = fixture()
  f.add(1, 0, [['Allowed', 10, 60]])
  f.add(2, 0, [['values', 10, 80]])
  for (const col of [1, 2, 3])
    for (const row of [1, 2, 3]) f.add(row, col, [['value', 80 + col * 60, 30 + row * 20]])
  const rules = [[0, 35, 320, 35]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('staggered-native-stub-records')
  for (const p of f.tokens.slice(0, 2)) {
    p.baseline -= 10
    p.rect[1] -= 10
    p.rect[3] -= 10
  }
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('staggered-native-stub-records')
})

it('rejects a clipped native header above three printed column separators without rejecting prose outside them', () => {
  const f = fixture()
  for (const row of [0, 1])
    for (const col of [0, 1, 2]) f.add(row, col, [['12', 20 + col * 100, 60 + row * 25]])
  const heads = [0, 1, 2].map((col) => f.add(7, col, [['Header', 20 + col * 100, 30, 25]]))
  f.cells.splice(6)
  const table = {
    ...f.table(),
    cropRect: [0, 25, 300, 100],
    clipped: heads.map((c) => ({ text: c.text, rect: c.sourceRects[0] }))
  }
  const rules = [0, 1, 2].map((col) => [col * 100, 46, col * 100 + 90, 46])
  expect(conflicts(table, f.tokens, rules)).toContain('clipped-native-header-band')
  expect(
    conflicts({ ...table, clipped: table.clipped.slice(0, 1) }, f.tokens, rules)
  ).not.toContain('clipped-native-header-band')
})
it('rejects a repeated leaf sequence whose peer group spans it but its own group does not', () => {
  const f = fixture()
  f.add(0, 1, [['Group A', 30, 20, 50]])
  f.add(0, 3, [['Group B', 130, 20, 50]], 3)
  for (let col = 0; col < 6; col++)
    f.add(1, col, [[['X', 'Y', 'Z'][col % 3], 10 + col * 30 + (col > 2 ? 10 : 0), 40, 15]])
  expect(conflicts(f.table(), f.tokens)).toContain('inconsistent-grouped-header-span')
  f.cells[0].column = 0
  f.cells[0].colSpan = 3
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('requires identical peer leaf sequence and complete native source ownership', () => {
  const f = fixture()
  f.add(0, 1, [['Group A', 30, 20, 50]])
  f.add(0, 3, [['Group B', 130, 20, 50]], 3)
  for (let col = 0; col < 6; col++)
    f.add(1, col, [
      [['X', 'Y', 'Z', 'U', 'V', 'W'][col], 10 + col * 30 + (col > 2 ? 10 : 0), 40, 15]
    ])
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects a single leaf cell crossing a repeated printed vertical divider', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      [String(row + 1), 10, 30 + row * 20],
      ['value', 70, 30 + row * 20]
    ])
  const rules = [[50, 15, 50, 100]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('printed-divider-inside-leaf-column')
  for (const c of f.cells) c.colSpan = 2
  expect(conflicts(f.table(), f.tokens, rules)).toEqual([])
})
it('does not infer a missing column from spaced values alone or one short divider', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      ['2', 10, 30 + row * 20],
      ['4', 70, 30 + row * 20]
    ])
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  expect(conflicts(f.table(), f.tokens, [[50, 15, 50, 35]])).toEqual([])
})
it('rejects a ruled fraction denominator assigned to the following record', () => {
  const f = fixture()
  f.add(1, 0, [
    ['a', 10, 40, 6, 8],
    ['value', 20, 45, 20, 12]
  ])
  f.add(2, 0, [
    ['3', 10, 50, 6, 8],
    ['next', 10, 70, 20, 12]
  ])
  f.add(2, 1, [['12', 80, 70, 20, 12]])
  f.add(2, 2, [['15', 120, 70, 20, 12]])
  expect(conflicts(f.table(), f.tokens, [[9, 43, 17, 43]])).toContain('fraction-crosses-record-row')
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  expect(conflicts(f.table(), f.tokens, [[0, 43, 180, 43]])).toEqual([])
})
it('rejects a complete horizontal header separator inside first-row cells', () => {
  const f = fixture()
  for (let col = 0; col < 3; col++)
    f.add(0, col, [
      ['Header', 10 + col * 60, 20],
      ['Body', 10 + col * 60, 45]
    ])
  expect(conflicts(f.table(), f.tokens, [[5, 30, 160, 30]])).toContain(
    'printed-header-rule-inside-row'
  )
  expect(conflicts(f.table(), f.tokens, [[5, 30, 40, 30]])).toEqual([])
})
it('rejects two stub continuations preceding independently aligned next records', () => {
  const f = fixture()
  f.add(1, 0, [
    ['Record', 10, 40],
    ['long', 10, 52]
  ])
  const tail1 = f.add(2, 0, [
    ['tail', 10, 64],
    ['Next', 10, 80],
    ['long', 10, 92]
  ])
  const tail2 = f.add(3, 0, [
    ['tail', 10, 104],
    ['Last', 10, 120]
  ])
  for (const row of [1, 2, 3])
    for (const col of [1, 2]) f.add(row, col, [['12', 80 + col * 30, row * 40]])
  const nativeOrder = [0, 1, 2, 5, 6, 7, 10, 3, 4, 8, 9, 11, 12]
  f.tokens.forEach((font, index) => {
    font.sourceItem.index = nativeOrder[index]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('stub-continuation-crosses-record-row')
  const peerSources = f.cells.filter((c) => c.column > 0).flatMap((c) => c.sourceItems)
  peerSources.forEach((o) => {
    o.index += 100
  })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  peerSources.forEach((o) => {
    o.index -= 100
  })
  // Without contiguous native item ordering the geometry alone is not proof.
  tail1.sourceItems[0].index = 100
  tail2.sourceItems[0].index = 101
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects a mixed full-parent and unmeasured partial-parent claim but permits measured segments', () => {
  const f = fixture()
  const a = f.add(0, 0, [
    ['4±', 10, 40],
    ['1 /', 30, 40, 30]
  ])
  a.text = '4±1'
  a.sourceRects[1] = [30, 30, 45, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '/',
    sourceItems: [f.tokens[1].sourceItem],
    sourceRects: [[45, 30, 60, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('unmeasured-mixed-source-partition')
  a.sourceSegments = [{ ...f.tokens[1].sourceItem, start: 0, end: 1, rect: a.sourceRects[1] }]
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('does not use duplicate native identities or mismatched cell text as layout proof', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      [String(row + 1), 10, 30 + row * 20],
      ['value', 70, 30 + row * 20]
    ])
  const rules = [[50, 15, 50, 100]]
  const duplicate = f.tokens.map((t) => ({ ...t, sourceItem: { ...t.sourceItem } }))
  expect(conflicts(f.table(), [...f.tokens, ...duplicate], rules)).toEqual([])
  for (const c of f.cells) c.text = 'unrelated'
  expect(conflicts(f.table(), f.tokens, rules)).toEqual([])
})
it('rejects an unmeasured partial parent even when a raised complete peer precedes its native order', () => {
  const f = fixture()
  const cell = f.add(0, 0, [
    ['BASE', 10, 40, 25],
    ['q', 35, 36, 5, 8],
    ['First second', 50, 40, 60]
  ])
  cell.text = 'q BASE First'
  cell.sourceRects[2] = [50, 30, 75, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: 'second',
    sourceItems: [f.tokens[2].sourceItem],
    sourceRects: [[80, 30, 110, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('unmeasured-mixed-source-partition')
  cell.text = 'q BASE First q'
  expect(conflicts(f.table(), f.tokens)).not.toContain('unmeasured-mixed-source-partition')
  cell.text = 'q BASE First'
  expect(conflicts(f.table(), [...f.tokens, f.tokens[1]])).not.toContain(
    'unmeasured-mixed-source-partition'
  )
})
it('keeps legitimate single-parent sharing without inventing a segment range', () => {
  const f = fixture(),
    a = f.add(0, 0, [['3 /', 10, 40, 30]])
  a.text = '3'
  a.sourceRects[0] = [10, 30, 20, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '/',
    sourceItems: [f.tokens[0].sourceItem],
    sourceRects: [[20, 30, 40, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects a raised native script serialized before its adjacent full-size base', () => {
  const f = fixture()
  const c = f.add(0, 0, [
    ['word', 10, 40, 30, 12],
    ['x', 50, 40, 8, 12],
    ['abc', 58, 34, 15, 8]
  ])
  c.text = 'abc word x'
  Object.assign(c, {
    sourceTokens: [f.tokens[2], f.tokens[0], f.tokens[1]].map((font) => ({
      text: font.text,
      rect: font.rect,
      baseline: font.baseline,
      height: font.height
    }))
  })
  expect(conflicts(f.table(), f.tokens)).toContain('native-script-precedes-base')
  c.text = 'word x abc'
  Object.assign(c, { sourceTokens: f.tokens })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects omitted point estimates above three owned intervals with intact peer records', () => {
  const f = fixture(),
    missing: string[] = []
  for (const col of [1, 2, 3]) {
    f.add(1, col, [
      ['2', col * 80 + 15, 40, 10],
      ['[1, 3]', col * 80, 55, 40]
    ])
    f.add(2, col, [['[2, 4]', col * 80, 95, 40]])
    const omitted = f.add(7, col, [[String(col + 2), col * 80 + 15, 80, 10]])
    missing.push(omitted.text)
    f.cells.pop()
  }
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).toContain(
    'unassigned-point-estimate-above-interval'
  )
  expect(conflicts({ ...f.table(), unassigned: missing.slice(0, 1) }, f.tokens)).not.toContain(
    'unassigned-point-estimate-above-interval'
  )
  for (const c of f.cells.filter((c) => c.row === 1)) c.sourceSegments = []
  f.cells.splice(0, f.cells.length, ...f.cells.filter((c) => c.row !== 1))
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).not.toContain(
    'unassigned-point-estimate-above-interval'
  )
})

it('rejects an omitted left header within a ruled header band and a repeated native stub lane', () => {
  const f = fixture()
  for (const col of [1, 2]) f.add(0, col, [['Header', 100 * col, 30, 30]])
  for (const row of [1, 2, 3]) {
    f.add(row, 0, [['long record name', 10, 50 + row * 20, 70]])
    for (const col of [1, 2]) f.add(row, col, [['12', col * 100, 50 + row * 20, 20]])
  }
  const omitted = f.add(7, 0, [['Kind', 10, 30, 20]])
  f.cells.pop()
  f.cells.push({
    row: 0,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    sourceItems: [],
    sourceRects: []
  })
  const table = { ...f.table(), unassigned: [omitted.text] }
  expect(
    conflicts(table, f.tokens, [
      [0, 15, 250, 15],
      [0, 40, 250, 40]
    ])
  ).toContain('unassigned-ruled-leaf-header')
  expect(conflicts(table, f.tokens, [[0, 40, 250, 40]])).not.toContain(
    'unassigned-ruled-leaf-header'
  )
})

it('rejects three omitted angled headings independently enclosed above native body columns', () => {
  const f = fixture(),
    missing: string[] = []
  for (let col = 0; col < 3; col++) {
    for (const row of [1, 2]) f.add(row, col, [['12', 30 + col * 70, 90 + row * 20, 10]])
    const header = f.add(7, col, [['Heading', 20 + col * 70, 70, 40, 40]])
    f.tokens.at(-1)!.horizontal = false
    f.tokens.at(-1)!.height = 10
    f.cells.pop()
    missing.push(header.text)
    f.cells.push({
      row: 0,
      column: col,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceItems: [],
      sourceRects: []
    })
  }
  const table = { ...f.table(), unassigned: missing }
  const rules = [
    [10, 20, 220, 20],
    [10, 80, 220, 80]
  ]
  expect(conflicts(table, f.tokens, rules)).toContain('unassigned-oriented-header-band')
  expect(conflicts(table, f.tokens, rules.slice(1))).not.toContain(
    'unassigned-oriented-header-band'
  )
})

it('rejects two omitted continuation lines between the same pair of complete native records', () => {
  const f = fixture(),
    missing: string[] = []
  for (const col of [1, 2]) {
    f.add(1, col, [['begin phrase', col * 100, 50, 80]])
    const tail = f.add(7, col, [['continued', col * 100, 65, 55]])
    f.cells.pop()
    missing.push(tail.text)
    f.add(2, col, [['next phrase', col * 100, 80, 80]])
  }
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).toContain(
    'unassigned-interior-record-continuations'
  )
  f.cells.pop()
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).not.toContain(
    'unassigned-interior-record-continuations'
  )
})

it('rejects a full native leaf header extending into an empty independently populated column', () => {
  const f = fixture()
  f.add(0, 1, [['Kind Count', 100, 30, 150]])
  f.cells.push({
    row: 0,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    sourceItems: [],
    sourceRects: []
  })
  for (const row of [1, 2]) {
    f.add(row, 1, [['category', 100, 50 + row * 20, 50]])
    f.add(row, 2, [['12', 220, 50 + row * 20, 20]])
  }
  expect(conflicts(f.table(), f.tokens, [[90, 40, 260, 40]])).toContain(
    'native-leaf-header-crosses-empty-column'
  )
  f.cells[0].colSpan = 2
  expect(conflicts(f.table(), f.tokens, [[90, 40, 260, 40]])).toEqual([])
})

it('rejects a repeated assignment heading whose identifier belongs to the preceding column', () => {
  const f = fixture()
  f.add(0, 1, [
    ['z', 80, 30, 5],
    ['=2', 87, 30, 15]
  ])
  f.add(0, 2, [
    ['z', 150, 30, 5],
    ['=4', 157, 30, 15],
    ['z', 220, 30, 5]
  ])
  f.add(0, 3, [['=6', 227, 30, 15]])
  for (const row of [1, 2])
    for (const col of [1, 2, 3]) f.add(row, col, [['3', 25 + col * 70, 50 + row * 20, 8]])
  expect(conflicts(f.table(), f.tokens)).toContain('native-assignment-header-crosses-column')
  f.cells[2].sourceItems.unshift(f.cells[1].sourceItems.pop()!)
  f.cells[2].sourceRects.unshift(f.cells[1].sourceRects.pop()!)
  f.cells[1].text = 'z =4'
  f.cells[2].text = 'z =6'
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects centered column-major group labels split across middle records in repeated ruled bands', () => {
  const f = fixture()
  for (let band = 0; band < 2; band++) {
    const row = band * 4 + 1,
      y = 40 + band * 80
    f.add(row + 1, 0, [['Grouped', 10, y + 20, 40]])
    f.add(row + 2, 0, [['records', 10, y + 40, 40]])
    for (const r of [row, row + 3])
      f.cells.push({
        row: r,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '',
        sourceItems: [],
        sourceRects: []
      })
    for (let i = 0; i < 4; i++)
      for (let col = 1; col < 4; col++) f.add(row + i, col, [['12', 80 * col, y + 20 * i, 20]])
  }
  const rules = [25, 105, 185].map((y) => [0, y, 280, y])
  expect(conflicts(f.table(), f.tokens, rules)).toContain('centered-group-stub-split-across-rows')
  for (const c of f.cells.filter((c) => c.column === 0 && c.text)) c.rowSpan = 4
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'centered-group-stub-split-across-rows'
  )
})
it('rejects a native record prefix assigned after the preceding row numbers', () => {
  const f = fixture()
  f.add(1, 0, [['First record', 10, 50]])
  const wrong = f.add(1, 1, [
    ['Type', 80, 50],
    ['Size', 80, 69]
  ])
  f.add(1, 2, [['12', 160, 50]])
  f.add(1, 3, [['15', 220, 50]])
  const next = f.add(2, 0, [['Next record', 10, 80]])
  f.add(2, 1, [['Type', 80, 80]])
  f.add(2, 2, [['16', 160, 80]])
  f.add(2, 3, [['18', 220, 80]])
  // Native stream introduces the next record before its misassigned prefix.
  next.sourceItems[0].index = 40
  wrong.sourceItems[1].index = 41
  for (const c of f.cells.filter((c) => c.row === 2 && c.column > 0))
    for (const o of c.sourceItems) o.index += 50
  expect(conflicts(f.table(), f.tokens)).toContain('native-record-prefix-crosses-row')
  wrong.sourceItems[1].index = 39
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects an unassigned native header prefix contiguous with its retained suffix', () => {
  const f = fixture()
  f.add(0, 0, [['Mean (%)', 10, 30, 60]])
  f.add(0, 1, [['Maximum', 100, 30, 50]])
  f.cells.pop()
  f.add(0, 1, [['(%)', 152, 30, 20]])
  f.add(0, 2, [['Count', 220, 30, 40]])
  expect(conflicts({ ...f.table(), unassigned: ['Maximum'] }, f.tokens)).toContain(
    'unassigned-contiguous-header'
  )
  expect(conflicts({ ...f.table(), unassigned: ['Footnote'] }, f.tokens)).toEqual([])
})
it('rejects a contiguous native header atom split into an otherwise empty extra row', () => {
  const f = fixture()
  f.add(0, 0, [['A', 10, 22, 10]])
  f.add(1, 0, [['Rate', 20, 30, 30]])
  f.add(1, 1, [['Other', 80, 30]])
  f.add(1, 2, [['Count', 140, 30]])
  expect(conflicts(f.table(), f.tokens)).toContain('inline-header-split-across-rows')
  f.cells[0].sourceRects[0][2] -= 5
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects moving an inline mathematical operator before its native left context', () => {
  const f = fixture()
  const c = f.add(1, 1, [
    ['Expected value:', 10, 50, 90],
    ['∫', 105, 42, 8],
    ['f(x)', 116, 50, 30]
  ])
  c.text = '∫ Expected value: f(x)'
  expect(conflicts(f.table(), f.tokens)).toContain('native-inline-operator-order-conflict')
  c.text = 'Expected value: ∫ f(x)'
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects two omitted repeated native records enclosed by the table rules', () => {
  const f = fixture()
  for (const [row, label] of ['Reference alpha', 'Reference beta'].entries()) {
    f.add(row, 0, [[label, 10, 30 + row * 15, 80]])
    f.add(row, 1, [['Score: 2', 120, 30 + row * 15, 50]])
    f.add(row, 2, [['Error: 3', 210, 30 + row * 15, 50]])
  }
  const count = f.cells.length
  for (const [row, label] of ['Reference alpha', 'Reference beta'].entries()) {
    f.add(row + 2, 0, [[label, 10, 90 + row * 15, 80]])
    f.add(row + 2, 1, [['Score: 4', 120, 90 + row * 15, 50]])
    f.add(row + 2, 2, [['Error: 5', 210, 90 + row * 15, 50]])
  }
  const unassigned = f.cells.splice(count).map((c) => c.text)
  const rules = [
    [5, 75, 280, 75],
    [5, 115, 280, 115]
  ]
  expect(conflicts({ ...f.table(), unassigned }, f.tokens, rules)).toContain(
    'omitted-repeated-native-records'
  )
  expect(conflicts({ ...f.table(), unassigned }, f.tokens, rules.slice(0, 1))).toEqual([])
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function omittedNumericRecord() {
  const f = fixture()
  for (const row of [1, 2, 3]) {
    f.add(row, 0, [[`Group ${row}`, 10, row * 30, 40]])
    for (const col of [1, 2, 3]) f.add(row, col, [[`${row}.${col}`, col * 80, row * 30]])
  }
  const missing = f.cells.splice(4, 4)
  return { ...f, missing, table: () => ({ ...f.table(), unassigned: missing.map((c) => c.text) }) }
}

it('rejects an omitted numeric record independently aligned between two owned body records', () => {
  const f = omittedNumericRecord()
  expect(conflicts(f.table(), f.tokens)).toContain('unassigned-interior-numeric-record')
  // Different widths remain valid when the same alignment is proved at both ends.
  f.tokens[9].rect[2] += 12
  expect(conflicts(f.table(), f.tokens)).toContain('unassigned-interior-numeric-record')
  f.cells.push(...f.missing)
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('does not infer omitted records from external notes, partial columns or ambiguous sources', () => {
  for (const variant of [
    'external',
    'two-columns',
    'misaligned',
    'duplicate',
    'segments',
    'no-stub'
  ]) {
    const f = omittedNumericRecord()
    if (variant === 'external')
      for (const token of f.tokens.slice(4, 8)) {
        token.baseline += 100
        token.rect[1] += 100
        token.rect[3] += 100
      }
    if (variant === 'two-columns') f.missing.pop()
    if (variant === 'misaligned') {
      f.tokens[7].rect[0] += 30
      f.tokens[7].rect[2] += 30
    }
    if (variant === 'duplicate') f.tokens.push({ ...f.tokens[7] })
    if (variant === 'segments') {
      const cell = f.cells[3]
      cell.sourceSegments = [
        { ...cell.sourceItems[0], start: 0, end: 1, rect: cell.sourceRects[0] }
      ]
    }
    if (variant === 'no-stub') f.missing.shift()
    expect(conflicts(f.table(), f.tokens), variant).toEqual([])
  }
})

it('isolates two terminal scalar lanes proved by numeric headings and two independent peer columns', () => {
  const f = fixture()
  for (let row = 0; row < 3; row++) {
    f.add(row, 0, [[['Setting', 'Estimate', 'Error'][row], 10, 30 + row * 25, 60]])
    for (const col of [1, 2]) f.add(row, col, [['2', 85 + col * 45, 30 + row * 25, 10]])
    f.add(row, 3, [
      ['8', 225, 30 + row * 25, 10],
      ['16', 270, 30 + row * 25, 10]
    ])
  }
  const table = { ...f.table(), grid: Array.from({ length: 3 }, () => Array(4).fill('')) }
  expect(conflicts(table, f.tokens)).toContain('numeric-headed-terminal-lanes-collapsed')
  const before = JSON.stringify(table)
  const checked = reviewFinalNativeTableSources(table, f.tokens, [])
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.grid).toBe(table.grid)
  expect(checked.cells).toBe(table.cells)
  expect(JSON.stringify(table)).toBe(before)
  f.cells.at(-1)!.colSpan = 2
  expect(conflicts(table, f.tokens)).not.toContain('numeric-headed-terminal-lanes-collapsed')
  f.cells.at(-1)!.colSpan = 1
  expect(conflicts(table, [...f.tokens, { ...f.tokens.at(-1)! }])).not.toContain(
    'numeric-headed-terminal-lanes-collapsed'
  )
})

it('rejects duplicate record stubs and distinct thresholds merged above a spanning note', () => {
  const f = fixture()
  f.add(1, 0, [
    ['Control', 10, 50, 45],
    ['Control', 10, 70, 45]
  ])
  f.add(1, 1, [
    ['2/5', 80, 50],
    ['3/5', 80, 70]
  ])
  f.add(1, 2, [['1.2', 140, 50]])
  f.add(1, 3, [['0.8', 200, 50]])
  f.add(1, 4, [['No observations', 140, 70, 110]])
  expect(conflicts(f.table(), f.tokens)).toContain('repeated-stub-records-collapsed')
  f.cells[0].rowSpan = 2
  expect(conflicts(f.table(), f.tokens)).not.toContain('repeated-stub-records-collapsed')
  f.cells[0].rowSpan = 1
  f.cells[1].text = 'A wrapped threshold label'
  expect(conflicts(f.table(), f.tokens)).not.toContain('repeated-stub-records-collapsed')
})

it('rejects complete parent runs moved over an empty leading field below a split native heading', () => {
  const f = fixture(),
    head = f.add(0, 0, [['ID Description', 10, 30, 90]])
  head.text = 'ID'
  head.sourceRects = [[10, 20, 25, 30]]
  f.cells.push({ ...head, column: 1, text: 'Description', sourceRects: [[25, 20, 100, 30]] })
  for (let row = 1; row <= 3; row++) {
    f.add(row, 0, [])
    f.add(row, 1, [[`R${row} Complete description`, 10, 50 + row * 20, 155]])
  }
  const rules = [[0, 40, 200, 40]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('whole-native-parent-crosses-empty-stub')
  expect(conflicts(f.table(), f.tokens, [])).not.toContain('whole-native-parent-crosses-empty-stub')
  f.cells[3].colSpan = 2
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'whole-native-parent-crosses-empty-stub'
  )
})

it('rejects line rows inside repeated ragged native paragraph blocks, preserving row-major tables', () => {
  const f = fixture()
  for (let col = 0; col < 3; col++) f.add(0, col, [['Heading', 10 + col * 100, 30, 50]])
  for (let group = 0; group < 2; group++)
    for (let col = 0; col < 3; col++)
      for (let line = 0; line < [3, 2, 4][col]; line++)
        f.add(1 + group * 4 + line, col, [
          [`Native words ${line}`, 10 + col * 100, 55 + group * 100 + line * 20, 70]
        ])
  const table = { ...f.table(), grid: Array.from({ length: 9 }, () => Array(3).fill('')) },
    rules = [[0, 40, 300, 40]]
  expect(conflicts(table, f.tokens, rules)).toContain(
    'native-paragraph-blocks-split-into-line-rows'
  )
  expect(conflicts(table, f.tokens, [])).not.toContain(
    'native-paragraph-blocks-split-into-line-rows'
  )
  f.add(1, 1, [['Unclaimed native words', 120, 80, 70]])
  f.cells.pop()
  expect(conflicts(table, f.tokens, rules)).not.toContain(
    'native-paragraph-blocks-split-into-line-rows'
  )
  f.tokens.pop()
  // Independent native cell paint order follows the actual row units here.
  for (const [index, c] of [...f.cells]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .entries())
    c.sourceItems[0].index = index
  expect(conflicts(table, f.tokens, rules)).not.toContain(
    'native-paragraph-blocks-split-into-line-rows'
  )
})

it('retains an unknown formula atom in a closed native advance gap across whitespace items', () => {
  const f = fixture()
  f.add(0, 0, [['A =', 10, 40, 25]])
  const expression = f.add(0, 1, [
    ['smooth', 50, 40, 30],
    ['X', 90, 40, 10]
  ])
  const glyph = f.add(1, 1, [['\u0000', 82, 35, 8]])
  f.cells.pop()
  expression.sourceItems[0].index = 10
  glyph.sourceItems[0].index = 12
  expression.sourceItems[1].index = 13
  const table = { ...f.table(), unassigned: [glyph.text] }
  expect(conflicts(table, f.tokens)).toContain('unassigned-native-formula-atom')
  f.tokens.at(-1)!.rect[0] -= 10
  expect(conflicts(table, f.tokens)).not.toContain('unassigned-native-formula-atom')
})

it('uses repeated printed metric labels to reject a collapsed first numeric panel', () => {
  const f = fixture()
  f.add(0, 0, [
    ['Parameter', 10, 30, 50],
    ['Response', 10, 50, 50],
    ['Change', 10, 70, 50]
  ])
  for (const col of [1, 2, 3])
    f.add(0, col, [
      ['0.2', col * 80, 30],
      ['.42', col * 80, 50],
      ['-1.5%', col * 80, 70]
    ])
  for (const [at, label] of ['Parameter', 'Response', 'Change'].entries()) {
    f.add(at + 1, 0, [[label, 10, 110 + at * 20, 50]])
    for (const col of [1, 2, 3]) f.add(at + 1, col, [['2', col * 80, 110 + at * 20]])
  }
  const rules = [[0, 85, 280, 85]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('repeated-metric-panel-rows-collapsed')
  expect(conflicts(f.table(), f.tokens, [])).not.toContain('repeated-metric-panel-rows-collapsed')
  f.cells.find((c) => c.row === 2 && c.column === 0)!.text = 'Different measure'
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'repeated-metric-panel-rows-collapsed'
  )
})

it('requires omitted native headings and a printed divider before isolating a prose reference lane', () => {
  const f = fixture()
  const left = f.add(0, 0, [['Explanation', 10, 25, 95]]),
    right = f.add(0, 1, [['Ref.', 150, 25, 20]])
  f.cells.splice(0)
  for (let row = 0; row < 3; row++)
    f.add(row, 0, [
      ['A complete claim', 10, 50 + row * 35, 95],
      ['continues here', 10, 65 + row * 35, 90],
      ['Q', 155, 50 + row * 35, 10]
    ])
  const table = { ...f.table(), unassigned: [left.text, right.text] },
    rules = [[0, 35, 180, 35]]
  expect(conflicts(table, f.tokens, rules)).toContain('omitted-headed-reference-lane')
  expect(conflicts({ ...table, unassigned: [] }, f.tokens, rules)).not.toContain(
    'omitted-headed-reference-lane'
  )
  expect(conflicts(table, f.tokens, [])).not.toContain('omitted-headed-reference-lane')
})

it('rejects a complete top header band merged with a separately repeated body-value band', () => {
  const f = fixture()
  f.add(0, 0, [
    ['Operation', 10, 25, 55],
    ['Initial setup', 10, 45, 65]
  ])
  f.add(0, 1, [
    ['Work', 100, 25, 25],
    ['F(n)', 100, 45, 30]
  ])
  f.add(0, 2, [
    ['Scale', 190, 25, 25],
    ['linear', 190, 45, 30]
  ])
  f.add(0, 3, [
    ['Mode', 280, 25, 25],
    ['absent', 280, 45, 30]
  ])
  for (const row of [1, 2]) {
    f.add(row, 0, [['Later operation', 10, 45 + row * 20, 70]])
    f.add(row, 1, [[`F(n${row})`, 100, 45 + row * 20, 35]])
    f.add(row, 2, [['linear', 190, 45 + row * 20, 30]])
    f.add(row, 3, [['absent', 280, 45 + row * 20, 30]])
  }
  const table = { ...f.table(), grid: Array.from({ length: 3 }, () => Array(4).fill('')) }
  const order = [...f.tokens].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  order.forEach((token, index) => {
    token.sourceItem.index = index
  })
  const marker = 'native-header-and-first-record-merged'
  expect(conflicts(table, f.tokens)).toContain(marker)
  const reviewed = reviewFinalNativeTableSources(table, f.tokens)
  expect(reviewed.issues).toContain('native-table-structure-ambiguous')
  expect(reviewed.cells).toBe(table.cells)
  expect(reviewed.grid).toBe(table.grid)
  expect(reviewed.cropRect).toBe(table.cropRect)
  // Column-major painting can describe an ordinary multiline heading.
  f.tokens.forEach((token, index) => {
    token.sourceItem.index = index
  })
  expect(conflicts(table, f.tokens)).not.toContain(marker)
  order.forEach((token, index) => {
    token.sourceItem.index = index
  })
  f.cells[1].rowSpan = 2
  expect(conflicts(table, f.tokens)).not.toContain(marker)
  f.cells[1].rowSpan = 1
  // The same bands below an earlier native row cannot be the table's header.
  f.add(3, 0, [['Earlier printed record', 10, 15, 90]])
  expect(conflicts(table, f.tokens)).not.toContain(marker)
})

it('rejects independent record starts synchronized with a repeated categorical lane and another field', () => {
  const f = fixture()
  for (const [col, title] of ['Measure', 'Stages', 'Checklist'].entries())
    f.add(0, col, [[title, 10 + col * 100, 25, 50]])
  f.add(1, 0, [
    ['Consumed energy', 10, 55, 80],
    ['Processor hours', 10, 85, 80]
  ])
  const repeated = f.add(1, 1, [
    ['A·B·C', 110, 55, 50],
    ['A·B·C', 110, 85, 50]
  ])
  const other = f.add(1, 2, [
    ['K2, K7', 210, 55, 50],
    ['K4, K8', 210, 85, 50]
  ])
  for (const row of [2, 3]) {
    f.add(row, 0, [['Other measure', 10, 85 + row * 20, 70]])
    f.add(row, 1, [['A·B·C', 110, 85 + row * 20, 50]])
    f.add(row, 2, [['K3', 210, 85 + row * 20, 20]])
  }
  const table = { ...f.table(), grid: Array.from({ length: 4 }, () => Array(3).fill('')) },
    marker = 'native-independent-record-starts-merged'
  expect(conflicts(table, f.tokens)).toContain(marker)
  expect(reviewFinalNativeTableSources(table, f.tokens).issues).toContain(
    'native-table-structure-ambiguous'
  )
  other.colSpan = 2
  expect(conflicts(table, f.tokens)).not.toContain(marker)
  other.colSpan = 1
  repeated.rowSpan = 2
  expect(conflicts(table, f.tokens)).not.toContain(marker)
  repeated.rowSpan = 1
  const second = f.tokens.find((t) => t.sourceItem === repeated.sourceItems[1])!
  second.baseline -= 30
  second.rect[1] -= 30
  second.rect[3] -= 30
  expect(conflicts(table, f.tokens)).not.toContain(marker)
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function splitNativeSectionRecord() {
  const f = fixture(),
    stub = f.add(1, 0, [
      ['SET', 10, 30, 15, 8],
      ['0', 20, 46, 4],
      ['.', 24, 46, 2],
      ['5', 26, 46, 4]
    ]),
    word = f.add(0, 0, [['parameter', 30, 30, 40]])
  f.cells.pop()
  const symbol = f.add(0, 2, [
      ['ξ', 75, 30, 6],
      ['q', 81, 31, 4, 6]
    ]),
    merged = f.add(
      1,
      1,
      [
        ['0', 70, 46, 4],
        ['.', 74, 46, 2],
        ['7', 76, 46, 4],
        ['+', 120, 46, 4],
        ['8', 124, 46, 4],
        ['.', 128, 46, 2],
        ['8', 130, 46, 4]
      ],
      2
    )
  f.add(1, 3, [['0.2', 170, 46, 12]])
  for (const row of [2, 3])
    for (const [column, x] of [20, 70, 120, 170].entries())
      f.add(row, column, [
        [column === 2 ? '+1' : '1', x, 30 + row * 16, column === 2 ? 8 : 4],
        ['.', x + (column === 2 ? 8 : 4), 30 + row * 16, 2],
        ['2', x + (column === 2 ? 10 : 6), 30 + row * 16, 4]
      ])
  const order = [...f.tokens].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  order.forEach((token, index) => {
    token.sourceItem.index = index
  })
  return {
    ...f,
    stub,
    word,
    symbol,
    merged,
    table: {
      ...f.table(),
      grid: Array.from({ length: 4 }, () => Array(4).fill('')),
      unassigned: [word.text]
    },
    rules: [
      [0, 18, 195, 18],
      [0, 90, 195, 90]
    ]
  }
}

it('retains native sources when a split section also projects two numeric lanes into one cell', () => {
  const f = splitNativeSectionRecord(),
    marker = 'native-section-and-projected-record-conflict',
    before = structuredClone(f.table)
  expect(conflicts(f.table, f.tokens, f.rules)).toContain(marker)
  const checked = reviewFinalNativeTableSources(f.table, f.tokens, f.rules)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.grid).toBe(f.table.grid)
  expect(checked.cropRect).toBe(f.table.cropRect)
  expect(f.table).toEqual(before)
})

it.each([
  'unassigned absent',
  'unassigned source missing',
  'duplicate source',
  'unassigned literal mismatch',
  'intervening unbound native source',
  'source rectangle mismatch',
  'explicit row span',
  'measured source partition',
  'missing font height',
  'outside crop',
  'no projected numeric span',
  'only two numeric records',
  'different heading baseline',
  'word outside native gap',
  'same-row multiline heading',
  'column-major native order',
  'percentage annotation',
  'missing divider',
  'duplicate divider'
])('keeps a section/record layout when %s prevents its complete contradiction proof', (mode) => {
  const f = splitNativeSectionRecord()
  if (mode === 'unassigned absent') f.table.unassigned = []
  if (mode === 'unassigned source missing')
    f.tokens.splice(
      f.tokens.findIndex((t) => t.sourceItem === f.word.sourceItems[0]),
      1
    )
  if (mode === 'duplicate source') f.tokens.push(structuredClone(f.tokens[0]))
  if (mode === 'unassigned literal mismatch') f.word.sourceItems[0].text = 'another'
  if (mode === 'intervening unbound native source') {
    for (const token of f.tokens) if (token.sourceItem.index >= 2) token.sourceItem.index++
    f.tokens.push({
      text: 'x',
      horizontal: false,
      height: 0,
      baseline: 30,
      rect: [50, 20, 55, 30],
      sourceItem: { pageNumber: 1, index: 2, text: 'x' }
    })
  }
  if (mode === 'source rectangle mismatch') f.stub.sourceRects[0] = [9, 22, 25, 30]
  if (mode === 'explicit row span') f.symbol.rowSpan = 2
  if (mode === 'measured source partition')
    f.symbol.sourceSegments = [
      { ...f.symbol.sourceItems[0], start: 0, end: 1, rect: f.symbol.sourceRects[0] }
    ]
  if (mode === 'missing font height')
    f.tokens.find((t) => t.sourceItem === f.stub.sourceItems[0])!.height = NaN
  if (mode === 'outside crop') f.table.cropRect[0] = 15
  if (mode === 'no projected numeric span') f.merged.colSpan = 1
  if (mode === 'only two numeric records')
    f.cells.splice(0, f.cells.length, ...f.cells.filter((c) => c.row !== 3))
  if (mode === 'different heading baseline') {
    const font = f.tokens.find((t) => t.sourceItem === f.stub.sourceItems[0])!
    font.baseline -= 2
    font.rect[1] -= 2
    font.rect[3] -= 2
  }
  if (mode === 'word outside native gap') {
    const font = f.tokens.find((t) => t.sourceItem === f.word.sourceItems[0])!
    font.rect[0] += 60
    font.rect[2] += 60
  }
  if (mode === 'same-row multiline heading') f.symbol.row = 1
  if (mode === 'column-major native order')
    [...f.tokens]
      .sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
      .forEach((t, n) => {
        t.sourceItem.index = n
      })
  if (mode === 'percentage annotation') {
    const c = f.cells.find((c) => c.row === 2 && c.column === 1)!,
      font = f.tokens.find((t) => t.sourceItem === c.sourceItems.at(-1))!
    font.text += '%'
    font.sourceItem.text = font.text
    c.text += '%'
  }
  if (mode === 'missing divider') f.rules.pop()
  if (mode === 'duplicate divider') f.rules.push([...f.rules[0]])
  expect(conflicts(f.table, f.tokens, f.rules)).not.toContain(
    'native-section-and-projected-record-conflict'
  )
})

// Independently headed lanes must keep their native sources even when the grid fuses them.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function headedFractionAndCount() {
  const f = fixture()
  for (const [column, text] of ['Model', 'Count', 'Safe'].entries())
    f.add(0, column, [[text, 10 + column * 90, 30, 25]])
  f.add(0, 3, [
    ['Rate', 300, 25, 20],
    ['trial', 297, 36, 23],
    ['↑', 321, 36, 7],
    ['Err.', 340, 25, 20],
    ['↓', 345, 36, 8]
  ])
  for (const row of [1, 2, 3]) {
    f.add(row, 0, [['Model', 10, 40 + row * 20, 25]])
    f.add(row, 1, [[String(row), 100, 40 + row * 20, 10]])
    f.add(row, 2, [[String(row + 2), 190, 40 + row * 20, 10]])
    f.add(row, 3, [
      [`${row}/20`, 300, 40 + row * 20, 28],
      ['0', 355, 40 + row * 20, 5]
    ])
  }
  for (const font of f.tokens)
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [
        font.rect[0],
        font.baseline - font.height * 0.8,
        font.rect[2],
        font.baseline + font.height * 0.2
      ]
    })
  return {
    ...f,
    table: {
      ...f.table(),
      page: 1,
      grid: Array.from({ length: 4 }, () => Array(4).fill('')),
      issues: []
    },
    rules: [
      [0, 10, 380, 10],
      [0, 45, 380, 45],
      [0, 110, 380, 110]
    ]
  }
}

it('retains independent native fraction and count lanes without guessing replacement columns', () => {
  const f = headedFractionAndCount(),
    before = structuredClone(f.table)
  expect(conflicts(f.table, f.tokens, f.rules)).toContain('native-headed-fraction-count-lanes')
  const checked = reviewFinalNativeTableSources(f.table, f.tokens, f.rules)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.grid).toBe(f.table.grid)
  expect(f.table).toEqual(before)
})

it.each([
  'missing closing rule',
  'duplicate source',
  'foreign top edge',
  'foreign bottom edge',
  'missing font metrics'
])('does not infer independent native terminal lanes with %s', (mode) => {
  const f = headedFractionAndCount()
  if (mode === 'missing closing rule') f.rules.pop()
  if (mode === 'duplicate source') f.tokens.push(structuredClone(f.tokens[3]))
  if (mode === 'missing font metrics') Object.assign(f.tokens[3], { fontAscent: undefined })
  if (mode.startsWith('foreign')) {
    const y = mode === 'foreign top edge' ? 19 : 109
    const c = f.add(7, 3, [['Foreign', 332, y, 3]])
    f.cells.pop()
    const font = f.tokens.find((t) => t.sourceItem === c.sourceItems[0])!
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [332, y - 8, 335, y + 2]
    })
  }
  expect(conflicts(f.table, f.tokens, f.rules)).not.toContain('native-headed-fraction-count-lanes')
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function displacedNativeSubscript() {
  const f = fixture(),
    c = f.add(1, 0, [
      ['Wave ', 10, 40, 30],
      ['q', 40, 40, 6],
      ['2', 46, 41.1, 4, 6.7],
      ['(s', 55, 40, 10],
      ['−1', 65, 35.8, 7, 6.7],
      [')', 73, 40, 4]
    ])
  Object.assign(c, {
    text: 'Wave q (s−1 2)',
    textRuns: [
      { text: 'Wave q (s', position: 'normal' },
      { text: '−1', position: 'superscript' },
      { text: ' 2)', position: 'normal' }
    ]
  })
  for (const font of f.tokens)
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [
        font.rect[0],
        font.baseline - font.height * 0.8,
        font.rect[2],
        font.baseline + font.height * 0.2
      ]
    })
  return { ...f, c, table: { ...f.table(), page: 1, issues: [] } }
}

it('retains a native-attached subscript displaced into a later closed enclosure', () => {
  const f = displacedNativeSubscript(),
    before = structuredClone(f.table)
  expect(conflicts(f.table, f.tokens)).toContain('native-attached-subscript-order-conflict')
  const checked = reviewFinalNativeTableSources(f.table, f.tokens)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.grid).toBe(f.table.grid)
  expect(f.table).toEqual(before)
})

it.each(['correct order', 'different metrics', 'missing atom', 'foreign attachment'])(
  'does not infer a displaced native subscript with %s',
  (mode) => {
    const f = displacedNativeSubscript()
    if (mode === 'correct order')
      Object.assign(f.c, {
        text: 'Wave q2 (s−1)',
        textRuns: [{ text: 'Wave q2 (s−1)', position: 'normal' }]
      })
    if (mode === 'different metrics') Object.assign(f.tokens[2], { fontDescent: -0.3 })
    if (mode === 'missing atom') f.tokens.splice(2, 1)
    if (mode === 'foreign attachment') {
      const c = f.add(7, 0, [['Foreign', 42, 39, 2]])
      f.cells.pop()
      const font = f.tokens.find((t) => t.sourceItem === c.sourceItems[0])!
      Object.assign(font, { fontAscent: 0.8, fontDescent: -0.2, nativeLabelRect: [42, 31, 44, 41] })
    }
    expect(conflicts(f.table, f.tokens)).not.toContain('native-attached-subscript-order-conflict')
  }
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function calibratedNativeCycles(merged = true) {
  const f = fixture()
  for (const column of [0, 1, 2]) f.add(0, column, [['Heading', 10 + column * 60, 20, 35]])
  for (const record of [0, 1, 2, 3])
    for (const column of [0, 1, 2]) {
      const row = merged ? Math.max(1, record) : record + 1,
        prior = f.cells.find((c) => c.row === row && c.column === column),
        cell = f.add(row, column, [
          ['Record', 10 + column * 60, 50 + record * 50, 35],
          ['continued', 10 + column * 60, 62 + record * 50, 40]
        ])
      if (prior) {
        f.cells.pop()
        prior.text += ' ' + cell.text
        prior.sourceItems.push(...cell.sourceItems)
        prior.sourceRects.push(...cell.sourceRects)
      }
    }
  for (const font of f.tokens)
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [font.rect[0], font.baseline - 8, font.rect[2], font.baseline + 2]
    })
  return {
    ...f,
    table: {
      ...f.table(),
      page: 1,
      grid: Array.from({ length: merged ? 4 : 5 }, () => Array(3).fill('')),
      cropRect: [0, 0, 200, 245],
      issues: []
    },
    rules: [0, 30, 245].map((y) => [0, y, 200, y])
  }
}

it('protects merged native record cycles calibrated by complete independent records', () => {
  const f = calibratedNativeCycles()
  expect(conflicts(f.table, f.tokens, f.rules)).toContain('native-calibrated-source-cycles-merged')
  const checked = reviewFinalNativeTableSources(f.table, f.tokens, f.rules)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.grid).toBe(f.table.grid)
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.cropRect).toBe(f.table.cropRect)
})

it.each([
  'already separate records',
  'missing font proof',
  'foreign crossing frame',
  'missing header divider',
  'source order broken',
  'shared calibration owner'
])('does not infer a native record cycle contradiction with %s', (mode) => {
  const f = calibratedNativeCycles(mode !== 'already separate records')
  if (mode === 'missing font proof') Object.assign(f.tokens[3], { fontDescent: undefined })
  if (mode === 'foreign crossing frame') {
    const c = f.add(8, 0, [['Foreign', 10, 4, 20]])
    f.cells.pop()
    Object.assign(
      f.tokens.find((t) => t.sourceItem === c.sourceItems[0])!,
      {
        fontAscent: 0.8,
        fontDescent: -0.2,
        nativeLabelRect: [10, -4, 30, 6]
      }
    )
  }
  if (mode === 'missing header divider') f.rules.splice(1, 1)
  if (mode === 'source order broken') f.tokens[3].sourceItem.index = 10000
  if (mode === 'shared calibration owner') f.table.cells.find((c) => c.row === 3)!.rowSpan = 2
  expect(conflicts(f.table, f.tokens, f.rules)).not.toContain(
    'native-calibrated-source-cycles-merged'
  )
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function measuredHeadingLeaves(outside = false) {
  const f = fixture()
  f.add(0, 1, [['AA BB CC DD', 50, 30, 110]], 3)
  if (outside) f.cells.pop()
  for (const row of [1, 2, 3]) {
    f.add(row, 1, [['1.1 2.2', 50, 40 + row * 20, 50]])
    f.add(row, 2, [['3.3', 110, 40 + row * 20, 20]])
    f.add(row, 3, [['4.4', 140, 40 + row * 20, 20]])
  }
  for (const font of f.tokens)
    Object.assign(font, {
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [font.rect[0], font.baseline - 8, font.rect[2], font.baseline + 2]
    })
  const measuredRuns = f.tokens.map((font) => ({
    ...font,
    literalGlyphs: [...font.text.replace(/\s/gu, '')],
    glyphRuns: Array.from(font.text.replace(/\s/gu, ''), () => 1),
    gaps:
      font.text === 'AA BB CC DD'
        ? [2, 4, 6].map((index, n) => ({ index, left: 70 + n * 30, right: 80 + n * 30 }))
        : font.text === '1.1 2.2'
          ? [{ index: 3, left: 70, right: 80 }]
          : []
  }))
  return {
    ...f,
    measuredRuns,
    table: { ...f.table(), page: 1, cropRect: [0, outside ? 35 : 0, 200, 120], issues: [] },
    rules: [
      [0, 20, 200, 20],
      [0, 35, 200, 35],
      [0, 110, 200, 110]
    ]
  }
}

it.each([false, true])(
  'protects measured independent leaf headings with outside frame %s',
  (outside) => {
    const f = measuredHeadingLeaves(outside),
      before = structuredClone(f.table)
    expect(conflicts(f.table, f.tokens, f.rules, f.measuredRuns)).toContain(
      'native-measured-heading-leaf-collapse'
    )
    const checked = reviewFinalNativeTableSources(f.table, f.tokens, f.rules, f.measuredRuns)
    expect(checked.issues).toContain('native-table-structure-ambiguous')
    expect(checked.cells).toBe(f.table.cells)
    expect(checked.grid).toBe(f.table.grid)
    const nested = reviewFinalNativeTableSources(
      { parts: [f.table], cropRect: f.table.cropRect },
      f.tokens,
      f.rules,
      f.measuredRuns
    )
    expect(nested.parts[0].issues).toContain('native-table-structure-ambiguous')
    expect(nested.parts[0].cells).toBe(f.table.cells)
    expect(f.table).toEqual(before)
  }
)

it.each([
  'missing measurement',
  'duplicate measurement',
  'wrong glyph literal',
  'wrong gap',
  'missing adjacent divider',
  'only two records',
  'foreign full font'
])('does not infer measured leaf collapse with %s', (mode) => {
  const f = measuredHeadingLeaves()
  if (mode === 'missing measurement') f.measuredRuns.shift()
  if (mode === 'duplicate measurement') f.measuredRuns.push(structuredClone(f.measuredRuns[0]))
  if (mode === 'wrong glyph literal') f.measuredRuns[0].literalGlyphs[0] = 'Z'
  if (mode === 'wrong gap') f.measuredRuns[0].gaps[0].index++
  if (mode === 'missing adjacent divider') f.rules.splice(1, 1)
  if (mode === 'only two records') f.table.cells = f.table.cells.filter((c) => c.row < 3)
  if (mode === 'foreign full font') {
    const c = f.add(7, 0, [['Foreign', 75, 25, 2]])
    f.cells.pop()
    Object.assign(
      f.tokens.find((t) => t.sourceItem === c.sourceItems[0])!,
      { fontAscent: 0.8, fontDescent: -0.2, nativeLabelRect: [75, 17, 77, 27] }
    )
  }
  expect(conflicts(f.table, f.tokens, f.rules, f.measuredRuns)).not.toContain(
    'native-measured-heading-leaf-collapse'
  )
})

it.each(['shifted owner', 'correct owner', 'missing divider', 'foreign header font'])(
  'checks complete independently calibrated native heading lanes with %s',
  (mode) => {
    const f = calibratedNativeCycles()
    f.table.cropRect[3] = 250
    f.rules[0] = [0, 5, 200, 5]
    f.table.cells.find((c) => c.row === 3 && c.column === 0)!.sourceRects.reverse()
    if (mode !== 'correct owner') {
      const a = f.table.cells.find((c) => c.row === 0 && c.column === 0)!,
        b = f.table.cells.find((c) => c.row === 0 && c.column === 1)!
      a.column = 1
      b.column = 0
    }
    if (mode === 'missing divider') f.rules.splice(1, 1)
    if (mode === 'foreign header font') {
      const c = f.add(8, 0, [['Foreign', 70, 20, 20]])
      f.cells.pop()
      Object.assign(
        f.tokens.find((t) => t.sourceItem === c.sourceItems[0])!,
        {
          fontAscent: 0.8,
          fontDescent: -0.2,
          nativeLabelRect: [70, 12, 90, 22]
        }
      )
    }
    const found = conflicts(f.table, f.tokens, f.rules)
    if (mode === 'shifted owner') {
      expect(found).toContain('native-heading-assigned-to-foreign-lane')
      const checked = reviewFinalNativeTableSources(f.table, f.tokens, f.rules)
      expect(checked.issues).toContain('native-table-structure-ambiguous')
      expect(checked.cells).toBe(f.table.cells)
      expect(checked.cropRect).toBe(f.table.cropRect)
    } else expect(found).not.toContain('native-heading-assigned-to-foreign-lane')
  }
)
