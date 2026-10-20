import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { mergeDuplicateSourceRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)

const separatedCaptionedFrames = (): ReturnType<typeof JSON.parse> => {
  const captions = [
    { page: 1, lines: ['Table 1: First settings'], rect: [120, 10, 200, 20] },
    { page: 1, lines: ['Table 2: Second settings'], rect: [110, 160, 210, 170] },
    { page: 1, lines: ['Table 3: Final settings'], rect: [90, 330, 230, 340] }
  ]
  const rules = [25, 45, 140, 175, 195, 310].map((y) => [40, y, 260, y])
  rules.push(...[345, 365, 425].map((y) => [121, y, 199, y]))
  const token = (text: string, x: number, y: number): object => ({
    text,
    rect: [x, y, x + 12, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true
  })
  const items = [30, 60, 90, 120, 180, 210, 240, 290].flatMap((y, n) => [
    token('Setting', 50, y),
    token(String(n + 10), n % 2 ? 185 : 170, y)
  ])
  items.push(
    ...[350, 375, 395, 415].flatMap((y, n) => [
      token(n ? 'Value' : 'Header', 125, y),
      token(String(n + 20), 175, y)
    ])
  )
  const existing = [
    [38, 15, 262, 142],
    [38, 172, 262, 312],
    [119, 344, 201, 427]
  ].map((cropRect) => ({
    cropRect,
    structure: {
      objects: [
        ...[0, 1, 2, 3].map(() => ({ label: 'table row' })),
        ...[0, 1].map(() => ({ label: 'table column' }))
      ]
    }
  }))
  return { captions, rules, items, existing }
}

it('does not recover a narrow later frame under an earlier centered table title', () => {
  const f = separatedCaptionedFrames(),
    before = structuredClone(f)
  expect(recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, f.existing)).toEqual([])
  expect(f).toEqual(before)
})

it.each(['same-number', 'neighboring-column', 'below-frame', 'reference-without-delimiter'])(
  'preserves the open-rule fallback without a distinct intervening title: %s',
  (mutation) => {
    const f = separatedCaptionedFrames()
    // Keep the first caption and the one immediately above the narrow frame.
    f.captions.splice(1, 1)
    const later = f.captions[1]
    if (mutation === 'same-number') later.lines = ['Table 1: Continued settings']
    if (mutation === 'neighboring-column') later.rect = [270, 330, 350, 340]
    if (mutation === 'below-frame') later.rect = [90, 430, 230, 440]
    if (mutation === 'reference-without-delimiter') later.lines = ['Table 3 has further settings']
    expect(recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, f.existing)).toHaveLength(1)
  }
)

const emptySourceSeam = (): ReturnType<typeof JSON.parse> => {
  const rows = [
    { rect: [0, 0, 300, 10], origin: 'model' },
    { rect: [0, 15, 300, 30], origin: 'model' },
    { rect: [0, 31.5, 300, 32.05], origin: 'source-text' },
    { rect: [0, 31.9, 300, 45], origin: 'model' }
  ]
  const items = [20, 32].flatMap((y, n) =>
    ['Record ' + n, '12', '34'].map((text, c) => ({
      text,
      rect: [c * 100 + 5, y, c * 100 + 45, y + 10],
      baseline: y + 10,
      height: 10,
      horizontal: true
    }))
  )
  const cells = [1, 3].flatMap((row, n) =>
    items.slice(n * 3, n * 3 + 3).map((item, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: item.text,
      sourceRects: [item.rect],
      origin: 'source-text'
    }))
  )
  cells.push(
    ...[0, 1, 2].map((column) => ({
      row: 2,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceRects: [],
      origin: 'model-grid'
    }))
  )
  return { rows, cells, items, rules: [], repairs: [] }
}

it('removes only a source-derived empty sliver at the next complete native baseline', () => {
  const f = emptySourceSeam()
  const owners = f.cells.filter((c) => c.text).map((c) => structuredClone(c.sourceRects))
  removeEmptyOverlappingRows(f)
  expect(f.rows).toHaveLength(3)
  expect(f.cells.filter((c) => c.text).map((c) => c.sourceRects)).toEqual(owners)
  expect(f.items).toHaveLength(6)
  expect(f.repairs).toEqual(['empty-overlapping-row-removed'])
})

