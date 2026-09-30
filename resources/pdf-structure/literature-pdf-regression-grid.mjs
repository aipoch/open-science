/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

// Paired univariable/multivariable summaries share coefficient, interval, R²
// and P-value headings. Recover native records, retaining intentionally blank
// model-summary values instead of filling them down.
export function recoverRegressionGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length === 4) return recoverCategoricalRiskRecords(table, items, predicted)
  if (predicted.length !== 9) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const parents = source.filter((i) => /^(?:Univariable|Multivariable) associations$/.test(i.text))
  if (
    parents.length !== 2 ||
    parents[0].text !== 'Univariable associations' ||
    parents[1].text !== 'Multivariable associations'
  )
    return
  const ci = source.filter((i) => /^99% CI$/.test(i.text))
  if (ci.length !== 2 || col(ci[0]) !== 2 || col(ci[1]) !== 6) return
  const body = source.filter((i) => i.rect[1] > Math.max(...ci.map((i) => i.rect[3])) + 1)
  const anchors = body.filter((i) => col(i) === 0 && /^∆\s*\p{L}/u.test(i.text))
  if (anchors.length < 12) return
  const groups = anchors.map((a) =>
    body.filter(
      (i) =>
        Math.abs(i.baseline - a.baseline) < a.height * 0.4 ||
        (i.height < a.height * 0.8 &&
          i.rect[0] >= a.rect[0] &&
          i.rect[0] <= a.rect[2] + 1 &&
          Math.abs(i.baseline - a.baseline) < a.height * 0.6)
    )
  )
  if (!hasUniqueRecordTokens(body, groups)) return
  let records = 0,
    sections = 0
  const spans = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 4 },
    { row: 0, column: 5, rowSpan: 1, colSpan: 4 }
  ]
  for (const [n, g] of groups.entries()) {
    const values = readSourceRow(g, cuts)
    if (!values) return
    if (values.slice(1).every((v) => !v)) {
      sections++
      spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: 9 })
      continue
    }
    if (
      values
        .slice(1, 7)
        .some((v, c) =>
          c === 1 || c === 5
            ? !/^[−-]?\d+\.\d+;[−-]?\d+\.\d+$/.test(v)
            : !/^[<>]?[−-]?\d+(?:\.\d+)?\*?$/.test(v)
        )
    )
      return
    if (values.slice(7).some((v) => v && !/^[<>]?\d+(?:\.\d+)?$/.test(v))) return
    records++
  }
  if (records < 9 || sections < 3) return
  const split =
    (Math.max(...parents.map((i) => i.rect[3])) + Math.min(...ci.map((i) => i.rect[1]))) / 2
  const rows = [
    [left, top, right, split],
    [left, split, right, Math.min(...body.map((i) => i.rect[1])) - 0.1],
    ...groups.map((g) => {
      const r = union(g)
      return [left, r[1] - 0.1, right, r[3] + 0.1]
    })
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}

// Standard coefficient summaries have five aligned numeric fields per record.
// Explicit statistical headings and ruled section bands distinguish these
// tables from arbitrary number-rich prose; no values are filled or calculated.
export function recoverSectionedCoefficientsGrid(table, items, rules) {
  const identifiers = recoverIdentifierCoefficientGrid(table, items, rules)
  if (identifiers) return identifiers
  const inline = recoverInlineCoefficientSections(table, items, rules)
  if (inline) return inline
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
  const nearby = tableSourceItems(items, [left, top - 30, right, bottom + 30])
  const headings = ['Predictor', 'β', 'SEM', 'df', 't', 'p'].map((s) =>
    nearby.filter((i) => i.text.trim() === s)
  )
  if (headings.some((a) => a.length !== 1)) return
  const header = headings.flat()
  if (
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) > 1 ||
    header.some((i, n) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])
  )
    return
  cuts[1] = Math.max(
    cuts[1],
    ...nearby
      .filter((i) => /\p{L}/u.test(i.text) && i.rect[0] < cuts[1] && i.rect[2] < header[1].rect[0])
      .map((i) => i.rect[2] + 1)
  )
  const headBottom = Math.max(...header.map((i) => i.rect[3]))
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] <= left + 15 &&
        r[2] >= right - 15 &&
        r[1] > headBottom &&
        r[1] <= bottom + 40
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 3) return
  const body = tableSourceItems(items, [
    left,
    headBottom + 0.1,
    right,
    Math.max(bottom, borders.at(-1)[1])
  ])
  const groups = []
  for (const i of body) {
    let g = groups.find((g) => Math.abs(g[0].baseline - i.baseline) < i.height * 0.35)
    if (!g) groups.push((g = []))
    g.push(i)
  }
  const sections = [],
    records = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      r = readSourceRow(g, cuts),
      bounds = union(g)
    if (
      r &&
      /\p{L}/u.test(r[0]) &&
      r.slice(1).every((s) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)\*{0,2}$/.test(s))
    ) {
      records.push(g)
      continue
    }
    const text = g.map((i) => i.text).join(' ')
    if (
      !/\p{L}/u.test(text) ||
      /\d/.test(text) ||
      !borders.some((r) => r[1] <= bounds[1] && bounds[1] - r[1] < g[0].height * 2)
    )
      return
    sections.push(n)
  }
  if (records.length < 6 || sections.length < 2 || !hasUniqueRecordTokens(body, groups)) return
  const all = [header, ...groups],
    rects = all.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1] - 0.1, right, r[3] + 0.1]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], rects[0][1] - 0.1, x, borders.at(-1)[1]]),
    spans: sections.map((n) => ({ row: n + 1, column: 0, rowSpan: 1, colSpan: 6 })),
    completeSpans: true,
    ownedTokens: new Set(all.flat()),
    cropRect: [left, Math.min(top, rects[0][1] - 0.1), right, Math.max(bottom, borders.at(-1)[1])]
  }
}

