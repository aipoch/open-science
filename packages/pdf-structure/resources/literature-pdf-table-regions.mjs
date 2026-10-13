/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside, isAdjacentTableScript, rebaseTableCrop } from './literature-pdf-table-geometry.mjs'
import { clusterTableRulePositions } from './literature-pdf-table-rules.mjs'
import {
  proveNativeCompleteRuledSourcePacket,
  nativeWholeFontOrigins,
  nativeCompleteRuledPaintCrop
} from './literature-pdf-native-leaf-record-repair.mjs'

// A closed three-leaf prose/sign/prose body owns each physical record locally.
// Full-width section rows are witnessed by the absence of both inner fences,
// never by a previous page's title or an inferred logical continuation.
export function recoverNativeClosedProseSymbolRows(table, items, rules, context) {
  const crop = table?.cropRect,
    valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (!valid(crop) || !Array.isArray(items) || !Array.isArray(rules)) return
  const near = rules.filter((r) => r[0] === r[2] && r[1] >= crop[1] - 2 && r[3] <= crop[3] + 2),
    xs = [...new Set(near.map((r) => r[0]))].sort((a, b) => a - b)
  if (xs.length !== 4) return
  const horizontal = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - xs[0]) < 0.4 &&
      Math.abs(r[2] - xs[3]) < 0.4 &&
      r[1] >= crop[1] - 2 &&
      r[1] <= crop[3] + 2
  )
  const ys = [...new Set(horizontal.map((r) => r[1]))].sort((a, b) => a - b)
  if (ys.length < 6 || ys.length > 40) return
  const frame = [
    Math.min(...horizontal.map((r) => r[0])),
    ys[0],
    Math.max(...horizontal.map((r) => r[2])),
    ys.at(-1)
  ]
  if (!proveNativeCompleteRuledSourcePacket(items, rules, context, frame)) return
  const native = items.filter(
    (i) =>
      i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
  )
  if (
    native.some((i) => i.rect[0] < frame[0] || i.rect[2] > frame[2] || i.rect[3] > frame[3]) ||
    !nativeWholeFontOrigins(native)
  )
    return
  const spans = [],
    groups = [],
    rowEdges = [...ys]
  let records = 0
  for (let row = 0; row < ys.length - 1; row++) {
    const top = ys[row],
      bottom = ys[row + 1],
      fence = (x) =>
        near.filter((r) => Math.abs(r[0] - x) < 0.01 && r[1] <= top + 0.4 && r[3] >= bottom - 0.4)
          .length
    if (!fence(xs[0]) || !fence(xs[3])) return
    const inner = [fence(xs[1]), fence(xs[2])],
      fonts = native.filter((i) => i.baseline > top && i.baseline < bottom)
    if (!fonts.length) return
    groups.push(fonts)
    if (inner.every((n) => n === 0)) {
      if (
        fonts.length !== 1 ||
        !/^\p{L}[\p{L}\s-]{2,}$/u.test(fonts[0].text) ||
        Math.abs((fonts[0].rect[0] + fonts[0].rect[2] - xs[0] - xs[3]) / 2) > fonts[0].height * 0.4
      )
        return
      // Preserve the whole nominal title font even when its upper metric
      // reaches just past the native rule. Its preceding complete record must
      // end before that font; moving the empty boundary never splits any ink.
      if (fonts[0].rect[3] > bottom || fonts[0].rect[1] < (row ? ys[row - 1] : crop[1])) return
      rowEdges[row] = Math.min(top, fonts[0].rect[1])
      spans.push({ row, column: 0, rowSpan: 1, colSpan: 3 })
      continue
    }
    if (inner.some((n) => n !== 1)) return
    if (fonts.some((i) => i.rect[1] < top || i.rect[3] > bottom)) return
    const lanes = [0, 1, 2].map((c) =>
      fonts.filter((i) => i.rect[0] >= xs[c] && i.rect[2] <= xs[c + 1])
    )
    if (
      lanes.flat().length !== fonts.length ||
      lanes.some((l) => !l.length) ||
      lanes[1].length !== 1 ||
      !/^[+−-]$/u.test(lanes[1][0].text) ||
      !lanes[0].some((i) => /\p{L}{3}/u.test(i.text)) ||
      !lanes[2].some((i) => /\p{L}{3}/u.test(i.text))
    )
      return
    records++
  }
  if (
    records < 4 ||
    spans.length < 1 ||
    spans.length > 3 ||
    new Set(groups.flat()).size !== native.length ||
    groups.some((g, n) => g.some((i) => i.rect[1] < rowEdges[n] || i.rect[3] > rowEdges[n + 1]))
  )
    return
  frame[1] = rowEdges[0]
  const completeCrop = nativeCompleteRuledPaintCrop(
    frame,
    [...horizontal, ...near],
    context,
    native
  )
  if (!completeCrop) return
  return {
    cropRect: completeCrop,
    rows: rowEdges.slice(1).map((y, n) => [frame[0], rowEdges[n], frame[2], y]),
    columns: xs.slice(1).map((x, n) => [xs[n], frame[1], x, frame[3]]),
    headerRows: spans.filter((s) => s.row === 0).map((s) => s.row),
    spans,
    completeSpans: true,
    ownedTokens: new Set(native),
    repair: 'native-body-records-recovered'
  }
}

