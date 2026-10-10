/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Repeated seven-piece native frame bands establish cohort/count/summary lanes.
// Aligned section titles precede complete two-cohort records. The label and P
// belong to their physical pair; intervening section headings never join them.
export function recoverRuledScaleCohortGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect,
    source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const bands = [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom),
      (r) => r[1]
    ).values()
  ]
    .map((g) => [...g].sort((a, b) => a[0] - b[0]))
    .filter(
      (g) =>
        g.length === 7 &&
        Math.abs(g[0][0] - left) < height &&
        Math.abs(g.at(-1)[2] - right) < height &&
        g.slice(1).every((r, n) => Math.abs(r[0] - g[n][2]) < height * 0.01)
    )
    .sort((a, b) => a[0][1] - b[0][1])
  if (
    bands.length !== 3 ||
    bands[1][0][1] - bands[0][0][1] > height * 6 ||
    bands.some((g) =>
      g.some(
        (r, c) =>
          Math.abs(r[0] - bands[0][c][0]) > height * 0.01 ||
          Math.abs(r[2] - bands[0][c][2]) > height * 0.01
      )
    )
  )
    return
  const divider = bands[1][0][1],
    closing = bands[2][0][1],
    cuts = [left, ...bands[0].slice(1).map((r) => r[0] - height * 0.01), right],
    header = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider && i.rect[3] < closing),
    split = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > bands[0][0][1] &&
        r[1] < divider &&
        Math.abs(r[0] - bands[0][5][0]) < height * 0.01 &&
        Math.abs(r[2] - bands[0][6][2]) < height * 0.01
    )
  if (
    split.length !== 1 ||
    !body.length ||
    closing - Math.max(...body.map((i) => i.rect[3])) > height * 1.5
  )
    return
  const upper = header.filter((i) => i.rect[3] < split[0][1]),
    lower = header.filter((i) => i.rect[1] > split[0][1]),
    headings = readSourceRow(upper, cuts),
    leaves = readSourceRow(lower, cuts)
  if (
    !headings ||
    !leaves ||
    headings[0] ||
    !/^\p{L}{3}/u.test(headings[1]) ||
    headings[2] !== 'N' ||
    !headings.slice(3, 5).every((s) => /^\p{L}\d+$/u.test(s)) ||
    !/^\p{L}{3}/u.test(headings[5]) ||
    headings[6] ||
    leaves.slice(0, 3).some(Boolean) ||
    !leaves.slice(3, 6).every((s) => s === 'Mean(SD)') ||
    !/^p(?:value)?[†‡*]?$/i.test(leaves[6]) ||
    !hasUniqueRecordTokens(header, [upper, lower])
  )
    return
  const physical = groupSourceRowsWithScripts(body, height, 0.2)
  if (!physical || !hasUniqueRecordTokens(source, [header, ...physical])) return
  const summary = (s) => /^[−–+-]?\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(s),
    count = (s) => /^\d+$/.test(s),
    probability = (s) => /^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s),
    records = physical.map((g) => readSourceRow(g, cuts)),
    spans = []
  let names,
    sectionLeft,
    paired = 0,
    sections = 0,
    awaitingMeasure = false
  for (let n = 0; n < physical.length; n++) {
    const v = records[n],
      g = physical[n],
      row = n + 2
    if (!v) return
    if (v[0] && v.slice(1).every((s) => !s)) {
      if (
        !/\p{L}/u.test(v[0]) ||
        awaitingMeasure ||
        Math.abs(union(g)[0] - bands[0][0][0]) > height * 0.75 ||
        (sectionLeft !== undefined && Math.abs(union(g)[0] - sectionLeft) > height * 0.1)
      )
        return
      sectionLeft ??= union(g)[0]
      sections++
      awaitingMeasure = true
      spans.push({ row, column: 0, rowSpan: 1, colSpan: 7 })
      continue
    }
    const second = records[n + 1]
    if (
      sectionLeft === undefined ||
      !v[0] ||
      union(g.filter((i) => i.rect[2] < cuts[1]))[0] - sectionLeft < height * 0.4 ||
      !/^\p{L}/u.test(v[1]) ||
      !count(v[2]) ||
      !v.slice(3, 6).every(summary) ||
      !probability(v[6]) ||
      !second ||
      second[0] ||
      !/^\p{L}/u.test(second[1]) ||
      second[1] === v[1] ||
      !count(second[2]) ||
      !second.slice(3, 6).every(summary) ||
      second[6]
    )
      return
    if (names && (names[0] !== v[1] || names[1] !== second[1])) return
    names ??= [v[1], second[1]]
    if (physical[n + 1][0].baseline - g[0].baseline > height * 1.7) return
    spans.push(
      { row, column: 0, rowSpan: 2, colSpan: 1 },
      { row, column: 6, rowSpan: 2, colSpan: 1 }
    )
    paired++
    awaitingMeasure = false
    n++
  }
  if (paired < 3 || sections < 2 || awaitingMeasure) return
  const rows = physical.map((g) => [left, union(g)[1], right, union(g)[3]])
  if (rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  return {
    rows: [[left, top, right, split[0][1]], [left, split[0][1], right, divider], ...rows],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 1, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 2, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 5, rowSpan: 1, colSpan: 2 },
      ...spans
    ],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
