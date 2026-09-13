import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width = 40
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const caption = [{ lines: ['Table 1. Repeated outcomes'], rect: [0, -25, 700, -5] }]
const source = {
  id: 'followup',
  cropRect: [0, 0, 700, 105],
  structure: {
    objects: [
      ...Array.from({ length: 7 }, (_, c) => ({
        label: 'table column',
        rect: [c * 100, 0, (c + 1) * 100, 105]
      })),
      ...[
        [0, 30],
        [30, 50],
        [50, 100]
      ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 700, b] }))
    ]
  }
}
const header = [
  'Outcome',
  'Time',
  'Arm A',
  'Arm B',
  'Time effect',
  'Treatment effect',
  'Interaction'
].map((t, c) => item(t, c * 100 + 5, 5))
const rows = ['Baseline', 'Post-clinic', '3 months'].flatMap((t, r) => [
  item(t, 105, 35 + r * 20),
  item(`${r + 1} ± 1`, 205, 35 + r * 20),
  item(`${r + 2} ± 1`, 305, 35 + r * 20)
])
const items = [
  ...header,
  ...rows,
  item('Risk', 5, 35),
  item('2 NS', 405, 35),
  item('3 NS', 505, 35),
  item('4 NS', 605, 35)
]
const rules = [
  [0, 0, 700, 0],
  [0, 30, 700, 30],
  [0, 100, 700, 100]
]
it('separates follow-up values while sharing the outcome and effect statistics', () => {
  const result = refineTable(source, items, caption, [], rules)
  expect(result.grid.slice(1).map((r: string[]) => r.slice(1, 4))).toEqual([
    ['Baseline', '1 ± 1', '2 ± 1'],
    ['Post-clinic', '2 ± 1', '3 ± 1'],
    ['3 months', '3 ± 1', '4 ± 1']
  ])
  expect(result.cells.find((c: { text: string }) => c.text === 'Risk').rowSpan).toBe(3)
  expect(result.cells.find((c: { text: string }) => c.text === '2 NS').rowSpan).toBe(3)
  expect(result.unassigned).toEqual([])
})
it('does not share independently printed follow-up statistics', () => {
  const result = refineTable(source, [...items, item('7 NS', 405, 55)], caption, [], rules)
  expect(result.repairs).not.toContain('text-supported-study-records-recovered')
})
it('joins only geometrically adjacent fragments of a complete miRNA identifier', () => {
  const table = {
    id: 'identifier',
    cropRect: [0, 0, 300, 30],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 300, 30] },
        ...[0, 150].map((x) => ({ label: 'table column', rect: [x, 0, x + 150, 30] }))
      ]
    }
  }
  const parts = [
    item('hsa-', 5, 5, 25),
    item(' miR-', 30, 5, 30),
    item(' 1200', 60, 5, 30),
    item('1.5', 160, 5)
  ]
  expect(refineTable(table, parts).grid[0][0]).toBe('hsa-miR-1200')
  expect(
    refineTable(table, [...parts.slice(0, 2), item(' treatment', 60, 5, 70), parts[3]]).grid[0][0]
  ).toContain(' treatment')
})

it('recovers centered multiline statistics and their repeated sample-size group headers', () => {
  const raw = {
    id: 'longitudinal',
    cropRect: [0, 0, 1200, 200],
    structure: {
      objects: [
        ...Array.from({ length: 12 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 200]
        })),
        ...[
          [15, 70],
          [70, 112],
          [112, 137],
          [137, 162],
          [162, 200]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 1200, b] }))
      ]
    }
  }
  const headers = [
    '',
    'n',
    'Baseline',
    'n',
    'Post-Intervention',
    'Change',
    'n',
    'Baseline',
    'n',
    'Post-intervention',
    'Change',
    'Mean (95% CI)'
  ]
  const source = [
    item('Group A Mean (SD)', 205, 5, 200),
    item('Group B Mean (SD)', 705, 5, 200),
    item('Difference', 1105, 5),
    ...headers.flatMap((t, c) => (t ? [item(t, c * 100 + 5, 45)] : [])),
    ...Array.from({ length: 4 }, (_, r) =>
      Array.from({ length: 12 }, (_, c) =>
        item(
          c === 0 ? `Outcome ${r}` : [1, 3, 6, 8].includes(c) ? '20' : '5 (2)',
          c * 100 + 5,
          85 + r * 25
        )
      )
    ).flat()
  ]
  const result = refineTable(
    raw,
    source,
    [{ lines: ['Table 1. Summary'], rect: [0, -25, 1200, -5] }],
    [],
    [
      [0, 0, 1200, 0],
      [0, 35, 1200, 35],
      [0, 70, 1200, 70],
      [0, 200, 1200, 200]
    ]
  )
  expect(result.grid).toHaveLength(6)
  expect(result.cells.find((c: { text: string }) => c.text === 'Group A Mean (SD)').colSpan).toBe(5)
  expect(result.unassigned).toEqual([])
  expect(result.grid[2].slice(1)).toEqual([
    '20',
    '5 (2)',
    '20',
    '5 (2)',
    '5 (2)',
    '20',
    '5 (2)',
    '20',
    '5 (2)',
    '5 (2)',
    '5 (2)'
  ])
})

