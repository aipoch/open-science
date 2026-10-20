/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside, union } from './literature-pdf-table-geometry.mjs'

const plainNumber = /^[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u
const parenthesizedNumber = /^\([−–-]?(?:\d+(?:\.\d+)?|\.\d+)\)$/u

// Dense statistical tables often print a model's estimates on one baseline and
// its standard errors on the next. A detector can either put two complete
// records into one row, or put the error line in the following row. This
// helper only moves observed source rows; it never invents values or columns.
export function recoverWrappedMeanSeRows({ rows, items, columnRects, repairs }) {
  if (!Array.isArray(rows) || !Array.isArray(items) || columnRects?.length < 3) return false
  const columnOf = (item) =>
    columnRects.findIndex(
      (rect) =>
        (item.rect[0] + item.rect[2]) / 2 >= rect[0] && (item.rect[0] + item.rect[2]) / 2 < rect[2]
    )
  const owned = (row) => items.filter((item) => item.horizontal !== false && inside(row.rect, item))
  const valueAt = (group) => {
    const cells = Array.from({ length: columnRects.length }, () => [])
    for (const item of group) {
      const column = columnOf(item)
      if (column >= 0) cells[column].push(item)
    }
    return cells.map((cell) =>
      cell
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text)
        .join('')
        .replace(/\s/gu, '')
    )
  }
  const heightOf = (group) => {
    const values = group
      .map((item) => item.height)
      .filter((height) => height > 0)
      .sort((a, b) => a - b)
    return values[values.length >> 1]
  }
  const groupsOf = (source) => {
    const height = heightOf(source)
    if (!(height > 0)) return []
    const groups = []
    for (const item of [...source].sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    )) {
      const group = groups.at(-1)
      if (group && Math.abs(item.baseline - group[0].baseline) < height * 0.35) group.push(item)
      else groups.push([item])
    }
    return groups
  }
  const groupUnion = (groups) => {
    const items = groups.flat()
    return items.length ? union(items) : [0, 0, 0, 0]
  }
  const isMain = (group) => {
    const values = valueAt(group)
    return (
      values[0] &&
      /\p{L}/u.test(values[0]) &&
      values.slice(1).filter((value) => plainNumber.test(value)).length >= 3
    )
  }
  const isSe = (group) => {
    const values = valueAt(group)
    return (
      !values[0] &&
      values.slice(1).filter((value) => parenthesizedNumber.test(value)).length >= 3 &&
      values.slice(1).every((value) => !value || parenthesizedNumber.test(value))
    )
  }
  let changed = false

  // First split detector rows that contain two independent model baselines.
  // Segment boundaries are placed between the last glyph of one record and
  // the first glyph of the next, so every source glyph has one row owner.
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n],
      source = owned(row),
      groups = groupsOf(source),
      mains = groups.flatMap((group, index) => (isMain(group) ? [index] : []))
    if (mains.length < 2) continue
    const slices = mains.map((main, index) => {
      const next = mains[index + 1]
      const before = groups.slice(main, next ?? groups.length)
      const top = index
        ? (groupUnion(groups.slice(mains[index - 1], main))[3] + groupUnion(before)[1]) / 2
        : row.rect[1]
      const bottom = next
        ? (groupUnion(before)[3] +
            groupUnion(groups.slice(next, mains[index + 2] ?? groups.length))[1]) /
          2
        : row.rect[3]
      return { ...row, rect: [row.rect[0], top, row.rect[2], bottom] }
    })
    if (
      slices.some(
        (slice) =>
          !Number.isFinite(slice.rect[1]) ||
          !Number.isFinite(slice.rect[3]) ||
          slice.rect[3] <= slice.rect[1]
      )
    )
      continue
    rows.splice(n, 1, ...slices)
    n += slices.length - 1
    changed = true
    repairs?.push?.('wrapped-mean-se-records-separated')
  }

  // Then merge a detached SE line into the preceding estimate row. Require
  // several same-column pairs; one parenthesized value alone is ambiguous.
  for (let n = 1; n < rows.length; n++) {
    const upper = rows[n - 1],
      lower = rows[n],
      upperItems = owned(upper),
      lowerItems = owned(lower),
      upperGroups = groupsOf(upperItems),
      lowerGroups = groupsOf(lowerItems),
      upperValues = valueAt(upperItems),
      lowerValues = valueAt(lowerItems)
    if (
      !upperItems.length ||
      !lowerItems.length ||
      lowerGroups.length !== 1 ||
      !isMain(upperGroups[0]) ||
      !isSe(lowerGroups[0]) ||
      lowerGroups[0].some((item) => columnOf(item) < 1) ||
      lowerValues
        .slice(1)
        .some(
          (value, offset) =>
            value &&
            (!parenthesizedNumber.test(value) || !plainNumber.test(upperValues[offset + 1] ?? ''))
        )
    )
      continue
    const pairs = lowerValues.slice(1).filter(Boolean).length
    if (pairs < 3) continue
    upper.rect[3] = Math.max(upper.rect[3], lower.rect[3], union(lowerItems)[3])
    rows.splice(n--, 1)
    changed = true
    repairs?.push?.('wrapped-mean-se-continuation-recovered')
  }
  return changed
}
