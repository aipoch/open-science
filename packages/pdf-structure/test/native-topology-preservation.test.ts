import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { readWorkerResult } from '../src/worker-result.js'
import { resolve } from './paths'

const { recoverNativeScalarRecordPlan } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-scalar-record-grid.mjs')).href
)
const { recoverNativeTextRecordGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-text-record-grid.mjs')).href
)
const { nativeTableSourceConflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const columnFixture = (fused: boolean): Fixture => {
  const items: Fixture[] = [],
    add = (text: string, left: number, right: number, baseline: number): void => {
      items.push({
        text,
        rect: [left, baseline - 10, right, baseline],
        height: 10,
        baseline,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: items.length, text }
      })
    }
  if (fused) {
    add('Index Label', 10, 65, 22)
    add('Score Settings', 150, 260, 22)
  } else {
    add('Group', 10, 50, 22)
    add('Value', 100, 125, 22)
    add('Interval', 145, 195, 22)
    add('Rate', 250, 280, 22)
  }
  for (let row = 0; row < 3; row++) {
    const y = 40 + row * 15
    if (fused) {
      add(String(row), 10, 16, y)
      add('Mode ' + String.fromCharCode(65 + row), 30, 100, y)
      add('-0.' + (row + 2), 160, 180, y)
      add('k=' + (row + 1), 220, 280, y)
    } else {
      add('Set ' + String.fromCharCode(65 + row), 10, 50, y)
      add('0.' + (row + 2), 100, 120, y)
      add('[0.1,0.8]', 145, 220, y)
      add('0.9', 250, 270, y)
    }
  }
  const cuts = fused ? [0, 22, 130, 200, 300] : [0, 80, 135, 235, 300]
  return {
    items,
    table: {
      cropRect: [0, 5, 300, 85],
      structure: {
        objects: [
          ...cuts.slice(1).map((right, n) => ({
            label: 'table column',
            score: 0.99,
            rect: [cuts[n], 0, right, 80]
          })),
          ...[0, 1, 2].map((n) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, n * 25, 300, (n + 1) * 25]
          }))
        ]
      }
    },
    captions: [{ lines: ['Table 1: Measurements'], rect: [0, 86, 300, 96] }],
    rules: [
      [0, 10, 300, 10],
      [0, 25, 300, 25],
      [0, 80, 300, 80]
    ]
  }
}

const ordinaryHeaderFixture = (): Fixture => {
  const f = columnFixture(false)
  f.items[0].text = 'Kind'
  f.items[0].sourceItem.text = 'Kind'
  f.items[0].rect[2] = 28
  f.items[1].text = 'Value label'
  f.items[1].sourceItem.text = 'Value label'
  f.items[1].rect[0] = 80
  f.items.push({
    ...f.items[0],
    text: 'Mode',
    rect: [40, 12, 65, 22],
    sourceItem: { pageNumber: 1, index: 100, text: 'Mode' }
  })
  for (let row = 0; row < 3; row++) {
    const first = f.items[4 + row * 4],
      text = String.fromCharCode(65 + row)
    first.text = text
    first.sourceItem.text = text
    first.rect[2] = 16
    f.items.push({
      ...first,
      text: 'Mode ' + text,
      rect: [40, first.rect[1], 65, first.rect[3]],
      sourceItem: { pageNumber: 1, index: 101 + row, text: 'Mode ' + text }
    })
  }
  const cuts = [0, 32, 90, 135, 235, 300]
  f.table.structure.objects = [
    ...f.table.structure.objects.filter((o: Fixture) => o.label !== 'table column'),
    ...cuts
      .slice(1)
      .map((right, n) => ({ label: 'table column', score: 0.99, rect: [cuts[n], 0, right, 80] }))
  ]
  return f
}

