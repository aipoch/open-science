/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  joinHorizontalTableRules,
  clusterTableRulePositions,
  classifyTableRuleEdge
} from './literature-pdf-table-rules.mjs'
import { recoverClosedCellGrid } from './literature-pdf-ruled-column-grid.mjs'

export function findClosedDefinitionTailFrame(tokens, rules, pageHeight) {
  if (!(pageHeight > 0)) return
  const horizontal = joinHorizontalTableRules(rules, 1)
  if (horizontal.length !== 2) return
  const [top, bottom] = horizontal
  if (
    Math.abs(top[0] - bottom[0]) > 1 ||
    Math.abs(top[2] - bottom[2]) > 1 ||
    top[1] > pageHeight * 0.2
  )
    return
  const vertical = rules.filter((r) => r[0] === r[2] && r[1] >= top[1] - 1 && r[3] <= bottom[1] + 1)
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (
    xs.length !== 7 ||
    Math.abs(xs[0] - top[0]) > 1 ||
    Math.abs(xs.at(-1) - top[2]) > 1 ||
    xs.some((x) => classifyTableRuleEdge(vertical, 0, x, top[1], bottom[1]) !== 1)
  )
    return
  if (
    xs
      .slice(1)
      .some((x, c) =>
        [top[1], bottom[1]].some((y) => classifyTableRuleEdge(horizontal, 1, y, xs[c], x) !== 1)
      )
  )
    return
  const rect = [top[0] - 0.5, top[1] - 0.5, top[2] + 0.5, bottom[1] + 0.5]
  const source = tokens.filter(
    (i) =>
      i.horizontal &&
      i.text.trim() &&
      i.rect[0] >= xs[0] &&
      i.rect[2] <= xs.at(-1) &&
      (i.rect[1] + i.rect[3]) / 2 >= top[1] &&
      (i.rect[1] + i.rect[3]) / 2 <= bottom[1]
  )
  if (source.some((i) => i.rect[1] < top[1] - i.height * 0.1 || i.rect[3] > bottom[1])) return
  if (
    source.length !== 2 ||
    source.some((i) => i.rect[0] < xs[1] || i.rect[2] > xs[2] || !(i.height > 0))
  )
    return
  if (
    tokens.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < rect[2] &&
        i.rect[2] > rect[0] &&
        i.rect[1] < rect[3] &&
        i.rect[3] > rect[1] &&
        !source.includes(i)
    )
  )
    return
  source.sort((a, b) => a.baseline - b.baseline)
  const [first, last] = source,
    em = first.height
  if (
    Math.abs(last.height - em) > 0.01 ||
    last.baseline - first.baseline < em * 0.8 ||
    last.baseline - first.baseline > em * 2 ||
    Math.abs(first.rect[0] - last.rect[0]) > em * 0.1 ||
    bottom[1] - top[1] > em * 6 ||
    !/^[\p{Ll}]/u.test(first.text) ||
    !/[.)]$/.test(last.text)
  )
    return
  rect[1] = Math.min(rect[1], first.rect[1])
  return { rect, xs, source }
}

export function recoverClosedDefinitionTail(
  frame,
  previousTokens,
  previousRules,
  pageNumber,
  previousPageHeight
) {
  if (!frame || !(previousPageHeight > 0) || !Number.isSafeInteger(pageNumber) || pageNumber <= 1)
    return
  const horizontal = joinHorizontalTableRules(previousRules, 1)
  const rows = horizontal.filter(
    (r) => Math.abs(r[0] - frame.xs[0]) < 1 && Math.abs(r[2] - frame.xs.at(-1)) < 1
  )
  if (rows.length < 5 || rows.at(-1)[1] < previousPageHeight * 0.8) return
  const crop = [rows[0][0], rows[0][1], rows[0][2], rows.at(-1)[1]]
  const previous = recoverClosedCellGrid(
    { cropRect: crop, structure: { objects: [] } },
    previousTokens,
    [],
    previousRules
  )
  if (
    !previous?.preservePhysicalRows ||
    previous.columns.length !== 6 ||
    previous.columns.some(
      (column, c) =>
        Math.abs(column[0] - frame.xs[c]) > 0.5 || Math.abs(column[2] - frame.xs[c + 1]) > 0.5
    )
  )
    return
  const last = previous.rows.at(-1)
  const definition = [...previous.ownedTokens]
    .filter(
      (i) =>
        i.rect[0] >= frame.xs[1] &&
        i.rect[2] <= frame.xs[2] &&
        i.rect[1] >= last[1] &&
        i.rect[3] <= last[3]
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const end = definition.at(-1)
  if (
    !end ||
    /[.!?:;)]$/.test(end.text) ||
    !/[\p{L}]$/u.test(end.text) ||
    Math.abs(end.height - frame.source[0].height) > 0.01 ||
    Math.abs(end.rect[0] - frame.source[0].rect[0]) > end.height * 0.1
  )
    return
  const rect = frame.rect,
    object = (label, r) => ({ label, score: 1, rect: r.map((v, axis) => v - rect[axis % 2]) })
  return {
    id: `page-${pageNumber}-native-definition-tail`,
    cropRect: rect,
    structure: {
      objects: [
        object('table row', rect),
        ...frame.xs
          .slice(1)
          .map((x, c) => object('table column', [frame.xs[c], rect[1], x, rect[3]]))
      ]
    }
  }
}
