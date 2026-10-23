/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { intersection } from './literature-pdf-page-geometry.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6)
const matrix = (m) =>
  finite(m, 6) &&
  ((m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0) ||
    // A quarter turn preserves rectangular clips exactly. Require equal axis
    // scales and positive determinant; mirrors and shears remain unsupported.
    (m[0] === 0 && m[3] === 0 && m[1] !== 0 && m[2] === -m[1]))
const box = (r, m) => {
  const points = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]]
  ]
  for (const p of points) Util.applyTransform(p, m)
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
}

// A single text-free native plate can lack a caption. Its actual Form clip and
// opaque rectangular background must close all four edges. Path unions and
// a loose Form BBox alone cannot invent the missing boundary.
export function nativeUncaptionedFormPlate(page, captions, tables, tokens, context) {
  const o = context?.operators,
    v = context?.viewport
  if (
    ![captions, tables, tokens, page?.graphicsBounds, context?.graphicsBounds].every(
      Array.isArray
    ) ||
    captions.some((c) => c.page === page.pageNumber) ||
    tables.length ||
    page.graphicsBounds.length < 3 ||
    JSON.stringify(page.graphicsBounds) !== JSON.stringify(context.graphicsBounds) ||
    v?.rotation !== 0 ||
    v.scale !== 1 ||
    !finite(v.transform, 6) ||
    !same(v.transform, [1, 0, 0, -1, 0, page.height])
  )
    return
  const inventory = nativePageTextPacketInventory(page, tokens, context, true)
  if (!inventory) return
  const stack = [],
    forms = [],
    paints = new Map()
  let ctm = [1, 0, 0, 1, 0, 0],
    form,
    pendingClip = false
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (pendingClip) return
      stack.push({ op, ctm: [...ctm], form })
      if (op === OPS.paintFormXObjectBegin) {
        if (a?.[0] !== null && !matrix(a?.[0])) return
        if (a[0]) ctm = Util.transform(ctm, a[0])
        if (!matrix(ctm) || !valid(a?.[1])) return
        form = {
          begin: i,
          parent: form,
          quarterTurn: ctm[0] === 0,
          rect: box(a[1], Util.transform(v.transform, ctm)),
          paint: []
        }
        if (!valid(form.rect)) return
        forms.push(form)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const previous = stack.pop()
      if (
        pendingClip ||
        !previous ||
        previous.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)
      )
        return
      if (op === OPS.paintFormXObjectEnd) form.end = i
      ctm = previous.ctm
      form = previous.form
    } else if (op === OPS.transform) {
      if (!matrix(a)) return
      ctm = Util.transform(ctm, a)
    } else if (op === OPS.clip || op === OPS.eoClip) {
      // All local clips must be inside the independently bounded plate; the
      // existing inventory checks each rectangular clip's actual geometry.
      if (!form || pendingClip) return
      pendingClip = true
    } else if (op === OPS.showText) {
      if (form) return
    } else if (op === OPS.constructPath) {
      const path = a?.[1]?.[0]
      if (
        !form ||
        !finite(a?.[2], 4) ||
        !(Array.isArray(path) || ArrayBuffer.isView(path)) ||
        !path.length ||
        !path.every(Number.isFinite)
      )
        return
      if (a[0] === OPS.endPath) {
        pendingClip = false
        continue
      }
      if (pendingClip || paints.has(i)) return
      for (let owner = form; owner; owner = owner.parent) owner.paint.push(i)
      paints.set(i, a)
    }
  }
  const roots = forms.filter((f) => !f.parent)
  if (
    stack.length ||
    pendingClip ||
    form ||
    roots.length !== 1 ||
    forms.some((f) => !Number.isInteger(f.end))
  )
    return
  const root = roots[0],
    rect = root.rect,
    normalized = rect.map((x, i) => x / (i % 2 ? page.height : page.width))
  const size = (normalized[2] - normalized[0]) * (normalized[3] - normalized[1])
  // The complete native clip and page bounds prove the lower edge. A fixed
  // footer margin would discard tall plates whose full ink remains on the page.
  if (
    !inside([0, 0, page.width, page.height], rect) ||
    normalized[0] < 0.04 ||
    normalized[2] > 0.96 ||
    normalized[1] < 0.06 ||
    size <= 0.12 ||
    size > 0.65 ||
    paints.size !== page.graphicsBounds.length ||
    root.paint.length !== paints.size
  )
    return
  const ids = new Set()
  for (const g of page.graphicsBounds) {
    const state = inventory.evidence.paths.get(g.operationIndex)
    if (
      g.kind !== 'path' ||
      !Number.isInteger(g.operationIndex) ||
      ids.has(g.operationIndex) ||
      !paints.has(g.operationIndex) ||
      !valid(g.normalizedRect) ||
      !valid(state?.clip) ||
      !inside(rect, state.clip)
    )
      return
    ids.add(g.operationIndex)
    const r = g.normalizedRect.map((x, i) => x * (i % 2 ? page.height : page.width))
    const clipped = [
      Math.max(r[0], state.clip[0]),
      Math.max(r[1], state.clip[1]),
      Math.min(r[2], state.clip[2]),
      Math.min(r[3], state.clip[3])
    ]
    if (!valid(clipped) || !inside(rect, clipped)) return
  }
  const first = root.paint[0],
    background = paints.get(first),
    state = inventory.evidence.paths.get(first),
    path = background[1]?.[0]
  if (
    background[0] !== OPS.fill ||
    state.fillAlpha !== 1 ||
    !same(state.clip, rect) ||
    path?.length !== 13 ||
    path[0] !== 0 ||
    path[12] !== 4 ||
    ![3, 6, 9].every((i) => path[i] === 1)
  )
    return
  const points = [0, 3, 6, 9].map((i) => [path[i + 1], path[i + 2]])
  if (
    points.some((p, i) => {
      const q = points[(i + 1) % 4]
      return p[0] !== q[0] && p[1] !== q[1]
    })
  )
    return
  const r = [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
  if (
    !valid(r) ||
    new Set(points.map((p) => p.join(','))).size !== 4 ||
    points.some((p) => ![r[0], r[2]].includes(p[0]) || ![r[1], r[3]].includes(p[1]))
  )
    return
  if (!inside(box(r, Util.transform(v.transform, state.transform)), rect)) return
  if (
    inventory.records.some((r) => {
      const label = nativeFigureLabelBounds(r.r, context.content.styles?.[r.r.fontName], v)
      return (
        !valid(label) ||
        intersection(label, rect) > 0 ||
        intersection(r.rect, rect) > 0 ||
        r.part.some((p) => intersection(p.g.ink, rect) > 0)
      )
    })
  )
    return
  return {
    rect,
    graphicsCount: paints.size,
    reason: 'native-uncaptioned-form-plate',
    ...(root.quarterTurn ? { clipToForm: true } : {})
  }
}
