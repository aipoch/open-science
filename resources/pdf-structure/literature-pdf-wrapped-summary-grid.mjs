/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import { tableSourceItems, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'

// Narrow manuscript columns can wrap both count headings and parenthesized SDs.
// Use repeated complete mean/SD records to establish columns and row extents;
// never join an incomplete numeric expression or infer its missing characters.
export function recoverWrappedSummaryGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const labels = source.filter((i) => /^mean\s*\(SD\)$/i.test(i.text))
  if (labels.length < 3 || labels.length > 20) return
  const first = labels[0]
  if (labels.some((i) => Math.abs(i.rect[0] - first.rect[0]) > first.height * 0.2)) return
  const numeric = (i) => /^\d+\.\d+$/.test(i.text)
  const baseline = source.filter(
    (i) =>
      numeric(i) &&
      i.rect[0] > first.rect[2] &&
      Math.abs(i.baseline - first.baseline) < first.height * 0.3
  )
  if (baseline.length < 3 || baseline.length > 7) return
  const anchors = baseline.slice(0, -1)
  const p = baseline.at(-1)
  const starts = [
    first.rect[0],
    ...anchors.flatMap((anchor, n) => {
      const next = anchors[n + 1] ?? p
      const sd = source.filter(
        (i) =>
          /^\(\d/.test(i.text) &&
          i.rect[0] > anchor.rect[2] &&
          i.rect[2] < next.rect[0] &&
          Math.abs(i.baseline - anchor.baseline) < first.height * 1.5
      )
      return sd.length === 1 ? [anchor.rect[0], sd[0].rect[0]] : []
    }),
    p.rect[0]
  ]
  if (starts.length !== anchors.length * 2 + 2) return
  const columnOf = (i) => {
    for (let c = starts.length - 1; c > 0; c--)
      if (i.rect[0] >= starts[c] - first.height * 0.2) return c
    return 0
  }
  const joinedTokens = new Set()
  const records = []
  for (const label of labels) {
    const block = source.filter((i) => Math.abs(i.baseline - label.baseline) <= label.height * 1.5)
    const parts = starts.map((_, c) => block.filter((i) => columnOf(i) === c))
    if (parts[0].length !== 1 || parts[0][0] !== label) return
    for (let c = 1; c < parts.length; c++) {
      const tokens = parts[c]
      if (c % 2 || c === parts.length - 1) {
        if (
          tokens.length !== 1 ||
          !numeric(tokens[0]) ||
          Math.abs(tokens[0].baseline - label.baseline) > label.height * 0.3
        )
          return
      } else {
        if (
          tokens.length !== 2 ||
          !/^\(\d+\.\d+\)$/.test(tokens.map((i) => i.text).join('')) ||
          tokens[0].baseline >= label.baseline ||
          tokens[1].baseline <= label.baseline ||
          Math.abs(tokens[0].rect[0] - tokens[1].rect[0]) > label.height * 0.2
        )
          return
        joinedTokens.add(tokens[1])
      }
    }
    const rect = union(block)
    if (records.length && records.at(-1)[3] >= rect[1]) return
    records.push([left, rect[1], right, rect[3]])
  }
  // A full-width divider and repeated sample sizes bound two header tiers.
  const horizontal = rules.filter((r) => r[1] === r[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const borders = []
  for (const rule of horizontal) {
    const previous = borders.at(-1)
    if (
      previous &&
      Math.abs(previous[1] - rule[1]) < 0.01 &&
      rule[0] - previous[2] <= first.height * 0.05
    )
      previous[2] = Math.max(previous[2], rule[2])
    else borders.push([...rule])
  }
  const divider = borders.find(
    (r) =>
      r[0] <= left + 12 &&
      r[2] >= right - 12 &&
      r[1] < records[0][1] &&
      source.some(
        (i) =>
          i.text === 'Characteristic' && i.rect[3] < r[1] && r[1] - i.rect[3] < first.height * 6
      )
  )
  if (!divider) return
  const heading = source.filter((i) => i.rect[3] < divider[1])
  const sizes = heading.filter((i) => /^\(n\s*=\s*\d+\)$/i.test(i.text))
  if (
    sizes.length !== anchors.length ||
    sizes.some(
      (i, n) =>
        columnOf(i) !== n * 2 + 1 || Math.abs(i.baseline - sizes[0].baseline) > first.height * 0.3
    )
  )
    return
  const countTokens = heading.filter(
    (i) =>
      i.rect[1] > Math.max(...sizes.map((s) => s.rect[3])) &&
      columnOf(i) % 2 &&
      columnOf(i) < starts.length - 1
  )
  for (let c = 1; c < starts.length - 1; c += 2) {
    const words = countTokens.filter((i) => columnOf(i) === c)
    const compact = words.map((i) => i.text.replace(/\s/g, '')).join('')
    if (!/^Numberof(?:patients|participants)$/.test(compact) || words.length < 3) return
    let offset = 0
    for (const word of words) {
      if (offset && ![6, 8].includes(offset)) joinedTokens.add(word)
      offset += word.text.replace(/\s/g, '').length
    }
    const percent = heading.filter((i) => columnOf(i) === c + 1)
    if (percent.length !== 1 || !/^(?:%|\(%\))$/.test(percent[0].text)) return
    const parent = heading.filter((i) => columnOf(i) === c && !words.includes(i))
    if (
      parent.length < 2 ||
      parent.at(-1) !== sizes[(c - 1) / 2] ||
      !parent.slice(0, -1).every((i) => /^[\p{L}\s-]+$/u.test(i.text))
    )
      return
  }
  const stub = heading.filter((i) => columnOf(i) === 0)
  const comparison = heading.filter((i) => columnOf(i) === starts.length - 1)
  if (
    stub.length !== 1 ||
    stub[0].text !== 'Characteristic' ||
    !/^Pvalue[†*]?$/.test(comparison.map((i) => i.text).join(''))
  )
    return
  const split =
    (Math.max(...sizes.map((i) => i.rect[3])) + Math.min(...countTokens.map((i) => i.rect[1]))) / 2
  const rows = [
    [left, top, right, split],
    [left, split, right, divider[1]]
  ]
  const body = source.filter((i) => i.rect[1] > divider[1])
  const covered = (i) => records.some((r) => i.rect[1] >= r[1] && i.rect[3] <= r[3])
  const sections = body.filter((i) => !covered(i))
  if (sections.some((i) => columnOf(i) !== 0)) return
  const bands = []
  for (const item of sections) {
    const previous = bands.at(-1)
    if (previous && item.rect[1] <= previous[3]) previous[3] = Math.max(previous[3], item.rect[3])
    else bands.push([left, item.rect[1], right, item.rect[3]])
  }
  rows.push(...[...bands, ...records].sort((a, b) => a[1] - b[1]))
  const cuts = [left]
  for (let c = 1; c < starts.length; c++) {
    const previous = source.filter(
      (i) => columnOf(i) === c - 1 && (i.rect[1] > divider[1] || countTokens.includes(i))
    )
    if (!previous.length) return
    const end = Math.max(...previous.map((i) => i.rect[2]))
    if (end >= starts[c]) return
    cuts.push((end + starts[c]) / 2)
  }
  cuts.push(right)
  // Reject any token or actual dividing stroke crossing a reconstructed cell.
  if (
    source.some((i) => {
      const c = columnOf(i)
      const parent = i.rect[3] <= split && c > 0 && c < starts.length - 1 && c % 2
      return i.rect[0] < cuts[c] || i.rect[2] > cuts[c + (parent ? 2 : 1)]
    })
  )
    return
  if (
    rules.some(
      (r) =>
        r[1] === r[3] &&
        records.some(
          (row) => r[1] > row[1] && r[1] < row[3] && r[0] <= cuts[1] && r[2] >= cuts.at(-2)
        )
    )
  )
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: starts.length - 1, rowSpan: 2, colSpan: 1 },
      ...anchors.map((_, n) => ({ row: 0, column: n * 2 + 1, rowSpan: 1, colSpan: 2 }))
    ],
    joinedTokens,
    completeSpans: true
  }
}

