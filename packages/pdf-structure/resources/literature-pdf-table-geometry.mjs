/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { classifyTableRuleEdge, joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  captionKind,
  sourceWordSpellings,
  hasWitnessedLineEndHyphen
} from './literature-pdf-caption-group.mjs'
// Analysis may inspect two preceding pages for a captionless continuation.
// Emit distant geometry only when a returned caption actually references it.
export function selectResultGeometryPages(pages, requestedPages, elements) {
  const requested = new Set(requestedPages)
  const captionPages = new Set(
    elements.flatMap((element) =>
      element.caption
        ? [
            element.caption.page ?? element.page,
            ...(element.caption.regions ?? []).map((region) => region.page)
          ]
        : []
    )
  )
  return pages.filter(
    ({ pageNumber }) =>
      requested.has(pageNumber) ||
      requested.has(pageNumber - 1) ||
      requested.has(pageNumber + 1) ||
      captionPages.has(pageNumber)
  )
}

// Source table tokens expose their page-space bounds through item.rect.
export const inside = (rect, item) => {
  const x = (item.rect[0] + item.rect[2]) / 2,
    y = (item.rect[1] + item.rect[3]) / 2
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
}
export const union = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]

// Repeated native rule segments can outlive a detector crop even when every
// literal font fits. Require complete leaf owners and every measured paint bound;
// only the right edge grows, without inventing a vertical table fence.
export function completeRepeatedHorizontalRuleCarrierCrop(
  table,
  rules,
  pageSize,
  pageItems,
  rulePaintBounds,
  graphics = [],
  pageFontItems = []
) {
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-7 : v <= a[n] + 1e-7))
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const same = (a, b, tolerance = 0.02) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every(
      (v, n) => Number.isFinite(v) && Number.isFinite(b[n]) && Math.abs(v - b[n]) <= tolerance
    )
  const fontRect = (f) => [f.rect[0], f.rect[1], f.rect[2], f.rect[3] - f.fontDescent * f.height]
  if (
    !table ||
    typeof table !== 'object' ||
    ![
      rules,
      pageSize,
      pageItems,
      graphics,
      pageFontItems,
      table.cells,
      table.grid,
      table.unassigned
    ].every(Array.isArray) ||
    pageSize.length !== 2 ||
    !pageSize.every((v) => Number.isFinite(v) && v > 0) ||
    !(rulePaintBounds instanceof Map) ||
    !pageFontItems.length ||
    !graphics.length ||
    (table.readingRotation !== undefined &&
      (!Number.isFinite(table.readingRotation) || table.readingRotation !== 0)) ||
    !Array.isArray(table.clipped) ||
    table.clipped.length ||
    ['parts', 'notes'].some(
      (key) => table[key] !== undefined && (!Array.isArray(table[key]) || table[key].length)
    ) ||
    table.unassigned.length ||
    (table.issues !== undefined && (!Array.isArray(table.issues) || table.issues.length)) ||
    !rect(table.cropRect)
  )
    return
  const rows = table.grid.length,
    columns = table.grid[0]?.length
  if (
    rows < 3 ||
    !Number.isInteger(columns) ||
    columns < 2 ||
    !table.grid.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columns &&
        row.every((t) => typeof t === 'string' && t.trim())
    ) ||
    table.cells.length !== rows * columns ||
    rules.length > 81 ||
    rulePaintBounds.size !== rules.length
  )
    return
  if (
    !pageItems.every(
      (i) =>
        i && typeof i === 'object' && typeof i.text === 'string' && (!i.text.trim() || rect(i.rect))
    )
  )
    return
  if (
    !pageFontItems.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        typeof f.text === 'string' &&
        f.horizontal === true &&
        rect(f.rect) &&
        [f.height, f.baseline, f.fontDescent].every(Number.isFinite) &&
        f.height > 0 &&
        f.fontDescent >= -1 &&
        f.fontDescent <= 0 &&
        Math.abs(f.rect[3] - f.rect[1] - f.height) <= 1e-6 &&
        Math.abs(f.rect[3] - f.baseline) <= 1e-6
    )
  )
    return
  if (!graphics.every((g) => g && typeof g === 'object' && g.kind === 'path' && rect(g.rect)))
    return
  if (
    !rules.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] > r[0] &&
        r[1] === r[3] &&
        rulePaintBounds.has(r.join(',')) &&
        rect(rulePaintBounds.get(r.join(',')))
    )
  )
    return
  const owners = [],
    slots = new Set()
  for (const c of table.cells) {
    if (
      !c ||
      typeof c !== 'object' ||
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      c.row < 0 ||
      c.row >= rows ||
      c.column < 0 ||
      c.column >= columns ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      typeof c.text !== 'string' ||
      !c.text.trim() ||
      !Array.isArray(c.sourceRects) ||
      !Array.isArray(c.sourceTokens) ||
      !c.sourceRects.length ||
      c.sourceRects.length !== c.sourceTokens.length ||
      slots.has(c.row + ',' + c.column)
    )
      return
    slots.add(c.row + ',' + c.column)
    for (let n = 0; n < c.sourceRects.length; n++) {
      const r = c.sourceRects[n],
        token = c.sourceTokens[n]
      if (
        !rect(r) ||
        !token ||
        typeof token !== 'object' ||
        typeof token.text !== 'string' ||
        !rect(token.rect) ||
        !same(token.rect, r, 1e-7)
      )
        return
      const matches = pageFontItems.filter((f) => f.text === token.text && same(f.rect, r, 1e-7))
      if (matches.length !== 1 || owners.some((o) => o.font === matches[0])) return
      owners.push({ cell: c, font: matches[0] })
    }
  }
  if (!owners.length || table.cells.some((c) => table.grid[c.row][c.column] !== c.text)) return
  const heights = owners.map((o) => o.font.height).sort((a, b) => a - b),
    height = heights[heights.length >> 1]
  const ys = [...new Set(rules.map((r) => r[1]))].sort((a, b) => a - b)
  if (
    ys.length !== rows + 1 ||
    rules.length !== ys.length * columns ||
    ys[0] < table.cropRect[1] ||
    ys.at(-1) > table.cropRect[3]
  )
    return
  const bands = ys.map((y) => rules.filter((r) => r[1] === y).sort((a, b) => a[0] - b[0]))
  if (
    !bands.every((b) => b.length === columns) ||
    !bands
      .slice(0, -1)
      .every((b) => b.every((r, n) => same([r[0], r[2]], [bands[0][n][0], bands[0][n][2]]))) ||
    !bands[0].every(
      (r, n) =>
        r[2] - r[0] >= height * 3 &&
        (!n || (r[0] > bands[0][n - 1][2] && r[0] - bands[0][n - 1][2] <= height * 0.1))
    )
  )
    return
  // Closing left paint can overlap a narrow existing seam. It does not create a
  // vertical fence or a new leaf; its right endpoint must still match exactly.
  if (
    !bands.at(-1).every((r, n) => {
      const p = rulePaintBounds.get(r.join(',')),
        opening = bands[0][n]
      return (
        Math.abs(r[2] - opening[2]) <= 0.02 &&
        r[0] <= opening[0] + 0.02 &&
        opening[0] - r[0] <= 2 * (p[3] - p[1]) + 0.02
      )
    })
  )
    return
  if (!ys.slice(1).every((y, n) => y - ys[n] >= height * 1.5 && y - ys[n] <= height * 4)) return
  for (const { cell: c, font: f } of owners) {
    const lane = bands[c.row][c.column]
    if (
      f.rect[0] < lane[0] - 1e-7 ||
      f.rect[2] > lane[2] + 1e-7 ||
      f.baseline < ys[c.row] ||
      f.baseline > ys[c.row + 1] ||
      !contains(table.cropRect, fontRect(f))
    )
      return
  }
  const painted = rules.map((r) => rulePaintBounds.get(r.join(',')))
  if (
    painted.some(
      (p, n) =>
        Math.abs((p[1] + p[3]) / 2 - rules[n][1]) > 0.02 ||
        p[3] - p[1] > height * 0.1 ||
        p[0] > rules[n][0] + 0.02 ||
        p[2] < rules[n][2] - 0.02 ||
        rules[n][0] - p[0] > height * 0.1 ||
        p[2] - rules[n][2] > height * 0.1
    )
  )
    return
  const bounds = [
    Math.min(...painted.map((p) => p[0])),
    Math.min(...painted.map((p) => p[1])),
    Math.max(...painted.map((p) => p[2])),
    Math.max(...painted.map((p) => p[3]))
  ]
  if (
    bounds[0] < table.cropRect[0] ||
    bounds[1] < table.cropRect[1] ||
    bounds[3] > table.cropRect[3] ||
    bounds[2] <= table.cropRect[2] ||
    bounds[2] - table.cropRect[2] > height * 2
  )
    return
  if (
    graphics.some(
      (g) =>
        ys.filter((y) => y >= g.rect[1] && y <= g.rect[3]).length !== 1 ||
        g.rect[3] - g.rect[1] > height * 0.75 ||
        g.rect[0] < bounds[0] - (pageSize[0] / 256) * 2 ||
        g.rect[2] > bounds[2] + (pageSize[0] / 256) * 2 ||
        g.rect[1] < ys[0] - (pageSize[1] / 256) * 2 ||
        g.rect[3] > ys.at(-1) + (pageSize[1] / 256) * 2
    )
  )
    return
  const crossed = graphics.filter((g) => g.rect[2] > table.cropRect[2])
  if (
    crossed.length !== ys.length ||
    !ys.every(
      (y, n) =>
        crossed.filter(
          (g) =>
            g.rect[1] <= y &&
            g.rect[3] >= y &&
            g.rect[0] >= bands[n].at(-1)[0] - (pageSize[0] / 256) * 2 &&
            g.rect[0] <= bands[n].at(-1)[0] + pageSize[0] / 256 &&
            g.rect[2] >= bands[n].at(-1)[2] &&
            g.rect[2] <= bands[n].at(-1)[2] + (pageSize[0] / 256) * 2
        ).length === 1
    )
  )
    return
  const crop = [...table.cropRect]
  crop[2] = Math.max(bounds[2], ...crossed.map((g) => g.rect[2]))
  if (
    !contains([0, 0, ...pageSize], crop) ||
    !graphics.every((g) => contains(crop, g.rect)) ||
    !painted.every((p) => contains(crop, p))
  )
    return
  const strip = [table.cropRect[2], table.cropRect[1], crop[2], table.cropRect[3]],
    owned = new Set(owners.map((o) => o.font))
  if (pageFontItems.some((f) => overlaps(fontRect(f), strip) && !owned.has(f))) return
  if (pageItems.some((i) => i.text.trim() && overlaps(i.rect, strip))) return
  return crop
}

