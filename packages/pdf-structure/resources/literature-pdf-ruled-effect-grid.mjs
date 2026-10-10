/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import { tableSourceItems, readSourceRow } from './literature-pdf-source-records.mjs'

// Crossover summaries alternate repeated text headings and complete mean/SD
// comparisons. Native horizontal rules delimit the final record and its notes.
export function recoverRuledEffectGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 4) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const groups = []
  for (const i of source) {
    const g = groups.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.3)
    if (g) g.push(i)
    else groups.push([i])
  }
  if (!groups.length) return
  const head = readSourceRow(groups[0], cuts)
  if (
    !head ||
    !/^pre-test$/i.test(head[1]) ||
    !/^post-test$/i.test(head[2]) ||
    !/^MD\(95%CI\)$/i.test(head[3])
  )
    return
  const numeric = (g) => {
    const c = readSourceRow(g, cuts)
    return (
      !!c &&
      /\p{L}/u.test(c[0]) &&
      c.slice(1, 3).every((v) => /^-?\d+\.\d+±\d+\.\d+$/.test(v)) &&
      /^-?\d+\.\d+\(-?\d+\.\d+to-?\d+\.\d+\)$/.test(c[3])
    )
  }
  const records = groups.filter(numeric)
  if (records.length < 4) return
  const end = union(records.at(-1))[3]
  const borders = rules.filter(
    (r) => r[1] === r[3] && r[1] >= end && r[1] <= end + groups[0][0].height
  )
  const ruled = borders.some((r) => {
    const parts = borders.filter((v) => Math.abs(v[1] - r[1]) < 0.2).sort((a, b) => a[0] - b[0])
    return (
      parts.length &&
      parts.every((v, n) => !n || v[0] - parts[n - 1][2] < 1) &&
      parts.at(-1)[2] - parts[0][0] > (right - left) * 0.9
    )
  })
  if (!ruled) return
  const body = groups.filter((g) => union(g)[3] <= end)
  for (const g of body) {
    const c = readSourceRow(g, cuts)
    if (!c) return
    if (!numeric(g) && !(c[0] === '' && c[1] && c[2] && (!c[3] || g === groups[0]))) return
  }
  return {
    rows: body.map((g) => {
      const r = union(g)
      return [left, r[1] - 0.1, right, r[3] + 0.1]
    }),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true
  }
}
