/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  classifyTableRuleEdge,
  joinHorizontalTableRules,
  clusterTableRulePositions
} from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'

// Two ruled header bands may contain sample counts or a shared P-value
// heading. Source clusters keep a left stub out of an overlapping model span.
function recoverRuledSummaryHeaders(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 6) return
  const borders = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 8 &&
      r[1] <= crop[3] + 8
  )
  if (borders.length < 4 || borders[2][1] - borders[0][1] > 70) return
  const frame = [borders[0][0] - 0.1, borders[0][1], borders[0][2] + 0.1, borders.at(-1)[1]],
    source = tableSourceItems(items, frame),
    upper = source.filter((i) => i.rect[3] < borders[1][1]),
    lower = source.filter((i) => i.rect[1] > borders[1][1] && i.rect[3] < borders[2][1])
  if (!upper.length || !lower.length) return
  const height = Math.max(...upper.map((i) => i.height)),
    clusters = []
  for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
    const g = clusters.at(-1)
    if (g && i.rect[0] - union(g)[2] < height * 0.8) g.push(i)
    else clusters.push([i])
  }
  const text = (g) =>
    g
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const counts = lower.filter((i) => /^n\s*=\s*\d+$/i.test(i.text))
  const parent = clusters.find((g) => /^PValueforDifference$/i.test(text(g)))
  if (counts.length < 2 && !parent) return
  const cuts = [
    frame[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2]
  ]
  const spans = []
  if (parent) {
    const index = clusters.indexOf(parent),
      prior = clusters[index - 1]
    if (!prior || index !== clusters.length - 1 || columns.length !== 6) return
    cuts[4] = (union(prior)[2] + union(parent)[0]) / 2
    if (
      !lower.every((i) => i.rect[0] >= cuts[4]) ||
      !readSourceRow(lower, cuts, { multiline: true })
    )
      return
    spans.push({ row: 0, column: 4, rowSpan: 1, colSpan: 2 })
  } else {
    if (columns.length !== 5 || clusters.length !== 4) return
    cuts[1] = Math.min(cuts[1], union(clusters[1])[0] - 0.1)
  }
  const body = source.filter((i) => i.rect[1] > borders[2][1]),
    physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (
    !physical ||
    physical.length < 10 ||
    !hasUniqueRecordTokens(source, [upper, lower, ...physical])
  )
    return
  const groups = [],
    measured = []
  for (const g of physical) {
    const numeric = g.some((i) => i.rect[0] >= cuts[1] && /\d/.test(i.text))
    if (numeric) {
      const cells =
        readSourceRow(g, cuts) ??
        cuts.slice(1).map((x, c) =>
          g
            .filter(
              (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < x
            )
            .map((i) => i.text)
            .join('')
        )
      if (!cells || !cells[0] || !cells.slice(1).some((v) => /\d/.test(v))) return
      measured.push(g)
    } else if (g.some((i) => i.rect[0] < cuts[1]) && g.some((i) => i.rect[0] >= cuts[1])) return
    groups.push(g)
  }
  if (measured.length < 8) return
  // A caption can independently witness a wrapped label whose values appear
  // on its second line; do not merge an unrelated section heading.
  const captionText = captions
    .flatMap((c) => c.lines)
    .join(' ')
    .toLowerCase()
  for (let n = 1; n < groups.length; n++) {
    const a = groups[n - 1],
      b = groups[n]
    if (measured.includes(a) || !measured.includes(b) || !a.every((i) => i.rect[0] < cuts[1]))
      continue
    const tail = b.filter((i) => i.rect[0] < cuts[1]),
      words = a
        .map((i) => i.text)
        .join(' ')
        .match(/[A-Za-z]+/g),
      first = text(tail).match(/^[A-Za-z]+/)
    if (
      !words ||
      !first ||
      !/,[a-z]+$/i.test(text(tail)) ||
      !captionText.includes(words.at(-1).toLowerCase() + ' ' + first[0].toLowerCase()) ||
      rules.some((r) => r[1] === r[3] && r[1] > union(a)[3] && r[1] < union(b)[1])
    )
      continue
    groups.splice(n - 1, 2, [...a, ...b])
    n--
  }
  const rows = [
    [frame[0], frame[1], frame[2], borders[1][1]],
    [frame[0], borders[1][1], frame[2], borders[2][1]]
  ]
  for (const g of groups) {
    const r = union(g),
      row = rows.length
    if (!g.some((i) => i.rect[0] >= cuts[1] && /\d/.test(i.text)))
      spans.push({ row, column: 0, rowSpan: 1, colSpan: columns.length })
    rows.push([frame[0], r[1], frame[2], r[3]])
  }
  return {
    cropRect: frame,
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated sample-qualified cohort headings anchor complete source values.
// Read physical records independently of overlapping model rows and columns;
// centred statistic labels are shared headings, not an extra numeric column.
export function recoverCohortSummaryRows(table, items, captions, rules) {
  const headers = recoverRuledSummaryHeaders(table, items, captions, rules)
  if (headers) return headers
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const borders = joinHorizontalTableRules(rules, 1)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < 36 &&
        Math.abs(r[2] - crop[2]) < 20 &&
        r[1] >= crop[1] - 12 &&
        r[1] <= crop[3] + 12
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 2 || borders.length > 3 || borders[1][1] - borders[0][1] > 45) return
  const frame = [borders[0][0] - 1, borders[0][1], borders[0][2] + 1, borders[2]?.[1] ?? crop[3]],
    source = tableSourceItems(items, frame)
  const header = source.filter((i) => i.rect[3] < borders[1][1]),
    height = Math.max(...header.map((i) => i.height)),
    clusters = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - union(last)[2] < height) last.push(i)
    else clusters.push([i])
  }
  const text = (g) =>
    g
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  if (
    clusters.length !== 4 ||
    !clusters.slice(0, 3).every((g) => /^\p{L}[\p{L}-]*\(N=\d+\)$/u.test(text(g))) ||
    !/^p$/i.test(text(clusters[3]))
  )
    return
  const cuts = [
    frame[0],
    union(clusters[0])[0] - height * 2,
    ...clusters.slice(1).map((g, n) => (union(clusters[n])[2] + union(g)[0]) / 2),
    frame[2]
  ]
  const body = source.filter((i) => i.rect[1] > borders[1][1]),
    physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (!physical || physical.length < 15 || !hasUniqueRecordTokens(source, [header, ...physical]))
    return
  const groups = [],
    spans = []
  let measured = 0,
    sections = 0
  const numeric = (v) => /^(?:N=\d+|[−+]?\d[\d.,()%[\]–−-]*)$/.test(v)
  for (const g of physical) {
    const v = readSourceRow(g, cuts),
      row = groups.length + 1
    if (
      g.every((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[4]) &&
      /^Median\[IQR\],\(minimum,maximum\)N$/i.test(text(g))
    ) {
      spans.push({ row, column: 1, rowSpan: 1, colSpan: 3 })
      groups.push(g)
      continue
    }
    if (!v) return
    if (
      !v[0] &&
      !v[4] &&
      v.slice(1, 4).filter(Boolean).length === 1 &&
      /^(?:Mean\(SD\)|N\(%\)|Median\[IQR\],\(minimum,maximum\)|N)$/i.test(v.slice(1, 4).join(''))
    ) {
      spans.push({ row, column: 1, rowSpan: 1, colSpan: 3 })
      groups.push(g)
      continue
    }
    if (
      !/\p{L}/u.test(v[0]) ||
      v.slice(1, 4).some((s) => s && !numeric(s)) ||
      (v[4] && !/^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[4]))
    )
      return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row, column: 0, rowSpan: 1, colSpan: 5 })
      sections++
    } else if (v.slice(1, 4).every(numeric)) measured++
    groups.push(g)
  }
  if (measured < 8 || (!sections && !borders[2])) return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], borders[1][1]],
      ...groups.map((g) => {
        const r = union(g)
        return [frame[0], r[1], frame[2], r[3]]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A small two-column numeric table can wrap one heading across several
// lines. Complete numeric pairs below it delimit the entire header band.
export function recoverCompactNumericHeader(table, items) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 2) return
  const source = tableSourceItems(items, crop)
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height)),
    groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 5 || groups.length > 12) return
  const cut = crop[0] + (columns[0].rect[2] + columns[1].rect[0]) / 2,
    cuts = [crop[0], cut, crop[2]]
  const cells = groups.map((g) => readSourceRow(g, cuts))
  const numeric = (v) => /^\d+(?:\.\d+)?%?$/.test(v)
  const first = cells.findIndex((v) => v && v.every(numeric))
  if (
    first < 2 ||
    first > 4 ||
    cells.length - first < 3 ||
    cells.slice(first).some((v) => !v || !v.every(numeric))
  )
    return
  const header = groups.slice(0, first).flat(),
    head = readSourceRow(header, cuts, { multiline: true })
  if (
    !head ||
    head.some((s) => !/^\p{L}[\p{L}–-]{1,70}$/u.test(s)) ||
    header.some((i) => i.height < height * 0.9) ||
    !hasUniqueRecordTokens(source, [header, ...groups.slice(first)])
  )
    return
  return {
    rows: [header, ...groups.slice(first)].map((g) => {
      const r = union(g)
      return [crop[0], r[1], crop[2], r[3]]
    }),
    columns: [
      [crop[0], crop[1], cut, crop[3]],
      [cut, crop[1], crop[2], crop[3]]
    ],
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A segmented header border preserves native column starts even when the
// detector invents an overlapping column. Repeated underlined child headings
// and paired source records must independently confirm every native column.
export function recoverRepeatedHeaderGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!(height > 0)) return
  const horizontal = rules.filter((r) => r[1] === r[3] && r[1] > top && r[1] < bottom)
  const bands = []
  for (const r of horizontal) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.05)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  for (const band of bands) band.sort((a, b) => a[0] - b[0])
  const borders = bands.filter(
    (b) =>
      b.length >= 7 &&
      b.length <= 25 &&
      Math.abs(b[0][0] - left) < 15 &&
      Math.abs(b.at(-1)[2] - right) < 15 &&
      b.slice(1).every((r, n) => Math.abs(r[0] - b[n][2]) < 0.05)
  )
  const pairedBorders = bands
    .filter(
      (b) =>
        b.length === 6 &&
        Math.abs(b[0][0] - left) < 15 &&
        Math.abs(b.at(-1)[2] - right) < 15 &&
        b.slice(1).every((r, n) => Math.abs(r[0] - b[n][2]) < 0.05)
    )
    .sort((a, b) => a[0][1] - b[0][1])
  if (pairedBorders.length >= 2) {
    const [upperRule, lowerRule] = pairedBorders,
      y0 = upperRule[0][1],
      y1 = lowerRule[0][1]
    const cuts = [left, ...lowerRule.slice(1).map((r) => r[0] - 0.1), right]
    const childRules = bands.find((b) => b.length === 2 && b[0][1] > y0 && b[0][1] < y1)
    if (childRules) {
      const split = childRules[0][1]
      const upper = source.filter((i) => i.rect[1] >= y0 && i.rect[3] < split)
      const lower = source.filter((i) => i.rect[1] >= split && i.rect[3] < y1)
      const leaves = readSourceRow(lower, cuts)
      const parents = childRules.map((r) =>
        upper.filter((i) => i.rect[0] >= r[0] - 0.1 && i.rect[2] <= r[2])
      )
      if (
        leaves?.join('|') === '|n|M(SD)or%|n|M(SD)or%|' &&
        parents.every((g) => g.length === 1 && /\p{L}/u.test(g[0].text)) &&
        childRules.every(
          (r, n) => Math.abs(r[0] - cuts[1 + n * 2]) < 0.2 && r[2] < cuts[3 + n * 2]
        ) &&
        upper
          .filter((i) => !parents.flat().includes(i))
          .every((i) => i.rect[0] >= cuts[5] && /^p$/i.test(i.text))
      ) {
        const body = source.filter((i) => i.rect[1] > y1),
          groups = groupSourceRowsWithScripts(body, height, 0.3)
        const records = [],
          spans = [
            { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
            { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
            { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
          ]
        let valid = Boolean(groups),
          measures = 0
        for (const g of groups ?? []) {
          if (
            /^\(?continued\)?$/i.test(
              g
                .map((i) => i.text)
                .join(' ')
                .trim()
            )
          )
            break
          const v = readSourceRow(g, cuts)
          if (
            !v ||
            !v[0] ||
            v.slice(1).some((x) => x && !/^[<>≤≥−+-]?\d[\d.,()%–−±/+-]*$/.test(x))
          ) {
            valid = false
            break
          }
          if (v.slice(1).some(Boolean)) measures++
          else spans.push({ row: records.length + 2, column: 0, rowSpan: 1, colSpan: 6 })
          records.push(union(g))
        }
        if (valid && measures >= 3 && records.every((r, n) => !n || r[1] > records[n - 1][3]))
          return {
            rows: [
              [left, y0, right, split],
              [left, split, right, y1],
              ...records.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans,
            completeSpans: true
          }
      }
    }
  }
  // A summary block can list the compared groups once, followed by repeated
  // metric blocks for those same groups. Native segmented borders give the
  // leaf columns even when the detector omits the entire parent row.
  if (borders.length === 2) {
    const [upperBorder, lowerBorder] = [...borders].sort((a, b) => a[0][1] - b[0][1])
    const y0 = upperBorder[0][1],
      y1 = lowerBorder[0][1]
    const cuts = [left, ...lowerBorder.slice(1).map((r) => r[0] - 0.1), right]
    const divider = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] > y0 &&
        r[1] < y1 &&
        Math.abs(r[0] - cuts[1]) < 0.2 &&
        Math.abs(r[2] - lowerBorder.at(-1)[2]) < 0.2
    )
    if (
      divider.length === 1 &&
      y1 - y0 < height * 5 &&
      upperBorder.length === lowerBorder.length &&
      upperBorder.every((r, n) => Math.abs(r[0] - lowerBorder[n][0]) < 0.2)
    ) {
      const split = divider[0][1]
      const upper = source.filter((i) => i.rect[1] >= y0 && i.rect[3] < split)
      const lower = source.filter((i) => i.rect[1] > split && i.rect[3] < y1)
      const body = source.filter((i) => i.rect[1] > y1)
      const clusters = []
      for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
        const g = clusters.at(-1)
        if (g && i.rect[0] - union(g)[2] < height * 0.8) g.push(i)
        else clusters.push([i])
      }
      const text = (g) =>
        g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
      const leaves = readSourceRow(lower, cuts)
      const count = clusters.length - 1
      const width = (lowerBorder.length - 1 - count) / count
      const records = groupSourceRowsWithScripts(body, height, 0.3)
      const values = records?.map((g) => readSourceRow(g, cuts))
      if (
        count >= 3 &&
        count <= 6 &&
        Number.isInteger(width) &&
        width >= 2 &&
        width <= 5 &&
        leaves &&
        leaves.every((s) => /\p{L}/u.test(s)) &&
        clusters.slice(1).every((g, n) => text(g) === leaves[n + 1]) &&
        leaves.slice(1 + count).every((s, n) => s === leaves[1 + count + (n % width)]) &&
        clusters.every((g, n) => {
          const start = n ? 1 + count + (n - 1) * width : 1
          const end = n ? start + width : 1 + count
          const rect = union(g)
          return (
            rect[0] >= cuts[start] &&
            rect[2] <= cuts[end] &&
            Math.abs((rect[0] + rect[2]) / 2 - (cuts[start] + cuts[end]) / 2) < height
          )
        }) &&
        values?.length >= 3 &&
        values.every(
          (v) => v && /\p{L}/u.test(v[0]) && v.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))
        ) &&
        hasUniqueRecordTokens(source, [upper, lower, ...records])
      ) {
        const bounds = records.map(union)
        if (bounds.every((r, n) => !n || r[1] > bounds[n - 1][3]))
          return {
            rows: [
              [left, y0, right, split],
              [left, split, right, y1],
              ...bounds.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans: [
              { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
              { row: 0, column: 1, rowSpan: 1, colSpan: count },
              ...clusters.slice(1).map((_, n) => ({
                row: 0,
                column: 1 + count + n * width,
                rowSpan: 1,
                colSpan: width
              }))
            ],
            completeSpans: true
          }
      }
    }
  }
  if (borders.length !== 1) return
  const border = borders[0],
    divider = border[0][1]
  const cuts = [left, ...border.slice(1).map((r) => r[0] - 0.1), right]
  const footer = horizontal.find(
    (r) =>
      r[1] > divider &&
      Math.abs(r[0] - border[0][0]) < 0.1 &&
      Math.abs(r[2] - border.at(-1)[2]) < 0.1
  )
  if (!footer) return
  const tiers = bands.filter(
    (b) =>
      b.length >= 2 &&
      b.length <= 6 &&
      b[0][1] < divider &&
      divider - b[0][1] < height * 3 &&
      b.slice(1).every((r, n) => r[0] > b[n][2] + height)
  )
  if (tiers.length !== 1) return
  const parents = tiers[0],
    y = parents[0][1]
  const upper = source.filter((i) => i.rect[3] <= y),
    lower = source.filter((i) => i.rect[1] > y && i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer[1])
  if (!hasUniqueRecordTokens(source, [upper, lower, body])) return
  const primary = (group) => group.filter((i) => i.height >= height * 0.8)
  const scriptsOwned = (group) =>
    group
      .filter((i) => i.height < height * 0.8)
      .every((i) => primary(group).filter((a) => isAdjacentTableScript(i, a)).length === 1)
  if (!scriptsOwned(upper) || !scriptsOwned(lower)) return
  const leaves = readSourceRow(primary(lower), cuts)
  if (!leaves) return
  const prefix = leaves.findIndex(Boolean)
  if (prefix < 2 || prefix > 4 || leaves.slice(prefix).some((s) => !/^\p{L}+$/u.test(s))) return
  const width = (border.length - prefix) / parents.length
  if (
    !Number.isInteger(width) ||
    width < 2 ||
    width > 4 ||
    leaves.slice(prefix).some((s, n) => s !== leaves[prefix + (n % width)])
  )
    return
  const parentGroups = parents.map((r) =>
    upper.filter((i) => i.rect[0] >= r[0] && i.rect[2] <= r[2])
  )
  if (
    parentGroups.some(
      (g, n) =>
        g.length !== 1 ||
        !/\p{L}/u.test(g[0].text) ||
        Math.abs(parents[n][0] - border[prefix + n * width][0]) > 0.1 ||
        parents[n][2] > cuts[prefix + (n + 1) * width] + 0.2
    )
  )
    return
  const parentTokens = new Set(parentGroups.flat())
  const stubs = upper.filter((i) => !parentTokens.has(i))
  const stubText = readSourceRow(primary(stubs), cuts)
  if (
    !stubText ||
    stubText.slice(0, prefix).some((s) => !/\p{L}/u.test(s)) ||
    stubText.slice(prefix).some(Boolean) ||
    !hasUniqueRecordTokens(upper, [stubs, ...parentGroups])
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.2)
  if (!groups || groups.length < 6 || groups.length % 2) return
  const records = groups.map((g) => readSourceRow(g, cuts))
  if (
    records.some(
      (r) =>
        !r ||
        r.slice(1, prefix).some((s) => !s) ||
        r.slice(prefix).some((s) => s && !/^[−+-]?\d[\d.,]*$/.test(s))
    )
  )
    return
  // Explicit repeated group codes distinguish a shared stub from arbitrary
  // blank labels. Each first record is complete; the second retains its blanks.
  if (
    records[0][1] === records[1][1] ||
    !/^[A-Za-z]+$/.test(records[0][1]) ||
    !/^[A-Za-z]+$/.test(records[1][1]) ||
    records.some(
      (r, n) =>
        r[1] !== records[n % 2][1] ||
        (n % 2 ? r[0] : !/\p{L}/u.test(r[0])) ||
        (!(n % 2) && r.slice(prefix).some((s) => !s)) ||
        r.slice(prefix).filter(Boolean).length < parents.length * 2
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && bounds[n - 1][3] >= b[1])) return
  const ys = [divider, ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2), footer[1]]
  return {
    rows: [
      [left, top, right, y],
      [left, y, right, divider],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, footer[1]]),
    spans: [
      ...parents.map((_, n) => ({
        row: 0,
        column: prefix + n * width,
        rowSpan: 1,
        colSpan: width
      })),
      ...Array.from({ length: prefix }, (_, column) => ({
        row: 0,
        column,
        rowSpan: 2,
        colSpan: 1
      })),
      ...groups.flatMap((_, n) =>
        n % 2 ? [] : [{ row: n + 2, column: 0, rowSpan: 2, colSpan: 1 }]
      )
    ],
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set(source)
  }
}

