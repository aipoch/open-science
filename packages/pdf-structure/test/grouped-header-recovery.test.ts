import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type HeaderToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}

type HeaderRun = Pick<HeaderToken, 'text' | 'rect' | 'baseline' | 'height'> & {
  literalGlyphs: string[]
  glyphRuns: number[]
  gaps: Array<{ left: number; right: number; index: number }>
}

type HeaderFixture = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: Array<{ label: string; rect: number[] }> }
  }
  source: HeaderToken[]
  rules: number[][]
}

const groupedHeader = (): HeaderFixture => {
  const table = {
    id: 'grouped-header',
    cropRect: [0, 0, 500, 100],
    structure: {
      objects: [
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 25, x + 100, 95]
        })),
        ...[25, 50, 75].map((y) => ({ label: 'table row', rect: [0, y, 500, y + 25] })),
        { label: 'table column header', rect: [0, 25, 500, 50] }
      ]
    }
  }
  let index = 0
  const token = (text: string, left: number, top: number, width: number): HeaderToken => ({
    text,
    rect: [left, top, left + width, top + 10],
    baseline: top + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    token('Item', 15, 18, 35),
    token('Group alpha', 135, 5, 100),
    token('Group beta', 335, 5, 100),
    ...[115, 215, 315, 415].map((x, n) => token(n % 2 ? 'Right' : 'Left', x, 30, 40)),
    ...[0, 1].flatMap((row) => [
      token(row ? 'B' : 'A', 15, 55 + row * 25, 15),
      ...[115, 215, 315, 415].map((x, n) => token(`${row + n + 1}.5`, x, 55 + row * 25, 30))
    ])
  ]
  const rules = [0, 50, 75, 100].map((y) => [0, y, 500, y])
  return { table, source, rules }
}

it('recovers two grouped parents above the predicted child header without changing body owners', () => {
  const f = groupedHeader()
  const before = structuredClone(f)
  const result = refineTable(f.table, f.source, [], [], f.rules)
  expect(result.grid).toEqual([
    ['Item', 'Group alpha', '', 'Group beta', ''],
    ['', 'Left', 'Right', 'Left', 'Right'],
    ['A', '1.5', '2.5', '3.5', '4.5'],
    ['B', '2.5', '3.5', '4.5', '5.5']
  ])
  expect(result.cells.find((c: { text: string }) => c.text === 'Item')).toMatchObject({
    rowSpan: 2,
    colSpan: 1
  })
  expect(result.cells.filter((c: { text: string }) => c.text.startsWith('Group '))).toEqual([
    expect.objectContaining({ row: 0, column: 1, rowSpan: 1, colSpan: 2 }),
    expect.objectContaining({ row: 0, column: 3, rowSpan: 1, colSpan: 2 })
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: Array<{ index: number }> }) =>
        (c.sourceItems ?? []).map((s) => s.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(f.source.map((s) => s.sourceItem.index))
  expect(f).toEqual(before)
})

const threeTierHeader = (): HeaderFixture & { runs: HeaderRun[] } => {
  const table = {
    id: 'measured-grouped-header',
    cropRect: [0, 0, 700, 100],
    structure: {
      objects: [
        ...Array.from({ length: 7 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 25, (c + 1) * 100, 100]
        })),
        ...[
          [25, 45],
          [45, 60],
          [60, 80],
          [80, 100]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 700, b] })),
        { label: 'table column header', rect: [0, 25, 700, 60] }
      ]
    }
  }
  let index = 0
  const token = (text: string, x: number, y: number, width: number): HeaderToken => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const runs: HeaderRun[] = []
  const joined = (parts: Array<[string, number, number]>, y: number): HeaderToken => {
    const item = token(
      parts.map(([t]) => t).join(' '),
      parts[0][1],
      y,
      parts.at(-1)![2] - parts[0][1]
    )
    let offset = 0
    const gaps = parts.slice(1).map((_, n) => {
      offset += parts[n][0].replace(/\s/gu, '').length
      return { left: parts[n][2], right: parts[n + 1][1], index: offset }
    })
    const literalGlyphs = [...item.text.replace(/\s/gu, '')]
    runs.push({
      text: item.text,
      rect: item.rect,
      baseline: item.baseline,
      height: item.height,
      literalGlyphs,
      glyphRuns: literalGlyphs.map(() => 1),
      gaps
    })
    return item
  }
  const source = [
    token('Item', 15, 25, 35),
    token('Group alpha', 200, 5, 100),
    token('Group beta', 500, 5, 100),
    joined(
      [
        ['Combined measurements', 120, 280],
        ['Single', 320, 380],
        ['Combined measurements', 420, 580],
        ['Single', 620, 680]
      ],
      25
    ),
    joined(
      [
        ['Left', 130, 170],
        ['Right', 230, 270]
      ],
      45
    ),
    token('Score', 330, 45, 40),
    joined(
      [
        ['Left', 430, 470],
        ['Right', 530, 570]
      ],
      45
    ),
    token('Score', 630, 45, 40),
    ...[0, 1].flatMap((r) => [
      token(r ? 'B' : 'A', 15, 65 + r * 20, 15),
      ...Array.from({ length: 6 }, (_, c) =>
        token(`${r + c + 1}.5`, c * 100 + 125, 65 + r * 20, 50)
      )
    ])
  ]
  const rules = [0, 60, 100].map((y) => [0, y, 700, y])
  rules.push(
    [110, 20, 390, 20],
    [410, 20, 690, 20],
    [110, 40, 290, 40],
    [310, 40, 390, 40],
    [410, 40, 590, 40],
    [610, 40, 690, 40]
  )
  return { table, source, rules, runs }
}

