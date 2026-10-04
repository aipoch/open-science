import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const {
  refineTable,
  recoverGroupedStubSourceRow,
  recoverClippedSideBySideCrop,
  recoverClippedLeftLabelCrop,
  recoverClippedRightLabelCrop,
  recoverRuledBottomBoundaryCrop,
  recoverWideTableBottomCrop,
  recoverCompleteTerminalSourceRowCrop
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { rebaseTableCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
const {
  recoverUnassignedStubSpans,
  recoverUnassignedSlashScoreRows,
  recoverUnassignedBracketIntervalRows,
  recoverUnassignedRepeatedGroupLabels
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)

it('stops a padded crop at an explicit ruled bottom before following prose', () => {
  const table = model(3, [0, 20, 40, 60])
  table.cropRect = [0, 0, 300, 70]
  const items = [
    item('A', 10, 16),
    item('1', 110, 16),
    item('B', 10, 36),
    item('2', 110, 36),
    ...['following', 'prose', 'starts', 'after', 'the', 'table'].map((text, index) =>
      item(text, 10 + index * 25, 60, 20)
    )
  ]
  expect(recoverRuledBottomBoundaryCrop(table, items, [[0, 55, 300, 55]])).toEqual([0, 0, 300, 57])
})

it('keeps an interior rule when a column-aligned data row follows it', () => {
  const table = model(6, [0, 20, 40, 60, 80])
  table.cropRect = [0, 0, 600, 70]
  const items = [
    ...Array.from({ length: 6 }, (_, column) => item(`Value ${column}`, column * 100 + 5, 16)),
    ...Array.from({ length: 6 }, (_, column) => item(`Result ${column}`, column * 100 + 5, 60))
  ]
  expect(recoverRuledBottomBoundaryCrop(table, items, [[0, 55, 600, 55]])).toBeUndefined()
})

it('extends a wide table for a complete terminal row below the detector crop', () => {
  const fixture = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/wide-terminal-row-below-detector-crop.jsonl'
    )
  )
  const crop = recoverWideTableBottomCrop(fixture.table, fixture.items, [])
  expect(crop?.[3]).toBeGreaterThan(112)
  expect(crop?.slice(0, 3)).toEqual([0, 0, 800])
})

it('extends a narrow table when every terminal source-text cell crosses the crop edge', () => {
  const fixture = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/complete-terminal-source-row-crop.jsonl')
  )
  const crop = recoverCompleteTerminalSourceRowCrop(fixture.table, fixture.items)
  expect(crop?.[3]).toBeGreaterThan(100)
  expect(crop?.slice(0, 3)).toEqual([0, 0, 500])
})

it('extends a raw detector crop from a complete terminal source row', () => {
  const fixture = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/complete-terminal-source-row-crop.jsonl')
  )
  const table = structuredClone(fixture.table)
  delete table.rows
  delete table.cells
  const crop = recoverCompleteTerminalSourceRowCrop(table, fixture.items)
  expect(crop?.[3]).toBeGreaterThan(96)
  expect(crop?.slice(0, 3)).toEqual([0, 0, 500])
})

it('extends outer model rows and columns when a crop grows', () => {
  const table = {
    cropRect: [0, 0, 200, 100],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 0, 100, 100] },
        { label: 'table column', rect: [100, 0, 200, 100] },
        { label: 'table row', rect: [0, 0, 200, 50] },
        { label: 'table row', rect: [0, 50, 200, 100] }
      ]
    }
  }
  const rebased = rebaseTableCrop(table, [-20, -10, 230, 130], true)
  expect(rebased.structure.objects).toContainEqual({
    label: 'table column',
    rect: [0, 10, 120, 110]
  })
  expect(rebased.structure.objects).toContainEqual({
    label: 'table column',
    rect: [120, 10, 250, 110]
  })
  expect(rebased.structure.objects).toContainEqual({ label: 'table row', rect: [20, 0, 220, 60] })
  expect(rebased.structure.objects).toContainEqual({ label: 'table row', rect: [20, 60, 220, 140] })
})

