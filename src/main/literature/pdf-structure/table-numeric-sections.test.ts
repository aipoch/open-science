import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const token = (text: string, column: number, line: number): object => ({
  text,
  rect: [column * 150 + 10, line * 16 + 3, column * 150 + 120, line * 16 + 15],
  height: 12,
  baseline: line * 16 + 15,
  horizontal: true
})
it('recovers a dropped record in a short captioned table enclosed by header and footer rules', () => {
  const grid = [
    ['', 'Arm A', 'Arm B', 'Arm C'],
    ...Array.from({ length: 7 }, (_, i) => [`Outcome ${i}`, '1.0', '1.3', '1.0'])
  ]
  const table = {
    id: 'short-records',
    cropRect: [0, 0, 600, 128],
    structure: {
      objects: [
        ...Array.from({ length: 4 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, 128]
        })),
        { label: 'table column header', rect: [0, 0, 600, 16] },
        ...grid.flatMap((_, r) =>
          r === 5
            ? [
                { label: 'table row', rect: [0, 80, 600, 84] },
                { label: 'table row', rect: [0, 94, 600, 96] }
              ]
            : [{ label: 'table row', rect: [0, r * 16, 600, r * 16 + 16] }]
        )
      ]
    }
  }
  const items = grid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  const captions = [{ lines: ['Table 4. Recovery outcomes'], rect: [0, -20, 600, -5] }]
  const rules = [
    [0, 0, 600, 0],
    [0, 16, 600, 16],
    [0, 128, 600, 128]
  ]
  expect(refineTable(table, items, captions, [], rules).grid).toEqual(grid)
  expect(refineTable(table, items, captions, [], rules).unassigned).toEqual([])
  expect(refineTable(table, items, [], [], rules).grid).not.toEqual(grid)
})
it('recovers nested sections and sparse numeric rows beside repeated P columns', () => {
  const grid = [
    ['Characteristic', 'Arm A', 'Arm B', 'P', 'Arm C', 'Arm D', 'P'],
    ['Demographics', '', '', '', '', '', ''],
    ['Sex', '', '', '', '', '', ''],
    ...Array.from({ length: 12 }, (_, i) => [
      i === 6 ? '<85%' : `Category ${i}`,
      '55.6',
      '66.7',
      i % 2 ? '' : '.60',
      '59.1',
      '44.4',
      i % 2 ? '' : '.46'
    ]),
    ['Missing (n)', '1', '1', '', '', '', '']
  ]
  const table = {
    id: 'sparse',
    cropRect: [0, 0, 1050, 270],
    structure: {
      objects: [
        ...Array.from({ length: 7 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, c * 150 + 150, 270]
        })),
        { label: 'table column header', rect: [0, 0, 1050, 16] },
        ...grid
          .filter((_, r) => r !== 9)
          .map((_, r) => ({ label: 'table row', rect: [0, r * 16, 1050, r * 16 + 16] }))
      ]
    }
  }
  const items = grid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  const result = refineTable(table, items)
  expect(result.grid).toEqual(grid)
  expect(result.unassigned).toEqual([])
})

