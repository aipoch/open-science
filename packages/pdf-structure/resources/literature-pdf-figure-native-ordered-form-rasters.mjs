/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { nativeCompleteFormCropPngSafe } from './literature-pdf-figure-native-complete-form.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n))
const compact = (s) => s.replace(/\s/gu, '')
const positive = (g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3]
function deriveOrderedForms(page, f, captions, tables, tokens, context) {
  if (
    f.sourceItems?.length ||
    !f.rect ||
    !f.caption?.rect ||
    f.caption.regions ||
    f.parts ||
    f.cropRects ||
    f.headerRaster ||
    f.fallbackFigure
  )
    return
  const p = nativePageTextPacketInventory(page, tokens, context, true)
  if (!p) return
  if (
    p.records.length > 4096 ||
    p.evidence.paths.size > 4096 ||
    p.evidence.images.length < 2 ||
    p.evidence.images.length > 64
  )
    return
  if (p.o.fnArray.some((op) => [OPS.beginGroup, OPS.endGroup].includes(op))) return
  const forms = [],
    stack = [],
    states = new Map()
  let m = [1, 0, 0, 1, 0, 0],
    active,
    fill = '#000000',
    stroke = '#000000',
    fillAlpha = 1,
    strokeAlpha = 1
  for (let i = 0; i < p.o.fnArray.length; i++) {
    const op = p.o.fnArray[i],
      a = p.o.argsArray[i]
    if ([OPS.save, OPS.paintFormXObjectBegin].includes(op)) {
      stack.push({ op, m, active, fill, stroke, fillAlpha, strokeAlpha })
      if (op === OPS.paintFormXObjectBegin) {
        if (active) return
        if (a?.[0]) {
          if (!p.finite(a[0], 6)) return
          m = Util.transform(m, a[0])
        }
        if (!p.finite(a?.[1], 4)) return
        const rect = p.box(a[1], Util.transform(p.v.transform, m))
        if (!p.valid(rect)) return
        active = { start: i, rect }
        forms.push(active)
      }
    } else if ([OPS.restore, OPS.paintFormXObjectEnd].includes(op)) {
      if (op === OPS.paintFormXObjectEnd) {
        if (!active) return
        active.end = i
      }
      const s = stack.pop()
      if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      ;({ m, active, fill, stroke, fillAlpha, strokeAlpha } = s)
    } else if (op === OPS.transform) {
      if (!p.finite(a, 6)) return
      m = Util.transform(m, a)
    } else if (op === OPS.setFillRGBColor) fill = a?.[0]
    else if (op === OPS.setStrokeRGBColor) stroke = a?.[0]
    else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(([k, v]) => !['ca', 'CA'].includes(k) || ![0, 1].includes(v))
      )
        return
      for (const [k, v] of a[0]) {
        if (k === 'ca') fillAlpha = v
        else strokeAlpha = v
      }
    } else if (op === OPS.paintImageXObject && fillAlpha !== 1) return
    else if (op === OPS.constructPath) states.set(i, { fill, stroke })
  }
  if (stack.length || forms.length !== 2 || forms.some((q) => !Number.isInteger(q.end))) return
  const cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
  if (
    !cap.length ||
    compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join(''))
  )
    return
  const capStart = Math.min(...cap.flatMap((r) => r.part.map((z) => z.g.i)))
  const full = (r) => {
    const s = context.content.styles[r.r.fontName]
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
    return b && union([r.rect, b, ...r.part.map((z) => z.g.ink)])
  }
  const domains = new Map(p.records.map((r) => [r, full(r)]))
  if ([...domains.values()].some((r) => !p.valid(r))) return
  const used = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (used.has(g)) return
      used.set(g, r)
    }
  const owned = [],
    ownedGlyphs = new Set(),
    ownedRects = [],
    foreignPaints = [],
    paints = []
  for (const [n, form] of forms.entries()) {
    const belongs = (i) => i > form.start && i < form.end,
      end = forms[n + 1]?.start ?? capStart
    if (form.end >= end || (n > 0 && form.rect[1] <= forms[n - 1].rect[3])) return
    const rs = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
    if (
      !rs.length ||
      rs.some(
        (r) =>
          !r.part.every((z) => belongs(z.g.i)) ||
          !inside(form.rect, r.rect) ||
          !r.part.every((z) => inside(form.rect, z.g.ink))
      )
    )
      return
    const keys = p.records.filter((r) => r.part.every((z) => z.g.i > form.end && z.g.i < end))
    if (
      keys.length !== 1 ||
      !new RegExp(`^\\(${String.fromCharCode(97 + n)}\\)\\s+\\p{L}`, 'u').test(keys[0].r.str) ||
      keys[0].rect[1] < form.rect[3] ||
      keys[0].rect[1] - form.rect[3] > 2 * keys[0].r.height ||
      keys[0].rect[3] >= f.caption.rect[1]
    )
      return
    const group = [...rs, ...keys],
      glyphs = new Set(group.flatMap((r) => r.part.map((z) => z.g)))
    if (p.glyphs.some((g) => positive(g) && g.i > form.start && g.i < end && !glyphs.has(g))) return
    if (
      group.some((r) =>
        r.part.some(
          ({ g }) =>
            g.textPaint.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
            g.textPaint.fillColor.toLowerCase() === '#ffffff'
        )
      )
    )
      return
    const ims = p.evidence.images.filter((im) => belongs(im.operationIndex))
    if (!ims.length || ims.some((im) => !inside(form.rect, im.rect))) return
    for (const im of ims) {
      const a = p.o.argsArray[im.operationIndex],
        raw = context.opaqueRasterImages.filter((q) => q.operationIndex === im.operationIndex)
      if (
        p.o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
        raw.length !== 1 ||
        raw[0].imageId !== a[0] ||
        raw[0].width !== a[1] ||
        raw[0].height !== a[2] ||
        raw[0].kind !== 2
      )
        return
    }
    owned.push(...group)
    for (const g of glyphs) ownedGlyphs.add(g)
    ownedRects.push(...ims.map((im) => im.rect), ...group.map((r) => domains.get(r)))
  }
  const belongs = (i) => forms.some((q) => i > q.start && i < q.end)
  if (p.evidence.images.some((im) => !belongs(im.operationIndex))) return
  let ownedPaths = 0
  for (const [i, s] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) {
      continue
    }
    const q = nativeFigurePathPaint(p, i, s),
      colors = states.get(i)
    if (!q || !p.valid(q.rect)) return
    if (belongs(i)) {
      if (
        ![0, 1].includes(s.fillAlpha) ||
        ![0, 1].includes(s.strokeAlpha) ||
        !s.solidStroke ||
        !/^#[a-f0-9]{6}$/iu.test(colors?.fill) ||
        !/^#[a-f0-9]{6}$/iu.test(colors?.stroke)
      )
        return
      ownedRects.push(q.rect)
      paints.push({ i, state: s, ...q })
      ownedPaths++
    } else foreignPaints.push(q)
  }
  if (
    p.glyphs.some((g) => {
      const s = context.content.styles[g.fontName]
      return (
        positive(g) &&
        (!Number.isFinite(s?.ascent) ||
          s.ascent <= 0 ||
          s.ascent > 2 ||
          !Number.isFinite(s.descent) ||
          s.descent > 0 ||
          s.descent < -2)
      )
    })
  )
    return
  const ownedSet = new Set(owned)
  foreignPaints.push(
    ...p.records.filter((r) => !ownedSet.has(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownedGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  const rect = union(ownedRects),
    scale = Math.ceil(page.width * 1.5) / page.width,
    padded = expand(rect, 2 / scale)
  if (
    !inside([0, 0, page.width, page.height], padded) ||
    foreignPaints.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
    tables.some((t) => hit(t, padded)) ||
    captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded))
  )
    return
  if (
    p.evidence.images.every((im) => inside(f.rect, im.rect)) &&
    [...ownedGlyphs].filter(positive).every((g) => inside(f.rect, g.ink))
  )
    return
  const sourceItems = owned.map((r) => r.r.sourceItem).sort((a, b) => a.index - b.index),
    tokenMap = new Map()
  for (const t of tokens) {
    const index = t.sourceItem?.index
    if (!tokenMap.has(index)) tokenMap.set(index, [])
    tokenMap.get(index).push(t)
  }
  if (
    new Set(sourceItems.map((s) => s.index)).size !== sourceItems.length ||
    sourceItems.some(
      (s) =>
        tokenMap.get(s.index)?.length !== 1 || tokenMap.get(s.index)[0].sourceItem.text !== s.text
    )
  )
    return
  return {
    paints,
    packet: p,
    rect,
    sourceItems,
    graphicsCount: p.evidence.images.length + ownedPaths,
    formCropRaster: { ownedRects, foreignPaints }
  }
}

