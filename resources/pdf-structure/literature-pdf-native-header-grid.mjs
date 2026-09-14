/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens,
  groupSourceRowsWithScripts
} from './literature-pdf-source-records.mjs'

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
  const events = recoverRepeatedEventGrid(table, items, captions, rules)
  if (events) return events
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

// A detector can clip the glyph tops of an entire leading column header.
// One aligned label per column plus a full native underline establishes the
// missing row, including untitled resource-table continuations.
export function recoverClippedColumnHeader(table, items, rules) {
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
  const borders = rules
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
    lower = borders.at(-1),
    tier = borders.length === 4 ? borders[1] : undefined
  if (divider[1] - upper[1] > 80 || lower[1] - divider[1] < 70) return
  const left = Math.min(crop[0], upper[0]),
    right = Math.max(crop[2], upper[2]),
    top = upper[1],
    bottom = lower[1]
  const source = tableSourceItems(items, [left, top, right, bottom])
  const body = source.filter((i) => i.rect[1] >= divider[1])
  if (!body.length) return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  const groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups || groups.length < 8) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
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
    /^(?:(?:n=)?[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%/±–−+*a-z=<>≤≥-]*|\([\d.−–%-]+\)|[–—-][*†‡]?)$/i.test(
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
    sections.length < 2 ||
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
        !/\p{L}/u.test(v[0]) ||
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
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])
  )
    return
  const headRows = [[left, top, right, divider[1]]],
    spans = []
  const underlines = rules.filter(
    (r) =>
      !borders.includes(r) &&
      r[1] === r[3] &&
      r[1] > top &&
      r[1] < divider[1] &&
      r[0] > left &&
      r[2] < right
  )
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
          ? [{ row: n + headRows.length, column: 0, rowSpan: 1, colSpan: predicted.length }]
          : []
      )
    ],
    completeSpans: true,
    headerRows: headRows.map((_, n) => n),
    ownedTokens: new Set(source),
    repair: 'source-record-boundary-comparison-recovered'
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
