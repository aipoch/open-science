/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  readSourceRow
} from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// Zero advance is meaningful for an overprinted negation, but is not a valid
// ordinary font box. Keep its original owner and prove the exact equality it
// overprints; the positive-width fonts still use the shared all-carrier guard.
export function recoverNativeOverlayMathRecords(table, items, captions, rules) {
  const p = closedFrame(table, items, captions, rules)
  if (!p || p.captionCount !== 1) return
  const { em, opening, divider, closing, source, header, body } = p,
    marks = source.filter((i) => i.rect[0] === i.rect[2]),
    fonts = source.filter((i) => i.rect[2] > i.rect[0]),
    near = (a, b) => Math.abs(a - b) < em * 0.00001
  if (
    !marks.length ||
    source.length !== marks.length + fonts.length ||
    !proveNativeUniqueWholeFonts(fonts, items) ||
    fonts.some(
      (i) =>
        i.sourceItem.pageNumber !== fonts[0].sourceItem.pageNumber ||
        Object.keys(i.sourceItem).some((k) => !['pageNumber', 'index', 'text'].includes(k))
    ) ||
    source.some(
      (i) =>
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        !near(i.rect[3], i.baseline) ||
        !near(i.rect[3] - i.rect[1], i.height)
    )
  )
    return
  const overlays = new Map(),
    origins = new Set()
  for (const mark of marks) {
    const origin = mark.sourceItem
    if (
      mark.text !== '\u0338' ||
      !body.includes(mark) ||
      !origin ||
      !Number.isSafeInteger(origin.pageNumber) ||
      origin.pageNumber < 1 ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      origin.text !== mark.text ||
      Object.keys(origin).some((k) => !['pageNumber', 'index', 'text'].includes(k)) ||
      Object.keys(mark).some((k) => k !== 'sourceItem' && /^source/u.test(k))
    )
      return
    const key = `${origin.pageNumber}:${origin.index}`
    let count = 0
    const visit = (o) => {
      if (!o || typeof o !== 'object') return
      if (o.pageNumber === origin.pageNumber && o.index === origin.index) count++
      for (const value of Object.values(o)) visit(value)
    }
    // The shared guard above has already rejected cycles and excessive depth.
    items.forEach(visit)
    if (count !== 1 || origins.has(key) || origin.pageNumber !== fonts[0].sourceItem.pageNumber)
      return
    origins.add(key)
    const anchors = body.filter(
      (i) =>
        /^=\s*[−+-]?\d+(?:\.\d+)?$/u.test(i.text) &&
        i.rect[2] > i.rect[0] &&
        near(i.rect[0], mark.rect[0]) &&
        near(i.baseline, mark.baseline) &&
        near(i.height, mark.height)
    )
    if (anchors.length !== 1 || [...overlays.values()].includes(anchors[0])) return
    overlays.set(mark, anchors[0])
  }
  const projections = []
  for (const i of [...fonts].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < em * 0.65) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (
    projections.length !== 3 ||
    projections.slice(1).some((r, n) => r[0] - projections[n][1] < em * 0.3)
  )
    return
  const cuts = [
      opening[0],
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      opening[2]
    ],
    grouped = (g) =>
      groupSourceRowsWithScripts(
        [...g].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        em,
        0.3
      ),
    heads = grouped(header),
    physical = grouped(body),
    records = [],
    lane = (g, c) => g.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
  if (
    heads?.length !== 1 ||
    !readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t)) ||
    !physical ||
    !hasUniqueRecordTokens(source, [header, ...physical]) ||
    marks.some((m) => !cuts.slice(1, -1).some((x, n) => m.rect[0] > cuts[n] && m.rect[0] < x)) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    ) ||
    rules.some(
      (r) =>
        r[0] < opening[2] &&
        r[2] > opening[0] &&
        r[1] > opening[1] &&
        r[1] < closing[1] &&
        !(
          near(r[1], divider[1]) &&
          near(r[3], divider[1]) &&
          near(r[0], opening[0]) &&
          near(r[2], opening[2])
        )
    )
  )
    return
  for (const row of physical) {
    // Omit the separately proved overlays from recognition only. They remain
    // in the row packet, the emitted cell owners and its original regions.
    const v = readSourceRow(
      row.filter((i) => !overlays.has(i)),
      cuts
    )
    if (!v) return
    if (v.every(Boolean)) {
      const result = lane(row, 2)
      if (
        result.length !== 1 ||
        !/^\p{L}[\p{L}.\s]*\d+(?:\.\d+)*$/u.test(result[0].text) ||
        v.slice(0, 2).some((t) => !/[=<>≤≥≡±×+()]/u.test(t))
      )
        return
      records.push([...row])
    } else if (
      v[0] &&
      v[1] &&
      !v[2] &&
      records.length &&
      !v.slice(0, 2).some((t) => /[=<>≤≥≡]/u.test(t))
    ) {
      const prior = records.at(-1),
        a = lane(row, 0),
        b = lane(row, 1)
      for (const [c, g] of [
        [0, a],
        [1, b]
      ]) {
        const previous = lane(prior, c),
          gap = Math.min(...g.map((i) => i.baseline)) - Math.max(...previous.map((i) => i.baseline))
        if (
          gap < em * 0.8 ||
          gap > em * 1.8 ||
          !near(Math.min(...g.map((i) => i.rect[0])), Math.min(...previous.map((i) => i.rect[0])))
        )
          return
      }
      prior.push(...row)
    } else return
  }
  if (
    records.length < 3 ||
    records.length > 12 ||
    physical.length <= records.length ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const bounds = records.map((g) => [
    Math.min(...g.map((i) => i.rect[1])),
    Math.max(...g.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const edges = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cuts,
    groups: [header, ...records],
    rowRects: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
    headerRows: 1,
    baselineHeight: em,
    consumed: source,
    combiningOperators: overlays,
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    repair: 'native-body-records-recovered'
  }
}

// Serialization copies are local to a fully proved plan. Whole source tokens
// are never changed or replaced in the ownership packet.
export function nativeMathOverlaySerialization(items, overlays) {
  if (!(overlays instanceof Map) || !overlays.size) return items
  const active = [...overlays].filter(
    ([mark, anchor]) => items.includes(mark) && items.includes(anchor)
  )
  if (!active.length) return items
  return items
    .filter((i) => !active.some(([mark]) => mark === i))
    .map((i) =>
      active.some(([, anchor]) => anchor === i)
        ? { ...i, text: i.text.replace(/^=/u, '=\u0338') }
        : i
    )
}

// Independent full-width strokes enclose a complete source table. A detector's
// crop may miss an outer glyph, but all intersecting native text must fit the
// closed frame; no text may be silently dropped to make a record proof succeed.
function closedFrame(table, items, captions, rules) {
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
    em = median(near.map((i) => i.height))
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  // A typographical double opening rule is one frame edge, not a header row.
  if (full.length === 4 && full[1][1] - full[0][1] < em * 0.25) full.splice(1, 1)
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const [opening, divider, closing] = full,
    source = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  const topAccent = (i) =>
    /^[¯ˉ]$/.test(i.text) &&
    opening[1] - i.rect[1] <= em * 0.1 &&
    source.some(
      (a) =>
        a !== i &&
        a.rect[1] >= opening[1] &&
        a.baseline > i.baseline &&
        a.baseline - i.baseline < em * 0.35 &&
        a.rect[0] < i.rect[2] &&
        a.rect[2] > i.rect[0]
    )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        (i.rect[1] < opening[1] && !topAccent(i)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const captionCount = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < em * 8) ||
        (c.rect[1] > closing[1] && c.rect[1] - closing[1] < em * 3))
  ).length
  if (captionCount > 1) return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (!header.length || !body.length || !hasUniqueRecordTokens(source, [header, body])) return
  return { em, opening, divider, closing, source, header, body, captionCount }
}