it('recovers complete count and hazard-ratio records with verbal interval separators', () => {
  const grid = [
    ['Factor', 'Count', 'HR'],
    ...Array.from({ length: 6 }, (_, i) => [
      [`Marker ${i}`, '', ''],
      ['Positive', '36 (62)', '1.7 (1.0 to 2.7)'],
      ['Negative', '64 (109)', '1.0 (referent)']
    ]).flat()
  ]
  const height = grid.length * 16
  const raw = {
    id: 'hazard-records',
    cropRect: [0, 0, 450, height],
    structure: {
      objects: [
        ...Array.from({ length: 3 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 450, 16] },
        { label: 'table row', rect: [0, 0, 450, 16] },
        { label: 'table row', rect: [0, 16, 450, height] }
      ]
    }
  }
  const source = grid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  expect(refineTable(raw, source).grid).toEqual(grid)
  const prose = grid.flatMap((row, r) =>
    row.flatMap((text, c) =>
      text ? [token(text === '1.0 (referent)' ? '1.0 (unrelated prose)' : text, c, r)] : []
    )
  )
  expect(refineTable(raw, prose).repairs).not.toContain('text-supported-numeric-rows-recovered')
})
it('separates two-column interval records across ruled repeated headers and wrapped labels', () => {
  const lines = [
    ['Variable', 'Invasive, HR (95% CI)'],
    ['Age', '1.0 (0.8 to 1.3)'],
    ['Detection', '2.7 (1.4 to 5.5)'],
    ['(vs screening)†', ''],
    ['Grade', ''],
    ['High', '1.7 (0.6 to 4.8)'],
    ['Intermediate', '1.3 (0.4 to 4.1)'],
    ['Low', '1.0 (referent)'],
    ['Other', '1.2 (0.9 to 1.5)'],
    ['Variable†', 'DCIS, HR (95% CI)'],
    ['Age', '0.9 (0.7 to 1.1)'],
    ['Margins', ''],
    ['Positive', '1.3 (1.1 to 1.7)'],
    ['Negative', '1.0 (referent)'],
    ['Grade', ''],
    ['High', '1.7 (0.6 to 4.8)'],
    ['Intermediate', '1.3 (0.4 to 4.1)'],
    ['Low', '1.0 (referent)']
  ]
  const height = lines.length * 16
  const raw = {
    id: 'interval-blocks',
    cropRect: [0, 0, 300, height],
    structure: {
      objects: [
        ...[0, 1].map((c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 300, 16] },
        { label: 'table row', rect: [0, 0, 300, 16] },
        { label: 'table row', rect: [0, 16, 300, height] },
        { label: 'table spanning cell', rect: [0, 32, 300, 64] }
      ]
    }
  }
  const items = lines.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  const rules = [0, 16, 144, 160, height].map((y) => [0, y, 300, y])
  const captions = [{ lines: ['Table 1. Results'], rect: [0, -30, 300, -10] }]
  const result = refineTable(raw, items, captions, [], rules)
  expect(result.grid).toEqual(
    lines
      .filter((_, r) => r !== 3)
      .map((row, r) => (r === 2 ? ['Detection (vs screening)†', row[1]] : row))
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(refineTable(raw, items, captions, [], []).repairs).not.toContain(
    'text-supported-numeric-rows-recovered'
  )
})
it('recovers dense clinical records with censored counts and indented stub continuations', () => {
  const lines = [
    ['Characteristic', 'Arm A', 'Arm B'],
    ['Hematologic and lym-', '', ''],
    ['phatic systems', '', ''],
    ...Array.from({ length: 6 }, (_, i) => [`Event ${i}`, '28 (<1)', '31 (0)']),
    ['Marker expression', '', ''],
    ['— no./no. analyzed (%)‡', '', ''],
    ['2+', '24/92 (26)', '19/96 (20)'],
    ['3+', '68/92 (74)', '77/96 (80)'],
    ['Therapy (as adjuvant, for', '88/142 (62)', '76/134 (57)'],
    ['metastasis, or both)', '', ''],
    ['Dyspnea not related', '36 (3)', '25 (3)'],
    ['to heart failure', '', ''],
    ['Pharyngitis', '27 (0)', '16 (<1)'],
    ['Skin', '', ''],
    ['Rash', '31 (<1)', '17 (<1)']
  ]
  const height = lines.length * 16
  const raw = {
    id: 'wrapped-clinical',
    cropRect: [0, 0, 450, height],
    structure: {
      objects: [
        ...[0, 1, 2].map((c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 450, 16] },
        { label: 'table row', rect: [0, 0, 450, 16] },
        { label: 'table row', rect: [0, 16, 450, height] }
      ]
    }
  }
  const continuation = [2, 10, 14, 16]
  const items = lines.flatMap((row, r) =>
    row.flatMap((text, c) =>
      text
        ? [
            {
              ...token(text, c, r),
              rect: [
                c * 150 + 10 + (continuation.includes(r) ? 12 : 0),
                r * 16 + 3,
                c * 150 + 120,
                r * 16 + 15
              ]
            }
          ]
        : []
    )
  )
  const result = refineTable(raw, items)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual([
    'Therapy (as adjuvant, for metastasis, or both)',
    '88/142 (62)',
    '76/134 (57)'
  ])
  expect(result.grid).toContainEqual(['Marker expression — no./no. analyzed (%)‡', '', ''])
  expect(result.grid).toContainEqual(['Dyspnea not related to heart failure', '36 (3)', '25 (3)'])
  expect(result.grid).toContainEqual(['Skin', '', ''])
  expect(result.grid.filter((row: string[]) => row[0].startsWith('Event '))).toHaveLength(6)
})
it('keeps wrapped stubs in repeated sample-size and interval blocks', () => {
  const lines = [
    ['Model', 'Arm A', 'Arm B', 'Arm C'],
    ...Array.from({ length: 3 }, () => [
      ['Adjusted for', '(n = 44)', '(n = 32)', '(n = 21)'],
      ['registry', '', '', ''],
      ['Relative change', '1.11 (1.01–1.23)', '1.13 (1.01–1.27)', '0.97 (0.83–1.12)'],
      ['at T1', '', '', ''],
      ['Relative change', '1.08 (0.98–1.19)', '1.12 (0.99–1.27)', '0.93 (0.79–1.09)'],
      ['at T2', '', '', '']
    ]).flat()
  ]
  const height = lines.length * 16
  const table = {
    id: 'interval-blocks',
    cropRect: [0, 0, 600, height],
    structure: {
      objects: [
        ...Array.from({ length: 4 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, c * 150 + 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 600, 16] },
        ...lines.map((_, r) => ({ label: 'table row', rect: [0, r * 16, 600, r * 16 + 16] }))
      ]
    }
  }
  const items = lines.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  const result = refineTable(table, items)
  expect(result.grid).toHaveLength(10)
  expect(result.grid.filter((row: string[]) => row[0] === 'Relative change at T2')).toHaveLength(3)
  expect(result.unassigned).toEqual([])
})
it('reconstructs parent headings split across model rows by small-cap font heights', () => {
  const raw = {
    id: 'small-caps',
    cropRect: [0, 0, 600, 130],
    structure: {
      objects: [
        ...Array.from({ length: 6 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 130]
        })),
        { label: 'table column header', rect: [0, 0, 600, 46] },
        ...[
          [0, 32],
          [31, 46],
          [46, 65],
          [70, 85],
          [90, 105],
          [110, 125]
        ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 600, bottom] }))
      ]
    }
  }
  const t = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height = 10
  ): {
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
  } => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    height,
    baseline,
    horizontal: true
  })
  const source = [
    t('Margin', 10, 35, 60),
    t('U', 105, 35, 6),
    t('NADJUSTED', 111, 35, 55, 7.5),
    t('ANALYSIS', 170, 35, 51),
    t('A', 335, 35, 6),
    t('DJUSTED', 341, 35, 44, 7.5),
    t('ANALYSIS', 389, 35, 51),
    ...['', 'RISK', 'P', 'VARIABLE', 'RISK', 'P'].flatMap((s, c) =>
      s ? [t(s, c * 100 + 10, 60, 60)] : []
    ),
    ...[80, 100, 120].flatMap((y) =>
      Array.from({ length: 6 }, (_, c) =>
        t(c === 3 ? 'Condition' : c === 0 ? '10' : '0.5', c * 100 + 10, y, 60)
      )
    )
  ]
  const result = refineTable(raw, source)
  expect(
    result.cells.find((c: { text: string }) => c.text === 'UNADJUSTED ANALYSIS')?.colSpan
  ).toBe(2)
  expect(result.cells.find((c: { text: string }) => c.text === 'ADJUSTED ANALYSIS')?.colSpan).toBe(
    3
  )
  expect(result.grid).toHaveLength(5)
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('small-caps-header-recovered')
  const namedRecords = source.map((item) =>
    item.text === '10' ? { ...item, text: 'Response' } : item
  )
  const named = refineTable(raw, namedRecords)
  expect(named.grid).toHaveLength(5)
  expect(named.grid.slice(2).map((row: string[]) => row[0])).toEqual([
    'Response',
    'Response',
    'Response'
  ])
  const ordinary = source.map((i) => ({
    ...i,
    height: 10,
    rect: [i.rect[0], i.baseline - 10, i.rect[2], i.baseline]
  }))
  expect(refineTable(raw, ordinary).repairs).not.toContain('small-caps-header-recovered')
})
it('includes the first line of a single column with a multi-line header', () => {
  const raw = {
    id: 'no-treatment',
    cropRect: [0, 0, 300, 80],
    structure: {
      objects: [
        ...Array.from({ length: 3 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 80]
        })),
        { label: 'table column header', rect: [0, 17, 300, 48] },
        { label: 'table row', rect: [0, 17, 300, 48] },
        { label: 'table row', rect: [0, 55, 300, 75] }
      ]
    }
  }
  const t = (text: string, x: number, y: number): object => ({
    text,
    rect: [x, y, x + 60, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  expect(
    refineTable(raw, [
      t('No', 110, 5),
      t('Radiation', 110, 17),
      t('Therapy', 110, 29),
      t('Group', 10, 29),
      t('P value', 210, 29),
      t('Patients', 10, 58),
      t('20', 110, 58),
      t('0.5', 210, 58)
    ]).grid[0]
  ).toEqual(['Group', 'No Radiation Therapy', 'P value'])
})
it('includes the P column under each ruled parent of sample-size leaf headings', () => {
  const t = (text: string, x: number, y: number, width = 60): object => ({
    text,
    rect: [x, y, x + width, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  const raw = {
    id: 'sample-parents',
    cropRect: [0, 0, 700, 125],
    structure: {
      objects: [
        ...Array.from({ length: 7 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 125]
        })),
        { label: 'table column header', rect: [0, 0, 700, 85] },
        ...[
          [0, 25],
          [35, 60],
          [65, 85],
          [90, 105],
          [110, 125]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 700, b] }))
      ]
    }
  }
  const source = [
    t('Not completed', 130, 0, 150),
    t('Completed', 430, 0, 150),
    t('Characteristic', 10, 70),
    ...[100, 400].flatMap((x) => [
      t('Intervention', x + 10, 38),
      t('Control', x + 110, 38),
      t('(n = 10)', x + 10, 68),
      t('(n = 12)', x + 110, 68),
      t('P', x + 210, 68, 10)
    ]),
    ...[92, 112].flatMap((y) =>
      Array.from({ length: 7 }, (_, c) => t(c === 0 ? 'Record' : '10', c * 100 + 10, y))
    )
  ]
  const result = refineTable(
    raw,
    source,
    [],
    [],
    [
      [100, 30, 340, 30],
      [400, 30, 640, 30]
    ]
  )
  expect(result.cells.find((c: { text: string }) => c.text === 'Not completed')?.colSpan).toBe(3)
  expect(result.cells.find((c: { text: string }) => c.text === 'Completed')?.colSpan).toBe(3)
})

