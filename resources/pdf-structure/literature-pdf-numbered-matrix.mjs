/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  readSourceRow,
  groupSourceRowsWithScripts
} from './literature-pdf-source-records.mjs'
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
  const named = recoverNamedTriangle(source, table.cropRect, rules)
  if (named) return named
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

// A printed lower triangle establishes its sparse columns from the header and
// the increasing count of coefficients. Preserve repeated/mistyped source labels.
function recoverNamedTriangle(source, [left, top, right, bottom], rules) {
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups || groups.length < 7 || groups.length > 25) return
  const head = [...groups[0]].sort((a, b) => a.rect[0] - b.rect[0])
  if (head.length !== groups.length - 2 || !head.every((i) => /^[A-Za-z]{2,12} ?\d?$/.test(i.text)))
    return
  const firstStub = groups[1].find((i) => i.rect[2] < head[0].rect[0])
  if (!firstStub || groups[1].length !== 1) return
  const cuts = [
    left,
    (firstStub.rect[2] + head[0].rect[0]) / 2,
    ...head.slice(1).map((i, n) => (head[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const values = groups.slice(1).map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v, n) =>
        !v ||
        !/^[A-Za-z]{2,12}\d?$/.test(v[0]) ||
        v
          .slice(1)
          .some((x, c) => (c < n ? !/^[−-]?(?:0?\.\d+|1(?:\.0+)?)\*{0,2}$/.test(x) : Boolean(x)))
    )
  )
    return
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 16 &&
      r[2] >= right - 16 &&
      r[1] > union(head)[3] &&
      r[1] < firstStub.rect[1]
  )
  if (!divider) return
  const rects = groups.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}