// A complete two-field statistics body needs its own caption, three enclosing
// horizontal rules, every central-value anchor and every whole script font.
// This supplies physical row/column ownership; script serialization stays in
// the existing cell-text proof and never guesses scientific values.
export function recoverNativeCaptionedTwoFieldRows(table, items, captions, rules, context) {
  const crop = table?.cropRect
  if (
    !Array.isArray(crop) ||
    crop.length !== 4 ||
    !crop.every(Number.isFinite) ||
    !Array.isArray(items) ||
    !Array.isArray(captions) ||
    !Array.isArray(rules)
  )
    return
  const horizontal = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= crop[1] - 20 &&
        r[1] <= crop[3] + 20 &&
        Math.abs(r[0] - crop[0]) < 20 &&
        Math.abs(r[2] - crop[2]) < 20
    )
    .sort((a, b) => a[1] - b[1])
  if (
    horizontal.length !== 3 ||
    horizontal.some(
      (r) => Math.abs(r[0] - horizontal[0][0]) > 0.01 || Math.abs(r[2] - horizontal[0][2]) > 0.01
    )
  )
    return
  const [top, divider, bottom] = horizontal,
    frame = [top[0], top[1], top[2], bottom[1]]
  if (!proveNativeCompleteRuledSourcePacket(items, rules, context, frame)) return
  const native = items.filter(
    (i) =>
      i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
  )
  if (!native.length || native.some((i) => !inside(frame, i)) || !nativeWholeFontOrigins(native))
    return
  const h = Math.max(...native.map((i) => i.height)),
    titles = captions.filter(
      (c) =>
        c.page === native[0].sourceItem.pageNumber &&
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect?.[3] <= top[1] &&
        top[1] - c.rect[3] < h * 3 &&
        c.rect[2] > frame[0] &&
        c.rect[0] < frame[2]
    )
  if (titles.length !== 1 || captions.some((c) => c.rect[1] < frame[3] && c.rect[3] > frame[1]))
    return
  const header = native.filter((i) => i.rect[3] < divider[1]),
    body = native.filter((i) => i.rect[1] > divider[1])
  if (
    header.length + body.length !== native.length ||
    !header.length ||
    divider[1] - top[1] > h * 3
  )
    return
  const anchors = body
    .filter(
      (i) =>
        i.height === h &&
        /^\p{L}[\p{L}. -]*$/u.test(i.text) &&
        i.rect[2] < frame[0] + (frame[2] - frame[0]) * 0.4
    )
    .sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length < 3 ||
    anchors.length > 12 ||
    anchors.some((i, n) => n && i.baseline - anchors[n - 1].baseline < h)
  )
    return
  const central = anchors.map((a) =>
    body.filter(
      (i) =>
        i !== a &&
        i.height === h &&
        Math.abs(i.baseline - a.baseline) < h * 0.02 &&
        /^\d+(?:\.\d+)?$/u.test(i.text)
    )
  )
  if (central.some((g) => g.length !== 1)) return
  const left = Math.max(...anchors.map((i) => i.rect[2])),
    right = Math.min(...central.map((g) => g[0].rect[0]))
  if (right - left < h * 0.5) return
  const cut = (left + right) / 2,
    groups = anchors.map((a) => body.filter((i) => Math.abs(i.baseline - a.baseline) < h * 0.5))
  if (
    groups.flat().length !== body.length ||
    new Set(groups.flat()).size !== body.length ||
    groups.some(
      (g, n) =>
        g.filter((i) => i.rect[2] <= cut).length !== 1 ||
        !g.includes(anchors[n]) ||
        g.some((i) => i.rect[0] < cut && i.rect[2] > cut) ||
        !g.some((i) => i.rect[0] >= cut && i.height < h && /^[+−-]/u.test(i.text))
    )
  )
    return
  if (
    header.some((i) => i.rect[0] < cut && i.rect[2] > cut) ||
    !header.some((i) => i.rect[2] <= cut && /\p{L}/u.test(i.text)) ||
    !header.some((i) => i.rect[0] >= cut && /\p{L}/u.test(i.text))
  )
    return
  const bounds = groups.map((g) => [
    Math.min(...g.map((i) => i.rect[1])),
    Math.max(...g.map((i) => i.rect[3]))
  ])
  if (bounds.some((b, n) => n && b[0] <= bounds[n - 1][1])) return
  const ys = [
      top[1],
      divider[1],
      ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2),
      bottom[1]
    ],
    cuts = [frame[0], cut, frame[2]]
  const completeCrop = nativeCompleteRuledPaintCrop(frame, horizontal, context, native)
  if (!completeCrop) return
  return {
    cropRect: completeCrop,
    rows: ys.slice(1).map((y, n) => [frame[0], ys[n], frame[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(native),
    repair: 'native-body-records-recovered'
  }
}

// A detector can start a lower table above its title when an upper table ends
// close to the next caption.  Keep the lower region bounded by its explicit
// caption, but only when the source below that caption still proves a real
// table body.  The helper runs before refinement, so model boxes must be
// rebased together with the crop.
function trimEmbeddedTableCaption(table, items, captions) {
  const crop = table.cropRect
  const candidates = captions
    .filter(
      (caption) =>
        captionKind(caption.lines?.[0]) === 'table' &&
        /^Table\s+\d+[A-Z]?\s*[:.]/i.test(caption.lines?.[0] ?? '') &&
        caption.rect[1] >= crop[1] - 2 &&
        caption.rect[3] < crop[3] - 4 &&
        caption.rect[2] > crop[0] &&
        caption.rect[0] < crop[2] &&
        (Math.min(caption.rect[2], crop[2]) - Math.max(caption.rect[0], crop[0])) /
          Math.min(caption.rect[2] - caption.rect[0], crop[2] - crop[0]) >=
          0.5
    )
    .sort((a, b) => a.rect[1] - b.rect[1])
  for (const caption of candidates) {
    const top = caption.rect[3] + 2
    const source = items
      .filter(
        (item) =>
          item.horizontal &&
          item.rect[1] >= top &&
          item.rect[3] <= crop[3] &&
          item.rect[2] > crop[0] &&
          item.rect[0] < crop[2] &&
          item.text.trim()
      )
      .sort((a, b) => a.rect[1] - b.rect[1])
    const baselines = []
    for (const item of source) {
      const baseline = Number.isFinite(item.baseline) ? item.baseline : item.rect[3]
      const previous = baselines.at(-1)
      if (!previous || baseline - previous > Math.max(2, item.height * 0.7))
        baselines.push(baseline)
    }
    const numeric = source.filter((item) => /\d/.test(item.text)).length
    if (baselines.length < 3 || numeric < 4) continue
    return rebaseTableCrop(table, [crop[0], top, crop[2], crop[3]])
  }
  return table
}
// Near-identical detector boxes can compete for the same caption. Collapse them
// only when they enclose exactly the same native tokens, including edge text.
export function deduplicateTableRegions(tables, items, captions = []) {
  tables = tables.map((table) => trimEmbeddedTableCaption(table, items, captions))
  const hasTableCaption = (table) => {
    const crop = table?.cropRect
    if (!crop) return false
    return captions.some((caption) => {
      if (captionKind(caption?.lines?.[0]) !== 'table' || !caption.rect) return false
      const overlap = Math.min(caption.rect[2], crop[2]) - Math.max(caption.rect[0], crop[0])
      const width = Math.min(caption.rect[2] - caption.rect[0], crop[2] - crop[0])
      if (overlap / Math.max(1, width) < 0.5) return false
      const aboveGap = crop[1] - caption.rect[3]
      return (
        (aboveGap >= -2 && aboveGap <= 36) ||
        (caption.rect[1] >= crop[1] && caption.rect[3] <= crop[3])
      )
    })
  }
  // A detector may cover a prose column together with a real table in the
  // neighboring column. Keep the narrower, source-backed grid when the wider
  // box contributes a complete narrative line outside that grid; ordinary
  // adjacent tables do not satisfy the prose-plus-numeric proof.
  const duplicateNarrativeTables = new Set()
  for (const outer of tables) {
    if (hasTableCaption(outer)) continue
    for (const inner of tables) {
      if (outer === inner) continue
      const a = outer.cropRect,
        b = inner.cropRect
      const vertical =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(a[3] - a[1], b[3] - b[1]))
      const outerWidth = a[2] - a[0]
      const innerWidth = b[2] - b[0]
      const horizontalOverlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
      if (
        b[0] <= a[0] + outerWidth * 0.3 ||
        b[2] < a[2] - 14 ||
        innerWidth >= outerWidth * 0.8 ||
        horizontalOverlap / Math.max(1, Math.min(outerWidth, innerWidth)) < 0.35 ||
        vertical < 0.35
      )
        continue
      const outside = items.filter(
        (item) =>
          item.horizontal &&
          intersect(item.rect, a) > 0 &&
          item.rect[2] <= b[0] + 2 &&
          item.text.trim().split(/\s+/).length >= 8
      )
      const outerColumns = (outer.structure?.objects ?? [])
        .filter((object) => object.label === 'table column' && Array.isArray(object.rect))
        .map((object) => object.rect.map((value, index) => value + (index % 2 ? a[1] : a[0])))
      const unownedOutside = outside.filter(
        (item) =>
          !outerColumns.length ||
          item.rect[0] < Math.min(...outerColumns.map((column) => column[0])) ||
          item.rect[2] > Math.max(...outerColumns.map((column) => column[2]))
      )
      const insideItems = items.filter(
        (item) => item.horizontal && intersect(item.rect, b) > 0 && item.text.trim()
      )
      const numeric = insideItems.filter((item) => /\d/.test(item.text)).length
      const rows =
        inner.structure?.objects?.filter((object) => object.label === 'table row').length ?? 0
      const columns =
        inner.structure?.objects?.filter((object) => object.label === 'table column').length ?? 0
      if (unownedOutside.length && numeric >= 2 && rows >= 2 && columns >= 2)
        duplicateNarrativeTables.add(outer)
    }
  }
  if (duplicateNarrativeTables.size)
    tables = tables.filter((table) => !duplicateNarrativeTables.has(table))
  const titles = captions.filter((c) => captionKind(c.lines[0]) === 'table')
  if (titles.length === 1) {
    const caption = titles[0]
    tables = tables.filter(
      (table) =>
        !tables.some((other) => {
          if (other === table) return false
          const a = table.cropRect,
            b = other.cropRect
          if (
            Math.abs(a[0] - b[0]) > 4 ||
            Math.abs(a[1] - b[1]) > 4 ||
            Math.abs(a[3] - b[3]) > 4 ||
            b[2] - b[0] < (a[2] - a[0]) * 1.5 ||
            caption.rect[3] > a[1] + 12 ||
            a[1] - caption.rect[3] > 36
          )
            return false
          const cols = other.structure.objects.filter((o) => o.label === 'table column')
          if (
            cols.length <
            table.structure.objects.filter((o) => o.label === 'table column').length + 2
          )
            return false
          const extra = items.filter(
            (i) =>
              i.horizontal &&
              i.rect[0] > a[2] &&
              i.rect[2] < b[2] &&
              i.rect[1] > b[1] &&
              i.rect[3] < b[3] &&
              /^[<>−+-]?(?:\d|\.\d)/.test(i.text)
          )
          const baselines = new Set(
            extra
              .filter((i) =>
                extra.some(
                  (j) =>
                    j !== i &&
                    j.rect[0] - i.rect[2] > i.height &&
                    Math.abs(i.baseline - j.baseline) < i.height * 0.2
                )
              )
              .map((i) => Math.round(i.baseline))
          )
          return (
            baselines.size >= 4 &&
            items.filter((i) => intersect(i.rect, a) > 0).every((i) => intersect(i.rect, b) > 0)
          )
        })
    )
  }
  const kept = []
  for (const table of [...tables].sort(
    (a, b) => (b.detection?.score ?? 0) - (a.detection?.score ?? 0)
  )) {
    const source = items.filter((item) => intersect(item.rect, table.cropRect) > 0)
    if (
      source.length &&
      kept.some((other) => {
        if (
          intersect(table.cropRect, other.cropRect) /
            Math.max(area(table.cropRect), area(other.cropRect)) <
          0.95
        )
          return false
        const previous = items.filter((item) => intersect(item.rect, other.cropRect) > 0)
        return previous.length === source.length && previous.every((item, i) => item === source[i])
      })
    )
      continue
    kept.push(table)
  }
  return tables.filter((table) => kept.includes(table))
}

// A detector can retain an earlier, wider refinement around a real table in
// the neighboring column.  At this stage the refined grids are available, so
// use their actual prose/numeric content rather than raw detector geometry.
// Return indices to keep the caller's table identity and caption association
// stable while dropping only the proven narrative duplicate.
export function narrativeDuplicateTableIndices(
  tables,
  { captionedIndices = new Set(), rules = [] } = {}
) {
  const duplicate = new Set()
  const normalizeCell = (value) =>
    String(value ?? '')
      .replace(/\s+/gu, '')
      .replace(/[−–—]/gu, '-')
  const suffixMatchRatio = (outer, inner) => {
    const innerRows = inner.grid ?? []
    let compared = 0
    let matched = 0
    for (const row of outer.grid ?? []) {
      const suffix = row.slice(1).map(normalizeCell)
      const populated = suffix.filter(Boolean)
      if (!populated.length) continue
      compared += 1
      const found = innerRows.some((candidate) => {
        const normalized = candidate.map(normalizeCell)
        const equal = suffix.filter((value, index) => value && value === normalized[index]).length
        return equal >= Math.max(2, populated.length - 1)
      })
      if (found) matched += 1
    }
    return compared ? matched / compared : 0
  }
  const contentMatchEvidence = (outer, inner) => {
    let compared = 0
    let matchedRows = 0
    let matchedCells = 0
    for (const row of outer.grid ?? []) {
      const source = row.slice(1).map(normalizeCell)
      const populated = source.filter(Boolean)
      if (!populated.length) continue
      compared += populated.length
      let best = 0
      for (const candidate of inner.grid ?? []) {
        const normalized = candidate.map(normalizeCell)
        for (let offset = 0; offset <= normalized.length - source.length; offset++) {
          const equal = source.filter(
            (value, index) => value && value === normalized[index + offset]
          ).length
          best = Math.max(best, equal)
        }
      }
      if (best >= 2) {
        matchedRows += 1
        matchedCells += best
      }
    }
    return { compared, matchedRows, matchedCells }
  }
  for (let outerIndex = 0; outerIndex < tables.length; outerIndex++) {
    if (captionedIndices.has(outerIndex)) continue
    const outer = tables[outerIndex]
    const a = outer?.cropRect
    if (!a) continue
    const outerWidth = a[2] - a[0]
    const outerHeight = a[3] - a[1]
    if (outerWidth <= 0 || outerHeight <= 0) continue
    const narrative = (outer.unassigned ?? []).some((text) => text.trim().split(/\s+/u).length >= 8)
    if (!narrative) continue
    for (let innerIndex = 0; innerIndex < tables.length; innerIndex++) {
      if (innerIndex === outerIndex) continue
      const inner = tables[innerIndex]
      const b = inner?.cropRect
      if (!b) continue
      const innerWidth = b[2] - b[0]
      const overlap =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(outerHeight, b[3] - b[1]))
      const numericCells = (inner.grid ?? []).flat().filter((text) => /\d/u.test(text.trim()))
      const innerRows = inner.grid?.length ?? 0
      const innerColumns = Math.max(0, ...(inner.grid ?? []).map((row) => row.length))
      const evidence = contentMatchEvidence(outer, inner)
      if (
        b[0] > a[0] + outerWidth * 0.3 &&
        b[2] >= a[2] - 20 &&
        innerWidth < outerWidth * 0.8 &&
        overlap >= 0.35 &&
        innerRows >= 2 &&
        innerColumns >= 2 &&
        numericCells.length >= 2 &&
        evidence.matchedRows >= 2 &&
        evidence.matchedCells >= 4 &&
        evidence.matchedCells / Math.max(1, evidence.compared) >= 0.6
      ) {
        duplicate.add(outerIndex)
        break
      }
    }
  }
  // A two-column page can feed the numeric stub from the left table into a
  // second detector box. The wider candidate then has one extra numeric-first
  // column while its remaining cells match the clean right-hand grid. Drop
  // only that proven spill; a real stub column does not satisfy the geometry,
  // numeric-first, and row-suffix witnesses together.
  for (let outerIndex = 0; outerIndex < tables.length; outerIndex++) {
    if (duplicate.has(outerIndex)) continue
    const outer = tables[outerIndex]
    const captionedOuter = captionedIndices.has(outerIndex)
    const a = outer?.cropRect
    const outerRows = outer?.grid ?? []
    const outerColumns = Math.max(0, ...outerRows.map((row) => row.length))
    if (!a || outerColumns < 3 || !outerRows.length) continue
    if (
      !(outer.issues ?? []).includes('text-crosses-crop-boundary') ||
      (!captionedOuter && (outer.unassigned?.length ?? 0) < 3) ||
      (captionedOuter && (outer.unassigned?.length ?? 0) < 1)
    )
      continue
    const outerWidth = a[2] - a[0]
    const outerHeight = a[3] - a[1]
    const firstColumn = outerRows.map((row) => normalizeCell(row[0])).filter(Boolean)
    const numericFirst = firstColumn.filter((value) =>
      /^[<>≤≥+-]?\d[\d.,]*(?:\s*±\s*\d[\d.,]*)*(?:[kKmMbB])?$/u.test(value)
    )
    if (numericFirst.length < Math.max(2, Math.ceil(firstColumn.length * 0.55))) continue
    for (let innerIndex = 0; innerIndex < tables.length; innerIndex++) {
      if (innerIndex === outerIndex) continue
      const inner = tables[innerIndex]
      const b = inner?.cropRect
      const innerRows = inner?.grid ?? []
      const innerColumns = Math.max(0, ...innerRows.map((row) => row.length))
      if (!b || innerColumns !== outerColumns - 1 || innerRows.length < 2) continue
      if (
        !captionedOuter &&
        (outer.unassigned?.length ?? 0) <= (inner.unassigned?.length ?? 0) * 1.5
      )
        continue
      const vertical =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(outerHeight, b[3] - b[1]))
      const rightDelta = Math.abs(a[2] - b[2])
      const leftShift = b[0] - a[0]
      if (
        vertical < 0.9 ||
        rightDelta > 20 ||
        leftShift <= 2 ||
        leftShift > outerWidth * (captionedOuter ? 0.25 : 0.16) ||
        (!captionedOuter && outerWidth - (b[2] - b[0]) > outerWidth * 0.2) ||
        suffixMatchRatio(outer, inner) < 0.7
      )
        continue
      duplicate.add(outerIndex)
      break
    }
  }
  // A captioned side-by-side crop can be a partial detector box while a
  // neighboring uncaptioned box contains the complete rows. Once caption
  // association has selected the complete box, drop the partial record even
  // when its first column is a text header rather than a numeric stub.
  for (let outerIndex = 0; outerIndex < tables.length; outerIndex++) {
    if (captionedIndices.has(outerIndex)) continue
    const outer = tables[outerIndex]
    const a = outer?.cropRect
    if (!a || !(outer.issues ?? []).includes('text-crosses-crop-boundary')) continue
    if ((outer.unassigned?.length ?? 0) < 3) continue
    const outerRows = outer.grid?.length ?? 0
    const outerColumns = Math.max(0, ...(outer.grid ?? []).map((row) => row.length))
    for (let innerIndex = 0; innerIndex < tables.length; innerIndex++) {
      if (innerIndex === outerIndex || !captionedIndices.has(innerIndex)) continue
      const inner = tables[innerIndex]
      const b = inner?.cropRect
      if (!b || (inner.unassigned?.length ?? 0) > 0) continue
      const innerRows = inner.grid?.length ?? 0
      const innerColumns = Math.max(0, ...(inner.grid ?? []).map((row) => row.length))
      if (innerRows < Math.max(3, outerRows + 1) || innerColumns !== outerColumns - 1) continue
      const horizontal =
        Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) /
        Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]))
      const vertical =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(a[3] - a[1], b[3] - b[1]))
      if (horizontal < 0.5 || vertical < 0.8) continue
      duplicate.add(outerIndex)
      break
    }
  }
  // A detector may emit a tall captionless box that repeats one complete
  // table while also enclosing a second independently detected table. Keep
  // the independent grid and drop only the tall candidate when its assigned
  // rows match a shorter inner grid almost exactly.
  for (let outerIndex = 0; outerIndex < tables.length; outerIndex++) {
    if (duplicate.has(outerIndex)) continue
    const outer = tables[outerIndex]
    const a = outer?.cropRect
    if (!a || !(outer.issues ?? []).includes('unassigned-source-text')) continue
    const outerHeight = a[3] - a[1]
    const outerWidth = a[2] - a[0]
    const outerRows = outer.grid?.length ?? 0
    if (outerHeight <= 0 || outerWidth <= 0 || outerRows < 3) continue
    for (let innerIndex = 0; innerIndex < tables.length; innerIndex++) {
      if (innerIndex === outerIndex) continue
      const inner = tables[innerIndex]
      const b = inner?.cropRect
      if (!b) continue
      const innerHeight = b[3] - b[1]
      const innerWidth = b[2] - b[0]
      if (innerHeight <= 0 || innerWidth <= 0 || outerHeight < innerHeight * 1.35) continue
      if ((outer.unassigned?.length ?? 0) <= (inner.unassigned?.length ?? 0) * 1.5) continue
      const verticalOverlap =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(outerHeight, innerHeight))
      const horizontalOverlap =
        Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) /
        Math.max(1, Math.min(outerWidth, innerWidth))
      if (verticalOverlap < 0.8 || horizontalOverlap < 0.85) continue
      const evidence = contentMatchEvidence(outer, inner)
      const innerRows = inner.grid?.length ?? 0
      if (
        innerRows >= 3 &&
        evidence.matchedRows >= Math.max(3, Math.ceil(innerRows * 0.75)) &&
        evidence.matchedCells >= 6 &&
        evidence.matchedCells / Math.max(1, evidence.compared) >= 0.8
      ) {
        duplicate.add(outerIndex)
        break
      }
    }
  }
  // A single detector box can span several independently ruled panels under
  // one caption.  Its model grid then looks like one very wide/long table,
  // while smaller source-backed records already own individual panels.  Do
  // not keep the covering record: it has no stable cell ownership and its
  // section labels remain unassigned.  The proof is deliberately narrow:
  // multiple explicit (a)/(b)/... labels, at least two complete inner grids,
  // disjoint vertical bands, and a native rule at each inner opening/closing.
  for (let outerIndex = 0; outerIndex < tables.length; outerIndex++) {
    // `captionedIndices` also contains proximity-based owners. A single
    // caption above a stacked panel plate is intentionally shared by every
    // detector candidate, so it must not suppress the panel-overlap proof.
    if (duplicate.has(outerIndex)) continue
    const outer = tables[outerIndex]
    const crop = outer?.cropRect
    if (!crop || !Array.isArray(outer?.unassigned)) continue
    const panelLabels = [
      ...outer.unassigned,
      ...(outer.grid ?? []).map((row) => row[0] ?? '')
    ].filter((text) => /^\s*\([a-z]\)\s*\p{L}/iu.test(text))
    if (panelLabels.length < 2) continue
    if (
      ![
        'unresolved-spanning-cells',
        'conflicting-spanning-cells',
        'nonrectangular-spanning-cell'
      ].some((issue) => (outer.issues ?? []).includes(issue))
    )
      continue
    const width = crop[2] - crop[0]
    const height = crop[3] - crop[1]
    if (
      !(width > 0 && height > 0) ||
      (outer.unassigned?.length ?? 0) < Math.max(4, panelLabels.length * 2)
    )
      continue
    const panels = tables
      .map((table, index) => ({ table, index }))
      .filter(({ table, index }) => {
        // Proximity-based caption ownership is shared by every panel in a
        // stacked plate; it must not hide a complete inner grid.
        if (index === outerIndex) return false
        const rect = table?.cropRect
        if (!rect || (table.unassigned?.length ?? 0) > 4) return false
        const rows = table.grid?.length ?? 0
        const columns = Math.max(0, ...(table.grid ?? []).map((row) => row.length))
        if (rows < 3 || columns < 2) return false
        if (
          (table.issues ?? []).some((issue) => /(?:unresolved|conflicting|ambiguous)-/u.test(issue))
        )
          return false
        const horizontal =
          Math.max(0, Math.min(crop[2], rect[2]) - Math.max(crop[0], rect[0])) /
          Math.max(1, Math.min(width, rect[2] - rect[0]))
        return (
          horizontal >= 0.8 &&
          rect[0] >= crop[0] - 20 &&
          rect[2] <= crop[2] + 20 &&
          rect[1] >= crop[1] - 20 &&
          rect[3] <= crop[3] + 20
        )
      })
      .sort((a, b) => a.table.cropRect[1] - b.table.cropRect[1])
    if (panels.length < 2) continue
    const independent = []
    for (const panel of panels) {
      const previous = independent.at(-1)?.table.cropRect
      if (!previous || panel.table.cropRect[1] - previous[3] >= -24) independent.push(panel)
    }
    if (independent.length < 2) continue
    const coverage = independent.reduce(
      (sum, { table }) => sum + Math.max(0, table.cropRect[3] - table.cropRect[1]),
      0
    )
    if (coverage / height < 0.4) continue
    const horizontalRules = (Array.isArray(rules) ? rules : []).filter(
      (rule) =>
        Math.abs(rule[1] - rule[3]) <= 0.75 &&
        rule[1] >= crop[1] - 14 &&
        rule[1] <= crop[3] + 14 &&
        Math.max(0, Math.min(crop[2], rule[2]) - Math.max(crop[0], rule[0])) >= width * 0.65
    )
    if (horizontalRules.length < independent.length * 2) continue
    const hasBoundary = (value, panelHeight) =>
      horizontalRules.some((rule) => Math.abs(rule[1] - value) <= Math.max(14, panelHeight * 0.3))
    if (
      independent.some(({ table }) => {
        const panelHeight = table.cropRect[3] - table.cropRect[1]
        return (
          !hasBoundary(table.cropRect[1], panelHeight) ||
          !hasBoundary(table.cropRect[3], panelHeight)
        )
      })
    )
      continue
    duplicate.add(outerIndex)
  }
  return duplicate
}