const groupedHeaderWithSplitNativeOwners = (): HeaderFixture & {
  captions: Array<{ page: number; lines: string[]; rect: number[] }>
  distantRun: HeaderRun
} => {
  const crop = [108.56300994, 319.31032608, 431.44303708, 441.53448426]
  const width = crop[2] - crop[0]
  const rowEdges = [
    0, 11.981278419, 23.230344309, 36.845122089, 50.459899869, 61.708550649, 72.957201429,
    84.206267319, 95.455333209, 106.703983989, 122.22415818
  ]
  const columnEdges = [
    0,
    38.10128646,
    72.934172621,
    107.766052721,
    142.597932821,
    177.430228031,
    213.793148298,
    251.686464648,
    288.049155941,
    width
  ]
  const table = {
    id: 'page-8-table-1',
    recoveredGrid: true,
    cropRect: crop,
    structure: {
      objects: [
        ...rowEdges.slice(0, -1).map((top, row) => ({
          label: 'table row',
          rect: [0, top, width, rowEdges[row + 1]]
        })),
        ...columnEdges.slice(0, -1).map((left, column) => ({
          label: 'table column',
          rect: [left, 0, columnEdges[column + 1], 122.22415818]
        }))
      ]
    }
  }
  let index = 0
  const token = (text: string, left: number, top: number, tokenWidth: number): HeaderToken => ({
    text,
    rect: [left, top, left + tokenWidth, top + 9.056953002],
    baseline: top + 9.056953002,
    height: 9.056953002,
    horizontal: true,
    sourceItem: { pageNumber: 8, index: index++, text }
  })
  const source = [
    token('Group', 113.5260651, 332.387868498, 28.17618079),
    token('Overview', 264.27907314, 321.138387498, 49.55059087),
    token('Metric alpha', 154.26745116, 332.387868498, 54.4594584),
    token('Metric beta', 227.64478542, 332.387868498, 47.03275694),
    token('Metric gamma', 290.95570218, 332.387868498, 65.86216223),
    token('Metric delta', 378.37537752, 332.387868498, 36.47234974),
    ...[
      [153.76931916, 17.693],
      [191.73606614, 12.309],
      [223.43307936, 17.693],
      [261.39982634, 12.309],
      [293.09766978, 17.693],
      [334.12566688, 12.309],
      [368.88430248, 17.693],
      [406.85104946, 12.309]
    ].map(([left, tokenWidth], column) =>
      token(column % 2 ? 'S.D.' : 'Mean', left, 343.636519278, tokenWidth)
    ),
    ...Array.from({ length: 6 }, (_, row) => {
      const top = [
        359.617424058, 370.866074838, 382.114725618, 393.363376398, 404.612857398, 415.861508178
      ][row]
      const labels = ['Set A', 'Set B', 'Set C', 'Set D', 'Set E', 'Set F']
      const labelX = [
        122.07567066, 125.09601102, 124.59372792, 119.0553303, 122.07567066, 121.57338756
      ][row]
      const labelWidth = [11.077, 5.036, 6.041, 17.118, 11.077, 12.082][row]
      const valueXs = [
        151.62735156, 186.460392806, 221.29111176, 256.124153006, 290.95570218, 328.84999354,
        366.74233488, 401.575376126
      ]
      return [
        token(labels[row], labelX, top, labelWidth),
        ...valueXs.map((left, column) =>
          token(((100 + row * 8 + column) / 1000).toFixed(4), left, top, 24.90662076)
        )
      ]
    }).flat()
  ]
  const rules = [
    [crop[0], crop[1], crop[2], crop[1]],
    [crop[0], crop[1] + rowEdges[3], crop[2], crop[1] + rowEdges[3]],
    [crop[0], crop[3], crop[2], crop[3]]
  ]
  const captions = [
    {
      page: 8,
      lines: ['Table 1: grouped measurements.'],
      rect: [105.8355, 443.6721, 433.6936, 476.5485]
    }
  ]
  const distantRun: HeaderRun = {
    text: 'ordinary nearby note',
    rect: [850, 1000, 980, 1010],
    baseline: 1010,
    height: 10,
    literalGlyphs: [...'ordinary nearby note'],
    glyphRuns: Array(20).fill(0),
    gaps: []
  }
  return { table, source, rules, captions, distantRun }
}