// A complete estimate row followed by its intervals is one record. Require
// repeated paired baseline/follow-up headings and all six interval columns.
export function recoverEstimateIntervalGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const ci = source.filter((i) => i.text === '(95% CI)')
  const gm = source.filter((i) => i.text === 'GM')
  if (
    ci.length !== 4 ||
    gm.length !== 4 ||
    source.filter((i) => i.text === 'Absolute diff. (%)').length !== 2
  )
    return
  const headerBottom = Math.max(...ci.map((i) => i.rect[3]))
  const body = source.filter((i) => i.rect[1] > headerBottom + 1)
  const first = body[0]
  if (!first || !/\p{L}/u.test(first.text)) return
  const labels = body.filter(
    (i) => Math.abs(i.rect[0] - first.rect[0]) < first.height * 0.15 && /\p{L}/u.test(i.text)
  )
  if (labels.length < 8) return
  const firstRecord = body.filter((i) => Math.abs(i.baseline - first.baseline) < first.height * 0.3)
  if (
    firstRecord.length !== 9 ||
    firstRecord.slice(1).some((i) => !/^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(i.text))
  )
    return
  const centers = firstRecord.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const col = (i) =>
    centers.reduce(
      (best, x, c) =>
        Math.abs(x - (i.rect[0] + i.rect[2]) / 2) <
        Math.abs(centers[best] - (i.rect[0] + i.rect[2]) / 2)
          ? c
          : best,
      0
    )
  const groups = labels.map((label, n) =>
    body.filter(
      (i) =>
        i.rect[1] >= label.rect[1] - 0.1 && (!labels[n + 1] || i.rect[3] < labels[n + 1].rect[1])
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  for (const [n, group] of groups.entries()) {
    const parts = centers.map((_, c) => group.filter((i) => col(i) === c))
    if (parts[0].length !== 1 || parts[0][0] !== labels[n]) return
    for (let c = 1; c < 9; c++) {
      const p = parts[c]
      if (p.length !== (c <= 6 ? 2 : 1) || !/^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(p[0].text))
        return
      if (c <= 6 && (!/^\([\d\s.,−+-]+\)$/.test(p[1].text) || p[1].rect[1] <= p[0].rect[3])) return
    }
  }
  const parts = centers.map((_, c) => body.filter((i) => col(i) === c))
  const cuts = [
    left,
    ...parts
      .slice(1)
      .map(
        (p, c) =>
          (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...p.map((i) => i.rect[0]))) / 2
      ),
    right
  ]
  if (body.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])) return
  const parents = source.filter((i) => /\(N\s*=\s*\d+\)/i.test(i.text) && i.rect[3] < gm[0].rect[1])
  const comparison = source.filter((i) => /^P-value comparing changes$/.test(i.text))
  const child = source.filter((i) => /^(?:Baseline|12-Month|Change)$/.test(i.text))
  if (parents.length !== 2 || comparison.length !== 1 || child.length !== 6) return
  const split =
    (Math.max(...parents.map((i) => i.rect[3])) + Math.min(...child.map((i) => i.rect[1]))) / 2
  const lower = (Math.max(...gm.map((i) => i.rect[3])) + Math.min(...ci.map((i) => i.rect[1]))) / 2
  const rows = [
    [left, top, right, split],
    [left, split, right, lower],
    [left, lower, right, first.rect[1] - 0.1],
    ...groups.map((g) => {
      const r = union(g)
      return [left, r[1] - 0.1, right, r[3] + 0.1]
    })
  ]
  const spans = [
    { row: 0, column: 0, rowSpan: 3, colSpan: 1 },
    { row: 0, column: 1, rowSpan: 1, colSpan: 3 },
    { row: 0, column: 4, rowSpan: 1, colSpan: 3 },
    { row: 0, column: 7, rowSpan: 2, colSpan: 2 },
    ...Array.from({ length: 6 }, (_, c) => ({ row: 1, column: c + 1, rowSpan: 2, colSpan: 1 }))
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Mixed cohort tables use merged count cells above separate Mean/SD columns.
// Recover those columns from the repeated source headings, not the model count.
export function recoverMixedCohortGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const firstMean = source.find((i) => i.text === 'Mean')
  if (!firstMean) return
  const heads = source.filter(
    (i) =>
      /^(Mean|SD)$/.test(i.text) &&
      Math.abs(i.baseline - firstMean.baseline) < firstMean.height * 0.3
  )
  if (heads.length !== 8 || heads.some((i, c) => i.text !== (c % 2 ? 'SD' : 'Mean'))) return
  const centers = heads.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const stubEnd = Math.min(...heads.map((i) => i.rect[0])) - firstMean.height * 0.2
  const note = source.find((i) => /^\*\s*Includes\b|^Notes?\s*:/i.test(i.text))
  const stub = source.filter(
    (i) =>
      i.rect[2] < stubEnd &&
      (!note || i.rect[3] < note.rect[1]) &&
      i.height >= firstMean.height * 0.8
  )
  if (stub.length < 20) return
  const first = stub[0]
  const body = source.filter(
    (i) => i.rect[1] >= first.rect[1] - 0.1 && (!note || i.rect[3] < note.rect[1])
  )
  const col = (i) =>
    i.rect[2] < stubEnd
      ? 0
      : centers.reduce(
          (best, x, c) =>
            Math.abs(x - (i.rect[0] + i.rect[2]) / 2) <
            Math.abs(centers[best] - (i.rect[0] + i.rect[2]) / 2)
              ? c
              : best,
          0
        ) + 1
  const baselines = []
  for (const label of stub)
    if (!baselines.some((y) => Math.abs(y - label.baseline) < firstMean.height * 0.3))
      baselines.push(label.baseline)
  const groups = baselines.map((y) =>
    body.filter(
      (i) => i.height >= firstMean.height * 0.8 && Math.abs(i.baseline - y) < firstMean.height * 0.3
    )
  )
  for (const mark of body.filter((i) => i.height < firstMean.height * 0.8)) {
    const owners = groups.filter((g) =>
      g.some(
        (i) =>
          Math.abs(i.baseline - mark.baseline) < firstMean.height * 0.6 &&
          Math.abs(i.rect[2] - mark.rect[0]) < firstMean.height * 0.3
      )
    )
    if (owners.length !== 1) return
    owners[0].push(mark)
  }
  if (!hasUniqueRecordTokens(body, groups)) return
  const paired = body.filter(
    (i) => i.baseline >= firstMean.baseline && col(i) > 0 && !/^[-–]$/.test(i.text)
  )
  const parts = [
    body.filter((i) => col(i) === 0),
    ...centers.map((_, c) => paired.filter((i) => col(i) === c + 1))
  ]
  if (parts.some((p) => !p.length)) return
  const cuts = [
    left,
    ...parts
      .slice(1)
      .map(
        (p, c) =>
          (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...p.map((i) => i.rect[0]))) / 2
      ),
    right
  ]
  const spans = []
  let countRows = 0,
    meanRows = 0
  for (const [n, g] of groups.entries()) {
    const values = g.filter((i) => col(i) > 0)
    if (g[0].baseline < firstMean.baseline) {
      if (
        values.length !== 4 ||
        values.some((i) => !/^\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?%?\)$/.test(i.text))
      )
        return
      for (let c = 0; c < 4; c++) {
        const v = values[c]
        if (v.rect[0] < cuts[1 + c * 2] || v.rect[2] > cuts[3 + c * 2]) return
        spans.push({ row: n + 1, column: 1 + c * 2, rowSpan: 1, colSpan: 2 })
      }
      countRows++
    } else {
      const dash = values.filter((i) => /^[-–]$/.test(i.text))
      if (dash.length > 1) return
      if (dash.length) {
        if (dash[0].rect[0] < cuts[1] || dash[0].rect[2] > cuts[3]) return
        spans.push({ row: n + 1, column: 1, rowSpan: 1, colSpan: 2 })
      }
      const rest = values.filter((i) => !dash.includes(i))
      if (
        rest.length !== (dash.length ? 6 : 8) &&
        !(rest.length === 6 && rest.every((i) => /^(Mean|SD)$/.test(i.text)))
      )
        return
      if (
        rest.some(
          (i) =>
            !/^Mean$|^SD$|^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(i.text) ||
            i.rect[0] < cuts[col(i)] ||
            i.rect[2] > cuts[col(i) + 1]
        )
      )
        return
      meanRows++
    }
  }
  if (countRows < 8 || meanRows < 8) return
  const header = source.filter((i) => i.rect[3] < first.rect[1])
  for (let c = 1; c < 9; c += 2) {
    const h = header.filter(
      (i) => (i.rect[0] + i.rect[2]) / 2 >= cuts[c] && (i.rect[0] + i.rect[2]) / 2 < cuts[c + 2]
    )
    if (
      !h.some((i) => /\(N\s*=\s*\d+\)/i.test(i.text)) ||
      h.some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 2])
    )
      return
    spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  }
  return {
    rows: [
      [left, top, right, first.rect[1] - 0.1],
      ...groups.map((g) => {
        const r = union(g)
        return [left, r[1] - 0.1, right, r[3] + 0.1]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated strata provide independent row anchors and explicit shared trend
// values. A complete first stratum establishes every column without guessing.
export function recoverStratifiedIntervalGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const ci = source.filter((i) => i.text === 'GM (95% CI)')
  if (
    ci.length !== 2 ||
    !source.some((i) => i.text === 'p-trend') ||
    !source.some((i) => i.text === 'Absolute difference (%)')
  )
    return
  const end = Math.max(...ci.map((i) => i.baseline))
  const controls = source.filter((i) => i.text === 'Control' && i.rect[1] > end)
  if (controls.length < 2) return
  const first = source.filter(
    (i) => Math.abs(i.baseline - controls[0].baseline) < controls[0].height * 0.3
  )
  if (
    first.length !== 10 ||
    first[1] !== controls[0] ||
    first[6].text !== 'Ref.' ||
    first[7].text !== 'Ref.'
  )
    return
  const centers = first.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const col = (i) =>
    centers.reduce(
      (best, x, c) =>
        Math.abs(x - (i.rect[0] + i.rect[2]) / 2) <
        Math.abs(centers[best] - (i.rect[0] + i.rect[2]) / 2)
          ? c
          : best,
      0
    )
  const body = source.filter((i) => i.rect[1] > end + 1 && !/^\(?Continued\)?$/.test(i.text))
  const strata = body.filter((i) => col(i) === 1)
  if (strata.length !== controls.length * 3) return
  const groups = strata.map((s) =>
    body.filter((i) => Math.abs(i.baseline - s.baseline) < s.height * 0.3)
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  const parts = centers.map((_, c) => body.filter((i) => col(i) === c))
  if (parts.some((p) => !p.length)) return
  const cuts = [
    left,
    ...parts
      .slice(1)
      .map(
        (p, c) =>
          (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...p.map((i) => i.rect[0]))) / 2
      ),
    right
  ]
  const spans = []
  for (const [n, g] of groups.entries()) {
    const cells = centers.map((_, c) => g.filter((i) => col(i) === c))
    const control = n % 3 === 0
    if (
      strata[n].text !== strata[n % 3].text ||
      cells.some((p, c) => p.length !== (!control && [0, 8, 9].includes(c) ? 0 : 1))
    )
      return
    if (
      cells.slice(2).some((p) => p.length && !/^(?:Ref\.|[−+\d.][\d\s.,()%−+-]*)$/.test(p[0].text))
    )
      return
    if (g.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])) return
    if (control)
      for (const c of [0, 8, 9]) spans.push({ row: n + 2, column: c, rowSpan: 3, colSpan: 1 })
  }
  const header = source.filter((i) => i.rect[1] <= end + 1)
  const split = Math.min(...ci.map((i) => i.rect[1])) - 0.1
  spans.push(
    ...Array.from({ length: 6 }, (_, c) => ({ row: 0, column: c, rowSpan: 2, colSpan: 1 })),
    { row: 0, column: 6, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 8, rowSpan: 1, colSpan: 2 }
  )
  const rows = [
    [left, top, right, split],
    [left, split, right, Math.min(...body.map((i) => i.rect[1])) - 0.1],
    ...groups.map((g) => {
      const r = union(g)
      return [left, r[1] - 0.1, right, r[3] + 0.1]
    })
  ]
  if (header.some((i) => i.rect[0] < left || i.rect[2] > right)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Repeated arm/arm/P records establish shared outcome labels independently of
// model row spans. An isolated stub between complete triples is a section.
export function recoverRepeatedComparisonGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 5) return
  const source = tableSourceItems(items, table.cropRect)
  const header = source.find((i) => i.text === 'Group')
  if (!header) return
  const means = source
    .filter(
      (i) =>
        /^Mean\s*\(SD\)$/i.test(i.text) &&
        Math.abs(i.baseline - header.baseline) < header.height * 0.3
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  const pHeader = source.find((i) => /^P-value\*$/.test(i.text) && i.baseline < header.baseline + 1)
  if (means.length !== 2 || !pHeader) return
  const cuts = [
    left,
    header.rect[0] - 1,
    ...means.map((i) => i.rect[0] - 1),
    pHeader.rect[0] - 1,
    right
  ]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const col = (i) =>
    i.rect[0] < cuts[1] ? 0 : cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (
    source.some(
      (i) =>
        col(i) < 0 || (col(i) > 0 && (i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    )
  )
    return
  const body = source.filter((i) => i.rect[1] > header.baseline + 1)
  const anchors = body.filter((i) => col(i) === 1)
  if (anchors.length < 6 || anchors.length % 3 || !/^P[- ]?value\*+$/i.test(anchors[2].text)) return
  if (
    anchors.some((i, n) => i.text.toLowerCase() !== anchors[n % 3].text.toLowerCase()) ||
    anchors[0].text === anchors[1].text
  )
    return
  const groups = anchors.map((a) =>
    body.filter((i) => col(i) > 0 && Math.abs(i.baseline - a.baseline) < a.height * 0.3)
  )
  const stubs = []
  for (let n = 0; n < anchors.length; n += 3) {
    const label = body.filter(
      (i) =>
        col(i) === 0 && i.rect[1] >= anchors[n].rect[1] - 1 && i.baseline <= anchors[n + 2].baseline
    )
    if (!label.length || !label.some((i) => /\p{L}/u.test(i.text))) return
    stubs.push(label)
    for (let k = 0; k < 3; k++) {
      const row = groups[n + k]
      for (let c = 2; c < 5; c++) {
        const text = row
          .filter((i) => col(i) === c)
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
        if (
          k === 2
            ? c === 4
              ? text !== ''
              : !/^\*{0,3}[<>≤≥]?\d+(?:\.\d+)?$/.test(text)
            : c === 4
              ? !/^[<>≤≥]?\d+(?:\.\d+)?$/.test(text)
              : !/^[−+-]?\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(text)
        )
          return
      }
    }
  }
  const used = new Set(stubs.flat()),
    sections = []
  for (const i of body.filter((i) => col(i) === 0 && !used.has(i))) {
    const g = sections.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.3)
    if (g) g.push(i)
    else sections.push([i])
  }
  if (!hasUniqueRecordTokens(body, [...groups, ...stubs, ...sections])) return
  const records = groups.map((g, n) => ({ g, index: n, rect: union(g) }))
  records.push(...sections.map((g) => ({ g, index: -1, rect: union(g) })))
  records.sort((a, b) => a.rect[1] - b.rect[1])
  const starts = records.map((r) => r.rect[1] - 0.1)
  const bodyTop = Math.min(...body.map((i) => i.rect[1])) - 0.1
  const split = header.rect[1] - 0.1
  const rows = [
    [left, top, right, split],
    [left, split, right, bodyTop],
    ...records.map((r, n) => [
      left,
      starts[n],
      right,
      starts[n + 1] ?? Math.max(...body.map((i) => i.rect[3])) + 0.1
    ])
  ]
  const spans = []
  for (let n = 0; n < records.length; n++) {
    const r = records[n]
    if (r.index < 0) {
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: 5 })
      continue
    }
    if (r.index % 3 === 0) {
      if (records[n + 1]?.index !== r.index + 1 || records[n + 2]?.index !== r.index + 2) return
      spans.push({ row: n + 2, column: 0, rowSpan: 3, colSpan: 1 })
    }
  }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true,
    repair: 'repeated-comparison-grid-recovered'
  }
}

