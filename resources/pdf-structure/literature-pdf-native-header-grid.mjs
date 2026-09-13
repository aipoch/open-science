/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Repeated short gaps in the top and bottom header rules identify columns.
// Accept only single-line records with indented labels and explicitly empty
// comparison cells. Wrapped labels and bare numeric continuation rows decline.
export function recoverNativeHeaderGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const lines = new Map()
  for (const r of rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)
    .sort((a, b) => a[0] - b[0])) {
    const band = lines.get(r[1]) ?? []
    band.push(r)
    lines.set(r[1], band)
  }
  const edges = [...lines].sort((a, b) => a[0] - b[0])
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
export function recoverClippedHeading({ rows, objects, groups, columnRects, rules, repairs }) {
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
  if (rect[1] >= first[1] || first[1] - rect[1] > height * 2) return
  const column = columnOf(leading[0])
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
    (confidence || comparison) &&
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