// Full-width rules delimit category groups; paired count/percentage baselines
// delimit records within each group, including bottom-aligned wrapped labels.
export function recoverRuledCategoryGrid(table, items, captions, rules) {
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
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > top &&
        r[1] < bottom &&
        Math.abs(r[0] - left) < 15 &&
        Math.abs(r[2] - right) < 15
    )
    .sort((a, b) => a[1] - b[1])
  if (
    borders.length < 5 ||
    borders.some((r) => Math.abs(r[0] - borders[0][0]) > 2 || Math.abs(r[2] - borders[0][2]) > 2)
  )
    return
  const source = tableSourceItems(items, [left, borders[0][1], right, borders.at(-1)[1]])
  const header = source.filter((i) => i.rect[3] < borders[1][1])
  if (readSourceRow(header, cuts)?.join('|') !== '||Count|%') return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (source.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    return
  const rows = [[left, borders[0][1], right, borders[1][1]]],
    spans = [],
    groups = [header]
  for (let n = 1; n + 1 < borders.length; n++) {
    const a = borders[n][1],
      b = borders[n + 1][1]
    const body = source.filter((i) => i.rect[1] >= a && i.rect[3] <= b)
    const parent = body.filter((i) => col(i) === 0)
    const counts = body.filter((i) => col(i) === 2)
    const percentages = body.filter((i) => col(i) === 3)
    if (
      parent.length !== 1 ||
      !/\p{L}/u.test(parent[0].text) ||
      counts.length < 2 ||
      counts.length !== percentages.length ||
      counts.some(
        (i, j) =>
          !/^\d+$/.test(i.text) ||
          !/^\d+(?:\.\d+)?%?$/.test(percentages[j].text) ||
          Math.abs(i.baseline - percentages[j].baseline) > i.height * 0.2
      )
    )
      return
    const records = counts.map((i, j) => [i, percentages[j]])
    for (const item of body.filter((i) => col(i) === 1)) {
      const row = counts.findIndex((i) => i.baseline >= item.baseline - item.height * 0.2)
      if (row < 0 || counts[row].baseline - item.baseline > item.height * 1.6) return
      records[row].push(item)
    }
    if (records.some((g) => !g.some((i) => col(i) === 1 && /\p{L}/u.test(i.text)))) return
    const bounds = records.map(union)
    if (bounds.some((r, j) => j && r[1] <= bounds[j - 1][3])) return
    spans.push({ row: rows.length, column: 0, rowSpan: records.length, colSpan: 1 })
    const ys = [a, ...bounds.slice(1).map((r, j) => (bounds[j][3] + r[1]) / 2), b]
    rows.push(...records.map((_, j) => [left, ys[j], right, ys[j + 1]]))
    groups.push(parent, ...records)
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated short gaps in the top and bottom header rules identify columns.
// Accept only single-line records with indented labels and explicitly empty
// comparison cells. Wrapped labels and bare numeric continuation rows decline.
export function recoverNativeHeaderGrid(table, items, captions, rules) {
  const grouped = recoverRuledGroupedCountGrid(table, items, captions, rules)
  if (grouped) return grouped
  const bands = recoverRuledComparisonBands(table, items, captions, rules)
  if (bands) return bands
  const sectioned = recoverSectionedComparisonGrid(table, items, rules)
  if (sectioned) return sectioned
  const domains = recoverRuledDomainGrid(table, items, captions, rules)
  if (domains) return domains
  const underlined = recoverUnderlinedNumericGrid(table, items, captions, rules)
  if (underlined) return underlined
  const review = recoverRuledReviewHeader(table, items, captions, rules)
  if (review) return review
  const events = recoverRepeatedEventGrid(table, items, captions, rules)
  if (events) return events
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  // Explicit count, percentage, summary and range headings establish sparse
  // columns even when the model overlaps two count columns and loses '%'.
  const summary = source.filter((i) => /^(?:n|%|Mean \(SD\)|Range)$/.test(i.text))
  if (
    summary.length === 4 &&
    summary.map((i) => i.text).join('|') === 'n|%|Mean (SD)|Range' &&
    summary.every((i) => Math.abs(i.baseline - summary[0].baseline) < 0.1)
  ) {
    const font = summary[0].height
    const frame = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] >= left &&
          r[2] <= right &&
          r[2] - r[0] > (right - left) * 0.9 &&
          r[1] >= top &&
          r[1] <= bottom
      )
      .sort((a, b) => a[1] - b[1])
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      frame.length === 3 &&
      predicted.length === 5 &&
      frame[0][1] < summary[0].rect[1] &&
      frame[1][1] > summary[0].rect[3]
    ) {
      const cuts = [
        left,
        summary[0].rect[0] - font,
        ...summary.slice(1).map((i, n) => (summary[n].rect[2] + i.rect[0]) / 2),
        right
      ]
      const body = source.filter((i) => i.rect[1] > frame[1][1] && i.rect[3] < frame[2][1])
      const groups = groupSourceRowsWithScripts(body, font, 0.35)
      const records = [],
        sections = []
      let valid = Boolean(groups),
        measures = 0
      for (const g of groups ?? []) {
        const v = readSourceRow(g, cuts)
        if (!v || !v[0]) {
          valid = false
          break
        }
        if (
          v[1] &&
          /^\d+$/.test(v[1]) &&
          v.slice(2).every((x) => !x || /^\d[\d.,()–-]*$/.test(x))
        ) {
          measures++
          records.push([...g])
        } else if (v.slice(1).every((x) => !x)) {
          if (
            records.length &&
            /^[a-z(]/.test(v[0]) &&
            g[0].baseline - records.at(-1).at(-1).baseline < font * 1.6
          )
            records.at(-1).push(...g)
          else {
            sections.push(records.length)
            records.push([...g])
          }
        } else {
          valid = false
          break
        }
      }
      if (valid && measures >= 20 && sections.length >= 5 && hasUniqueRecordTokens(body, records)) {
        const rects = records.map(union)
        if (rects.every((r, n) => !n || r[1] > rects[n - 1][3]))
          return {
            rows: [
              [left, frame[0][1], right, frame[1][1]],
              ...rects.map((r) => [left, r[1], right, r[3]])
            ],
            columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
            spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })),
            completeSpans: true
          }
      }
    }
  }
  const lines = new Map()
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[0] - b[0])) {
    const band = lines.get(r[1]) ?? []
    band.push(r)
    lines.set(r[1], band)
  }
  const edges = [...lines].sort((a, b) => a[0] - b[0])
  // Small tables can have column-width strokes at the header divider and
  // footer even when the model emits no rows. Matching segment endpoints and
  // complete numeric baselines establish the grid independently of inference.
  const segmented = edges.filter(
    ([, parts]) =>
      parts.length >= 3 &&
      parts.length <= 8 &&
      parts[0][0] >= left - 12 &&
      parts.at(-1)[2] <= right + 12 &&
      parts.slice(1).every((r, i) => Math.abs(r[0] - parts[i][2]) < 0.1)
  )
  if (segmented.length === 2) {
    const [[divider, upper], [footer, lower]] = segmented
    const border = edges.findLast(
      ([y, parts]) =>
        y < divider &&
        parts.length === 1 &&
        Math.abs(parts[0][0] - upper[0][0]) < 0.1 &&
        Math.abs(parts[0][2] - upper.at(-1)[2]) < 0.1
    )?.[0]
    if (
      border !== undefined &&
      upper.length === lower.length &&
      upper.every(
        (r, i) => Math.abs(r[0] - lower[i][0]) < 0.1 && Math.abs(r[2] - lower[i][2]) < 0.1
      )
    ) {
      const cuts = [upper[0][0] - 0.1, ...upper.map((r) => r[2])]
      cuts[cuts.length - 1] += 0.1
      const body = source.filter((i) => i.rect[1] >= divider && i.rect[3] <= footer)
      const groups = []
      for (const i of body) {
        const group = groups.at(-1)
        if (group && Math.abs(group[0].baseline - i.baseline) < i.height * 0.3) group.push(i)
        else groups.push([i])
      }
      const header = source.filter((i) => i.rect[1] >= border && i.rect[3] <= divider)
      const values = groups.map((g) => readSourceRow(g, cuts))
      // Matching segmented borders also delimit sparse baseline comparisons.
      // Require two explicit cohort headings, statistic/probability columns,
      // and complete paired counts or section statistics on every source line.
      const heading = readSourceRow(header, cuts)
      if (
        cuts.length === 6 &&
        heading &&
        !heading[0] &&
        heading.slice(1, 3).every((v) => /group\(n=\d+\)/i.test(v)) &&
        /^torχ2$/i.test(heading[3]) &&
        /^P$/i.test(heading[4])
      ) {
        const height = Math.max(...header.map((i) => i.height))
        const nativeBody = source.filter(
          (i) => i.rect[1] >= divider - height * 0.1 && i.rect[3] <= footer
        )
        const nativeRows = groupSourceRowsWithScripts(nativeBody, height, 0.35)
        const nativeValues = nativeRows?.map((g) => readSourceRow(g, cuts))
        const number = (v) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±–−+/-]*$/.test(v)
        const paired = (v) => v && number(v[1]) && number(v[2])
        const section = (v) => v && !v[1] && !v[2] && number(v[3]) && number(v[4])
        if (
          nativeRows &&
          nativeValues.filter(paired).length >= 12 &&
          nativeValues.filter(section).length >= 3 &&
          nativeValues.every(
            (v) =>
              v &&
              /\p{L}/u.test(v[0]) &&
              (paired(v) || section(v)) &&
              v.slice(1).every((x) => !x || number(x))
          ) &&
          hasUniqueRecordTokens(source, [header, ...nativeRows])
        ) {
          return {
            rows: [
              [cuts[0], border, cuts.at(-1), divider],
              ...nativeRows.map((g) => {
                const r = union(g)
                return [cuts[0], r[1], cuts.at(-1), r[3]]
              })
            ],
            columns: cuts.slice(1).map((x, n) => [cuts[n], border, x, footer]),
            spans: [],
            completeSpans: true
          }
        }
      }
      if (
        groups.length >= 2 &&
        groups.length <= 8 &&
        hasUniqueRecordTokens(source, [header, ...groups]) &&
        values.every(
          (r) =>
            r && /\p{L}/u.test(r[0]) && r.slice(1).every((v) => /^[<>≤≥−+-]?\d[\d.,()%]*$/.test(v))
        ) &&
        cuts
          .slice(1)
          .every((x, c) =>
            header.some((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x && /\p{L}/u.test(i.text))
          )
      ) {
        const ys = [
          divider,
          ...groups.slice(1).map((g, n) => (union(groups[n])[3] + union(g)[1]) / 2),
          footer
        ]
        return {
          rows: [
            [cuts[0], border, cuts.at(-1), divider],
            ...groups.map((_, n) => [cuts[0], ys[n], cuts.at(-1), ys[n + 1]])
          ],
          columns: cuts.slice(1).map((x, n) => [cuts[n], border, x, footer]),
          spans: [],
          completeSpans: true
        }
      }
    }
  }
  const matches = edges.filter(
    ([, segments]) =>
      segments.length >= 3 &&
      segments.length <= 8 &&
      segments[0][0] <= left + 12 &&
      segments.at(-1)[2] >= right - 12 &&
      segments.slice(1).every((r, n) => r[0] - segments[n][2] > 0 && r[0] - segments[n][2] < 1)
  )
  if (matches.length !== 2) return
  const [[a, upper], [b, lower]] = matches
  if (
    upper.length !== lower.length ||
    upper.some((r, n) => Math.abs(r[0] - lower[n][0]) > 1 || Math.abs(r[2] - lower[n][2]) > 1)
  )
    return
  const cuts = [left, ...upper.slice(1).map((r, n) => (upper[n][2] + r[0]) / 2), right]
  const header = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 > a && (i.rect[1] + i.rect[3]) / 2 < b
  )
  const heading = readSourceRow(header, cuts)
  if (
    !heading?.every((s) => /\p{L}/u.test(s)) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > i.height * 0.2)
  )
    return
  const footer = edges.findLast(
    ([y, rs]) =>
      y > b &&
      rs[0][0] <= left + 12 &&
      rs.at(-1)[2] >= right - 12 &&
      rs.slice(1).every((r, n) => r[0] <= rs[n][2] + 1)
  )?.[0]
  if (!footer) return
  const body = source.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= b && i.rect[3] < footer)
  const groups = []
  for (const i of body) {
    const g = groups.at(-1)
    if (g && Math.abs(i.baseline - g[0].baseline) < i.height * 0.25) g.push(i)
    else groups.push([i])
  }
  if (groups.length < 6 || !hasUniqueRecordTokens(body, groups)) return
  const cells = groups.map((g) => readSourceRow(g, cuts))
  if (
    cells.some(
      (r) =>
        !r ||
        !/\p{L}/u.test(r[0]) ||
        r.slice(1).some((s) => s && !/^[−–-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(s))
    )
  )
    return
  if (cells.filter((r) => r.slice(1).every(Boolean)).length < 4) return
  const sections = cells.map((r, n) => (r.slice(1).every((s) => !s) ? n : -1)).filter((n) => n >= 0)
  if (sections.length < 2 || sections[0] !== 0) return
  const sectionLeft = Math.min(...groups[0].map((i) => i.rect[0]))
  if (
    groups.some((g, n) =>
      sections.includes(n)
        ? Math.abs(g[0].rect[0] - sectionLeft) > 1
        : g[0].rect[0] < sectionLeft + g[0].height * 0.5
    )
  )
    return
  const ys = [b, ...groups.slice(1).map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1), footer]
  return {
    rows: [[left, a, right, b], ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })),
    completeSpans: true
  }
}

