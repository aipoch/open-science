import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const token = (
  text: string,
  x: number,
  y: number,
  width = 20
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 12],
  baseline: y + 12,
  height: 12,
  horizontal: true
})
const cuts = [0, ...Array.from({ length: 13 }, (_, i) => 100 + i * 50)]
const table = {
  cropRect: [0, 0, 700, 120],
  structure: {
    objects: [
      ...cuts.slice(1).map((x, i) => ({ label: 'table column', rect: [cuts[i], 20, x, 100] })),
      ...[0, 20, 40, 60, 80].map((y) => ({ label: 'table row', rect: [0, y, 700, y + 20] })),
      { label: 'table column header', rect: [0, 0, 700, 40] }
    ]
  }
}
const items = [
  token('Model', 5, 2),
  token('Training', 205, 2, 38),
  token('Cohort', 246, 2, 32),
  token('Validation', 505, 2, 48),
  token('Cohort', 556, 2, 32),
  ...Array.from({ length: 12 }, (_, i) =>
    token(['AUC', '95% CI', 'Sen', 'Spe', 'NPV', 'PPV'][i % 6], 110 + i * 50, 22, 30)
  ),
  ...['Nomogram', 'Comparator'].flatMap((label, i) => [
    token(label, 5, 42 + i * 40, 60),
    ...Array.from({ length: 12 }, (_, c) => token('0.800', 110 + c * 50, 42 + i * 40)),
    token('0.950', 160, 62 + i * 40),
    token('0.960', 460, 62 + i * 40)
  ])
]
const rules = [
  [100, 0, 100, 20],
  [400, 0, 400, 20],
  [104, 20, 370, 20],
  [404, 20, 700, 20],
  [0, 118, 700, 118]
]

it('recovers repeated metric groups from parent dividers even with a short underline', () => {
  const result = refineTable(table, items, [], [], rules)
  expect(result.cells.filter((c: { row: number }) => c.row === 0)).toMatchObject([
    { column: 0, text: 'Model' },
    { column: 1, colSpan: 6, text: 'Training Cohort' },
    { column: 7, colSpan: 6, text: 'Validation Cohort' }
  ])
})

it('keeps split confidence interval endpoints with each named record, including the final record', () => {
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid).toHaveLength(4)
  expect(result.grid[2][2]).toMatch(/0\.800\s+0\.950/)
  expect(result.grid[3][8]).toMatch(/0\.800\s+0\.960/)
  expect(result.unassigned).toEqual([])
})

it('does not infer repeated metric groups when a parent divider cuts through child columns', () => {
  const result = refineTable(table, items, [], [], [...rules, [250, 0, 250, 20]])
  expect(result.cells.some((c: { colSpan: number }) => c.colSpan === 6)).toBe(false)
})

it('does not join an interval continuation with its own record label or a separating rule', () => {
  for (const [extraItems, extraRules] of [
    [[token('Separate', 5, 62, 60)], []],
    [[], [[0, 58, 700, 58]]]
  ]) {
    const result = refineTable(table, [...items, ...extraItems], [], [], [...rules, ...extraRules])
    expect(result.grid.some((row: string[]) => /0\.800\s+0\.950/.test(row[2]))).toBe(false)
  }
})

