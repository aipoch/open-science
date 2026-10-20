/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { isDeepStrictEqual } from 'node:util'
import {
  proveNativeCompleteRuledSourcePacket,
  nativeChangedCellOrigins
} from './literature-pdf-native-leaf-record-repair.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { splitNativeMeasuredFields } from './literature-pdf-native-header-grid.mjs'
import { nativeWhitespaceGaps } from './literature-pdf-symbol-text.mjs'
import { measuredSourceRanges } from './literature-pdf-source-segments.mjs'
const bounds = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const text = (items) => items.map((i) => i.text).join('')

// A native split can share its parent identity, but only disjoint measured
// ranges can own different glyphs. Whole-item aliases cannot prove a reorder.
function hasNoncompetingStackSources(items) {
  const claims = new Map()
  for (const item of items) {
    const segment = item.sourceSegment ?? item.sourceToken?.sourceSegment,
      whole = item.sourceItem ?? item.sourceToken?.sourceItem,
      origin = segment ?? whole
    if (!origin) continue
    if (
      (segment && item.sourceItem) ||
      !Number.isSafeInteger(origin.pageNumber) ||
      origin.pageNumber < 1 ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      typeof origin.text !== 'string' ||
      (!segment && origin.text !== item.text) ||
      [
        item.sourceItem,
        item.sourceToken?.sourceItem,
        item.sourceSegment,
        item.sourceToken?.sourceSegment
      ]
        .filter(Boolean)
        .some(
          (other) =>
            other.pageNumber !== origin.pageNumber ||
            other.index !== origin.index ||
            other.text !== origin.text ||
            (other.start !== undefined &&
              (other.start !== segment?.start ||
                other.end !== segment?.end ||
                !Array.isArray(other.rect) ||
                other.rect.length !== 4 ||
                other.rect.some(
                  (v, n) => !Number.isFinite(v) || Math.abs(v - item.rect[n]) > 1e-6
                )))
        )
    )
      return false
    const start = segment?.start ?? 0,
      end = segment?.end ?? origin.text.length
    if (
      segment &&
      (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > origin.text.length ||
        origin.text.slice(start, end) !== item.text ||
        !Array.isArray(segment.rect) ||
        segment.rect.length !== 4 ||
        segment.rect.some((v, n) => !Number.isFinite(v) || Math.abs(v - item.rect[n]) > 1e-6))
    )
      return false
    const key = `${origin.pageNumber}:${origin.index}`,
      previous = claims.get(key) ?? []
    if (
      previous.some(
        (claim) =>
          claim.text !== origin.text || Math.min(claim.end, end) > Math.max(claim.start, start)
      )
    )
      return false
    previous.push({ text: origin.text, start, end })
    claims.set(key, previous)
  }
  return true
}

