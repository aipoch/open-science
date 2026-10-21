/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0
const contains = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 0.001 : v <= a[i] + 0.001))
const bounds = (points) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1]))
]
const sameSource = (a, b) =>
  a.pageNumber === b.pageNumber && a.index === b.index && a.text === b.text

// A stroked curly brace has two vertical legs and four mirrored cubic bends.
// Decode the actual path, not its enclosing rectangle or a nearby text shape.
function bracePoints(args, state, viewport) {
  if (
    args?.[0] !== OPS.stroke ||
    args[1]?.length !== 1 ||
    !state?.clip ||
    !state.solidStroke ||
    state.strokeAlpha !== 1 ||
    !(state.lineWidth > 0)
  )
    return
  if (
    !Array.isArray(args[1][0]) &&
    !(ArrayBuffer.isView(args[1][0]) && typeof args[1][0].length === 'number')
  )
    return
  let path = Array.from(args[1][0])
  if (!path.every(Number.isFinite) || path[0] !== 0) return
  while (path[3] === 0 && path[1] === path[4] && path[2] === path[5]) path = path.slice(3)
  const points = [[path[1], path[2]]]
  let offset = 3
  for (const kind of [2, 1, 2, 2, 1, 2]) {
    if (path[offset++] !== kind) return
    for (let i = 0; i < (kind === 2 ? 3 : 1); i++) points.push([path[offset++], path[offset++]])
  }
  if (offset !== path.length || points.some((p) => !p.every(Number.isFinite))) return
  const matrix = Util.transform(viewport.transform, state.transform)
  if (
    !matrix.every(Number.isFinite) ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    matrix[0] === 0 ||
    Math.abs(Math.abs(matrix[0]) - Math.abs(matrix[3])) > 1e-6
  )
    return
  for (const p of points) Util.applyTransform(p, matrix)
  const start = points[0],
    end = points.at(-1),
    cusp = points[7],
    tolerance = Math.max(0.001, state.lineWidth * Math.abs(matrix[0]) * 0.01),
    direction = Math.sign(cusp[0] - start[0]),
    vertical = Math.sign(end[1] - start[1]),
    width = Math.abs(cusp[0] - start[0]),
    height = Math.abs(end[1] - start[1]),
    local = points.map((p) => [(p[0] - start[0]) * direction, (p[1] - start[1]) * vertical])
  if (
    !(width > tolerance && height > width * 4) ||
    Math.abs(end[0] - start[0]) > tolerance ||
    Math.abs(cusp[1] - (start[1] + end[1]) / 2) > tolerance ||
    local.some(
      (p, i) =>
        p[0] < -tolerance ||
        p[0] > width + tolerance ||
        (i && p[1] < local[i - 1][1] - tolerance) ||
        (i && (i <= 7 ? p[0] < local[i - 1][0] - tolerance : p[0] > local[i - 1][0] + tolerance)) ||
        Math.abs(p[0] - local.at(-i - 1)[0]) > tolerance ||
        Math.abs(p[1] + local.at(-i - 1)[1] - height) > tolerance
    ) ||
    ![3, 4, 10, 11].every((i) => Math.abs(local[i][0] - local[3][0]) <= tolerance) ||
    !(local[3][0] > tolerance && local[3][0] < width - tolerance) ||
    !(local[3][1] < local[4][1] && local[10][1] < local[11][1])
  )
    return
  const box = bounds(points),
    halfStroke = (state.lineWidth * Math.abs(matrix[0])) / 2,
    painted = box.map((v, i) => v + (i < 2 ? -halfStroke : halfStroke))
  if (!contains(state.clip, painted)) return
  return { start, end, cusp, direction, box: painted, tolerance }
}

