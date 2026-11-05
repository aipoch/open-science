/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createHash } from 'node:crypto'
import {
  nativeClosedProgramInkPacket,
  nativeRecoveryFigureInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import {
  nativeFigureRecoveryProfileData,
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
const certificates = new WeakMap()
const pixelCertificates = new WeakMap()
const nativeCaptionPixelMode = Symbol('native-caption-pixel')
const nativePaintPixelMode = Symbol('native-paint-pixel')
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7))
const expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n))
const metrics = (s) =>
  Number.isFinite(s?.ascent) &&
  s.ascent > 0 &&
  s.ascent <= 2 &&
  Number.isFinite(s.descent) &&
  s.descent <= 0 &&
  s.descent >= -2
const zeroMetrics = (s) => s?.ascent === 0 && s?.descent === 0
const pageKey = (page) =>
  JSON.stringify([
    page.pageNumber,
    page.width,
    page.height,
    page.rotation,
    page.renderRotation ?? page.rotation,
    page.invalidGraphicsBounds
  ])
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
  valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
  clipPoly = (p, n, c) => {
    const q = []
    for (let i = 0; i < p.length; i++) {
      const a = p[i],
        b = p[(i + 1) % p.length],
        da = a[0] * n[0] + a[1] * n[1] - c,
        db = b[0] * n[0] + b[1] * n[1] - c
      if (da <= 0) q.push(a)
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db)
        q.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
      }
    }
    return q
  }
function clippedStraightLinePaint(inv, i, s, rasterScale = 4) {
  try {
    const a = inv.o.argsArray[i],
      d = a?.[1]?.[0],
      bbox = Array.from(a?.[2] ?? []),
      m = Util.transform(inv.v.transform, s.transform)
    if (
      a?.[0] !== OPS.stroke ||
      a.length !== 3 ||
      a[1].length !== 1 ||
      !ArrayBuffer.isView(d) ||
      d.length !== 6 ||
      d[0] !== 0 ||
      d[3] !== 1 ||
      !Array.from(d).every(Number.isFinite) ||
      !valid(bbox) ||
      !finite(m, 6) ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      m[0] <= 0 ||
      m[3] >= 0 ||
      m[0] !== -m[3] ||
      !valid(s.clip) ||
      s.lineCap !== 1 ||
      !s.solidStroke ||
      s.fillAlpha !== 1 ||
      s.strokeAlpha !== 1 ||
      !(s.lineWidth > 0) ||
      !(rasterScale >= 1 && rasterScale <= 4)
    )
      return
    const local = [
      Math.min(d[1], d[4]),
      Math.min(d[2], d[5]),
      Math.max(d[1], d[4]),
      Math.max(d[2], d[5])
    ]
    if (JSON.stringify(local) !== JSON.stringify(bbox)) return
    const point = (x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]],
      p = point(d[1], d[2]),
      q = point(d[4], d[5]),
      dx = q[0] - p[0],
      dy = q[1] - p[1],
      length = Math.hypot(dx, dy),
      t = [dx / length, dy / length],
      n = [-t[1], t[0]],
      // Five is the existing conservative miter-limit/device margin (10/2),
      // not a five-pixel renderer stroke. Charge it before applying the clip.
      radius = (s.lineWidth * m[0]) / 2 + 5 / rasterScale,
      corners = [
        [s.clip[0], s.clip[1]],
        [s.clip[2], s.clip[1]],
        [s.clip[2], s.clip[3]],
        [s.clip[0], s.clip[3]]
      ],
      projections = corners.map((z) => (z[0] - p[0]) * t[0] + (z[1] - p[1]) * t[1])
    if (
      !Number.isFinite(radius) ||
      radius <= 0 ||
      Math.min(...projections) <= radius ||
      Math.max(...projections) >= length - radius
    )
      return
    let poly = clipPoly(corners, n, p[0] * n[0] + p[1] * n[1] + radius)
    poly = clipPoly(poly, [-n[0], -n[1]], -(p[0] * n[0] + p[1] * n[1]) + radius)
    if (poly.length < 3) return
    const rect = [
      Math.min(...poly.map((z) => z[0])),
      Math.min(...poly.map((z) => z[1])),
      Math.max(...poly.map((z) => z[0])),
      Math.max(...poly.map((z) => z[1]))
    ]
    if (!valid(rect)) return
    return {
      rect,
      floor: 1,
      actualClip: s.clip,
      rasterScale,
      conservativeDeviceMargin: 5,
      strokeCapsProvenOutsideClip: true,
      straightLineEndpoints: [p, q],
      boundedStripPolygon: poly,
      outerAntialiasPixels: 1,
      physicalStrokeRadius: (s.lineWidth * m[0]) / 2,
      conservativeDeviceRadius: radius
    }
  } catch {
    return
  }
}