// Several count/percentage cohorts share native record baselines, with optional
// median/range records and empty section rows. Enclosing rules and repeated
// complete pairs prove the layout even on a continuation without a caption.
export function recoverCohortDistributionRecords(table, items, rules) {
  const [left, top, right, originalBottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length > 9 || predicted.length % 2 !== 1) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const sideEnds = rules.filter(
    (r) =>
      r[0] === r[2] && r[1] < originalBottom && r[3] > originalBottom && r[3] - originalBottom < 15
  )
  const lower = sideEnds.find(
    (r) =>
      Math.abs(r[0] - left) < 15 &&
      sideEnds.some((s) => Math.abs(s[0] - right) < 15 && Math.abs(s[3] - r[3]) < 1)
  )
  const bottom = lower?.[3] ?? originalBottom
  const cropRect = [left, top, right, bottom]
  const source = tableSourceItems(items, cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 12) return
  const frame = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      r[1] >= top && r[1] <= bottom && Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15
  )
  if (frame.length < 3) return
  let first = 0
  const spans = [],
    headerRows = []
  if (
    groups
      .slice(0, 3)
      .flat()
      .some((i) => /^\(N\s*=\s*\d+\)$/i.test(i.text))
  ) {
    const head = groups.slice(0, 3).flat(),
      parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right]
    const v = readSourceRow(head, parentCuts, { multiline: true })
    if (
      !v ||
      !/\p{L}/u.test(v[0]) ||
      !v.slice(1).every((s) => /\p{L}/u.test(s) && /\(N=\d+\)/i.test(s))
    )
      return
    first = 3
    headerRows.push(0)
    for (let c = 1; c < predicted.length; c += 2)
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  }
  const records = []
  for (const g of groups.slice(first)) {
    const v = readSourceRow(g, cuts),
      last = records.at(-1),
      prior = last && readSourceRow(last, cuts, { multiline: true })
    if (
      v &&
      prior &&
      /^[a-z]/.test(v[0]) &&
      v.slice(1).every((s) => !s) &&
      prior.slice(1).every((s) => !s) &&
      g[0].baseline - last.at(-1).baseline < height * 1.3 &&
      !frame.some((r) => r[1] > union(last)[3] && r[1] < union(g)[1])
    )
      last.push(...g)
    else records.push([...g])
  }
  const values = records.map((g) => readSourceRow(g, cuts, { multiline: true }))
  let counts = 0,
    sections = 0
  for (const v of values) {
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      sections++
      continue
    }
    let count = true,
      range = true,
      sparse = true
    for (let c = 1; c < predicted.length; c += 2) {
      count &&= /^\d+$/.test(v[c]) && /^\d+(?:\.\d+)?%$/.test(v[c + 1])
      range &&= /^\d+(?:\.\d+)?$/.test(v[c]) && /^\(\d+(?:\.\d+)?;\d+(?:\.\d+)?\)$/.test(v[c + 1])
      sparse &&= /^\d+$/.test(v[c]) && !v[c + 1]
    }
    if (!count && !range && !sparse) return
    if (count) counts++
  }
  if (counts < 8 || sections < 3) return
  const owned = first ? [groups.slice(0, first).flat(), ...records] : records
  if (!hasUniqueRecordTokens(source, owned)) return
  const bounds = owned.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect,
    rows: bounds.map((r) => [left, r[1] - 0.01, right, r[3] + 0.01]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Partial row rules leave the category and P-value columns open; full-width
// rules close those shared cells. Require both native borders and complete
// count records before replacing conflicting model spans.
function recoverRuledGroupedCountGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
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
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 8 || !hasUniqueRecordTokens(source, groups)) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const [parent, leaves] = values
  if (
    !parent[0] ||
    parent[1] ||
    !/N=\d/i.test(parent[2]) ||
    !/\p{L}/u.test(parent[3]) ||
    parent[4] ||
    !/^p-?value$/i.test(parent[5]) ||
    leaves.some((v, c) => (c === 3 || c === 4 ? !/N=\d/i.test(v) : Boolean(v)))
  )
    return
  const count = (s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?%\)$/.test(s)
  if (
    values
      .slice(2)
      .some(
        (v) =>
          !v[1] ||
          !v.slice(2, 5).every(count) ||
          (v[5] && !/^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[5]))
      )
  )
    return
  const sections = values.flatMap((v, n) => (n >= 2 && v[0] ? [n] : []))
  if (sections.length < 2 || sections[0] !== 2) return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const horizontal = joinHorizontalTableRules(rules, 0.1).filter(
    (r) => r[1] >= top && r[1] <= bottom
  )
  const full = horizontal.filter((r) => Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15)
  if (!full.some((r) => r[1] <= bounds[0][1]) || !full.some((r) => r[1] >= bounds.at(-1)[3])) return
  const spans = [
    { row: 0, column: 0, rowSpan: 2, colSpan: 2 },
    { row: 0, column: 2, rowSpan: 2, colSpan: 1 },
    { row: 0, column: 3, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 5, rowSpan: 2, colSpan: 1 }
  ]
  for (const [j, start] of sections.entries()) {
    const end = sections[j + 1] ?? groups.length
    if (end - start < 2 || !values[start][5] || values.slice(start + 1, end).some((v) => v[5]))
      return
    if (!full.some((r) => r[1] > bounds[start - 1][3] && r[1] < bounds[start][1])) return
    for (let n = start + 1; n < end; n++) {
      if (
        !horizontal.some(
          (r) =>
            r[1] > bounds[n - 1][3] &&
            r[1] < bounds[n][1] &&
            r[0] >= cuts[1] - height &&
            r[0] < cuts[2] &&
            r[2] > cuts[5] - height &&
            r[2] < right
        )
      )
        return
    }
    spans.push(
      { row: start, column: 0, rowSpan: end - start, colSpan: 1 },
      { row: start, column: 5, rowSpan: end - start, colSpan: 1 }
    )
  }
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Full-width native borders prove record boundaries independently of the model.
// A comparison row must contain both cohort values; a section may span them only
// when those columns contain no measurements. Wrapped labels stay in their band.
function recoverRuledComparisonBands(table, items, captions, rules) {
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
  const borders = clusterTableRulePositions(
    joinHorizontalTableRules(rules, 0.1)
      .filter(
        (r) =>
          r[1] >= top && r[1] <= bottom && Math.abs(r[0] - left) < 15 && Math.abs(r[2] - right) < 15
      )
      .map((r) => r[1])
  )
  if (borders.length < 8) return
  const source = tableSourceItems(items, table.cropRect)
  const groups = borders
    .slice(1)
    .map((y, n) => source.filter((i) => i.rect[1] >= borders[n] && i.rect[3] <= y))
  if (!hasUniqueRecordTokens(source, groups)) return
  const header = readSourceRow(groups[0], cuts, { multiline: true })
  if (
    !header ||
    !header.slice(1, 3).every((s) => /\p{L}/u.test(s)) ||
    !/^P(?:value)?$/i.test(header[3])
  )
    return
  const value = (s) => /^[<>≤≥−+-]?\d[\d.,()%–−/+-]*$/.test(s)
  const spans = []
  let records = 0,
    sections = 0
  for (let n = 1; n < groups.length; n++) {
    const v = readSourceRow(groups[n], cuts, { multiline: true })
    if (v && v[0] && value(v[1]) && value(v[2]) && (!v[3] || value(v[3]) || v[3] === 'NT')) {
      records++
      continue
    }
    const section = readSourceRow(groups[n], [left, cuts[3], right], { multiline: true })
    if (
      !section ||
      !/\p{L}/u.test(section[0]) ||
      (section[1] && section[1] !== 'NT' && !value(section[1])) ||
      groups[n].some((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[3] && /\d/.test(i.text))
    )
      return
    sections++
    spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 3 })
  }
  if (records < 5 || sections < 1) return
  return {
    rows: groups.map((_, n) => [left, borders[n], right, borders[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true
  }
}

// Paired cohort values and repeated indented categories establish complete
// records independently of model rowspans. A section may own a separate P
// value, but may not contain a partly populated pair of cohort measurements.
function recoverSectionedComparisonGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 3 && predicted.length !== 4) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const borders = joinHorizontalTableRules(rules, 0.1).filter(
    (r) =>
      r[1] === r[3] && r[0] <= left + 15 && r[2] >= right - 15 && r[1] >= top - 2 && r[1] <= bottom
  )
  if (borders.length < 3) return
  const footer = Math.max(...borders.map((r) => r[1]))
  // A full-width section separator is not necessarily the closing border.
  // Decline if any original table text would be lost below it.
  if (tableSourceItems(items, table.cropRect).some((i) => i.rect[3] > footer)) return
  const source = tableSourceItems(items, [left, top, right, footer])
  if (source.length < 25) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups || !hasUniqueRecordTokens(source, groups)) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const statistic = (v) => v === 'None' || /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%±;–−+\-/=Nn]*$/.test(v)
  const probability = (v) => /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[*†‡§]*$/.test(v)
  const paired = (v) =>
    v[0] && statistic(v[1]) && statistic(v[2]) && (v.length === 3 || !v[3] || probability(v[3]))
  const first = values.findIndex(paired)
  if (first < 1) return
  const headerCount =
    values.slice(0, first).findLastIndex((v) => /\p{L}/u.test(v[1]) && /\p{L}/u.test(v[2])) + 1
  if (
    headerCount < 1 ||
    headerCount > 2 ||
    values.slice(0, headerCount).some((v) => !/\p{L}/u.test(v[1]) || !/\p{L}/u.test(v[2]))
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const sections = []
  let records = 0
  for (let n = headerCount; n < groups.length; n++) {
    const v = values[n]
    if (paired(v)) {
      records++
      continue
    }
    if (!/\p{L}/u.test(v[0]) || v[1] || v[2] || (v.length === 4 && v[3] && !probability(v[3])))
      return
    const stubLeft = Math.min(
      ...groups[n].filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])
    )
    if (
      ![n + 1, n + 2].every(
        (j) =>
          values[j] &&
          paired(values[j]) &&
          Math.min(...groups[j].filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])) >=
            stubLeft + height * 0.4
      )
    )
      return
    sections.push(n)
  }
  if (sections.length < 2 || records < 6) return
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, footer]),
    spans: sections.map((row) => ({ row, column: 0, rowSpan: 1, colSpan: 3 })),
    headerRows: Array.from({ length: headerCount }, (_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Overlapping footer strokes preserve each original column even when model
// columns overlap. Repeated numeric/unit headings and complete first records
// independently confirm those cuts and the parent groups.
export function recoverRepeatedUnitGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const times = source.filter((i) => /^\d+(?:\.\d+)?\s+(?:h|min|d)$/.test(i.text))
  if (times.length < 3 || times.some((i) => Math.abs(i.rect[0] - times[0].rect[0]) > 1)) return
  const candidates = rules.filter(
    (r) => r[1] === r[3] && r[1] > times.at(-1).rect[3] && r[1] < bottom
  )
  const footer = candidates
    .filter((r) => Math.abs(r[1] - candidates[0][1]) < 0.01)
    .sort((a, b) => a[0] - b[0])
  if (
    footer.length < 7 ||
    footer[0][0] > left + 12 ||
    footer.at(-1)[2] < right - 12 ||
    footer.slice(1).some((r, n) => r[0] - footer[n][2] > 0 || r[0] - footer[n][2] < -2)
  )
    return
  const cuts = [left, ...footer.slice(1).map((r, n) => (footer[n][2] + r[0]) / 2), right]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const heading = source.filter((i) => i.rect[3] < times[0].rect[1])
  const units = heading.filter((i) => /^(?:[μµ]g|mg|g|mL|ml|kg)$/.test(i.text))
  if (
    units.length !== footer.length - 1 ||
    !units.every(
      (i, n) =>
        i.text === units[0].text &&
        col(i) === n + 1 &&
        Math.abs(i.baseline - units[0].baseline) < i.height * 0.2
    )
  )
    return
  const numbers = heading.filter((i) => /^\d+(?:\.\d+)?$/.test(i.text))
  if (
    numbers.length !== units.length ||
    !numbers.every(
      (i, n) => col(i) === n + 1 && Math.abs(i.baseline - numbers[0].baseline) < i.height * 0.2
    )
  )
    return
  const size = numbers.findIndex((i, n) => n > 0 && i.text === numbers[0].text)
  if (
    size < 2 ||
    numbers.length % size ||
    numbers.some((i, n) => i.text !== numbers[n % size].text)
  )
    return
  const parents = heading.filter((i) => !numbers.includes(i) && !units.includes(i))
  if (
    parents.length !== numbers.length / size ||
    parents.some(
      (i, n) =>
        !/\p{L}/u.test(i.text) ||
        i.rect[0] < cuts[1 + n * size] ||
        i.rect[2] > cuts[1 + (n + 1) * size]
    )
  )
    return
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 12 &&
      r[2] >= right - 12 &&
      r[1] > units[0].rect[3] &&
      r[1] < times[0].baseline - times[0].height / 2
  )
  const parentDivider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= cuts[1] + 2 &&
      r[2] >= right - 12 &&
      r[1] > parents[0].rect[3] &&
      r[1] < numbers[0].baseline - numbers[0].height / 2
  )
  if (!divider || !parentDivider) return
  const body = source.filter((i) => !heading.includes(i) && i.rect[3] <= footer[0][1])
  const ys = [divider[1], ...times.slice(1).map((i) => i.rect[1] - 0.1), footer[0][1]]
  const groups = times.map((_, n) =>
    body.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < ys[n + 1]
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  const cells = groups.map((g) => readSourceRow(g, cuts))
  if (
    cells.some(
      (r, n) =>
        !r ||
        r[0] !== times[n].text.replace(/\s/g, '') ||
        r.slice(1).some((s) => s && !/^\d+(?:\.\d+)?±\d+(?:\.\d+)?[a-z]?$/.test(s))
    ) ||
    !cells[0].every(Boolean)
  )
    return
  return {
    rows: [
      [left, top, right, parentDivider[1]],
      [left, parentDivider[1], right, divider[1]],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: parents.map((_, n) => ({ row: 0, column: 1 + n * size, rowSpan: 1, colSpan: size })),
    completeSpans: true
  }
}

// Repeated count/percentage sections contain the same leaf headings and
// underlined parent tiers. Build rows from complete source baselines, preserving
// each repeated section title instead of letting it fall between model rows.
export function recoverRepeatedCountSections(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length % 2 !== 1) return
  const cuts = [
    left,
    ...predicted.slice(1).map((r, n) => left + (predicted[n].rect[2] + r.rect[0]) / 2),
    right
  ]
  const footer = rules
    .filter((r) => r[1] === r[3] && r[0] <= left + 12 && r[2] >= right - 12 && r[1] <= bottom)
    .sort((a, b) => b[1] - a[1])[0]
  if (!footer) return
  const source = tableSourceItems(items, table.cropRect).filter((i) => i.rect[3] < footer[1])
  const groups = []
  for (const i of source) {
    const g = groups.at(-1)
    if (g && Math.abs(i.baseline - g[0].baseline) < i.height * 0.25) g.push(i)
    else groups.push([i])
  }
  if (groups.length < 12 || groups[0].length !== 1) return
  const key = (s) => s.replace(/\d+/g, '#')
  const titles = groups.filter((g) => g.length === 1 && key(g[0].text) === key(groups[0][0].text))
  if (
    titles.length < 2 ||
    !/\d/.test(groups[0][0].text) ||
    titles.some(
      (g) =>
        !/\p{L}/u.test(g[0].text) ||
        Math.abs((g[0].rect[0] + g[0].rect[2] - left - right) / 2) > (right - left) * 0.05
    )
  )
    return
  const spans = [],
    leafRows = [],
    recordRows = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      cells = readSourceRow(g, cuts)
    if (titles.includes(g)) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: predicted.length })
      continue
    }
    if (
      cells &&
      /\p{L}/u.test(cells[0]) &&
      cells.slice(1).every((s, c) => (c % 2 ? s === '%' : /^(?:No\.|N|Count)$/.test(s)))
    ) {
      leafRows.push(n)
      continue
    }
    if (
      cells &&
      /\p{L}/u.test(cells[0]) &&
      cells.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))
    ) {
      recordRows.push(n)
      continue
    }
    const occupied = new Set()
    for (const i of g) {
      if (!/\p{L}/u.test(i.text)) return
      const underline = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] > i.rect[3] &&
          r[1] - i.rect[3] < i.height &&
          r[0] <= i.rect[0] &&
          r[2] >= i.rect[2]
      )
      if (!underline) return
      const cols = predicted
        .map((_, c) => c)
        .filter(
          (c) =>
            c > 0 &&
            (cuts[c] + cuts[c + 1]) / 2 >= underline[0] &&
            (cuts[c] + cuts[c + 1]) / 2 <= underline[2]
        )
      if (
        cols.length < 2 ||
        cols.some((c) => occupied.has(c)) ||
        i.rect[0] < cuts[cols[0]] ||
        i.rect[2] > cuts[cols.at(-1) + 1]
      )
        return
      cols.forEach((c) => occupied.add(c))
      spans.push({ row: n, column: cols[0], rowSpan: 1, colSpan: cols.length })
    }
    if (occupied.size !== predicted.length - 1) return
  }
  if (leafRows.length !== titles.length || recordRows.length < titles.length * 3) return
  for (let n = 0; n < titles.length; n++) {
    const start = groups.indexOf(titles[n]),
      end = n + 1 < titles.length ? groups.indexOf(titles[n + 1]) : groups.length
    const leaves = leafRows.filter((r) => r > start && r < end)
    if (
      leaves.length !== 1 ||
      recordRows.filter((r) => r > leaves[0] && r < end).length !== end - leaves[0] - 1 ||
      end - leaves[0] - 1 < 3
    )
      return
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  const ys = [
    top,
    ...groups.slice(1).map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1),
    footer[1]
  ]
  return {
    rows: groups.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated totals followed by ordered count distributions share a wrapped
// description down the stub column. Native column strokes and complete numeric
// baselines establish the records; no counts or missing values are synthesized.
export function recoverCountDistributionGrid(table, items, captions, rules) {
  const mixedStub = recoverMixedStubCountRecords(table, items, captions)
  if (mixedStub) return mixedStub
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const frames = bands.filter(
    (b) =>
      b.parts.length === 5 &&
      Math.abs(b.parts[0][0] - left) < 15 &&
      Math.abs(b.parts.at(-1)[2] - right) < 15 &&
      b.parts.slice(1).every((r, n) => Math.abs(r[0] - b.parts[n][2]) < 0.05)
  )
  if (
    frames.length !== 3 ||
    frames.some((b) =>
      b.parts.some(
        (r, n) =>
          Math.abs(r[0] - frames[0].parts[n][0]) > 0.05 ||
          Math.abs(r[2] - frames[0].parts[n][2]) > 0.05
      )
    )
  )
    return
  const cuts = [frames[0].parts[0][0], ...frames[0].parts.map((r) => r[2])]
  const [a, b, z] = frames.map((f) => f.y)
  const underline = bands.find(
    (f) =>
      f.y > a &&
      f.y < b &&
      f.parts.length === 2 &&
      Math.abs(f.parts[0][0] - cuts[2]) < 0.05 &&
      Math.abs(f.parts[0][2] - cuts[3]) < 0.05 &&
      Math.abs(f.parts[1][0] - cuts[3]) < 0.05 &&
      Math.abs(f.parts[1][2] - cuts[4]) < 0.05
  )
  if (!underline) return
  const source = tableSourceItems(items, [cuts[0], a, cuts[5], z])
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const upper = source.filter((i) => i.rect[3] < underline.y)
  const lower = source.filter((i) => i.rect[1] > underline.y && i.rect[3] < b)
  const parent = upper.filter((i) => col(i) === 2 || col(i) === 3)
  const parentText = parent.map((i) => i.text).join('')
  const header = readSourceRow(
    upper.filter((i) => !parent.includes(i)),
    cuts
  )
  const children = readSourceRow(lower, cuts)
  if (
    !/^[\p{L} ]{2,50}\([Nn]\)$/u.test(parentText) ||
    !header ||
    parent.some((i) => i.rect[0] < cuts[2] || i.rect[2] > cuts[4]) ||
    Math.abs(
      (Math.min(...parent.map((i) => i.rect[0])) +
        Math.max(...parent.map((i) => i.rect[2])) -
        cuts[2] -
        cuts[4]) /
        2
    ) > 1 ||
    !/^[\p{L} ]+\(n\)$/iu.test(header[1]) ||
    !/^p$/i.test(header[4]) ||
    header[0] ||
    header[2] ||
    header[3] ||
    !children ||
    children[0] ||
    children[1] ||
    children[4] ||
    !children.slice(2, 4).every((s) => /^[\p{L}]+$/u.test(s))
  )
    return
  const body = source.filter((i) => i.rect[1] > b)
  const numeric = []
  for (const i of body.filter((i) => col(i) > 0)) {
    const last = numeric.at(-1)
    if (last && Math.abs(i.baseline - last[0].baseline) < i.height * 0.2) last.push(i)
    else numeric.push([i])
  }
  if (numeric.some((g) => new Set(g.map(col)).size !== g.length)) return
  const values = numeric.map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v) =>
        !v ||
        !/^\d+$/.test(v[2]) ||
        !/^\d+$/.test(v[3]) ||
        (v[1] && !/^\d+$/.test(v[1])) ||
        (v[4] && !/^(?:0?\.\d+|1(?:\.0+)?)$/.test(v[4]))
    )
  )
    return
  const totals = values.flatMap((v, n) => (!v[1] && !v[4] ? [n] : []))
  if (totals.length < 2 || totals[0] !== 0) return
  const ys = numeric.map((g) => Math.min(...g.map((i) => i.rect[1])) - 0.1)
  const rows = [
    [cuts[0], a, cuts[5], underline.y],
    [cuts[0], underline.y, cuts[5], b],
    ...numeric.map((_, n) => [cuts[0], ys[n], cuts[5], ys[n + 1] ?? z])
  ]
  const spans = [
    { row: 0, column: 2, rowSpan: 1, colSpan: 2 },
    ...[0, 1, 4].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 }))
  ]
  const groups = [upper, lower]
  for (let k = 0; k < totals.length; k++) {
    const start = totals[k],
      end = totals[k + 1] ?? numeric.length
    if (
      end - start < 4 ||
      values
        .slice(start + 1, end)
        .some(
          (v, n) =>
            !v[1] || (n > 0 && Number(v[1]) <= Number(values[start + n][1])) || (n > 0 && v[4])
        )
    )
      return
    const summary = body.filter((i) => i.rect[1] >= ys[start] && i.rect[3] < ys[start + 1])
    const labels = body.filter(
      (i) => col(i) === 0 && i.rect[1] >= ys[start + 1] && i.rect[3] < (ys[end] ?? z)
    )
    const summaryLabels = summary.filter((i) => col(i) === 0)
    if (
      summaryLabels.length < 2 ||
      !/^Total\b/.test(summaryLabels[0].text) ||
      labels.length < 2 ||
      !/^\p{Lu}/u.test(labels[0].text) ||
      labels.slice(1).some((i) => !/^\p{Ll}/u.test(i.text) && !/^[A-Z]{2,}\b/.test(i.text)) ||
      [...summaryLabels, ...labels].some(
        (i) => Math.abs(i.rect[0] - cuts[0]) > 1 || i.rect[2] > cuts[1]
      ) ||
      Math.abs(labels[0].baseline - numeric[start + 1][0].baseline) > labels[0].height * 0.3
    )
      return
    groups.push(summary, ...numeric.slice(start + 1, end), labels)
    spans.push({ row: start + 3, column: 0, rowSpan: end - start - 1, colSpan: 1 })
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], a, x, z]),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Restore only source-backed header fragments. A confidence suffix establishes
// a same-column measure; a comparison must repeat both neighboring arm names.
// An independent single-column heading instead requires its own native frame.
export function recoverClippedHeading({
  rows,
  objects,
  groups,
  columnRects,
  rules,
  repairs,
  captioned = true
}) {
  if (!rows.length || !groups[0]?.length) return
  const leading = groups[0]
  const bounds = (items) => [
    Math.min(...items.map((i) => i.rect[0])),
    Math.min(...items.map((i) => i.rect[1])),
    Math.max(...items.map((i) => i.rect[2])),
    Math.max(...items.map((i) => i.rect[3]))
  ]
  const contains = (rect, item) => item.rect.every((v, n) => (n < 2 ? v >= rect[n] : v <= rect[n]))
  const columnOf = (item) => columnRects.findIndex((r) => contains(r, item))
  const rect = bounds(leading)
  const height = Math.max(...leading.map((i) => i.height))
  const next = groups[1] ?? []
  const first = rows[0].rect
  const column = columnOf(leading[0])
  const leadingColumns = new Set(leading.map(columnOf).filter((value) => value >= 0))
  // Expanding a row is safe only when it already contains the final line of
  // one wrapped heading. An independent header above a data row needs its own row.
  const tails = groups
    .slice(1)
    .flat()
    .filter((item) => item.rect[3] <= first[3])
  const tailColumn = tails.length ? columnOf(tails[0]) : -1
  const ruledHeader = objects.find(
    (o) =>
      o.label === 'table column header' &&
      Math.abs(o.rect[1] - first[1]) < height &&
      Math.abs(o.rect[3] - first[3]) < height &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= rect[1] &&
          rect[1] - r[1] < height &&
          r[0] <= rect[0] &&
          r[2] >= rect[2]
      ) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[1] - o.rect[3]) < height * 0.3 &&
          r[0] <= rect[0] &&
          r[2] >= rect[2]
      )
  )
  const multiColumnHeading =
    rect[1] < first[1] &&
    first[1] - rect[1] <= height * 2.5 &&
    leading.length >= 3 &&
    leadingColumns.size >= 3 &&
    leading.filter((item) => /\p{L}/u.test(item.text)).length >= 3 &&
    leading.every(
      (item) =>
        /\p{L}/u.test(item.text) ||
        leading.some((anchor) => /\p{L}/u.test(anchor.text) && isAdjacentTableScript(item, anchor))
    ) &&
    tails.length >= 2 &&
    tailColumn >= 0 &&
    leadingColumns.has(tailColumn) &&
    tails.every(
      (item) =>
        /\p{L}/u.test(item.text) &&
        (columnOf(item) === tailColumn || (ruledHeader && leadingColumns.has(columnOf(item))))
    ) &&
    tails.some((item) => item.rect[3] >= first[1]) &&
    !rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] > rect[3] &&
        rule[1] < first[1] &&
        rule[0] <= rect[0] &&
        rule[2] >= rect[2]
    )
  if (multiColumnHeading && (captioned || ruledHeader)) {
    first[1] = rect[1]
    repairs.push('clipped-multicolumn-heading-recovered')
    return
  }
  if (!captioned) return
  if (rect[1] >= first[1] || first[1] - rect[1] > height * 2 + 0.1) return
  // A labelled stub can be the only ink in the first ruled header band.
  // Two complete native boundaries distinguish it from an unruled section
  // label; the model need not have predicted a column-header object.
  if (
    column === 0 &&
    leading.every((i) => columnOf(i) === 0) &&
    /^(?:Characteristics?|Variables?|Parameters?|Outcomes?)$/i.test(
      leading
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
  ) {
    const width = columnRects.at(-1)[2] - columnRects[0][0]
    const edges = rules.filter((r) => r[1] === r[3] && r[2] - r[0] > width * 0.9)
    if (
      edges.some((r) => r[1] <= rect[1] && rect[1] - r[1] < height) &&
      edges.some((r) => r[1] >= rect[3] && r[1] <= first[1] && r[1] - rect[3] < height)
    ) {
      rows.unshift({
        rect: [columnRects[0][0], rect[1], columnRects.at(-1)[2], rect[3]],
        origin: 'source-header'
      })
      repairs.push('clipped-first-header-recovered')
      return
    }
  }
  if (column < 1 || !leading.every((i) => columnOf(i) === column)) return
  const text = leading.map((i) => i.text.trim()).join(' ')
  if (!/\p{L}/u.test(text)) return
  const suffix = next.filter((i) => columnOf(i) === column)
  const header = objects.find(
    (o) =>
      o.label === 'table column header' &&
      suffix.length &&
      suffix.every((i) => i.rect[1] >= o.rect[1] - height * 0.2 && i.rect[3] <= o.rect[3])
  )
  // A tall, left-aligned header may begin above all model rows while its
  // lower lines share the neighboring two-tier header. Native child underlines
  // and complete textual peers establish the header's extent.
  const wrappedHeader =
    header ??
    objects.find(
      (o) => o.label === 'table column header' && o.rect[1] <= first[3] && o.rect[3] >= first[3]
    )
  if (wrappedHeader && rows.length >= 3) {
    const prefix = groups
      .flat()
      .filter(
        (i) => columnOf(i) === column && i.rect[1] >= rect[1] && i.rect[3] <= wrappedHeader.rect[3]
      )
    const peers = groups
      .flat()
      .filter(
        (i) => columnOf(i) !== column && i.rect[1] >= first[1] && i.rect[3] <= wrappedHeader.rect[3]
      )
    const headerRows = rows.filter((r) => r.rect[1] < wrappedHeader.rect[3] - height * 0.2)
    if (
      prefix.length >= 3 &&
      prefix.length <= 5 &&
      headerRows.length === 2 &&
      prefix.every((i) => /\p{L}/u.test(i.text) && Math.abs(i.rect[0] - rect[0]) < 1) &&
      prefix
        .slice(1)
        .every(
          (i, n) =>
            i.baseline - prefix[n].baseline > height * 0.8 &&
            i.baseline - prefix[n].baseline < height * 1.6
        ) &&
      new Set(peers.filter((i) => /\p{L}/u.test(i.text)).map(columnOf)).size >= 3 &&
      !peers.some((i) => /^\d/.test(i.text)) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > first[1] &&
          r[1] < wrappedHeader.rect[3] &&
          r[0] >= columnRects[0][0] &&
          r[2] < columnRects[column][0] &&
          r[2] - r[0] > height * 4
      )
    ) {
      first[1] = rect[1]
      wrappedHeader.rect[1] = Math.min(wrappedHeader.rect[1], rect[1])
      repairs.push('clipped-wrapped-heading-recovered')
      return {
        column,
        rect: [columnRects[column][0], rect[1], columnRects[column][2], headerRows[1].rect[3]]
      }
    }
  }
  const sampleLine =
    groups
      .slice(2, 4)
      .find((g) => g.some((i) => columnOf(i) === column && /^[Nn]$/.test(i.text))) ?? []
  const sample = sampleLine.filter((i) => columnOf(i) === column)
  const sampledGroup =
    suffix.length === 1 &&
    /^[\p{L} ,.-]+$/u.test(suffix[0].text) &&
    Math.abs((suffix[0].rect[0] + suffix[0].rect[2]) / 2 - (rect[0] + rect[2]) / 2) <
      height * 0.25 &&
    /^[Nn]\s*=\s*\d+$/.test(sample.map((i) => i.text).join(' ')) &&
    sample.every(
      (i) =>
        i.baseline - suffix[0].baseline > height * 0.8 &&
        i.baseline - suffix[0].baseline < height * 1.6
    ) &&
    sampleLine.some((i) => columnOf(i) !== column && /^[Nn]$/.test(i.text))
  const confidence =
    suffix.length === 1 &&
    /^\((?:90|95|99)% CI\)$/.test(suffix[0].text.trim()) &&
    Math.abs(suffix[0].rect[0] - rect[0]) < 1
  const parents = next.filter((i) => columnOf(i) !== column && /\p{L}/u.test(i.text))
  const comparison =
    suffix.length === 1 &&
    parents.length === 2 &&
    `${text} ${suffix[0].text.trim()}` ===
      `${parents[0].text.trim()} vs. ${parents[1].text.trim()}` &&
    Math.abs(suffix[0].rect[0] + suffix[0].rect[2] - rect[0] - rect[2]) < height * 0.1 &&
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > suffix[0].rect[3] &&
        r[1] - suffix[0].rect[3] < height &&
        r[0] <= rect[0] &&
        r[2] >= rect[2]
    )
  if (
    leading.length === 1 &&
    first[1] - rect[1] < height * 1.6 &&
    header &&
    (confidence || comparison || sampledGroup) &&
    suffix[0].baseline - leading[0].baseline > height * 0.8 &&
    suffix[0].baseline - leading[0].baseline < height * 1.6 &&
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > rect[3] &&
        r[1] < suffix[0].rect[1] &&
        r[0] <= rect[0] &&
        r[2] >= rect[2]
    )
  ) {
    first[1] = rect[1]
    header.rect[1] = Math.min(header.rect[1], rect[1])
    repairs.push('clipped-wrapped-heading-recovered')
    return
  }
  if (
    columnRects.length !== 2 ||
    rows.length < 4 ||
    rect[3] >= first[1] ||
    next.length !== 2 ||
    columnOf(next[0]) !== 0 ||
    columnOf(next[1]) !== 1 ||
    !/\p{L}/u.test(next[0].text) ||
    !/^\d+(?:\.\d+)?$/.test(next[1].text.trim()) ||
    leading.some((i) => Math.abs(i.baseline - leading[0].baseline) > height * 0.35)
  )
    return
  const fullRules = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - columnRects[0][0]) < 8 &&
      r[2] >= columnRects[1][2] - 8 &&
      r[2] - r[0] <= (columnRects[1][2] - columnRects[0][0]) * 1.2
  )
  const upper = fullRules.find((r) => r[1] <= rect[1] && rect[1] - r[1] < height * 0.5)
  const lower = fullRules.find(
    (r) => r[1] >= rect[3] && r[1] < next[0].rect[1] && r[1] - rect[3] < height * 0.5
  )
  if (
    !upper ||
    !lower ||
    Math.abs(upper[0] - lower[0]) > 0.1 ||
    Math.abs(upper[2] - lower[2]) > 0.1
  )
    return
  rows.unshift({ rect: [first[0], upper[1], first[2], lower[1]], origin: 'source-native-header' })
  repairs.push('ruled-isolated-heading-recovered')
}

