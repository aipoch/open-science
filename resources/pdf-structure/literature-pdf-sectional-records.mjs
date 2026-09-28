/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'
import { union, rebaseTableCrop } from './literature-pdf-table-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

// A repeated leaf category plus complete measurements anchors records beneath
// several sparse stub levels. Blank ancestors on a continuation stay blank.
export function recoverNestedMeasureRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 7 || columns.length > 12) return
  const borders = joinHorizontalTableRules(rules, 0.1)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16 && r[1] >= top && r[1] < top + 80
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length !== 2) return
  const source = tableSourceItems(items, table.cropRect),
    header = source.filter((i) => i.rect[3] < borders[1][1]),
    body = source.filter((i) => i.rect[1] > borders[1][1])
  if (!hasUniqueRecordTokens(source, [header, body])) return
  const heights = body.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = header.filter((i) => col(i) === c - 1),
      b = header.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (cuts[c] < end || cuts[c] > start) cuts[c] = (end + start) / 2
  }
  const headings = readSourceRow(header, cuts, { multiline: true })
  if (!headings) return
  const leaf = headings.findIndex((s) => /^(?:Treatment|Intervention|Condition)$/i.test(s))
  if (leaf < 3 || leaf > 5 || columns.length - leaf < 3) return
  const raw = groupSourceRowsWithScripts(body, height, 0.3)
  if (!raw) return
  const groups = []
  for (const g of raw) {
    const prev = groups.at(-1),
      populated = [...new Set(g.map(col))],
      text = g.map((i) => i.text).join(' ')
    if (
      prev &&
      populated.length === 1 &&
      populated[0] < leaf &&
      /^[a-z)]/.test(text) &&
      g[0].baseline - Math.max(...prev.map((i) => i.baseline)) < height * 1.5 &&
      prev.some((i) => col(i) === populated[0])
    )
      prev.push(...g)
    else groups.push([...g])
  }
  const values = groups.map((g) => {
    const cells = cuts.slice(1).map(() => [])
    for (const i of g) {
      const c = col(i)
      if (c < 0) return
      cells[c].push(i)
    }
    return cells.map((a) =>
      a
        .sort((a, b) =>
          Math.abs(a.baseline - b.baseline) > height * 0.35
            ? a.baseline - b.baseline
            : a.rect[0] - b.rect[0]
        )
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
  })
  if (values.some((v) => !v)) return
  const number = (s) => /^[−+-]?\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(s)
  const records = values.filter((v) => v[leaf] && v.slice(leaf + 1).every(number))
  if (records.length < 10 || new Set(records.map((v) => v[leaf])).size !== 2) return
  if (
    values.some((v) => v.slice(leaf).some(Boolean) && !(v[leaf] && v.slice(leaf + 1).every(number)))
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  const rows = [
      [left, borders[0][1], right, borders[1][1]],
      ...bounds.map((b) => [left, b[1], right, b[3]])
    ],
    spans = []
  for (let n = 0; n < groups.length; n++)
    for (let c = 0; c < leaf; c++) {
      if (!values[n][c]) continue
      const own = groups[n].filter((i) => col(i) === c),
        end = Math.max(...own.map((i) => i.rect[2]))
      const width = cuts.slice(c + 1).findIndex((x) => end <= x) + 1
      if (width < 1) return
      if (width > 1) {
        if (values[n].slice(c + 1, c + width).some(Boolean) || values[n].slice(leaf).some(Boolean))
          return
        spans.push({ row: n + 1, column: c, rowSpan: 1, colSpan: width })
        continue
      }
      let stop = n + 1
      while (stop < groups.length && !values[stop].slice(0, c + 1).some(Boolean)) stop++
      if (stop - n > 1) spans.push({ row: n + 1, column: c, rowSpan: stop - n, colSpan: 1 })
    }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Paired populations share section titles and separate probability rows. Native
// side segments prove the complete bands even when model rows skip an estimate.
export function recoverPairedOutcomeRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 5) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const sides = rules.filter(
    (r) => r[0] === r[2] && Math.abs(r[0] - left) < 10 && r[1] >= top && r[3] <= bottom
  )
  if (
    sides.filter((r) =>
      rules.some(
        (s) =>
          s[0] === s[2] &&
          Math.abs(s[0] - right) < 10 &&
          Math.abs(s[1] - r[1]) < 1 &&
          Math.abs(s[3] - r[3]) < 1
      )
    ).length < 20
  )
    return
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const raw = groupSourceRowsWithScripts(source, height, 0.3)
  if (!raw || raw.length < 15) return
  const headerEnd = raw.findIndex((g) =>
    readSourceRow(g, cuts)
      ?.slice(1)
      .every((s) => /^N=\d+$/.test(s))
  )
  if (headerEnd < 2 || headerEnd > 4) return
  const parents = readSourceRow(raw[0], [left, cuts[1], cuts[3], right])
  if (!parents || parents[0] || !parents.slice(1).every((s) => /\p{L}/u.test(s))) return
  const header = raw.slice(1, headerEnd + 1).flat(),
    leaves = readSourceRow(header, cuts, { multiline: true })
  if (
    !leaves ||
    !leaves[0] ||
    !leaves.slice(1).every((s) => /\p{L}.*N=\d/u.test(s)) ||
    leaves[1].replace(/N=\d+/, '') !== leaves[3].replace(/N=\d+/, '') ||
    leaves[2].replace(/N=\d+/, '') !== leaves[4].replace(/N=\d+/, '')
  )
    return
  const groups = [raw[0], header]
  for (const g of raw.slice(headerEnd + 1)) {
    const v = readSourceRow(g, cuts),
      prev = groups.at(-1)
    if (
      v &&
      v[0] &&
      !v.slice(1).some(Boolean) &&
      /^[a-z]/.test(v[0]) &&
      g[0].baseline - Math.max(...prev.map((i) => i.baseline)) < height * 1.5 &&
      readSourceRow(prev, cuts)?.slice(1).every(Boolean)
    )
      prev.push(...g)
    else groups.push(g)
  }
  if (!hasUniqueRecordTokens(source, groups)) return
  const spans = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 3, rowSpan: 1, colSpan: 2 }
  ]
  let records = 0,
    probabilities = 0,
    sections = 0
  for (let n = 2; n < groups.length; n++) {
    const g = groups[n],
      v = readSourceRow(g, cuts, { multiline: true })
    if (
      v &&
      v[0] &&
      v.slice(1).every((s) => /^(?:[<>≤≥−+-]?\d[\d.,%()–−+\-/]*|1\(ref\))$/.test(s))
    ) {
      records++
      continue
    }
    const pairs = readSourceRow(g, [left, cuts[1], cuts[3], right], { multiline: true })
    if (
      pairs &&
      /^P-?value$/i.test(pairs[0]) &&
      pairs.slice(1).every((s) => /^P=[0-9.·]+$/.test(s))
    ) {
      probabilities++
      spans.push(
        { row: n, column: 1, rowSpan: 1, colSpan: 2 },
        { row: n, column: 3, rowSpan: 1, colSpan: 2 }
      )
      continue
    }
    const text = g
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join(' ')
    if (
      !/^\p{L}/u.test(text) ||
      g[0].rect[0] > left + height * 1.5 ||
      union(g)[2] > cuts[2] ||
      (v && v.slice(1).some(Boolean)) ||
      (!v && g.some((i, k, all) => k && i.rect[0] - all[k - 1].rect[2] > height))
    )
      return
    sections++
    spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 5 })
  }
  // Continuations can contain just one outcome and its rate section. The
  // repeated header, complete records and two probability bands still prove
  // the same layout without requiring a third section from the previous page.
  if (records < 10 || sections < 2 || probabilities < 2) return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Native header bands can expose phantom model columns. Repeated numbered