// Recovered header glyphs can outlive an undersized detector crop. Require a
// nearby native full-width border and complete source ownership before growing
// the thumbnail; a paragraph or a short group underline is not that evidence.
export function recoverOwnedTableCrop(
  table,
  rules,
  pageSize = [Infinity, Infinity],
  pageItems = [],
  rulePaintBounds,
  sourceGraphics = [],
  pageFontItems = []
) {
  const completed = completeRepeatedHorizontalRuleCarrierCrop(
    table,
    rules,
    pageSize,
    pageItems,
    rulePaintBounds,
    sourceGraphics,
    pageFontItems
  )
  if (completed) return completed
  const crop = [...table.cropRect]
  const source = table.cells.flatMap((cell) => cell.sourceRects)
  if (table.unassigned.length || !source.length) return crop
  recoverClosedTableSides(crop, table, rules, pageItems, rulePaintBounds, pageSize)
  const left = Math.min(...source.map((r) => r[0])),
    top = Math.min(...source.map((r) => r[1])),
    right = Math.max(...source.map((r) => r[2]))
  if (left >= crop[0] - 0.5 && top >= crop[1] - 0.5 && right <= crop[2] + 0.5) return crop
  const first = source.filter((r) => r[1] === top)
  const height = Math.max(...first.map((r) => r[3] - r[1]))
  const width = crop[2] - crop[0]
  if (
    height <= 0 ||
    crop[1] - top > height * 2 ||
    crop[0] - left > width * 0.15 ||
    right - crop[2] > width * 0.15
  )
    return crop
  const borders = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[1] - top) <= height * 2 &&
      r[0] <= left + 1.5 &&
      r[2] >= right - 1.5 &&
      r[2] - r[0] >= width * 0.85 &&
      r[0] >= crop[0] - width * 0.15 &&
      r[2] <= crop[2] + width * 0.15
  )
  if (!borders.length) return crop
  const border = borders.sort((a, b) => Math.abs(a[1] - top) - Math.abs(b[1] - top))[0]
  return [
    Math.min(crop[0], border[0], left - 1.5),
    Math.min(crop[1], border[1], top - 1.5),
    Math.max(crop[2], border[2], right + 1.5),
    crop[3]
  ].map((value, index) => Math.max(0, Math.min(value, pageSize[index % 2])))
}