// Scope discovery grants no text ownership. A unique complete program is
// rebound through the explicit packet API before it can publish source items.
export function nativeClosedProgramFigureCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  recoveryProfile
) {
  try {
    if (
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/iu.test(figure.caption?.lines?.[0] ?? '') ||
      figure.caption.page !== page.pageNumber ||
      page.rotation !== 0 ||
      (page.renderRotation ?? page.rotation) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.caption.regions
    )
      return
    const v = context.viewport
    if (
      v.scale !== 1 ||
      v.rotation !== 0 ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const seed = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem,
      p =
        seed &&
        (recoveryProfile
          ? nativeRecoveryFigureInkPacket(page, tokens, context, [], recoveryProfile)
          : nativeClosedProgramInkPacket(page, tokens, context, [seed]))
    if (!p || p.evidence.images.length || p.records.length > 4096 || p.evidence.paths.size > 4096)
      return
    const full = (r) => {
      const s = context.content.styles[r.r.fontName]
      if (!metrics(s) && (!zeroMetrics(s) || !r.advanceComplete)) return
      const font = metrics(s) ? nativeFigureLabelBounds(r.r, s, v) : undefined
      return union([
        r.rect,
        ...(font ? [font] : []),
        ...r.part.flatMap((z) => [z.g.ink, z.g.advance])
      ])
    }
    if (p.records.some((r) => !full(r))) return
    const glyphs = p.glyphs.filter(
      (g) => !g.rendererSkipped && !(g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3])
    )
    if (
      glyphs.some(
        (g) =>
          !p.valid(g.ink) ||
          (!metrics(context.content.styles[g.fontName]) &&
            !zeroMetrics(context.content.styles[g.fontName]))
      )
    )
      return
    const membership = new Map(),
      shared = new Set()
    for (const r of p.records)
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (membership.has(g)) shared.add(g)
        else membership.set(g, r)
      }
    const scopes = [],
      stack = []
    let current = [1, 0, 0, 1, 0, 0]
    for (let i = 0; i < p.o.fnArray.length; i++) {
      const op = p.o.fnArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        const q = p.o.argsArray[i],
          scope = { start: i, op, parent: stack.at(-1), matrix: [...current] }
        if (op === OPS.paintFormXObjectBegin) {
          if (q[0]) current = Util.transform(current, q[0])
          if (p.valid(Array.from(q[1] ?? [])))
            scope.rect = p.box(Array.from(q[1]), Util.transform(v.transform, current))
        }
        scopes.push(scope)
        stack.push(scope)
        if (scopes.length > 512) return
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const scope = stack.pop()
        if (!scope || scope.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin))
          return
        scope.end = i
        current = scope.matrix
      } else if (op === OPS.transform) current = Util.transform(current, p.o.argsArray[i])
    }
    if (stack.length) return
    const forms = scopes.filter((s) => s.op === OPS.paintFormXObjectBegin),
      groups = p.evidence.isolatedGroups?.size ?? 0,
      paths = []
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (
        a[0] === OPS.endPath ||
        ([OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(a[0]) &&
          a.length === 3 &&
          a[1]?.length === 1 &&
          a[1][0] === null &&
          a[2] === null)
      )
        continue
      const line = clippedStraightLinePaint(p, i, state),
        paint = line ?? nativeFigurePathPaint(p, i, state)
      if (!paint) return
      paths.push({ i, state, ...paint, line: !!line })
    }
    const within = (r, s) => r.part.every((z) => z.g.i > s.start && z.g.i < s.end),
      candidates = []
    if (
      !forms.length &&
      (groups || p.records.some((r) => zeroMetrics(context.content.styles[r.r.fontName])))
    ) {
      if (!p.records.every((r) => r.advanceComplete)) return
      for (const s of scopes)
        candidates.push({
          kind: 'save',
          scopes: [s],
          records: p.records.filter((r) => within(r, s))
        })
    }
    if (forms.length && !groups)
      for (const s of forms) {
        const a = p.o.argsArray[s.start]
        if (a?.[0] === null && p.valid(Array.from(a?.[1] ?? [])))
          candidates.push({
            kind: 'form',
            scopes: [s],
            records: p.records.filter((r) => within(r, s))
          })
      }
    if (groups) {
      const roots = forms.filter((s) => {
        for (let q = s.parent; q; q = q.parent) if (q.op === OPS.paintFormXObjectBegin) return false
        return true
      })
      if (roots.length === 2) {
        const [a, b] = roots,
          fr = roots.map((s) => {
            const q = p.o.argsArray[s.start]
            return q?.[0] === null && p.valid(Array.from(q?.[1] ?? [])) ? s.rect : undefined
          }),
          labels = roots.map((s, n) =>
            p.records.filter(
              (r) =>
                r.part.every(
                  (z) => z.g.i > s.end && z.g.i < (roots[n + 1]?.start ?? p.o.fnArray.length)
                ) && new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)\\s+\\S').test(r.r.str)
            )
          )
        // Full font and actual paint bounds, rather than a model gutter, decide
        // the two owners. Their only exterior text is one aligned whole label.
        if (
          fr.every(Boolean) &&
          fr[0][2] < fr[1][0] &&
          Math.abs(fr[0][1] - fr[1][1]) < 1e-6 &&
          Math.abs(fr[0][3] - fr[1][3]) < 1e-6 &&
          Math.abs(fr[0][2] - fr[0][0] - (fr[1][2] - fr[1][0])) < 1e-6 &&
          labels.every((l) => l.length === 1)
        ) {
          const [x, y] = labels.map((l) => l[0]),
            em = Math.max(x.r.height, y.r.height)
          if (
            x.r.fontName === y.r.fontName &&
            Math.abs(x.rect[1] - y.rect[1]) < 1e-6 &&
            Math.abs(x.r.height - y.r.height) < 1e-6 &&
            x.rect[0] < y.rect[0] &&
            em > 0
          ) {
            const owned = p.records.filter(
              (r) => roots.some((s) => within(r, s)) || r === x || r === y
            )
            candidates.push({ kind: 'pair', scopes: [a, b], records: owned, labels: [x, y] })
          }
        }
      }
    }
    const results = []
    for (const candidate of candidates) {
      const owned = candidate.records,
        paints = paths.filter((q) => candidate.scopes.some((s) => q.i > s.start && q.i < s.end))
      if (
        owned.length < 3 ||
        owned.length > 64 ||
        paints.length < 3 ||
        owned.some(
          (r) =>
            !r.advanceComplete ||
            !metrics(context.content.styles[r.r.fontName]) ||
            r.part.some((z) => shared.has(z.g))
        )
      )
        continue
      const ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
        span = (g) =>
          candidate.scopes.some((s) => g.i > s.start && g.i < s.end) ||
          (candidate.labels?.some((r) => r.part.some((z) => z.g.i === g.i)) ?? false)
      if (
        glyphs.some((g) => span(g) && !ownGlyphs.has(g)) ||
        owned.some((r) =>
          r.part.some(
            (z) =>
              z.g.textPaint?.fillAlpha !== 1 || z.g.textPaint.fillColor?.toLowerCase() === '#ffffff'
          )
        ) ||
        paints.some((q) => q.state.fillAlpha !== 1 || q.state.strokeAlpha !== 1)
      )
        continue
      const rect = union([...owned.map(full), ...paints.map((q) => q.rect)]),
        em = Math.max(...owned.map((r) => r.r.height)),
        pad = 2 / (Math.ceil(page.width * 1.5) / page.width),
        padded = expand(rect, pad)
      if (
        rect[2] - rect[0] < (figure.caption.rect[2] - figure.caption.rect[0]) * 0.5 ||
        rect[3] - rect[1] < em * 5 ||
        rect[3] >= figure.caption.rect[1] ||
        figure.caption.rect[1] - rect[3] > em * 4 ||
        !inside([0, 0, page.width, page.height], padded) ||
        captions.some((c) => c.page === page.pageNumber && hit(padded, c.rect)) ||
        tables.some((t) => hit(padded, t))
      )
        continue
      if (candidate.labels) {
        const labels = candidate.labels
        if (
          labels.some(
            (r, n) =>
              r.rect[0] <
                Math.min(
                  ...paints
                    .filter((q) => q.i > candidate.scopes[n].start && q.i < candidate.scopes[n].end)
                    .map((q) => q.rect[0])
                ) -
                  em ||
              r.rect[1] -
                Math.max(
                  ...paints
                    .filter((q) => q.i > candidate.scopes[n].start && q.i < candidate.scopes[n].end)
                    .map((q) => q.rect[3])
                ) >
                em * 3
          )
        )
          continue
      }
      if (
        (figure.sourceItems ?? []).some(
          (s) => !owned.some((r) => JSON.stringify(r.r.sourceItem) === JSON.stringify(s))
        )
      )
        continue
      const old = figure.rect && expand(figure.rect, pad),
        missesInk = !old || owned.some((r) => !inside(old, r.ink)),
        borrowsText =
          old &&
          p.records.some(
            (r) =>
              !owned.includes(r) && r.ink[2] > r.ink[0] && r.ink[3] > r.ink[1] && hit(old, r.ink)
          ),
        completeClaims =
          figure.sourceItems?.length === owned.length &&
          owned.every((r) =>
            figure.sourceItems.some((s) => JSON.stringify(s) === JSON.stringify(r.r.sourceItem))
          )
      // Missing model claims alone do not justify trimming an already complete
      // Form. Its old crop must demonstrably borrow native exterior text.
      // Paired programs instead need an actually omitted owned glyph envelope.
      if (candidate.kind === 'form' && !borrowsText) continue
      if (candidate.kind === 'pair' && !missesInk) continue
      if (
        candidate.kind === 'save' &&
        !missesInk &&
        !borrowsText &&
        (completeClaims ||
          !p.records.some((r) => zeroMetrics(context.content.styles[r.r.fontName])))
      )
        continue
      if (old && completeClaims && inside(old, rect) && !borrowsText) continue
      const foreign = [
        ...p.records.filter((r) => !owned.includes(r)).map((r) => ({ rect: full(r), floor: 0 })),
        ...paths.filter((q) => !paints.includes(q)).map((q) => ({ rect: q.rect, floor: q.floor })),
        ...glyphs.filter((g) => !membership.has(g)).map((g) => ({ rect: g.ink, floor: 0 }))
      ]
      if (foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / 4)))) continue
      const id = owned.map((r) => r.index).join(',') + '|' + paints.map((q) => q.i).join(',')
      if (results.some((r) => r.id === id)) continue
      results.push({
        id,
        rect,
        sourceItems: owned.map((r) => r.r.sourceItem),
        graphicsCount: paints.length,
        formCropRaster: { ownedRects: [rect], foreignPaints: foreign },
        paints,
        packet: p
      })
    }
    if (results.length !== 1) return
    const result = results[0],
      rebound = recoveryProfile
        ? nativeRecoveryFigureInkPacket(page, tokens, context, result.sourceItems, recoveryProfile)
        : nativeClosedProgramInkPacket(page, tokens, context, result.sourceItems)
    if (!rebound) return
    const binding = () =>
        createHash('sha256')
          .update(JSON.stringify([context, page, tokens, captions, tables, figure]))
          .digest('hex'),
      nativeBinding = binding(),
      rasterBinding = JSON.stringify(result.formCropRaster),
      ownerBinding = JSON.stringify([result.rect, result.sourceItems, result.graphicsCount])
    certificates.set(result.formCropRaster, {
      recoveryProfile,
      tokens,
      context,
      page,
      pageSnapshot: pageKey(page),
      paints: result.paints,
      packet: result.packet,
      binding,
      nativeBinding,
      rasterBinding,
      ownerBinding
    })
    return {
      rect: result.rect,
      sourceItems: result.sourceItems,
      graphicsCount: result.graphicsCount,
      formCropRaster: result.formCropRaster,
      closedProgramRaster: true
    }
  } catch {
    return
  }
}