it.each(['rule', 'large', 'gap', 'ink', 'incomplete', 'misaligned', 'opaque-origin'])(
  'preserves a source-derived empty band with %s evidence',
  (mutation) => {
    const f = emptySourceSeam()
    if (mutation === 'rule') f.rules.push([0, 32, 300, 32])
    if (mutation === 'large') f.rows[2].rect[1] = 30.5
    if (mutation === 'gap') f.rows[2].rect[3] = 31.9
    if (mutation === 'ink')
      f.items.push({
        text: 'x',
        rect: [5, 31.7, 10, 32.2],
        baseline: 32.2,
        height: 0.5,
        horizontal: true
      })
    if (mutation === 'incomplete')
      f.cells.find((c) => c.row === 3 && c.column === 1).sourceRects = []
    if (mutation === 'misaligned') {
      f.items[4].rect[3] += 2
      f.items[4].baseline += 2
    }
    if (mutation === 'opaque-origin') f.rows[2].origin = 'unknown'
    const before = structuredClone(f)
    removeEmptyOverlappingRows(f)
    expect(f).toEqual(before)
  }
)
it('restores complete source records claimed by overlapping model bands', () => {
  const x = readPdfFixture(resolve('test/fixtures/source-grids/overlapping-native-records.jsonl'))
  const table = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(table.unassigned).not.toContain('Yes')
  expect(table.repairs.filter((r: string) => r === 'duplicate-source-row-merged')).toHaveLength(2)
  expect(table.grid).toContainEqual(['Yes', '15', '8', '7', '', ''])
  expect(table.grid).toContainEqual(['Total mastectomy', '17', '11', '6', '', ''])
  expect(table.grid).toContainEqual(['Disease stage', '', '', '', 'χ2=4.456', 'P=0.108'])
})
it('does not merge bands with different source baselines or unowned extra text', () => {
  const token = (text: string, x: number, y: number): object => ({
    text,
    rect: [x, y, x + 10, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const group = [token('Yes', 5, 20), token('15', 105, 20), token('8', 205, 20)]
  for (const extra of [token('Other', 5, 35), token('2', 105, 35)]) {
    const rows = [{ rect: [0, 18, 300, 32] }, { rect: [0, 18, 300, 43] }]
    mergeDuplicateSourceRows({
      rows,
      groups: [group, [extra]],
      items: [...group, extra],
      columnRects: [
        [0, 0, 100, 100],
        [100, 0, 200, 100],
        [200, 0, 300, 100]
      ],
      repairs: []
    })
    expect(rows).toHaveLength(2)
  }
})

it('preserves a record that already has a substantially stronger row owner', () => {
  const group = [
    { text: 'Yes', rect: [5, 20, 15, 30], baseline: 30, height: 10, horizontal: true },
    { text: '15', rect: [105, 20, 115, 30], baseline: 30, height: 10, horizontal: true },
    { text: '8', rect: [205, 20, 215, 30], baseline: 30, height: 10, horizontal: true }
  ]
  const rows = [{ rect: [0, 18, 300, 32] }, { rect: [0, 24, 300, 43] }]
  const original = structuredClone(rows)
  const repairs: string[] = []
  mergeDuplicateSourceRows({
    rows,
    groups: [group],
    items: group,
    columnRects: [
      [0, 0, 100, 100],
      [100, 0, 200, 100],
      [200, 0, 300, 100]
    ],
    repairs
  })
  expect(rows).toEqual(original)
  expect(repairs).toEqual([])
})

it('keeps overlapping bands when the nearby raised glyph has no source anchor', () => {
  const x = readPdfFixture(resolve('test/fixtures/source-grids/overlapping-native-records.jsonl'))
  x.tokens = x.tokens.filter(
    (item: { text: string; baseline: number }) =>
      !(item.text === 'χ' && item.baseline > 520 && item.baseline < 525)
  )
  const table = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(table.grid).not.toContainEqual(['Total mastectomy', '17', '11', '6', '', ''])
  expect(table.unassigned).toContain('Total mastectomy')
})

it.each([
  ['middle-dot-overlapping-record', 'Worsens thyroid issues'],
  ['indented-overlapping-record', 'Single']
])('recovers source-backed records with blank outer stubs or middle dots: %s', (name, label) => {
  const x = readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).not.toContain(label)
  expect(result.grid.filter((row: string[]) => row.includes(label))).toHaveLength(1)
  expect(result.repairs).toContain('duplicate-source-row-merged')
  const row = result.grid.find((row: string[]) => row.includes(label))
  expect(row.filter(Boolean).length).toBeGreaterThan(3)
})

it('recovers missing mixed records only between consecutive source identifiers', () => {
  const x = readPdfFixture(resolve('test/fixtures/source-grids/sequential-mixed-records.jsonl'))
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const id of ['8', '11', '12', '15']) {
    expect(result.grid.filter((row: string[]) => row[0] === id && row.every(Boolean))).toHaveLength(
      1
    )
  }
  expect(result.grid.find((row: string[]) => row[0] === '11')).toEqual([
    '11',
    '40',
    '0 (IHC)',
    'ER -/PgR -',
    'IIIA (T3N1M0)'
  ])
  const sparse = {
    ...x,
    tokens: x.tokens.filter(
      (token: { text: string; rect: number[] }) => !(token.text === '10' && token.rect[0] < 180)
    )
  }
  const rejected = refineTable(sparse.table, sparse.tokens, sparse.captions, [], sparse.rules)
  expect(rejected.unassigned).toContain('11')
})

it('keeps wrapped stub text below recovered underlined treatment parents', () => {
  const x = readPdfFixture(resolve('test/fixtures/source-grids/appendix-underlined-arms.jsonl'))
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.find((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan === 2)
      ?.text
  ).toBe('TRAEs of Special Interest,a Preferred Term')
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 6)
  ).toHaveLength(2)
})