// A same-TJ field gutter may separate a whole stub from its central value only
// beside four complete serial uncertainty peers. The raw page packet and every
// existing body owner must close before either cell receives a new projection.
export function recoverNativeFusedStackedScalarOwners(table, items, rules, runs, context) {
  const crop = table.cropRect,
    cells = table.cells,
    valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite),
    same = (a, b) =>
      a.text === b.text &&
      a.baseline === b.baseline &&
      a.height === b.height &&
      valid(a.rect) &&
      valid(b.rect) &&
      a.rect.every((v, n) => Math.abs(v - b.rect[n]) < 0.02)
  if (table.readingRotation !== 0 || !valid(crop) || !cells?.length || !Array.isArray(runs)) return
  if (
    !context?.content ||
    !context.operators ||
    !context.viewport ||
    cells.filter(
      (c) => c.column === 1 && c.rowSpan === 1 && c.colSpan === 1 && c.sourceTokens?.length >= 9
    ).length !== 5
  )
    return
  const nearby = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[1]
  )
  const heights = nearby.map((i) => i.height).sort((a, b) => a - b),
    height = heights[heights.length >> 1]
  if (!(height > 0) || !Number.isFinite(height)) return
  const full = joinHorizontalTableRules(rules).filter(
    (r) =>
      r.every(Number.isFinite) &&
      Math.abs(r[0] - crop[0]) < height * 2 &&
      Math.abs(r[2] - crop[2]) < height * 2 &&
      r[1] >= crop[1] - height &&
      r[1] <= crop[3] + height
  )
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.1 || Math.abs(r[2] - full[0][2]) > 0.1)
  )
    return
  const frame = [full[0][0], full[0][1], full[0][2], full[2][1]],
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect[0] < frame[2] &&
        i.rect[2] > frame[0] &&
        i.rect[1] < frame[3] &&
        i.rect[3] > frame[1]
    )
  if (!proveNativeCompleteRuledSourcePacket(source, rules, context, frame)) return
  const body = source.filter((i) => i.baseline > full[1][1] && i.baseline < full[2][1]),
    assigned = cells.flatMap((c) =>
      (c.sourceTokens ?? []).map((t) => ({ cell: c, token: t, owner: t.sourceToken ?? t }))
    )
  if (
    !body.length ||
    cells.some(
      (c) =>
        !Array.isArray(c.sourceTokens) ||
        !Array.isArray(c.sourceRects) ||
        c.sourceRects.length !== c.sourceTokens.length ||
        c.sourceTokens.some(
          (t) =>
            !valid(t.rect) ||
            c.sourceRects.filter((r) => valid(r) && isDeepStrictEqual(t.rect, r)).length !== 1
        ) ||
        c.sourceRects.some(
          (r) =>
            !valid(r) || c.sourceTokens.filter((t) => isDeepStrictEqual(t.rect, r)).length !== 1
        ) ||
        table.grid?.[c.row]?.[c.column] !== c.text
    )
  )
    return
  for (const font of body) if (assigned.filter((a) => same(a.owner, font)).length !== 1) return
  const bodyCells = cells.filter((c) =>
    c.sourceTokens.some((t) => body.some((i) => same(t.sourceToken ?? t, i)))
  )
  if (
    bodyCells.some(
      (c) =>
        c.sourceTokens.some((t) => body.filter((i) => same(t.sourceToken ?? t, i)).length !== 1) ||
        !nativeChangedCellOrigins([c], items, c.sourceTokens)
    )
  )
    return
  const peers = bodyCells
      .filter((c) => c.column === 1)
      .map((cell) => ({
        cell,
        proof: recoverNativeStackedUncertainty(
          cell.sourceTokens.map((t) => body.find((i) => same(i, t))),
          rules
        )
      })),
    complete = peers.filter(({ proof }) => proof?.runs.length === 7),
    missing = peers.filter(({ proof }) => !proof)
  if (complete.length !== 4 || missing.length !== 1 || peers.length !== 5) return
  if (
    complete.some(
      ({ cell, proof }) =>
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        cell.text !== proof.runs.map((r) => r.text).join('')
    ) ||
    new Set(peers.map(({ cell }) => cell.row)).size !== 5
  )
    return
  const target = missing[0].cell,
    donor = bodyCells.find(
      (c) =>
        c.row === target.row &&
        c.column === 0 &&
        c.rowSpan === 1 &&
        c.colSpan === 1 &&
        c.sourceTokens.length === 1
    )
  if (!donor || target.rowSpan !== 1 || target.colSpan !== 1 || donor.textRuns?.length) return
  const font = body.find((i) => same(i, donor.sourceTokens[0]))
  const characters = (s) => [...s.replace(/\s/gu, '')].sort().join('')
  if (
    !font ||
    donor.sourceTokens[0].sourceToken ||
    donor.text !== font.text ||
    characters(target.text) !== characters(target.sourceTokens.map((i) => i.text).join(''))
  )
    return
  const observed = runs.filter((r) => same(r, font)),
    raw = nativeWhitespaceGaps(context.content, context.operators, context.viewport).filter((r) =>
      same(r, font)
    )
  if (observed.length !== 1 || raw.length !== 1 || !isDeepStrictEqual(observed[0], raw[0])) return
  const parts = splitNativeMeasuredFields(font, raw, font.height)
  if (
    parts?.length !== 2 ||
    !/\p{L}/u.test(parts[0].text) ||
    !/^[−-]?\d+\.\d+$/.test(parts[1].text)
  )
    return
  const [label, central] = parts,
    centers = complete.map(({ cell }) =>
      cell.sourceTokens.filter(
        (i) =>
          /^[−-]?\d+\.\d+$/.test(i.text) &&
          Math.abs(i.height - font.height) < font.height * 0.03 &&
          Math.abs(i.baseline - central.baseline) > font.height
      )
    )
  if (
    !valid(donor.rect) ||
    !valid(target.rect) ||
    label.rect[0] < donor.rect[0] - 0.02 ||
    label.rect[2] > donor.rect[2] + 0.02 ||
    central.rect[0] < target.rect[0] - 0.02 ||
    central.rect[2] > target.rect[2] + 0.02 ||
    centers.some(
      (g) =>
        g.length !== 1 ||
        Math.abs(g[0].rect[0] - central.rect[0]) > font.height * 0.03 ||
        Math.abs(g[0].rect[2] - central.rect[2]) > font.height * 0.03
    ) ||
    target.sourceTokens.some((i) => i.rect[0] < central.rect[2] - 0.02) ||
    body.some(
      (i) =>
        i !== font &&
        i.rect[0] < central.rect[0] &&
        i.rect[2] > label.rect[2] &&
        i.rect[1] < font.rect[3] &&
        i.rect[3] > font.rect[1]
    )
  )
    return
  const ranges = measuredSourceRanges(
    { str: font.text, sourceItem: font.sourceItem },
    parts.map((part) => part.text)
  )
  if (font.sourceItem && !ranges) return
  const measuredCentral = ranges
    ? { ...central, sourceItem: undefined, sourceSegment: { ...ranges[1], rect: central.rect } }
    : central
  const targetTokens = [central, ...target.sourceTokens],
    proof = recoverNativeStackedUncertainty(
      [measuredCentral, ...target.sourceTokens.map((t) => body.find((i) => same(i, t)))],
      rules
    ),
    donorOrigins = nativeChangedCellOrigins([donor], items, [label]),
    targetOrigins = nativeChangedCellOrigins([donor, target], items, targetTokens)
  if (proof?.runs.length !== 7 || !donorOrigins || !targetOrigins) return
  return { donor, target, label, targetTokens, runs: proof.runs, donorOrigins, targetOrigins }
}
// Called only after the existing cell assignments. Exactly three native
// baselines and matched smaller signed lanes witness the two scripts. Every
// original character is emitted once; no value or sign is synthesized.
export function recoverNativeStackedUncertainty(items, rules, equalFontStacks) {
  if (!hasNoncompetingStackSources(items)) return
  const labelled = recoverLabelledStackedPairs(items, rules)
  if (labelled) return labelled
  if (
    items.length < 3 ||
    items.length > 18 ||
    new Set(items).size !== items.length ||
    items.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        i.rect.some((v) => !Number.isFinite(v)) ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3]
    )
  )
    return
  const rows = []
  for (const i of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.at(-1)
    if (row && Math.abs(i.baseline - row[0].baseline) < Math.min(i.height, row[0].height) * 0.03)
      row.push(i)
    else rows.push([i])
  }
  if (rows.length !== 3) return
  for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
  const [upper, main, lower] = rows,
    height = main[0].height,
    script = upper[0].height,
    mainBox = bounds(main),
    upperBox = bounds(upper),
    lowerBox = bounds(lower),
    witnessed = equalFontStacks?.filter(
      (g) => g.tokens.size === items.length && items.every((i) => g.tokens.has(i))
    ),
    equalFont =
      witnessed?.length === 1 &&
      rows.every((row) => row.every((i) => Math.abs(i.height - height) < height * 0.03))
  const smallFontBoundary = witnessed?.length === 1 && witnessed[0].smallFontBoundary === true
  if (
    !/^[−-]?\d+\.\d+$/.test(text(main)) ||
    !/^[+−-]\d+\.\d+$/.test(text(upper)) ||
    !/^[+−-]\d+\.\d+$/.test(text(lower)) ||
    // Printed lanes determine script positions. Opposite signs can appear in
    // either order; do not swap them to impose a numerical convention.
    text(upper).startsWith('+') === text(lower).startsWith('+') ||
    // PDF font sizes may round a true three-quarter em just above 0.75.
    // A thousandth of an em tolerance retains the independent lane proof.
    (!equalFont && (script < height * 0.55 || script > height * 0.751)) ||
    rows.some((row, n) =>
      row.some(
        (i, k) =>
          Math.abs(i.height - (n === 1 ? height : script)) > height * 0.05 ||
          (k &&
            (i.rect[0] - row[k - 1].rect[2] < -height * 0.03 ||
              i.rect[0] - row[k - 1].rect[2] > height * 0.15))
      )
    )
  )
    return
  const up = main[0].baseline - upper[0].baseline,
    down = lower[0].baseline - main[0].baseline,
    gap = upperBox[0] - mainBox[2]
  if (
    up < height * (equalFont ? 0.45 : 0.2) ||
    up > height * (equalFont ? 0.6 : 0.5) ||
    down < height * (equalFont ? 0.45 : 0.15) ||
    down > height * (equalFont ? 0.6 : 0.45) ||
    gap < -height * 0.03 ||
    gap > height * 0.35 ||
    Math.abs(upperBox[0] - lowerBox[0]) > height * 0.05 ||
    Math.abs(upperBox[2] - lowerBox[2]) > height * (equalFont ? 1.5 : 0.75) ||
    upperBox[3] > lowerBox[1] + height * 0.05
  )
    return
  const box = bounds(items)
  if (
    rules.some(
      (r) =>
        (r[1] === r[3] &&
          r[1] > box[1] &&
          r[1] < box[3] &&
          r[0] < box[2] &&
          r[2] > box[0] &&
          !(
            (equalFont || smallFontBoundary) &&
            r[1] === witnessed[0].divider &&
            upper[0].baseline > r[1] &&
            r[1] - upperBox[1] <= height * (equalFont ? 0.3 : 0.01) &&
            mainBox[1] > r[1]
          )) ||
        (r[0] === r[2] && r[0] > mainBox[2] && r[0] < box[2] && r[1] < box[3] && r[3] > box[1])
    )
  )
    return
  return {
    runs: [
      { text: text(main), position: 'normal' },
      { text: text(upper), position: 'superscript' },
      { text: text(lower), position: 'subscript' }
    ],
    ownedTokens: new Set(items)
  }
}

