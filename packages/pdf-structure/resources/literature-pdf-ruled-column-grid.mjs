/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  clusterTableRulePositions,
  classifyTableRuleEdge,
  joinHorizontalTableRules
} from './literature-pdf-table-rules.mjs'
import { recoverRuledRecordFaces } from './literature-pdf-ruled-record-faces.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Cell-width header strokes can overlap or abut. Subtotals independently prove
// abutting columns before a model-column face recovery can collapse the stub.
export function recoverRuledColumnGrid(table, items, captions, rules) {
  const marked = recoverMarkedSchedule(table, items, captions, rules)
  if (marked) return marked
  const comparisonsByCell = recoverSegmentedComparisonGrid(table, items, captions, rules)
  if (comparisonsByCell) return comparisonsByCell
  const gutters = recoverSegmentedGutterGrid(table, items, captions, rules)
  if (gutters) return gutters
  const ratings = recoverSymbolRatingGrid(table, items, captions, rules)
  if (ratings) return ratings
  const summaries = recoverRepeatedSummaryBlocks(table, items, captions, rules)
  if (summaries) return summaries
  const repeated = recoverRepeatedLeafHeaderGrid(table, items, captions, rules)
  if (repeated) return repeated
  const segmented = recoverSegmentedCellBands(table, items, captions, rules)
  if (segmented) return segmented
  const comparisons = recoverUnderlinedComparisons(table, items, captions, rules)
  if (comparisons) return comparisons
  const closed = recoverFullyRuledRecords(table, items, captions, rules)
  if (closed) return closed
  const faces = recoverRuledRecordFaces(table, items, captions, rules)
  return recoverHeaderSegmentColumns(table, items, captions, rules, Boolean(faces)) ?? faces
}