// A detector can clip the glyph tops of an entire leading column header.
// One aligned label per column plus a full native underline establishes the
// missing row, including untitled resource-table continuations.
export function recoverClippedColumnHeader(table, items, rules, captions = []) {
  const crop = table.cropRect
  // An open-top header still has native vertical faces. Two sample headings
  // and a test column identify the header; common endpoints bound it without
  // inventing a horizontal stroke or extending through adjacent prose.
  const edges = rules
    .filter(
      (r) =>
        r[0] === r[2] &&
        r[0] >= crop[0] - 15 &&
        r[0] <= crop[2] + 20 &&
        r[1] >= crop[1] &&
        r[1] < crop[1] + 20 &&
        r[3] < crop[3]
    )
    .sort((a, b) => a[0] - b[0])
  if (
    edges.length >= 4 &&
    edges.length <= 8 &&
    edges.every((r) => Math.abs(r[1] - edges[0][1]) < 0.1 && Math.abs(r[3] - edges[0][3]) < 0.1)
  ) {
    const [left, top, , bottom] = edges[0],
      right = edges.at(-1)[0]
    const header = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
    const text = header.map((i) => i.text).join(' ')
    const nativeFaces = edges
      .slice(1)
      .map((r, c) => header.filter((i) => i.rect[0] >= edges[c][0] && i.rect[2] <= r[0]))
    if (
      right > crop[2] &&
      right - crop[2] < 20 &&
      (text.match(/n\s*=\s*\d+/g) ?? []).length === 2 &&
      /P\s*-?\s*value/i.test(text) &&
      nativeFaces.every((g) => g.some((i) => /\p{L}/u.test(i.text))) &&
      nativeFaces.flat().length === header.length
    ) {
      const modelColumns = table.structure.objects.filter((o) => o.label === 'table column')
      const spans = edges.slice(1).flatMap((r, c) =>
        modelColumns.filter((o) => {
          const center = crop[0] + (o.rect[0] + o.rect[2]) / 2
          return center > edges[c][0] && center < r[0]
        }).length > 1
          ? [[edges[c][0], top, r[0], bottom]]
          : []
      )
      const stubEdges = [
        ...new Set(
          rules
            .filter(
              (r) =>
                r[0] === r[2] &&
                r[0] > left + 2 &&
                r[0] < edges[1][0] - 2 &&
                r[1] >= bottom - 1 &&
                r[3] <= crop[3]
            )
            .map((r) => r[0])
        )
      ]
      if (spans[0]?.[0] === left && stubEdges.length === 1) {
        const stubRight = stubEdges[0]
        const horizontal = rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] > bottom &&
            r[1] <= crop[3] &&
            r[0] <= left + 1 &&
            r[2] >= stubRight - 1
        )
        const ys = [bottom, ...new Set(horizontal.map((r) => r[1]))].sort((a, b) => a - b)
        const vertical = rules.filter((r) => r[0] === r[2])
        for (let n = 1; n < ys.length; n++) {
          const a = ys[n - 1],
            b = ys[n]
          const label = items.filter(
            (i) => i.rect[0] >= left && i.rect[2] <= stubRight && i.rect[1] >= a && i.rect[3] <= b
          )
          const separators = rules.filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > a + 1 &&
              r[1] < b - 1 &&
              r[0] >= stubRight - 1 &&
              r[0] < stubRight + 1 &&
              r[2] >= edges[1][0] - 1
          )
          if (
            label.length === 1 &&
            /^\d+$/.test(label[0].text) &&
            separators.length >= 1 &&
            [left, stubRight].every((x) => classifyTableRuleEdge(vertical, 0, x, a, b) === 1)
          )
            spans.push([left, a, stubRight, b])
        }
      }
      return {
        cropRect: [Math.min(crop[0], left), crop[1], right + 1, crop[3]],
        rect: [left, top, right, bottom],
        spans
      }
    }
  }

  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  const rows = table.structure.objects
    .filter((o) => o.label === 'table row')
    .sort((a, b) => a.rect[1] - b.rect[1])
  // A printed continuation and multiple independently underlined parent
  // headings establish a clipped multi-level header above the detector crop.
  if (
    columns.length >= 5 &&
    rows.length >= 6 &&
    items.some(
      (i) =>
        /^\(Table\s+\d+\s+continues on next page\)$/i.test(i.text.trim()) &&
        i.rect[1] > crop[1] &&
        i.rect[3] <= crop[3] + i.height
    )
  ) {
    const underlines = joinHorizontalTableRules(rules).filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] - crop[1] < 24 &&
        r[0] >= crop[0] &&
        r[2] <= crop[2] &&
        r[2] - r[0] > (crop[2] - crop[0]) * 0.2 &&
        r[2] - r[0] < (crop[2] - crop[0]) * 0.5
    )
    if (
      underlines.length >= 2 &&
      underlines.every(
        (r, n) =>
          Math.abs(r[1] - underlines[0][1]) < 1 &&
          underlines.slice(0, n).every((p) => r[0] >= p[2] || p[0] >= r[2])
      )
    ) {
      const bottom = underlines[0][1]
      const parents = underlines.map((r) =>
        items.filter(
          (i) =>
            i.horizontal &&
            i.rect[0] >= r[0] &&
            i.rect[2] <= r[2] &&
            i.rect[3] < bottom &&
            i.rect[1] >= bottom - i.height * 4.5
        )
      )
      const leaves = underlines.map((r) =>
        items.filter(
          (i) =>
            i.horizontal &&
            i.rect[0] >= r[0] &&
            i.rect[2] <= r[2] &&
            i.rect[1] > bottom &&
            i.rect[3] <= bottom + i.height * 2
        )
      )
      if (
        parents.every((g) => g.length && g.every((i) => /\p{L}/u.test(i.text))) &&
        leaves.every((g) => g.filter((i) => /\p{L}/u.test(i.text)).length >= 2) &&
        parents.flat().some((i) => i.rect[1] < crop[1])
      ) {
        const top = Math.min(...parents.flat().map((i) => i.rect[1])) - 1
        if (!captions.some((c) => c.rect[3] > top && c.rect[1] < bottom))
          return {
            cropRect: [crop[0], top, crop[2], crop[3]],
            rect: [crop[0], top, crop[2], bottom],
            spans: underlines.map((r) => [r[0], top, r[2], bottom])
          }
      }
    }
  }
  // An unboxed prose-table header can extend beyond a crop fitted to short
  // body values. Repeated native body borders and both aligned column labels
  // bound the missing header independently of the detector's right edge.
  if (
    columns.length === 2 &&
    rows.length >= 3 &&
    captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= crop[1] + 4 &&
        crop[1] - c.rect[3] < 40 &&
        c.rect[0] < crop[2] &&
        c.rect[2] > crop[0]
    )
  ) {
    const first = crop[1] + rows[0].rect[1]
    const split = crop[0] + (columns[0].rect[2] + columns[1].rect[0]) / 2
    const horizontal = joinHorizontalTableRules(rules)
    for (const border of horizontal.filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < 8 &&
        r[2] >= crop[2] &&
        r[2] - crop[2] < (crop[2] - crop[0]) * 0.15 &&
        r[1] < first &&
        first - r[1] < 12
    )) {
      const heading = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= border[0] &&
          i.rect[2] <= border[2] &&
          i.rect[1] >= crop[1] &&
          i.rect[3] < border[1]
      )
      if (
        heading.length !== 2 ||
        !heading.every((i) => /\p{L}/u.test(i.text)) ||
        Math.abs(heading[0].baseline - heading[1].baseline) >
          Math.min(...heading.map((i) => i.height)) * 0.2
      )
        continue
      const labels = heading.slice().sort((a, b) => a.rect[0] - b.rect[0])
      if (
        labels[0].rect[2] >= split ||
        labels[1].rect[0] <= split ||
        border[1] - Math.min(...heading.map((i) => i.rect[1])) > labels[0].height * 2
      )
        continue
      if (
        horizontal.filter(
          (r) =>
            r[1] > border[1] &&
            r[1] < crop[3] &&
            Math.abs(r[0] - border[0]) < 1 &&
            Math.abs(r[2] - border[2]) < 1
        ).length < 3
      )
        continue
      if (
        labels.some(
          (label) =>
            items.filter(
              (i) =>
                i.horizontal &&
                i.rect[1] > border[1] &&
                i.rect[3] <= crop[3] &&
                Math.abs(i.rect[0] - label.rect[0]) < 1
            ).length < 3
        )
      )
        continue
      return {
        cropRect: [crop[0], crop[1], border[2] + 1, crop[3]],
        rect: [crop[0], Math.min(...heading.map((i) => i.rect[1])), border[2] + 1, border[1]]
      }
    }
  }
  // A detector may omit the whole header, including multiple wrapped lines
  // above empty stub columns. Matching full-width native rules establish its
  // own row; do not append these labels to the first data record.
  if (columns.length >= 2 && rows.length >= 3) {
    const first = crop[1] + rows[0].rect[1]
    const borders = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) <= 16 &&
        Math.abs(r[2] - crop[2]) <= 16 &&
        r[1] >= crop[1] - 4 &&
        r[1] <= first + 16
    )
    for (const upper of borders) {
      const divider = borders.find((r) => r[1] > upper[1] + 8 && r[1] >= first - 16)
      if (!divider) continue
      const header = items.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= upper[0] - 1 &&
          i.rect[2] <= upper[2] + 1 &&
          i.rect[1] >= upper[1] &&
          i.rect[3] <= Math.min(first, divider[1])
      )
      if (header.length < 2 || header.some((i) => /[.!?]$/u.test(i.text.trim()))) continue
      const groups = columns.map((column) =>
        header.filter((i) => {
          const center = (i.rect[0] + i.rect[2]) / 2 - crop[0]
          return center >= column.rect[0] && center <= column.rect[2]
        })
      )
      if (
        (columns.length > 2 && (groups[0].length || groups[1].length)) ||
        groups.filter((g) => g.some((i) => /\p{L}/u.test(i.text))).length < 2 ||
        groups.flat().length !== header.length ||
        table.structure.objects.some(
          (o) =>
            o.label === 'table column header' &&
            o.rect[1] + crop[1] <= Math.min(...header.map((i) => i.rect[1]))
        )
      )
        continue
      return {
        cropRect: crop,
        rect: [crop[0], upper[1], crop[2], Math.min(first, divider[1])]
      }
    }
  }
  // A continuation can omit the caption and the model's entire spanning header.
  // Matching native borders establish that header independently of its wording.
  if (columns.length >= 2 && rows.length >= 3) {
    const first = crop[1] + rows[0].rect[1]
    const leading = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] &&
        i.rect[1] >= crop[1] - i.height &&
        i.rect[3] < first
    )
    if (leading.length === 1 && /\p{L}/u.test(leading[0].text)) {
      const item = leading[0]
      const upper = rules.find(
        (r) =>
          r[1] === r[3] &&
          r[1] <= item.rect[1] &&
          item.rect[1] - r[1] < item.height &&
          Math.abs(r[0] - crop[0]) < item.height * 1.5 &&
          Math.abs(r[2] - crop[2]) < item.height * 2 &&
          r[0] <= item.rect[0] &&
          r[2] >= item.rect[2]
      )
      const divider =
        upper &&
        rules.find(
          (r) =>
            r[1] === r[3] &&
            r[1] > item.rect[3] &&
            Math.abs(r[1] - first) < item.height * 0.25 &&
            Math.abs(r[0] - upper[0]) < 0.1 &&
            Math.abs(r[2] - upper[2]) < 0.1
        )
      const lower =
        upper &&
        rules.find(
          (r) =>
            r[1] === r[3] &&
            r[1] >= crop[1] + rows.at(-1).rect[3] &&
            Math.abs(r[1] - crop[3]) < item.height &&
            Math.abs(r[0] - upper[0]) < 0.1 &&
            Math.abs(r[2] - upper[2]) < 0.1
        )
      if (divider && lower) {
        const rect = [upper[0], upper[1], upper[2], divider[1]]
        return {
          cropRect: [
            Math.min(crop[0], upper[0]),
            Math.min(crop[1], upper[1]),
            Math.max(crop[2], upper[2]),
            Math.max(crop[3], lower[1])
          ],
          rect,
          spans: [rect]
        }
      }
    }
  }
  if (columns.length < 3 || columns.length > 10 || rows.length < 3) return
  const first = crop[1] + rows[0].rect[1]
  const leading = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.rect[1] >= crop[1] - i.height * 0.5 &&
      i.rect[3] <= first &&
      i.rect[1] <= crop[1] + i.height * 0.5
  )
  if (
    leading.length !== columns.length ||
    !leading.some((i) => i.rect[1] < crop[1]) ||
    leading.some(
      (i) =>
        !/\p{L}/u.test(i.text) ||
        /[\d.;:]/.test(i.text) ||
        Math.abs(i.baseline - leading[0].baseline) > leading[0].height * 0.2
    )
  )
    return
  const cuts = [
    crop[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  leading.sort((a, b) => a.rect[0] - b.rect[0])
  if (leading.some((i, n) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])) return
  const glyphBottom = Math.max(...leading.map((i) => i.rect[3]))
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] > glyphBottom &&
      r[1] < first &&
      r[1] - glyphBottom < leading[0].height &&
      Math.abs(r[0] - crop[0]) < 12 &&
      Math.abs(r[2] - crop[2]) < 12
  )
  if (!divider) return
  const top = Math.min(...leading.map((i) => i.rect[1])) - 1
  return { cropRect: [crop[0], top, crop[2], crop[3]], rect: [crop[0], top, crop[2], divider[1]] }
}