const certificates = new WeakMap()
export function nativeOrderedFormRasterCrop(page, figure, captions, tables, tokens, context) {
  try {
    if (page.invalidGraphicsBounds !== 0 || page.rotation !== 0) return
    const result = deriveOrderedForms(page, figure, captions, tables, tokens, context)
    if (!result) return
    const binding = () =>
        createHash('sha256')
          .update(JSON.stringify([page, figure, captions, tables, tokens, context]))
          .digest('hex'),
      nativeBinding = binding()
    const output = {
      rect: result.rect,
      sourceItems: result.sourceItems,
      graphicsCount: result.graphicsCount,
      formCropRaster: result.formCropRaster,
      orderedFormRaster: true
    }
    certificates.set(output.formCropRaster, {
      page,
      binding,
      nativeBinding,
      outputBinding: JSON.stringify(output),
      paints: result.paints,
      packet: result.packet
    })
    return output
  } catch {
    return
  }
}
export function nativeOrderedFormRasterPngSafe(png, rect, page, candidate) {
  const proof = certificates.get(candidate?.formCropRaster)
  if (!proof) return candidate?.orderedFormRaster ? false : undefined
  try {
    const projection = {
      rect: candidate.rect,
      sourceItems: candidate.sourceItems,
      graphicsCount: candidate.graphicsCount,
      formCropRaster: candidate.formCropRaster,
      orderedFormRaster: candidate.orderedFormRaster
    }
    if (
      page !== proof.page ||
      proof.binding() !== proof.nativeBinding ||
      JSON.stringify(projection) !== proof.outputBinding
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || !nativeCompleteFormCropPngSafe(png, rect, page, candidate)) return false
    return proof.paints.every((q) => {
      let paint = q
      const matrix = Util.transform(proof.packet.v.transform, q.state.transform)
      if (matrix[1] === 0 && matrix[2] === 0 && matrix[0] > 0 && matrix[0] === -matrix[3]) {
        const bounded = nativeFigurePathPaint(proof.packet, q.i, {
          ...q.state,
          lineWidth: Math.max(q.state.lineWidth, 1 / (raster.scaleLower * matrix[0]))
        })
        paint = bounded && { rect: bounded.rect, floor: 0 }
      }
      return paint && inside(rect, expand(paint.rect, (paint.floor + 1) / raster.scaleLower))
    })
  } catch {
    return false
  }
}
