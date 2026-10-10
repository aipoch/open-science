/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  readSourceRow
} from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// Independent full-width strokes enclose a complete source table. A detector's
// crop may miss an outer glyph, but all intersecting native text must fit the
// closed frame; no text may be silently dropped to make a record proof succeed.
function closedFrame(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    em = median(near.map((i) => i.height))
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  // A typographical double opening rule is one frame edge, not a header row.
  if (full.length === 4 && full[1][1] - full[0][1] < em * 0.25) full.splice(1, 1)
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const [opening, divider, closing] = full,
    source = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  const topAccent = (i) =>
    /^[¯ˉ]$/.test(i.text) &&
    opening[1] - i.rect[1] <= em * 0.1 &&
    source.some(
      (a) =>
        a !== i &&
        a.rect[1] >= opening[1] &&
        a.baseline > i.baseline &&
        a.baseline - i.baseline < em * 0.35 &&
        a.rect[0] < i.rect[2] &&
        a.rect[2] > i.rect[0]
    )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        (i.rect[1] < opening[1] && !topAccent(i)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const captionCount = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < em * 8) ||
        (c.rect[1] > closing[1] && c.rect[1] - closing[1] < em * 3))
  ).length
  if (captionCount > 1) return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (!header.length || !body.length || !hasUniqueRecordTokens(source, [header, body])) return
  return { em, opening, divider, closing, source, header, body, captionCount }
}

// A complete three-field header and repeated simultaneous text/count anchors
// distinguish records from wrapped mathematical descriptions. Only the last
// field may continue; every original token must keep a unique logical owner.
export function recoverNativeWrappedMathRecords(table, items, captions, rules) {
  const p = closedFrame(table, items, captions, rules)
  if (!p || !p.captionCount) return
  const { em, opening, divider, closing, source, header, body } = p,
    projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < em * 0.65) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (
    projections.length !== 3 ||
    projections.slice(1).some((r, n) => r[0] - projections[n][1] < em * 0.3)
  )
    return
  const cuts = [
    Math.min(opening[0], projections[0][0]),
    ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
    Math.max(opening[2], projections.at(-1)[1])
  ]
  if (!readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t))) return
  const physical = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline),
      em,
      0.3
    ),
    records = []
  if (!physical) return
  for (const row of physical) {
    const v = readSourceRow(row, cuts)
    if (!v) return
    if (/\p{L}/u.test(v[0]) && /^\d+$/.test(v[1]) && v[2]) records.push([...row])
    else if (
      !v[0] &&
      !v[1] &&
      v[2] &&
      records.length &&
      row[0].baseline - records.at(-1).at(-1).baseline < em * 2.5
    )
      records.at(-1).push(...row)
    else return
  }
  if (
    records.length < 3 ||
    physical.length <= records.length ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...r.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const ys = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [cuts[0], opening[1], cuts.at(-1), closing[1]],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Mathematical expressions are fields even when they contain no numerals.
// Every native row must independently repeat the complete header's leaf lanes,
// and positive gutters must remain empty across *all* original source glyphs.
export function recoverNativeMathFieldRecords(table, items, captions, rules) {
  const p = closedFrame(table, items, captions, rules)
  if (!p) return
  const { em, opening, divider, closing, source, header, body } = p,
    grouped = (row) =>
      groupSourceRowsWithScripts(
        [...row].sort((a, b) => a.baseline - b.baseline),
        em,
        0.3
      ),
    heads = grouped(header),
    records = grouped(body)
  if (
    heads?.length !== 1 ||
    !records ||
    records.length < 2 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const lanes = (row) => {
    const groups = []
    for (const i of [...row].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = groups.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((j) => j.rect[2])) < em * 0.65) last.push(i)
      else groups.push([i])
    }
    return groups
  }
  const groups = [lanes(header), ...records.map(lanes)],
    count = groups[0].length
  if (
    count < 3 ||
    count > 10 ||
    groups.some((g) => g.length !== count) ||
    groups[0].some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
    !body.some((i) => /[=<>±×+()]/.test(i.text))
  )
    return
  const cuts = [Math.min(opening[0], ...source.map((i) => i.rect[0]))]
  for (let c = 1; c < count; c++) {
    const a = Math.max(...groups.flatMap((g) => g[c - 1].map((i) => i.rect[2]))),
      b = Math.min(...groups.flatMap((g) => g[c].map((i) => i.rect[0])))
    if (b - a < em * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(Math.max(opening[2], ...source.map((i) => i.rect[2])))
  if ([header, ...records].some((r) => !readSourceRow(r, cuts)?.every(Boolean))) return
  // A continued table can repeat its complete column header on the next page
  // without repeating the caption. Require several numerical measurement
  // leaves in every one of many complete records, in addition to the frame.
  if (
    !p.captionCount &&
    (count < 5 ||
      records.length < 8 ||
      records.some(
        (r) =>
          readSourceRow(r, cuts)
            .slice(2)
            .filter((v) => /\d/.test(v)).length < 2
      ))
  )
    return
  // Accents can have an em-high nominal glyph box extending into the prior
  // line's box. Their independently proved row owner and disjoint glyph
  // centers preserve them without inventing an extra mathematical record.
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...r.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const ys = [
    Math.min(opening[1], ...header.map((i) => i.rect[1])),
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [cuts[0], ys[0], cuts.at(-1), closing[1]],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], ys[0], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
