/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// A complete count/count/P baseline anchors a record whose description and
// parenthesized percentage can wrap. Native horizontal rules bound the table;
// explicit colon-only section lines interrupt, rather than consume, records.
export function recoverWrappedProportionGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 4) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const p = source.find((i) => col(i) === 3 && /^[pP](?:[ -]?value)?$/.test(i.text.trim()))
  if (!p) return
  const header = source.filter((i) => Math.abs(i.baseline - p.baseline) < p.height * 0.5)
  if (![1, 2].every((c) => header.some((i) => col(i) === c && /\p{L}/u.test(i.text)))) return
  const edges = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] <= left + 12 &&
        r[2] >= right - 12 &&
        r[1] > p.baseline &&
        r[1] < bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length !== 2 || edges[0][1] - p.baseline > p.height) return
  const body = source.filter((i) => i.rect[1] >= edges[0][1] && i.rect[3] <= edges[1][1])
  const anchors = body.filter((i) => col(i) === 3 && /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(i.text))
  if (anchors.length < 3 || body.filter((i) => col(i) === 3).length !== anchors.length) return
  const sections = body.filter(
    (i) =>
      col(i) === 0 &&
      /^\p{L}[^:]{2,60}:$/u.test(i.text) &&
      !anchors.some((a) => Math.abs(i.baseline - a.baseline) < i.height * 0.5)
  )
  const bands = [...anchors, ...sections].sort((a, b) => a.rect[1] - b.rect[1])
  const groups = bands.map((a, n) =>
    body.filter(
      (i) =>
        (i.rect[1] + i.rect[3]) / 2 >= a.rect[1] &&
        (i.rect[1] + i.rect[3]) / 2 < (bands[n + 1]?.rect[1] ?? edges[1][1])
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  let wrapped = false
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      a = bands[n]
    if (sections.includes(a)) {
      if (g.length !== 1 || g[0] !== a) return
      continue
    }
    const cells = readSourceRow(g, cuts)
    if (
      !cells ||
      !/\p{L}/u.test(cells[0]) ||
      !cells.slice(1, 3).every((s) => /^\d+\(\d+(?:\.\d+)?%?\)$/.test(s))
    )
      return
    if (
      ![0, 1, 2].every((c) =>
        g.some((i) => col(i) === c && Math.abs(i.baseline - a.baseline) < a.height * 0.25)
      )
    )
      return
    const tails = g.filter((i) => col(i) > 0 && i.baseline > a.baseline + a.height * 0.5)
    if (
      tails.some(
        (i) => !/^\(\d+(?:\.\d+)?%?\)$/.test(i.text) || i.baseline - a.baseline > a.height * 1.2
      )
    )
      return
    wrapped ||= tails.length > 0
  }
  if (!wrapped) return
  const rects = [union(header), ...groups.map(union)]
  const ys = [
    rects[0][1],
    edges[0][1],
    ...rects.slice(2).map((r, n) => (rects[n + 1][3] + r[1]) / 2),
    edges[1][1]
  ]
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: sections.map((s) => ({ row: bands.indexOf(s) + 1, column: 0, rowSpan: 1, colSpan: 4 })),
    completeSpans: true
  }
}