it('recovers an omitted analysis tier above repeated interval subheaders', () => {
  const columns = [
    [8.396, 159.017],
    [157.987, 219.961],
    [219.852, 291.835],
    [292.291, 363.322],
    [362.953, 442.481],
    [443.533, 502.978],
    [503.426, 574.435],
    [575.468, 646.7],
    [646.46, 702.372]
  ]
  const rows = [
    [86.586, 105.88],
    [67.693, 86.59],
    [49.043, 67.726],
    [31.215, 48.867]
  ]
  const input = {
    cropRect: [88, 94, 807, 521],
    structure: {
      objects: [
        ...columns.map(([l, r]) => ({ label: 'table column', rect: [l, 31, r, 411] })),
        ...rows.map(([t, b]) => ({ label: 'table row', rect: [9, t, 703, b] })),
        { label: 'table column header', rect: [9.39, 31.177, 702.315, 68.011] }
      ]
    }
  }
  const source: [string, number, number, number, number][] = [
    ['Univariate', 344.938, 106.57, 56.785, 13.45],
    ['Analysis', 405.123, 106.57, 46.311, 13.45],
    ['Multivariate', 615.425, 106.57, 66.508, 13.45],
    ['Analysis', 685.329, 106.57, 46.311, 13.45],
    ['Variables', 97.875, 126.077, 52.062, 13.45],
    ['OR', 269.298, 126.077, 16.439, 13.45],
    ['95%', 369.576, 126.077, 24.65, 13.45],
    ['CI', 397.63, 126.077, 11.218, 13.45],
    ['P', 469.935, 126.077, 7.478, 13.45],
    ['-value', 477.454, 126.077, 34.358, 13.45],
    ['OR', 553.5, 126.077, 16.439, 13.45],
    ['95%', 653.792, 126.077, 24.65, 13.45],
    ['CI', 681.845, 126.077, 11.218, 13.45],
    ['P-', 754.15, 126.077, 11.959, 13.45],
    ['Value', 766.152, 126.077, 31.145, 13.45],
    ['Lower', 327.456, 145.585, 33.624, 13.45],
    ['Upper', 399.073, 145.585, 32.871, 13.45],
    ['Lower', 611.658, 145.585, 33.624, 13.45],
    ['Upper', 683.289, 145.585, 32.871, 13.45],
    ['Age', 97.875, 164.265, 15.936, 11.955],
    ['2.85', 268.218, 164.265, 18.575, 11.955],
    ['1.80', 334.976, 164.265, 18.574, 11.955],
    ['4.49', 406.215, 164.265, 18.575, 11.955],
    ['<', 476.914, 164.265, 9.326, 11.955],
    ['.001', 486.283, 164.265, 18.574, 11.955],
    ['1.43', 552.433, 164.265, 18.575, 11.955],
    ['0.63', 619.178, 164.265, 18.574, 11.955],
    ['3.27', 690.43, 164.265, 18.575, 11.955],
    ['.39', 769.068, 164.265, 13.273, 11.955],
    ['location', 97.875, 183.691, 33.179, 11.955],
    ['0.66', 268.218, 183.691, 18.575, 11.955],
    ['0.42', 334.976, 183.691, 18.574, 11.955],
    ['1.02', 406.215, 183.691, 18.575, 11.955],
    ['.06', 484.218, 183.691, 13.273, 11.955],
    ['0.74', 552.433, 183.691, 18.575, 11.955],
    ['0.32', 619.178, 183.691, 18.574, 11.955],
    ['1.70', 690.43, 183.691, 18.575, 11.955],
    ['.48', 769.068, 183.691, 13.273, 11.955]
  ]
  const text = source.map(([text, x, y, width, height]) => ({
    text,
    rect: [x, y, x + width, y + height],
    baseline: y + height,
    height,
    horizontal: true
  }))
  const result = refineTable(
    input,
    text,
    [{ lines: ['Table 4. Analysis'], rect: [88, 70, 500, 90] }],
    [],
    [
      [88.911, 135.901, 806.233, 135.901],
      [245.827, 106.411, 245.827, 125.851],
      [530.111, 106.411, 530.111, 125.851],
      [255.109, 125.993, 478.278, 125.993],
      [539.311, 125.993, 806.22, 125.993],
      [245.868, 125.919, 245.868, 145.359],
      [307.752, 125.919, 307.752, 145.359],
      [450.271, 125.919, 450.271, 145.359],
      [530.11, 125.919, 530.11, 145.359],
      [591.955, 125.919, 591.955, 145.359],
      [734.487, 125.919, 734.487, 145.359],
      [316.993, 145.5, 398.439, 145.5],
      [601.195, 145.5, 682.641, 145.5],
      [245.827, 145.413, 245.827, 164.853],
      [307.711, 145.413, 307.711, 164.853],
      [379.369, 145.413, 379.369, 164.853],
      [450.231, 145.413, 450.231, 164.853],
      [530.029, 145.413, 530.029, 164.853],
      [591.913, 145.413, 591.913, 164.853],
      [663.586, 145.413, 663.586, 164.853],
      [734.446, 145.413, 734.446, 164.853],
      [245.868, 162.598, 245.868, 182.039],
      [307.752, 162.598, 307.752, 182.039],
      [379.369, 162.598, 379.369, 182.039],
      [450.231, 162.598, 450.231, 182.039],
      [530.11, 162.598, 530.11, 182.039],
      [591.955, 162.598, 591.955, 182.039],
      [663.586, 162.598, 663.586, 182.039],
      [734.447, 162.598, 734.447, 182.039]
    ]
  )
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
  ).toMatchObject([
    { column: 1, colSpan: 4, text: 'Univariate Analysis' },
    { column: 5, colSpan: 4, text: 'Multivariate Analysis' }
  ])
  expect(result.unassigned).toEqual([])
  expect(result.grid[3]).toEqual([
    'Age',
    '2.85',
    '1.80',
    '4.49',
    '<.001',
    '1.43',
    '0.63',
    '3.27',
    '.39'
  ])
})
