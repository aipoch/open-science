/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Paired univariable/multivariable summaries share coefficient, interval, R²
// and P-value headings. Recover native records, retaining intentionally blank
// model-summary values instead of filling them down.
export function recoverRegressionGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 9) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const parents = source.filter((i) => /^(?:Univariable|Multivariable) associations$/.test(i.text))
  if (
    parents.length !== 2 ||
    parents[0].text !== 'Univariable associations' ||
    parents[1].text !== 'Multivariable associations'
  )
    return
  const ci = source.filter((i) => /^99% CI$/.test(i.text))
  if (ci.length !== 2 || col(ci[0]) !== 2 || col(ci[1]) !== 6) return
  const body = source.filter((i) => i.rect[1] > Math.max(...ci.map((i) => i.rect[3])) + 1)
  const anchors = body.filter((i) => col(i) === 0 && /^∆\s*\p{L}/u.test(i.text))
  if (anchors.length < 12) return
  const groups = anchors.map((a) =>
    body.filter(
      (i) =>
        Math.abs(i.baseline - a.baseline) < a.height * 0.4 ||
        (i.height < a.height * 0.8 &&
          i.rect[0] >= a.rect[0] &&
          i.rect[0] <= a.rect[2] + 1 &&
          Math.abs(i.baseline - a.baseline) < a.height * 0.6)
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  let records = 0,
    sections = 0
  const spans = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
    { row: 0, column: 5, rowSpan: 1, colSpan: 4 }
  ]
  for (const [n, g] of groups.entries()) {
    const values = readSourceRow(g, cuts)
    if (!values) return
    if (values.slice(1).every((v) => !v)) {
      sections++
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: 9 })
      continue
    }
    if (
      values
        .slice(1, 7)
        .some((v, c) =>
          c === 1 || c === 5
            ? !/^[−-]?\d+\.\d+;[−-]?\d+\.\d+$/.test(v)
            : !/^[<>]?[−-]?\d+(?:\.\d+)?\*?$/.test(v)
        )
    )
      return
    if (values.slice(7).some((v) => v && !/^[<>]?\d+(?:\.\d+)?$/.test(v))) return
    records++
  }
  if (records < 9 || sections < 3) return
  const split =
    (Math.max(...parents.map((i) => i.rect[3])) + Math.min(...ci.map((i) => i.rect[1]))) / 2
  const rows = [
    [left, top, right, split],
    [left, split, right, Math.min(...body.map((i) => i.rect[1])) - 0.1],
    ...groups.map((g) => {
      const r = union(g)
      return [left, r[1] - 0.1, right, r[3] + 0.1]
    })
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Standard coefficient summaries have five aligned numeric fields per record.
// Explicit statistical headings and ruled section bands distinguish these
// tables from arbitrary number-rich prose; no values are filled or calculated.
export function recoverSectionedCoefficientsGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 6) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const nearby = tableSourceItems(items, [left, top - 30, right, bottom + 30])
  const headings = ['Predictor', 'β', 'SEM', 'df', 't', 'p'].map((s) =>
    nearby.filter((i) => i.text.trim() === s)
  )
  if (headings.some((a) => a.length !== 1)) return
  const header = headings.flat()
  if (
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) > 1 ||
    header.some((i, n) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])
  )
    return
  cuts[1] = Math.max(
    cuts[1],
    ...nearby
      .filter((i) => /\p{L}/u.test(i.text) && i.rect[0] < cuts[1] && i.rect[2] < header[1].rect[0])
      .map((i) => i.rect[2] + 1)
  )
  const headBottom = Math.max(...header.map((i) => i.rect[3]))
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] <= left + 15 &&
        r[2] >= right - 15 &&
        r[1] > headBottom &&
        r[1] <= bottom + 40
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 3) return
  const body = tableSourceItems(items, [
    left,
    headBottom + 0.1,
    right,
    Math.max(bottom, borders.at(-1)[1])
  ])
  const groups = []
  for (const i of body) {
    let g = groups.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.35)
    if (!g) groups.push((g = []))
    g.push(i)
  }
  const sections = [],
    records = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      r = readSourceRow(g, cuts),
      bounds = union(g)
    if (
      r &&
      /\p{L}/u.test(r[0]) &&
      r.slice(1).every((s) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)\*{0,2}$/.test(s))
    ) {
      records.push(g)
      continue
    }
    const text = g.map((i) => i.text).join(' ')
    if (
      !/\p{L}/u.test(text) ||
      /\d/.test(text) ||
      !borders.some((r) => r[1] <= bounds[1] && bounds[1] - r[1] < g[0].height * 2)
    )
      return
    sections.push(n)
  }
  if (records.length < 6 || sections.length < 2 || !hasUniqueRecordTokens(body, groups)) return
  const all = [header, ...groups],
    rects = all.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1] - 0.1, right, r[3] + 0.1]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], rects[0][1] - 0.1, x, borders.at(-1)[1]]),
    spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: 6 })),
    completeSpans: true,
    ownedTokens: new Set(all.flat()),
    cropRect: [left, Math.min(top, rects[0][1] - 0.1), right, Math.max(bottom, borders.at(-1)[1])]
  }
}