// A fully ruled numeric grid can survive on a continuation page with no title
// even when the detector returns no box. Require every row/column border, not
// merely a collection of rectangles such as a form or flowchart.
export function recoverRuledTable(items, rules, pageNumber, caption = undefined) {
  const cluster = (values) =>
    values.sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > 1.5)
  const vertical = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 10)
  const components = []
  for (const r of [...vertical].sort((a, b) => a[1] - b[1])) {
    const last = components.at(-1)
    if (last && r[1] <= last[1] + 2) last[1] = Math.max(last[1], r[3])
    else components.push([r[1], r[3]])
  }
  if (components.length > 1) {
    for (const [top, bottom] of components) {
      const recovered = recoverRuledTable(
        items,
        rules.filter((r) => r[1] >= top - 2 && r[3] <= bottom + 2),
        pageNumber,
        caption
      )
      if (recovered) return recovered
    }
    return undefined
  }
  const xs = cluster(vertical.map((r) => r[0]))
  if (xs.length < 4 || xs.length > 13) return undefined
  const left = xs[0],
    right = xs.at(-1)
  const horizontal = rules.filter((r) => r[1] === r[3] && r[0] >= left - 2 && r[2] <= right + 2)
  const ys = cluster(horizontal.map((r) => r[1])).filter(
    (y) =>
      horizontal.filter((r) => Math.abs(r[1] - y) < 1.5).reduce((sum, r) => sum + r[2] - r[0], 0) >=
      (right - left) * 0.95
  )
  if (
    ys.length < 2 ||
    ys.length > 81 ||
    xs.some((x) =>
      ys
        .slice(1)
        .some(
          (y, i) =>
            !vertical.some((r) => Math.abs(r[0] - x) < 1.5 && r[1] <= ys[i] + 2 && r[3] >= y - 2)
        )
    )
  )
    return undefined
  const top = ys[0],
    bottom = ys.at(-1)
  const values = items.filter(
    (i) => i.horizontal && inside([left, top, right, bottom], i) && /^[<>≤≥−+-]?\d/.test(i.text)
  )
  if (!caption && values.length < (ys.length - 1) * 2) return undefined
  // A short spillover needs stronger evidence: every non-stub cell contains
  // a numeric mean ± deviation. Plain forms and isolated labels are ineligible.
  if (
    !caption &&
    ys.length < 8 &&
    ys.slice(1).some((y, row) =>
      xs.slice(2).some((x, column) => {
        const cell = [xs[column + 1], ys[row], x, y]
        const text = items
          .filter((i) => i.horizontal && inside(cell, i))
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join(' ')
          .trim()
        return !/^\d[\d.]*\s*±\s*\d[\d.]*$/.test(text)
      })
    )
  )
    return undefined
  if (caption) {
    if (
      top < caption.rect[3] - 2 ||
      top - caption.rect[3] > 3 * (caption.rect[3] - caption.rect[1])
    )
      return undefined
    // Captioned grids may have text headers and p-value summaries, but must
    // contain at least two complete numeric records, including narrow n columns.
    const numericRows = ys.slice(1).filter((y, row) =>
      xs.slice(2).every((x, column) => {
        const cell = [xs[column + 1], ys[row], x, y]
        const text = items
          .filter((i) => i.horizontal && inside(cell, i))
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((i) => i.text)
          .join(' ')
          .trim()
        return /^[<>≤≥−+-]?(?:\d|\.\d)/.test(text) && !/\p{L}/u.test(text)
      })
    )
    if (numericRows.length < 2) return undefined
  }
  const cropTop = caption
    ? Math.max(
        top - 2,
        Math.min(
          top,
          ...items
            .filter((i) => i.horizontal && inside([left, top, right, bottom], i))
            .map((i) => i.rect[1])
        )
      )
    : top
  return {
    id: `p${pageNumber}-ruled-table`,
    recoveredGrid: true,
    cropRect: [left, cropTop, right, bottom],
    structure: {
      objects: [
        ...ys.slice(1).map((y, i) => ({
          label: 'table row',
          rect: [0, ys[i] - cropTop, right - left, y - cropTop]
        })),
        ...xs.slice(1).map((x, i) => ({
          label: 'table column',
          rect: [xs[i] - left, 0, x - left, bottom - cropTop]
        }))
      ]
    }
  }
}

