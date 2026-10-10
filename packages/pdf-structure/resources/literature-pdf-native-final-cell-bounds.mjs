/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { recoverOwnedTableCrop } from './literature-pdf-table-geometry.mjs'
// Final geometry reconciliation uses existing literal source owners. It never
// assigns text, infers a statistical role, or accepts a rejected model span.
const sameRect = (a, b) => a.every((value, index) => value === b[index])
const inside = (rect, bounds, tolerance = 0.002) =>
  rect[0] >= bounds[0] - tolerance &&
  rect[1] >= bounds[1] - tolerance &&
  rect[2] <= bounds[2] + tolerance &&
  rect[3] <= bounds[3] + tolerance
const intersection = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const horizontal = (rule) => Math.abs(rule[3] - rule[1]) < 0.2
const sameEndpoints = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[2] - b[2]) < 0.5

// A complete native table can sit beside ordinary body prose.  The detector
// crop then clips the prose at the table edge even though none of its glyphs
// belongs to a cell.  Suppress that diagnostic only when source ownership is
// complete, every clipped glyph is separated from the source bounds by a
// readable gutter, and the clipped run is clearly prose.  Short labels and
// single values remain diagnostics because they may be table evidence.
function isAdjacentProseClipping(clipped, source, cropRect) {
  // A single trailing line may be a table note or footnote. Require a
  // multi-line run before classifying it as neighboring body prose.
  if (!source || clipped.length < 2) return false
  const [left, top, right, bottom] = source.rects.reduce(
    (bounds, rect) => [
      Math.min(bounds[0], rect[0]),
      Math.min(bounds[1], rect[1]),
      Math.max(bounds[2], rect[2]),
      Math.max(bounds[3], rect[3])
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  )
  const em = source.em
  if (![left, top, right, bottom, em].every(Number.isFinite) || em <= 0) return false
  const words = clipped
    .map((item) => item.text.trim())
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean)
  if (words.length < 3 || !words.some((word) => /\p{L}{2,}/u.test(word))) return false
  if (clipped.some((item) => intersection(item.rect, [left, top, right, bottom]) > 0)) return false
  const leftMargin = clipped.every(
    (item) => item.rect[2] <= left - em * 0.25 && item.rect[2] > cropRect[0]
  )
  const bottomMargin = clipped.every(
    (item) =>
      item.rect[1] >= bottom + em * 0.5 &&
      item.rect[1] < cropRect[3] &&
      (item.rect[2] <= left - em * 0.25 || item.rect[0] >= right + em * 0.25)
  )
  const rightMargin = clipped.every(
    (item) => item.rect[0] >= right + em * 0.25 && item.rect[0] < cropRect[2]
  )
  return leftMargin || bottomMargin || rightMargin
}

function sourceEvidence(table, tokens) {
  const rects = table.cells.flatMap((cell) => cell.sourceRects ?? [])
  if (!rects.length || table.unassigned.length || new Set(rects.map(String)).size !== rects.length)
    return
  const matches = rects.map((rect) => tokens.filter((item) => sameRect(item.rect, rect)))
  if (matches.some((items) => items.length !== 1)) return
  const items = matches.flat()
  if (
    items.some(
      (item) =>
        !item.horizontal ||
        !item.rect.every(Number.isFinite) ||
        item.rect[2] <= item.rect[0] ||
        item.rect[3] <= item.rect[1] ||
        !Number.isFinite(item.baseline) ||
        !Number.isFinite(item.height) ||
        item.height <= 0
    )
  )
    return
  const recorded = table.cells.flatMap((cell) => cell.sourceTokens ?? [])
  if (
    recorded.length !== items.length ||
    items.some(
      (item) =>
        recorded.filter(
          (token) =>
            sameRect(token.rect, item.rect) &&
            token.text === item.text &&
            token.baseline === item.baseline &&
            token.height === item.height
        ).length !== 1
    )
  )
    return
  const heights = items.map((item) => item.height).sort((a, b) => a - b)
  return { rects, items, em: heights[Math.floor(heights.length / 2)] }
}

function completeBodyRows(table) {
  const byRow = new Map()
  for (const cell of table.cells) {
    if (!cell.row || cell.rowSpan !== 1) continue
    if (!byRow.has(cell.row)) byRow.set(cell.row, [])
    byRow.get(cell.row).push(cell)
  }
  return [...byRow.values()].filter(
    (row) =>
      row.length === table.columnCount &&
      row.every((cell) => cell.colSpan === 1 && cell.sourceRects.length) &&
      row.filter((cell) => /\d/.test(cell.text)).length >= 2
  )
}

