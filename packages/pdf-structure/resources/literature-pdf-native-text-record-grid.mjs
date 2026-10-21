/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  refineNativeTableBoundaryInk,
  recoverNativeClippedHeaderCrop
} from './literature-pdf-native-table-boundary-ink.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { hasDisjointNativeTableSlots } from './literature-pdf-native-table-ambiguity.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  nativeChangedCellOrigins,
  nativeCompleteRuledRecordPaintCrop
} from './literature-pdf-native-leaf-record-repair.mjs'

function completeRecordPaintBounds(source, full, rules, context) {
  if (
    !Array.isArray(context?.sourceContent?.items) ||
    context.content !== context.sourceContent ||
    context.viewport?.rotation !== 0 ||
    !Array.isArray(context.viewport.transform) ||
    context.viewport.transform.length !== 6 ||
    !context.viewport.transform.every(Number.isFinite) ||
    typeof context.viewport.convertToViewportPoint !== 'function' ||
    context.sourceContent.items.some(
      (raw) =>
        typeof raw.str === 'string' &&
        raw.str.trim() &&
        (!Array.isArray(raw.transform) ||
          raw.transform.length !== 6 ||
          !raw.transform.every(Number.isFinite) ||
          !(raw.width > 0) ||
          !(raw.height > 0))
    )
  )
    return
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    machineSame = (a, b) =>
      Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16,
    key = (o) => `${o.pageNumber}:${o.index}`,
    frame = [full[0][0], full[0][1], full[0][2], full.at(-1)[1]],
    closing = full.at(-2)[1],
    inventory = context.sourceContent.items
      .filter((i) => typeof i.str === 'string' && i.str.trim())
      .map((raw) => ({ ...raw, ...tableTextToken(raw, context.viewport, 0) }))
  if (inventory.some((i) => !valid(i.rect))) return
  const owned = inventory.filter(
    (i) =>
      i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
  )
  if (
    !owned.length ||
    !proveNativeUniqueWholeFonts(owned, inventory) ||
    owned.some(
      (i) =>
        i.rect[0] < frame[0] ||
        i.rect[2] > frame[2] ||
        i.rect[1] <= frame[1] ||
        i.rect[3] >= closing
    )
  )
    return
  const used = new Set()
  for (const raw of owned) {
    const origin = raw.sourceItem,
      parts = source.filter((i) => {
        const o = i.sourceItem ?? i.sourceSegment
        return o && key(o) === key(origin)
      }),
      coverage = Array(origin.text.length).fill(0)
    if (!parts.length) return
    for (const item of parts) {
      if (
        used.has(item) ||
        item.sourceToken ||
        item.sourceTokens ||
        item.sourceItems ||
        item.sourceSegments ||
        (item.sourceItem && item.sourceSegment) ||
        !valid(item.rect) ||
        !item.horizontal ||
        item.baseline !== raw.baseline ||
        item.height !== raw.height
      )
        return
      used.add(item)
      const o = item.sourceSegment ?? item.sourceItem,
        start = item.sourceSegment ? o.start : 0,
        end = item.sourceSegment ? o.end : origin.text.length
      if (
        o.text !== origin.text ||
        (item.rect[0] < raw.rect[0] && !machineSame(item.rect[0], raw.rect[0])) ||
        (item.rect[2] > raw.rect[2] && !machineSame(item.rect[2], raw.rect[2])) ||
        item.rect[1] !== raw.rect[1] ||
        item.rect[3] !== raw.rect[3] ||
        (!item.sourceSegment && !item.rect.every((x, n) => machineSame(x, raw.rect[n]))) ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > origin.text.length ||
        item.text !== origin.text.slice(start, end).trim() ||
        (item.sourceSegment && (!valid(o.rect) || o.rect.some((x, n) => x !== item.rect[n])))
      )
        return
      for (let n = start; n < end; n++) if (++coverage[n] > 1) return
    }
    for (let n = 0; n < origin.text.length; n++)
      if (!/\s/u.test(origin.text[n]) && coverage[n] !== 1) return
  }
  if (used.size !== source.length) return
  return nativeCompleteRuledRecordPaintCrop(frame, full, rules, context, owned)
}