// Segmented native outer borders can lie outside the detector even when every
// glyph fits. Grow only the sides of one closed frame, with exact cell owners
// and no foreign text in either newly included strip.
function recoverClosedTableSides(crop, table, rules, items, rulePaintBounds, pageSize) {
  const rects = table.cells.flatMap((c) => c.sourceRects),
    source = new Set()
  if (
    !items.length ||
    new Set(table.cells.map((c) => c.row)).size < 3 ||
    new Set(table.cells.map((c) => c.column)).size < 2 ||
    new Set(rects.map((r) => r.join(','))).size !== rects.length
  )
    return
  for (const rect of rects) {
    const matches = items.filter((i) => i.rect.join(',') === rect.join(','))
    if (matches.length !== 1) return
    const item = matches[0]
    if (!item.horizontal || !Number.isFinite(item.baseline) || !(item.height > 0)) return
    source.add(item)
  }
  const native = [...source],
    height = native.map((i) => i.height).sort((a, b) => a - b)[native.length >> 1],
    left = Math.min(...rects.map((r) => r[0])),
    right = Math.max(...rects.map((r) => r[2])),
    top = Math.min(...native.map((i) => i.baseline)),
    bottom = Math.max(...native.map((i) => i.baseline)),
    horizontal = joinHorizontalTableRules(rules, 0.01, 1),
    vertical = rules.filter((r) => r[0] === r[2]),
    sides = [...new Set(vertical.map((r) => r[0]))],
    frames = []
  for (const a of sides.filter((x) => x <= left && Math.abs(x - crop[0]) <= height * 2))
    for (const b of sides.filter((x) => x >= right && Math.abs(x - crop[2]) <= height * 2)) {
      const edges = horizontal.filter((r) => Math.abs(r[0] - a) < 1 && Math.abs(r[2] - b) < 1)
      for (const opening of edges.filter((r) => r[1] <= top && top - r[1] <= height * 2))
        for (const closing of edges.filter((r) => r[1] >= bottom && r[1] - bottom <= height * 2)) {
          if (
            opening[1] < crop[1] ||
            closing[1] > crop[3] ||
            rects.some((r) => r[1] < opening[1] - height * 0.5 || r[3] > closing[1] + 0.5) ||
            classifyTableRuleEdge(vertical, 0, a, opening[1], closing[1]) !== 1 ||
            classifyTableRuleEdge(vertical, 0, b, opening[1], closing[1]) !== 1
          )
            continue
          frames.push([a, opening[1], b, closing[1]])
        }
    }
  if (frames.length !== 1) return
  const frame = frames[0],
    paintedSide = (x, index) => {
      const painted = vertical
        .filter((r) => r[0] === x && r[1] >= frame[1] - 1 && r[3] <= frame[3] + 1)
        .map((r) => rulePaintBounds instanceof Map && rulePaintBounds.get(r.join(',')))
        .filter(
          (p) =>
            Array.isArray(p) &&
            p.length === 4 &&
            p.every(Number.isFinite) &&
            Math.abs((p[0] + p[2]) / 2 - x) < 0.01 &&
            p[2] > p[0] &&
            p[2] - p[0] <= 2
        )
      return index === 0
        ? Math.min(x - 0.5, ...painted.map((p) => p[0]))
        : Math.max(x + 0.5, ...painted.map((p) => p[2]))
    },
    a = paintedSide(frame[0], 0),
    b = paintedSide(frame[2], 2),
    clearStrip = (start, end) =>
      !items.some(
        (i) =>
          i.text.trim() &&
          !source.has(i) &&
          i.rect[0] < end &&
          i.rect[2] > start &&
          i.rect[1] < crop[3] &&
          i.rect[3] > crop[1]
      )
  if ((a < crop[0] && !clearStrip(a, crop[0])) || (b > crop[2] && !clearStrip(crop[2], b))) return
  if (a < crop[0]) crop[0] = Math.max(0, a)
  if (b > crop[2]) crop[2] = Math.min(pageSize[0], b)
}

// Place the caption cut in native whitespace, preserving any top border.
// Model row padding can start inside caption glyphs, so use owned source text.
export function tableCaptionCropTop(table, captionBottom, rules) {
  const source = table.cells.flatMap((cell) => cell.sourceRects)
  if (table.unassigned.length || !source.length)
    return Math.max(table.cropRect[1], captionBottom + 1.5)
  const firstText = Math.min(...source.map((r) => r[1]))
  if (firstText <= captionBottom) return table.cropRect[1]
  let top = (captionBottom + firstText) / 2
  for (const rule of rules) {
    if (
      rule[1] === rule[3] &&
      rule[1] > captionBottom &&
      rule[1] < top &&
      rule[0] <= table.cropRect[0] + 12 &&
      rule[2] >= table.cropRect[2] - 12
    )
      top = rule[1]
  }
  return Math.max(table.cropRect[1], top)
}

// Caption/content bounds are in page space; thumbnail bounds and rules are scaled.
export function trimTableCaptionCrop({
  cropRect,
  table,
  caption,
  contentRect,
  rules,
  pageNumber,
  scale,
  pageItems = [],
  pageFontItems = [],
  noteOwnerRects = [],
  rulePaintBounds
}) {
  // A caption sheet can be associated from another page; its coordinates
  // cannot delimit this table page's thumbnail.
  if (!caption || caption.page !== pageNumber) return
  const frame = proveCaptionedTableRuleFrame(
    table,
    caption,
    rules,
    pageItems,
    scale,
    false,
    rulePaintBounds
  )
  const footerFrame =
    frame ??
    proveCaptionedTableRuleFrame(table, caption, rules, pageItems, scale, true, rulePaintBounds)
  const original = [...cropRect]
  // Glyph outlines can extend beyond their font-metric boxes. Cut inside
  // the measured caption/content gap instead of hugging the caption.
  if (caption.rect[3] <= contentRect[1])
    cropRect[1] = Math.max(cropRect[1], tableCaptionCropTop(table, caption.rect[3] * scale, rules))
  if (caption.rect[1] >= contentRect[3])
    cropRect[3] = Math.min(cropRect[3], (caption.rect[1] - 1) * scale)
  const openingPaint =
    footerFrame &&
    nativeFrameRulePaint(footerFrame.opening, footerFrame, pageItems, rulePaintBounds, cropRect)
  const openingFrame = frame ?? (openingPaint ? footerFrame : undefined)
  if (openingFrame) {
    if (
      original[1] > Math.min(openingFrame.opening[1] - 0.5, openingPaint?.[1] ?? Infinity) &&
      (original[1] - openingFrame.opening[1] < openingFrame.height * 0.25 ||
        (openingFrame.secondOpening &&
          openingPaint &&
          nativeFrameRulePaint(
            openingFrame.secondOpening,
            openingFrame,
            pageItems,
            rulePaintBounds,
            original
          ) &&
          original[1] >= openingFrame.secondOpening[1] &&
          original[1] - openingFrame.secondOpening[1] < openingFrame.height * 0.25))
    )
      cropRect[1] = Math.min(
        cropRect[1],
        openingFrame.opening[1] - 0.5,
        openingPaint?.[1] ?? Infinity
      )
  }
  if (footerFrame) {
    const closingPaint = nativeFrameRulePaint(
      footerFrame.closing,
      footerFrame,
      pageItems,
      rulePaintBounds,
      cropRect
    )
    if (original[3] >= footerFrame.closing[1] - footerFrame.height * 0.25)
      cropRect[3] = Math.max(
        cropRect[3],
        footerFrame.closing[1] + 0.5,
        closingPaint?.[3] ?? -Infinity
      )
    // Both exact painted rules must witness the same physical side endpoints.
    // Check the whole added strip, including crop padding outside the frame.
    if (
      openingPaint &&
      closingPaint &&
      Math.abs(footerFrame.opening[0] - footerFrame.closing[0]) <= 0.01 &&
      Math.abs(footerFrame.opening[2] - footerFrame.closing[2]) <= 0.01
    ) {
      const left = Math.min(openingPaint[0], closingPaint[0]),
        right = Math.max(openingPaint[2], closingPaint[2]),
        ownedStrip = (a, b) =>
          !pageItems.some(
            (i) =>
              i.text.trim() &&
              i.rect[0] < b &&
              i.rect[2] > a &&
              i.rect[1] < cropRect[3] &&
              i.rect[3] > cropRect[1] &&
              !footerFrame.source.has(i) &&
              !footerFrame.captionSource.has(i)
          )
      if (
        original[0] > left &&
        original[0] - left < footerFrame.height * 0.25 &&
        ownedStrip(left, cropRect[0])
      )
        cropRect[0] = Math.min(cropRect[0], left)
      if (
        original[2] < right &&
        right - original[2] < footerFrame.height * 0.25 &&
        ownedStrip(cropRect[2], right)
      )
        cropRect[2] = Math.max(cropRect[2], right)
    }
  }
  const visualFooter = nativeVisualFooterCrop({
    cropRect: original,
    table,
    caption,
    contentRect,
    rules,
    scale,
    pageItems,
    pageFontItems,
    noteOwnerRects,
    rulePaintBounds
  })
  if (visualFooter) cropRect.splice(0, 4, ...visualFooter)
}

