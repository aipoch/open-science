import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { resolveTableCellMerges } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)
const { populateTableCellText, reconcileFragmentedCountHeaders } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)

const token = (text: string, rect: number[]): object => ({
  text,
  rect,
  baseline: rect[3],
  height: rect[3] - rect[1],
  horizontal: true
})

type TextCell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
  origin: string
  items: object[]
  text?: string
}

const textCell = (
  row: number,
  column: number,
  rect: number[],
  origin = 'model-grid'
): TextCell => ({
  row,
  column,
  rowSpan: 1,
  colSpan: 1,
  rect,
  origin,
  items: []
})

it.each([
  ['7', '7'],
  ['Group', 'Group'],
  ['Group A', 'Group']
])('keeps %s cell text from hiding an unowned %s token', (assigned, unowned) => {
  const cells = [textCell(0, 0, [0, 0, 50, 20]), textCell(0, 1, [50, 0, 100, 20])]
  const items = [token(assigned, [5, 5, 35, 15]), token(unowned, [45, 5, 55, 15])]
  const issues = new Set<string>()
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows: [{ rect: [0, 0, 100, 20] }],
    columnRects: [
      [0, 0, 50, 20],
      [50, 0, 100, 20]
    ],
    headerRows: [],
    rules: [],
    bottom: 20,
    issues,
    repairs: []
  })
  expect(cells.map((cell) => cell.text)).toEqual([assigned, ''])
  expect(unassigned).toEqual([unowned])
  expect(issues).toContain('unassigned-source-text')
})

it('keeps a split confidence interval tail with the preceding estimate', () => {
  const cells = [
    textCell(0, 0, [0, 0, 50, 35]),
    textCell(0, 1, [50, 0, 100, 35]),
    textCell(1, 0, [0, 15, 50, 55]),
    textCell(1, 1, [50, 15, 100, 55])
  ]
  const rows = [{ rect: [0, 0, 100, 35] }, { rect: [0, 15, 100, 55] }]
  const items = [token('Estimate (–2 to', [60, 5, 95, 15]), token('–3)', [60, 20, 80, 30])]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects: [
      [0, 0, 50, 100],
      [50, 0, 100, 100]
    ],
    headerRows: [],
    rules: [],
    bottom: 60,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[1].text).toBe('Estimate (–2 to –3)')
  expect(repairs).toContain('confidence-interval-tail-recovered')
})

it('reconciles repeated count headers split at a model column boundary', () => {
  const cells = [
    { ...textCell(0, 0, [0, 0, 20, 20]), text: '' },
    { ...textCell(0, 1, [20, 0, 40, 20]), text: '(n' },
    { ...textCell(0, 2, [40, 0, 60, 20]), text: 'Anastrozole 1 mg = 49)' },
    { ...textCell(0, 3, [60, 0, 80, 20]), text: '(n' },
    { ...textCell(0, 4, [80, 0, 100, 20]), text: 'Tamoxifen 20 mg = 50)' },
    { ...textCell(1, 0, [0, 20, 20, 40]), text: '' },
    { ...textCell(1, 1, [20, 20, 40, 40]), text: 'n' },
    { ...textCell(1, 2, [40, 20, 60, 40]), text: '(%)' },
    { ...textCell(1, 3, [60, 20, 80, 40]), text: 'n' },
    { ...textCell(1, 4, [80, 20, 100, 40]), text: '(%)' }
  ]
  const issues = new Set(['span-conflicts-with-source-columns'])
  const repairs: string[] = []
  expect(reconcileFragmentedCountHeaders({ cells, issues, repairs })).toBe(2)
  expect(cells.filter((cell) => cell.row === 0)).toEqual([
    expect.objectContaining({ row: 0, column: 0, colSpan: 1, text: '' }),
    expect.objectContaining({
      row: 0,
      column: 1,
      colSpan: 2,
      rect: [20, 0, 60, 20],
      text: 'Anastrozole 1 mg (n = 49)'
    }),
    expect.objectContaining({
      row: 0,
      column: 3,
      colSpan: 2,
      rect: [60, 0, 100, 20],
      text: 'Tamoxifen 20 mg (n = 50)'
    })
  ])
  expect(issues).toEqual(new Set())
  expect(repairs).toContain('fragmented-treatment-header-reconciled')
})