// Complete identifier/value records establish baselines independently of
// model rows. Top-aligned nested stubs end at the next label in their own or
// an outer tier; a missing label at a hierarchy boundary is not filled down.
function recoverIdentifierCoefficientGrid(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 7 || predicted.length > 15) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const source = tableSourceItems(items, table.cropRect)
  const identifiers = source.filter((i) => /^[A-Za-z]{1,8}\d{4,}$/.test(i.text.trim()))
  if (identifiers.length < 12) return
  const idColumn = col(identifiers[0]),
    height = identifiers[0].height
  if (
    idColumn < 2 ||
    idColumn > 4 ||
    predicted.length - idColumn < 5 ||
    identifiers.some((i) => col(i) !== idColumn)
  )
    return
  const divider = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= left + 15 &&
      r[2] >= right - 15 &&
      r[1] > top &&
      r[1] < identifiers[0].rect[1] &&
      identifiers[0].rect[1] - r[1] < height * 2
  )
  if (!divider) return
  const header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (!hasUniqueRecordTokens(source, [header, body])) return
  const ci = header.filter((i) => /^\d{2}%\s*CI$/i.test(i.text)),
    lower = header.filter((i) => /^Lower$/i.test(i.text)),
    upper = header.filter((i) => /^Upper$/i.test(i.text))
  if (ci.length !== 1 || lower.length !== 1 || upper.length !== 1) return
  const ciColumn = col(lower[0])
  if (ciColumn <= idColumn || col(upper[0]) !== ciColumn + 1) return
  const underline = rules.find(
    (r) =>
      r[1] === r[3] &&
      r[0] <= lower[0].rect[0] &&
      r[2] >= upper[0].rect[2] &&
      r[0] >= cuts[ciColumn] &&
      r[2] <= cuts[ciColumn + 2] &&
      r[1] >= ci[0].rect[3] &&
      r[1] < lower[0].rect[1]
  )
  if (!underline || ci[0].rect[0] < cuts[ciColumn] || ci[0].rect[2] > cuts[ciColumn + 2]) return
  const ordinary = header.filter((i) => !ci.includes(i) && !lower.includes(i) && !upper.includes(i))
  const headings = readSourceRow(ordinary, cuts, { multiline: true })
  if (
    !headings ||
    headings.slice(idColumn).some((s, n) => !s && ![ciColumn, ciColumn + 1].includes(n + idColumn))
  )
    return
  const groups = groupSourceRowsWithScripts(body, height, 0.35)
  if (!groups || groups.length !== identifiers.length || !hasUniqueRecordTokens(body, groups))
    return
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (
    values.some(
      (v) =>
        !v ||
        !/^[A-Za-z]{1,8}\d{4,}$/.test(v[idColumn]) ||
        v.slice(idColumn + 1).some((s) => !/^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)\*{0,3}$/.test(s))
    )
  )
    return
  const bounds = groups.map(union)
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const spans = [{ row: 0, column: ciColumn, rowSpan: 1, colSpan: 2 }]
  for (let c = 0; c < predicted.length; c++)
    if (![ciColumn, ciColumn + 1].includes(c))
      spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  let shared = 0
  for (let c = 0; c < idColumn; c++) {
    if (!values[0][c]) return
    for (let n = 0; n < values.length; n++) {
      if (values[n].slice(0, c).some(Boolean) && !values[n][c]) return
      if (!values[n][c]) continue
      if (!/\p{L}/u.test(values[n][c])) return
      let end = n + 1
      while (end < values.length && values[end].slice(0, c + 1).every((s) => !s)) end++
      if (end - n > 1) {
        spans.push({ row: n + 2, column: c, rowSpan: end - n, colSpan: 1 })
        shared++
      }
    }
  }
  if (shared < 3) return
  return {
    rows: [
      [left, top, right, underline[1]],
      [left, underline[1], right, divider[1]],
      ...bounds.map((r) => [left, r[1] - 0.1, right, r[3] + 0.1])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0, 1],
    ownedTokens: new Set(source),
    cropRect: [...table.cropRect]
  }
}