it('uses the source underline when the predicted header boundary is slightly above it', () => {
  const raw = {
    id: 'shifted-underline',
    cropRect: [0, 0, 500, 90],
    structure: {
      objects: [
        ...Array.from({ length: 5 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 90]
        })),
        { label: 'table column header', rect: [0, 0, 500, 60] },
        ...[
          [0, 25],
          [25, 60],
          [65, 90]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 500, b] }))
      ]
    }
  }
  const t = (text: string, x: number, y: number, width = 60): object => ({
    text,
    rect: [x, y, x + width, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  const source = [
    t('Measure', 20, 10),
    t('Treatment', 260, 10),
    t('P', 440, 10, 10),
    t('Patients', 101, 28, 80),
    t('Events', 210, 28),
    t('Risk', 310, 28, 80),
    ...Array.from({ length: 5 }, (_, c) => t(c ? '12' : 'Response', c * 100 + 10, 70))
  ]
  const result = refineTable(raw, source, [], [], [[100, 28, 391, 28]])
  expect(result.cells.find((c: { text: string }) => c.text === 'Treatment')).toMatchObject({
    column: 1,
    colSpan: 3
  })
  expect(result.grid[2]).toEqual(['Response', '12', '12', '12', '12'])
})

it('recovers a wrapped header with sample sizes only inside a ruled header band', () => {
  const raw = {
    id: 'bounded-header',
    cropRect: [0, 0, 300, 95],
    structure: {
      objects: [
        ...Array.from({ length: 3 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 95]
        })),
        { label: 'table column header', rect: [0, 25, 300, 60] },
        ...[
          [25, 60],
          [65, 90]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 300, b] }))
      ]
    }
  }
  const t = (text: string, x: number, y: number): object => ({
    text,
    rect: [x, y, x + 80, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  const source = [
    t('No subsequent', 110, 10),
    t('tumor event', 110, 25),
    t('(N = 279)', 110, 40),
    t('Factor', 10, 40),
    t('Risk', 210, 40),
    t('Patients', 10, 70),
    t('30', 110, 70),
    t('1.0', 210, 70)
  ]
  const result = refineTable(
    raw,
    source,
    [],
    [],
    [
      [0, 8, 300, 8],
      [0, 60, 300, 60]
    ]
  )
  expect(result.grid[0][1]).toBe('No subsequent tumor event (N = 279)')
  expect(result.grid[1]).toEqual(['Patients', '30', '1.0'])
  expect(refineTable(raw, source).unassigned).toContain('No subsequent')
})

it.each([
  ['counts', ['30 (29.1)', '35 (33.7)', '.65']],
  ['statistics', ['9.5 (13/136)', 'NS', '–']]
])('recovers an omitted section between %s records', (_, values) => {
  const grid = [
    ['Characteristic', 'Count', 'Comparison', 'Estimate'],
    ...['Tumor', 'Margins', 'Grade'].flatMap((label) => [
      [label, '', '', label !== 'Margins' && _ === 'counts' ? '0.55' : ''],
      ['Positive', ...values],
      ['Negative', ...values]
    ])
  ]
  const height = grid.length * 16
  const table = {
    id: 'count-sections',
    cropRect: [0, 0, 600, height],
    structure: {
      objects: [
        ...Array.from({ length: 4 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 600, 16] },
        ...grid.flatMap((_, r) =>
          r === 4
            ? [
                { label: 'table row', rect: [0, 64, 600, 68] },
                { label: 'table row', rect: [0, 78, 600, 80] }
              ]
            : [{ label: 'table row', rect: [0, r * 16, 600, (r + 1) * 16] }]
        )
      ]
    }
  }
  const items = grid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  expect(refineTable(table, items).grid).toContainEqual(['Margins', '', '', ''])
  expect(refineTable(table, items).unassigned).toEqual([])
  const prose = grid.flatMap((row, r) =>
    row.flatMap((text, c) =>
      text ? [token(c > 0 && r > 0 ? 'Requires further evaluation' : text, c, r)] : []
    )
  )
  expect(refineTable(table, prose).repairs).not.toContain('text-supported-section-row-recovered')
})

it('preserves ruled nested sections, dash values and multi-line numeric record labels', () => {
  const sourceGrid = [
    ['', 'Arm A', 'Arm B', 'All'],
    ['At diagnosis', '', '', ''],
    ['Histology', '', '', ''],
    ...Array.from({ length: 12 }, (_, i) => [`Type ${i}`, i % 2 ? '–' : '2', '3', '5']),
    ['Invasive with pre-', '4', '5', '9'],
    ['dominant intraductal', '', '', ''],
    ['component', '', '', ''],
    ['Other', '1', '2', '3']
  ]
  const table = {
    id: 'nested-records',
    cropRect: [0, 0, 600, sourceGrid.length * 16],
    structure: {
      objects: [
        ...Array.from({ length: 4 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, c * 150 + 150, sourceGrid.length * 16]
        })),
        { label: 'table column header', rect: [0, 0, 600, 16] },
        ...sourceGrid.flatMap((_, r) =>
          r === 6 ? [] : [{ label: 'table row', rect: [0, r * 16, 600, r * 16 + 16] }]
        )
      ]
    }
  }
  const source = sourceGrid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r)] : []))
  )
  const rules = [
    [0, 0, 600, 0],
    [0, 16, 600, 16],
    [0, sourceGrid.length * 16, 600, sourceGrid.length * 16]
  ]
  const result = refineTable(
    table,
    source,
    [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 600, -5] }],
    [],
    rules
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual(['Type 3', '–', '3', '5'])
  expect(result.grid).toContainEqual([
    'Invasive with pre-dominant intraductal component',
    '4',
    '5',
    '9'
  ])
  expect(result.grid).toContainEqual(['At diagnosis', '', '', ''])
  expect(result.grid).toContainEqual(['Histology', '', '', ''])
})