it('recovers a missing time-point record beside a continuation fragment', () => {
  const cells = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) =>
      textCell(row, column, [
        column * 50,
        row === 0 ? 0 : row === 1 ? 20 : 42,
        (column + 1) * 50,
        row === 0 ? 20 : row === 1 ? 46 : 70
      ])
    )
  ).flat()
  const rows = [{ rect: [0, 0, 200, 20] }, { rect: [0, 20, 200, 46] }, { rect: [0, 42, 200, 70] }]
  const items = [
    token('T1', [10, 28, 25, 36]),
    token('10', [60, 28, 75, 36]),
    token('20', [110, 28, 125, 36]),
    token('0.4', [160, 28, 180, 36]),
    token('T2', [10, 40, 25, 48]),
    token('11', [60, 40, 75, 48]),
    token('21', [110, 40, 125, 48]),
    token('1.2', [160, 40, 180, 48]),
    token('to 16)', [160, 50, 190, 58])
  ]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects: [
      [0, 0, 50, 100],
      [50, 0, 100, 100],
      [100, 0, 150, 100],
      [150, 0, 200, 100]
    ],
    headerRows: [0],
    rules: [],
    bottom: 80,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells.find((cell) => cell.row === 2 && cell.column === 0)?.text).toBe('T2')
  expect(cells.find((cell) => cell.row === 2 && cell.column === 3)?.text).toBe('1.2 to 16)')
  expect(repairs).toContain('complete-statistical-record-recovered')
})

it('keeps a split superscript exponent beside a repeated footnote marker', () => {
  const cells = [textCell(0, 0, [0, 0, 200, 30])]
  const label = token('1 Median PSA, ng mL', [10, 10, 100, 22])
  const sign = { ...token('−', [100, 8.5, 106, 16.5]), inlineSymbol: true }
  const exponent = token('1', [106, 8.5, 112, 16.5])
  const suffix = token('(IQR)', [114, 10, 140, 22])
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items: [label, sign, exponent, suffix],
    pageItems: [label, sign, exponent, suffix],
    rows: [{ rect: [0, 0, 200, 30] }],
    columnRects: [[0, 0, 200, 30]],
    headerRows: [],
    rules: [],
    bottom: 30,
    recordGrid: { ownedTokens: new Set([label, sign, suffix]) },
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[0].text).toBe('1 Median PSA, ng mL−1 (IQR)')
  expect(repairs).toContain('multi-glyph-script-recovered')
})

it('preserves a narrow source gap after a repaired sample-size equals sign', () => {
  const cells = [textCell(0, 0, [0, 0, 100, 20])]
  const items = [
    token('(n', [10, 5, 24, 15]),
    token('=', [26, 5, 32, 15]),
    token('119)', [33, 5, 52, 15])
  ]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows: [{ rect: [0, 0, 100, 20] }],
    columnRects: [[0, 0, 100, 20]],
    headerRows: [],
    rules: [],
    bottom: 20,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[0].text).toBe('(n = 119)')
})

it('recovers numeric-leading treatment headers from a padded ruled crop', () => {
  const table = {
    id: 'numeric-leading-header',
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...Array.from({ length: 5 }, (_, column) => ({
          label: 'table column',
          rect: [column * 100, 0, (column + 1) * 100, 130]
        })),
        { label: 'table column header', rect: [0, 24, 500, 38] },
        { label: 'table row', rect: [0, 24, 500, 38] },
        { label: 'table row', rect: [0, 38, 500, 58] }
      ]
    }
  }
  const source = [
    token('5-Session arm (N=163)', [120, 8, 190, 18]),
    token('1-Session arm (N=164)', [320, 8, 390, 18]),
    token('N (%)', [120, 26, 160, 34]),
    token('M (SD)', [220, 26, 270, 34]),
    token('N (%)', [320, 26, 360, 34]),
    token('M (SD)', [420, 26, 470, 34]),
    token('Age', [10, 42, 35, 50]),
    token('10 (1)', [120, 42, 160, 50]),
    token('20 (2)', [220, 42, 260, 50]),
    token('30 (3)', [320, 42, 360, 50]),
    token('40 (4)', [420, 42, 460, 50])
  ]
  const result = refineTable(
    table,
    source,
    [{ lines: ['Table 1. Demographics'], rect: [0, -20, 160, -10] }],
    [],
    [
      [0, 4, 500, 4],
      [0, 22, 500, 22],
      [0, 36, 500, 36]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid.slice(0, 2)).toEqual([
    ['', '5-Session arm (N=163)', '', '1-Session arm (N=164)', ''],
    ['', 'N (%)', 'M (SD)', 'N (%)', 'M (SD)']
  ])
  expect(result.repairs).toContain('treatment-header-recovered')
})

