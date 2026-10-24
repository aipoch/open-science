/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { intersection, union, area } from './literature-pdf-page-geometry.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { getInitialPdfCropRaster } from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const letters = (s) => Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))
const box = (r, m) => {
  const points = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]]
  ]
  for (const p of points) Util.applyTransform(p, m)
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
}

// A native Form has its own renderer-enforced BBox. This proof isolates a
// captioned vector body without interpreting its glyph ink. Outside glyphs
// still need their complete loaded outlines before excluding adjacent prose.
function captionedFormProgram(page, tokens, context) {
  const o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items
  if (
    page.invalidGraphicsBounds !== 0 ||
    ![tokens, raw, page.graphicsBounds, context?.graphicsBounds, o?.fnArray, o?.argsArray].every(
      Array.isArray
    ) ||
    !equal(context.graphicsBounds, page.graphicsBounds) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    v?.width !== page.width ||
    v.height !== page.height ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    !equal(v.transform, [1, 0, 0, -1, 0, page.height])
  )
    return
  const viewport = { ...v, convertToViewportPoint: (x, y) => [x, page.height - y] }
  const paint = new Map()
  for (const g of page.graphicsBounds) {
    if (
      !Number.isInteger(g.operationIndex) ||
      paint.has(g.operationIndex) ||
      !['image', 'path'].includes(g.kind) ||
      !valid(g.normalizedRect)
    )
      return
    const rect = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (!inside([0, 0, page.width, page.height], rect)) return
    paint.set(g.operationIndex, { ...g, rect })
  }
  const outsidePaint = []
  const forms = [],
    stack = [],
    chars = [],
    glyphs = []
  let state = { ctm: [1, 0, 0, 1, 0, 0], font: undefined, size: 0 },
    form,
    text = false,
    matrix = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lineX = 0,
    lineY = 0,
    marked = 0
  const plain = new Set([
    OPS.dependency,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.setLineWidth,
    OPS.setLineJoin,
    OPS.setLineCap,
    OPS.setMiterLimit,
    OPS.setDash,
    OPS.clip,
    OPS.eoClip,
    OPS.setRenderingIntent
  ])
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (text) return
      stack.push({ state: { ...state, ctm: [...state.ctm] }, op })
      if (op === OPS.paintFormXObjectBegin) {
        if (
          form ||
          a?.[0] !== null ||
          !valid(a?.[1]) ||
          !finite(state.ctm, 6) ||
          state.ctm[0] <= 0 ||
          state.ctm[3] <= 0 ||
          state.ctm[1] !== 0 ||
          state.ctm[2] !== 0
        )
          return
        const rect = box(a[1], Util.transform(v.transform, state.ctm))
        if (!valid(rect) || !inside([0, 0, page.width, page.height], rect)) return
        form = { begin: i, rect, paint: [], records: [] }
        forms.push(form)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const previous = stack.pop(),
        begin = op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin
      if (text || !previous || previous.op !== begin) return
      if (op === OPS.paintFormXObjectEnd) {
        if (!form || marked) return
        form.end = i
        form = undefined
      }
      state = previous.state
    } else if (op === OPS.transform) {
      if (text || !finite(a, 6)) return
      state.ctm = Util.transform(state.ctm, a)
    } else if (op === OPS.beginText) {
      if (text) return
      text = true
      matrix = [1, 0, 0, 1, 0, 0]
      x = y = lineX = lineY = 0
    } else if (op === OPS.endText) {
      if (!text) return
      text = false
    } else if (op === OPS.setFont) {
      if (!text || typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.setTextMatrix) {
      const m = a?.length === 1 ? a[0] : a
      if (!text || !finite(m, 6)) return
      matrix = m
      x = y = lineX = lineY = 0
    } else if (op === OPS.moveText) {
      if (!text || !finite(a, 2)) return
      x = lineX += a[0]
      y = lineY += a[1]
    } else if (op === OPS.showText) {
      if (!text || !state.font || !(state.size > 0) || !Array.isArray(a?.[0])) return
      const m = Util.transform(v.transform, Util.transform(state.ctm, matrix))
      if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
      for (const glyph of a[0]) {
        if (typeof glyph === 'number') {
          if (!Number.isFinite(glyph)) return
          x -= (glyph * state.size) / 1000
          continue
        }
        if (
          typeof glyph?.unicode !== 'string' ||
          !Number.isFinite(glyph.width) ||
          glyph.width < 0 ||
          glyph.accent != null ||
          glyph.vmetric != null ||
          glyph.operatorListId != null
        )
          return
        const advance = box([x, y, x + (glyph.width * state.size) / 1000, y + state.size], m),
          native = {
            form,
            font: state.font,
            advance,
            glyph,
            origin: [x, y],
            matrix: m,
            size: state.size
          }
        glyphs.push(native)
        for (const c of letters(glyph.unicode))
          chars.push({
            c,
            ...native
          })
        x += (glyph.width * state.size) / 1000
      }
    } else if (op === OPS.constructPath || op === OPS.paintImageXObject) {
      if (text) return
      if (
        op === OPS.constructPath &&
        (![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0]) ||
          !(Array.isArray(a[1]?.[0]) || ArrayBuffer.isView(a[1]?.[0])) ||
          !a[1][0].length ||
          !a[1][0].every(Number.isFinite) ||
          !finite(a[2], 4))
      )
        return
      if (op === OPS.constructPath && a?.[0] === OPS.endPath) continue
      const g = paint.get(i)
      if (
        !g ||
        g.kind !== (op === OPS.constructPath ? 'path' : 'image') ||
        (form && intersection(form.rect, g.rect) <= 0)
      )
        return
      if (form) form.paint.push(g)
      else outsidePaint.push(g)
      paint.delete(i)
    } else if (op === OPS.beginMarkedContentProps) {
      if (
        !form ||
        !(
          (a?.[0] === 'P' && Number.isInteger(a[1]) && a[1] >= 0) ||
          (a?.[0] === 'Span' && a[1] == null)
        )
      )
        return
      marked++
    } else if (op === OPS.endMarkedContent) {
      if (!marked) return
      marked--
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            !(
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (['ca', 'CA'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false) ||
              (['LC', 'LJ'].includes(e[0]) && [0, 1, 2].includes(e[1])) ||
              (e[0] === 'LW' && Number.isFinite(e[1]) && e[1] >= 0) ||
              (e[0] === 'ML' && Number.isFinite(e[1]) && e[1] >= 1)
            )
        )
      )
        return
    } else if (!plain.has(op) || (!form && [OPS.clip, OPS.eoClip].includes(op))) return
  }
  if (text || stack.length || form || marked || paint.size || forms.length !== 1) return
  const records = [],
    recordIndices = new Set(),
    byIndex = new Map()
  for (const token of tokens) {
    const key = token.sourceItem?.index
    if (!Number.isInteger(key) || byIndex.has(key) || token.sourceSegment) return
    byIndex.set(key, token)
  }
  let offset = 0
  for (const [index, r] of raw.entries()) {
    if (typeof r.str !== 'string') return
    const cs = letters(r.str)
    if (!cs.length) continue
    const part = chars.slice(offset, offset + cs.length),
      source = r.sourceItem
    offset += cs.length
    if (
      source?.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== r.str ||
      !finite(r.transform, 6) ||
      !(r.width >= 0) ||
      !(r.height > 0) ||
      part.map((p) => p.c).join('') !== cs.join('') ||
      part.some((p) => p.font !== r.fontName || p.form !== part[0].form)
    )
      return
    const token = tableTextToken(r, viewport, 0),
      bounds = union(part.map((p) => p.advance)),
      supplied = byIndex.get(index)
    if (
      (!valid(token.rect) && !(r.width === 0 && part.every((p) => p.glyph.width === 0))) ||
      bounds.some((n, i) => Math.abs(n - token.rect[i]) > 0.02) ||
      (supplied &&
        (supplied.text !== r.str ||
          supplied.sourceItem.text !== r.str ||
          supplied.sourceItem.pageNumber !== page.pageNumber ||
          (!valid(supplied.rect) &&
            !(
              r.width === 0 &&
              finite(supplied.rect, 4) &&
              supplied.rect[0] === supplied.rect[2] &&
              supplied.rect[1] < supplied.rect[3]
            )) ||
          supplied.rect.some((n, i) => Math.abs(n - token.rect[i]) > 1e-6)))
    )
      return
    const record = {
      r,
      part,
      index,
      token,
      form: part[0].form,
      label: nativeFigureLabelBounds(r, context.content.styles?.[r.fontName], viewport)
    }
    if (record.form) {
      if (
        !supplied ||
        r.dir !== 'ltr' ||
        !valid(record.label) ||
        !inside(record.form.rect, token.rect) ||
        !inside(record.form.rect, record.label)
      )
        return
      record.form.records.push(record)
    }
    records.push(record)
    recordIndices.add(index)
  }
  if (offset !== chars.length || [...byIndex.keys()].some((index) => !recordIndices.has(index)))
    return
  const raster = getInitialPdfCropRaster(forms[0].rect, page)
  if (!raster || !Array.isArray(context.glyphBounds)) return
  const fontMap = new Map()
  for (const f of context.glyphBounds) {
    if (typeof f?.fontName !== 'string' || fontMap.has(f.fontName) || !Array.isArray(f.glyphs))
      return
    const glyphs = new Map()
    for (const g of f.glyphs) {
      if (
        typeof g?.fontChar !== 'string' ||
        glyphs.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      glyphs.set(g.fontChar, g.bounds)
    }
    fontMap.set(f.fontName, glyphs)
  }
  const ink = (p) => {
    const b = fontMap.get(p.font)?.get(p.glyph.fontChar)
    if (p.glyph.isInFont !== true || !finite(b, 4)) return
    return box(
      [
        p.origin[0] + b[0] * p.size,
        p.origin[1] + b[1] * p.size,
        p.origin[0] + b[2] * p.size,
        p.origin[1] + b[3] * p.size
      ],
      p.matrix
    )
  }
  // Whitespace is omitted only from source-string comparison. A loaded space
  // can still paint ink, so every outside glyph must remain disjoint as well.
  for (const g of glyphs) {
    if (g.form) continue
    const rect = ink(g)
    if (!rect || intersection(rect, forms[0].rect) > 0 || intersection(rect, raster.protection) > 0)
      return
  }
  for (const r of records) {
    if (r.form) continue
    r.ink = union(r.part.map(ink))
  }
  if (outsidePaint.some((p) => intersection(p.rect, forms[0].rect) > 0)) return
  if (outsidePaint.some((p) => intersection(p.rect, raster.protection) > 0)) return
  return { forms, records, outsidePaint, raster }
}

