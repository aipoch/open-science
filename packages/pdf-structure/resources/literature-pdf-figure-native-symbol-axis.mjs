/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeGroupedAxisPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { intersection, union } from './literature-pdf-page-geometry.mjs'

// A complete native Form, its closed axis and repeated physical tick marks
// own a larger symbol title. Existing proximity-label contracts stay strict.
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const same = (a, b) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < 1e-5)
export function nativeGroupedSymbolAxisCrop(
  page,
  f,
  captions,
  tables,
  tokens,
  c,
  foreignOwns = () => false
) {
  try {
    if (
      !valid(f?.rect) ||
      f.fallbackFigure ||
      f.headerRaster ||
      f.parts ||
      f.cropRects ||
      f.caption?.regions ||
      f.sourceItems?.length
    )
      return
    const rules = collectTableRules(c.operators, c.viewport),
      axis = rules
        .filter(
          (r) =>
            r[1] === r[3] && r[2] - r[0] > page.width * 0.2 && inside(f.rect, r) && r[1] < f.rect[3]
        )
        .filter((a) =>
          [a[0], a[2]].every(
            (x) =>
              rules.filter(
                (r) =>
                  r[0] === r[2] &&
                  Math.abs(r[0] - x) < 0.05 &&
                  Math.abs(r[3] - a[1]) < 0.05 &&
                  r[3] - r[1] > (a[2] - a[0]) * 0.2
              ).length === 1
          )
        )
    if (axis.length !== 1) return
    const ax = axis[0],
      potential = tokens.filter(
        (t) =>
          t.horizontal &&
          /^\p{L}$/u.test(t.text) &&
          valid(t.nativeLabelRect) &&
          t.rect[1] >= f.rect[3] &&
          t.rect[1] - f.rect[3] < t.height &&
          t.rect[3] < f.caption.rect[1] &&
          Math.abs((t.rect[0] + t.rect[2] - ax[0] - ax[2]) / 2) < t.height
      )
    if (potential.length !== 1) return
    const t = potential[0]
    let p = nativeGroupedAxisPacketInventory(page, f, captions, tables, rules, tokens, c, [
      t.sourceItem
    ])
    if (!p) return
    const target = p.records.find((r) => r.index === t.sourceItem.index)
    if (!target) return
    const o = c.operators,
      stack = [],
      forms = []
    let matrix = [1, 0, 0, 1, 0, 0]
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
        const state = { op, matrix }
        if (op === OPS.paintFormXObjectBegin) {
          if (a?.[0]) matrix = Util.transform(matrix, a[0])
          let rect
          if (a?.[1] !== null && a?.[1] !== undefined) {
            if (!p.finite(a[1], 4)) return
            rect = p.box(a[1], Util.transform(c.viewport.transform, matrix))
            if (!valid(rect)) return
          }
          state.form = { begin: i, rect }
          forms.push(state.form)
        }
        stack.push(state)
      } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        const state = stack.pop(),
          expected =
            op === OPS.restore
              ? OPS.save
              : op === OPS.endGroup
                ? OPS.beginGroup
                : OPS.paintFormXObjectBegin
        if (!state || state.op !== expected) return
        if (state.form) state.form.end = i
        matrix = state.matrix
      } else if (op === OPS.transform) {
        if (!p.finite(a, 6)) return
        matrix = Util.transform(matrix, a)
      }
    }
    if (stack.length) return
    const ancestors = forms.filter(
      (q) => valid(q.rect) && target.part.every(({ g }) => g.i > q.begin && g.i < q.end)
    )
    if (!ancestors.length) return
    const form = ancestors.sort((a, b) => b.end - b.begin - (a.end - a.begin))[0]
    if (!inside(form.rect, f.rect)) return
    const owned = p.records.filter((r) =>
      r.part.every(({ g }) => g.i > form.begin && g.i < form.end)
    )
    if (owned.length < 4 || owned.length > 128) return
    const sourceItems = owned.map((r) => r.r.sourceItem)
    p = nativeGroupedAxisPacketInventory(page, f, captions, tables, rules, tokens, c, sourceItems)
    if (!p) return
    const own = new Set(sourceItems.map((s) => s.index)),
      records = []
    for (const r of p.records) {
      const style = c.content.styles[r.r.fontName],
        label = nativeFigureLabelBounds(r.r, style, c.viewport),
        [a, b, cc, d, x, y] = r.r.transform,
        w = Math.hypot(a, b),
        h = Math.hypot(cc, d)
      if (
        !valid(label) ||
        !Number.isFinite(style?.ascent) ||
        style.ascent <= 0 ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2 ||
        !(w > 0) ||
        !(h > 0)
      )
        return
      const points = [0, r.r.width].flatMap((u) =>
          [style.descent * h, style.ascent * h].map((z) =>
            c.viewport.convertToViewportPoint(
              x + (a / w) * u + (cc / h) * z,
              y + (b / w) * u + (d / h) * z
            )
          )
        ),
        font = [
          Math.min(...points.map((q) => q[0])),
          Math.min(...points.map((q) => q[1])),
          Math.max(...points.map((q) => q[0])),
          Math.max(...points.map((q) => q[1]))
        ],
        whole = union([r.rect, label, font, ...r.part.map(({ g }) => g.ink)])
      if (!valid(whole)) return
      records.push({ ...r, whole })
    }
    const rr = records.filter((r) => own.has(r.index))
    if (rr.some((r) => r.part.some(({ g }) => !inside(p.evidence.texts.get(g.i).clip, r.whole))))
      return
    const title = rr.find((r) => r.index === t.sourceItem.index),
      ticks = rr.filter(
        (r) =>
          /^[−-]?\d+(?:\.\d+)?$/u.test(r.r.str) &&
          r.rect[1] >= ax[1] &&
          r.rect[1] - ax[1] < t.height &&
          r.rect[0] >= ax[0] - t.height &&
          r.rect[2] <= ax[2] + t.height &&
          inside(f.rect, r.rect)
      )
    if (
      ticks.length < 3 ||
      ticks.some(
        (r) => Math.abs(r.rect[3] - ticks[0].rect[3]) > 0.01 || r.r.fontName !== ticks[0].r.fontName
      ) ||
      Math.max(...ticks.map((r) => r.rect[2])) - Math.min(...ticks.map((r) => r.rect[0])) <
        (ax[2] - ax[0]) * 0.5
    )
      return
    const tickBottom = Math.max(...ticks.map((r) => r.rect[3]))
    if (
      title.rect[1] < tickBottom ||
      title.rect[1] - tickBottom >= t.height ||
      title.part.length !== 1 ||
      title.part[0].g.textPaint.fillColor !== '#000000' ||
      title.part[0].g.textPaint.fillAlpha !== 1
    )
      return
    // The real renderer's repeated vertical tick marks connect this exact row to the bottom axis.
    const marks = []
    for (const [i, s] of p.evidence.paths) {
      const a = o.argsArray[i],
        q = a?.[1]
      if (
        ![OPS.stroke, OPS.fillStroke].includes(a?.[0]) ||
        q?.length !== 1 ||
        q[0]?.length !== 6 ||
        q[0][0] !== 0 ||
        q[0][3] !== 1 ||
        s.solidStroke !== true ||
        s.strokeAlpha !== 1
      )
        continue
      const path = q[0],
        m = Util.transform(c.viewport.transform, s.transform),
        u = [path[1], path[2]],
        z = [path[4], path[5]]
      Util.applyTransform(u, m)
      Util.applyTransform(z, m)
      if (
        Math.abs(u[0] - z[0]) < 1e-5 &&
        Math.min(u[1], z[1]) >= ax[1] - 0.01 &&
        Math.max(u[1], z[1]) - ax[1] > 0 &&
        Math.max(u[1], z[1]) - ax[1] < t.height * 0.5
      )
        marks.push({ i, x: u[0] })
    }
    if (
      ticks.some(
        (r) => marks.filter((m) => Math.abs(m.x - (r.rect[0] + r.rect[2]) / 2) < 0.05).length !== 1
      )
    )
      return
    const rect = union([f.rect, ...rr.map((r) => r.whole)]),
      padding = 2 / (Math.ceil(page.width * 1.5) / page.width),
      paint = rect.map((n, i) => n + (i < 2 ? -padding : padding)),
      old = f.rect.map((n, i) => n + (i < 2 ? -padding : padding))
    if (
      rect[3] >= f.caption.rect[1] ||
      !inside(form.rect, rect) ||
      tables.some((r) => intersection(r, paint) > 0) ||
      foreignOwns(paint) ||
      captions.some(
        (cap) =>
          cap.page === page.pageNumber &&
          !same(cap.rect, f.caption.rect) &&
          intersection(cap.rect, paint) > 0
      )
    )
      return
    if (
      records.some(
        (r) => !own.has(r.index) && intersection(r.whole, paint) > intersection(r.whole, old) + 1e-7
      )
    )
      return
    for (const [i, s] of p.evidence.paths) {
      const a = o.argsArray[i]
      if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
      if (!a?.[2] || a[2].length !== 4 || !s.clip) return
      const strokes = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a[0]),
        pad = strokes ? (s.lineWidth * Math.max(1, p.strokeMargins.get(i) ?? 10)) / 2 : 0,
        q = p.box(
          Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
          Util.transform(c.viewport.transform, s.transform)
        ),
        clipped = [
          Math.max(q[0], s.clip[0]),
          Math.max(q[1], s.clip[1]),
          Math.min(q[2], s.clip[2]),
          Math.min(q[3], s.clip[3])
        ]
      if (valid(clipped) && intersection(clipped, paint) > intersection(clipped, old) + 1e-7) return
    }
    if (
      p.evidence.images.some(
        (im) => !valid(im.rect) || intersection(im.rect, paint) > intersection(im.rect, old) + 1e-7
      )
    )
      return
    if (
      c.graphicsBounds.some((g) => {
        if (!valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex)) return true
        const q = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return intersection(q, paint) > intersection(q, old) + 1e-7
      })
    )
      return
    const belongs = (i) => i > form.begin && i < form.end,
      foreignPaints = [
        ...captions
          .filter((cap) => cap.page === page.pageNumber)
          .map((cap) => ({ rect: cap.rect, floor: 0 })),
        ...tables.map((rect) => ({ rect, floor: 0 })),
        ...records.filter((r) => !own.has(r.index)).map((r) => ({ rect: r.whole, floor: 0 })),
        ...p.evidence.images
          .filter((im) => !belongs(im.operationIndex))
          .map((im) => ({ rect: im.rect, floor: 0 }))
      ]
    for (const [i, s] of p.evidence.paths) {
      if (belongs(i) && (!valid(s.clip) || !inside(form.rect, s.clip))) return
      if (belongs(i) || [OPS.endPath, OPS.clip, OPS.eoClip].includes(o.argsArray[i]?.[0])) continue
      const bound = nativeFigurePathPaint(p, i, s)
      if (!bound) return
      foreignPaints.push(bound)
    }
    if (
      p.evidence.images.some(
        (im) => belongs(im.operationIndex) && (!valid(im.rect) || !inside(form.rect, im.rect))
      )
    )
      return
    return {
      rect,
      sourceItems,
      formCropRaster: { ownedRects: rr.map((r) => r.whole), foreignPaints }
    }
  } catch {
    return undefined
  }
}