it('recovers a single parent line above a detected leaf header', () => {
  const result = refineTable(
    {
      id: 'stacked-parent-header',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 20, 300, 70] },
          { label: 'table row', rect: [0, 20, 300, 35] },
          { label: 'table row', rect: [0, 35, 300, 52] },
          { label: 'table row', rect: [0, 52, 300, 70] }
        ]
      }
    },
    [
      token('Parent', [210, 8, 260, 16]),
      token('Leaf', [210, 22, 240, 30]),
      token('Value', [110, 22, 145, 30]),
      token('Label', [10, 39, 45, 47]),
      token('1', [210, 39, 218, 47])
    ],
    [{ lines: ['Table 1. Stacked header'], rect: [0, -20, 120, -10] }],
    [],
    [
      [0, 5, 300, 5],
      [0, 70, 300, 70]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][2]).toBe('Parent Leaf')
  expect(result.repairs).toContain('leading-header-line-recovered')
})

it('recovers a multi-column header band with wrapped comparison labels', () => {
  const rows = [
    [0, 30, 800, 50],
    [0, 50, 800, 66],
    [0, 66, 800, 82]
  ]
  const groups = [
    [
      token('Training', [120, 8, 170, 18]),
      token('Control', [220, 8, 270, 18]),
      token('Training effect*', [320, 8, 390, 18]),
      token('p for TE', [420, 8, 470, 18]),
      token('1', [470, 10, 474, 16]),
      token('p for IE', [520, 8, 570, 18]),
      token('2', [570, 10, 574, 16])
    ],
    [token('(Training vs.', [320, 20, 390, 30])],
    [token('Control)', [320, 31, 370, 41])]
  ]
  const columnRects = Array.from({ length: 8 }, (_, column) => [
    column * 100,
    0,
    (column + 1) * 100,
    100
  ])
  const result = refineTable(
    {
      id: 'multicolumn-wrapped-header',
      cropRect: [0, 0, 800, 100],
      structure: {
        objects: [
          ...columnRects.map((rect) => ({ label: 'table column', rect })),
          ...rows.map((rect) => ({ label: 'table row', rect }))
        ]
      }
    },
    [
      ...groups.flat(),
      token('Measure', [10, 52, 80, 60]),
      token('Baseline', [120, 52, 170, 60]),
      token('Value', [10, 68, 50, 76]),
      token('10', [120, 68, 135, 76])
    ],
    [{ lines: ['Table 1. Wrapped comparison'], rect: [0, -20, 200, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid[0]).toEqual([
    '',
    'Training',
    'Control',
    'Training effect* (Training vs. Control)',
    'p for TE1',
    'p for IE2',
    '',
    ''
  ])
  expect(result.repairs).toContain('clipped-multicolumn-heading-recovered')
})

it('recovers a complete numeric row missed between detected records', () => {
  const result = refineTable(
    {
      id: 'missing-numeric-row',
      cropRect: [0, 0, 400, 120],
      structure: {
        objects: [
          ...Array.from({ length: 4 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 120]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] },
          { label: 'table row', rect: [0, 20, 400, 35] },
          { label: 'table row', rect: [0, 58, 400, 75] },
          { label: 'table row', rect: [0, 78, 400, 95] }
        ]
      }
    },
    [
      token('Range', [10, 25, 55, 33]),
      token('1–2', [110, 25, 130, 33]),
      token('2–3', [210, 25, 230, 33]),
      token('3–4', [310, 25, 330, 33]),
      token('Mean', [10, 42, 45, 50]),
      token('1.8', [110, 42, 125, 50]),
      token('2.1', [210, 42, 225, 50]),
      token('1.5', [310, 42, 325, 50]),
      token('Total', [10, 62, 45, 70]),
      token('3.6', [110, 62, 125, 70]),
      token('1.1', [210, 62, 225, 70]),
      token('6.2', [310, 62, 325, 70])
    ],
    [{ lines: ['Table 1. Missing row'], rect: [0, -20, 120, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual(['Mean', '1.8', '2.1', '1.5'])
  expect(result.repairs).toContain('text-supported-row-recovered')
})

it('recovers a missing statistical row with a non-significant value', () => {
  const result = refineTable(
    {
      id: 'missing-ns-row',
      cropRect: [0, 0, 700, 130],
      structure: {
        objects: [
          ...Array.from({ length: 7 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 130]
          })),
          { label: 'table column header', rect: [0, 0, 700, 20] },
          { label: 'table row', rect: [0, 20, 700, 36] },
          { label: 'table row', rect: [0, 54, 700, 70] },
          { label: 'table row', rect: [0, 72, 700, 88] }
        ]
      }
    },
    [
      token('Definition of cancer', [10, 24, 95, 32]),
      token('28%', [110, 24, 135, 32]),
      token('35%', [210, 24, 235, 32]),
      token('36%', [310, 24, 335, 32]),
      token('0.72', [410, 24, 440, 32]),
      token('ns', [610, 24, 625, 32]),
      token('Definition of Pap test', [10, 42, 100, 50]),
      token('41%', [110, 42, 135, 50]),
      token('49%', [210, 42, 235, 50]),
      token('67%', [310, 42, 335, 50]),
      token('4.62*', [410, 42, 445, 50]),
      token('ns', [610, 42, 625, 50]),
      token('Frequency of Pap test', [10, 58, 100, 66]),
      token('31%', [110, 58, 135, 66]),
      token('32%', [210, 58, 235, 66]),
      token('16%', [310, 58, 335, 66]),
      token('3.17', [410, 58, 440, 66]),
      token('ns', [610, 58, 625, 66])
    ],
    [{ lines: ['Table 3. Knowledge indicators'], rect: [0, -20, 180, -10] }]
  )
  expect(result.grid).toContainEqual([
    'Definition of Pap test',
    '41%',
    '49%',
    '67%',
    '4.62*',
    '',
    'ns'
  ])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('text-supported-row-recovered')
})

it('merges wide statistical section headings across native body columns', () => {
  const result = refineTable(
    {
      id: 'wide-statistical-section',
      cropRect: [0, 0, 500, 100],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 100]
          })),
          { label: 'table column header', rect: [0, 0, 500, 18] },
          { label: 'table row', rect: [0, 18, 500, 34] },
          { label: 'table row', rect: [0, 34, 500, 50] }
        ]
      }
    },
    [
      token('Outcome scale (statistical result', [10, 21, 270, 29]),
      token('P', [270, 21, 278, 29]),
      token('=.52b)', [278, 21, 315, 29]),
      token('Control', [10, 38, 55, 46]),
      token('10', [110, 38, 125, 46]),
      token('20', [210, 38, 225, 46]),
      token('30', [310, 38, 325, 46]),
      token('40', [410, 38, 425, 46])
    ],
    [{ lines: ['Table 1. Wide section'], rect: [0, -18, 150, -8] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][0]).toBe('Outcome scale (statistical resultP=.52b)')
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 0
    )?.colSpan
  ).toBe(5)
  expect(result.repairs).toContain('source-wide-section-span-recovered')
})

