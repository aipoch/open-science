import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable, recoverRuledTable, recoverCaptionedRuledTables, hasTableEvidence } =
  await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
const { captionKind } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const token = (text: string, x: number, y: number): object => ({
  text,
  rect: [x, y, x + 55, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const source = (bands: number[][]): object => ({
  cropRect: [0, 0, 400, 100],
  structure: {
    objects: [
      ...bands.map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 400, bottom] })),
      ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 100] }))
    ]
  }
})

it('rejects a structured abstract and publisher contact grid while preserving a captioned table', () => {
  const grid = ['Background', 'Methods', 'Results', 'Conclusions'].map((label) => [
    label,
    'This is a long narrative paragraph about the trial and its conclusions. '.repeat(3)
  ])
  const table = { grid, cropRect: [0, 0, 400, 200], issues: [], unassigned: [] }
  const items = grid.map((row, i) => token(row[0], 10, i * 30 + 10))
  expect(hasTableEvidence(table, undefined, items)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 1. Summary'] }, items)).toBe(true)
  expect(
    hasTableEvidence(
      {
        ...table,
        grid: [
          ['Tel.', ': +48-123456'],
          ['Fax', ': +48-123457'],
          ['e-mail', ': contact@example.org']
        ]
      },
      undefined,
      []
    )
  ).toBe(false)
  expect(
    hasTableEvidence(
      {
        ...table,
        grid: [
          ['ARTICLE TOOLS', 'https://example.org/article'],
          ['PERMISSIONS', 'https://example.org/rights']
        ]
      },
      undefined,
      []
    )
  ).toBe(false)
})

it('recovers a blank-stub treatment header whose glyphs straddle the first model band', () => {
  const result = refineTable(
    source([
      [19, 40],
      [42, 60],
      [65, 85]
    ]),
    [
      token('Treatment', 105, 12),
      token('Control', 205, 12),
      token('P value', 305, 12),
      token('(n=20)', 105, 26),
      ...['Age', '44', '45', '0.8'].map((s, i) => token(s, i * 100 + 5, 45)),
      ...['Weight', '60', '61', '0.7'].map((s, i) => token(s, i * 100 + 5, 69))
    ],
    [{ lines: ['Table 1. Patients'], rect: [0, -20, 400, -10] }]
  )
  expect(result.grid[0]).toEqual(['', 'Treatment (n=20)', 'Control', 'P value'])
  expect(result.unassigned).toEqual([])
})

it('recovers a complete numeric record between populated neighboring rows', () => {
  const result = refineTable(
    source([
      [10, 32],
      [38, 62],
      [70, 90]
    ]),
    [
      ...['A', '1 (2)', '2 (3)', '0.4'].map((s, i) => token(s, i * 100 + 5, 13)),
      ...['B', '3 (4)', '4 (5)', '0.5'].map((s, i) => token(s, i * 100 + 5, 30)),
      ...['C', '5 (6)', '6 (7)', '0.6'].map((s, i) => token(s, i * 100 + 5, 47)),
      ...['D', '7 (8)', '8 (9)', '0.7'].map((s, i) => token(s, i * 100 + 5, 75))
    ]
  )
  expect(result.grid.map((r: string[]) => r[0])).toEqual(['A', 'B', 'C', 'D'])
  expect(result.unassigned).toEqual([])
})

it('recovers a numeric continuation only when every grid border is present', () => {
  const xs = [10, 110, 210, 310],
    ys = Array.from({ length: 9 }, (_, i) => 20 + i * 30)
  const rules = [
    ...ys.map((y) => [10, y, 310, y]),
    ...xs.flatMap((x) => ys.slice(1).map((y, i) => [x, ys[i], x, y]))
  ]
  const items = ys
    .slice(1)
    .flatMap((_, i) => [
      token(`Row ${i}`, 20, ys[i] + 5),
      token('12', 120, ys[i] + 5),
      token('14', 220, ys[i] + 5)
    ])
  const raw = recoverRuledTable(items, rules, 2)
  expect(raw).toBeDefined()
  expect(refineTable(raw, items, [], [], rules).grid).toHaveLength(8)
  expect(recoverRuledTable(items, rules.slice(0, -1), 2)).toBeUndefined()
  expect(
    recoverRuledTable(
      items.map(() => token('Prose', 20, 30)),
      rules,
      2
    )
  ).toBeUndefined()
})

it.each([
  ['lettered figure number', 'Figure 2A. Probe position', 'figure'],
  ['parenthesized table number', 'Table (1): Patient characteristics', 'table'],
  ['Chinese table number', '\u88681\u3002\u7eb3\u5165\u7814\u7a76\u7684\u7279\u5f81', 'table']
])('recognizes printed caption numbering: %s', (_, caption, kind) => {
  expect(captionKind(caption)).toBe(kind)
})

it('keeps a single ruled mean/deviation continuation without accepting a plain form', () => {
  const rules = [
    [10, 20, 310, 20],
    [10, 60, 310, 60],
    ...[10, 110, 210, 310].map((x) => [x, 20, x, 60])
  ]
  const items = [token('Dose', 20, 30), token('12±3', 120, 30), token('14±2', 220, 30)]
  const raw = recoverRuledTable(items, rules, 2)
  expect(raw).toBeDefined()
  const result = refineTable(raw, items, [], [], rules)
  expect(result.grid).toEqual([['Dose', '12±3', '14±2']])
  expect(hasTableEvidence(result)).toBe(true)
  expect(
    recoverRuledTable([items[0], token('12', 120, 30), token('14', 220, 30)], rules, 2)
  ).toBeUndefined()
})

it('associates a side caption only with the aligned table beside it', () => {
  const caption = { page: 1, lines: ['Table 2. Analgesic use'], rect: [10, 100, 90, 125] }
  const page = { pageNumber: 1, height: 800, lines: [] }
  const result = associateTableCaptions(
    page,
    [{ rect: [110, 101, 400, 200] }, { rect: [110, 300, 400, 400] }],
    [caption]
  )
  expect(result[0].caption).toBe(caption)
  expect(result[1].caption).toBeUndefined()
})

it('keeps all glyphs of a split exponent on the base text line', () => {
  const result = refineTable(
    source([
      [10, 45],
      [50, 90]
    ]),
    [
      token('Dose kg', 5, 20),
      { text: '−', rect: [60, 20, 65, 26], height: 6, baseline: 26, horizontal: true },
      { text: '1', rect: [65, 20, 68, 26], height: 6, baseline: 26, horizontal: true },
      ...['1', '2', '0.5'].map((s, i) => token(s, (i + 1) * 100 + 5, 20)),
      ...['Age', '30', '31', '0.7'].map((s, i) => token(s, i * 100 + 5, 60))
    ]
  )
  expect(result.grid[0][0]).toBe('Dose kg−1')
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 0)
      .textRuns
  ).toContainEqual({ text: '−1', position: 'superscript' })
})

