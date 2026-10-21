/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { joinCaptionLines } from './literature-pdf-caption-group.mjs'
// Recover a missing numeric panel only as part of a captioned, native two-panel
// table. This proves image ownership; it deliberately does not invent cells.
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) =>
  b[0] >= a[0] - 0.01 && b[1] >= a[1] - 0.01 && b[2] <= a[2] + 0.01 && b[3] <= a[3] + 0.01
const compact = (s) => s.replace(/\s/gu, '')
const titlePattern = /^Panel ([A-Z]) \([^()]+\)$/u

export function nativePairedTablePanelCrop(table, fonts, horizontal, paint, graphics, context) {
  if (!Array.isArray(context.captions) || table.unassigned?.length) return
  const old = table.cropRect,
    titles = fonts.filter((f) => titlePattern.test(f.text))
  const tails = titles.filter(
    (f) =>
      f.advance[1] < old[1] &&
      f.advance[3] > old[1] &&
      table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance))
  )
  if (tails.length !== 1) return
  const tail = tails[0],
    h = tail.advance[3] - tail.advance[1]
  const heads = titles.filter(
    (f) =>
      f.source.index < tail.source.index &&
      titlePattern.exec(f.text)[1].charCodeAt(0) + 1 ===
        titlePattern.exec(tail.text)[1].charCodeAt(0) &&
      Math.abs(f.advance[3] - f.advance[1] - h) < 1e-6 &&
      context.sourceContent.items[f.source.index].fontName ===
        context.sourceContent.items[tail.source.index].fontName
  )
  if (heads.length !== 1) return
  const head = heads[0],
    bars = horizontal.filter((r) => valid(paint(r)))
  const panel = (label, bottom) => {
    const first = bars
      .filter(
        (r) =>
          r[1] > label.advance[3] &&
          r[1] - label.advance[3] < h * 2 &&
          r[0] < label.advance[0] &&
          r[2] > label.advance[2]
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!first) return
    const rules = bars
      .filter(
        (r) =>
          r[1] >= first[1] &&
          r[1] < bottom &&
          Math.abs(r[0] - first[0]) < 0.01 &&
          Math.abs(r[2] - first[2]) < 0.01
      )
      .sort((a, b) => a[1] - b[1])
    if (
      rules.length < 3 ||
      Math.abs(label.advance[0] + label.advance[2] - first[0] - first[2]) > h * 2
    )
      return
    return { rules, rect: [first[0], first[1], first[2], rules.at(-1)[1]] }
  }
  const first = panel(head, tail.advance[1]),
    last = panel(tail, old[3])
  if (
    !first ||
    !last ||
    first.rules.length !== 3 ||
    Math.abs(first.rect[0] + first.rect[2] - last.rect[0] - last.rect[2]) > h * 0.2 ||
    Math.abs(first.rect[2] - first.rect[0] - last.rect[2] + last.rect[0]) > h * 0.5 ||
    tail.advance[1] - first.rect[3] < 0 ||
    tail.advance[1] - first.rect[3] > h * 2
  )
    return
  const captions = context.captions.filter(
    (c) =>
      c.page === table.page &&
      valid(c.rect) &&
      /^Table\s+\S+/iu.test(c.lines?.[0] ?? '') &&
      c.rect[3] < head.advance[1] &&
      head.advance[1] - c.rect[3] < h * 2
  )
  if (captions.length !== 1) return
  const caption = captions[0],
    captionFonts = fonts.filter((f) => over(f.advance, caption.rect))
  if (
    !captionFonts.length ||
    compact(captionFonts.map((f) => f.text).join('')) !== compact(caption.lines.join(''))
  )
    return
  const owned = new Set()
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return
    for (const [i, s] of (cell.sourceItems ?? []).entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, s) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0]) || !inside(last.rect, matches[0].advance))
        return
      owned.add(matches[0])
    }
  }
  const lower = fonts.filter((f) => over(f.advance, last.rect))
  if (!owned.size || lower.length !== owned.size || lower.some((f) => !owned.has(f))) return
  const upper = fonts.filter((f) => over(f.advance, first.rect))
  if (!upper.length || upper.some((f) => !inside(first.rect, f.advance))) return
  const body = upper.filter((f) => f.advance[1] > first.rules[1][1]),
    stubs = body
      .filter(
        (f) => /^\p{L}[\p{L}\s-]*$/u.test(f.text) && Math.abs(f.advance[0] - first.rect[0]) < 0.01
      )
      .sort((a, b) => a.advance[3] - b.advance[3])
  if (stubs.length !== 2) return
  const numeric = /^[+−-]?\d+(?:\.\d+)?$/u,
    interval = /^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u
  const assigned = new Set(stubs),
    centers = []
  for (const stub of stubs) {
    const row = body.filter((f) => f !== stub && Math.abs(f.advance[3] - stub.advance[3]) < h)
    if (row.some((f) => !numeric.test(f.text) && !interval.test(f.text))) return
    const ranges = row.filter((f) => interval.test(f.text)),
      lane = []
    if (ranges.length < 3) return
    for (const r of ranges) {
      const point = row.filter(
        (f) =>
          numeric.test(f.text) &&
          f.advance[3] < r.advance[1] &&
          Math.abs(f.advance[0] + f.advance[2] - r.advance[0] - r.advance[2]) < h * 0.1
      )
      if (point.length !== 1) return
      lane.push((r.advance[0] + r.advance[2]) / 2)
    }
    centers.push(lane.sort((a, b) => a - b))
    for (const f of row) {
      if (assigned.has(f)) return
      assigned.add(f)
    }
  }
  if (
    assigned.size !== body.length ||
    centers[0].length !== centers[1].length ||
    centers[0].some((x, i) => Math.abs(x - centers[1][i]) > 0.01)
  )
    return
  const all = new Set([...upper, ...lower, head, tail]),
    painted = [...first.rules, ...last.rules].map(paint)
  const crop = [
    Math.min(old[0], ...painted.map((r) => r[0]), ...upper.map((f) => f.ink[0])),
    Math.min(head.advance[1], head.ink[1]),
    Math.max(old[2], ...painted.map((r) => r[2]), ...upper.map((f) => f.ink[2])),
    old[3]
  ]
  const strips = [
    [crop[0], crop[1], crop[2], old[1]],
    [crop[0], old[1], old[0], old[3]],
    [old[2], old[1], crop[2], old[3]]
  ].filter(valid)
  if (
    !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
    [...all].some((f) => !inside(crop, f.ink)) ||
    captionFonts.some((f) => f.ink[3] >= crop[1]) ||
    fonts.some((f) => !all.has(f) && strips.some((r) => over(f.ink, r))) ||
    graphics.some((g) => strips.some((r) => over(g, r)) && !painted.some((p) => equal(g, p)))
  )
    return
  const serialized =
    !table.caption &&
    !caption.regions &&
    !caption.lines.some((line) => /[-\u00ad\u2010\u2011]\s*$/u.test(line)) &&
    Number.isFinite(context.viewport.scale) &&
    context.viewport.scale > 0
      ? {
          page: caption.page,
          lines: caption.lines,
          text: joinCaptionLines(caption.lines),
          rect: caption.rect.map((x) => x / context.viewport.scale)
        }
      : undefined
  return { cropRect: crop, ...(serialized ? { caption: serialized } : {}) }
}