export function proveFirstNativeTitleBand(table, tokens, rules) {
  const source = sourceEvidence(table, tokens)
  if (!source || table.columnCount < 3 || completeBodyRows(table).length < 3) return
  const first = table.cells.filter((cell) => cell.row === 0)
  const occupied = first.filter((cell) => cell.sourceRects.length)
  if (
    occupied.length !== 1 ||
    occupied[0].rowSpan !== 1 ||
    occupied[0].colSpan !== 1 ||
    first.some((cell) => cell !== occupied[0] && cell.text)
  )
    return
  const items = source.items.filter((item) =>
    occupied[0].sourceRects.some((rect) => sameRect(rect, item.rect))
  )
  if (
    !items.length ||
    items.some((item) => /\d/.test(item.text) || Math.abs(item.baseline - items[0].baseline) > 0.1)
  )
    return
  const bodyTop = Math.min(
    ...table.cells
      .filter((cell) => cell.row > 0)
      .flatMap((cell) => cell.sourceRects.map((r) => r[1]))
  )
  const pairs = rules
    .filter(horizontal)
    .flatMap((top) =>
      rules
        .filter(
          (bottom) =>
            horizontal(bottom) &&
            sameEndpoints(top, bottom) &&
            bottom[1] > top[1] &&
            bottom[1] < bodyTop &&
            items.every((item) => inside(item.rect, [top[0], top[1], top[2], bottom[1]]))
        )
        .map((bottom) => [top, bottom])
    )
  if (pairs.length !== 1) return
  const [top, bottom] = pairs[0]
  const band = [top[0], top[1], top[2], bottom[1]]
  if (
    top[2] - top[0] < 0.8 * (table.cropRect[2] - table.cropRect[0]) ||
    rules.some(
      (rule) =>
        Math.abs(rule[2] - rule[0]) < 0.2 &&
        rule[0] > top[0] + 0.5 &&
        rule[0] < top[2] - 0.5 &&
        rule[1] < bottom[1] &&
        rule[3] > top[1]
    )
  )
    return
  const bandItems = tokens.filter((item) => intersection(item.rect, band) > 0)
  if (bandItems.length !== items.length || !bandItems.every((item) => items.includes(item))) return
  return {
    cell: {
      ...occupied[0],
      column: 0,
      colSpan: table.columnCount,
      rect: [table.cropRect[0], table.rows[0].rect[1], table.cropRect[2], table.rows[0].rect[3]]
    }
  }
}

export function proveNativeClosingBeforeNextBand(table, tokens, rules) {
  const source = sourceEvidence(table, tokens)
  if (!source || completeBodyRows(table).length < 3) return
  const top = rules.filter(
    (rule) =>
      horizontal(rule) &&
      rule[1] < Math.min(...source.rects.map((rect) => rect[1])) &&
      rule[1] > table.cropRect[1] - 4
  )
  if (top.length !== 1) return
  const closing = rules.filter(
    (rule) =>
      horizontal(rule) &&
      sameEndpoints(rule, top[0]) &&
      rule[1] > Math.max(...source.rects.map((rect) => rect[3])) &&
      rule[1] < table.cropRect[3]
  )
  if (closing.length !== 1) return
  const next = rules.filter(
    (rule) =>
      horizontal(rule) &&
      rule[1] > closing[0][1] + 1 &&
      rule[1] < table.cropRect[3] &&
      rule[2] - rule[0] > top[0][2] - top[0][0]
  )
  if (next.length !== 1) return
  const bottom = rules.filter(
    (rule) =>
      horizontal(rule) &&
      sameEndpoints(rule, next[0]) &&
      rule[1] > next[0][1] &&
      rule[1] - next[0][1] < 30
  )
  if (bottom.length !== 1) return
  const nextItems = tokens.filter((item) =>
    inside(item.rect, [next[0][0], next[0][1], next[0][2], bottom[0][1]])
  )
  if (nextItems.length !== 1 || /\d/.test(nextItems[0].text)) return
  if (
    tokens.some(
      (item) => intersection(item.rect, [top[0][0], closing[0][1], top[0][2], next[0][1]]) > 0
    )
  )
    return
  const cropRect = [...table.cropRect]
  cropRect[3] = closing[0][1] + 0.5
  if (!source.rects.every((rect) => inside(rect, cropRect))) return
  return { cropRect, nextItems }
}

