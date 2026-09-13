/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { area, intersection as intersect } from './literature-pdf-page-geometry.mjs'
import { inside } from './literature-pdf-table-geometry.mjs'

// Near-identical detector boxes can compete for the same caption. Collapse them
// only when they enclose exactly the same native tokens, including edge text.
export function deduplicateTableRegions(tables, items) {
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