it('recovers a clipped repeated group header without adding rows or columns', () => {
  const columns = [0, 100, 200].map((start) => [start, 0, start + 100, 40])
  const header = columns.map((rect, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [rect[0], 10, rect[2], 20],
    text: ''
  }))
  const body = [1, 2].flatMap((row) =>
    columns.map((rect, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], 20 + row * 10, rect[2], 30 + row * 10],
      text: ''
    }))
  )
  const rows = [{ rect: [0, 10, 300, 20] }, { rect: [0, 20, 300, 30] }, { rect: [0, 30, 300, 40] }]
  const labels = [item('Alpha', 10, 0), item('Beta', 110, 0), item('Gamma', 210, 0)]
  const values = [1, 2].flatMap((row) =>
    columns.map((_, column) => item(String(row + column), column * 100 + 10, 20 + row * 10))
  )
  const assignments = new Map(values.map((value, index) => [value, body[index]]))
  const repairs: string[] = []
  expect(
    recoverUnassignedRepeatedGroupLabels({
      items: [...labels, ...values],
      cells: [...header, ...body],
      rows,
      columnRects: columns,
      headerRows: [0],
      assignments,
      repairs
    })
  ).toBe(3)
  expect(assignments.get(labels[0])).toBe(header[0])
  expect(rows).toHaveLength(3)
  expect(header).toHaveLength(3)
  expect(repairs).toContain('repeated-group-header-recovered')
})

it('expands both sides of a clipped side-by-side terminal table', () => {
  const table = model(3, [0, 20, 40, 60, 80, 100, 120])
  table.cropRect = [50, 0, 250, 120]
  const items = [
    ...Array.from({ length: 6 }, (_, row) => [
      item(`Model ${row}`, 20, row * 18 + 3),
      item(String(10 + row), 110, row * 18 + 3),
      item(`Method ${row}`, 180, row * 18 + 3),
      item(String(20 + row), 248, row * 18 + 3)
    ]).flat(),
    item('Final (Ours)', 20, 111),
    item('99.0', 110, 111),
    item('Final (Ours)', 180, 111),
    item('100.0', 248, 111)
  ]
  const crop = recoverClippedSideBySideCrop(table, items)
  expect(crop?.[0]).toBeLessThan(50)
  expect(crop?.[2]).toBeGreaterThan(250)
  expect(crop?.[3]).toBeGreaterThan(120)
})

it('does not merge a neighboring numeric panel into a table crop', () => {
  const table = model(3, [0, 20, 40, 60, 80, 100, 120])
  table.cropRect = [50, 0, 250, 120]
  const items = [
    ...Array.from({ length: 6 }, (_, row) => [
      item(`Neighboring row ${row}`, 20, row * 18 + 3),
      item(String(20 + row), 248, row * 18 + 3)
    ]).flat()
  ]
  expect(recoverClippedSideBySideCrop(table, items)).toBeUndefined()
})

it('recovers short multiline labels clipped at the left table edge', () => {
  const table = model(3, [0, 20, 40, 60, 80, 100])
  table.cropRect = [50, 0, 250, 100]
  const items = [
    ...Array.from({ length: 4 }, (_, row) => [
      item(`Label ${row}`, 42, row * 20 + 3),
      item(String(10 + row), 110, row * 20 + 3),
      item(String(20 + row), 210, row * 20 + 3)
    ]).flat()
  ]
  const crop = recoverClippedLeftLabelCrop(table, items)
  expect(crop?.[0]).toBeLessThan(50)
  expect(crop?.[2]).toBe(250)
})

it('does not expand a crop for one neighboring prose line', () => {
  const table = model(3, [0, 20, 40, 60, 80, 100])
  table.cropRect = [50, 0, 250, 100]
  const items = [
    item('Neighboring prose', 42, 3),
    item('10', 110, 23),
    item('20', 210, 23),
    item('30', 110, 43),
    item('40', 210, 43)
  ]
  expect(recoverClippedLeftLabelCrop(table, items)).toBeUndefined()
})

it('does not expand a crop for prose lines without owned row values', () => {
  const table = model(3, [0, 20, 40, 60])
  table.cropRect = [50, 0, 250, 100]
  const items = [item('Nearby note 0', 42, 3), item('Nearby note 1', 42, 23)]
  expect(recoverClippedLeftLabelCrop(table, items)).toBeUndefined()
})

