import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  proveNativeTieredHeader,
  proveNativeNarrativeHeader,
  proveNativeMeasuredLeafHeader,
  proveNativeMeasuredTieredHeader,
  splitNativeMeasuredFields
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { reconcileNativeTieredHeader } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it('uses measured native gaps to retain two textual stubs and every paired scalar under source tiers', () => {
  const f = fixture('native-measured-tiered-pairs'),
    original = structuredClone(f)
  const p = proveNativeMeasuredTieredHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  expect(p.columns).toHaveLength(8)
  expect(p.rows).toHaveLength(2)
  expect(p.prefixColumns).toBe(2)
  expect(
    p.headerCells.find(
      (c: { column: number; colSpan: number }) => c.column === 3 && c.colSpan === 2
    )
  ).toBeDefined()
  expect(p.bodyRecords).toHaveLength(4)
  expect(p.bodyItems.map((i: { text: string }) => i.text)).toContain('78.5 / 90.7')
  expect(p.bodyItems.map((i: { text: string }) => i.text)).toContain('0.0 / 7.4')
  expect(p.originalBody.every((i: unknown) => f.tokens.includes(i))).toBe(true)
  expect([...p.ownedTokens].every((i: unknown) => f.tokens.includes(i))).toBe(true)
  expect(new Set(p.bodyItems.map((i: { sourceToken: unknown }) => i.sourceToken))).toEqual(
    new Set(p.originalBody)
  )
  expect(f).toEqual(original)
  const crossing = f.tokens.find((i: { text: string }) => i.text.startsWith('246 '))
  const run = f.measuredRuns.find((r: { text: string }) => r.text === crossing.text)
  run.literalGlyphs[0] = '9'
  expect(
    proveNativeMeasuredTieredHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  ).toBeUndefined()
})

it('requires each selected measured column boundary to stay inside one literal text operator', () => {
  const f = fixture('native-measured-independent-leaves')
  const item = f.tokens[0],
    run = f.measuredRuns[0],
    gap = run.gaps[0]
  run.glyphRuns = run.glyphRuns.map((_: number, n: number) => (n < gap.index ? 1 : 2))
  expect(splitNativeMeasuredFields(item, [run], item.height)).toBeUndefined()
  // A separate operator inside one unchanged field cannot authorize splitting
  // that field; the actual chosen boundary still has one native TJ owner.
  run.glyphRuns = run.glyphRuns.map((_: number, n: number) => (n < gap.index + 3 ? 1 : 2))
  expect(
    splitNativeMeasuredFields(item, [run], item.height).map((i: { text: string }) => i.text)
  ).toEqual(['No.', 'Plain-language feature'])
})

it('recovers every paired scalar and sample count through the production measured-tiered seam', () => {
  const f = fixture('native-measured-tiered-pairs')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid).toHaveLength(6)
  expect(r.grid.every((row: string[]) => row.length === 8)).toBe(true)
  expect(r.grid.slice(2).map((row: string[]) => row.slice(2))).toEqual([
    ['246', '78.5 / 90.7', '98.8 / 100.0', '98.8 / 99.6', '1.2 / 81.7', '100.0'],
    ['250', '62.8 / 74.8', '91.6 / 99.2', '83.2 / 96.4', '0.0 / 67.6', '100.0'],
    ['244', '51.2 / 65.6', '27.9 / 79.1', '17.2 / 35.2', '0.0 / 7.4', '99.2'],
    ['245', '51.0 / 65.7', '49.4 / 84.9', '41.2 / 64.1', '0.0 / 24.9', '99.2']
  ])
  expect(r.unassigned).toEqual([])
  expect(r.repairs).toContain('native-tiered-header-body-records-recovered')
})

it('uses exact positioned mixed operators while keeping every chosen gap inside its native TJ run', () => {
  const f = fixture('native-positioned-two-stub-header')
  expect(f.measuredRuns.some((r: { glyphRuns: number[] }) => new Set(r.glyphRuns).size > 1)).toBe(
    true
  )
  const p = proveNativeMeasuredTieredHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  expect(p.columns).toHaveLength(8)
  expect(p.prefixColumns).toBe(2)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid).toHaveLength(13)
  expect(r.grid.slice(2).map((row: string[]) => row.slice(2))).toEqual(f.expectedMetricRows)
  expect(r.grid.slice(2).every((row: string[]) => row[0] && row[1])).toBe(true)
  expect(r.unassigned).toEqual([])
  const headerParent = r.cells.find(
    (c: { row: number; column: number; colSpan: number }) =>
      c.row === 0 && c.column === 3 && c.colSpan === 2
  )
  expect(headerParent).toBeDefined()
  const mixed = f.measuredRuns.find(
    (r: {
      text: string
      glyphRuns: number[]
      gaps: { index: number; left: number; right: number }[]
    }) => new Set(r.glyphRuns).size > 1 && r.gaps.some((g) => g.right - g.left > 6)
  )
  const selected = mixed.gaps.find((g: { left: number; right: number }) => g.right - g.left > 6)
  mixed.glyphRuns[selected.index] += 1000
  expect(
    proveNativeMeasuredTieredHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  ).toBeUndefined()
})