it('recovers a detached continuation above a native table header', () => {
  const result = refineTable(
    {
      id: 'detached-header-continuation',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 20, 300, 50] },
          { label: 'table row', rect: [0, 20, 300, 34] },
          { label: 'table row', rect: [0, 34, 300, 50] }
        ]
      }
    },
    [
      token('Bonferroni post hoc', [205, 10, 285, 18]),
      token('Pairwise comparisons', [205, 22, 285, 30]),
      token('Outcome A', [10, 38, 70, 46]),
      token('Control', [110, 38, 150, 46]),
      token('0.04', [205, 38, 225, 46])
    ],
    [{ lines: ['Table 1. Results'], rect: [0, -20, 120, -10] }]
  )
  expect(result.grid[0][2]).toContain('Bonferroni post hoc')
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('detached-header-continuation-recovered')
})

it('restores a statistical parent header over empty model child columns', () => {
  const result = refineTable(
    {
      id: 'statistical-parent-header',
      cropRect: [0, 0, 600, 90],
      structure: {
        objects: [
          ...Array.from({ length: 6 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 600, 30] },
          { label: 'table spanning cell', rect: [400, 0, 600, 20] },
          { label: 'table row', rect: [0, 0, 600, 20] },
          { label: 'table row', rect: [0, 20, 600, 40] }
        ]
      }
    },
    [
      token('Scale', [10, 5, 45, 13]),
      token('Control', [110, 5, 160, 13]),
      token('Linear mixed model statistical tests', [405, 5, 585, 13]),
      token('Outcome', [10, 25, 55, 33]),
      token('10', [110, 25, 125, 33]),
      token('20', [210, 25, 225, 33]),
      token('30', [310, 25, 325, 33]),
      token('40', [410, 25, 425, 33]),
      token('50', [510, 25, 525, 33])
    ]
  )
  expect(result.grid[0][4]).toBe('Linear mixed model statistical tests')
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 4, colSpan: 2, rowSpan: 1 })
  )
  expect(result.unassigned).toEqual([])
})

