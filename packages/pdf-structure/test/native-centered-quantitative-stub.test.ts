import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { reconcileNativeRuledStubBands } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-sparse-comparison-grid.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>

// The missing scalar falls in a detector row gap. Both whole leading fonts
// are printed at the mean of two independently complete method/metric rows.
const fixture = (bands = 2): Fixture => {
  const items: Fixture[] = [],
    cells: Fixture[] = [],
    grid = Array.from({ length: bands * 2 + 1 }, () => Array<string>(6).fill(''))
  const token = (text: string, column: number, baseline: number): Fixture => {
    const i = {
      text,
      rect: [column * 30 + 4, baseline - 8, column * 30 + 24, baseline],
      baseline,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(i)
    return i
  }
  const cell = (row: number, column: number, i?: Fixture): void => {
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: i?.text ?? '',
      rect: [column * 30, row * 20, column * 30 + 30, row * 20 + 20],
      ...(i ? { sourceItems: [i.sourceItem], sourceTokens: [i], sourceRects: [i.rect] } : {})
    })
    grid[row][column] = i?.text ?? ''
  }
  for (let column = 0; column < 6; column++) cell(0, column, token(`Header ${column}`, column, 12))
  for (let band = 0; band < bands; band++) {
    const baselines = [30 + band * 40, 48 + band * 40],
      first = band * 2 + 1,
      label = token(`Group ${band}`, 0, 39 + band * 40),
      scalar = token(String(100 + band), 1, 39 + band * 40)
    for (const [n, baseline] of baselines.entries()) {
      cell(first + n, 0, n === 1 ? label : undefined)
      cell(first + n, 1, band && !n ? scalar : undefined)
      cell(first + n, 2, token(`Method ${n}`, 2, baseline))
      for (let column = 3; column < 6; column++)
        cell(first + n, column, token(String(10 * (n + 1) + column), column, baseline))
    }
  }
  return {
    items,
    rules: [0, 20, ...Array.from({ length: bands }, (_, n) => 58 + n * 40)].map((y) => [
      0,
      y,
      180,
      y
    ]),
    result: {
      cropRect: [0, 0, 180, bands * 40 + 20],
      cells,
      grid,
      unassigned: ['100'],
      issues: ['unassigned-source-text'],
      repairs: []
    }
  }
}
const prove = (f: Fixture): Fixture => reconcileNativeRuledStubBands(f.result, f.items, f.rules)

it('restores one centered quantitative source owner and both closed-band spans', () => {
  const f = fixture(),
    before = structuredClone(f),
    r = prove(f)
  expect(r?.unassigned).toEqual([])
  expect(r.issues).toEqual([])
  expect(r.cells.filter((c: Fixture) => c.column < 2 && c.row > 0)).toHaveLength(4)
  expect(
    r.cells.filter((c: Fixture) => c.column < 2 && c.row > 0).every((c: Fixture) => c.rowSpan === 2)
  ).toBe(true)
  expect(r.grid[1].slice(0, 3)).toEqual(['Group 0', '100', 'Method 0'])
  expect(r.grid[2].slice(0, 3)).toEqual(['', '', 'Method 1'])
  const claims = r.cells.flatMap((c: Fixture) => c.sourceItems ?? [])
  expect(new Set(claims.map((s: Fixture) => s.index)).size).toBe(f.items.length)
  expect(claims).toHaveLength(f.items.length)
  expect(f).toEqual(before)
})

it('preserves an unproved band and its unassigned literal while recovering complete peers', () => {
  const f = fixture(3),
    i = f.items.find((t: Fixture) => t.text === '100')
  i.baseline += 2
  const before = structuredClone(f.result),
    r = prove(f)
  expect(r?.unassigned).toEqual(['100'])
  expect(r.issues).toContain('unassigned-source-text')
  expect(r.grid.slice(0, 3)).toEqual(before.grid.slice(0, 3))
  expect(r.cells.filter((c: Fixture) => c.row < 3)).toEqual(
    before.cells.filter((c: Fixture) => c.row < 3)
  )
  expect(
    r.cells
      .filter((c: Fixture) => c.row >= 3 && c.column < 2)
      .every((c: Fixture) => c.rowSpan === 2)
  ).toBe(true)
})

it('allows an interior separator confined to unchanged method and metric leaves', () => {
  const f = fixture()
  f.rules.push([60, 40, 180, 40])
  expect(prove(f)?.unassigned).toEqual([])
})