// Repeated indexed records can contain attached numeric subscripts whose font
// boxes slightly overlap the next normal line. Their literal baselines and
// unique preceding stems prove ownership; an overlapping normal line cannot.
function scriptedRecordBounds(header, records, cuts, h) {
  if (cuts.length !== 4 || header.length !== 3 || records.length < 3) return
  const indices = []
  for (const record of records) {
    const normal = record.filter((i) => Math.abs(i.height - h) < h * 0.04)
    const scripts = record.filter((i) => Math.abs(i.height - h) >= h * 0.04)
    const lanes = cuts
      .slice(1)
      .map((x, n) => normal.filter((i) => i.rect[0] >= cuts[n] && i.rect[2] <= x))
    if (
      normal.length !== 5 ||
      scripts.length !== 4 ||
      lanes[0].length !== 1 ||
      lanes[1].length !== 2 ||
      lanes[2].length !== 2 ||
      !/^\d+$/.test(lanes[0][0].text.trim())
    )
      return
    indices.push(Number(lanes[0][0].text.trim()))
    if (normal.some((i) => Math.abs(i.baseline - normal[0].baseline) > h * 0.04)) return
    const stems = [...lanes[1], ...lanes[2]]
    if (stems.some((i) => !/^\p{L}+$/u.test(i.text.trim()))) return
    const owners = new Set()
    for (const script of scripts) {
      const offset = script.baseline - normal[0].baseline
      if (
        script.height < h * 0.55 ||
        script.height > h * 0.8 ||
        offset < h * 0.1 ||
        offset > h * 0.3 ||
        !/^\d+(?:\.\d+)?\(\d+\)$/.test(script.text.trim())
      )
        return
      const matches = stems.filter(
        (stem) =>
          Math.abs(stem.rect[2] - script.rect[0]) <= h * 0.04 &&
          cuts.slice(1).some((x, n) => stem.rect[0] >= cuts[n] && script.rect[2] <= x)
      )
      if (matches.length !== 1 || owners.has(matches[0])) return
      owners.add(matches[0])
    }
    if (owners.size !== 4) return
  }
  if (indices.some((v, n) => !Number.isSafeInteger(v) || (n && v !== indices[n - 1] + 1))) return
  const groups = [header, ...records]
  for (let n = 1; n < groups.length; n++) {
    const previous = groups[n - 1],
      current = groups[n]
    const normalPrevious = previous.filter((i) => Math.abs(i.height - h) < h * 0.04)
    const normalCurrent = current.filter((i) => Math.abs(i.height - h) < h * 0.04)
    if (
      Math.max(...normalPrevious.map((i) => i.rect[3])) >=
      Math.min(...normalCurrent.map((i) => i.rect[1]))
    )
      return
    const overlap =
      Math.max(...previous.map((i) => i.rect[3])) - Math.min(...current.map((i) => i.rect[1]))
    if (overlap > h * 0.02) return
    if (n === 1 && overlap > 0) return
  }
  return groups.map((row) => [
    Math.min(...row.map((i) => i.rect[1])),
    Math.max(...row.map((i) => i.rect[3]))
  ])
}