// These two finite visual bands are not public note assignments. Require a
// complete native body, unique existing cell/recipient ownership, and the
// original font descent before changing a crop with unresolved footer text.
function nativeVisualFooterCrop({
  cropRect,
  table,
  caption,
  contentRect,
  rules,
  scale,
  pageItems,
  pageFontItems,
  noteOwnerRects,
  rulePaintBounds
}) {
  const validRect = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    sameRect = (a, b) => a.every((v, n) => v === b[n]),
    contains = (a, b, tolerance = 0) =>
      a[0] >= b[0] - tolerance &&
      a[1] >= b[1] - tolerance &&
      a[2] <= b[2] + tolerance &&
      a[3] <= b[3] + tolerance,
    overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    literal = (s) => s.replace(/\s/gu, ''),
    nativeItem = (i) =>
      i &&
      typeof i.text === 'string' &&
      i.text.trim() &&
      validRect(i.rect) &&
      i.horizontal &&
      Number.isFinite(i.baseline) &&
      Number.isFinite(i.height) &&
      i.height > 0,
    width = table.grid?.[0]?.length,
    owners = new Map(),
    slots = new Set(),
    rectKeys = new Set()
  if (
    !validRect(cropRect) ||
    !validRect(contentRect) ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !pageFontItems.length ||
    !noteOwnerRects.length ||
    !(rulePaintBounds instanceof Map) ||
    captionKind(caption.lines[0]) !== 'table' ||
    !table.unassigned.length ||
    !(width >= 2) ||
    table.grid.length < 3 ||
    table.cells.length !== width * table.grid.length
  )
    return
  for (const cell of table.cells) {
    const slot = `${cell.row},${cell.column}`,
      tokens = cell.sourceTokens
    if (
      slots.has(slot) ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      table.grid[cell.row]?.length !== width ||
      !cell.text ||
      table.grid[cell.row]?.[cell.column] !== cell.text ||
      !tokens?.length ||
      cell.sourceRects.length !== tokens.length ||
      literal(tokens.map((i) => i.text).join('')) !== literal(cell.text)
    )
      return
    slots.add(slot)
    for (const rect of cell.sourceRects) {
      if (!validRect(rect) || rectKeys.has(rect.join(','))) return
      rectKeys.add(rect.join(','))
      const parts = tokens.filter((i) => sameRect(i.rect, rect))
      if (parts.length !== 1) return
      const part = parts[0],
        original = part.sourceToken ?? part,
        matches = pageItems.filter(
          (i) =>
            sameRect(i.rect, original.rect) &&
            i.text === original.text &&
            i.baseline === original.baseline &&
            i.height === original.height
        )
      if (
        matches.length !== 1 ||
        !nativeItem(matches[0]) ||
        !contains(rect, matches[0].rect) ||
        part.baseline !== matches[0].baseline ||
        part.height !== matches[0].height
      )
        return
      const old = owners.get(matches[0])
      if (old && old.cell !== cell) return
      owners.set(matches[0], { cell, parts: [...(old?.parts ?? []), part] })
    }
  }
  for (const [parent, { parts }] of owners) {
    const ordered = [...parts].sort((a, b) => a.rect[0] - b.rect[0])
    if (
      ordered[0].rect[0] !== parent.rect[0] ||
      ordered.at(-1).rect[2] !== parent.rect[2] ||
      literal(ordered.map((i) => i.text).join('')) !== literal(parent.text) ||
      ordered.some((i, n) => n && i.rect[0] < ordered[n - 1].rect[2])
    )
      return
  }
  const source = [...owners.keys()],
    bounds = union(source),
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[heights.length >> 1],
    captionRect = caption.rect.map((v) => v * scale),
    horizontal = joinHorizontalTableRules(rules, 0.01, 1).filter(
      (r) =>
        r[0] <= bounds[0] + 0.01 &&
        r[2] >= bounds[2] - 0.01 &&
        Math.abs(r[0] - bounds[0]) < height &&
        Math.abs(r[2] - bounds[2]) < height * 2
    ),
    openings = horizontal.filter(
      (r) => r[1] > captionRect[3] && r[1] < bounds[1] && bounds[1] - r[1] < height
    ),
    header = table.cells.filter((c) => c.row === 0).flatMap((c) => c.sourceTokens),
    firstBody = table.cells.filter((c) => c.row === 1).flatMap((c) => c.sourceTokens),
    dividers = horizontal.filter(
      (r) =>
        r[1] > Math.max(...header.map((i) => i.rect[3])) &&
        r[1] < Math.min(...firstBody.map((i) => i.baseline))
    ),
    closings = horizontal
      .filter((r) => r[1] > bounds[3] && r[1] - bounds[3] < height * 2)
      .sort((a, b) => a[1] - b[1])
  if (openings.length !== 1 || dividers.length !== 1 || !closings.length) return
  const opening = openings[0],
    closing = closings[0],
    edges = [opening, dividers[0], closing],
    frame = [opening[0], opening[1], opening[2], closing[1]],
    paint = (rule) => {
      const p = rulePaintBounds.get(rule.join(','))
      return validRect(p) &&
        p[0] <= rule[0] &&
        p[2] >= rule[2] &&
        Math.abs((p[1] + p[3]) / 2 - rule[1]) < 0.01 &&
        p[3] - p[1] <= 2 &&
        rule[0] - p[0] <= (p[3] - p[1]) / 2 + 0.01 &&
        p[2] - rule[2] <= (p[3] - p[1]) / 2 + 0.01
        ? p
        : undefined
    },
    paints = edges.map(paint)
  if (
    edges.some((r) => Math.abs(r[0] - opening[0]) >= 0.01 || Math.abs(r[2] - opening[2]) >= 0.01) ||
    horizontal.filter((r) => r[1] >= opening[1] && r[1] <= closing[1]).length !== 3 ||
    rules.some(
      (r) =>
        r[0] === r[2] && r[0] > frame[0] && r[0] < frame[2] && r[1] < frame[3] && r[3] > frame[1]
    ) ||
    paints.some((p) => !p) ||
    source.some((i) => !contains(i.rect, frame, 0.01)) ||
    pageItems.some((i) => i.text.trim() && overlaps(i.rect, frame) && !owners.has(i))
  )
    return
  const fontBottom = (items) => {
      const fonts = items.map((item) =>
        pageFontItems.filter((i) => i.text === item.text && sameRect(i.rect, item.rect))
      )
      if (
        !items.length ||
        fonts.some(
          (m, n) =>
            m.length !== 1 ||
            m[0].baseline !== items[n].baseline ||
            m[0].height !== items[n].height ||
            !Number.isFinite(m[0].fontDescent) ||
            m[0].fontDescent < -1 ||
            m[0].fontDescent > 0
        )
      )
        return
      return Math.max(...fonts.map(([i]) => i.baseline - i.fontDescent * i.height))
    },
    captionItems = pageItems.filter((i) => nativeItem(i) && contains(i.rect, captionRect, 1e-7))
  if (literal(captionItems.map((i) => i.text).join('')) !== literal(caption.lines.join(''))) return
  const captionBottom = fontBottom(captionItems),
    footer = pageItems
      .filter(
        (i) =>
          i.text.trim() &&
          !owners.has(i) &&
          i.rect[0] < frame[2] &&
          i.rect[2] > frame[0] &&
          i.rect[1] >= closing[1] &&
          i.rect[1] < closing[1] + height * 2.5
      )
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (
    footer.length !== 2 ||
    footer.some(
      (i) =>
        !nativeItem(i) ||
        i.height !== footer[0].height ||
        Math.abs(i.rect[3] - i.baseline) > 1e-9 ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) > 1e-9
    )
  )
    return
  const footerRect = union(footer),
    footerBottom = fontBottom(footer),
    fh = footer[0].height,
    recipients = noteOwnerRects.filter(
      (r) =>
        validRect(r) &&
        r[0] * scale <= footerRect[0] &&
        r[2] * scale >= footerRect[2] &&
        r[3] * scale <= footerRect[1] &&
        footerRect[1] - r[3] * scale < height * 2
    )
  if (
    !Number.isFinite(captionBottom) ||
    !Number.isFinite(footerBottom) ||
    footerRect[0] < frame[0] ||
    footerRect[2] > frame[2] + 0.01 ||
    recipients.length !== 1 ||
    !sameRect(recipients[0], contentRect) ||
    new Set(table.unassigned).size !== table.unassigned.length ||
    table.unassigned.some((s) => footer.filter((i) => i.text === s).length !== 1)
  )
    return
  const strip = [
    Math.min(cropRect[0], frame[0]),
    closing[1],
    Math.max(cropRect[2], frame[2]),
    footerBottom + 0.5
  ]
  if (
    pageItems.some(
      (i) => i.text.trim() && overlaps(i.rect, strip) && !footer.includes(i) && !owners.has(i)
    )
  )
    return
  let proposed
  if (footer[0].baseline !== footer[1].baseline) {
    const firstColumn = table.cells
        .filter((c) => c.row > 0 && c.column === 0)
        .flatMap((c) => c.sourceTokens),
      leading = footer[1].baseline - footer[0].baseline,
      next = pageItems
        .filter(
          (i) =>
            i.text.trim() &&
            i.rect[0] < frame[2] &&
            i.rect[2] > frame[0] &&
            i.rect[1] >= footerRect[3]
        )
        .sort((a, b) => a.rect[1] - b.rect[1])[0]
    if (
      firstColumn.some((i) => fh >= i.height * 0.85) ||
      Math.abs(footer[0].rect[0] - footer[1].rect[0]) > 1e-7 ||
      footer[0].rect[0] - frame[0] > fh ||
      footer[0].rect[1] - closing[1] > fh * 0.1 ||
      leading < fh ||
      leading > fh * 1.3 ||
      footer[1].rect[0] < cropRect[0] ||
      footer[0].rect[2] > cropRect[2] ||
      footer[0].rect[2] - footer[0].rect[0] < (frame[2] - frame[0]) * 0.8 ||
      footer[1].rect[2] - footer[1].rect[0] >= (footer[0].rect[2] - footer[0].rect[0]) * 0.75 ||
      !/[.!?]$/.test(footer[1].text) ||
      !next ||
      next.rect[1] - footerBottom < fh * 2 ||
      next.height <= fh * 1.2 ||
      captionBottom >= cropRect[1] ||
      cropRect[3] < closing[1] ||
      cropRect[3] >= footerBottom
    )
      return
    proposed = [cropRect[0], cropRect[1], cropRect[2], footerBottom + 0.5]
  } else {
    const lower = horizontal.filter(
        (r) =>
          r[1] > footerRect[3] &&
          r[1] - footerRect[3] < fh &&
          Math.abs(r[0] - frame[0]) < 0.01 &&
          Math.abs(r[2] - frame[2]) < 0.01
      ),
      top = (captionBottom + Math.min(bounds[1], paints[0][1])) / 2,
      bottom = Math.max(closing[1] + 0.5, paints[2][3])
    if (
      !/^References:\s+\p{L}/u.test(footer[0].text) ||
      footer[0].rect[0] !== frame[0] ||
      footer[1].rect[0] <= footer[0].rect[2] ||
      table.unassigned.length !== 2 ||
      lower.length !== 1 ||
      !paint(lower[0]) ||
      top >= paints[0][1] ||
      bottom >= footerRect[1] ||
      top < cropRect[1] ||
      bottom >= cropRect[3] ||
      paints[0][2] - cropRect[2] > height * 2
    )
      return
    proposed = [cropRect[0], top, Math.max(cropRect[2], paints[0][2], paints[2][2]), bottom]
    if (
      pageItems.some(
        (i) =>
          i.text.trim() &&
          !owners.has(i) &&
          overlaps(i.rect, [cropRect[2], proposed[1], proposed[2], proposed[3]])
      )
    )
      return
  }
  const bodyBottom = fontBottom(source)
  if (
    !Number.isFinite(bodyBottom) ||
    bodyBottom > proposed[3] ||
    !source.every((i) => contains(i.rect, proposed))
  )
    return
  // Reject foreign glyphs in crop padding as well as the ruled body. Use the
  // original descent when available, so an adjacent em box cannot hide ink.
  if (
    pageItems.some((i) => {
      if (!i.text.trim() || owners.has(i) || footer.includes(i) || captionItems.includes(i))
        return false
      const bottom = fontBottom([i])
      return overlaps(
        Number.isFinite(bottom)
          ? [i.rect[0], i.rect[1], i.rect[2], Math.max(i.rect[3], bottom)]
          : i.rect,
        proposed
      )
    })
  )
    return
  return proposed
}

