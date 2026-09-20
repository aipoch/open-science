import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverThresholdSweepGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width = text.length * 4
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const model = (
  n: number,
  ys: number[]
): {
  id: string
  cropRect: number[]
  structure: { objects: { label: string; rect: number[] }[] }
} => ({
  id: 'recovery',
  cropRect: [0, 0, n * 100, ys[ys.length - 1]],
  structure: {
    objects: [
      ...Array.from({ length: n }, (_, c) => ({
        label: 'table column',
        rect: [c * 100, 0, (c + 1) * 100, ys[ys.length - 1]]
      })),
      ...ys.slice(1).map((y, r) => ({ label: 'table row', rect: [0, ys[r], n * 100, y] })),
      { label: 'table column header', rect: [0, 0, n * 100, ys[1]] }
    ]
  }
})
it('anchors a raised full-em footnote to its header only with an independent note', () => {
  const table = model(2, [0, 25, 50]),
    items = [
      item('Label', 5, 8),
      item('P', 110, 8),
      item('a', 114, 2.2),
      item('Count', 5, 33),
      item('4', 110, 33),
      item('a', 5, 60)
    ]
  const t = refineTable(table, items)
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).textRuns
  ).toEqual([
    { text: 'P', position: 'normal' },
    { text: 'a', position: 'superscript' }
  ])
  expect(
    refineTable(table, items.slice(0, -1)).cells.some((c: { textRuns: unknown }) => c.textRuns)
  ).toBe(false)
})
it('joins a hyphenated measured label across otherwise empty continuation rows', () => {
  const table = model(3, [0, 20, 35, 50, 65, 85]),
    items = [
      item('Label', 5, 4),
      item('N', 105, 4),
      item('P', 205, 4),
      item('Long pre-', 5, 21),
      item('10', 105, 21),
      item('20', 205, 21),
      item('dominant', 5, 36),
      item('component', 5, 51),
      item('Next', 5, 70),
      item('30', 105, 70),
      item('40', 205, 70)
    ]
  const t = refineTable(table, items)
  expect(t.cells.some((c: { text: string }) => c.text === 'Long pre-dominant component')).toBe(true)
  expect(t.grid.some((r: string[]) => r[0] === 'Next' && r[1] === '30')).toBe(true)
})
it('uses repeated complete sweep records to recover parent headings and stub spans', () => {
  const table = model(
      9,
      Array.from({ length: 18 }, (_, i) => i * 20)
    ),
    items = [
      item('No. cases', 5, 2),
      item('Follow-up', 105, 2),
      item('Statistic', 205, 2),
      item('Proportional increases', 420, 2)
    ]
  for (let c = 0; c < 6; c++) items.push(item((c / 5).toFixed(1), 305 + c * 100, 22))
  for (let block = 0; block < 2; block++) {
    const start = 42 + block * 140
    items.push(item(`Threshold P = 0.0${block + 1}`, 420, start))
    for (let r = 0; r < 6; r++) {
      const y = start + 20 + r * 20
      if (r % 3 === 0) items.push(item(String(500 + r), 5, y), item('3', 105, y))
      items.push(item(['C', 'exp (M)', 'Both'][r % 3], 205, y))
      for (let c = 0; c < 6; c++) items.push(item(String(10 + r + c), 305 + c * 100, y))
    }
  }
  const recovered = recoverThresholdSweepGrid(table, items)
  expect(recovered.spans).toContainEqual({ row: 0, column: 3, rowSpan: 1, colSpan: 6 })
  expect(recovered.spans).toContainEqual({ row: 3, column: 0, rowSpan: 3, colSpan: 1 })
  expect(refineTable(table, items).unassigned).toEqual([])
  expect(
    recoverThresholdSweepGrid(
      table,
      items.filter((i) => i !== items.at(-1))
    )
  ).toBeUndefined()
})