it('proves measured leaf titles and complete ordinal/prose records without losing source text', () => {
  const f = fixture('native-measured-independent-leaves'),
    original = structuredClone(f)
  const p = proveNativeMeasuredLeafHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  expect(p.columns).toHaveLength(8)
  expect(p.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'No.',
    'Plain-language feature',
    'Raw feature',
    'Proposed',
    'Observed',
    'Fire rate',
    'Score',
    '95% interval'
  ])
  expect(p.bodyRecords).toHaveLength(10)
  expect(p.bodyRecords.map((r: { text: string }[]) => r[0].text)).toEqual(f.expectedOrdinals)
  expect(new Set(p.bodyRecords.flat()).size).toBe(p.bodyItems.length)
  expect(new Set(p.originalBody)).toEqual(
    new Set(f.tokens.filter((i: { rect: number[] }) => i.rect[1] > p.headerBottom))
  )
  expect([...p.ownedTokens].every((i: unknown) => f.tokens.includes(i))).toBe(true)
  expect(
    p.bodyItems.filter((i: { sourceToken: unknown }) => !f.tokens.includes(i.sourceToken))
  ).toEqual([])
  // The literal source can have a ligature with two Unicode characters; its
  // measured boundary still separates the ordinal exactly once.
  expect(p.bodyRecords[1][0].text).toBe('3')
  expect(f).toEqual(original)
})

it('refuses measured titles without literal glyph provenance and complete peer gutters', () => {
  for (const change of [
    'no measurements',
    'literal mismatch',
    'ordinary spaces',
    'crossed body gutter',
    'missing frame',
    'remote caption'
  ]) {
    const f = fixture('native-measured-independent-leaves')
    if (change === 'no measurements') f.measuredRuns = []
    if (change === 'literal mismatch') f.measuredRuns[0].literalGlyphs[0] = 'z'
    if (change === 'ordinary spaces')
      for (const run of f.measuredRuns) for (const gap of run.gaps) gap.right = gap.left + 2
    if (change === 'crossed body gutter') {
      const i = f.tokens.find((i: { text: string }) => i.text === '0.68')
      i.rect[2] += 20
      const run = f.measuredRuns.find((r: { text: string }) => r.text === '0.68')
      run.rect[2] += 20
    }
    if (change === 'missing frame') f.rules.pop()
    if (change === 'remote caption') f.captions[0].rect[3] -= 200
    expect(
      proveNativeMeasuredLeafHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns),
      change
    ).toBeUndefined()
  }
})

it('restores measured leaf headers through production while preserving all native scalar and interval records', () => {
  const f = fixture('native-measured-independent-leaves')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(result.grid).toHaveLength(11)
  expect(result.grid.every((row: string[]) => row.length === 8)).toBe(true)
  expect(result.cells.filter((c: { row: number }) => c.row === 0)).toHaveLength(8)
  expect(
    result.cells
      .filter((c: { row: number }) => c.row === 0)
      .every((c: { origin: string }) => c.origin === 'source-measured-leaf-header')
  ).toBe(true)
  expect(result.grid.slice(1).map((row: string[]) => row[0])).toEqual(f.expectedOrdinals)
  expect(result.grid.slice(1).map((row: string[]) => row.slice(5))).toEqual(f.expectedMetricRows)
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('native-measured-leaf-body-records-recovered')
})

it('retains blank native sample counts while restoring an underlined parent over summary metrics', () => {
  const f = fixture('native-summary-optional-count-header')
  const p = proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)
  expect(p.columns).toHaveLength(7)
  expect(p.headerCells.find((c: { text: string }) => c.text === 'XXXXXXXX')).toMatchObject({
    column: 2,
    colSpan: 2
  })
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid.slice(2).map((row: string[]) => row.slice(1))).toEqual([
    ['', '95.1', '95.1', '83.0', '80.3', '84.6'],
    ['', '68.0', '6.0', '0.0', '8.0', '0.0'],
    ['50', '68.0 / 80.0', '6.0', '0.0', '8.0', '0.0']
  ])
  expect(r.repairs).toContain('source-native-tiered-header-recovered')
  expect(r.unassigned).toEqual([])
  // Without a native n title, the two summaries cannot prove a complete
  // numeric lane that the third evaluation alone populates.
  f.tokens.find((i: { text: string }) => i.text === 'n').text = 'Count'
  expect(proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  [
    'native-underlined-independent-header',
    10,
    2,
    [
      [2, 2],
      [4, 2]
    ]
  ],
  [
    'native-task-paired-header',
    12,
    2,
    [
      [2, 2],
      [4, 2],
      [6, 2],
      [8, 2],
      [10, 2]
    ]
  ],
  [
    'native-three-tier-repeated-header',
    17,
    3,
    [
      [1, 8],
      [9, 8]
    ]
  ]
])('proves source tiers and all body lanes for %s', (name, count, tiers, parents) => {
  const f = fixture(name as string),
    original = structuredClone(f)
  const plan = proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)
  expect(plan.columns).toHaveLength(count as number)
  expect(plan.rows).toHaveLength(tiers as number)
  expect(
    plan.headerCells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
      .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
  ).toEqual(parents)
  const owned = Array.from(plan.ownedTokens) as { text: string; rect: number[] }[]
  const header = f.tokens.filter(
    (i: { rect: number[] }) => i.rect[1] >= plan.rows[0][1] && i.rect[3] < plan.headerBottom
  )
  expect(new Set(owned)).toEqual(new Set(header))
  expect(new Set(owned).size).toBe(header.length)
  const positions = plan.headerCells.flatMap(
    (c: { row: number; column: number; rowSpan: number; colSpan: number }) =>
      Array.from({ length: c.rowSpan }, (_, row) =>
        Array.from({ length: c.colSpan }, (_, col) => `${row + c.row}:${col + c.column}`)
      ).flat()
  )
  expect(new Set(positions).size).toBe((count as number) * (tiers as number))
  expect(positions.length).toBe(new Set(positions).size)
  expect(f).toEqual(original)
})

