/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { hasUniqueRecordTokens, readSourceRow } from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { recoverNativeHorizontalStubScopes } from './literature-pdf-native-horizontal-stub-scopes.mjs'
import {
  proveOrdinaryNativeTablePrograms,
  fitOrdinaryNativeTableSourcePaint
} from './literature-pdf-native-bounded-text-record-grid.mjs'
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const centerY = (i) => (i.rect[1] + i.rect[3]) / 2

// Repeated native vertical segments independently prove every leaf record.
// Full-width horizontal separators group those records around one centered
// left stub. Neither the detector's coarse rows nor the stub's baseline proves
// a data-row boundary.
export function recoverNativeSegmentedStubRecords(table, items, captions, rules, context) {
  const horizontal = recoverNativeHorizontalStubScopes(table, items, captions, rules, context)
  if (horizontal) return horizontal
  const underlined = recoverUnderlinedCenteredStubRecords(table, items, captions, rules, context)
  if (underlined) return underlined
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
    em = heights[Math.floor(heights.length * 0.9)]
  if (!(em > 0)) return
  const vertical = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > crop[0] + em &&
        r[0] < crop[2] - em &&
        r[1] > crop[1] - em &&
        r[3] < crop[3] + em &&
        r[3] - r[1] > em * 0.7
    ),
    xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (xs.length < 3 || xs.length > 11) return
  const segments = vertical.filter((r) => r[0] === xs[0]).sort((a, b) => a[1] - b[1])
  if (segments.length < 5 || segments.some((r, n) => n && r[1] < segments[n - 1][3] - 0.02)) return
  for (const x of xs) {
    const next = vertical.filter((r) => r[0] === x).sort((a, b) => a[1] - b[1])
    if (
      next.length !== segments.length ||
      next.some(
        (r, n) => Math.abs(r[1] - segments[n][1]) > 0.02 || Math.abs(r[3] - segments[n][3]) > 0.02
      )
    )
      return
  }
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] > segments[0][1] &&
        r[1] < segments.at(-1)[3] &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 2 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const left = full[0][0],
    right = full[0][2],
    top = segments[0][1] - em * 0.3,
    bottom = segments.at(-1)[3],
    cuts = [left, ...xs, right],
    source = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < right &&
        i.rect[2] > left &&
        centerY(i) > top &&
        centerY(i) < bottom
    )
  if (
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < left ||
        i.rect[2] > right ||
        i.rect[1] < top ||
        i.rect[3] > bottom
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < right &&
        c.rect[2] > left &&
        ((c.rect[3] < top && top - c.rect[3] < em * 3) ||
          (c.rect[1] > bottom - em * 0.15 && c.rect[3] > bottom && c.rect[1] - bottom < em * 3))
    ).length !== 1
  )
    return
  const rows = segments.map((r, n) => [
    left,
    n
      ? (segments[n - 1][3] + r[1]) / 2
      : Math.min(r[1], ...source.filter((i) => centerY(i) < r[3]).map((i) => i.rect[1])),
    right,
    n === segments.length - 1 ? bottom : (r[3] + segments[n + 1][1]) / 2
  ])
  const groups = rows.map((r) => source.filter((i) => centerY(i) >= r[1] && centerY(i) < r[3])),
    header = groups[0]
  if (
    !hasUniqueRecordTokens(source, groups) ||
    !readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t))
  )
    return
  const boundary = []
  for (const rule of full) {
    const matches = rows
      .map((r, n) => (Math.abs(r[3] - rule[1]) < em * 0.1 ? n : -1))
      .filter((n) => n >= 0)
    if (matches.length !== 1) return
    boundary.push(matches[0] + 1)
  }
  if (boundary[0] !== 1 || boundary.at(-1) >= rows.length) return
  boundary.push(rows.length)
  const spans = []
  for (let g = 1; g < boundary.length; g++) {
    const start = boundary[g - 1],
      end = boundary[g],
      records = groups.slice(start, end),
      stubs = records.flat().filter((i) => i.rect[2] <= cuts[1]),
      leaf = records.map((r) => r.filter((i) => i.rect[0] >= cuts[1]))
    if (
      records.length < 2 ||
      !stubs.length ||
      !readSourceRow(stubs, cuts, { multiline: true })?.[0] ||
      stubs.some((i) => !/\p{L}/u.test(i.text)) ||
      leaf.some((r) => {
        const v = readSourceRow(r, cuts)
        return !v || !v[1] || !v.slice(2).every((t) => /\d/.test(t))
      })
    )
      return
    const main = leaf.map((r) =>
        median(r.filter((i) => i.height >= em * 0.9).map((i) => i.baseline))
      ),
      stubBaseline = median(stubs.map((i) => i.baseline))
    if (
      main.some((y) => !Number.isFinite(y)) ||
      stubs.some((i) => Math.abs(i.baseline - stubBaseline) > em * 0.2) ||
      Math.abs(stubBaseline - main.reduce((a, b) => a + b, 0) / main.length) > em * 0.2
    )
      return
    spans.push({ row: start, column: 0, rowSpan: end - start, colSpan: 1 })
  }
  return {
    cropRect: [left, rows[0][1], right, bottom],
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], rows[0][1], x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Full body fences, independently printed parent underlines and two complete
// even peer bands prove a shared category without treating its centered font
// as another record. No quantity or odd-row stub scope is inferred here.
function recoverUnderlinedCenteredStubRecords(table, items, captions, rules, context) {
  const crop = table.cropRect,
    p = Number(/^page-(\d+)-/.exec(table.id ?? '')?.[1])
  if (
    !Number.isInteger(p) ||
    p < 1 ||
    table.readingRotation ||
    !crop?.every(Number.isFinite) ||
    !Array.isArray(context?.sourceContent?.items) ||
    typeof context.viewport?.convertToViewportPoint !== 'function'
  )
    return
  if (
    context.sourceContent.items.some(
      (i) =>
        typeof i.str === 'string' &&
        i.str.trim() &&
        (!Array.isArray(i.transform) ||
          i.transform.length !== 6 ||
          !i.transform.every(Number.isFinite) ||
          !(i.width > 0) ||
          !(i.height > 0))
    )
  )
    return
  const valid = (i) =>
      i.horizontal === true &&
      i.rect?.length === 4 &&
      i.rect.every(Number.isFinite) &&
      i.rect[2] > i.rect[0] &&
      i.rect[3] > i.rect[1] &&
      Number.isFinite(i.baseline) &&
      Number.isFinite(i.height) &&
      i.height > 0,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect?.[0] < crop[2] &&
        i.rect?.[2] > crop[0] &&
        i.rect?.[1] < crop[3] &&
        i.rect?.[3] > crop[1]
    ),
    em = median(near.map((i) => i.height))
  if (!(em > 0) || near.some((i) => !valid(i))) return
  const horizontal = joinHorizontalTableRules(rules),
    full = horizontal
      .filter(
        (r) =>
          r[1] >= crop[1] - em &&
          r[1] <= crop[3] + em &&
          Math.abs(r[0] - crop[0]) < em &&
          Math.abs(r[2] - crop[2]) < em
      )
      .sort((a, b) => a[1] - b[1])
  if (
    full.length < 4 ||
    full.length > 6 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    full[1][1] - full[0][1] > em * 5
  )
    return
  const [opening, divider] = full,
    closing = full.at(-1),
    source = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect?.[0] < opening[2] &&
        i.rect?.[2] > opening[0] &&
        i.rect?.[1] < closing[1] &&
        i.rect?.[3] > opening[1]
    )
  if (
    source.some(
      (i) =>
        !valid(i) ||
        Math.abs(i.height - em) > 0.02 ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    ) ||
    !proveNativeUniqueWholeFonts(source, items)
  )
    return
  const original = context.sourceContent.items
    .filter((i) => 'str' in i && i.str.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
    .filter(
      (i) =>
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1]
    )
  if (
    original.length !== source.length ||
    original.some(
      (i) =>
        source.filter(
          (s) =>
            s.sourceItem?.index === i.sourceItem?.index &&
            s.text === i.text &&
            s.rect.every((v, n) => Math.abs(v - i.rect[n]) < 0.02)
        ).length !== 1
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    partial = horizontal
      .filter(
        (r) => r[1] > opening[1] && r[1] < divider[1] && r[0] > opening[0] && r[2] < opening[2]
      )
      .sort((a, b) => a[0] - b[0])
  if (
    header.length + body.length !== source.length ||
    partial.length < 2 ||
    partial.length > 8 ||
    partial.some(
      (r, n) => Math.abs(r[1] - partial[0][1]) > 0.02 || (n && r[0] <= partial[n - 1][2])
    )
  )
    return
  const upper = header.filter((i) => i.baseline < partial[0][1]),
    lower = header.filter((i) => i.rect[1] > partial[0][1])
  if (
    upper.length !== partial.length ||
    upper.length + lower.length !== header.length ||
    upper.some((i) => Math.abs(i.baseline - upper[0].baseline) > 0.02) ||
    lower.some((i) => Math.abs(i.baseline - lower[0].baseline) > 0.02)
  )
    return
  const projections = []
  for (const i of [...lower, ...body].sort((a, b) => a.rect[0] - b.rect[0])) {
    const prior = projections.at(-1)
    if (prior && i.rect[0] - prior[1] < em * 0.3) prior[1] = Math.max(prior[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  const count = projections.length
  if (count < 5 || count > 20 || lower.length !== count) return
  const cuts = [
      opening[0],
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      opening[2]
    ],
    lane = (i) => cuts.slice(1).findIndex((right, c) => i.rect[0] >= cuts[c] && i.rect[2] <= right),
    leaf = [...lower].sort((a, b) => a.rect[0] - b.rect[0])
  if (
    [...lower, ...body].some((i) => lane(i) < 0) ||
    leaf.some((i, c) => lane(i) !== c || !/\p{L}/u.test(i.text))
  )
    return
  const spans = [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 2, colSpan: 1 }
    ],
    covered = new Set()
  for (const r of partial) {
    const parent = upper.filter((i) => i.rect[0] >= r[0] && i.rect[2] <= r[2] && i.rect[3] < r[1]),
      columns = projections
        .map((d, c) => ({ d, c }))
        .filter(({ d }) => d[0] >= r[0] && d[1] <= r[2])
        .map(({ c }) => c)
    if (
      parent.length !== 1 ||
      columns.length < 1 ||
      columns.length > 4 ||
      columns.some((c, n) => c < 2 || covered.has(c) || (n && c !== columns[n - 1] + 1))
    )
      return
    for (const c of columns) covered.add(c)
    spans.push({ row: 0, column: columns[0], rowSpan: 1, colSpan: columns.length })
  }
  if (covered.size !== count - 2) return
  const records = [],
    bands = [],
    boundaries = [opening[1], partial[0][1], divider[1]]
  for (let b = 1; b < full.length - 1; b++) {
    const top = full[b][1],
      bottom = full[b + 1][1],
      owned = body.filter((i) => i.rect[1] > top && i.rect[3] < bottom),
      stub = owned.filter((i) => lane(i) === 0),
      fields = owned.filter((i) => lane(i) > 0),
      rows = []
    if (stub.length !== 1 || !/\p{L}/u.test(stub[0].text)) return
    for (const i of [...fields].sort((a, z) => a.baseline - z.baseline || a.rect[0] - z.rect[0])) {
      const prior = rows.at(-1)
      if (prior && Math.abs(prior[0].baseline - i.baseline) < 0.02) prior.push(i)
      else rows.push([i])
    }
    if (
      rows.length < 2 ||
      rows.length > 8 ||
      rows.length % 2 ||
      rows.some(
        (r) =>
          r.length !== count - 1 ||
          r.some(
            (i, c) =>
              lane(i) !== c + 1 ||
              (c ? !/^[+−-]?\d+(?:\.\d+)?$/u.test(i.text) : !/\p{L}/u.test(i.text))
          )
      )
    )
      return
    const bounds = rows.map((r) => [
      Math.min(...r.map((i) => i.rect[1])),
      Math.max(...r.map((i) => i.rect[3]))
    ])
    if (
      bounds.some((r, n) => n && r[0] <= bounds[n - 1][1]) ||
      Math.abs(stub[0].baseline - rows.reduce((sum, r) => sum + r[0].baseline, 0) / rows.length) >
        0.02
    )
      return
    spans.push({ row: records.length + 2, column: 0, rowSpan: rows.length, colSpan: 1 })
    boundaries.push(...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2), bottom)
    bands.push(rows.map((r) => r[0].text))
    records.push(...rows.map((r, n) => (n ? r : [stub[0], ...r])))
  }
  if (
    bands.some((b) => b.length !== bands[0].length || b.some((s, n) => s !== bands[0][n])) ||
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    (records.length + 2) * count > 2048
  )
    return
  const titles = captions.filter(
    (c) =>
      c.page === p &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect?.every(Number.isFinite) &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < em * 4) ||
        (c.rect[1] > closing[1] && c.rect[1] - closing[1] < em * 4))
  )
  if (titles.length !== 1) return
  const caption = titles[0],
    titleFonts = context.sourceContent.items
      .filter((i) => 'str' in i && i.str.trim())
      .map((i) => tableTextToken(i, context.viewport, 0))
      .filter(
        (i) =>
          i.rect[0] < caption.rect[2] &&
          i.rect[2] > caption.rect[0] &&
          i.rect[1] < caption.rect[3] &&
          i.rect[3] > caption.rect[1]
      )
  if (
    !titleFonts.length ||
    titleFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    titleFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '') ||
    !proveOrdinaryNativeTablePrograms([...source, ...titleFonts], context, p)
  )
    return
  const paint = new Map(),
    native = collectTableRules(context.operators, context.viewport, paint),
    expected = [...full, ...partial],
    // Crossing strokes are foreign evidence even when neither endpoint is inside.
    local = native.filter(
      (r) => r[0] <= opening[2] && r[2] >= opening[0] && r[1] <= closing[1] && r[3] >= opening[1]
    )
  if (
    local.length !== expected.length ||
    expected.some(
      (r) =>
        local.filter((n) => n.every((v, k) => Math.abs(v - r[k]) < 0.02) && paint.has(n.join(',')))
          .length !== 1
    ) ||
    rules.some(
      (r) =>
        r[0] <= opening[2] &&
        r[2] >= opening[0] &&
        r[1] <= closing[1] &&
        r[3] >= opening[1] &&
        !expected.some((e) => e.every((v, n) => Math.abs(v - r[n]) < 0.02))
    )
  )
    return
  const painted = local.map((r) => paint.get(r.join(','))),
    cropRect = [
      Math.min(crop[0], ...painted.map((r) => r[0])),
      Math.min(crop[1], ...painted.map((r) => r[1])),
      Math.max(crop[2], ...painted.map((r) => r[2])),
      Math.max(crop[3], ...painted.map((r) => r[3]))
    ]
  if (!fitOrdinaryNativeTableSourcePaint(source, context, cropRect)) return
  cuts[0] = cropRect[0]
  cuts[cuts.length - 1] = cropRect[2]
  boundaries[0] = cropRect[1]
  boundaries[boundaries.length - 1] = cropRect[3]
  return {
    cropRect,
    rows: boundaries.slice(1).map((y, n) => [cuts[0], boundaries[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], cropRect[1], x, cropRect[3]]),
    spans,
    headerRows: [0, 1],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