it('realigns an empty final prediction without producing infinite row coordinates', () => {
  const table = model(3, [0, 20, 40, 69]),
    items = [
      item('Label', 5, 4),
      item('A', 105, 4),
      item('B', 205, 4),
      item('First', 5, 25),
      item('10', 105, 25),
      item('20', 205, 25),
      item('Last', 5, 65),
      item('30', 105, 65),
      item('40', 205, 65)
    ]
  table.cropRect[3] = 85
  const t = refineTable(table, items, [], [], [[0, 80, 300, 80]])
  expect(t.rows.every((r: { rect: number[] }) => r.rect.every(Number.isFinite))).toBe(true)
  expect(t.grid.some((r: string[]) => r.every((s: string) => !s))).toBe(false)
  expect(t.grid.at(-1)).toEqual(['Last', '30', '40'])
})

it('preserves tightly wrapped hyphenated words without joining numeric ranges or separate entries', () => {
  const table = model(3, [0, 20, 60, 85])
  const extract = (first: string, second: string, y = 36): string =>
    refineTable(table, [
      item('Label', 5, 4),
      item('N', 105, 4),
      item('P', 205, 4),
      item(first, 5, 21),
      item(second, 10, y),
      item('10', 105, 21),
      item('20', 205, 21),
      item('Next', 5, 70),
      item('30', 105, 70),
      item('40', 205, 70)
    ]).cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0).text
  expect(extract('With lympho-', 'cytic infiltrate')).toBe('With lympho-cytic infiltrate')
  expect(extract('10 -', '20')).toBe('10 - 20')
  expect(extract('Group -', 'Other')).toBe('Group - Other')
  expect(extract('With lympho-', 'cytic infiltrate', 48)).toBe('With lympho- cytic infiltrate')
})

it.each([true, false])(
  'joins an indented lowercase label tail with numeric peers=%s',
  (measured) => {
    const table = model(3, [0, 20, 35, 50, 70])
    const items = [
      item('Label', 5, 4),
      item('A', 105, 4),
      item('B', 205, 4),
      item('White cell count', 5, 21, 85),
      ...(measured ? [item('10', 105, 21), item('20', 205, 21)] : []),
      item('increased', 10, 36, 45),
      item('Next', 5, 54),
      item('30', 105, 54),
      item('40', 205, 54)
    ]
    const t = refineTable(table, items)
    expect(
      t.grid.some(
        (r: string[]) => r[0] === 'White cell count increased' && r[1] === (measured ? '10' : '')
      )
    ).toBe(true)
    expect(t.grid.some((r: string[]) => r[0] === 'Next' && r[1] === '30')).toBe(true)
    for (const variant of [
      items.map((i) => (i.text === 'increased' ? { ...i, text: 'Another category' } : i)),
      [...items, item('12', 105, 36)],
      items.map((i) => (i.text === 'increased' ? { ...i, rect: [5, 36, 50, 46] } : i))
    ])
      expect(
        refineTable(table, variant).grid.some(
          (r: string[]) => r[0] === 'White cell count increased'
        )
      ).toBe(false)
    expect(
      refineTable(table, items, [], [], [[0, 34, 300, 34]]).grid.some(
        (r: string[]) => r[0] === 'White cell count increased'
      )
    ).toBe(false)
  }
)

it('keeps each median with its wrapped range without merging neighboring treatment columns', () => {
  const table = model(3, [0, 20, 35, 50, 70])
  const items = [
    item('Statistic', 5, 4),
    item('A', 105, 4),
    item('B', 205, 4),
    item('Median (range)', 5, 21, 85),
    item('1.67', 125, 21),
    item('1.40', 225, 21),
    item('(0.08 to 4.12)', 105, 36, 85),
    item('(0.11 to 5.40)', 205, 36, 85),
    item('Ratio', 5, 54),
    item('1.3', 105, 54),
    item('1.2', 205, 54)
  ]
  expect(refineTable(table, items).grid).toContainEqual([
    'Median (range)',
    '1.67 (0.08 to 4.12)',
    '1.40 (0.11 to 5.40)'
  ])
  for (const variant of [
    items.filter((i) => i.text !== '(0.11 to 5.40)'),
    [...items, item('95% CI', 5, 36)],
    items.map((i) => (i.text === 'Median (range)' ? { ...i, text: 'Estimate' } : i))
  ])
    expect(
      refineTable(table, variant).grid.some((r: string[]) => r[1] === '1.67 (0.08 to 4.12)')
    ).toBe(false)
  expect(
    refineTable(table, items, [], [], [[0, 34, 300, 34]]).grid.some(
      (r: string[]) => r[1] === '1.67 (0.08 to 4.12)'
    )
  ).toBe(false)
})