it('restores three grouped tiers from native measured header runs while preserving complete records', () => {
  const f = threeTierHeader()
  const result = refineTable(f.table, f.source, [], [], f.rules, f.runs)
  expect(result.grid).toEqual([
    ['Item', 'Group alpha', '', '', 'Group beta', '', ''],
    ['', 'Combined measurements', '', 'Single', 'Combined measurements', '', 'Single'],
    ['', 'Left', 'Right', 'Score', 'Left', 'Right', 'Score'],
    ['A', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5'],
    ['B', '2.5', '3.5', '4.5', '5.5', '6.5', '7.5']
  ])
  expect(result.cells.find((c: { text: string }) => c.text === 'Item')).toMatchObject({
    rowSpan: 3
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Group alpha')).toMatchObject({
    colSpan: 3
  })
  expect(result.unassigned).toEqual([])
  expect(
    [
      ...new Set(
        result.cells.flatMap((c: { sourceItems?: Array<{ index: number }> }) =>
          (c.sourceItems ?? []).map((s) => s.index)
        )
      )
    ].sort((a, b) => Number(a) - Number(b))
  ).toEqual(f.source.map((s) => s.sourceItem.index))
})

it('stops grouped headers before a section heading that precedes the first numeric record', () => {
  const f = threeTierHeader()
  f.table.cropRect = [0, 0, 700, 120]
  for (const object of f.table.structure.objects) {
    if (object.label === 'table column') object.rect[3] = 120
    if (object.label === 'table row' && object.rect[1] >= 60) {
      object.rect[1] += 20
      object.rect[3] += 20
    }
  }
  f.table.structure.objects.push({ label: 'table row', rect: [0, 60, 700, 80] })
  f.source = f.source.map((item) => {
    if (item.baseline <= 60) return item
    return {
      ...item,
      baseline: item.baseline + 20,
      rect: [item.rect[0], item.rect[1] + 20, item.rect[2], item.rect[3] + 20]
    }
  })
  f.source.push({
    text: 'Traditional Models',
    rect: [15, 62, 120, 72],
    baseline: 72,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 99, text: 'Traditional Models' }
  })
  const shortRules = f.rules.filter((rule) => rule[1] === 20 || rule[1] === 40)
  f.rules = [...[0, 60, 80, 100, 120].map((y) => [0, y, 700, y]), ...shortRules]
  const result = refineTable(f.table, f.source, [], [], f.rules, f.runs)
  expect(result.repairs).toContain('native-grouped-header-tiers-recovered')
  expect(result.grid.slice(0, 4)).toEqual([
    ['Item', 'Group alpha', '', '', 'Group beta', '', ''],
    ['', 'Combined measurements', '', 'Single', 'Combined measurements', '', 'Single'],
    ['', 'Left', 'Right', 'Score', 'Left', 'Right', 'Score'],
    ['Traditional Models', '', '', '', '', '', '']
  ])
  expect(result.grid.at(-2)).toEqual(['A', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5'])
  expect(result.grid.at(-1)).toEqual(['B', '2.5', '3.5', '4.5', '5.5', '6.5', '7.5'])
  expect(
    [
      ...new Set(
        result.cells.flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
          (cell.sourceItems ?? []).map((item) => item.index)
        )
      )
    ].sort((a, b) => a - b)
  ).toEqual(f.source.map((item) => item.sourceItem.index).sort((a, b) => a - b))
})

it.each(['missing measured gaps', 'competing parent'])(
  'does not invent grouped header ownership with %s',
  (variant) => {
    const f = threeTierHeader()
    if (variant === 'missing measured gaps') f.runs[0].gaps = []
    if (variant === 'competing parent')
      f.source.push({
        ...f.source[1],
        text: 'Other group',
        sourceItem: { ...f.source[1].sourceItem, index: 99, text: 'Other group' }
      })
    expect(refineTable(f.table, f.source, [], [], f.rules, f.runs).repairs).not.toContain(
      'native-grouped-header-tiers-recovered'
    )
  }
)

it('allows native leaf text to correct a small model column-edge offset', () => {
  let index = 0
  const token = (text: string, rect: number[]): HeaderToken => ({
    text,
    rect,
    baseline: rect[3],
    height: 14.9439,
    horizontal: true,
    sourceItem: { pageNumber: 24, index: index++, text }
  })
  const leaf = token('MAE Std. Error MAE Std. Error', [202.6335, 912.3291, 409.5169, 927.273])
  const glyphs = [...leaf.text.replace(/\s/gu, '')]
  const run: HeaderRun = {
    text: leaf.text,
    rect: leaf.rect,
    baseline: leaf.baseline,
    height: leaf.height,
    literalGlyphs: glyphs,
    glyphRuns: glyphs.map(() => 1),
    gaps: [
      { left: 235.8388, right: 242.7728, index: 3 },
      { left: 302.6082, right: 309.5422, index: 12 },
      { left: 342.7475, right: 349.6815, index: 15 }
    ]
  }
  const source = [
    token('Parameter', [135.3405, 887.1921, 195.6989, 902.136]),
    token('n', [224.989, 887.1921, 233.9583, 902.136]),
    token('= 100', [238.1127, 887.1921, 276.3063, 902.136]),
    token('n', [331.8976, 887.1921, 340.8669, 902.136]),
    token('= 200', [345.0213, 887.1921, 383.215, 902.136]),
    leaf,
    ...[
      ['A', 937.7661, ['0.1', '0.2', '0.3', '0.4']],
      ['B', 955.6986, ['0.5', '0.6', '0.7', '0.8']]
    ].flatMap(([label, y, values]) => [
      token(String(label), [135.34, Number(y), 150, Number(y) + 14.9439]),
      ...values.map((value, column) =>
        token(String(value), [
          198.6885 + column * 53.4543,
          Number(y),
          239.7842 + column * 53.4543,
          Number(y) + 14.9439
        ])
      )
    ])
  ]
  const x = [120, 190.8625, 242.2731, 302.3079, 349.8131, 419]
  const table = {
    id: 'measured-grouped-header-edge-offset',
    cropRect: [120, 880, 419, 976],
    structure: {
      objects: [
        ...x.slice(0, -1).map((left, column) => ({
          label: 'table column',
          rect: [left - 120, 0, x[column + 1] - 120, 96]
        })),
        ...[
          [0, 55.601],
          [55.601, 73],
          [73, 96]
        ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 299, bottom] })),
        { label: 'table column header', rect: [0, 0, 299, 55.601] }
      ]
    }
  }
  const rules = [884.8035, 935.601, 976].map((y) => [133.8465, y, 411.0105, y])
  const result = refineTable(table, source, [], [], rules, [run])
  expect(result.repairs).toContain('native-grouped-header-tiers-recovered')
  expect(result.grid.slice(0, 2)).toEqual([
    ['Parameter', 'n = 100', '', 'n = 200', ''],
    ['', 'MAE', 'Std. Error', 'MAE', 'Std. Error']
  ])
  expect(result.unassigned).toEqual([])
})