// A currency amount followed by a parenthesized deviation/interval is one
// record. All numeric columns must carry both parts before replacing row bands.
export function recoverCurrencySummaryGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 4) return
  const cuts = [
    left,
    ...predicted.slice(1).map((p, c) => left + (predicted[c].rect[2] + p.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const anchors = source.filter((i) => col(i) === 1 && /^[€£$][−-]?\d/.test(i.text))
  if (anchors.length < 3) return
  const body = source.filter((i) => i.rect[1] >= anchors[0].rect[1] - 1)
  const groups = anchors.map((a, n) =>
    body.filter(
      (i) => i.rect[1] >= a.rect[1] - 1 && i.rect[1] < (anchors[n + 1]?.rect[1] ?? Infinity) - 1
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  for (const g of groups) {
    if (!g.some((i) => col(i) === 0 && /\p{L}/u.test(i.text))) return
    if (g.some((i) => col(i) < 0 || i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
      return
    for (let c = 1; c < 4; c++) {
      const p = g.filter((i) => col(i) === c)
      const text = p
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
      if (!/^[€£$][−-]?\d[\d.,]*\([−-]?\d[\d.,–−-]*\)$/.test(text)) return
      if (
        Math.max(...p.map((i) => i.baseline)) - Math.min(...p.map((i) => i.baseline)) >
        p[0].height * 1.8
      )
        return
    }
  }
  return {
    rows: [
      [left, top, right, anchors[0].rect[1] - 0.1],
      ...groups.map((g) => {
        const r = union(g)
        return [left, r[1] - 0.1, right, r[3] + 0.1]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    completeSpans: true,
    repair: 'currency-summary-grid-recovered'
  }
}
