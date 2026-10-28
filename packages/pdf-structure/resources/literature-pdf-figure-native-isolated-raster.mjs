/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  createNativeIsolatedRasterProfile,
  nativeFigureRecoveryProfileData,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeRecoveryFigureInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
const certificates = new WeakMap(),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  inside = (a, b) => valid(a) && valid(b) && b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i])),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  compact = (s) => s.replace(/\s/gu, '')
const binding = (c) =>
  JSON.stringify([c.rect, c.sourceItems, c.graphicsCount, c.formCropRaster, c.isolatedRasterRoot])
export function nativeIsolatedRasterFigureCrop(page, figure, captions, tables, tokens, context) {
  try {
    if (
      !valid(figure?.rect) ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      !Array.isArray(captions) ||
      !Array.isArray(tables)
    )
      return
    const profile = createNativeIsolatedRasterProfile(page, tokens, context),
      data = nativeFigureRecoveryProfileData(profile, page, tokens, context),
      scope = data?.rasterScope
    if (!scope || !hit(figure.rect, scope.rect) || scope.rect[3] >= figure.caption.rect[1]) return
    const p = nativeRecoveryFigureInkPacket(page, tokens, context, [], profile)
    if (
      !p ||
      p.records.length > 4096 ||
      p.evidence.paths.size > 4096 ||
      p.evidence.images.length !== scope.images.length
    )
      return
    const belongs = (i) => i > scope.begin && i < scope.end
    if (
      p.glyphs.some((g) => belongs(g.i)) ||
      p.records.some((r) => r.part.some((z) => belongs(z.g.i)))
    )
      return
    const cap = p.records.filter((r) => inside(figure.caption.rect, r.rect)),
      number = /^(?:Figure|Fig\.?)\s+([1-9]\d*)[.:]/u.exec(figure.caption.lines?.[0] ?? '')?.[1]
    if (
      !number ||
      !cap.length ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(figure.caption.lines.join('')) ||
      cap[0].part[0].g.i <= scope.end ||
      captions.filter(
        (c) =>
          c.page === page.pageNumber &&
          new RegExp('^(?:Figure|Fig\\.?)\\s+' + number + '[.:]', 'u').test(c.lines?.[0] ?? '')
      ).length !== 1
    )
      return
    for (const [index, im] of p.evidence.images.entries()) {
      const row = scope.images[index].identity,
        a = p.o.argsArray[im.operationIndex]
      if (
        !belongs(im.operationIndex) ||
        im.operationIndex !== row.operationIndex ||
        a?.[0] !== row.imageId ||
        a[1] !== row.width ||
        a[2] !== row.height ||
        !inside(scope.clip, im.rect) ||
        JSON.stringify(im.rect) !== JSON.stringify(row.rect)
      )
        return
    }
    const capGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g))),
      foreign = [],
      laneForeign = [],
      ownedPaints = []
    for (const [i, s] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      if (belongs(i)) {
        if (
          !inside(scope.clip, s.clip) ||
          ![s.fillAlpha, s.strokeAlpha].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
        )
          return
        ownedPaints.push(i)
      } else {
        const paint = nativeFigurePathPaint(p, i, s)
        if (!paint) return
        foreign.push(paint)
        laneForeign.push(paint)
      }
    }
    for (const record of p.records) {
      const style = context.content.styles[record.r.fontName]
      if (
        style?.vertical === false &&
        style.ascent === 0 &&
        style.descent === 0 &&
        record.advanceComplete
      ) {
        const rect = union([record.rect, ...record.part.flatMap((z) => [z.g.ink, z.g.advance])])
        if (!valid(rect)) return
        foreign.push({ rect, floor: 0 })
        if (!cap.includes(record)) laneForeign.push({ rect, floor: 0 })
        continue
      }
      if (
        !Number.isFinite(style?.ascent) ||
        style.ascent <= 0 ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2
      )
        return
      const font = nativeFigureLabelBounds(record.r, style, p.v)
      if (!font) return
      const rect = union([record.rect, font, ...record.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (!valid(rect)) return
      foreign.push({ rect, floor: 0 })
      if (!cap.includes(record)) laneForeign.push({ rect, floor: 0 })
    }
    foreign.push(
      ...p.glyphs
        .filter((g) => !g.rendererSkipped && valid(g.ink))
        .map((g) => ({ rect: g.ink, floor: 0 }))
    )
    laneForeign.push(
      ...p.glyphs
        .filter((g) => !capGlyphs.has(g) && !g.rendererSkipped && valid(g.ink))
        .map((g) => ({ rect: g.ink, floor: 0 }))
    )
    const rect = [...scope.rect],
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      lane = [
        Math.min(figure.rect[0], rect[0], figure.caption.rect[0]),
        rect[3],
        Math.max(figure.rect[2], rect[2], figure.caption.rect[2]),
        figure.caption.rect[1]
      ]
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      laneForeign.some((q) => hit(lane, expand(q.rect, (q.floor + 2) / scale))) ||
      captions.some(
        (c) => c !== figure.caption && c.page === page.pageNumber && hit(c.rect, lane)
      ) ||
      tables.some((t) => hit(t, lane)) ||
      foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
      captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
      tables.some((t) => hit(t, padded))
    )
      return
    if (inside(figure.rect, rect) && !foreign.some((q) => hit(figure.rect, q.rect))) return
    const output = {
        rect,
        sourceItems: [],
        graphicsCount: p.evidence.images.length + ownedPaints.length,
        formCropRaster: { ownedRects: [rect], foreignPaints: foreign },
        isolatedRasterRoot: true
      },
      unchanged = retainNativeRecoveryInputs([figure, captions, tables, output])
    if (!unchanged) return
    certificates.set(output.formCropRaster, {
      page,
      tokens,
      context,
      profile,
      unchanged,
      binding: binding(output),
      padded
    })
    return output
  } catch {
    return
  }
}
export function nativeIsolatedRasterFigurePngSafe(png, rect, page, candidate) {
  try {
    const proof = certificates.get(candidate?.formCropRaster)
    if (!proof) return candidate?.isolatedRasterRoot ? false : undefined
    if (
      page !== proof.page ||
      !proof.unchanged() ||
      binding(candidate) !== proof.binding ||
      JSON.stringify(rect) !== JSON.stringify(proof.padded) ||
      !nativeFigureRecoveryProfileData(proof.profile, page, proof.tokens, proof.context)
    )
      return false
    return (
      !!getPdfCropRasterProtectionFromPng(png, rect, page) &&
      nativeCompleteFormCropPngSafe(png, rect, page, candidate)
    )
  } catch {
    return false
  }
}