// Two independently signed script pairs alternate with complete baseline
// labels. Their font baselines and ink lanes, rather than lexical number
// splitting, determine the order. Keep every original fragment exactly once.
function recoverLabelledStackedPairs(items, rules) {
  if (
    items.length < 9 ||
    items.length > 36 ||
    new Set(items).size !== items.length ||
    items.some(
      (i) =>
        !i.horizontal ||
        !i.text.trim() ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0) ||
        !Array.isArray(i.rect) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        Math.abs(i.rect[3] - i.baseline) > 0.02 ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02 ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3]
    )
  )
    return
  const height = Math.max(...items.map((i) => i.height)),
    main = items.filter((i) => Math.abs(i.height - height) < height * 0.03),
    scripts = items.filter((i) => !main.includes(i)),
    baseline = main[0]?.baseline
  if (
    main.length < 3 ||
    scripts.length < 4 ||
    main.some((i) => Math.abs(i.baseline - baseline) > height * 0.03) ||
    scripts.some((i) => i.height < height * 0.55 || i.height > height * 0.751)
  )
    return
  const groups = []
  for (const i of [...main].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && i.rect[0] - last.at(-1).rect[2] < height * 0.2) last.push(i)
    else groups.push([i])
  }
  if (
    groups.length !== 3 ||
    !/^[−-]?\d+\.\d+$/.test(text(groups[0])) ||
    groups.slice(1).some((g) => !/^\([A-Za-z]{2,12}\.?\)$/.test(text(g))) ||
    groups.some((g) => g.some((i, n) => n && i.rect[0] - g[n - 1].rect[2] < -height * 0.03))
  )
    return
  const runs = [{ text: text(groups[0]), position: 'normal' }],
    owned = new Set(main)
  for (let n = 1; n < groups.length; n++) {
    const left = bounds(groups[n - 1])[2],
      right = bounds(groups[n])[0],
      pair = scripts.filter((i) => i.rect[0] >= left - height * 0.03 && i.rect[2] <= right + 0.02),
      upper = pair.filter((i) => i.baseline < baseline),
      lower = pair.filter((i) => i.baseline > baseline)
    if (!upper.length || !lower.length || pair.length !== upper.length + lower.length) return
    for (const row of [upper, lower]) row.sort((a, b) => a.rect[0] - b.rect[0])
    const up = baseline - upper[0].baseline,
      down = lower[0].baseline - baseline,
      a = bounds(upper),
      b = bounds(lower)
    if (
      !/^\+\d+\.\d+$/.test(text(upper)) ||
      !/^[−-]\d+\.\d+$/.test(text(lower)) ||
      up < height * 0.2 ||
      up > height * 0.5 ||
      down < height * 0.15 ||
      down > height * 0.45 ||
      a[0] - left < -height * 0.03 ||
      a[0] - left > height * 0.35 ||
      right - Math.max(a[2], b[2]) < -0.02 ||
      right - Math.max(a[2], b[2]) > height * 0.15 ||
      Math.abs(a[0] - b[0]) > height * 0.05 ||
      Math.abs(a[2] - b[2]) > height * 0.75 ||
      a[3] > b[1] + height * 0.05 ||
      [upper, lower].some((row) =>
        row.some(
          (i, k) =>
            Math.abs(i.baseline - row[0].baseline) > height * 0.03 ||
            Math.abs(i.height - row[0].height) > height * 0.03 ||
            (k &&
              (i.rect[0] - row[k - 1].rect[2] < -height * 0.03 ||
                i.rect[0] - row[k - 1].rect[2] > height * 0.15))
        )
      )
    )
      return
    for (const i of pair) {
      if (owned.has(i)) return
      owned.add(i)
    }
    runs.push(
      { text: text(upper), position: 'superscript' },
      { text: text(lower), position: 'subscript' },
      { text: text(groups[n]), position: 'normal' }
    )
  }
  const box = bounds(items)
  if (
    owned.size !== items.length ||
    rules.some(
      (r) =>
        (r[1] === r[3] && r[1] > box[1] && r[1] < box[3] && r[0] < box[2] && r[2] > box[0]) ||
        (r[0] === r[2] && r[0] > box[0] && r[0] < box[2] && r[1] < box[3] && r[3] > box[1])
    )
  )
    return
  return { runs, ownedTokens: owned }
}

