/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const horizontal = (rule) => Math.abs(rule[3] - rule[1]) < 0.05
const overlap = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) /
  Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]))

// A detector may merge two vertically adjacent tables. A caption inside the
// merged crop owns the lower table; a full-width rule just above that caption
// bounds the preceding table. Trim only when source rows exist on both sides
// and the separator is witnessed by native page geometry.
export function recoverCaptionBoundaryCrop(table, items, captions, rules) {
  if (!table?.cropRect || !Array.isArray(captions) || !Array.isArray(items)) return
  const [left, top, right, bottom] = table.cropRect
  const source = items.filter(
    (item) => item?.horizontal !== false && item.rect?.[2] > left && item.rect?.[0] < right
  )
  const heights = source
    .map((item) => item.height)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)] ?? 10
  const candidates = captions
    .filter((caption) => captionKind(caption.lines?.[0] ?? '') === 'table')
    .filter(
      (caption) =>
        overlap(caption.rect, table.cropRect) >= 0.5 || Math.abs(caption.rect[0] - left) < height
    )
    .sort((a, b) => a.rect[1] - b.rect[1])
  if (!candidates.length) return

  // If the detector crop already starts below a complete table caption, an
  // interior caption is usually the next stacked table on the page rather
  // than a separator inside this table.  Trimming at it would keep only the
  // tail of the preceding table (the common sparse-fragment failure).  A
  // crop that starts before its first caption still uses the interior-caption
  // recovery below, as before.
  const hasLeadingCaption = candidates.some(
    (caption) => caption.rect[3] <= top + height * 0.5 && top - caption.rect[3] <= height * 8
  )
  const inside = hasLeadingCaption
    ? undefined
    : candidates.find(
        (caption) => caption.rect[1] > top + height && caption.rect[1] < bottom - height
      )
  if (inside) {
    const before = source.filter((item) => item.rect[3] < inside.rect[1] - height * 0.2).length
    const after = source.filter((item) => item.rect[1] > inside.rect[3] + height * 0.2).length
    if (before >= 2 && after >= 2)
      return [left, Math.min(bottom - height * 0.25, inside.rect[3] + height * 0.25), right, bottom]
  }

  const below = candidates.find(
    (caption) => caption.rect[1] >= bottom && caption.rect[1] - bottom <= height * 4
  )
  if (!below) return
  const separators = joinHorizontalTableRules(rules).filter(
    (rule) =>
      horizontal(rule) &&
      rule[1] > top + height &&
      rule[1] < below.rect[1] - height * 0.25 &&
      rule[2] - rule[0] >= (right - left) * 0.75 &&
      overlap(rule, table.cropRect) >= 0.75
  )
  const separator = separators.at(-1)
  if (!separator || separator[1] >= bottom - height * 0.1) return
  const tail = source.filter(
    (item) => item.rect[1] > separator[1] + height * 0.2 && item.rect[3] < bottom + height
  )
  if (tail.length < 2) return
  return [left, top, right, separator[1]]
}