function nativeOuterFrame(table, tokens, rules) {
  const source = sourceEvidence(table, tokens)
  if (!source || table.columnCount < 3) return
  // A native category label can be centered beside several independent
  // numeric records. Blank stub slots do not make those complete fields
  // incomplete; they also do not authorize any new category rowspan.
  const measured = Array.from({ length: table.rows.length - 1 }, (_, index) =>
    table.cells.filter((cell) => cell.row === index + 1)
  ).filter(
    (row) =>
      row.length === table.columnCount &&
      row.every((cell) => cell.colSpan === 1 && cell.rowSpan === 1) &&
      row.filter((cell) => cell.sourceRects.length && /\d/.test(cell.text)).length >= 2
  )
  if (measured.length < 3) return
  if (
    measured.some((row) => {
      const values = row.filter((cell) => cell.sourceRects.length && /\d/.test(cell.text))
      const items = values.flatMap((cell) =>
        cell.sourceRects.flatMap((rect) => source.items.filter((item) => sameRect(rect, item.rect)))
      )
      return items.some((item) => Math.abs(item.baseline - items[0].baseline) > source.em * 0.2)
    })
  )
    return
  const minY = Math.min(...source.rects.map((rect) => rect[1]))
  const maxY = Math.max(...source.rects.map((rect) => rect[3]))
  const lines = rules.filter(
    (rule) => horizontal(rule) && rule[2] - rule[0] > 0.8 * (table.cropRect[2] - table.cropRect[0])
  )
  const top = lines.filter((rule) => rule[1] <= minY && minY - rule[1] < source.em * 0.4)
  if (top.length !== 1) return
  const closing = lines.filter(
    (rule) => rule[1] >= maxY && rule[1] - maxY < source.em && sameEndpoints(rule, top[0])
  )
  if (closing.length !== 1) return
  const bounded = lines.filter(
    (rule) => rule[1] >= top[0][1] && rule[1] <= closing[0][1] && sameEndpoints(rule, top[0])
  )
  if (bounded.length !== 4) return
  const frame = [top[0][0], top[0][1], top[0][2], closing[0][1]]
  // Text advances are doubles, path endpoints may be float32 (.0051px in
  // the minimized input). This tolerance never changes source geometry.
  if (
    source.rects.some((rect) => rect[0] < frame[0] - 0.01 || rect[2] > frame[2] + 0.01) ||
    tokens.some((item) => intersection(item.rect, frame) > 0 && !source.items.includes(item))
  )
    return
  return { ...source, frame }
}

export function proveNativeOuterColumnBounds(table, tokens, rules) {
  const proof = nativeOuterFrame(table, tokens, rules)
  if (!proof) return
  const pad = proof.em * 0.5
  if (
    table.cropRect[0] > proof.frame[0] ||
    table.cropRect[2] < proof.frame[2] ||
    proof.frame[0] - table.cropRect[0] > pad ||
    table.cropRect[2] - proof.frame[2] > pad
  )
    return
  const left = table.cells.filter((cell) => cell.column === 0)
  const right = table.cells.filter((cell) => cell.column + cell.colSpan === table.columnCount)
  const expandLeft = left.some((cell) =>
    cell.sourceRects.some((rect) => rect[0] < cell.rect[0] - 0.002)
  )
  const expandRight = right.some((cell) =>
    cell.sourceRects.some((rect) => rect[2] > cell.rect[2] + 0.002)
  )
  if (!expandLeft && !expandRight) return
  return {
    cells: table.cells.map((cell) => ({
      ...cell,
      rect: [
        expandLeft && cell.column === 0 ? table.cropRect[0] : cell.rect[0],
        cell.rect[1],
        expandRight && cell.column + cell.colSpan === table.columnCount
          ? table.cropRect[2]
          : cell.rect[2],
        cell.rect[3]
      ]
    }))
  }
}

export function proveNativeOwnedColumnGutters(table, tokens, rules) {
  const proof = nativeOuterFrame(table, tokens, rules)
  if (
    !proof ||
    table.columnCount !== 3 ||
    table.cells.some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1)
  )
    return
  const records = Array.from({ length: table.rows.length - 1 }, (_, index) =>
    table.cells.filter((cell) => cell.row === index + 1)
  )
  if (
    records.length < 3 ||
    records.some(
      (row) =>
        row.length !== 3 ||
        row.some((cell) => !cell.sourceRects.length) ||
        !/^[-−+]?\d+(?:\.\d+)?$/.test(row[1].text.trim()) ||
        !(/\d/.test(row[2].text) || /^—$/.test(row[2].text))
    )
  )
    return
  if (
    records.some((row) => {
      const items = row.flatMap((cell) =>
        cell.sourceRects.flatMap((rect) => proof.items.filter((item) => sameRect(rect, item.rect)))
      )
      return items.some((item) => Math.abs(item.baseline - items[0].baseline) > proof.em * 0.2)
    })
  )
    return
  const headers = table.cells.filter((cell) => cell.row === 0)
  if (
    headers.length !== 3 ||
    headers.some((cell) => !cell.sourceRects.length || /\d/.test(cell.text))
  )
    return
  const cuts = [...headers.map((cell) => cell.rect[0]), headers.at(-1).rect[2]]
  if (
    table.cells.some(
      (cell) =>
        Math.abs(cell.rect[0] - cuts[cell.column]) > 0.002 ||
        Math.abs(cell.rect[2] - cuts[cell.column + 1]) > 0.002
    )
  )
    return
  const newCuts = [...cuts]
  for (let column = 0; column < 2; column++) {
    const left = table.cells
      .filter((cell) => cell.column === column)
      .flatMap((cell) => cell.sourceRects)
    const right = table.cells
      .filter((cell) => cell.column === column + 1)
      .flatMap((cell) => cell.sourceRects)
    const start = Math.max(...left.map((rect) => rect[2]))
    const end = Math.min(...right.map((rect) => rect[0]))
    if (end - start < proof.em * 0.25) return
    if (cuts[column + 1] >= start + 0.001 && cuts[column + 1] <= end - 0.001) continue
    if (
      rules.some(
        (rule) =>
          Math.abs(rule[0] - rule[2]) < 0.2 &&
          rule[0] > start &&
          rule[0] < end &&
          rule[1] < proof.frame[3] &&
          rule[3] > proof.frame[1]
      )
    )
      return
    newCuts[column + 1] = (start + end) / 2
  }
  if (newCuts.every((cut, index) => cut === cuts[index])) return
  const cells = table.cells.map((cell) => ({
    ...cell,
    rect: [newCuts[cell.column], cell.rect[1], newCuts[cell.column + 1], cell.rect[3]]
  }))
  if (
    cells.some((cell) =>
      cell.sourceRects.some(
        (rect) => rect[0] < cell.rect[0] - 0.002 || rect[2] > cell.rect[2] + 0.002
      )
    )
  )
    return
  return { cells, cuts: newCuts }
}