// Booktabs-style tables often draw only the top/mid/bottom rules and omit the
// outer vertical borders. When the detector misses one member of a side-by-side
// pair, the horizontal rule span plus the surviving interior column rules still
// prove a separate table. Reconstruct row bands from native text baselines so
// the fallback preserves every visible row without broadening ordinary prose.
function recoverCaptionedOpenRuleTable(items, rules, pageNumber, caption, captions) {
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const cluster = (values, tolerance = 1.5) =>
    values
      .sort((a, b) => a - b)
      .filter((value, index, sorted) => !index || value - sorted[index - 1] > tolerance)
  const horizontalCandidates = rules
    .filter(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] >= caption.rect[3] - 2 &&
        overlap(rule, caption.rect) >=
          Math.min(caption.rect[2] - caption.rect[0], rule[2] - rule[0]) * 0.5
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontalCandidates.length < 2) return
  const maxRuleGap = Math.max(180, (caption.rect[3] - caption.rect[1]) * 6)
  const horizontal = [horizontalCandidates[0]]
  const firstWidth = Math.max(1, horizontal[0][2] - horizontal[0][0])
  for (const rule of horizontalCandidates.slice(1)) {
    if (rule[1] - horizontal.at(-1)[1] > maxRuleGap) break
    // A nearby plot or chart can contribute long horizontal grid lines after
    // the table's closing rule. Keep disjoint side-by-side spans (the normal
    // two-column case), but stop when an overlapping span shifts materially
    // in both x edges; that is a new graphic region, not the same table.
    const shared = overlap(rule, horizontal[0])
    const edgeShift = Math.max(
      Math.abs(rule[0] - horizontal[0][0]),
      Math.abs(rule[2] - horizontal[0][2])
    )
    if (shared > 0 && edgeShift > firstWidth * 0.12) break
    horizontal.push(rule)
  }
  if (horizontal.length < 2) return
  const top = horizontal[0][1]
  const bottom = horizontal.at(-1)[1]
  if (bottom - top < 30) return
  const left = Math.min(...horizontal.map((rule) => rule[0]))
  const right = Math.max(...horizontal.map((rule) => rule[2]))
  if (!(right > left) || overlap([left, top, right, bottom], caption.rect) < (right - left) * 0.5)
    return
  // Centered titles of different widths need not share a left edge. The first
  // surviving rule can therefore belong to a later, narrower table. Refuse
  // that fallback when a distinct explicit title intervenes before its entire
  // rule frame; ordinary continuation titles and neighboring columns remain
  // eligible. Do not remove any existing detector-owned table.
  const number = /^Table\s+(\d+[A-Z]?)\s*[:.]/i.exec(caption.lines?.[0] ?? '')?.[1]
  if (
    number &&
    captions.some((other) => {
      const nextNumber = /^Table\s+(\d+[A-Z]?)\s*[:.]/i.exec(other.lines?.[0] ?? '')?.[1]
      return (
        other !== caption &&
        other.page === caption.page &&
        nextNumber &&
        nextNumber.toLowerCase() !== number.toLowerCase() &&
        other.rect[1] > caption.rect[3] &&
        other.rect[3] <= top + 2 &&
        overlap(other.rect, [left, top, right, bottom]) >=
          Math.min(other.rect[2] - other.rect[0], right - left) * 0.5
      )
    })
  )
    return
  const verticalSegments = rules.filter(
    (rule) =>
      rule[0] === rule[2] &&
      rule[0] > left + 2 &&
      rule[0] < right - 2 &&
      rule[1] <= bottom + 2 &&
      rule[3] >= top - 2 &&
      rule[3] - rule[1] >= 10
  )
  const vertical = cluster(verticalSegments.map((rule) => rule[0]))
  // Open-rule tables may omit both outer borders, but when a source document
  // does draw one of those borders its native segments are still evidence for
  // the table's complete extent.  A missing final segment otherwise lets the
  // fallback recover a second grid whose last rule was dropped from the input
  // (the interior columns remain sufficient for column inference).
  for (const boundary of [left, right]) {
    const segments = rules.filter(
      (rule) =>
        rule[0] === rule[2] &&
        Math.abs(rule[0] - boundary) <= 1.5 &&
        rule[1] <= bottom + 2 &&
        rule[3] >= top - 2 &&
        rule[3] - rule[1] >= 10
    )
    if (segments.length) {
      const covered = segments.reduce(
        (sum, rule) => sum + Math.max(0, Math.min(bottom, rule[3]) - Math.max(top, rule[1])),
        0
      )
      if (covered / Math.max(1, bottom - top) < 0.8) return
    }
  }
  if (
    vertical.length >= 2 &&
    vertical.some((x) => {
      const segments = verticalSegments.filter((rule) => Math.abs(rule[0] - x) <= 1.5)
      const covered = segments.reduce((sum, rule) => sum + Math.max(0, rule[3] - rule[1]), 0)
      return covered < (bottom - top) * 0.8
    })
  )
    return
  const source = items
    .filter(
      (item) =>
        item.horizontal &&
        item.text?.trim() &&
        item.rect?.[1] >= caption.rect[3] - 2 &&
        item.rect?.[3] <= bottom + 2 &&
        overlap(item.rect, [left, top, right, bottom]) > 0
    )
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const centers = []
  for (const item of source) {
    const center = (item.rect[1] + item.rect[3]) / 2
    const previous = centers.at(-1)
    const tolerance = Math.max(2, (item.height || item.rect[3] - item.rect[1]) * 0.7)
    if (!previous || center - previous.center > tolerance) centers.push({ center, items: [item] })
    else {
      previous.items.push(item)
      previous.center =
        previous.items.reduce((sum, current) => sum + (current.rect[1] + current.rect[3]) / 2, 0) /
        previous.items.length
    }
  }
  if (centers.length < 3 || centers.length > 81) return
  let xs
  if (vertical.length >= 2 && vertical.length <= 11) xs = [left, ...vertical, right]
  else {
    const medianHeight = source.map((item) => item.rect[3] - item.rect[1]).sort((a, b) => a - b)[
      Math.floor(source.length / 2)
    ]
    const minColumnHeight = (medianHeight || 4) * 0.9
    const bodyRows = centers.filter(
      ({ items: row }) => row.filter((item) => /\d/u.test(item.text)).length >= 7
    )
    const columnSource = (
      bodyRows.length ? bodyRows.flatMap(({ items: row }) => row) : source
    ).filter((item) => item.rect[3] - item.rect[1] >= minColumnHeight)
    const starts = cluster(
      columnSource.map((item) => item.rect[0]),
      Math.max(2, (medianHeight || 4) * 0.8)
    ).filter((x) => x > left + 2 && x < right - 2)
    if (starts.length < 3 || starts.length > 31) return
    if (bodyRows.length) {
      const tolerance = Math.max(2, (medianHeight || 4) * 0.8)
      const minimumSupport = Math.ceil(bodyRows.length * 0.65)
      const stableStarts = starts.filter(
        (start) =>
          bodyRows.filter(({ items: row }) =>
            row.some(
              (item) =>
                item.rect[3] - item.rect[1] >= minColumnHeight &&
                Math.abs(item.rect[0] - start) <= tolerance
            )
          ).length >= minimumSupport
      )
      const rowCounts = bodyRows.map(
        ({ items: row }) =>
          row.filter((item) => item.rect[3] - item.rect[1] >= minColumnHeight).length
      )
      const rowCountRange = Math.max(...rowCounts) - Math.min(...rowCounts)
      const uniformRows = rowCounts.length >= 4 && rowCountRange <= 3
      if (stableStarts.length < 3 || (!uniformRows && stableStarts.length < starts.length * 0.75))
        return
      xs = [
        left,
        ...stableStarts.slice(1).map((start, index) => (stableStarts[index] + start) / 2),
        right
      ]
    } else {
      xs = [left, ...starts.slice(1).map((start, index) => (starts[index] + start) / 2), right]
    }
  }
  const rowEdges = [
    top,
    ...centers.slice(0, -1).map((row, index) => (row.center + centers[index + 1].center) / 2),
    bottom
  ]
  const numericRows = centers.filter(({ items: row }) =>
    row.some((item) => /\d/u.test(item.text))
  ).length
  if (numericRows < 2) return
  const cropTop = Math.min(top, ...source.map((item) => item.rect[1]))
  return {
    id: `p${pageNumber}-open-rule-table`,
    recoveredGrid: true,
    cropRect: [left, cropTop, right, bottom],
    structure: {
      objects: [
        ...rowEdges.slice(1).map((edge, index) => ({
          label: 'table row',
          rect: [0, rowEdges[index] - cropTop, right - left, edge - cropTop]
        })),
        ...xs.slice(1).map((x, index) => ({
          label: 'table column',
          rect: [xs[index] - left, 0, x - left, bottom - cropTop]
        }))
      ]
    }
  }
}