it.each(['native-underlined-independent-header', 'native-task-paired-header'])(
  'reconciles %s through production without changing body values',
  (name) => {
    const f = fixture(name),
      plan = proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)
    const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(result.repairs).toContain('source-native-tiered-header-recovered')
    const expected = f.expectedMetrics.flat()
    const metricStart = name === 'native-task-paired-header' ? 2 : 1
    const values = result.grid
      .slice(plan.rows.length)
      .filter((r: string[]) => r.slice(metricStart).some(Boolean))
      .flatMap((r: string[]) => r.slice(metricStart))
    expect(values).toEqual(expected)
    expect(result.unassigned).toEqual([])
  }
)

it('does not merge a missing leaf, crossed gutter, missing frame or changed repeated order', () => {
  for (const change of [
    'missing leaf',
    'crossed gutter',
    'missing frame',
    'changed repeated order'
  ]) {
    const f = fixture('native-three-tier-repeated-header')
    if (change === 'missing leaf')
      f.tokens.find((i: { text: string }) => i.text.startsWith('Method OptionA')).text = f.tokens
        .find((i: { text: string }) => i.text.startsWith('Method OptionA'))
        .text.replace('Method ', '')
    if (change === 'changed repeated order')
      f.tokens.find((i: { text: string }) => i.text.startsWith('Method OptionA')).text = f.tokens
        .find((i: { text: string }) => i.text.startsWith('Method OptionA'))
        .text.replace('System Choice', 'Choice System')
    if (change === 'missing frame')
      f.rules = f.rules.filter(
        (r: number[]) => r[1] !== Math.max(...f.rules.map((q: number[]) => q[1]))
      )
    if (change === 'crossed gutter')
      for (const i of f.tokens.filter((i: { text: string }) => i.text === '8.51')) i.rect[2] += 30
    expect(proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
})

it('keeps scalar body tokens out of a header-only plan', () => {
  const f = fixture('native-underlined-independent-header')
  const plan = proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)
  expect(
    Array.from(plan.ownedTokens).some((i) => /^[+−-]?\d/u.test((i as { text: string }).text))
  ).toBe(false)
  expect(plan.headerCells.find((c: { text: string }) => c.text === 'Coverage')).toMatchObject({
    row: 0,
    column: 2,
    colSpan: 2,
    rowSpan: 1
  })
  expect(plan.headerCells.find((c: { text: string }) => c.text === 'Configuration')).toMatchObject({
    row: 0,
    column: 0,
    colSpan: 1,
    rowSpan: 2
  })
})

it('declines prose without the complete native narrative header vocabulary', () => {
  const f = fixture('native-underlined-independent-header')
  expect(proveNativeNarrativeHeader(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('does not replace a header that also owns a numeric body record', () => {
  const f = fixture('native-underlined-independent-header')
  const plan = proveNativeTieredHeader(f.table, f.tokens, f.captions, f.rules)
  const state = {
    cells: [
      {
        row: 0,
        column: 0,
        rowSpan: 1,
        colSpan: 10,
        text: 'damaged header',
        sourceRects: [plan.bodyRecords[0][0].rect]
      }
    ],
    rows: [{ rect: [...f.table.cropRect] }],
    columnRects: plan.columns,
    headerRows: [0],
    pageItems: f.tokens,
    rules: f.rules,
    captions: f.captions,
    unassigned: [],
    repairs: [],
    recordGrid: { nativeTieredHeader: plan }
  }
  const cells = structuredClone(state.cells),
    rows = structuredClone(state.rows)
  expect(reconcileNativeTieredHeader(state)).toBe(0)
  expect(state.cells).toEqual(cells)
  expect(state.rows).toEqual(rows)
})
