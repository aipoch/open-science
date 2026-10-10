/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'

// Native opening/divider/footer strokes, complete scalar records and unique
// physical baselines establish header ownership. Font boxes may touch a rule;
// their baseline must remain in the same uniquely bounded physical band.
export function recoverNativeHeaderOwnershipGrid(table, items, captions, rules) {
  const plan = recoverHeaderOwnershipPlan(table, items, captions, rules)
  if (!plan) return
  const ink = [...plan.ownedTokens]
  const frameInk = plan.cropRect.map((v, n) =>
    n < 2 ? Math.min(v, ...ink.map((i) => i.rect[n])) : Math.max(v, ...ink.map((i) => i.rect[n]))
  )
  // Preserve existing padding when it contains only this table. Tighten a
  // vertical edge only for independently excluded ink outside the proved
  // opening/closing, while retaining every owned glyph and native stroke.
  const cropRect = frameInk.map((v, n) =>
    n < 2 ? Math.min(v, table.cropRect[n]) : Math.max(v, table.cropRect[n])
  )
  const external = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      !plan.ownedTokens.has(i) &&
      i.rect[0] < table.cropRect[2] &&
      i.rect[2] > table.cropRect[0] &&
      i.rect[1] < table.cropRect[3] &&
      i.rect[3] > table.cropRect[1]
  )
  if (external.some((i) => i.baseline < plan.cropRect[1])) cropRect[1] = frameInk[1]
  if (external.some((i) => i.baseline > plan.cropRect[3])) cropRect[3] = frameInk[3]
  return { ...plan, cropRect, repair: 'native-body-records-recovered' }
}

function proveNativeHeaderFrame(table, items, captions, rules) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite)) return
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[1]
  )
  const heights = near
    .map((i) => i.height)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b)
  const height = heights[heights.length >> 1]
  if (!(height > 0)) return
  const edges = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        Math.abs(r[0] - crop[0]) < height * 2 &&
        Math.abs(r[2] - crop[2]) < height * 2 &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height
    )
    .sort((a, b) => a[1] - b[1])
  if (edges.length < 3) return
  const opening = edges[0],
    closing = edges.at(-1)
  if (
    Math.abs(opening[0] - closing[0]) > 0.5 ||
    Math.abs(opening[2] - closing[2]) > 0.5 ||
    opening[1] - crop[1] > height ||
    Math.abs(closing[1] - crop[3]) > height * 2
  )
    return
  const frame = [opening[0], opening[1], opening[2], closing[1]]
  const contains = (rect, i) =>
    i.rect[0] >= rect[0] - 0.1 &&
    i.rect[2] <= rect[2] + 0.1 &&
    i.rect[1] >= rect[1] - 0.1 &&
    i.rect[3] <= rect[3] + 0.1
  const belowParts = new Map()
  for (const c of captions) {
    if (
      captionKind(c.lines[0]) !== 'table' ||
      c.rect[1] < closing[1] - height * 0.25 ||
      c.rect[1] - closing[1] >= height * 4
    )
      continue
    const parts = items.filter((i) => i.horizontal && i.text.trim() && contains(c.rect, i))
    const literal = (s) => s.replace(/\s+/g, '')
    if (
      parts.length &&
      parts.every((i) => Number.isFinite(i.baseline) && i.baseline > closing[1]) &&
      literal(parts.map((i) => i.text).join('')) === literal(c.lines.join(''))
    )
      belowParts.set(c, new Set(parts))
  }
  const aboveCandidates = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < height * 4 &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0]
  )
  const candidates = aboveCandidates.length
    ? aboveCandidates
    : captions.filter((c) => belowParts.has(c) && c.rect[0] < frame[2] && c.rect[2] > frame[0])
  if (candidates.length !== 1) return
  const intersects = items.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] < frame[2] &&
      i.rect[2] > frame[0] &&
      i.rect[1] < frame[3] &&
      i.rect[3] > frame[1] &&
      !(belowParts.get(candidates[0])?.has(i) || contains(candidates[0].rect, i))
  )
  const source = intersects
    .filter(
      (i) =>
        i.rect.every(Number.isFinite) &&
        Number.isFinite(i.baseline) &&
        Number.isFinite(i.height) &&
        i.height > 0 &&
        i.rect[0] >= frame[0] - 0.1 &&
        i.rect[2] <= frame[2] + 0.1 &&
        i.baseline > frame[1] &&
        i.baseline < frame[3] &&
        i.rect[1] >= frame[1] - height * 0.25 &&
        i.rect[3] <= frame[3] + 0.1
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (source.length !== intersects.length) return
  return {
    crop,
    height,
    edges,
    opening,
    closing,
    frame,
    source,
    belowCaption: belowParts.has(candidates[0])
  }
}

