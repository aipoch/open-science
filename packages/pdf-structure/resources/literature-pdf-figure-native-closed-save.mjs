/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const area = (r) => (r[2] - r[0]) * (r[3] - r[1])
const overlap = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7))
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n))
const explicitMetrics = (s) =>
  Number.isFinite(s?.ascent) &&
  s.ascent > 0 &&
  s.ascent <= 2 &&
  Number.isFinite(s.descent) &&
  s.descent <= 0 &&
  s.descent >= -2

// A complete ordinary save/restore program can own a drawing without a Form
// XObject. Whole-page native identity, explicit font metrics, and every foreign
// font/paint envelope remain mandatory; geometry alone cannot create owners.
export function nativeClosedSaveFigureCrop(page, figure, captions, tables, tokens, ctx) {
  try {
    if (
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/iu.test(figure.caption?.lines?.[0] ?? '') ||
      !figure.caption ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.caption.regions
    )
      return
    const v = ctx.viewport
    if (
      v.scale !== 1 ||
      v.rotation !== 0 ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, ctx, true)
    if (!p || p.evidence.images.length || p.evidence.paths.size > 4096 || p.records.length > 4096)
      return
    const full = (r) => {
      const s = ctx.content.styles[r.r.fontName]
      if (!explicitMetrics(s)) return
      const font = nativeFigureLabelBounds(r.r, s, v)
      return font && union([r.rect, font, ...r.part.map((z) => z.g.ink)])
    }
    if (p.records.some((r) => !full(r))) return
    // Literal records omit whitespace, but the native renderer may still paint
    // its glyph outline. Account for every positive-ink glyph independently.
    // Exact empty outlines and renderer-certified skipped glyphs have no ink.
    const paintedGlyphs = p.glyphs.filter(
      (g) => !g.rendererSkipped && !(g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3])
    )
    if (
      paintedGlyphs.some((g) => !p.valid(g.ink) || !explicitMetrics(ctx.content.styles[g.fontName]))
    )
      return
    const recordGlyphs = new Set(),
      sharedGlyphs = new Set()
    for (const record of p.records)
      for (const glyph of new Set(record.part.map((z) => z.g))) {
        if (recordGlyphs.has(glyph)) sharedGlyphs.add(glyph)
        recordGlyphs.add(glyph)
      }
    const unboundGlyphs = paintedGlyphs.filter((g) => !recordGlyphs.has(g))
    const scopes = [],
      stack = []
    for (let i = 0; i < p.o.fnArray.length; i++) {
      const op = p.o.fnArray[i]
      if (op === OPS.paintFormXObjectBegin || op === OPS.paintFormXObjectEnd) return
      if (op === OPS.save) {
        const scope = { start: i }
        scopes.push(scope)
        if (scopes.length > 512) return
        stack.push(scope)
      } else if (op === OPS.restore) {
        const scope = stack.pop()
        if (!scope) return
        scope.end = i
      }
    }
    if (stack.length) return
    const paths = []
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      // PDF.js represents an empty Path2D paint by this exact null payload.
      // It has no ink or bounds; all nonempty paths require measured closure.
      if (
        a[0] === OPS.endPath ||
        ([OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(a[0]) &&
          a.length === 3 &&
          a[1]?.length === 1 &&
          a[1][0] === null &&
          a[2] === null)
      )
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      paths.push({ i, state, ...paint })
    }
    const results = []
    for (const scope of scopes) {
      if (!Number.isInteger(scope.end)) continue
      const paints = paths.filter((q) => q.i > scope.start && q.i < scope.end),
        records = p.records.filter((r) =>
          r.part.every((z) => z.g.i > scope.start && z.g.i < scope.end)
        )
      if (paints.length < 3 || records.length < 3 || records.length > 64) continue
      // Canonical decomposition may repeat a glyph inside one literal record;
      // distinct whole source items may not both claim that same painted glyph.
      if (records.some((r) => r.part.some((z) => sharedGlyphs.has(z.g)))) continue
      const ownedGlyphs = new Set(records.flatMap((r) => r.part.map((z) => z.g)))
      // A closed program must not hide an unclaimed glyph elsewhere in the
      // same save scope, even if that glyph falls outside the proposed crop.
      if (paintedGlyphs.some((g) => g.i > scope.start && g.i < scope.end && !ownedGlyphs.has(g)))
        continue
      if (
        records.some((r) =>
          r.part.some(
            (z) =>
              z.g.packet.start <= scope.start ||
              z.g.packet.end >= scope.end ||
              z.g.textPaint?.fillAlpha !== 1 ||
              z.g.textPaint.fillColor?.toLowerCase() === '#ffffff'
          )
        )
      )
        continue
      if (
        paints.some(
          (q) =>
            ![q.state.fillAlpha, q.state.strokeAlpha].every(
              (a) => Number.isFinite(a) && a >= 0 && a <= 1
            )
        )
      )
        continue
      const rect = union([...paints.map((q) => q.rect), ...records.map(full)]),
        em = Math.max(...records.map((r) => r.r.height)),
        scale = Math.ceil(page.width * 1.5) / page.width,
        padded = expand(rect, 2 / scale)
      if (
        rect[2] - rect[0] < (figure.caption.rect[2] - figure.caption.rect[0]) * 0.5 ||
        rect[3] - rect[1] < em * 5 ||
        rect[3] >= figure.caption.rect[1] ||
        figure.caption.rect[1] - rect[3] > em * 4 ||
        !inside([0, 0, page.width, page.height], padded) ||
        (figure.rect && overlap(rect, figure.rect) / area(figure.rect) < 0.9)
      )
        continue
      if (
        captions.some((c) => c.page === page.pageNumber && hit(padded, c.rect)) ||
        tables.some((t) => hit(padded, t))
      )
        continue
      if (figure.rect && records.every((r) => inside(expand(figure.rect, 2 / scale), full(r))))
        continue
      if (
        (figure.sourceItems ?? []).some(
          (s) => !records.some((r) => JSON.stringify(r.r.sourceItem) === JSON.stringify(s))
        )
      )
        continue
      const foreignPaints = p.records
        .filter((r) => !records.includes(r))
        .map((r) => ({ rect: full(r), floor: 0 }))
      foreignPaints.push(
        ...paths.filter((q) => !paints.includes(q)).map((q) => ({ rect: q.rect, floor: q.floor }))
      )
      foreignPaints.push(...unboundGlyphs.map((g) => ({ rect: g.ink, floor: 0 })))
      if (foreignPaints.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale)))) continue
      const identity =
        paints.map((q) => q.i).join(',') + '|' + records.map((r) => r.index).join(',')
      // Nested saves enclosing the exact same complete program are one owner.
      if (results.some((r) => r.identity === identity)) continue
      results.push({
        identity,
        rect,
        sourceItems: records.map((r) => r.r.sourceItem),
        formCropRaster: { ownedRects: [rect], foreignPaints },
        graphicsCount: paints.length
      })
    }
    if (results.length !== 1) return
    const result = { ...results[0] }
    delete result.identity
    return result
  } catch {
    return
  }
}
