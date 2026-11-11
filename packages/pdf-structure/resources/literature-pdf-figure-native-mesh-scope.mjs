/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  createNativeMesh4PixelCertificate,
  nativeMesh4PixelCertificateData
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeMesh4RenderContextData } from './literature-pdf-render-bounds.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const plans = new WeakMap(),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7)),
  expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, '')

function bounds(piece, scale) {
  if (!valid(piece.rect) || !Number.isFinite(piece.floor) || piece.floor < 0) return
  const r = expand(piece.rect, (piece.floor + 1) / scale),
    c = piece.paintClip
  if (c && !valid(c)) return
  const out = c
    ? [Math.max(r[0], c[0]), Math.max(r[1], c[1]), Math.min(r[2], c[2]), Math.min(r[3], c[3])]
    : r
  return valid(out) ? out : undefined
}

// One native closed outer Form owns every mesh and every other drawing paint.
// A Form box alone never supplies this role: the full page glyph/path inventory
// must close, match the numbered caption, and exclude all foreign page paint.
export function nativeMesh4PixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers,
  originalRect
) {
  try {
    const mesh = nativeMesh4RenderContextData(context)
    if (!mesh) return
    const current = retainNativeRecoveryInputs(
      [page, figure, captions, tables, tokens, context, peers, originalRect],
      context?.viewport
    )
    if (
      !current ||
      !valid(figure?.rect) ||
      !valid(originalRect) ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      !Array.isArray(captions) ||
      captions.filter((c) => c === figure.caption).length !== 1 ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      !Array.isArray(peers) ||
      figure.parts ||
      figure.cropRects ||
      figure.sourceItems?.length ||
      figure.fallbackFigure ||
      figure.headerRaster ||
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/u.test(figure.caption.lines?.[0] ?? '') ||
      !/[.!?]$/u.test(figure.caption.lines?.at(-1) ?? '') ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const handle = createNativeMesh4PixelCertificate(page, tokens, context),
      data = nativeMesh4PixelCertificateData(handle, page, tokens, context)
    if (
      !data ||
      data.pieces.some((p) => !valid(p.rect) || !Number.isFinite(p.floor) || p.floor < 0)
    )
      return
    const forms = data.scopes.filter((s) => s.op === OPS.paintFormXObjectBegin),
      roots = forms.filter((s) => !forms.some((p) => p.begin < s.begin && p.end > s.end))
    if (roots.length !== 1) return
    const root = roots[0],
      belongs = (p) => p.operationIndex > root.begin && p.operationIndex < root.end,
      owned = data.pieces.filter(belongs),
      foreign = data.pieces.filter((p) => !belongs(p)),
      minScale = 1.5
    if (
      !owned.some((p) => p.kind === 'glyph') ||
      !owned.some((p) => p.kind === 'path') ||
      owned.some((p) => !p.paintClip) ||
      mesh.states.some((s) => s.operationIndex <= root.begin || s.fillOperationIndex >= root.end) ||
      data.pieces.some((p) => p.kind !== 'glyph' && p.kind !== 'path')
    )
      return
    const ownedBounds = owned.map((p) => bounds(p, minScale)).filter(Boolean)
    if (!ownedBounds.length) return
    const rect = expand(union(ownedBounds), 2 / minScale),
      cap = figure.caption,
      capSources = context.content.items.filter(
        (r) =>
          typeof r.str === 'string' &&
          r.str.trim() &&
          inside(cap.rect, tableTextToken(r, context.viewport, 0).rect)
      ),
      capGlyphs = foreign.filter((p) => p.kind === 'glyph' && inside(cap.rect, p.advance))
    if (
      !capSources.length ||
      !capGlyphs.length ||
      compact(capSources.map((r) => r.str).join('')) !== compact(cap.lines.join('')) ||
      compact(capGlyphs.map((p) => p.text).join('')) !== compact(cap.lines.join('')) ||
      capGlyphs.some((p) => p.operationIndex <= root.end) ||
      !inside([0, 0, page.width, page.height], rect) ||
      rect[3] >= cap.rect[1] ||
      !hit(rect, originalRect) ||
      tables.some((r) => hit(rect, r)) ||
      captions.some((c) => c !== cap && c.page === page.pageNumber && hit(rect, c.rect)) ||
      peers.some((f) => f !== figure && hit(rect, f.rect)) ||
      foreign.some((p) => {
        const b = bounds(p, minScale)
        return b && hit(rect, expand(b, 2 / minScale))
      })
    )
      return
    const plan = Object.freeze({ rect }),
      outputCurrent = retainNativeRecoveryInputs([plan])
    if (!outputCurrent || !current()) return
    plans.set(plan, {
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalRect,
      current,
      outputCurrent,
      handle,
      data,
      owned,
      foreign,
      minScale
    })
    return plan
  } catch {
    return
  }
}

// Undefined means a different pixel family owns the plan. A stale mesh plan
// returns false, so it cannot fall through to another family's validation.
export function nativeMesh4PixelPngSafe(plan, png, rect, page) {
  const p = plans.get(plan)
  if (!p) return
  try {
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (
      p.page !== page ||
      rect !== plan.rect ||
      !p.current() ||
      !p.outputCurrent() ||
      nativeMesh4PixelCertificateData(p.handle, page, p.tokens, p.context) !== p.data ||
      !raster ||
      raster.scaleLower < p.minScale
    )
      return false
    const scale = raster.scaleLower
    return (
      p.owned.every((piece) => {
        const b = bounds(piece, scale)
        return !b || inside(rect, expand(b, 1 / scale))
      }) &&
      p.foreign.every((piece) => {
        const b = bounds(piece, scale)
        return !b || !hit(raster.protection, expand(b, 2 / scale))
      })
    )
  } catch {
    return false
  }
}