// Only the canonical renderer's final encoded PNG is admitted. Existing
// 4MiB/2400-edge/scale4 limits and conservative ceil/AA interval remain intact.
export function nativeClosedProgramPngSafe(png, rect, page, candidate) {
  const proof = certificates.get(candidate?.formCropRaster)
  if (!proof) return candidate?.closedProgramRaster ? false : undefined
  try {
    if (
      proof.recoveryProfile &&
      !nativeFigureRecoveryProfileData(proof.recoveryProfile, page, proof.tokens, proof.context)
    )
      return false
    if (
      page !== proof.page ||
      pageKey(page) !== proof.pageSnapshot ||
      candidate.closedProgramRaster !== true ||
      proof.binding() !== proof.nativeBinding ||
      JSON.stringify(candidate.formCropRaster) !== proof.rasterBinding ||
      JSON.stringify([candidate.rect, candidate.sourceItems, candidate.graphicsCount]) !==
        proof.ownerBinding
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || !nativeCompleteFormCropPngSafe(png, rect, page, candidate)) return false
    return closedProgramPaintsInside(proof.packet, proof.paints, rect, raster)
  } catch {
    return false
  }
}

function closedProgramPaintsInside(packet, paints, rect, raster) {
  return paints.every((q) => {
    if (q.clippedPaint) {
      const paint = closedProgramClippedPaint(packet, q.i, q.state, raster.scaleLower)
      return paint && inside(rect, expand(paint.rect, 2 / raster.scaleLower))
    }
    let paint = q.line ? clippedStraightLinePaint(packet, q.i, q.state, raster.scaleLower) : q
    if (!q.line) {
      const matrix = Util.transform(packet.v.transform, q.state.transform)
      // Under a uniform axis transform, the native stroke and the renderer's
      // minimum device width are alternatives. Bound their maximum before
      // adding AA, rather than charging both complete stroke envelopes.
      if (matrix[1] === 0 && matrix[2] === 0 && matrix[0] > 0 && matrix[0] === -matrix[3]) {
        const bounded = nativeFigurePathPaint(packet, q.i, {
          ...q.state,
          lineWidth: Math.max(q.state.lineWidth, 1 / (raster.scaleLower * matrix[0]))
        })
        paint = bounded && { rect: bounded.rect, floor: 0 }
      }
    }
    return paint && inside(rect, expand(paint.rect, (paint.floor + 1) / raster.scaleLower))
  })
}