function recoverHeaderOwnershipPlan(table, items, captions, rules) {
  const context = proveNativeHeaderFrame(table, items, captions, rules)
  if (!context) return
  if (context.belowCaption) return recoverCompoundPhysicalLeafGrid(table, context)
  const grouped = recoverCenteredGroupStubGrid(table, context)
  if (grouped) return grouped
  const prose = recoverRuledProseHeaderGrid(table, context)
  if (prose) return prose
  const underlined = recoverUnderlinedSourceLeafGrid(context, rules)
  if (underlined) return underlined
  const separated = recoverSeparatedNumericParentGrid(table, context)
  if (separated) return separated
  const aligned = recoverAlignedLeafHeaderGrid(table, context)
  if (aligned) return aligned
  const { crop, height, edges, frame, source } = context
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 3 || predicted.length > 18) return
  const cuts = [
    frame[0] - 0.1,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const scalar = (v) => /^(?:[<>≤≥−–+\-|]?\d[\d.,()[\]±−–+\-|%*/=<>≤≥]*|[—–-])$/.test(v)
  const physical = []
  for (const item of source.filter((i) => i.height >= height * 0.8)) {
    const last = physical.at(-1)
    if (last && Math.abs(last[0].baseline - item.baseline) < height * 0.2) last.push(item)
    else physical.push([item])
  }
  const measured = physical
    .map((g) => readSourceRow(g, cuts))
    .map(
      (v) => v && v.filter((x) => scalar(x)).length >= 2 && v.slice(2).every((x) => !x || scalar(x))
    )
  const first = measured.indexOf(true)
  if (first < 1 || first > 6 || measured.filter(Boolean).length < 3) return
  const firstBaseline = physical[first][0].baseline
  let head = source.filter((i) => i.baseline < firstBaseline - height * 0.5)
  let body = groupSourceRowsWithScripts(
    source.filter((i) => !head.includes(i)),
    height,
    0.2
  )
  const sectionPlan = recoverNativeFullWidthSections(source, cuts, edges, frame, height)
  const sections = sectionPlan?.sections ?? []
  if (sectionPlan) {
    head = sectionPlan.head
    body = sectionPlan.body
  }
  if (!body || (!sectionPlan && measured.slice(first).some((v) => !v))) return
  const bodyValues = body
    .filter((_, row) => !sections.includes(row))
    .map((g) => readSourceRow(g, cuts))
  if (bodyValues.some((v) => !v)) return
  // This branch proves header scopes only. An empty detector leaf is not a
  // native column, and sparse shared body cells need the existing categorical
  // and statistical span recovery rather than a complete-spans declaration.
  if (
    cuts.slice(1).some((_, c) => !bodyValues.some((v) => v[c])) ||
    cuts.slice(2).some((_, n) => {
      const values = bodyValues.map((v) => v[n + 1])
      return values.filter(Boolean).length === 1 && values.filter((v) => !v).length >= 2
    }) ||
    bodyValues.some((v) => !v[0] && v.slice(1).some((x) => !x))
  )
    return
  const divider = edges.filter(
    (r) =>
      r[1] > Math.max(...head.map((i) => i.baseline)) &&
      r[1] < Math.min(...body[0].map((i) => i.baseline))
  )
  if (divider.length !== 1 || divider[0][1] - frame[1] > height * 5) return
  let header = recoverRuledHeaderBands(head, cuts, rules, frame[1], divider[0][1])
  if (header?.rows.length === 1) {
    const parents = recoverSingleTierParentScopes(head, cuts, body, height)
    header =
      recoverCenteredParentHeaderScopes(head, cuts, frame[1], divider[0][1], height, body.flat()) ??
      (parents ? { ...header, spans: parents.spans } : header)
  }
  if (!header || header.rows.length < 1 || header.rows.length > 3) return
  // A new plan must actually recover a native header tier, rather than use a
  // numeric table as a general body-reconstruction escape hatch.
  if (
    header.rows.length === 1 &&
    head.some((i) => i.rect[1] >= frame[1] && i.rect[1] >= divider[0][1])
  )
    return
  let repairedLeafCut = false
  if (header.rows.length === 1 && !header.spans.some((s) => s.colSpan > 1)) {
    // A complete one-line leaf can straddle a detector cut. The unique ink
    // gutter may move that cut only while every numeric record keeps its lane.
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    const numericBody = body.filter((_, n) => !sections.includes(n))
    const owned = head.map((i) => [i, col(i)]),
      bodyOwned = numericBody.flat().map((i) => [i, col(i)])
    for (let c = 1; c < cuts.length - 1; c++) {
      const left = head.filter((i) => col(i) === c - 1),
        right = head.filter((i) => col(i) === c)
      if (!left.length || !right.length) return
      const end = Math.max(...left.map((i) => i.rect[2])),
        start = Math.min(...right.map((i) => i.rect[0]))
      if (end >= start) return
      if (end > cuts[c] || start < cuts[c]) {
        cuts[c] = (end + start) / 2
        repairedLeafCut = true
      }
    }
    if (
      head.some((i, n) => col(i) !== owned[n][1]) ||
      bodyOwned.some(([i, c]) => col(i) !== c) ||
      numericBody.some((g) => !readSourceRow(g, cuts))
    )
      return
  }
  if (header.rows.length === 1 && !header.spans.length && !sections.length && !repairedLeafCut)
    return
  const spanOwner = (i, row) =>
    header.spans.find(
      (s) =>
        s.row <= row &&
        s.row + s.rowSpan > row &&
        (i.rect[0] + i.rect[2]) / 2 >= cuts[s.column] &&
        (i.rect[0] + i.rect[2]) / 2 < cuts[s.column + s.colSpan]
    )
  for (const i of head) {
    const row = header.rows.findIndex((r) => i.baseline > r[1] && i.baseline < r[3])
    if (row < 0) return
    const s = spanOwner(i, row),
      c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (
      c < 0 ||
      i.rect[0] < cuts[s?.column ?? c] - 0.1 ||
      i.rect[2] > cuts[s ? s.column + s.colSpan : c + 1] + 0.1
    )
      return
  }
  if (!hasUniqueRecordTokens(source, [head, ...body])) return
  const bodyBands = sourceBodyBands(body, frame, divider[0][1])
  if (!bodyBands) return
  const rows = [...header.rows, ...bodyBands]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: header.rows.map((_, n) => n),
    spans: [
      ...header.spans,
      ...sections.map((row) => ({
        row: row + header.rows.length,
        column: 0,
        rowSpan: 1,
        colSpan: cuts.length - 1
      }))
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// A single physical header baseline has independent ink clusters. Move a
// detector cut only when it actually splits one such cluster, and every body
// glyph keeps its original lane. Sparse stubs additionally need repeated native
// full-width section boundaries and one flush label per section.
function recoverCompoundPhysicalLeafGrid(table, context) {
  const { crop, height, edges, frame, source } = context
  const divider = edges[1]
  if (divider[1] - frame[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !head.length ||
    !records ||
    records.length < 4 ||
    Math.max(...head.map((i) => i.baseline)) - Math.min(...head.map((i) => i.baseline)) >
      height * 0.2
  )
    return
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 4 || columns.length > 12) return
  const original = [
    frame[0] - 0.1,
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (original.some((x, n) => !Number.isFinite(x) || (n && x <= original[n - 1]))) return
  const clusters = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  if (clusters.length !== columns.length) return
  const col = (i, cuts) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const splitLeaf = clusters.some((g, c) => g.some((i) => col(i, original) !== c))
  const headerBodySpan = (table.spans ?? []).some((s) => {
    const r = s.rect.map((x, n) => x + crop[n % 2])
    const contains = (i) =>
      i.rect[0] >= r[0] && i.rect[2] <= r[2] && i.baseline >= r[1] && i.baseline <= r[3]
    return (
      r[2] <= original[1] + 0.1 &&
      r[1] < divider[1] &&
      r[3] > divider[1] &&
      clusters[0].every(contains) &&
      body.some((i) => col(i, original) === 0 && contains(i))
    )
  })
  if (!splitLeaf && !headerBodySpan) return
  const owned = body.map((i) => col(i, original))
  if (owned.some((c) => c < 0)) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < columns.length; c++) {
    const left = Math.max(
        ...[...clusters[c - 1], ...body.filter((_, n) => owned[n] === c - 1)].map((i) => i.rect[2])
      ),
      right = Math.min(
        ...[...clusters[c], ...body.filter((_, n) => owned[n] === c)].map((i) => i.rect[0])
      )
    if (right - left < height * 0.45) return
    cuts.push((left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  const values = records.map((g) => readSourceRow(g, cuts))
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(x)
  if (
    values.some((v) => !v || v.filter(scalar).length < 2) ||
    body.some((i, n) => col(i, cuts) !== owned[n]) ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const spans = []
  for (let c = 0; c < columns.length; c++) {
    if (values.every((v) => v[c])) continue
    if (edges.length < 4 || c > 1) return
    const groups = edges
      .slice(1, -1)
      .map((r, n) =>
        records
          .map((g, row) => (g[0].baseline > r[1] && g[0].baseline < edges[n + 2][1] ? row : -1))
          .filter((row) => row >= 0)
      )
    if (
      groups.length < 2 ||
      groups.some(
        (g) => g.length < 3 || !values[g[0]][c] || g.slice(1).some((row) => values[row][c])
      )
    )
      return
    for (const g of groups) spans.push({ row: g[0] + 1, column: c, rowSpan: g.length, colSpan: 1 })
  }
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands || !readSourceRow(head, cuts)?.every(Boolean)) return
  // Caption distance follows owned body ink, while the rendering crop retains
  // the independent footer. A below-caption font box may overhang that stroke.
  bands.at(-1)[3] = Math.max(...records.at(-1).map((i) => i.rect[3]))
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: [frame[0], frame[1] - 0.5, frame[2], frame[3] + 0.5]
  }
}

function recoverRuledProseHeaderGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    cols.length !== 3 ||
    edges.length < 5 ||
    edges.length > 10 ||
    edges.some((r) => Math.abs(r[0] - opening[0]) > 0.5 || Math.abs(r[2] - opening[2]) > 0.5) ||
    edges[1][1] - opening[1] > height * 2
  )
    return
  const cuts = [
    frame[0] - 0.1,
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const records = edges
    .slice(1)
    .map((r, n) => source.filter((i) => i.baseline > edges[n][1] && i.baseline < r[1]))
  if (
    !hasUniqueRecordTokens(source, records) ||
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || v.some((x) => !x || !/\p{L}/u.test(x))
    })
  )
    return
  const header = records[0]
  if (
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) >
      height * 0.1 ||
    records
      .slice(1)
      .some(
        (g) =>
          Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) < height
      )
  )
    return
  // Baselines establish native faces; complete glyph centers must agree so the
  // renderer never borrows a tail from the adjoining physical record.
  if (
    records.some((g, n) =>
      g.some(
        (i) =>
          (i.rect[1] + i.rect[3]) / 2 <= edges[n][1] ||
          (i.rect[1] + i.rect[3]) / 2 >= edges[n + 1][1]
      )
    )
  )
    return
  return {
    rows: edges.slice(1).map((r, n) => [frame[0] - 0.1, edges[n][1], frame[2] + 0.1, r[1]]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function recoverAlignedLeafHeaderGrid(table, context) {
  const { height, edges, opening, frame, source } = context
  if (edges.length !== 3) return
  const divider = edges[1]
  if (divider[1] - opening[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (!head.length || !records || records.length < 4) return
  const lanes = records.map((g) => {
    const clusters = []
    for (const i of [...g].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = clusters.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
      else clusters.push([i])
    }
    return clusters
  })
  const width = lanes[0].length
  if (table.structure.objects.filter((o) => o.label === 'table column').length === width) return
  if (
    width < 5 ||
    width > 12 ||
    lanes.some(
      (row) =>
        row.length !== width ||
        row.filter((g) => /^[−+-]?\d[\d.,]*$/.test(g.map((i) => i.text).join(''))).length < 3
    )
  )
    return
  const headGroups = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = headGroups.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else headGroups.push([i])
  }
  if (headGroups.length !== width) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < width; c++) {
    const left = Math.max(
        ...[headGroups[c - 1], ...lanes.map((row) => row[c - 1])].flat().map((i) => i.rect[2])
      ),
      right = Math.min(
        ...[headGroups[c], ...lanes.map((row) => row[c])].flat().map((i) => i.rect[0])
      )
    if (right - left < height * 0.45) return
    cuts.push((left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  const header = readSourceRow(head, cuts)
  if (
    !header ||
    header.some((v) => !v) ||
    records.some((g) => !readSourceRow(g, cuts)) ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands) return
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// A centered stub may name several records. Native full-width separators, or
// repeated leading separated by one unique larger gap, bound its scope.
function recoverCenteredGroupStubGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cols.length < 4 || cols.length > 10) return
  const cuts = [
    frame[0] - 0.1,
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    frame[2] + 0.1
  ]
  if (cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))) return
  const divider = edges[1]
  if (divider[1] - opening[1] > height * 3) return
  const head = source.filter((i) => i.baseline < divider[1]),
    allBody = source.filter((i) => !head.includes(i))
  if (!head.length || !readSourceRow(head, cuts)) return
  const stubs = allBody.filter((i) => i.rect[0] >= cuts[0] && i.rect[2] <= cuts[1]),
    data = allBody.filter((i) => !stubs.includes(i))
  if (!stubs.length) return
  const records = groupSourceRowsWithScripts(data, height, 0.2)
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(x)
  if (
    !records ||
    records.length < 6 ||
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || v.filter(scalar).length < 3 || v[0] || v.slice(2).some((x) => !scalar(x))
    })
  )
    return
  const labels = groupSourceRowsWithScripts(stubs, height, 0.2)
  if (!labels || labels.length < 2 || labels.length > 5) return
  const ys = records.map((g) => g.find((i) => i.height >= height * 0.8)?.baseline)
  if (ys.some((y) => !Number.isFinite(y))) return
  const gaps = ys.slice(1).map((y, n) => y - ys[n]),
    leading = Math.min(...gaps)
  if (leading < height || leading > height * 1.8) return
  const groups = []
  if (edges.length > 3) {
    for (let n = 1; n < edges.length - 1; n++)
      groups.push(
        records
          .map((g, r) => (ys[r] > edges[n][1] && ys[r] < edges[n + 1][1] ? r : -1))
          .filter((r) => r >= 0)
      )
  } else {
    let group = []
    for (let r = 0; r < records.length; r++) {
      if (r && gaps[r - 1] > leading * 1.3) {
        groups.push(group)
        group = []
      } else if (r && Math.abs(gaps[r - 1] - leading) > height * 0.1) return
      if (r && gaps[r - 1] > leading * 2) return
      group.push(r)
    }
    groups.push(group)
  }
  if (
    groups.length !== labels.length ||
    groups.some((g) => g.length < 3) ||
    groups.flat().length !== records.length
  )
    return
  const owners = []
  for (let n = 0; n < groups.length; n++) {
    const g = groups[n],
      lo = ys[g[0]],
      hi = ys[g.at(-1)],
      label = labels[n]
    if (
      Math.abs((lo + hi) / 2 - label[0].baseline) > height * 0.1 ||
      g.slice(1).some((r, k) => Math.abs(ys[r] - ys[g[k]] - leading) > height * 0.1)
    )
      return
    owners.push(label)
  }
  if (!hasUniqueRecordTokens(source, [head, ...records, ...owners])) return
  const bands = sourceBodyBands(records, frame, divider[1])
  if (!bands) return
  return {
    rows: [[frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]], ...bands],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: groups.map((g) => ({ row: g[0] + 1, column: 0, rowSpan: g.length, colSpan: 1 })),
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function sourceBodyBands(records, frame, top) {
  const bounds = records.map((g) => [
    Math.min(...g.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...g.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (
    bounds.some(
      (b, n) =>
        !b.every(Number.isFinite) ||
        b[0] <= top ||
        b[1] >= frame[3] ||
        (n && b[0] <= bounds[n - 1][1])
    )
  )
    return
  const edges = [top, ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2), frame[3]]
  return records.map((_, n) => [frame[0] - 0.1, edges[n], frame[2] + 0.1, edges[n + 1]])
}

// Repeated literal separators delimit equal-sized numerical subgroups on every
// source baseline. Their wide gutters and uniquely centered parent ink prove
// a shared header scope without borrowing the model's phantom separator lane.
function recoverSeparatedNumericParentGrid(table, context) {
  const { crop, height, edges, opening, frame, source } = context
  const divider = edges.find((r) => r[1] > opening[1] + height && r[1] < opening[1] + height * 4)
  if (!divider) return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => !header.includes(i))
  const records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !records ||
    records.length < 3 ||
    !header.length ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const scalar = (i) =>
    i.height >= height * 0.8 &&
    /^[−–+-]?\d[\d.,%]*$/.test(i.text) &&
    Math.abs(
      i.baseline -
        records.find((g) => g.includes(i))?.find((a) => a.height >= height * 0.8)?.baseline
    ) <
      height * 0.2
  const groups = []
  let firstNumericLeft, groupCuts
  for (const row of records) {
    const values = row
      .filter(
        (i) =>
          scalar(i) &&
          (firstNumericLeft === undefined || i.rect[0] >= firstNumericLeft - height * 2)
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (values.length < 4 || values.length > 20) return
    const separators = row
      .filter((i) => i.text === '|' && i.rect[0] > values[0].rect[0])
      .sort((a, b) => a.rect[0] - b.rect[0])
    const terms = [...values, ...separators].sort((a, b) => a.rect[0] - b.rect[0]),
      partition = []
    if (groupCuts) {
      for (let p = 0; p < groupCuts.length - 1; p++)
        partition.push(
          terms.filter((i) => i.rect[0] >= groupCuts[p] && i.rect[2] <= groupCuts[p + 1])
        )
      if (!hasUniqueRecordTokens(terms, partition)) return
    } else {
      for (const i of terms) {
        const last = partition.at(-1)
        if (last && i.rect[0] - last.at(-1).rect[2] < height * 0.65) last.push(i)
        else partition.push([i])
      }
    }
    if (partition.length < 2 || partition.length > 5) return
    const count = partition[0].filter(scalar).length
    if (
      count < 2 ||
      count > 4 ||
      partition.some(
        (g) => g.length !== count * 2 - 1 || g.some((i, n) => (n % 2 ? i.text !== '|' : !scalar(i)))
      ) ||
      partition.some((g, n) => n && g[0].rect[0] - partition[n - 1].at(-1).rect[2] < height)
    )
      return
    if (!groupCuts) {
      firstNumericLeft = values[0].rect[0]
      groupCuts = [
        firstNumericLeft - height * 2,
        ...partition.slice(1).map((g, n) => (partition[n].at(-1).rect[2] + g[0].rect[0]) / 2),
        frame[2] + 0.1
      ]
    }
    groups.push(partition)
  }
  const count = groups[0][0].filter(scalar).length,
    parents = groups[0].length
  if (groups.some((g) => g.length !== parents || g.some((p) => p.filter(scalar).length !== count)))
    return
  const heads = groupSourceRowsWithScripts(header, height, 0.2)
  if (!heads || heads.length !== 1) return
  const clusters = []
  for (const i of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.65) last.push(i)
    else clusters.push([i])
  }
  const stubCount = clusters.length - parents
  if (stubCount < 1 || stubCount > 2) return
  const boundaries = Array.from({ length: parents + 1 }, (_, n) => {
    if (!n) return Math.min(...groups.map((g) => g[0][0].rect[0]))
    if (n === parents) return frame[2] + 0.1
    return (
      (Math.max(...groups.map((g) => g[n - 1].at(-1).rect[2])) +
        Math.min(...groups.map((g) => g[n][0].rect[0]))) /
      2
    )
  })
  for (let p = 0; p < parents; p++) {
    const ink = clusters[stubCount + p],
      box = [Math.min(...ink.map((i) => i.rect[0])), Math.max(...ink.map((i) => i.rect[2]))]
    const centers = groups.map((g) => (g[p][0].rect[0] + g[p].at(-1).rect[2]) / 2)
    if (
      box[0] < boundaries[p] ||
      box[1] > boundaries[p + 1] ||
      Math.abs((box[0] + box[1]) / 2 - centers[0]) > height ||
      Math.max(...centers) - Math.min(...centers) > height
    )
      return
  }
  const numericStart = Math.min(...groups.map((g) => g[0][0].rect[0]))
  const stubGroups = records.map((row) => row.filter((i) => i.rect[2] < numericStart))
  const stubCuts = []
  for (let c = 0; c < stubCount; c++) {
    if (!c) {
      stubCuts.push(frame[0] - 0.1)
      continue
    }
    const predicted = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
    const cut = crop[0] + (predicted[c - 1].rect[2] + predicted[c].rect[0]) / 2
    if (!Number.isFinite(cut) || cut <= stubCuts.at(-1) || cut >= numericStart) return
    stubCuts.push(cut)
  }
  const stubEnd = Math.max(...stubGroups.flat().map((i) => i.rect[2]))
  if (stubEnd >= numericStart - height * 0.5) return
  const cuts = [...stubCuts, (stubEnd + numericStart) / 2]
  for (let p = 0; p < parents; p++) {
    for (let c = 1; c < count; c++) {
      const left = Math.max(...groups.map((g) => g[p][c * 2 - 1].rect[2])),
        right = Math.min(...groups.map((g) => g[p][c * 2].rect[0]))
      if (left >= right) return
      cuts.push((left + right) / 2)
    }
    cuts.push(p === parents - 1 ? frame[2] + 0.1 : boundaries[p + 1])
  }
  if (records.some((row) => !readSourceRow(row, cuts))) return
  const spans = Array.from({ length: parents }, (_, p) => ({
    row: 0,
    column: stubCount + p * count,
    rowSpan: 1,
    colSpan: count
  }))
  for (let c = 0; c < stubCount; c++)
    if (clusters[c].some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
  const rows = [
    [frame[0] - 0.1, frame[1], frame[2] + 0.1, divider[1]],
    ...records.map((g, n) => [
      frame[0] - 0.1,
      n
        ? (Math.max(...records[n - 1].map((i) => i.baseline)) +
            Math.min(...g.map((i) => i.baseline))) /
          2
        : divider[1],
      frame[2] + 0.1,
      records[n + 1]
        ? (Math.max(...g.map((i) => i.baseline)) +
            Math.min(...records[n + 1].map((i) => i.baseline))) /
          2
        : frame[3]
    ])
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

// Independent native parent strokes and complete repeated body baselines
// identify the leaf lanes. Horizontal source-run adjacency is used only for
// ownership; no literal text, number or script is rewritten by this plan.
function recoverUnderlinedSourceLeafGrid(context, rules) {
  const { height, edges: full, frame, source } = context
  const parents = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] >= frame[0] - 0.1 &&
        r[2] <= frame[2] + 0.1 &&
        r[2] - r[0] < (frame[2] - frame[0]) * 0.85 &&
        r[2] - r[0] > height * 3 &&
        r[1] > frame[1] + height * 0.5 &&
        r[1] < frame[1] + height * 3
    )
    .sort((a, b) => a[0] - b[0])
  if (
    !parents.length ||
    parents.length > 4 ||
    parents.some(
      (r, n) =>
        Math.abs(r[1] - parents[0][1]) > height * 0.1 || (n && r[0] < parents[n - 1][2] - 0.1)
    )
  )
    return
  const split = parents[0][1],
    dividers = full.filter((r) => r[1] > split + height * 0.5 && r[1] < frame[1] + height * 5)
  if (dividers.length !== 1) return
  const divider = dividers[0][1]
  const head = source.filter((i) => i.baseline < divider),
    body = source.filter((i) => !head.includes(i)),
    records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !records ||
    records.length < 3 ||
    !head.length ||
    !hasUniqueRecordTokens(source, [head, ...records])
  )
    return
  const clusters = (parts) => {
    const groups = []
    for (const i of [...parts].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = groups.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
      else groups.push([i])
    }
    return groups
  }
  const parentProof = [],
    leaves = []
  for (const stroke of parents) {
    const upper = head.filter(
      (i) =>
        i.baseline < stroke[1] &&
        i.rect[0] >= stroke[0] - height * 0.15 &&
        i.rect[2] <= stroke[2] + height * 0.15
    )
    const lower = head.filter(
      (i) =>
        i.baseline > stroke[1] &&
        i.rect[0] >= stroke[0] - height * 0.15 &&
        i.rect[2] <= stroke[2] + height * 0.15
    )
    const leaf = clusters(lower)
    if (
      !upper.length ||
      leaf.length < 2 ||
      leaf.length > 5 ||
      Math.abs(
        (Math.min(...upper.map((i) => i.rect[0])) +
          Math.max(...upper.map((i) => i.rect[2])) -
          stroke[0] -
          stroke[2]) /
          2
      ) > height
    )
      return
    const start = leaves.length
    for (const g of leaf) leaves.push({ items: g, parent: parentProof.length })
    parentProof.push({ stroke, upper, start, count: leaf.length })
  }
  const reserved = parentProof.flatMap((p) => [
    ...p.upper,
    ...leaves.filter((l) => l.parent === parentProof.indexOf(p)).flatMap((l) => l.items)
  ])
  if (new Set(reserved).size !== reserved.length) return
  const remaining = head.filter((i) => !reserved.includes(i))
  for (const g of clusters(remaining)) leaves.push({ items: g, parent: -1 })
  leaves.sort(
    (a, b) =>
      Math.min(...a.items.map((i) => i.rect[0])) - Math.min(...b.items.map((i) => i.rect[0]))
  )
  if (leaves.length < 4 || leaves.length > 16) return
  const center = (l) =>
    (Math.min(...l.items.map((i) => i.rect[0])) + Math.max(...l.items.map((i) => i.rect[2]))) / 2
  const centers = leaves.map(center),
    owners = leaves.map((l) => [...l.items])
  const provisional = [
    frame[0] - 0.1,
    ...centers.slice(1).map((x, c) => (centers[c] + x) / 2),
    frame[2] + 0.1
  ]
  const ownRecords = []
  for (const record of records) {
    const cells = leaves.map(() => [])
    for (const g of clusters(record)) {
      const left = Math.min(...g.map((i) => i.rect[0])),
        right = Math.max(...g.map((i) => i.rect[2])),
        mid = (left + right) / 2
      const c = provisional.slice(1).findIndex((x) => mid < x)
      if (c < 0 || left < frame[0] - 0.1 || right > frame[2] + 0.1) return
      const p = leaves[c].parent >= 0 ? parentProof[leaves[c].parent] : undefined
      if (p && (left < p.stroke[0] - height * 0.15 || right > p.stroke[2] + height * 0.15)) return
      cells[c].push(...g)
      owners[c].push(...g)
    }
    const values = cells.map((g) => g.map((i) => i.text).join(''))
    if (!values[0] || values.filter((v) => /\d/.test(v)).length < 2) return
    ownRecords.push(cells)
  }
  if (owners.some((g, c) => ownRecords.filter((row) => row[c].length).length < 3)) return
  const cuts = [frame[0] - 0.1]
  for (let c = 1; c < leaves.length; c++) {
    const left = Math.max(...owners[c - 1].map((i) => i.rect[2])),
      right = Math.min(...owners[c].map((i) => i.rect[0]))
    if (left >= right) return
    const native = parents
      .flatMap((r) => [r[0], r[2]])
      .filter((x) => x > left - 0.1 && x < right + 0.1)
    const unique = [...new Set(native)]
      .sort((a, b) => a - b)
      .filter((x, n, a) => !n || x - a[n - 1] > 0.1)
    if (unique.length > 1) return
    cuts.push(unique.length ? unique[0] : (left + right) / 2)
  }
  cuts.push(frame[2] + 0.1)
  if (records.some((row) => !readSourceRow(row, cuts))) return
  const insets = parentProof.flatMap((proof, p) => {
    const indices = leaves.map((l, c) => (l.parent === p ? c : -1)).filter((c) => c >= 0)
    return [proof.stroke[0] - cuts[indices[0]], cuts[indices.at(-1) + 1] - proof.stroke[2]]
  })
  const repeatedInset =
    parentProof.length >= 2 &&
    insets.every((x) => x >= height * 0.2 && x <= height * 0.6) &&
    Math.max(...insets) - Math.min(...insets) <= height * 0.1
  const spans = []
  for (let p = 0; p < parentProof.length; p++) {
    const indices = leaves.map((l, c) => (l.parent === p ? c : -1)).filter((c) => c >= 0),
      start = indices[0]
    if (indices.some((c, n) => c !== start + n)) return
    const proof = parentProof[p]
    if (
      !repeatedInset &&
      (Math.abs(cuts[start] - proof.stroke[0]) > height * 0.2 ||
        Math.abs(cuts[start + indices.length] - proof.stroke[2]) > height * 0.2)
    )
      return
    spans.push({ row: 0, column: start, rowSpan: 1, colSpan: indices.length })
  }
  for (let c = 0; c < leaves.length; c++)
    if (leaves[c].parent < 0) spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  if (
    !hasUniqueRecordTokens(head, [
      ...parentProof.map((p) => p.upper),
      ...leaves.map((l) => l.items)
    ])
  )
    return
  const rows = [
    [frame[0] - 0.1, frame[1], frame[2] + 0.1, split],
    [frame[0] - 0.1, split, frame[2] + 0.1, divider],
    ...records.map((g, n) => [
      frame[0] - 0.1,
      n
        ? (Math.max(...records[n - 1].map((i) => i.baseline)) +
            Math.min(...g.map((i) => i.baseline))) /
          2
        : divider,
      frame[2] + 0.1,
      records[n + 1]
        ? (Math.max(...g.map((i) => i.baseline)) +
            Math.min(...records[n + 1].map((i) => i.baseline))) /
          2
        : frame[3]
    ])
  ]
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    cropRect: frame
  }
}

function recoverCenteredParentHeaderScopes(head, cuts, top, bottom, height, body) {
  const main = head.filter((i) => i.height >= height * 0.8),
    baselines = []
  for (const i of main) {
    if (!baselines.some((y) => Math.abs(i.baseline - y) < height * 0.2)) baselines.push(i.baseline)
  }
  if (
    baselines.length !== 2 ||
    baselines[1] - baselines[0] < height ||
    baselines[1] - baselines[0] > height * 2.5
  )
    return
  const upper = head.filter((i) => i.baseline < baselines[0] + height * 0.5),
    lower = head.filter((i) => !upper.includes(i)),
    leaf = readSourceRow(lower, cuts)
  if (!leaf || leaf.filter(Boolean).length < 4) return
  const clusters = []
  for (const i of [...upper].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  const column = (i, xs) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const oldCuts = [...cuts],
    bodyOwners = body.map((i) => column(i, cuts))
  const stubs = clusters
    .map((g) => ({
      g,
      c: column(
        {
          rect: [Math.min(...g.map((i) => i.rect[0])), 0, Math.max(...g.map((i) => i.rect[2])), 0]
        },
        cuts
      )
    }))
    .filter(({ c }) => c >= 0 && !leaf[c])
  for (const { c } of stubs)
    for (const boundary of [c, c + 1]) {
      if (boundary === 0 || boundary === cuts.length - 1) continue
      const left = [
        ...body.filter((i, n) => bodyOwners[n] === boundary - 1),
        ...lower.filter((i) => column(i, oldCuts) === boundary - 1),
        ...stubs.filter((s) => s.c === boundary - 1).flatMap((s) => s.g)
      ]
      const right = [
        ...body.filter((i, n) => bodyOwners[n] === boundary),
        ...lower.filter((i) => column(i, oldCuts) === boundary),
        ...stubs.filter((s) => s.c === boundary).flatMap((s) => s.g)
      ]
      if (!left.length || !right.length) return
      const end = Math.max(...left.map((i) => i.rect[2])),
        start = Math.min(...right.map((i) => i.rect[0]))
      if (end >= start) return
      if (end > cuts[boundary] || start < cuts[boundary]) cuts[boundary] = (end + start) / 2
    }
  if (body.some((i, n) => column(i, cuts) !== bodyOwners[n]) || !readSourceRow(lower, cuts)) return
  const spans = [],
    parents = []
  for (const group of clusters) {
    const l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2])),
      center = (l + r) / 2
    const c = cuts.slice(1).findIndex((x) => center < x)
    if (c < 0) return
    if (!leaf[c] && l >= cuts[c] && r <= cuts[c + 1])
      spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
    else parents.push(group)
  }
  if (parents.length < 2 || parents.length > 4) return
  const occupied = leaf.map((v, c) => (v ? c : -1)).filter((c) => c >= 0)
  if (occupied.some((c, n) => n && c !== occupied[n - 1] + 1)) return
  const answers = []
  const visit = (n, start, plan) => {
    if (n === parents.length) {
      if (start === occupied.at(-1) + 1) answers.push(plan)
      return
    }
    const group = parents[n],
      l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2]))
    for (let end = start + 2; end <= occupied.at(-1) + 1; end++)
      if (
        l >= cuts[start] &&
        r <= cuts[end] &&
        Math.abs((l + r - cuts[start] - cuts[end]) / 2) < height * 0.8
      )
        visit(n + 1, end, [...plan, { row: 0, column: start, rowSpan: 1, colSpan: end - start }])
  }
  visit(0, occupied[0], [])
  if (
    answers.length !== 1 ||
    !hasUniqueRecordTokens(head, [
      ...clusters,
      ...cuts
        .slice(1)
        .map((_, c) => lower.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]))
        .filter((g) => g.length)
    ])
  )
    return
  const split =
    (Math.max(...upper.map((i) => i.baseline)) + Math.min(...lower.map((i) => i.baseline))) / 2
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans: [...spans, ...answers[0]]
  }
}