// Repeated indented count categories establish native rows independently of
// gaps in the model. Section labels carry no value; do not fill them down.
export function recoverCountedCategoryGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 2) return
  const cuts = [left, left + (predicted[0].rect[2] + predicted[1].rect[0]) / 2, right]
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 10) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const sections = values.flatMap((v, n) => (/\p{L}.*[,;]n\(%\)$/u.test(v[0]) && !v[1] ? [n] : []))
  if (sections.length < 3) return
  const count = (v) => /^\d+\(\d+(?:\.\d+)?%\)$/.test(v)
  if (values.filter((v) => count(v[1])).length < 8) return
  const indent = Math.min(...sections.map((n) => groups[n][0].rect[0]))
  for (const [n, v] of values.entries()) {
    if (!v[0] || !/\p{L}|\d/u.test(v[0])) return
    if (sections.includes(n)) {
      if (Math.abs(groups[n][0].rect[0] - indent) > 1 || !count(values[n + 1]?.[1] ?? '')) return
    } else if (!count(v[1])) {
      if (!/[,;]M\(SD\)$/.test(v[0]) || !/^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(v[1])) return
    } else if (
      groups[n][0].rect[0] - indent < height * 0.5 ||
      groups[n][0].rect[0] - indent > height * 1.5
    )
      return
  }
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const borders = rules.filter((r) => r[1] === r[3] && r[0] <= left + 4 && r[2] >= right - 4)
  if (
    !borders.some((r) => r[1] >= top && r[1] < bounds[0][1]) ||
    !borders.some((r) => r[1] > bounds.at(-1)[3] && r[1] <= bottom)
  )
    return
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    headerRows: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Dense baseline summaries have a ruled header, repeated numeric records and
// outdented category labels. Reconstruct those records from native baselines,
// including labels wrapped within one record, before accepting model merges.
export function recoverRuledComparisonRecords(table, items, captions, rules) {
  const paired = recoverPairedCountRecords(table, items, captions, rules)
  if (paired) return paired
  const summaries = recoverPairedCountSummaries(table, items, captions, rules)
  if (summaries) return summaries
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
    .filter(
      (c, n, all) =>
        !all
          .slice(0, n)
          .some(
            (p) =>
              (Math.min(p.rect[2], c.rect[2]) - Math.max(p.rect[0], c.rect[0])) /
                Math.max(p.rect[2] - p.rect[0], c.rect[2] - c.rect[0]) >
              0.9
          )
    )
  if (
    predicted.length < 3 ||
    predicted.length > 12 ||
    !captions.some((c) => captionKind(c.lines[0]) === 'table')
  )
    return
  const joined = []
  for (const r of rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = joined.at(-1)
    if (previous && Math.abs(previous[1] - r[1]) < 0.5 && r[0] <= previous[2] + 0.01) {
      previous[0] = Math.min(previous[0], r[0])
      previous[2] = Math.max(previous[2], r[2])
    } else joined.push([...r])
  }
  const borders = joined
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < 16 &&
        r[1] >= crop[1] - 16 &&
        r[1] <= crop[3] + 16
    )
    .sort((a, b) => a[1] - b[1])
  if (![3, 4].includes(borders.length)) return
  const upper = borders[0],
    divider = borders.at(-2),
    lower = borders.at(-1)
  let tier = borders.length === 4 ? borders[1] : undefined
  if (divider[1] - upper[1] > 80 || lower[1] - divider[1] < 70) return
  const left = Math.min(crop[0], upper[0]),
    right = Math.max(crop[2], upper[2]),
    top = upper[1],
    bottom = lower[1]
  const source = tableSourceItems(items, [left, top, right, bottom])
  const body = source.filter((i) => i.rect[1] >= divider[1])
  if (!body.length) return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  // A close double rule with no text between its strokes is decoration, not
  // a parent-header tier. Keep the full border for cropping and text ownership.
  if (
    tier &&
    tier[1] - upper[1] < height * 0.5 &&
    !source.some(
      (i) => (i.rect[1] + i.rect[3]) / 2 < tier[1] && (i.rect[1] + i.rect[3]) / 2 > upper[1]
    )
  )
    tier = undefined
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  // A detector can combine adjacent narrow scalar columns. Separate them
  // only when independent short headers and repeated pairs of native values
  // agree on one empty gutter; never split a text run by character count.
  for (let c = cuts.length - 2; c > 0; c--) {
    const head = source
      .filter((i) => i.rect[3] <= divider[1] && i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      head.length !== 2 ||
      head.some((i) => !/^[A-Za-z]{1,4}$/.test(i.text.trim())) ||
      Math.abs(head[0].baseline - head[1].baseline) > height * 0.2 ||
      head[1].rect[0] - head[0].rect[2] < height * 2
    )
      continue
    const middle = (head[0].rect[2] + head[1].rect[0]) / 2
    const pairs = groups
      .map((g) => g.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
      .filter((g) => g.length)
    if (
      pairs.length < 3 ||
      pairs.some(
        (g) =>
          g.length !== 2 ||
          g.some((i) => !/^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(i.text.trim())) ||
          g.filter((i) => i.rect[2] < middle).length !== 1 ||
          g.filter((i) => i.rect[0] > middle).length !== 1
      )
    )
      continue
    const band = source.filter((i) => i.rect[0] < cuts[c + 1] && i.rect[2] > cuts[c])
    if (band.some((i) => i.rect[0] < middle && i.rect[2] > middle)) continue
    cuts.splice(c + 1, 0, middle)
  }
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  // Move a predicted cut only within an empty source gutter. A run crossing
  // every possible cut is ambiguous and must not be split by character count.
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (end > cuts[c] || start < cuts[c]) cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v)) return
  const numeric = (v) =>
    /^(?:(?:n=)?[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%/±–−+*a-z=<>≤≥-]*|\((?:n=)?[\d.−–%-]+\)|[–—-][*†‡]?)$/i.test(
      v
    )
  const records = values.filter((v) => v[0] && v.slice(1).filter(numeric).length >= 2)
  if (records.length < 5) return
  const indent = Math.min(...body.filter((i) => col(i) === 0).map((i) => i.rect[0]))
  const sections = values.flatMap((v, n) =>
    v[0] &&
    /^(?:\p{Lu}|\d+[- ]day)/u.test(v[0]) &&
    !v[1] &&
    Math.abs(Math.min(...groups[n].filter((i) => col(i) === 0).map((i) => i.rect[0])) - indent) < 1
      ? [n]
      : []
  )
  if (
    (sections.length < 2 && records.some((v) => v.slice(1).some((s) => !s))) ||
    sections.some((n) => /^[a-z]\./.test(values[n][0])) ||
    groups.some((g) =>
      /\s\d+(?:\.\d+)?\s\d+(?:\.\d+)?(?:\s\d+(?:\.\d+)?)?$/.test(
        g
          .filter((i) => col(i) === 0)
          .map((i) => i.text)
          .join(' ')
      )
    )
  )
    return
  const owned = [],
    isSection = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      v = values[n],
      stub = g.filter((i) => col(i) === 0),
      data = v.slice(1).some(Boolean)
    if (!v[0] || v.slice(1).some((s) => s && !numeric(s) && !/^(?:[χv]2|t)=.*p=/.test(s))) return
    const x = Math.min(...stub.map((i) => i.rect[0]))
    if (!data && owned.length && !sections.includes(n)) {
      const previous = owned.at(-1),
        label = previous.filter((i) => col(i) === 0),
        bounds = union(previous)
      if (
        !label.length ||
        g[0].baseline - Math.max(...previous.map((i) => i.baseline)) > height * 1.7 ||
        x < Math.min(...label.map((i) => i.rect[0])) - 1
      )
        return
      // A label-only numeric category is a real record, never a continuation.
      if (
        (!/\p{L}/u.test(v[0]) && !/^[%)]+$/.test(v[0])) ||
        /^[<>≤≥]/.test(v[0]) ||
        /\s\d+\s+\d+$/.test(stub.map((i) => i.text).join(' '))
      )
        return
      if (union(g)[1] < bounds[3] - height * 0.15) return
      previous.push(...g)
    } else {
      owned.push([...g])
      isSection.push(sections.includes(n))
    }
  }
  const header = source.filter((i) => i.rect[3] <= divider[1]),
    bounds = owned.map(union)
  if (
    !header.length ||
    !hasUniqueRecordTokens(source, [header, ...owned]) ||
    bounds.some((r, n) => n && r[1] < bounds[n - 1][3] - height * 0.01) ||
    // Only complete numeric records justify relaxing the font-box boundary.
    // Sparse sections and partial records still need separate wrapping evidence.
    (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) &&
      records.some((v) => v.slice(1).some((s) => !s)))
  )
    return
  // Font em boxes can touch or overlap by a rounding fraction even though
  // native baselines establish distinct records. Share that boundary only;
  // never change token geometry or tolerate substantive line overlap.
  for (let n = 1; n < bounds.length; n++) {
    if (bounds[n][1] <= bounds[n - 1][3]) {
      const cut = (bounds[n][1] + bounds[n - 1][3]) / 2
      bounds[n][1] = cut
      bounds[n - 1][3] = cut
    }
  }
  const headRows = [[left, top, right, divider[1]]],
    spans = []
  const underlines = rules.filter(
    (r) =>
      !borders.some(
        (b) => Math.abs(b[1] - r[1]) < 0.5 && r[0] >= b[0] - 0.01 && r[2] <= b[2] + 0.01
      ) &&
      r[1] === r[3] &&
      r[1] > top &&
      r[1] < divider[1] &&
      r[0] > left &&
      r[2] < right
  )
  // Repeated value/(SD or %) records establish paired columns even without a
  // second header tier. Require a complete sample-qualified heading for each
  // pair and a separate P-value column before joining any header slots.
  if (!tier && !underlines.length && predicted.length === 6) {
    const parentValues = readSourceRow(header, [left, cuts[1], cuts[3], cuts[5], right], {
      multiline: true
    })
    if (
      parentValues &&
      !parentValues[0] &&
      /^P-?value$/i.test(parentValues[3]) &&
      parentValues.slice(1, 3).every((s) => /\p{L}.*\(n=\d+\)$/u.test(s)) &&
      records.length >= 6 &&
      records.every((v) =>
        [1, 3].every((c) => /^\d+(?:\.\d+)?$/.test(v[c]) && /^\(\d+(?:\.\d+)?%?\)$/.test(v[c + 1]))
      )
    ) {
      for (const column of [1, 3]) spans.push({ row: 0, column, rowSpan: 1, colSpan: 2 })
    }
  }
  if (tier) {
    if (underlines.length || predicted.length % 2 !== 1) return
    const parents = header.filter((i) => i.rect[3] < tier[1]),
      children = header.filter((i) => i.rect[1] > tier[1])
    if (!hasUniqueRecordTokens(header, [parents, children])) return
    const values = readSourceRow(children, cuts)
    if (
      !values ||
      values[0] ||
      values.slice(1).some((v, n) => (n % 2 === 0 ? v !== 'Numberofpatients' : v !== '(%)'))
    )
      return
    if (
      parents.some(
        (i) =>
          col(i) > 0 &&
          (i.rect[0] < cuts[1 + 2 * Math.floor((col(i) - 1) / 2)] ||
            i.rect[2] > cuts[3 + 2 * Math.floor((col(i) - 1) / 2)])
      )
    )
      return
    headRows.splice(0, 1, [left, top, right, tier[1]], [left, tier[1], right, divider[1]])
    for (let c = 1; c < predicted.length; c += 2)
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
    for (const [n, g] of owned.entries())
      if (/^Median\(range\)$/.test(readSourceRow(g, cuts)?.[0] ?? ''))
        for (let c = 1; c < predicted.length; c += 2)
          spans.push({ row: n + 2, column: c, rowSpan: 1, colSpan: 2 })
  }
  if (underlines.length) {
    if (underlines.length !== 1) return
    const line = underlines[0],
      parent = header.filter((i) => i.rect[3] <= line[1]),
      children = header.filter((i) => i.rect[1] >= line[1])
    if (!parent.length || !children.length || !hasUniqueRecordTokens(header, [parent, children]))
      return
    const cols = cuts
      .slice(1)
      .flatMap((x, c) =>
        children.some(
          (i) => col(i) === c && i.rect[0] >= line[0] - 2 && i.rect[2] <= line[2] + height * 4
        )
          ? [c]
          : []
      )
    if (
      cols.length !== 2 ||
      cols[1] !== cols[0] + 1 ||
      parent.some((i) => i.rect[0] < cuts[cols[0]] || i.rect[2] > cuts[cols[1] + 1])
    )
      return
    headRows.splice(0, 1, [left, top, right, line[1]], [left, line[1], right, divider[1]])
    spans.push({ row: 0, column: cols[0], rowSpan: 1, colSpan: 2 })
  }
  return {
    cropRect: [left, top, right, bottom],
    rows: [...headRows, ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      ...spans,
      ...owned.flatMap((g, n) =>
        isSection[n] && g.every((i) => col(i) === 0)
          ? [{ row: n + headRows.length, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }]
          : []
      )
    ],
    completeSpans: true,
    headerRows: headRows.map((_, n) => n),
    ownedTokens: new Set(source),
    repair: 'source-record-boundary-comparison-recovered'
  }
}

