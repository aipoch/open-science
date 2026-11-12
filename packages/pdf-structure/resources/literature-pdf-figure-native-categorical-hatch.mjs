/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  createNativeIdentityHatchPixelEvidence,
  nativeIdentityHatchPixelEvidenceData,
  createNativeIdentityHatchGridPixelEvidence,
  nativeIdentityHatchGridPixelEvidenceData
} from './literature-pdf-figure-native-plot-labels.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { nativeSixPanelHatchProfile } from './literature-pdf-figure-native-six-panel-hatch.mjs'

const plans = new WeakMap(),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  finite = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) &&
    a.length === n &&
    Array.from(a).every(Number.isFinite),
  inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-6 : v <= a[n] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, d) => r.map((v, n) => v + (n < 2 ? -d : d)),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
  captionKey = (c) => JSON.stringify([c?.page, c?.lines, c?.rect]),
  box = (r, m) =>
    union(
      [
        [r[0], r[1]],
        [r[0], r[3]],
        [r[2], r[1]],
        [r[2], r[3]]
      ].map((p) => {
        Util.applyTransform(p, m)
        return [p[0], p[1], p[0], p[1]]
      })
    )

function boundedPaths(data, context) {
  const inv = {
      o: context.operators,
      v: context.viewport,
      finite,
      valid,
      box,
      strokeMargins: new Map(data.paths.map((p) => [p.operationIndex, p.strokeMargin]))
    },
    output = []
  for (const p of data.paths) {
    const a = inv.o.argsArray[p.operationIndex],
      s = p.state,
      points = []
    if (!valid(s.clip) || s.fillAlpha !== 1 || s.strokeAlpha !== 1) return
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) continue
    const paint = nativeFigurePathPaint(inv, p.operationIndex, s)
    if (!paint || !Array.isArray(a[1])) return
    for (const path of a[1]) {
      if (path === null) continue
      let i = 0
      while (i < path.length) {
        const op = path[i++],
          n = op === 0 || op === 1 ? 1 : op === 2 ? 3 : op === 4 ? 0 : -1
        if (n < 0) return
        for (let k = 0; k < n; k++) {
          const x = path[i++],
            y = path[i++]
          if (!Number.isFinite(x) || !Number.isFinite(y)) return
          points.push([x, y, x, y])
        }
      }
    }
    if (!points.length) return
    const stroke = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      pad = stroke ? (s.lineWidth * Math.max(Math.SQRT2, p.strokeMargin)) / 2 : 0
    const hull = box(
      expand(union(points), pad),
      Util.transform(context.viewport.transform, s.transform)
    )
    output.push({
      operationIndex: p.operationIndex,
      rect: union([paint.rect, hull]),
      floor: paint.floor
    })
  }
  return output
}

