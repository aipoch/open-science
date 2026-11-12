import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeSparseComparisonGrid, reconcileNativeCenteredBodySpans } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-sparse-comparison-grid.mjs')).href
)
const { recoverNativeRepeatedMetricSourceGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-repeated-metric-grid.mjs')).href
)
const { recoverNativeMathFieldRecords, recoverNativeMathSummaryRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-math-field-record-grid.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const load = (name: string): Fixture =>
  readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
const sparse = (): Fixture => load('sparse-cohort-method-records')
const metric = (): Fixture => load('repeated-four-leaf-metrics-with-native-fused-record')
const math = (): Fixture => load('mathematical-components-with-ruled-summary')
const refine = (f: Fixture): Fixture =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs ?? [])
const proveSparse = (f: Fixture): Fixture =>
  recoverNativeSparseComparisonGrid(f.table, f.tokens, f.captions, f.rules)
const proveMetric = (f: Fixture): Fixture =>
  recoverNativeRepeatedMetricSourceGrid(f.table, f.tokens, f.captions, f.rules, f.runs)
const proveMath = (f: Fixture): Fixture =>
  recoverNativeMathFieldRecords(f.table, f.tokens, f.captions, f.rules)

it('keeps every sparse cohort record and preserves the printed empty stubs', () => {
  const f = sparse(),
    before = structuredClone(f),
    r = refine(f)
  expect(r.grid).toHaveLength(7)
  expect(r.grid[3]).toEqual(['', 'Task 2', '4', 'Choice X', '3.2 (0.3)'])
  expect(r.grid[4]).toEqual(['', '', '', 'Choice Y', '4.2 (0.3)'])
  expect(r.grid[5]).toEqual(['Group B', 'Task 3', '6', 'Choice X', '5.2 (0.3)'])
  expect(r.cells.every((c: Fixture) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual([])
  expect(f).toEqual(before)
  const owners = r.cells.flatMap((c: Fixture) => c.sourceItems ?? [])
  expect(new Set(owners.map((s: Fixture) => s.index)).size).toBe(f.tokens.length)
})

it.each(['rule', 'crossing', 'record', 'caption'])(
  'declines sparse records without the complete %s proof',
  (change) => {
    const f = sparse()
    if (change === 'rule') f.rules.pop()
    if (change === 'crossing') f.tokens[5].rect[2] = 125
    if (change === 'record')
      f.tokens.find((t: Fixture) => t.text === '3.2 (0.3)').text = 'unrelated prose'
    if (change === 'caption') f.captions.push(structuredClone(f.captions[0]))
    expect(proveSparse(f)).toBeUndefined()
  }
)

it('uses repeated native leaves to restore thirteen columns and retain a fused final record', () => {
  const f = metric(),
    before = structuredClone(f),
    plan = proveMetric(f),
    r = refine(f)
  expect(plan.columns).toHaveLength(13)
  expect(r.grid).toHaveLength(6)
  expect(r.grid.every((row: string[]) => row.length === 13)).toBe(true)
  expect(r.grid[5]).toEqual(['Row 3', ...Array.from({ length: 12 }, (_, n) => String(44 + n))])
  expect(r.cells.filter((c: Fixture) => c.row === 0 && c.colSpan === 4)).toHaveLength(3)
  expect(r.cells.filter((c: Fixture) => c.row === 2 && c.colSpan === 4)).toHaveLength(3)
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual([])
  const split = r.cells.filter((c: Fixture) => c.row === 5)
  expect(split).toHaveLength(13)
  expect(
    new Set(split.flatMap((c: Fixture) => c.sourceItems).map((s: Fixture) => s.index)).size
  ).toBe(1)
  expect(f).toEqual(before)
})

it.each(['leaf', 'gap', 'incomplete', 'offset', 'source'])(
  'declines repeated metrics with an unproved %s',
  (change) => {
    const f = metric()
    if (change === 'leaf') f.tokens.filter((t: Fixture) => t.text === 'Rate')[1].text = 'Other'
    if (change === 'gap') f.runs[0].glyphRuns[f.runs[0].gaps[0].index] = 8
    if (change === 'incomplete') f.tokens = f.tokens.filter((t: Fixture) => t.text !== '20')
    if (change === 'offset') f.tokens.find((t: Fixture) => t.text === '10').rect[0] += 5
    if (change === 'source') f.tokens.push({ ...f.tokens[0], text: 'Overlapping field' })
    expect(proveMetric(f)).toBeUndefined()
  }
)

const sectionedMetric = (): Fixture => {
  const f = metric()
  for (const t of f.tokens.filter((t: Fixture) => t.baseline > 60)) {
    t.rect[1] += 20
    t.rect[3] += 20
    t.baseline += 20
  }
  for (const r of f.runs) {
    r.rect[1] += 20
    r.rect[3] += 20
    r.baseline += 20
  }
  const append = (text: string, rect: number[]): void => {
    f.tokens.push({
      text,
      rect,
      height: 10,
      baseline: rect[3],
      horizontal: true,
      sourceItem: { pageNumber: 1, index: f.tokens.length, text }
    })
  }
  append('Cohort A', [20, 65, 120, 75])
  append('Cohort B', [20, 175, 120, 185])
  const templates = f.tokens.filter((t: Fixture) => t.baseline === 120 || t.baseline === 140)
  for (const t of templates) {
    const y = t.baseline === 120 ? 200 : 220
    append(t.text, [t.rect[0], y, t.rect[2], y + 10])
  }
  f.table.cropRect[3] = 245
  f.rules = f.rules.filter((r: number[]) => r[1] !== 155)
  f.rules.push([0, 170, 720, 170], [0, 245, 720, 245])
  return f
}

it('retains ruled cohort titles as whole rows above complete repeated metric records', () => {
  const f = sectionedMetric(),
    before = structuredClone(f),
    p = proveMetric(f),
    r = refine(f)
  expect(p?.rows).toHaveLength(10)
  expect(p.columns).toHaveLength(13)
  expect(p.spans).toContainEqual({ row: 2, column: 0, rowSpan: 1, colSpan: 13 })
  expect(p.spans).toContainEqual({ row: 7, column: 0, rowSpan: 1, colSpan: 13 })
  expect(r.grid[2][0]).toBe('Cohort A')
  expect(r.grid[7][0]).toBe('Cohort B')
  expect(r.unassigned).toEqual([])
  expect(r.cells.filter((c: Fixture) => c.colSpan === 13).map((c: Fixture) => c.text)).toEqual([
    'Cohort A',
    'Cohort B'
  ])
  expect(f).toEqual(before)
})

it.each(['fence', 'extra-title', 'number-title', 'body', 'source', 'crossing', 'measured-gap'])(
  'declines sectioned repeated metrics without the %s evidence',
  (change) => {
    const f = sectionedMetric()
    if (change === 'fence') f.rules = f.rules.filter((r: number[]) => r[1] !== 170)
    if (change === 'extra-title') {
      const t = f.tokens.find((t: Fixture) => t.text === 'Cohort A')
      f.tokens.push({
        ...t,
        rect: [20, 80, 120, 90],
        baseline: 90,
        sourceItem: { ...t.sourceItem, index: f.tokens.length }
      })
    }
    if (change === 'number-title') f.tokens.find((t: Fixture) => t.text === 'Cohort A').text = '123'
    if (change === 'body')
      f.tokens = f.tokens.filter((t: Fixture) => !(t.baseline === 230 && t.text === '43'))
    if (change === 'source') delete f.tokens.find((t: Fixture) => t.text === 'Cohort A').sourceItem
    if (change === 'crossing') {
      const t = f.tokens.find((t: Fixture) => t.text === 'Cohort B')
      t.rect[1] = 169
    }
    if (change === 'measured-gap') f.runs[0].glyphRuns[f.runs[0].gaps[0].index] = 8
    expect(proveMetric(f)).toBeUndefined()
  }
)

it('proves paired native headings with a shared stub and preserves the next caption owner', () => {
  const f = load('paired-metrics-with-shared-stub-and-following-caption'),
    r = refine(f),
    plan = proveMetric(f)
  expect(plan.columns).toHaveLength(7)
  expect(plan.spans).toContainEqual({ row: 0, column: 0, rowSpan: 2, colSpan: 1 })
  expect(plan.ownedTokens.size).toBe(31)
  expect([...plan.ownedTokens].every((t: Fixture) => !t.text.startsWith('Table 2:'))).toBe(true)
  expect(r.grid).toHaveLength(5)
  expect(r.grid[0]).toEqual(['Method', 'Group A', '', 'Group B', '', 'Group C', ''])
  expect(r.grid[1]).toEqual(['', 'Rate', 'Delta', 'Rate', 'Delta', 'Rate', 'Delta'])
  expect(r.grid[4]).toEqual(['Row 3', '32', '33', '34', '35', '36', '37'])
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual(['text-crosses-crop-boundary'])
})

it.each(['frame', 'caption', 'origin', 'header', 'body'])(
  'retains touching caption text when the following %s owner is unproved',
  (change) => {
    const f = load('paired-metrics-with-shared-stub-and-following-caption')
    if (change === 'frame') f.rules.pop()
    if (change === 'caption') f.captions[1].lines[0] += ' Missing literal.'
    if (change === 'origin')
      delete f.tokens.find((t: Fixture) => t.text.startsWith('Table 2:')).sourceItem
    if (change === 'header')
      f.tokens.filter((t: Fixture) => t.rect[1] === 175).forEach((t: Fixture) => (t.text = '0'))
    if (change === 'body') f.tokens = f.tokens.filter((t: Fixture) => t.rect[1] !== 225)
    expect(proveMetric(f)).toBeUndefined()
  }
)

it('retains mathematical component rows above a separately ruled summary with a true blank field', () => {
  const f = math(),
    before = structuredClone(f),
    r = refine(f)
  expect(proveMath(f).rows).toHaveLength(5)
  expect(r.grid).toEqual([
    ['Component', 'Expression', 'Count'],
    ['Layer A', 'R(2) → R(1)', '100'],
    ['Layer B', 'R(3) → R(2)', '200'],
    ['Layer C', 'R(4) → R(3)', '300'],
    ['Summary', '', '600']
  ])
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual([])
  expect(f).toEqual(before)
})

it.each(['extra', 'summary', 'rule', 'crossing'])(
  'declines a mathematical summary with unproved %s content',
  (change) => {
    const f = math()
    if (change === 'extra')
      f.tokens.push({ ...f.tokens.at(-1), text: 'Unknown', rect: [180, 132, 240, 142] })
    if (change === 'summary') f.tokens.at(-1).text = 'not a count'
    if (change === 'rule') f.rules.pop()
    if (change === 'crossing') f.tokens.at(-1).rect[3] = 155
    expect(recoverNativeMathSummaryRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

// The centered values are original whole native fonts. The later section
// prints both leaves separately; the parent underline and section fence prove
// that these earlier values occupy one shared field, not either leaf alone.
const centered = (): Fixture => {
  const rows = Array.from({ length: 7 }, (_, row) => ({ rect: [0, row * 20, 300, (row + 1) * 20] }))
  const cells: Fixture[] = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 2, rect: [100, 0, 300, 20], text: 'Duration' },
    ...[1, 2].map((column) => ({
      row: 1,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, 20, (column + 1) * 100, 40],
      text: column === 1 ? 'Warm' : 'Cold'
    }))
  ]
  const items: Fixture[] = []
  for (let row = 2; row < 7; row++) {
    const values =
      row < 5
        ? [{ text: String(row + 1), rect: [195, row * 20 + 5, 205, row * 20 + 15] }]
        : [
            { text: '10', rect: [130, row * 20 + 5, 145, row * 20 + 15] },
            { text: '20', rect: [240, row * 20 + 5, 255, row * 20 + 15] }
          ]
    for (const value of values)
      items.push({
        ...value,
        height: 10,
        baseline: value.rect[3],
        horizontal: true,
        sourceItem: { pageNumber: 1, index: items.length, text: value.text }
      })
    for (let column = 1; column < 3; column++) {
      const source =
        row < 5
          ? row === 2 && column === 1
            ? [items.at(-1)]
            : []
          : [items[items.length - 3 + column]]
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 100, row * 20, (column + 1) * 100, (row + 1) * 20],
        text: source.map((i: Fixture) => i.text).join(''),
        sourceTokens: structuredClone(source)
      })
    }
  }
  return {
    cells,
    rows,
    items,
    rules: [
      [100, 20, 300, 20],
      [0, 100, 300, 100]
    ],
    headerRows: [0, 1],
    unassigned: ['4', '5'],
    issues: new Set(['unassigned-source-text']),
    repairs: []
  }
}

