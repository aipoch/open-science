/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  recoverRuledHeaderBands,
  recoverClosedNativeHeaderBands,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  joinHorizontalTableRules,
  clusterTableRulePositions,
  classifyTableRuleEdge
} from './literature-pdf-table-rules.mjs'

const numeric = (s) =>
  /^(?:[<>≤≥−–+-]?(?:\d|\.\d)[\d.,:()%/±−–+*†‡a-zχ[\]-]*|[–—-]|Ref\.)$/i.test(
    s.replace(/\s|to/g, '')
  )

// A native divider and a fully accounted sequence of repeated numeric records
// establish body rows independently of omitted/overlapping model bands. Sparse
// reference records and nested stubs have separate, explicit header signatures.
export function recoverRuledBodyRecords(table, items, rules) {
  const counts = recoverNativeCountContinuation(table, items, rules)
  if (counts) return counts
  const continuation = recoverTrailingCountContinuation(table, items, rules)
  if (continuation) return continuation
  const faces = recoverHorizontalCellFaces(table, items, rules)
  if (faces) return faces
  const studies = recoverComparisonStudyRecords(table, items, rules)
  if (studies) return studies
  const scores = recoverRepeatedScoreSummaries(table, items, rules)
  if (scores) return scores
  const unitRecords = recoverCohortUnitRecords(table, items, rules)
  if (unitRecords) return unitRecords
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 3 || columns.length > 12) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const full = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < 16 &&
      Math.abs(r[2] - right) < 24 &&
      r[1] > top &&
      r[1] < top + height * 9
  )
  for (const divider of full) {
    const header = source.filter((i) => i.rect[3] < divider[1]),
      body = source.filter(
        (i) =>
          i.rect[1] > divider[1] ||
          (i.baseline > divider[1] && divider[1] - i.rect[1] < height * 0.15)
      )
    if (!header.length || !body.length || !hasUniqueRecordTokens(source, [header, body])) continue
    const hierarchy =
      recoverClosedNativeHeaderBands(header, cuts, rules, top, divider[1]) ??
      recoverRuledHeaderBands(header, cuts, rules, top, divider[1])
    if (!hierarchy) continue
    const heading = readSourceRow(
      header.filter((i) => i.baseline > hierarchy.rows.at(-1)[1]),
      cuts,
      { multiline: true }
    )
    const allHeading = readSourceRow(header, cuts, { multiline: true })
    const hazards =
      heading &&
      columns.length === 7 &&
      [1, 4].every((c) => /HazardRatio/i.test(heading[c])) &&
      [2, 5].every((c) => /95%CI/.test(heading[c])) &&
      [3, 6].every((c) => /^p$/i.test(heading[c]))
    const metrics =
      columns.length === 5 &&
      header.some((i) => /^Metric$/i.test(i.text.trim())) &&
      heading &&
      [2, 3].every((c) => /Mean±SD/i.test(heading[c])) &&
      /p-value/i.test(readSourceRow(header, cuts, { multiline: true })?.[4] ?? '')
    const nested =
      heading &&
      columns.length === 5 &&
      !heading[0] &&
      !heading[1] &&
      heading.slice(2).every((s) => /\p{L}/u.test(s))
    const odds =
      columns.length === 5 &&
      allHeading &&
      /Oddsratio\(95%CI\)/i.test(allHeading[4]) &&
      /p-value/i.test(allHeading[3]) &&
      allHeading.slice(1, 3).every((s) => /No\.\(%\)/.test(s))
    const headerText = header
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
    const eventCounts =
      columns.length === 5 &&
      /Numberofpatients\(%\)/i.test(headerText) &&
      /Oddsratio\(95%CI\)/i.test(headerText) &&
      headerText.match(/\(n=\d+\)/gi)?.length === 2
    const summaries =
      columns.length === 4 &&
      headerText.match(/Median\(IQR\)/gi)?.length === 2 &&
      headerText.match(/Frequency\(%\)/gi)?.length === 2
    const schedules =
      [7, 10].includes(columns.length) &&
      header.some((i) => i.text.trim() === 'Schedule') &&
      header.some((i) => /^Hazard ratio/.test(i.text)) &&
      header.some((i) => /^Prevalence/.test(i.text)) &&
      header.filter((i) => /^P-/.test(i.text)).length >= 2
    if (!hazards && !metrics && !nested && !odds && !eventCounts && !summaries && !schedules)
      continue
    if (hazards) {
      const rawCol = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
      const col = (i) => {
        const anchors = body.filter((a) => a !== i && isAdjacentTableScript(i, a))
        return anchors.length === 1 ? rawCol(anchors[0]) : rawCol(i)
      }
      const stubEnd = Math.max(...body.filter((i) => col(i) === 0).map((i) => i.rect[2]))
      const dataStart = Math.min(...body.filter((i) => col(i) === 1).map((i) => i.rect[0]))
      if (stubEnd >= dataStart || stubEnd - cuts[1] > height * 2) continue
      if (cuts[1] < stubEnd) cuts[1] = (stubEnd + dataStart) / 2
    }
    const stubCount = metrics || nested ? 2 : 1
    let sourceBottom = bottom,
      bodyRecords = body
    if (schedules) {
      const closing = joinHorizontalTableRules(rules).find(
        (r) =>
          Math.abs(r[0] - left) < 16 &&
          Math.abs(r[2] - right) < 16 &&
          r[1] <= bottom &&
          bottom - r[1] < height * 2
      )
      const tail = closing && body.filter((i) => i.rect[1] > closing[1])
      if (tail?.length && tail.every((i) => /^\d$/.test(i.text) && i.height < height * 0.8)) {
        sourceBottom = closing[1]
        bodyRecords = body.filter((i) => i.rect[3] <= sourceBottom)
      }
    }
    const physical = groupSourceRowsWithScripts(bodyRecords, height, 0.3)
    if (!physical) continue
    const groups = [],
      spans = [],
      sections = []
    let records = 0,
      references = 0,
      intervals = 0,
      valid = true
    for (const g of physical) {
      const v = readSourceRow(g, cuts),
        previous = groups.at(-1)
      if (
        odds &&
        v &&
        !v.slice(0, 4).some(Boolean) &&
        /^\([−+-]?\d+(?:\.\d+)?to[−+-]?\d+(?:\.\d+)?\)$/.test(v[4])
      ) {
        if (!previous || !readSourceRow(previous, cuts)?.slice(1).every(numeric)) {
          valid = false
          break
        }
        previous.push(...g)
        intervals++
        continue
      }
      const stubOnly =
        g.every((i) => i.rect[0] < cuts[stubCount]) &&
        (g.some((i) => /\p{L}/u.test(i.text)) ||
          (summaries &&
            /^\(\d+\)$/.test(
              g
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '')
            )))
      if (stubOnly) {
        const compact = g
          .map((i) => i.text)
          .join('')
          .replace(/\s/g, '')
        const prior = previous && readSourceRow(previous, cuts, { multiline: true })
        if (
          schedules &&
          previous &&
          sections.includes(groups.length - 1) &&
          /[-]$/.test(previous.map((i) => i.text).join('')) &&
          /^\p{Ll}/u.test(compact)
        ) {
          previous.push(...g)
        } else if (
          previous &&
          !sections.includes(groups.length - 1) &&
          prior?.slice(stubCount).some(Boolean) &&
          /^[a-z(]/.test(compact) &&
          g[0].baseline - Math.max(...previous.map((i) => i.baseline)) < height * 1.5
        ) {
          previous.push(...g)
        } else {
          sections.push(groups.length)
          groups.push([...g])
        }
        continue
      }
      const summary = hazards && readSourceRow(g, [left, cuts[1], cuts[4], right])
      if (
        hazards &&
        summary &&
        /(?:AIC|likelihood)/i.test(summary[0]) &&
        summary.slice(1).every(numeric)
      ) {
        spans.push(
          ...[1, 4].map((column) => ({
            row: hierarchy.rows.length + groups.length,
            column,
            rowSpan: 1,
            colSpan: 3
          }))
        )
        groups.push([...g])
        continue
      }
      if (
        eventCounts &&
        v &&
        !v[0] &&
        v.slice(1).every(numeric) &&
        previous &&
        sections.at(-1) === groups.length - 1 &&
        full.every((r) => r[1] <= union(previous)[1] || r[1] >= union(g)[3])
      ) {
        previous.push(...g)
        sections.pop()
        records++
        continue
      }
      if (!v) {
        valid = false
        break
      }
      if (hazards && v[0] && v[1] === 'Ref.' && v.slice(2).every((s) => !s)) {
        references++
      } else if (
        hazards &&
        v[0] &&
        numeric(v[1]) &&
        /^\([\d.,]+\)$/.test(v[2]) &&
        numeric(v[3]) &&
        ((numeric(v[4]) && /^\([\d.,]+\)$/.test(v[5]) && numeric(v[6])) ||
          (v[4] === '—' && !v[5] && v[6] === '—'))
      ) {
        records++
      } else if (
        hazards &&
        v[0] &&
        !v[1] &&
        numeric(v[2]) &&
        !v[3] &&
        !v[4] &&
        numeric(v[5]) &&
        !v[6]
      ) {
        spans.push(
          ...[1, 4].map((column) => ({
            row: hierarchy.rows.length + groups.length,
            column,
            rowSpan: 1,
            colSpan: 3
          }))
        )
      } else if (
        v.slice(0, stubCount).some(Boolean) &&
        v.slice(stubCount).every((s) => !s || numeric(s)) &&
        v.slice(stubCount).filter(Boolean).length >=
          (metrics
            ? 3
            : summaries
              ? 2
              : schedules
                ? columns.length - 4
                : columns.length - stubCount)
      ) {
        if (schedules && !/^\d+(?:\.\d+)?Gy$/.test(v[0])) {
          valid = false
          break
        }
        records++
      } else {
        valid = false
        break
      }
      groups.push([...g])
    }
    if (
      !valid ||
      records < (odds ? 4 : 10) ||
      (odds
        ? intervals < 2
        : hazards
          ? references < 3
          : !metrics && !eventCounts && sections.length < 3) ||
      !hasUniqueRecordTokens(bodyRecords, groups)
    )
      continue
    const bounds = groups.map(union)
    if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) continue
    if (metrics) {
      const values = groups.map((g) => readSourceRow(g, cuts))
      for (let n = 0; n < groups.length; n++)
        if (values[n]?.[0]) {
          let stop = n + 1
          while (stop < groups.length && !values[stop][0]) stop++
          if (stop - n > 1)
            spans.push({ row: hierarchy.rows.length + n, column: 0, rowSpan: stop - n, colSpan: 1 })
        }
    }
    return {
      ...(sourceBottom < bottom ? { cropRect: [left, top, right, sourceBottom] } : {}),
      rows: [...hierarchy.rows, ...bounds.map((r) => [left, r[1], right, r[3]])],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      headerRows: hierarchy.rows.map((_, n) => n),
      spans: [
        ...hierarchy.spans,
        ...spans,
        ...sections.map((n) => ({
          row: hierarchy.rows.length + n,
          column: 0,
          rowSpan: 1,
          colSpan: Math.max(stubCount, cuts.slice(1).findIndex((x) => union(groups[n])[2] <= x) + 1)
        }))
      ],
      completeSpans: true,
      ownedTokens: new Set([...header, ...bodyRecords])
    }
  }
}