// Equal native em boxes alone never prove scripts. A closed, captioned frame
// with twelve native leaves and repeated complete twelve-lane records proves
// the eight paired numeric lanes before any cell text receives this exception.
export function recoverNativeEqualFontStackRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    nearby = items.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    ids = nearby.filter(
      (i) => /^\d{6,20}$/.test(i.text) && i.rect[0] < crop[0] + (crop[2] - crop[0]) * 0.15
    ),
    height = ids[0]?.height
  if (!(height > 0) || ids.length < 6 || ids.length > 60) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < height * 2 &&
        Math.abs(r[2] - crop[2]) < height * 2 &&
        r[1] > crop[1] - height &&
        r[1] < crop[3] + height
    )
    .sort((a, b) => a[1] - b[1])
  if (
    ![3, 4].includes(full.length) ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  if (
    full.length === 4 &&
    (full[1][1] - full[0][1] < height * 0.15 || full[1][1] - full[0][1] > height * 0.45)
  )
    return
  const opening = full[full.length === 4 ? 1 : 0],
    divider = full.at(-2),
    closing = full.at(-1)
  if (
    divider[1] - opening[1] < height * 2 ||
    divider[1] - opening[1] > height * 4 ||
    Math.abs(closing[1] - crop[3]) > height * 1.5 ||
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 4 &&
        c.rect[0] < closing[2] &&
        c.rect[2] > closing[0]
    ).length !== 1
  )
    return
  const source = nearby.filter((i) => i.baseline > opening[1] && i.baseline < closing[1]),
    header = source.filter((i) => i.baseline <= divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    anchors = ids.filter((i) => body.includes(i)).sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length !== ids.length ||
    body.some((i) => Math.abs(i.height - height) > height * 0.03) ||
    source.some((i) => i.rect[1] < full[0][1] - height * 0.1 || i.rect[3] > closing[1]) ||
    body.some((i) => i.rect[1] < divider[1] - height * 0.3)
  )
    return
  const main = anchors.map((a) =>
    body
      .filter((i) => Math.abs(i.baseline - a.baseline) < height * 0.03)
      .sort((a, b) => a.rect[0] - b.rect[0])
  )
  if (
    main.some(
      (row) =>
        row.length !== 12 ||
        !/^\d{6,20}$/.test(row[0].text) ||
        !row.slice(1, 3).every((i) => /\p{L}/u.test(i.text)) ||
        !/^\d+$/.test(row[3].text) ||
        !row.slice(4).every((i) => /^[−-]?\d+\.\d+$/.test(i.text))
    )
  )
    return
  const gaps = anchors.slice(1).map((a, n) => a.baseline - anchors[n].baseline),
    leading = gaps[0]
  if (
    leading < height * 1.8 ||
    leading > height * 2.2 ||
    gaps.some((g) => Math.abs(g - leading) > height * 0.03)
  )
    return
  const headingBaseline = header.find((i) => /\p{L}/u.test(i.text))?.baseline,
    leaves = header
      .filter(
        (i) => /\p{L}/u.test(i.text) && Math.abs(i.baseline - headingBaseline) < height * 0.03
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (leaves.length !== 12) return
  const centers = leaves.map((i) => (i.rect[0] + i.rect[2]) / 2),
    initial = [crop[0], ...centers.slice(1).map((x, n) => (x + centers[n]) / 2), crop[2]],
    lane = (i) => initial.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (main.some((row) => row.some((i, n) => lane(i) !== n))) return
  const records = anchors.map(() => [])
  for (const i of body) {
    const owners = anchors
      .map((a, n) => ({ a, n }))
      .filter(({ a }) => Math.abs(i.baseline - a.baseline) < height * 0.65)
    if (owners.length !== 1) return
    records[owners[0].n].push(i)
  }
  const lanes = initial.slice(1).map((_, n) => source.filter((i) => lane(i) === n)),
    cuts = [crop[0]]
  for (let c = 1; c < 12; c++) {
    const left = Math.max(...lanes[c - 1].map((i) => i.rect[2])),
      right = Math.min(...lanes[c].map((i) => i.rect[0]))
    if (right - left < height * 0.05) return
    cuts.push((left + right) / 2)
  }
  cuts.push(crop[2])
  if (
    !readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v)) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const stacks = [],
    offsets = []
  for (let n = 0; n < records.length; n++)
    for (let c = 4; c < 12; c++) {
      const group = records[n].filter((i) => lane(i) === c),
        set = { tokens: new Set(group), divider: divider[1] },
        p = recoverNativeStackedUncertainty(group, rules, [set])
      if (!p || !readSourceRow(group, cuts)) return
      const baselines = [...new Set(group.map((i) => i.baseline))].sort((a, b) => a - b)
      if (baselines.length !== 3 || Math.abs(baselines[1] - anchors[n].baseline) > height * 0.03)
        return
      offsets.push([baselines[1] - baselines[0], baselines[2] - baselines[1]])
      stacks.push(set)
    }
  if (
    offsets.some((pair) => pair.some((v, n) => Math.abs(v - offsets[0][n]) > height * 0.03)) ||
    records.some((row) => row.filter((i) => lane(i) < 4).length !== 4)
  )
    return
  const edges = [crop[1], divider[1]]
  for (let n = 1; n < records.length; n++) {
    const last = Math.max(...records[n - 1].map((i) => (i.rect[1] + i.rect[3]) / 2)),
      next = Math.min(...records[n].map((i) => (i.rect[1] + i.rect[3]) / 2))
    if (last >= next) return
    edges.push((last + next) / 2)
  }
  edges.push(crop[3])
  if (edges.some((y, n) => n && y <= edges[n - 1])) return
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    equalFontStacks: stacks,
    repair: 'native-body-records-recovered'
  }
}
