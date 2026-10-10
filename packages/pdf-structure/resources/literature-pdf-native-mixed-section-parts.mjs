/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { nativeMeasuredWordTokens } from './literature-pdf-native-scalar-record-grid.mjs'
import { populateTableCellText } from './literature-pdf-table-cell-text.mjs'

const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const normal = (i, h) => Math.abs(i.height - h) < h * 0.04
const literal = (items) =>
  items
    .map((i) => i.text)
    .join('')
    .replace(/\s/gu, '')
const number = (s) => /^[−+-]?\d+(?:\.\d+)?(?:\(\d+\))?$/.test(s)

function sourceRows(items, h) {
  const rows = []
  for (const i of items
    .filter((i) => normal(i, h))
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const r = rows.at(-1)
    if (r && Math.abs(r[0].baseline - i.baseline) < h * 0.03) r.push(i)
    else rows.push([i])
  }
  if (rows.length < 4 || rows.length > 16) return
  for (const i of items.filter((i) => !normal(i, h))) {
    const owner = rows.filter((r) => Math.abs(r[0].baseline - i.baseline) < h * 0.5)
    if (owner.length !== 1 || i.height < h * 0.55 || i.height > h * 0.8) return
    owner[0].push(i)
  }
  if (!hasUniqueRecordTokens(items, rows)) return
  return rows
}