it('assigns each centered scalar once to the full parent width and keeps the later pair independent', () => {
  const f = centered()
  reconcileNativeCenteredBodySpans(f)
  expect(f.cells.filter((c: Fixture) => c.row >= 2 && c.row <= 4)).toEqual(
    [2, 3, 4].map((row) =>
      expect.objectContaining({
        row,
        column: 1,
        colSpan: 2,
        rowSpan: 1,
        text: String(row + 1),
        sourceItems: [f.items[row - 2].sourceItem]
      })
    )
  )
  expect(f.cells.filter((c: Fixture) => c.row >= 5)).toHaveLength(4)
  expect(f.unassigned).toEqual([])
  expect([...f.issues]).toEqual([])
  expect(f.repairs).toEqual(['native-centered-body-span-recovered'])
})

it.each(['fence', 'offset', 'origin', 'later', 'conflict'])(
  'keeps centered diagnostics when the %s proof is absent',
  (change) => {
    const f = centered()
    if (change === 'fence') f.rules.pop()
    if (change === 'offset') f.items[1].rect[0] += 2
    if (change === 'origin') delete f.items[0].sourceItem
    if (change === 'later') f.cells.find((c: Fixture) => c.row === 5 && c.column === 2).text = ''
    if (change === 'conflict')
      f.cells.find((c: Fixture) => c.row === 3 && c.column === 2).sourceTokens = [
        { ...f.items[1], text: 'Other' }
      ]
    const before = structuredClone(f)
    reconcileNativeCenteredBodySpans(f)
    expect(f).toEqual(before)
  }
)

it('retains a same-literal diagnostic when its centered source already had an owner', () => {
  const f = centered()
  f.unassigned.unshift('3')
  reconcileNativeCenteredBodySpans(f)
  expect(f.unassigned).toEqual(['3'])
  expect([...f.issues]).toEqual(['unassigned-source-text'])
})

it.each(['segment', 'nested-token', 'metadata'])(
  'declines centered spans with an out-of-row %s source alias',
  (carrier) => {
    const f = centered(),
      origin = f.items[1].sourceItem
    const alias: Fixture = {
      text: 'Alias',
      rect: [500, 200, 520, 210],
      height: 10,
      baseline: 210,
      horizontal: true
    }
    if (carrier === 'segment') alias.sourceSegment = { ...origin, start: 0, end: 1 }
    if (carrier === 'nested-token') alias.sourceToken = { sourceItem: { ...origin } }
    if (carrier === 'metadata')
      alias.metadata = { sourceSegments: [{ ...origin, start: 0, end: 1 }] }
    f.items.push(alias)
    const before = structuredClone(f)
    reconcileNativeCenteredBodySpans(f)
    expect(f).toEqual(before)
  }
)