// An independently printed stub starts a record only when every value lane
// has a source item on the same baseline. Stub-free continuation lines retain
// the previous record; scripts must have a unique nearby normal baseline.
export function recoverNativeTextRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length < 2 || model.length > 6) return
  const near = items.filter(
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
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h * 1.5 &&
        r[2] - r[0] >= (crop[2] - crop[0]) * 0.9 &&
        r[2] - r[0] <= (crop[2] - crop[0]) * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 16 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const opening = full[0],
    divider = full.find((r) => r[1] - opening[1] >= h * 0.6)
  const doubleStroke =
    full.length === 5 &&
    full[1][1] - opening[1] > 0 &&
    full[1][1] - opening[1] < h * 0.3 &&
    Math.abs(full.at(-1)[1] - full.at(-2)[1] - (full[1][1] - opening[1])) < 0.05
  const closing = doubleStroke ? full.at(-2) : full.at(-1)
  if (!divider || divider === closing) return
  if (doubleStroke && near.some((i) => i.baseline > closing[1] && i.baseline < full.at(-1)[1]))
    return
  const groupRules = full.filter((r) => r[1] > divider[1] && r[1] < closing[1])
  if (
    divider[1] - opening[1] < h * 0.6 ||
    divider[1] - opening[1] > h * 2.5 ||
    closing[1] - divider[1] < h * 3
  )
    return
  if (
    !captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
          (c.rect[1] >= closing[1] - h * 0.2 && c.rect[1] - closing[1] < h * 8))
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.baseline > opening[1] &&
      i.baseline < closing[1]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        !Number.isFinite(i.baseline) ||
        i.rect.some((v) => !Number.isFinite(v)) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        i.height < h * 0.55 ||
        i.height > h * 1.04
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const mainHeader = header.filter((i) => Math.abs(i.height - h) < h * 0.04)
  if (
    mainHeader.length < 2 ||
    mainHeader.length > 4 ||
    mainHeader.some((i) => Math.abs(i.baseline - mainHeader[0].baseline) > h * 0.04)
  )
    return
  mainHeader.sort((a, b) => a.rect[0] - b.rect[0])
  // A missing leading title is not proof that its body lanes disappear.
  if (mainHeader[0].rect[0] - opening[0] > h * 2) return
  const cuts = [opening[0]],
    rough = [
      opening[0],
      ...mainHeader.slice(1).map((i, n) => (mainHeader[n].rect[2] + i.rect[0]) / 2),
      opening[2]
    ]
  const physical = []
  for (const item of body
    .filter((i) => Math.abs(i.height - h) < h * 0.04)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = physical.at(-1)
    if (row && Math.abs(row[0].baseline - item.baseline) < h * 0.04) row.push(item)
    else physical.push([item])
  }
  if (physical.length < 3 || physical.length > 80) return
  for (const item of source.filter((i) => Math.abs(i.height - h) >= h * 0.04)) {
    const owners =
      item.baseline < divider[1]
        ? [header]
        : physical.filter((r) => Math.abs(r[0].baseline - item.baseline) < h * 0.45)
    if (owners.length !== 1) return
    if (owners[0] !== header) owners[0].push(item)
  }
  for (let n = 1; n < mainHeader.length; n++) {
    let a = mainHeader[n - 1].rect[2],
      b = mainHeader[n].rect[0]
    for (const row of physical) {
      const left = row.filter((i) => (i.rect[0] + i.rect[2]) / 2 < rough[n]),
        right = row.filter((i) => (i.rect[0] + i.rect[2]) / 2 >= rough[n])
      if (left.length) a = Math.max(a, ...left.map((i) => i.rect[2]))
      if (right.length) b = Math.min(b, ...right.map((i) => i.rect[0]))
    }
    if (b - a < h * 0.15) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  const records = []
  for (const row of physical) {
    if (
      mainHeader.length !== model.length &&
      cuts
        .slice(1)
        .some(
          (x, n) =>
            n > 0 &&
            row.filter(
              (i) =>
                i.rect[0] >= cuts[n] &&
                i.rect[2] <= x &&
                /^[−+-]?\d+(?:\.\d+)?$/.test(i.text.trim())
            ).length > 1
        )
    )
      return
    const values = readSourceRow(row, cuts)
    if (
      !values ||
      row.some((i) => !cuts.slice(1).some((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x))
    )
      return
    if (values[0].trim()) {
      if (values.some((s) => !s.trim())) return
      records.push([...row])
    } else {
      if (!records.length || row[0].baseline - records.at(-1).at(-1).baseline > h * 2) return
      records.at(-1).push(...row)
    }
  }
  if (
    records.length < 3 ||
    !readSourceRow(header, cuts)?.every((s) => s.trim()) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  // Ruled prose faces may contain several physical lines of one record.
  // Parameter/value groups instead prove independent complete pairs on every
  // baseline, with at least two pairs in each native band and ink-free dividers.
  if (groupRules.length) {
    if (
      mainHeader.length !== 2 ||
      !/^(?:hyper)?parameters?$/i.test(mainHeader[0].text.trim()) ||
      !/^values?$/i.test(mainHeader[1].text.trim()) ||
      records.length !== physical.length ||
      physical.some((row) => {
        const values = readSourceRow(row, cuts)
        return !values || !/\p{L}/u.test(values[0]) || !/[\p{L}\d]/u.test(values[1])
      }) ||
      physical.filter((row) => /\d/.test(readSourceRow(row, cuts)[1])).length <
        Math.ceil(physical.length / 2) ||
      groupRules.some((rule) => body.some((i) => i.rect[1] <= rule[1] && i.rect[3] >= rule[1]))
    )
      return
    const bounds = [divider[1], ...groupRules.map((r) => r[1]), closing[1]]
    if (
      bounds
        .slice(1)
        .some(
          (bottom, n) =>
            physical.filter((row) => row[0].baseline > bounds[n] && row[0].baseline < bottom)
              .length < 2
        )
    )
      return
  }
  if (
    records.some(
      (r) =>
        new Set(
          r
            .filter((i) => Math.abs(i.height - h) < h * 0.04)
            .map((i) => Math.round(i.baseline / (h * 0.04)))
        ).size > 3
    )
  )
    return
  if (table.structure.objects.filter((o) => o.label === 'table row').length === records.length + 1)
    return
  if (
    full
      .filter((r) => r[1] > divider[1] && r[1] < closing[1])
      .some((r) => body.some((i) => i.rect[1] < r[1] && i.rect[3] > r[1]))
  )
    return
  const scriptBounds = scriptedRecordBounds(header, records, cuts, h)
  if (
    scriptBounds &&
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < full.at(-1)[1] &&
        i.rect[3] > opening[1] &&
        !source.includes(i)
    )
  )
    return
  const edges = [Math.min(...header.map((i) => i.rect[1])), divider[1]]
  for (let n = 1; n < records.length; n++) {
    const a = Math.max(...records[n - 1].map((i) => i.rect[3])),
      b = Math.min(...records[n].map((i) => i.rect[1]))
    if (b - a < h * 0.04 && !scriptBounds) return
    edges.push((a + b) / 2)
  }
  edges.push(Math.max(...body.map((i) => i.rect[3])))
  const rect = [
    Math.min(crop[0], opening[0] - 0.5),
    Math.min(crop[1], opening[1] - 0.5),
    Math.max(crop[2], opening[2] + 0.5),
    Math.max(crop[3], closing[1] + 0.5)
  ]
  return {
    cropRect: rect,
    rows: scriptBounds
      ? scriptBounds.map(([top, bottom]) => [rect[0], top, rect[2], bottom])
      : edges.slice(1).map((y, n) => [rect[0], edges[n], rect[2], y]),
    columns: cuts
      .slice(1)
      .map((x, n) => [
        n ? cuts[n] : rect[0],
        rect[1],
        n === cuts.length - 2 ? rect[2] : x,
        rect[3]
      ]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Rendering bounds must not influence the logical grouping or peer order.
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3],
  key = (f) => `${f.sourceItem?.pageNumber}:${f.sourceItem?.index}`
function nativeWholeCellVisualCrop(table, proof, inventory, rules, context) {
  if (
    !proof ||
    !valid(table.cropRect) ||
    !table.clipped?.length ||
    !context?.nativePaintIdentityGraphics ||
    !context.sourceContent?.items ||
    context.content !== context.sourceContent
  )
    return
  const owned = proof.proved.flatMap((p) => p.fonts),
    old = table.cropRect
  if (!owned.length || !proveNativeUniqueWholeFonts(owned, inventory)) return
  const bounds = [
    Math.min(...owned.map((f) => f.rect[0])),
    Math.min(...owned.map((f) => f.rect[1])),
    Math.max(...owned.map((f) => f.rect[2])),
    Math.max(...owned.map((f) => f.rect[3]))
  ]
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] && r[0] <= bounds[0] && r[2] >= bounds[2] && r[1] >= old[1] && r[1] <= old[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length !== 5 || full.some((r) => r[0] !== full[0][0] || r[2] !== full[0][2])) return
  const frame = [full[0][0], full[0][1], full[0][2], full[4][1]]
  // Both outer pairs contain no text; the middle rule exactly divides all header and body sources.
  if (
    proof.proved.some((p) =>
      p.fonts.some(
        (f) =>
          !contains(frame, f.rect) ||
          f.rect[1] <= full[1][1] ||
          f.rect[3] >= full[3][1] ||
          (p.cell.row === 0 ? f.rect[3] >= full[2][1] : f.rect[1] <= full[2][1])
      )
    )
  )
    return
  const raw = context.sourceContent.items.filter((i) => typeof i.str === 'string' && i.str.trim())
  if (
    raw.some(
      (i) =>
        !Array.isArray(i.transform) ||
        i.transform.length !== 6 ||
        !i.transform.every(Number.isFinite) ||
        !(i.width > 0) ||
        !(i.height > 0)
    )
  )
    return
  const fonts = raw.map((i) => ({ ...i, ...tableTextToken(i, context.viewport, 0) }))
  if (fonts.some((f) => !valid(f.rect) || !f.horizontal)) return
  const inside = fonts.filter((f) => over(f.rect, frame)),
    owners = new Map(owned.map((f) => [key(f), f]))
  if (
    inside.length !== owned.length ||
    !proveNativeUniqueWholeFonts(inside, fonts) ||
    inside.some((f) => {
      const o = owners.get(key(f))
      return !o || f.text !== o.text || !eq(f.rect, o.rect) || !eq(f.sourceItem, o.sourceItem)
    })
  )
    return
  const paint = nativeCompleteRuledRecordPaintCrop(frame, full, rules, context, owned)
  if (
    !valid(paint) ||
    !contains(old, paint) ||
    !(paint[1] > old[1]) ||
    fonts.some((f) => over(f.rect, paint) && !owners.has(key(f)))
  )
    return
  const crop = [old[0], paint[1], old[2], old[3]],
    removed = [old[0], old[1], old[2], paint[1]]
  // Complete raw glyphs removed, none straddling the retained edge or belonging to a cell.
  const cut = fonts.filter((f) => over(f.rect, removed))
  if (!cut.length || cut.some((f) => f.rect[3] >= paint[1] || owners.has(key(f)))) return
  if (
    table.clipped.some(
      (c) =>
        !valid(c.rect) ||
        c.rect[3] >= paint[1] ||
        !cut.some((f) => eq(f.rect, c.rect) && f.text === c.text)
    )
  )
    return
  const issues = table.issues.filter((s) => s !== 'text-crosses-crop-boundary')
  return { ...table, cropRect: crop, clipped: [], issues, reviewCandidate: issues.length === 0 }
}

export function proveNativeTableReadingOrder(table, wholeProof, items, rules, context) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    !table ||
    table.parts !== undefined ||
    table.cropRects !== undefined ||
    !valid(table.cropRect) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.clipped) ||
    table.clipped.some((i) => !i || !valid(i.rect)) ||
    !Array.isArray(table.issues) ||
    !Array.isArray(items) ||
    items.some((i) => !i || typeof i !== 'object' || !valid(i.rect)) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    !Array.isArray(context?.sourceContent?.items) ||
    context.sourceContent.items.some((i) => !i || typeof i !== 'object') ||
    context.content !== context.sourceContent ||
    typeof context.viewport?.convertToViewportPoint !== 'function'
  )
    return

  if (
    table.cells.some((c) => !c) ||
    !hasDisjointNativeTableSlots(table) ||
    table.cells.some((c) => c.text !== table.grid[c.row][c.column])
  )
    return
  const raw = context.sourceContent.items.filter((i) => typeof i.str === 'string' && i.str.trim())
  if (
    raw.some(
      (i) =>
        !Array.isArray(i.transform) ||
        i.transform.length !== 6 ||
        !i.transform.every(Number.isFinite) ||
        !(i.width > 0) ||
        !(i.height > 0)
    )
  )
    return
  const original = raw.map((i) => ({ ...i, ...tableTextToken(i, context.viewport, 0) }))
  if (original.some((i) => !valid(i.rect) || !i.horizontal)) return
  const source = [],
    used = new Set(),
    cells = []
  if (wholeProof) {
    for (const cell of table.cells) {
      const parts = wholeProof.proved.find((p) => p.cell === cell)?.fonts ?? []
      cells.push({ cell, parts })
      source.push(...parts)
    }
  } else
    for (const cell of table.cells ?? []) {
      if (
        !cell ||
        !Array.isArray(cell.sourceTokens) ||
        cell.sourceTokens.some((t) => !t || typeof t !== 'object' || !valid(t.rect)) ||
        cell.sourceSegments ||
        cell.sourceToken ||
        cell.sourceSegment ||
        !eq(
          cell.sourceRects,
          cell.sourceTokens.map((t) => t.rect)
        )
      )
        return
      const parts = []
      for (const t of cell.sourceTokens) {
        if (
          !t ||
          typeof t !== 'object' ||
          Object.keys(t).sort().join(',') !== 'baseline,height,rect,text'
        )
          return
        const matched = items.filter(
          (i) =>
            i.text === t.text &&
            i.baseline === t.baseline &&
            i.height === t.height &&
            eq(i.rect, t.rect)
        )
        if (matched.length !== 1 || used.has(matched[0])) return
        used.add(matched[0])
        parts.push(matched[0])
        source.push(matched[0])
      }
      if (!nativeChangedCellOrigins([cell], items, cell.sourceTokens)) return
      cells.push({ cell, parts })
    }
  if (!source.length) return
  const xmin = Math.min(...source.map((i) => i.rect[0])),
    xmax = Math.max(...source.map((i) => i.rect[2])),
    groups = new Map()
  for (const r of rules) {
    if (
      r[1] !== r[3] ||
      r[0] > xmin ||
      r[2] < xmax ||
      r[0] < table.cropRect[0] ||
      r[2] > table.cropRect[2]
    )
      continue
    const k = r[0] + ':' + r[2]
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const candidates = []
  for (const group of groups.values()) {
    group.sort((a, b) => a[1] - b[1])
    for (let n = 0; n + 5 <= group.length; n++) {
      const full = group.slice(n, n + 5)
      if (
        cells.some(({ cell, parts }) =>
          parts.some(
            (i) =>
              i.rect[1] <= full[1][1] ||
              i.rect[3] >= full[3][1] ||
              (cell.row === 0 ? i.rect[3] >= full[2][1] : i.rect[1] <= full[2][1])
          )
        )
      )
        continue
      const frame = [full[0][0], full[0][1], full[0][2], full[4][1]],
        inside = items.filter(
          (i) =>
            i.text?.trim() &&
            i.rect[0] < frame[2] &&
            i.rect[2] > frame[0] &&
            i.rect[1] < frame[3] &&
            i.rect[3] > frame[1]
        )
      const originalInside = original.filter(
        (i) =>
          i.rect[0] < frame[2] &&
          i.rect[2] > frame[0] &&
          i.rect[1] < frame[3] &&
          i.rect[3] > frame[1]
      )
      const whole =
        wholeProof &&
        inside.length === source.length &&
        inside.every((i) => source.includes(i)) &&
        originalInside.length === source.length &&
        proveNativeUniqueWholeFonts(originalInside, original) &&
        originalInside.every((i) =>
          source.some(
            (t) =>
              eq(i.sourceItem, t.sourceItem) &&
              eq(i.rect, t.rect) &&
              i.text === t.text &&
              i.baseline === t.baseline &&
              i.height === t.height
          )
        )
      const paint = whole ? frame : completeRecordPaintBounds(source, full, rules, context)
      if (paint) candidates.push({ paint, full })
    }
  }
  if (candidates.length !== 1) return

  const { paint, full } = candidates[0],
    headers = cells.filter((p) => p.cell.row === 0),
    headerFonts = headers.flatMap((p) => p.parts),
    origins = source.map((i) => i.sourceItem ?? i.sourceSegment)
  if (
    headers.length !== table.grid[0].length ||
    headers.some((p) => p.cell.rowSpan !== 1 || p.cell.colSpan !== 1 || !p.parts.length) ||
    new Set(origins.map((o) => o.pageNumber)).size !== 1
  )
    return
  const signature = JSON.stringify(
    [
      ...new Set(
        headerFonts.map((f) => JSON.stringify([f.baseline, f.height, f.rect[1], f.rect[3]]))
      )
    ].sort()
  )
  return {
    table,
    paint,
    full,
    source,
    signature,
    page: origins[0].pageNumber,
    minIndex: Math.min(...origins.map((o) => o.index)),
    maxIndex: Math.max(...origins.map((o) => o.index)),
    headerBounds: [
      Math.min(...headerFonts.map((f) => f.rect[0])),
      Math.min(...headerFonts.map((f) => f.rect[1])),
      Math.max(...headerFonts.map((f) => f.rect[2])),
      Math.max(...headerFonts.map((f) => f.rect[3]))
    ]
  }
}

export function completeNativeTableVisualCrop(table, wholeProof, items, rules, context) {
  const header = recoverNativeClippedHeaderCrop(table, context)
  if (header) return { ...table, cropRect: header }
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    !table ||
    table.parts !== undefined ||
    table.cropRects !== undefined ||
    !valid(table.cropRect) ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.clipped) ||
    table.clipped.some((i) => !i || !valid(i.rect)) ||
    !Array.isArray(table.issues) ||
    !Array.isArray(items) ||
    items.some((i) => !i || typeof i !== 'object' || !valid(i.rect)) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    !Array.isArray(context?.sourceContent?.items) ||
    context.sourceContent.items.some((i) => !i || typeof i !== 'object') ||
    context.content !== context.sourceContent ||
    typeof context.viewport?.convertToViewportPoint !== 'function'
  )
    return
  const boundary = refineNativeTableBoundaryInk(table, rules, context)
  if (boundary) return boundary
  const glyphTrim = trimNativeCaptionGlyphInk(table, context)
  if (glyphTrim) return glyphTrim
  const simple =
    Array.isArray(wholeProof?.proved) &&
    nativeWholeCellVisualCrop(table, wholeProof, items, rules, context)
  if (simple) return simple
  const trimmed = trimWholeTableBottomNote(table, wholeProof, items, rules, context)
  if (trimmed) return trimmed
  // Scope remains the already proved record reconstruction family. This marker alone never proves sources.
  if (!table.repairs?.includes('native-body-records-recovered'))
    return completeWholeTableBottom(table, wholeProof, items, rules, context)
  const proved = proveNativeTableReadingOrder(table, null, items, rules, {
    ...context,
    nativePaintIdentityGraphics: undefined
  })
  if (!proved) return
  const { paint, source } = proved,
    old = table.cropRect,
    crop = [old[0], paint[1], old[2], Math.max(old[3], paint[3])]
  if (eq(old, crop)) return
  const sourceKeys = new Set(
      source.map((i) => {
        const o = i.sourceItem ?? i.sourceSegment
        return o.pageNumber + ':' + o.index
      })
    ),
    fonts = context.sourceContent.items
      .filter((i) => typeof i.str === 'string' && i.str.trim())
      .map((i) => ({ ...i, ...tableTextToken(i, context.viewport, 0) })),
    over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  if (
    fonts.some(
      (f) =>
        over(f.rect, paint) && !sourceKeys.has(f.sourceItem.pageNumber + ':' + f.sourceItem.index)
    )
  )
    return
  if (
    crop[1] > old[1] &&
    fonts.some((f) => over(f.rect, [old[0], old[1], old[2], crop[1]]) && f.rect[3] >= crop[1])
  )
    return
  // A clipped font may disappear only if its whole box is outside the new crop.
  const clipped = table.clipped.filter(
      (i) =>
        i.rect[0] < crop[2] && i.rect[2] > crop[0] && i.rect[1] < crop[3] && i.rect[3] > crop[1]
    ),
    issues = clipped.length
      ? table.issues
      : table.issues.filter((i) => i !== 'text-crosses-crop-boundary')
  return { ...table, cropRect: crop, clipped, issues, reviewCandidate: issues.length === 0 }
}