it('keeps questionnaire scale counts on their own row under one shared question', () => {
  const raw = {
    id: 'responses',
    cropRect: [0, 0, 600, 130],
    structure: {
      objects: [
        ...Array.from({ length: 6 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 130]
        })),
        ...[
          [0, 30],
          [30, 70],
          [70, 105],
          [105, 130]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 600, b] }))
      ]
    }
  }
  const source = [
    item('Question', 5, 5),
    item('Responses', 255, 5),
    ...['First?', 'Second?'].flatMap((q, r) => [
      item(q, 5, 35 + r * 50),
      item('Difficult', 105, 35 + r * 50),
      item('Easy', 505, 35 + r * 50),
      ...[2, 0, 6, 3, 3].map((n, c) => item(String(n), (c + 1) * 100 + 5, 60 + r * 50))
    ])
  ]
  const result = refineTable(
    raw,
    source,
    [{ lines: ['Table 1. Responses'], rect: [0, -25, 600, -5] }],
    [],
    [
      [0, 0, 600, 0],
      [0, 30, 600, 30],
      [0, 80, 600, 80],
      [0, 130, 600, 130]
    ]
  )
  expect(result.grid[2].slice(1)).toEqual(['2', '0', '6', '3', '3'])
  expect(result.cells.find((c: { text: string }) => c.text === 'First?').rowSpan).toBe(2)
  expect(result.cells.find((c: { text: string }) => c.text === 'Responses').colSpan).toBe(5)
  expect(result.unassigned).toEqual([])
})

it.each([false, true])('recovers nested header tiers with wrapped grade labels: %s', (wrapped) => {
  const raw = {
    id: 'tiers',
    cropRect: [0, 0, 900, 200],
    structure: {
      objects: [
        ...Array.from({ length: 9 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 200]
        })),
        ...[
          [0, 70],
          [70, 100],
          [105, 130],
          [135, 160],
          [165, 190]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 900, b] }))
      ]
    }
  }
  const source = [
    item('Population A', 105, 5),
    item('Population B', 505, 5),
    item('Adverse events', 5, 40),
    ...[1, 3, 5, 7].map((c) => item(`Treatment ${c}`, c * 100 + 5, 40, 140)),
    ...Array.from({ length: 8 }, (_, c) =>
      wrapped && c % 2
        ? [item('Grade', (c + 1) * 100 + 5, 75), item('3/4', (c + 1) * 100 + 5, 90)]
        : [item(c % 2 ? 'Grade 3/4' : 'All grades', (c + 1) * 100 + 5, 80)]
    ).flat(),
    ...Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) =>
        item(c ? String(c) : `Event ${r}`, c * 100 + 5, 110 + r * 30)
      )
    ).flat()
  ]
  const rules = [
    [105, 30, 490, 30],
    [505, 30, 890, 30],
    ...[1, 3, 5, 7].map((c) => [c * 100 + 5, 60, (c + 2) * 100 - 10, 60])
  ]
  const result = refineTable(
    raw,
    source,
    [{ lines: ['Table 1. Events'], rect: [0, -25, 900, -5] }],
    [],
    rules
  )
  expect(result.cells.find((c: { text: string }) => c.text === 'Population A').colSpan).toBe(4)
  expect(result.cells.find((c: { text: string }) => c.text === 'Treatment 3').colSpan).toBe(2)
  expect(result.cells.find((c: { text: string }) => c.text === 'Adverse events').rowSpan).toBe(3)
  expect(result.unassigned).toEqual([])
})