function recoverNativeFullWidthSections(source, cuts, edges, frame, height) {
  const answers = []
  for (const edge of edges.filter(
    (r) => r[1] > frame[1] + height && r[1] < frame[1] + height * 5
  )) {
    const head = source.filter((i) => i.baseline < edge[1]),
      body = groupSourceRowsWithScripts(
        source.filter((i) => !head.includes(i)),
        height,
        0.2
      )
    if (!head.length || !body) continue
    const sections = [],
      sectionLines = []
    let measures = 0,
      valid = true
    for (let n = 0; n < body.length; n++) {
      const g = body[n],
        v = readSourceRow(g, cuts),
        scalar = (x) => /^(?:[<>≤≥−–+-]?\d[\d.,()[\]±−–+\-%*/=<>≤≥]*|[—–-])$/.test(x)
      if (v && v.filter(scalar).length >= 2 && v.slice(2).every((x) => !x || scalar(x))) {
        measures++
        continue
      }
      const line = [...g].sort((a, b) => a.rect[0] - b.rect[0]),
        left = line[0].rect[0],
        right = Math.max(...line.map((i) => i.rect[2])),
        last = n ? Math.max(...body[n - 1].map((i) => i.baseline)) : edge[1]
      const border = edges.filter(
        (r) =>
          r[1] >= last &&
          r[1] < Math.min(...g.map((i) => i.baseline)) &&
          Math.min(...g.map((i) => i.baseline)) - r[1] < height * 1.5
      )
      if (
        Math.abs(left - frame[0]) > height ||
        !g.some((i) => /\p{L}{4}/u.test(i.text)) ||
        border.length !== 1 ||
        line.some(
          (i, k) =>
            k && i.rect[0] - Math.max(...line.slice(0, k).map((a) => a.rect[2])) > height * 0.65
        ) ||
        Math.max(...g.filter((i) => i.height >= height * 0.8).map((i) => i.baseline)) -
          Math.min(...g.filter((i) => i.height >= height * 0.8).map((i) => i.baseline)) >
          height * 0.2
      ) {
        valid = false
        break
      }
      sections.push(n)
      sectionLines.push({ g, left, right })
    }
    // A short setting line inherits a full-width scope only from two other
    // independently ruled setting lines, with the same source size and inset.
    if (sectionLines.some((s) => s.right <= cuts[1])) {
      const peers = sectionLines.filter((s) => s.right > cuts[1])
      if (
        peers.length < 2 ||
        sectionLines.some(
          (s) =>
            Math.abs(s.left - peers[0].left) > height * 0.1 ||
            s.g.some(
              (i) =>
                Math.abs(i.height - peers[0].g[0].height) > height * 0.1 ||
                ((peers[0].g[0].font ?? peers[0].g[0].fontName) !== undefined &&
                  (i.font ?? i.fontName) !== (peers[0].g[0].font ?? peers[0].g[0].fontName))
            )
        )
      )
        valid = false
    }
    if (
      valid &&
      measures >= 3 &&
      sections.length >= 1 &&
      hasUniqueRecordTokens(source, [head, ...body])
    )
      answers.push({ head, body, sections })
  }
  return answers.length === 1 ? answers[0] : undefined
}

