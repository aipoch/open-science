/* eslint-disable @typescript-eslint/explicit-function-return-type */
// One native string crosses two cells. Partial rectangles are not source ranges.
export function wholeSourceExclusivityFixture() {
  const source = { pageNumber: 1, index: 0, text: '7] [' },
    token = {
      sourceItem: source,
      text: source.text,
      rect: [20, 20, 60, 30],
      baseline: 30,
      height: 10,
      horizontal: true
    },
    cells = [
      {
        row: 0,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '7]',
        sourceRects: [[20, 20, 40, 30]],
        sourceItems: [source]
      },
      {
        row: 0,
        column: 1,
        rowSpan: 1,
        colSpan: 1,
        text: '[',
        sourceRects: [[50, 20, 60, 30]],
        sourceItems: [source]
      }
    ]
  return {
    token,
    tokens: [token],
    table: {
      page: 1,
      cropRect: [10, 10, 70, 40],
      grid: [['7]', '[']],
      cells,
      issues: [],
      thumbnail: 'retained.png',
      notes: [{ text: 'Retained note' }]
    }
  }
}

export function measuredSourcePartitions(f) {
  for (const [i, cell] of f.table.cells.entries()) {
    cell.sourceSegments = [
      { ...f.token.sourceItem, start: i ? 3 : 0, end: i ? 4 : 2, rect: cell.sourceRects[0] }
    ]
    delete cell.sourceItems
  }
  return f
}