it('attaches a nearby direction marker to its measured grouped label', () => {
  const f = threeTierHeader()
  const marker: HeaderToken = {
    text: '↑',
    rect: [302, 5, 310, 15],
    baseline: 15,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 100, text: '↑' }
  }
  f.source.push(marker)
  const before = structuredClone(f)
  const result = refineTable(f.table, f.source, [], [], f.rules, f.runs)
  expect(f).toEqual(before)
  expect(() => JSON.stringify(result)).not.toThrow()
  expect(result.grid[0][1]).toBe('Group alpha ↑')
  expect(
    result.cells.find((cell: { text: string }) => cell.text === 'Group alpha ↑')
  ).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 3,
    sourceItems: [
      { pageNumber: 1, index: 1, text: 'Group alpha' },
      { pageNumber: 1, index: 100, text: '↑' }
    ]
  })
})

it('recovers native grouped tiers when the printed header is open', () => {
  const f = threeTierHeader()
  f.rules = f.rules.filter((rule) => rule[0] === 0 || rule[2] === 700)
  const result = refineTable(f.table, f.source, [], [], f.rules, f.runs)
  expect(result.grid).toEqual([
    ['Item', 'Group alpha', '', '', 'Group beta', '', ''],
    ['', 'Combined measurements', '', 'Single', 'Combined measurements', '', 'Single'],
    ['', 'Left', 'Right', 'Score', 'Left', 'Right', 'Score'],
    ['A', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5'],
    ['B', '2.5', '3.5', '4.5', '5.5', '6.5', '7.5']
  ])
  expect(result.unassigned).toEqual([])
  expect(
    [
      ...new Set(
        result.cells.flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
          (cell.sourceItems ?? []).map((item) => item.index)
        )
      )
    ].sort((a: number, b: number) => a - b)
  ).toEqual(f.source.map((item) => item.sourceItem.index))
})