// Repeated Estimate / CI / P blocks establish their own columns independently
// of the detector. Higher headings must partition those same blocks evenly;
// every native token, including reference rows and wrapped CIs, keeps one owner.
export function recoverRepeatedRegressionGrid(table, items, captions, rules) {
  const intervals = recoverLabeledIntervalRows(table, items, captions, rules)
  if (intervals) return intervals
  const effects = recoverRepeatedEffectRecords(table, items, captions, rules)
  if (effects) return effects
  const coefficients = recoverPairedCoefficientRows(table, items, captions, rules)
  if (coefficients) return coefficients
  const paired = recoverPairedRiskGrid(table, items, captions, rules)
  if (paired) return paired
  const crop = table.cropRect
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const nearby = tableSourceItems(items, [crop[0] - 12, crop[1] - 35, crop[2] + 12, crop[3] + 20])
  const estimates = nearby.filter((i) => i.text.trim() === 'Estimate')
  if (
    estimates.length < 2 ||
    estimates.length > 6 ||
    estimates.some((i) => Math.abs(i.baseline - estimates[0].baseline) > 1)
  )
    return
  estimates.sort((a, b) => a.rect[0] - b.rect[0])
  const height = estimates[0].height
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < 16 &&
        Math.abs(r[2] - crop[2]) < 24 &&
        r[1] >= crop[1] - 35 &&
        r[1] <= crop[3] + 20
    )
    .sort((a, b) => a[1] - b[1])
  const top = borders.filter((r) => r[1] < estimates[0].rect[1])[0]?.[1],
    bottom = borders.filter((r) => r[1] > estimates[0].baseline).at(-1)?.[1]
  const divider = borders.find((r) => r[1] > estimates[0].baseline)?.[1]
  if (top === undefined || bottom === undefined || divider === bottom) return
  const left = Math.min(crop[0], borders[0][0]),
    right = Math.max(crop[2], borders[0][2])
  const source = tableSourceItems(items, [left, top, right, bottom]),
    body = source.filter((i) => i.rect[1] >= divider)
  const leaves = source.filter((i) => Math.abs(i.baseline - estimates[0].baseline) < height * 0.2)
  const blocks = estimates.map((e, n) => {
    const end = estimates[n + 1]?.rect[0] ?? right
    const line = leaves
      .filter((i) => i.rect[0] >= e.rect[0] && i.rect[0] < end)
      .sort((a, b) => a.rect[0] - b.rect[0])
    const p = line.find((i) => i.text === 'P' || /^P-value$/.test(i.text))
    const ci = line.find((i) => /^95(?:%|$)/.test(i.text))
    return p && ci
      ? {
          e,
          ci: { rect: union(line.filter((i) => i.rect[0] >= ci.rect[0] && i.rect[0] < p.rect[0])) },
          p: { rect: union(line.filter((i) => i.rect[0] >= p.rect[0])) }
        }
      : undefined
  })
  if (blocks.some((b) => !b)) return
  const cuts = [
    left,
    estimates[0].rect[0] - height,
    ...blocks.flatMap((b, n) => [
      (b.e.rect[2] + b.ci.rect[0]) / 2,
      b.p.rect[0] - height * 0.2,
      ...(n + 1 < blocks.length ? [(b.p.rect[2] + blocks[n + 1].e.rect[0]) / 2] : [])
    ]),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  // Tighten each cut to the actual empty gutter across the entire body.
  const assigned = body.map((i) => col(i))
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i, n) => assigned[n] === c - 1),
      b = body.filter((i, n) => assigned[n] === c)
    if (!a.length || !b.length) return
    const x = Math.max(...a.map((i) => i.rect[2])),
      y = Math.min(...b.map((i) => i.rect[0]))
    if (x >= y) return
    cuts[c] = (x + y) / 2
  }
  const anchors = body
    .filter((i) => col(i) === 0 && i.height >= height * 0.8)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const baselines = []
  for (const i of anchors)
    if (!baselines.some((y) => Math.abs(y - i.baseline) < height * 0.3)) baselines.push(i.baseline)
  if (baselines.length < 9) return
  const groups = baselines.map(() => [])
  const units = body.filter((i) => col(i) % 3 !== 2).map((i) => [i])
  for (let c = 2; c < cuts.length - 1; c += 3) {
    let pending = [],
      depth = 0
    for (const i of body
      .filter((i) => col(i) === c)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      pending.push(i)
      depth += (i.text.match(/\(/g) ?? []).length - (i.text.match(/\)/g) ?? []).length
      if (depth < 0 || depth > 1) return
      if (!depth) {
        units.push(pending)
        pending = []
      }
    }
    if (pending.length) return
  }
  for (const unit of units) {
    const baseline =
      (Math.min(...unit.map((i) => i.baseline)) + Math.max(...unit.map((i) => i.baseline))) / 2
    const near = baselines.map((y) => Math.abs(y - baseline)),
      index = near.indexOf(Math.min(...near))
    if (near[index] > height * 1.7) return
    groups[index].push(...unit)
  }
  const values = groups.map((g) =>
    readSourceRow(g, cuts)?.map((value, c) =>
      c % 3 === 2
        ? g
            .filter((i) => col(i) === c)
            .sort((a, b) =>
              Math.abs(a.baseline - b.baseline) < height * 0.3
                ? a.rect[0] - b.rect[0]
                : a.baseline - b.baseline
            )
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
        : value
    )
  )
  const number = (s) => /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)
  let records = 0,
    sections = 0
  for (const v of values) {
    if (!v || !v[0] || !/\p{L}/u.test(v[0])) return
    if (v.slice(1).every((s) => !s)) {
      sections++
      continue
    }
    for (let c = 1; c < v.length; c += 3) {
      const [e, ci, p] = v.slice(c, c + 3)
      if ((e === 'ref' || e === '-') && !ci && !p) continue
      if (!number(e) || !/^\([−+-]?\d+(?:\.\d+)?,[−+-]?\d+(?:\.\d+)?\)$/.test(ci) || !number(p))
        return
    }
    records++
  }
  if (records < 6 || sections < 2) return
  const header = source.filter((i) => i.rect[3] <= divider),
    headerGroups = []
  for (const i of header
    .filter((i) => i.height >= height * 0.8)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = headerGroups.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < height * 0.3) last.push(i)
    else headerGroups.push([i])
  }
  for (const i of header.filter((i) => i.height < height * 0.8)) {
    const matches = headerGroups.filter((g) =>
      g.some(
        (a) =>
          i.rect[0] >= a.rect[2] - 1 &&
          i.rect[0] - a.rect[2] <= height * 0.4 &&
          Math.abs(i.baseline - a.baseline) < height
      )
    )
    if (matches.length !== 1) return
    matches[0].push(i)
  }
  const spans = []
  for (let n = 0; n < headerGroups.length - 1; n++) {
    const g = headerGroups[n].sort((a, b) => a.rect[0] - b.rect[0]),
      parts = []
    for (const i of g) {
      const last = parts.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((t) => t.rect[2])) < height * 2) last.push(i)
      else parts.push([i])
    }
    if (!parts.length || estimates.length % parts.length) return
    const width = (3 * estimates.length) / parts.length
    for (let k = 0; k < parts.length; k++) {
      const bounds = union(parts[k]),
        start = 1 + k * width,
        end = start + width
      if (bounds[0] < cuts[start] || bounds[2] > cuts[end]) return
      spans.push({ row: n, column: start, rowSpan: 1, colSpan: width })
    }
  }
  const bounds = [...headerGroups, ...groups].map(union)
  if (
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) ||
    !hasUniqueRecordTokens(source, [...headerGroups, ...groups])
  )
    return
  for (let n = 0; n < values.length; n++)
    if (values[n].slice(1).every((s) => !s))
      spans.push({ row: headerGroups.length + n, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
  return {
    cropRect: [left, top, right, bottom],
    rows: bounds.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: headerGroups.map((_, n) => n),
    ownedTokens: new Set(source),
    repair: 'repeated-regression-blocks-recovered'
  }
}

// Explicit interval/P headings and complete native baselines establish records
// independently of model rows. A repeated adjustment sequence can additionally
// own a shared outcome label; detached signs remain in their original records.
function recoverLabeledIntervalRows(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![3, 4, 5, 6].includes(predicted.length)) return
  const tolerance = Math.min(40, (crop[2] - crop[0]) * 0.06)
  const borders = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < tolerance &&
        Math.abs(r[2] - crop[2]) < tolerance &&
        r[1] >= crop[1] - 16 &&
        r[1] <= crop[3] + 16
    )
    .filter((r, n, all) => !n || r[1] - all[n - 1][1] > 2)
  if (borders.length !== 3) return
  const frame = [
    Math.min(crop[0], borders[0][0]),
    borders[0][1],
    Math.max(crop[2], borders[0][2]),
    borders[2][1]
  ]
  const source = tableSourceItems(items, frame)
  const header = source.filter((i) => i.rect[3] < borders[1][1])
  const body = source.filter((i) => i.rect[1] > borders[1][1])
  if (
    !header.some((i) => /Estimates?|\d{2}%\s*CI/i.test(i.text)) ||
    (predicted.length !== 3 && !/p[- ]?value/i.test(header.map((i) => i.text).join('')))
  )
    return
  const heights = body.map((i) => i.height).sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  const cuts = [
    frame[0],
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    frame[2]
  ]
  if (predicted.length === 3)
    return (
      recoverNestedIntervalRows(source, header, body, cuts, frame, borders[1][1], height) ??
      recoverTrailingRiskRows(source, header, body, cuts, frame, borders[1][1], height)
    )
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const stub = predicted.length === 4 ? 1 : 0
  const anchorGroups = groupSourceRowsWithScripts(
    body.filter((i) => col(i) === stub && i.height >= height * 0.8 && /\p{L}/u.test(i.text)),
    height,
    0.3
  )
  if (!anchorGroups) return
  const anchors = anchorGroups.map((g) => ({
    ...g[0],
    rect: union(g),
    text: g.map((i) => i.text).join(' ')
  }))
  if (
    anchors.length < 3 ||
    anchors.some((a, n) => n && a.baseline - anchors[n - 1].baseline < height)
  )
    return
  const groups = anchors.map((a) =>
    body.filter(
      (i) =>
        (stub === 0 || col(i) > 0) &&
        (Math.abs(i.baseline - a.baseline) < height * 0.35 ||
          (i.height < height * 0.8 &&
            i.rect[0] >= a.rect[0] &&
            i.rect[0] < a.rect[2] + height * 0.4 &&
            Math.abs(i.baseline - a.baseline) < height * 0.6))
    )
  )
  const parts = cuts.slice(1).map((_, c) => groups.flat().filter((i) => col(i) === c))
  for (let c = stub + 1; c < cuts.length - 1; c++) {
    const end = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      start = Math.min(...parts[c].map((i) => i.rect[0]))
    if (!(end < start)) return
    cuts[c] = (end + start) / 2
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  const interval = /^[−–+-]?\d+(?:\.\d+)?[[(][−–+-]?\d+(?:\.\d+)?;[−–+-]?\d+(?:\.\d+)?[\])][*]*$/
  const probability = /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)[*]*$/
  const summary = predicted.length === 6
  if (summary && !header.some((i) => /Mean/.test(i.text))) return
  if (
    values.some(
      (v) =>
        !v ||
        !v[stub] ||
        (summary && !/^[−–+-]?\d+(?:\.\d+)?±\d+(?:\.\d+)?$/.test(v[1])) ||
        v
          .slice(summary ? 2 : stub + 1)
          .some(
            (s, n) =>
              !(
                (summary && s === '-' && v[n % 2 ? n + 1 : n + 3] === '-') ||
                (n % 2 ? probability : interval).test(s)
              )
          )
    )
  )
    return
  const hierarchy = recoverRuledHeaderBands(header, cuts, rules, frame[1], borders[1][1])
  if (!hierarchy && !readSourceRow(header, cuts, { multiline: true })) return
  const heads = hierarchy?.rows ?? [[frame[0], frame[1], frame[2], borders[1][1]]]
  const spans = [...(hierarchy?.spans ?? [])]
  const labels = []
  if (stub) {
    const starts = anchors.flatMap((a, n) => (/^unadjusted$/i.test(a.text) ? [n] : []))
    if (starts.length < 2 || starts[0] !== 0) return
    const length = starts[1]
    if (
      length < 2 ||
      length > 8 ||
      anchors.length % length ||
      starts.some((n, i) => n !== i * length)
    )
      return
    for (let n = 0; n < anchors.length; n++) {
      if (
        anchors[n].text !== anchors[n % length].text ||
        (n % length && !/^adjusted\s+for\b/i.test(anchors[n].text))
      )
        return
    }
    for (const n of starts) {
      const last = anchors[n + length - 1]
      const label = body.filter(
        (i) =>
          col(i) === 0 &&
          i.rect[1] >= anchors[n].rect[1] - height * 0.3 &&
          i.rect[3] <= last.rect[3] + height * 0.1
      )
      if (
        !label.length ||
        !/\p{L}/u.test(readSourceRow(label, cuts, { multiline: true })?.[0] ?? '')
      )
        return
      labels.push(label)
      spans.push({ row: heads.length + n, column: 0, rowSpan: length, colSpan: 1 })
    }
  }
  if (!hasUniqueRecordTokens(source, [header, ...groups, ...labels])) return
  const rows = groups.map((g) => union(g))
  if (rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  return {
    cropRect: frame,
    rows: [...heads, ...rows.map((r) => [frame[0], r[1], frame[2], r[3]])],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: heads.map((_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Adjusted/unadjusted interval columns can share one detector band across a
// dash-only parent and its indented categories. All native intervals must be
// complete; the shared header/rules and empty gutter establish their ownership.
function recoverNestedIntervalRows(source, header, body, cuts, frame, headerBottom, height) {
  const heading = readSourceRow(header, cuts, { multiline: true })
  if (
    !heading ||
    !/^(?:Unadjusted|Univariate)(?:OR|HR|RR)\[95%CI\]$/i.test(heading[1]) ||
    !/^(?:Adjusted|Multivariate)(?:OR|HR|RR)\[95%CI\]$/i.test(heading[2])
  )
    return
  const lines = groupSourceRowsWithScripts(body, height, 0.35)
  if (!lines || lines.length < 6) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const stub = body.filter((i) => col(i) === 0),
    first = body.filter((i) => col(i) === 1)
  const end = Math.max(...stub.map((i) => i.rect[2])),
    start = Math.min(...first.map((i) => i.rect[0]))
  if (!(end < start) || end - cuts[1] > height * 2) return
  if (end > cuts[1]) cuts[1] = (end + start) / 2
  const values = lines.map((g) => readSourceRow(g, cuts))
  const interval = (s) =>
    /^[−+-]?\d+(?:\.\d+)?\[[−+-]?\d+(?:\.\d+)?[,;][−+-]?\d+(?:\.\d+)?\][*†‡]*$/.test(s)
  const dash = (s) => /^[–—−-]$/.test(s)
  if (
    values.some(
      (v) => !v || !/\p{L}/u.test(v[0]) || !v.slice(1).every((s) => interval(s) || dash(s))
    )
  )
    return
  const parents = values.flatMap((v, n) => (v.slice(1).every(dash) ? [n] : []))
  if (!parents.length || values.filter((v) => interval(v[1])).length < 6) return
  for (const n of parents) {
    const x = Math.min(...lines[n].filter((i) => col(i) === 0).map((i) => i.rect[0]))
    const children = lines.slice(n + 1, parents.find((p) => p > n) ?? lines.length)
    if (
      children.length < 2 ||
      children.some(
        (g) => Math.min(...g.filter((i) => col(i) === 0).map((i) => i.rect[0])) - x < height * 0.4
      )
    )
      return
  }
  const bounds = lines.map(union)
  if (
    bounds.some((r, n) => n && r[1] <= bounds[n - 1][3]) ||
    !hasUniqueRecordTokens(source, [header, ...lines])
  )
    return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], headerBottom],
      ...bounds.map((r) => [frame[0], r[1], frame[2], r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// In compact risk tables, each estimate/CI pair is aligned with the final
// line of its wrapped label. Native rules close the table; complete pairs and
// outdented reference-category sections partition all source lines uniquely.
function recoverTrailingRiskRows(source, header, body, cuts, frame, headerBottom, height) {
  const headings = readSourceRow(header, cuts)
  if (!headings || !/^(?:RH|HR|RR|OR)$/.test(headings[1]) || !/^95%CI\*?$/.test(headings[2])) return
  const lines = groupSourceRowsWithScripts(body, height, 0.3)
  if (!lines || lines.length < 8) return
  const values = lines.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v || !v[0])) return
  const risk = /^\d+(?:\.\d+)?$/
  const interval = /^(?:Ref\.?|\d+(?:\.\d+)?[−–-]\d+(?:\.\d+)?[*†‡§]*)$/i
  const complete = (v) => v && risk.test(v[1]) && interval.test(v[2])
  const stubLeft = (g) => Math.min(...g.filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0]))
  const left = Math.min(...lines.map(stubLeft))
  const groups = [],
    spans = []
  let pending = [],
    wrapped = 0,
    references = 0,
    records = 0
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n],
      v = values[n],
      next = values[n + 1]
    if (pending.length && line[0].baseline - pending.at(-1)[0].baseline > height * 1.65) return
    if (complete(v)) {
      if (pending.length > 3) return
      if (pending.length) wrapped++
      references += /^Ref\.?$/i.test(v[2]) ? 1 : 0
      records++
      groups.push([...pending.flat(), ...line])
      pending = []
    } else if (!v[1] && !v[2]) {
      const indent = lines[n + 1] ? stubLeft(lines[n + 1]) - stubLeft(line) : 0
      if (
        !pending.length &&
        complete(next) &&
        /^Ref\.?$/i.test(next[2]) &&
        Number(next[1]) === 1 &&
        /^[\p{L}\s/-]+$/u.test(line.map((i) => i.text).join(' ')) &&
        Math.abs(stubLeft(line) - left) < height * 0.3 &&
        indent > height * 0.6 &&
        indent < height * 1.4
      ) {
        spans.push({ row: groups.length + 1, column: 0, rowSpan: 1, colSpan: 3 })
        groups.push(line)
      } else pending.push(line)
    } else return
  }
  if (
    pending.length ||
    wrapped < 3 ||
    records < 6 ||
    !references ||
    !hasUniqueRecordTokens(source, [header, ...groups])
  )
    return
  const rows = groups.map((g) => union(g))
  if (rows.some((r, n) => n && r[1] <= rows[n - 1][3])) return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], headerBottom],
      ...rows.map((r) => [frame[0], r[1], frame[2], r[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Coefficient/CI, P and ratio/CI blocks use explicit zero/one reference rows.
// Blank P cells are source omissions, not missing records or values to fill.
function recoverRepeatedEffectRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 7 || columns.length > 13 || (columns.length - 1) % 3) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - left) < 16 &&
        Math.abs(r[2] - right) < 16 &&
        r[1] >= top - 2 &&
        r[1] <= bottom + 16
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length !== 3) return
  const source = tableSourceItems(items, [left, top, right, full[2][1]])
  const body = source.filter((i) => i.rect[1] > full[1][1]),
    header = source.filter((i) => !body.includes(i))
  const height = body[0]?.height,
    groups = groupSourceRowsWithScripts(body, height, 0.3),
    heads = groupSourceRowsWithScripts(header, height, 0.3)
  if (!groups || groups.length < 6 || !heads || heads.length !== 3) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parts = cuts.slice(1).map((_, c) => body.filter((i) => col(i) === c))
  if (parts.some((g) => !g.length)) return
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      b = Math.min(...parts[c].map((i) => i.rect[0]))
    if (a >= b) return
    cuts[c] = (a + b) / 2
  }
  const leaves = readSourceRow(heads[2], cuts)
  if (
    !leaves ||
    leaves[0] ||
    !leaves
      .slice(1)
      .every((v, n) =>
        [/^(?:β|B|Coef\.?)\(\d{2}%CI\)$/i, /^P[- ]?value$/i, /^(?:OR|HR|RR)\(\d{2}%CI\)$/i][
          n % 3
        ].test(v)
      )
  )
    return
  const interval = (s) =>
    /^[−–+-]?(?:\d+(?:\.\d+)?|\.\d+)\([−–+-]?(?:\d+(?:\.\d+)?|\.\d+),[−–+-]?(?:\d+(?:\.\d+)?|\.\d+)\)$/.test(
      s
    )
  const probability = (s) => /^[<≤>]?(?:0?\.\d+|1(?:\.0+)?)$/.test(s)
  let references = 0,
    records = 0
  for (const g of groups) {
    const v = readSourceRow(g, cuts)
    if (!v || !/^\p{L}/u.test(v[0])) return
    let reference = true
    for (let c = 1; c < v.length; c += 3) {
      const [a, p, b] = v.slice(c, c + 3)
      if (a === '0' && !p && b === '1') continue
      if (!interval(a) || !probability(p) || !interval(b)) return
      reference = false
    }
    if (reference) references++
    else records++
  }
  if (records < 4 || references < 1) return
  const count = (columns.length - 1) / 3
  if (heads[0].length !== 1 || heads[1].length !== count) return
  const parents = [...heads[1]].sort((a, b) => a.rect[0] - b.rect[0])
  const underlined = (group, a, b) => {
    const r = union(group)
    return (
      r[0] >= cuts[a] &&
      r[2] <= cuts[b] &&
      rules.some(
        (line) =>
          line[1] === line[3] &&
          line[1] > r[3] &&
          line[1] - r[3] < height &&
          line[0] <= r[0] &&
          line[2] >= r[2]
      )
    )
  }
  if (
    !underlined(heads[0], 1, columns.length) ||
    parents.some((p, n) => !underlined([p], 1 + n * 3, 4 + n * 3)) ||
    !hasUniqueRecordTokens(source, [...heads, ...groups])
  )
    return
  const rects = [...heads, ...groups].map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    cropRect: [left, top, right, full[2][1]],
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, full[2][1]]),
    headerRows: [0, 1, 2],
    spans: [
      { row: 0, column: 1, rowSpan: 1, colSpan: columns.length - 1 },
      ...parents.map((_, n) => ({ row: 1, column: 1 + n * 3, rowSpan: 1, colSpan: 3 }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Paired P/HR columns contain complete reference and interval records below
// outdented factor labels. The source header and footer bound this sparse grid.
function recoverPairedRiskGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
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
  const source = tableSourceItems(items, table.cropRect)
  const title = source.find((i) => i.text === 'HR (CI)')
  if (
    !title ||
    !source.some((i) => i.text === 'Univariable') ||
    !source.some((i) => i.text === 'Multivariable')
  )
    return
  const divider = rules
    .filter(
      (r) => r[1] === r[3] && r[1] > title.baseline && r[1] - title.baseline < title.height * 3
    )
    .sort((a, b) => a[1] - b[1])[0]?.[1]
  const footer = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[1] > divider && r[1] <= bottom && r[0] < left + 15 && r[2] > right - 15
    )
    .sort((a, b) => b[1] - a[1])[0]?.[1]
  if (divider === undefined || footer === undefined) return
  const header = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider && i.rect[3] < footer)
  const groups = groupSourceRowsWithScripts(body, title.height, 0.35)
  if (!groups) return
  const number = (s) => /^0?\.\d+$/.test(s),
    risk = (s) => /^(?:—|\d+(?:\.\d+)?\((?:ref|\d+(?:\.\d+)?[–−-]\d+(?:\.\d+)?)\))$/.test(s)
  let records = 0,
    sections = 0
  const spans = []
  for (const [n, g] of groups.entries()) {
    const v = readSourceRow(g, cuts)
    if (!v || !v[0]) return
    if (v.slice(1).every((s) => !s)) {
      if (!/\p{L}/u.test(v[0])) return
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 5 })
      sections++
    } else {
      if (
        ![1, 3].every((c) => !v[c] || number(v[c]) || v[c] === '—') ||
        ![2, 4].every((c) => risk(v[c]))
      )
        return
      records++
    }
  }
  if (records < 15 || sections < 6) return
  return {
    cropRect: table.cropRect,
    rows: [union(header), ...groups.map(union)].map((r) => [left, r[1], right, r[3]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true,
    headerRows: [0],
    ownedTokens: new Set([...header, ...body])
  }
}

// Repeated coefficients and standard errors establish alternating source rows.
// Keep the two baselines and span only their shared label; do not infer missing
// values or allow a model span to join labels from different regressions.
function recoverPairedCoefficientRows(table, items, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  if (
    !captions.some(
      (c) => captionKind(c.lines[0]) === 'table' && c.rect[3] <= top && top - c.rect[3] < 60
    )
  )
    return
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length === 7) return recoverGroupedCoefficientRows(table, items, rules, columns)
  if (columns.length !== 5) return
  const full = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] >= left - 16 &&
      r[0] <= left + 16 &&
      r[2] >= right - 16 &&
      r[2] <= right + 16
  )
  const footer = full.filter((r) => Math.abs(r[1] - bottom) < 16).sort((a, b) => b[1] - a[1])[0]
  if (!footer || !full.some((r) => Math.abs(r[1] - top) < 16)) return
  const source = tableSourceItems(items, [left, top, right, Math.min(bottom, footer[1])])
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 10) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (c.rect[0] + columns[n].rect[2]) / 2),
    right
  ]
  const parts = cuts.slice(1).map(() => [])
  for (const i of source) {
    const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (c < 0) return
    parts[c].push(i)
  }
  if (parts.some((g) => !g.length)) return
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      b = Math.min(...parts[c].map((i) => i.rect[0]))
    if (a >= b) return
    cuts[c] = Math.max(a + 0.01, Math.min(b - 0.01, cuts[c]))
  }
  const values = groups.map((g) => readSourceRow(g, cuts))
  if (values.some((v) => !v) || values[0][0] || values[0].slice(1).some((v) => !/\p{L}/u.test(v)))
    return
  const scalar = /^[−–+-]?\d+(?:\.\d+)?\*{0,3}$/
  const deviation = /^\(\d+(?:\.\d+)?\)$/
  const spans = []
  let pairs = 0
  for (let n = 1; n < values.length; n++) {
    const row = values[n]
    if (!row[0] || row.slice(1).some((v) => !scalar.test(v))) return
    const next = values[n + 1]
    if (next && !next[0] && next.slice(1).every((v) => deviation.test(v))) {
      if (
        union(groups[n])[3] >= union(groups[n + 1])[1] ||
        union(groups[n + 1])[1] - union(groups[n])[3] > height
      )
        return
      spans.push({ row: n, column: 0, rowSpan: 2, colSpan: 1 })
      pairs++
      n++
    } else if (n !== values.length - 1 || !/^P-value[: ]/i.test(groups[n][0].text)) return
  }
  if (pairs < 4 || !hasUniqueRecordTokens(source, groups)) return
  return {
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    cropRect: [...table.cropRect],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Three paired regressions may repeat under separate outcome headings. Native
// coefficient/error baselines, six numbered leaves and aligned parent captions
// establish the hierarchy without borrowing model row or span predictions.
function recoverGroupedCoefficientRows(table, items, rules, columns) {
  const [left, top, right, bottom] = table.cropRect
  const borders = rules.filter(
    (r) => r[1] === r[3] && Math.abs(r[0] - left) < 16 && Math.abs(r[2] - right) < 16
  )
  const footer = borders.filter((r) => Math.abs(r[1] - bottom) < 16).sort((a, b) => b[1] - a[1])[0]
  if (!footer || !borders.some((r) => Math.abs(r[1] - top) < 16)) return
  const source = tableSourceItems(items, [left, top, right, Math.min(bottom, footer[1])])
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 10) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (c.rect[0] + columns[n].rect[2]) / 2),
    right
  ]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const scalar = /^[−–+-]?\d+(?:\.\d+)?\*{0,3}$/
  const deviation = /^\(\d+(?:\.\d+)?\)$/
  const parent = (g) =>
    g.length === 3 &&
    g.every((i) => /\p{L}/u.test(i.text) && !/\d/.test(i.text) && i.rect[0] > cuts[1])
  const section = (g) =>
    g.length === 1 &&
    /\p{L}/u.test(g[0].text) &&
    g[0].rect[0] > cuts[1] &&
    Math.abs((g[0].rect[0] + g[0].rect[2] - left - right) / 2) < height * 2
  const body = groups.filter((g) => !parent(g) && !section(g)).flat()
  const parts = cuts.slice(1).map((_, c) => body.filter((i) => col(i) === c))
  if (parts.some((g) => !g.length)) return
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      b = Math.min(...parts[c].map((i) => i.rect[0]))
    if (a >= b) return
    cuts[c] = Math.max(a + 0.01, Math.min(b - 0.01, cuts[c]))
  }
  const spans = [],
    headerRows = []
  let pairs = 0,
    parents = 0,
    firstRecord = -1,
    metadata = false
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n]
    if (parent(g)) {
      const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !ordered.every(
          (i, c) =>
            i.rect[0] >= cuts[1 + c * 2] &&
            i.rect[2] <= cuts[3 + c * 2] &&
            Math.abs((i.rect[0] + i.rect[2] - cuts[1 + c * 2] - cuts[3 + c * 2]) / 2) < height * 2
        )
      )
        return
      for (let c = 1; c < 7; c += 2) spans.push({ row: n, column: c, rowSpan: 1, colSpan: 2 })
      parents++
      if (firstRecord < 0) headerRows.push(n)
      metadata = false
      continue
    }
    if (section(g)) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 7 })
      if (firstRecord < 0) headerRows.push(n)
      continue
    }
    const v = readSourceRow(g, cuts)
    if (!v) return
    if (
      !v[0] &&
      v
        .slice(1)
        .every(
          (x, c) => /^\(\d+\)$/.test(x) && Number(x.slice(1, -1)) === Number(v[1].slice(1, -1)) + c
        )
    ) {
      if (firstRecord < 0) headerRows.push(n)
      continue
    }
    if (/^(?:Covariates|Observations|P-valueofjoint(?:hyp\.?test|hyp\.test))$/.test(v[0])) {
      if (pairs < 3 || !v.slice(1).every((x) => /^(?:Yes|No|[\d,.]+)$/.test(x))) return
      metadata = true
      continue
    }
    if (metadata || !v[0] || !v.slice(1).every((x) => scalar.test(x))) return
    const next = groups[n + 1] && readSourceRow(groups[n + 1], cuts)
    // Some source tables omit the final standard-error row. Preserve that
    // omission when the following native line is the joint test, never invent it.
    if (
      pairs >= 3 &&
      next &&
      /^P-valueofjointhyp\.?test$/.test(next[0]) &&
      next.slice(1).every((x) => scalar.test(x))
    ) {
      if (firstRecord < 0) firstRecord = n
      continue
    }
    if (
      !next ||
      next[0] ||
      !next.slice(1).every((x) => deviation.test(x)) ||
      union(g)[3] >= union(groups[n + 1])[1] ||
      union(groups[n + 1])[1] - union(g)[3] > height
    )
      return
    if (firstRecord < 0) firstRecord = n
    spans.push({ row: n, column: 0, rowSpan: 2, colSpan: 1 })
    pairs++
    n++
  }
  if (pairs < 3 || !parents || !metadata || !hasUniqueRecordTokens(source, groups)) return
  return {
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    cropRect: [...table.cropRect],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows,
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Reference-category section labels precede aligned coefficient/SE records.
// Optional repeated Coef./SE headings and centered model summaries share the
// same paired-column geometry; model row predictions are not needed here.
function recoverInlineCoefficientSections(table, items, rules) {
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![3, 7].includes(columns.length)) return
  const full = rules.filter(
    (r) => r[1] === r[3] && Math.abs(r[0] - left) < 20 && Math.abs(r[2] - right) < 35
  )
  const footer = full.filter((r) => Math.abs(r[1] - bottom) < 20).sort((a, b) => a[1] - b[1])[0]
  if (!footer || !full.some((r) => Math.abs(r[1] - top) < 20)) return
  const source = tableSourceItems(items, [left, top, right, footer[1]])
  const refs = source.filter((i) => /\(ref:/.test(i.text))
  if (refs.length < (columns.length === 3 ? 3 : 1)) return
  const height = refs[0].height
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups || groups.length < 12) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (c.rect[0] + columns[n].rect[2]) / 2),
    right
  ]
  const pairs = (columns.length - 1) / 2
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const parent = (g) =>
    pairs > 1 &&
    g.length === pairs &&
    g.every((i) => /\p{L}/u.test(i.text) && i.rect[0] > cuts[1] && !/\d/.test(i.text))
  const section = (g) => g.length === 1 && g[0].rect[0] < cuts[1] && /\p{L}/u.test(g[0].text)
  const metadata = (g) => /^(?:Covariates|Observations|(?:Pseudo )?R-squared)$/.test(g[0].text)
  const body = groups.filter((g) => !parent(g) && !section(g) && !metadata(g)).flat()
  const parts = cuts.slice(1).map((_, c) => body.filter((i) => col(i) === c))
  if (parts.some((g) => !g.length)) return
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = Math.max(...parts[c - 1].map((i) => i.rect[2])),
      b = Math.min(...parts[c].map((i) => i.rect[0]))
    if (a >= b) return
    cuts[c] = Math.max(a + 0.01, Math.min(b - 0.01, cuts[c]))
  }
  const spans = [],
    headerRows = []
  let records = 0,
    headings = 0
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n]
    if (parent(g)) {
      const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0])
      if (!ordered.every((i, c) => i.rect[0] >= cuts[1 + c * 2] && i.rect[2] <= cuts[3 + c * 2]))
        return
      for (let c = 1; c < columns.length; c += 2)
        spans.push({ row: n, column: c, rowSpan: 1, colSpan: 2 })
      if (!records) headerRows.push(n)
      continue
    }
    if (section(g)) {
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: columns.length })
      continue
    }
    if (metadata(g)) {
      if (
        records < 10 ||
        g.length !== pairs + 1 ||
        !g.slice(1).every((i) => /^(?:Yes|No|[\d.,]+)$/.test(i.text))
      )
        return
      const ordered = [...g.slice(1)].sort((a, b) => a.rect[0] - b.rect[0])
      if (!ordered.every((i, c) => i.rect[0] >= cuts[1 + c * 2] && i.rect[2] <= cuts[3 + c * 2]))
        return
      for (let c = 1; c < columns.length; c += 2)
        spans.push({ row: n, column: c, rowSpan: 1, colSpan: 2 })
      continue
    }
    const v = readSourceRow(g, cuts)
    if (!v) return
    if (!v[0] && v.slice(1).every((x, c) => x === (c % 2 ? 'SE' : 'Coef.'))) {
      headings++
      headerRows.push(n)
      continue
    }
    // An explicitly printed zero row without a stub remains blank in output.
    if (!v[0] && !v.slice(1).every((x, c) => x === (c % 2 ? '(0.000)' : '0.000'))) return
    if (
      !v
        .slice(1)
        .every((x, c) => (c % 2 ? /^\(\d+(?:\.\d+)?\)$/ : /^[−–+-]?\d+(?:\.\d+)?\*{0,3}$/).test(x))
    )
      return
    records++
  }
  if (records < 10 || (pairs > 1 && headings !== 1) || !hasUniqueRecordTokens(source, groups))
    return
  return {
    cropRect: [left, top, right, footer[1]],
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, footer[1]]),
    headerRows,
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Categorical regression summaries put a section-level P beside an outdented
// label; indented levels contain an estimate/interval and a ratio or reference.
function recoverCategoricalRiskRecords(table, items, predicted) {
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  const groups = groupSourceRowsWithScripts(
    [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    height,
    0.35
  )
  if (!groups || groups.length < 10) return
  const header = readSourceRow(groups[0], cuts)
  if (
    !header ||
    !/95%CI/.test(header[1]) ||
    !/(?:OR|HR|RR).*95%CI/.test(header[2]) ||
    !/^P[*†‡]?$/i.test(header[3])
  )
    return
  const interval = (s) =>
    /^[−-]?\d+(?:\.\d+)?\([−-]?\d+(?:\.\d+)?[–−-][−-]?\d+(?:\.\d+)?\)$/.test(s)
  let sections = 0,
    records = 0,
    refs = 0,
    sectionLeft
  const spans = []
  for (let n = 1; n < groups.length; n++) {
    const g = groups[n],
      v = readSourceRow(g, cuts)
    if (!v || !v[0]) return
    if (!v[1] && !v[2] && /^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[3]) && /\p{L}/u.test(v[0])) {
      sections++
      sectionLeft = Math.min(...g.filter((i) => i.rect[0] < cuts[1]).map((i) => i.rect[0]))
      spans.push({ row: n, column: 0, rowSpan: 1, colSpan: 3 })
    } else if (
      sectionLeft !== undefined &&
      interval(v[1]) &&
      (interval(v[2]) || /^Ref(?:erent)?$/i.test(v[2])) &&
      ((!v[3] &&
        g
          .filter((i) => i.rect[0] < cuts[1])
          .every((i) => i.rect[0] - sectionLeft >= height * 0.5)) ||
        (/^[<>≤≥]?(?:0?\.\d+|1(?:\.0+)?)$/.test(v[3]) &&
          g.filter((i) => i.rect[0] < cuts[1]).every((i) => Math.abs(i.rect[0] - sectionLeft) < 1)))
    ) {
      records++
      if (/^Ref/i.test(v[2])) refs++
    } else return
  }
  if (sections < 3 || records < 8 || refs < 2 || !hasUniqueRecordTokens(source, groups)) return
  return {
    rows: groups.map((g) => {
      const r = union(g)
      return [left, r[1], right, r[3]]
    }),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    completeSpans: true
  }
}
