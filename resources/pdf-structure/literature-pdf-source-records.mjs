/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside, union } from './literature-pdf-table-geometry.mjs'

// Record recognizers share strict source containment, while each recognizer
// retains its own anchors, row tolerances and statistical expressions.
export function tableSourceItems(items, [left, top, right, bottom]) {
  return items
    .filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
}

// Compact strings are for recognition only. Never write them back to source
// tokens or use them as replacement text in the exported table.
export function readSourceRow(items, cuts) {
  if (
    cuts.length < 2 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n > 0 && x <= cuts[n - 1])) ||
    new Set(items).size !== items.length
  )
    return
  const cells = cuts.slice(1).map(() => [])
  for (const item of items) {
    const [left, , right] = item.rect
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return
    const column = cuts.slice(1).findIndex((x) => (left + right) / 2 < x)
    if (column < 0 || left < cuts[column] || right > cuts[column + 1]) return
    cells[column].push(item)
  }
  return cells.map((cell) =>
    cell
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, '')
  )
}

// A token may not disappear or be claimed twice when nearby anchors produce
// overlapping record groups. Repeated values at different positions are valid.
export function hasUniqueRecordTokens(items, groups) {
  const remaining = new Set(items)
  if (remaining.size !== items.length) return false
  for (const group of groups) {
    if (!group.length) return false
    for (const item of group) if (!remaining.delete(item)) return false
  }
  return remaining.size === 0
}

// Split only a uniquely owned model row. Unlike strict column containment in
// readSourceRow, row repair uses glyph centers, matching cell assignment. The
// caller supplies ordered source groups and retains responsibility for deciding
// whether their labels/values justify a split. No source tokens are rewritten.
export function splitOwnedSourceRow(rows, items, upper, lower, bounds) {
  return splitOwnedSourceRows(rows, items, [upper, lower], bounds)
}

// The same ownership check applies when one model band contains several
// complete source records. Keep the pair interface for existing recognizers.
export function splitOwnedSourceRows(rows, items, groups, [left, right]) {
  const members = groups.flat()
  if (
    groups.length < 2 ||
    !hasUniqueRecordTokens(members, groups) ||
    members.some((i) => !items.includes(i))
  )
    return
  const owns = (row, item) => inside([left, row.rect[1], right, row.rect[3]], item)
  const owners = rows.filter((row) => members.every((item) => owns(row, item)))
  if (
    owners.length !== 1 ||
    items.some((item) => !members.includes(item) && owns(owners[0], item)) ||
    rows.some((row) => row !== owners[0] && members.some((item) => owns(row, item)))
  )
    return
  const rects = groups.map(union)
  if (rects.some((rect, n) => n && rects[n - 1][3] >= rect[1])) return
  return {
    index: rows.indexOf(owners[0]),
    rows: rects.map((rect, n) => ({
      rect: [
        left,
        n ? (rects[n - 1][3] + rect[1]) / 2 : rect[1],
        right,
        n + 1 < rects.length ? (rect[3] + rects[n + 1][1]) / 2 : rect[3]
      ],
      origin: 'source-text'
    }))
  }
}