// The operator collector supplies painted bounds without changing rule centers.
// An exact key is required: merged or nearby lines cannot lend paint evidence.
// Check the newly included strip against the same unique native cell/caption owners.
function nativeFrameRulePaint(rule, frame, items, rulePaintBounds, cropRect) {
  const paint = rulePaintBounds instanceof Map && rulePaintBounds.get(rule.join(','))
  if (!Array.isArray(paint) || paint.length !== 4 || !paint.every(Number.isFinite)) return
  const half = (paint[3] - paint[1]) / 2
  if (
    !(half > 0) ||
    paint[2] <= paint[0] ||
    Math.abs((paint[1] + paint[3]) / 2 - rule[1]) > 0.01 ||
    Math.abs((paint[0] + paint[2]) / 2 - (rule[0] + rule[2]) / 2) > 0.01 ||
    paint[0] > rule[0] + 0.01 ||
    paint[2] < rule[2] - 0.01 ||
    rule[0] - paint[0] > half + 0.01 ||
    paint[2] - rule[2] > half + 0.01 ||
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] < Math.max(paint[2], cropRect[2]) &&
        i.rect[2] > Math.min(paint[0], cropRect[0]) &&
        i.rect[1] < paint[3] &&
        i.rect[3] > paint[1] &&
        !frame.source.has(i) &&
        !frame.captionSource.has(i)
    )
  )
    return
  return paint
}

