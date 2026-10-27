/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { types } from 'node:util'
function ownViewport(c) {
  if (!c || types.isProxy(c)) return
  const d = Object.getOwnPropertyDescriptor(c, 'viewport')
  return d && 'value' in d ? d.value : undefined
}
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  createNativeCompositingProfile,
  nativeCompositingProfileData,
  retainNativeCompositingInputs
} from './literature-pdf-native-compositing-profile.mjs'
import { nativeCompositingInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
const certificates = new WeakMap(),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i])),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  compact = (s) => s.replace(/\s/gu, '')
export function nativeCompositingFigureCrop(page, figure, captions, tables, tokens, context) {
  try {
    if (!context || types.isProxy(context)) return
    const resource = Object.getOwnPropertyDescriptor(context, 'compositingImages')
    if (!resource || !Object.hasOwn(resource, 'value') || !Array.isArray(resource.value)) return
    const unchanged = retainNativeCompositingInputs(
      [page, figure, captions, tables, tokens, context],
      ownViewport(context)
    )
    if (
      !unchanged ||
      figure.sourceItems?.length ||
      figure.fallbackFigure ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      !valid(figure.rect) ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      !Array.isArray(figure.caption.lines) ||
      !['native-raster-vector-strip', undefined].includes(figure.reason ?? figure.issue)
    )
      return
    const handle = createNativeCompositingProfile(page, tokens, context, context.compositingImages),
      scope = nativeCompositingProfileData(handle, page, tokens, context),
      result = scope && nativeCompositingInkPacket(page, tokens, context, handle)
    if (!result) return
    const p = result.packet
    if (p.evidence.images.length) return
    const cap = p.records.filter((r) => inside(figure.caption.rect, r.rect))
    if (
      !cap.length ||
      !/^Figure\s+\d+:/u.test(cap[0].r.str) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(figure.caption.lines.join('')) ||
      !/[.!?]$/u.test(cap.at(-1).r.str) ||
      cap.some((r) => !r.advanceComplete)
    )
      return
    const captionFirst = Math.min(...cap.flatMap((r) => r.part.map((z) => z.g.i))),
      stack = [],
      pairs = []
    for (let i = scope.end + 1; i < captionFirst; i++) {
      const op = p.o.fnArray[i]
      if (op === OPS.save) stack.push(i)
      if (op === OPS.restore) {
        const begin = stack.pop()
        if (begin !== undefined) pairs.push({ begin, end: i })
      }
    }
    const choices = pairs.filter((s) =>
        p.records.some((r) => r.part.some((z) => z.g.i > s.begin && z.g.i < s.end))
      ),
      outer = choices.filter((s) => !choices.some((t) => t.begin < s.begin && t.end > s.end))
    if (outer.length !== 1) return
    const body = outer[0],
      belongs = (i) => i > body.begin && i < body.end,
      owners = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
    if (
      !owners.length ||
      owners.length > 64 ||
      owners.some(
        (r) =>
          !valid(r.rect) ||
          !r.advanceComplete ||
          !r.part.every(
            (z) =>
              belongs(z.g.i) &&
              !z.g.rendererSkipped &&
              z.g.textPaint?.fillAlpha === 1 &&
              /^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) &&
              z.g.textPaint.fillColor.toLowerCase() !== '#ffffff'
          )
      )
    )
      return
    const ownedGlyphs = new Set(owners.flatMap((r) => r.part.map((z) => z.g))),
      seen = new Set()
    for (const r of p.records)
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (seen.has(g)) return
        seen.add(g)
      }
    if (p.glyphs.some((g) => belongs(g.i) && !ownedGlyphs.has(g))) return
    const bounds = new Map()
    for (const r of p.records) {
      const style = context.content.styles[r.r.fontName],
        font = nativeFigureLabelBounds(r.r, style, p.v),
        zero =
          !owners.includes(r) &&
          r.r.width === 0 &&
          r.advanceComplete &&
          r.rect[0] === r.rect[2] &&
          r.part.every((z) => z.g.advance[0] === z.g.advance[2]) &&
          Number.isFinite(style?.ascent) &&
          style.ascent > 0 &&
          style.ascent <= 2 &&
          Number.isFinite(style.descent) &&
          style.descent <= 0 &&
          style.descent >= -2
            ? [
                r.rect[0],
                r.rect[3] - style.ascent * r.r.height,
                r.rect[2],
                r.rect[3] - style.descent * r.r.height
              ]
            : undefined
      if (!font && !zero) return
      const rect = union([r.rect, font ?? zero, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (!valid(rect)) return
      bounds.set(r, rect)
    }
    const capGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g))),
      paths = [],
      foreign = [],
      laneForeign = []
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      if (belongs(i)) paths.push({ i, ...paint })
      else {
        foreign.push(paint)
        laneForeign.push(paint)
      }
    }
    foreign.push(
      ...p.records
        .filter((r) => !owners.includes(r))
        .map((r) => ({ rect: bounds.get(r), floor: 0 })),
      ...p.glyphs
        .filter((g) => !ownedGlyphs.has(g) && !g.rendererSkipped)
        .map((g) => ({ rect: g.ink, floor: 0 }))
    )
    laneForeign.push(
      ...p.records
        .filter((r) => !owners.includes(r) && !cap.includes(r))
        .map((r) => ({ rect: bounds.get(r), floor: 0 })),
      ...p.glyphs
        .filter((g) => !ownedGlyphs.has(g) && !capGlyphs.has(g) && !g.rendererSkipped)
        .map((g) => ({ rect: g.ink, floor: 0 }))
    )
    const rect = union([
        scope.rect,
        ...paths.map((p) => p.rect),
        ...owners.map((r) => bounds.get(r))
      ]),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      lane = [
        Math.min(figure.rect[0], rect[0], figure.caption.rect[0]),
        rect[3],
        Math.max(figure.rect[2], rect[2], figure.caption.rect[2]),
        figure.caption.rect[1]
      ]
    if (
      !hit(figure.rect, scope.rect) ||
      !hit(figure.rect, rect) ||
      rect[3] >= figure.caption.rect[1] ||
      !inside([0, 0, page.width, page.height], padded) ||
      laneForeign.some((q) => hit(lane, expand(q.rect, (q.floor + 2) / scale))) ||
      captions.some(
        (c) => c !== figure.caption && c.page === page.pageNumber && hit(c.rect, lane)
      ) ||
      tables.some((t) => hit(t, lane)) ||
      foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
      captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
      tables.some((t) => hit(t, padded)) ||
      (!foreign.some((q) => hit(q.rect, figure.rect)) && inside(figure.rect, rect))
    )
      return
    const compositeOps = p.o.fnArray.flatMap((op, i) =>
        i >= scope.begin &&
        i <= scope.end &&
        (op === OPS.paintImageXObject ||
          (op === OPS.constructPath &&
            ![OPS.endPath, OPS.clip, OPS.eoClip].includes(p.o.argsArray[i]?.[0])))
          ? [i]
          : []
      ),
      out = {
        rect,
        sourceItems: owners.map((r) => r.r.sourceItem).sort((a, b) => a.index - b.index),
        graphicsCount: compositeOps.length + paths.length,
        formCropRaster: {
          ownedRects: [
            scope.rect,
            ...paths.map((p) => p.rect),
            ...owners.map((r) => bounds.get(r))
          ],
          foreignPaints: foreign
        },
        recoveryProgramRaster: true,
        compositingProgramRaster: true,
        fallbackFigure: figure
      }
    const outputUnchanged = retainNativeRecoveryInputs([
      out.rect,
      out.sourceItems,
      out.formCropRaster
    ])
    if (!outputUnchanged) return
    certificates.set(out.formCropRaster, {
      page,
      tokens,
      context,
      figure,
      handle,
      unchanged,
      outputUnchanged,
      out,
      rect,
      sourceItems: out.sourceItems,
      binding: JSON.stringify([out.rect, out.sourceItems, out.graphicsCount, out.formCropRaster])
    })
    return out
  } catch {
    return
  }
}
export function nativeCompositingFigurePngSafe(png, rect, page, candidate) {
  const values = nativeRecoveryOwnValues(candidate)
  if (!values) return false
  const proof = certificates.get(values.formCropRaster)
  if (!proof) return values.compositingProgramRaster ? false : undefined
  try {
    return (
      values.compositingProgramRaster === true &&
      values.recoveryProgramRaster === true &&
      !values.parts &&
      !values.cropRects &&
      !values.headerRaster &&
      page === proof.page &&
      values.fallbackFigure === proof.figure &&
      values.rect === proof.rect &&
      values.sourceItems === proof.sourceItems &&
      (!Object.hasOwn(values, 'caption') || values.caption === proof.figure.caption) &&
      proof.unchanged() &&
      proof.outputUnchanged() &&
      JSON.stringify([
        values.rect,
        values.sourceItems,
        values.graphicsCount,
        values.formCropRaster
      ]) === proof.binding &&
      !!nativeCompositingProfileData(proof.handle, page, proof.tokens, proof.context) &&
      nativeCompleteFormCropPngSafe(png, rect, page, values)
    )
  } catch {
    return false
  }
}
