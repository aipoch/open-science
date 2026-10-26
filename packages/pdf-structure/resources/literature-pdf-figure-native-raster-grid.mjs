/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i]))
const close = (a, b) => Math.abs(a - b) < 1e-6
const expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d))
const compact = (s) => s.replace(/\s/gu, '')

// A complete rectangular raster grid and one whole native caption identify the
// original pixel group. This restores crop bounds without claiming any text.
export function nativeRasterGridCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (
      f?.reason ||
      f?.fallbackFigure ||
      f?.parts ||
      f?.cropRects ||
      f?.headerRaster ||
      f?.sourceItems?.length ||
      f?.caption?.regions ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1
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
    const { evidence, o, v, valid, finite } = p,
      images = evidence.images
    if (images.length < 4 || images.length > 64 || images.some((im) => !valid(im.rect))) return
    // Keep this admission independent of Form/clip inference and of unknown or
    // invisible caption paint. The default packet continues to accept its old inputs.
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
    if (
      !Array.isArray(f.caption.lines) ||
      !f.caption.lines.length ||
      f.caption.lines.some((s) => typeof s !== 'string' || !s.trim())
    )
      return
    const cap = p.records.filter((r) => inside(f.caption.rect, r.rect)),
      em = Math.max(...cap.map((r) => r.r.height)),
      indices = cap.map((r) => r.index)
    if (
      !cap.length ||
      !(em > 0) ||
      cap.some(
        ({ r }) =>
          r.transform[0] <= 0 ||
          r.transform[1] !== 0 ||
          r.transform[2] !== 0 ||
          r.transform[3] <= 0 ||
          r.height !== r.transform[3]
      ) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join('')) ||
      p.records.some((r) => r.index >= indices[0] && r.index <= indices.at(-1) && !cap.includes(r))
    )
      return
    const columns = [],
      rows = []
    for (const im of images) {
      let col = columns.find(
        (c) => close(c[0].rect[0], im.rect[0]) && close(c[0].rect[2], im.rect[2])
      )
      if (!col) columns.push((col = []))
      col.push(im)
      let row = rows.find((r) => close(r[0].rect[3], im.rect[3]))
      if (!row) rows.push((row = []))
      row.push(im)
    }
    columns.sort((a, b) => a[0].rect[0] - b[0].rect[0])
    rows.sort((a, b) => a[0].rect[3] - b[0].rect[3])
    if (
      columns.length < 2 ||
      rows.length < 2 ||
      columns.length * rows.length !== images.length ||
      columns.some(
        (c, n) =>
          c.length !== rows.length ||
          c.some((im) => !close(im.rect[3] - im.rect[1], c[0].rect[3] - c[0].rect[1])) ||
          (n > 0 &&
            (c[0].rect[0] < columns[n - 1][0].rect[2] ||
              c[0].rect[0] - columns[n - 1][0].rect[2] >= em * 2))
      )
    )
      return
    const ordered = []
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n].sort((a, b) => a.rect[0] - b.rect[0])
      if (
        row.length !== columns.length ||
        row.some((im, col) => !columns[col].includes(im)) ||
        (n > 0 &&
          row.some(
            (im, col) =>
              im.rect[1] < rows[n - 1][col].rect[3] ||
              im.rect[1] - rows[n - 1][col].rect[3] >= em * 0.5
          ))
      )
        return
      ordered.push(...row)
    }
    if (ordered.some((im, n) => n > 0 && im.operationIndex <= ordered[n - 1].operationIndex)) return
    const anchors = images.filter(
      (im) =>
        inside(im.rect, f.rect) &&
        (f.rect[2] - f.rect[0]) * (f.rect[3] - f.rect[1]) >
          (im.rect[2] - im.rect[0]) * (im.rect[3] - im.rect[1]) * 0.75
    )
    if (anchors.length !== 1 || !rows.at(-1).includes(anchors[0])) return
    const rect = union(images.map((im) => im.rect)),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale)
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      rect[2] - rect[0] < em * 8 ||
      rect[3] - rect[1] < em * 8 ||
      f.caption.rect[0] > rect[0] ||
      f.caption.rect[2] < rect[2] ||
      f.caption.rect[1] <= rect[3] ||
      f.caption.rect[1] - rect[3] > em * 2 ||
      Math.abs(f.caption.rect[0] + f.caption.rect[2] - rect[0] - rect[2]) > em * 2
    )
      return
    const foreignPaints = nativeRasterForeignPaints(p, page, captions, tables, ctx, images)
    if (!foreignPaints) return
    // Source font envelopes include real ascent/descent and the whole advance;
    // actual foreign glyph ink remains an additional independent boundary.
    for (const { r } of p.records) {
      const style = ctx.content.styles[r.fontName],
        [a, b, c, d, x, y] = r.transform,
        h = Math.hypot(c, d),
        w = Math.hypot(a, b)
      if (
        !Number.isFinite(style?.ascent) ||
        !Number.isFinite(style?.descent) ||
        !(style.ascent > 0) ||
        style.descent > 0 ||
        !(h > 0) ||
        !(w > 0) ||
        !Number.isFinite(r.width) ||
        !(r.width > 0)
      )
        return
      const points = [0, r.width].flatMap((u) =>
        [style.descent * h, style.ascent * h].map((z) =>
          v.convertToViewportPoint(x + (a / w) * u + (c / h) * z, y + (b / w) * u + (d / h) * z)
        )
      )
      if (points.some((q) => !finite(q, 2))) return
      foreignPaints.push({
        rect: [
          Math.min(...points.map((q) => q[0])),
          Math.min(...points.map((q) => q[1])),
          Math.max(...points.map((q) => q[0])),
          Math.max(...points.map((q) => q[1]))
        ],
        floor: 0
      })
    }
    if (
      foreignPaints.some(
        (paint) => !valid(paint.rect) || hit(padded, expand(paint.rect, (paint.floor + 2) / scale))
      )
    )
      return
    return { rect, formCropRaster: { ownedRects: images.map((im) => im.rect), foreignPaints } }
  } catch {
    return undefined
  }
}