// A caption's font AABB can overlap a closing line. Its exact native literal
// and below-line baselines distinguish those glyphs from table cells; every
// other native item in the frame must have one final cell owner. No rectangle
// is invented for split or unresolved text, and absent native inputs retain the
// old trim behavior.
function proveCaptionedTableRuleFrame(
  table,
  caption,
  rules,
  items,
  scale,
  strictCompleteRecords = false,
  rulePaintBounds
) {
  if (
    !items.length ||
    table.unassigned.length ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    captionKind(caption.lines[0]) !== 'table'
  )
    return
  const cells = table.cells,
    rects = cells.flatMap((c) => c.sourceRects),
    key = (r) => r.join(',')
  if (
    !rects.length ||
    rects.some((r) => !r.every(Number.isFinite)) ||
    new Set(rects.map(key)).size !== rects.length
  )
    return
  const native = new Map(),
    groups = new Map(),
    tokenParts = cells.flatMap((c) => c.sourceTokens ?? [])
  for (const r of rects) {
    const exact = items.filter((i) => key(i.rect) === key(r))
    if (exact.length > 1) return
    let parent = exact[0],
      part = parent
    if (!parent) {
      const fragments = tokenParts.filter((i) => key(i.rect) === key(r))
      if (fragments.length !== 1) return
      part = fragments[0]
      const matches = items.filter(
        (i) =>
          i.horizontal &&
          Number.isFinite(i.baseline) &&
          Math.abs(i.baseline - part.baseline) < 1e-7 &&
          Math.abs(i.rect[1] - r[1]) < 1e-7 &&
          Math.abs(i.rect[3] - r[3]) < 1e-7 &&
          r[0] >= i.rect[0] - 1e-7 &&
          r[2] <= i.rect[2] + 1e-7
      )
      if (matches.length !== 1) return
      parent = matches[0]
    }
    native.set(key(r), parent)
    const group = groups.get(parent) ?? []
    group.push(part)
    groups.set(parent, group)
  }
  for (const [parent, group] of groups) {
    if (group.length === 1 && group[0] === parent) continue
    const ordered = group.sort((a, b) => a.rect[0] - b.rect[0])
    if (
      Math.abs(ordered[0].rect[0] - parent.rect[0]) > 1e-7 ||
      Math.abs(ordered.at(-1).rect[2] - parent.rect[2]) > 1e-7 ||
      ordered.some(
        (i, n) => i.rect[2] <= i.rect[0] || (n && i.rect[0] < ordered[n - 1].rect[2] - 1e-7)
      ) ||
      ordered
        .map((i) => i.text)
        .join('')
        .replace(/\s+/g, '') !== parent.text.replace(/\s+/g, '')
    )
      return
  }
  const source = [...groups.keys()],
    heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[heights.length >> 1]
  if (
    !(height > 0) ||
    source.some(
      (i) =>
        !i.horizontal || !Number.isFinite(i.baseline) || !Number.isFinite(i.height) || i.height <= 0
    )
  )
    return
  const grid = table.grid,
    width = grid?.[0]?.length ?? 0,
    scalar = (s) => /^[<>≤≥−–+-]?\d[\d.,%]*$/.test(s.replace(/\s/g, ''))
  let leafHeader = 0
  if (strictCompleteRecords) {
    leafHeader = grid?.findIndex((r) => r.length === width && r.every(Boolean))
    const letters = (s) => [...s.replace(/\s/gu, '')].sort().join('')
    const pageWords = sourceWordSpellings(items.filter((i) => i.horizontal).map((i) => i.text))
    const cellLiteral = (c) => {
      const parts = c.sourceRects.map(
        (r) => tokenParts.find((t) => key(t.rect) === key(r)) ?? native.get(key(r))
      )
      if (parts.some((i) => !i)) return false
      if (letters(c.text) === letters(parts.map((i) => i.text).join(''))) return true
      const lines = []
      for (const i of [...parts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
        let line = lines.find(
          (line) =>
            Math.abs(line[0].baseline - i.baseline) <= Math.max(line[0].height, i.height) * 0.35
        )
        if (!line) {
          line = []
          lines.push(line)
        }
        line.push(i)
      }
      let text = ''
      for (const [n, line] of lines.entries()) {
        line.sort((a, b) => a.rect[0] - b.rect[0])
        const previous = lines[n - 1]
        const wrapped =
          previous &&
          /\p{L}[-\u2010\u2011]$/u.test(previous.map((i) => i.text).join('')) &&
          /^\p{Ll}/u.test(line[0].text) &&
          (previous.length < 2 ||
            previous.at(-1).rect[0] - previous.at(-2).rect[2] <= previous[0].height * 0.25) &&
          Math.abs(previous.at(-1).height - previous[0].height) <= previous[0].height * 0.2 &&
          Math.abs(line[0].height - previous[0].height) <= previous[0].height * 0.2 &&
          line[0].baseline - previous[0].baseline <= previous[0].height * 1.6 &&
          Math.abs(line[0].rect[0] - previous[0].rect[0]) <= previous[0].height &&
          !rules.some(
            (r) =>
              r[1] === r[3] &&
              r[1] > previous[0].baseline &&
              r[1] < line[0].baseline &&
              r[0] < c.rect[2] &&
              r[2] > c.rect[0]
          )
        if (wrapped && hasWitnessedLineEndHyphen(text, line[0].text, pageWords))
          text = text.slice(0, -1)
        text += line.map((i) => i.text).join('')
      }
      return letters(c.text) === letters(text)
    }
    const completeRecord = (row) => {
      const own = cells.filter((c) => c.row === row)
      const ordered = [...own].sort((a, b) => a.column - b.column)
      if (
        ordered.length !== width ||
        ordered.some(
          (c, n) => c.column !== n || !c.sourceRects.length || !c.rect?.every(Number.isFinite)
        ) ||
        ordered.some(
          (c, n) =>
            n &&
            (c.rect[0] < ordered[n - 1].rect[2] - 1e-7 ||
              Math.min(...c.sourceRects.map((r) => (r[0] + r[2]) / 2)) <=
                Math.max(...ordered[n - 1].sourceRects.map((r) => (r[0] + r[2]) / 2)))
        )
      )
        return false
      return (
        own.length === width &&
        Array.from(
          { length: width },
          (_, column) =>
            own.filter(
              (c) =>
                c.column === column &&
                c.colSpan === 1 &&
                c.rowSpan === 1 &&
                c.sourceRects.length &&
                grid[row]?.[column] === c.text &&
                c.rect?.every(Number.isFinite) &&
                c.rect[0] < c.rect[2] &&
                c.sourceRects.every(
                  (r) => (r[0] + r[2]) / 2 >= c.rect[0] && (r[0] + r[2]) / 2 <= c.rect[2]
                ) &&
                cellLiteral(c)
            ).length === 1
        ).every(Boolean)
      )
    }
    if (
      width < 2 ||
      leafHeader < 0 ||
      leafHeader > 1 ||
      !completeRecord(leafHeader) ||
      !completeRecord(leafHeader + 1) ||
      grid
        .slice(leafHeader + 1)
        .filter(
          (r, n) => r.length === width && r.every(Boolean) && completeRecord(leafHeader + 1 + n)
        ).length < 2
    )
      return
  } else {
    if (
      width < 3 ||
      !grid?.[0]?.every(Boolean) ||
      cells.filter((c) => c.row <= leafHeader).length !== width ||
      grid
        .slice(1)
        .filter((r) => r.length === width && r.every(Boolean) && r.filter(scalar).length >= 2)
        .length < 2
    )
      return
  }
  const crop = table.cropRect,
    horizontal = joinHorizontalTableRules(rules).filter(
      (r) =>
        r.every(Number.isFinite) &&
        Math.abs(r[0] - crop[0]) <= height &&
        Math.abs(r[2] - crop[2]) <= height
    )
  const topInk = Math.min(...source.map((i) => i.rect[1])),
    bottomInk = Math.max(...source.map((i) => i.rect[3]))
  const openings = horizontal.filter(
      (r) => r[1] < topInk && topInk - r[1] < height * 2 && Math.abs(r[1] - crop[1]) < height
    ),
    closings = horizontal.filter(
      (r) =>
        r[1] > bottomInk && r[1] - bottomInk < height * 2 && Math.abs(r[1] - crop[3]) < height * 2
    )
  const sortedOpenings = [...openings].sort((a, b) => a[1] - b[1]),
    doubleOpening =
      sortedOpenings.length === 2 &&
      sortedOpenings[1][1] - sortedOpenings[0][1] < height * 0.25 &&
      Math.abs(sortedOpenings[0][0] - sortedOpenings[1][0]) < 0.01 &&
      Math.abs(sortedOpenings[0][2] - sortedOpenings[1][2]) < 0.01
  if ((!doubleOpening && openings.length !== 1) || closings.length !== 1) return
  const opening = sortedOpenings[0],
    closing = closings[0]
  if (Math.abs(opening[0] - closing[0]) > 0.5 || Math.abs(opening[2] - closing[2]) > 0.5) return
  const header = cells
      .filter((c) => c.row === 0)
      .flatMap((c) => c.sourceRects)
      .map((r) => native.get(key(r))),
    firstBody = cells
      .filter((c) => c.row === leafHeader + 1)
      .flatMap((c) => c.sourceRects)
      .map((r) => native.get(key(r)))
  if (!firstBody.length) return
  const dividers = horizontal.filter(
    (r) =>
      r[1] > Math.max(...header.map((i) => i.baseline)) &&
      r[1] < Math.min(...firstBody.map((i) => i.baseline)) &&
      Math.abs(r[0] - opening[0]) <= 0.5 &&
      Math.abs(r[2] - opening[2]) <= 0.5
  )
  if (dividers.length !== 1) return
  const captionRect = caption.rect.map((x) => x * scale),
    contains = (i) =>
      i.rect[0] >= captionRect[0] - 0.1 &&
      i.rect[2] <= captionRect[2] + 0.1 &&
      i.rect[1] >= captionRect[1] - 0.1 &&
      i.rect[3] <= captionRect[3] + 0.1,
    parts = items.filter((i) => i.horizontal && i.text.trim() && contains(i)),
    literal = (s) => s.replace(/\s+/g, '')
  if (
    !parts.length ||
    literal(parts.map((i) => i.text).join('')) !== literal(caption.lines.join(''))
  )
    return
  let captionHeight = height
  if (strictCompleteRecords) {
    const captionHeights = parts.map((i) => i.height).sort((a, b) => a - b)
    captionHeight = captionHeights[captionHeights.length >> 1]
    if (
      !(captionHeight > 0) ||
      !Number.isFinite(captionHeight) ||
      parts.some(
        (i) =>
          !Number.isFinite(i.height) || Math.abs(i.height - captionHeight) > captionHeight * 0.03
      )
    )
      return
  }
  const above =
      captionRect[3] < opening[1] &&
      opening[1] - captionRect[3] < height * 4 &&
      parts.every((i) => i.baseline < opening[1]),
    below =
      captionRect[1] >= closing[1] - captionHeight * 0.25 &&
      captionRect[1] - closing[1] < height * 4 &&
      parts.every((i) => Number.isFinite(i.baseline) && i.baseline > closing[1] + height * 0.5)
  if (!above && !below) return
  if (strictCompleteRecords && !below && !doubleOpening) return
  const unique = new Set(source),
    captionSource = new Set(parts)
  const frame = [opening[0], opening[1], opening[2], closing[1]]
  if (
    source.some(
      (i) =>
        i.rect[0] < frame[0] - 0.1 ||
        i.rect[2] > frame[2] + 0.1 ||
        i.baseline <= frame[1] ||
        i.baseline >= frame[3]
    ) ||
    items.some(
      (i) =>
        i.text.trim() &&
        i.rect[0] < frame[2] &&
        i.rect[2] > frame[0] &&
        i.rect[1] < frame[3] + 0.5 &&
        i.rect[3] > frame[1] - 0.5 &&
        !unique.has(i) &&
        !captionSource.has(i)
    )
  )
    return
  const proved = { opening, closing, height, source: unique, captionSource }
  if (doubleOpening) {
    if (
      !nativeFrameRulePaint(opening, proved, items, rulePaintBounds, crop) ||
      !nativeFrameRulePaint(sortedOpenings[1], proved, items, rulePaintBounds, crop)
    )
      return
    proved.secondOpening = sortedOpenings[1]
  }
  return proved
}

// Notes are assigned before the final grid excludes their source tokens. Use
// final cell ink when ownership is complete; preliminary row bands can still
// include the note and cannot establish the thumbnail's lower boundary.
export function trimTableNoteCrop({
  cropRect,
  table,
  notes,
  contentRect,
  scale,
  sourceRules = []
}) {
  const source = table.cells.flatMap((cell) => cell.sourceRects)
  const complete = !table.unassigned.length && source.length > 0
  const bottom =
    !table.unassigned.length && source.length
      ? Math.max(...source.map((rect) => rect[3]))
      : contentRect[3] * scale
  for (const note of notes) {
    const top = note.rect[1] * scale
    if (top < bottom + 1) continue
    const heights = source.map((rect) => rect[3] - rect[1]).sort((a, b) => a - b)
    const height = heights[heights.length >> 1]
    const horizontal = joinHorizontalTableRules(sourceRules)
    const firstInk = complete ? Math.min(...source.map((rect) => rect[1])) : 0
    const ownsInsetFrame = (rule) =>
      source.length >= 6 &&
      rule[0] >= cropRect[0] &&
      rule[2] <= cropRect[2] &&
      rule[0] - cropRect[0] <= height &&
      cropRect[2] - rule[2] <= height &&
      source.every(
        (rect) => rect[0] >= rule[0] - height * 0.1 && rect[2] <= rule[2] + height * 0.1
      ) &&
      horizontal.some(
        (opening) =>
          opening[1] >= Math.max(cropRect[1], table.cropRect[1]) &&
          opening[1] < firstInk &&
          firstInk - opening[1] <= height * 2 &&
          Math.abs(opening[0] - rule[0]) <= 0.5 &&
          Math.abs(opening[2] - rule[2]) <= 0.5
      )
    // A note's full-em box can overlap the closing stroke even though every
    // owned cell glyph is above it. Keep only one matching native border
    // already inside the crop; competing rules or unresolved ink supply no proof.
    const closing =
      complete && height > 0
        ? horizontal.filter(
            (rule) =>
              ((Math.abs(rule[0] - cropRect[0]) <= Math.max(0.5, height * 0.1) &&
                Math.abs(rule[2] - cropRect[2]) <= Math.max(0.5, height * 0.1)) ||
                ownsInsetFrame(rule)) &&
              rule[1] >= bottom &&
              rule[1] - bottom <= height * 2 &&
              rule[1] <= Math.min(cropRect[3], table.cropRect[3]) &&
              Math.abs(rule[1] - top) <= height * 0.25
          )
        : []
    const boundary = closing.length === 1 ? Math.max(top - 1, closing[0][1] + 0.5) : top - 1
    cropRect[3] = Math.min(cropRect[3], boundary)
  }
}

// Repeated page furniture has already been excluded from source tokens. Use
// that same ownership evidence to trim detector padding above a continuation.
export function tableMarginCropTop(table, originalPage, contentPage, rules, scale) {
  const source = table.cells.flatMap((cell) => cell.sourceRects)
  if (table.unassigned.length || !source.length) return table.cropRect[1]
  const firstText = Math.min(...source.map((r) => r[1]))
  const retained = new Set(contentPage.lines)
  const headers = (originalPage.lines ?? []).filter(
    (line) =>
      !retained.has(line) &&
      (line.y + line.height) / originalPage.height < 0.1 &&
      line.width > line.height * 2 &&
      (line.y + line.height) * scale > table.cropRect[1] &&
      (line.y + line.height) * scale < firstText &&
      line.x * scale < table.cropRect[2] &&
      (line.x + line.width) * scale > table.cropRect[0]
  )
  if (!headers.length) return table.cropRect[1]
  return tableCaptionCropTop(
    table,
    Math.max(...headers.map((line) => (line.y + line.height) * scale)),
    rules
  )
}

// Geometry shared by script assignment and row recovery. A baseline offset
// alone is insufficient: the glyph must tightly adjoin a larger source token.
export function isAdjacentTableScript(item, anchor) {
  // Isotope mass numbers precede their chemical symbol. Keep the same
  // script-size and baseline evidence used for trailing superscripts.
  const isotope =
    /^\d{2,3}$/.test(item.text) &&
    /^(?:[A-Z][a-z]?)[–-]/.test(anchor.text) &&
    item.baseline < anchor.baseline &&
    item.rect[2] <= anchor.rect[0]
  const gap = isotope ? anchor.rect[0] - item.rect[2] : item.rect[0] - anchor.rect[2]
  const shift = Math.abs(item.baseline - anchor.baseline)
  // Italic font matrices can report a full em for a visibly raised marker.
  // Its baseline and near-touching advance still establish script placement.
  const raisedFullEm =
    /^[a-z](?:,[a-z])*$/.test(item.text) &&
    item.height >= anchor.height * 0.8 &&
    item.height <= anchor.height * 1.1 &&
    anchor.baseline - item.baseline > anchor.height * 0.5 &&
    anchor.baseline - item.baseline < anchor.height * 0.7 &&
    Math.abs(gap) <= anchor.height * 0.05
  const tightlyRaised =
    /^[a-z0-9]{1,3}$/i.test(item.text) &&
    item.height < anchor.height * 0.8 &&
    item.baseline < anchor.baseline &&
    Math.abs(gap) <= anchor.height * 0.05
  const parenthesizedMarker =
    /^(?:[a-z]\)|\(\d{1,3}\))$/.test(item.text) &&
    item.height < anchor.height * 0.8 &&
    item.baseline < anchor.baseline &&
    Math.abs(gap) <= anchor.height * (/^\(/.test(item.text) ? 0.15 : 0.05)
  return (
    item.horizontal &&
    anchor.horizontal &&
    (raisedFullEm ||
      item.height < anchor.height * 0.8 ||
      (/^[a-z]$/.test(item.text) && item.height < anchor.height * 0.9) ||
      ((item.inlineSymbol || /^[′″]$/.test(item.text)) &&
        !anchor.inlineSymbol &&
        item.height <= anchor.height * 1.1)) &&
    shift > anchor.height * 0.08 &&
    shift <=
      anchor.height *
        (raisedFullEm ? 0.7 : parenthesizedMarker ? 0.65 : tightlyRaised ? 0.6 : 0.5) &&
    gap >=
      -Math.max(
        anchor.height * 0.1,
        Math.min(anchor.height * 0.15, (item.rect[2] - item.rect[0]) * 0.5)
      ) &&
    gap <= anchor.height * 0.35
  )
}

// Model boxes are crop-relative. Keep their page-space positions invariant
// whenever native source evidence corrects a detector crop. Extending an
// outer model row/column is opt-in because only a recovery with explicit
// source ownership may claim the newly exposed boundary.
export function rebaseTableCrop(table, cropRect, expandModelBounds = false) {
  const previousCrop = table.cropRect
  const width = cropRect[2] - cropRect[0]
  const height = cropRect[3] - cropRect[1]
  const objects = table.structure.objects.map((object) => ({
    ...object,
    rect: object.rect.map((v, i) => v + previousCrop[i % 2] - cropRect[i % 2])
  }))
  const columns = objects.filter((object) => object.label === 'table column')
  const rows = objects.filter((object) => object.label === 'table row')
  if (expandModelBounds && columns.length && cropRect[0] < previousCrop[0])
    columns.reduce((left, object) => (object.rect[0] < left.rect[0] ? object : left)).rect[0] = 0
  if (expandModelBounds && columns.length && cropRect[2] > previousCrop[2])
    columns.reduce((right, object) => (object.rect[2] > right.rect[2] ? object : right)).rect[2] =
      width
  if (expandModelBounds && rows.length && cropRect[1] < previousCrop[1])
    rows.reduce((top, object) => (object.rect[1] < top.rect[1] ? object : top)).rect[1] = 0
  if (expandModelBounds && rows.length && cropRect[3] > previousCrop[3])
    rows.reduce((bottom, object) => (object.rect[3] > bottom.rect[3] ? object : bottom)).rect[3] =
      height
  return {
    ...table,
    cropRect,
    structure: {
      ...table.structure,
      objects
    }
  }
}