export function nativeCaptionedFormScope(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    figure.sourceItems?.length ||
    figure.reason ||
    figure.issue ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !/^Figure\s+\d+[.:]/u.test(cap.lines?.[0] ?? '')
  )
    return
  const p = captionedFormProgram(page, tokens, context)
  if (!p) return
  const form = p.forms[0],
    rect = form.rect,
    lead = p.records
      .filter(
        (r) =>
          !r.form &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    !lead.length ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01) ||
    !Number.isFinite(height) ||
    cap.rect[2] - cap.rect[0] > page.width * 0.5 ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 4 ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.5 ||
    Math.abs(rect[2] - cap.rect[2]) > height * 0.5 ||
    !form.records.length ||
    form.paint.length < 3 ||
    form.paint.some((g) => g.kind !== 'path') ||
    tables.some((t) => intersection(t, rect) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, rect) > 0) ||
    !form.paint.some((g) => intersection(g.rect, figure.rect) > 0) ||
    !p.outsidePaint.some((g) => intersection(g.rect, figure.rect) > 0) ||
    !p.records.some((r) => !r.form && intersection(r.ink, figure.rect) > 0) ||
    intersection(rect, figure.rect) / Math.min(area(rect), area(figure.rect)) < 0.5
  )
    return
  return {
    ...figure,
    rect: [...rect],
    graphicsCount: form.paint.length,
    raster: p.raster,
    reason: 'native-captioned-form-scope'
  }
}