function continuousSeparator(rules, divider, closing, h, body) {
  const vertical = rules.filter(
    (r) =>
      Math.abs(r[0] - r[2]) < 0.02 &&
      r[1] >= divider[1] - 0.05 * h &&
      r[3] <= closing[1] + 0.05 * h &&
      r[3] > r[1]
  )
  const xs = [...new Set(vertical.map((r) => Math.round(r[0] * 100) / 100))]
  const candidates = []
  for (const x of xs) {
    const segments = vertical.filter((r) => Math.abs(r[0] - x) < 0.02).sort((a, b) => a[1] - b[1])
    if (
      segments.length < 4 ||
      segments[0][1] - divider[1] > h * 0.05 ||
      closing[1] - segments.at(-1)[3] > h * 0.3 ||
      segments[0][1] >= Math.min(...body.map((i) => i.baseline)) ||
      segments.at(-1)[3] < Math.max(...body.map((i) => i.rect[3]))
    )
      continue
    let end = segments[0][3],
      complete = true
    for (const r of segments.slice(1)) {
      if (r[1] - end > h * 0.05) {
        complete = false
        break
      }
      end = Math.max(end, r[3])
    }
    if (complete) candidates.push(segments[0][0])
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function commonCuts(fields, left, right, h) {
  const cuts = [left]
  for (let k = 1; k < fields[0].length; k++) {
    const a = Math.max(...fields.flatMap((r) => r[k - 1]).map((i) => i.rect[2])),
      b = Math.min(...fields.flatMap((r) => r[k]).map((i) => i.rect[0]))
    if (b - a < h * 0.1) return
    cuts.push((a + b) / 2)
  }
  cuts.push(right)
  return fields.every((r) =>
    r.every((lane, n) => lane.every((i) => i.rect[0] >= cuts[n] && i.rect[2] <= cuts[n + 1]))
  )
    ? cuts
    : undefined
}

function leftFields(rows, left, right, h) {
  const boundaries = [...new Set(rows.flat().flatMap((i) => [i.rect[0], i.rect[2]]))].sort(
    (a, b) => a - b
  )
  const valid = []
  for (let n = 1; n < boundaries.length; n++) {
    const lo = boundaries[n - 1],
      hi = boundaries[n]
    if (hi - lo < h * 0.1) continue
    const cut = (lo + hi) / 2
    const fields = rows.map((r) => [
      r.filter((i) => i.rect[2] <= cut),
      r.filter((i) => i.rect[0] >= cut)
    ])
    if (
      fields.some(
        (r, n) =>
          r.some((l) => !l.length) ||
          !hasUniqueRecordTokens(rows[n], r) ||
          !/[\p{L}]/u.test(literal(r[0])) ||
          !/[\d]/u.test(literal(r[1]))
      )
    )
      continue
    const cuts = commonCuts(fields, left, right, h)
    if (cuts && !valid.some((v) => Math.abs(v.cuts[1] - cuts[1]) < 0.01))
      valid.push({ fields, cuts })
  }
  return valid.length === 1 ? valid[0] : undefined
}

function rightFields(rows, left, right, h, rules) {
  const header = rows[0],
    leaf = header
      .filter((i) => normal(i, h) && /^\p{L}+$/u.test(i.text.trim()))
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (leaf.length !== 7) return
  const rough = [left, ...leaf.slice(1).map((i, n) => (leaf[n].rect[2] + i.rect[0]) / 2), right]
  const fields = rows.map((row) =>
    rough
      .slice(1)
      .map((x, n) =>
        row.filter(
          (i) => (i.rect[0] + i.rect[2]) / 2 >= rough[n] && (i.rect[0] + i.rect[2]) / 2 < x
        )
      )
  )
  if (fields.some((row, n) => row.some((l) => !l.length) || !hasUniqueRecordTokens(rows[n], row)))
    return
  const fractions = []
  for (let n = 1; n < fields.length; n++) {
    const row = fields[n]
    if (!/^[\p{L}]+\d+$/u.test(literal(row[0])) || !/^\d+\p{L}+$/u.test(literal(row[1]))) return
    for (let k = 2; k < 7; k++) {
      const lane = row[k]
      if (lane.every((i) => normal(i, h)) && number(literal(lane))) continue
      const ordered = [...lane].sort((a, b) => a.baseline - b.baseline)
      if (ordered.length !== 2 || ordered.some((i) => normal(i, h) || !/^\d+$/.test(i.text.trim())))
        return
      const upper = ordered[0],
        lower = ordered[1]
      const bars = rules.filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > upper.baseline &&
          r[1] < lower.baseline &&
          r[0] <= Math.min(upper.rect[0], lower.rect[0]) + 0.05 * h &&
          r[2] >= Math.max(upper.rect[2], lower.rect[2]) - 0.05 * h &&
          r[2] - r[0] < h
      )
      if (
        bars.length !== 1 ||
        Math.abs(upper.rect[0] + upper.rect[2] - (lower.rect[0] + lower.rect[2])) > h * 0.1
      )
        return
      fractions.push({ row: n, column: k, upper, lower })
    }
  }
  const cuts = commonCuts(fields, left, right, h)
  return cuts ? { fields, cuts, fractions } : undefined
}

function makePart(fields, cuts, h, rules, headerRows, title, fractions = []) {
  const bands = fields.map((r) => r.flat()),
    edges = [box(bands[0])[1]]
  for (let n = 1; n < bands.length; n++) {
    const prior = box(bands[n - 1]),
      current = box(bands[n])
    if (current[1] <= prior[3]) return
    edges.push((prior[3] + current[1]) / 2)
  }
  edges.push(box(bands.at(-1))[3])
  const rows = edges
      .slice(1)
      .map((b, n) => ({ rect: [cuts[0], edges[n], cuts.at(-1), b], origin: 'source-record' })),
    columns = cuts.slice(1).map((r, n) => [cuts[n], edges[0], r, edges.at(-1)])
  const cells = fields.flatMap((row, n) =>
    row.map((_lane, k) => ({
      row: n,
      column: k,
      rowSpan: 1,
      colSpan: 1,
      header: headerRows.includes(n),
      rect: [cuts[k], edges[n], cuts[k + 1], edges[n + 1]],
      items: []
    }))
  )
  const items = bands.flat(),
    issues = new Set(),
    repairs = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects: columns,
    headerRows,
    rules,
    bottom: edges.at(-1),
    recordGrid: { completeSpans: true, ownedTokens: new Set(items) },
    issues,
    repairs
  })
  if (
    unassigned.length ||
    cells.some(
      (c) =>
        c.sourceRects.length !== fields[c.row][c.column].length ||
        c.sourceRects.some((rect) => !fields[c.row][c.column].some((i) => i.rect === rect))
    )
  )
    return
  for (const f of fractions) {
    const cell = cells.find((c) => c.row === f.row && c.column === f.column)
    cell.text = f.upper.text + f.lower.text
    cell.textRuns = [
      { text: f.upper.text, position: 'superscript' },
      { text: f.lower.text, position: 'subscript' }
    ]
  }
  return {
    title,
    grid: fields.map((row, n) =>
      row.map((_l, k) => cells.find((c) => c.row === n && c.column === k).text)
    ),
    cells,
    unassigned: [],
    issues: [...issues],
    notes: []
  }
}