it('retains complete ordinary row recovery and the independently headed interval leaf', () => {
  const f = ordinaryHeaderFixture(),
    before = structuredClone(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toHaveLength(5)
  expect(result.repairs).toContain('native-body-records-recovered')
  expect(result.grid[0]).toEqual(['Kind', 'Mode', 'Value label', 'Interval', 'Rate'])
  expect(f).toEqual(before)
})

it('still protects a model leaf when its printed header consists of separate whole fragments', () => {
  const f = columnFixture(false),
    original = f.items[1]
  f.items.splice(
    1,
    1,
    {
      ...original,
      text: 'Va',
      rect: [100, 12, 111, 22],
      sourceItem: { pageNumber: 1, index: 100, text: 'Va' }
    },
    {
      ...original,
      text: 'lue',
      rect: [112, 12, 125, 22],
      sourceItem: { pageNumber: 1, index: 101, text: 'lue' }
    }
  )
  expect(recoverNativeScalarRecordPlan(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('does not exempt nonunique header sources from the independent-leaf guard', () => {
  const f = columnFixture(false)
  f.items[1].sourceItem.index = f.items[2].sourceItem.index
  expect(recoverNativeScalarRecordPlan(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('retains a scalar with its interval when the whole heading supplies no independent leaf cut', () => {
  const f = columnFixture(false),
    heading = f.items[1]
  heading.text = 'Value interval'
  heading.sourceItem.text = heading.text
  heading.rect[2] = f.items[2].rect[2]
  f.items.splice(2, 1)
  expect(
    recoverNativeScalarRecordPlan(f.table, f.items, f.captions, f.rules)?.grid.columns
  ).toHaveLength(3)
})

it('does not replace complete repeated native leaves with two fused headings', () => {
  const f = columnFixture(true),
    before = structuredClone(f)
  expect(recoverNativeTextRecordGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(before)
})

it('retains source record recovery when whole body packets do not prove the model leaves', () => {
  const f = columnFixture(true)
  for (let row = 0; row < 3; row++) {
    const at = 2 + row * 2,
      a = f.items[at],
      b = f.items[at + 1],
      c = f.items[at + 2],
      d = f.items[at + 3]
    a.text += ' ' + b.text
    a.sourceItem.text = a.text
    a.rect[2] = b.rect[2]
    c.text += ' ' + d.text
    c.sourceItem.text = c.text
    c.rect[2] = d.rect[2]
    f.items.splice(at, 4, a, c)
  }
  expect(recoverNativeTextRecordGrid(f.table, f.items, f.captions, f.rules)?.columns).toHaveLength(
    2
  )
})

const scientificRows = (): Fixture => {
  const items: Fixture[] = [],
    cells: Fixture[] = [],
    add = (text: string, x: number, baseline: number, height = 10, width = 20): Fixture => {
      const f = {
        text,
        rect: [x, baseline - height, x + width, baseline],
        height,
        baseline,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: items.length, text }
      }
      items.push(f)
      return f
    }
  for (let column = 0; column < 3; column++) {
    const fonts: Fixture[] = []
    for (let line = 0; line < 2; line++) {
      const y = 40 + line * 15
      if (column < 2) fonts.push(add(column ? '0.' + (line + 2) : String(line + 2), column * 70, y))
      else {
        fonts.push(add(line + 2 + '.0 × 10', 140, y, 10, 40))
        fonts.push(add('−3', 180, y - 5, 6.6, 8))
      }
    }
    cells.push({
      row: 1,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: fonts.map((f) => f.text).join(' '),
      sourceItems: fonts.map((f) => f.sourceItem),
      sourceRects: fonts.map((f) => f.rect)
    })
  }
  return {
    items,
    table: { cells, grid: [[], cells.map((c) => c.text)], cropRect: [0, 20, 200, 70] }
  }
}

it('flags synchronous collapsed numeric rows when a third leaf has fully attached exponents', () => {
  const f = scientificRows(),
    before = structuredClone(f)
  expect(nativeTableSourceConflicts(f.table, f.items)).toContain('collapsed-numeric-records')
  expect(f).toEqual(before)
})

it.each(['detached exponent', 'zero advance exponent', 'ordinary prose', 'missing native source'])(
  'does not count unsupported scientific lines as an independent numeric leaf: %s',
  (mode) => {
    const f = scientificRows()
    if (mode === 'detached exponent') f.items.at(-1).rect[0] += 5
    if (mode === 'zero advance exponent') f.items.at(-1).rect[2] = f.items.at(-1).rect[0]
    if (mode === 'ordinary prose') {
      f.items.at(-2).text = 'ordinary prose'
      f.items.at(-2).sourceItem.text = 'ordinary prose'
      f.table.cells[2].text = f.items
        .slice(4)
        .map((font: Fixture) => font.text)
        .join(' ')
    }
    if (mode === 'missing native source') f.items.pop()
    expect(nativeTableSourceConflicts(f.table, f.items)).not.toContain('collapsed-numeric-records')
  }
)

const { nativeTableLayoutConflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)
const { reviewFinalNativeTableSources, retainNativeCenteredRecordGraphic } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)

const topologyFixture = (): Fixture => ({
  items: [],
  table: {
    page: 1,
    cropRect: [0, 5, 350, 150],
    grid: [],
    cells: [],
    issues: [],
    reviewCandidate: true
  },
  rules: []
})
const topologyOwner = (
  f: Fixture,
  row: number,
  column: number,
  parts: [string, number, number, number?, number?][]
): void => {
  const fonts = parts.map(([text, x, y, height = 10, width = 35]) => {
    const font = {
      text,
      rect: [x, y - height, x + width, y],
      height,
      baseline: y,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: f.items.length, text }
    }
    f.items.push(font)
    return font
  })
  const text = fonts.map((p: Fixture) => p.text).join(' ')
  f.table.grid[row] ??= []
  f.table.grid[row][column] = text
  f.table.cells.push({
    row,
    column,
    rowSpan: 1,
    colSpan: 1,
    text,
    sourceItems: fonts.map((p: Fixture) => p.sourceItem),
    sourceRects: fonts.map((p: Fixture) => p.rect)
  })
}
const topologyContext = (f: Fixture): Fixture => ({
  viewport: { transform: [1, 0, 0, -1, 0, 400] },
  sourceContent: {
    items: f.items.map((p: Fixture) => ({
      str: p.text,
      dir: 'ltr',
      fontName: 'body',
      transform: [p.height, 0, 0, p.height, p.rect[0], 400 - p.baseline],
      width: p.rect[2] - p.rect[0],
      height: p.height
    })),
    styles: { body: { ascent: 0.8, descent: -0.2, vertical: false } }
  }
})
const wrappedParagraphOwners = (): Fixture => {
  const f = topologyFixture()
  for (let c = 0; c < 3; c++) topologyOwner(f, 0, c, [['Heading', 10 + 110 * c, 22]])
  const lines = [
    ['Shared label', 'continuation'],
    ['Independent trans-', 'mission block.'],
    ['Another repre-', 'sentation block.']
  ]
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 2; r++)
      topologyOwner(f, r + 1, c, [[lines[c][r], 10 + 110 * c, 40 + 12 * r]])
  f.rules = [[0, 28, 350, 28]]
  return f
}

it('preserves whole native paragraphs and their image while declining split wrapped-word rows', () => {
  const f = wrappedParagraphOwners(),
    before = structuredClone(f),
    checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each([
  'single column',
  'short sentences',
  'missing source',
  'foreign source',
  'divider',
  'font change'
])('does not claim a paired native paragraph contradiction from %s', (mode) => {
  const f = wrappedParagraphOwners()
  if (mode === 'single column' || mode === 'short sentences') {
    for (const p of f.items.filter((p: Fixture) => p.text.endsWith('-'))) {
      if (mode === 'single column' && p.sourceItem.index === 5) continue
      p.text = p.sourceItem.text = p.text.slice(0, -1)
      const cell = f.table.cells.find((c: Fixture) => c.sourceItems.includes(p.sourceItem))
      cell.text = p.text
      f.table.grid[cell.row][cell.column] = cell.text
    }
  }
  const context = topologyContext(f)
  if (mode === 'missing source') f.items.pop()
  if (mode === 'foreign source') {
    const text = 'Foreign'
    f.items.push({
      text,
      horizontal: true,
      height: 5,
      baseline: 45,
      rect: [50, 40, 60, 45],
      sourceItem: { pageNumber: 1, index: f.items.length, text }
    })
  }
  if (mode === 'divider') f.rules.push([0, 45, 350, 45])
  if (mode === 'font change') {
    context.sourceContent.styles.other = { ascent: 0.8, descent: -0.2, vertical: false }
    context.sourceContent.items[8].fontName = 'other'
  }
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).not.toContain(
    'native-paired-wrapped-words-split'
  )
})

const dashedLeafOwners = (): Fixture => {
  const f = topologyFixture()
  for (let r = 0; r < 4; r++) {
    const y = 22 + r * 18
    topologyOwner(f, r, 0, [[r ? String(r) : 'Index', 10, y]])
    topologyOwner(f, r, 1, [[String(r + 2), 80, y, 10, 10]])
    topologyOwner(f, r, 2, [[String(r + 3), 150, y, 10, 10]])
    topologyOwner(f, r, 3, [
      [r ? (r === 3 ? '8' : '—') : '4', 220, y, 10, 10],
      [r ? (r === 3 ? '1' : '—') : '5', 250, y, 10, 10]
    ])
  }
  return f
}
it('retains dash placeholders as evidence of two independently headed native value leaves', () => {
  const f = dashedLeafOwners(),
    before = structuredClone(f)
  const checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})
it('does not infer two value leaves from an unsupported single native heading', () => {
  const f = dashedLeafOwners(),
    h = f.table.cells.find((c: Fixture) => c.row === 0 && c.column === 3)
  h.sourceItems = h.sourceItems.slice(0, 1)
  h.sourceRects = h.sourceRects.slice(0, 1)
  h.text = f.table.grid[0][3] = h.sourceItems[0].text
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules)).not.toContain(
    'numeric-headed-terminal-lanes-collapsed'
  )
})

const symbolPacketOwners = (): Fixture => {
  const f = topologyFixture()
  for (let c = 0; c < 4; c++) topologyOwner(f, 0, c, [['Heading', 10 + 85 * c, 22]])
  const collected: Fixture[][] = [[], [], [], []]
  for (let n = 0; n < 3; n++) {
    const y = 45 + n * 15
    for (const [c, parts] of [
      [0, [[['α', 'β', 'q'][n], 10, y, 10, 6]]],
      [1, [['Independent description', 70, y, 10, 100]]],
      [2, [[n ? 'Tunable' : '[1,2]', 210, y, 10, 35]]],
      [3, [[n ? '–' : '[3,4]', 280, y, 10, 35]]]
    ] as [number, [string, number, number, number, number][]][]) {
      topologyOwner(f, 1, c, parts)
      collected[c].push(f.table.cells.pop())
    }
  }
  for (let c = 0; c < 4; c++) {
    const cells = collected[c],
      text = cells.map((p) => p.text).join(' ')
    f.table.grid[1][c] = text
    f.table.cells.push({
      row: 1,
      column: c,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceItems: cells.flatMap((p) => p.sourceItems),
      sourceRects: cells.flatMap((p) => p.sourceRects)
    })
  }
  return f
}
it('declines a merged row containing complete independent symbol and value/reference packets', () => {
  const f = symbolPacketOwners(),
    before = structuredClone(f)
  const checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})
it.each(['multiline prose', 'explicit row span'])(
  'does not call independent symbol packets from %s',
  (mode) => {
    const f = symbolPacketOwners()
    if (mode === 'multiline prose') {
      const cell = f.table.cells.find((c: Fixture) => c.row === 1 && c.column === 0)
      for (const o of cell.sourceItems) {
        const font = f.items.find((p: Fixture) => p.sourceItem === o)
        font.text = o.text = 'ordinary prose'
      }
      cell.text = f.table.grid[1][0] = cell.sourceItems.map((o: Fixture) => o.text).join(' ')
    } else {
      f.table.grid.push(['', '', '', ''], ['', '', '', ''])
      for (const cell of f.table.cells.filter((c: Fixture) => c.row === 1)) cell.rowSpan = 3
    }
    expect(
      nativeTableLayoutConflicts(f.table, f.items, f.rules, [], topologyContext(f))
    ).not.toContain('native-independent-symbol-records-merged')
  }
)

const attachedSuffixOwners = (): Fixture => {
  const f = topologyFixture()
  topologyOwner(f, 0, 0, [['Formula', 10, 22]])
  topologyOwner(f, 0, 1, [['Value', 150, 22]])
  topologyOwner(f, 1, 0, [
    ['X', 10, 50, 10, 6],
    ['small', 16.1, 52, 7, 14],
    ['→', 35, 50, 10, 8],
    ['X', 48, 50, 10, 6]
  ])
  f.table.cells.at(-1).textRuns = [
    { text: 'X', position: 'normal' },
    { text: 'small', position: 'subscript' },
    { text: '→ X', position: 'normal' }
  ]
  topologyOwner(f, 1, 1, [
    ['large', 54.1, 52, 7, 14],
    ['0.4', 150, 50, 10, 20]
  ])
  return f
}

it('retains whole native sources and declines a suffix split from its repeated mathematical base', () => {
  const f = attachedSuffixOwners(),
    before = structuredClone(f),
    checked = reviewFinalNativeTableSources(f.table, f.items, [], [], topologyContext(f))
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], topologyContext(f))).toContain(
    'native-attached-suffix-crosses-cell'
  )
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each(['correct owner', 'missing prefix script', 'unknown native font'])(
  'does not infer a split mathematical suffix without complete role evidence: %s',
  (mode) => {
    const f = attachedSuffixOwners(),
      left = f.table.cells.find((c: Fixture) => c.row === 1 && c.column === 0),
      right = f.table.cells.find((c: Fixture) => c.row === 1 && c.column === 1)
    if (mode === 'correct owner') {
      left.sourceItems.push(right.sourceItems.shift())
      left.sourceRects.push(right.sourceRects.shift())
      left.text += ' large'
      right.text = '0.4'
      f.table.grid[1] = [left.text, right.text]
    }
    if (mode === 'missing prefix script') delete left.textRuns
    const context = topologyContext(f)
    if (mode === 'unknown native font') delete context.sourceContent.styles.body.ascent
    expect(nativeTableLayoutConflicts(f.table, f.items, [], [], context)).not.toContain(
      'native-attached-suffix-crosses-cell'
    )
  }
)

const measuredTailOwners = (): Fixture => {
  const f = topologyFixture()
  topologyOwner(f, 0, 0, [['Spread', 180, 22, 10, 25]])
  topologyOwner(f, 0, 1, [['Duration', 230, 22, 10, 35]])
  topologyOwner(f, 1, 0, [['0.12 3 min', 180, 50, 10, 85]])
  f.table.cells.push({
    row: 1,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    sourceItems: [],
    sourceRects: []
  })
  f.table.grid[1][1] = ''
  topologyOwner(f, 2, 0, [['0.14', 180, 70, 10, 30]])
  topologyOwner(f, 2, 1, [['19 s', 230, 70, 10, 35]])
  f.items.push({
    text: 'Outside paragraph',
    rect: [10, 8, 90, 18],
    height: 10,
    baseline: 18,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: f.items.length, text: 'Outside paragraph' }
  })
  const measured = (index: number, cuts: [number, number, number][]): Fixture => {
    const font = f.items[index]
    return {
      ...font,
      literalGlyphs: Array.from(font.text.replace(/\s/gu, '')),
      glyphRuns: Array.from(font.text.replace(/\s/gu, ''), () => 0),
      gaps: cuts.map(([index, left, right]) => ({ index, left, right }))
    }
  }
  for (const font of f.items) font.nativeLabelRect = font.rect
  return {
    ...f,
    measured: [
      measured(2, [
        [4, 210, 230],
        [5, 237, 240]
      ]),
      measured(3, []),
      measured(4, [[2, 244, 250]])
    ]
  }
}

it('declines a measured whole source consuming a separately headed and independently populated native lane', () => {
  const f = measuredTailOwners(),
    before = structuredClone(f),
    context = topologyContext(f)
  expect(nativeTableLayoutConflicts(f.table, f.items, [], f.measured, context)).toContain(
    'native-measured-source-crosses-header-lanes'
  )
  const checked = reviewFinalNativeTableSources(f.table, f.items, [], f.measured, context)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each([
  'missing peer',
  'missing header',
  'measured gap missing',
  'foreign role band',
  'unknown font'
])('requires complete measured sources and an exclusive native lane role band: %s', (mode) => {
  const f = measuredTailOwners()
  if (mode === 'missing peer' || mode === 'missing header') {
    const row = mode === 'missing peer' ? 2 : 0,
      c = f.table.cells.find((c: Fixture) => c.row === row && c.column === 1)
    c.sourceItems = []
    c.sourceRects = []
    c.text = ''
    f.table.grid[row][1] = ''
  }
  if (mode === 'measured gap missing') f.measured[0].gaps.pop()
  if (mode === 'foreign role band') {
    const p = f.items.at(-1)
    p.rect = [220, 40, 225, 50]
    p.baseline = 50
  }
  const context = topologyContext(f)
  if (mode === 'unknown font') delete context.sourceContent.styles.body.ascent
  expect(nativeTableLayoutConflicts(f.table, f.items, [], f.measured, context)).not.toContain(
    'native-measured-source-crosses-header-lanes'
  )
})

it('leaves paragraph ownership unchanged when original native font facts are incomplete', () => {
  for (const mode of ['missing metrics', 'height mismatch', 'rtl']) {
    const f = wrappedParagraphOwners(),
      context = topologyContext(f)
    if (mode === 'missing metrics')
      context.sourceContent.styles.body.ascent = context.sourceContent.styles.body.descent = 0
    if (mode === 'height mismatch') context.sourceContent.items[5].height = 9
    if (mode === 'rtl') context.sourceContent.items[5].dir = 'rtl'
    expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).not.toContain(
      'native-paired-wrapped-words-split'
    )
  }
})

it('excludes foreign native font envelopes outside the nominal paragraph token box', () => {
  const f = wrappedParagraphOwners(),
    text = 'Foreign'
  f.items.push({
    text,
    horizontal: true,
    height: 5,
    baseline: 65,
    rect: [50, 60, 60, 65],
    sourceItem: { pageNumber: 1, index: f.items.length, text }
  })
  const context = topologyContext(f)
  context.sourceContent.styles.wide = { ascent: 3, descent: -0.2, vertical: false }
  context.sourceContent.items.at(-1).fontName = 'wide'
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).not.toContain(
    'native-paired-wrapped-words-split'
  )
})

const pairedStubOwners = (): Fixture => {
  const f = topologyFixture()
  f.table.cropRect = [0, 5, 440, 170]
  for (let c = 0; c < 4; c++) topologyOwner(f, 0, c, [['Heading', 10 + 110 * c, 22]])
  for (let group = 0; group < 4; group++) {
    const row = 1 + group * 2,
      baseline = 40 + group * 32
    topologyOwner(f, row, 0, [['Mode ' + String.fromCharCode(65 + group), 10, baseline + 6]])
    const stub = f.table.cells.at(-1)
    if (group < 3) stub.rowSpan = 2
    else {
      f.table.grid[row + 1] = ['']
      f.table.cells.push({
        row: row + 1,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '',
        sourceItems: [],
        sourceRects: []
      })
    }
    for (let line = 0; line < 2; line++)
      for (let c = 1; c < 4; c++)
        topologyOwner(f, row + line, c, [
          [
            c === 1 ? (line ? 'Adjusted' : 'Initial') : String(c + line / 10),
            10 + 110 * c,
            baseline + 12 * line
          ]
        ])
  }
  f.rules = [[0, 28, 440, 28]]
  return f
}

it('preserves complete native table sources while declining an inconsistent repeated two-row stub', () => {
  const f = pairedStubOwners(),
    before = structuredClone(f),
    checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each(['valid spans', 'missing witness', 'divider', 'foreign font envelope'])(
  'requires the complete repeated native stub certificate: %s',
  (mode) => {
    const f = pairedStubOwners()
    if (mode === 'valid spans') {
      f.table.cells.find((c: Fixture) => c.row === 7 && c.column === 0).rowSpan = 2
      f.table.cells = f.table.cells.filter((c: Fixture) => c.row !== 8 || c.column !== 0)
    }
    if (mode === 'missing witness') f.items.splice(5, 1)
    if (mode === 'divider') f.rules.push([0, 142, 440, 142])
    if (mode === 'foreign font envelope') {
      const text = 'Foreign'
      f.items.push({
        text,
        rect: [50, 158, 60, 163],
        height: 5,
        baseline: 163,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: f.items.length, text }
      })
    }
    const context = topologyContext(f)
    if (mode === 'foreign font envelope') {
      context.sourceContent.styles.wide = { ascent: 5, descent: -0.2, vertical: false }
      context.sourceContent.items.at(-1).fontName = 'wide'
    }
    expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).not.toContain(
      'native-repeated-two-row-stub-inconsistent'
    )
  }
)
const duplicatedParentOwners = (): Fixture => {
  const f = topologyFixture()
  topologyOwner(f, 0, 0, [['Group', 10, 22]])
  topologyOwner(f, 0, 1, [['A', 120, 22, 10, 12]])
  f.table.cells.at(-1).colSpan = 2
  topologyOwner(f, 1, 0, [['Record', 10, 36]])
  topologyOwner(f, 1, 1, [['p', 120, 36, 10, 10]])
  const child = f.table.cells.at(-1)
  child.sourceItems.unshift(f.items[1].sourceItem)
  child.sourceRects.unshift(f.items[1].rect)
  child.text = 'A p'
  topologyOwner(f, 1, 2, [['q', 220, 36, 10, 10]])
  f.table.grid = [
    ['Group', 'A', ''],
    ['Record', 'A p', 'q']
  ]
  return f
}

it('retains complete source and image geometry when a spanning parent and leaf claim the same whole native header', () => {
  const f = duplicatedParentOwners(),
    before = structuredClone(f),
    checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each([
  'valid parent span',
  'same-cell repeat',
  'measured claim',
  'duplicate inventory',
  'invalid column'
])(
  'declines a duplicated parent-source contradiction without the complete certificate: %s',
  (mode) => {
    const f = duplicatedParentOwners(),
      parent = f.table.cells.find((c: Fixture) => c.row === 0 && c.column === 1),
      child = f.table.cells.find((c: Fixture) => c.row === 1 && c.column === 1)
    if (mode === 'valid parent span' || mode === 'same-cell repeat') {
      child.sourceItems.shift()
      child.sourceRects.shift()
      child.text = f.table.grid[1][1] = 'p'
    }
    if (mode === 'same-cell repeat') {
      parent.sourceItems.push(parent.sourceItems[0])
      parent.sourceRects.push(parent.sourceRects[0])
      parent.text = f.table.grid[0][1] = 'A A'
    }
    if (mode === 'measured claim') child.sourceSegments = []
    if (mode === 'duplicate inventory') f.items.push(structuredClone(f.items[1]))
    if (mode === 'invalid column') child.column = NaN
    expect(
      nativeTableLayoutConflicts(f.table, f.items, f.rules, [], topologyContext(f))
    ).not.toContain('native-parent-source-duplicated-in-leaf')
  }
)

const ruledTerminalOwners = (): Fixture => {
  const f = topologyFixture()
  f.table.cropRect = [0, 5, 430, 95]
  topologyOwner(f, 0, 0, [['Name', 10, 22]])
  topologyOwner(f, 0, 1, [
    ['Grouped', 220, 22, 10, 60],
    ['Aggregate', 380, 22, 10, 20]
  ])
  f.table.cells.at(-1).colSpan = 3
  for (const [column, text, x, width] of [
    [0, 'Label', 10, 35],
    [1, 'Low', 220, 20],
    [2, 'High', 270, 20],
    [3, 'Value', 300, 50]
  ] as [number, string, number, number][])
    topologyOwner(f, 1, column, [[text, x, 42, 10, width]])
  for (let row = 2; row < 4; row++) {
    const y = 64 + (row - 2) * 14
    topologyOwner(f, row, 0, [['Mode ' + String.fromCharCode(63 + row), 10, y]])
    topologyOwner(f, row, 1, [[String(row), 220, y, 10, 20]])
    topologyOwner(f, row, 2, [[String(row + 1), 270, y, 10, 20]])
    topologyOwner(f, row, 3, [
      [String(row + 2), 330, y, 10, 20],
      [String(row + 3), 380, y, 10, 20]
    ])
  }
  f.table.grid[0] = ['Name', 'Grouped Aggregate', '', '']
  f.rules = [[210, 28, 351, 28]]
  const context = topologyContext(f)
  context.viewport = { ...context.viewport, width: 450, height: 400, scale: 1, rotation: 0 }
  context.operators = {
    fnArray: [58, 2, 3, 91],
    argsArray: [['#000000'], [1], [0], [20, [[0, 210, 372, 1, 351, 372]], [210, 372, 351, 372]]]
  }
  context.rulePaintBounds = new Map([[f.rules[0].join(','), [210, 27.5, 351, 28.5]]])
  context.nativePaintIdentityGraphics = [
    { kind: 'path', operationIndex: 3, rect: [205, 23, 356, 33] }
  ]
  return { ...f, context }
}

it('keeps the original grid and source when a printed native header group proves two scalar lanes inside one cell', () => {
  const f = ruledTerminalOwners(),
    before = structuredClone(f),
    checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], f.context)
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], f.context)).toContain(
    'native-ruled-header-value-lanes-collapsed'
  )
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})