// Pixel-only recovery for one complete ordinary saved drawing. Unlike the
// owning API above, font advances do not enlarge the image or grant claims.
export function nativeClosedProgramPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect
) {
  return closedProgramPixelCrop(page, figure, captions, tables, tokens, context, publishedRect)
}

// A complete literal paint packet can bound an image even when a mixed
// baseline has no single whole source advance. This separate mode grants no
// source ownership and leaves both existing pixel/owning contracts unchanged.
export function nativeClosedPaintPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect
) {
  return closedProgramPixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    publishedRect,
    nativePaintPixelMode
  )
}
function closedPaintMetrics(s) {
  return (
    s?.vertical === false &&
    Number.isFinite(s.ascent) &&
    s.ascent >= 0 &&
    s.ascent <= 2 &&
    Number.isFinite(s.descent) &&
    s.descent <= 0 &&
    s.descent >= -2
  )
}
function closedPaintForeignFontBounds(r, s, v) {
  // Use the explicit metrics, including a declared zero ascent. The complete
  // observed glyph outlines remain part of the same exterior bound.
  const [a, b, c, d, x, y] = r.transform,
    h = Math.hypot(a, b),
    z = Math.hypot(c, d),
    points = [0, r.width].flatMap((u) =>
      [s.descent * z, s.ascent * z].map((t) =>
        v.convertToViewportPoint(x + (a * u) / h + (c * t) / z, y + (b * u) / h + (d * t) / z)
      )
    )
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
}
function closedProgramClippedPaint(packet, i, state, scale = 4) {
  if (!valid(state.clip) || !(scale > 0)) return
  const m = Util.transform(packet.v.transform, state.transform),
    uniform = m[1] === 0 && m[2] === 0 && Math.abs(m[0]) === Math.abs(m[3]) && m[0] !== 0,
    bounded = nativeFigurePathPaint(
      packet,
      i,
      uniform
        ? { ...state, lineWidth: Math.max(state.lineWidth, 1 / (scale * Math.abs(m[0]))) }
        : state
    )
  if (!bounded) return
  // Charge physical/minimum-device stroke width before clipping. A clip is
  // an upper bound, never permission to discard an unknown drawing program.
  const raw = uniform ? bounded.rect : expand(bounded.rect, bounded.floor / scale),
    rect = [
      Math.max(raw[0], state.clip[0]),
      Math.max(raw[1], state.clip[1]),
      Math.min(raw[2], state.clip[2]),
      Math.min(raw[3], state.clip[3])
    ]
  return valid(rect) ? { rect, floor: 1 } : undefined
}
function closedProgramNotesBetween(records, after, before, labels, body, caption) {
  // Notes stay exterior text. They only bridge an otherwise unique complete
  // native program to its own printed caption; their ink is still excluded.
  const rows = records.filter(
    (r) => !labels.includes(r) && r.part.some((z) => z.g.i > after && z.g.i < before)
  )
  if (!rows.length) return true
  if (
    rows.length > 6 ||
    !/^Notes?:\s+\p{Lu}/u.test(rows[0].r.str) ||
    !/[.!?]$/u.test(rows.at(-1).r.str.trim())
  )
    return false
  const em = rows[0].r.height,
    family = rows[0].r.fontName
  return rows.every(
    (r, i) =>
      r.advanceComplete &&
      r.r.fontName === family &&
      Math.abs(r.r.height - em) < 0.02 &&
      r.rect[1] > body[3] + 0.5 &&
      r.rect[3] < caption.rect[1] &&
      (!i ||
        (Math.abs(r.rect[0] - rows[0].rect[0]) < 0.02 &&
          r.rect[1] - rows[i - 1].rect[1] > em &&
          r.rect[1] - rows[i - 1].rect[1] < em * 1.6))
  )
}
function closedProgramPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect,
  mode,
  originalCaptions
) {
  try {
    const values = nativeRecoveryOwnValues(context)
    if (!values) return
    const prototype = Object.getPrototypeOf(context),
      descriptors = Object.getOwnPropertyDescriptors(context),
      keys = Reflect.ownKeys(descriptors),
      input = Object.fromEntries(
        [
          'operators',
          'glyphBounds',
          'partialFontGlyphBounds',
          'skippedSpaceGlyphs',
          'graphicsBounds',
          'viewport',
          'content',
          'pageNumber',
          'sourceSha256'
        ]
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, values[key]])
      ),
      current = retainNativeRecoveryInputs(
        [page, figure, captions, originalCaptions, tables, tokens, publishedRect, input],
        input.viewport
      ),
      caption = figure?.caption
    if (
      !current ||
      !valid(caption?.rect) ||
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/iu.test(caption.lines?.[0] ?? '') ||
      caption.page !== page.pageNumber ||
      caption.regions ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.formCropRaster ||
      figure.fallbackFigure ||
      figure.sourceItems?.length ||
      (publishedRect != null && !valid(publishedRect)) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? page.rotation) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      !Array.isArray(captions) ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      captions.filter(
        (c) =>
          c.page === page.pageNumber &&
          JSON.stringify([c.lines, c.rect]) === JSON.stringify([caption.lines, caption.rect])
      ).length !== 1
    )
      return
    const v = input.viewport
    if (
      v.scale !== 1 ||
      v.rotation !== 0 ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const seed = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem,
      packet = seed && nativeClosedProgramInkPacket(page, tokens, input, [seed])
    if (
      !packet ||
      (mode !== nativeCaptionPixelMode && packet.evidence.images.length) ||
      packet.records.length > 4096 ||
      packet.evidence.paths.size > 4096 ||
      (mode !== nativePaintPixelMode &&
        packet.o.fnArray.some((op) =>
          [
            OPS.paintFormXObjectBegin,
            OPS.paintFormXObjectEnd,
            OPS.beginGroup,
            OPS.endGroup
          ].includes(op)
        )) ||
      !packet.records.every(
        (r) =>
          (mode === nativePaintPixelMode || r.advanceComplete) &&
          (mode === nativePaintPixelMode
            ? closedPaintMetrics(input.content.styles[r.r.fontName])
            : metrics(input.content.styles[r.r.fontName]) ||
              zeroMetrics(input.content.styles[r.r.fontName]))
      )
    )
      return
    const glyphs = packet.glyphs.filter((g) => !g.rendererSkipped && valid(g.ink)),
      roots = [],
      stack = [],
      images = []
    let matrix = [1, 0, 0, 1, 0, 0]
    for (let i = 0; i < packet.o.fnArray.length; i++) {
      const op = packet.o.fnArray[i]
      if (
        op === OPS.save ||
        (mode === nativePaintPixelMode && [OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
      ) {
        const a = packet.o.argsArray[i]
        if (
          mode === nativePaintPixelMode &&
          op === OPS.paintFormXObjectBegin &&
          (a?.[0] !== null || a?.[1] !== null)
        )
          return
        if (
          mode === nativePaintPixelMode &&
          op === OPS.beginGroup &&
          !packet.evidence.isolatedGroups?.get(i)
        )
          return
        const scope = { start: i, op, parent: stack.at(-1), matrix: [...matrix] }
        if (!stack.length) roots.push(scope)
        stack.push(scope)
        if (roots.length > 512) return
      } else if (
        op === OPS.restore ||
        (mode === nativePaintPixelMode && [OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
      ) {
        const scope = stack.pop()
        if (
          !scope ||
          (mode === nativePaintPixelMode &&
            scope.op !==
              (op === OPS.restore
                ? OPS.save
                : op === OPS.paintFormXObjectEnd
                  ? OPS.paintFormXObjectBegin
                  : OPS.beginGroup))
        )
          return
        scope.end = i
        matrix = scope.matrix
      } else if (op === OPS.transform) {
        matrix = Util.transform(matrix, packet.o.argsArray[i])
      } else if (op === OPS.paintImageXObject && mode === nativeCaptionPixelMode) {
        // The whole affine image is an upper bound even when its private clip
        // is curved. No unsupported clip is treated as an empty image.
        const m = Util.transform(v.transform, matrix),
          points = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1]
          ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]),
          rect = [
            Math.min(...points.map((p) => p[0])),
            Math.min(...points.map((p) => p[1])),
            Math.max(...points.map((p) => p[0])),
            Math.max(...points.map((p) => p[1]))
          ],
          recorded = page.graphicsBounds.filter((g) => g.kind === 'image' && g.operationIndex === i)
        if (
          !valid(rect) ||
          recorded.length !== 1 ||
          !/^[a-f0-9]{64}$/u.test(recorded[0].imageHash ?? '') ||
          !inside(
            recorded[0].normalizedRect.map((n, k) => n * (k % 2 ? page.height : page.width)),
            rect
          )
        )
          return
        images.push({ i, rect, floor: 0 })
      }
    }
    if (
      stack.length ||
      (mode === nativeCaptionPixelMode &&
        (images.length !== packet.evidence.images.length ||
          images.length > 64 ||
          images.length !== page.graphicsBounds.filter((g) => g.kind === 'image').length))
    )
      return
    const paths = []
    for (const [i, state] of packet.evidence.paths) {
      const a = packet.o.argsArray[i]
      if (
        a[0] === OPS.endPath ||
        ([OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(a[0]) &&
          a.length === 3 &&
          a[1]?.length === 1 &&
          a[1][0] === null &&
          a[2] === null)
      )
        continue
      const line =
          mode === nativePaintPixelMode ? undefined : clippedStraightLinePaint(packet, i, state),
        paint =
          mode === nativePaintPixelMode
            ? closedProgramClippedPaint(packet, i, state)
            : (line ?? nativeFigurePathPaint(packet, i, state))
      if (!paint) return
      paths.push({
        i,
        state,
        ...paint,
        line: !!line,
        ...(mode === nativePaintPixelMode ? { clippedPaint: true } : {})
      })
    }
    const cap = packet.records.filter((r) => inside(caption.rect, r.rect)),
      literal = (s) => s.replace(/\s/gu, '')
    if (
      !cap.length ||
      literal(cap.map((r) => r.r.str).join('')) !== literal(caption.lines.join(''))
    )
      return
    const capStart = Math.min(...cap.flatMap((r) => r.part.map((z) => z.g.i))),
      results = []
    const programs = roots.map((root) => ({ scopes: [root], labels: [] }))
    if (mode === nativePaintPixelMode && roots.length === 2) {
      const labels = roots.map((root, n) =>
        packet.records.filter(
          (r) =>
            r.part.every((z) => z.g.i > root.end && z.g.i < (roots[n + 1]?.start ?? capStart)) &&
            new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)\\s+\\p{Lu}', 'u').test(r.r.str)
        )
      )
      if (labels.every((a) => a.length === 1))
        programs.push({ scopes: roots, labels: labels.map((a) => a[0]) })
    }
    for (const program of programs) {
      const root = { start: program.scopes[0].start, end: program.scopes.at(-1).end },
        belongs = (i) =>
          program.scopes.some((s) => i > s.start && i < s.end) ||
          program.labels.some((r) => r.part.some((z) => z.g.i === i)),
        own = glyphs.filter((g) => belongs(g.i)),
        records = packet.records.filter((r) => r.part.some((z) => belongs(z.g.i))),
        paints = paths.filter((p) => belongs(p.i)),
        ownImages = images.filter((p) => belongs(p.i))
      if (
        records.length < 3 ||
        records.length > (mode === nativeCaptionPixelMode ? 256 : 64) ||
        (mode === nativeCaptionPixelMode && (records.length <= 64 || !ownImages.length)) ||
        paints.length < 3 ||
        !own.length ||
        !records.every((r) => r.part.every((z) => belongs(z.g.i))) ||
        paints.some((q) => q.state.fillAlpha !== 1 || q.state.strokeAlpha !== 1) ||
        own.some(
          (g) =>
            g.textPaint?.fillAlpha !== 1 ||
            (mode !== nativeCaptionPixelMode && g.textPaint.fillColor?.toLowerCase() === '#ffffff')
        ) ||
        root.end >= capStart ||
        roots.some((s) => s.start > root.end && s.start < capStart) ||
        (mode !== nativePaintPixelMode &&
          packet.records.some(
            (r) => !cap.includes(r) && r.part.some((z) => z.g.i > root.end && z.g.i < capStart)
          ))
      )
        continue
      if (mode === nativePaintPixelMode && program.scopes.length === 2) {
        const boxes = program.scopes.map((s) =>
            union([
              ...glyphs.filter((g) => g.i > s.start && g.i < s.end).map((g) => g.ink),
              ...paths.filter((p) => p.i > s.start && p.i < s.end).map((p) => p.rect)
            ])
          ),
          [a, b] = program.labels,
          em = a.r.height
        if (
          a.r.fontName !== b.r.fontName ||
          Math.abs(b.r.height - em) > 0.02 ||
          boxes[0][3] >= boxes[1][1] ||
          Math.abs(boxes[0][0] - boxes[1][0]) > 0.02 ||
          Math.abs(boxes[0][2] - boxes[1][2]) > 0.02 ||
          program.labels.some(
            (r, i) =>
              r.rect[1] <= boxes[i][3] ||
              r.rect[1] - boxes[i][3] > em * 3 ||
              Math.abs((r.rect[0] + r.rect[2] - boxes[i][0] - boxes[i][2]) / 2) > em
          )
        )
          continue
      }
      const body = union([
          ...own.map((g) => g.ink),
          ...paints.map((p) => p.rect),
          ...ownImages.map((p) => p.rect)
        ]),
        pad = 2 / (Math.ceil(page.width * 1.5) / page.width),
        rect = union([expand(body, pad), ...(publishedRect ? [publishedRect] : [])]),
        foreign = [
          ...glyphs.filter((g) => !belongs(g.i)).map((g) => ({ rect: g.ink, floor: 0 })),
          ...(mode === nativePaintPixelMode
            ? packet.records
                .filter((r) => !records.includes(r))
                .map((r) => ({
                  rect: union([
                    closedPaintForeignFontBounds(r.r, input.content.styles[r.r.fontName], v),
                    ...r.part.map((z) => z.g.ink)
                  ]),
                  floor: 0
                }))
            : []),
          ...paths.filter((p) => !belongs(p.i)),
          ...images.filter((p) => !belongs(p.i))
        ]
      if (
        (mode === nativePaintPixelMode &&
          !closedProgramNotesBetween(
            packet.records,
            root.end,
            capStart,
            program.labels,
            body,
            caption
          )) ||
        !valid(rect) ||
        !inside([0, 0, page.width, page.height], rect) ||
        body[3] >= caption.rect[1] ||
        body[2] <= caption.rect[0] ||
        body[0] >= caption.rect[2] ||
        (publishedRect && !own.some((g) => !inside(publishedRect, g.ink))) ||
        tables.some((r) => hit(rect, r)) ||
        captions.some((c) => c !== caption && c.page === page.pageNumber && hit(rect, c.rect)) ||
        foreign.some((p) => hit(rect, expand(p.rect, (p.floor + 2) / 4)))
      )
        continue
      results.push({ rect, own, paints, ownImages, foreign })
    }
    if (results.length !== 1) return
    const proof = results[0],
      output = { rect: proof.rect, ...(mode === nativeCaptionPixelMode ? { caption } : {}) },
      retained = retainNativeRecoveryInputs([output, proof.own, proof.paints, proof.foreign])
    if (!retained) return
    pixelCertificates.set(output, {
      ...proof,
      mode,
      page,
      packet,
      current: () => {
        if (
          !current() ||
          !retained() ||
          !nativeRecoveryOwnValues(context) ||
          Object.getPrototypeOf(context) !== prototype ||
          Reflect.ownKeys(context).length !== keys.length
        )
          return false
        return keys.every((key, i) => {
          const d = Object.getOwnPropertyDescriptor(context, key),
            b = descriptors[key]
          return (
            Reflect.ownKeys(context)[i] === key &&
            d &&
            Object.hasOwn(d, 'value') &&
            Object.is(d.value, b.value) &&
            d.enumerable === b.enumerable &&
            d.configurable === b.configurable &&
            d.writable === b.writable
          )
        })
      }
    })
    return output
  } catch {
    return
  }
}

