/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativeCompositingFigureCrop,
  nativeCompositingFigurePngSafe
} from './literature-pdf-figure-native-compositing-scope.mjs'
import {
  createNativeFigureRecoveryProfile,
  nativeFigureRecoveryProfileData,
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeRecoveryFigureInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import {
  nativeClosedProgramFigureCrop,
  nativeClosedProgramPngSafe
} from './literature-pdf-figure-native-closed-program.mjs'
import {
  nativeIsolatedFormFigureCrop,
  nativeIsolatedFormPngSafe
} from './literature-pdf-figure-native-isolated-form.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const certificates = new WeakMap(),
  inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  positive = (g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3],
  compact = (s) => s.replace(/\s/gu, '')
const outputBinding = (candidate) =>
  JSON.stringify([
    candidate.rect,
    candidate.sourceItems,
    candidate.graphicsCount,
    candidate.formCropRaster,
    candidate.recoveryProgramRaster
  ])

function wholeNestedScope(page, figure, captions, tables, tokens, context, profile, data) {
  const anchor = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem,
    p = anchor && nativeRecoveryFigureInkPacket(page, tokens, context, [], profile)
  if (
    !p ||
    p.records.length > 4096 ||
    p.evidence.paths.size > 4096 ||
    p.evidence.images.length > 64
  )
    return
  const roots = data.nested.filter((g) => g.depth === 0)
  if (roots.length !== 1) return
  const root = p.evidence.isolatedGroups.get(roots[0].begin)
  if (
    !root ||
    !p.valid(root.rect) ||
    !p.valid(root.clip) ||
    !inside(root.clip, root.rect) ||
    !p.valid(figure.rect) ||
    !p.valid(figure.caption.rect) ||
    figure.caption.page !== page.pageNumber ||
    !hit(figure.rect, root.rect) ||
    root.rect[3] >= figure.caption.rect[1]
  )
    return
  const belongs = (i) => i > root.begin && i < root.end,
    owned = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
  if (
    owned.length > 64 ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !r.part.every(
          ({ g }) =>
            belongs(g.i) &&
            inside(root.clip, g.ink) &&
            g.textPaint.fillAlpha === 1 &&
            /^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) &&
            g.textPaint.fillColor.toLowerCase() !== '#ffffff'
        )
    )
  )
    return
  const ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
    membership = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (membership.has(g)) return
      membership.set(g, r)
    }
  if (p.glyphs.some((g) => belongs(g.i) && positive(g) && !ownGlyphs.has(g))) return
  const full = (r) => {
      const s = context.content.styles[r.r.fontName]
      // A complete foreign punctuation font can have no ascender. Preserve its
      // actual glyph ink and whole advance; this never supplies an owned metric.
      if (
        s?.vertical === false &&
        s.ascent === 0 &&
        Number.isFinite(s.descent) &&
        s.descent <= 0 &&
        s.descent >= -2 &&
        !owned.includes(r) &&
        r.advanceComplete
      )
        return union([r.rect, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (
        !Number.isFinite(s?.ascent) ||
        s.ascent <= 0 ||
        s.ascent > 2 ||
        !Number.isFinite(s.descent) ||
        s.descent > 0 ||
        s.descent < -2
      )
        return
      const font = nativeFigureLabelBounds(r.r, s, p.v)
      return font && union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
    },
    domains = new Map(p.records.map((r) => [r, full(r)]))
  if ([...domains.values()].some((r) => !p.valid(r))) return
  const cap = p.records.filter((r) => inside(figure.caption.rect, r.rect))
  if (
    !cap.length ||
    !/^Figure\s+\d+:/u.test(cap[0].r.str) ||
    compact(cap.map((r) => r.r.str).join('')) !== compact(figure.caption.lines.join('')) ||
    !/[.!?]$/u.test(cap.at(-1).r.str) ||
    cap[0].part[0].g.i <= root.end ||
    cap.some((r) => owned.includes(r))
  )
    return
  const images = p.evidence.images.filter((im) => belongs(im.operationIndex)),
    capGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g))),
    foreign = [],
    laneForeign = [],
    paints = []
  if (
    (!owned.length && !images.length) ||
    p.evidence.images.some((im) => !belongs(im.operationIndex))
  )
    return
  for (const im of images) {
    const actual = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
      ),
      a = p.o.argsArray[im.operationIndex]
    if (
      !inside(root.clip, im.rect) ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '') ||
      a?.length !== 3 ||
      !Number.isSafeInteger(a[1]) ||
      !Number.isSafeInteger(a[2]) ||
      a[1] <= 0 ||
      a[2] <= 0
    )
      return
  }
  for (const [i, state] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) continue
    if (belongs(i)) {
      if (
        !p.valid(state.clip) ||
        !inside(root.clip, state.clip) ||
        ![state.fillAlpha, state.strokeAlpha].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      )
        return
      paints.push(i)
    } else {
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreign.push(paint)
      laneForeign.push(paint)
    }
  }
  foreign.push(
    ...p.records.filter((r) => !owned.includes(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  laneForeign.push(
    ...p.records
      .filter((r) => !owned.includes(r) && !cap.includes(r))
      .map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g) && !capGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  const rect = union([root.rect, ...owned.map((r) => domains.get(r))]),
    scale = Math.ceil(page.width * 1.5) / page.width,
    padded = expand(rect, 2 / scale),
    lane = [
      Math.min(figure.rect[0], rect[0], figure.caption.rect[0]),
      rect[3],
      Math.max(figure.rect[2], rect[2], figure.caption.rect[2]),
      figure.caption.rect[1]
    ]
  if (
    rect[3] >= figure.caption.rect[1] ||
    !inside([0, 0, page.width, page.height], padded) ||
    laneForeign.some((q) => hit(lane, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((c) => c !== figure.caption && c.page === page.pageNumber && hit(c.rect, lane)) ||
    tables.some((t) => hit(t, lane)) ||
    foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
    tables.some((t) => hit(t, padded))
  )
    return
  if (
    !images.some((im) => !inside(figure.rect, im.rect)) &&
    ![...ownGlyphs].some((g) => positive(g) && !inside(figure.rect, g.ink)) &&
    !foreign.some((q) => hit(figure.rect, q.rect))
  )
    return
  const sourceItems = owned.map((r) => r.r.sourceItem).sort((a, b) => a.index - b.index)
  if (
    sourceItems.length &&
    !nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile)
  )
    return
  return {
    rect,
    sourceItems,
    graphicsCount: images.length + paints.length,
    formCropRaster: {
      ownedRects: [root.rect, ...owned.map((r) => domains.get(r))],
      foreignPaints: foreign
    },
    clip: root.clip
  }
}

export function nativeRecoveryFigureCrop(page, figure, captions, tables, tokens, context) {
  const compositing = nativeCompositingFigureCrop(page, figure, captions, tables, tokens, context)
  if (compositing) return compositing
  try {
    if (
      !figure?.rect ||
      !figure.caption?.rect ||
      !Array.isArray(figure.caption.lines) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure
    )
      return
    const profile = createNativeFigureRecoveryProfile(page, tokens, context),
      data = nativeFigureRecoveryProfileData(profile, page, tokens, context)
    if (!data) return
    const result = data.nested
      ? wholeNestedScope(page, figure, captions, tables, tokens, context, profile, data)
      : (nativeClosedProgramFigureCrop(page, figure, captions, tables, tokens, context, profile) ??
        nativeIsolatedFormFigureCrop(page, figure, captions, tables, tokens, context, profile))
    if (!result) return
    const unchanged = retainNativeRecoveryInputs([figure, captions, tables])
    if (!unchanged) return
    const out = {
      rect: result.rect,
      sourceItems: result.sourceItems,
      graphicsCount: result.graphicsCount,
      formCropRaster: result.formCropRaster,
      ...(result.closedProgramRaster ? { closedProgramRaster: true } : {}),
      ...(result.isolatedFormRaster ? { isolatedFormRaster: true } : {}),
      recoveryProgramRaster: true,
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
      figure,
      tokens,
      context,
      profile,
      unchanged,
      outputUnchanged,
      rect: out.rect,
      sourceItems: out.sourceItems,
      binding: outputBinding(out),
      clip: result.clip,
      legacySafe: result.closedProgramRaster
        ? nativeClosedProgramPngSafe
        : result.isolatedFormRaster
          ? nativeIsolatedFormPngSafe
          : undefined
    })
    return out
  } catch {
    return
  }
}

export function nativeRecoveryFigurePngSafe(png, rect, page, candidate) {
  const compositing = nativeCompositingFigurePngSafe(png, rect, page, candidate)
  if (compositing !== undefined) return compositing
  const values = nativeRecoveryOwnValues(candidate)
  if (!values) return false
  const proof = certificates.get(values.formCropRaster)
  if (!proof) return values.recoveryProgramRaster ? false : undefined
  try {
    if (
      page !== proof.page ||
      values.fallbackFigure !== proof.figure ||
      values.rect !== proof.rect ||
      values.sourceItems !== proof.sourceItems ||
      (Object.hasOwn(values, 'caption') && values.caption !== proof.figure.caption) ||
      values.parts ||
      values.cropRects ||
      values.headerRaster ||
      !proof.outputUnchanged() ||
      !proof.unchanged() ||
      outputBinding(values) !== proof.binding ||
      !nativeFigureRecoveryProfileData(proof.profile, page, proof.tokens, proof.context)
    )
      return false
    if (proof.legacySafe) return proof.legacySafe(png, rect, page, values)
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!raster &&
      inside(rect, expand(proof.clip, 1 / raster.scaleLower)) &&
      nativeCompleteFormCropPngSafe(png, rect, page, values)
    )
  } catch {
    return false
  }
}