it.each([
  'no independent heading',
  'missing native paint',
  'white rule',
  'transparent rule',
  'foreign covering paint',
  'unbound foreign text',
  'unknown paint state'
])(
  'requires the complete printed native group boundary before declining scalar mapping: %s',
  (mode) => {
    const f = ruledTerminalOwners()
    if (mode === 'no independent heading') {
      const c = f.table.cells.find((c: Fixture) => c.row === 0 && c.column === 1)
      c.sourceItems.pop()
      c.sourceRects.pop()
      c.text = f.table.grid[0][1] = 'Grouped'
    }
    if (mode === 'unbound foreign text')
      f.items.push({
        text: 'Foreign',
        horizontal: true,
        height: 5,
        baseline: 30,
        rect: [250, 25, 260, 30]
      })
    if (mode === 'missing native paint') f.context.rulePaintBounds.clear()
    if (mode === 'white rule') f.context.operators.argsArray[0] = ['#ffffff']
    if (mode === 'transparent rule' || mode === 'unknown paint state') {
      f.context.operators.fnArray.splice(3, 0, 9)
      f.context.operators.argsArray.splice(3, 0, [
        [mode === 'transparent rule' ? ['CA', 0] : ['SMask', {}]]
      ])
      f.context.nativePaintIdentityGraphics[0].operationIndex++
    }
    if (mode === 'foreign covering paint') {
      f.context.operators.fnArray.push(91)
      f.context.operators.argsArray.push([
        22,
        [[0, 210, 372, 1, 351, 372, 1, 351, 373, 1, 210, 373, 4]],
        [210, 372, 351, 373]
      ])
      f.context.nativePaintIdentityGraphics.push({
        kind: 'path',
        operationIndex: 4,
        rect: [210, 27, 351, 28]
      })
    }
    expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], f.context)).not.toContain(
      'native-ruled-header-value-lanes-collapsed'
    )
  }
)