// A two-leaf grid above its caption needs all native faces, complete populated
// fields and the separate measured stroke bounds. Center lines alone cannot
// authorize this fallback or reserve a neighboring illustration as a table.
function recoverBelowCaptionTwoLeafGrid(items, rules, captions, pageNumber, caption, paint) {
  const finite = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (!(paint instanceof Map) || caption.page !== pageNumber || !finite(caption.rect)) return
  if (items.some((i) => i.text?.trim() && !finite(i.rect))) return
  const seam = 0.02,
    axisRules = rules.filter(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        ((r[0] === r[2] && r[3] > r[1]) || (r[1] === r[3] && r[2] > r[0]))
    ),
    nativeRules = [...new Map(axisRules.map((r) => [r.join(','), r])).values()],
    vertical = nativeRules.filter((r) => r[0] === r[2]),
    horizontal = nativeRules.filter((r) => r[1] === r[3] && r[1] < caption.rect[1]),
    maximumHeight = Math.min(
      caption.rect[3] - caption.rect[1],
      items.reduce(
        (maximum, i) => (Number.isFinite(i.height) ? Math.max(maximum, i.height) : maximum),
        0
      )
    ),
    frames = []
  const painted = (r) => {
    const p = paint.get(r.join(','))
    if (
      !finite(p) ||
      p[0] > r[0] ||
      p[1] > r[1] ||
      p[2] < r[2] ||
      p[3] < r[3] ||
      (r[0] === r[2] ? Math.abs((p[0] + p[2]) / 2 - r[0]) : Math.abs((p[1] + p[3]) / 2 - r[1])) >
        seam
    )
      return
    return p
  }
  // Only native closings in the caption's short font-sized corridor can start
  // a search. Retain the existing ruled-grid bound of at most 81 row edges.
  for (const closing of horizontal.filter(
    (r) =>
      caption.rect[1] - r[1] <= maximumHeight * 2 &&
      Math.abs((caption.rect[0] + caption.rect[2] - r[0] - r[2]) / 2) <= maximumHeight * 0.25
  )) {
    const family = horizontal.filter(
      (r) =>
        r[1] <= closing[1] &&
        Math.abs(r[0] - closing[0]) < seam &&
        Math.abs(r[2] - closing[2]) < seam
    )
    if (family.length < 4 || family.length > 81) continue
    family.sort((a, b) => a[1] - b[1])
    for (let start = 0; start <= family.length - 4; start++) {
      const edges = family.slice(start),
        frame = [edges[0][0], edges[0][1], edges[0][2], edges.at(-1)[1]],
        owned = items.filter((i) => i.text?.trim() && intersect(i.rect, frame) > 0),
        h = owned.reduce((maximum, i) => Math.max(maximum, i.height), 0)
      if (
        !finite(frame) ||
        !Number.isFinite(h) ||
        h <= 0 ||
        owned.some(
          (i) =>
            !finite(i.rect) ||
            !i.horizontal ||
            !Number.isFinite(i.height) ||
            i.height <= 0 ||
            !Number.isFinite(i.baseline) ||
            Math.abs(i.rect[3] - i.baseline) > seam ||
            Math.abs(i.rect[3] - i.rect[1] - i.height) > seam ||
            i.rect[0] < frame[0] ||
            i.rect[2] > frame[2] ||
            i.rect[1] < frame[1] ||
            i.rect[3] > frame[3]
        ) ||
        new Set(owned.map((i) => i.rect.join(','))).size !== owned.length ||
        caption.rect[1] - frame[3] <= 0 ||
        caption.rect[1] - frame[3] > h * 2 ||
        Math.abs((caption.rect[0] + caption.rect[2] - frame[0] - frame[2]) / 2) > h * 0.25
      )
        continue
      const sides = vertical.filter(
          (r) => r[0] >= frame[0] && r[0] <= frame[2] && r[1] < frame[3] && r[3] > frame[1]
        ),
        xs = [...new Set(sides.map((r) => r[0]))].sort((a, b) => a - b),
        used = [...edges, ...sides],
        bounds = used.map(painted)
      if (
        xs.length !== 3 ||
        bounds.some((p) => !p) ||
        sides.some((r) => r[1] < frame[1] - seam || r[3] > frame[3] + seam) ||
        bounds.some((p, n) => (used[n][0] === used[n][2] ? p[2] - p[0] : p[3] - p[1]) > h * 0.5) ||
        vertical.some(
          (r) =>
            xs.includes(r[0]) &&
            ((r[1] < frame[1] - h * 0.25 && r[3] >= frame[1] - h * 0.25) ||
              (r[3] > frame[3] + h * 0.25 && r[1] <= frame[3] + h * 0.25))
        )
      )
        continue
      let complete = true
      for (let row = 0; row < edges.length - 1 && complete; row++) {
        const upper = painted(edges[row]),
          lower = painted(edges[row + 1])
        for (const x of xs) {
          const pieces = sides
            .filter((r) => r[0] === x)
            .map(painted)
            .filter((p) => p[3] > upper[3] - seam && p[1] < lower[1] + seam)
            .sort((a, b) => a[1] - b[1])
          let reached = upper[3]
          for (const p of pieces) {
            if (p[1] > reached + seam) {
              complete = false
              break
            }
            reached = Math.max(reached, p[3])
            if (
              (x === xs[0] && Math.abs(p[0] - upper[0]) > seam) ||
              (x === xs[2] && Math.abs(p[2] - upper[2]) > seam)
            ) {
              complete = false
              break
            }
          }
          if (reached < lower[1] - seam) complete = false
        }
      }
      if (!complete) continue
      const cells = []
      for (let row = 0; row < edges.length - 1 && complete; row++) {
        const rowOrdinary = []
        for (let column = 0; column < 2; column++) {
          const fonts = owned.filter(
              (i) =>
                i.rect[0] >= xs[column] &&
                i.rect[2] <= xs[column + 1] &&
                i.baseline > edges[row][1] &&
                i.baseline < edges[row + 1][1] &&
                (i.rect[1] + i.rect[3]) / 2 > edges[row][1] &&
                (i.rect[1] + i.rect[3]) / 2 < edges[row + 1][1]
            ),
            ordinary = fonts.filter((i) => Math.abs(i.height - h) < seam)
          if (
            !ordinary.length ||
            fonts.some(
              (child) =>
                !ordinary.includes(child) &&
                ordinary.filter(
                  (parent) =>
                    isAdjacentTableScript(child, parent) &&
                    Math.abs(child.rect[0] - parent.rect[2]) <= h * 0.05
                ).length !== 1
            )
          ) {
            complete = false
            break
          }
          rowOrdinary.push(...ordinary)
          cells.push(...fonts)
        }
        if (rowOrdinary.some((i) => Math.abs(i.baseline - rowOrdinary[0].baseline) > seam))
          complete = false
      }
      if (!complete || cells.length !== owned.length || new Set(cells).size !== owned.length)
        continue
      const crop = bounds.reduce(
          (a, p) => [
            Math.min(a[0], p[0]),
            Math.min(a[1], p[1]),
            Math.max(a[2], p[2]),
            Math.max(a[3], p[3])
          ],
          [...bounds[0]]
        ),
        corridor = [crop[0], crop[3], crop[2], caption.rect[1]]
      if (
        !finite(corridor) ||
        items.some(
          (i) =>
            i.text?.trim() &&
            ((intersect(i.rect, crop) > 0 && !owned.includes(i)) || intersect(i.rect, corridor) > 0)
        ) ||
        nativeRules.some(
          (r) =>
            Math.max(r[0], crop[0]) <= Math.min(r[2], crop[2]) &&
            Math.max(r[1], crop[1]) <= Math.min(r[3], crop[3]) &&
            !used.includes(r)
        ) ||
        captions.some(
          (c) =>
            c !== caption &&
            c.page === pageNumber &&
            (intersect(c.rect, crop) > 0 ||
              intersect(c.rect, corridor) > 0 ||
              (captionKind(c.lines?.[0]) === 'table' &&
                finite(c.rect) &&
                c.rect[1] > crop[3] &&
                c.rect[1] - crop[3] < h * 2 &&
                Math.abs((c.rect[0] + c.rect[2] - frame[0] - frame[2]) / 2) < h * 0.25))
        )
      )
        continue
      frames.push({ crop, edges, xs })
    }
  }
  if (frames.length !== 1) return
  const { crop, edges, xs } = frames[0]
  return {
    id: `p${pageNumber}-below-caption-two-leaf-table`,
    recoveredGrid: true,
    cropRect: crop,
    structure: {
      objects: [
        ...edges.slice(1).map((edge, row) => ({
          label: 'table row',
          rect: [0, edges[row][1] - crop[1], crop[2] - crop[0], edge[1] - crop[1]]
        })),
        ...xs.slice(1).map((x, column) => ({
          label: 'table column',
          rect: [xs[column] - crop[0], 0, x - crop[0], crop[3] - crop[1]]
        }))
      ]
    }
  }
}