function recoverSingleTierParentScopes(head, cuts, body, height) {
  const grouped = groupSourceRowsWithScripts(head, height, 0.2)
  if (!grouped || grouped.length !== 1) return
  const clusters = []
  for (const i of [...head].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = clusters.at(-1)
    if (last && i.rect[0] - Math.max(...last.map((a) => a.rect[2])) < height * 0.45) last.push(i)
    else clusters.push([i])
  }
  const scalar = (x) => /^[<>≤≥−–+-]?\d[\d.,()[\]±−–+\-%*/=<>≤≥]*$/.test(x)
  const measured = body
    .map((g) => readSourceRow(g, cuts))
    .filter((v) => v && v.filter(scalar).length >= 2)
  if (measured.length < 3) return
  const leading = cuts.slice(1).findIndex((_, c) => measured.some((v) => scalar(v[c])))
  if (
    leading < 1 ||
    leading > 2 ||
    clusters.length >= cuts.length - 1 ||
    clusters.length - leading < 2
  )
    return
  for (let c = 0; c < leading; c++)
    if (clusters[c].some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
  const parents = clusters.slice(leading),
    answers = []
  const visit = (n, start, plan) => {
    if (n === parents.length) {
      if (start === cuts.length - 1) answers.push(plan)
      return
    }
    const group = parents[n],
      l = Math.min(...group.map((i) => i.rect[0])),
      r = Math.max(...group.map((i) => i.rect[2]))
    for (let end = start + 2; end < cuts.length; end++)
      if (
        l >= cuts[start] &&
        r <= cuts[end] &&
        Math.abs((l + r - cuts[start] - cuts[end]) / 2) < height
      )
        visit(n + 1, end, [...plan, { row: 0, column: start, rowSpan: 1, colSpan: end - start }])
  }
  visit(0, leading, [])
  if (answers.length !== 1) return
  return {
    rows: [
      [
        cuts[0],
        Math.min(...head.map((i) => i.rect[1])),
        cuts.at(-1),
        Math.max(...head.map((i) => i.rect[3]))
      ]
    ],
    spans: answers[0]
  }
}