// Repeated No./% baselines establish complete cohort records independently of
// missing or overlapping model rows. Native header rules establish the parent;
// trailing statistics retain their printed row rather than an inferred span.
function recoverPairedCountRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 4 || predicted.length > 12) return
  const initial = tableSourceItems(items, table.cropRect)
  const heights = initial.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return
  const frame = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < height * 2 &&
      Math.abs(r[2] - right) < height * 2 &&
      r[1] >= top - height &&
      r[1] <= bottom + height
  )
  if (frame.length !== 3 || frame[1][1] - frame[0][1] > height * 8) return
  const source = tableSourceItems(items, [left, frame[0][1], right, frame[2][1]])
  const header = source.filter((i) => i.rect[3] < frame[1][1])
  const cue = source.at(-1)
  const continuation =
    cue &&
    /^\(continued in next column\)$/i.test(cue.text.trim()) &&
    frame[2][1] - cue.rect[3] < height &&
    Math.abs(cue.rect[0] + cue.rect[2] - left - right) < height * 2
      ? cue
      : undefined
  const body = source.filter((i) => i.rect[1] > frame[1][1] && i !== continuation)
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 12) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (end > cuts[c] || start < cuts[c]) cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v || !v[0])) return
  const percentages = values.flatMap((v, n) => (v[0] === '%' ? [n] : []))
  if (percentages.length < 5) return
  const cohorts = values[percentages[0]].slice(1).filter(Boolean).length
  if (cohorts < 2 || cohorts >= predicted.length - 1) return
  const number = (s) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
  const statistic = (s) => /^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)[*†‡]?$/.test(s)
  const counts = new Set()
  for (const n of percentages) {
    const previous = values[n - 1],
      current = values[n]
    if (
      !previous ||
      !/^(?:No\.|N|Count)$/i.test(previous[0]) ||
      previous.slice(1, cohorts + 1).some((s) => !/^\d+$/.test(s)) ||
      current.slice(1, cohorts + 1).some((s) => !number(s)) ||
      current.slice(cohorts + 1).some(Boolean) ||
      previous.slice(cohorts + 1).some((s) => s && !statistic(s)) ||
      groups[n][0].baseline - groups[n - 1][0].baseline > height * 1.6
    )
      return
    counts.add(n - 1)
  }
  const nativeHeader = recoverRuledHeaderBands(header, cuts, rules, frame[0][1], frame[1][1])
  if (!nativeHeader?.spans.some((s) => s.row === 0 && s.column === 1 && s.colSpan === cohorts))
    return
  const owned = [],
    labels = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      v = values[n]
    if (counts.has(n) || percentages.includes(n)) {
      owned.push([...g])
      labels.push(false)
    } else if (v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      const previous = owned.at(-1),
        bounds = union(g)
      if (
        previous &&
        labels.at(-1) &&
        g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.3 &&
        bounds[0] >= union(previous)[0] - 1 &&
        bounds[0] - union(previous)[0] < height * 3
      )
        previous.push(...g)
      else {
        owned.push([...g])
        labels.push(true)
      }
    } else if (
      /^(?:TotalNo\.|No\.ofpatients|N)$/i.test(v[0]) &&
      v.slice(1, cohorts + 1).every((s) => /^\d+$/.test(s)) &&
      v.slice(cohorts + 1).every((s) => !s)
    ) {
      owned.push([...g])
      labels.push(false)
    } else return
  }
  const bounds = owned.map(union)
  if (
    !hasUniqueRecordTokens(source, [header, ...owned, ...(continuation ? [[continuation]] : [])]) ||
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])
  )
    return
  return {
    cropRect: [left, frame[0][1], right, frame[2][1]],
    rows: [...nativeHeader.rows, ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame[2][1]]),
    spans: nativeHeader.spans,
    completeSpans: true,
    headerRows: nativeHeader.rows.map((_, n) => n),
    ownedTokens: new Set([...header, ...owned.flat()]),
    repair: 'source-record-boundary-comparison-recovered'
  }
}

// Repeated No./% leaves and cohort underlines establish a single stub and paired
// data columns even when the model splits the stub. Centered summary values own
// both leaves; count-only records retain genuinely blank percentage cells.
function recoverPairedCountSummaries(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const horizontal = rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
  const frame = horizontal
    .filter((r) => Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16)
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3 || frame[1][1] - frame[0][1] > 120 || bottom - frame[2][1] > 16) return
  const source = tableSourceItems(items, [left, frame[0][1], right, frame[2][1]])
  const header = source.filter((i) => i.rect[3] < frame[1][1])
  const first = header.find((i) => i.text === 'No.')
  if (!first) return
  const height = first.height
  const leaves = header
    .filter(
      (i) => /^(?:No\.|%)$/.test(i.text) && Math.abs(i.baseline - first.baseline) < height * 0.3
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    leaves.length < 4 ||
    leaves.length > 12 ||
    leaves.length % 2 ||
    leaves.some((i, n) => i.text !== (n % 2 ? '%' : 'No.'))
  )
    return
  const cuts = [
    left,
    leaves[0].rect[0] - height * 0.75,
    ...leaves.slice(1).map((i, n) => (leaves[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right]
  const bands = []
  for (const r of horizontal.filter((r) => r[1] > frame[0][1] && r[1] < first.rect[1])) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.1)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  bands.sort((a, b) => a[0][1] - b[0][1])
  if (bands.length !== 2 || bands[0].length !== 1 || bands[1].length !== leaves.length / 2) return
  const parentRule = bands[0][0],
    children = bands[1].sort((a, b) => a[0] - b[0])
  if (
    children.some(
      (r, n) =>
        r[0] > leaves[n * 2].rect[0] ||
        r[2] < leaves[n * 2 + 1].rect[2] ||
        r[0] < parentCuts[n + 1] ||
        r[2] > parentCuts[n + 2]
    ) ||
    parentRule[0] > leaves[0].rect[0] ||
    parentRule[2] < leaves.at(-1).rect[2]
  )
    return
  const upper = header.filter((i) => i.rect[3] < parentRule[1]),
    middle = header.filter((i) => i.rect[1] > parentRule[1] && i.rect[3] < children[0][1]),
    lower = header.filter((i) => i.rect[1] > children[0][1])
  const main = readSourceRow(upper, [left, cuts[1], right]),
    parents = readSourceRow(middle, parentCuts, { multiline: true }),
    labels = readSourceRow(lower, cuts)
  if (
    !hasUniqueRecordTokens(header, [upper, middle, lower]) ||
    !main ||
    main[0] ||
    !/\p{L}/u.test(main[1]) ||
    !parents ||
    parents[0] ||
    !parents.slice(1).every((s) => /\p{L}/u.test(s) && /\(n=\d+\)/i.test(s)) ||
    !labels ||
    !/\p{L}/u.test(labels[0]) ||
    labels.slice(1).some((s, n) => s !== (n % 2 ? '%' : 'No.'))
  )
    return
  const body = source.filter((i) => i.rect[1] > frame[1][1]),
    groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || !hasUniqueRecordTokens(source, [header, ...groups])) return
  const spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: leaves.length }]
  for (let c = 1; c < cuts.length - 1; c += 2)
    spans.push({ row: 1, column: c, rowSpan: 1, colSpan: 2 })
  const indent = Math.min(...body.map((i) => i.rect[0]))
  let sections = 0,
    records = 0,
    summaries = 0
  for (const [n, g] of groups.entries()) {
    const paired = readSourceRow(g, parentCuts)
    if (!paired || !paired[0]) return
    if (paired.slice(1).every((s) => !s)) {
      if (!/\p{L}/u.test(paired[0]) || Math.abs(union(g)[0] - indent) > height * 0.35) return
      spans.push({ row: n + 3, column: 0, rowSpan: 1, colSpan: leaves.length + 1 })
      sections++
    } else if (/^(?:Median|Mean|Range)$/i.test(paired[0])) {
      if (!paired.slice(1).every((s) => /^[-−+]?\d+(?:\.\d+)?(?:[-–−]\d+(?:\.\d+)?)?$/.test(s)))
        return
      for (let c = 1; c < parentCuts.length - 1; c++) {
        const tokens = g.filter((i) => i.rect[0] >= parentCuts[c] && i.rect[2] <= parentCuts[c + 1])
        const bounds = union(tokens),
          rule = children[c - 1]
        if (Math.abs((bounds[0] + bounds[2] - rule[0] - rule[2]) / 2) > height) return
        spans.push({ row: n + 3, column: c * 2 - 1, rowSpan: 1, colSpan: 2 })
      }
      summaries++
    } else {
      const v = readSourceRow(g, cuts)
      if (!v) return
      const counts = v.slice(1).filter((_, c) => c % 2 === 0),
        percentages = v.slice(2).filter((_, c) => c % 2 === 0)
      if (
        counts.some((s) => !/^(?:\d+|NA)$/.test(s)) ||
        !(
          percentages.every((s) => !s) ||
          percentages.every((s, c) =>
            counts[c] === 'NA' ? !s : /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
          )
        )
      )
        return
      records++
    }
  }
  if (sections < 2 || records < 5 || summaries < 2) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const ys = [frame[1][1], ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), frame[2][1]]
  return {
    cropRect: [left, frame[0][1], right, frame[2][1]],
    rows: [
      [left, frame[0][1], right, parentRule[1]],
      [left, parentRule[1], right, children[0][1]],
      [left, children[0][1], right, frame[1][1]],
      ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame[2][1]]),
    spans,
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated allele headings and P-value columns establish the actual count
// blocks when the detector duplicates a column. Native header/footer rules
// and a unique, complete assignment of every source run are required.
export function recoverAlleleDistributionGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < 16 &&
        r[1] >= crop[1] - 10 &&
        r[1] <= crop[3] + 10
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length !== 4) return
  const [upper, tier, divider, lower] = borders
  if (tier[1] - upper[1] > 30 || divider[1] - tier[1] > 55) return
  const left = Math.min(crop[0], upper[0]),
    right = Math.max(crop[2], upper[2]),
    top = upper[1],
    bottom = lower[1]
  const source = tableSourceItems(items, [left, top, right, bottom])
  const header = source.filter((i) => i.rect[1] > tier[1] && i.rect[3] < divider[1])
  const heads = header
    .filter((i) => /^(?:[ACGT]{2}|P[- ]value)$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    heads.length < 8 ||
    heads.length > 24 ||
    heads.length % 4 ||
    heads.some((i, n) => (n % 4 === 3 ? !/^P/.test(i.text) : !/^[ACGT]{2}$/.test(i.text)))
  )
    return
  const height = heads[0].height,
    body = source.filter((i) => i.rect[1] > divider[1])
  const cuts = [
    left,
    heads[0].rect[0] - height * 2,
    ...heads.slice(1).map((i, n) => (heads[n].rect[2] + i.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = [...body, ...header].filter((i) => col(i) === c - 1),
      b = [...body, ...header].filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    cuts[c] = (end + start) / 2
  }
  const labels = groupSourceRowsWithScripts(
    body.filter((i) => col(i) === 0),
    height,
    0.3
  )
  if (!labels || labels.length < 10) return
  const anchors = labels.map((g) => Math.max(...g.map((i) => i.baseline))),
    groups = labels.map((g) => [...g])
  for (const i of body.filter((i) => col(i) > 0)) {
    const near = anchors
      .map((y, n) => ({ n, d: Math.abs(y - i.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (near[0].d > height || near[1].d - near[0].d < height * 0.1) return
    groups[near[0].n].push(i)
  }
  for (const group of groups) {
    if (!readSourceRow(group, cuts)) return
    for (let c = 1; c < cuts.length - 1; c++) {
      const v = group
        .filter((i) => col(i) === c)
        .sort((a, b) =>
          Math.abs(a.baseline - b.baseline) < height * 0.3
            ? a.rect[0] - b.rect[0]
            : a.baseline - b.baseline
        )
        .map((i) => i.text)
        .join('')
        .replace(/[\s＊*†]/g, '')
      if (v && !/^(?:[<>]?\d+(?:\.\d+)?(?:\([\d.%-]+\))?[＊*†]?|-)$/u.test(v)) return
    }
  }
  const parents = source.filter((i) => i.rect[3] < tier[1]),
    parentGroups = heads.filter((_, n) => n % 4 === 0).map(() => [])
  for (const i of parents) {
    const c = col(i)
    if (c < 1) return
    parentGroups[Math.floor((c - 1) / 4)].push(i)
  }
  if (
    parentGroups.some(
      (g, n) =>
        !g.length || g.some((i) => i.rect[0] < cuts[1 + n * 4] || i.rect[2] > cuts[5 + n * 4])
    ) ||
    !hasUniqueRecordTokens(source, [parents, header, ...groups])
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: [left, top, right, bottom],
    rows: [
      [left, top, right, tier[1]],
      [left, tier[1], right, divider[1]],
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: parentGroups.map((_, n) => ({ row: 0, column: 1 + n * 4, rowSpan: 1, colSpan: 4 })),
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'allele-distribution-grid-recovered'
  }
}

// A small repeated-measure table can lose its entire first record into the
// header. A full underline and independently aligned stub/interval records
// determine both bands without treating a model header as source evidence.
export function recoverRuledIntervalRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 7) return
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 20 &&
        Math.abs(r[2] - crop[2]) < 20 &&
        r[1] >= crop[1] - 10 &&
        r[1] <= crop[3] + 10
    )
    .sort((a, b) => a[1] - b[1])
  if (
    borders.length !== 3 ||
    borders[1][1] - borders[0][1] > 35 ||
    borders[2][1] - borders[1][1] > 160
  )
    return
  const [top, divider, bottom] = borders.map((r) => r[1]),
    left = Math.min(crop[0], borders[0][0]),
    right = Math.max(crop[2], borders[0][2])
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left, top, right, bottom]),
    head = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const labels = body.filter((i) => col(i) === 0)
  if (labels.length < 3 || labels.length > 6 || labels.some((i) => !/\p{L}/u.test(i.text))) return
  const height = labels[0].height,
    groups = labels.map((i) => [i])
  for (const i of body.filter((i) => col(i) > 0)) {
    const near = labels
      .map((l, n) => ({ n, d: Math.abs(l.baseline - i.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (near[0].d > height || near[1].d - near[0].d < height * 0.15) return
    groups[near[0].n].push(i)
  }
  if (
    !readSourceRow(head, cuts) ||
    !hasUniqueRecordTokens(source, [head, ...groups]) ||
    groups.some((g) => !readSourceRow(g, cuts))
  )
    return
  if (
    groups
      .slice(0, -1)
      .some((g) =>
        cuts
          .slice(2, -1)
          .some((_, n) => !g.some((i) => col(i) === n + 1 && /^\([\d., ]+\)$/.test(i.text)))
      )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: [left, top, right, bottom],
    rows: [[left, top, right, divider], ...bounds.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'ruled-interval-records-recovered'
  }
}

function recoverRepeatedEventGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 6 || columns.length % 2) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    events = source.filter((i) => i.text === 'No. of Events')
  if (
    events.length !== (columns.length - 2) / 2 ||
    events.length < 2 ||
    !source.some((i) => i.text === 'Total Patients')
  )
    return
  const height = events[0].height
  const units = source.filter((i) => /^\(\d+-y CI\)$/.test(i.text))
  if (units.length !== events.length) return
  const divider = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > Math.max(...units.map((i) => i.baseline)) &&
        r[1] - units[0].baseline < height * 2
    )
    .sort((a, b) => a[1] - b[1])[0]?.[1]
  const footer = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[1] > divider && r[1] <= bottom && r[0] < left + 15 && r[2] > right - 15
    )
    .sort((a, b) => b[1] - a[1])[0]?.[1]
  if (divider === undefined || footer === undefined) return
  const upper = source.filter((i) => i.baseline < events[0].rect[1]),
    lower = source.filter((i) => i.baseline >= events[0].rect[1] && i.rect[3] < divider)
  const leaves = readSourceRow(lower, cuts)
  if (
    !leaves ||
    leaves.slice(0, 2).some(Boolean) ||
    !events.every(
      (_, n) => /^No\.ofEvents\(\d+-yCI\)$/.test(leaves[2 + n * 2]) && leaves[3 + n * 2] === 'P'
    )
  )
    return
  const parents = [...upper].sort((a, b) => a.rect[0] - b.rect[0])
  if (
    parents.length !== events.length + 1 ||
    parents[0].text !== 'Total Patients' ||
    parents.some(
      (i, n) =>
        i.rect[0] < cuts[n ? 2 * n : 1] ||
        i.rect[2] > cuts[n ? 2 * n + 2 : 2] ||
        Math.abs(i.baseline - parents[0].baseline) > height * 0.2
    )
  )
    return
  const groups = groupSourceRowsWithScripts(
    source.filter((i) => i.rect[1] > divider && i.rect[3] < footer),
    height,
    0.35
  )
  if (!groups) return
  const spans = [
    { row: 0, column: 1, rowSpan: 2, colSpan: 1 },
    ...events.map((_, n) => ({ row: 0, column: 2 + n * 2, rowSpan: 1, colSpan: 2 }))
  ]
  let records = 0,
    sections = 0
  for (const [n, g] of groups.entries()) {
    const v = readSourceRow(g, cuts)
    if (!v || !/\p{L}/u.test(v[0])) return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: columns.length })
      sections++
    } else {
      if (
        !/^\d+$/.test(v[1]) ||
        !events.every(
          (_, i) =>
            /^\d+\(\d+(?:\.\d+)?%\)$/.test(v[2 + i * 2]) && /^(?:0?\.\d+|—)?$/.test(v[3 + i * 2])
        )
      )
        return
      records++
    }
  }
  if (records < 6 || sections < 3) return
  return {
    rows: [union(upper), union(lower), ...groups.map(union)].map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set([...upper, ...lower, ...groups.flat()])
  }
}