// Repeated abutting cell strokes establish column gutters without vertical
// rules. Missing stub/statistic separators then prove bounded rowspans, while
// full-width prose faces remain independent section labels.
function recoverHorizontalCellFaces(table, items, rules) {
  const crop = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length < 3 || model.length > 8) return
  const local = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] >= crop[0] - 4 &&
      r[2] <= crop[2] + 4 &&
      r[1] >= crop[1] - 4 &&
      r[1] <= crop[3] + 4
  )
  const xs = clusterTableRulePositions(local.flatMap((r) => [r[0], r[2]]))
  if (xs.length !== model.length + 1) return
  if (
    xs.some((x) => local.filter((r) => Math.abs(r[0] - x) < 1 || Math.abs(r[2] - x) < 1).length < 8)
  )
    return
  const joined = joinHorizontalTableRules(local)
  const full = joined.filter((r) => Math.abs(r[0] - xs[0]) < 1 && Math.abs(r[2] - xs.at(-1)) < 1)
  if (full.length < 12 || Math.abs(full[0][1] - crop[1]) > 16) return
  const top = full[0][1],
    bottom = full.at(-1)[1]
  const tail = tableSourceItems(items, crop).filter((i) => i.rect[1] >= bottom)
  if (tail.length && !tail.every((i) => /^Continued$/i.test(i.text.trim()))) return
  if (crop[3] - bottom > 30) return
  const source = tableSourceItems(items, [xs[0] - 0.1, top, xs.at(-1) + 0.1, bottom])
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const ys = clusterTableRulePositions(
    local.filter((r) => r[1] >= top && r[1] <= bottom).map((r) => r[1])
  )
  if (ys.length < 15 || ys.length > 80) return
  const faces = ys
    .slice(1)
    .map((y, n) =>
      source.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (faces.some((g) => !g.length) || !hasUniqueRecordTokens(source, faces)) return
  const header = readSourceRow(faces[0], xs, { multiline: true })
  if (
    !header ||
    !header.every((v) => /\p{L}/u.test(v)) ||
    !/p[- ]?value[*†‡]?$/i.test(header.at(-1))
  )
    return
  const sections = new Set(),
    spans = [],
    owned = [faces[0]]
  for (let n = 1; n < faces.length; n++) {
    const g = faces[n]
    if (
      g.every((i) => /^[\p{L}\s\d,;:()–−/-]+$/u.test(i.text)) &&
      /^\p{L}/u.test(g[0].text) &&
      !g.some((i) => /^\d/.test(i.text.trim()) && !/\p{L}/u.test(i.text)) &&
      [ys[n], ys[n + 1]].every((y) => full.some((r) => Math.abs(r[1] - y) < 0.1))
    ) {
      sections.add(n)
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: model.length })
      owned.push(g)
    }
  }
  if (sections.size < 2) return
  const body = source.filter((i) => !owned.some((g) => g.includes(i)))
  const col = (i) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  // Ignore only sub-pixel endpoint rounding, with a native empty gutter.
  for (let c = 1; c < xs.length - 1; c++) {
    const overhang = body.filter(
      (i) => col(i) === c - 1 && i.rect[2] > xs[c] && i.rect[2] - xs[c] < 0.1
    )
    if (overhang.length) {
      const end = Math.max(...overhang.map((i) => i.rect[2]))
      if (body.some((i) => col(i) === c && i.rect[0] <= end)) return
      xs[c] = end
    }
  }
  const shared = new Map()
  for (let n = 1; n < faces.length; n++) {
    if (sections.has(n)) continue
    const cross = faces[n].filter((i) => col(i) > 0 && i.rect[2] > xs[col(i) + 1] + 0.1)
    if (!cross.length) continue
    if (cross.length !== 1) return
    const i = cross[0],
      c = col(i)
    if (
      c + 2 >= xs.length ||
      i.rect[0] < xs[c] ||
      i.rect[2] > xs[c + 2] ||
      !numeric(i.text) ||
      faces[n].some((j) => j !== i && [c, c + 1].includes(col(j)))
    )
      return
    shared.set(n, c)
    spans.push({ row: n, column: c, rowSpan: 1, colSpan: 2 })
  }
  let merged = 0,
    records = 0
  for (let c = 0; c < model.length; c++) {
    for (let start = 1; start < faces.length;) {
      if (sections.has(start) || shared.get(start) === c - 1) {
        start++
        continue
      }
      let end = start + 1
      while (
        end < faces.length &&
        !sections.has(end) &&
        classifyTableRuleEdge(joined, 1, ys[end], xs[c], xs[c + 1]) === 0
      )
        end++
      if (
        [ys[start], ys[end]].some(
          (y) => classifyTableRuleEdge(joined, 1, y, xs[c], xs[c + 1]) !== 1
        )
      )
        return
      const g = body.filter(
        (i) => col(i) === c && i.rect[1] >= ys[start] - 0.1 && i.rect[3] <= ys[end] + 0.1
      )
      if (!g.length) return
      if (c && groupSourceRowsWithScripts(g, height, 0.3)?.length !== 1) return
      const text =
        shared.get(start) === c
          ? readSourceRow(g, [xs[c], xs[c + 2]], { multiline: true })?.[0]
          : readSourceRow(g, xs, { multiline: true })?.[c]
      if (
        !text ||
        (c
          ? !(numeric(text) || /^\(\d+(?:\.\d+)?(?:[−–-]\d+(?:\.\d+)?)?\)$/.test(text))
          : !/[\p{L}\d]/u.test(text))
      )
        return
      if (end - start > 1) {
        spans.push({ row: start, column: c, rowSpan: end - start, colSpan: 1 })
        merged++
      }
      owned.push(g)
      if (c === 1) records++
      start = end
    }
  }
  if (merged < 3 || records < 10 || !hasUniqueRecordTokens(source, owned)) return
  return {
    cropRect: [xs[0], top, xs.at(-1), bottom],
    rows: ys.slice(1).map((y, n) => [xs[0], ys[n], xs.at(-1), y]),
    columns: xs.slice(1).map((x, c) => [xs[c], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// A comparison of published studies has one explicitly qualified author/year
// header and repeated yes/no records. Its multiline labels establish starts;
// lowercase/parenthetical continuations and empty-stub prose stay in that record.
function recoverComparisonStudyRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const cs = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cs.length !== 6) return
  const cuts = [left, ...cs.slice(1).map((c, n) => left + (cs[n].rect[2] + c.rect[0]) / 2), right]
  const source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const physical = groupSourceRowsWithScripts(source, height, 0.3)
  if (!physical || physical.length < 12) return
  const initial = readSourceRow(physical[0], cuts),
    years = readSourceRow(physical[1], cuts)
  if (
    !initial ||
    initial[0] !== 'FirstAuthor' ||
    !initial.slice(1).every((s) => /\p{L}/u.test(s)) ||
    !years ||
    years[0] !== '(YearPublished)' ||
    !years.slice(1).every((s) => /^\((?:\d{4}|CurrentStudy)\)$/.test(s))
  )
    return
  const full = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16 && r[1] >= top && r[1] <= bottom
  )
  if (full.length !== 3 || full[1][1] >= union(physical[2])[1]) return
  const body = physical.slice(2).flat(),
    rawCol = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => rawCol(i) === c - 1),
      b = body.filter((i) => rawCol(i) === c)
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start || end - cuts[c] > height * 2 || cuts[c] - start > height * 2) return
    if (end > cuts[c] || start < cuts[c]) cuts[c] = (end + start) / 2
  }
  const groups = [physical.slice(0, 2).flat()]
  let booleanRecords = 0
  for (const g of physical.slice(2)) {
    const v = readSourceRow(g, cuts),
      prev = groups.at(-1)
    if (!v) return
    if (!v[0] || /^[a-z(]/.test(v[0])) {
      if (groups.length < 2) return
      prev.push(...g)
    } else {
      if (v.slice(1).every((s) => /^(?:Yes|No)$/.test(s))) booleanRecords++
      groups.push([...g])
    }
  }
  if (booleanRecords < 4 || groups.length < 12 || !hasUniqueRecordTokens(source, groups)) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

function recoverRepeatedScoreSummaries(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const cs = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cs.length !== 5) return
  const cuts = [left, ...cs.slice(1).map((c, n) => left + (cs[n].rect[2] + c.rect[0]) / 2), right]
  const source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const physical = groupSourceRowsWithScripts(source, height, 0.3)
  if (!physical) return
  const values = physical.map((g) => readSourceRow(g, cuts))
  if (
    values.some((v) => !v) ||
    !values[1] ||
    values[1][1] !== 'Median(IQR)' ||
    values[1][2] ||
    values[1][3] ||
    values[1][4] !== '(95%CI),p'
  )
    return
  const divider = joinHorizontalTableRules(rules).find(
    (r) =>
      Math.abs(r[0] - left) < 16 &&
      Math.abs(r[2] - right) < 16 &&
      r[1] > union(physical[1])[3] &&
      r[1] < union(physical[2])[1]
  )
  if (!divider) return
  const groups = physical.slice(0, 2).map((g) => [...g]),
    spans = [{ row: 1, column: 1, rowSpan: 1, colSpan: 2 }]
  let records = 0,
    visits = 0
  const number = (s) => /^[<>≤≥−+-]?\d+(?:\.\d+)?$/.test(s)
  const interval = (s) => /^\([−+-]?\d+(?:\.\d+)?to[−+-]?\d+(?:\.\d+)?\)$/.test(s)
  for (let n = 2; n < physical.length;) {
    const v = values[n]
    if (v[0] && v.slice(1, 3).every((s) => /^N=\d+$/.test(s)) && v.slice(3).every((s) => !s)) {
      visits++
      groups.push([...physical[n++]])
      continue
    }
    const estimate = values[n + 1],
      range = values[n + 2]
    if (
      !/\p{L}/u.test(v[0]) ||
      v.slice(1).some(Boolean) ||
      !estimate ||
      !range ||
      !/^\(question\d+(?:,\d+)+\)$/.test(estimate[0]) ||
      !estimate.slice(1).every(number) ||
      range[0] !== 'Scale0–100' ||
      !range.slice(1, 3).every(interval) ||
      range[3] ||
      !/^\([−+-]?\d+(?:\.\d+)?to[−+-]?\d+(?:\.\d+)?\),[<>≤≥]?\d+(?:\.\d+)?$/.test(range[4])
    )
      return
    groups.push(physical.slice(n, n + 3).flat())
    n += 3
    records++
  }
  if (visits !== 2 || records < 6 || !hasUniqueRecordTokens(source, groups)) return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated N/mean/deviation leaves plus separately underlined sample headings
// identify the same cohort grid on a captionless continuation. Physical records
// recover omitted rows; only a locally printed N owns following blank N cells.
function recoverCohortUnitRecords(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const cs = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cs.length !== 7) return
  const cuts = [left, ...cs.slice(1).map((c, n) => left + (cs[n].rect[2] + c.rect[0]) / 2), right]
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const physical = groupSourceRowsWithScripts(source, height, 0.3)
  if (!physical || physical.length < 12) return
  const units = physical.findIndex((g) => {
    const v = readSourceRow(g, cuts)
    return v && !v[0] && v.slice(1).every((s, c) => s === ['N', 'n/mean', 'SD/%'][c % 3])
  })
  if (units !== 1) return
  const parents = physical[0],
    head = readSourceRow(parents, [left, cuts[1], cuts[4], right])
  if (!head || head[0] || !head.slice(1).every((s) => /\p{L}.*\(n=\d+\)/iu.test(s))) return
  const underlines = joinHorizontalTableRules(rules).filter(
    (r) => r[1] > union(parents)[3] && r[1] < union(physical[1])[1]
  )
  if (
    ![1, 4].every((c) =>
      underlines.some(
        (r) => r[0] > cuts[c] && r[0] < cuts[c + 1] && r[2] > cuts[c + 2] && r[2] < cuts[c + 3]
      )
    )
  )
    return
  const values = physical.slice(2).map((g) => readSourceRow(g, cuts))
  const sections = []
  let records = 0
  const number = (s) => /^[−+-]?\d+(?:\.\d+)?$/.test(s)
  const dispersion = (s) => /^\(\d+(?:\.\d+)?%?\)[*†‡]?$/.test(s)
  for (let n = 0; n < values.length; n++) {
    const v = values[n]
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      if (!/\p{L}/u.test(v[0])) return
      sections.push(n)
    } else if (
      [1, 4].every(
        (c) =>
          (!v[c] || /^\d+$/.test(v[c])) &&
          ((number(v[c + 1]) && dispersion(v[c + 2])) ||
            (/^\d+$/.test(v[c]) && !v[c + 1] && !v[c + 2]))
      )
    )
      records++
    else return
  }
  if (records < 10 || sections.length < 2) return
  const bounds = physical.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const spans = [1, 4].map((column) => ({ row: 0, column, rowSpan: 1, colSpan: 3 }))
  for (let n = 0; n < values.length; n++)
    for (const c of [1, 4]) {
      if (!values[n][c]) continue
      let stop = n + 1
      while (stop < values.length && !sections.includes(stop) && !values[stop][c]) stop++
      if (stop - n > 1) spans.push({ row: n + 2, column: c, rowSpan: stop - n, colSpan: 1 })
    }
  return {
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans: [...spans, ...sections.map((n) => ({ row: n + 2, column: 0, rowSpan: 1, colSpan: 7 }))],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
// A final section without values is meaningful on an explicitly marked
// continuation. Repeated sample-qualified cohorts and owned source records
// recover it even when the last model band ends above its printed ink.
function recoverTrailingCountContinuation(table, items, rules) {
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 3) return
  const cuts = [
    crop[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  const source = tableSourceItems(items, crop)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  const markers = items.filter(
    (i) =>
      i.horizontal &&
      /^\(?continu(?:e|ed)(?:\.{3}|…)?\)?$/i.test(i.text.trim()) &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] + 16 &&
      i.rect[1] > crop[3] &&
      i.rect[1] - crop[3] < height * 3
  )
  if (markers.length !== 1) return
  const full = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] > crop[1] &&
      r[1] - crop[1] < height * 8
  )
  for (const divider of full) {
    const header = source.filter((i) => i.rect[3] < divider[1]),
      body = source.filter((i) => i.rect[1] > divider[1])
    if (!header.length || !body.length || !hasUniqueRecordTokens(source, [header, body])) continue
    const heading = readSourceRow(header, cuts, { multiline: true })
    if (!heading?.[0] || !heading.slice(1).every((s) => /\p{L}.*\(n=\d+\)$/iu.test(s))) continue
    const physical = groupSourceRowsWithScripts(body, height, 0.3)
    if (!physical) continue
    const groups = [],
      sections = []
    let records = 0,
      counts = 0,
      valid = true
    for (const g of physical) {
      const v = readSourceRow(g, cuts),
        prev = groups.at(-1)
      if (!v) {
        valid = false
        break
      }
      if (v[0] && !v.slice(1).some(Boolean)) {
        if (
          prev &&
          /^[\p{Ll}]/u.test(v[0]) &&
          !sections.includes(groups.length - 1) &&
          g[0].baseline - Math.max(...prev.map((i) => i.baseline)) < height * 1.4
        )
          prev.push(...g)
        else {
          sections.push(groups.length)
          groups.push([...g])
        }
      } else if (v.slice(1).every(numeric)) {
        if (!v[0]) {
          if (
            !prev ||
            !sections.includes(groups.length - 1) ||
            g[0].baseline - Math.max(...prev.map((i) => i.baseline)) > height
          ) {
            valid = false
            break
          }
          prev.push(...g)
          sections.pop()
        } else groups.push([...g])
        records++
        if (v.slice(1).every((s) => /^\d+$|^[–—-]$/.test(s))) counts++
      } else {
        valid = false
        break
      }
    }
    if (
      !valid ||
      records < 8 ||
      counts < 5 ||
      sections.length < 2 ||
      sections.at(-1) !== groups.length - 1 ||
      !hasUniqueRecordTokens(body, groups)
    )
      continue
    const last = union(groups.at(-1)),
      first = union(groups[sections[0]])
    const modelBottom = Math.max(
      ...table.structure.objects
        .filter((o) => o.label === 'table row')
        .map((o) => o.rect[3] + crop[1])
    )
    if (
      last[1] <= modelBottom ||
      Math.abs(last[0] - first[0]) > 0.5 ||
      groups.at(-1).some((i) => i.rect[2] >= cuts[1])
    )
      continue
    const hierarchy = recoverRuledHeaderBands(header, cuts, rules, crop[1], divider[1])
    if (!hierarchy) continue
    const bounds = groups.map(union)
    if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) continue
    return {
      rows: [...hierarchy.rows, ...bounds.map((r) => [crop[0], r[1], crop[2], r[3]])],
      columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, crop[3]]),
      headerRows: hierarchy.rows.map((_, n) => n),
      spans: [
        ...hierarchy.spans,
        ...sections.map((n) => ({
          row: hierarchy.rows.length + n,
          column: 0,
          rowSpan: 1,
          colSpan: 3
        }))
      ],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
}
// A headerless continuation retains two n/% cohort pairs and a probability
// column. Native first/last rules bound the panel; every printed numeric or
// section record must validate before omitted model rows/spans are replaced.
function recoverNativeCountContinuation(table, items, rules) {
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length !== 6) return
  const local = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 16 &&
      r[1] <= crop[3] + 16
  )
  if (
    local.length !== 2 ||
    Math.abs(local[0][1] - crop[1]) > 16 ||
    Math.abs(local[1][1] - crop[3]) > 16 ||
    Math.abs(local[0][0] - local[1][0]) > 1 ||
    Math.abs(local[0][2] - local[1][2]) > 1
  )
    return
  const left = Math.min(crop[0], local[0][0]),
    right = Math.max(crop[2], local[0][2]),
    bottom = Math.max(crop[3], local[1][1]),
    frame = [left, crop[1], right, bottom]
  const source = tableSourceItems(items, frame),
    height = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  if (
    !height ||
    source.some((i) => i.rect[1] < local[0][1] - height * 0.1 || i.rect[3] > local[1][1])
  )
    return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const physical = groupSourceRowsWithScripts(source, height, 0.3)
  if (!physical || physical.length < 15) return
  const values = physical.map((g) => readSourceRow(g, cuts))
  const count = (s) => /^\d+$/.test(s),
    percent = (s) => /^\d+(?:\.\d+)?$/.test(s) && +s >= 0 && +s <= 100,
    probability = (s) => /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(s)
  let records = 0,
    sectionProbabilities = 0
  const sections = []
  for (let n = 0; n < values.length; n++) {
    const v = values[n]
    if (!v || !/\p{L}/u.test(v[0])) return
    if (v.slice(1, 5).every((s) => !s) && probability(v[5])) {
      sectionProbabilities++
      continue
    }
    if (v.slice(1).every((s) => !s)) {
      sections.push(n)
      continue
    }
    if (
      !count(v[1]) ||
      !percent(v[2]) ||
      !count(v[3]) ||
      !percent(v[4]) ||
      (v[5] && !probability(v[5]))
    )
      return
    records++
  }
  if (
    records < 10 ||
    sectionProbabilities < 3 ||
    sections.length !== 1 ||
    !values[0].slice(1, 5).every((s, c) => (c % 2 ? percent(s) : count(s)))
  )
    return
  const section = sections[0],
    label = union(physical[section]),
    parents = physical.filter(
      (_, n) => probability(values[n][5]) && !values[n].slice(1, 5).some(Boolean)
    )
  if (
    section < 3 ||
    section >= values.length - 3 ||
    parents.some((g) => union(g.filter((i) => i.rect[2] < cuts[1]))[0] - label[0] < height * 0.5)
  )
    return
  if (
    physical.some((g) =>
      g.some((i) => {
        const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
        return c < 0 || i.rect[0] < cuts[c] - 0.1 || i.rect[2] > cuts[c + 1] + 0.1
      })
    )
  )
    return
  const bounds = physical.map(union)
  if (
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) ||
    !hasUniqueRecordTokens(source, physical)
  )
    return
  return {
    cropRect: frame,
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, bottom]),
    headerRows: [],
    spans: [{ row: section, column: 0, rowSpan: 1, colSpan: 6 }],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