it.each([
  [
    'overlap-before-count-section',
    'First FH of breast cancer, n (%)',
    'duplicate-source-row-section-separated'
  ],
  ['overlap-with-raised-marker', 'Income', 'duplicate-source-row-merged'],
  ['two-column-interstitial-count', 'Invasive lobular carcinoma', 'interstitial-record-recovered']
])(
  'recovers missing source records while retaining neighboring content: %s',
  (name, label, reason) => {
    const x = readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.unassigned).toEqual([])
    expect(result.repairs).toContain(reason)
    expect(result.grid.filter((row: string[]) => row[0].startsWith(label))).toHaveLength(1)
    if (name === 'overlap-before-count-section') {
      expect(result.grid).toContainEqual([
        'Years since last mammogram, n (%)',
        ...Array(11).fill('')
      ])
      expect(
        result.grid.some((row: string[]) => row[0] === 'Within 2 years' && row[1] === '36 (30⋅5)')
      ).toBe(true)
    }
    if (name === 'overlap-with-raised-marker') {
      expect(result.grid.find((row: string[]) => row[0].startsWith('Income'))).toEqual([
        'Incomec',
        '',
        '',
        '0.25',
        '',
        '0.08'
      ])
    }
    if (name === 'two-column-interstitial-count') {
      expect(result.grid).toContainEqual(['Invasive lobular carcinoma', '2'])
      const changed = x.tokens.filter(
        (i: { text: string }) => i.text !== 'Invasive tubular carcinoma'
      )
      expect(refineTable(x.table, changed, x.captions, [], x.rules).unassigned).toContain(
        'Invasive lobular carcinoma'
      )
    }
  }
)

it('recovers a missing centered section only with matching peers and consecutive records', () => {
  const x = readPdfFixture(resolve('test/fixtures/source-grids/sequential-mixed-records.jsonl'))
  const section = '1000 μg; mean tumor size 31±11 mm'
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual([section, '', '', '', ''])
  expect(result.unassigned).not.toContain(section)
  const changed = x.tokens.filter((i: { text: string }) => !i.text.startsWith('250 μg;'))
  expect(refineTable(x.table, changed, x.captions, [], x.rules).unassigned).toContain(section)
})