// Open outer sides are permitted only with complete native booktabs paint,
// continuing leaf fences and a complete scalar record in every body band.
// The two header faces follow the actual partial divider and parent fences.
function recoverBelowCaptionBooktabs(items, rules, captions, pageNumber, caption, paint, runs) {
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const axis = (r) =>
    Array.isArray(r) &&
    r.length === 4 &&
    r.every(Number.isFinite) &&
    ((r[0] === r[2] && r[3] > r[1]) || (r[1] === r[3] && r[2] > r[0]))
  if (
    !(paint instanceof Map) ||
    !Array.isArray(runs) ||
    !runs.length ||
    !rect(caption.rect) ||
    caption.page !== pageNumber ||
    rules.some((r) => !axis(r)) ||
    items.some((i) => i.text?.trim() && !rect(i.rect))
  )
    return
  const native = [...new Map(rules.map((r) => [r.join(','), r])).values()],
    hs = native.filter((r) => r[1] === r[3] && r[1] < caption.rect[1]),
    vs = native.filter((r) => r[0] === r[2]),
    maxHeight = Math.max(...items.filter((i) => i.text?.trim()).map((i) => i.height)),
    found = []
  const painted = (r) => {
    const p = paint.get(r.join(','))
    return rect(p) && p[0] <= r[0] && p[1] <= r[1] && p[2] >= r[2] && p[3] >= r[3] ? p : undefined
  }
  for (const closing of hs.filter(
    (r) =>
      caption.rect[1] - r[1] > 0 &&
      caption.rect[1] - r[1] < maxHeight * 2 &&
      Math.abs((r[0] + r[2] - caption.rect[0] - caption.rect[2]) / 2) < maxHeight * 0.25
  )) {
    const edges = hs
      .filter(
        (r) =>
          r[1] <= closing[1] &&
          Math.abs(r[0] - closing[0]) < 0.02 &&
          Math.abs(r[2] - closing[2]) < 0.02
      )
      .sort((a, b) => a[1] - b[1])
      .slice(-3)
    if (edges.length !== 3) continue
    const [opening, floor] = edges,
      frame = [opening[0], opening[1], opening[2], closing[1]],
      partials = hs.filter(
        (r) =>
          r[1] > opening[1] &&
          r[1] < floor[1] &&
          r[0] > frame[0] &&
          Math.abs(r[2] - frame[2]) < 0.02
      ),
      sides = vs.filter(
        (r) => r[0] > frame[0] && r[0] < frame[2] && r[1] < frame[3] && r[3] > frame[1]
      )
    if (partials.length !== 1) continue
    const partial = partials[0],
      xs = [...new Set(sides.map((r) => r[0]))].sort((a, b) => a - b),
      used = [...edges, partial, ...sides],
      bounds = used.map(painted)
    if (
      xs.length < 2 ||
      xs.length > 10 ||
      bounds.some((p) => !p) ||
      sides.some((r) => r[1] < frame[1] - 0.02 || r[3] > frame[3] + 0.02) ||
      native.some(
        (r) =>
          Math.max(r[0], frame[0]) <= Math.min(r[2], frame[2]) &&
          Math.max(r[1], frame[1]) <= Math.min(r[3], frame[3]) &&
          !used.includes(r)
      )
    )
      continue
    const [op, fp, cp, pp] = bounds,
      covered = (x, top, bottom) => {
        let reached = top
        const segments = [
          ...sides.filter((r) => r[0] === x).map(painted),
          ...[op, fp, cp, pp].filter((p) => p[0] <= x && p[2] >= x)
        ]
        for (const p of segments
          .filter((p) => p[3] > top && p[1] < bottom)
          .sort((a, b) => a[1] - b[1])) {
          if (p[1] > reached + 0.02) return false
          reached = Math.max(reached, p[3])
        }
        return reached >= bottom - 0.02
      }
    if (Math.abs(pp[0] - xs[0]) > maxHeight * 0.1 || !xs.every((x) => covered(x, pp[3], cp[1])))
      continue
    const parentCuts = xs.filter((x) => covered(x, op[3], pp[1]))
    if (
      parentCuts.length < 2 ||
      parentCuts[0] !== xs[0] ||
      xs.some(
        (x) => !parentCuts.includes(x) && sides.some((r) => r[0] === x && r[1] < pp[1] - 0.02)
      )
    )
      continue
    const cuts = [frame[0], ...xs, frame[2]],
      parentEdges = [...parentCuts, frame[2]],
      fonts = items.filter((i) => i.text?.trim() && intersect(i.rect, frame) > 0),
      height = Math.max(...fonts.map((i) => i.height))
    if (
      !fonts.length ||
      !Number.isFinite(height) ||
      height <= 0 ||
      bounds.some(
        (p, n) => (used[n][0] === used[n][2] ? p[2] - p[0] : p[3] - p[1]) > height * 0.2
      ) ||
      fonts.some(
        (i) =>
          !i.horizontal ||
          !Number.isFinite(i.height) ||
          i.height <= 0 ||
          !Number.isFinite(i.baseline) ||
          Math.abs(i.rect[3] - i.baseline) > 0.02 ||
          Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02 ||
          i.rect[0] < frame[0] ||
          i.rect[2] > frame[2] ||
          i.rect[1] < frame[1] ||
          i.rect[3] > frame[3] ||
          Math.abs(i.height - height) > 0.02
      ) ||
      new Set(fonts.map((i) => i.rect.join(',') + '|' + i.text)).size !== fonts.length ||
      fonts.some((i, n) =>
        fonts
          .slice(n + 1)
          .some(
            (j) =>
              Math.min(i.rect[2], j.rect[2]) - Math.max(i.rect[0], j.rect[0]) > 0.02 &&
              Math.min(i.rect[3], j.rect[3]) - Math.max(i.rect[1], j.rect[1]) > 0.02
          )
      )
    )
      continue
    // Every complete source string must have all of its original literal glyph
    // observations. No token is cut at a rule or inferred by its center.
    const complete = fonts.every((i) => {
      const observations = runs.filter(
        (r) =>
          r.text === i.text &&
          rect(r.rect) &&
          r.rect.every((v, n) => Math.abs(v - i.rect[n]) < 0.02)
      )
      if (observations.length !== 1) return false
      const r = observations[0],
        chars = [...i.text.replace(/\s/gu, '')]
      return (
        Number.isFinite(r.height) &&
        Math.abs(r.height - i.height) < 0.02 &&
        Number.isFinite(r.baseline) &&
        Math.abs(r.baseline - i.baseline) < 0.02 &&
        Array.isArray(r.literalGlyphs) &&
        r.literalGlyphs.join('') === chars.join('') &&
        Array.isArray(r.glyphRuns) &&
        r.glyphRuns.length === chars.length &&
        r.glyphRuns.every((n) => Number.isInteger(n) && n >= 0)
      )
    })
    if (!complete) continue
    const lane = (i) =>
        cuts.slice(1).flatMap((x, c) => (i.rect[0] >= cuts[c] && i.rect[2] <= x ? [c] : [])),
      header = fonts.filter((i) => i.baseline < floor[1]),
      body = fonts.filter((i) => i.baseline > floor[1]),
      records = []
    for (const i of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const last = records.at(-1)
      if (last && Math.abs(last[0].baseline - i.baseline) < 0.02) last.push(i)
      else records.push([i])
    }
    if (
      records.length < 2 ||
      records.length > 40 ||
      header.length + body.length !== fonts.length ||
      records.some(
        (g) =>
          g.some((i) => lane(i).length !== 1) ||
          cuts.slice(1).some((_, c) => {
            const cell = g.filter((i) => lane(i)[0] === c),
              text = cell
                .map((i) => i.text)
                .join('')
                .replace(/\s/gu, '')
            return (
              !cell.length || (c > 0 && (cell.length !== 1 || !/^[-+−]?\d+(?:\.\d+)?$/u.test(text)))
            )
          })
      )
    )
      continue
    const stub = header.filter((i) => lane(i)[0] === 0),
      leaves = cuts
        .slice(2)
        .map((_, c) => header.filter((i) => lane(i)[0] === c + 1 && i.baseline > partial[1])),
      parents = parentEdges
        .slice(1)
        .map((x, c) =>
          header.filter(
            (i) => i.rect[0] >= parentEdges[c] && i.rect[2] <= x && i.baseline < partial[1]
          )
        )
    const assigned = [...stub, ...leaves.flat(), ...parents.flat()]
    if (
      !stub.length ||
      leaves.some((g) => !g.length) ||
      parents.some((g) => !g.length) ||
      assigned.length !== header.length ||
      new Set(assigned).size !== header.length
    )
      continue
    const firstSplit = Math.min(partial[1], ...leaves.flat().map((i) => i.rect[1])),
      secondSplit = Math.min(floor[1], ...records[0].map((i) => i.rect[1]))
    if (
      parents.flat().some((i) => i.rect[3] >= firstSplit) ||
      leaves.flat().some((i) => i.rect[3] >= secondSplit) ||
      stub.some((i) => i.rect[3] > secondSplit)
    )
      continue
    const rowEdges = [frame[1], firstSplit, secondSplit]
    let separated = true
    for (let n = 1; n < records.length; n++) {
      const a = Math.max(...records[n - 1].map((i) => i.rect[3])),
        b = Math.min(...records[n].map((i) => i.rect[1]))
      if (a >= b) {
        separated = false
        break
      }
      rowEdges.push((a + b) / 2)
    }
    if (!separated) continue
    rowEdges.push(frame[3])
    const crop = bounds.reduce(
        (a, p) => [
          Math.min(a[0], p[0]),
          Math.min(a[1], p[1]),
          Math.max(a[2], p[2]),
          Math.max(a[3], p[3])
        ],
        [...bounds[0]]
      ),
      corridor = [crop[0], crop[3], crop[2], caption.rect[1]]
    if (
      !rect(corridor) ||
      items.some(
        (i) =>
          i.text?.trim() &&
          ((intersect(i.rect, crop) > 0 && !fonts.includes(i)) || intersect(i.rect, corridor) > 0)
      ) ||
      captions.some(
        (c) =>
          c !== caption &&
          c.page === pageNumber &&
          (intersect(c.rect, crop) > 0 ||
            intersect(c.rect, corridor) > 0 ||
            (captionKind(c.lines?.[0]) === 'table' &&
              rect(c.rect) &&
              c.rect[1] > crop[3] &&
              c.rect[1] - crop[3] < height * 2 &&
              Math.abs((c.rect[0] + c.rect[2] - frame[0] - frame[2]) / 2) < height * 0.25))
      )
    )
      continue
    found.push({ crop, cuts, rowEdges, parentEdges, headerBottom: secondSplit })
  }
  if (found.length !== 1) return
  const { crop, cuts, rowEdges, parentEdges, headerBottom } = found[0],
    local = (r) => r.map((v, i) => v - crop[i % 2])
  return {
    id: `page-${pageNumber}-table-1`,
    recoveredGrid: true,
    cropRect: crop,
    structure: {
      objects: [
        ...rowEdges.slice(1).map((bottom, n) => ({
          label: 'table row',
          rect: local([crop[0], rowEdges[n], crop[2], bottom])
        })),
        ...cuts.slice(1).map((right, n) => ({
          label: 'table column',
          rect: local([cuts[n], crop[1], right, crop[3]])
        })),
        {
          label: 'table column header',
          rect: local([crop[0], rowEdges[0], crop[2], headerBottom])
        },
        {
          label: 'table spanning cell',
          rect: local([cuts[0], rowEdges[0], cuts[1], headerBottom])
        },
        ...parentEdges.slice(1).map((right, n) => ({
          label: 'table spanning cell',
          rect: local([parentEdges[n], rowEdges[0], right, rowEdges[1]])
        }))
      ]
    }
  }
}

