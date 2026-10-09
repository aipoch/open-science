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

type ClosedGridFont = {
  text: string
  rect: number[]
  height: number
  baseline: number
  horizontal: boolean
}
type ClosedGridCaption = { page: number; lines: string[]; rect: number[] }

const closedTwoLeafGrid = (
  rows = 4,
  offset = 0
): {
  items: ClosedGridFont[]
  rules: number[][]
  paint: Map<string, number[]>
  captions: ClosedGridCaption[]
  grid: string[][]
  xs: number[]
  ys: number[]
  crop: number[]
} => {
  const xs = [30.3, 90, 239.7].map((x) => x + offset)
  const ys = Array.from({ length: rows + 1 }, (_, r) => 50 + r * 13.5)
  const rules = ys.map((y) => [30 + offset, y, 240 + offset, y])
  const paint = new Map<string, number[]>(
    rules.map((r) => [r.join(','), [r[0], r[1] - 0.3, r[2], r[3] + 0.3]])
  )
  for (const x of xs)
    for (let row = 0; row < rows; row++) {
      // Adjacent original segments can touch a painted horizontal band with
      // sub-pixel PDF float drift. That does not make them part of both faces.
      const r = [x, ys[row] + (row % 2 ? 0.2999999 : 0.3015), x, ys[row + 1] - 0.3]
      rules.push(r)
      paint.set(r.join(','), [x - 0.3, r[1], x + 0.3, r[3]])
    }
  const font = (text: string, x: number, baseline: number, width: number): ClosedGridFont => ({
    text,
    rect: [x + offset, baseline - 10, x + offset + width, baseline],
    height: 10,
    baseline,
    horizontal: true
  })
  const items = [font('Index', 38, ys[0] + 11, 28), font('q', 128, ys[0] + 11, 7)]
  items.push({
    text: 'k',
    rect: [135.4 + offset, ys[0] + 6, 139.4 + offset, ys[0] + 12],
    height: 6,
    baseline: ys[0] + 12,
    horizontal: true
  })
  const grid = [['Index', 'qk']]
  for (let row = 1; row < rows; row++) {
    const values = [String(row), `0.${row + 2}1 ± 0.04`]
    grid.push(values)
    items.push(font(values[0], 38, ys[row] + 8.5, 8))
    items.push(font(values[1], 110, ys[row] + 8.5, 80))
  }
  const captions = [
    {
      page: 1,
      lines: ['Table 3. Summary of measured results.'],
      rect: [10 + offset, ys[rows] + 10, 260 + offset, ys[rows] + 20]
    }
  ]
  return {
    items,
    rules,
    paint,
    captions,
    grid,
    xs,
    ys,
    crop: [30 + offset, ys[0] - 0.3, 240 + offset, ys[rows] + 0.3]
  }
}

it.each([
  [4, 0],
  [6, 260]
])(
  'recovers a complete two-leaf painted grid before its caption (%s rows, translated %s)',
  (rows, offset) => {
    const f = closedTwoLeafGrid(rows, offset)
    const before = structuredClone(f)
    const recovered = recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], [], f.paint)
    expect(recovered).toHaveLength(1)
    expect(recovered[0].caption).toBe(f.captions[0])
    expect(recovered[0].cropRect).toEqual(f.crop)
    const result = refineTable(recovered[0], f.items, f.captions, [], f.rules)
    expect(result.grid).toEqual(f.grid)
    expect(result.cells).toHaveLength(rows * 2)
    expect(result.unassigned).toEqual([])
    expect(result.cells[1].textRuns).toEqual([
      { text: 'q', position: 'normal' },
      { text: 'k', position: 'subscript' }
    ])
    expect(result.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
      f.items.map((i) => i.rect).sort()
    )
    expect(f).toEqual(before)
    expect(
      recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, recovered, [], f.paint)
    ).toEqual([])
    expect(
      recoverCaptionedRuledTables(
        f.items,
        f.rules,
        [...f.captions, { ...structuredClone(f.captions[0]), page: 2 }],
        1,
        [],
        [],
        f.paint
      )
    ).toHaveLength(1)
  }
)

