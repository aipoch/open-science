/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { hasUniqueRecordTokens, readSourceRow } from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const centerY = (i) => (i.rect[1] + i.rect[3]) / 2

// Repeated native vertical segments independently prove every leaf record.
// Full-width horizontal separators group those records around one centered
// left stub. Neither the detector's coarse rows nor the stub's baseline proves
// a data-row boundary.
export function recoverNativeSegmentedStubRecords(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
    em = heights[Math.floor(heights.length * 0.9)]
  if (!(em > 0)) return
  const vertical = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > crop[0] + em &&
        r[0] < crop[2] - em &&
        r[1] > crop[1] - em &&
        r[3] < crop[3] + em &&
        r[3] - r[1] > em * 0.7
    ),
    xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (xs.length < 3 || xs.length > 11) return
  const segments = vertical.filter((r) => r[0] === xs[0]).sort((a, b) => a[1] - b[1])
  if (segments.length < 5 || segments.some((r, n) => n && r[1] < segments[n - 1][3] - 0.02)) return
  for (const x of xs) {
    const next = vertical.filter((r) => r[0] === x).sort((a, b) => a[1] - b[1])
    if (
      next.length !== segments.length ||
      next.some(
        (r, n) => Math.abs(r[1] - segments[n][1]) > 0.02 || Math.abs(r[3] - segments[n][3]) > 0.02
      )
    )
      return
  }
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] > segments[0][1] &&
        r[1] < segments.at(-1)[3] &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 2 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const left = full[0][0],
    right = full[0][2],
    top = segments[0][1] - em * 0.3,
    bottom = segments.at(-1)[3],
    cuts = [left, ...xs, right],
    source = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < right &&
        i.rect[2] > left &&
        centerY(i) > top &&
        centerY(i) < bottom
    )
  if (
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < left ||
        i.rect[2] > right ||
        i.rect[1] < top ||
        i.rect[3] > bottom
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < right &&
        c.rect[2] > left &&
        ((c.rect[3] < top && top - c.rect[3] < em * 3) ||
          (c.rect[1] > bottom - em * 0.15 && c.rect[3] > bottom && c.rect[1] - bottom < em * 3))
    ).length !== 1
  )
    return
  const rows = segments.map((r, n) => [
    left,
    n
      ? (segments[n - 1][3] + r[1]) / 2
      : Math.min(r[1], ...source.filter((i) => centerY(i) < r[3]).map((i) => i.rect[1])),
    right,
    n === segments.length - 1 ? bottom : (r[3] + segments[n + 1][1]) / 2
  ])
  const groups = rows.map((r) => source.filter((i) => centerY(i) >= r[1] && centerY(i) < r[3])),
    header = groups[0]
  if (
    !hasUniqueRecordTokens(source, groups) ||
    !readSourceRow(header, cuts)?.every((t) => /\p{L}/u.test(t))
  )
    return
  const boundary = []
  for (const rule of full) {
    const matches = rows
      .map((r, n) => (Math.abs(r[3] - rule[1]) < em * 0.1 ? n : -1))
      .filter((n) => n >= 0)
    if (matches.length !== 1) return
    boundary.push(matches[0] + 1)
  }
  if (boundary[0] !== 1 || boundary.at(-1) >= rows.length) return
  boundary.push(rows.length)
  const spans = []
  for (let g = 1; g < boundary.length; g++) {
    const start = boundary[g - 1],
      end = boundary[g],
      records = groups.slice(start, end),
      stubs = records.flat().filter((i) => i.rect[2] <= cuts[1]),
      leaf = records.map((r) => r.filter((i) => i.rect[0] >= cuts[1]))
    if (
      records.length < 2 ||
      !stubs.length ||
      !readSourceRow(stubs, cuts, { multiline: true })?.[0] ||
      stubs.some((i) => !/\p{L}/u.test(i.text)) ||
      leaf.some((r) => {
        const v = readSourceRow(r, cuts)
        return !v || !v[1] || !v.slice(2).every((t) => /\d/.test(t))
      })
    )
      return
    const main = leaf.map((r) =>
        median(r.filter((i) => i.height >= em * 0.9).map((i) => i.baseline))
      ),
      stubBaseline = median(stubs.map((i) => i.baseline))
    if (
      main.some((y) => !Number.isFinite(y)) ||
      stubs.some((i) => Math.abs(i.baseline - stubBaseline) > em * 0.2) ||
      Math.abs(stubBaseline - main.reduce((a, b) => a + b, 0) / main.length) > em * 0.2
    )
      return
    spans.push({ row: start, column: 0, rowSpan: end - start, colSpan: 1 })
  }
  return {
    cropRect: [left, rows[0][1], right, bottom],
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], rows[0][1], x, bottom]),
    spans,
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