const fusedTupleWall = (): Fixture => {
  const f = topologyFixture()
  for (let c = 0; c < 3; c++) topologyOwner(f, 0, c, [['Field', 10 + c * 100, 22]])
  topologyOwner(f, 1, 0, [['1', 10, 50, 10, 6]])
  topologyOwner(f, 1, 1, [['(−2,0,1', 110, 50, 10, 42]])
  topologyOwner(f, 1, 2, [
    [') (', 152, 50, 10, 16],
    ['−1,0,2)', 168, 50, 10, 44]
  ])
  f.rules = [[160, 40, 160, 53]]
  return f
}
it('withdraws a whole native punctuation run claimed across a real tuple-cell wall', () => {
  const f = fusedTupleWall(),
    before = structuredClone(f)
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], topologyContext(f))).toContain(
    'native-fused-tuple-crosses-cell-wall'
  )
  const checked = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], topologyContext(f))
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect({ ...checked, issues: [], reviewCandidate: true }).toEqual(f.table)
  expect(f).toEqual(before)
})
it('checks the tuple source packet despite an adjacent record font envelope', () => {
  const f = fusedTupleWall(),
    context = topologyContext(f)
  context.sourceContent.items.push({
    ...context.sourceContent.items.at(-1),
    str: 'Adjacent',
    transform: [10, 0, 0, 10, 130, 361.5]
  })
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).toContain(
    'native-fused-tuple-crosses-cell-wall'
  )
})
it.each([
  'no wall',
  'outside baseline',
  'ordinary statistic',
  'missing source',
  'stale native content',
  'stale owner bounds',
  'duplicate claim',
  'unclaimed native item'
])('does not infer a tuple-wall contradiction from %s', (mode) => {
  const f = fusedTupleWall()
  if (mode === 'no wall') f.rules = []
  if (mode === 'outside baseline') f.rules = [[160, 5, 160, 20]]
  if (mode === 'ordinary statistic') {
    const atom = f.items.find((i: Fixture) => i.text === ') (')
    atom.text = atom.sourceItem.text = '(2.5)'
    f.table.cells.at(-1).sourceItems[0].text = '(2.5)'
    f.table.cells.at(-1).text = '(2.5) −1,0,2)'
  }
  if (mode === 'missing source') f.items.pop()
  if (mode === 'stale owner bounds') {
    const cell = f.table.cells.at(-1)
    cell.sourceRects[0] = [...cell.sourceRects[0]]
    cell.sourceRects[0][0]++
  }
  if (mode === 'duplicate claim') f.table.cells[1].sourceItems.push(f.items.at(-1).sourceItem)
  const context = topologyContext(f)
  if (mode === 'stale native content') context.sourceContent.items.at(-1).str = 'Changed'
  if (mode === 'unclaimed native item') {
    // Deliberately absent from the supplied inventory: closure must inspect
    // the original native content, not trust the cell claims as complete.
    context.sourceContent.items.push({
      ...context.sourceContent.items.at(-1),
      str: 'Foreign',
      transform: [10, 0, 0, 10, 140, 350]
    })
  }
  expect(nativeTableLayoutConflicts(f.table, f.items, f.rules, [], context)).not.toContain(
    'native-fused-tuple-crosses-cell-wall'
  )
})

