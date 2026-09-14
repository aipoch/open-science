/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Paired univariable/multivariable summaries share coefficient, interval, R²
// and P-value headings. Recover native records, retaining intentionally blank
// model-summary values instead of filling them down.
export function recoverRegressionGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
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

// Repeated Estimate / CI / P blocks establish their own columns independently
// of the detector. Higher headings must partition those same blocks evenly;
// every native token, including reference rows and wrapped CIs, keeps one owner.
export function recoverRepeatedRegressionGrid(table, items, captions, rules) {
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