it('recovers overlapping criterion rows without appending a wrapped label to the next record', () => {
  const raw = {
    id: 'criteria',
    cropRect: [0, 0, 700, 170],
    structure: {
      objects: [
        ...[0, 100, 400, 500, 600].map((x, c, a) => ({
          label: 'table column',
          rect: [x, 0, a[c + 1] ?? 700, 170]
        })),
        ...[
          [0, 30],
          [30, 55],
          [55, 80],
          [80, 101],
          [98, 115],
          [110, 138],
          [133, 151],
          [146, 169]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 700, b] }))
      ]
    }
  }
  const source = [
    ...['Section', 'Criterion', 'Arm A', 'Arm B', 'Arm C'].map((t, c) =>
      item(t, [5, 105, 405, 505, 605][c], 5)
    ),
    ...['Sampling', 'Treatment', 'Follow up'].flatMap((t, r) => [
      item(t, 5, 35 + r * 25, 75),
      item('Criteria for eligible patients', 105, 35 + r * 25, 220),
      ...[405, 505, 605].map((x) => item('2 (25%)', x, 35 + r * 25))
    ]),
    item('Not controlled for non-narcotics', 105, 105, 220),
    ...[405, 505, 605].map((x) => item('2', x, 105)),
    item('or requiring narcotics', 105, 120, 170),
    item('Not controlled for narcotics', 105, 140, 210),
    ...[405, 505, 605].map((x) => item('1', x, 140))
  ]
  const result = refineTable(raw, source, caption)
  expect(result.unassigned).toEqual([])
  expect(result.grid.find((r: string[]) => r[1].includes('or requiring'))?.slice(1)).toEqual([
    'Not controlled for non-narcotics or requiring narcotics',
    '2',
    '2',
    '2'
  ])
  expect(
    result.grid.find((r: string[]) => r[1] === 'Not controlled for narcotics')?.slice(2)
  ).toEqual(['1', '1', '1'])
})

it('rebuilds count rows with an optional P column and wrapped category headings', () => {
  const raw = {
    id: 'baseline',
    cropRect: [0, 0, 400, 380],
    structure: {
      objects: [
        ...[0, 160, 240, 320].map((x, c, a) => ({
          label: 'table column',
          rect: [x, 0, a[c + 1] ?? 400, 380]
        })),
        ...[
          [0, 35],
          [35, 85],
          [80, 125],
          [125, 185],
          [180, 260],
          [255, 380]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 400, b] }))
      ]
    }
  }
  const source = [
    item('Variable', 5, 15),
    item('Arm A', 165, 0),
    item('Group (n = 40)', 165, 15, 65),
    item('Arm B', 245, 0),
    item('Group (n = 42)', 245, 15, 65),
    item('P', 365, 15, 10),
    ...['Education, n (%)', 'Occupation, n (%)', 'Procedure, n (%)'].flatMap((t, s) => [
      item(t, 5, 40 + s * 105, 140),
      item('.25', 365, 40 + s * 105, 20),
      ...Array.from({ length: 3 }, (_, r) => [
        item(`Category ${r}`, 15, 60 + s * 105 + r * 25, 90),
        item('10 (25.0)', 165, 60 + s * 105 + r * 25, 60),
        item('12 (28.6)', 245, 60 + s * 105 + r * 25, 60)
      ]).flat()
    ])
  ]
  const result = refineTable(raw, source, [
    { lines: ['Table 1. Baseline'], rect: [0, -25, 400, -5] }
  ])
  expect(result.unassigned).toEqual([])
  expect(result.grid.filter((r: string[]) => r[0].startsWith('Category'))).toHaveLength(9)
  expect(result.grid.find((r: string[]) => r[0].startsWith('Occupation'))).toEqual([
    'Occupation, n (%)',
    '',
    '',
    '.25'
  ])
  expect(
    refineTable(
      raw,
      source.filter((i) => i.text !== 'P'),
      caption
    ).repairs
  ).not.toContain('text-supported-study-records-recovered')
})

