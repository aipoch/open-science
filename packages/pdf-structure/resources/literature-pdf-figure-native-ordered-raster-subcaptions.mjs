/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Whole ordered raster/subcaption sources; no geometry-only text claims.
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePageTextPacketInventory,
  nativePageTextPacketInventoryWithDualApiCertificate
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
const union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-7 : v <= a[i] + 1e-7)),
  expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d)),
  close = (a, b) => Math.abs(a - b) < 1e-6,
  compact = (s) => s.replace(/\s/gu, ''),
  positive = (g) => !g.rendererSkipped && !(g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3])
export function nativeOrderedRasterSubcaptionCrop(
  page,
  f,
  captions,
  tables,
  tokens,
  ctx,
  evidence
) {
  try {
    if (
      f?.reason !== 'native-raster-side-by-side' ||
      !f.rect ||
      !f.caption?.rect ||
      f.sourceItems?.length ||
      f.caption.regions ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.fallbackFigure
    )
      return
    if (!/^(?:Figure|Fig\.?)\s+[1-9]\d*[.:]\s/u.test(f.caption.lines?.[0] ?? '')) return
    const p = evidence
      ? nativePageTextPacketInventoryWithDualApiCertificate(page, tokens, ctx, evidence, true)
      : nativePageTextPacketInventory(page, tokens, ctx, true)
    if (!p) return
    if (p.records.length > 4096 || p.evidence.paths.size > 4096 || p.evidence.images.length !== 2)
      return
    if (
      p.o.fnArray.some((op) =>
        [
          OPS.beginGroup,
          OPS.endGroup,
          OPS.paintFormXObjectBegin,
          OPS.paintFormXObjectEnd,
          OPS.clip,
          OPS.eoClip
        ].includes(op)
      )
    )
      return
    const full = (r) => {
        const s = ctx.content.styles[r.r.fontName]
        if (
          !Number.isFinite(s?.ascent) ||
          s.ascent <= 0 ||
          s.ascent > 2 ||
          !Number.isFinite(s.descent) ||
          s.descent > 0 ||
          s.descent < -2
        )
          return
        const b = nativeFigureLabelBounds(r.r, s, p.v)
        if (!b) return
        return union([r.rect, b, ...r.part.map((z) => z.g.ink)])
      },
      domains = new Map(p.records.map((r) => [r, full(r)]))
    if ([...domains.values()].some((r) => !p.valid(r))) return
    const seen = new Set()
    for (const r of p.records)
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (seen.has(g)) return
        seen.add(g)
      }
    if (
      p.glyphs.some((g) => {
        const s = ctx.content.styles[g.fontName]
        return (
          positive(g) &&
          (!p.valid(g.ink) ||
            !Number.isFinite(s?.ascent) ||
            s.ascent <= 0 ||
            s.ascent > 2 ||
            !Number.isFinite(s.descent) ||
            s.descent > 0 ||
            s.descent < -2)
        )
      })
    )
      return
    const strokeColors = new Map(),
      colorStack = []
    let strokeColor = '#000000'
    for (let i = 0; i < p.o.fnArray.length; i++) {
      const op = p.o.fnArray[i],
        a = p.o.argsArray[i]
      if (op === OPS.save) colorStack.push(strokeColor)
      else if (op === OPS.restore) {
        if (!colorStack.length) return
        strokeColor = colorStack.pop()
      } else if (op === OPS.setStrokeRGBColor) strokeColor = a?.[0]
      else if (op === OPS.constructPath) strokeColors.set(i, strokeColor)
    }
    if (colorStack.length) return
    const images = [...p.evidence.images].sort((a, b) => a.operationIndex - b.operationIndex),
      [left, right] = images,
      cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
    if (
      !cap.length ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join('')) ||
      p.records.some(
        (r) => r.index >= cap[0].index && r.index <= cap.at(-1).index && !cap.includes(r)
      )
    )
      return
    const capStart = Math.min(...cap.flatMap((r) => r.part.map((z) => z.g.i))),
      imageWidth = left.rect[2] - left.rect[0],
      imageHeight = left.rect[3] - left.rect[1]
    if (
      !(imageWidth > 0 && imageHeight > 0) ||
      !close(right.rect[2] - right.rect[0], imageWidth) ||
      !close(right.rect[3] - right.rect[1], imageHeight) ||
      !close(left.rect[1], right.rect[1]) ||
      !close(left.rect[3], right.rect[3]) ||
      left.rect[2] >= right.rect[0] ||
      right.operationIndex >= capStart
    )
      return
    for (const im of images) {
      const raw = p.o.argsArray[im.operationIndex],
        native = ctx.opaqueRasterImages.filter((z) => z.operationIndex === im.operationIndex)
      if (
        p.o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
        native.length !== 1 ||
        native[0].imageId !== raw[0] ||
        native[0].width !== raw[1] ||
        native[0].height !== raw[2] ||
        native[0].kind !== 2
      )
        return
    }
    if (
      p.o.fnArray.some(
        (op, i) =>
          op === OPS.setGState &&
          p.o.argsArray[i][0].some(([k, v]) => ['ca', 'CA'].includes(k) && v !== 1)
      )
    )
      return
    if (
      p.glyphs.some(
        (g) =>
          positive(g) &&
          (g.textPaint.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
            g.textPaint.fillColor.toLowerCase() === '#ffffff')
      )
    )
      return
    const groups = []
    for (const [n, im] of images.entries()) {
      const end = images[n + 1]?.operationIndex ?? capStart,
        rs = p.records.filter((r) => r.part.every((z) => z.g.i > im.operationIndex && z.g.i < end))
      if (
        rs.length < 2 ||
        rs.length > 24 ||
        rs[0].r.str !== `(${String.fromCharCode(97 + n)})` ||
        rs.filter((r) => /^\([a-z]\)/u.test(r.r.str)).length !== 1
      )
        return
      const em = rs[0].r.height,
        domain = union(rs.map((r) => domains.get(r))),
        ops = rs.flatMap((r) => r.part.map((z) => z.g.i))
      if (
        !(em > 0) ||
        imageWidth < em * 8 ||
        rs.some(
          (r) =>
            r.r.dir !== 'ltr' ||
            r.r.transform[0] <= 0 ||
            r.r.transform[1] !== 0 ||
            r.r.transform[2] !== 0 ||
            r.r.transform[3] !== r.r.height ||
            r.r.height > em ||
            r.r.height < em * 0.5
        ) ||
        rs[0].rect[1] < im.rect[3] ||
        rs[0].rect[1] - im.rect[3] > em * 1.5 ||
        domain[0] < (n === 0 ? left.rect[0] : (left.rect[2] + right.rect[0]) / 2) - 1e-7 ||
        domain[2] > (n === 0 ? (left.rect[2] + right.rect[0]) / 2 : right.rect[2]) + 1e-7 ||
        domain[3] >= f.caption.rect[1] ||
        domain[3] - im.rect[3] > em * 4
      )
        return
      const packets = new Set(rs.flatMap((r) => r.part.map((z) => z.g.packet)))
      if ([...packets].some((q) => q.start <= im.operationIndex)) return
      const ownedGlyphs = new Set(rs.flatMap((r) => r.part.map((z) => z.g)))
      if (
        p.glyphs.some(
          (g) => positive(g) && g.i > im.operationIndex && g.i < end && !ownedGlyphs.has(g)
        )
      )
        return
      groups.push({ im, end, rs, domain, em, ops })
    }
    const records = groups.flatMap((g) => g.rs),
      owned = new Set(records),
      paths = [],
      ownedPaths = []
    for (const [i, s] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const q = nativeFigurePathPaint(p, i, s)
      if (!q || !p.valid(q.rect)) return
      const group = groups.find((g) => i > g.im.operationIndex && i < g.end)
      if (group) {
        const raw = a[1]?.[0],
          line = Array.from(raw ?? []),
          bare = p.box(Array.from(a[2]), Util.transform(p.v.transform, s.transform)),
          linked = group.rs.filter(
            (r) =>
              /^\p{L}$/u.test(r.r.str) &&
              Math.abs(r.rect[0] - bare[0]) <= 0.02 &&
              Math.abs(r.rect[2] - bare[2]) <= 0.02 &&
              bare[1] >= domains.get(r)[1] - 2 / (Math.ceil(page.width * 1.5) / page.width) &&
              bare[3] <= domains.get(r)[3] + 2 / (Math.ceil(page.width * 1.5) / page.width)
          )
        if (
          !/^#[a-f0-9]{6}$/iu.test(strokeColors.get(i)) ||
          strokeColors.get(i).toLowerCase() === '#ffffff' ||
          a[0] !== OPS.stroke ||
          s.strokeAlpha !== 1 ||
          !s.solidStroke ||
          line.length !== 6 ||
          line[0] !== 0 ||
          line[3] !== 1 ||
          line[2] !== line[5] ||
          line[1] >= line[4] ||
          ![line[1], line[2], line[4], line[5]].every((x, k) => x === a[2][k]) ||
          linked.length !== 1 ||
          q.rect[0] < group.im.rect[0] ||
          q.rect[2] > group.im.rect[2] ||
          q.rect[3] >= f.caption.rect[1]
        )
          return
        ownedPaths.push({
          i,
          ...q,
          linkedSource: linked[0].r.sourceItem,
          rawLine: bare,
          advanceRoundoff: 0.02
        })
      } else paths.push({ i, ...q })
    }
    const rect = union([
        ...images.map((im) => im.rect),
        ...records.map((r) => domains.get(r)),
        ...ownedPaths.map((q) => q.rect)
      ]),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      foreignPaints = [
        ...p.records.filter((r) => !owned.has(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
        ...paths.map((q) => ({ rect: q.rect, floor: q.floor })),
        ...p.glyphs
          .filter((g) => positive(g) && !seen.has(g))
          .map((g) => ({ rect: g.ink, floor: 0 }))
      ]
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      tables.some((t) => hit(t, padded)) ||
      captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
      foreignPaints.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale)))
    )
      return
    if (
      records.some(
        (r) =>
          tokens.filter((t) => t.sourceItem?.index === r.index && t.sourceItem?.text === r.r.str)
            .length !== 1
      )
    )
      return
    const sourceItems = records.map((r) => r.r.sourceItem)
    if (new Set(sourceItems.map((s) => s.index)).size !== records.length) return
    return {
      rect,
      sourceItems,
      formCropRaster: {
        ownedRects: [
          ...images.map((im) => im.rect),
          ...records.map((r) => domains.get(r)),
          ...ownedPaths.map((q) => q.rect)
        ],
        foreignPaints,
        paintSeparations: groups.flatMap((g) =>
          images
            .filter((im) => im.operationIndex > g.im.operationIndex)
            .map((im) => ({ glyphInk: g.domain, laterPaintRect: im.rect }))
        )
      }
    }
  } catch {
    return undefined
  }
}
