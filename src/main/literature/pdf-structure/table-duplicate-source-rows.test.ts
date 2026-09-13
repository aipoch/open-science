import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { mergeDuplicateSourceRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
it('restores complete source records claimed by overlapping model bands', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/overlapping-native-records.jsonl'
    )
  )
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
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/overlapping-native-records.jsonl'
    )
  )
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
  const x = readPdfFixture(
    resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`)
  )
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).not.toContain(label)
  expect(result.grid.filter((row: string[]) => row.includes(label))).toHaveLength(1)
  expect(result.repairs).toContain('duplicate-source-row-merged')
  const row = result.grid.find((row: string[]) => row.includes(label))
  expect(row.filter(Boolean).length).toBeGreaterThan(3)
})

it('recovers missing mixed records only between consecutive source identifiers', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/sequential-mixed-records.jsonl'
    )
  )
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
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/appendix-underlined-arms.jsonl'
    )
  )
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
    const x = readPdfFixture(
      resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`)
    )
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
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/sequential-mixed-records.jsonl'
    )
  )
  const section = '1000 μg; mean tumor size 31±11 mm'
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual([section, '', '', '', ''])
  expect(result.unassigned).not.toContain(section)
  const changed = x.tokens.filter((i: { text: string }) => !i.text.startsWith('250 μg;'))
  expect(refineTable(x.table, changed, x.captions, [], x.rules).unassigned).toContain(section)
})
