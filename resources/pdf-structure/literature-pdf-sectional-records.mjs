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

// A cohort comparison may change from mean/deviation records to count/percent
// records, adding a total column only in the second section. Explicit repeated
// units and additive counts distinguish the two local header roles.
export function recoverMixedCohortSummaries(table, items) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 6) return
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    height = hs[Math.floor(hs.length / 2)]
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const values = lines.map((g) => readSourceRow(g, cuts))
  const units = values.findIndex(
    (v) =>
      v &&
      !v[0] &&
      v.slice(1, 4).every((s) => /^n\(%\)$/i.test(s)) &&
      /^[χx]2$/.test(v[4]) &&
      /^p$/i.test(v[5])
  )
  if (units < 8) return
  const heading = values.findIndex(
    (v) =>
      v &&
      /\p{L}/u.test(v[0]) &&
      v[1].includes('±') &&
      v[2].includes('±') &&
      /^Total$/i.test(v[3]) &&
      /^t$/i.test(v[4]) &&
      /^p$/i.test(v[5])
  )
  if (heading < 1 || heading > 3) return
  const parent = lines.slice(0, heading).flat()
  const parentValues = readSourceRow(
    parent,
    [cuts[0], cuts[1], cuts[2], cuts[3], cuts[4], cuts[6]],
    { multiline: true }
  )
  if (
    !parentValues ||
    parentValues[0] ||
    parentValues[3] ||
    !parentValues.slice(1, 3).every((s) => /\(?(?:n|N)=\d+\)?$/.test(s)) ||
    !/\p{L}/u.test(parentValues[4])
  )
    return
  const groups = [parent, lines[heading]],
    sections = [],
    headers = [0, 1]
  let counts = 0,
    summaries = 0
  const numeric = (s) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
  for (let n = heading + 1; n < lines.length; n++) {
    const g = lines[n],
      v = values[n]
    if (
      g.every((i) => /^[\p{L}\s()]+$/u.test(i.text) && i.rect[2] < cuts[2]) &&
      Math.min(...g.map((i) => i.rect[0])) < cuts[1]
    ) {
      sections.push(groups.length)
      groups.push(g)
      continue
    }
    if (!v) return
    if (n === units) {
      headers.push(groups.length)
      groups.push(g)
      continue
    }
    if (v[0] && v.slice(1).every((s) => !s)) {
      sections.push(groups.length)
      groups.push(g)
      continue
    }
    if (n < units) {
      if (
        !v[0] &&
        [1, 2].every((c) => /^\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\)$/.test(v[c])) &&
        v.slice(3).every((s) => !s) &&
        groups.at(-1).some((i) => i.text === '±') &&
        union(g)[1] - union(groups.at(-1))[3] < height
      ) {
        groups.at(-1).push(...g)
        continue
      }
      if (
        !v[0] ||
        ![1, 2].every((c) =>
          /^\d+(?:\.\d+)?±\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?\))?$/.test(v[c])
        ) ||
        v[3] ||
        !v.slice(4).every(numeric)
      )
        return
      summaries++
    } else {
      const count = v.slice(1, 4).map((s) => /^(\d+)\(\d+(?:\.\d+)?\)$/.exec(s))
      if (
        !v[0] ||
        count.some((m) => !m) ||
        Number(count[0][1]) + Number(count[1][1]) !== Number(count[2][1]) ||
        !(v.slice(4).every((s) => !s) || v.slice(4).every(numeric))
      )
        return
      counts++
    }
    groups.push([...g])
  }
  if (summaries < 4 || counts < 12 || sections.length < 4) return
  for (const n of sections) {
    const next = groups[n + 1]
    if (
      !next ||
      Math.min(...next.map((i) => i.rect[0])) - Math.min(...groups[n].map((i) => i.rect[0])) <
        height * 0.5
    )
      return
  }
  const bounds = groups.map(union)
  if (
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) ||
    !hasUniqueRecordTokens(source, groups)
  )
    return
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 0, column: 4, rowSpan: 1, colSpan: 2 },
      ...sections.map((row) => ({ row, column: 0, rowSpan: 1, colSpan: 6 }))
    ],
    headerRows: headers,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Dense count/percentage cohorts distinguish native section labels from empty