// categorical records and enclosed sample-size sections independently prove
// their real gutters, section spans and scientific-notation probability cells.
export function recoverRuledCategoricalRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  if (!height) return
  const borders = joinHorizontalTableRules(rules, 0.1)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < 15 &&
        Math.abs(r[2] - right) < 15 &&
        r[1] >= top - height &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 5) return
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups) return
  const head = groups.findIndex(
    (g) =>
      g.length >= 7 &&
      g.every((i) => /\p{L}/u.test(i.text)) &&
      g.filter((i) => i.text.length > 3).length >= 5
  )
  if (head !== 1) return
  const header = groups[head].slice().sort((a, b) => a.rect[0] - b.rect[0]),
    labels = []
  for (const i of header) {
    const last = labels.at(-1)
    if (last && i.rect[0] - union(last)[2] < height * 0.6) last.push(i)
    else labels.push([i])
  }
  if (labels.length < 7 || labels.length > 12) return
  const boxes = labels.map(union),
    cuts = [left, ...boxes.slice(1).map((b, n) => (boxes[n][2] + b[0]) / 2), right]
  if (
    !/^P(?:value)?$/i.test(
      labels
        .at(-1)
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    )
  )
    return
  const spans = [],
    sections = [],
    values = groups.map((g) => readSourceRow(g, cuts))
  let expected = 1,
    records = 0
  for (let n = 0; n < groups.length; n++) {
    if (n === head) continue
    const v = values[n],
      g = groups[n],
      b = union(g),
      text = g
        .slice()
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
        .replace(/\s/g, '')
    if (
      /^\p{L}.*\(n=\d+\)[a-z]?$/u.test(text) &&
      borders.some((r) => r[1] <= b[1] && b[1] - r[1] < height * 2) &&
      borders.some((r) => r[1] >= b[3] && r[1] - b[3] < height * 2)
    ) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: labels.length })
      sections.push(n)
      expected = 1
      continue
    }
    if (
      !v ||
      v[0] !== String(expected++) ||
      !v.slice(1, -3).every((s) => /^[A-Z]$/.test(s)) ||
      !/^0?\.\d+$/.test(v.at(-3)) ||
      !(/^[−+-]?\d[\d.,()–−+\-/]*$/.test(v.at(-2)) || v.at(-2) === '—') ||
      !/^(?:[<>≤≥]?\d[\d.×−+-]*|—)$/.test(v.at(-1))
    )
      return
    records++
  }
  if (sections.length < 2 || sections[0] !== 0 || records < 6) return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: bounds.map((b) => [left, b[1], right, b[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [head],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Padded detection can cross the last record of the preceding panel. A native
// separator before the model's entire header and an aligned numeric row above
// it establish which side owns that record; never trim through native text.
export function separateAdjacentNumericPanel(table, items, rules) {
  if (table.detection?.origin === 'captioned-numeric-region')
    return rebaseTableCrop(table, table.detection.rect)
  const [left, top, right, bottom] = table.cropRect
  const headers = table.structure.objects.filter((o) => o.label === 'table column header')
  if (headers.length !== 1) return table
  const headerTop = top + headers[0].rect[1]
  const borders = joinHorizontalTableRules(rules, 0.1).filter(
    (r) =>
      Math.abs(r[0] - left) < 16 &&
      Math.abs(r[2] - right) < 16 &&
      r[1] > top &&
      r[1] < headerTop &&
      r[1] - top < 24
  )
  if (borders.length !== 1) return table
  const y = borders[0][1]
  const crossing = items.filter(
    (i) =>
      i.horizontal && i.rect[0] >= left && i.rect[2] <= right && i.rect[1] < y && i.rect[3] > top
  )
  if (
    crossing.length < 5 ||
    crossing.some((i) => i.rect[3] >= y) ||
    crossing.filter((i) => /^\d/.test(i.text)).length < 4 ||
    Math.max(...crossing.map((i) => i.baseline)) - Math.min(...crossing.map((i) => i.baseline)) >
      Math.min(...crossing.map((i) => i.height)) * 0.4
  )
    return table
  const heading = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= headerTop &&
      i.rect[3] <= top + headers[0].rect[3]
  )
  if (heading.filter((i) => /\p{L}/u.test(i.text)).length < 5) return table
  return rebaseTableCrop(table, [left, y, right, bottom])
}

// A full-width section band followed by underlined populations and repeated
// numeric records proves the parent spans, even when the model shifts a parent
// into a neighboring population. Blank probability cells remain empty.
export function recoverRuledComparisonPanel(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 7 || columns.length > 15) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.35)
  if (!groups || groups.length < 6) return
  const full = joinHorizontalTableRules(rules, 0.1).filter(
    (r) => Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16
  )
  const section = union(groups[0])
  if (
    !groups[0].every((i) => /\p{L}/u.test(i.text)) ||
    section[0] > left + height * 2 ||
    section[2] > cuts[columns.length - 2] ||
    !full.some((r) => r[1] <= section[1] && section[1] - r[1] < height * 2) ||
    !full.some((r) => r[1] >= section[3] && r[1] - section[3] < height * 2)
  )
    return
  const leaves = readSourceRow(groups[2], cuts)
  if (
    !leaves ||
    !leaves.every((s) => /\p{L}/u.test(s)) ||
    leaves.filter((s) => /^Pvalue[a-z]?$/i.test(s)).length < 1
  )
    return
  for (const g of groups.slice(3)) {
    const v = readSourceRow(g, cuts)
    if (
      !v ||
      !/^[\p{L}/-]+$/u.test(v[0]) ||
      v
        .slice(1)
        .some(
          (s, c) =>
            !/^(?:[<>≤≥−+-]?\d[\d.,()%±–−+\-/]*|—)$/.test(s) &&
            !(s === '' && /^Pvalue[a-z]?$/i.test(leaves[c + 1]))
        )
    )
      return
  }
  const header = groups.slice(1, 3).flat(),
    band = union(header)
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, band[1], band[3])
  if (
    !hierarchy ||
    hierarchy.rows.length !== 2 ||
    hierarchy.spans.filter((s) => s.row === 0 && s.colSpan > 1).length < 2
  )
    return
  const bounds = groups.slice(3).map(union)
  if (bounds.some((b, n) => b[1] <= (n ? bounds[n - 1][3] : band[3]))) return
  return {
    rows: [
      [left, section[1], right, section[3]],
      ...hierarchy.rows,
      ...bounds.map((b) => [left, b[1], right, b[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 0, rowSpan: 1, colSpan: columns.length },
      ...hierarchy.spans.map((s) => ({ ...s, row: s.row + 1 }))
    ],
    headerRows: [0, 1, 2],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