it('clears split-word warnings only after rebuilding their exact grouped-header owners', () => {
  const f = groupedHeaderWithSplitNativeOwners()
  const result = refineTable(f.table, f.source, f.captions, [], f.rules, [f.distantRun])

  expect(result.repairs).toContain('native-grouped-header-tiers-recovered')
  expect(result.grid.slice(0, 3)).toEqual([
    ['Group', 'Overview', '', '', '', '', '', '', ''],
    ['', 'Metric alpha', '', 'Metric beta', '', 'Metric gamma', '', 'Metric delta', ''],
    ['', 'Mean', 'S.D.', 'Mean', 'S.D.', 'Mean', 'S.D.', 'Mean', 'S.D.']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('unassigned-source-text')
  const owners = result.cells.flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
    (cell.sourceItems ?? []).map((item) => item.index)
  )
  expect(owners.sort((a: number, b: number) => a - b)).toEqual(
    f.source.map((item) => item.sourceItem.index).sort((a: number, b: number) => a - b)
  )
})

it('allows one native parent to cover every child in the upper open tier', () => {
  const f = threeTierHeader()
  f.source = f.source.filter((item) => !item.text.startsWith('Group '))
  f.source.push({
    text: 'All measurements',
    rect: [340, 5, 460, 15],
    baseline: 15,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 100, text: 'All measurements' }
  })
  const result = refineTable(
    f.table,
    f.source,
    [],
    [],
    f.rules.filter((rule) => rule[0] === 0 || rule[2] === 700),
    f.runs
  )
  expect(result.grid[0]).toEqual(['Item', 'All measurements', '', '', '', '', ''])
  expect(
    result.cells.find((cell: { text: string }) => cell.text === 'All measurements')
  ).toMatchObject({
    column: 1,
    colSpan: 6
  })
  expect(result.unassigned).toEqual([])
})