it('spans descriptive statistical section labels before numeric effects', () => {
  const result = refineTable(
    {
      id: 'statistical-section-label',
      cropRect: [0, 0, 600, 80],
      structure: {
        objects: [
          ...Array.from({ length: 6 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 80]
          })),
          { label: 'table column header', rect: [0, 0, 600, 16] },
          { label: 'table row', rect: [0, 0, 600, 16] },
          { label: 'table row', rect: [0, 16, 600, 32] },
          { label: 'table row', rect: [0, 32, 600, 48] }
        ]
      }
    },
    [
      token('Scale', [10, 4, 45, 12]),
      token('Functional well-being', [10, 20, 190, 28]),
      token('3.22 (1,102)', [310, 20, 375, 28]),
      token('.08', [410, 20, 430, 28]),
      token('5.25 (2,90)', [510, 20, 575, 28]),
      token('T0', [10, 36, 25, 44]),
      token('10', [110, 36, 125, 44]),
      token('20', [210, 36, 225, 44]),
      token('30', [310, 36, 325, 44]),
      token('40', [410, 36, 425, 44]),
      token('50', [510, 36, 525, 44])
    ]
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, colSpan: 3, text: 'Functional well-being' })
  )
  expect(result.unassigned).toEqual([])
})

it('recovers a text-only comparison section between numeric rows', () => {
  const result = refineTable(
    {
      id: 'missing-comparison-section',
      cropRect: [0, 0, 500, 110],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 110]
          })),
          { label: 'table row', rect: [0, 20, 500, 36] },
          { label: 'table row', rect: [0, 74, 500, 90] }
        ]
      }
    },
    [
      token('BCCT vs Panel', [10, 22, 90, 30]),
      token('83', [110, 22, 125, 30]),
      token('65', [210, 22, 225, 30]),
      token('18', [310, 22, 325, 30]),
      token('0.57', [410, 22, 440, 30]),
      token('Patient live vs patient live', [10, 44, 90, 52]),
      token('Clinician vs patient', [10, 76, 100, 84]),
      token('89', [110, 76, 125, 84]),
      token('88', [210, 76, 225, 84]),
      token('1', [310, 76, 318, 84]),
      token('0.15', [410, 76, 440, 84])
    ],
    [{ lines: ['Table 1. Agreement'], rect: [0, -20, 120, -10] }]
  )
  expect(result.grid).toContainEqual(['Patient live vs patient live', '', '', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('missing-section-row-recovered')
})

