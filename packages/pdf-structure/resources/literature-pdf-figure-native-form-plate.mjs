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

// Some inline diagrams have no number. Admit only one closed packet of
// interleaved native polygons with an isolated four-line caption beside prose.
export function nativeInlinePolygonFigure(page, captions, tables, tokens, context) {
  const graphics = page.graphicsBounds,
    ops = context?.operators,
    viewport = context?.viewport
  if (
    !ops ||
    viewport?.rotation !== 0 ||
    !finite(viewport.transform, 6) ||
    !Array.isArray(graphics) ||
    !Array.isArray(context.content?.items) ||
    ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0) ||
    !same(viewport.transform, [1, 0, 0, -1, 0, page.height]) ||
    captions.some((caption) => caption.page === page.pageNumber) ||
    tables.length ||
    page.invalidGraphicsBounds !== 0 ||
    graphics.length < 24 ||
    graphics.length > 1024 ||
    JSON.stringify(graphics) !== JSON.stringify(context.graphicsBounds) ||
    graphics.some(
      (g, i) =>
        g.kind !== 'path' ||
        !valid(g.normalizedRect) ||
        !Number.isSafeInteger(g.operationIndex) ||
        (i && g.operationIndex <= graphics[i - 1].operationIndex)
    )
  )
    return
  const rect = [0, 1, 2, 3].map(
    (axis) =>
      (axis < 2 ? Math.min : Math.max)(...graphics.map((g) => g.normalizedRect[axis])) *
      (axis % 2 ? page.height : page.width)
  )
  const w = rect[2] - rect[0],
    h = rect[3] - rect[1]
  if (
    rect[0] < page.width * 0.5 ||
    rect[2] > page.width * 0.95 ||
    rect[1] < page.height * 0.1 ||
    rect[3] > page.height * 0.8 ||
    w < page.width * 0.12 ||
    w > page.width * 0.3 ||
    h < w * 0.7 ||
    h > w * 1.4 ||
    tokens.some((token) => intersection(token.rect, rect) > 0)
  )
    return

  const first = graphics[0].operationIndex,
    last = graphics.at(-1).operationIndex
  const { fnArray: operators, argsArray: args } = ops
  const clip = args[first - 2],
    clipPath = clip?.[1]?.[0]
  if (
    operators[first - 4] !== OPS.save ||
    operators[first - 3] !== OPS.clip ||
    operators[first - 2] !== OPS.constructPath ||
    clip?.[0] !== OPS.endPath ||
    !valid(clip[2]) ||
    !finite(clipPath, 13) ||
    operators[first - 1] !== OPS.setFillRGBColor ||
    operators[last + 1] !== OPS.restore ||
    last - first > graphics.length * 2
  )
    return
  const [left, bottom, right, top] = clip[2]
  if (!same(clipPath, [0, left, bottom, 1, right, bottom, 1, right, top, 1, left, top, 4])) return
  const colors = new Set(),
    sides = new Set()
  let next = 0
  for (let i = first - 1; i <= last; i++) {
    if (operators[i] === OPS.setFillRGBColor) {
      const color = args[i]?.[0]
      if (!/^#([0-9a-f]{2})\1\1$/iu.test(color) || color.toLowerCase() === '#ffffff') return
      colors.add(color.toLowerCase())
      continue
    }
    const a = args[i],
      path = a?.[1]?.[0],
      edges = path?.length / 3 - 1
    if (
      operators[i] !== OPS.constructPath ||
      graphics[next++]?.operationIndex !== i ||
      ![OPS.fill, OPS.eoFill].includes(a[0]) ||
      ![3, 6].includes(edges) ||
      !finite(path, 3 * (edges + 1)) ||
      path[0] !== 0 ||
      path[1] !== path.at(-2) ||
      path[2] !== path.at(-1) ||
      !valid(a[2]) ||
      !inside(clip[2], a[2])
    )
      return
    const vertices = []
    for (let j = 0; j < path.length - 3; j += 3) {
      if (j && path[j] !== 1) return
      vertices.push([path[j + 1], path[j + 2]])
    }
    if (
      path.at(-3) !== 1 ||
      new Set(vertices.map((point) => point.join(','))).size !== edges ||
      !same(a[2], [
        Math.min(...vertices.map(([x]) => x)),
        Math.min(...vertices.map(([, y]) => y)),
        Math.max(...vertices.map(([x]) => x)),
        Math.max(...vertices.map(([, y]) => y))
      ])
    )
      return
    sides.add(edges)
  }
  if (next !== graphics.length || colors.size < 2 || sides.size !== 2) return

  const center = (rect[0] + rect[2]) / 2
  const centered = tokens.filter(
    (token) =>
      token.horizontal &&
      token.rect[1] >= rect[3] &&
      token.rect[1] - rect[3] < token.height * 5.5 &&
      Math.abs((token.rect[0] + token.rect[2]) / 2 - center) < w * 0.18
  )
  const candidates = centered.filter(
    (token) => token.rect[1] - rect[3] < (centered[0]?.height ?? 0) * 5.5
  )
  if (candidates.length !== 4) return
  const [firstRow, secondRow, , lastRow] = candidates
  const em = firstRow.height,
    pitch = secondRow.baseline - firstRow.baseline
  const entries = candidates.map(({ sourceItem }) => context.content.items[sourceItem?.index])
  if (
    !firstRow.sourceItem ||
    firstRow.rect[1] - rect[3] > em * 1.25 ||
    pitch < em * 1.1 ||
    pitch > em * 1.55 ||
    !/^\p{Lu}/u.test(firstRow.text) ||
    !/^\p{Ll}+(?: \p{Ll}+)?$/u.test(lastRow.text) ||
    lastRow.rect[2] - lastRow.rect[0] > w * 0.4 ||
    candidates.some(
      (token, index) =>
        !/^\p{L}[\p{L}\p{M} /’'-]*$/u.test(token.text) ||
        !valid(token.rect) ||
        token.rect[2] - token.rect[0] > w ||
        Math.abs(token.height - em) > em * 0.02 ||
        Math.abs(token.baseline - firstRow.baseline - index * pitch) > em * 0.05 ||
        token.sourceSegment ||
        token.sourceItem?.pageNumber !== page.pageNumber ||
        token.sourceItem?.index !== firstRow.sourceItem.index + index ||
        token.sourceItem?.text !== token.text ||
        entries[index]?.str !== token.text ||
        !entries[index].fontName ||
        entries[index].fontName !== entries[0].fontName ||
        (index > 0 && !/^\p{Ll}/u.test(token.text))
    ) ||
    page.lines.filter(
      (line) =>
        line.y > rect[1] &&
        line.y < lastRow.rect[1] &&
        line.x + line.width <= Math.min(...candidates.map((token) => token.rect[0])) &&
        line.width >= w &&
        line.fontSize > em * 1.05
    ).length < 3
  )
    return
  const caption = {
    page: page.pageNumber,
    rect: [0, 1, 2, 3].map((axis) =>
      (axis < 2 ? Math.min : Math.max)(...candidates.map((token) => token.rect[axis]))
    ),
    lines: candidates.map((token) => token.text)
  }
  return { caption, rect, graphicsCount: graphics.length }
}

// An independent fully clipped Form is stronger evidence than a mixed strip
// envelope that included the lower half of a neighboring diagram.
export function nativeSideBySideFormFigureCrops(page, captions, tables, tokens, context, figures) {
  const ops = context?.operators,
    viewport = context?.viewport,
    local = captions.filter((caption) => caption.page === page.pageNumber)
  if (
    figures.length !== 2 ||
    local.length !== 2 ||
    page.invalidGraphicsBounds !== 0 ||
    page.rotation !== 0 ||
    viewport?.rotation !== 0 ||
    !finite(viewport.transform, 6) ||
    !same(viewport.transform, [1, 0, 0, -1, 0, page.height]) ||
    !ops ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 16000 ||
    !Array.isArray(context.content?.items) ||
    JSON.stringify(page.graphicsBounds) !== JSON.stringify(context.graphicsBounds) ||
    figures.some(
      (f) =>
        !valid(f.rect) ||
        !local.includes(f.caption) ||
        f.fallbackFigure ||
        f.sourceItems?.length ||
        f.parts?.length ||
        f.formCropRaster
    )
  )
    return

  const sorted = figures.slice().sort((a, b) => a.caption.rect[0] - b.caption.rect[0])
  const [wide] = sorted.filter(
    (f) => f.reason === 'native-raster-vector-strip' && f.rect[2] - f.rect[0] > page.width * 0.65
  )
  if (!wide) return
  const peer = sorted.find((f) => f !== wide)
  const forms = [],
    stack = []
  let ctm = [1, 0, 0, 1, 0, 0],
    active
  for (const [index, op] of ops.fnArray.entries()) {
    const args = ops.argsArray[index]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ op, ctm })
      if (op === OPS.paintFormXObjectBegin) {
        if (
          active ||
          args?.[0] !== null ||
          !valid(args[1]) ||
          !matrix(ctm) ||
          ctm[1] !== 0 ||
          ctm[2] !== 0
        )
          return
        const rect = box(args[1], Util.transform(viewport.transform, ctm))
        if (!valid(rect) || !inside([0, 0, page.width, page.height], rect)) return
        active = { start: index, rect }
        forms.push(active)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const previous = stack.pop()
      if (previous?.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      ctm = previous.ctm
      if (op === OPS.paintFormXObjectEnd) {
        if (!active) return
        active.end = index
        active = undefined
      }
    } else if (op === OPS.transform) {
      if (!finite(args, 6)) return
      ctm = Util.transform(ctm, args)
    }
  }
  if (active || stack.length || forms.length !== 2) return
  const [left, right] = forms
  const w = left.rect[2] - left.rect[0]
  if (
    right.rect[0] <= left.rect[2] ||
    right.rect[0] - left.rect[2] > page.width * 0.1 ||
    w < page.width * 0.25 ||
    w > page.width * 0.48 ||
    Math.abs(w - right.rect[2] + right.rect[0]) > 0.05 ||
    [1, 3].some((axis) => Math.abs(left.rect[axis] - right.rect[axis]) > 0.05)
  )
    return

  if (
    !forms.every((f) => intersection(wide.rect, f.rect) > 0) ||
    !inside(peer.rect, forms[sorted.indexOf(peer)].rect)
  )
    return

  const starts = [],
    ends = []
  const number = (f) => Number(/^Figure\s+([1-9]\d*):/u.exec(f.caption.lines[0])?.[1])
  if (!Number.isSafeInteger(number(sorted[0])) || number(sorted[1]) !== number(sorted[0]) + 1)
    return
  const native = (t) => {
    const item = t.sourceItem
    return (
      item?.pageNumber === page.pageNumber &&
      Number.isSafeInteger(item.index) &&
      !t.sourceSegment &&
      context.content.items[item.index]?.str === t.text &&
      item.text === t.text
    )
  }
  const compact = (value) => value.normalize('NFKC').replace(/\s/gu, '')
  for (const [index, { rect, start, end }] of forms.entries()) {
    const caption = sorted[index].caption
    const parts = tokens.filter((t) => intersection(t.rect, caption.rect) > 0)
    if (
      !parts.length ||
      parts.some((t) => !native(t) || !t.horizontal || !inside(caption.rect, t.rect))
    )
      return
    if (
      parts
        .map((t) => t.text)
        .join('')
        .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '')
    )
      return
    const em = Math.max(...parts.map((t) => t.height))
    if (
      !(em > 0) ||
      caption.rect[1] <= rect[3] ||
      caption.rect[1] - rect[3] > em * 2 ||
      [0, 2].some((axis) => Math.abs(caption.rect[axis] - rect[axis]) > em * 0.1)
    )
      return
    starts.push(parts[0].sourceItem.index)
    ends.push(parts.at(-1).sourceItem.index)
    const text = tokens.filter((t) => intersection(t.rect, rect) > 0)
    if (
      !text.length ||
      text.some(
        (t) =>
          !native(t) ||
          !inside(rect, t.rect) ||
          t.sourceItem.index >= starts[index] ||
          (index && t.sourceItem.index <= ends[index - 1])
      )
    )
      return
    const first = Math.min(...text.map((t) => t.sourceItem.index))
    const nativeText = context.content.items
      .slice(first, starts[index])
      .map((item) => item.str ?? '')
      .join('')
    // Extraction can expose glyphs outside a Form clip. Match all painted
    // text operations against the complete original sequence before treating
    // a nearby extraction-only token as part of the clipped diagram.
    const glyphText = []
    for (let i = start + 1; i < end; i++) {
      if (ops.fnArray[i] !== OPS.showText) continue
      const glyphs = ops.argsArray[i]?.[0]
      if (!Array.isArray(glyphs)) return
      for (const glyph of glyphs) {
        if (typeof glyph === 'number') continue
        if (typeof glyph?.unicode !== 'string') return
        glyphText.push(glyph.unicode)
      }
    }
    if (
      compact(nativeText) !== compact(glyphText.join('')) ||
      tokens.some(
        (t) =>
          intersection(t.rect, [rect[0], rect[3], rect[2], caption.rect[1]]) > 0 &&
          (!native(t) || t.sourceItem.index < first || t.sourceItem.index >= starts[index])
      )
    )
      return
  }

  for (const form of forms) {
    const own = page.graphicsBounds.filter(
      (g) => g.operationIndex > form.start && g.operationIndex < form.end
    )
    if (!own.some((g) => g.kind === 'image') || own.filter((g) => g.kind === 'path').length < 3)
      return
    if (
      page.graphicsBounds.some(
        (g) =>
          !own.includes(g) &&
          intersection(
            form.rect,
            (g.paintedNormalizedRect ?? g.normalizedRect).map(
              (value, i) => value * (i % 2 ? page.height : page.width)
            )
          ) > 0
      )
    )
      return
    if (tables.some((rect) => intersection(rect, form.rect) > 0)) return
  }

  return figures.map((figure) =>
    figure === wide ? { caption: wide.caption, rect: forms[sorted.indexOf(wide)].rect } : figure
  )
}