it('joins native symbol-equals-value parents over repeated measured children', () => {
  const table = {
    id: 'paired-measure-header',
    cropRect: [0, 0, 500, 100],
    structure: {
      objects: [
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 25, x + 100, 95]
        })),
        ...[
          [25, 50],
          [50, 75],
          [75, 85],
          [85, 95]
        ].map(([top, bottom]) => ({
          label: 'table row',
          rect: [0, top, 500, bottom]
        })),
        { label: 'table column header', rect: [0, 25, 500, 75] }
      ]
    }
  }
  let index = 0
  const token = (text: string, left: number, top: number, width: number): HeaderToken => ({
    text,
    rect: [left, top, left + width, top + 10],
    baseline: top + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    token('Parameter', 10, 30, 70),
    token('n', 165, 5, 10),
    token('= 100', 180, 5, 40),
    token('n', 365, 5, 10),
    token('= 200', 380, 5, 40),
    ...[
      ['MAE', 115],
      ['Std. Error', 215],
      ['MAE', 315],
      ['Std. Error', 415]
    ].map(([text, x]) => token(String(text), Number(x), 30, String(text).length * 7)),
    ...[0, 1].flatMap((row) => [
      token(row ? 'B' : 'A', 10, 55 + row * 20, 15),
      ...[1, 2, 3, 4].map((c) => token(`${row + c}.5`, c * 100 + 15, 55 + row * 20, 30))
    ])
  ]
  const runs: HeaderRun[] = [
    ...[source[2], source[4]].map((item) => ({
      text: item.text,
      rect: item.rect,
      baseline: item.baseline,
      height: item.height,
      literalGlyphs: [...item.text.replace(/\s/gu, '')],
      glyphRuns: [...item.text.replace(/\s/gu, '')].map(() => item.sourceItem.index),
      gaps: [{ left: item.rect[0] + 12, right: item.rect[0] + 15, index: 1 }]
    }))
  ]
  const result = refineTable(
    table,
    source,
    [],
    [],
    [0, 50, 75, 100].map((y) => [0, y, 500, y]),
    runs
  )
  expect(result.grid).toEqual([
    ['Parameter', 'n = 100', '', 'n = 200', ''],
    ['', 'MAE', 'Std. Error', 'MAE', 'Std. Error'],
    ['A', '1.5', '2.5', '3.5', '4.5'],
    ['B', '2.5', '3.5', '4.5', '5.5']
  ])
  expect(
    result.cells.filter((cell: { text: string }) => cell.text.startsWith('n = '))
  ).toMatchObject([
    { row: 0, column: 1, colSpan: 2, rowSpan: 1 },
    { row: 0, column: 3, colSpan: 2, rowSpan: 1 }
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
        (cell.sourceItems ?? []).map((item) => item.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(source.map((item) => item.sourceItem.index))
})

it('keeps a wrapped stub continuation in the same native header cell', () => {
  const table = {
    id: 'wrapped-stub-header',
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({
          label: 'table column',
          rect: [x, 20, x + 100, 80]
        })),
        ...[20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 20] })),
        { label: 'table column header', rect: [0, 22, 300, 60] }
      ]
    }
  }
  let index = 0
  const token = (text: string, x: number, y: number, width: number): HeaderToken => ({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    token('Method', 10, 25, 40),
    token('No. of', 110, 20, 35),
    token('Activated', 108, 28, 50),
    token('Parameters', 105, 42, 60),
    token('Metrics', 215, 20, 40),
    token('Score', 215, 42, 30),
    token('A', 10, 65, 10),
    token('1', 110, 65, 10),
    token('2', 210, 65, 10)
  ]
  const result = refineTable(
    table,
    source,
    [],
    [],
    [0, 60, 80, 100].map((y) => [0, y, 300, y])
  )
  expect(result.grid.slice(0, 2)).toEqual([
    ['Method', 'No. of Activated Parameters', 'Metrics'],
    ['', '', 'Score']
  ])
  expect(
    result.cells.find((cell: { text: string }) => cell.text === 'No. of Activated Parameters')
  ).toMatchObject({ row: 0, column: 1, rowSpan: 2, colSpan: 1 })
  expect(result.repairs).toContain('native-wrapped-header-stub-recovered')
  expect(
    result.cells
      .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
        (cell.sourceItems ?? []).map((item) => item.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(source.map((item) => item.sourceItem.index))
})

it('does not join a wrapped stub whose continuation crosses the native header rule', () => {
  const table = {
    id: 'wrapped-stub-body-boundary',
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({
          label: 'table column',
          rect: [x, 20, x + 100, 80]
        })),
        ...[20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 20] })),
        { label: 'table column header', rect: [0, 22, 300, 60] }
      ]
    }
  }
  let index = 0
  const token = (text: string, x: number, y: number, width: number): HeaderToken => ({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    token('Method', 10, 25, 40),
    token('No. of', 110, 20, 35),
    token('Activated', 108, 28, 50),
    token('Parameters', 105, 55, 60),
    token('Metrics', 215, 20, 40),
    token('Score', 215, 42, 30),
    token('A', 10, 65, 10),
    token('1', 110, 65, 10),
    token('2', 210, 65, 10)
  ]
  const result = refineTable(
    table,
    source,
    [],
    [],
    [0, 60, 80, 100].map((y) => [0, y, 300, y])
  )
  expect(result.repairs).not.toContain('native-wrapped-header-stub-recovered')
  expect(
    result.cells.find((cell: { text: string }) => cell.text === 'No. of Activated Parameters')
  ).toBeUndefined()
})