it('joins indented qualifier-only lines to complete records without merging numeric categories', () => {
  const lines = [
    ['Characteristic', 'Arm A', 'Arm B'],
    ...Array.from({ length: 10 }, (_, i) => [`Event ${i}`, '10 (20)', '12 (24)']),
    ['BMI, median', '24 (18–48)', '25 (15–44)'],
    ['(range)', '', ''],
    ['Monocytes', '25 (22)', '22 (20)'],
    ['<0.25/nL', '', ''],
    ['Prior therapy', '51 (45)', '43 (38)'],
    ['(adjuvant)', '', ''],
    ['Age', '', ''],
    ['<65', '76 (67)', '71 (63)'],
    ['(unknown)', '', '']
  ]
  const height = lines.length * 16
  const raw = {
    id: 'indented-qualifiers',
    cropRect: [0, 0, 450, height],
    structure: {
      objects: [
        ...[0, 1, 2].map((c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, height]
        })),
        { label: 'table column header', rect: [0, 0, 450, 16] },
        ...lines.map((_, r) => ({ label: 'table row', rect: [0, r * 16, 450, r * 16 + 16] }))
      ]
    }
  }
  const items = lines.flatMap((row, r) =>
    row.flatMap((text, c) =>
      text
        ? [
            {
              ...token(text, c, r),
              rect: [
                c * 150 + 10 + ([12, 14, 16].includes(r) ? 12 : 0),
                r * 16 + 3,
                c * 150 + 120,
                r * 16 + 15
              ]
            }
          ]
        : []
    )
  )
  const result = refineTable(raw, items)
  expect(result.grid).toContainEqual(['BMI, median (range)', '24 (18–48)', '25 (15–44)'])
  expect(result.grid).toContainEqual(['Monocytes <0.25/nL', '25 (22)', '22 (20)'])
  expect(result.grid).toContainEqual(['Prior therapy (adjuvant)', '51 (45)', '43 (38)'])
  expect(result.grid).toContainEqual(['<65', '76 (67)', '71 (63)'])
  expect(result.grid).toContainEqual(['(unknown)', '', ''])
})