export function nativeBraceFigureLabel(page, figure, captions, tables, tokens, context) {
  const bound = figure.rect
  if (
    !valid(bound) ||
    !figure.caption ||
    !figure.sourceItems?.length ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    context?.viewport?.scale !== 1 ||
    !context.operators ||
    !context.content?.items ||
    !Array.isArray(page.graphicsBounds)
  )
    return
  const { fnArray, argsArray } = context.operators
  if (
    fnArray.some(
      (op, i) =>
        [OPS.beginGroup, OPS.endGroup, OPS.beginAnnotation, OPS.endAnnotation].includes(op) ||
        (op === OPS.setGState &&
          (!Array.isArray(argsArray[i]?.[0]) ||
            argsArray[i][0].some(
              ([name, value]) =>
                !['LW', 'LC', 'D', 'CA', 'ca'].includes(name) && !(name === 'TR' && value === null)
            )))
    )
  )
    return
  const inventory = tokens.filter((t) => t.text?.trim())
  if (
    inventory.some(
      (t) =>
        !valid(t.rect) ||
        !t.sourceItem ||
        t.sourceItem.pageNumber !== page.pageNumber ||
        t.sourceItem.text !== t.text ||
        context.content.items[t.sourceItem.index]?.str !== t.text
    ) ||
    context.content.items.some(
      (item, index) =>
        item.str?.trim() && inventory.filter((t) => t.sourceItem.index === index).length !== 1
    )
  )
    return
  const owned = inventory.filter((t) => figure.sourceItems.some((s) => sameSource(s, t.sourceItem)))
  if (
    owned.length !== figure.sourceItems.length ||
    owned.some((t) => !contains(bound, t.rect)) ||
    !proveNativeUniqueWholeFonts(owned, tokens)
  )
    return
  const evidence = { paths: new Map(), frames: new Map(), texts: new Map(), images: [] },
    frames = collectClosedFigureFrames(context.operators, context.viewport, evidence),
    nodes = frames
      .filter(
        (r) =>
          contains(bound, r) &&
          area(r) < area(bound) * 0.8 &&
          owned.some((t) => contains(r, t.rect))
      )
      .sort((a, b) => a[1] - b[1])
  if (
    nodes.length < 3 ||
    nodes.some((r, i) => i && r[1] <= nodes[i - 1][3]) ||
    inventory.some((t) => nodes.some((r) => contains(r, t.rect)) && !owned.includes(t))
  )
    return
  const conflict = (r) =>
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, r) > 0) ||
    tables.some((t) => intersection(t, r) > 0)
  const proposals = []
  for (const [index, state] of evidence.paths) {
    const brace = bracePoints(argsArray[index], state, context.viewport)
    if (!brace || !contains(bound, brace.box)) continue
    const { start, end, cusp, direction, tolerance } = brace,
      top = Math.min(start[1], end[1]),
      bottom = Math.max(start[1], end[1]),
      nodeHeight = Math.min(...nodes.map((r) => r[3] - r[1])),
      edge = direction > 0 ? 2 : 0,
      gap = (start[0] - nodes[0][edge]) * direction
    if (
      Math.abs(top - nodes[0][1]) > tolerance ||
      Math.abs(bottom - nodes.at(-1)[3]) > tolerance ||
      !(gap > 0 && gap < nodeHeight) ||
      nodes.some((r) => Math.abs(r[edge] - nodes[0][edge]) > nodeHeight * 0.1) ||
      !nodes.some((r) => Math.abs((r[1] + r[3]) / 2 - cusp[1]) < tolerance)
    )
      continue
    const painted = page.graphicsBounds.find((g) => g.kind === 'path' && g.operationIndex === index)
    if (
      !painted ||
      !contains(
        painted.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
        brace.box
      )
    )
      continue
    const labels = inventory.filter(
      (t) =>
        !contains(bound, t.rect) &&
        t.horizontal &&
        t.height > 0 &&
        t.height < nodeHeight * 0.75 &&
        Math.abs((t.rect[1] + t.rect[3]) / 2 - cusp[1]) < t.height * 0.2 &&
        (direction > 0 ? t.rect[0] - cusp[0] : cusp[0] - t.rect[2]) > 0 &&
        (direction > 0 ? t.rect[0] - cusp[0] : cusp[0] - t.rect[2]) < t.height &&
        t.rect[1] > top &&
        t.rect[3] < bottom
    )
    if (labels.length !== 1 || !proveNativeUniqueWholeFonts(labels, tokens)) continue
    const label = labels[0],
      rect = union([bound, label.rect])
    if (
      !contains([0, 0, page.width, page.height], rect) ||
      conflict(rect) ||
      inventory.some(
        (t) => t !== label && intersection(t.rect, rect) > intersection(t.rect, bound) + 0.001
      ) ||
      page.graphicsBounds.some((g) => {
        const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        return intersection(r, rect) > intersection(r, bound) + 0.001
      })
    )
      continue
    proposals.push({
      rect,
      sourceItems: [...figure.sourceItems, label.sourceItem].sort(
        (a, b) => a.pageNumber - b.pageNumber || a.index - b.index
      )
    })
  }
  return proposals.length === 1 ? proposals[0] : undefined
}