it('expands a narrow right-edge table when several terminal glyphs cross the crop', () => {
  const table = model(2, [0, 20, 40, 60, 80, 100, 120])
  table.cropRect = [550, 158, 695, 439]
  const items = [
    item('Value', 671, 164, 29),
    item('0.15', 675, 375, 22),
    item('0.45', 675, 405, 22),
    item('6', 693, 419, 7)
  ]
  const crop = recoverClippedRightLabelCrop(table, items)
  expect(crop?.[0]).toBe(550)
  expect(crop?.[2]).toBeGreaterThan(699)
  expect(crop?.[3]).toBe(439)
})

it('recovers the anonymous clipped terminal-column fixture', () => {
  const fixture = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/clipped-right-terminal-column.jsonl')
  )
  const crop = recoverClippedRightLabelCrop(fixture.table, fixture.items)
  expect(crop?.[2]).toBeGreaterThan(699)
})

it('does not expand a right edge for an isolated neighboring line', () => {
  const table = model(2, [0, 20, 40, 60])
  table.cropRect = [100, 0, 200, 80]
  expect(recoverClippedRightLabelCrop(table, [item('neighbor', 198, 20, 20)])).toBeUndefined()
})

it('expands a right edge when terminal values carry an ASCII minus sign', () => {
  const table = { cropRect: [0, 0, 160, 50] }
  const items = [10, 25, 40].map((y) => item('-1.2', 150, y, 20))
  expect(recoverClippedRightLabelCrop(table, items)?.[2]).toBeGreaterThan(160)
})

it('recovers an omitted first line of a grouped multiline stub', () => {
  const table = model(3, [0, 20, 40, 60, 80, 100, 130])
  const items = [
    item('Subset', 5, 4),
    item('Query', 105, 4),
    item('Lake', 205, 4),
    item('WikiTables', 5, 24),
    item('10', 105, 24),
    item('20', 205, 24),
    item('MMQA', 5, 44),
    item('30', 105, 44),
    item('40', 205, 44),
    item('NYC', 5, 64),
    item('Tables: 70', 105, 64),
    item('Tables: 2638', 205, 64),
    item('Open Data', 5, 84),
    item('Avg. Rows: 1015.2', 105, 84),
    item('Avg. Rows: 856.8', 205, 84),
    item('(Hybrid)', 5, 104),
    item('Avg. Cols: 14.8', 105, 104),
    item('Avg. Cols: 10.8', 205, 104)
  ]
  expect(recoverGroupedStubSourceRow(table, items)).toBe(true)
  expect(
    table.structure.objects
      .filter((object) => object.label === 'table row')
      .some((row) => row.rect[1] >= 60 && row.rect[1] < 70)
  ).toBe(true)
  const refined = refineTable(table, items)
  expect(refined.repairs).toContain('grouped-stub-row-recovered')
  expect(refined.grid).toContainEqual(['NYC', 'Tables: 70', 'Tables: 2638'])
})

it('recovers a centered row-spanning model stub over complete value rows', () => {
  const rows = [0, 20, 40, 60].map((top, index) => ({
    rect: [0, top, 300, top + 20],
    origin: 'source-text',
    index
  }))
  const cells = [] as Array<{
    row: number
    column: number
    rowSpan: number
    colSpan: number
    rect: number[]
  }>
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 3; column++)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 100, row * 20, (column + 1) * 100, row * 20 + 20]
      })
  const stub = item('pMF-L/32', 5, 38, 40)
  const valueItems = [
    item('42.9', 105, 24),
    item('20', 205, 24),
    item('157.7', 105, 44),
    item('6', 205, 44)
  ]
  const assignments = new Map([
    [valueItems[0], cells[4]],
    [valueItems[1], cells[5]],
    [valueItems[2], cells[7]],
    [valueItems[3], cells[8]]
  ])
  const repairs: string[] = []
  expect(
    recoverUnassignedStubSpans({
      items: [stub, ...valueItems],
      cells,
      rows,
      headerRows: [0],
      assignments,
      repairs
    })
  ).toBe(1)
  const merged = cells.find((cell) => cell.column === 0 && cell.rowSpan === 2)
  expect(merged?.row).toBe(1)
  expect(assignments.get(stub)).toBe(merged)
  expect(repairs).toContain('unassigned-stub-row-span-recovered')
})

