/* eslint-disable @typescript-eslint/explicit-function-return-type */
export function encodedSourceTableFixture(control = '\u0010') {
  const values = [
    ['Label', 'Value'],
    ['A', '12'],
    ['B', control],
    ['C', '14']
  ]
  const inventory = values.flatMap((row, r) =>
    row.map((text, c) => ({
      text,
      sourceItem: { pageNumber: 1, index: r * 2 + c, text },
      rect: [10 + c * 60, 10 + r * 20, 40 + c * 60, 20 + r * 20],
      baseline: 20 + r * 20,
      height: 10,
      horizontal: true,
      fontAscent: 0.8,
      fontDescent: -0.2
    }))
  )
  const cells = inventory.map((f, index) => ({
    row: Math.floor(index / 2),
    column: index % 2,
    rowSpan: 1,
    colSpan: 1,
    text: f.text,
    sourceItems: [f.sourceItem],
    sourceRects: [f.rect]
  }))
  const items = inventory.map((f) => ({
    str: f.text,
    dir: 'ltr',
    width: 30,
    height: 10,
    transform: [10, 0, 0, 10, f.rect[0], 200 - f.baseline],
    fontName: 'native',
    sourceItem: f.sourceItem
  }))
  return {
    table: {
      id: 'retained-table',
      page: 1,
      cropRect: [0, 0, 150, 100],
      grid: values,
      cells,
      issues: [],
      reviewCandidate: true,
      thumbnail: 'retained.png',
      notes: [{ text: 'Retained note' }]
    },
    inventory,
    context: {
      viewport: { width: 200, height: 200, rotation: 0, transform: [1, 0, 0, -1, 0, 200] },
      sourceContent: {
        items,
        styles: { native: { ascent: 0.8, descent: -0.2, vertical: false } }
      }
    },
    control: inventory[5],
    rawControl: items[5],
    cell: cells[5]
  }
}