// A tall literature-review header can wrap independently beside a short parent
// and two underlined children. Recover those gutters from complete child glyphs;
// author anchors own the body, including separately footnoted outcome rows.
function recoverRuledReviewHeader(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 11) return
  const source = tableSourceItems(items, table.cropRect)
  const author = source.find((i) => i.text === 'Author, year'),
    parent = source.find((i) => i.text === 'Reported LRR')
  const children = ['MRI (%)', 'No MRI (%)'].map((s) => source.find((i) => i.text === s))
  if (!author || !parent || children.some((i) => !i)) return
  const underline = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] > parent.rect[3] &&
      r[1] < Math.min(...children.map((i) => i.rect[1])) &&
      Math.abs(r[0] - children[0].rect[0]) < 1 &&
      Math.abs(r[2] - children[1].rect[2]) < 1
  )
  if (!underline) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const authors = source
    .filter(
      (i) => col(i) === 0 && (/\bet al\.\s*\d{4}$/.test(i.text) || /^Current series$/.test(i.text))
    )
    .sort((a, b) => a.baseline - b.baseline)
  if (authors.length < 4) return
  const bodyStart = authors[0].rect[1] - author.height * 0.25
  const heading = source.filter((i) => i.rect[3] < bodyStart)
  const neighbour = heading.filter((i) => col(i) === 7 && i !== parent)
  cuts[8] = (Math.max(...neighbour.map((i) => i.rect[2])) + children[0].rect[0]) / 2
  cuts[9] = (children[0].rect[2] + children[1].rect[0]) / 2
  if (
    cuts.some((x, n) => n && x <= cuts[n - 1]) ||
    source.some(
      (i) =>
        i !== parent &&
        (col(i) < 0 || i.rect[0] < cuts[col(i)] - 1 || i.rect[2] > cuts[col(i) + 1] + 1)
    )
  )
    return
  const rows = [
    [left, Math.min(...heading.map((i) => i.rect[1])), right, underline[1]],
    [left, underline[1], right, bodyStart]
  ]
  const spans = [{ row: 0, column: 8, rowSpan: 1, colSpan: 2 }]
  for (let c = 0; c < 11; c++)
    if (c !== 8 && c !== 9) spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  const footer = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[1] >= Math.max(...source.map((i) => i.rect[3])) &&
      r[2] - r[0] > (right - left) * 0.9
  )?.[1]
  if (!footer) return
  for (const [n, a] of authors.entries()) {
    const start = a.rect[1] - author.height * 0.25,
      end = authors[n + 1] ? authors[n + 1].rect[1] - author.height * 0.25 : footer
    const owned = source.filter(
      (i) => (i.rect[1] + i.rect[3]) / 2 >= start && (i.rect[1] + i.rect[3]) / 2 < end
    )
    const values = owned
      .filter((i) => col(i) === 8 && /^\d[\d.]*$/.test(i.text))
      .sort((a, b) => a.baseline - b.baseline)
    if (
      !values.length ||
      values.length > 2 ||
      !owned.some((i) => col(i) === 1 && /^\d[\d,]*$/.test(i.text))
    )
      return
    if (values.length === 2) {
      const split = (values[0].rect[3] + values[1].rect[1]) / 2
      if (owned.some((i) => col(i) < 8 && (i.rect[1] + i.rect[3]) / 2 >= split)) return
      for (let c = 0; c < 8; c++)
        spans.push({ row: rows.length, column: c, rowSpan: 2, colSpan: 1 })
      rows.push([left, start, right, split], [left, split, right, end])
    } else rows.push([left, start, right, end])
  }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Native segmented underlines supply leaf columns; shorter underlines supply