// Contract the visual bottom only when every table font is inside one complete
// ruled domain and the removed text is wholly outside its actual closing paint.
// Logical rows, cells and source ownership remain untouched.
function trimWholeTableBottomNote(table, proof, items, rules, context) {
  if (!proof?.proved?.length || !table.clipped.length) return
  const populated = table.cells.filter((c) => c?.text?.trim())
  if (
    proof.proved.length !== populated.length ||
    proof.proved.some(
      (p) => !p || !populated.includes(p.cell) || !Array.isArray(p.fonts) || !p.fonts.length
    ) ||
    populated.some((cell) => proof.proved.filter((p) => p.cell === cell).length !== 1)
  )
    return
  const source = proof.proved.flatMap((p) => p.fonts),
    old = table.cropRect
  if (!source.length || !proveNativeUniqueWholeFonts(source, items)) return
  const xmin = Math.min(...source.map((f) => f.rect[0])),
    xmax = Math.max(...source.map((f) => f.rect[2])),
    full = rules
      .filter(
        (r) => r[1] === r[3] && r[0] <= xmin && r[2] >= xmax && r[1] > old[1] && r[1] < old[3]
      )
      .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.some((r) => r[0] !== full[0][0] || r[2] !== full[0][2]) ||
    full.some((r, n) => n && r[1] === full[n - 1][1])
  )
    return
  const frame = [full[0][0], full[0][1], full[0][2], full.at(-1)[1]],
    headers = proof.proved.filter((p) => p.cell.row === 0).flatMap((p) => p.fonts),
    body = proof.proved.filter((p) => p.cell.row > 0).flatMap((p) => p.fonts)
  if (
    !headers.length ||
    !body.length ||
    !contains(old, frame) ||
    source.some(
      (f) => !contains(frame, f.rect) || full.some((r) => f.rect[1] <= r[1] && f.rect[3] >= r[1])
    ) ||
    full.filter(
      (r) => headers.every((f) => f.rect[3] < r[1]) && body.every((f) => f.rect[1] > r[1])
    ).length !== 1
  )
    return
  const raw = context.sourceContent.items.filter((i) => typeof i.str === 'string' && i.str.trim())
  if (
    raw.some(
      (i) =>
        !Array.isArray(i.transform) ||
        i.transform.length !== 6 ||
        !i.transform.every(Number.isFinite) ||
        !(i.width > 0) ||
        !(i.height > 0)
    )
  )
    return
  const fonts = raw.map((i) => ({ ...i, ...tableTextToken(i, context.viewport, 0) })),
    inside = fonts.filter((f) => over(f.rect, frame)),
    owners = new Map(source.map((f) => [key(f), f]))
  if (
    fonts.some((f) => !valid(f.rect) || !f.horizontal) ||
    inside.length !== source.length ||
    !proveNativeUniqueWholeFonts(inside, fonts) ||
    inside.some((f) => {
      const owner = owners.get(key(f))
      return (
        !owner ||
        owner.text !== f.text ||
        !eq(owner.rect, f.rect) ||
        !eq(owner.sourceItem, f.sourceItem)
      )
    })
  )
    return
  const paint = nativeCompleteRuledRecordPaintCrop(frame, full, rules, context, source)
  if (!valid(paint) || !contains(old, paint) || paint[3] >= old[3]) return
  const crop = [old[0], old[1], old[2], paint[3]],
    strip = [old[0], paint[3], old[2], old[3]],
    cut = fonts.filter((f) => over(f.rect, strip))
  if (
    !cut.length ||
    cut.some((f) => owners.has(key(f)) || f.rect[1] <= paint[3]) ||
    [...context.rulePaintBounds.values()].some((r) => !valid(r) || over(r, strip))
  )
    return
  const removed = table.clipped.filter((c) => !over(c.rect, crop))
  if (
    !removed.length ||
    removed.some((c) => !cut.some((f) => eq(c.rect, f.rect) && c.text === f.text))
  )
    return
  const clipped = table.clipped.filter((c) => over(c.rect, crop)),
    issues = clipped.length
      ? table.issues
      : table.issues.filter((s) => s !== 'text-crosses-crop-boundary')
  return { ...table, cropRect: crop, clipped, issues, reviewCandidate: issues.length === 0 }
}