// Use each explicit caption to bound a separate grid. Page frames and ordinary
// forms cannot opt into recovery without a complete source-owned lattice.
export function recoverCaptionedRuledTables(
  items,
  rules,
  captions,
  pageNumber,
  existing = [],
  rulePaintBounds,
  runs = []
) {
  const tables = []
  const candidates = captions.filter((c) => captionKind(c.lines[0]) === 'table')
  // A detector can already provide the complete table while the open-rule
  // fallback sees the first horizontal rule after the caption and then keeps
  // walking through body prose until the next rule.  The caption may be above
  // or below a table, so use a short gap on either side plus a real native
  // row/column grid before suppressing only that fallback.  A partial detector
  // box with unresolved source text remains eligible for recovery.
  const hasCompleteCaptionedTable = (caption) => {
    const captionHeight = Math.max(1, caption.rect[3] - caption.rect[1])
    return existing.some((table) => {
      const crop = table?.cropRect
      if (!crop) return false
      const overlap = Math.min(caption.rect[2], crop[2]) - Math.max(caption.rect[0], crop[0])
      const width = Math.min(caption.rect[2] - caption.rect[0], crop[2] - crop[0])
      if (overlap / Math.max(1, width) < 0.5) return false
      const aboveGap = caption.rect[1] - crop[3]
      const belowGap = crop[1] - caption.rect[3]
      const nearCaption =
        (aboveGap >= -2 && aboveGap <= Math.max(36, captionHeight * 8)) ||
        (belowGap >= -2 && belowGap <= Math.max(36, captionHeight * 8))
      if (!nearCaption) return false
      const objects = table.structure?.objects ?? []
      const rows = objects.filter((object) => object.label === 'table row').length
      const columns = objects.filter((object) => object.label === 'table column').length
      if (rows < 2 || columns < 2) return false
      const source = items.filter(
        (item) => item.horizontal && item.text?.trim() && intersect(item.rect, crop) > 0
      )
      if (source.length < rows) return false
      const baselines = new Set(source.map((item) => Math.round(item.baseline ?? item.rect[3])))
      const numeric = source.filter((item) => /\d/u.test(item.text)).length
      return baselines.size >= 2 && numeric >= 2
    })
  }
  for (const [index, caption] of candidates.entries()) {
    const closed =
      recoverBelowCaptionTwoLeafGrid(
        items,
        rules,
        captions,
        pageNumber,
        caption,
        rulePaintBounds
      ) ??
      recoverBelowCaptionBooktabs(
        items,
        rules,
        captions,
        pageNumber,
        caption,
        rulePaintBounds,
        runs
      )
    if (closed) {
      if (
        ![...existing, ...tables].some(
          (t) => intersect(t.cropRect, closed.cropRect) > area(closed.cropRect) * 0.5
        )
      ) {
        closed.caption = caption
        if (closed.id === `page-${pageNumber}-table-1`) {
          const pattern = new RegExp(`^page-${pageNumber}-table-(\\d+)$`)
          const numbers = [...existing, ...tables].map((table) =>
            Number(pattern.exec(table.id)?.[1] ?? 0)
          )
          const number = Math.max(0, ...numbers) + 1
          closed.id = `page-${pageNumber}-table-${number}`
        } else closed.id += `-${index}`
        tables.push(closed)
      }
      continue
    }
    const next = candidates
      .filter((c) => c.rect[1] > caption.rect[3] && Math.abs(c.rect[0] - caption.rect[0]) < 4)
      .sort((a, b) => a.rect[1] - b.rect[1])[0]
    const bounded = rules.filter(
      (r) =>
        r[0] >= caption.rect[0] - 2 &&
        r[1] >= caption.rect[3] - 2 &&
        r[3] <= (next?.rect[1] ?? Infinity)
    )
    const ruled = recoverRuledTable(items, bounded, pageNumber, caption)
    const openRule = hasCompleteCaptionedTable(caption)
      ? undefined
      : recoverCaptionedOpenRuleTable(items, bounded, pageNumber, caption, candidates)
    const recovered =
      openRule &&
      (!ruled ||
        (openRule.cropRect[3] - openRule.cropRect[1] > ruled.cropRect[3] - ruled.cropRect[1] + 12 &&
          openRule.structure.objects.filter((object) => object.label === 'table row').length >=
            ruled.structure.objects.filter((object) => object.label === 'table row').length))
        ? openRule
        : ruled
    if (recovered) {
      // An indented caption can clip the stub column's border from `bounded`.
      // Check the original separators before accepting the remaining numeric grid.
      const [left, top, right] = recovered.cropRect
      const boundaries = recovered.structure.objects
        .filter((o) => o.label === 'table row')
        .flatMap((o) => [o.rect[1] + top, o.rect[3] + top])
      const overhangs = rules.filter(
        (r) =>
          r[1] === r[3] &&
          boundaries.some((y) => Math.abs(r[1] - y) <= 1) &&
          ((r[0] < left - 2 && r[2] >= left - 2) || (r[2] > right + 2 && r[0] <= right + 2))
      )
      if (clusterTableRulePositions(overhangs.map((r) => r[1])).length >= 2) continue
    }
    if (
      !recovered ||
      [...existing, ...tables].some(
        (t) => intersect(t.cropRect, recovered.cropRect) > area(recovered.cropRect) * 0.5
      )
    )
      continue
    recovered.caption = caption
    recovered.id += `-${index}`
    tables.push(recovered)
  }
  return tables
}