it('rebuilds a two-row ruled math table from complete native column anchors', () => {
  const table = {
    id: 'ruled-math-table',
    cropRect: [0, 0, 400, 50],
    rowCount: 1,
    columnCount: 6,
    structure: {
      objects: [
        ...Array.from({ length: 6 }, (_, column) => ({
          label: 'table column',
          rect: [column * 65, 0, (column + 1) * 65, 50]
        })),
        { label: 'table row', rect: [0, 0, 500, 50] }
      ]
    }
  }
  const source: HeaderToken[] = []
  const token = (text: string, x: number, top: number, width: number, height = 10): void => {
    const index = source.length
    source.push({
      text,
      rect: [x, top, x + width, top + height],
      baseline: top + height,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })
  }
  token('Hypothesis Class(F)', 10, 5, 50)
  token('F1(Lasso)', 80, 5, 50)
  token('F2(Ridge)', 150, 5, 50)
  token('FK(Kernel)', 220, 5, 50)
  token('Size of S(M(F))', 10, 25, 50)
  token('Ω', 80, 25, 8)
  token('log(d)', 90, 25, 20)
  token('ε', 111, 35, 7)
  token('2', 118, 25, 4, 5)
  token('Ω', 150, 25, 8)
  token('d', 160, 25, 7)
  token('ε', 181, 35, 7)
  token('2', 188, 25, 4, 5)
  token('Ω', 220, 25, 8)
  token('r', 230, 25, 7)
  token('2', 237, 25, 4, 5)
  token('ε', 251, 35, 7)
  token('2', 258, 25, 4, 5)
  const result = refineTable(
    table,
    source,
    [{ page: 1, lines: ['Table 1: A measured example'], rect: [100, 0, 300, 5] }],
    [],
    [0, 20, 50].map((y) => [0, y, 400, y])
  )
  expect(result.grid).toHaveLength(2)
  expect(result.grid[0]).toEqual(['Hypothesis Class(F)', 'F1(Lasso)', 'F2(Ridge)', 'FK(Kernel)'])
  expect(result.grid[1][0]).toBe('Size of S(M(F))')
  expect(result.repairs).toContain('native-ruled-two-row-math-table-recovered')
  const separateRecords = source.slice(0, 4)
  for (const [top, start] of [
    [25, 1],
    [40, 5]
  ]) {
    for (let column = 0; column < 4; column++) {
      const text = String(start + column)
      separateRecords.push({
        text,
        rect: [10 + column * 70, top, 20 + column * 70, top + 10],
        height: 10,
        baseline: top + 10,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: separateRecords.length, text }
      })
    }
  }
  expect(
    refineTable(
      { ...table, cropRect: [0, 0, 400, 70] },
      separateRecords,
      [{ page: 1, lines: ['Table 1: Measurements'], rect: [0, -15, 400, -5] }],
      [],
      [0, 20, 70].map((y) => [0, y, 400, y])
    ).repairs
  ).not.toContain('native-ruled-two-row-math-table-recovered')
  const missingRows = refineTable(
    {
      ...table,
      rowCount: 0,
      cropRect: [0, 0, 398.5, 50],
      structure: {
        objects: table.structure.objects.filter((object) => object.label !== 'table row')
      }
    },
    source,
    [{ page: 1, lines: ['Table 1: A measured example'], rect: [100, -15, 300, -5] }],
    [],
    [0, 20, 50].map((y) => [0, y, 400, y])
  )
  expect(missingRows.grid).toEqual(result.grid)
  expect(missingRows.issues).not.toContain('missing-row-or-column')
  expect(missingRows.rows.map((row: { rect: number[] }) => row.rect)).toEqual([
    [0, 0, 400, 20],
    [0, 20, 400, 50]
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
        (cell.sourceItems ?? []).map((item) => item.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(source.map((item) => item.sourceItem.index))
  expect(
    result.cells.some(
      (cell: { row: number; textRuns?: Array<{ position: string }> }) =>
        cell.row === 1 && cell.textRuns?.some((run) => run.position === 'superscript')
    )
  ).toBe(true)
  expect(
    refineTable(
      table,
      source,
      [{ page: 1, lines: ['Table 1: A measured example'], rect: [100, 0, 300, 5] }],
      [],
      [0, 50].map((y) => [0, y, 400, y])
    ).repairs
  ).not.toContain('native-ruled-two-row-math-table-recovered')
})

it.each(['subscript', 'superscript', 'large-superscript', 'full-em-superscript'] as const)(
  'keeps an independent leaf below a single-line parent with %s',
  (position) => {
    const table = {
      id: 'anonymous-script-parent-leaf',
      cropRect: [0, 0, 300, 100],
      structure: {
        objects: [
          ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 20, x + 100, 80] })),
          ...[20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 20] })),
          { label: 'table column header', rect: [0, 18, 300, 60] }
        ]
      }
    }
    let index = 0
    const token = (text: string, x: number, y: number, width: number, height = 8): HeaderToken => ({
      text,
      rect: [x, y, x + width, y + height],
      baseline: y + height,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: index++, text }
    })
    const source = [
      token('Method', 10, 25, 40),
      token('Parent x', 105, 28, 50),
      position === 'large-superscript'
        ? token('i', 156, 26, 4, 6.8)
        : position === 'full-em-superscript'
          ? token('i', 155, 23.2, 4, 8)
          : token('i', 156, position === 'subscript' ? 32 : 24, 4, 5),
      token('Leaf', 105, 42, 30),
      token('Metrics', 215, 24, 40),
      token('Score', 215, 42, 30),
      token('A', 10, 65, 10),
      token('1', 110, 65, 10),
      token('2', 210, 65, 10)
    ]
    const result = refineTable(
      table,
      source,
      [],
      [],
      [0, 60, 80, 100].map((y) => [0, y, 300, y])
    )
    expect(result.repairs).not.toContain('native-wrapped-header-stub-recovered')
    expect(
      result.cells.find((cell: { text: string }) => cell.text.includes('Parent'))
    ).toMatchObject({ row: 0, rowSpan: 1 })
    expect(result.cells.find((cell: { text: string }) => cell.text === 'Leaf')).toMatchObject({
      row: 1,
      column: 1
    })
    for (const cell of result.cells) {
      if (cell.textRuns)
        expect(cell.textRuns.map((run: { text: string }) => run.text).join('')).toBe(cell.text)
    }
    expect(
      result.cells
        .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
          (cell.sourceItems ?? []).map((item) => item.index)
        )
        .sort((a: number, b: number) => a - b)
    ).toEqual(source.map((item) => item.sourceItem.index))
  }
)