const sectionedPairRows = (cellMajor = false, rightAligned = false): Fixture => {
  const f = topologyFixture()
  for (let c = 0; c < 3; c++) topologyOwner(f, 0, c, [['Heading', 10 + c * 100, 22]])
  topologyOwner(f, 1, 0, [['Controls', 10, 40]])
  f.table.cells.at(-1).colSpan = 3
  f.table.grid[1] = ['Controls', '', '']
  const parts: Fixture[][] = [[], []]
  const add = (c: number, n: number): void => {
    const width = rightAligned && c === 1 && n === 1 ? 24 : 35
    topologyOwner(f, 2, c + 1, [
      [
        c ? ['ModeA', '0.02'][n] : ['Procedure', 'Step size'][n],
        145 + c * 100 - width,
        55 + n * 12,
        10,
        width
      ]
    ])
    parts[c].push(f.table.cells.pop())
  }
  if (cellMajor) for (let c = 0; c < 2; c++) for (let n = 0; n < 2; n++) add(c, n)
  else for (let n = 0; n < 2; n++) for (let c = 0; c < 2; c++) add(c, n)
  topologyOwner(f, 2, 0, [])
  for (let c = 0; c < 2; c++) {
    const text = parts[c].map((p) => p.text).join(' ')
    f.table.grid[2][c + 1] = text
    f.table.cells.push({
      row: 2,
      column: c + 1,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceItems: parts[c].flatMap((p) => p.sourceItems),
      sourceRects: parts[c].flatMap((p) => p.sourceRects)
    })
  }
  for (let row = 3; row < 5; row++) {
    topologyOwner(f, row, 0, [])
    topologyOwner(f, row, 1, [['Parameter ' + row, 110, 80 + 12 * (row - 3)]])
    topologyOwner(f, row, 2, [['0.' + row, 210, 80 + 12 * (row - 3)]])
  }
  return f
}
it.each([false, true])(
  'declines two complete row-major label/value records hidden in one category row (right aligned: %s)',
  (rightAligned) => {
    const f = sectionedPairRows(false, rightAligned)
    expect(nativeTableLayoutConflicts(f.table, f.items, [], [], topologyContext(f))).toContain(
      'native-section-label-value-records-merged'
    )
  }
)
it('preserves ordinary cell-major wrapped fields under a category heading', () => {
  const f = sectionedPairRows(true)
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], topologyContext(f))).not.toContain(
    'native-section-label-value-records-merged'
  )
})
it.each(['missing category span', 'one peer', 'stale native content', 'crossed baseline'])(
  'declines no paired-record claim without its complete native witnesses: %s',
  (mode) => {
    const f = sectionedPairRows()
    if (mode === 'missing category span')
      f.table.cells.find((c: Fixture) => c.row === 1).colSpan = 1
    if (mode === 'one peer') f.table.cells = f.table.cells.filter((c: Fixture) => c.row !== 4)
    const context = topologyContext(f),
      owner = f.table.cells.find((c: Fixture) => c.row === 2 && c.column === 2),
      index = owner.sourceItems[0].index
    if (mode === 'stale native content') context.sourceContent.items[index].str = 'Changed'
    if (mode === 'crossed baseline') context.sourceContent.items[index].transform[5]++
    expect(nativeTableLayoutConflicts(f.table, f.items, [], [], context)).not.toContain(
      'native-section-label-value-records-merged'
    )
  }
)

