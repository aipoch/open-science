/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i]))
const expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d))
const close = (a, b) => Math.abs(a - b) < 1e-6
const compact = (s) => s.replace(/\s/gu, '')

// Whole native labels are printed immediately after their own equal raster
// panels. Their unique centered pairing closes the group without adding owners.
export function nativeLabeledRasterCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (
      (f?.reason && f.reason !== 'native-raster-composite-grid') ||
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
    const { evidence, o, v, finite, valid } = p,
      images = evidence.images
    if (images.length < 4 || images.length > 64 || images.some((im) => !valid(im.rect))) return
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
      horizontal = ({ r }) =>
        r.transform[0] > 0 &&
        r.transform[1] === 0 &&
        r.transform[2] === 0 &&
        r.transform[3] > 0 &&
        r.height === r.transform[3]
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
    for (const im of images) {
      const next = images
          .filter((q) => q.operationIndex > im.operationIndex)
          .reduce((n, q) => Math.min(n, q.operationIndex), Infinity),
        labels = p.records.filter(
          (r) =>
            horizontal(r) &&
            !cap.includes(r) &&
            Math.abs((im.rect[0] + im.rect[2] - r.rect[0] - r.rect[2]) / 2) < r.r.height / 64 &&
            r.rect[1] >= im.rect[3] &&
            r.rect[1] - im.rect[3] < r.r.height * 1.5 &&
            r.part.every(({ g }) => g.show.i > im.operationIndex && g.show.i < next)
        )
      if (labels.length !== 1) return
      pairs.push({ im, label: labels[0] })
    }
    const labels = pairs.map((q) => q.label),
      em = labels[0].r.height,
      w = images[0].rect[2] - images[0].rect[0],
      h = images[0].rect[3] - images[0].rect[1]
    if (
      new Set(labels).size !== images.length ||
      !(em > 0) ||
      labels.some((r) => r.r.height !== em || r.r.fontName !== labels[0].r.fontName) ||
      images.some((im) => !close(im.rect[2] - im.rect[0], w) || !close(im.rect[3] - im.rect[1], h))
    )
      return
    const rows = []
    for (const q of pairs) {
      let row = rows.find((rs) => Math.abs(rs[0].im.rect[1] - q.im.rect[1]) < em / 4)
      if (!row) rows.push((row = []))
      row.push(q)
    }
    rows.sort((a, b) => a[0].im.rect[1] - b[0].im.rect[1])
    for (const row of rows) row.sort((a, b) => a.im.rect[0] - b.im.rect[0])
    const columns = rows[0].length
    if (
      rows.length < 2 ||
      columns < 2 ||
      rows.length * columns !== images.length ||
      rows.some(
        (row, n) =>
          row.length !== columns ||
          row.some(
            (q, col) =>
              Math.abs(q.im.rect[0] - rows[0][col].im.rect[0]) >= em / 2 ||
              (col > 0 &&
                (q.im.rect[0] < row[col - 1].im.rect[2] - em / 64 ||
                  q.im.rect[0] - row[col - 1].im.rect[2] > em)) ||
              (n > 0 &&
                (q.im.rect[1] < rows[n - 1][col].im.rect[3] ||
                  q.im.rect[1] - rows[n - 1][col].im.rect[3] > em * 3))
          )
      )
    )
      return
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
    const ownedRects = [...images.map((im) => im.rect), ...labels.map((r) => domains.get(r))],
      rect = union(ownedRects),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      capEm = Math.max(...cap.map((r) => r.r.height))
    if (
      !inside(rect, f.rect) ||
      !inside([0, 0, page.width, page.height], padded) ||
      rect[2] - rect[0] < em * 8 ||
      rect[3] - rect[1] < em * 8 ||
      f.caption.rect[1] <= rect[3] ||
      f.caption.rect[1] - rect[3] > capEm * 2 ||
      f.caption.rect[2] - f.caption.rect[0] < (rect[2] - rect[0]) / 2 ||
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
    return { rect, formCropRaster: { ownedRects, foreignPaints, paintSeparations } }
  } catch {
    return undefined
  }
}