it('recovers aligned numeric tails wrapped below a statistical row', () => {
  const result = refineTable(
    {
      id: 'wrapped-numeric-tail',
      cropRect: [0, 0, 400, 110],
      structure: {
        objects: [
          ...Array.from({ length: 4 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 110]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] },
          { label: 'table row', rect: [0, 20, 400, 40] },
          { label: 'table row', rect: [0, 50, 400, 68] }
        ]
      }
    },
    [
      token('Group', [10, 24, 50, 32]),
      token('Placebo', [110, 24, 160, 32]),
      token('63.27 ±', [210, 24, 260, 32]),
      token('−5.27 ±', [310, 24, 360, 32]),
      token('1.1', [210, 34, 225, 42]),
      token('0.8', [310, 34, 325, 42]),
      token('Next', [10, 54, 40, 62]),
      token('1', [110, 54, 118, 62]),
      token('2', [210, 54, 218, 62]),
      token('3', [310, 54, 318, 62])
    ],
    [{ lines: ['Table 1. Wrapped statistic'], rect: [0, -20, 120, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][2]).toBe('63.27 ± 1.1')
  expect(result.grid[0][3]).toBe('−5.27 ± 0.8')
})

it('keeps split chi-square fragments with the populated section row', () => {
  const result = refineTable(
    {
      id: 'split-statistical-fragments',
      cropRect: [0, 0, 500, 90],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table row', rect: [0, 0, 500, 18] },
          { label: 'table row', rect: [0, 18, 500, 40] },
          { label: 'table row', rect: [0, 32, 500, 50] },
          { label: 'table row', rect: [0, 50, 500, 68] }
        ]
      }
    },
    [
      token('Characteristics', [5, 4, 80, 12]),
      token('Time since diagnosis, months, n (%)', [5, 20, 95, 28]),
      token('2', [310, 18, 315, 27]),
      token('χ', [300, 22, 307, 32]),
      token('(df)=3.945 (2)', [316, 22, 382, 32]),
      token('.14', [410, 22, 425, 32]),
      token('≤3', [5, 54, 20, 62]),
      token('25 (49)', [110, 54, 155, 62]),
      token('24 (46)', [210, 54, 255, 62])
    ],
    [{ lines: ['Table 1. Baseline characteristics'], rect: [0, -20, 180, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('ambiguous-cell-assignment')
  expect(result.grid.some((row: string[]) => row.includes('2 χ (df)=3.945 (2)'))).toBe(true)
})

it('keeps slash-wrapped values with the preceding row when bands overlap', () => {
  const result = refineTable(
    {
      id: 'overlapping-wrapped-row',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 300, 18] },
          { label: 'table row', rect: [0, 18, 300, 46] },
          { label: 'table row', rect: [0, 34, 300, 54] },
          { label: 'table row', rect: [0, 50, 300, 70] }
        ]
      }
    },
    [
      token('Four months', [8, 20, 70, 28]),
      token('8.8 (12.1) /', [110, 20, 170, 28]),
      token('9.7 (11.5) /', [210, 20, 270, 28]),
      token('3 (16)', [110, 36, 145, 44]),
      token('5.5 (12.5)', [210, 36, 260, 44]),
      token('12 months', [8, 52, 65, 60]),
      token('6.5 (11.3) /', [110, 52, 170, 60]),
      token('12.4 (15.1) /', [210, 52, 275, 60])
    ],
    [{ lines: ['Table 1. Patient characteristics'], rect: [0, -18, 180, -8] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('ambiguous-cell-assignment')
  const wrapped = result.grid.find((row: string[]) => row[0] === 'Four months')
  expect(wrapped?.slice(1)).toEqual(['8.8 (12.1) / 3 (16)', '9.7 (11.5) / 5.5 (12.5)'])
})

it('discards numeric model spans that absorb an independent value column', () => {
  const result = refineTable(
    {
      id: 'numeric-span-conflict',
      cropRect: [0, 0, 300, 70],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 70]
          })),
          { label: 'table row', rect: [0, 0, 300, 35] },
          { label: 'table row', rect: [0, 35, 300, 70] },
          { label: 'table spanning cell', rect: [100, 35, 300, 70] }
        ]
      }
    },
    [token('Label', [10, 8, 50, 18]), token('42', [210, 43, 230, 53])]
  )
  expect(result.grid).toEqual([
    ['Label', '', ''],
    ['', '', '42']
  ])
  expect(
    result.cells.some(
      (cell: { row: number; colSpan: number }) => cell.row === 1 && cell.colSpan > 1
    )
  ).toBe(false)
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-numeric-span-discarded')
})