// model bands. The same columns may carry one interval summary per cohort.
export function recoverClinicalCountSections(table, items, rules) {
  const nested = recoverNestedCountSummaries(table, items, rules)
  if (nested) return nested
  const centered = recoverCenteredCohortSections(table, items, rules)
  if (centered) return centered
  const ratios = recoverRuledRatioCohorts(table, items, rules)
  if (ratios) return ratios
  const mixed = recoverPairedCountSummarySections(table, items, rules)
  if (mixed) return mixed
  const cohorts = recoverCompleteCountCohorts(table, items, rules)
  if (cohorts) return cohorts
  const [left, modelTop, right, bottom] = table.cropRect
  // Retain header glyphs whose baseline is inside the crop but whose ascent
  // was clipped by the detector. Do not pull in a separate caption baseline.
  const top = Math.min(
    modelTop,
    ...items
      .filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= left &&
          i.rect[2] <= right &&
          i.baseline > modelTop &&
          i.rect[1] < modelTop &&
          modelTop - i.rect[1] < i.height * 0.2
      )
      .map((i) => i.rect[1])
  )
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![3, 5].includes(columns.length)) return
  const source = tableSourceItems(items, [left, top, right, bottom])
  if (!source.length) return
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    height = hs[Math.floor(hs.length / 2)]
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const borders = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[0] <= left + height * 2 &&
      r[2] >= right - height * 2 &&
      r[1] > top &&
      r[1] < top + height * 8
  )
  const closing = borders.find(
    (r) =>
      source.some((i) => i.rect[3] < r[1] && /(?:#|No\.|N)\s*(?:\(%\))?$/.test(i.text.trim())) &&
      source.filter((i) => i.rect[3] < r[1] && /%/.test(i.text)).length >= 2
  )
  if (!closing) return
  const header = source.filter((i) => i.rect[3] < closing[1]),
    body = source.filter((i) => i.rect[1] > closing[1])
  if (!hasUniqueRecordTokens(source, [header, body])) return
  let groups = groupSourceRowsWithScripts(body, height, 0.3)
  if (!groups) return
  const repeatedHeaders = new Set()
  const fullRules = joinHorizontalTableRules(rules)
    .filter((r) => r[0] <= left + height * 2 && r[2] >= right - height * 2)
    .sort((a, b) => a[1] - b[1])
  for (let n = 1; n < fullRules.length; n++) {
    const upper = fullRules[n - 1][1],
      lower = fullRules[n][1]
    if (upper <= closing[1] || lower - upper > height * 4) continue
    const contained = groups.filter((g) => g.every((i) => i.rect[1] > upper && i.rect[3] < lower))
    const v = readSourceRow(contained.flat(), cuts, { multiline: true })
    if (contained.length >= 2 && v && v.slice(1).every((s) => /Mean\(SD\)$/.test(s))) {
      const merged = contained.flat(),
        start = groups.indexOf(contained[0])
      groups.splice(start, contained.length, merged)
      repeatedHeaders.add(merged)
    }
  }
  const bands = [],
    sections = [],
    summary = []
  let continuousHeader = false
  let measured = 0
  for (const g of groups) {
    const v = readSourceRow(g, cuts),
      previous = bands.at(-1)
    if (repeatedHeaders.has(g)) {
      bands.push(g)
      continuousHeader = true
      continue
    }
    if (
      g.length === 1 &&
      /^[*⁎†‡]$/.test(g[0].text) &&
      previous &&
      previous.every((i) => i.rect[2] < cuts[1]) &&
      Math.abs(g[0].rect[0] - Math.max(...previous.map((i) => i.rect[2]))) < height * 0.1 &&
      Math.abs(g[0].baseline - previous[0].baseline) < height * 0.6
    ) {
      previous.push(...g)
      continue
    }
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      if (
        /\(range\b/i.test(g.map((i) => i.text).join(' ')) &&
        previous &&
        !sections.includes(bands.length - 1) &&
        Math.min(...g.map((i) => i.rect[0])) > Math.min(...previous.map((i) => i.rect[0]))
      )
        previous.push(...g)
      else {
        if (!/\p{L}/u.test(v[0])) return
        sections.push(bands.length)
        bands.push([...g])
      }
    } else {
      const count =
        columns.length === 3
          ? v.slice(1).every((s) => /^\d+\(\d+(?:\.\d+)?%\)$/.test(s))
          : v.slice(1).every((s) => /^\d+(?:\.\d+)?$/.test(s))
      const interval = (s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?[−–-]\d+(?:\.\d+)?\)$/.test(s)
      const range =
        columns.length === 3
          ? v.slice(1).every(interval)
          : interval(v[1]) && !v[2] && interval(v[3]) && !v[4]
      // Continuous summaries can have a standard deviation, but must be
      // labelled as such and occur beside genuine count records.
      const continuous =
        (continuousHeader || /(?:mean|average)/i.test(v[0])) &&
        v.slice(1).every((s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(s))
      if (!count && !range && !continuous) return
      if (count) measured++
      if (range && columns.length === 5) summary.push(bands.length)
      bands.push([...g])
    }
  }
  if (sections.length < 3 || measured < 12) return
  const values = bands.map((g) => readSourceRow(g, cuts, { multiline: true }))
  for (const n of sections) {
    const children = bands.slice(n + 1, sections.find((s) => s > n) ?? bands.length)
    if (
      !children.length ||
      !children.some(
        (g) =>
          Math.min(...g.filter((i) => i.rect[2] < cuts[1]).map((i) => i.rect[0])) >
          Math.min(...bands[n].map((i) => i.rect[0])) + height * 0.4
      )
    )
      return
  }
  if (values.some((v) => !v)) return
  const hierarchy =
    columns.length === 3
      ? { rows: [[left, Math.min(...header.map((i) => i.rect[1])), right, closing[1]]], spans: [] }
      : recoverRuledHeaderBands(header, cuts, rules, top, closing[1])
  if (!hierarchy) return
  const rects = bands.map(union)
  if (rects.some((r, n) => n && r[1] < rects[n - 1][3])) return
  return {
    rows: [...hierarchy.rows, ...rects.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      ...hierarchy.spans,
      ...sections.map((n) => ({
        row: hierarchy.rows.length + n,
        column: 0,
        rowSpan: 1,
        colSpan: columns.length
      })),
      ...summary.flatMap((n) =>
        [1, 3].map((c) => ({ row: hierarchy.rows.length + n, column: c, rowSpan: 1, colSpan: 2 }))
      )
    ],
    headerRows: hierarchy.rows.map((_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Two cohort columns can mix slash counts with mean/deviation summaries.
// Full native rules, sample-qualified headers and complete paired values make
// section and wrapped-label ownership independent of overlapping model rows.
function recoverRuledRatioCohorts(table, items, rules) {
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 3) return
  const borders = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 8 &&
      r[1] <= crop[3] + 8
  )
  if (borders.length !== 3) return
  const frame = [
    Math.min(crop[0], borders[0][0]),
    borders[0][1],
    Math.max(crop[2], borders[0][2]),
    borders[2][1]
  ]
  const source = tableSourceItems(items, frame),
    header = source.filter((i) => i.rect[3] < borders[1][1]),
    body = source.filter((i) => i.rect[1] > borders[1][1])
  const heights = body.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const cuts = [
    frame[0],
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    frame[2]
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const heads = readSourceRow(
    header.filter((i) => col(i) > 0 && i.rect[0] >= cuts[col(i)] && i.rect[2] <= cuts[col(i) + 1]),
    cuts,
    { multiline: true }
  )
  if (!heads || !heads.slice(1).every((v) => /\(n=\d+\)/i.test(v))) return
  const groups = groupSourceRowsWithScripts(body, height, 0.35)
  if (!groups) return
  const bands = [],
    sections = []
  let ratios = 0,
    records = 0
  for (const g of groups) {
    const v = readSourceRow(g, cuts),
      previous = bands.at(-1)
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      if (
        previous &&
        /^\([^()]+\)$/.test(v[0]) &&
        union(g)[1] - union(previous)[3] < height &&
        !sections.includes(bands.length - 1)
      )
        previous.push(...g)
      else {
        if (!/\p{L}/u.test(v[0])) return
        sections.push(bands.length)
        bands.push([...g])
      }
    } else {
      if (
        !v
          .slice(1)
          .every((s) => /^\d+(?:\.\d+)?(?:\/\d+|±\d+(?:\.\d+)?(?:,?\(\d+[−–-]\d+\))?)?$/.test(s))
      )
        return
      if (v.slice(1).every((s) => /^\d+\/\d+$/.test(s))) ratios++
      records++
      bands.push([...g])
    }
  }
  if (
    records < 10 ||
    ratios < 3 ||
    sections.length < 3 ||
    !hasUniqueRecordTokens(source, [header, ...bands])
  )
    return
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, frame[1], borders[1][1])
  if (!hierarchy) return
  const rects = bands.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    cropRect: frame,
    rows: [...hierarchy.rows, ...rects.map((r) => [frame[0], r[1], frame[2], r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: hierarchy.rows.map((_, n) => n),
    spans: [
      ...hierarchy.spans,
      ...sections.map((row) => ({
        row: row + hierarchy.rows.length,
        column: 0,
        rowSpan: 1,
        colSpan: 3
      }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Complete cohort values anchor rows in tables with a parent stub and a leaf
// category. Native rules and sample headings establish the table; sparse parent
// labels span only consecutive counted children before the next parent/summary.
function recoverNestedCountSummaries(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 5) return
  const borders = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16 && r[1] >= top && r[1] <= bottom
  )
  if (borders.length !== 3) return
  const source = tableSourceItems(items, [left, borders[0][1], right, borders[2][1]])
  const header = source.filter((i) => i.rect[3] < borders[1][1])
  const body = source.filter(
    (i) =>
      i.rect[1] > borders[1][1] ||
      (i.rect[3] > borders[1][1] && borders[1][1] - i.rect[1] < i.height * 0.1)
  )
  if (!body.length || !hasUniqueRecordTokens(source, [header, body])) return
  const height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parents = body.filter((i) => col(i) === 0)
  const children = body.filter((i) => col(i) === 1)
  if (!parents.length || !children.length) return
  const parentEnd = Math.max(...parents.map((i) => i.rect[2]))
  const childStart = Math.min(...children.map((i) => i.rect[0]))
  if (parentEnd >= childStart) return
  // Correct only a modest overhang inside an otherwise empty stub gutter.
  if (cuts[1] < parentEnd) {
    if (parentEnd - cuts[1] > height * 2) return
    cuts[1] = (parentEnd + childStart) / 2
  }
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, borders[0][1], borders[1][1])
  if (!hierarchy) return
  const heading = readSourceRow(
    header.filter((i) => col(i) >= 2 && i.rect[1] >= hierarchy.rows.at(-1)[1]),
    cuts,
    { multiline: true }
  )
  if (
    !heading ||
    !heading.slice(2, 4).every((s) => /\p{L}.*\(n=\d+\)$/iu.test(s)) ||
    !/^P$/i.test(heading[4])
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.35)
  if (!groups) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  const count = (s) => /^(?:0|\d+\((?:%\d+(?:\.\d+)?|\d+(?:\.\d+)?%)\))$/.test(s)
  const summary = (s) => /^\d+(?:\.\d+)?(?:±\d+(?:\.\d+)?|\(\d+(?:\.\d+)?,\d+(?:\.\d+)?\))$/.test(s)
  const probability = (s) => /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[a-zα-ω*#†‡♉]*$/.test(s)
  let counted = 0,
    measured = 0,
    parentCount = 0
  const spans = []
  let owner = -1
  for (let n = 0; n < values.length; n++) {
    const v = values[n]
    if (!v || (v[4] && !probability(v[4]))) return
    if (v[1]) {
      if (!v.slice(2, 4).every(count)) return
      if (v[0]) {
        if (!/\p{L}.*n\(%\)$/iu.test(v[0])) return
        owner = n
        parentCount++
      }
      if (owner < 0) return
      counted++
    } else {
      if (!v[0] || !v[4] || !v.slice(2, 4).every(summary)) return
      owner = -1
      measured++
      spans.push({ row: hierarchy.rows.length + n, column: 0, rowSpan: 1, colSpan: 2 })
    }
  }
  if (counted < 6 || parentCount < 3 || measured < 1) return
  for (let n = 0; n < values.length; n++) {
    if (!values[n][0] || !values[n][1]) continue
    let end = n + 1
    while (end < values.length && !values[end][0] && values[end][1]) end++
    if (end - n < 2) return
    spans.push({ row: hierarchy.rows.length + n, column: 0, rowSpan: end - n, colSpan: 1 })
  }
  const centers = groups.map((g) => [
    Math.min(...g.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...g.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (centers.some((r, n) => n && r[0] <= centers[n - 1][1])) return
  const ys = [
    borders[1][1],
    ...centers.slice(1).map((r, n) => (centers[n][1] + r[0]) / 2),
    borders[2][1]
  ]
  return {
    rows: [...hierarchy.rows, ...groups.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [...hierarchy.spans, ...spans],
    headerRows: hierarchy.rows.map((_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated complete count/percentage records establish row ownership more
// reliably than empty or overlapping model rows. Preserve independent section
// labels and attach only tightly spaced indented/lowercase stub continuations.
function recoverCompleteCountCohorts(table, items, rules) {
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 8) return
  const cuts = [
    crop[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  const source = tableSourceItems(items, crop).filter(
    (i) => !/^\(Table\s+\d+\s+continues on (?:the )?next page\)$/i.test(i.text.trim())
  )
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const numeric = (s) => /^[-+−<>≤≥]?\d[\d.,·–−+%()/<>≤≥-]*$/.test(s)
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[0] <= crop[0] + 16 && r[2] >= crop[2] - 16 && r[1] > crop[1] && r[1] - crop[1] < height * 8
  )
  for (const divider of edges) {
    const header = source.filter((i) => i.rect[3] < divider[1]),
      body = source.filter((i) => i.rect[1] > divider[1])
    if (!header.length || !body.length || !hasUniqueRecordTokens(source, [header, body])) continue
    const physical = groupSourceRowsWithScripts(body, height, 0.3)
    if (!physical) continue
    const groups = [],
      sections = []
    let counts = 0,
      valid = true
    for (const g of physical) {
      const v = readSourceRow(g, cuts),
        text = g.map((i) => i.text).join(' ')
      const stubOnly =
        g.some((i) => i.rect[0] < cuts[1]) &&
        g.every((i) => i.rect[0] < cuts[1] || /^[*†‡§‖]$/.test(i.text))
      if (stubOnly && /\p{L}/u.test(text)) {
        const prev = groups.at(-1),
          r = union(g),
          before = prev && union(prev)
        const prevStub = prev?.filter((i) => i.rect[2] < cuts[1]) ?? []
        if (
          prev &&
          !sections.includes(groups.length - 1) &&
          prevStub.length &&
          g[0].baseline - Math.max(...prev.map((i) => i.baseline)) < height * 1.4 &&
          (r[0] - Math.min(...prevStub.map((i) => i.rect[0])) > height * 0.4 ||
            /^[a-z]/.test(text) ||
            /[–-]$/.test(prevStub.at(-1).text)) &&
          r[1] >= before[3] - height * 0.15
        )
          prev.push(...g)
        else {
          sections.push(groups.length)
          groups.push([...g])
        }
      } else if (v && v[0] && v.slice(1).every(numeric)) {
        if (
          v
            .slice(1)
            .every(
              (s) => /\d(?:\/\d+)?\([<>]?\d[\d.,·]*%\)$/.test(s) || s === '0' || /^0\/\d+$/.test(s)
            )
        )
          counts++
        groups.push([...g])
      } else {
        valid = false
        break
      }
    }
    if (!valid || counts < 12 || sections.length < 3 || !hasUniqueRecordTokens(body, groups))
      continue
    const hierarchy = recoverRuledHeaderBands(header, cuts, rules, crop[1], divider[1])
    if (!hierarchy) continue
    const centers = groups.map((g) => [
      Math.min(...g.map((i) => (i.rect[1] + i.rect[3]) / 2)),
      Math.max(...g.map((i) => (i.rect[1] + i.rect[3]) / 2))
    ])
    if (centers.some((r, n) => n && r[0] <= centers[n - 1][1])) continue
    const ys = [
      divider[1],
      ...centers.slice(1).map((r, n) => (centers[n][1] + r[0]) / 2),
      Math.max(...body.map((i) => i.rect[3]))
    ]
    return {
      rows: [...hierarchy.rows, ...groups.map((_, n) => [crop[0], ys[n], crop[2], ys[n + 1]])],
      columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, crop[3]]),
      headerRows: hierarchy.rows.map((_, n) => n),
      spans: [
        ...hierarchy.spans,
        ...sections.map((n) => ({
          row: hierarchy.rows.length + n,
          column: 0,
          rowSpan: 1,
          colSpan: columns.length
        }))
      ],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
}

// A mean/deviation cell can occupy the same width as a later n/% pair.
// Native cohort underlines and repeated unit headings establish both grids;
// section probabilities remain independent of the following counted records.
function recoverPairedCountSummarySections(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 6 || columns.length > 10 || columns.length % 2) return
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (!height) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const last = columns.length - 1,
    pairs = (columns.length - 2) / 2
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const units = lines.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return (
      v &&
      !v[0] &&
      /^p[a-z]?$/i.test(v.at(-1)) &&
      v.slice(1, -1).every((s, c) => s === (c % 2 ? '%' : 'n'))
    )
  })
  if (units < 4 || units > 8) return
  const horizontal = joinHorizontalTableRules(rules)
  const divider = horizontal
    .filter(
      (r) =>
        r[0] <= left + height &&
        r[2] >= right - height &&
        r[1] > top &&
        r[1] < union(lines[units])[1]
    )
    .at(-1)
  if (!divider) return
  const underlines = horizontal
    .filter(
      (r) => r[0] > left + height * 2 && r[2] < right - height && r[1] > top && r[1] < divider[1]
    )
    .sort((a, b) => a[0] - b[0])
  if (
    underlines.length !== pairs ||
    underlines.some((r) => Math.abs(r[1] - underlines[0][1]) > 0.1)
  )
    return
  const header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (!hasUniqueRecordTokens(source, [header, body])) return
  for (let p = 1; p < pairs; p++) {
    const edge = (underlines[p - 1][2] + underlines[p][0]) / 2
    if (Math.abs(edge - cuts[1 + p * 2]) > height * 2) return
    cuts[1 + p * 2] = edge
  }
  const pHeader = header.filter((i) => i.rect[0] > underlines.at(-1)[2])
  if (!pHeader.length) return
  cuts[last] = (underlines.at(-1)[2] + Math.min(...pHeader.map((i) => i.rect[0]))) / 2
  const coarse = [left, ...cuts.filter((_, c) => c % 2 === 1 && c < cuts.length - 1), right]
  const headerLines = groupSourceRowsWithScripts(header, height, 0.3)
  const headerValues = headerLines?.map((g) => readSourceRow(g, coarse))
  if (!headerValues || headerValues.some((v) => !v)) return
  const heading = coarse.slice(1).map((_, c) => headerValues.map((v) => v[c]).join(''))
  if (
    !heading ||
    !/\p{L}/u.test(heading[0]) ||
    !/^p[a-z]?$/i.test(heading.at(-1)) ||
    !heading.slice(1, -1).every((s) => /\p{L}.*\(n=\d+\)Mean±SD$/iu.test(s))
  )
    return
  const physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (!physical) return
  const groups = [],
    kinds = []
  let split = false,
    summaries = 0,
    counts = 0
  const probability = (s) => /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[a-z*†‡]*$/.test(s)
  for (const g of physical) {
    const v = readSourceRow(g, cuts)
    if (
      !split &&
      v &&
      !v[0] &&
      /^p[a-z]?$/i.test(v.at(-1)) &&
      v.slice(1, -1).every((s, c) => s === (c % 2 ? '%' : 'n'))
    ) {
      split = true
      groups.push([...g])
      kinds.push('units')
      continue
    }
    if (!split) {
      const summary = readSourceRow(g, coarse)
      if (
        !summary ||
        !/\p{L}/u.test(summary[0]) ||
        !probability(summary.at(-1)) ||
        !summary.slice(1, -1).every((s) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(s))
      )
        return
      summaries++
      groups.push([...g])
      kinds.push('summary')
      continue
    }
    if (!v || !v[0]) return
    if (v.slice(1, -1).every((s) => /^\d+$/.test(s)) && (!v.at(-1) || probability(v.at(-1)))) {
      counts++
      groups.push([...g])
      kinds.push('count')
      continue
    }
    if (v.slice(1, -1).some(Boolean) || (v.at(-1) && !probability(v.at(-1)))) return
    const previous = groups.at(-1),
      label = g.filter((i) => i.rect[2] < cuts[1])
    const previousLabel = previous?.filter((i) => i.rect[2] < cuts[1]) ?? []
    const tight =
      previousLabel.length &&
      union(g)[1] >= union(previous)[3] &&
      g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.4
    if (
      !v.at(-1) &&
      tight &&
      (/^[a-z]/.test(v[0]) || union(label)[0] - union(previousLabel)[0] > height * 0.4)
    ) {
      previous.push(...g)
    } else {
      groups.push([...g])
      kinds.push(v.at(-1) ? 'statistic' : 'label')
    }
  }
  if (
    summaries < 2 ||
    counts < 8 ||
    kinds.filter((k) => k === 'statistic').length < 3 ||
    !hasUniqueRecordTokens(body, groups)
  )
    return
  const spans = []
  for (let c = 1; c < last; c += 2) spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
  for (let n = 0; n < groups.length; n++) {
    if (kinds[n] === 'summary') {
      for (let c = 1; c < last; c += 2)
        spans.push({ row: n + 1, column: c, rowSpan: 1, colSpan: 2 })
    } else if (['statistic', 'label'].includes(kinds[n]) && kinds[n + 1] === 'count') {
      const stub = (g) => g.filter((i) => i.rect[2] < cuts[1])
      if (union(stub(groups[n + 1]))[0] - union(stub(groups[n]))[0] > height * 0.4)
        spans.push({
          row: n + 1,
          column: 0,
          rowSpan: 1,
          colSpan: kinds[n] === 'statistic' ? last : columns.length
        })
    }
  }
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: [[left, top, right, divider[1]], ...bounds.map((b) => [left, b[1], right, b[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, kinds.indexOf('units') + 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Numbered regression models may share cohort boundaries while changing from
// two estimate/probability pairs to one. Native segmented outer rules and
// repeated n/CI/p headings prove the common fine grid and its local colspans.
export function recoverNumberedModelSections(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    height = hs[Math.floor(hs.length / 2)]
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const compact = (g) =>
    g
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
  const models = lines.flatMap((g, n) => (/^Model\d+[a-z]?$/.test(compact(g)) ? [{ n, g }] : []))
  if (
    models.length !== 2 ||
    models[0].n !== 0 ||
    models.some((m, n) => Number(compact(m.g).match(/\d+/)[0]) !== n + 1)
  )
    return
  const edge = rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] < Math.min(...source.map((i) => i.rect[1])))
    .sort((a, b) => a[0] - b[0])
  if (
    edge.length !== 11 ||
    edge.some(
      (r, n) => n && (Math.abs(r[1] - edge[0][1]) > 0.01 || Math.abs(r[0] - edge[n - 1][2]) > 0.01)
    )
  )
    return
  const cuts = [left, ...edge.slice(1).map((r) => r[0] - height * 0.08), right]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const rows = [],
    spans = [],
    owned = [],
    headerRows = []
  for (let s = 0; s < models.length; s++) {
    const section = lines.slice(models[s].n, models[s + 1]?.n ?? lines.length)
    const leaf = section.findIndex(
      (g) => g.filter((i) => i.text === 'n' && [1, 6].includes(col(i))).length === 2
    )
    if (leaf < 3 || leaf > 5) return
    const first = section.findIndex(
      (g, n) =>
        n > leaf && g.filter((i) => /^\d+$/.test(i.text) && [1, 6].includes(col(i))).length === 2
    )
    if (first < 0) return
    const header = section.slice(0, first).flat(),
      leafItems = section[leaf]
    const active = leafItems.filter((i) => col(i) > 0).sort((a, b) => a.rect[0] - b.rect[0])
    const expected = s ? [1, 2, 5, 6, 7, 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    if (
      active.length !== expected.length ||
      active.some((i, n) => col(i) !== expected[n]) ||
      active.filter((i) => /CI/.test(i.text)).length !== (s ? 2 : 4) ||
      active.filter((i) => i.text === 'p').length !== (s ? 2 : 4)
    )
      return
    const titleBottom = Math.max(...section[0].map((i) => i.rect[3])),
      cohort = section[1]
    if (
      cohort.some((i) => col(i) < 1) ||
      ![1, 6].every((c) =>
        readSourceRow(
          cohort.filter((i) => col(i) >= c && col(i) < c + 5),
          [cuts[c], cuts[c + 5]]
        )
      )
    )
      return
    const effect = section[2],
      dataTop = Math.min(...section[first].map((i) => i.rect[1]))
    const split0 = (titleBottom + Math.min(...cohort.map((i) => i.rect[1]))) / 2
    const split1 =
      (Math.max(...cohort.map((i) => i.rect[3])) + Math.min(...effect.map((i) => i.rect[1]))) / 2
    const split2 =
      (Math.max(...effect.filter((i) => col(i) > 0).map((i) => i.rect[3])) +
        Math.min(...active.map((i) => i.rect[1]))) /
      2
    if (!(split0 < split1 && split1 < split2 && split2 < dataTop)) return
    const offset = rows.length
    rows.push(
      [left, Math.min(...section[0].map((i) => i.rect[1])), right, split0],
      [left, split0, right, split1],
      [left, split1, right, split2],
      [left, split2, right, dataTop - height * 0.1]
    )
    headerRows.push(offset, offset + 1, offset + 2, offset + 3)
    spans.push({ row: offset, column: 0, rowSpan: 1, colSpan: 11 })
    for (const c of [1, 6]) spans.push({ row: offset + 1, column: c, rowSpan: 1, colSpan: 5 })
    for (const c of s ? [2, 7] : [2, 4, 7, 9])
      spans.push({ row: offset + 2, column: c, rowSpan: 1, colSpan: s ? 4 : 2 })
    if (s) {
      spans.push({ row: offset + 2, column: 0, rowSpan: 2, colSpan: 1 })
      for (const c of [2, 7]) spans.push({ row: offset + 3, column: c, rowSpan: 1, colSpan: 3 })
    }
    owned.push(header)
    const groups = []
    for (const g of section.slice(first)) {
      if (g.every((i) => col(i) === 0)) {
        const previous = groups.at(-1)
        if (
          !previous ||
          g[0].baseline - Math.max(...previous.map((i) => i.baseline)) > height * 1.5
        )
          return
        previous.push(...g)
      } else groups.push([...g])
    }
    if (groups.length < 3) return
    for (const g of groups) {
      const v = readSourceRow(g, cuts, { multiline: true })
      if (!v || !/^\d+$/.test(v[1]) || !/^\d+$/.test(v[6])) return
      const estimate = (v) => /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?,\d+(?:\.\d+)?\)$/.test(v)
      const probability = (v) => /^\d+(?:\.\d+)?$/.test(v)
      for (const c of [1, 6]) {
        if (s) {
          if (
            v[c + 2] ||
            v[c + 3] ||
            ((v[c + 1] || v[c + 4]) && !(estimate(v[c + 1]) && probability(v[c + 4])))
          )
            return
        } else
          for (const d of [1, 3])
            if ((v[c + d] || v[c + d + 1]) && !(estimate(v[c + d]) && probability(v[c + d + 1])))
              return
      }
      const rect = union(g),
        row = rows.length
      rows.push([left, rect[1], right, rect[3]])
      if (s) for (const c of [2, 7]) spans.push({ row, column: c, rowSpan: 1, colSpan: 3 })
      owned.push(g)
    }
  }
  if (!hasUniqueRecordTokens(source, owned) || rows.some((r, n) => n && r[1] < rows[n - 1][3]))
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Wide count matrices can have several sparse ancestor stubs and wrapped sums.
// Recover from complete native count rows, paired repeated leaf labels and
// explicit cohort sample sizes; keep every printed summand rather than compute it.
export function recoverNestedCountRecords(table, items) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    height = hs[Math.floor(hs.length / 2)]
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const first = lines.findIndex((g) => g.some((i) => /\(n\s*=\s*\d/i.test(i.text)))
  if (first < 0 || first > 4) return
  const body = lines.slice(first)
  const numeric = (s) =>
    /^(?:[-–—]|\d+(?:\.\d+)?%?|\d+(?:\s*\+\s*\d+)+(?:\s*\+)?|\d+\s*\+)$/.test(s.trim())
  const firstValues = body[0].filter((i) => numeric(i.text))
  if (firstValues.length < 12 || firstValues.length > 24 || firstValues.length % 2) return
  const numericLeft = Math.min(...firstValues.map((i) => i.rect[0]))
  const segments = body
    .flat()
    .filter((i) => i.rect[0] >= numericLeft - height)
    .map((i) => [i.rect[0], i.rect[2]])
    .sort((a, b) => a[0] - b[0])
  const blocks = []
  for (const r of segments) {
    const last = blocks.at(-1)
    if (last && r[0] - last[1] < height * 0.25) last[1] = Math.max(last[1], r[1])
    else blocks.push([...r])
  }
  if (blocks.length !== firstValues.length) return
  const stubItems = body.flat().filter((i) => i.rect[2] < blocks[0][0])
  const stubBlocks = []
  for (const i of stubItems.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = stubBlocks.at(-1)
    if (last && i.rect[0] - last[1] < height * 0.25) last[1] = Math.max(last[1], i.rect[2])
    else stubBlocks.push([i.rect[0], i.rect[2]])
  }
  if (stubBlocks.length < 2 || stubBlocks.length > 4) return
  const allBlocks = [...stubBlocks, ...blocks],
    stubCount = stubBlocks.length,
    leaf = stubCount - 1
  const cuts = [left, ...allBlocks.slice(1).map((r, n) => (allBlocks[n][1] + r[0]) / 2), right]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const groups = [],
    floating = []
  for (const g of body) {
    const v = readSourceRow(g, cuts),
      previous = groups.at(-1)
    if (!v) return
    if (!v.slice(leaf).some(Boolean) && g.every((i) => col(i) < leaf - 1)) {
      floating.push(g)
      continue
    }
    const p = previous && readSourceRow(previous, cuts, { multiline: true })
    const percentage =
      previous &&
      !v[leaf] &&
      v.slice(stubCount).every((s) => /^(?:\d+(?:\.\d+)?%|0)$/.test(s)) &&
      v.slice(stubCount).some((s) => s.endsWith('%')) &&
      p.slice(stubCount).every((s) => /^\d+$/.test(s))
    const tail =
      previous &&
      g[0].baseline - Math.max(...previous.map((i) => i.baseline)) <
        height * (percentage ? 2 : 1.3) &&
      (!v[leaf] || (!/\d/.test(v[leaf]) && !/\d/.test(p[leaf]))) &&
      (!v.slice(stubCount).some(Boolean) ||
        p.slice(stubCount).some((s) => s.endsWith('+')) ||
        percentage)
    if (tail) previous.push(...g)
    else groups.push([...g])
  }
  if (groups.length < 6 || groups.length % 2) return
  const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
  if (
    values.some(
      (v) => !v || !v[leaf] || !v.slice(stubCount).every((s) => numeric(s) && !s.endsWith('+'))
    )
  )
    return
  // One leaf category is numbered, the other a wrapped alphabetic aggregate.
  // Both recur in every cohort. Allow a one-letter source spelling difference
  // for recognition, while retaining every original label in the output.
  const label = (s) => s.toLowerCase().replace(/s$/, '')
  const sameLabel = (a, b) =>
    a === b ||
    (Math.abs(a.length - b.length) === 1 &&
      [...(a.length > b.length ? a : b)].some(
        (_, n) =>
          (a.length > b.length ? a : b).slice(0, n) + (a.length > b.length ? a : b).slice(n + 1) ===
          (a.length > b.length ? b : a)
      ))
  if (
    !/\d/.test(values[0][leaf]) ||
    /\d/.test(values[1][leaf]) ||
    values.some((v, n) => !sameLabel(label(v[leaf]), label(values[n % 2][leaf])))
  )
    return
  const cohort = leaf - 1
  if (
    values.some((v, n) =>
      n % 2
        ? Boolean(v[cohort])
        : !(/\(n=\d/i.test(v[cohort]) || (n === values.length - 2 && /^Total$/i.test(v[cohort])))
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const rows = [],
    spans = [],
    header = lines.slice(0, first).flat()
  if (header.length) {
    const grades = lines[first - 1]
      .filter((i) => i.rect[0] >= cuts[stubCount])
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      grades.length !== blocks.length ||
      !grades.every((i, n) => i.text === grades[n % 2].text) ||
      grades[0].text === grades[1].text
    )
      return
    const split =
      (Math.max(
        ...lines
          .slice(0, first - 1)
          .flat()
          .map((i) => i.rect[3])
      ) +
        Math.min(...grades.map((i) => i.rect[1]))) /
      2
    rows.push(
      [left, Math.min(...header.map((i) => i.rect[1])), right, split],
      [left, split, right, Math.min(...bounds.map((r) => r[1])) - height * 0.1]
    )
    spans.push(
      { row: 0, column: 0, rowSpan: 1, colSpan: stubCount },
      { row: 1, column: 0, rowSpan: 1, colSpan: stubCount }
    )
    const parents = header.filter((i) => i.rect[3] < split && i.rect[0] >= cuts[stubCount])
    for (let c = stubCount; c < cuts.length - 1; c += 2) {
      if (!parents.some((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 2])) return
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: 2 })
    }
    if (
      parents.some(
        (i) =>
          !spans.some(
            (s) =>
              s.row === 0 && i.rect[0] >= cuts[s.column] && i.rect[2] <= cuts[s.column + s.colSpan]
          )
      )
    )
      return
  }
  const offset = rows.length
  rows.push(...bounds.map((r) => [left, r[1], right, r[3]]))
  for (let c = 0; c < leaf; c++) {
    const isolated = floating.flat().filter((i) => col(i) === c)
    const entries = groups.flatMap((g, n) => (g.some((i) => col(i) === c) ? [n] : []))
    if ((entries.length === 1 || (entries.length === 0 && isolated.length === 1)) && c < cohort) {
      spans.push({ row: offset, column: c, rowSpan: groups.length, colSpan: 1 })
      continue
    }
    for (let n = 0; n < entries.length; n++) {
      const start = entries[n],
        end = entries[n + 1] ?? groups.length
      if (start % 2 || (end - start) % 2) return
      spans.push({ row: offset + start, column: c, rowSpan: end - start, colSpan: 1 })
    }
  }
  if (!hasUniqueRecordTokens(source, [...(header.length ? [header] : []), ...groups, ...floating]))
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: offset ? [0, 1] : [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated longitudinal measures establish hanging stub continuations even
// when every printed line has the same leading. Outdented unit-bearing section
// labels remain separate and may span beyond the first numeric column.
export function recoverWrappedRepeatedMeasures(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 7 || columns.length > 13 || !source.length) return
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    height = hs[Math.floor(hs.length / 2)]
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const headIndex = lines.findIndex((g) => {
    const sorted = g.slice().sort((a, b) => a.rect[0] - b.rect[0])
    const v =
      sorted.length === columns.length ? sorted.map((i) => i.text.replace(/\s/g, '')) : undefined
    if (!v || !/\p{L}/u.test(v[0])) return false
    for (let width = 3; width <= 6; width++) {
      if ((v.length - 1) % width || (v.length - 1) / width < 2) continue
      if (
        new Set(v.slice(1, width + 1)).size === width &&
        v.slice(1).every((s, n) => /\p{L}/u.test(s) && s === v[1 + (n % width)])
      )
        return true
    }
    return false
  })
  if (headIndex < 1 || headIndex > 3) return
  const leaf = lines[headIndex].slice().sort((a, b) => a.rect[0] - b.rect[0])
  for (let c = 1; c < cuts.length - 1; c++) {
    if (Math.abs(cuts[c] - leaf[c].rect[0]) > height * 3) return
    cuts[c] = Math.min(cuts[c], leaf[c].rect[0] - height * 0.1)
  }
  const closing = joinHorizontalTableRules(rules).find(
    (r) =>
      r[0] <= left + height * 2 &&
      r[2] >= right - height * 2 &&
      r[1] > Math.max(...lines[headIndex].map((i) => i.rect[3])) &&
      r[1] - lines[headIndex][0].baseline < height
  )
  if (!closing) return
  const header = lines.slice(0, headIndex + 1).flat()
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, top, closing[1])
  if (!hierarchy || hierarchy.rows.length < 2) return
  const groups = [],
    labels = [],
    sections = []
  const number = (s) => /^[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%±−+–*/-]*$/.test(s)
  const measuredStarts = lines.slice(headIndex + 1).flatMap((g) => {
    const v = readSourceRow(g, cuts)
    return v &&
      /\p{L}/u.test(v[0]) &&
      v.slice(1).filter(Boolean).length >= 2 &&
      v.slice(1).filter(Boolean).every(number)
      ? [Math.min(...g.filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0]))]
      : []
  })
  let tails = 0
  for (const g of lines.slice(headIndex + 1)) {
    const v = readSourceRow(g, cuts)
    if (
      v &&
      /\p{L}/u.test(v[0]) &&
      v.slice(1).filter(Boolean).length >= 2 &&
      v.slice(1).filter(Boolean).every(number)
    ) {
      groups.push([...g])
      labels.push(g.filter((i) => i.rect[2] <= cuts[1]))
      continue
    }
    const previous = groups.at(-1),
      stub = labels.at(-1)
    const first = Math.min(...g.map((i) => i.rect[0]))
    if (
      previous &&
      stub &&
      !sections.includes(groups.length - 1) &&
      g.every((i) => i.rect[2] < cuts[1]) &&
      first - Math.min(...stub.map((i) => i.rect[0])) >= height * 0.2 &&
      first - Math.min(...stub.map((i) => i.rect[0])) < height &&
      Math.min(...g.map((i) => i.baseline)) - Math.max(...previous.map((i) => i.baseline)) <
        height * 1.6
    ) {
      previous.push(...g)
      stub.push(...g)
      tails++
      continue
    }
    // Unit exponents and closing parentheses can overhang the stub. There
    // must be no measurement in later columns and an outdented alphabetic head.
    if (
      !measuredStarts.length ||
      first >= Math.min(...measuredStarts) - height * 0.2 ||
      !/^\p{L}/u.test(g.slice().sort((a, b) => a.rect[0] - b.rect[0])[0].text) ||
      g.some((i) => i.rect[2] >= cuts[2])
    )
      return
    sections.push(groups.length)
    groups.push([...g])
    labels.push(g)
  }
  const labelText = labels
    .filter((_, n) => !sections.includes(n))
    .map((g) => readSourceRow(g, [left, right], { multiline: true })?.[0])
  if (
    tails < 3 ||
    groups.length < 10 ||
    new Set(labelText.filter((s) => labelText.filter((v) => v === s).length >= 2)).size < 3
  )
    return
  const rects = groups.map(union)
  if (
    rects.some((r, n) => n && r[1] <= rects[n - 1][3]) ||
    !hasUniqueRecordTokens(source, [header, ...groups])
  )
    return
  return {
    rows: [...hierarchy.rows, ...rects.map((r) => [left, r[1], right, r[3]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans: [
      ...hierarchy.spans,
      ...sections.map((n) => ({
        row: hierarchy.rows.length + n,
        column: 0,
        rowSpan: 1,
        colSpan: cuts.length - 1
      }))
    ],
    headerRows: hierarchy.rows.map((_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated native leaf headings anchor both the fine measurement columns and
// coarser records above them. Whitespace must separate every leaf through all
// complete measurements; native underlines establish the parent hierarchy.
export function recoverRepeatedLeafSections(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const heights = source.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const candidates = lines.flatMap((line, index) => {
    const anchors = line
      .filter((i) => /^[A-Za-z][A-Za-z.% -]{0,12}$/.test(i.text))
      .sort((a, b) => a.rect[0] - b.rect[0])
    for (let size = 2; size <= 6; size++) {
      const count = Math.floor(anchors.length / size)
      if (count < 2 || count > 8 || anchors.length % size > 1) continue
      const repeated = anchors.slice(0, count * size)
      if (
        new Set(repeated.slice(0, size).map((i) => i.text)).size !== size ||
        !repeated.every((i, n) => i.text === repeated[n % size].text)
      )
        continue
      if (anchors.length > repeated.length && !/^P[- ]?value$/i.test(anchors.at(-1).text)) continue
      return [{ index, anchors, size, count }]
    }
    return []
  })
  if (candidates.length !== 1) return
  const { index, anchors, size, count } = candidates[0]
  const borders = joinHorizontalTableRules(rules)
  const bands = []
  for (const r of borders.filter((r) => r[1] >= top && r[1] <= bottom)) {
    let band = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.01)
    if (!band) bands.push((band = []))
    band.push(r)
  }
  const full = bands
    .filter(
      (b) =>
        b[0][0] <= left + height &&
        b.at(-1)[2] >= right - height &&
        b.reduce((sum, r) => sum + r[2] - r[0], 0) >= (right - left) * 0.85
    )
    .map((b) => [b[0][0], b[0][1], b.at(-1)[2], b[0][1]])
  const divider = full.find(
    (r) =>
      r[1] > Math.max(...lines[index].map((i) => i.rect[3])) &&
      r[1] - anchors[0].baseline < height * 1.5
  )
  if (!divider) return
  const lower = lines.slice(index + 1)
  const sections = lower.filter((g) => g.every((i) => i.rect[2] < anchors[0].rect[0]))
  const records = lower.filter((g) => !sections.includes(g))
  if (records.length < 3) return
  const ink = [...lines[index], ...records.flat()]
    .map((i) => [i.rect[0], i.rect[2]])
    .sort((a, b) => a[0] - b[0])
  const blocks = []
  for (const r of ink) {
    const last = blocks.at(-1)
    if (last && r[0] - last[1] < height * 0.35) last[1] = Math.max(last[1], r[1])
    else blocks.push([...r])
  }
  const stubCount = blocks.length - anchors.length
  if (
    (stubCount !== 1 && stubCount !== 2) ||
    anchors.some(
      (i, n) => i.rect[0] < blocks[n + stubCount][0] || i.rect[2] > blocks[n + stubCount][1]
    )
  )
    return
  const cuts = [left, ...blocks.slice(1).map((r, n) => (blocks[n][1] + r[0]) / 2), right]
  const numeric = (v) => /^[<>≤≥−+–-]?(?:\d|\.\d)[\d.,()%±−+–*/-]*(?:to[−+–-]?\d[\d.]*)?$/.test(v)
  if (
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || !/\p{L}/u.test(v[stubCount - 1]) || !v.slice(stubCount).every(numeric)
    })
  )
    return
  if (stubCount === 2) {
    if (sections.length || records.length < 6 || records.length % 2) return
    const values = records.map((g) => readSourceRow(g, cuts))
    if (values[0][1] === values[1][1] || values.some((v, n) => v[1] !== values[n % 2][1])) return
    for (let n = 0; n < records.length; n += 2) {
      const a = records[n].filter((i) => i.rect[2] < cuts[1]),
        b = records[n + 1].filter((i) => i.rect[2] < cuts[1])
      if (
        !a.length ||
        (b.length &&
          (!/^[a-z]/.test(values[n + 1][0]) ||
            Math.min(...b.map((i) => i.rect[0])) <= Math.min(...a.map((i) => i.rect[0]))))
      )
        return
    }
  }
  let headerTop = Math.max(
    top,
    ...full.filter((r) => r[1] < Math.min(...lines[index].map((i) => i.rect[1]))).map((r) => r[1])
  )
  const parent = lines[index - 1],
    beforeParent = lines[index - 2]
  if (
    stubCount === 1 &&
    parent &&
    beforeParent &&
    parent.length === count &&
    parent.every((i) => /\p{L}/u.test(i.text)) &&
    beforeParent.filter((i) => /^\d/.test(i.text)).length >= count
  ) {
    const underlines = borders.filter(
      (r) =>
        r[1] > Math.max(...parent.map((i) => i.rect[3])) &&
        r[1] < Math.min(...lines[index].map((i) => i.rect[1]))
    )
    if (
      underlines.length !== count ||
      parent.some((i) => !underlines.some((r) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1))
    )
      return
    headerTop =
      (Math.max(...beforeParent.map((i) => i.rect[3])) +
        Math.min(...parent.map((i) => i.rect[1]))) /
      2
  }
  const header = source.filter((i) => i.rect[1] > headerTop && i.rect[3] < divider[1])
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, headerTop, divider[1])
  if (!hierarchy || hierarchy.rows.length < 2) return
  hierarchy.rows[0][1] = Math.max(hierarchy.rows[0][1], Math.min(...header.map((i) => i.rect[1])))
  const rows = [],
    spans = [],
    owned = []
  const add = (tokens, rowCuts, widths) => {
    const values = readSourceRow(tokens, rowCuts, { multiline: true })
    if (!values) return false
    const row = rows.length,
      rect = union(tokens)
    rows.push([left, rect[1], right, rect[3]])
    let column = 0
    for (const width of widths) {
      if (width > 1) spans.push({ row, column, rowSpan: 1, colSpan: width })
      column += width
    }
    owned.push(tokens)
    return values
  }
  const upper = source.filter((i) => i.rect[3] < headerTop)
  if (upper.length) {
    if (stubCount !== 1 || anchors.length !== size * count) return
    const coarse = [left, ...Array.from({ length: count }, (_, n) => cuts[1 + n * size]), right]
    const closing = full.find(
      (r) => r[1] > Math.min(...upper.map((i) => i.baseline)) && r[1] < headerTop
    )
    if (!closing) return
    const upperHeader = upper.filter((i) => i.rect[3] < closing[1])
    const bands = recoverRuledHeaderBands(upperHeader, coarse, rules, top, closing[1])
    if (!bands) return
    // Each upper cohort is one value, even though lower sections have several
    // leaves. Collapse header tiers within each cohort without crossing it.
    if (!add(upperHeader, coarse, [1, ...Array(count).fill(size)])) return
    const groups = groupSourceRowsWithScripts(
      upper.filter((i) => i.rect[1] > closing[1]),
      height,
      0.3
    )
    if (!groups) return
    for (const g of groups) {
      if (
        g.every((i) => i.rect[2] < cuts[1]) ||
        (g.length === 1 &&
          g[0].rect[0] < cuts[1] &&
          /\p{L}/u.test(g[0].text) &&
          g[0].rect[2] < cuts[2])
      ) {
        if (!add(g, [left, right], [cuts.length - 1])) return
      } else {
        const v = add(g, coarse, [1, ...Array(count).fill(size)])
        if (
          !v ||
          !(v.slice(1).every(numeric) || (!v[0] && v.slice(1).every((s) => /\p{L}/u.test(s))))
        )
          return
      }
    }
  }
  const offset = rows.length
  rows.push(...hierarchy.rows)
  spans.push(...hierarchy.spans.map((s) => ({ ...s, row: s.row + offset })))
  owned.push(header)
  const bodyOffset = rows.length
  for (const g of lower) {
    if (
      !add(
        g,
        sections.includes(g) ? [left, right] : cuts,
        sections.includes(g) ? [cuts.length - 1] : Array(cuts.length - 1).fill(1)
      )
    )
      return
  }
  if (stubCount === 2)
    for (let n = 0; n < records.length; n += 2)
      spans.push({ row: bodyOffset + n, column: 0, rowSpan: 2, colSpan: 1 })
  if (!hasUniqueRecordTokens(source, owned) || rows.some((r, n) => n && r[1] < rows[n - 1][3]))
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: Array.from({ length: hierarchy.rows.length }, (_, n) => offset + n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Cohort counts with an explicit total provide an independent arithmetic check
// for omitted rows. Recover only complete source records and section-level
// probabilities; no missing count is synthesized from the total.
export function recoverAdditiveCohortRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 5) return
  const source = tableSourceItems(items, table.cropRect)
  const samples = source.filter((i) => /^\(N\s*=\s*\d+\)$/i.test(i.text))
  if (samples.length !== 3) return
  samples.sort((a, b) => a.rect[0] - b.rect[0])
  const height = samples[0].height
  if (
    samples.some((i) => Math.abs(i.baseline - samples[0].baseline) > height * 0.2) ||
    Number(samples[0].text.match(/\d+/)[0]) + Number(samples[1].text.match(/\d+/)[0]) !==
      Number(samples[2].text.match(/\d+/)[0])
  )
    return
  const probability = source.filter(
    (i) => /^P\s*value$/i.test(i.text) && i.rect[3] < samples[0].rect[3]
  )
  const unit = source.filter(
    (i) =>
      /^N\s*\(%\)$/.test(i.text) &&
      i.rect[1] > samples[0].rect[3] &&
      i.rect[1] < samples[0].rect[3] + height * 2
  )
  if (probability.length !== 1 || unit.length !== 1) return
  const borders = joinHorizontalTableRules(rules)
  const divider = borders.find(
    (r) =>
      r[0] <= left + height * 2 &&
      r[2] >= right - height * 2 &&
      r[1] > unit[0].rect[3] &&
      r[1] < unit[0].rect[3] + height
  )
  const underline = borders.find(
    (r) =>
      r[1] > samples[0].rect[3] &&
      r[1] < unit[0].rect[1] &&
      r[0] <= samples[0].rect[0] + 1 &&
      r[0] >= samples[0].rect[0] - height &&
      r[2] >= samples[2].rect[2] - 1 &&
      r[2] < probability[0].rect[0]
  )
  if (!divider || !underline) return
  const header = source.filter((i) => i.rect[3] < underline[1])
  const body = source.filter((i) => i.rect[1] > divider[1])
  const lines = groupSourceRowsWithScripts(body, height, 0.35)
  if (!lines || !hasUniqueRecordTokens(source, [header, unit, ...lines])) return
  const starts = [left, ...samples.map((i) => i.rect[0]), probability[0].rect[0]]
  const col = (i) => {
    let c = 0
    while (c + 1 < starts.length && i.rect[0] >= starts[c + 1] - height * 0.2) c++
    return c
  }
  const cuts = [left]
  for (let c = 1; c < starts.length; c++) {
    const a = [...header, ...body].filter((i) => col(i) === c - 1),
      b = [...header, ...body].filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    cuts.push((end + start) / 2)
  }
  cuts.push(right)
  const heading = readSourceRow(header, cuts, { multiline: true })
  if (!heading || !/^Total\(N=/i.test(heading[3])) return
  let counts = 0,
    sections = 0,
    summaries = 0
  for (const line of lines) {
    const v = readSourceRow(line, cuts)
    if (!v || !v[0] || (v[4] && !/^[<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v[4]))) return
    if (v.slice(1, 4).every((s) => !s)) {
      if (!/\p{L}/u.test(v[0])) return
      sections++
      continue
    }
    if (/^Median/i.test(v[0]) && v.slice(1, 4).every((s) => /^\d+(?:\.\d+)?$/.test(s))) {
      summaries++
      continue
    }
    const ns = v.slice(1, 4).map((s) => /^(\d+)(?:\([<>≤≥]?\d+(?:\.\d+)?\))?$/.exec(s))
    if (ns.some((n) => !n) || Number(ns[0][1]) + Number(ns[1][1]) !== Number(ns[2][1])) return
    counts++
  }
  if (counts < 12 || sections < 3 || summaries > 2) return
  const bounds = lines.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3])) return
  return {
    rows: [
      [left, top, right, underline[1]],
      [left, underline[1], right, divider[1]],
      ...bounds.map((b) => [left, b[1], right, b[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [
      { row: 1, column: 1, rowSpan: 1, colSpan: 3 },
      ...[0, 4].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 }))
    ],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated outcome records can use different cohort widths in each section.
// Sample headings and the same complete record sequence establish local cuts;
// their union is represented by ordinary colspans in the existing grid format.
export function recoverSectionLocalColumns(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const samples = source.filter((i) => /^n\s*=\s*\d+$/i.test(i.text.trim()))
  if (samples.length < 4) return
  const height = samples[0].height
  const lines = groupSourceRowsWithScripts(source, height, 0.3)
  if (!lines) return
  const headers = lines.flatMap((g, n) => {
    const anchors = g.filter((i) => samples.includes(i)).sort((a, b) => a.rect[0] - b.rect[0])
    return anchors.length >= 2 ? [{ n, anchors }] : []
  })
  if (
    headers.length < 2 ||
    headers.some((h) => h.anchors.length > 4) ||
    new Set(headers.map((h) => h.anchors.length)).size < 2
  )
    return
  const probability = source.filter(
    (i) => /^P(?:\s*value)?$/i.test(i.text.trim()) && i.rect[3] <= headers[0].anchors[0].rect[3]
  )
  if (probability.length !== 1) return
  const px = probability[0].rect[0]
  const sections = []
  let previous = -1
  for (const [index, h] of headers.entries()) {
    const stop = headers[index + 1] ? headers[index + 1].n - 1 : lines.length
    const records = []
    for (let n = h.n + 1; n < stop; n++) {
      const g = lines[n].slice().sort((a, b) => a.rect[0] - b.rect[0])
      if (
        g[0].rect[0] < h.anchors[0].rect[0] - height * 2 &&
        /\p{L}/u.test(g[0].text) &&
        g.slice(1).every((i) => /^[−+\d.<>≤≥][\d.,()\s%<>≤≥−+–-]*$/.test(i.text))
      )
        records.push({ n, g })
    }
    if (records.length < 4 || records.some((r, n) => n && r.n !== records[n - 1].n + 1)) return
    const signature = records.map((r) => r.g[0].text).join('|')
    if (sections.length && signature !== sections[0].signature) return
    const heading = lines.slice(previous + 1, h.n + 1).flat()
    const groups = [heading, ...records.map((r) => r.g)]
    const numericGroups = records.map((r) => {
      const result = []
      for (const i of r.g.slice(1)) {
        const last = result.at(-1)
        if (last && i.rect[0] - union(last)[2] < height * 0.6) last.push(i)
        else result.push([i])
      }
      return result
    })
    if (numericGroups.some((g) => g.length < h.anchors.length || g.length > h.anchors.length + 1))
      return
    const probabilities = numericGroups
      .filter((g) => g.length === h.anchors.length + 1)
      .map((g) => union(g.at(-1))[0])
    if (!probabilities.length || Math.max(...probabilities) - Math.min(...probabilities) > height)
      return
    const localP = Math.min(...probabilities)
    const starts = [left, ...h.anchors.map((i) => i.rect[0]), localP]
    const col = (i) => {
      let c = 0
      while (c + 1 < starts.length && i.rect[0] >= starts[c + 1] - height * 0.15) c++
      return c
    }
    const body = records.flatMap((r) => r.g)
    const cuts = [left],
      gaps = []
    const leafHeading = heading.filter((i) => i.baseline >= h.anchors[0].baseline - height * 1.6)
    const evidence = [...body, ...leafHeading]
    for (let c = 1; c < starts.length; c++) {
      const a = evidence.filter((i) => col(i) === c - 1),
        b = evidence.filter((i) => col(i) === c)
      if (!a.length || !b.length) return
      const end = Math.max(...a.map((i) => i.rect[2])),
        start = Math.min(...b.map((i) => i.rect[0]))
      if (end >= start) return
      cuts.push((end + start) / 2)
      gaps.push({ left: end, right: start, column: c })
    }
    cuts.push(right)
    const values = records.map((r) => readSourceRow(r.g, cuts))
    if (values.some((v) => !v || !v.slice(1, -1).every(Boolean))) return
    const border = joinHorizontalTableRules(rules).some(
      (r) =>
        r[0] <= body[0].rect[0] &&
        r[2] >= px &&
        r[1] > Math.max(...heading.map((i) => i.rect[3])) &&
        r[1] < union(records[0].g)[1]
    )
    if (!border) return
    sections.push({ heading, records, cuts, gaps, signature, groups })
    previous = records.at(-1).n
  }
  if (
    !hasUniqueRecordTokens(
      source,
      sections.flatMap((s) => s.groups)
    )
  )
    return
  // Several sections may allow the same cut at different positions in their
  // whitespace. Intersect those gaps instead of creating tiny empty columns.
  const boundaries = sections
    .flatMap((section) => section.gaps.map((gap) => ({ ...gap, section })))
    .sort((a, b) => a.left + a.right - b.left - b.right)
  const clusters = []
  for (const boundary of boundaries) {
    const last = clusters.at(-1)
    if (last && Math.max(last.left, boundary.left) + 1 < Math.min(last.right, boundary.right)) {
      last.left = Math.max(last.left, boundary.left)
      last.right = Math.min(last.right, boundary.right)
      last.members.push(boundary)
    } else clusters.push({ left: boundary.left, right: boundary.right, members: [boundary] })
  }
  for (const cluster of clusters)
    for (const b of cluster.members) b.section.cuts[b.column] = (cluster.left + cluster.right) / 2
  const cuts = [left, ...clusters.map((c) => (c.left + c.right) / 2), right]
  const rows = [],
    spans = [],
    headerRows = []
  for (const [n, s] of sections.entries()) {
    const headerBottom = (union(s.heading)[3] + union(s.records[0].g)[1]) / 2
    const head =
      n === 0
        ? recoverRuledHeaderBands(s.heading, s.cuts, rules, top, headerBottom)
        : { rows: [[left, union(s.heading)[1], right, headerBottom]], spans: [] }
    if (!head) return
    const rowOffset = rows.length
    rows.push(
      ...head.rows,
      ...s.records.map((r) => {
        const b = union(r.g)
        return [left, b[1], right, b[3]]
      })
    )
    headerRows.push(...head.rows.map((_, i) => rowOffset + i))
    for (let r = 0; r < head.rows.length + s.records.length; r++)
      for (let c = 0; c < s.cuts.length - 1; c++) {
        if (
          head.spans.some(
            (p) => r >= p.row && r < p.row + p.rowSpan && c >= p.column && c < p.column + p.colSpan
          )
        )
          continue
        const column = cuts.indexOf(s.cuts[c]),
          colSpan = cuts.indexOf(s.cuts[c + 1]) - column
        if (colSpan > 1) spans.push({ row: rowOffset + r, column, colSpan, rowSpan: 1 })
      }
    for (const p of head.spans) {
      const column = cuts.indexOf(s.cuts[p.column]),
        colSpan = cuts.indexOf(s.cuts[p.column + p.colSpan]) - column
      spans.push({ ...p, row: rowOffset + p.row, column, colSpan })
    }
  }
  if (rows.some((r, n) => n && r[1] < rows[n - 1][3])) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Unique native identifiers anchor complete records even when a detector skips
// a row or combines adjacent records. Sparse ancestors remain bounded by the
// next printed ancestor; wrapped values must stay within their identifier band.
export function recoverIdentifierRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 6 || columns.length > 12) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const source = tableSourceItems(items, table.cropRect)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const labels = source.filter(
    (i) => /^(?:ID|Identifier)$/i.test(i.text.trim()) && i.rect[3] < top + 80
  )
  if (labels.length !== 1) return
  const id = labels[0],
    leaf = col(id),
    height = id.height
  if (leaf < 1 || leaf > 3 || columns.length - leaf < 4) return
  const anchors = source
    .filter((i) => col(i) === leaf && i.rect[1] > id.rect[3] && /^\d+$/.test(i.text.trim()))
    .sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length < 8 ||
    new Set(anchors.map((i) => i.text)).size !== anchors.length ||
    anchors.some(
      (i, n) =>
        Math.abs(i.rect[0] - anchors[0].rect[0]) > height * 0.2 ||
        (n && i.rect[1] <= anchors[n - 1].rect[3])
    )
  )
    return
  const body = source.filter((i) => i.rect[1] >= anchors[0].rect[1] - height * 0.2)
  const header = source.filter((i) => !body.includes(i))
  const lines = groupSourceRowsWithScripts(body, height, 0.3)
  if (!lines) return
  const groups = anchors.map((a, n) =>
    lines
      .filter(
        (g) =>
          g[0].baseline >= a.baseline - height * 0.25 &&
          (!anchors[n + 1] || g[0].baseline < anchors[n + 1].baseline - height * 0.25)
      )
      .flat()
  )
  if (!hasUniqueRecordTokens(source, [header, ...groups])) return
  // Correct only cuts that cross source text, using a shared glyph-free gap.
  for (let c = 1; c < columns.length; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    if (cuts[c] < end || cuts[c] > start) cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts, { multiline: true }))
  if (
    values.some((v, n) => !v || v[leaf] !== anchors[n].text || !v.slice(leaf + 1).every(Boolean)) ||
    groups.some((g, n) =>
      cuts
        .slice(leaf + 2)
        .some(
          (_, k) =>
            !g.some(
              (i) =>
                col(i) === leaf + k + 1 && Math.abs(i.baseline - anchors[n].baseline) < height * 0.3
            )
        )
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((b, n) => n && b[1] <= bounds[n - 1][3]) || values.filter((v) => v[0]).length < 2)
    return
  const headerBottom = (Math.max(...header.map((i) => i.rect[3])) + bounds[0][1]) / 2
  const head = recoverRuledHeaderBands(header, cuts, rules, top, headerBottom)
  if (!head || head.rows.length < 2) return
  const spans = [...head.spans],
    offset = head.rows.length
  for (let n = 0; n < groups.length; n++)
    for (let c = 0; c < leaf; c++) {
      if (!values[n][c]) continue
      let end = n + 1
      while (end < groups.length && !values[end].slice(0, c + 1).some(Boolean)) end++
      if (end - n > 1) spans.push({ row: offset + n, column: c, rowSpan: end - n, colSpan: 1 })
    }
  return {
    rows: [...head.rows, ...bounds.map((b) => [left, b[1], right, b[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: head.rows.map((_, n) => n),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

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
  const paired =
    recoverCenteredCategoryRecords(table, items, rules) ??
    recoverGroupedCategoryPairs(table, items, rules)
  if (paired) return paired
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

// Repeated count/percentage baselines identify categories independently of
// centered group stubs. A probability centered on the group spans its records;
// probabilities aligned with individual categories retain separate cells.
function recoverCenteredCategoryRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 8) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!height) return
  const frame = joinHorizontalTableRules(rules, 0.1)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < height * 2 &&
        Math.abs(r[2] - right) < height * 2 &&
        r[1] >= top &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length < 3) return
  const ruled = recoverIndividuallyRuledCategories(source, cuts, frame, rules, height)
  if (ruled) return ruled
  const band = (a, b) => source.filter((i) => i.rect[1] >= a && i.rect[3] <= b)
  const header = band(frame[0][1], frame[1][1])
  const heading = readSourceRow(header, cuts)
  if (
    !heading ||
    !/\p{L}/u.test(heading[0]) ||
    heading[1] ||
    !heading.slice(2, -1).every((s) => /\p{L}/u.test(s)) ||
    !/^p[- ]?(?:value)?$/i.test(heading.at(-1))
  )
    return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const probability = (s) => /^(?:[<>≤≥]?0?\.\d+|1(?:\.0+)?)[*†‡]*$/.test(s)
  const rows = [[left, frame[0][1], right, frame[1][1]]]
  const spans = [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }]
  const owned = [header]
  let centeredGroups = 0
  for (let f = 1; f < frame.length - 1; f++) {
    const a = frame[f][1],
      b = frame[f + 1][1],
      body = band(a, b)
    const data = body.filter((i) => col(i) > 0 && col(i) < columns.length - 1)
    const groups = groupSourceRowsWithScripts(data, height, 0.3)
    if (!groups?.length) return
    const values = groups.map((g) => readSourceRow(g, cuts))
    if (values.some((v) => !v)) return
    // A separately ruled summary is one record, even with a mean and range
    // on different baselines. It must not absorb a later group's statistic.
    if (values.every((v) => !v[1])) {
      const summary = readSourceRow(body, cuts, { multiline: true })
      if (
        !summary ||
        !/\p{L}/u.test(summary[0]) ||
        !probability(summary.at(-1)) ||
        !summary.slice(2, -1).every((s) => /\d/.test(s) && /[±()]/.test(s)) ||
        groupSourceRowsWithScripts(
          body.filter((i) => col(i) === 0),
          height,
          0.3
        )?.length !== 1
      )
        return
      spans.push({ row: rows.length, column: 0, rowSpan: 1, colSpan: 2 })
      rows.push([left, a, right, b])
      owned.push(body)
      continue
    }
    if (
      groups.length < 4 ||
      values.some(
        (v) =>
          !/\p{L}/u.test(v[1]) ||
          !v.slice(2, -1).every((s) => /^\d+\(\d+(?:\.\d+)?%\)[*†‡]*$/.test(s))
      )
    )
      return
    const bounds = groups.map(union)
    if (
      bounds.some((r, n) => n && (r[1] <= bounds[n - 1][3] || r[1] - bounds[n - 1][3] > height * 2))
    )
      return
    const edges = [a, ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2), b]
    const labels = groupSourceRowsWithScripts(
      body.filter((i) => col(i) === 0),
      height,
      0.3
    )
    if (!labels || labels.length < 2) return
    const offset = rows.length
    let start = 0
    for (const label of labels) {
      if (start >= groups.length) return
      if (!label.some((i) => /\p{L}/u.test(i.text))) return
      const stops = groups
        .map((_, n) => n + 1)
        .filter(
          (stop) =>
            stop >= start + 2 &&
            Math.abs(
              label[0].baseline - (groups[start][0].baseline + groups[stop - 1][0].baseline) / 2
            ) <
              height * 0.3
        )
      if (stops.length !== 1) return
      const stop = stops[0]
      if (label.some((i) => i.rect[1] < edges[start] || i.rect[3] > edges[stop])) return
      const stats = body.filter(
        (i) =>
          col(i) === columns.length - 1 && i.rect[1] >= edges[start] && i.rect[3] <= edges[stop]
      )
      const statGroups = groupSourceRowsWithScripts(stats, height, 0.3)
      if (!statGroups || statGroups.some((g) => !probability(readSourceRow(g, cuts)?.at(-1) ?? '')))
        return
      if (
        statGroups.length === 1 &&
        Math.abs(statGroups[0][0].baseline - label[0].baseline) < height * 0.3
      ) {
        spans.push({
          row: offset + start,
          column: columns.length - 1,
          rowSpan: stop - start,
          colSpan: 1
        })
      } else if (
        statGroups.length !== stop - start ||
        statGroups.some(
          (g, n) => Math.abs(g[0].baseline - groups[start + n][0].baseline) > height * 0.3
        )
      )
        return
      spans.push({ row: offset + start, column: 0, rowSpan: stop - start, colSpan: 1 })
      owned.push(label, stats, ...groups.slice(start, stop))
      centeredGroups++
      start = stop
    }
    if (start !== groups.length) return
    rows.push(...groups.map((_, n) => [left, edges[n], right, edges[n + 1]]))
  }
  if (centeredGroups < 2 || !hasUniqueRecordTokens(source, owned)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame.at(-1)[1]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Full-width borders can enclose one wrapped group at a time, with inset rules
// separating its categories. Those rules, complete cohort counts, and native
// probability alignment distinguish independent values from shared statistics.
function recoverIndividuallyRuledCategories(source, modelCuts, frame, rules, height) {
  if (frame.length < 5) return
  const cuts = [...modelCuts],
    last = cuts.length - 2,
    left = cuts[0],
    right = cuts.at(-1)
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const band = (a, b) => source.filter((i) => i.rect[1] >= a && i.rect[3] <= b)
  const header = band(frame[0][1], frame[1][1])
  // A long cohort heading can cross a predicted cut. Move that cut only into
  // a narrow empty native gutter that preserves every glyph's column owner.
  for (let c = 1; c < cuts.length - 1; c++) {
    const before = source.filter((i) => col(i) === c - 1),
      after = source.filter((i) => col(i) === c)
    if (!before.length || !after.length) return
    const end = Math.max(...before.map((i) => i.rect[2])),
      start = Math.min(...after.map((i) => i.rect[0]))
    if (end > start) return
    if (end > cuts[c] || start < cuts[c]) {
      if (start - end > height * 3 || Math.abs((end + start) / 2 - cuts[c]) > height * 2) return
      cuts[c] = (end + start) / 2
    }
  }
  const heading = readSourceRow(header, cuts)
  if (
    !heading ||
    heading[0] ||
    !/^\p{L}+$/u.test(heading[1]) ||
    !heading.slice(2, -1).every((s) => /\p{L}.*n=?\d+$/iu.test(s)) ||
    !/^p[- ]?(?:value)?$/i.test(heading.at(-1))
  )
    return
  const horizontal = joinHorizontalTableRules(rules, 0.1)
  const rows = [[left, frame[0][1], right, frame[1][1]]],
    spans = [],
    owned = [header]
  let multiple = 0
  const probability = (s) => /^(?:[<>≤≥]?0?\.\d+|1(?:\.0+)?)(?:[*†‡]+|[a-z])?$/.test(s)
  for (let f = 1; f < frame.length - 1; f++) {
    const a = frame[f][1],
      b = frame[f + 1][1],
      body = band(a, b),
      label = body.filter((i) => col(i) === 0),
      stats = body.filter((i) => col(i) === last),
      data = body.filter((i) => col(i) > 0 && col(i) < last)
    if (!label.some((i) => /\p{L}/u.test(i.text))) return
    const groups = groupSourceRowsWithScripts(data, height, 0.3),
      statGroups = groupSourceRowsWithScripts(stats, height, 0.3)
    if (!groups?.length || !statGroups?.length) return
    const values = groups.map((g) => readSourceRow(g, cuts))
    if (
      values.some(
        (v) =>
          !v ||
          !/^\d+(?:\p{L}[\p{L}\d/-]*)?$/u.test(v[1]) ||
          !v.slice(2, -1).every((s) => /^\d+\(\d+(?:\.\d+)?%\)[*†‡]*$/.test(s))
      ) ||
      statGroups.some((g) => !probability(readSourceRow(g, cuts)?.at(-1) ?? ''))
    )
      return
    const inner = horizontal
      .filter(
        (r) =>
          r[1] > a &&
          r[1] < b &&
          Math.abs(r[0] - cuts[1]) < height &&
          Math.abs(r[2] - cuts[last]) < height &&
          r[0] > Math.max(...label.map((i) => i.rect[2])) &&
          r[2] < Math.min(...stats.map((i) => i.rect[0]))
      )
      .sort((u, v) => u[1] - v[1])
    if (inner.length !== groups.length - 1) return
    const edges = [a, ...inner.map((r) => r[1]), b]
    if (
      groups.some((g, n) =>
        g.some((i) => {
          const center = (i.rect[1] + i.rect[3]) / 2
          return center <= edges[n] || center >= edges[n + 1]
        })
      )
    )
      return
    const offset = rows.length
    if (statGroups.length === 1 && groups.length > 1) {
      if (
        Math.abs(
          statGroups[0][0].baseline - (groups[0][0].baseline + groups.at(-1)[0].baseline) / 2
        ) >
        height * 0.5
      )
        return
      spans.push({ row: offset, column: last, rowSpan: groups.length, colSpan: 1 })
    } else if (
      statGroups.length !== groups.length ||
      statGroups.some((g, n) => Math.abs(g[0].baseline - groups[n][0].baseline) > height * 0.5)
    )
      return
    if (groups.length > 1) {
      multiple++
      spans.push({ row: offset, column: 0, rowSpan: groups.length, colSpan: 1 })
    }
    rows.push(...groups.map((_, n) => [left, edges[n], right, edges[n + 1]]))
    owned.push(label, stats, data)
  }
  if (multiple < 2 || !hasUniqueRecordTokens(source, owned)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame.at(-1)[1]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Two cohorts repeat within each category, while a section owns one centered
// dF/P pair. Anchor rows on complete counts rather than on those shared values;
// a statistic between baselines must not become a record or disappear.
function recoverGroupedCategoryPairs(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 7) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!height) return
  const frame = joinHorizontalTableRules(rules, 0.1)
    .filter(
      (r) =>
        Math.abs(r[0] - left) < height * 1.5 &&
        Math.abs(r[2] - right) < height * 1.5 &&
        r[1] >= top &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3) return
  const header = source.filter((i) => i.rect[1] >= frame[0][1] && i.rect[3] < frame[1][1])
  const body = source.filter((i) => i.rect[1] > frame[1][1] && i.rect[3] <= frame[2][1])
  const heading = readSourceRow(header, cuts, { multiline: true })
  if (
    !hasUniqueRecordTokens(source, [header, body]) ||
    !heading ||
    heading[0] ||
    heading[1] ||
    !/^(?:Group|Cohort)$/i.test(heading[2]) ||
    !/^(?:F|Frequency|N)$/i.test(heading[3]) ||
    heading[4] !== '%' ||
    !/^df$/i.test(heading[5]) ||
    !/^p(?:value)?$/i.test(heading[6])
  )
    return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (!readSourceRow(body, cuts, { multiline: true })) return
  const anchors = body.filter((i) => col(i) >= 2 && col(i) <= 4)
  const groups = groupSourceRowsWithScripts(anchors, height, 0.3)
  if (!groups || groups.length < 8 || groups.length % 2) return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v) =>
        !v ||
        !/^[A-Za-z][A-Za-z0-9-]*$/.test(v[2]) ||
        !/^\d+$/.test(v[3]) ||
        !/^\d+(?:\.\d+)?$/.test(v[4]) ||
        Number(v[4]) > 100
    )
  )
    return
  const cohorts = values.slice(0, 2).map((v) => v[2])
  if (cohorts[0] === cohorts[1] || values.some((v, n) => v[2] !== cohorts[n % 2])) return
  const bounds = groups.map(union)
  if (
    bounds.some((b, n) => n && (b[1] <= bounds[n - 1][3] || b[1] - bounds[n - 1][3] > height * 2))
  )
    return
  const edges = [
    frame[1][1],
    ...bounds.slice(1).map((b, n) => (bounds[n][3] + b[1]) / 2),
    frame[2][1]
  ]
  const rows = [
    [left, frame[0][1], right, frame[1][1]],
    ...groups.map((_, n) => [left, edges[n], right, edges[n + 1]])
  ]
  const spans = [],
    sections = [],
    owned = [header]
  for (let n = 0; n < groups.length; n += 2) {
    const pair = body.filter(
      (i) => col(i) < 5 && i.rect[1] >= edges[n] && i.rect[3] <= edges[n + 2]
    )
    const labels = [0, 1].map((c) =>
      pair.filter((i) => col(i) === c).sort((a, b) => a.baseline - b.baseline)
    )
    if (!labels[1].length) return
    for (const label of labels) {
      if (!label.length) continue
      if (
        !/\p{L}/u.test(label[0].text) ||
        Math.abs(label[0].baseline - groups[n][0].baseline) > height * 0.3 ||
        label
          .slice(1)
          .some(
            (i) =>
              !/^[a-z]/.test(i.text) ||
              Math.abs(i.rect[0] - label[0].rect[0]) > height * 0.2 ||
              Math.abs(i.baseline - groups[n + 1][0].baseline) > height * 0.3
          )
      )
        return
    }
    if (labels[0].length) sections.push(n)
    spans.push({ row: n + 1, column: 1, rowSpan: 2, colSpan: 1 })
    owned.push(pair)
  }
  if (sections.length < 3 || sections[0] !== 0) return
  for (const [index, start] of sections.entries()) {
    const stop = sections[index + 1] ?? groups.length
    const categories = (stop - start) / 2
    if (categories < 2) return
    const stats = body.filter(
      (i) => col(i) >= 5 && i.rect[1] >= edges[start] && i.rect[3] <= edges[stop]
    )
    const cells = readSourceRow(stats, cuts)
    // The printed degrees of freedom independently agree with the category
    // count for two cohorts. Never calculate or replace a source statistic.
    if (
      !cells ||
      cells[5] !== String(categories - 1) ||
      !/^(?:[<>≤≥]?0?\.\d+|1(?:\.0+)?)$/.test(cells[6]) ||
      Math.max(...stats.map((i) => i.baseline)) - Math.min(...stats.map((i) => i.baseline)) >
        height * 0.3 ||
      stats.some(
        (i) =>
          Math.abs(i.baseline - (groups[start][0].baseline + groups[stop - 1][0].baseline) / 2) >
          height * 0.75
      )
    )
      return
    for (let cohort = 0; cohort < 2; cohort++) {
      const percentages = values
        .slice(start, stop)
        .filter((_, n) => n % 2 === cohort)
        .map((v) => Number(v[4]))
      if (Math.abs(percentages.reduce((a, b) => a + b, 0) - 100) > categories * 0.1) return
    }
    for (const column of [0, 5, 6])
      spans.push({ row: start + 1, column, rowSpan: stop - start, colSpan: 1 })
    owned.push(stats)
  }
  if (!hasUniqueRecordTokens(source, owned)) return
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[0][1], x, frame[2][1]]),
    spans,
    headerRows: [0],
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

// Native full-width rules and repeated complete cohort values establish rows;
// centered text-only bands are independent section headings, not data cells.
function recoverCenteredCohortSections(table, items, rules) {
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 4) return
  const borders = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 12 &&
      r[1] <= crop[3] + 12
  )
  if (borders.length !== 3) return
  const frame = [
    Math.min(crop[0], borders[0][0]),
    borders[0][1],
    Math.max(crop[2], borders[0][2]),
    borders[2][1]
  ]
  const cuts = [
    frame[0],
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    frame[2]
  ]
  const source = tableSourceItems(items, frame),
    header = source.filter((i) => i.rect[3] < borders[1][1]),
    body = source.filter((i) => i.rect[1] > borders[1][1])
  const heading = readSourceRow(header, cuts, { multiline: true })
  if (
    !heading ||
    !/\p{L}/u.test(heading[0]) ||
    !heading[1] ||
    !heading[2] ||
    !/^p[- ]?value$/i.test(heading[3])
  )
    return
  const heights = body.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const groups = groupSourceRowsWithScripts(body, height, 0.35)
  if (!groups || !hasUniqueRecordTokens(source, [header, ...groups])) return
  const spans = []
  let records = 0,
    centered = 0
  const number = (s) =>
    /^[−–+-]?\d+(?:\.\d+)?(?:[±+]\d+(?:\.\d+)?)?(?:\(\d+(?:\.\d+)?%?\))?(?:;n=\d+)?$/.test(s) ||
    /^\(\d+\)\d+%$/.test(s)
  for (const [n, g] of groups.entries()) {
    const v = readSourceRow(g, cuts),
      r = union(g)
    const label = g.map((i) => i.text).join('')
    if (g.every((i) => i.rect[2] < cuts[1]) && /\p{L}/u.test(label) && !v?.slice(1).some(Boolean)) {
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 4 })
      continue
    }
    if (
      !/\d/.test(label) &&
      /\p{L}/u.test(label) &&
      Math.abs((r[0] + r[2]) / 2 - (frame[0] + frame[2]) / 2) < height &&
      r[2] - r[0] < (frame[2] - frame[0]) * 0.5
    ) {
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 4 })
      centered++
      continue
    }
    if (
      !v ||
      !v[0] ||
      !number(v[1]) ||
      !number(v[2]) ||
      !(
        /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[*]*$/.test(v[3]) ||
        (n === 0 && !v[3] && /^n\(%\)$/.test(v[0]))
      )
    )
      return
    records++
  }
  const bounds = groups.map(union)
  if (records < 8 || centered < 3 || bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], borders[1][1]],
      ...bounds.map((r) => [frame[0], r[1], frame[2], r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
