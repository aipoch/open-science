/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts
} from './literature-pdf-source-records.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { clusterTableRulePositions, classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Some publishers draw the header divider as overlapping cell-width strokes.
// Consistent overlap identifies real column gutters independently of model rows.
export function recoverRuledColumnGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.01)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const graded = recoverGradedEventGrid(table, items, bands)
  if (graded) return graded
  const assessment = recoverAssessmentSchedule(table, items, bands)
  if (assessment) return assessment
  const matches = bands.filter(({ y, parts }) => {
    const overlap = parts[0]?.[2] - parts[1]?.[0]
    const edgeTolerance = Math.max(16, (crop[2] - crop[0]) * 0.05)
    return (
      parts.length >= 3 &&
      parts.length <= 12 &&
      y > crop[1] &&
      y < crop[1] + 120 &&
      Math.abs(parts[0][0] - crop[0]) < edgeTolerance &&
      Math.abs(parts.at(-1)[2] - crop[2]) < edgeTolerance &&
      overlap > 4 &&
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
  const groups = baselines.map(() => [])
  for (const i of body) {
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
  if (!hasUniqueRecordTokens(body, groups)) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const parents = bands.filter(
    (b) => b.y > top && b.y < divider.y && b.parts.every((r) => r[2] - r[0] > (right - left) * 0.05)
  )
  if (parents.length !== 1) return
  const parent = parents[0]
  const header = source.filter((i) => i.rect[3] <= divider.y)
  if (!hasUniqueRecordTokens(source, [header, ...groups])) return
  const spans = [],
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
  return {
    cropRect: [left, top, right, bottom],
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