it('assigns a ruled section label that crosses the stub boundary', () => {
  const result = refineTable(
    {
      id: 'ruled-section-label',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 300, 20] },
          ...[0, 20, 40].map((top) => ({ label: 'table row', rect: [0, top, 300, top + 20] }))
        ]
      }
    },
    [
      token('Variable', [10, 5, 55, 15]),
      token('Section heading', [10, 23, 180, 33]),
      token('10', [110, 43, 130, 53]),
      token('20', [210, 43, 230, 53])
    ],
    [],
    [],
    [[0, 38, 300, 38]]
  )
  expect(result.grid[1]).toEqual(['Section heading', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('source-section-span-recovered')
})

it('recovers compact count labels above repeated n/% columns', () => {
  const columns = 9
  const result = refineTable(
    {
      id: 'compact-count-header',
      cropRect: [0, 0, 900, 150],
      structure: {
        objects: [
          ...Array.from({ length: columns }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 150]
          })),
          { label: 'table column header', rect: [0, 40, 900, 80] },
          ...[40, 60, 80, 100].map((top) => ({
            label: 'table row',
            rect: [0, top, 900, top + 20]
          }))
        ]
      }
    },
    [
      token('Control (', [110, 20, 160, 30]),
      token('n', [160, 20, 170, 30]),
      token('=', [175, 20, 185, 30]),
      token('65)', [190, 20, 210, 30]),
      token('WBH', [310, 20, 350, 30]),
      token('(n', [350, 20, 370, 30]),
      token('=', [375, 20, 385, 30]),
      token('98)', [390, 20, 410, 30]),
      token('WBH2', [510, 20, 560, 30]),
      token('(n', [560, 20, 580, 30]),
      token('=', [585, 20, 595, 30]),
      token('35)', [600, 20, 620, 30]),
      token('Characteristics', [10, 62, 80, 70]),
      ...[110, 210, 310, 410, 510, 610].flatMap((x) => [
        token('n', [x, 62, x + 10, 70]),
        token('%', [x + 40, 62, x + 50, 70])
      ]),
      token('Race', [10, 85, 40, 93]),
      ...[110, 210, 310, 410, 510, 610].map((x, index) =>
        token(String(index + 1), [x, 85, x + 10, 93])
      ),
      token('Urban', [10, 105, 50, 113]),
      ...[110, 210, 310, 410, 510, 610].map((x, index) =>
        token(String(index + 2), [x, 105, x + 10, 113])
      )
    ],
    [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 150, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0].slice(1, 7)).toEqual([
    'Control (n = 65)',
    '',
    'WBH(n = 98)',
    '',
    'WBH2(n = 35)',
    ''
  ])
  expect(result.repairs).toContain('compact-treatment-header-recovered')
  expect(result.issues).not.toContain('unresolved-spanning-cells')
})

