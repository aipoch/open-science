import { describe, expect, it } from 'vitest'

const runtime = (name: string): string =>
  new URL(`../../../../resources/pdf-structure/${name}.mjs`, import.meta.url).href

const {
  recoverUnassignedDenseRows,
  recoverUnassignedNumericContinuationRows,
  recoverWideNumericRows,
  populateTableCellText,
  rotatedColumnHeaderAssignments
} = await import(runtime('literature-pdf-table-cell-text'))
const { recoverWideTableBottomCrop } = await import(runtime('literature-pdf-table-refine'))

const cell = (
  column: number,
  left: number,
  right: number
): {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
} => ({
  row: 0,
  column,
  rowSpan: 1,
  colSpan: 1,
  rect: [left, 0, right, 30]
})

describe('external wide table geometry repairs', () => {
  it('assigns a coordinated run of vertical labels to the first row', () => {
    const cells = [cell(0, 0, 20), cell(1, 20, 40), cell(2, 40, 60), cell(3, 60, 80)]
    const items = [0, 1, 2, 3].map((column) => ({
      text: `Task-${column}`,
      rect: [column * 20 + 6, 4, column * 20 + 14, 28],
      horizontal: false,
      height: 24,
      baseline: 28
    }))
    const assignments = rotatedColumnHeaderAssignments(items, cells)
    expect(assignments.size).toBe(4)
    expect([...assignments.values()].map((value) => value.column)).toEqual([0, 1, 2, 3])
  })

  it('requires a majority of columns before accepting rotated labels', () => {
    const cells = [cell(0, 0, 20), cell(1, 20, 40), cell(2, 40, 60), cell(3, 60, 80)]
    const items = [0, 1].map((column) => ({
      text: `Task-${column}`,
      rect: [column * 20 + 6, 4, column * 20 + 14, 28],
      horizontal: false,
      height: 24,
      baseline: 28
    }))
    expect(rotatedColumnHeaderAssignments(items, cells).size).toBe(0)
  })

  it('does not promote vertical labels from a body band into the header row', () => {
    const cells = [cell(0, 0, 20), cell(1, 20, 40), cell(2, 40, 60), cell(3, 60, 80)]
    const items = [0, 1, 2, 3].map((column) => ({
      text: `Body-${column}`,
      rect: [column * 20 + 6, 48, column * 20 + 14, 72],
      horizontal: false,
      height: 24,
      baseline: 72
    }))
    expect(rotatedColumnHeaderAssignments(items, cells, [{ rect: [0, 0, 80, 30] }], [0]).size).toBe(
      0
    )
  })

  it('extends a wide crop to a witnessed native closing rule', () => {
    const table = {
      cropRect: [0, 0, 160, 50],
      structure: {
        objects: Array.from({ length: 8 }, (_, column) => ({
          label: 'table column',
          rect: [column * 20, 0, (column + 1) * 20, 50]
        }))
      }
    }
    const row = Array.from({ length: 8 }, (_, column) => ({
      text: column === 0 ? 'Model-A' : `${column + 10}`,
      rect: [column * 20 + 2, 48, column * 20 + 16, 56],
      horizontal: true,
      height: 8,
      baseline: 56
    }))
    expect(recoverWideTableBottomCrop(table, row, [[0, 58, 160, 58]])).toEqual([0, 0, 160, 59.5])
  })

  it('rejects a prose line below a wide table without a complete numeric row', () => {
    const table = {
      cropRect: [0, 0, 160, 50],
      structure: {
        objects: Array.from({ length: 8 }, (_, column) => ({
          label: 'table column',
          rect: [column * 20, 0, (column + 1) * 20, 50]
        }))
      }
    }
    const prose = [
      {
        text: 'A paragraph follows the table.',
        rect: [2, 48, 158, 56],
        horizontal: true,
        height: 8,
        baseline: 56
      }
    ]
    expect(recoverWideTableBottomCrop(table, prose, [[0, 58, 160, 58]])).toBeUndefined()
  })

  it('recovers a blank indicator row from dense unassigned source items', () => {
    const rows = [{ rect: [0, 0, 300, 20] }, { rect: [0, 20, 300, 40] }, { rect: [0, 40, 300, 60] }]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 4 }, (_, column) => ({
        row: rowIndex,
        column,
        text: '',
        rect: [column * 75, row.rect[1], (column + 1) * 75, row.rect[3]],
        sourceRects: []
      }))
    )
    const item = (
      text: string,
      x: number
    ): {
      text: string
      rect: number[]
      horizontal: boolean
    } => ({
      text,
      rect: [x, 20, x + 12, 40],
      horizontal: true
    })
    const items = [item('Long method', 4), item('✓', 90), item('✗', 165), item('✓', 240)]
    const assignments = new Map()
    const ambiguousAssignments = new Set()
    const repairs: string[] = []
    expect(
      recoverUnassignedDenseRows({
        items,
        cells,
        rows,
        headerRows: [0],
        assignments,
        ambiguousAssignments,
        repairs
      })
    ).toBe(1)
    expect([...assignments.values()].map((cell) => cell.column)).toEqual([0, 1, 2, 3])
    expect(assignments.size).toBe(4)
    expect(repairs).toContain('unassigned-dense-row-recovered')
  })

  it('rejects dense indicators that collapse onto one cell', () => {
    const rows = [{ rect: [0, 0, 300, 20] }, { rect: [0, 20, 300, 40] }]
    const cells = Array.from({ length: 4 }, (_, column) => ({
      row: 1,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 75, 20, (column + 1) * 75, 40]
    }))
    const items = [
      { text: 'Method', rect: [4, 20, 55, 30], horizontal: true },
      { text: '✓', rect: [90, 20, 102, 30], horizontal: true },
      { text: '✗', rect: [92, 20, 104, 30], horizontal: true },
      { text: '✓', rect: [94, 20, 106, 30], horizontal: true }
    ]
    const assignments = new Map()
    const repairs: string[] = []
    expect(
      recoverUnassignedDenseRows({
        items,
        cells,
        rows,
        headerRows: [0],
        assignments,
        ambiguousAssignments: new Set(),
        repairs
      })
    ).toBe(0)
    expect(assignments.size).toBe(0)
  })

  it('does not rewrite an unassigned second header row', () => {
    const rows = [0, 20, 40].map((top) => ({ rect: [0, top, 300, top + 20] }))
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 4 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 75, row.rect[1], (column + 1) * 75, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const items = [
      { text: 'Subgroup', rect: [4, 24, 60, 34], horizontal: true },
      { text: '✓', rect: [90, 24, 102, 34], horizontal: true },
      { text: '✗', rect: [165, 24, 177, 34], horizontal: true },
      { text: '✓', rect: [240, 24, 252, 34], horizontal: true }
    ]
    const assignments = new Map()
    const repairs: string[] = []
    expect(
      recoverUnassignedDenseRows({
        items,
        cells,
        rows,
        headerRows: [0, 1],
        assignments,
        ambiguousAssignments: new Set(),
        repairs
      })
    ).toBe(0)
    expect(assignments.size).toBe(0)
    expect(repairs).not.toContain('unassigned-dense-row-recovered')
  })

  it('rebuilds anonymous parallel numeric rows and preserves every lane', () => {
    const columnRects = Array.from({ length: 8 }, (_, column) => [
      column * 40,
      0,
      (column + 1) * 40,
      120
    ])
    const rows = [
      { rect: [0, 0, 320, 20], origin: 'source-native-header' },
      { rect: [0, 20, 320, 40], origin: 'model' },
      { rect: [0, 40, 320, 60], origin: 'model' },
      { rect: [0, 60, 320, 80], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 8 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: rowIndex === 1 && column === 0 ? 8 : 1,
        rect: [column * 40, row.rect[1], (column + 1) * 40, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const values = (
      label: string,
      y: number
    ): {
      text: string
      rect: number[]
      horizontal: boolean
      baseline: number
      height: number
    } => ({
      text: `${label} 1 2 3 4 5 6 7`,
      rect: [0, y, 320, y + 10],
      horizontal: true,
      baseline: y + 10,
      height: 10
    })
    const items = [values('Alpha', 22), values('Beta', 42), values('Gamma', 62)]
    const repairs: string[] = []
    expect(
      recoverWideNumericRows({
        items,
        cells,
        rows,
        columnRects,
        headerRows: [0],
        repairs
      })
    ).toBe(3)
    expect(rows).toHaveLength(4)
    expect(cells.filter((cell) => cell.row === 1)).toHaveLength(8)
    expect(repairs).toEqual([
      'wide-numeric-row-recovered',
      'wide-numeric-row-recovered',
      'wide-numeric-row-recovered'
    ])
    expect(items.map((item) => item.text)).toContain('Gamma')
  })

  it('splits a broad model band when two source baselines share it', () => {
    const columnRects = Array.from({ length: 8 }, (_, column) => [
      column * 40,
      0,
      (column + 1) * 40,
      120
    ])
    const rows = [
      { rect: [0, 0, 320, 20], origin: 'source-native-header' },
      { rect: [0, 20, 320, 80], origin: 'model' },
      { rect: [0, 80, 320, 120], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 8 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: rowIndex === 1 && column === 0 ? 8 : 1,
        rect: [column * 40, row.rect[1], (column + 1) * 40, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const values = (
      label: string,
      y: number
    ): { text: string; rect: number[]; horizontal: boolean; baseline: number; height: number } => ({
      text: `${label} 1 2 3 4 5 6 7`,
      rect: [0, y, 320, y + 10],
      horizontal: true,
      baseline: y + 10,
      height: 10
    })
    const items = [values('Alpha', 22), values('Beta', 47), values('Gamma', 82)]
    const repairs: string[] = []
    expect(
      recoverWideNumericRows({
        items,
        cells,
        rows,
        columnRects,
        headerRows: [0],
        repairs
      })
    ).toBe(3)
    expect(rows).toHaveLength(4)
    expect(repairs).toContain('wide-numeric-row-split')
    expect(items.map((item) => item.text)).toEqual(
      expect.arrayContaining(['Alpha', 'Beta', 'Gamma', '1', '2', '3', '4', '5', '6', '7'])
    )
  })

  it('inserts an anonymous missing continuation row before a spanning model stub', () => {
    const columnRects = Array.from({ length: 8 }, (_, column) => [
      column * 40,
      0,
      (column + 1) * 40,
      100
    ])
    const rows = [
      { rect: [0, 0, 320, 20], origin: 'source-native-header' },
      { rect: [0, 20, 320, 40], origin: 'model' },
      { rect: [0, 60, 320, 80], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 8 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: rowIndex === 2 && column === 0 ? 2 : 1,
        colSpan: 1,
        rect: [column * 40, row.rect[1], (column + 1) * 40, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const item = (
      text: string,
      column: number,
      y: number
    ): {
      text: string
      rect: number[]
      horizontal: boolean
      baseline: number
      height: number
    } => ({
      text,
      rect: [column * 40 + 4, y, column * 40 + 20, y + 10],
      horizontal: true,
      baseline: y + 9,
      height: 10
    })
    const previous = item('Model-A', 0, 24)
    const previousClass = item('T', 1, 24)
    const next = item('Model-B', 0, 64)
    const nextClass = item('T', 1, 64)
    const continuation = [
      item('F', 1, 44),
      item('31.07', 2, 44),
      item('1.080', 3, 44),
      item('1.103', 4, 44),
      item('1.089', 5, 44),
      item('1.086', 6, 44),
      item('flat', 7, 44)
    ]
    const items = [previous, previousClass, next, nextClass, ...continuation]
    const assignments = new Map([
      [previous, cells[8]],
      [previousClass, cells[9]],
      [next, cells[16]],
      [nextClass, cells[17]]
    ])
    const repairs: string[] = []
    expect(
      recoverUnassignedNumericContinuationRows({
        items,
        cells,
        rows,
        columnRects,
        headerRows: [0],
        assignments,
        repairs
      })
    ).toBe(1)
    expect(rows).toHaveLength(4)
    expect(cells.filter((cell) => cell.row === 2)).toHaveLength(8)
    expect(cells.find((cell) => cell.row === 3 && cell.column === 0)?.rowSpan).toBe(2)
    expect(continuation.every((source) => assignments.has(source))).toBe(true)
    expect(repairs).toContain('unassigned-numeric-continuation-row-recovered')
  })

  it('splits a parenthesized model label from a fused leading metric', () => {
    const columnRects = Array.from({ length: 8 }, (_, column) => [
      column * 40,
      0,
      (column + 1) * 40,
      60
    ])
    const rows = [
      { rect: [0, 0, 320, 20], origin: 'model' },
      { rect: [0, 20, 320, 40], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 8 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 40, row.rect[1], (column + 1) * 40, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const item = (
      text: string,
      column: number
    ): {
      text: string
      rect: number[]
      horizontal: boolean
      baseline: number
      height: number
    } => ({
      text,
      rect: [column * 40 + 4, 24, column * 40 + 30, 34],
      horizontal: true,
      baseline: 33,
      height: 10
    })
    const fused = {
      text: 'Multimodal (Gemma) 0.24',
      rect: [4, 24, 78, 34],
      horizontal: true,
      baseline: 33,
      height: 10
    }
    const items = [
      fused,
      ...['0.91', '1.57', '0.11', '0.41', '0.73', '3.02'].map((text, i) => item(text, i + 2))
    ]
    const issues = new Set<string>()
    const repairs: string[] = []
    const unassigned = populateTableCellText({
      cells,
      items,
      pageItems: items,
      rows,
      columnRects,
      headerRows: [0],
      rules: [],
      bottom: 40,
      recordGrid: undefined,
      scheduleGrid: false,
      nativeMathOrder: undefined,
      rotatedContinuation: false,
      issues,
      repairs
    })
    expect(unassigned).toEqual([])
    expect(unassigned.sourceItems?.map((item: { text: string }) => item.text)).toEqual([
      'Multimodal (Gemma)',
      '0.24'
    ])
    expect(
      unassigned.reconciliationItems?.some((item: { text: string }) => item.text === '0.24')
    ).toBe(true)
    expect(cells.find((cell) => cell.row === 1 && cell.column === 0)?.text).toBe(
      'Multimodal (Gemma)'
    )
    expect(cells.find((cell) => cell.row === 1 && cell.column === 1)?.text).toBe('0.24')
    expect(repairs).toContain('fused-label-leading-value-split')
  })

  it('splits a fused count and data type across empty adjacent cells', () => {
    const columnRects = Array.from({ length: 4 }, (_, column) => [
      column * 30,
      0,
      (column + 1) * 30,
      60
    ])
    const rows = [
      { rect: [0, 0, 120, 20], origin: 'source-native-header' },
      { rect: [0, 20, 120, 40], origin: 'model' },
      { rect: [0, 40, 120, 60], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 4 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 30, row.rect[1], (column + 1) * 30, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const fused = {
      text: '138K Real',
      rect: [35, 18, 85, 32],
      horizontal: true,
      baseline: 32,
      height: 14
    }
    const items = [fused]
    const issues = new Set<string>()
    const repairs: string[] = []
    expect(
      populateTableCellText({
        cells,
        items,
        pageItems: items,
        rows,
        columnRects,
        headerRows: [0],
        rules: [],
        bottom: 60,
        recordGrid: undefined,
        scheduleGrid: false,
        nativeMathOrder: undefined,
        rotatedContinuation: false,
        issues,
        repairs
      })
    ).toEqual([])
    expect(cells.find((cell) => cell.row === 1 && cell.column === 1)?.text).toBe('138K')
    expect(cells.find((cell) => cell.row === 1 && cell.column === 2)?.text).toBe('Real')
    expect(repairs).toContain('adjacent-cell-run-split')
  })

  it('splits a reported missing-value marker and data type across empty adjacent cells', () => {
    const columnRects = Array.from({ length: 4 }, (_, column) => [
      column * 30,
      0,
      (column + 1) * 30,
      60
    ])
    const rows = [
      { rect: [0, 0, 120, 20], origin: 'source-native-header' },
      { rect: [0, 20, 120, 40], origin: 'model' },
      { rect: [0, 40, 120, 60], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: 4 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 30, row.rect[1], (column + 1) * 30, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const fused = {
      text: 'n/r Private',
      rect: [35, 18, 85, 32],
      horizontal: true,
      baseline: 32,
      height: 14
    }
    const items = [fused]
    const issues = new Set<string>()
    const repairs: string[] = []
    expect(
      populateTableCellText({
        cells,
        items,
        pageItems: items,
        rows,
        columnRects,
        headerRows: [0],
        rules: [],
        bottom: 60,
        recordGrid: undefined,
        scheduleGrid: false,
        nativeMathOrder: undefined,
        rotatedContinuation: false,
        issues,
        repairs
      })
    ).toEqual([])
    expect(cells.find((cell) => cell.row === 1 && cell.column === 1)?.text).toBe('n/r')
    expect(cells.find((cell) => cell.row === 1 && cell.column === 2)?.text).toBe('Private')
    expect(repairs).toContain('adjacent-cell-run-split')
  })

  it('does not split a missing-value marker without neighbouring leaf-row evidence', () => {
    const rows = [
      { rect: [0, 0, 120, 20], origin: 'source-native-header' },
      { rect: [0, 20, 120, 40], origin: 'model' }
    ]
    const cells = rows.flatMap((row, rowIndex) =>
      Array.from({ length: rowIndex === 0 ? 1 : 4 }, (_, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 30, row.rect[1], (column + 1) * 30, row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const fused = {
      text: 'n/r Private',
      rect: [35, 18, 85, 32],
      horizontal: true,
      baseline: 32,
      height: 14
    }
    const repairs: string[] = []
    populateTableCellText({
      cells,
      items: [fused],
      pageItems: [fused],
      rows,
      columnRects: Array.from({ length: 4 }, (_, column) => [
        column * 30,
        0,
        (column + 1) * 30,
        40
      ]),
      headerRows: [0],
      rules: [],
      bottom: 40,
      recordGrid: undefined,
      scheduleGrid: false,
      nativeMathOrder: undefined,
      rotatedContinuation: false,
      issues: new Set<string>(),
      repairs
    })
    expect(cells.find((cell) => cell.row === 1 && cell.column === 1)?.text).toBe('')
    expect(cells.find((cell) => cell.row === 1 && cell.column === 2)?.text).toBe('')
    expect(repairs).not.toContain('adjacent-cell-run-split')
  })
})
