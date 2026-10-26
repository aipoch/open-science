/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i]))
const expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d))
const close = (a, b) => Math.abs(a - b) < 1e-6
const compact = (s) => s.replace(/\s/gu, '')

// Independently measured complete text columns, not a wider image-label margin.
// Restore pixels only; the original figure's text ownership remains unchanged.
export function nativePairedRasterTailCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (
      f?.reason ||
      f?.fallbackFigure ||
      f?.parts ||
      f?.cropRects ||
      f?.headerRaster ||
      f?.sourceItems?.length ||
      f?.caption?.regions
    )
      return
    const p = nativePlotPacketInventory(
      page,
      f,
      captions,
      tables,
      collectTableRules(ctx.operators, ctx.viewport),
      tokens,
      ctx
    )
    if (!p) return
    const { evidence, o, v, finite, valid } = p,
      images = evidence.images.filter((im) => valid(im.rect) && hit(im.rect, f.rect))
    if (images.length !== 2 || evidence.images.some((im) => !valid(im.rect))) return
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (
        [
          OPS.paintFormXObjectBegin,
          OPS.paintFormXObjectEnd,
          OPS.beginGroup,
          OPS.endGroup,
          OPS.clip,
          OPS.eoClip
        ].includes(op)
      )
        return
      if (
        op === OPS.setFillRGBColor &&
        (typeof a?.[0] !== 'string' || !/^#[\da-f]{6}$/iu.test(a[0]) || /^#ffffff$/iu.test(a[0]))
      )
        return
      if (op === OPS.setGState && a[0].some((e) => ['CA', 'ca'].includes(e[0]) && e[1] !== 1))
        return
    }
    const horizontal = ({ r }) =>
      r.dir === 'ltr' &&
      r.transform[0] > 0 &&
      r.transform[1] === 0 &&
      r.transform[2] === 0 &&
      r.transform[3] > 0 &&
      r.height === r.transform[3]
    if (
      !Array.isArray(f.caption.lines) ||
      !f.caption.lines.length ||
      f.caption.lines.some((s) => typeof s !== 'string' || !s.trim())
    )
      return
    const cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
    if (
      !cap.length ||
      cap.some((r) => !horizontal(r)) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join('')) ||
      p.records.some(
        (r) => r.index >= cap[0].index && r.index <= cap.at(-1).index && !cap.includes(r)
      )
    )
      return
    const pairs = []
    for (const [n, im] of [...images].sort((a, b) => a.rect[0] - b.rect[0]).entries()) {
      const parents = p.records.filter(
        (r) =>
          horizontal(r) &&
          !cap.includes(r) &&
          new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)\\s+\\S', 'u').test(r.r.str) &&
          !/[.!?]$/u.test(r.r.str) &&
          inside(f.rect, r.rect) &&
          close(r.rect[0], im.rect[0]) &&
          r.rect[2] >= im.rect[2] &&
          r.rect[1] >= im.rect[3] &&
          r.rect[1] - im.rect[3] < r.r.height * 1.5
      )
      if (parents.length !== 1) return
      const parent = parents[0],
        tail = p.records[p.records.indexOf(parent) + 1],
        em = parent.r.height
      if (
        !tail ||
        !horizontal(tail) ||
        cap.includes(tail) ||
        tail.r.sourceItem.index !== parent.r.sourceItem.index + 1 ||
        tail.r.fontName !== parent.r.fontName ||
        tail.r.height !== em ||
        !tail.r.transform.slice(0, 4).every((x, i) => x === parent.r.transform[i]) ||
        !close(tail.rect[0], parent.rect[0]) ||
        tail.rect[2] >= parent.rect[2] ||
        tail.rect[1] - parent.rect[1] < em * 1.1 ||
        tail.rect[1] - parent.rect[1] > em * 1.5 ||
        !/^\p{Ll}/u.test(tail.r.str)
      )
        return
      pairs.push({ im, parent, tail })
    }
    const [a, b] = pairs,
      em = a.parent.r.height,
      labels = pairs.flatMap((q) => [q.parent, q.tail])
    if (
      new Set(labels).size !== 4 ||
      b.parent.r.height !== em ||
      b.parent.r.fontName !== a.parent.r.fontName ||
      Math.abs(a.parent.r.width - b.parent.r.width) >= em / 64 ||
      !close(a.parent.rect[1], b.parent.rect[1]) ||
      !close(a.tail.rect[1], b.tail.rect[1]) ||
      !close(a.im.rect[1], b.im.rect[1]) ||
      !close(a.im.rect[3], b.im.rect[3]) ||
      a.parent.rect[2] >= b.parent.rect[0] ||
      pairs.some((q) => q.im.rect[2] - q.im.rect[0] < em * 8) ||
      !labels.some((r) => r.rect[3] > f.rect[3])
    )
      return
    for (let n = 0; n < pairs.length; n++) {
      const q = pairs[n],
        next =
          pairs[n + 1]?.im.operationIndex ??
          Math.min(...cap.flatMap((r) => r.part.map(({ g }) => g.show.i)))
      if (
        ![q.parent, q.tail].every((r) =>
          r.part.every(({ g }) => g.show.i > q.im.operationIndex && g.show.i < next)
        )
      )
        return
      if (
        p.records.some(
          (r) =>
            !cap.includes(r) &&
            !labels.includes(r) &&
            r.rect[0] < q.parent.rect[2] &&
            r.rect[2] > q.parent.rect[0] &&
            r.rect[1] >= q.parent.rect[1] &&
            r.rect[1] < f.caption.rect[1]
        )
      )
        return
    }
    const domains = new Map()
    for (const r of p.records) {
      const s = ctx.content.styles[r.r.fontName],
        [a, b, c, d, x, y] = r.r.transform,
        hh = Math.hypot(c, d),
        ww = Math.hypot(a, b)
      if (
        !Number.isFinite(s?.ascent) ||
        !Number.isFinite(s?.descent) ||
        !(s.ascent > 0) ||
        s.descent > 0 ||
        !(hh > 0) ||
        !(ww > 0) ||
        !Number.isFinite(r.r.width) ||
        !(r.r.width > 0)
      )
        return
      const points = [0, r.r.width].flatMap((u) =>
        [s.descent * hh, s.ascent * hh].map((z) =>
          v.convertToViewportPoint(x + (a / ww) * u + (c / hh) * z, y + (b / ww) * u + (d / hh) * z)
        )
      )
      if (points.some((q) => !finite(q, 2))) return
      const rect = union([
        r.rect,
        nativeFigureLabelBounds(r.r, s, v),
        [
          Math.min(...points.map((q) => q[0])),
          Math.min(...points.map((q) => q[1])),
          Math.max(...points.map((q) => q[0])),
          Math.max(...points.map((q) => q[1]))
        ],
        ...r.part.map(({ g }) => g.ink)
      ])
      if (!valid(rect)) return
      domains.set(r, rect)
    }
    if (
      hit(
        union([domains.get(a.parent), domains.get(a.tail)]),
        union([domains.get(b.parent), domains.get(b.tail)])
      )
    )
      return
    const ownedRects = [f.rect, ...labels.map((r) => domains.get(r))],
      rect = union(ownedRects),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      capEm = Math.max(...cap.map((r) => r.r.height))
    if (
      !rect.slice(0, 3).every((x, i) => x === f.rect[i]) ||
      rect[3] <= f.rect[3] ||
      !inside([0, 0, page.width, page.height], padded) ||
      f.caption.rect[1] <= rect[3] ||
      f.caption.rect[1] - rect[3] > capEm * 2 ||
      Math.abs(f.caption.rect[0] + f.caption.rect[2] - rect[0] - rect[2]) > capEm * 2
    )
      return
    const foreign = p.records.filter((r) => !labels.includes(r)),
      foreignPaints = nativeRasterForeignPaints(
        { ...p, records: foreign },
        page,
        captions,
        tables,
        ctx,
        images
      )
    if (!foreignPaints) return
    foreignPaints.push(...foreign.map((r) => ({ rect: domains.get(r), floor: 0 })))
    if (
      foreignPaints.some(
        (paint) => !valid(paint.rect) || hit(padded, expand(paint.rect, (paint.floor + 2) / scale))
      )
    )
      return
    const paintSeparations = []
    for (const label of labels)
      for (const im of images) {
        if (label.part.every(({ g }) => g.show.i > im.operationIndex)) continue
        const glyphInk = union(label.part.map(({ g }) => g.ink))
        if (!valid(glyphInk) || hit(glyphInk, im.rect)) return
        paintSeparations.push({ glyphInk, laterPaintRect: im.rect })
      }
    if (!paintSeparations.length) return
    return { rect, formCropRaster: { ownedRects, foreignPaints, paintSeparations } }
  } catch {
    return undefined
  }
}