// Complete independent native save membership owns the labels, not their
// distance from a guessed category gutter. Every other program stays foreign.
export function nativeCategoricalHatchPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  originalCrop = figure?.rect
) {
  return savedIdentityHatchPixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers,
    originalCrop,
    false
  )
}
export function nativeSixPanelHatchPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  originalCrop = figure?.rect
) {
  return savedIdentityHatchPixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers,
    originalCrop,
    true
  )
}
function savedIdentityHatchPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers,
  originalCrop,
  sixPanels
) {
  try {
    const caption = figure?.caption,
      keep = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, peers, originalCrop],
        context?.viewport
      )
    if (
      !keep ||
      !valid(originalCrop) ||
      !valid(figure?.rect) ||
      !valid(caption?.rect) ||
      caption.page !== page.pageNumber ||
      page.rotation !== 0 ||
      (page.renderRotation ?? page.rotation) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      !tables.every(valid) ||
      captions.filter((c) => captionKey(c) === captionKey(caption)).length !== 1 ||
      peers.filter(
        (f) =>
          captionKey(f.caption) === captionKey(caption) &&
          JSON.stringify(f.rect) === JSON.stringify(figure.rect)
      ).length !== 1
    )
      return
    if (!/^(?:Figure|Fig\.?)\s+[A-Z]?[1-9]\d*[.:]/u.test(caption.lines?.[0] ?? '')) return
    if (
      JSON.stringify(context.viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const create = sixPanels
        ? createNativeIdentityHatchGridPixelEvidence
        : createNativeIdentityHatchPixelEvidence,
      dataFor = sixPanels
        ? nativeIdentityHatchGridPixelEvidenceData
        : nativeIdentityHatchPixelEvidenceData,
      handle = create(page, tokens, context),
      data = dataFor(handle, page, tokens, context)
    if (!data) return
    const member = (s, i) => i > s.begin && i < s.end,
      roots = data.scopes.filter(
        (s) =>
          data.patterns.some((i) => member(s, i)) &&
          !data.scopes.some((t) => t.begin < s.begin && t.end > s.end)
      ),
      paths = boundedPaths(data, context),
      results = []
    if (!paths || !roots.length || roots.length > (sixPanels ? 1 : 2)) return
    const cap = data.records.filter((r) => r.raw.str.trim() && inside(caption.rect, r.rect))
    if (
      !cap.length ||
      compact(cap.map((r) => r.raw.str).join('')) !== compact(caption.lines.join('')) ||
      cap.some((r) => !r.glyphIndices.length)
    )
      return
    const capStart = Math.min(
      ...cap.flatMap((r) => r.glyphIndices.map((i) => data.glyphs[i].operationIndex))
    )
    for (const root of roots) {
      if (
        data.patterns.filter((i) => member(root, i)).length !== (sixPanels ? 13 : 3) ||
        root.end >= capStart ||
        data.records.some(
          (r) =>
            r.raw.str.trim() &&
            r.glyphIndices.some(
              (i) =>
                data.glyphs[i].operationIndex > root.end && data.glyphs[i].operationIndex < capStart
            )
        )
      )
        continue
      const ownedRecords = data.records.filter((r) =>
          r.glyphIndices.some((i) => member(root, data.glyphs[i].operationIndex))
        ),
        ownGlyphs = data.glyphs.filter((g) => member(root, g.operationIndex)),
        ownPaths = paths.filter((p) => member(root, p.operationIndex))
      if (
        ownedRecords.length < 3 ||
        ownedRecords.length > 256 ||
        !ownGlyphs.length ||
        ownPaths.length < 3 ||
        data.records.some(
          (r) =>
            r.glyphIndices.some((i) => member(root, data.glyphs[i].operationIndex)) &&
            r.glyphIndices.some((i) => !member(root, data.glyphs[i].operationIndex))
        ) ||
        ownedRecords.some(
          (r) =>
            !r.glyphIndices.length ||
            union(r.glyphIndices.map((i) => data.glyphs[i].advance)).some(
              (v, n) => Math.abs(v - r.rect[n]) > 0.02
            )
        )
      )
        continue
      if (sixPanels && !nativeSixPanelHatchProfile(data, context, root, ownedRecords, caption))
        continue
      const minScale = 1.5,
        owned = [
          ...ownPaths,
          ...ownGlyphs.flatMap((g) => [
            { rect: g.rect, floor: 0 },
            { rect: g.advance, floor: 0 }
          ]),
          ...ownedRecords.map((r) => ({ rect: r.rect, floor: 0 }))
        ],
        ownedBounds = owned.map((p) => expand(p.rect, (p.floor + 1) / minScale)),
        rect = union([originalCrop, expand(union(ownedBounds), 2 / minScale)]),
        foreign = [
          ...paths
            .filter((p) => !member(root, p.operationIndex))
            .map((p) => expand(p.rect, (p.floor + 1) / minScale)),
          ...data.glyphs
            .filter((g) => !member(root, g.operationIndex))
            .flatMap((g) => [expand(g.rect, 1 / minScale), expand(g.advance, 1 / minScale)]),
          ...data.records
            .filter((r) => r.raw.str.trim() && !ownedRecords.includes(r))
            .map((r) => expand(r.rect, 1 / minScale))
        ]
      if (
        !valid(rect) ||
        !inside([0, 0, page.width, page.height], rect) ||
        tables.some((t) => hit(rect, t)) ||
        captions.some((c) => c.page === page.pageNumber && hit(rect, c.rect)) ||
        foreign.some((r) => hit(rect, expand(r, 2 / minScale))) ||
        rect.every((v, n) => Math.abs(v - originalCrop[n]) < 1e-6)
      )
        continue
      results.push({ rect, minScale, ownedBounds, foreign })
    }
    if (results.length !== 1) return
    const r = results[0],
      plan = {
        rect: r.rect,
        kind: sixPanels
          ? 'complete-native-six-panel-hatch-pixel'
          : 'complete-native-identity-hatch-pixel'
      },
      form = {
        ownedRects: r.ownedBounds,
        foreignPaints: r.foreign.map((rect) => ({ rect, floor: 0 }))
      },
      outputCurrent = retainNativeRecoveryInputs([plan, form])
    if (!outputCurrent || !keep() || dataFor(handle, page, tokens, context) !== data) return
    plans.set(plan, {
      page,
      tokens,
      context,
      handle,
      data,
      dataFor,
      sixPanels,
      keep,
      outputCurrent,
      form,
      minScale: r.minScale,
      rect: r.rect
    })
    return plan
  } catch {
    return
  }
}

export function nativeCategoricalHatchPixelPngSafe(plan, png, rect, page) {
  return savedIdentityHatchPixelPngSafe(plan, png, rect, page, false)
}
export function nativeSixPanelHatchPixelPngSafe(plan, png, rect, page) {
  return savedIdentityHatchPixelPngSafe(plan, png, rect, page, true)
}
function savedIdentityHatchPixelPngSafe(plan, png, rect, page, sixPanels) {
  try {
    const p = plans.get(plan),
      r = getPdfCropRasterProtectionFromPng(png, rect, page)
    return !!(
      p &&
      p.sixPanels === sixPanels &&
      p.page === page &&
      p.rect === rect &&
      p.keep() &&
      p.outputCurrent() &&
      r &&
      r.scaleLower >= p.minScale &&
      p.dataFor(p.handle, page, p.tokens, p.context) === p.data &&
      nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: p.form })
    )
  } catch {
    return false
  }
}