export function nativeClosedProgramPixelPngSafe(plan, png, rect, page) {
  try {
    const proof = pixelCertificates.get(plan),
      raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!proof &&
      proof.page === page &&
      proof.current() &&
      !!raster &&
      JSON.stringify(plan.rect) === JSON.stringify(rect) &&
      proof.own.every((g) => inside(rect, expand(g.ink, 1 / raster.scaleLower))) &&
      closedProgramPaintsInside(proof.packet, proof.paints, rect, raster) &&
      proof.ownImages.every((q) => inside(rect, expand(q.rect, 1 / raster.scaleLower))) &&
      proof.foreign.every(
        (q) => !hit(raster.protection, expand(q.rect, (q.floor + 2) / raster.scaleLower))
      )
    )
  } catch {
    return false
  }
}

// The pure caption classifier stays conservative. Only a complete native
// program followed by its literal, isolated multiline caption can use this
// optional image-only recovery; the returned object carries no Source claims.
export function nativeCaptionedProgramPixelCrop(page, captions, tables, tokens, context) {
  try {
    if (
      !nativeRecoveryOwnValues(page) ||
      !nativeRecoveryOwnValues(context) ||
      !retainNativeRecoveryInputs([page, captions, tables, tokens], context.viewport)
    )
      return
    if (!Array.isArray(page?.lines) || !Array.isArray(captions)) return
    const results = []
    for (const start of page.lines) {
      if (
        captionKind(start.text) !== undefined ||
        !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+\.\s+\p{Lu}[\p{L}\p{N}-]*\s+(?:is|are)\s+(?:a|an|the)\s+\p{L}/u.test(
          start.text ?? ''
        ) ||
        !(start.fontSize > 0) ||
        start.width < page.width * 0.6
      )
        continue
      const lines = [start]
      while (lines.length < 12) {
        const previous = lines.at(-1),
          next = page.lines.filter(
            (l) =>
              l !== previous &&
              l.y > previous.y + previous.height * 0.8 &&
              l.y <= previous.y + previous.height * 1.4 &&
              Math.abs(l.x - start.x) < start.fontSize * 0.1 &&
              Math.abs(l.fontSize - start.fontSize) < start.fontSize * 0.01 &&
              l.x + l.width <= start.x + start.width + start.fontSize * 0.1
          )
        if (next.length !== 1) break
        lines.push(next[0])
      }
      if (lines.length < 2 || !/[.!?]$/u.test(lines.at(-1).text)) continue
      const caption = {
        page: page.pageNumber,
        lines: lines.map((l) => l.text),
        rect: union(lines.map((l) => [l.x, l.y, l.x + l.width, l.y + l.height]))
      }
      if (captions.some((c) => c.page === page.pageNumber && hit(c.rect, caption.rect))) continue
      const plan = closedProgramPixelCrop(
        page,
        { caption },
        [...captions, caption],
        tables,
        tokens,
        context,
        undefined,
        nativeCaptionPixelMode,
        captions
      )
      if (plan) results.push(plan)
    }
    return results.length === 1 ? results[0] : undefined
  } catch {
    return
  }
}

export function nativeCaptionedProgramPixelPngSafe(plan, png, rect, page) {
  return (
    pixelCertificates.get(plan)?.mode === nativeCaptionPixelMode &&
    nativeClosedProgramPixelPngSafe(plan, png, rect, page)
  )
}

export function nativeClosedPaintPixelPngSafe(plan, png, rect, page) {
  return (
    pixelCertificates.get(plan)?.mode === nativePaintPixelMode &&
    nativeClosedProgramPixelPngSafe(plan, png, rect, page)
  )
}