// Different source schemas in adjoining faces must remain separate parts.
// Native full-width title bands and a continuously drawn separator identify
// each pair; every literal field and measured TJ partition has a unique owner.
export function recoverNativeMixedSectionParts(table, items, captions, rules, observations = []) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    )
  if (!near.length) return
  const h = near.map((i) => i.height).sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - h * 0.2 &&
        r[1] <= crop[3] + h * 0.2 &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  const count = (full.length - 2) / 3
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    count > 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  if (Math.abs(full.at(-1)[1] - full.at(-2)[1] - (full[1][1] - full[0][1])) > 0.02) return
  const captionsNear = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= full[0][1] &&
      full[0][1] - c.rect[3] < h * 8 &&
      c.rect[0] < full[0][2] &&
      c.rect[2] > full[0][0]
  )
  if (captionsNear.length !== 1) return
  const original = items.filter(
    (i) =>
      i.text?.trim() &&
      (i.rect[0] + i.rect[2]) / 2 >= full[0][0] &&
      (i.rect[0] + i.rect[2]) / 2 <= full[0][2] &&
      i.baseline > full[0][1] &&
      i.baseline < full.at(-1)[1]
  )
  // Baseline tests identify records, but cannot account for foreign font
  // boxes that cross the native frame from outside it.
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < full[0][2] &&
        i.rect[2] > full[0][0] &&
        i.rect[1] < full.at(-1)[1] &&
        i.rect[3] > full[0][1] &&
        !original.includes(i)
    )
  )
    return
  if (
    original.some(
      (i) =>
        i.horizontal === false ||
        ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
        i.height < h * 0.55 ||
        i.height > h * 1.04 ||
        i.rect[0] < Math.max(crop[0], full[0][0] - h * 0.3) ||
        i.rect[2] > Math.min(crop[2], full[0][2] + h * 0.3)
    )
  )
    return
  if (
    near.some(
      (i) => i.baseline > full[0][1] && i.baseline < full.at(-1)[1] && !original.includes(i)
    )
  )
    return
  const projected = original.flatMap((i) => nativeMeasuredWordTokens(i, observations, h)),
    parts = [],
    owners = [],
    titles = []
  for (let n = 0; n < count; n++) {
    const opening = full[3 * n],
      inner = full[3 * n + 1],
      divider = full[3 * n + 2],
      closing = full[3 * n + 3]
    if (
      inner[1] - opening[1] < h * 0.1 ||
      inner[1] - opening[1] > h * 0.3 ||
      Math.abs(inner[1] - opening[1] - (full[1][1] - full[0][1])) > 0.02
    )
      return
    const title = projected.filter((i) => i.baseline > inner[1] && i.baseline < divider[1]),
      body = projected.filter((i) => i.baseline > divider[1] && i.baseline < closing[1])
    if (
      !title.length ||
      title.some((i) => !normal(i, h) || Math.abs(i.baseline - title[0].baseline) > h * 0.03) ||
      !body.length ||
      box(title)[3] >= box(body)[1]
    )
      return
    const split = continuousSeparator(rules, divider, closing, h, body)
    if (split === undefined || split - opening[0] < h * 10 || opening[2] - split < h * 20) return
    const left = body.filter((i) => i.rect[2] <= split),
      right = body.filter((i) => i.rect[0] >= split)
    if (!hasUniqueRecordTokens(body, [left, right])) return
    const a = sourceRows(left, h),
      b = sourceRows(right, h)
    if (
      !a ||
      !b ||
      a.length < 6 ||
      Math.abs(a[0][0].baseline - b[0][0].baseline) > h * 0.03 ||
      Math.abs(a.length - b.length) > 1
    )
      return
    const lp = leftFields(a, Math.min(opening[0], ...left.map((i) => i.rect[0])), split, h),
      rp = rightFields(b, split, Math.max(opening[2], ...right.map((i) => i.rect[2])), h, rules)
    if (!lp || !rp) return
    const titleSource = original
      .filter((i) => i.baseline > inner[1] && i.baseline < divider[1])
      .sort((a, b) => a.rect[0] - b.rect[0])
    const titleText = titleSource
      .map(
        (i, k) =>
          (k && i.rect[0] - titleSource[k - 1].rect[2] > h * 0.15 ? ' ' : '') + i.text.trim()
      )
      .join('')
    const l = makePart(lp.fields, lp.cuts, h, rules, [], titleText),
      r = makePart(rp.fields, rp.cuts, h, rules, [0], titleText, rp.fractions)
    if (!l || !r) return
    parts.push(l, r)
    owners.push(...left, ...right)
    titles.push(...title)
  }
  if (
    !hasUniqueRecordTokens(projected, [owners, titles]) ||
    projected.length !== owners.length + titles.length
  )
    return
  const bounds = box(projected)
  const cropRect = [
    Math.min(full[0][0], bounds[0]) - 0.5,
    full[0][1] - 0.5,
    Math.max(full[0][2], bounds[2]) + 0.5,
    full.at(-1)[1] + 0.5
  ]
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < cropRect[2] &&
        i.rect[2] > cropRect[0] &&
        i.rect[1] < cropRect[3] &&
        i.rect[3] > cropRect[1] &&
        !original.includes(i)
    )
  )
    return
  return {
    parts,
    ownedTokens: new Set(projected),
    cellTokens: new Set(owners),
    titleTokens: new Set(titles),
    pageItems: items.flatMap((i) =>
      original.includes(i) ? nativeMeasuredWordTokens(i, observations, h) : [i]
    ),
    cropRect,
    caption: captionsNear[0]
  }
}