it.each([
  'no-paint',
  'missing-paint',
  'paint-gap',
  'missing-bottom',
  'missing-cut',
  'missing-field',
  'clipped-font',
  'nonfinite-font',
  'crossing-font',
  'duplicate-font',
  'foreign-corridor',
  'wrong-page',
  'competing-caption',
  'figure-caption',
  'foreign-rule',
  'neighbor-figure',
  'oversized-paint',
  'nonfinite-rect',
  'unbounded-grid'
])('does not recover an unproved below-caption two-leaf grid: %s', (condition) => {
  const f = closedTwoLeafGrid(condition === 'unbounded-grid' ? 81 : 4)
  let paint: Map<string, number[]> | undefined = f.paint
  const vertical = f.rules.find((r) => r[0] === f.xs[1] && r[1] > f.ys[1])!
  if (condition === 'no-paint') paint = undefined
  else if (condition === 'missing-paint') f.paint.delete(vertical.join(','))
  else if (condition === 'paint-gap') f.paint.get(vertical.join(','))![3] -= 0.03
  else if (condition === 'missing-bottom')
    f.rules = f.rules.filter((r) => r[1] !== f.ys.at(-1) || r[3] !== f.ys.at(-1))
  else if (condition === 'missing-cut') f.rules = f.rules.filter((r) => r !== vertical)
  else if (condition === 'missing-field') f.items.pop()
  else if (condition === 'clipped-font') f.items[0].rect[1]++
  else if (condition === 'nonfinite-font') f.items[0].baseline = NaN
  else if (condition === 'nonfinite-rect') f.items[0].rect[0] = NaN
  else if (condition === 'crossing-font') f.items[3].rect[2] = f.xs[1] + 2
  else if (condition === 'duplicate-font') f.items.push(structuredClone(f.items[0]))
  else if (condition === 'foreign-corridor')
    f.items.push({
      text: 'foreign',
      rect: [80, f.ys.at(-1)! + 2, 105, f.ys.at(-1)! + 7],
      height: 5,
      baseline: f.ys.at(-1)! + 7,
      horizontal: true
    })
  else if (condition === 'wrong-page') f.captions[0].page++
  else if (condition === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  else if (condition === 'figure-caption')
    f.captions[0].lines = ['Figure 3. A plot of measured results.']
  else if (condition === 'neighbor-figure')
    f.captions.push({
      page: 1,
      lines: ['Figure 4. Independent neighboring plot.'],
      rect: [100, f.ys[1], 180, f.ys[1] + 10]
    })
  else if (condition === 'oversized-paint') f.paint.get(vertical.join(','))![0] -= 40
  else if (condition === 'foreign-rule') {
    const r = [100, f.ys[1] + 2, 120, f.ys[1] + 2]
    f.rules.push(r)
    f.paint.set(r.join(','), [100, r[1] - 0.3, 120, r[1] + 0.3])
  }
  expect(recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], [], paint)).toEqual([])
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

it('rejects a caption-clipped numeric grid and preserves the complete ruled fallback', () => {
  const xs = [0, 100, 200, 300, 400]
  const ys = Array.from({ length: 9 }, (_, i) => 25 + i * 25)
  const rules = [
    ...ys.flatMap((y) => xs.slice(1).map((x, i) => [xs[i], y, x, y])),
    ...xs.flatMap((x) => ys.slice(1).map((y, i) => [x, ys[i], x, y]))
  ]
  const grid = [
    ['Characteristic', 'Arm A', 'Arm B', 'P'],
    ...Array.from({ length: 7 }, (_, i) => [`Record ${i + 1}`, '30', '31', '0.7'])
  ]
  const items = grid.flatMap((row, r) => row.map((text, c) => token(text, xs[c] + 5, ys[r] + 5)))
  const caption = { page: 2, lines: ['Table 1. Outcomes'], rect: [8, 0, 350, 10] }
  expect(recoverCaptionedRuledTables(items, rules, [caption], 2)).toEqual([])
  const complete = recoverRuledTable(items, rules, 2)
  expect(complete).toBeDefined()
  expect(refineTable(complete, items, [caption], [], rules).grid).toEqual(grid)

  // Rules outside the table and one repeated decorative separator do not prove a missing column.
  const aligned = { ...caption, rect: [0, 0, 350, 10] }
  const unrelated = [
    [-20, 240, 420, 240],
    [-20, 260, 420, 260],
    [-20, 50, 0, 50],
    [-20, 50, 0, 50]
  ]
  const accepted = recoverCaptionedRuledTables(items, [...rules, ...unrelated], [aligned], 2)
  expect(accepted).toHaveLength(1)
  expect(refineTable(accepted[0], items, [aligned], [], rules).grid).toEqual(grid)
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