// Sparse schedules have reliable source mark baselines even when the model
// collapses several rows. Keep each mark with its stub, attaching only indented
// stub continuations; annotations in data columns must share a marked baseline.
function recoverMarkedSchedule(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cols.length < 3 || cols.length > 20) return
  const cuts = [
    crop[0],
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const isMark = (i) => /^[✓✔☑X]$/.test(i.text)
  const candidates = tableSourceItems(items, crop),
    marks = candidates.filter((i) => isMark(i) && col(i) > 0)
  if (marks.length < 8) return
  const height = marks.map((i) => i.height).sort((a, b) => a - b)[Math.floor(marks.length / 2)]
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[0] <= crop[0] + 16 && r[2] >= crop[2] - 16 && r[1] >= crop[1] - 4 && r[1] <= crop[3] + 4
  )
  const middle = (i) => (i.rect[1] + i.rect[3]) / 2
  const firstMark = Math.min(...marks.map(middle))
  const divider = edges.filter((r) => r[1] < firstMark).at(-1),
    top = edges[0],
    bottom = edges.at(-1)
  if (!divider || divider === top || bottom[1] <= firstMark || divider[1] - top[1] > height * 7)
    return
  const source = candidates.filter((i) => i.rect[1] >= top[1] && i.rect[3] <= bottom[1])
  const body = source.filter((i) => middle(i) > divider[1]),
    header = source.filter((i) => middle(i) < divider[1])
  // An uppercase cross is also a variable name. Accept it as a schedule mark
  // only when the body contains labels and marks exclusively, under text headers.
  if (
    marks.some((i) => i.text === 'X') &&
    (body.some((i) => col(i) > 0 && !isMark(i)) ||
      !cuts.slice(1).every((_, c) => header.some((i) => col(i) === c && /\p{L}/u.test(i.text))))
  )
    return
  if (body.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    return
  const baselines = []
  for (const i of marks.sort((a, b) => a.baseline - b.baseline))
    if (!baselines.some((y) => Math.abs(i.baseline - y) < height * 0.3)) baselines.push(i.baseline)
  if (baselines.length < 4) return
  const groups = baselines.map(() => [])
  const stubLeft = Math.min(...body.filter((i) => col(i) === 0).map((i) => i.rect[0]))
  const starts = body
    .filter((i) => col(i) === 0 && Math.abs(i.rect[0] - stubLeft) < 1)
    .map((i) => i.baseline)
  // Some symbol fonts place their baseline above the painted check. Repeated
  // one-to-one stub starts establish that common offset without moving glyphs.
  const offsets = starts.map((y, n) => y - baselines[n])
  if (
    marks.some((i) => i.text === 'X') &&
    (starts.length !== baselines.length || offsets.some((value) => Math.abs(value) > height * 0.3))
  )
    return
  const offset =
    starts.length === baselines.length &&
    Math.max(...offsets) - Math.min(...offsets) < height * 0.1 &&
    Math.abs(offsets[0]) < height
      ? offsets.reduce((a, b) => a + b, 0) / offsets.length
      : 0
  for (const i of body) {
    const y = i.baseline - (col(i) === 0 ? offset : 0)
    const distances = baselines.map((b) => Math.abs(y - b))
    let n = distances.indexOf(Math.min(...distances))
    if (distances[n] > height * 0.7) {
      n = baselines.findLastIndex((b) => b < y)
      if (n < 0 || col(i) !== 0 || i.rect[0] - stubLeft < height * 0.4) return
    }
    groups[n].push(i)
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...groups]) ||
    groups.some(
      (g) =>
        !g.some((i) => col(i) === 0 && /\p{L}/u.test(i.text)) ||
        new Set(g.filter(isMark).map(col)).size !== g.filter(isMark).length
    )
  )
    return
  const centers = groups.map((g) => [Math.min(...g.map(middle)), Math.max(...g.map(middle))])
  if (centers.some((r, n) => n && r[0] <= centers[n - 1][1])) return
  const ys = [divider[1], ...centers.slice(1).map((r, n) => (centers[n][1] + r[0]) / 2), bottom[1]]
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, top[1], divider[1])
  if (!hierarchy) return
  return {
    cropRect: [crop[0], top[1], crop[2], bottom[1]],
    rows: [...hierarchy.rows, ...groups.map((_, n) => [crop[0], ys[n], crop[2], ys[n + 1]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top[1], x, bottom[1]]),
    headerRows: hierarchy.rows.map((_, n) => n),
    spans: hierarchy.spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Abutting cell-width strokes can encode a grid without internal vertical
// rules. Repeated interval/probability headers and complete measured rows
// establish the leaf columns; a missing last-column divider proves a shared
// statistic only when the other five columns have a continuous divider.
function recoverSegmentedComparisonGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const horizontal = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] >= crop[0] - 12 &&
      r[2] <= crop[2] + 12 &&
      r[1] >= crop[1] - 12 &&
      r[1] <= crop[3] + 12
  )
  const xs = clusterTableRulePositions(horizontal.flatMap((r) => [r[0], r[2]])).filter(
    (x) =>
      new Set(
        horizontal.filter((r) => Math.abs(r[0] - x) < 1 || Math.abs(r[2] - x) < 1).map((r) => r[1])
      ).size >= 3
  )
  const ys = clusterTableRulePositions(horizontal.map((r) => r[1]))
  if (xs.length !== 7 || ys.length < 9 || ys.length > 50) return
  const vertical = rules.filter((r) => r[0] === r[2]),
    frame = [xs[0], ys[0], xs[6], ys.at(-1)]
  if ([xs[0], xs[6]].some((x) => classifyTableRuleEdge(vertical, 0, x, ys[0], ys.at(-1)) !== 1))
    return
  const source = tableSourceItems(items, frame),
    height = Math.max(...source.map((i) => i.height))
  const groups = ys
    .slice(1)
    .map((y, n) =>
      source.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (!source.length || !hasUniqueRecordTokens(source, groups)) return
  const col = (i) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const leaf = readSourceRow(groups[1], xs)
  if (
    !leaf ||
    !/\(95%\s*CI\)/i.test(leaf[1]) ||
    !/^P\s*Value$/i.test(leaf[2]) ||
    leaf[1] !== leaf[3] ||
    leaf[2] !== leaf[4]
  )
    return
  const upper = groups[0],
    spans = [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
    ]
  const parents = [1, 3].map((c) =>
    upper.filter((i) => i.rect[0] >= xs[c] && i.rect[2] <= xs[c + 2])
  )
  if (
    parents.some(
      (g, c) =>
        !g.length ||
        !g.some((i) => /\p{L}/u.test(i.text)) ||
        !horizontal.some(
          (r) =>
            Math.abs(r[1] - ys[1]) < 1 &&
            Math.abs(r[0] - xs[1 + c * 2]) < 1 &&
            Math.abs(r[2] - xs[3 + c * 2]) < 1
        )
    )
  )
    return
  if (
    !hasUniqueRecordTokens(
      upper,
      [...parents, upper.filter((i) => [0, 5].includes(col(i)))].filter((g) => g.length)
    )
  )
    return
  spans.push(
    { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 3, rowSpan: 1, colSpan: 2 }
  )
  const numeric = (v) => /^[<>≤≥−+\d.,()–%-]+$/.test(v.replace(/\s/g, ''))
  const values = groups.map((g) => readSourceRow(g, xs, { multiline: true }))
  let records = 0
  for (let n = 2; n < groups.length; n++) {
    const g = groups[n],
      v = values[n]
    if (
      g.length === 1 &&
      /\p{L}/u.test(g[0].text) &&
      g[0].rect[0] < xs[1] &&
      (g[0].rect[2] > xs[1] || /\(ref:/i.test(g[0].text))
    ) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 6 })
      continue
    }
    if (
      !v ||
      !/\p{L}/u.test(v[0]) ||
      !numeric(v[1]) ||
      !numeric(v[2]) ||
      v.slice(3).some((s) => s && !numeric(s))
    )
      return
    records++
    if (n + 1 >= groups.length || !v[5] || values[n + 1]?.[5]) continue
    const next = values[n + 1]
    if (!next || !/\p{L}/u.test(next[0]) || !next.slice(1, 5).every(numeric)) continue
    const divider = ys[n + 1]
    if (
      classifyTableRuleEdge(horizontal, 1, divider, xs[0], xs[5]) !== 1 ||
      classifyTableRuleEdge(horizontal, 1, divider, xs[5] + 1, xs[6] - 1) !== 0 ||
      [ys[n], ys[n + 2]].some((y) => classifyTableRuleEdge(horizontal, 1, y, xs[5], xs[6]) !== 1) ||
      groups[n].filter((i) => col(i) === 5).length !== 1 ||
      ys[n + 2] - ys[n] > height * 6
    )
      continue
    spans.push({ row: n, column: 5, rowSpan: 2, colSpan: 1 })
  }
  if (records < 6) return
  return {
    cropRect: frame,
    rows: ys.slice(1).map((y, r) => [xs[0], ys[r], xs[6], y]),
    columns: xs.slice(1).map((x, c) => [xs[c], ys[0], x, ys.at(-1)]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A publisher can draw the white column gutter separately for every cell
// band. Repeated contiguous segment endpoints retain those native row bounds
// even when no visible horizontal rule is painted between shaded records.
function recoverSegmentedGutterGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const opening = rules.find(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[1] - crop[1]) < 12 &&
      Math.abs(r[0] - crop[0]) < 30 &&
      Math.abs(r[2] - crop[2]) < 30
  )
  if (!opening) return
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] > opening[0] + 12 &&
      r[0] < opening[2] - 12 &&
      r[1] >= opening[1] &&
      r[3] <= crop[3] + 16
  )
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (![1, 5].includes(xs.length)) return
  const chains = xs.map((x) =>
    vertical.filter((r) => Math.abs(r[0] - x) < 0.1).sort((a, b) => a[1] - b[1])
  )
  if (chains.some((g) => g.length < 6 || g.some((r, n) => n && Math.abs(r[1] - g[n - 1][3]) > 0.1)))
    return
  const main = chains.reduce((a, b) => (a.length > b.length ? a : b))
  if (
    chains.some((g) =>
      g.some((r) => !main.some((s) => Math.abs(r[1] - s[1]) < 0.1 && Math.abs(r[3] - s[3]) < 0.1))
    )
  )
    return
  const cuts = [opening[0], ...xs, opening[2]],
    frame = [opening[0], main[0][1], opening[2], main.at(-1)[3]]
  const source = tableSourceItems(items, frame),
    groups = main.map((r) =>
      source.filter(
        (i) => (i.rect[1] + i.rect[3]) / 2 >= r[1] && (i.rect[1] + i.rect[3]) / 2 < r[3]
      )
    )
  if (
    !hasUniqueRecordTokens(source, groups) ||
    groups.some(
      (g, n) =>
        !g.length ||
        g.some(
          (i) =>
            !(xs.length === 5 && i.rect[2] < cuts[1]) &&
            (i.rect[1] < main[n][1] - 0.1 || i.rect[3] > main[n][3] + 0.1)
        )
    )
  )
    return
  const headerRows = [0],
    spans = []
  if (xs.length === 1) {
    const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
    if (
      values.some((v) => !v || !v[1] || !/\p{L}/u.test(v[1])) ||
      !values[0][0] ||
      values.slice(1).filter((v) => v[0]).length < 4
    )
      return
  } else {
    const head = readSourceRow(groups[0], cuts, { multiline: true })
    if (
      head &&
      !head[0] &&
      !head[1] &&
      head.slice(2, 5).every((v) => /n=\d+/i.test(v)) &&
      /^p$/i.test(head[5])
    ) {
      const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
      if (
        values
          .slice(1)
          .some((v) => !v || v.slice(2, 5).some((s) => !s || !/^[\d.,()%–−-]+$/.test(s)))
      )
        return
      const bands = main.map((r) => [frame[0], r[1], frame[2], r[3]])
      // A bare estimate and its parenthesized range are one measured record.
      for (let n = 1; n + 1 < groups.length; n++) {
        if (
          values[n].slice(2, 5).every((s) => /^\d+(?:[.,]\d+)?$/.test(s)) &&
          !values[n + 1][0] &&
          !values[n + 1][1] &&
          !values[n + 1][5] &&
          values[n + 1].slice(2, 5).every((s) => /^\([\d.,]+[–-][\d.,]+\)$/.test(s))
        ) {
          groups[n].push(...groups[n + 1])
          bands[n][3] = bands[n + 1][3]
          groups.splice(n + 1, 1)
          bands.splice(n + 1, 1)
          values.splice(n + 1, 1)
        }
      }
      const starts = values.flatMap((v, n) =>
        n && /^(?:\p{Lu}|\p{Ll}\p{Lu})/u.test(v[0]) ? [n] : []
      )
      if (starts.length < 5 || starts[0] !== 1) return
      for (const [n, start] of starts.entries()) {
        const end = starts[n + 1] ?? groups.length
        for (let r = start + 1; r < end; r++) {
          if (
            values[r][0] &&
            !/^\([\p{L}%/]+\)$/u.test(values[r][0]) &&
            (!/^\p{Ll}/u.test(values[r][0]) ||
              !values.slice(start, r).some((v) => v[0].endsWith('-')))
          )
            return
        }
        if (end - start > 1) spans.push({ row: start, column: 0, rowSpan: end - start, colSpan: 1 })
      }
      return {
        cropRect: frame,
        rows: bands,
        columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
        headerRows,
        spans,
        completeSpans: true,
        ownedTokens: new Set(source)
      }
    }
    // Two parent headings over identical three-column leaf headings prove
    // the otherwise absent first-band gutter edges.
    const parents = readSourceRow(groups[0], [cuts[0], cuts[3], cuts[6]])
    const leaves = readSourceRow(groups[1], cuts)
    if (
      !parents ||
      !parents.every((v) => /^[\p{L}\d -]+$/u.test(v)) ||
      !leaves ||
      leaves.some((v, c) => !v || v !== leaves[c % 3]) ||
      new Set(leaves).size !== 3 ||
      chains.filter((g) => g.length === main.length).length !== 1 ||
      Math.abs(main[0][0] - cuts[3]) > 0.1
    )
      return
    headerRows.push(1)
    spans.push(
      { row: 0, column: 0, rowSpan: 1, colSpan: 3 },
      { row: 0, column: 3, rowSpan: 1, colSpan: 3 }
    )
    if (groups.slice(2).some((g) => !readSourceRow(g, cuts, { multiline: true }))) return
  }
  const rows = main.flatMap((r, n) => {
    if (xs.length !== 5 || n < 2) return [[frame[0], r[1], frame[2], r[3]]]
    const parts = groupSourceRowsWithScripts(
      groups[n],
      Math.max(...groups[n].map((i) => i.height)),
      0.3
    )
    const values = parts?.map((g) => readSourceRow(g, cuts))
    // Two independent complete records can share one shaded band. A centered
    // organ label with several measurement lines is instead one native cell.
    if (
      !values ||
      values.length !== 2 ||
      values.some(
        (v) => !v || !/\p{L}/u.test(v[0]) || !v[1] || !/^\d/.test(v[2]) || v.slice(3).some(Boolean)
      )
    )
      return [[frame[0], r[1], frame[2], r[3]]]
    const mid = (union(parts[0])[3] + union(parts[1])[1]) / 2
    return [
      [frame[0], r[1], frame[2], mid],
      [frame[0], mid, frame[2], r[3]]
    ]
  })
  return {
    cropRect: frame,
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows,
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Symbol-rating matrices have independent row labels and repeated native
// column segments. Recover the complete outer border before assigning cells,
// then use the indented sublabels to delimit wrapped category stubs.
function recoverSymbolRatingGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < (crop[2] - crop[0]) * 0.08 &&
      r[1] >= crop[1] - 16 &&
      r[1] <= crop[3] + 16
  )
  if (borders.length !== 2) return
  const segments = rules
    .filter((r) => r[1] === r[3] && Math.abs(r[1] - borders[0][1]) < 0.1)
    .sort((a, b) => a[0] - b[0])
  if (
    segments.length < 5 ||
    segments.length > 12 ||
    segments.some((r, n) => n && Math.abs(r[0] - segments[n - 1][2]) > 0.1) ||
    !segments.every((r) =>
      rules.some(
        (s) =>
          s[1] === s[3] &&
          Math.abs(s[1] - borders[1][1]) < 0.1 &&
          Math.abs(s[0] - r[0]) < 0.1 &&
          Math.abs(s[2] - r[2]) < 0.1
      )
    )
  )
    return
  const cuts = [segments[0][0], ...segments.map((r) => r[2])],
    frame = [cuts[0], borders[0][1], cuts.at(-1), borders[1][1]],
    source = tableSourceItems(items, frame)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const anchors = source.filter((i) => col(i) === 1 && /\p{L}/u.test(i.text))
  if (anchors.length < 3 || anchors.length > 10) return
  const height = anchors[0].height,
    header = source.filter((i) => i.rect[3] < anchors[0].rect[1]),
    body = source.filter((i) => !header.includes(i))
  if (
    header.some((i) => col(i) < 2) ||
    cuts.slice(3).some((_, n) => !header.some((i) => col(i) === n + 2 && /\p{L}/u.test(i.text)))
  )
    return
  const values = anchors.map((a) =>
    body.filter((i) => col(i) > 0 && Math.abs(i.baseline - a.baseline) < height * 0.3)
  )
  if (
    values.some((g) => {
      const v = readSourceRow(g, cuts)
      return (
        !v ||
        v.slice(2).filter(Boolean).length === 0 ||
        v.slice(2).some((s) => s && !/^[+−–\-/]{1,4}$/.test(s))
      )
    })
  )
    return
  const stubs = body.filter((i) => col(i) === 0),
    starts = stubs.filter((i) => /^\p{Lu}/u.test(i.text)),
    labels = []
  if (starts.length < 2) return
  const spans = []
  for (const [n, start] of starts.entries()) {
    const label = stubs.filter(
      (i) => i.rect[1] >= start.rect[1] && i.rect[1] < (starts[n + 1]?.rect[1] ?? Infinity)
    )
    const owned = anchors
      .map((a, r) => ({ a, r }))
      .filter(
        ({ a }) =>
          a.rect[1] >= start.rect[1] - height * 0.2 &&
          a.rect[1] < (starts[n + 1]?.rect[1] ?? Infinity) - height * 0.2
      )
    if (
      owned.length < 2 ||
      Math.abs(owned[0].a.baseline - start.baseline) > height * 0.3 ||
      label.some(
        (i, k) => k && (!/^\p{Ll}/u.test(i.text) || i.rect[1] - label[k - 1].rect[3] > height * 0.5)
      )
    )
      return
    labels.push(label)
    spans.push({ row: owned[0].r + 1, column: 0, rowSpan: owned.length, colSpan: 1 })
  }
  if (!hasUniqueRecordTokens(source, [header, ...values, ...labels])) return
  const ys = [
    frame[1],
    (union(header)[3] + anchors[0].rect[1]) / 2,
    ...anchors.slice(1).map((a, n) => (anchors[n].rect[3] + a.rect[1]) / 2),
    frame[3]
  ]
  return {
    cropRect: frame,
    rows: ys.slice(1).map((y, r) => [cuts[0], ys[r], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated summary-statistic cycles give shared cohort stubs an exact end.
// Header segment endpoints independently locate the statistic/value columns;
// a final comparison test is a separate record, never part of the last stub.
function recoverRepeatedSummaryBlocks(table, items, captions, rules) {
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 24 &&
      Math.abs(r[2] - crop[2]) < 24 &&
      r[1] >= crop[1] - 12 &&
      r[1] <= crop[3] + 12
  )
  if (borders.length !== 3) return
  const segments = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[1] - borders[0][1]) < 0.1 &&
        r[0] >= borders[0][0] - 1 &&
        r[2] <= borders[0][2] + 1
    )
    .sort((a, b) => a[0] - b[0])
  if (
    segments.length < 5 ||
    segments.length > 16 ||
    segments.some((r, n) => n && Math.abs(r[0] - segments[n - 1][2]) > 0.1) ||
    !segments.every((r) =>
      rules.some(
        (s) =>
          s[1] === s[3] &&
          Math.abs(s[1] - borders[1][1]) < 0.1 &&
          Math.abs(s[0] - r[0]) < 0.1 &&
          Math.abs(s[2] - r[2]) < 0.1
      )
    )
  )
    return
  const cuts = [
    segments[0][0] - 1,
    ...segments.slice(1).map((r) => r[0] - 1),
    segments.at(-1)[2] + 1
  ]
  const frame = [cuts[0], borders[0][1], cuts.at(-1), borders[2][1]],
    source = tableSourceItems(items, frame)
  if (!source.length) return
  const header = source.filter((i) => i.rect[3] < borders[1][1]),
    body = source.filter((i) => i.rect[1] > borders[1][1])
  const height = Math.max(...body.map((i) => i.height)),
    groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 7 || !hasUniqueRecordTokens(source, [header, ...groups])) return
  const tail = groups.at(-1),
    prior = groups.at(-2)
  if (
    tail.length === 1 &&
    /^test$/i.test(tail[0].text) &&
    tail[0].rect[2] < cuts[2] &&
    tail[0].rect[1] - union(prior)[3] < height &&
    prior.filter((i) => /^\d/.test(i.text)).length >= 3
  ) {
    prior.push(...tail)
    groups.pop()
  }
  const numeric = (v) => /^[−+-]?\d+(?:[.,]\d+)?$/.test(v)
  const values = groups.map((g) => readSourceRow(g, cuts)),
    spans = [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }],
    blocks = []
  let footer = false
  for (let n = 0; n < groups.length; n++) {
    let cells = values[n]
    if (!cells && n === groups.length - 1) {
      const test = readSourceRow(groups[n], [cuts[0], ...cuts.slice(2)], { multiline: true })
      if (!test || !/test$/i.test(test[0]) || !test.slice(1).every(numeric)) return
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 2 })
      footer = true
      continue
    }
    if (
      !cells ||
      !/^(?:Mean|N|SD|Median|Min|Max)$/.test(cells[1]) ||
      !cells.slice(2).every(numeric)
    )
      return
    if (cells[0]) blocks.push({ start: n, label: cells[0], statistics: [] })
    if (!blocks.length) return
    blocks.at(-1).statistics.push(cells[1])
  }
  if (
    blocks.length < 2 ||
    !footer ||
    blocks[0].statistics.length < 3 ||
    blocks.some((b) => b.statistics.join('|') !== blocks[0].statistics.join('|'))
  )
    return
  const headerGroups = [
    header.filter((i) => i.rect[2] < cuts[2]),
    ...cuts.slice(3).map((x, c) => header.filter((i) => i.rect[0] >= cuts[c + 2] && i.rect[2] <= x))
  ]
  if (headerGroups.some((g) => !g.length) || !hasUniqueRecordTokens(header, headerGroups)) return
  spans.push(
    ...blocks.map((b) => ({
      row: b.start + 1,
      column: 0,
      rowSpan: b.statistics.length,
      colSpan: 1
    }))
  )
  return {
    cropRect: frame,
    rows: [
      [cuts[0], frame[1], cuts.at(-1), borders[1][1]],
      ...groups.map((g) => {
        const r = union(g)
        return [cuts[0], r[1], cuts.at(-1), r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated leaf headings independently identify columns below centered
// parents. The enclosing native rules and complete numeric body records
// distinguish this two-level header from an ordinary pair of text lines.
function recoverRepeatedLeafHeaderGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (
    !captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' && c.rect[3] <= crop[1] + 12 && crop[1] - c.rect[3] < 60
    )
  )
    return
  const borders = joinHorizontalTableRules(rules, 1.5).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 24 &&
      Math.abs(r[2] - crop[2]) < 24 &&
      r[1] >= crop[1] - 16 &&
      r[1] <= crop[3] + 16
  )
  if (borders.length !== 3) return
  const frame = [borders[0][0], borders[0][1], borders[0][2], borders.at(-1)[1]],
    source = tableSourceItems(items, frame)
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height)),
    groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 5) return
  let leaves, leafTokens
  for (const group of groups) {
    const clusters = []
    for (const i of [...group].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = clusters.at(-1)
      if (last && i.rect[0] - last.rect[2] < height * 0.35) {
        last.tokens.push(i)
        last.rect = union(last.tokens)
        last.text += i.text
      } else clusters.push({ tokens: [i], rect: [...i.rect], text: i.text })
    }
    if (
      clusters.length >= 4 &&
      clusters.length <= 12 &&
      clusters.length % 2 === 0 &&
      clusters.every((i) => /^[A-Za-z][A-Za-z0-9]+$/.test(i.text)) &&
      clusters.every((i, n) => i.text === clusters[n % (clusters.length / 2)].text) &&
      new Set(clusters.map((i) => i.text)).size === clusters.length / 2
    ) {
      leaves = clusters
      leafTokens = group
      break
    }
  }
  if (!leaves) return
  leaves.sort((a, b) => a.rect[0] - b.rect[0])
  const centers = leaves.map((i) => (i.rect[0] + i.rect[2]) / 2),
    steps = centers.slice(1).map((v, n) => v - centers[n])
  if (steps.some((v) => v < height * 2 || v > Math.min(...steps) * 1.5)) return
  const cuts = [
    frame[0],
    centers[0] - Math.min(...steps) / 2,
    ...centers.slice(1).map((v, n) => (v + centers[n]) / 2),
    frame[2]
  ]
  const leafRect = union(leaves),
    upper = source.filter((i) => i.rect[3] < leafRect[1]),
    size = leaves.length / 2,
    parents = []
  for (let c = 1; c < cuts.length - 1; c += size) {
    const p = upper.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + size])
    if (
      !p.length ||
      !p.some((i) => /\p{L}/u.test(i.text)) ||
      Math.abs((union(p)[0] + union(p)[2] - cuts[c] - cuts[c + size]) / 2) > height
    )
      return
    parents.push(p)
  }
  const stub = upper.filter((i) => i.rect[2] <= cuts[1])
  if (!stub.length || !hasUniqueRecordTokens(upper, [stub, ...parents])) return
  const body = groups.filter((g) => union(g)[1] > leafRect[3])
  if (
    body.length < 2 ||
    body.some((g) => {
      const cells = readSourceRow(g, cuts)
      return !cells || !cells[0] || cells.slice(1).some((v) => !/^[-+<>≤≥Pp=\d.±()%–]+$/.test(v))
    })
  )
    return
  if (!hasUniqueRecordTokens(source, [upper, leafTokens, ...body])) return
  const split = (union(upper)[3] + leafRect[1]) / 2
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], split],
      [frame[0], split, frame[2], leafRect[3]],
      ...body.map((g) => {
        const r = union(g)
        return [frame[0], r[1], frame[2], r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      ...parents.map((_, n) => ({ row: 0, column: 1 + n * size, rowSpan: 1, colSpan: size }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Shaded cells may paint only their horizontal edges. Repeated, abutting
// segment endpoints establish columns even when the model joins two of them.
function recoverSegmentedCellBands(table, items, captions, rules) {
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const bands = []
  for (const r of rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= crop[1] - 24 &&
        r[1] <= crop[3] + 24 &&
        r[0] >= crop[0] - 24 &&
        r[2] <= crop[2] + 24 &&
        r[2] - r[0] > 12
    )
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.1)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    if (!band.parts.some((p) => Math.abs(p[0] - r[0]) < 0.1 && Math.abs(p[2] - r[2]) < 0.1))
      band.parts.push(r)
  }
  const valid = bands.filter(
    (b) =>
      b.parts.length >= 2 &&
      b.parts.length <= 12 &&
      Math.abs(b.parts[0][0] - crop[0]) < 24 &&
      Math.abs(b.parts.at(-1)[2] - crop[2]) < 24 &&
      b.parts.every((r, n) => !n || Math.abs(r[0] - b.parts[n - 1][2]) < 0.1)
  )
  if (valid.length < 4) return
  const xs = [valid[0].parts[0][0], ...valid[0].parts.map((r) => r[2])]
  if (
    valid.some(
      (b) =>
        b.parts.length !== xs.length - 1 ||
        b.parts.some((r, c) => Math.abs(r[0] - xs[c]) > 0.1 || Math.abs(r[2] - xs[c + 1]) > 0.1)
    )
  )
    return
  const ys = valid.map((b) => b.y),
    frame = [xs[0], ys[0], xs.at(-1), ys.at(-1)]
  const source = tableSourceItems(items, frame),
    groups = []
  if (!source.length) return
  for (let r = 0; r < ys.length - 1; r++)
    for (let c = 0; c < xs.length - 1; c++) {
      const tokens = source.filter(
        (i) =>
          i.rect[0] >= xs[c] - 0.1 &&
          i.rect[2] <= xs[c + 1] + 0.1 &&
          i.rect[1] >= ys[r] - 0.1 &&
          i.rect[3] <= ys[r + 1] + 0.1
      )
      if (!tokens.length) return
      // Section borders must not collapse several records into one cell. Each
      // body band needs one explicit ordinal stub, not a list of row labels.
      if (
        c === 0 &&
        r > 0 &&
        !/^(?:\p{L}+\s+)?\d+[A-Z]?$/u.test(
          tokens
            .map((i) => i.text)
            .join(' ')
            .trim()
        )
      )
        return
      groups.push(tokens)
    }
  if (!hasUniqueRecordTokens(source, groups)) return
  const header = table.structure.objects.some(
    (o) =>
      o.label === 'table column header' &&
      crop[1] + o.rect[3] > ys[0] &&
      crop[1] + o.rect[3] < ys[1] + 2
  )
  return {
    cropRect: frame,
    rows: ys.slice(1).map((y, r) => [xs[0], ys[r], xs.at(-1), y]),
    columns: xs.slice(1).map((x, c) => [xs[c], ys[0], x, ys.at(-1)]),
    headerRows: header ? [0] : [],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A closed native grid determines its cells independently of model columns.
// Missing complete edges connect slots; partial edges and nonrectangular
// components are ambiguous and must not authorize a merge.
export function recoverClosedCellGrid(table, items, captions, rules) {
  const crop = table.cropRect
  // Definition matrices use closed physical faces, including references whose
  // years occupy separate baselines. Require every individual edge and owner;
  // their prose is not an independent numeric record within a merged face.
  const narrative = (() => {
    const horizontal = joinHorizontalTableRules(rules, 1)
    const full = horizontal.filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < 24 &&
        Math.abs(r[2] - crop[2]) < (crop[2] - crop[0]) * 0.18 &&
        r[1] >= crop[1] - 24 &&
        r[1] <= crop[3] + 24
    )
    if (full.length < 5 || full.length > 25) return
    const first = full[0],
      last = full.at(-1)
    if (full.some((r) => Math.abs(r[0] - first[0]) > 1 || Math.abs(r[2] - first[2]) > 1)) return
    const frame = [first[0], first[1], first[2], last[1]]
    const vertical = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] >= frame[0] - 1 &&
        r[0] <= frame[2] + 1 &&
        r[1] >= frame[1] - 1 &&
        r[3] <= frame[3] + 1
    )
    const xs = clusterTableRulePositions(vertical.map((r) => r[0])),
      ys = clusterTableRulePositions(full.map((r) => r[1]))
    if (
      ![4, 7].includes(xs.length) ||
      Math.abs(xs[0] - frame[0]) > 1 ||
      Math.abs(xs.at(-1) - frame[2]) > 1
    )
      return
    const width = xs.length - 1
    for (let r = 0; r < ys.length - 1; r++)
      for (let c = 0; c < width; c++)
        if (
          [xs[c], xs[c + 1]].some(
            (x) => classifyTableRuleEdge(vertical, 0, x, ys[r], ys[r + 1]) !== 1
          ) ||
          [ys[r], ys[r + 1]].some(
            (y) => classifyTableRuleEdge(horizontal, 1, y, xs[c], xs[c + 1]) !== 1
          )
        )
          return
    const candidates = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] >= xs[0] - 0.1 &&
        i.rect[2] <= xs.at(-1) + 0.1 &&
        i.rect[1] < frame[3] &&
        i.rect[3] > frame[1]
    )
    if (!candidates.length) return
    if (
      items.some(
        (i) =>
          i.horizontal &&
          i.text.trim() &&
          i.rect[1] < frame[3] &&
          i.rect[3] > frame[1] &&
          i.rect[0] < frame[2] &&
          i.rect[2] > frame[0] &&
          !candidates.includes(i)
      )
    )
      return
    const headerInk = candidates.filter((i) => (i.rect[1] + i.rect[3]) / 2 < ys[1])
    const headings = readSourceRow(headerInk, xs, { multiline: true })
    const headed =
      headings?.[0] === 'Symbol' &&
      headings[1] === 'Definition' &&
      headings[2] === 'Units' &&
      headings.every(Boolean)
    if (!headed && headings?.[0] === 'Symbol') return
    const attachedScript = (i, own) =>
      own.some(
        (a) =>
          a !== i &&
          a.height > i.height * 1.2 &&
          Math.abs(a.baseline - i.baseline) < a.height * 0.8 &&
          i.rect[0] >= a.rect[0] - a.height * 0.2 &&
          i.rect[0] <= a.rect[2] + a.height * 0.7
      )
    const overhang = candidates.filter((i) => i.rect[1] < frame[1])
    if (
      overhang.some(
        (i) =>
          !(frame[1] - i.rect[1] <= i.height * 0.1 && headerInk.includes(i)) &&
          !(frame[1] - i.rect[1] <= i.height * 0.2 && attachedScript(i, headerInk))
      )
    )
      return
    if (
      items.some(
        (i) =>
          i.horizontal &&
          i.text.trim() &&
          i.rect[0] >= frame[0] &&
          i.rect[2] <= frame[2] &&
          i.rect[1] >= crop[1] &&
          i.rect[3] < frame[1] &&
          !captions.some((c) => i.rect[1] < c.rect[3] && i.rect[3] > c.rect[1])
      )
    )
      return
    const groups = [],
      faces = []
    for (let r = 0; r < ys.length - 1; r++) {
      const row = []
      for (let c = 0; c < width; c++) {
        const own = candidates.filter(
          (i) =>
            i.rect[0] >= xs[c] - 0.1 &&
            i.rect[2] <= xs[c + 1] + 0.1 &&
            (i.rect[1] + i.rect[3]) / 2 >= ys[r] &&
            (i.rect[1] + i.rect[3]) / 2 < ys[r + 1]
        )
        if (
          own.some(
            (i) =>
              (i.rect[1] < ys[r] - i.height * 0.1 || i.rect[3] > ys[r + 1] + i.height * 0.1) &&
              !(
                i.rect[1] >= ys[r] - i.height * 0.2 &&
                i.rect[3] <= ys[r + 1] + i.height * 0.2 &&
                attachedScript(i, own)
              )
          )
        )
          return
        groups.push(own)
        row.push(own)
      }
      faces.push(row)
    }
    if (faces.some((row) => row.every((g) => g.length === 0))) return
    if (
      !hasUniqueRecordTokens(
        candidates,
        groups.filter((g) => g.length)
      )
    )
      return
    const body = faces.slice(headed ? 1 : 0)
    if (
      body.some((row) => {
        const height = Math.max(...row[0].map((i) => i.height)),
          anchors = row[0].filter((i) => i.height >= height * 0.7)
        return (
          anchors.length > 1 &&
          Math.max(...anchors.map((i) => i.baseline)) -
            Math.min(...anchors.map((i) => i.baseline)) >
            height * 0.35
        )
      })
    )
      return
    const complete = body.filter((row) => {
      const values = row.map((g) => g.map((i) => i.text).join(' '))
      const prose = row[1]
      if (
        !values[0] ||
        values[0].length > 60 ||
        !/[\p{L}]/u.test(values[0]) ||
        values[1].length < 35 ||
        new Set(prose.map((i) => Math.round(i.baseline))).size < 2 ||
        (width === 3 && !values[2])
      )
        return false
      return (
        width === 3 ||
        (/\d/.test(values[3]) && /\d/.test(values[5]) && /\([^)]*\b(?:19|20)\d{2}/.test(values[4]))
      )
    })
    if (complete.length < 3 || (!headed && width !== 6)) return
    // Headerless continuation faces remain body rows. Their repeated six-lane
    // technical records prove the layout without inventing a repeated header.
    return {
      cropRect: [
        Math.min(crop[0], frame[0] - 0.5),
        Math.min(crop[1], ...candidates.map((i) => i.rect[1])),
        Math.max(crop[2], frame[2] + 0.5),
        Math.max(frame[3] + 0.5, ...candidates.map((i) => i.rect[3]))
      ],
      rows: ys
        .slice(1)
        .map((y, r) => [
          frame[0],
          r === 0 ? Math.min(frame[1], ...headerInk.map((i) => i.rect[1])) : ys[r],
          frame[2],
          y
        ]),
      columns: xs.slice(1).map((x, c) => [xs[c], frame[1], x, frame[3]]),
      headerRows: headed ? [0] : [],
      spans: [],
      completeSpans: true,
      ownedTokens: new Set(candidates),
      preservePhysicalRows: true,
      repair: 'native-body-records-recovered'
    }
  })()
  if (narrative) return narrative
  const captioned = captions.some((c) => captionKind(c.lines[0]) === 'table')
  const horizontal = joinHorizontalTableRules(rules, 1)
  let borders = horizontal.filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 24 &&
      Math.abs(r[2] - crop[2]) < (crop[2] - crop[0]) * (captioned ? 0.3 : 0.08) &&
      r[1] >= crop[1] - 24 &&
      r[1] <= crop[3] + 24
  )
  if (borders.length < 3) return
  const nearVertical = rules.filter((r) => r[0] === r[2] && r[1] < crop[3] && r[3] > crop[1])
  const framedBorders = borders.filter((r) =>
    [r[0], r[2]].every((x) =>
      nearVertical.some((v) => Math.abs(v[0] - x) < 1 && v[1] <= r[1] + 1 && v[3] >= r[1] - 1)
    )
  )
  if (framedBorders.length >= 3) borders = framedBorders
  const first = borders[0],
    last = borders.at(-1)
  if (Math.abs(last[0] - first[0]) > 1 || Math.abs(last[2] - first[2]) > 1) return
  const frame = [first[0], first[1], first[2], last[1]]
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= frame[0] - 1 &&
      r[0] <= frame[2] + 1 &&
      r[1] >= frame[1] - 1 &&
      r[3] <= frame[3] + 1
  )
  let source = tableSourceItems(items, [frame[0] - 0.1, frame[1], frame[2] + 0.1, frame[3]])
  if (!source.length) return
  let xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  // Font boxes can start slightly above a painted opening border. A complete
  // set of short leaf titles inside the first closed native band proves that
  // small overhang; unrelated prose above an underline still rejects the grid.
  let closedHeaderOverhang = false
  const overhang = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= frame[0] &&
      i.rect[2] <= frame[2] &&
      i.rect[1] < frame[1] - 0.1 &&
      i.rect[3] > frame[1] &&
      i.rect[3] < borders[1][1]
  )
  if (
    captioned &&
    xs.length >= 5 &&
    xs.length <= 10 &&
    borders.length >= 8 &&
    overhang.length === xs.length - 2 &&
    overhang.every(
      (i) => /\p{L}/u.test(i.text) && i.text.length < 30 && frame[1] - i.rect[1] <= i.height * 0.1
    ) &&
    [xs[0], xs.at(-1)].every(
      (x) => classifyTableRuleEdge(vertical, 0, x, frame[1], frame[3]) === 1
    ) &&
    xs
      .slice(2)
      .every(
        (end, n) => overhang.filter((i) => i.rect[0] >= xs[n + 1] && i.rect[2] <= end).length === 1
      )
  ) {
    frame[1] = Math.min(...overhang.map((i) => i.rect[1]))
    source = tableSourceItems(items, [frame[0] - 0.1, frame[1], frame[2] + 0.1, frame[3]])
    closedHeaderOverhang = true
  }
  // Some statistical matrices leave both outer sides open. Complete native
  // top/bottom endpoints still bound the table; paired F, p and effect-size
  // triples independently prove its final two lanes. Inner faces must retain
  // the same exact native edge and unique-token checks as a closed frame.
  let openStatistics = false
  if (
    captioned &&
    xs.length >= 6 &&
    xs.length <= 10 &&
    xs[0] > frame[0] &&
    xs.at(-1) < frame[2] &&
    borders.length >= 5 &&
    borders.every((r) => Math.abs(r[0] - frame[0]) < 1 && Math.abs(r[2] - frame[2]) < 1)
  ) {
    const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
    const statCuts = [...xs.slice(-2), frame[2]]
    const stats = source.filter((i) => i.rect[0] >= statCuts[0] && i.rect[2] <= statCuts[2])
    const groups = groupSourceRowsWithScripts(stats, height, 0.35)
    const values = groups?.map((g) => readSourceRow(g, statCuts)) ?? []
    let triples = 0
    for (let n = 0; n < values.length - 2; n++) {
      if (
        values[n]?.every((s) => /^F=[−–+-]?\d+(?:\.\d+)?[a-z*†‡]*$/i.test(s)) &&
        values[n + 1]?.every((s) => /^p[=<>≤≥]\d+(?:\.\d+)?[*†‡]*$/i.test(s)) &&
        values[n + 2]?.every((s) => /^[ηƞ]p2[=<>≤≥]\d+(?:\.\d+)?$/u.test(s))
      )
        triples++
    }
    if (triples >= 3 && hasUniqueRecordTokens(stats, groups)) {
      openStatistics = true
      xs = [frame[0], ...xs, frame[2]]
    }
  }
  const predicted = table.structure.objects.filter((o) => o.label === 'table column')
  const singleColumn =
    !vertical.length &&
    captioned &&
    predicted.length > 0 &&
    predicted.length <= 2 &&
    (predicted.length === 1 ||
      Math.min(predicted[0].rect[2], predicted[1].rect[2]) -
        Math.max(predicted[0].rect[0], predicted[1].rect[0]) >
        Math.min(
          predicted[0].rect[2] - predicted[0].rect[0],
          predicted[1].rect[2] - predicted[1].rect[0]
        ) *
          0.7) &&
    borders.length >= 5 &&
    source.every((i) => i.rect[0] - frame[0] < i.height * 2)
  let leadingHeader
  if (singleColumn) {
    xs = [frame[0], frame[2]]
    const above = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= frame[0] &&
        i.rect[2] <= frame[2] &&
        i.rect[1] >= crop[1] &&
        i.rect[3] < frame[1] &&
        frame[1] - i.rect[3] < i.height &&
        !captions.some((c) => i.rect[1] < c.rect[3] && i.rect[3] > c.rect[1])
    )
    if (above.length === 1 && /\p{L}/u.test(above[0].text)) {
      leadingHeader = Math.min(crop[1], above[0].rect[1])
      frame[1] = leadingHeader
      source = [...above, ...source]
    }
  }
  // An underlined header is not an opening border. Preserve the existing
  // header recovery when text above this frame still belongs to the crop.
  if (
    !singleColumn &&
    items.some(
      (i) =>
        i.horizontal &&
        i.rect[1] >= crop[1] &&
        i.rect[1] < frame[1] - 0.1 &&
        i.rect[0] >= frame[0] &&
        i.rect[2] <= frame[2] &&
        !captions.some((c) => i.rect[1] < c.rect[3] && i.rect[3] > c.rect[1])
    )
  )
    return
  if (xs.length < 2 || xs.length > 17 || (!singleColumn && xs.length < 3)) return
  if (Math.abs(xs[0] - frame[0]) > 1 || Math.abs(xs.at(-1) - frame[2]) > 1) return
  const localHorizontal = horizontal.filter(
    (r) => r[0] >= frame[0] - 1 && r[2] <= frame[2] + 1 && r[1] >= frame[1] && r[1] <= frame[3]
  )
  const ys = clusterTableRulePositions(localHorizontal.map((r) => r[1]))
  if (leadingHeader !== undefined) ys.unshift(leadingHeader)
  if (ys.length < 3 || ys.length > 81) return
  if (
    !singleColumn &&
    !openStatistics &&
    [xs[0], xs.at(-1)].some((x) => classifyTableRuleEdge(vertical, 0, x, ys[0], ys.at(-1)) !== 1)
  )
    return
  const width = xs.length - 1,
    height = ys.length - 1
  const parents = Array.from({ length: width * height }, (_, n) => n)
  const root = (n) => {
    while (parents[n] !== n) n = parents[n]
    return n
  }
  const connect = (a, b) => {
    parents[root(a)] = root(b)
  }
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      if (c + 1 < width) {
        const edge = classifyTableRuleEdge(vertical, 0, xs[c + 1], ys[r], ys[r + 1])
        if (edge < 0) return
        if (!edge) connect(r * width + c, r * width + c + 1)
      }
      if (r + 1 < height) {
        const edge = classifyTableRuleEdge(localHorizontal, 1, ys[r + 1], xs[c], xs[c + 1])
        if (edge < 0) return
        if (!edge) connect(r * width + c, (r + 1) * width + c)
      }
    }
  const components = new Map()
  for (let n = 0; n < parents.length; n++) {
    const key = root(n)
    if (!components.has(key)) components.set(key, [])
    components.get(key).push(n)
  }
  const spans = [],
    groups = []
  for (const slots of components.values()) {
    const row = Math.min(...slots.map((n) => Math.floor(n / width))),
      endRow = Math.max(...slots.map((n) => Math.floor(n / width))) + 1,
      column = Math.min(...slots.map((n) => n % width)),
      endColumn = Math.max(...slots.map((n) => n % width)) + 1
    if (slots.length !== (endRow - row) * (endColumn - column)) return
    const rect = [xs[column], ys[row], xs[endColumn], ys[endRow]]
    const tokens = source.filter(
      (i) =>
        i.rect[0] >= rect[0] - 0.1 &&
        i.rect[2] <= rect[2] + 0.1 &&
        (i.rect[1] + i.rect[3]) / 2 >= rect[1] &&
        (i.rect[1] + i.rect[3]) / 2 < rect[3]
    )
    // A tall ruled face can contain several independent numeric records.
    // Its border proves a section, not a single merged value cell.
    if (
      column > 0 &&
      tokens
        .filter((i) => /^[-+<>≤≥]?\d/.test(i.text))
        .some((a) =>
          tokens.some(
            (b) =>
              b !== a &&
              /^[-+<>≤≥]?\d/.test(b.text) &&
              Math.abs(a.baseline - b.baseline) > Math.max(a.height, b.height) * 0.7 &&
              !/±\s*$/.test(a.text) &&
              !/±\s*$/.test(b.text)
          )
        )
    )
      return
    if (tokens.length) groups.push(tokens)
    if (slots.length > 1)
      spans.push({ row, column, rowSpan: endRow - row, colSpan: endColumn - column })
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  // A fully closed grid can precede its caption on the next page. Repeated
  // numeric records prove the body; short, intervening native header faces
  // are allowed without discarding their independently ruled parent spans.
  const numericRows = ys
    .slice(1)
    .map(
      (y, r) =>
        source.filter(
          (i) =>
            (i.rect[1] + i.rect[3]) / 2 >= ys[r] &&
            (i.rect[1] + i.rect[3]) / 2 < y &&
            /^\d[\d.]*\s*±/.test(i.text)
        ).length >= 2
    )
  const nativeHeaders = numericRows.flatMap((numeric, r) => (numeric ? [] : [r]))
  const repeatedHeaderGrid =
    width >= 4 &&
    numericRows.filter(Boolean).length >= height * 0.6 &&
    nativeHeaders.length >= 2 &&
    nativeHeaders.every((r) =>
      source
        .filter(
          (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[r] && (i.rect[1] + i.rect[3]) / 2 < ys[r + 1]
        )
        .every((i) => i.text.length < 80)
    ) &&
    spans.some((s) => s.colSpan >= 3 && nativeHeaders.includes(s.row))
  if (!captioned && (width < 4 || (!numericRows.every(Boolean) && !repeatedHeaderGrid))) return
  const headingBottom = Math.max(
    frame[1],
    ...table.structure.objects
      .filter((o) => o.label === 'table column header')
      .map((o) => crop[1] + o.rect[3])
  )
  const headerRows = repeatedHeaderGrid
    ? nativeHeaders
    : ys.slice(1).flatMap((y, r) => (y <= headingBottom + 2 ? [r] : []))
  return {
    cropRect: frame,
    rows: ys.slice(1).map((y, r) => [frame[0], ys[r], frame[2], y]),
    columns: xs.slice(1).map((x, c) => [xs[c], frame[1], x, frame[3]]),
    headerRows,
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    ...(closedHeaderOverhang ? { repair: 'native-body-records-recovered' } : {})
  }
}

// Abutting leaf underlines in repeated arm/arm/P groups preserve exact cuts.
// A Mean subrow owns only its two arm values; it is not wrapped median text.
function recoverUnderlinedComparisons(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  if (
    !captions.some(
      (c) => captionKind(c.lines[0]) === 'table' && c.rect[3] <= top + 10 && top - c.rect[3] < 35
    )
  )
    return
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] > top && r[1] < Math.min(top + 80, bottom))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const matches = bands.filter((b) => {
    b.parts.sort((a, b) => a[0] - b[0])
    return (
      b.parts.length >= 6 &&
      b.parts.length <= 18 &&
      b.parts.length % 3 === 0 &&
      b.parts[0][0] > left &&
      Math.abs(b.parts.at(-1)[2] - right) < 16 &&
      b.parts
        .slice(1)
        .every((r, n) =>
          (n + 1) % 3 ? Math.abs(r[0] - b.parts[n][2]) < 0.1 : r[0] - b.parts[n][2] > 2
        )
    )
  })
  if (matches.length !== 1) return
  const band = matches[0],
    width = band.parts.length,
    count = width / 3
  const cuts = [
    left - 1,
    band.parts[0][0],
    ...band.parts.slice(1).map((r, n) => (r[0] + band.parts[n][2]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left - 1, top, right, bottom])
  const upper = source.filter((i) => i.rect[3] < band.y)
  if (upper.length !== count || !upper.every((i) => /\p{L}/u.test(i.text))) return
  const parents = Array.from({ length: count }, (_, n) =>
    upper.filter((i) => i.rect[0] >= cuts[n * 3 + 1] && i.rect[2] <= cuts[n * 3 + 4])
  )
  if (parents.some((p) => p.length !== 1)) return
  const height = Math.max(...upper.map((i) => i.height))
  const rest = source.filter((i) => i.rect[1] > band.y)
  const groups = groupSourceRowsWithScripts(rest, height, 0.3)
  if (!groups || groups.length < 4 || !hasUniqueRecordTokens(source, [upper, ...groups])) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const header = values[0]
  if (
    header[0] ||
    !/\p{L}/u.test(header[1]) ||
    !/\p{L}/u.test(header[2]) ||
    header[1] === header[2] ||
    !/^(?:p|pvalue)$/i.test(header[3]) ||
    !header.slice(1).every((v, n) => v === header[1 + (n % 3)])
  )
    return
  const numeric = (s) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±–−+*/-]*$/.test(s)
  const summary = (v) =>
    /^Mean$/i.test(v[0]) &&
    v.slice(1).every((s, n) => (n % 3 === 2 ? !s : /^\d+(?:\.\d+)?$/.test(s)))
  const complete = (v) => /\p{L}/u.test(v[0]) && v.slice(1).every(numeric)
  const body = values.slice(1),
    withMeans = body.some(summary)
  if (
    body.filter(complete).length < 3 ||
    body.some((v, n) => (withMeans ? (n % 2 ? !summary(v) : !complete(v)) : !complete(v))) ||
    (withMeans && body.length % 2)
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const bottomInk = Math.max(...source.map((i) => i.rect[3]))
  if (
    rules.some(
      (r) => r[0] === r[2] && r[0] > cuts[1] && r[0] < right && r[1] < bottomInk && r[3] > band.y
    )
  )
    return
  const ys = [band.y, ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), bottom]
  return {
    cropRect: [left - 1, top, right, bottom],
    rows: [
      [left - 1, top, right, band.y],
      ...groups.map((_, n) => [left - 1, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0, 1],
    spans: Array.from({ length: count }, (_, n) => ({
      row: 0,
      column: 1 + n * 3,
      rowSpan: 1,
      colSpan: 3
    })),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

function recoverHeaderSegmentColumns(table, items, captions, rules, abuttingOnly) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.01)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  if (!abuttingOnly) {
    const graded = recoverGradedEventGrid(table, items, bands)
    if (graded) return graded
    const assessment = recoverAssessmentSchedule(table, items, bands)
    if (assessment) return assessment
  }
  const matches = bands.filter(({ y, parts }) => {
    const overlap = parts[0]?.[2] - parts[1]?.[0]
    const edgeTolerance = Math.max(16, (crop[2] - crop[0]) * 0.05)
    return (
      parts.length >= 3 &&
      parts.length <= 30 &&
      y > crop[1] &&
      y < crop[1] + 120 &&
      Math.abs(parts[0][0] - crop[0]) < edgeTolerance &&
      Math.abs(parts.at(-1)[2] - crop[2]) < edgeTolerance &&
      (overlap > 4 || Math.abs(overlap) < 0.1) &&
      (!abuttingOnly || Math.abs(overlap) < 0.1) &&
      overlap < (parts.at(-1)[2] - parts[0][0]) * 0.1 &&
      parts
        .slice(1)
        .every((r, n) => Math.abs(parts[n][2] - r[0] - overlap) < 0.1 && r[2] > parts[n][2])
    )
  })
  if (matches.length !== 1) return
  const divider = matches[0],
    left = divider.parts[0][0],
    right = divider.parts.at(-1)[2]
  const edges = bands.filter((b) =>
    b.parts.some((r) => Math.abs(r[0] - left) < 0.1 && Math.abs(r[2] - right) < 0.1)
  )
  const top = edges.filter((b) => b.y < divider.y && b.y >= crop[1] - 16).at(-1)?.y
  const bottom = edges.find((b) => b.y > divider.y && Math.abs(b.y - crop[3]) < 16)?.y
  if (top === undefined || bottom === undefined) return
  const cuts = [
    left,
    ...divider.parts.slice(1).map((r, n) => (r[0] + divider.parts[n][2]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left - 0.1, top, right + 0.1, bottom])
  const body = source.filter((i) => i.rect[1] >= divider.y)
  if (!body.length) return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (
    body.some(
      (i) => col(i) < 0 || i.rect[0] < cuts[col(i)] - 0.1 || i.rect[2] > cuts[col(i) + 1] + 0.1
    )
  )
    return
  const abutting = Math.abs(divider.parts[0][2] - divider.parts[1][0]) < 0.1
  // A single header band can independently prove abutting cell boundaries.
  // Require complete, aligned numeric records in every data column; stroke
  // endpoints alone are not sufficient to override overlapping model columns.
  const header = source.filter((i) => i.rect[3] <= divider.y)
  const headerText = cuts.slice(1).map((_, c) =>
    header
      .filter((i) => col(i) === c)
      .map((i) => i.text)
      .join('')
  )
  const records = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    abutting &&
    records?.length >= 3 &&
    header.length &&
    hasUniqueRecordTokens(source, [header, ...records]) &&
    header.every((i) => i.rect[0] >= cuts[col(i)] - 0.1 && i.rect[2] <= cuts[col(i) + 1] + 0.1) &&
    headerText.slice(1).every((s) => /\p{L}/u.test(s)) &&
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) <
      height * 0.3 &&
    records.every((g) =>
      cuts.slice(1).every((_, c) => {
        const text = g
          .filter((i) => col(i) === c)
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
        return c === 0 ? /\p{L}/u.test(text) : /^[<>≤≥−+]?\d[\d.,()–−+±%/]*$/.test(text)
      })
    )
  ) {
    const bounds = records.map(union)
    if (bounds.every((r, n) => !n || r[1] > bounds[n - 1][3])) {
      const ys = [divider.y, ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2), bottom]
      return {
        cropRect: [left - 0.1, top, right + 0.1, bottom],
        rows: [
          [left, top, right, divider.y],
          ...records.map((_, n) => [left, ys[n], right, ys[n + 1]])
        ],
        columns: cuts
          .slice(1)
          .map((x, c) => [
            cuts[c] - (c === 0 ? 0.1 : 0),
            top,
            x + (c === cuts.length - 2 ? 0.1 : 0),
            bottom
          ]),
        headerRows: [0],
        spans: [],
        completeSpans: true,
        ownedTokens: new Set(source)
      }
    }
  }
  const subtotal = abutting
    ? recoverSubtotalCohorts({ source, body, cuts, divider: divider.y, bottom, height, col, rules })
    : undefined
  if (abutting && !subtotal) return
  if (cuts.length === 4)
    return recoverSchedule({ source, body, cuts, top, bottom, divider: divider.y, height, col })
  if (cuts.length < 6) return
  // Data columns must contain numeric evidence on multiple distinct baselines.
  // Ordinary narrative tables use a different owner and are not split here.
  const anchors = body.filter((i) => col(i) > 0 && i.height >= height * 0.8)
  const baselines = []
  for (const i of anchors)
    if (!baselines.some((y) => Math.abs(y - i.baseline) < height * 0.3)) baselines.push(i.baseline)
  baselines.sort((a, b) => a - b)
  if (baselines.length < 3 || anchors.filter((i) => /\d/.test(i.text)).length < baselines.length)
    return
  const groups = subtotal?.groups ?? baselines.map(() => [])
  for (const i of subtotal ? [] : body) {
    const distances = baselines.map((y) => Math.abs(y - i.baseline))
    const nearest = distances.indexOf(Math.min(...distances))
    if (distances[nearest] > height * 0.65) {
      const previous = baselines.findLastIndex((y) => y < i.baseline)
      const stubs = groups[previous]?.filter((item) => col(item) === 0) ?? []
      if (
        col(i) !== 0 ||
        !stubs.length ||
        i.baseline - baselines[previous] > height * 1.6 ||
        i.rect[0] < Math.min(...stubs.map((item) => item.rect[0])) + height * 0.4
      )
        return
      groups[previous].push(i)
      continue
    }
    groups[nearest].push(i)
  }
  const shared = subtotal ? [subtotal.stubs] : []
  if (!hasUniqueRecordTokens(body, [...groups, ...shared])) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const parents = bands.filter(
    (b) => b.y > top && b.y < divider.y && b.parts.every((r) => r[2] - r[0] > (right - left) * 0.05)
  )
  if (parents.length !== 1) return
  const parent = parents[0]
  if (!hasUniqueRecordTokens(source, [header, ...groups, ...shared])) return
  const spans = [...(subtotal?.spans ?? [])],
    covered = new Set()
  for (const r of parent.parts) {
    const columns = cuts
      .slice(1)
      .flatMap((x, c) => ((cuts[c] + x) / 2 >= r[0] && (cuts[c] + x) / 2 <= r[2] ? [c] : []))
    if (columns.length < 2 || columns.some((c) => covered.has(c))) return
    for (const c of columns) covered.add(c)
    spans.push({ row: 0, column: columns[0], rowSpan: 1, colSpan: columns.length })
  }
  for (let c = 0; c < cuts.length - 1; c++)
    if (!covered.has(c)) spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  if (
    subtotal &&
    (parent.parts.length !== (cuts.length - 4) / 2 ||
      spans
        .filter((s) => s.row === 0 && s.colSpan > 1)
        .some((s, n) => s.column !== 3 + n * 2 || s.colSpan !== 2))
  )
    return
  if (subtotal) {
    const upper = header.filter((i) => i.rect[3] <= parent.y)
    const owned = parent.parts.map((_, n) =>
      upper.filter((i) => i.rect[0] >= cuts[3 + n * 2] - 0.1 && i.rect[2] <= cuts[5 + n * 2] + 0.1)
    )
    if (
      !hasUniqueRecordTokens(upper, owned) ||
      owned.some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
      header.some((i) => !upper.includes(i) && i.rect[1] < parent.y)
    )
      return
  }
  // A wrapped stub shared by an explicit before/after pair belongs to both
  // records; summary-statistic rows remain independent, including their labels.
  for (let n = 0; n + 1 < groups.length; n++) {
    const time = (g) =>
      g
        .filter((i) => col(i) === 1)
        .map((i) => i.text)
        .join(' ')
        .trim()
    const nextStub = groups[n + 1].filter((i) => col(i) === 0)
    if (
      /^Before$/i.test(time(groups[n])) &&
      /^After$/i.test(time(groups[n + 1])) &&
      groups[n].some((i) => col(i) === 0 && /\p{L}/u.test(i.text)) &&
      (!nextStub.length || nextStub.every((i) => /^[a-z]/.test(i.text)))
    )
      spans.push({ row: n + 2, column: 0, rowSpan: 2, colSpan: 1 })
  }
  const ys = [divider.y, ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2), bottom]
  // The proven upper header can have a font box barely above its painted
  // opening stroke. Preserve that owned box in the image crop, while keeping
  // every internal cell boundary on the original native rules.
  const overhang = items.filter(
    (i) => i.rect[0] >= left && i.rect[2] <= right && i.rect[1] < top && i.rect[3] > top
  )
  const paddedTop = Math.min(top, ...overhang.map((i) => i.rect[1])) - 0.1
  const openingRules = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - left) < 0.1 &&
      Math.abs(r[2] - right) < 0.1 &&
      Math.abs(r[1] - top) < height * 0.1
  )
  const preserveHeaderBox =
    overhang.length > 0 &&
    openingRules.length === 1 &&
    overhang.every(
      (i) =>
        i.horizontal &&
        /\p{L}/u.test(i.text) &&
        top - i.rect[1] <= i.height * 0.05 &&
        i.baseline - top >= i.height * 0.5 &&
        i.rect[3] <= parent.y &&
        parent.parts.filter((r) => i.rect[0] >= r[0] && i.rect[2] <= r[2]).length === 1 &&
        !captions.some(
          (c) =>
            i.rect[0] < c.rect[2] &&
            i.rect[2] > c.rect[0] &&
            i.rect[1] < c.rect[3] &&
            i.rect[3] > c.rect[1]
        )
    ) &&
    !items.some(
      (i) =>
        !overhang.includes(i) &&
        i.rect[0] < right &&
        i.rect[2] > left &&
        i.rect[1] < top &&
        i.rect[3] > paddedTop
    )
  return {
    cropRect: [left, preserveHeaderBox ? paddedTop : top, right, bottom],
    rows: [
      [left, top, right, parent.y],
      [left, parent.y, right, divider.y],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Abutting header strokes alone can be decorative. Repeated category blocks,
// explicit sample subtotals and complete mean/deviation pairs prove their columns.
// Cohort labels belong to the whole block even when printed between record baselines.
function recoverSubtotalCohorts({ source, body, cuts, divider, bottom, height, col, rules }) {
  const width = cuts.length - 1
  if (width < 7 || width % 2 !== 1) return
  const header = source.filter((i) => i.rect[3] <= divider)
  const count = header.filter((i) => col(i) === 2 && /^n$/i.test(i.text))
  if (count.length !== 1 || header.some((i) => col(i) < 2)) return
  const lower = header.filter((i) => Math.abs(i.baseline - count[0].baseline) < height * 0.3)
  if (
    lower.some(
      (i) => col(i) < 0 || i.rect[0] < cuts[col(i)] - 0.1 || i.rect[2] > cuts[col(i) + 1] + 0.1
    )
  )
    return
  // Preserve the same 0.1-unit containment tolerance as the native rule checks.
  const read = (g) =>
    cuts.slice(1).map((_, c) =>
      g
        .filter((i) => col(i) === c)
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
  const cells = read(lower)
  if (cells[2].toLowerCase() !== 'n' || cells.slice(3).some((s, c) => s !== (c % 2 ? 'SD' : 'M')))
    return
  const stubs = body.filter((i) => col(i) === 0)
  const records = body.filter((i) => col(i) > 0)
  const groups = groupSourceRowsWithScripts(records, height, 0.3)
  if (!groups || groups.length < 6 || !hasUniqueRecordTokens(records, groups)) return
  const values = groups.map(read)
  if (
    values.some(
      (v) =>
        !/^\p{L}/u.test(v[1]) ||
        !/^\d+$/.test(v[2]) ||
        Number(v[2]) <= 0 ||
        v.slice(3).some((s) => !/^[-−+]?\d+(?:\.\d+)?[a-z*†‡]*$/.test(s))
    )
  )
    return
  const spans = [],
    blocks = [],
    assigned = []
  const bounds = groups.map(union)
  const ys = [divider, ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2), bottom]
  let start = 0
  for (let end = 0; end < values.length; end++) {
    if (!/^(?:All|Total|Together)$/i.test(values[end][1])) continue
    if (
      end - start < 2 ||
      end - start > 8 ||
      values.slice(start, end).reduce((sum, v) => sum + Number(v[2]), 0) !== Number(values[end][2])
    )
      return
    const labels = stubs.filter((i) => i.rect[1] >= ys[start] && i.rect[3] <= ys[end + 1])
    if (
      labels.length !== 1 ||
      !/^\p{L}[\p{L}\p{N} -]*$/u.test(labels[0].text) ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > ys[start] &&
          r[1] < ys[end + 1] &&
          r[0] <= labels[0].rect[0] &&
          r[2] >= labels[0].rect[2]
      )
    )
      return
    assigned.push(...labels)
    blocks.push(
      values
        .slice(start, end + 1)
        .map((v) => v[1])
        .join('|')
    )
    spans.push({ row: start + 2, column: 0, rowSpan: end - start + 1, colSpan: 1 })
    start = end + 1
  }
  if (
    start !== groups.length ||
    blocks.length < 2 ||
    blocks.some((b) => b !== blocks[0]) ||
    new Set(stubs.map((i) => i.text)).size !== stubs.length ||
    !hasUniqueRecordTokens(stubs, [assigned])
  )
    return
  return { groups, stubs, spans }
}

// Repeated full-width row rules plus continuous internal dividers define a
// rectangular matrix even when detection clips the units or final value column.
function recoverFullyRuledRecords(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects.filter((o) => o.label === 'table column')
  if (
    predicted.length < 2 ||
    predicted.length > 6 ||
    !captions.some((c) => captionKind(c.lines[0]) === 'table')
  )
    return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      Math.abs(r[0] - left) < 20 &&
      Math.abs(r[2] - right) < (right - left) * 0.15 &&
      r[1] >= top - 12 &&
      r[1] <= bottom + 12
  )
  if (
    borders.length < 4 ||
    Math.abs(borders[0][1] - top) > 16 ||
    Math.abs(borders.at(-1)[1] - bottom) > 16 ||
    borders.some((r) => Math.abs(r[0] - borders[0][0]) > 1 || Math.abs(r[2] - borders[0][2]) > 1)
  )
    return
  const frame = [borders[0][0], borders[0][1], borders[0][2], borders.at(-1)[1]]
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] > frame[0] &&
      r[0] < frame[2] &&
      r[1] >= frame[1] - 1 &&
      r[3] <= frame[3] + 1
  )
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (
    xs.length !== predicted.length - 1 ||
    xs.some((x) => classifyTableRuleEdge(vertical, 0, x, frame[1], frame[3]) !== 1)
  )
    return
  const cuts = [frame[0], ...xs, frame[2]],
    source = tableSourceItems(items, frame)
  const groups = borders
    .slice(1)
    .map((r, n) =>
      source.filter(
        (i) => (i.rect[1] + i.rect[3]) / 2 >= borders[n][1] && (i.rect[1] + i.rect[3]) / 2 < r[1]
      )
    )
  const headerRows = [0]
  if (
    !hasUniqueRecordTokens(source, groups) ||
    groups.some((g, n) => {
      const cells = cuts
        .slice(1)
        .map((x, c) => g.filter((i) => i.rect[0] >= cuts[c] - 0.1 && i.rect[2] <= x + 0.1))
      const leaves =
        !cells[0].length &&
        cells
          .slice(1)
          .every((c) => c.length && c.every((i) => /\p{L}/u.test(i.text) && !/\d/.test(i.text)))
      if (n === 1 && leaves) headerRows.push(n)
      return (
        !hasUniqueRecordTokens(
          g,
          cells.filter((c) => c.length)
        ) ||
        (!(n < 2 && leaves) &&
          !cells[0].some((i) => /\p{L}/u.test(i.text) || /^\d+$/u.test(i.text))) ||
        (n === 0 && cells.slice(1).some((c) => !c.some((i) => /\p{L}/u.test(i.text))))
      )
    })
  )
    return
  if (
    groups
      .slice(headerRows.length)
      .filter((g) => g.some((i) => i.rect[0] >= cuts[1] && /\d/.test(i.text))).length < 3
  )
    return
  return {
    cropRect: frame,
    rows: borders.slice(1).map((r, n) => [frame[0], borders[n][1], frame[2], r[1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], frame[1], x, frame[3]]),
    headerRows,
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A schedule has sparse period labels, short action names and aligned prose.
// Sentence endings and lower-case label continuations distinguish actions
// from wrapping; ambiguous boundaries leave the model result for review.
function recoverSchedule({ source, body, cuts, top, bottom, divider, height, col }) {
  const [left, , , right] = cuts
  const header = source.filter((i) => i.rect[3] <= divider)
  if (header.length !== 3 || !header.every((i, n) => col(i) === n && /^\p{L}/u.test(i.text))) return
  const labels = body.filter((i) => col(i) === 1)
  const starts = labels.filter((i) => /^\p{Lu}/u.test(i.text))
  if (starts.length < 6 || starts.some((i) => Math.abs(i.rect[0] - starts[0].rect[0]) > 0.1)) return
  const ys = [divider, ...starts.slice(1).map((i) => i.rect[1] - 0.1), bottom]
  const groups = starts.map((_, n) =>
    body.filter(
      (i) =>
        col(i) > 0 &&
        (i.rect[1] + i.rect[3]) / 2 >= ys[n] &&
        (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  for (const [n, group] of groups.entries()) {
    const label = group.filter((i) => col(i) === 1)
    const prose = group.filter((i) => col(i) === 2)
    if (
      !prose.length ||
      !label.length ||
      Math.abs(prose[0].baseline - starts[n].baseline) > height * 0.2 ||
      !/[.!?]$/.test(prose.at(-1).text.trim()) ||
      label
        .slice(1)
        .some(
          (i, j) =>
            !/^\p{Ll}/u.test(i.text) ||
            i.baseline - label[j].baseline > height * 1.6 ||
            Math.abs(i.rect[0] - label[0].rect[0]) > 0.1
        )
    )
      return
  }
  const periods = body.filter((i) => col(i) === 0)
  if (periods.length < 4 || periods.length % 2) return
  const spans = []
  for (let n = 0; n < periods.length; n += 2) {
    const [label, value] = periods.slice(n, n + 2)
    const row = starts.findIndex((i) => Math.abs(i.baseline - label.baseline) < height * 0.2)
    if (
      !/^(?:Week|Day|Cycle|Phase)$/i.test(label.text) ||
      label.text !== periods[0].text ||
      !/^\d+$/.test(value.text) ||
      row < 0 ||
      (n === 0 && row !== 0) ||
      value.baseline - label.baseline > height * 1.6 ||
      value.baseline <= label.baseline
    )
      return
    spans.push({ row: row + 1, column: 0, rowSpan: 1, colSpan: 1 })
  }
  for (const [n, span] of spans.entries()) {
    span.rowSpan = (spans[n + 1]?.row ?? starts.length + 1) - span.row
    if (span.rowSpan < 2 || periods[n * 2 + 1].rect[3] > ys[span.row + span.rowSpan - 1]) return
  }
  if (!hasUniqueRecordTokens(source, [header, periods, ...groups])) return
  return {
    cropRect: [left, top, right, bottom],
    rows: [[left, top, right, divider], ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Column-ruled statistical tables may have no outer box. Repeated native
// separators and aligned source records establish the grid; an absent separator
// joins only one contiguous label, never two independent values or a partial edge.
export function recoverVerticalRuleGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 10) return
  const local = rules.filter(
    (r) => r[0] >= crop[0] - 1 && r[2] <= crop[2] + 1 && r[1] >= crop[1] && r[3] <= crop[3]
  )
  const vertical = local.filter((r) => r[0] === r[2])
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (xs.length !== columns.length - 1) return
  const cuts = [crop[0], ...xs, crop[2]]
  if (
    columns.some((c, n) => {
      const x = crop[0] + (c.rect[0] + c.rect[2]) / 2
      return x <= cuts[n] || x >= cuts[n + 1]
    })
  )
    return
  const source = tableSourceItems(items, crop)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 5) return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const edges = bounds.map((b) => xs.map((x) => classifyTableRuleEdge(vertical, 0, x, b[1], b[3])))
  if (
    edges.some((row) => row.includes(-1) || row[0] !== 1) ||
    xs.some((_, c) => edges.filter((row) => row[c] === 1).length < groups.length * 0.6)
  )
    return
  const spans = [],
    contents = []
  for (const [row, group] of groups.entries()) {
    const rowCells = []
    for (let column = 0; column < columns.length;) {
      let end = column + 1
      while (end < columns.length && edges[row][end - 1] === 0) end++
      const tokens = group
        .filter(
          (i) =>
            (i.rect[0] + i.rect[2]) / 2 >= cuts[column] && (i.rect[0] + i.rect[2]) / 2 < cuts[end]
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (tokens.some((i) => i.rect[0] < cuts[column] || i.rect[2] > cuts[end])) return
      const text = tokens
        .map((i) => i.text)
        .join(' ')
        .trim()
      if (end > column + 1) {
        if (
          !/\p{L}/u.test(text) ||
          /\d/.test(text) ||
          tokens.some((i, n) => n && i.rect[0] - tokens[n - 1].rect[2] > height * 1.5)
        )
          return
        spans.push({ row, column, rowSpan: 1, colSpan: end - column })
      }
      rowCells.push({ column, text })
      column = end
    }
    contents.push(rowCells)
  }
  if (contents[0].some((c) => !/\p{L}/u.test(c.text))) return
  const headerBottom = Math.max(
    crop[1],
    ...table.structure.objects
      .filter((o) => o.label === 'table column header')
      .map((o) => crop[1] + o.rect[3])
  )
  const headerRows = [0]
  if (bounds[1][3] <= headerBottom + 1 && contents[1].slice(1).every((c) => /\p{L}/u.test(c.text)))
    headerRows.push(1)
  const body = contents.slice(headerRows.length)
  if (
    body.some((row) => !row[0].text) ||
    body.filter((row) => row.slice(1).filter((c) => /\d/.test(c.text)).length >= 2).length < 3
  )
    return
  const ys = [crop[1], ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2), crop[3]]
  return {
    rows: groups.map((_, n) => [crop[0], ys[n], crop[2], ys[n + 1]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, crop[3]]),
    spans,
    completeSpans: true,
    headerRows,
    ownedTokens: new Set(source)
  }
}

// Headerless manuscript tables still have one ruled band per record. Keep
// wrapped stubs inside their native band instead of promoting line one to a
// header. Require a numeric value in every data column of every band.
export function recoverHeaderlessRuledRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 2 || predicted.length > 6) return
  const joined = []
  for (const r of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const last = joined.at(-1)
    if (last && Math.abs(last[1] - r[1]) < 0.01 && r[0] - last[2] < 1)
      last[2] = Math.max(last[2], r[2])
    else joined.push([...r])
  }
  const borders = joined
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < (crop[2] - crop[0]) * 0.25 &&
        r[1] >= crop[1] - 12 &&
        r[1] <= crop[3] + 12
    )
    .sort((a, b) => a[1] - b[1])
  // Percentage distributions may print a P-value on its own line after each
  // category. That line is a record, not the next category's value.
  if (predicted.length === 2 && borders.length === 3) {
    const [upper, divider, lower] = borders
    const left = Math.min(crop[0], upper[0]),
      right = Math.max(crop[2], upper[2])
    const cut = crop[0] + (predicted[0].rect[2] + predicted[1].rect[0]) / 2
    const source = tableSourceItems(items, [left, upper[1], right, lower[1]])
    const header = source.filter((i) => i.rect[3] < divider[1]),
      body = source.filter((i) => i.rect[1] > divider[1])
    const height = body[0]?.height,
      groups = groupSourceRowsWithScripts(body, height, 0.3)
    if (groups && header.length && hasUniqueRecordTokens(source, [header, ...groups])) {
      const values = groups.map((g) =>
        g
          .filter((i) => i.rect[0] >= cut)
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
      const labels = groups.map((g) => g.filter((i) => i.rect[2] < cut))
      if (
        values.filter((v) => /^p[=<]0?\.\d+$/i.test(v)).length >= 3 &&
        values.filter((v) => /^\d+(?:\.\d+)?%$/.test(v)).length >= 8 &&
        values.every((v, n) =>
          v
            ? /^(?:p[=<]0?\.\d+|\d+(?:\.\d+)?%)$/i.test(v)
            : labels[n].length && labels[n].some((i) => /\p{L}/u.test(i.text))
        ) &&
        source.every((i) => i.rect[2] < cut || i.rect[0] >= cut)
      ) {
        const bounds = groups.map(union)
        if (bounds.every((r, n) => !n || r[1] > bounds[n - 1][3]))
          return {
            cropRect: [left, upper[1], right, lower[1]],
            rows: [
              [left, upper[1], right, divider[1]],
              ...bounds.map((r) => [left, r[1], right, r[3]])
            ],
            columns: [
              [left, upper[1], cut, lower[1]],
              [cut, upper[1], right, lower[1]]
            ],
            spans: [],
            headerRows: [0],
            completeSpans: true,
            ownedTokens: new Set(source)
          }
      }
    }
  }
  // Unheaded demographic tables begin with an outdented category, followed
  // by indented measured records. Keep that first category as body content.
  if (predicted.length === 2 && borders.length === 2) {
    const [upper, lower] = borders
    const left = Math.min(crop[0], upper[0]),
      right = Math.max(crop[2], upper[2])
    const cut = crop[0] + (predicted[0].rect[2] + predicted[1].rect[0]) / 2
    const source = tableSourceItems(items, [left, upper[1], right, lower[1]])
    if (!source.length) return
    const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
    const groups = groupSourceRowsWithScripts(source, height, 0.3)
    if (!groups || groups.length < 8) return
    const labels = groups.map((g) => g.filter((i) => i.rect[2] < cut)),
      values = groups.map((g) => g.filter((i) => i.rect[0] >= cut))
    if (
      labels.some((g) => !g.length) ||
      !hasUniqueRecordTokens(source, [...labels, ...values.filter((g) => g.length)])
    )
      return
    const indent = Math.min(...labels.flat().map((i) => i.rect[0]))
    const section = values.map((v, n) => !v.length && Math.abs(labels[n][0].rect[0] - indent) < 0.5)
    if (
      !section[0] ||
      section.filter(Boolean).length < 3 ||
      values.some(
        (g, n) =>
          !section[n] &&
          (!g.length ||
            !/^[−+–-]?\d[\d.,()%–−/ -]*(?:years?|months?|cm|cc)?(?:\([\d. –−-]+(?:years?|months?|cm|cc)(?:-[\d ]+(?:years?|months?|cm|cc))?\))?$/.test(
              g
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '')
            ))
      )
    )
      return
    const bounds = groups.map(union)
    if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
    return {
      cropRect: [left, upper[1], right, lower[1]],
      rows: bounds.map((r) => [left, r[1], right, r[3]]),
      columns: [
        [left, upper[1], cut, lower[1]],
        [cut, upper[1], right, lower[1]]
      ],
      spans: section.flatMap((s, n) => (s ? [{ row: n, column: 0, rowSpan: 1, colSpan: 2 }] : [])),
      headerRows: [],
      completeSpans: true,
      ownedTokens: new Set(source),
      repair: 'headerless-ruled-records-recovered'
    }
  }
  if (borders.length < 8) return
  const left = Math.min(crop[0], borders[0][0]),
    right = Math.max(crop[2], borders[0][2]),
    top = borders[0][1],
    bottom = borders.at(-1)[1]
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  // Alternating row fills also produce full-width edges. They are not the
  // table's outer frame when native header or record text lies beyond them.
  // Keep the original model for those tables instead of silently dropping text.
  if (tableSourceItems(items, crop).some((item) => item.rect[3] < top || item.rect[1] > bottom))
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      (i.rect[1] + i.rect[3]) / 2 > top &&
      (i.rect[1] + i.rect[3]) / 2 < bottom
  )
  const groups = borders
    .slice(1)
    .map((r, n) =>
      source.filter(
        (i) => (i.rect[1] + i.rect[3]) / 2 >= borders[n][1] && (i.rect[1] + i.rect[3]) / 2 < r[1]
      )
    )
  if (!hasUniqueRecordTokens(source, groups)) return
  for (const g of groups) {
    const cells = cuts
      .slice(1)
      .map((x, c) => g.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
    if (
      !hasUniqueRecordTokens(
        g,
        cells.filter((c) => c.length)
      ) ||
      !cells[0].some((i) => /[\p{L}\d]/u.test(i.text)) ||
      (g === groups[0] && cells.some((c) => !c.length)) ||
      cells
        .slice(1)
        .some(
          (c) =>
            c.length > 1 ||
            (c.length === 1 && !/^[<>]?\d+(?:\.\d+)?(?:\s*\([\d.%]+\))?$/.test(c[0].text))
        )
    )
      return
  }
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const frame = [left, Math.min(top, bounds[0][1]), right, Math.max(bottom, bounds.at(-1)[3])]
  return {
    cropRect: frame,
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'headerless-ruled-records-recovered'
  }
}

// Assessment schedules use repeated segmented rules for complete row and column
// boundaries. Checkmarks establish the body; native time labels establish tiers.
function recoverAssessmentSchedule(table, items, bands) {
  const [left, top, right, bottom] = table.cropRect
  const full = bands.filter(
    (b) =>
      b.y >= top &&
      b.y <= bottom + 12 &&
      b.parts.length >= 5 &&
      b.parts.length <= 12 &&
      Math.abs(b.parts[0][0] - left) < 16 &&
      Math.abs(b.parts.at(-1)[2] - right) < 16 &&
      b.parts.every((r, n) => !n || Math.abs(r[0] - b.parts[n - 1][2]) < 0.1)
  )
  if (full.length < 8 || Math.abs(full.at(-1).y - bottom) > 16) return
  const cuts = [left, ...full[0].parts.slice(1).map((r) => r[0]), right]
  if (
    full.some(
      (b) =>
        b.parts.length !== cuts.length - 1 ||
        b.parts.slice(1).some((r, n) => Math.abs(r[0] - cuts[n + 1]) > 0.1)
    )
  )
    return
  const ys = full.map((b) => b.y),
    source = tableSourceItems(items, [left, ys[0], right, ys.at(-1)])
  const groups = ys.slice(1).map((y, n) => source.filter((i) => i.rect[1] > ys[n] && i.rect[3] < y))
  if (!hasUniqueRecordTokens(source, groups)) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (source.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    return
  const compact = (g) =>
    g
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if (
    !groups[0].some((i) => i.text === 'Study period') ||
    !groups[2].some((i) => i.text === 'TIME POINT') ||
    groups.slice(3).filter((g) => g.some((i) => col(i) > 0 && i.text === '✓')).length < 5 ||
    groups.slice(3).some((g) => g.some((i) => col(i) > 0 && i.text !== '✓'))
  )
    return
  const spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: cuts.length - 2 }]
  const parents = [...new Set(groups[1].map(col))].sort((a, b) => a - b)
  if (parents.length < 3 || parents[0] !== 1 || groups[1].some((i) => !/[A-Za-z]/.test(i.text)))
    return
  for (const [n, c] of parents.entries()) {
    const end = parents[n + 1] ?? cuts.length - 1
    if (end - c > 1) spans.push({ row: 1, column: c, rowSpan: 1, colSpan: end - c })
  }
  for (let row = 3; row < groups.length; row++)
    if (
      groups[row].every((i) => col(i) === 0) &&
      /^(?:[A-Z-]+|Primaryoutcome|Secondaryoutcomes|Processevaluation)$/.test(compact(groups[row]))
    )
      spans.push({ row, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
  return {
    cropRect: [left, ys[0], right, ys.at(-1)],
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], ys[0], x, ys.at(-1)]),
    spans,
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Graded event tables put a full-width topic above treatment parents and
// repeated two-line Grade 1/2 leaves. Each native grade anchors one data column.
function recoverGradedEventGrid(table, items, bands) {
  const crop = table.cropRect,
    source = tableSourceItems(items, [crop[0], crop[1], crop[2] + 8, crop[3]])
  const grades = source.filter((i) => i.text === 'Grade').sort((a, b) => a.rect[0] - b.rect[0])
  if (
    grades.length < 4 ||
    grades.length > 10 ||
    grades.length % 2 ||
    grades.some((i) => Math.abs(i.baseline - grades[0].baseline) > 0.5)
  )
    return
  const height = grades[0].height
  const digits = grades.map((g) =>
    source.filter(
      (i) =>
        i.rect[1] > g.rect[3] &&
        i.rect[1] - g.rect[3] < height &&
        Math.abs(i.rect[0] - g.rect[0]) < 0.5
    )
  )
  if (digits.some((g, n) => g.length !== 1 || g[0].text !== String((n % 2) + 1))) return
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== grades.length + 1) return
  const cuts = [
    crop[0],
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    crop[2] + 8
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (grades.some((g, n) => col(g) !== n + 1)) return
  const boundaries = bands.filter(
    (b) =>
      b.y > crop[1] &&
      b.y < grades[0].rect[1] &&
      b.parts[0][0] < crop[0] + 16 &&
      b.parts.at(-1)[2] > crop[2] - 16
  )
  if (boundaries.length !== 3) return
  const [upper, topic, parent] = boundaries
  const footer = bands
    .filter(
      (b) =>
        b.y > grades[0].baseline &&
        Math.abs(b.y - crop[3]) < 16 &&
        b.parts[0][0] < crop[0] + 16 &&
        b.parts.at(-1)[2] > crop[2] - 16
    )
    .at(-1)
  if (!footer) return
  const leafBottom = Math.max(...digits.flat().map((i) => i.rect[3]))
  const first = source
    .filter((i) => i.rect[1] > leafBottom)
    .sort((a, b) => a.rect[1] - b.rect[1])[0]
  if (!first || first.rect[1] - leafBottom > height) return
  const divider = (leafBottom + first.rect[1]) / 2
  const body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer.y)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 5) return
  for (let n = 1; n < groups.length; n++) {
    const g = groups[n],
      prior = groups[n - 1]
    if (
      g.length === 1 &&
      g[0].rect[2] < cuts[1] &&
      /^\p{L}+$/u.test(g[0].text.trim()) &&
      prior.filter((i) => col(i) > 0).length >= grades.length &&
      g[0].baseline - Math.max(...prior.map((i) => i.baseline)) < height * 1.5 &&
      g[0].rect[0] >= prior[0].rect[0] - 0.5 &&
      g[0].rect[0] - prior[0].rect[0] < height * 1.1
    ) {
      prior.push(...g)
      groups.splice(n--, 1)
    }
  }
  const sections = []
  for (const [n, g] of groups.entries()) {
    const values = cuts.slice(1).map((_, c) =>
      g
        .filter((i) => col(i) === c)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
    if (g.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])) {
      if (
        g.filter((i) => i.height > height * 0.8).length !== 1 ||
        !/^\p{L}/u.test(g[0].text) ||
        g[0].rect[0] > cuts[1]
      )
        return
      sections.push(n)
    } else if (!values[0] || values.slice(1).some((v) => !/^(?:\d+|[–—-])$/.test(v))) return
  }
  const headers = [upper.y, topic.y, parent.y, divider],
    spans = [{ row: 0, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }]
  const parents = source.filter((i) => i.rect[1] > topic.y && i.rect[3] < parent.y)
  for (let c = 1; c < cuts.length - 1; c += 2) {
    const g = parents.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 2])
    if (
      !g.length ||
      !/[A-Za-z].*\(N=\d+\)/.test(
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      )
    )
      return
    spans.push({ row: 1, column: c, rowSpan: 1, colSpan: 2 })
  }
  const head = source.filter((i) => i.rect[1] > upper.y && i.rect[3] < divider)
  const owned = source.filter((i) => i.rect[1] > upper.y && i.rect[3] < footer.y)
  if (!hasUniqueRecordTokens(owned, [head, ...groups])) return
  return {
    cropRect: [cuts[0], upper.y, cuts.at(-1), footer.y],
    rows: [
      ...headers.slice(1).map((y, n) => [cuts[0], headers[n], cuts.at(-1), y]),
      ...groups.map((g) => {
        const r = union(g)
        return [cuts[0], r[1], cuts.at(-1), r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], upper.y, x, footer.y]),
    spans: [
      ...spans,
      ...sections.map((n) => ({ row: n + 3, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }))
    ],
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(owned)
  }
}