it.each(['complete', 'missing-rule', 'different-leaf', 'crossing-rule'])(
  'recovers separate parent and leaf tiers only with complete evidence (%s)',
  (variant) => {
    const columns = 7
    const result = refineTable(
      {
        id: 'ruled-parent-groups',
        cropRect: [0, 0, 700, 120],
        structure: {
          objects: [
            ...Array.from({ length: columns }, (_, column) => ({
              label: 'table column',
              rect: [column * 100, 0, (column + 1) * 100, 120]
            })),
            { label: 'table column header', rect: [0, 20, 700, 35] },
            ...[20, 35, 50, 65].map((top) => ({
              label: 'table row',
              rect: [0, top, 700, top + 15]
            }))
          ]
        }
      },
      [
        token('Grade <5*', [110, 5, 205, 14]),
        token('Grade', [410, 5, 485, 14]),
        token('≥5*', [487, 5, 515, 14]),
        token('Odds ratio', [110, 24, 170, 32]),
        token('95%CI', [210, 24, 255, 32]),
        token('P-value', [310, 24, 355, 32]),
        token('Odds ratio', [410, 24, 470, 32]),
        token('95%CI', [510, 24, 555, 32]),
        token(variant === 'different-leaf' ? 'Count' : 'P-value', [610, 24, 655, 32]),
        token('No family history', [10, 39, 90, 47]),
        token('Reference', [110, 39, 165, 47]),
        token('Reference', [410, 39, 465, 47]),
        token('Prostate cancer only', [10, 54, 95, 62]),
        token('1.46', [110, 54, 135, 62]),
        token('1.18–1.80', [210, 54, 265, 62]),
        token('<0.001', [310, 54, 350, 62]),
        token('1.51', [410, 54, 435, 62]),
        token('1.10–2.06', [510, 54, 565, 62]),
        token('0.01', [610, 54, 635, 62]),
        token('Breast cancer only', [10, 69, 95, 77]),
        token('1.10', [110, 69, 135, 77]),
        token('0.86–1.40', [210, 69, 265, 77]),
        token('0.46', [310, 69, 335, 77]),
        token('0.92', [410, 69, 435, 77]),
        token('0.62–1.36', [510, 69, 565, 77]),
        token('0.66', [610, 69, 635, 77])
      ],
      [{ lines: ['Table 1. Grouped statistics'], rect: [0, -20, 150, -10] }],
      [],
      [
        [110, 17, variant === 'crossing-rule' ? 455 : 355, 17],
        ...(variant === 'missing-rule' ? [] : [[410, 17, 655, 17]]),
        [0, 37, 700, 37]
      ]
    )
    if (variant !== 'complete') {
      expect(result.repairs).not.toContain('ruled-group-header-recovered')
      return
    }
    expect(result.unassigned).toEqual([])
    expect(result.issues).not.toContain('unassigned-source-text')
    expect(result.grid[0].slice(1, 7)).toEqual(['Grade <5*', '', '', 'Grade ≥5*', '', ''])
    expect(result.grid[1]).toEqual([
      '',
      'Odds ratio',
      '95%CI',
      'P-value',
      'Odds ratio',
      '95%CI',
      'P-value'
    ])
    expect(result.cells.filter((cell: { row: number }) => cell.row === 1)).toHaveLength(7)
    expect(result.cells).toContainEqual(
      expect.objectContaining({ row: 0, column: 1, rowSpan: 1, colSpan: 3, text: 'Grade <5*' })
    )
    expect(result.cells).toContainEqual(
      expect.objectContaining({ row: 0, column: 4, rowSpan: 1, colSpan: 3, text: 'Grade ≥5*' })
    )
    expect(result.repairs).toContain('ruled-group-header-recovered')
  }
)

it.each([false, true])(
  'reconciles nested section spans only with empty trailing slots (value: %s)',
  (hasValue) => {
    const baseCells = Array.from({ length: 3 }, (_, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, 0, (column + 1) * 100, 20],
      sourceTokens: []
    }))
    const items = [
      token('Section measurements', [10, 5, 190, 15]),
      // The next record touches the heading band but its center belongs below it.
      token('0.64', [210, 19, 235, 29]),
      ...(hasValue ? [token('0.12', [210, 5, 235, 15])] : [])
    ]
    const issues = new Set<string>()
    const repairs: string[] = []
    const cells = resolveTableCellMerges({
      proposals: [
        { slots: baseCells.slice(0, 2), origin: 'model-span', sectionHeader: true },
        { slots: baseCells, origin: 'model-span', sectionHeader: true }
      ],
      baseCells,
      items,
      rows: [{ rect: [0, 0, 300, 20] }],
      headerRows: [0],
      headerRuns: new Map(),
      rules: [],
      recordGrid: undefined,
      populatedColumns: () => [0, 1, 2],
      issues,
      repairs
    })
    if (hasValue) {
      expect(repairs).not.toContain('duplicate-model-span-discarded')
      expect(cells).not.toContainEqual(expect.objectContaining({ row: 0, column: 0, colSpan: 3 }))
    } else {
      expect(issues).not.toContain('conflicting-spanning-cells')
      expect(cells).toContainEqual(expect.objectContaining({ row: 0, column: 0, colSpan: 3 }))
      expect(repairs).toContain('duplicate-model-span-discarded')
    }
  }
)