it('splits two complete slash-score runs into empty leading lanes', () => {
  const rows = [0, 20, 40].map((top, index) => ({
    rect: [0, top, 900, top + 20],
    origin: index === 0 ? 'model' : 'source-text',
    index
  }))
  type SlashCell = { row: number; column: number; rowSpan: number; colSpan: number; rect: number[] }
  const cells: SlashCell[] = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 9 }, (_, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, row * 20, (column + 1) * 100, row * 20 + 20]
    }))
  ).flat()
  const runs = [
    item('88.8/66.3 81.1/58.4 86.4/64.9 74.8/54.0', 105, 22, 390),
    item('88.7/65.9 81.7/58.6 86.4/64.5 75.6/54.3', 105, 42, 390)
  ]
  const pair = (
    source: ReturnType<typeof item>,
    cell: SlashCell
  ): [ReturnType<typeof item>, SlashCell] => [source, cell]
  const assigned: [ReturnType<typeof item>, SlashCell][] = [
    ...[1, 2].flatMap((row) => [
      pair(item(`Method ${row}`, 5, row * 20 + 2), cells[row * 9]),
      ...[5, 6, 7, 8].map((column) =>
        pair(item(String(80 + column), column * 100 + 10, row * 20 + 2), cells[row * 9 + column])
      )
    ])
  ]
  const assignments = new Map(assigned)
  const repairs: string[] = []
  expect(
    recoverUnassignedSlashScoreRows({
      items: [...runs, ...assigned.map(([source]) => source)],
      cells,
      rows,
      columnRects: Array.from({ length: 9 }, (_, column) => [
        column * 100,
        0,
        (column + 1) * 100,
        60
      ]),
      headerRows: [0],
      assignments,
      ambiguousAssignments: new Set(),
      repairs
    })
  ).toBe(2)
  expect(repairs).toContain('wide-slash-score-rows-recovered')
  expect(
    [...assignments.values()].filter((cell) => cell.column >= 1 && cell.column <= 4)
  ).toHaveLength(8)
})

it('merges complete bracket confidence subrows into their primary cells', () => {
  const rows = [0, 20, 30, 45, 55, 70, 80].map((top, index) => ({
    rect: [0, top, 800, top + (index === 0 ? 20 : 10)],
    origin: index === 0 ? 'model' : 'source-text',
    index
  }))
  const cells = rows.flatMap((row, rowIndex) => {
    const columns = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (column) => ![2, 4, 6].includes(rowIndex) || (column >= 2 && column <= 6)
    )
    return columns.map((column) => ({
      row: rowIndex,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, row.rect[1], (column + 1) * 100, row.rect[3]]
    }))
  })
  const items = [] as ReturnType<typeof item>[]
  const assignments = new Map<ReturnType<typeof item>, (typeof cells)[number]>()
  const intervalRows: ReturnType<typeof item>[][] = []
  for (const rowIndex of [1, 3, 5]) {
    for (const column of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const source = item(
        column === 0 ? `Dataset ${rowIndex}` : column === 7 ? '−0.03' : '0.80',
        column * 100 + 10,
        rows[rowIndex].rect[1] + 1
      )
      items.push(source)
      assignments.set(
        source,
        cells.find((cell) => cell.row === rowIndex && cell.column === column)!
      )
    }
  }
  for (const rowIndex of [2, 4, 6]) {
    const intervalRow: ReturnType<typeof item>[] = []
    for (const column of [2, 3, 4, 5, 6]) {
      const source = item(
        `[0.${column}0, 0.${column + 1}0]`,
        column * 100 + 20,
        rows[rowIndex].rect[1] + 1,
        60
      )
      items.push(source)
      intervalRow.push(source)
      if (rowIndex !== 2)
        assignments.set(
          source,
          cells.find((cell) => cell.row === rowIndex && cell.column === column)!
        )
    }
    intervalRows.push(intervalRow)
  }
  const repairs: string[] = []
  expect(
    recoverUnassignedBracketIntervalRows({
      items,
      cells,
      rows,
      columnRects: Array.from({ length: 8 }, (_, column) => [
        column * 100,
        0,
        (column + 1) * 100,
        100
      ]),
      headerRows: [0],
      assignments,
      ambiguousAssignments: new Set(),
      repairs,
      captions: [{ lines: ['Table 1. Sensitivity.'] }]
    })
  ).toBe(3)
  expect(repairs).toContain('bracket-ci-subrows-recovered')
  expect(intervalRows[0].every((source) => assignments.get(source)?.row === 1)).toBe(true)
  expect(intervalRows[1].every((source) => assignments.get(source)?.row === 3)).toBe(true)
  expect(intervalRows[2].every((source) => assignments.get(source)?.row === 5)).toBe(true)
})