// Consecutive table numbers with full-width rules or separate centered titles
// can split one detector box. Subsections A/B and continued titles cannot.
export function splitCaptionedTableRegions(table, captions, rules) {
  const [left, top, right, bottom] = table.cropRect
  const anchors = captions
    .flatMap((caption) => {
      const number = /^Table\s+(\d+)\s*$/i.exec(caption.lines[0])?.[1]
      if (
        !number ||
        caption.rect[0] < left ||
        caption.rect[2] > right ||
        caption.rect[1] < top - 100 ||
        caption.rect[3] >= bottom
      )
        return []
      const rule = rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= caption.rect[3] &&
            r[1] - caption.rect[3] < (caption.rect[3] - caption.rect[1]) * 4 &&
            Math.abs(r[0] - left) < 15 &&
            Math.abs(r[2] - right) < 15
        )
        .sort((a, b) => a[1] - b[1])[0]
      // Scanned tables have no vector rules. A separately captured descriptive
      // title and centered consecutive table numbers provide the alternative.
      const titled =
        caption.lines.length > 1 &&
        Math.abs((caption.rect[0] + caption.rect[2] - left - right) / 2) < (right - left) * 0.1
      return rule || titled
        ? [
            {
              caption,
              number: Number(number),
              rule: rule ?? [
                left,
                Math.max(top, caption.rect[3] + 2),
                right,
                Math.max(top, caption.rect[3] + 2)
              ]
            }
          ]
        : []
    })
    .sort((a, b) => a.rule[1] - b.rule[1])
  if (
    anchors.length < 2 ||
    anchors[0].rule[1] > top + 20 ||
    anchors.some((a, i) => i && a.number !== anchors[i - 1].number + 1)
  )
    return [table]
  const parts = anchors.map((anchor, index) => {
    const cropRect = [left, anchor.rule[1], right, anchors[index + 1]?.caption.rect[1] ?? bottom]
    const objects = table.structure.objects.flatMap((o) => {
      const rect = o.rect.map((v, i) => v + table.cropRect[i % 2])
      if (rect[3] <= cropRect[1] || rect[1] >= cropRect[3]) return []
      if (o.label === 'table spanning cell' && (rect[1] < cropRect[1] || rect[3] > cropRect[3]))
        return []
      const clipped = [
        Math.max(left, rect[0]),
        Math.max(cropRect[1], rect[1]),
        Math.min(right, rect[2]),
        Math.min(cropRect[3], rect[3])
      ]
      if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1]) return []
      return [{ ...o, rect: clipped.map((v, i) => v - cropRect[i % 2]) }]
    })
    return {
      ...table,
      id: `${table.id}-part-${index + 1}`,
      splitCaptionedRegion: true,
      cropRect,
      structure: { ...table.structure, objects }
    }
  })
  return parts.every((p) => p.structure.objects.filter((o) => o.label === 'table row').length >= 3)
    ? parts
    : [table]
}
