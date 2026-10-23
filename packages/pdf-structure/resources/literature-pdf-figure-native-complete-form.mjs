/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePlotPacketInventory,
  nativeTypedPlotPacketInventory
} from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b, e = 1e-5) => b.every((v, i) => (i < 2 ? v >= a[i] - e : v <= a[i] + e))
const close = (a, b) => Math.abs(a - b) < 0.05
const expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d))
export function nativeCompleteFormCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (f?.fallbackFigure || f?.headerRaster) return
    const rules = collectTableRules(ctx.operators, ctx.viewport),
      inv =
        nativeTypedPlotPacketInventory(page, f, captions, tables, rules, tokens, ctx) ??
        nativePlotPacketInventory(page, f, captions, tables, rules, tokens, ctx, true)
    if (!inv) return
    const { o, v, evidence, finite, valid, box } = inv,
      forms = [],
      stack = [],
      strokes = new Map(),
      textPaints = new Map()
    let matrix = [1, 0, 0, 1, 0, 0],
      active,
      strokeColor = '#000000',
      fillColor = '#000000',
      fillAlpha = 1
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push({ matrix, active, op, strokeColor, fillColor, fillAlpha })
        if (op === OPS.paintFormXObjectBegin) {
          if (a?.[0]) {
            if (!finite(a[0], 6)) return
            matrix = Util.transform(matrix, a[0])
          }
          const m = Util.transform(v.transform, matrix)
          if (!finite(a?.[1], 4) || !finite(m, 6) || (!m[0] && !m[1]) || (!m[2] && !m[3])) return
          const form = { start: i, parent: active, rect: box(a[1], m) }
          if (!valid(form.rect)) return
          forms.push(form)
          active = form
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (op === OPS.paintFormXObjectEnd && active) active.end = i
        const s = stack.pop()
        if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        ;({ matrix, active, strokeColor, fillColor, fillAlpha } = s)
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        matrix = Util.transform(matrix, a)
      } else if (op === OPS.setStrokeRGBColor) strokeColor = a?.[0]
      else if (op === OPS.setFillRGBColor) fillColor = a?.[0]
      else if (op === OPS.setGState) {
        for (const [key, value] of a[0]) if (key === 'ca') fillAlpha = value
      } else if (op === OPS.showText) textPaints.set(i, { fillColor, fillAlpha })
      else if (op === OPS.constructPath) strokes.set(i, strokeColor)
    }
    const roots = forms.filter((x) => !x.parent),
      owned = (form, i) => i > form.start && i < form.end,
      visible = (record) =>
        record.part.every(({ g }) => {
          const p = textPaints.get(g.i)
          return (
            p &&
            /^#[0-9a-f]{6}$/i.test(p.fillColor) &&
            p.fillColor.toLowerCase() !== '#ffffff' &&
            p.fillAlpha === 1
          )
        })
    if (
      stack.length ||
      roots.length < 1 ||
      roots.length > 2 ||
      roots.some((q) => !Number.isInteger(q.end))
    )
      return
    const vs = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 35),
      hs = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 65)
    for (const form of roots) {
      form.faces = vs
        .flatMap((a) =>
          hs
            .filter((b) => close(a[0], b[0]) && close(a[3], b[1]))
            .map((b) => [a[0], a[1], b[2], a[3]])
        )
        .filter(
          (r, i, all) =>
            inside(form.rect, r) && !all.slice(0, i).some((q) => q.every((n, k) => close(n, r[k])))
        )
      const faces = form.faces,
        w = faces[0]?.[2] - faces[0]?.[0],
        h = faces[0]?.[3] - faces[0]?.[1]
      if (
        faces.length < 3 ||
        faces.length > 8 ||
        faces.some(
          (r, i) =>
            Math.abs(r[2] - r[0] - w) > w * 0.15 ||
            Math.abs(r[3] - r[1] - h) > h * 0.05 ||
            !close(r[1], faces[0][1]) ||
            faces.slice(0, i).some((q) => hit(q, r))
        )
      )
        return
      for (const face of faces) {
        for (const side of [
          [face[0], face[1], face[0], face[3]],
          [face[0], face[3], face[2], face[3]]
        ]) {
          const matches = [...evidence.paths].filter(([i, s]) => {
            const a = o.argsArray[i],
              p = a?.[1]?.[0],
              m = Util.transform(v.transform, s.transform)
            if (
              !owned(form, i) ||
              a?.[0] !== OPS.stroke ||
              p?.length !== 6 ||
              p[0] !== 0 ||
              p[3] !== 1 ||
              s.strokeAlpha !== 1 ||
              s.solidStroke !== true ||
              !(s.lineWidth > 0) ||
              ![0, 1, 2].includes(s.lineCap) ||
              !s.clip ||
              !/^#[0-9a-f]{6}$/i.test(strokes.get(i)) ||
              strokes.get(i).toLowerCase() === '#ffffff'
            )
              return false
            const segment = [
              Math.min(p[1], p[4]),
              Math.min(p[2], p[5]),
              Math.max(p[1], p[4]),
              Math.max(p[2], p[5])
            ]
            return (
              box(segment, m).every((n, k) => close(n, side[k])) &&
              box(a[2], m).every((n, k) => close(n, side[k])) &&
              inside(form.rect, s.clip)
            )
          })
          if (!matches.length) return
        }
        if (
          inv.records.filter(
            (r) =>
              r.part.every((p) => owned(form, p.g.i)) &&
              /^[−-]?\d+(?:\.\d+)?$/.test(r.r.str.trim()) &&
              visible(r) &&
              inside(expand(face, 4 * r.r.height), r.rect)
          ).length < 2
        )
          return
      }
      form.records = inv.records.filter((r) => r.part.some((p) => owned(form, p.g.i)))
      if (
        !form.records.length ||
        form.records.some(
          (r) =>
            !r.part.every((p) => owned(form, p.g.i)) ||
            !r.part.every((p) => inside(form.rect, p.g.ink))
        )
      )
        return
      if (form.rect[3] - form.rect[1] > h * 3) return
    }
    roots.sort((a, b) => a.rect[1] - b.rect[1])
    const keys = []
    if (roots.length === 2) {
      const [a, b] = roots
      if (
        a.faces.some((q, i) => !close(q[0], b.faces[i]?.[0])) ||
        !close(a.rect[0], b.rect[0]) ||
        !close(a.rect[2], b.rect[2]) ||
        !close(a.rect[3] - a.rect[1], b.rect[3] - b.rect[1]) ||
        a.faces.length !== b.faces.length ||
        !inside(f.rect, b.rect) ||
        hit(a.rect, f.rect)
      )
        return
      for (let n = 0; n < 2; n++) {
        const form = roots[n],
          key = inv.records.filter(
            (r) =>
              r.r.str.trimStart().startsWith(`(${String.fromCharCode(97 + n)})`) &&
              r.part.every((p) => !roots.some((q) => owned(q, p.g.i))) &&
              r.rect[1] >= form.rect[3] &&
              r.rect[1] - form.rect[3] < 2 * r.r.height &&
              r.rect[0] >= form.rect[0] &&
              r.rect[2] <= form.rect[2]
          )
        if (key.length !== 1 || !visible(key[0])) return
        keys.push(key[0])
      }
    } else {
      const form = roots[0]
      if (!inside(form.rect, f.rect)) return
      const panelKeys = []
      for (let n = 0; n < form.faces.length; n++) {
        const face = form.faces[n],
          key = form.records.filter(
            (r) =>
              r.r.str.trim() === `(${String.fromCharCode(97 + n)})` &&
              r.rect[1] >= face[3] &&
              r.rect[3] <= form.rect[3] &&
              Math.abs((r.rect[0] + r.rect[2] - face[0] - face[2]) / 2) < r.r.height
          )
        if (key.length !== 1 || !visible(key[0])) return
        panelKeys.push(key[0])
      }
      if (
        panelKeys.some(
          (q) =>
            !close(q.rect[1], panelKeys[0].rect[1]) || !close(q.r.height, panelKeys[0].r.height)
        )
      )
        return
    }
    const rect = union([
      f.rect,
      ...roots.map((q) => q.rect),
      ...keys.map((r) => union([r.rect, ...r.part.map((p) => p.g.ink)]))
    ])
    if (rect.every((n, i) => close(n, f.rect[i]))) return
    const scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      belongs = (i) => roots.some((q) => owned(q, i))
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      captions.some((c) => c.page === page.pageNumber && hit(padded, c.rect)) ||
      tables.some((t) => hit(padded, t))
    )
      return
    for (const [i, s] of evidence.paths) {
      if (
        belongs(i) &&
        (!valid(s.clip) || !roots.some((q) => owned(q, i) && inside(q.rect, s.clip)))
      )
        return
    }
    if (
      evidence.images.some(
        (im) =>
          belongs(im.operationIndex) &&
          (!valid(im.rect) ||
            !roots.some((q) => owned(q, im.operationIndex) && inside(q.rect, im.rect)))
      )
    )
      return
    const allowed = new Set(keys.flatMap((r) => r.part.map((p) => p.g))),
      foreignPaints = [
        ...captions
          .filter((c) => c.page === page.pageNumber)
          .map((c) => ({ rect: c.rect, floor: 0 })),
        ...tables.map((rect) => ({ rect, floor: 0 })),
        ...inv.glyphs
          .filter((g) => !belongs(g.i) && !allowed.has(g) && valid(g.ink))
          .map((g) => ({ rect: g.ink, floor: 0 }))
      ]
    if (
      inv.glyphs.some((g) => !belongs(g.i) && !allowed.has(g) && valid(g.ink) && hit(padded, g.ink))
    )
      return
    for (const [i, s] of evidence.paths) {
      const a = o.argsArray[i]
      if (belongs(i) || a?.[0] === OPS.endPath) continue
      const stroke = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a[0]),
        pad = stroke ? (s.lineWidth * Math.max(Math.SQRT2, inv.strokeMargins.get(i) ?? 10)) / 2 : 0
      if (
        !finite(a?.[2], 4) ||
        !finite(s.transform, 6) ||
        s.transform[0] * s.transform[3] - s.transform[1] * s.transform[2] === 0 ||
        !Number.isFinite(pad) ||
        pad < 0 ||
        (stroke &&
          (![0, 1, 2].includes(s.lineCap) || !Number.isFinite(s.lineWidth) || s.lineWidth < 0)) ||
        (s.clip && !valid(s.clip))
      )
        return
      const matrix = Util.transform(v.transform, s.transform),
        r = box(expand(Array.from(a[2]), pad), matrix),
        det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]),
        nx = Math.hypot(matrix[0], matrix[1]),
        ny = Math.hypot(matrix[2], matrix[3]),
        margin = Math.max(Math.SQRT2, inv.strokeMargins.get(i) ?? 10),
        floor = stroke
          ? (margin / 2) *
            Math.max(
              (Math.abs(matrix[0]) * ny + Math.abs(matrix[2]) * nx) / det,
              (Math.abs(matrix[1]) * ny + Math.abs(matrix[3]) * nx) / det
            )
          : 0
      // Keep an unclipped overestimate. Device-scale minimum stroke widths may
      // reach a clip even when the physical-width path would miss it.
      if (!(det > 0) || !finite(r, 4) || !Number.isFinite(floor) || floor < 0) return
      foreignPaints.push({ rect: r, floor })
      if (hit(padded, expand(r, (floor + 2) / scale))) return
    }
    if (
      evidence.images.some(
        (im) =>
          !belongs(im.operationIndex) &&
          (!valid(im.rect) || hit(padded, expand(im.rect, 2 / scale)))
      )
    )
      return
    foreignPaints.push(
      ...evidence.images
        .filter((im) => !belongs(im.operationIndex))
        .map((im) => ({ rect: im.rect, floor: 0 }))
    )
    return {
      rect,
      formCropRaster: {
        ownedRects: [
          ...roots.map((q) => q.rect),
          ...keys.map((r) => union([r.rect, ...r.part.map((p) => p.g.ink)]))
        ],
        foreignPaints
      }
    }
  } catch {
    return undefined
  }
}