it('retains rich text and every original when joining a genuinely wrapped header', () => {
  const table = {
    id: 'wrapped-stub-header',
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({
          label: 'table column',
          rect: [x, 20, x + 100, 80]
        })),
        ...[20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 20] })),
        { label: 'table column header', rect: [0, 22, 300, 60] }
      ]
    }
  }
  let index = 0
  const token = (text: string, x: number, y: number, width: number): HeaderToken => ({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    token('Method', 10, 25, 40),
    token('No. of', 110, 20, 35),
    token('Activated', 108, 28, 50),
    { ...token('k', 159, 33, 4), height: 5, baseline: 38, rect: [159, 33, 163, 38] },
    token('Parameters', 105, 42, 60),
    token('Metrics', 215, 20, 40),
    token('Score', 215, 42, 30),
    token('A', 10, 65, 10),
    token('1', 110, 65, 10),
    token('2', 210, 65, 10)
  ]
  const result = refineTable(
    table,
    source,
    [],
    [],
    [0, 60, 80, 100].map((y) => [0, y, 300, y])
  )
  const merged = result.cells.find(
    (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 1
  )
  expect(merged).toMatchObject({ rowSpan: 2, colSpan: 1 })
  expect(merged.text).toContain('Parameters')
  expect(merged.textRuns?.some((run: { position: string }) => run.position !== 'normal')).toBe(true)
  expect(merged.textRuns.map((run: { text: string }) => run.text).join('')).toBe(merged.text)
  expect(result.repairs).toContain('native-wrapped-header-stub-recovered')
  expect(
    result.cells
      .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
        (cell.sourceItems ?? []).map((item) => item.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(source.map((item) => item.sourceItem.index))
})
