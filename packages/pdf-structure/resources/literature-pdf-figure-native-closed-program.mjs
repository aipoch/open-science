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
import { nativeFigureRecoveryProfileData } from './literature-pdf-native-figure-recovery-profile.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
const certificates = new WeakMap()
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
    return proof.paints.every((q) => {
      let paint = q.line
        ? clippedStraightLinePaint(proof.packet, q.i, q.state, raster.scaleLower)
        : q
      if (!q.line) {
        const matrix = Util.transform(proof.packet.v.transform, q.state.transform)
        // Under a uniform axis transform, the native stroke and the renderer's
        // minimum device width are alternatives. Bound their maximum before
        // adding AA, rather than charging both complete stroke envelopes.
        if (matrix[1] === 0 && matrix[2] === 0 && matrix[0] > 0 && matrix[0] === -matrix[3]) {
          const bounded = nativeFigurePathPaint(proof.packet, q.i, {
            ...q.state,
            lineWidth: Math.max(q.state.lineWidth, 1 / (raster.scaleLower * matrix[0]))
          })
          paint = bounded && { rect: bounded.rect, floor: 0 }
        }
      }
      return paint && inside(rect, expand(paint.rect, (paint.floor + 1) / raster.scaleLower))
    })
  } catch {
    return false
  }
}