// A missing outer closing stroke is independent of logical record recovery.
// Only the already proved frame paint may enter the new strip; existing crop
// sides, cells, diagnostics and reading order remain exactly as supplied.
function completeWholeTableBottom(table, proof, items, rules, context) {
  if (!proof) return
  const frame = proveNativeTableReadingOrder(table, proof, items, rules, context)
  if (!frame) return
  const paint = nativeCompleteRuledRecordPaintCrop(
      frame.paint,
      frame.full,
      rules,
      context,
      frame.source
    ),
    old = table.cropRect
  if (!valid(paint) || paint[0] < old[0] || paint[2] > old[2] || paint[3] <= old[3]) return
  const strip = [old[0], old[3], old[2], paint[3]]
  const fonts = context.sourceContent.items
    .filter((i) => typeof i.str === 'string' && i.str.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
  if (fonts.some((f) => !valid(f.rect) || over(f.rect, strip))) return
  if (!(context.rulePaintBounds instanceof Map)) return
  const owned = new Set(frame.full.map((r) => r.join(',')))
  if (
    [...context.rulePaintBounds].some(
      ([key, bounds]) =>
        !valid(bounds) || (over(bounds, strip) && (!owned.has(key) || !contains(paint, bounds)))
    )
  )
    return
  return { ...table, cropRect: [old[0], old[1], old[2], paint[3]] }
}

// A rule-free visual contraction needs the complete native text program.
// It does not certify cells or change any reliability/source metadata.
function trimNativeCaptionGlyphInk(table, context) {
  const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
  const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
  const same = (a, b) =>
    Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const intersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
  const union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]

  try {
    const p = context?.nativeGlyphContext,
      v = p?.viewport,
      o = p?.operators,
      raw = p?.content?.items,
      current = context?.sourceContent?.items,
      scale = context?.viewport?.scale
    if (
      !valid(table?.cropRect) ||
      table.parts !== undefined ||
      table.cropRects !== undefined ||
      !Array.isArray(table.cells) ||
      !Array.isArray(table.caption?.lines) ||
      table.caption.lines.length !== 1 ||
      table.caption.lines[0] !== table.caption.text ||
      table.caption.page !== table.page ||
      !valid(table.caption.rect) ||
      !Array.isArray(table.excludedCaptionItems) ||
      table.excludedCaptionItems.filter((t) => t === table.caption.text).length !== 1 ||
      ![raw, current, o?.fnArray, o?.argsArray, p?.glyphBounds].every(Array.isArray) ||
      raw.length !== current.length ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      v.rotation !== 0 ||
      v.scale !== 1 ||
      !finite(v.transform, 6) ||
      !equal(v.transform, [1, 0, 0, -1, 0, v.height]) ||
      context.viewport.rotation !== 0 ||
      context.viewport.width !== v.width * scale ||
      context.viewport.height !== v.height * scale ||
      !equal(
        context.viewport.transform,
        v.transform.map((n) => n * scale)
      ) ||
      !Number.isSafeInteger(table.page) ||
      table.page < 1 ||
      (table.sourceViewport !== undefined &&
        !equal(table.sourceViewport, {
          width: context.viewport.width,
          height: context.viewport.height,
          scale
        }))
    )
      return
    const glyphs = [],
      allowed = new Set(
        [
          'setFillRGBColor',
          'setStrokeRGBColor',
          'beginText',
          'endText',
          'dependency',
          'setFont',
          'moveText',
          'showText'
        ].map((k) => OPS[k])
      )
    let active,
      size = 0,
      x = 0,
      y = 0,
      lx = 0,
      ly = 0,
      text = false
    for (let n = 0; n < o.fnArray.length; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (!allowed.has(op)) return
      if (op === OPS.beginText) {
        if (text) return
        text = true
        x = y = lx = ly = 0
      }
      if (op === OPS.endText) {
        if (!text) return
        text = false
      }
      if (op === OPS.setFont) {
        if (typeof a?.[0] !== 'string' || !(a[1] > 0) || !Number.isFinite(a[1])) return
        active = a[0]
        size = a[1]
      }
      if (op === OPS.moveText) {
        if (!text || !finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      }
      if (op !== OPS.showText) continue
      if (!text || !active || !Array.isArray(a?.[0])) return
      const fonts = p.glyphBounds.filter((f) => f?.fontName === active)
      if (fonts.length !== 1 || !Array.isArray(fonts[0].glyphs)) return
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          x -= (g * size) / 1000
          continue
        }
        if (
          typeof g?.unicode !== 'string' ||
          !g.unicode ||
          g.accent != null ||
          !Number.isFinite(g.width) ||
          g.width < 0
        )
          return
        const paths = fonts[0].glyphs.filter((b) => b?.fontChar === g.fontChar),
          w = (g.width * size) / 1000
        if (paths.length !== 1 || !finite(paths[0].bounds, 4)) return
        const b = paths[0].bounds
        if (b[0] > b[2] || b[1] > b[3]) return
        const rect =
          b[0] < b[2] && b[1] < b[3]
            ? [
                x + b[0] * size,
                v.height - y - b[3] * size,
                x + b[2] * size,
                v.height - y - b[1] * size
              ]
            : undefined
        if (!g.unicode.trim()) {
          const absentSpace =
            g.originalCharCode === 32 &&
            g.fontChar === ' ' &&
            g.unicode === ' ' &&
            g.isSpace === true &&
            g.isInFont === false
          if (rect && !absentSpace) return
        } else {
          if (!rect) return
          for (const c of g.unicode)
            if (c.trim())
              glyphs.push({ c, font: active, x, end: x + w, baseline: v.height - y, size, rect })
        }
        x += w
      }
    }
    if (text) return
    const fonts = new Map(),
      reverse = new Map(),
      domains = []
    let offset = 0
    for (let index = 0; index < raw.length; index++) {
      const r = raw[index],
        c = current[index]
      if (
        typeof r?.str !== 'string' ||
        typeof c?.str !== 'string' ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => r[k] !== c[k]) ||
        !equal(r.transform, c.transform) ||
        !equal(p.content.styles[r.fontName], context.sourceContent.styles[c.fontName]) ||
        (fonts.has(r.fontName) && fonts.get(r.fontName) !== c.fontName) ||
        (reverse.has(c.fontName) && reverse.get(c.fontName) !== r.fontName)
      )
        return
      fonts.set(r.fontName, c.fontName)
      reverse.set(c.fontName, r.fontName)
      if (!r.str.trim()) continue
      const source = c.sourceItem,
        m = r.transform,
        style = p.content.styles[r.fontName]
      if (
        !source ||
        source.pageNumber !== table.page ||
        source.index !== index ||
        source.text !== r.str ||
        (r.sourceItem !== undefined && !equal(r.sourceItem, source)) ||
        ['sourceSegment', 'sourceToken', 'sourceItems', 'sourceSegments'].some(
          (k) => c[k] != null || r[k] != null
        ) ||
        !finite(m, 6) ||
        m[1] ||
        m[2] ||
        m[0] <= 0 ||
        m[3] !== m[0] ||
        r.dir !== 'ltr' ||
        !style ||
        style.vertical ||
        !Number.isFinite(r.width) ||
        r.width <= 0 ||
        r.height !== m[0]
      )
        return
      const letters = [...r.str].filter((c) => c.trim()),
        selected = glyphs.slice(offset, offset + letters.length)
      offset += letters.length
      if (
        selected.length !== letters.length ||
        selected.some(
          (g, n) =>
            g.c !== letters[n] ||
            g.font !== r.fontName ||
            !same(g.baseline, v.height - m[5]) ||
            g.size !== m[0]
        ) ||
        !same(selected[0].x, m[4]) ||
        !same(selected.at(-1).end, m[4] + r.width)
      )
        return
      domains.push({
        index,
        source,
        text: r.str,
        rect: union(selected.map((g) => g.rect)),
        advance: [m[4], v.height - m[5] - m[3], m[4] + r.width, v.height - m[5]]
      })
    }
    if (offset !== glyphs.length) return
    const captions = domains.filter(
      (d) =>
        d.text === table.caption.text && d.advance.every((n, i) => same(n, table.caption.rect[i]))
    )
    if (captions.length !== 1) return
    const caption = captions[0],
      old = table.cropRect.map((n) => n / scale)
    if (!intersects(old, caption.rect) || caption.advance[3] >= old[1]) return
    for (const cell of table.cells) {
      if (!cell || typeof cell !== 'object') return
      const origins = [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])]
      if (
        origins.some((s) => s.pageNumber === table.page && s.index === caption.index) ||
        cell.sourceItem?.index === caption.index ||
        cell.text === caption.text
      )
        return
    }
    const retained = domains.filter((d) => d !== caption && intersects(d.rect, old))
    if (!retained.length) return
    const top = Math.min(...retained.map((d) => d.advance[1]))
    if (
      !(top > old[1] && top < old[3] && caption.rect[3] < top) ||
      retained.some((d) => d.rect[1] < top) ||
      domains.some((d) => d !== caption && intersects(d.rect, [old[0], old[1], old[2], top]))
    )
      return
    return {
      ...table,
      cropRect: [table.cropRect[0], top * scale, table.cropRect[2], table.cropRect[3]]
    }
  } catch {
    return
  }
}
