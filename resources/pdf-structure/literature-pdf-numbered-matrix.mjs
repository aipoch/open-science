/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { tableSourceItems, readSourceRow } from './literature-pdf-source-records.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Numbered variables, consecutive column references and the printed unit
// diagonal jointly establish an upper-triangular correlation matrix. Missing
// correlations stay blank; neither symmetry nor a computed value fills them.
export function recoverNumberedMatrix(table, items, captions, rules) {
  if (!captions.some((c) => /\bcorrelations?\b/i.test(c.lines.join(' ')))) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const labels = source.filter((i) => /^\d+\.\s+\p{L}/u.test(i.text) && i.rect[2] < cuts[1])
  if (
    labels.length !== predicted.length ||
    labels.some((i, n) => Number.parseInt(i.text) !== n + 1)
  )
    return
  const heads = source.filter((i) => i.rect[3] < labels[0].rect[1] && /^\d+$/.test(i.text))
  if (
    heads.length !== predicted.length - 1 ||
    heads.some((i, n) => i.text !== String(n + 2) || Math.abs(i.baseline - heads[0].baseline) > 1)
  )
    return
  const header = readSourceRow(heads, cuts)
  if (!header || header[0] || header.slice(1).some((s, n) => s !== String(n + 2))) return
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 12 &&
      r[2] >= right - 16 &&
      r[1] > labels.at(-1).rect[3] &&
      r[1] <= bottom
  )
  if (!footer) return
  const boundaries = [
    heads[0].rect[3],
    ...labels.slice(1).map((l, n) => (labels[n].baseline + l.baseline) / 2 - l.height * 0.6),
    footer[1]
  ]
  const records = labels.map((_, n) =>
    source.filter((i) => i.rect[1] >= boundaries[n] && i.rect[3] <= boundaries[n + 1])
  )
  if (
    new Set([...heads, ...records.flat()]).size !== source.length ||
    records.flat().length + heads.length !== source.length
  )
    return
  for (let n = 0; n < records.length; n++) {
    const cells = readSourceRow(records[n], cuts)
    if (!cells || !cells[0]?.startsWith(`${n + 1}.`)) return
    for (let c = 1; c < cells.length; c++) {
      if (c < n) {
        if (cells[c]) return
      } else if (!/^[−-]?(?:0?\.\d+|1\.0+)[a-z]?$/.test(cells[c])) return
      if (n > 0 && c === n && !/^1\.0+$/.test(cells[c])) return
    }
  }
  const rects = [union(heads), ...records.map(union)]
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  const ys = [rects[0][1], ...rects.slice(1).map((r, n) => (rects[n][3] + r[1]) / 2), footer[1]]
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}