const mergedGroupHeading = (): Fixture => {
  const f = topologyFixture()
  for (let c = 0; c < 4; c++) topologyOwner(f, 0, c, [['Heading', 10 + c * 80, 22]])
  topologyOwner(f, 1, 0, [['First group', 10, 40]])
  for (let c = 1; c < 4; c++) topologyOwner(f, 1, c, [])
  for (let c = 0; c < 4; c++) topologyOwner(f, 2, c, [['Field ' + c, 10 + c * 80, 55]])
  topologyOwner(f, 3, 0, [
    ['Second group', 10, 70],
    ['Next field', 10, 82]
  ])
  for (let c = 1; c < 4; c++) topologyOwner(f, 3, c, [['Value ' + c, 10 + c * 80, 82]])
  return f
}
const groupHeadingContext = (f: Fixture): Fixture => {
  const context = topologyContext(f)
  context.sourceContent.styles.bold = { ascent: 0.8, descent: -0.2, vertical: false }
  for (const i of f.items.filter((i: Fixture) => /group$/.test(i.text)))
    context.sourceContent.items[i.sourceItem.index].fontName = 'bold'
  return context
}
it('withdraws a group-heading baseline merged into its first data field', () => {
  const f = mergedGroupHeading(),
    context = groupHeadingContext(f)
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], context)).toContain(
    'native-group-heading-merged-with-record'
  )
})
it('checks a complete group-heading packet despite a distant zero-advance native mark', () => {
  const f = mergedGroupHeading(),
    context = groupHeadingContext(f)
  context.sourceContent.items.push({
    ...context.sourceContent.items.at(-1),
    str: '̸',
    width: 0,
    transform: [10, 0, 0, 10, 300, 200]
  })
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], context)).toContain(
    'native-group-heading-merged-with-record'
  )
})
it.each([
  'populated heading peer',
  'one active peer',
  'stale native content',
  'foreign native item'
])('requires the independent native group-heading packet: %s', (mode) => {
  const f = mergedGroupHeading()
  if (mode === 'populated heading peer') topologyOwner(f, 1, 1, [['Value', 90, 40]])
  if (mode === 'one active peer')
    f.table.cells = f.table.cells.filter((c: Fixture) => c.row !== 3 || c.column < 2)
  const context = groupHeadingContext(f)
  if (mode === 'stale native content') {
    const index = f.items.find((i: Fixture) => i.text === 'Second group').sourceItem.index
    context.sourceContent.items[index].str = 'Changed'
  }
  if (mode === 'foreign native item')
    context.sourceContent.items.push({
      ...context.sourceContent.items.at(-1),
      str: 'Foreign',
      transform: [10, 0, 0, 10, 90, 330]
    })
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], context)).not.toContain(
    'native-group-heading-merged-with-record'
  )
})
it('does not split an ordinary two-line first field without a matching independent heading face', () => {
  const f = mergedGroupHeading()
  expect(nativeTableLayoutConflicts(f.table, f.items, [], [], topologyContext(f))).not.toContain(
    'native-group-heading-merged-with-record'
  )
})