it.each([
  'fence',
  'off-center',
  'variable',
  'partial-record',
  'duplicate-owner',
  'foreign-source',
  'foreign-segment',
  'interior-stub-divider',
  'conflicting-source-text',
  'hidden-source-token',
  'nested-source-carrier',
  'hidden-cell-text',
  'source',
  'crossing',
  'merged-record'
])('declines an incomplete shared-band proof: %s', (change) => {
  const f = fixture()
  if (change === 'fence') f.rules.pop()
  if (change === 'off-center') f.items.find((i: Fixture) => i.text === '100').baseline += 2
  if (change === 'variable') {
    const i = structuredClone(f.items.find((i: Fixture) => i.text === '100'))
    i.text = i.sourceItem.text = '999'
    i.sourceItem.index = f.items.length
    f.items.push(i)
  }
  if (change === 'partial-record')
    f.result.cells = f.result.cells.filter((c: Fixture) => !(c.row === 1 && c.column === 4))
  if (change === 'duplicate-owner') {
    const i = f.items.find((i: Fixture) => i.text === '101')
    const c = f.result.cells.find((c: Fixture) => c.row === 4 && c.column === 1)
    c.text = i.text
    c.sourceItems = [i.sourceItem]
  }
  if (change === 'foreign-source') {
    const i = f.items.find((i: Fixture) => i.text === '100')
    f.result.cells
      .find((c: Fixture) => c.row === 0 && c.column === 0)
      .sourceItems.push(i.sourceItem)
  }
  if (change === 'foreign-segment') {
    const i = f.items.find((t: Fixture) => t.text === '100')
    f.result.cells[0].sourceSegments = [{ ...i.sourceItem, start: 0, end: 1 }]
  }
  if (change === 'interior-stub-divider') f.rules.push([0, 40, 60, 40])
  if (change === 'conflicting-source-text') {
    const i = f.items.find((t: Fixture) => t.text === '100')
    f.result.cells[0].sourceItems.push({ ...i.sourceItem, text: 'Other original text' })
  }
  if (change === 'hidden-source-token')
    f.result.cells
      .find((c: Fixture) => c.row === 2 && c.column === 0)
      .sourceTokens.push(f.items.find((i: Fixture) => i.text === 'Header 5'))
  if (change === 'nested-source-carrier')
    f.result.cells.find((c: Fixture) => c.row === 2 && c.column === 0).extra = {
      sourceItem: f.items.find((i: Fixture) => i.text === 'Header 5').sourceItem
    }
  if (change === 'hidden-cell-text')
    f.result.cells.find((c: Fixture) => c.row === 2 && c.column === 0).text += ' foreign'
  if (change === 'source') delete f.items.find((i: Fixture) => i.text === '100').sourceItem
  if (change === 'crossing') f.items.find((i: Fixture) => i.text === '100').rect[0] = 29
  if (change === 'merged-record')
    f.result.cells.find((c: Fixture) => c.row === 1 && c.column === 4).rowSpan = 2
  expect(prove(f)).toBeUndefined()
})