// A complete three-field header and repeated simultaneous text/count anchors
// distinguish records from wrapped mathematical descriptions. Only the last
// field may continue; every original token must keep a unique logical owner.
export function recoverNativeWrappedMathRecords(table, items, captions, rules) {
  const terminal = recoverNativeTerminalFieldContinuationGrid(table, items, captions, rules)
  if (terminal) return terminal
  const p = closedFrame(table, items, captions, rules)
  if (!p || !p.captionCount) return
  const { em, opening, divider, closing, source, header, body } = p,
    projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < em * 0.65) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (
    projections.length !== 3 ||
    projections.slice(1).some((r, n) => r[0] - projections[n][1] < em * 0.3)
  )
    return
  const cuts = [
    Math.min(opening[0], projections[0][0]),
    ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
    Math.max(opening[2], projections.at(-1)[1])
  ]
  if (!readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t))) return
  const physical = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline),
      em,
      0.3
    ),
    records = []
  if (!physical) return
  for (const row of physical) {
    const v = readSourceRow(row, cuts)
    if (!v) return
    if (/\p{L}/u.test(v[0]) && /^\d+$/.test(v[1]) && v[2]) records.push([...row])
    else if (
      !v[0] &&
      !v[1] &&
      v[2] &&
      records.length &&
      row[0].baseline - records.at(-1).at(-1).baseline < em * 2.5
    )
      records.at(-1).push(...row)
    else return
  }
  if (
    records.length < 3 ||
    physical.length <= records.length ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...r.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const ys = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [cuts[0], opening[1], cuts.at(-1), closing[1]],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// A blank stub alone never joins records. Here two independent fields both
// continue: an unfinished native assignment list and a grammatical prose tail.
// Complete three-lane ink projections, repeated anchor baselines and the native
// closing rule bind the whole terminal record without using the stub's label.
export function recoverNativeTerminalFieldContinuationGrid(table, items, captions, rules) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        (!valid(i.rect) ||
          !Number.isFinite(i.height) ||
          i.height <= 0 ||
          !Number.isFinite(i.baseline))
    ) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return
  const p = closedFrame(table, items, captions, rules)
  if (!p || p.captionCount !== 1) return
  const { em, opening, divider, closing, source, header, body } = p,
    origins = new Set(),
    frame = [opening[0], opening[1], opening[2], closing[1]]
  if (
    source.some(
      (i) =>
        !i.sourceItem ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0 ||
        !Number.isSafeInteger(i.sourceItem.pageNumber) ||
        i.sourceItem.pageNumber < 1 ||
        i.sourceItem.text !== i.text ||
        origins.has(i.sourceItem.index) ||
        !origins.add(i.sourceItem.index) ||
        i.rect.some((v, n) => (n < 2 ? v < frame[n] - 1e-6 : v > frame[n] + 1e-6))
    ) ||
    source.some((i) => i.sourceItem.pageNumber !== source[0].sourceItem.pageNumber) ||
    table.structure.objects.filter((o) => o.label === 'table column').length !== 3
  )
    return
  if (
    rules.some(
      (r) =>
        r[0] < frame[2] &&
        r[2] > frame[0] &&
        r[1] > frame[1] &&
        r[1] < frame[3] &&
        !(
          r[1] === r[3] &&
          Math.abs(r[1] - divider[1]) < em * 0.002 &&
          Math.abs(r[0] - frame[0]) < em * 0.002 &&
          Math.abs(r[2] - frame[2]) < em * 0.002
        )
    )
  )
    return
  if (
    rules.some(
      (r) =>
        r[0] === r[2] && r[0] > frame[0] && r[0] < frame[2] && r[1] < frame[3] && r[3] > frame[1]
    )
  )
    return
  const projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < em * 0.65) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (projections.length !== 3) return
  const cuts = [
      frame[0],
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      frame[2]
    ],
    physical = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      em,
      0.1
    ),
    heads = groupSourceRowsWithScripts(
      [...header].sort((a, b) => a.baseline - b.baseline),
      em,
      0.05
    )
  if (
    heads?.length !== 1 ||
    !readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t)) ||
    !physical ||
    physical.length < 5 ||
    physical.length > 20
  )
    return
  const values = physical.map((row) => readSourceRow(row, cuts)),
    bounds = physical.map((row) => [
      Math.min(...row.map((i) => i.rect[1])),
      Math.max(...row.map((i) => i.rect[3]))
    ]),
    baselines = physical.map((row) =>
      row.filter((i) => i.height >= em * 0.8).map((i) => i.baseline)
    ),
    tail = physical.at(-1),
    head = physical.at(-2),
    tailValues = values.at(-1),
    headValues = values.at(-2)
  if (
    values.some((v) => !v) ||
    values.slice(0, -1).some((v) => v.some((t) => !t)) ||
    tailValues[0] ||
    !tailValues[1] ||
    !tailValues[2] ||
    physical.some((row) =>
      row.some((i) => !cuts.slice(1).some((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x))
    ) ||
    baselines.some((b) => !b.length || b.some((y) => Math.abs(y - b[0]) > em * 0.1)) ||
    bounds.some(
      (r, n) =>
        n &&
        (r[0] <= bounds[n - 1][1] ||
          baselines[n][0] - baselines[n - 1][0] < em * 0.9 ||
          baselines[n][0] - baselines[n - 1][0] > em * 1.8)
    )
  )
    return
  const lane = (row, c) => row.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]),
    first = physical.slice(0, -1).map((row) => lane(row, 0))
  if (
    first.some((row) => !row.length || row.some((i) => Math.abs(i.height - em) > em * 0.02)) ||
    first.some(
      (row) =>
        Math.abs(
          Math.min(...row.map((i) => i.rect[0])) - Math.min(...first[0].map((i) => i.rect[0]))
        ) >
        em * 0.05
    )
  )
    return
  for (const c of [1, 2]) {
    const a = lane(head, c),
      b = lane(tail, c)
    if (
      !a.length ||
      !b.length ||
      Math.abs(Math.min(...a.map((i) => i.rect[0])) - Math.min(...b.map((i) => i.rect[0]))) >
        em * 0.05
    )
      return
  }
  // Split only top-level commas. Commas within distributions/functions are
  // part of their unchanged original mathematical field, not record evidence.
  const assignments = (text, unfinished) => {
    const compact = text.replace(/\s/gu, ''),
      stack = [],
      parts = []
    let start = 0
    for (let n = 0; n < compact.length; n++) {
      const c = compact[n]
      if (c === '(' || c === '[') stack.push(c)
      else if (c === ')' || c === ']') {
        if (stack.pop() !== (c === ')' ? '(' : '[')) return false
      } else if (c === ',' && !stack.length) {
        parts.push(compact.slice(start, n))
        start = n + 1
      }
    }
    if (stack.length || compact.endsWith(',') !== unfinished) return false
    if (start < compact.length) parts.push(compact.slice(start))
    return parts.length >= 2 && parts.every((t) => /^\p{L}[\p{L}\p{N}]*[=∼].+$/u.test(t))
  }
  const proseHead = lane(head, 2),
    proseTail = lane(tail, 2)
  if (
    proseHead.length !== 1 ||
    proseTail.length !== 1 ||
    !assignments(headValues[1], true) ||
    !assignments(tailValues[1], false) ||
    !/\b(?:over|under|with|without|for|of|in|on|by|through|between|and|or)\s*$/u.test(
      proseHead[0].text
    ) ||
    !/^[a-z]{2,}\b/u.test(proseTail[0].text) ||
    proseTail[0].text.trim().split(/\s+/u).length < 2 ||
    closing[1] - bounds.at(-1)[1] >= em ||
    !hasUniqueRecordTokens(source, [header, ...physical])
  )
    return
  const edges = [
    frame[1],
    divider[1],
    ...bounds.slice(1, -1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    frame[3]
  ]
  return {
    cropRect: frame,
    rows: edges.slice(1).map((y, n) => [frame[0], edges[n], frame[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], frame[1], x, frame[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Mathematical expressions are fields even when they contain no numerals.
// Every native row must independently repeat the complete header's leaf lanes,
// and positive gutters must remain empty across *all* original source glyphs.
export function recoverNativeMathFieldRecords(table, items, captions, rules) {
  const p = closedFrame(table, items, captions, rules)
  if (!p) return recoverNativeMathSummaryRecords(table, items, captions, rules)
  const { em, opening, divider, closing, source, header, body } = p,
    grouped = (row) =>
      groupSourceRowsWithScripts(
        [...row].sort((a, b) => a.baseline - b.baseline),
        em,
        0.3
      ),
    heads = grouped(header),
    records = grouped(body)
  if (
    heads?.length !== 1 ||
    !records ||
    records.length < 2 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const lanes = (row) => {
    const groups = []
    for (const i of [...row].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = groups.at(-1)
      if (last && i.rect[0] - Math.max(...last.map((j) => j.rect[2])) < em * 0.65) last.push(i)
      else groups.push([i])
    }
    return groups
  }
  const groups = [lanes(header), ...records.map(lanes)],
    count = groups[0].length
  if (
    count < 3 ||
    count > 10 ||
    groups.some((g) => g.length !== count) ||
    groups[0].some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
    !body.some((i) => /[=<>±×+()]/.test(i.text))
  )
    return
  const cuts = [Math.min(opening[0], ...source.map((i) => i.rect[0]))]
  for (let c = 1; c < count; c++) {
    const a = Math.max(...groups.flatMap((g) => g[c - 1].map((i) => i.rect[2]))),
      b = Math.min(...groups.flatMap((g) => g[c].map((i) => i.rect[0])))
    if (b - a < em * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(Math.max(opening[2], ...source.map((i) => i.rect[2])))
  if ([header, ...records].some((r) => !readSourceRow(r, cuts)?.every(Boolean))) return
  // A continued table can repeat its complete column header on the next page
  // without repeating the caption. Require several numerical measurement
  // leaves in every one of many complete records, in addition to the frame.
  if (
    !p.captionCount &&
    (count < 5 ||
      records.length < 8 ||
      records.some(
        (r) =>
          readSourceRow(r, cuts)
            .slice(2)
            .filter((v) => /\d/.test(v)).length < 2
      ))
  )
    return
  // Accents can have an em-high nominal glyph box extending into the prior
  // line's box. Their independently proved row owner and disjoint glyph
  // centers preserve them without inventing an extra mathematical record.
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => (i.rect[1] + i.rect[3]) / 2)),
    Math.max(...r.map((i) => (i.rect[1] + i.rect[3]) / 2))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const ys = [
    Math.min(opening[1], ...header.map((i) => i.rect[1])),
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [cuts[0], ys[0], cuts.at(-1), closing[1]],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], ys[0], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// An independently ruled final summary can have a true empty description.
// Prove the complete mathematical records above it first; the fourth rule
// bounds a single textual stub and one numeric field, not another paragraph.
export function recoverNativeMathSummaryRecords(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.rect[1] < crop[3] &&
        i.rect[3] > crop[1]
    ),
    em = median(near.map((i) => i.height))
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 4 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const separator = full[2],
    closing = full[3],
    prefix = recoverNativeMathFieldRecords(
      { ...table, cropRect: [crop[0], crop[1], crop[2], separator[1]] },
      items,
      captions,
      rules.filter((r) => r[1] <= separator[1] + 0.02)
    )
  if (!prefix || prefix.columns.length !== 3 || prefix.rows.length < 4) return
  const tail = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < closing[2] &&
        i.rect[2] > closing[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > separator[1]
    ),
    physical = groupSourceRowsWithScripts(
      [...tail].sort((a, b) => a.baseline - b.baseline),
      em,
      0.3
    ),
    cuts = [prefix.columns[0][0], ...prefix.columns.map((c) => c[2])]
  if (
    !physical ||
    physical.length !== 1 ||
    tail.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < closing[0] - 0.02 ||
        i.rect[2] > closing[2] + 0.02 ||
        i.rect[1] < separator[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const values = readSourceRow(tail, cuts)
  if (
    !values ||
    !/\p{L}/u.test(values[0]) ||
    values[1] ||
    !/^(?:≈\s*)?[\d,]+$/u.test(values[2]) ||
    closing[1] - separator[1] > em * 3 ||
    !hasUniqueRecordTokens([...prefix.ownedTokens, ...tail], [[...prefix.ownedTokens], tail])
  )
    return
  return {
    ...prefix,
    cropRect: [prefix.cropRect[0], prefix.cropRect[1], prefix.cropRect[2], closing[1]],
    rows: [...prefix.rows, [cuts[0], separator[1], cuts.at(-1), closing[1]]],
    columns: prefix.columns.map((c) => [c[0], c[1], c[2], closing[1]]),
    ownedTokens: new Set([...prefix.ownedTokens, ...tail])
  }
}