it('keeps raised receptor signs with their labels while recovering wrapped units and numeric rows', () => {
  const grid = [
    ['', 'Arm A', 'Arm B'],
    ['Years from diagnosis (mean ± SD)', '1.8 ± 1.3', '1.9 ± 1.3'],
    ...Array.from({ length: 10 }, (_, i) => [i === 4 ? 'ER−' : `Outcome ${i}`, '12', '14'])
  ]
  const items = grid.flatMap((row, r) =>
    row.flatMap((text, c) => (text ? [token(text, c, r > 1 ? r + 1 : r)] : []))
  ) as {
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
    inlineSymbol?: boolean
  }[]
  const units = items.find((x) => x.text.startsWith('Years'))!
  units.text = 'Years from diagnosis'
  items.push({ ...token('(mean ± SD)', 0, 2), rect: [20, 35, 110, 47] } as typeof units)
  const receptor = items.find((x) => x.text === 'ER−')!
  receptor.text = 'ER'
  receptor.rect[2] = 26
  const sign = {
    text: '−',
    rect: [26, receptor.rect[1] - 1.3, 33, receptor.baseline - 5.3],
    height: 8,
    baseline: receptor.baseline - 5.3,
    horizontal: true,
    inlineSymbol: true
  }
  items.push(sign)
  const table = {
    id: 'raised-sign-records',
    cropRect: [0, 0, 450, 208],
    structure: {
      objects: [
        ...Array.from({ length: 3 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, 208]
        })),
        { label: 'table column header', rect: [0, 0, 450, 16] },
        ...Array.from({ length: 26 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 8, 450, r * 8 + 10]
        }))
      ]
    }
  }
  const captions = [{ lines: ['Table 1. Baseline characteristics'], rect: [0, -20, 450, -5] }]
  const result = refineTable(table, items, captions)
  expect(result.grid).toEqual(grid)
  expect(result.unassigned).toEqual([])
  // A sign in another data column or far from its label has no stub owner.
  for (const rect of [
    [160, ...sign.rect.slice(1, 2), 167, sign.rect[3]],
    [80, sign.rect[1], 87, sign.rect[3]]
  ]) {
    const separate = refineTable(
      table,
      items.map((x) => (x === sign ? { ...x, rect } : x)),
      captions
    )
    expect(separate.repairs).not.toContain('text-supported-numeric-rows-recovered')
  }
})
