/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union } from './literature-pdf-table-geometry.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Dense two-column narrative tables print a separator below each paragraph.
// Use those native bands instead of model rows that split a long instruction.
// The right border must be consistent, and every glyph must have one owner.
export function recoverRuledNarrativeGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 2) return
  const list = recoverBulletedList(table, items, rules, predicted)
  if (list) return list
  const cut = left + (predicted[0].rect[2] + predicted[1].rect[0]) / 2
  const source = tableSourceItems(items, table.cropRect)
  const continuation = source.find((i) =>
    /^\(?continued on (?:following|next) page\)?$/i.test(i.text.trim())
  )
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= top &&
        r[1] <= (continuation?.rect[1] ?? bottom) &&
        r[0] <= cut &&
        r[2] >= right - 12 &&
        r[2] <= right + 12
    )
    .sort((a, b) => a[1] - b[1])
  const ys = [...new Set(borders.map((r) => r[1]))]
  if (ys.length < 12 || borders.some((r) => Math.abs(r[2] - borders[0][2]) > 1)) return
  const body = source.filter(
    (i) => (i.rect[1] + i.rect[3]) / 2 >= ys[0] && (i.rect[1] + i.rect[3]) / 2 <= ys.at(-1)
  )
  const groups = ys
    .slice(1)
    .map((y, n) =>
      body.filter((i) => (i.rect[1] + i.rect[3]) / 2 >= ys[n] && (i.rect[1] + i.rect[3]) / 2 < y)
    )
  if (!hasUniqueRecordTokens(body, groups)) return
  if (
    groups.some((g) => {
      const stubs = g.filter((i) => i.rect[0] < cut)
      return stubs.some((i) => Math.abs(i.baseline - stubs[0].baseline) > i.height * 0.5)
    })
  )
    return
  const cells = groups.map(
    (g) =>
      readSourceRow(g, [left, cut, right]) ??
      (g.every((i) => i.rect[0] < cut && Math.abs(i.baseline - g[0].baseline) < i.height * 0.3)
        ? [g.map((i) => i.text).join(''), '']
        : undefined)
  )
  if (cells.some((r) => !r) || !cells[0].every((s) => /\p{L}/u.test(s) && s.length < 80)) return
  if (
    cells.filter((r) => r[1].length > 160).length < 3 ||
    cells.slice(1).some((r) => r[0].length > 90 || (r[0] && !/\p{L}/u.test(r[0])))
  )
    return
  const spans = cells.flatMap((r, n) =>
    n && r[0] && !r[1] ? [{ row: n, column: 0, rowSpan: 1, colSpan: 2 }] : []
  )
  return {
    rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]),
    columns: [
      [left, top, cut, bottom],
      [cut, top, right, bottom]
    ],
    spans,
    completeSpans: true
  }
}

// A narrow detected bullet column is not a data column. Require native outer
// rules, repeated aligned bullets, outdented section titles and hanging indents;
// every source token must belong to exactly one complete list entry.
function recoverBulletedList(table, items, rules, predicted) {
  const [left, top, right, bottom] = table.cropRect
  const widths = predicted.map((o) => o.rect[2] - o.rect[0])
  if (Math.min(...widths) > (right - left) * 0.08 || Math.max(...widths) < (right - left) * 0.85)
    return
  const source = tableSourceItems(items, table.cropRect)
  if (!source.length) return
  const lines = []
  for (const item of source) {
    const last = lines.at(-1)
    if (last && Math.abs(last[0].baseline - item.baseline) < item.height * 0.2) last.push(item)
    else lines.push([item])
  }
  for (const line of lines) line.sort((a, b) => a.rect[0] - b.rect[0])
  const bullets = lines.filter((line) => /^[–•−-]\s+[\p{L}\d]/u.test(line[0].text))
  if (bullets.length < 8) return
  const indent = bullets[0][0].rect[0],
    height = bullets[0][0].height
  if (bullets.some((line) => Math.abs(line[0].rect[0] - indent) > 1)) return
  const border = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] >= left &&
        r[2] <= right &&
        r[2] - r[0] > (right - left) * 0.9 &&
        r[1] >= top &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (
    border.length !== 3 ||
    border[0][1] > source[0].rect[1] ||
    border.at(-1)[1] < Math.max(...source.map((i) => i.rect[3]))
  )
    return
  const records = [],
    sections = []
  for (const line of lines) {
    const x = line[0].rect[0]
    if (x < indent - height * 0.5) {
      if (
        Math.abs(x - lines[0][0].rect[0]) > 1 ||
        !/^[\p{L} ]{3,60}$/u.test(line.map((i) => i.text).join(' '))
      )
        return
      sections.push(records.length)
      records.push([...line])
    } else if (bullets.includes(line)) records.push([...line])
    else {
      if (
        !records.length ||
        sections.includes(records.length - 1) ||
        x < indent + height * 0.4 ||
        x > indent + height * 1.5 ||
        line[0].baseline - records.at(-1).at(-1).baseline > height * 1.6
      )
        return
      records.at(-1).push(...line)
    }
  }
  if (
    sections.length < 2 ||
    sections[0] !== 0 ||
    sections.some((n, i) => (sections[i + 1] ?? records.length) - n < 3) ||
    border[1][1] <= union(records[0])[3] ||
    border[1][1] >= union(records[1])[1] ||
    !hasUniqueRecordTokens(source, records)
  )
    return
  const rects = records.map(union)
  if (rects.some((r, n) => n && r[1] <= rects[n - 1][3])) return
  return {
    rows: rects.map((r) => [left, r[1], right, r[3]]),
    columns: [[left, top, right, bottom]],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