it('keeps a continuous projected row heading together across a model column boundary', () => {
  const table = model(3, [0, 20, 40, 60, 80])
  table.structure.objects.push({ label: 'table projected row header', rect: [0, 20, 300, 40] })
  const heading = [item('Lymphonodal', 5, 24, 94), item('status', 102, 24, 30)]
  const body = [
    item('Characteristic', 5, 4),
    item('Group A', 105, 4),
    item('Group B', 205, 4),
    item('N0', 15, 44),
    item('14 (31)', 105, 44),
    item('12 (26)', 205, 44),
    item('N1', 15, 64),
    item('31 (69)', 105, 64),
    item('35 (74)', 205, 64)
  ]
  const result = refineTable(table, [...body, ...heading])
  expect(result.cells.find((c: { text: string }) => c.text === 'Lymphonodal status')).toMatchObject(
    { rowSpan: 1, colSpan: 3 }
  )
  for (const fragments of [
    [heading[0], item('status', 120, 24, 30)],
    [heading[0], item('14', 102, 24, 12)],
    [heading[0], item('status', 102, 31, 30)]
  ]) {
    expect(
      refineTable(table, [...body, ...fragments]).cells.some(
        (c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 3
      )
    ).toBe(false)
  }
  const withoutRole = {
    ...table,
    structure: {
      objects: table.structure.objects.filter((o) => o.label !== 'table projected row header')
    }
  }
  expect(
    refineTable(withoutRole, [...body, ...heading]).cells.some(
      (c: { text: string; colSpan: number }) => c.text === 'Lymphonodal status' && c.colSpan === 3
    )
  ).toBe(false)
})

it('extends a centered stub through a recovered parent header without crossing a rule or another label', () => {
  const table = model(5, [20, 45, 65])
  table.structure.objects.find((o) => o.label === 'table column header')!.rect[1] = 20
  const items = [
    item('Group A', 170, 4, 60),
    item('Group B', 370, 4, 60),
    item('Population', 5, 16, 55),
    item('A1', 120, 30),
    item('A2', 220, 30),
    item('B1', 320, 30),
    item('B2', 420, 30),
    item('Count', 5, 50),
    item('1', 120, 50),
    item('2', 220, 50),
    item('3', 320, 50),
    item('4', 420, 50)
  ]
  const rules = [
    [105, 18, 295, 18],
    [305, 18, 495, 18]
  ]
  const parsed = refineTable(table, items, [], [], rules)
  expect(parsed.cells.find((c: { text: string }) => c.text === 'Population')).toMatchObject({
    row: 0,
    rowSpan: 2,
    colSpan: 1
  })
  for (const [tokens, borders] of [
    [items, [...rules, [0, 18, 100, 18]]],
    [[...items, item('Separate', 5, 4)], rules],
    [items.map((i) => (i.text === 'Population' ? item('Population', 5, 30, 55) : i)), rules]
  ]) {
    expect(
      refineTable(table, tokens, [], [], borders).cells.find(
        (c: { text: string }) => c.text === 'Population'
      )?.rowSpan
    ).toBe(1)
  }
})

it('trims a shared P value off the preceding section heading while preserving both records', () => {
  const table = model(3, [0, 20, 40, 60, 80])
  table.structure.objects.push(
    { label: 'table projected row header', rect: [0, 20, 300, 40] },
    { label: 'table spanning cell', rect: [200, 20, 300, 80] }
  )
  const items = [
    item('Response', 5, 4),
    item('N', 105, 4),
    item('P', 205, 4),
    item('pCR', 5, 24),
    item('Yes', 5, 44),
    item('13', 105, 44),
    item('0.896', 205, 44),
    item('No', 5, 64),
    item('34', 105, 64)
  ]
  const result = refineTable(table, items)
  expect(result.cells.find((c: { text: string }) => c.text === '0.896')).toMatchObject({
    row: 2,
    column: 2,
    rowSpan: 2,
    colSpan: 1
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'pCR')).toMatchObject({
    rowSpan: 1,
    colSpan: 3
  })
  const conflicting = refineTable(table, [...items, item('0.1', 205, 24)])
  expect(conflicting.cells.find((c: { text: string }) => c.text === '0.896')?.rowSpan).toBe(1)
})

it('retains a raised footnote on a continuous projected heading across columns', () => {
  const table = model(3, [0, 20, 40, 60])
  table.structure.objects.push({ label: 'table projected row header', rect: [0, 20, 300, 40] })
  const marker = {
    text: 'e',
    rect: [132, 22.6, 136, 29.6],
    baseline: 29.6,
    height: 7,
    horizontal: true
  }
  const items = [
    item('Characteristic', 5, 4),
    item('A', 105, 4),
    item('B', 205, 4),
    item('Prior therapy,', 5, 24, 93),
    item('n (%)', 101, 24, 30),
    marker,
    item('None', 5, 44),
    item('39', 105, 44),
    item('35', 205, 44)
  ]
  const result = refineTable(table, items)
  expect(
    result.cells.find((c: { text: string }) => c.text === 'Prior therapy, n (%)e')
  ).toMatchObject({
    colSpan: 3,
    rowSpan: 1,
    textRuns: [
      { text: 'Prior therapy, n (%)', position: 'normal' },
      { text: 'e', position: 'superscript' }
    ]
  })
  const ordinary = refineTable(
    table,
    items.map((i) => (i === marker ? item('e', 150, 24, 4) : i))
  )
  expect(
    ordinary.cells.some((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 3)
  ).toBe(false)
})

it('recovers a projected section and its overlapping baseline record with literal ellipses', () => {
  const table = model(5, [0, 20, 40, 68, 82, 100, 120])
  const bands = table.structure.objects.filter((o) => o.label === 'table row')
  bands[2].rect[1] = 47
  bands[3].rect[1] = 62
  table.structure.objects.push({ label: 'table projected row header', rect: [0, 38, 500, 52] })
  const items = [
    ...['Outcome', 'N', 'Mean SD', 'P', 'Difference'].map((t, c) => item(t, c * 100 + 5, 4)),
    ...[24, 60, 84, 104].flatMap((y, r) =>
      [r === 1 ? 'Baseline' : `Visit ${r}`, '52', '155±40', '…', '…'].map((t, c) =>
        item(t, c * 100 + 5, y)
      )
    ),
    item('Peak power output, W', 5, 40, 120)
  ]
  const result = refineTable(table, items, [
    { lines: ['Table 1. Outcomes'], rect: [0, -20, 300, -10] }
  ])
  expect(result.unassigned).toEqual([])
  const row = result.grid.findIndex((r: string[]) => r[0] === 'Peak power output, W')
  expect(row).toBeGreaterThan(0)
  expect(result.grid[row + 1]).toEqual(['Baseline', '52', '155±40', '…', '…'])
  expect(result.grid.filter((r: string[]) => r[2] === '155±40')).toHaveLength(4)
})

it('recovers a boxed interval parent above an inset model header', () => {
  const table = model(5, [30, 50, 80, 110, 140])
  table.cropRect[1] = 0
  const items = [
    item('95% CI', 215, 10),
    item('Mean', 110, 33),
    item('Lower', 210, 33),
    item('Upper', 310, 33),
    item('P', 410, 33),
    ...[60, 90, 120].flatMap((y, i) => [
      item(`Outcome ${i}`, 5, y),
      item('1.2', 110, y),
      item('0.8', 210, y),
      item('1.5', 310, y),
      item('0.04', 410, y)
    ])
  ]
  const rules = [
    [0, 5, 200, 5],
    [400, 5, 500, 5],
    [0, 28, 200, 28],
    [400, 28, 500, 28],
    [200, 5, 400, 5],
    [200, 5, 200, 28],
    [400, 5, 400, 28],
    [200, 28, 400, 28],
    [300, 28, 300, 50]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(result.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '95% CI', row: 0, column: 2, colSpan: 2 })
    ])
  )
})