// A merged model row has two complete native records; an independent closed
// peer band repeats the complete method/measurement sequence.
const mergedBandFixture = (): Fixture => {
  const items: Fixture[] = [],
    cells: Fixture[] = [],
    grid = Array.from({ length: 7 }, () => Array(6).fill('')),
    rows = grid.map((_, n) => ({
      rect: [0, n ? 18 + (n - 1) * 18 : 0, 180, n ? 18 + n * 18 : 18],
      origin: 'model'
    }))
  const token = (text: string, c: number, y: number): Fixture => {
    const i = {
      text,
      rect: [c * 30 + 4, y - 8, c * 30 + 24, y],
      baseline: y,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(i)
    return i
  }
  const cell = (row: number, column: number, tokens: Fixture | Fixture[], rowSpan = 1): void => {
    const ts = Array.isArray(tokens) ? tokens : [tokens],
      c = {
        row,
        column,
        rowSpan,
        colSpan: 1,
        rect: [
          column * 30,
          rows[row].rect[1],
          column * 30 + 30,
          rows[Math.min(6, row + rowSpan - 1)].rect[3]
        ],
        text: ts.map((i) => i.text).join(' '),
        sourceTokens: ts,
        sourceRects: ts.map((i) => i.rect),
        sourceItems: ts.map((i) => i.sourceItem).sort((a, b) => a.index - b.index)
      }
    cells.push(c)
    grid[row][column] = c.text
  }
  for (let c = 0; c < 6; c++) cell(0, c, token('Header ' + c, c, 12))
  for (let b = 0; b < 2; b++) {
    const first = 1 + b * 3,
      mid = 44 + b * 58
    cell(first, 0, token('Group ' + b, 0, mid), 3)
    cell(first, 1, token(String(100 + b), 1, mid), 3)
    for (const c of cells.filter((c) => c.row === first && c.column < 2)) {
      c.rect[1] = b ? 68 : 18
      c.rect[3] = b ? 126 : 68
    }
    for (let n = 0; n < 3; n++) {
      const row = first + n,
        y = 30 + b * 58 + n * 14
      rows[row] = { rect: [0, y - 8, 180, y], origin: 'model' }
      cell(row, 2, token(['A', 'B', 'C'][n], 2, y))
      for (let c = 3; c < 6; c++) cell(row, c, token(String(b * 100 + n * 10 + c), c, y))
    }
  }
  for (let c = 2; c < 6; c++) {
    const a = cells.find((x) => x.row === 2 && x.column === c),
      b = cells.find((x) => x.row === 3 && x.column === c)
    a.text += ' ' + b.text
    a.sourceTokens.push(...b.sourceTokens)
    a.sourceRects.push(...b.sourceRects)
    a.sourceItems.push(...b.sourceItems)
    a.rect[3] = b.rect[3]
  }
  const result: Fixture = {
    cropRect: [0, 0, 180, 126],
    grid: [],
    rows: [],
    cells: cells.filter((c) => c.row !== 3),
    unassigned: [],
    issues: ['native-table-structure-ambiguous'],
    repairs: []
  }
  for (const c of result.cells) {
    if (c.row === 1 && c.column < 2) c.rowSpan = 2
    if (c.row >= 4) c.row--
  }
  result.rows = [...rows.slice(0, 3), ...rows.slice(4)]
  result.rows[2] = { rect: [0, 36, 180, 58], origin: 'model' }
  result.grid = result.rows.map(() => Array(6).fill(''))
  for (const c of result.cells) result.grid[c.row][c.column] = c.text
  return {
    result,
    items,
    rules: [
      [0, 0, 180, 0],
      [0, 18, 180, 18],
      [0, 68, 180, 68],
      [0, 126, 180, 126]
    ]
  }
}

it('splits only a completely owned merged native band and remaps later spans atomically', () => {
  const f = mergedBandFixture(),
    before = JSON.stringify(f),
    r = reconcileNativeRuledStubBands(f.result, f.items, f.rules)
  expect(r?.grid).toHaveLength(7)
  expect(r.grid.slice(1, 4).map((row: string[]) => row[2])).toEqual(['A', 'B', 'C'])
  expect(r.cells.find((c: Fixture) => c.row === 1 && c.column === 0).rowSpan).toBe(3)
  const sort = (cs: Fixture[]): Fixture[] =>
    cs.toSorted((a, b) => a.row - b.row || a.column - b.column)
  expect(sort(r.cells.filter((c: Fixture) => c.row >= 4))).toEqual(
    sort(
      f.result.cells
        .filter((c: Fixture) => c.row >= 3)
        .map((c: Fixture) => ({ ...c, row: c.row + 1 }))
    )
  )
  const claims = (cs: Fixture[]): Fixture[] =>
    cs
      .flatMap((c) => c.sourceItems ?? [])
      .map((s) => JSON.stringify(s))
      .sort()
  const rects = (cs: Fixture[]): string[] =>
    cs
      .flatMap((c) => c.sourceRects ?? [])
      .map((s) => JSON.stringify(s))
      .sort()
  expect(claims(r.cells)).toEqual(claims(f.result.cells))
  expect(rects(r.cells)).toEqual(rects(f.result.cells))
  expect(r.issues).toEqual(f.result.issues)
  expect(JSON.stringify(f)).toBe(before)
})

it('declines an otherwise proved insertion that exceeds the public cell limit', () => {
  const f = mergedBandFixture(),
    extra = 2048 - f.result.cells.length,
    rowCount = Math.ceil(extra / 6),
    first = f.result.rows.length
  f.result.cropRect[3] = 226
  for (let n = 0; n < rowCount; n++) {
    const top = 126 + (n * 100) / rowCount,
      bottom = 126 + ((n + 1) * 100) / rowCount
    f.result.rows.push({ rect: [0, top, 180, bottom], origin: 'model' })
    f.result.grid.push(Array(6).fill(''))
    for (let column = 0; column < 6 && n * 6 + column < extra; column++)
      f.result.cells.push({
        row: first + n,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: '',
        rect: [column * 30, top, column * 30 + 30, bottom]
      })
  }
  expect(f.result.cells).toHaveLength(2048)
  const before = JSON.stringify(f)
  expect(Boolean(reconcileNativeRuledStubBands(f.result, f.items, f.rules))).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
})

it('keeps whole-table review after a source-complete local record repair', () => {
  const f = mergedBandFixture()
  f.result.issues = ['span-conflicts-with-source-rows']
  f.result.reviewCandidate = true
  const before = JSON.stringify(f),
    result = reconcileNativeRuledStubBands(f.result, f.items, f.rules)
  expect(result?.grid).toHaveLength(7)
  expect(result.grid.slice(1, 4).map((row: string[]) => row[2])).toEqual(['A', 'B', 'C'])
  expect(result.issues).toEqual([
    'span-conflicts-with-source-rows',
    'native-table-structure-ambiguous'
  ])
  expect(result.reviewCandidate).toBe(false)
  const claims = (cells: Fixture[]): string[] =>
    cells
      .flatMap((cell) => cell.sourceItems ?? [])
      .map((s) => JSON.stringify(s))
      .sort()
  expect(claims(result.cells)).toEqual(claims(f.result.cells))
  expect(JSON.stringify(f)).toBe(before)
})

it('keeps the bounded merged repair when later stub recovery would exceed the cell limit', () => {
  const f = mergedBandFixture(),
    add = (text: string, column: number, baseline: number): Fixture => {
      const item = {
        text,
        rect: [column * 30 + 4, baseline - 8, column * 30 + 24, baseline],
        baseline,
        height: 8,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: f.items.length, text }
      }
      f.items.push(item)
      return item
    }
  add('Group 2', 0, 159)
  add('102', 1, 159)
  for (const [n, baseline] of [150, 168].entries()) {
    const row = f.result.rows.length,
      rect = [0, baseline - 8, 180, baseline]
    f.result.rows.push({ rect, origin: 'model' })
    f.result.grid.push(Array(6).fill(''))
    for (let column = 2; column < 6; column++) {
      const item = add(column === 2 ? `Peer ${n}` : String(200 + n * 10 + column), column, baseline)
      f.result.cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: item.text,
        rect: [column * 30, rect[1], column * 30 + 30, rect[3]],
        sourceTokens: [item],
        sourceRects: [item.rect],
        sourceItems: [item.sourceItem]
      })
      f.result.grid[row][column] = item.text
    }
  }
  f.rules.push([0, 194, 180, 194])
  f.result.unassigned.push('Group 2', '102')
  f.result.issues.push('unassigned-source-text')
  f.result.cropRect[3] = 294
  const extra = 2044 - f.result.cells.length,
    rowCount = Math.ceil(extra / 6),
    first = f.result.rows.length
  for (let n = 0; n < rowCount; n++) {
    const top = 194 + (n * 100) / rowCount,
      bottom = 194 + ((n + 1) * 100) / rowCount
    f.result.rows.push({ rect: [0, top, 180, bottom], origin: 'model' })
    f.result.grid.push(Array(6).fill(''))
    for (let column = 0; column < 6 && n * 6 + column < extra; column++)
      f.result.cells.push({
        row: first + n,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: '',
        rect: [column * 30, top, column * 30 + 30, bottom]
      })
  }
  expect(f.result.cells).toHaveLength(2044)
  const before = JSON.stringify(f),
    result = reconcileNativeRuledStubBands(f.result, f.items, f.rules)
  expect(result.cells).toHaveLength(2048)
  expect(result.grid.slice(1, 4).map((row: string[]) => row[2])).toEqual(['A', 'B', 'C'])
  expect(result.unassigned).toEqual(['Group 2', '102'])
  expect(result.issues).toContain('unassigned-source-text')
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
})
it.each<[string, (f: Fixture) => void]>([
  [
    'existing metric columns are swapped',
    (f) => {
      for (const c of f.result.cells.filter(
        (c: Fixture) => c.row >= 1 && c.row <= 2 && (c.column === 3 || c.column === 4)
      ))
        c.column = 7 - c.column
      f.result.grid = f.result.rows.map(() => Array(6).fill(''))
      for (const c of f.result.cells) f.result.grid[c.row][c.column] = c.text
    }
  ],
  [
    'existing stub columns are swapped',
    (f) => {
      for (const c of f.result.cells.filter((c: Fixture) => c.row === 1 && c.column < 2))
        c.column = 1 - c.column
      f.result.grid = f.result.rows.map(() => Array(6).fill(''))
      for (const c of f.result.cells) f.result.grid[c.row][c.column] = c.text
    }
  ],
  [
    'rich-script',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      c.textRuns = [{ text: c.text, position: 'superscript' }]
    }
  ],
  [
    'source-segment',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      c.sourceSegments = [{ ...c.sourceItems[0], start: 0, end: 1, rect: c.sourceRects[0] }]
    }
  ],
  [
    'foreign-owner',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      f.result.cells[0].sourceItems.push({ ...c.sourceItems[0] })
    }
  ],
  [
    'conflicting-owner',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      f.result.cells[0].sourceItems.push({ ...c.sourceItems[0], text: 'Other' })
    }
  ],
  ['partial-divider', (f) => f.rules.push([0, 45, 60, 45])],
  [
    'native-boundary',
    (f) => {
      f.items.find((i) => i.text === 'A').rect[1] = 17
    }
  ],
  [
    'missing-value',
    (f) => {
      const i = f.items.find((i) => i.text === '13')
      f.items.splice(f.items.indexOf(i), 1)
    }
  ],
  [
    'missing-peer-fence',
    (f) => {
      f.rules = f.rules.filter((r) => r[1] !== 68)
    }
  ],
  [
    'variable-budget',
    (f) => {
      const i = structuredClone(f.items.find((i) => i.text === '100'))
      i.text = i.sourceItem.text = '200'
      i.sourceItem.index = 999
      i.baseline = 58
      i.rect = [34, 50, 54, 58]
      f.items.push(i)
    }
  ],
  [
    'cross-boundary-span',
    (f) => {
      f.result.cells.find((c) => c.row === 1 && c.column === 0).rowSpan = 3
    }
  ],
  [
    'different-peer-methods',
    (f) => {
      const i = f.items.find((i) => i.text === 'A' && i.baseline > 68)
      i.text = i.sourceItem.text = 'Other'
      const c = f.result.cells.find((c) => c.row === 3 && c.column === 2)
      c.text = 'Other'
      f.result.grid[3][2] = 'Other'
    }
  ],
  [
    'hidden-source-token',
    (f) => {
      f.result.cells.find((c) => c.row === 2 && c.column === 3).sourceTokens.push(f.items[0])
    }
  ],
  [
    'hidden-grid-value',
    (f) => {
      f.result.grid[2][3] += ' ghost'
    }
  ],
  [
    'orphan-annotation',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      c.metadata = { sourceItems: [f.items[0].sourceItem] }
    }
  ],
  [
    'hidden-same-band-annotation',
    (f) => {
      const c = f.result.cells.find((c) => c.row === 2 && c.column === 3)
      c.metadata = { sourceItems: [c.sourceItems[0]] }
    }
  ],
  [
    'arbitrary-scalar-text',
    (f) => {
      const i = f.items.find((i) => i.text === '13')
      i.text = i.sourceItem.text = 'value'
    }
  ],
  [
    'overlapping record ink',
    (f) => {
      for (const i of f.items.filter((i: Fixture) => i.baseline > 18 && i.baseline <= 58)) {
        const y = i.baseline === 44 ? 38.1 : i.baseline === 58 ? 46.2 : i.baseline
        const next = i.text === '3' ? y + 0.23 : i.text === '13' ? y - 0.23 : y
        const delta = next - i.baseline
        i.baseline = next
        i.rect[1] += delta
        i.rect[3] += delta
      }
    }
  ]
])('retains a merged-band diagnostic when %s cannot be proved', (_name, mutate) => {
  const f = mergedBandFixture()
  mutate(f)
  const before = JSON.stringify(f)
  expect(reconcileNativeRuledStubBands(f.result, f.items, f.rules)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