it('recovers two small captioned grids including a narrow count column and summary rows', () => {
  const xs = [10, 100, 120, 220, 320]
  const captions = [0, 160].map((y, i) => ({
    page: 7,
    lines: [`Table ${i + 4}. Outcomes`],
    rect: [10, y, 250, y + 10]
  }))
  const rules = [0, 160].flatMap((offset) => {
    const ys = [25, 50, 75, 100, 125].map((y) => y + offset)
    return [
      ...ys.map((y) => [10, y, 320, y]),
      ...xs.flatMap((x) => ys.slice(1).map((y, i) => [x, ys[i], x, y]))
    ]
  })
  const grid = [
    ['Group', 'n', 'Comfort', 'Satisfaction'],
    ['Routine', '37', '4.58±1.12', '88.14±4.14'],
    ['Experimental', '37', '5.88±1.74', '96.35±3.12'],
    ['P value', '−', '<.001', '<.001']
  ]
  const items = [0, 160].flatMap((offset) =>
    grid.flatMap((row, r) =>
      row.map((text, c) => ({
        ...token(text, xs[c] + 2, offset + 30 + r * 25),
        rect: [xs[c] + 2, offset + 30 + r * 25, xs[c + 1] - 2, offset + 40 + r * 25]
      }))
    )
  )
  const recovered = recoverCaptionedRuledTables(items, rules, captions, 7)
  expect(recovered).toHaveLength(2)
  expect(new Set(recovered.map((t: { id: string }) => t.id)).size).toBe(2)
  for (const raw of recovered)
    expect(refineTable(raw, items, captions, [], rules).grid).toEqual(grid)
  expect(recoverCaptionedRuledTables(items, rules, [], 7)).toEqual([])
  expect(recoverCaptionedRuledTables(items, rules.slice(0, -1), captions, 7)).toHaveLength(1)
  expect(recoverCaptionedRuledTables(items, rules, captions, 7, recovered)).toEqual([])
})

it('recovers a treatment record between a section row and an empty prediction', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/empty-band-treatment-record.jsonl'
    )
  )
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual(['The first‑line', '10 (18.2)', '8 (19.0)', '0.913'])
  expect(result.grid).toContainEqual(['The second-line', '45 (81.8)', '34 (81.0)', ''])
  expect(result.grid).toContainEqual(['The lines in treatments', '', '', ''])
  expect(result.unassigned).not.toContain('The first‑line')
})

it.each(['populated-neighbor', 'missing-value', 'unindented-record'])(
  'keeps an ambiguous empty prediction when the source has %s',
  (condition) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/empty-band-treatment-record.jsonl'
      )
    )
    if (condition === 'populated-neighbor') {
      x.tokens.push({
        text: '80',
        rect: [251, 841.7577, 264, 853.7577],
        baseline: 853.7577,
        height: 12,
        horizontal: true
      })
    } else if (condition === 'missing-value') {
      x.tokens = x.tokens.filter((item: { text: string }) => item.text !== '0.913')
    } else {
      const label = x.tokens.find((item: { text: string }) => item.text === 'The first‑line')
      label.rect[0] -= 9
      label.rect[2] -= 9
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.unassigned).toContain('The first‑line')
  }
)

it('separates a section heading from its first indented numeric record', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/empty-band-treatment-record.jsonl'
    )
  )
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual(['Histology', '', '', ''])
  expect(result.grid).toContainEqual(['Lobular', '1 (1.8)', '1 (2.4)', '0.847'])
  expect(result.grid).toContainEqual(['Ductal', '42 (76.4)', '34 (81.0)', '0.587'])
})

it.each(['missing-header-evidence', 'unindented-label', 'incomplete-next-record'])(
  'does not split a projected section with %s',
  (condition) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/empty-band-treatment-record.jsonl'
      )
    )
    if (condition === 'missing-header-evidence') {
      x.table.structure.objects = x.table.structure.objects.filter(
        (object: { label: string }) => object.label !== 'table projected row header'
      )
    } else if (condition === 'unindented-label') {
      const label = x.tokens.find((item: { text: string }) => item.text === 'Lobular')
      label.rect[0] -= 9
      label.rect[2] -= 9
    } else {
      x.tokens = x.tokens.filter((item: { text: string }) => item.text !== '0.587')
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.repairs).not.toContain('projected-section-record-separated')
  }
)