it('splits a wide bracket confidence run by its five x lanes', () => {
  const rows = [0, 20, 30, 45, 55, 70, 80].map((top, index) => ({
    rect: [0, top, 800, top + (index === 0 ? 20 : 10)],
    origin: index === 0 ? 'model' : 'source-text',
    index
  }))
  const cells = rows.flatMap((row, rowIndex) => {
    const columns = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (column) => ![2, 4, 6].includes(rowIndex) || (column >= 2 && column <= 6)
    )
    return columns.map((column) => ({
      row: rowIndex,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, row.rect[1], (column + 1) * 100, row.rect[3]]
    }))
  })
  const items = [] as ReturnType<typeof item>[]
  const assignments = new Map<ReturnType<typeof item>, (typeof cells)[number]>()
  for (const rowIndex of [1, 3, 5]) {
    for (const column of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const source = item(
        column === 0 ? `Dataset ${rowIndex}` : column === 7 ? '−0.03' : '0.80',
        column * 100 + 10,
        rows[rowIndex].rect[1] + 1
      )
      items.push(source)
      assignments.set(
        source,
        cells.find((cell) => cell.row === rowIndex && cell.column === column)!
      )
    }
  }
  const wideRuns = [
    '[0.60, 0.70] [0.61, 0.71] [0.62, 0.72] [0.63, 0.73] [0.64, 0.74]',
    '[0.70, 0.80] [0.71, 0.81] [0.72, 0.82] [0.73, 0.83] [0.74, 0.84]',
    '[0.80, 0.90] [0.81, 0.91] [0.82, 0.92] [0.83, 0.93] [0.84, 0.94]'
  ]
  const wideSources = [2, 4, 6].map((rowIndex, index) => {
    const source = item(wideRuns[index], 200, rows[rowIndex].rect[1] + 1, 500)
    items.push(source)
    return source
  })
  const repairs: string[] = []
  expect(
    recoverUnassignedBracketIntervalRows({
      items,
      cells,
      rows,
      columnRects: Array.from({ length: 8 }, (_, column) => [
        column * 100,
        0,
        (column + 1) * 100,
        100
      ]),
      headerRows: [0],
      assignments,
      ambiguousAssignments: new Set(),
      repairs,
      captions: [{ lines: ['Table 1. Sensitivity.'] }]
    })
  ).toBe(3)
  expect(repairs).toContain('bracket-ci-subrows-recovered')
  expect(wideSources.every((source) => !items.includes(source))).toBe(true)
  expect(
    items
      .filter((source) => source.text.startsWith('['))
      .map((source) => assignments.get(source)?.row)
  ).toEqual([1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5])
})

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

it('keeps a ruled numeric table with no textual header rows safe', () => {
  const table = model(4, [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200]),
    items = Array.from({ length: 12 }, (_, row) =>
      Array.from({ length: 4 }, (_, column) =>
        item(String(column + 1), column * 100 + 5, 24 + row * 10)
      )
    ).flat(),
    captions = [{ lines: ['Table 1. Numeric values'], rect: [0, -20, 160, -10] }],
    rules = [
      [0, 20, 400, 20],
      [0, 22, 400, 22],
      [0, 24, 400, 24],
      [0, 180, 400, 180]
    ]

  const result = refineTable(table, items, captions, [], rules)
  expect(result.grid.length).toBeGreaterThanOrEqual(10)
  expect(result.grid[0]).toEqual(['1', '2', '3', '4'])
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