// This certificate stays inside the extractor. The actual PNG determines the
// final raster footprint, including ceil rounding and byte-budget retries.
export function nativeCompleteFormCropPngSafe(png, rect, page, candidate) {
  try {
    const proof = candidate?.formCropRaster,
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] >= r[0] &&
        r[3] >= r[1]
    if (
      !proof ||
      !['foreignPaints,ownedRects', 'foreignPaints,ownedRects,paintSeparations'].includes(
        Object.keys(proof).sort().join(',')
      ) ||
      !Array.isArray(proof.ownedRects) ||
      !proof.ownedRects.length ||
      !Array.isArray(proof.foreignPaints) ||
      !valid(rect)
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster) return false
    const scale = raster.scaleLower
    if (
      Object.hasOwn(proof, 'paintSeparations') &&
      (!Array.isArray(proof.paintSeparations) ||
        !proof.paintSeparations.length ||
        !proof.paintSeparations.every(
          (p) =>
            p &&
            Object.keys(p).sort().join(',') === 'glyphInk,laterPaintRect' &&
            valid(p.glyphInk) &&
            p.glyphInk[2] > p.glyphInk[0] &&
            p.glyphInk[3] > p.glyphInk[1] &&
            valid(p.laterPaintRect) &&
            p.laterPaintRect[2] > p.laterPaintRect[0] &&
            p.laterPaintRect[3] > p.laterPaintRect[1] &&
            !hit(expand(p.glyphInk, 2 / scale), expand(p.laterPaintRect, 2 / scale))
        ))
    )
      return false
    return (
      proof.ownedRects.every((r) => valid(r) && inside(rect, expand(r, 1 / scale))) &&
      proof.foreignPaints.every(
        (p) =>
          valid(p?.rect) &&
          Number.isFinite(p.floor) &&
          p.floor >= 0 &&
          !hit(raster.protection, expand(p.rect, (p.floor + 2) / scale))
      )
    )
  } catch {
    return false
  }
}
