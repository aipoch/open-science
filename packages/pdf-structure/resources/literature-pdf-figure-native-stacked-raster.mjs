/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i]))
const expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d))
const close = (a, b) => Math.abs(a - b) < 1e-6

// Two adjacent equal raster panels share a complete native caption. Preserve
// original page pixels only; this certificate creates no text ownership.
export function nativeStackedRasterCrop(page, f, captions, tables, tokens, ctx) {
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
    const rules = collectTableRules(ctx.operators, ctx.viewport),
      p = nativePlotPacketInventory(page, f, captions, tables, rules, tokens, ctx)
    if (!p) return
    const { evidence, valid } = p,
      images = evidence.images
    if (images.some((im) => !valid(im.rect))) return
    const anchors = images.filter(
      (im) =>
        inside(im.rect, f.rect) &&
        (f.rect[2] - f.rect[0]) * (f.rect[3] - f.rect[1]) >
          (im.rect[2] - im.rect[0]) * (im.rect[3] - im.rect[1]) * 0.75
    )
    if (anchors.length !== 1) return
    const lower = anchors[0],
      captionRecords = f.caption.lines?.map((line) =>
        p.records.filter((r) => r.r.str === line && inside(f.caption.rect, r.rect))
      )
    if (
      !captionRecords?.length ||
      captionRecords.length > 12 ||
      captionRecords.some((rs) => rs.length !== 1)
    )
      return
    const cap = captionRecords.map((rs) => rs[0]),
      em = cap[0].r.height
    if (
      !(em > 0) ||
      cap.some(
        (r, n) =>
          r.r.fontName !== cap[0].r.fontName ||
          !Number.isFinite(r.r.transform[0]) ||
          r.r.transform[0] <= 0 ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[3] !== em ||
          r.r.height !== em ||
          r.r.sourceItem.index !== cap[0].r.sourceItem.index + n ||
          (n > 0 && r.rect[1] <= cap[n - 1].rect[1])
      )
    )
      return
    const siblings = images.filter(
      (im) =>
        im !== lower &&
        close(im.rect[0], lower.rect[0]) &&
        close(im.rect[2], lower.rect[2]) &&
        close(im.rect[3] - im.rect[1], lower.rect[3] - lower.rect[1]) &&
        im.rect[3] <= lower.rect[1] &&
        lower.rect[1] - im.rect[3] < em * 0.5
    )
    if (siblings.length !== 1) return
    const owned = [siblings[0], lower],
      rect = union(owned.map((im) => im.rect)),
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
    const foreignPaints = nativeRasterForeignPaints(p, page, captions, tables, ctx, owned)
    if (
      foreignPaints.some(
        (paint) => !valid(paint.rect) || hit(padded, expand(paint.rect, (paint.floor + 2) / scale))
      )
    )
      return
    return { rect, formCropRaster: { ownedRects: owned.map((im) => im.rect), foreignPaints } }
  } catch {
    return undefined
  }
}

// Fixed foreign-paint certificate shared by raster-group crop completions.
export function nativeRasterForeignPaints(p, page, captions, tables, ctx, owned) {
  const { evidence, finite, o, v, box } = p,
    images = evidence.images
  const foreignPaints = [
    ...captions.filter((c) => c.page === page.pageNumber).map((c) => ({ rect: c.rect, floor: 0 })),
    ...tables.map((r) => ({ rect: r, floor: 0 })),
    ...p.records.map((r) => ({
      rect: union([
        r.rect,
        nativeFigureLabelBounds(r.r, ctx.content.styles[r.r.fontName], v),
        ...r.part.map(({ g }) => g.ink)
      ]),
      floor: 0
    })),
    ...images.filter((im) => !owned.includes(im)).map((im) => ({ rect: im.rect, floor: 0 }))
  ]
  for (const [i, s] of evidence.paths) {
    const a = o.argsArray[i]
    if (a[0] === OPS.endPath) continue
    const stroke = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      margin = Math.max(Math.SQRT2, p.strokeMargins.get(i) ?? 10),
      pad = stroke ? (s.lineWidth * margin) / 2 : 0,
      m = Util.transform(v.transform, s.transform),
      det = Math.abs(m[0] * m[3] - m[1] * m[2]),
      nx = Math.hypot(m[0], m[1]),
      ny = Math.hypot(m[2], m[3]),
      floor = stroke
        ? (margin / 2) *
          Math.max(
            (Math.abs(m[0]) * ny + Math.abs(m[2]) * nx) / det,
            (Math.abs(m[1]) * ny + Math.abs(m[3]) * nx) / det
          )
        : 0
    if (
      !finite(a[2], 4) ||
      !finite(m, 6) ||
      !(det > 0) ||
      !Number.isFinite(pad) ||
      pad < 0 ||
      !Number.isFinite(floor) ||
      floor < 0
    )
      return
    foreignPaints.push({ rect: box(expand(Array.from(a[2]), pad), m), floor })
  }
  return foreignPaints
}