export function reconcileNativeFinalCellBounds({
  table,
  cells,
  rows,
  columnRects,
  tokens,
  rules,
  unassigned,
  clipped,
  repairs
}) {
  const view = {
    cropRect: table.cropRect,
    cells,
    rows,
    columnCount: columnRects.length,
    unassigned
  }
  const title = proveFirstNativeTitleBand(view, tokens, rules)
  if (title) {
    cells.splice(0, cells.length, title.cell, ...cells.filter((cell) => cell.row !== 0))
    repairs.push('ruled-table-title-recovered')
  }
  const closing = proveNativeClosingBeforeNextBand(view, tokens, rules)
  if (closing) {
    view.cropRect = closing.cropRect
    repairs.push('native-table-footer-crop-recovered')
  }
  // The publisher previously grew this source-owned crop after refinement.
  // Resolve final columns against that same existing recovery, but only once
  // our complete native frame and independent paired fields prove ownership.
  if (nativeOuterFrame(view, tokens, rules)) {
    const ownedCrop = recoverOwnedTableCrop(view, rules)
    if (ownedCrop.some((value, index) => value !== view.cropRect[index])) {
      view.cropRect = ownedCrop
      repairs.push('native-owned-column-crop-recovered')
    }
  }
  const outer = proveNativeOuterColumnBounds(view, tokens, rules)
  if (outer) {
    cells.splice(0, cells.length, ...outer.cells)
    columnRects[0][0] = cells.find((cell) => cell.column === 0).rect[0]
    columnRects.at(-1)[2] = cells.find(
      (cell) => cell.column + cell.colSpan === columnRects.length
    ).rect[2]
    repairs.push('native-outer-column-bounds-recovered')
  }
  const inner = proveNativeOwnedColumnGutters(view, tokens, rules)
  if (inner) {
    cells.splice(0, cells.length, ...inner.cells)
    for (let index = 0; index < columnRects.length; index++) {
      columnRects[index][0] = inner.cuts[index]
      columnRects[index][2] = inner.cuts[index + 1]
    }
    repairs.push('native-source-column-gutters-recovered')
  }
  // Only stale early-crop diagnostics with one complete current native owner
  // are resolved. A genuinely crossing font box or ambiguous owner stays.
  const source = sourceEvidence(view, tokens)
  const finalClipped = clipped.filter((item) => {
    const owners = cells.filter((cell) =>
      cell.sourceRects.some((rect) => sameRect(rect, item.rect))
    )
    if (
      source &&
      inside(item.rect, view.cropRect) &&
      owners.length === 1 &&
      item.rect[0] >= owners[0].rect[0] - 0.002 &&
      item.rect[2] <= owners[0].rect[2] + 0.002 &&
      source.items.filter((owner) => sameRect(owner.rect, item.rect) && owner.text === item.text)
        .length === 1
    )
      return false
    if (closing && !intersection(item.rect, view.cropRect) && closing.nextItems.includes(item))
      return false
    return true
  })
  const adjacentProse = isAdjacentProseClipping(finalClipped, source, view.cropRect)
  if (adjacentProse) repairs.push('adjacent-prose-boundary-suppressed')
  return {
    cropRect: view.cropRect,
    clipped: adjacentProse ? [] : finalClipped
  }
}
