/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside, rebaseTableCrop } from './literature-pdf-table-geometry.mjs'

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
export function narrativeDuplicateTableIndices(tables, { captionedIndices = new Set() } = {}) {
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
    const a = outer?.cropRect
    const outerRows = outer?.grid ?? []
    const outerColumns = Math.max(0, ...outerRows.map((row) => row.length))
    if (!a || outerColumns < 3 || !outerRows.length) continue
    if (
      !(outer.issues ?? []).includes('text-crosses-crop-boundary') ||
      (outer.unassigned?.length ?? 0) < 3
    )
      continue
    const outerWidth = a[2] - a[0]
    const outerHeight = a[3] - a[1]
    const firstColumn = outerRows.map((row) => normalizeCell(row[0])).filter(Boolean)
    const numericFirst = firstColumn.filter((value) =>
      /^[<>≤≥+-]?\d[\d.,]*(?:[kKmMbB])?$/u.test(value)
    )
    if (numericFirst.length < Math.max(2, Math.ceil(firstColumn.length * 0.55))) continue
    for (let innerIndex = 0; innerIndex < tables.length; innerIndex++) {
      if (innerIndex === outerIndex) continue
      const inner = tables[innerIndex]
      const b = inner?.cropRect
      const innerRows = inner?.grid ?? []
      const innerColumns = Math.max(0, ...innerRows.map((row) => row.length))
      if (!b || innerColumns !== outerColumns - 1 || innerRows.length < 2) continue
      if ((outer.unassigned?.length ?? 0) <= (inner.unassigned?.length ?? 0) * 1.5) continue
      const vertical =
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) /
        Math.max(1, Math.min(outerHeight, b[3] - b[1]))
      const rightDelta = Math.abs(a[2] - b[2])
      const leftShift = b[0] - a[0]
      if (
        vertical < 0.9 ||
        rightDelta > 20 ||
        leftShift <= 2 ||
        leftShift > outerWidth * 0.16 ||
        outerWidth - (b[2] - b[0]) > outerWidth * 0.2 ||
        suffixMatchRatio(outer, inner) < 0.7
      )
        continue
      duplicate.add(outerIndex)
      break
    }
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

// Use each explicit caption to bound a separate grid. Page frames begin above
// the caption and are excluded; ordinary forms cannot opt into this recovery.
export function recoverCaptionedRuledTables(items, rules, captions, pageNumber, existing = []) {
  const tables = []
  const candidates = captions.filter((c) => captionKind(c.lines[0]) === 'table')
  for (const [index, caption] of candidates.entries()) {
    const next = candidates
      .filter((c) => c.rect[1] > caption.rect[3] && Math.abs(c.rect[0] - caption.rect[0]) < 4)
      .sort((a, b) => a.rect[1] - b.rect[1])[0]
    const bounded = rules.filter(
      (r) =>
        r[0] >= caption.rect[0] - 2 &&
        r[1] >= caption.rect[3] - 2 &&
        r[3] <= (next?.rect[1] ?? Infinity)
    )
    const recovered = recoverRuledTable(items, bounded, pageNumber, caption)
    if (
      !recovered ||
      [...existing, ...tables].some(
        (t) => intersect(t.cropRect, recovered.cropRect) > area(recovered.cropRect) * 0.5
      )
    )
      continue
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