it.each([
  ['tuple wall', fusedTupleWall, topologyContext],
  ['paired records', sectionedPairRows, topologyContext],
  ['group heading', mergedGroupHeading, groupHeadingContext]
] as const)(
  'publishes only the original graphic for contradictory %s',
  async (_name, make, context) => {
    const f = make(),
      directory = await mkdtemp(join(tmpdir(), 'native-record-graphic-')),
      sourceChecksum = 'a'.repeat(64),
      png = await sharp({
        create: { width: 35, height: 40, channels: 3, background: '#ffffff' }
      })
        .png()
        .toBuffer()
    try {
      Object.assign(f.table, {
        id: 'native-records',
        region: [0, 5 / 400, 1, 150 / 400],
        sourceViewport: { width: 350, height: 400 },
        caption: { text: 'Table 1. Grouped values.', rect: [0, 0, 200, 4] },
        thumbnail: 'thumbnails/native-records.png',
        nativeBody: { kind: 'stale body' },
        sourceItems: [{ text: 'stale owner' }]
      })
      const before = structuredClone(f.table),
        native = context(f),
        reviewed = reviewFinalNativeTableSources(f.table, f.items, f.rules, [], native),
        out = retainNativeCenteredRecordGraphic(reviewed, f.items, f.rules, [], native)
      expect(out.grid).toEqual([])
      expect(out.cells).toEqual([])
      expect(out.thumbnail).toBe(f.table.thumbnail)
      expect(out.region).toBe(f.table.region)
      expect(out.caption).toBe(f.table.caption)
      expect(f.table).toEqual(before)
      await mkdir(join(directory, 'thumbnails'))
      await writeFile(join(directory, out.thumbnail), png)
      await writeFile(
        join(directory, 'structure.json'),
        JSON.stringify({
          sourceSha256: sourceChecksum,
          pageCount: 1,
          requestedPages: [1],
          processedPages: [1],
          pages: [{ page: 1, width: 350, height: 400, rotation: 0 }],
          figures: [],
          tables: [out],
          navigation: { entries: [] }
        })
      )
      const thumbnails = new Map<string, Uint8Array>(),
        result = await readWorkerResult(
          directory,
          {
            extractionId: '00000000-0000-4000-8000-000000000001',
            engineFingerprint: 'b'.repeat(64),
            sourceChecksum,
            sourceSizeBytes: 100,
            requestedPages: [1]
          },
          thumbnails
        ),
        element = result.elements[0]
      expect(result.elements).toHaveLength(1)
      expect(element.table).toBeUndefined()
      expect(element.tableParts).toBeUndefined()
      expect(element.sourceItems).toBeUndefined()
      expect(element.nativeBody).toBeUndefined()
      expect(element.issues.map((issue) => issue.code)).toContain('no-source-cell-grid')
      expect(element.caption?.text).toBe(f.table.caption.text)
      expect(element.regions).toEqual([{ page: 1, x: 0, y: 5 / 400, width: 1, height: 145 / 400 }])
      expect(thumbnails.get(element.thumbnailId)).toEqual(png)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