// parent spans. Accept only complete numeric records with unique token ownership.
function recoverUnderlinedNumericGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const caption = captions
    .filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] <= crop[1] + 40 &&
        c.rect[2] > crop[0] &&
        c.rect[0] < crop[2]
    )
    .sort((a, b) => b.rect[3] - a.rect[3])[0]
  if (!caption || crop[1] - caption.rect[3] > 30) return
  const bands = []
  for (const r of rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= caption.rect[3] &&
        r[1] <= crop[3] + 8 &&
        r[0] >= crop[0] - 16 &&
        r[2] <= crop[2] + 16
    )
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let band = bands.find((b) => Math.abs(b.y - r[1]) < 0.05)
    if (!band) bands.push((band = { y: r[1], parts: [] }))
    band.parts.push(r)
  }
  const full = bands.filter(
    (b) =>
      b.parts[0][0] < crop[0] + Math.max(16, (crop[2] - crop[0]) * 0.05) &&
      b.parts.at(-1)[2] > crop[2] - Math.max(16, (crop[2] - crop[0]) * 0.05) &&
      b.parts.every((r, n) => !n || (r[0] <= b.parts[n - 1][2] + 0.1 && r[2] > b.parts[n - 1][2]))
  )
  const footer = full.at(-1)
  if (!footer || Math.abs(footer.y - crop[3]) > 16) return
  const leafPattern =
    /^(?:n|%|Mean|SD|F|Utility|RI|Allgrades|Grade3-4|No|Yes|P\*|\((?:SE|SQ|TWT|SOL|WASO)\)|Arm[A-Z]:.+|HR\(95%CI\)|Pvalue|[bB]|t\(df\)|(?:Negative|Positive)\(n=\d+\))$/
  const native = tableSourceItems(items, [crop[0], caption.rect[3], crop[2], crop[3]])
  const candidates = [...full]
  // A single full divider can still use predicted gutters when repeated paired
  // population headings and their native underlines independently confirm them.
  const population = native.filter(
    (i) => i.rect[1] < crop[1] + 100 && /^(?:Negative|Positive)$/.test(i.text)
  )
  if (
    population.length === 6 &&
    new Set(population.map((i) => Math.round(i.baseline))).size === 1
  ) {
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (predicted.length === 10) {
      const cuts = [
        crop[0],
        ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
        crop[2]
      ]
      for (const b of full.filter(
        (b) =>
          b.parts.length === 1 && b.y > population[0].baseline && b.y - population[0].baseline < 40
      ))
        candidates.unshift({ ...b, parts: cuts.slice(1).map((x, c) => [cuts[c], b.y, x, b.y]) })
    }
  }
  // Repeated coefficient/test pairs are independently delimited by parent
  // underlines. Their single body rule needs the detector's leaf gutters only.
  const coefficients = native.filter((i) => /^[bB]$/.test(i.text) && i.rect[1] < crop[1] + 100)
  if (
    coefficients.length >= 3 &&
    coefficients.length <= 6 &&
    coefficients.every((i) => Math.abs(i.baseline - coefficients[0].baseline) < i.height * 0.2)
  ) {
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    for (let n = predicted.length - 1; n > 0; n--) {
      const a = predicted[n - 1].rect,
        b = predicted[n].rect
      if ((Math.min(a[2], b[2]) - Math.max(a[0], b[0])) / Math.min(a[2] - a[0], b[2] - b[0]) > 0.9)
        predicted.splice(n, 1)
    }
    const parents = bands.find(
      (b) =>
        b.parts.length === coefficients.length &&
        b.y < coefficients[0].rect[1] &&
        coefficients[0].rect[1] - b.y < coefficients[0].height
    )
    const border = full.find(
      (b) => b.y > coefficients[0].rect[3] && b.y - coefficients[0].rect[3] < coefficients[0].height
    )
    if (parents && border && predicted.length === coefficients.length * 2 + 1) {
      const cuts = [
        crop[0],
        ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
        crop[2]
      ]
      const leaves = native.filter((i) => i.rect[1] > parents.y && i.rect[3] < border.y)
      const values = readSourceRow(leaves, cuts)
      if (values && values.slice(1).every((v, n) => (n % 2 ? v === 't(df)' : /^[bB]$/.test(v))))
        candidates.unshift({
          ...border,
          parts: cuts.slice(1).map((x, c) => [cuts[c], border.y, x, border.y])
        })
    }
  }
  const roles = native
    .filter(
      (i) =>
        /^(?:Patients?|Spouses?|Intervention|Control)$/.test(i.text) && i.rect[1] < crop[1] + 100
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    roles.length === 4 &&
    roles.every(
      (i, n) =>
        (n % 2 ? /^(?:Spouse|Control)/ : /^(?:Patient|Intervention)/).test(i.text) &&
        Math.abs(i.baseline - roles[0].baseline) < i.height * 0.2
    )
  ) {
    const parent = bands.find(
      (b) =>
        b.parts.length === 2 && b.y < roles[0].rect[1] && roles[0].rect[1] - b.y < roles[0].height
    )
    const border = full.find(
      (b) => b.y > roles[0].baseline && b.y - roles[0].baseline < roles[0].height * 2 + 1
    )
    if (parent && border) {
      const predicted = table.structure.objects
        .filter((o) => o.label === 'table column')
        .sort((a, b) => a.rect[0] - b.rect[0])
        .filter(
          (c, n, all) =>
            !all
              .slice(0, n)
              .some(
                (p) =>
                  (Math.min(p.rect[2], c.rect[2]) - Math.max(p.rect[0], c.rect[0])) /
                    Math.max(p.rect[2] - p.rect[0], c.rect[2] - c.rect[0]) >
                  0.9
              )
        )
      if (predicted.length === (roles[0].text === 'Intervention' ? 7 : 5)) {
        const cuts = [
          crop[0],
          ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
          crop[2]
        ]
        const leaf = native.filter((i) => i.rect[1] > parent.y && i.rect[3] < border.y)
        const rawValues = readSourceRow(leaf, cuts)
        const values =
          rawValues &&
          cuts.slice(1).map((x, c) =>
            leaf
              .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)
              .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          )
        if (
          values &&
          values
            .slice(1)
            .every((v, n) =>
              (roles[0].text === 'Intervention'
                ? n % 3 === 2
                  ? /^p-?Value$/i
                  : n % 3 === 1
                    ? /^Control\(n=\d+\)$/
                    : /^Intervention\(n=\d+\)$/
                : n % 2
                  ? /^Spouses?(?:M?\(SE\)|\(n=\d+\))?$/
                  : /^Patients?(?:M\(SE\)|\(n=\d+\))?$/
              ).test(v)
            )
        )
          candidates.unshift({
            ...border,
            roleHeader: parent.y,
            parts: cuts.slice(1).map((x, c) => [cuts[c], border.y, x, border.y])
          })
      }
    }
  }
  const repeated = native.filter((i) => leafPattern.test(i.text.replace(/\s/g, '')))
  for (const anchor of repeated) {
    const leaf = repeated.filter(
      (i) => Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.3
    )
    if (leaf.length < 3 || anchor.baseline - caption.rect[3] > 100) continue
    const end = Math.max(...leaf.map((i) => i.rect[3]))
    const boundary = full.find((b) => b.y > end && b.parts.length >= 5)
    const first = native.filter((i) => i.rect[1] > end).sort((a, b) => a.rect[1] - b.rect[1])[0]
    if (
      boundary &&
      first &&
      first.rect[1] < boundary.y &&
      first.rect[1] - end < anchor.height * 2 &&
      !candidates.some((b) => Math.abs(b.y - (end + first.rect[1]) / 2) < 0.1)
    )
      candidates.unshift({ ...boundary, y: (end + first.rect[1]) / 2 })
  }
  for (const divider of candidates.filter(
    (b) =>
      b.parts.length >= 5 && b.parts.length <= 25 && b.y - caption.rect[3] < 120 && b !== footer
  )) {
    const left = Math.min(crop[0], divider.parts[0][0]),
      right = Math.max(crop[2], divider.parts.at(-1)[2])
    const top = caption.rect[3] + 0.1,
      bottom = footer.y
    const source = tableSourceItems(items, [left, top, right, bottom])
    const heading = source.filter((i) => i.rect[3] < divider.y)
    const times = heading.filter((i) => /^T\d+$/.test(i.text))
    if (times.length >= 4) {
      const counts = [...Map.groupBy(times, (i) => i.text).values()].map((g) => g.length)
      if (counts.some((n) => n < 2 || n !== counts[0])) continue
    }
    const body = source.filter((i) => i.rect[1] > divider.y)
    if (!heading.length || !body.length || !hasUniqueRecordTokens(source, [heading, body])) continue
    const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
    const leafY = Math.max(...heading.map((i) => i.baseline))
    const populationTier =
      population.length === 6
        ? Math.max(...bands.filter((b) => b.y < divider.y && b.parts.length === 3).map((b) => b.y))
        : -Infinity
    const leaves = heading.filter((i) =>
      divider.roleHeader
        ? i.rect[1] > divider.roleHeader
        : population.length === 6
          ? i.rect[1] > populationTier
          : Math.abs(i.baseline - leafY) < height * 0.3
    )
    let cuts = [left, ...divider.parts.slice(1).map((r) => r[0] - 0.1), right]
    // Empty narrow rule segments are spacing between groups, not data columns.
    for (let c = cuts.length - 2; c > 0; c--) {
      if (
        cuts[c + 1] - cuts[c] < height &&
        ![...leaves, ...body].some(
          (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < cuts[c + 1]
        )
      )
        cuts.splice(c, 1)
    }
    const leafValues = readSourceRow(leaves, cuts)
    if (
      !leafValues ||
      leafValues.slice(1).filter(Boolean).length < 3 ||
      (!divider.roleHeader && leafValues.slice(1).filter((v) => leafPattern.test(v)).length < 3)
    )
      continue
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    const shared =
      leafValues.slice(1).every((v, n) => v === (n % 2 ? 'RI' : 'Utility')) &&
      leafValues.length >= 7
    const coefficientPairs = leafValues
      .slice(1)
      .every((v, n) => (n % 2 ? v === 't(df)' : /^[bB]$/.test(v)))
    const probability = leafValues.filter((v) => v === 'P*').length >= 2
    const pValues = probability ? body.filter((i) => leafValues[col(i)] === 'P*') : []
    const sharedValues = shared ? body.filter((i) => col(i) > 0 && col(i) % 2 === 0) : pValues
    const recordBody = body.filter((i) => !sharedValues.includes(i))
    const groups = groupSourceRowsWithScripts(recordBody, height, 0.3)
    if (!groups || groups.length < 3) continue
    const owned = [],
      sections = [],
      labelSpans = []
    let valid = true,
      records = 0
    for (const g of groups) {
      let v = readSourceRow(g, cuts)
      if (!v && population.length === 6) {
        const stub = g.filter((i) => i.rect[0] < cuts[1]),
          values = g.filter((i) => i.rect[0] >= cuts[1])
        const start = Math.min(...values.map(col)),
          data = readSourceRow(values, cuts)
        if (
          stub.length === 1 &&
          /\p{L}/u.test(stub[0].text) &&
          start >= 2 &&
          stub[0].rect[2] < cuts[start] &&
          data
        ) {
          v = [stub[0].text.replace(/\s/g, ''), ...data.slice(1)]
          labelSpans.push({ row: owned.length, column: 0, rowSpan: 1, colSpan: start })
        }
      }
      if (!v && g.every((i) => i.rect[0] < cuts[1] && /\p{L}/u.test(i.text))) {
        const previous = owned.at(-1)
        if (
          previous &&
          sections.at(-1) &&
          /^[a-z]/.test(g[0].text) &&
          g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.6
        )
          previous.push(...g)
        else {
          owned.push([...g])
          sections.push(true)
        }
        continue
      }
      if (
        !v ||
        v
          .slice(1)
          .some(
            (s) =>
              s &&
              !(divider.roleHeader && /^[$€£]\d[\d,]*(?:\.\d+)?$/.test(s)) &&
              !/^(?:[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()<>%±−+–/:-]*(?:\(ref\))?[a-z]{0,2}[*#†]{0,3}|\(\d+(?:\.\d+)?(?:[–−-]\d+(?:\.\d+)?)?\)|[—–-]|\*{1,3})$/.test(
                s
              )
          )
      ) {
        valid = false
        break
      }
      if (v.slice(1).some(Boolean)) {
        if (!v[0]) {
          const prior = owned.at(-1)
          if (
            divider.roleHeader &&
            prior &&
            !sections.at(-1) &&
            v.slice(1).filter(Boolean).length >= 2 &&
            v.slice(1).every((x) => !x || /^\(\d+[–−-]\d+\)$/.test(x)) &&
            union(g)[1] > union(prior)[3] &&
            union(g)[1] - union(prior)[3] < height
          ) {
            prior.push(...g)
            continue
          }
          valid = false
          break
        }
        records++
        const previous = owned.at(-1)
        if (
          previous &&
          sections.at(-1) &&
          ((coefficientPairs && previous.some((i) => /[×*]\s*$/.test(i.text))) ||
            (divider.roleHeader &&
              (/^\(/.test(v[0]) ||
                Math.min(...previous.map((i) => i.rect[0])) -
                  Math.min(...body.filter((i) => col(i) === 0).map((i) => i.rect[0])) >=
                  height * 0.5))) &&
          Math.min(...g.map((i) => i.rect[1])) - Math.max(...previous.map((i) => i.rect[3])) <
            height
        ) {
          previous.push(...g)
          sections[sections.length - 1] = false
        } else {
          owned.push([...g])
          sections.push(false)
        }
      } else if (v[0]) {
        const previous = owned.at(-1)
        if (
          previous &&
          (/^[a-z(]/.test(v[0]) ||
            /^(?:RateofChange|RandomEffects)$/.test(
              previous
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '') + v[0]
            )) &&
          Math.min(...g.map((i) => i.baseline)) - Math.max(...previous.map((i) => i.baseline)) <
            height * 1.6
        )
          previous.push(...g)
        else {
          owned.push([...g])
          sections.push(true)
        }
      } else {
        valid = false
        break
      }
    }
    if (!valid || records < 3 || !hasUniqueRecordTokens(recordBody, owned)) continue
    const bodyBounds = owned.map(union)
    // Raised significance marks can graze the preceding line's font box.
    // Keep the native baseline grouping and divide only this sub-point overlap.
    if (coefficientPairs || divider.roleHeader)
      for (let n = 1; n < bodyBounds.length; n++) {
        const previous = bodyBounds[n - 1],
          current = bodyBounds[n]
        if (
          current[1] <= previous[3] &&
          previous[3] - current[1] < height * (divider.roleHeader ? 0.2 : 0.1)
        ) {
          const boundary = (previous[3] + current[1]) / 2
          previous[3] = boundary - 0.001
          current[1] = boundary + 0.001
        }
      }
    if (bodyBounds.some((r, n) => n && r[1] <= bodyBounds[n - 1][3])) continue
    const tiers = bands
      .filter(
        (b) =>
          b.y < divider.y &&
          b.y > Math.min(...heading.map((i) => i.rect[1])) &&
          b.parts.some((r) => r[0] > left + height || r[2] < right - height)
      )
      .map((b) => ({ ...b, parts: [...b.parts] }))
    for (let n = tiers.length - 1; n > 0; n--) {
      if (tiers[n].y - tiers[n - 1].y < height * 0.15) {
        tiers[n - 1].parts.push(...tiers[n].parts)
        tiers[n - 1].parts.sort((a, b) => a[0] - b[0])
        tiers.splice(n, 1)
      }
    }
    if (
      tiers.length > 2 ||
      (!tiers.length && leafValues.filter((v) => /^\([A-Z]+\)$/.test(v)).length < 4)
    )
      continue
    const ys = [top, ...tiers.map((b) => b.y), divider.y]
    const spans = labelSpans.map((s) => ({ ...s, row: s.row + ys.length - 1 })),
      assigned = new Set()
    if (probability) {
      const gs = []
      for (let c = 1; c < cuts.length - 1; c++)
        if (leafValues[c] === 'P*') {
          const g = pValues.filter((i) => col(i) === c)
          if (g.length !== 1 || !/^0?\.\d+$/.test(g[0].text)) {
            valid = false
            break
          }
          gs.push(g)
          // A probability printed beside another decimal statistic belongs to
          // that native record, not an inferred span across the entire matrix.
          const aligned = owned.findIndex((record) =>
            record.some(
              (i) =>
                col(i) === c - 1 &&
                /^\d?\.\d+$/.test(i.text) &&
                Math.abs(i.baseline - g[0].baseline) < height * 0.1
            )
          )
          spans.push({
            row: ys.length - 1 + Math.max(0, aligned),
            column: c,
            rowSpan: aligned < 0 ? owned.length : 1,
            colSpan: 1
          })
        }
      if (!valid || !hasUniqueRecordTokens(pValues, gs)) continue
    }
    if (shared) {
      const sectionRows = sections.flatMap((s, n) => (s ? [n] : []))
      if (sectionRows.length < 3 || sectionRows[0] !== 0) continue
      const sharedGroups = []
      for (const [index, start] of sectionRows.entries()) {
        const end = sectionRows[index + 1] ?? owned.length
        if (end - start < 3) {
          valid = false
          break
        }
        for (let c = 2; c < cuts.length - 1; c += 2) {
          const g = sharedValues.filter(
            (i) =>
              col(i) === c &&
              i.rect[1] > bodyBounds[start][3] &&
              i.rect[3] <= bodyBounds[end - 1][3] + height * 0.3
          )
          if (g.length !== 1 || !/^\d+(?:\.\d+)?$/.test(g[0].text)) {
            valid = false
            break
          }
          sharedGroups.push(g)
          spans.push({ row: start + ys.length, column: c, rowSpan: end - start - 1, colSpan: 1 })
        }
      }
      if (!valid || !hasUniqueRecordTokens(sharedValues, sharedGroups)) continue
    }
    for (let row = 0; row < ys.length - 1; row++) {
      const tokens = heading.filter((i) => i.rect[1] >= ys[row] && i.rect[3] <= ys[row + 1])
      if (row < tiers.length) {
        const segments = []
        for (const r of tiers[row].parts) {
          const p = segments.at(-1)
          if (p && Math.abs(p[2] - r[0]) < 0.1) p[2] = r[2]
          else segments.push([...r])
        }
        for (const r of segments) {
          const owned = tokens.filter((i) => i.rect[0] >= r[0] - 0.2 && i.rect[2] <= r[2] + 0.2)
          if (!owned.length) continue
          const covered = cuts
            .slice(1)
            .flatMap((x, c) =>
              leaves.some((i) => col(i) === c && i.rect[0] >= r[0] - 0.2 && i.rect[2] <= r[2] + 0.2)
                ? [c]
                : []
            )
          if (!covered.length || covered.some((c, n) => n && c !== covered[n - 1] + 1)) {
            valid = false
            break
          }
          spans.push({ row, column: covered[0], rowSpan: 1, colSpan: covered.length })
          owned.forEach((i) => assigned.add(i))
        }
      }
      for (const i of tokens.filter((i) => !assigned.has(i))) {
        const c = col(i)
        if (c < 0 || i.rect[0] < cuts[c] - 0.2 || i.rect[2] > cuts[c + 1] + 0.2) {
          valid = false
          break
        }
        assigned.add(i)
      }
    }
    for (const i of heading.filter((i) => !assigned.has(i))) {
      const c = col(i)
      if (
        c < 0 ||
        i.rect[0] < cuts[c] ||
        i.rect[2] > cuts[c + 1] ||
        spans.some((s) => c >= s.column && c < s.column + s.colSpan)
      ) {
        valid = false
        break
      }
      assigned.add(i)
    }
    if (!valid || assigned.size !== heading.length) continue
    // A wrapped stub can cross a tier boundary without crossing a data column.
    for (let c = 0; c < cuts.length - 1; c++) {
      const tokens = heading.filter(
        (i) => col(i) === c && !spans.some((s) => c >= s.column && c < s.column + s.colSpan)
      )
      if (tokens.length && tokens.every((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
        spans.push({ row: 0, column: c, rowSpan: ys.length - 1, colSpan: 1 })
    }
    return {
      rows: [
        ...ys.slice(1).map((y, n) => [left, ys[n], right, y]),
        ...bodyBounds.map((r) => [left, r[1], right, r[3]])
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      spans: [
        ...spans,
        ...sections.flatMap((s, n) =>
          s ? [{ row: n + ys.length - 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 }] : []
        )
      ],
      headerRows: ys.slice(1).map((_, n) => n),
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
}

// Native domain labels occupy the first column and start on the first member
// baseline. They must never inherit the preceding model row's group boundary.
function recoverRuledDomainGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const bands = []
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    let b = bands.find((b) => Math.abs(b.y - r[1]) < 0.1)
    if (!b) bands.push((b = { y: r[1], parts: [] }))
    b.parts.push(r)
  }
  const divider = bands.find(
    (b) =>
      [5, 11].includes(b.parts.length) &&
      b.y - top < 100 &&
      b.parts[0][0] < left + 2 &&
      b.parts.at(-1)[2] > right - 4 &&
      b.parts.every((r, n) => !n || (r[0] < b.parts[n - 1][2] && r[2] > b.parts[n - 1][2]))
  )
  const footer = bands.find(
    (b) =>
      b.parts.length === 1 &&
      b.y > divider?.y + 50 &&
      bottom - b.y < 16 &&
      b.parts[0][0] < left + 2 &&
      b.parts[0][2] > right - 4
  )
  if (!divider || !footer) return
  const cuts = [
    left,
    ...divider.parts.slice(1).map((r, n) => (divider.parts[n][2] + r[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left, top, right, footer.y]),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const head = source.filter((i) => i.rect[3] < divider.y),
    body = source.filter((i) => i.rect[1] > divider.y)
  if (!head.length || !hasUniqueRecordTokens(source, [head, body])) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parents = body.filter((i) => col(i) === 0)
  if (
    parents.length < 2 ||
    parents.length > 5 ||
    parents.some((i) => !/^\p{Lu}[\p{Lu}\d-]{2,24}$/u.test(i.text))
  )
    return
  const groups = groupSourceRowsWithScripts(
    body.filter((i) => col(i) !== 0),
    height,
    0.3
  )
  if (!groups) return
  const records = []
  for (const g of groups) {
    const v = readSourceRow(g, cuts)
    if (!v || !/[a-z]/i.test(v[1]) || v[0]) return
    if (v.slice(2).every((x) => x && /^[<>≤≥−–+-]?(?:\d|\.\d)[\d.,() %≤≥−–+/*-]*[a-z]?$/.test(x)))
      records.push([...g])
    else if (
      v.slice(2).every((x) => !x) &&
      records.length &&
      g[0].baseline - records.at(-1)[0].baseline < height * 1.6
    )
      records.at(-1).push(...g)
    else return
  }
  if (
    records.length < 12 ||
    !hasUniqueRecordTokens(
      body.filter((i) => col(i) !== 0),
      records
    )
  )
    return
  const bounds = records.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const starts = parents.map((p) =>
    records.findIndex((g) => Math.abs(g[0].baseline - p.baseline) < height * 0.3)
  )
  if (starts[0] !== 0 || starts.some((n, i) => n < 0 || (i && n - starts[i - 1] < 3))) return
  const tiers = bands.filter((b) => b.y < divider.y && b.parts.length === 2)
  if ((cuts.length === 12 && tiers.length !== 2) || (cuts.length === 6 && tiers.length)) return
  const ys = [top, ...tiers.map((b) => b.y), divider.y],
    spans = []
  const headerRows = ys.length - 1
  for (let n = 0; n < parents.length; n++)
    spans.push({
      row: headerRows + starts[n],
      column: 0,
      rowSpan: (starts[n + 1] ?? records.length) - starts[n],
      colSpan: 1
    })
  if (tiers.length) {
    const labels = head.filter((i) => i.rect[3] < tiers[0].y)
    if (labels.length !== 2 || labels[0].text !== 'Intervention' || labels[1].text !== 'Control')
      return
    for (const [n, label] of labels.entries()) {
      const first = col(label),
        end = n === 0 ? col(labels[1]) : cuts.length - 1
      if (first !== 2 + n * 4) return
      spans.push({ row: 0, column: first, rowSpan: 1, colSpan: end - first })
    }
    for (let c = 2; c < cuts.length - 1; c++) {
      const tokens = head.filter((i) => col(i) === c && i.rect[1] > tiers[0].y)
      if (
        tokens.some((i) => i.rect[1] < tiers[1].y) &&
        tokens.some((i) => i.rect[3] > tiers[1].y) &&
        !tokens.some((i) => i.text === 'Mean value')
      )
        spans.push({ row: 1, column: c, rowSpan: 2, colSpan: 1 })
    }
  }
  return {
    rows: [
      ...ys.slice(1).map((y, n) => [left, ys[n], right, y]),
      ...bounds.map((r) => [left, r[1], right, r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, footer.y]),
    headerRows: Array.from({ length: headerRows }, (_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Dense cohort tables can switch from a merged descriptive stub to paired
// category/value stubs. Repeated sample headings and category pairs prove the
// switch; every source baseline must be a complete record or a section.
function recoverMixedStubCountRecords(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 5) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const groups = groupSourceRowsWithScripts(
    [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    height,
    0.35
  )
  if (!groups || groups.length < 20) return
  const pairedHeaders = groups.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return v && !v[0] && !v[1] && !v[4] && /^(?:No\.?|n)\.?(?:\(%\))$/i.test(v[2]) && v[2] === v[3]
  })
  if (pairedHeaders < 1 || pairedHeaders > 3) return
  const head = groups.slice(0, pairedHeaders + 1).flat()
  if (
    ![2, 3].every((c) =>
      head.some(
        (i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1] && /^\(N\s*=\s*\d+\)$/i.test(i.text)
      )
    )
  )
    return
  const body = groups.slice(pairedHeaders + 1),
    spans = [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }]
  const scalar = (s) =>
    /^(?:NA|[<>≤≥−-]?\d+(?:[.,]\d+)?(?:[–-]\d+)?(?:\(\d+(?:[.,]\d+)?(?:[–-]\d+)?%?\))?)$/i.test(s)
  let records = 0,
    sections = 0
  const pairs = []
  for (let n = 0; n < body.length; n++) {
    const g = body[n],
      v = readSourceRow(g, [left, cuts[2], cuts[3], cuts[4], right])
    if (!v) return
    if (v[0] && v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      sections++
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })
      continue
    }
    if (!v[0] || !scalar(v[1]) || !scalar(v[2]) || (v[3] && !scalar(v[3]))) return
    records++
    const stub = g.filter((i) => i.rect[0] < cuts[2]),
      dual = readSourceRow(stub, cuts)
    if (dual?.[0] && dual[1]) {
      const next = body[n + 1] && readSourceRow(body[n + 1], cuts)
      if (!next || next[0] || !next[1] || !scalar(next[2]) || !scalar(next[3]) || next[4]) return
      pairs.push([dual[1], next[1]].join('|'))
      spans.push({ row: n + 1, column: 0, rowSpan: 2, colSpan: 1 })
    } else if (dual?.[1] && !dual[0]) {
      if (!spans.some((s) => s.row === n && s.rowSpan === 2)) return
    } else spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 2 })
  }
  if (
    records < 12 ||
    sections < 3 ||
    pairs.length < 2 ||
    new Set(pairs).size !== 1 ||
    !hasUniqueRecordTokens(source, [head, ...body])
  )
    return
  return {
    rows: [head, ...body].map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}
// Repeated count/percentage pairs establish categorical source rows even when
// the model drops the final category or merges a label into the preceding row.
// Each record must have both counts and either all or no percentages. Cohort
// qualifiers and a final P heading independently prove the paired header spans.
export function recoverPairedCountGrid(table, items, captions) {
  const grades = recoverPairedGradeHeader(table, items, captions)
  if (grades) return grades
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length < 7 || model.length > 11 || model.length % 2 !== 1) return
  const cuts = [
    left,
    ...model.slice(1).map((o, n) => (o.rect[0] + model[n].rect[2]) / 2 + left),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 7) return
  const header = groups[0]
  const parentCuts = [left, cuts[1], cuts[2], ...cuts.slice(4).filter((_, n) => n % 2 === 0), right]
  const headings = readSourceRow(header, parentCuts)
  if (
    !headings ||
    headings[0] ||
    headings[1] ||
    !/^P(?:-?value)?$/i.test(headings.at(-1)) ||
    !headings.slice(2, -1).every((s) => /\p{L}/u.test(s) && /\(n=\d+\)/i.test(s))
  )
    return
  const records = groups.slice(1).map((g) => readSourceRow(g, cuts))
  if (
    records.some(
      (r) =>
        !r ||
        !r[1] ||
        !Array.from({ length: (model.length - 3) / 2 }, (_, n) => n * 2 + 2).every((c) =>
          /^\d+$/.test(r[c])
        ) ||
        !(
          r
            .slice(3, -1)
            .filter((_, n) => n % 2 === 0)
            .every((s) => /^\(\d+(?:\.\d+)?%\)$/.test(s)) ||
          r
            .slice(3, -1)
            .filter((_, n) => n % 2 === 0)
            .every((s) => !s)
        ) ||
        (r.at(-1) && !/^[<>≤≥]?\d+(?:\.\d+)?[a-z]?$/.test(r.at(-1)))
    )
  )
    return
  const starts = records.flatMap((r, n) => (r[0] ? [n] : []))
  if (
    starts.length < 2 ||
    starts[0] !== 0 ||
    records.filter((r) => r[3]).length < 4 ||
    groups.some((g, n) => n && union(g)[1] < union(groups[n - 1])[3])
  )
    return
  const spans = Array.from({ length: (model.length - 3) / 2 }, (_, n) => ({
    row: 0,
    column: 2 + n * 2,
    rowSpan: 1,
    colSpan: 2
  }))
  for (const [n, first] of starts.entries()) {
    const end = starts[n + 1] ?? records.length
    if (end - first < 2) continue
    spans.push({ row: first + 1, column: 0, rowSpan: end - first, colSpan: 1 })
    const tests = records.slice(first, end).flatMap((r, n) => (r.at(-1) ? [first + n] : []))
    for (const [n, start] of tests.entries()) {
      const limit = tests[n + 1] ?? end
      if (limit - start >= 2)
        spans.push({ row: start + 1, column: model.length - 1, rowSpan: limit - start, colSpan: 1 })
    }
  }
  const ys = [
    top,
    ...groups.slice(1).map((g, n) => (union(groups[n])[3] + union(g)[1]) / 2),
    union(groups.at(-1))[3] + 0.1
  ]
  return {
    rows: groups.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true
  }
}

// Repeated grade leaves establish cohort pairs even when a common unit line
// follows the leaves. Keep that unit as its own spanning header, not in the
// first cohort's grade cell; all body records must independently fit the cuts.
function recoverPairedGradeHeader(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 13 || columns.length % 2 !== 1) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
    groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups) return
  const tier = groups.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return (
      v &&
      !v[0] &&
      v
        .slice(1)
        .every((s, n) =>
          n % 2 ? /^Grade[3-5](?:[/–-][3-5])?$/i.test(s) : /^(?:All|Any)Grades?$/i.test(s)
        )
    )
  })
  if (tier < 1 || tier > 3 || !groups[tier + 2]) return
  const head = groups.slice(0, tier).flat(),
    parentCuts = [left, ...cuts.slice(1, -1).filter((_, n) => n % 2 === 0), right],
    parents = readSourceRow(head, parentCuts, { multiline: true })
  const unit = readSourceRow(groups[tier + 1], [left, cuts[1], right])
  if (
    !parents ||
    !/\p{L}/u.test(parents[0]) ||
    !parents.slice(1).every((s) => /\p{L}/u.test(s) && /\(N=\d+\)/i.test(s)) ||
    !unit ||
    unit[0] ||
    !/^(?:Numberofpatients|Patients|n)\(%\)$/i.test(unit[1])
  )
    return
  const body = groups.slice(tier + 2),
    spans = [
      { row: 0, column: 0, rowSpan: 3, colSpan: 1 },
      { row: 2, column: 1, rowSpan: 1, colSpan: columns.length - 1 }
    ]
  let measured = 0
  for (const [n, g] of body.entries()) {
    const v = readSourceRow(g, cuts)
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      spans.push({ row: n + 3, column: 0, rowSpan: 1, colSpan: columns.length })
      continue
    }
    if (!v.slice(1).every((s) => /^\d+(?:\(\d+(?:\.\d+)?%?\))?$/.test(s))) return
    measured++
  }
  if (measured < 5) return
  for (let c = 1; c < columns.length; c += 2)
    spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  const owned = [head, groups[tier], groups[tier + 1], ...body],
    bounds = owned.map(union)
  if (!hasUniqueRecordTokens(source, owned) || bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]))
    return
  const ys = [top, ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), bottom]
  return {
    rows: owned.map((_, n) => [left, ys[n], right, ys[n + 1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: [0, 1, 2],
    completeSpans: true
  }
}
