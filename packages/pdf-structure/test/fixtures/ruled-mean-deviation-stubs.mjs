/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Three repeated cohorts, with independently printed mean/deviation records.
export function ruledMeanDeviationStubs() {
  const crop = [100, 100, 410, 228],
    cuts = [100, 145, 180, 290, 410],
    items = []
  const token = (text, x, baseline, width) =>
    items.push({
      text,
      rect: [x, baseline - 6, x + width, baseline],
      baseline,
      height: 6,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  token('Dataset', 102, 113, 29)
  token('Clients', 148, 113, 28)
  token('Summary', 258, 108, 32)
  token('Measure A', 212, 118, 37)
  token('Measure B', 326, 118, 37)
  for (let group = 0; group < 3; group++) {
    token(`Set ${String.fromCharCode(65 + group)}`, 102, 142 + group * 36, 22)
    for (let row = 0; row < 3; row++) {
      const baseline = 130 + group * 36 + row * 12
      token(String((row + 1) * 5), 151, baseline, 8)
      for (let metric = 0; metric < 2; metric++) {
        const x = 190 + metric * 112
        token(`${70 + group + row}.${metric + 1}`, x, baseline, 17)
        token('±', x + 21, baseline, 5)
        token(`0.${row + 1}`, x + 30, baseline, 11)
      }
    }
  }
  const rows = [
    [100, 110],
    [110, 120],
    ...Array.from({ length: 9 }, (_, n) => [120 + n * 12, 132 + n * 12])
  ]
  return {
    pageItems: items,
    rules: [100, 120, 156, 192, 228].map((y) => [100, y, 410, y]),
    table: {
      id: 'page-1-table-1',
      cropRect: crop,
      rowCount: rows.length,
      columnCount: 4,
      structure: {
        objects: [
          ...cuts.slice(1).map((right, n) => ({
            label: 'table column',
            rect: [cuts[n] - 100, 0, right - 100, 128]
          })),
          ...rows.map(([top, bottom]) => ({
            label: 'table row',
            rect: [0, top - 100, 310, bottom - 100]
          })),
          { label: 'table column header', rect: [0, 0, 310, 20] },
          { label: 'table spanning cell', rect: [0, 0, 45, 20] },
          { label: 'table spanning cell', rect: [45, 0, 80, 20] },
          { label: 'table spanning cell', rect: [80, 0, 310, 10] },
          { label: 'table spanning cell', rect: [0, 20, 45, 56] },
          { label: 'table spanning cell', rect: [0, 92, 45, 128] }
        ]
      }
    }
  }
}
