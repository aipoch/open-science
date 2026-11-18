/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const inside = (r, outer) =>
  r.every((n, i) => (i < 2 ? n >= outer[i] - 1e-6 : n <= outer[i] + 1e-6))
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const center = (r) => (r[0] + r[2]) / 2

// A chart and a ruled table may be two panels of one numbered figure. Require
// both panel labels and every original table text item before withdrawing its grid.
export function nativeFigureTablePanel({
  page,
  figure,
  rect,
  table,
  tokens,
  rules,
  viewport,
  peers,
  captions
}) {
  const toPage = (r) => r.map((n, i) => n * (i % 2 ? page.height : page.width))
  const number = /^Fig(?:ure)?\.?\s+(\d+)[.:]\s/iu.exec(figure.caption?.lines?.[0] ?? '')?.[1]
  if (
    !number ||
    page.renderRotation !== 0 ||
    page.rotation !== 0 ||
    viewport?.rotation !== 0 ||
    viewport.width !== page.width ||
    viewport.height !== page.height ||
    !valid(rect) ||
    !Array.isArray(page.graphicsBounds) ||
    figure.caption.page !== page.pageNumber ||
    !valid(figure.caption.rect) ||
    table.page !== page.pageNumber ||
    table.caption ||
    table.captionIssue !== 'no-adjacent-table-caption' ||
    table.parts ||
    table.notes?.length ||
    table.unassigned?.length ||
    table.clipped?.length !== 1 ||
    table.issues?.length !== 1 ||
    table.issues[0] !== 'text-crosses-crop-boundary' ||
    !valid(table.region) ||
    !valid(table.cropRect) ||
    table.sourceViewport?.scale !== 1.5 ||
    table.sourceViewport.width !== page.width * 1.5 ||
    table.sourceViewport.height !== page.height * 1.5
  )
    return
  const captionText = figure.caption.lines.join(' ')
  if (
    !['a', 'b'].every((label) =>
      new RegExp(`\\b(?:Figure|Fig\\.?)\\s+${number}\\s*(?:${label}\\b|\\(${label}\\))`, 'iu').test(
        captionText
      )
    )
  )
    return
  const tableRect = toPage(table.region)
  if (!tableRect.every((n, i) => Math.abs(n * 1.5 - table.cropRect[i]) < 1e-6)) return
  const lane = [
    Math.min(rect[0], tableRect[0]),
    rect[1],
    Math.max(rect[2], tableRect[2]),
    figure.caption.rect[1]
  ]
  if (!valid(lane)) return
  const local = tokens.filter((token) => valid(token.rect) && overlaps(token.rect, lane))
  const label = (letter) =>
    local.filter(
      (t) =>
        new RegExp(`^\\(${letter}\\)\\s+\\S`, 'u').test(t.text) &&
        t.horizontal &&
        t.sourceItem?.pageNumber === page.pageNumber &&
        t.sourceItem.text === t.text &&
        valid(t.nativeLabelRect)
    )
  const first = label('a'),
    second = label('b'),
    [a] = first,
    [b] = second
  if (
    first.length !== 1 ||
    second.length !== 1 ||
    !Number.isFinite(a.height) ||
    a.height <= 0 ||
    Math.abs(a.height - b.height) > 1e-6 ||
    a.fontAscent !== b.fontAscent ||
    a.fontDescent !== b.fontDescent ||
    Math.abs(center(a.rect) - center(b.rect)) > a.height * 0.1 ||
    Math.abs(center(b.rect) - center(tableRect)) > a.height ||
    !inside(a.nativeLabelRect, rect) ||
    a.nativeLabelRect[3] > b.rect[1] ||
    b.rect[1] < tableRect[1] ||
    b.nativeLabelRect[3] + 1 >= lane[3] ||
    lane[3] - b.nativeLabelRect[3] > 2 * a.height ||
    b.rect[1] - tableRect[3] > a.height ||
    b.text !== table.clipped[0].text ||
    !b.rect.every((n, i) => Math.abs(n * 1.5 - table.clipped[0].rect?.[i]) < 1e-6)
  )
    return
  const nativeRules = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[0] >= table.cropRect[0] &&
        r[2] <= table.cropRect[2] &&
        r[2] - r[0] >= (table.cropRect[2] - table.cropRect[0]) * 0.9 &&
        r[1] > a.nativeLabelRect[3] * 1.5 &&
        r[1] < b.rect[1] * 1.5
    )
    .sort((u, v) => u[1] - v[1])
  if (
    nativeRules.length !== 3 ||
    nativeRules.some(
      (r) => Math.abs(r[0] - nativeRules[0][0]) > 0.01 || Math.abs(r[2] - nativeRules[0][2]) > 0.01
    )
  )
    return
  const [top, divider, bottom] = nativeRules.map((r) => r[1] / 1.5)
  const tableTokens = local.filter((t) => t.rect[1] > a.nativeLabelRect[3] && t.rect[3] < b.rect[1])
  if (
    !Array.isArray(table.grid) ||
    table.grid.length < 3 ||
    table.grid[0]?.length < 2 ||
    table.cells?.length !== table.grid.length * table.grid[0].length ||
    tableTokens.length !== table.cells.length ||
    a.sourceItem.index >= b.sourceItem.index
  )
    return
  const byIndex = new Map(tableTokens.map((t) => [t.sourceItem?.index, t]))
  const indices = new Set(),
    positions = new Set()
  for (const cell of table.cells) {
    const origin = cell.sourceItems?.[0],
      token = byIndex.get(origin?.index)
    const position = cell.row + ':' + cell.column
    if (
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      positions.has(position) ||
      table.grid[cell.row]?.[cell.column] !== cell.text ||
      cell.sourceItems?.length !== 1 ||
      !token ||
      !token.horizontal ||
      token.sourceItem.pageNumber !== page.pageNumber ||
      origin.pageNumber !== page.pageNumber ||
      origin.text !== cell.text ||
      token.text !== cell.text ||
      !inside(token.rect, [
        nativeRules[0][0] / 1.5,
        cell.row === 0 ? top : divider,
        nativeRules[0][2] / 1.5,
        cell.row === 0 ? divider : bottom
      ]) ||
      indices.has(origin.index) ||
      origin.index <= a.sourceItem.index ||
      origin.index >= b.sourceItem.index
    )
      return
    positions.add(position)
    indices.add(origin.index)
  }
  const next = [lane[0], lane[1], lane[2], b.nativeLabelRect[3] + 1]
  const tablePaint = tableRect.map((n, i) => n + (i < 2 ? -a.height / 2 : a.height / 2))
  if (
    page.graphicsBounds.some((g) => {
      if (!valid(g.normalizedRect)) return true
      const paint = toPage(g.normalizedRect)
      return (
        overlaps(paint, next) &&
        (!inside(paint, next) ||
          (!inside(paint, rect) && (g.kind !== 'path' || !inside(paint, tablePaint))))
      )
    }) ||
    local.some(
      (t) =>
        overlaps(t.rect, next) &&
        (!inside(t.rect, next) ||
          (t.rect[3] > a.nativeLabelRect[3] && t !== b && !indices.has(t.sourceItem?.index)))
    ) ||
    peers.some((r) => !valid(r) || overlaps(r, next)) ||
    captions.some((c) => c !== figure.caption && (!valid(c.rect) || overlaps(c.rect, next)))
  )
    return
  const current = retainNativeRecoveryInputs(
    [page, figure, rect, table, tokens, rules, peers, captions],
    viewport
  )
  if (current?.()) return { rect: next, current }
}