it('splits a joined grade-label run only when every ruled treatment pair repeats the exact wording', () => {
  const raw = {
    id: 'joined-header',
    cropRect: [0, 0, 1300, 220],
    structure: {
      objects: [
        ...Array.from({ length: 13 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 220]
        })),
        ...[
          [0, 35],
          [35, 70],
          [70, 100],
          [100, 130],
          [130, 160],
          [160, 190]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 1300, b] }))
      ]
    }
  }
  const source = [
    ...['A', 'B', 'C'].map((t, n) => item(`Population ${t}`, 105 + n * 400, 5, 100)),
    item('Adverse events', 5, 40, 90),
    ...Array.from({ length: 6 }, (_, n) => item(`Treatment ${n}`, 105 + n * 200, 40, 140)),
    item('Any grade ≥ Grade 3 '.repeat(6).trim(), 105, 80, 1180),
    ...Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 13 }, (_, c) =>
        item(c ? '1' : `Event ${r}`, c * 100 + 5, 110 + r * 30, 40)
      )
    ).flat()
  ]
  const rules = [
    ...[1, 5, 9].map((c) => [c * 100 + 5, 30, (c + 4) * 100 - 10, 30]),
    ...[1, 3, 5, 7, 9, 11].map((c) => [c * 100 + 5, 65, (c + 2) * 100 - 10, 65])
  ]
  const captions = [{ lines: ['Table 1. Events'], rect: [0, -25, 1300, -5] }]
  const result = refineTable(raw, source, captions, [], rules)
  expect(result.grid[2].slice(1)).toEqual(
    Array.from({ length: 12 }, (_, n) => (n % 2 ? '≥ Grade 3' : 'Any grade'))
  )
  expect(result.cells.find((c: { text: string }) => c.text === 'Population C').colSpan).toBe(4)
  expect(result.unassigned).toEqual([])
  const changed = source.map((i) => ({
    ...i,
    text: i.text.replace('Any grade ≥ Grade 3', 'Any grade ≥ Grade 4')
  }))
  expect(refineTable(raw, changed, captions, [], rules).repairs).not.toContain(
    'ruled-header-tiers-recovered'
  )
})

it('shares centered comparison statistics but keeps separately printed arm intervals apart', () => {
  const raw = {
    id: 'shared-pairs',
    cropRect: [0, 0, 900, 220],
    structure: {
      objects: [
        ...Array.from({ length: 9 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 220]
        })),
        ...[
          [0, 35],
          [35, 65],
          [65, 95],
          [95, 125],
          [125, 151],
          [148, 173],
          [170, 192],
          [190, 215]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 900, b] })),
        { label: 'table spanning cell', rect: [500, 65, 700, 95] }
      ]
    }
  }
  const source = [
    ...[1, 3, 5, 7].map((c) => item(`Population ${c}`, c * 100 + 45, 5, 100)),
    ...Array.from({ length: 8 }, (_, c) => item(`Arm ${c}`, (c + 1) * 100 + 5, 40, 50)),
    ...Array.from({ length: 3 }, (_, r) => [
      item(`Value ${r}`, 5, 70 + r * 30, 80),
      ...Array.from({ length: 8 }, (_, c) =>
        item(r === 0 ? '(0.1 to 2.0)' : '1 (25.0)', (c + 1) * 100 + 5, 70 + r * 30, 85)
      )
    ]).flat(),
    ...['Difference between groups', '95% CI', 'p-value'].flatMap((t, r) => [
      item(t, 5, 160 + r * 18, 90),
      ...[1, 3, 5, 7].map((c) =>
        item(r === 1 ? '0.1 to 2.0' : '0.125', c * 100 + 65, 160 + r * 18, 70)
      )
    ])
  ]
  const result = refineTable(
    raw,
    source,
    [{ lines: ['Table 1. Comparisons'], rect: [0, -25, 900, -5] }],
    [],
    [1, 3, 5, 7].map((c) => [c * 100 + 5, 30, (c + 2) * 100 - 5, 30])
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid.find((r: string[]) => r[0] === 'Value 0')?.slice(1)).toEqual(
    Array(8).fill('(0.1 to 2.0)')
  )
  expect(
    result.cells
      .filter((c: { text: string }) => c.text === '0.125')
      .every((c: { colSpan: number }) => c.colSpan === 2)
  ).toBe(true)
  expect(result.grid.find((r: string[]) => r[0] === 'p-value')?.slice(1)).toEqual([
    '0.125',
    '',
    '0.125',
    '',
    '0.125',
    '',
    '0.125',
    ''
  ])
})
