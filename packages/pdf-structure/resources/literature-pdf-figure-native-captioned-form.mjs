/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { Path2D } from '@napi-rs/canvas'
import { types } from 'node:util'
import { intersection, union, area } from './literature-pdf-page-geometry.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  collectClosedFigureFrames,
  collectOriginalRasterHeaderFrames
} from './literature-pdf-graphics.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { verifyNativeDualApiCertificate } from './literature-pdf-native-dual-api-certificate.mjs'
import {
  getInitialPdfCropRaster,
  getPdfCropRasterProtectionFromPng
} from './literature-pdf-crop.mjs'
import {
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const letters = (s) => Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))
const pixelCropMode = Symbol('complete Form pixel crop'),
  pixelCrops = new WeakMap()
const originalRasterHeaderMode = Symbol('original raster header source')
const expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n))
const nonwhite = (color, alpha) =>
  alpha > 0 && /^#[a-f0-9]{6}$/iu.test(color) && color.toLowerCase() !== '#ffffff'
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
function captionedFormProgram(page, tokens, context, mode, literalCertificate) {
  const originalHeaders = mode === originalRasterHeaderMode,
    pixels = mode === pixelCropMode || originalHeaders
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
  const clips = originalHeaders
    ? collectOriginalRasterHeaderFrames(o, v)
    : pixels
      ? {
          images: [],
          paths: new Map(),
          texts: new Map(),
          frames: new Map(),
          isolatedGroups: new Map()
        }
      : undefined
  if (clips && !originalHeaders) collectClosedFigureFrames(o, v, clips)
  if (
    clips &&
    (clips.invalidIsolatedGroups ||
      clips.isolatedGroups.size > 1 ||
      [...clips.isolatedGroups.values()].some(
        (g) =>
          !Number.isSafeInteger(g.end) ||
          o.fnArray[g.begin + 1] !== OPS.paintFormXObjectBegin ||
          o.fnArray[g.end - 1] !== OPS.paintFormXObjectEnd ||
          !equal(o.argsArray[g.begin + 1], [null, null])
      ))
  )
    return
  const forms = [],
    stack = [],
    chars = [],
    glyphs = []
  let state = {
      ctm: [1, 0, 0, 1, 0, 0],
      font: undefined,
      size: 0,
      fillColor: '#000000',
      strokeColor: '#000000',
      fillAlpha: 1,
      strokeAlpha: 1,
      leading: 0,
      charSpacing: 0
    },
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
    if (op === OPS.save || op === OPS.paintFormXObjectBegin || (pixels && op === OPS.beginGroup)) {
      if (text) return
      stack.push({ state: { ...state, ctm: [...state.ctm] }, op, form, marked })
      if (op === OPS.beginGroup) {
        if (!clips.isolatedGroups.has(i)) return
        state.fillAlpha = state.strokeAlpha = 1
      }
      if (op === OPS.paintFormXObjectBegin) {
        const groupBoundary =
          pixels && !form && equal(a, [null, null]) ? clips.isolatedGroups.get(i - 1) : undefined
        if (
          (!pixels && form) ||
          (a?.[0] !== null &&
            (!pixels ||
              !finite(a[0], 6) ||
              (!form && !equal(Array.from(a[0]), [1, 0, 0, 1, 0, 0])) ||
              Math.abs(a[0][0] * a[0][3] - a[0][1] * a[0][2]) < 1e-12)) ||
          (!groupBoundary && !valid(a?.[1])) ||
          (groupBoundary && !valid(groupBoundary.clip)) ||
          !finite(state.ctm, 6) ||
          Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2]) < 1e-12 ||
          (!pixels &&
            !form &&
            (state.ctm[0] <= 0 || state.ctm[3] <= 0 || state.ctm[1] !== 0 || state.ctm[2] !== 0))
        )
          return
        if (a[0] !== null) state.ctm = Util.transform(state.ctm, a[0])
        const rect = groupBoundary
          ? [...groupBoundary.clip]
          : box(a[1], Util.transform(v.transform, state.ctm))
        if (!valid(rect) || (!pixels && !inside([0, 0, page.width, page.height], rect))) return
        // Nested programs remain clipped by the complete enclosing root Form.
        // They grant no independent Source or crop ownership.
        if (!form) {
          form = {
            begin: i,
            rect,
            paint: [],
            records: [],
            ...(groupBoundary
              ? {
                  pixelBoundary: {
                    kind: 'isolated-group-clip',
                    begin: groupBoundary.begin,
                    end: groupBoundary.end,
                    minimumScale: 1.5
                  }
                }
              : {})
          }
          forms.push(form)
        }
      }
    } else if (
      op === OPS.restore ||
      op === OPS.paintFormXObjectEnd ||
      (pixels && op === OPS.endGroup)
    ) {
      const previous = stack.pop(),
        begin =
          op === OPS.restore
            ? OPS.save
            : op === OPS.endGroup
              ? OPS.beginGroup
              : OPS.paintFormXObjectBegin
      if (text || !previous || previous.op !== begin) return
      if (op === OPS.paintFormXObjectEnd) {
        if (!form || marked !== previous.marked) return
        if (form.pixelBoundary && !previous.form && i !== form.pixelBoundary.end - 1) return
        if (!previous.form) form.end = i
        form = previous.form
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
      // PDF.js emits a harmless empty ET around some embedded drawing labels.
      // No text-clipping mode is admitted, and the enclosing Form stays closed.
      if (!text && (!pixels || !form)) return
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
    } else if (pixels && op === OPS.setLeading) {
      if (!text || !finite(a, 1)) return
      state.leading = a[0]
    } else if (pixels && op === OPS.setCharSpacing) {
      if (!text || !finite(a, 1)) return
      state.charSpacing = a[0]
    } else if (pixels && op === OPS.nextLine) {
      if (!text || (a !== null && (!Array.isArray(a) || a.length))) return
      x = lineX
      y = lineY -= state.leading
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
          ((!pixels || !form) &&
            (glyph.accent != null || glyph.vmetric != null || glyph.operatorListId != null))
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
            size: state.size,
            visible: nonwhite(state.fillColor, state.fillAlpha),
            ...(pixels
              ? {
                  opaque: state.fillAlpha === 1,
                  clip: clips.texts.get(i)?.clip,
                  charSpacing: state.charSpacing
                }
              : {})
          }
        glyphs.push(native)
        for (const c of letters(glyph.unicode))
          chars.push({
            c,
            ...native
          })
        x += (glyph.width * state.size) / 1000 + state.charSpacing
      }
    } else if (op === OPS.constructPath || op === OPS.paintImageXObject) {
      if (text) return
      if (
        pixels &&
        op === OPS.constructPath &&
        a?.length === 3 &&
        a[0] === OPS.endPath &&
        Array.isArray(a[1]) &&
        a[1].length === 1 &&
        a[1][0] === null &&
        a[2] === null &&
        !paint.has(i)
      )
        continue
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
      if (!g && pixels && form && op === OPS.constructPath) {
        // A complete inner path can be clipped away by a curved clip. Retain
        // its entire root domain; absence from renderer paint bounds never
        // proves empty ink and never supplies the missing-glyph witness.
        form.paint.push({ operationIndex: i, kind: 'path', rect: form.rect })
        continue
      }
      if (
        !g ||
        g.kind !== (op === OPS.constructPath ? 'path' : 'image') ||
        (form && intersection(form.rect, g.rect) <= 0)
      )
        return
      if (form && originalHeaders) {
        const visible =
          op === OPS.paintImageXObject ||
          ([
            OPS.fill,
            OPS.eoFill,
            OPS.fillStroke,
            OPS.eoFillStroke,
            OPS.closeFillStroke,
            OPS.closeEOFillStroke
          ].includes(a[0]) &&
            nonwhite(state.fillColor, state.fillAlpha)) ||
          ([
            OPS.stroke,
            OPS.closeStroke,
            OPS.fillStroke,
            OPS.eoFillStroke,
            OPS.closeFillStroke,
            OPS.closeEOFillStroke
          ].includes(a[0]) &&
            nonwhite(state.strokeColor, state.strokeAlpha))
        const entry = clips.paths.get(i),
          physical =
            op === OPS.constructPath &&
            entry &&
            nativeFigurePathPaint({ o, v, finite, valid, box, strokeMargins: new Map() }, i, entry)
        if (op === OPS.constructPath && (!physical || !valid(physical.rect) || !valid(entry.clip)))
          return
        form.paint.push({ ...g, visible, ...(physical ? { rect: physical.rect } : {}) })
      } else if (form) form.paint.push(g)
      else {
        let physical
        if (pixels && op === OPS.constructPath && [OPS.fill, OPS.eoFill].includes(a[0])) {
          const entry = clips.paths.get(i)
          physical =
            entry &&
            nativeFigurePathPaint({ o, v, finite, valid, box, strokeMargins: new Map() }, i, entry)
          if (!physical || !valid(physical.rect) || physical.floor !== 0) return
        }
        outsidePaint.push(
          pixels
            ? {
                ...g,
                ...(physical ? { rect: physical.rect } : {}),
                visible:
                  op === OPS.constructPath &&
                  (([
                    OPS.stroke,
                    OPS.closeStroke,
                    OPS.fillStroke,
                    OPS.eoFillStroke,
                    OPS.closeFillStroke,
                    OPS.closeEOFillStroke
                  ].includes(a[0]) &&
                    nonwhite(state.strokeColor, state.strokeAlpha)) ||
                    ([
                      OPS.fill,
                      OPS.eoFill,
                      OPS.fillStroke,
                      OPS.eoFillStroke,
                      OPS.closeFillStroke,
                      OPS.closeEOFillStroke
                    ].includes(a[0]) &&
                      nonwhite(state.fillColor, state.fillAlpha)))
              }
            : g
        )
      }
      paint.delete(i)
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      state[op === OPS.setFillRGBColor ? 'fillColor' : 'strokeColor'] = a?.[0]
    } else if (originalHeaders && op === OPS.beginMarkedContent) {
      if (!form || a?.length !== 1 || a[0]?.name !== 'Artifact' || marked >= 32) return
      marked++
    } else if (op === OPS.beginMarkedContentProps) {
      if (
        !form ||
        !(
          (a?.[0] === 'P' && Number.isInteger(a[1]) && a[1] >= 0) ||
          (a?.[0] === 'Span' &&
            (a[1] == null || (originalHeaders && Number.isSafeInteger(a[1]) && a[1] >= 0)))
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
      for (const [key, value] of a[0]) {
        if (key === 'ca') state.fillAlpha = value
        if (key === 'CA') state.strokeAlpha = value
      }
    } else if (!plain.has(op) || (!pixels && !form && [OPS.clip, OPS.eoClip].includes(op))) return
  }
  if (
    text ||
    stack.length ||
    form ||
    marked ||
    paint.size ||
    (pixels ? forms.length < 1 || forms.length > 64 : forms.length !== 1)
  )
    return
  const records = [],
    recordIndices = new Set(),
    byIndex = new Map()
  for (const token of tokens) {
    const key = token.sourceItem?.index
    if (!Number.isInteger(key) || byIndex.has(key) || token.sourceSegment) return
    byIndex.set(key, token)
  }
  let offset = 0
  const capturedGlyph = (p) =>
    (context.glyphBounds ?? context.partialFontGlyphBounds)
      ?.find((f) => f.fontName === p.font)
      ?.glyphs.find((g) => g.fontChar === p.glyph.fontChar)?.bounds
  for (const [index, r] of raw.entries()) {
    if (typeof r.str !== 'string') return
    const cs = letters(r.str)
    if (!cs.length) continue
    const part = chars.slice(offset, offset + cs.length),
      source = r.sourceItem,
      pair = pixels && literalCertificate?.get(index),
      exactPair =
        pair &&
        pair.normal === r.str &&
        part.length === 1 &&
        part[0].c === pair.raw &&
        part[0].glyph.unicode === pair.raw &&
        part[0].glyph.isInFont === true &&
        Number.isSafeInteger(part[0].glyph.originalCharCode) &&
        part[0].glyph.originalCharCode >= 0 &&
        part[0].glyph.width > 0 &&
        part[0].glyph.accent == null &&
        part[0].glyph.vmetric == null &&
        part[0].glyph.operatorListId == null &&
        finite(capturedGlyph(part[0]), 4)
    offset += cs.length
    if (
      source?.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== r.str ||
      !finite(r.transform, 6) ||
      !(r.width >= 0) ||
      !(r.height > 0) ||
      (part.map((p) => p.c).join('') !== cs.join('') && !exactPair) ||
      part.some((p) => p.font !== r.fontName || p.form !== part[0].form)
    )
      return
    const token = tableTextToken(r, viewport, 0),
      bounds = union(part.map((p) => p.advance)),
      supplied = byIndex.get(index),
      // A quarter-turn zero advance is a horizontal line in page space.
      // It remains opaque Form content, never a new Source claim.
      rotatedZeroAdvance =
        pixels &&
        part[0].form &&
        r.width === 0 &&
        r.transform[0] === 0 &&
        r.transform[3] === 0 &&
        r.transform[1] !== 0 &&
        r.transform[1] === -r.transform[2] &&
        token.rect[1] === token.rect[3] &&
        token.rect[0] < token.rect[2] &&
        bounds[1] === bounds[3] &&
        bounds.every((n, i) => Math.abs(n - token.rect[i]) <= 1e-6) &&
        part.every(
          (p) =>
            p.glyph.width === 0 &&
            p.glyph.isInFont === true &&
            p.glyph.accent == null &&
            p.glyph.vmetric == null &&
            p.glyph.operatorListId == null &&
            finite(capturedGlyph(p), 4) &&
            valid(p.clip) &&
            p.matrix[0] === 0 &&
            p.matrix[3] === 0 &&
            p.matrix[1] * p.matrix[2] > 0 &&
            Math.abs(p.matrix[1]) === Math.abs(p.matrix[2])
        )
    if (
      (!valid(token.rect) && !(r.width === 0 && part.every((p) => p.glyph.width === 0))) ||
      ((originalHeaders ||
        exactPair ||
        !pixels ||
        !part[0].form ||
        part.some((p) => p.charSpacing !== undefined && p.charSpacing !== 0)) &&
        bounds.some((n, i) => Math.abs(n - token.rect[i]) > 0.02)) ||
      (supplied &&
        (supplied.text !== r.str ||
          supplied.sourceItem.text !== r.str ||
          supplied.sourceItem.pageNumber !== page.pageNumber ||
          (!valid(supplied.rect) &&
            !(
              r.width === 0 &&
              finite(supplied.rect, 4) &&
              ((supplied.rect[0] === supplied.rect[2] && supplied.rect[1] < supplied.rect[3]) ||
                rotatedZeroAdvance)
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
        (!pixels &&
          (!valid(record.label) ||
            !inside(record.form.rect, token.rect) ||
            !inside(record.form.rect, record.label)))
      )
        return
      record.form.records.push(record)
    }
    records.push(record)
    recordIndices.add(index)
  }
  if (offset !== chars.length || [...byIndex.keys()].some((index) => !recordIndices.has(index)))
    return
  // The pixel-only caller retains the complete renderer-enforced BBox. It
  // neither owns internal source advances nor decodes internal Type3 programs.
  // Partial evidence is atomic per font; every exterior glyph still requires
  // its ordinary loaded outline, and the actual PNG supplies its final halo.
  const raster = pixels
    ? { protection: expand(forms[0].rect, 0.5) }
    : getInitialPdfCropRaster(forms[0].rect, page)
  const exteriorFonts = pixels
    ? (context.glyphBounds ?? context.partialFontGlyphBounds)
    : context.glyphBounds
  if (!raster || !Array.isArray(exteriorFonts)) return
  const fontMap = new Map()
  for (const f of exteriorFonts) {
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
  if (originalHeaders) {
    // Original retention still needs every visible native glyph, including
    // exterior advances whose outlines can enter the newly owned header band.
    if (glyphs.some((g) => !ink(g) || !valid(g.clip))) return
    for (const record of records) record.ink = union(record.part.map(ink))
  }
  // Whitespace is omitted only from source-string comparison. A loaded space
  // can still paint ink, so every outside glyph must remain disjoint as well.
  for (const g of glyphs) {
    if (g.form) continue
    const rect = ink(g)
    if (
      !rect ||
      (!pixels &&
        (intersection(rect, forms[0].rect) > 0 || intersection(rect, raster.protection) > 0))
    )
      return
  }
  for (const r of records) {
    if (r.form) continue
    r.ink = union(r.part.map(ink))
  }
  if (!pixels && outsidePaint.some((p) => intersection(p.rect, forms[0].rect) > 0)) return
  if (!pixels && outsidePaint.some((p) => intersection(p.rect, raster.protection) > 0)) return
  if (pixels)
    for (const form of forms)
      form.pixelInk = glyphs.flatMap((g) => {
        if (g.form !== form || !g.visible || !g.opaque || !valid(g.clip)) return []
        const b = ink(g)
        if (!valid(b)) return []
        const clipped = [
          Math.max(b[0], g.clip[0], form.rect[0]),
          Math.max(b[1], g.clip[1], form.rect[1]),
          Math.min(b[2], g.clip[2], form.rect[2]),
          Math.min(b[3], g.clip[3], form.rect[3])
        ]
        return valid(clipped) ? [clipped] : []
      })
  return {
    forms,
    records,
    outsidePaint,
    raster,
    ...(pixels
      ? {
          ...(originalHeaders
            ? {
                glyphInk: glyphs.map((g) => ({
                  origin: g.origin,
                  rect: ink(g),
                  visible: g.visible,
                  opaque: g.opaque
                }))
              }
            : {}),
          type3Glyphs: glyphs.filter((g) => g.form && g.glyph.operatorListId != null),
          outsideGlyphs: glyphs
            .filter((g) => !g.form)
            .map((g) => ({ rect: ink(g), visible: g.visible }))
        }
      : {})
  }
}

// This private-purpose observation can select whole original source items;
// it cannot create the WeakMap certificate used by pixel or native drawing.
export function nativeOriginalRasterHeaderInk(page, tokens, context) {
  try {
    const program = captionedFormProgram(page, tokens, context, originalRasterHeaderMode)
    if (!program || program.type3Glyphs.length) return
    return program
  } catch {
    return
  }
}

// Type3 charprocs execute on the caller's CanvasGraphics stack. Verify their
// live control flow rather than assuming the surrounding Form clip survives.
// Internal path geometry stays opaque and never grants Source ownership.
const type3FontProgramPurpose = Symbol('type3-font-program-current')
// A caller with its own complete render-stream proof can reuse the live font
// and charproc guard without pretending API image ids are renderer image ids.
export function liveType3FontPrograms(context, glyphs, scope) {
  return liveType3FormStack(context, glyphs, scope, type3FontProgramPurpose)
}
function liveType3FormStack(context, glyphs, scope, purpose) {
  if (!glyphs.length) return () => true
  const arrayData = (value) => {
      if (
        !Array.isArray(value) ||
        types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Array.prototype
      )
        return false
      const descriptors = Object.getOwnPropertyDescriptors(value)
      return Reflect.ownKeys(descriptors).every((key) => Object.hasOwn(descriptors[key], 'value'))
    },
    options = nativeRecoveryOwnValues(scope)
  if (!options) return
  const { nativePage, pageContent, operators } = options,
    retained = retainNativeRecoveryInputs([pageContent, operators])
  if (!retained) return
  const raw = context.content.items,
    actual = pageContent?.items,
    sourceOps = context.operators,
    forward = new Map(),
    reverse = new Map()
  if (
    !nativePage ||
    !Array.isArray(actual) ||
    actual.length !== raw.length ||
    !Array.isArray(operators?.fnArray) ||
    !Array.isArray(operators.argsArray) ||
    (purpose !== type3FontProgramPurpose &&
      (!equal(operators.fnArray, sourceOps.fnArray) ||
        operators.argsArray.length !== sourceOps.argsArray.length))
  )
    return
  for (const [i, row] of raw.entries()) {
    const other = actual[i]
    if (
      !other ||
      !['str', 'width', 'height', 'dir', 'hasEOL'].every((key) => row[key] === other[key]) ||
      !equal(row.transform, other.transform) ||
      !equal(context.content.styles[row.fontName], pageContent.styles?.[other.fontName]) ||
      (forward.has(row.fontName) && forward.get(row.fontName) !== other.fontName) ||
      (reverse.has(other.fontName) && reverse.get(other.fontName) !== row.fontName)
    )
      return
    forward.set(row.fontName, other.fontName)
    reverse.set(other.fontName, row.fontName)
  }
  for (const [i, op] of (purpose === type3FontProgramPurpose ? [] : sourceOps.fnArray).entries())
    if (op === OPS.setFont) {
      const a = sourceOps.argsArray[i],
        b = operators.argsArray[i]
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !Number.isFinite(a[1]) ||
        !Array.isArray(b) ||
        b.length !== 2 ||
        typeof b[0] !== 'string' ||
        a[1] !== b[1] ||
        (forward.has(a[0]) && forward.get(a[0]) !== b[0]) ||
        (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
      )
        return
      forward.set(a[0], b[0])
      reverse.set(b[0], a[0])
    }
  for (const [i, op] of (purpose === type3FontProgramPurpose ? [] : sourceOps.fnArray).entries()) {
    const args = sourceOps.argsArray[i],
      expected =
        op === OPS.setFont
          ? [forward.get(args[0]), args[1]]
          : op === OPS.dependency
            ? args.map((id) => forward.get(id) ?? id)
            : args
    if (!equal(expected, operators.argsArray[i])) return
  }
  const scopePrototype = Object.getPrototypeOf(scope)
  const slots = (object, keys) => {
      const chain = []
      for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
        if (chain.length === 8) return
        chain.push({
          owner,
          parent: Object.getPrototypeOf(owner),
          descriptors: keys.map((key) => [key, Object.getOwnPropertyDescriptor(owner, key)])
        })
      }
      return chain
    },
    currentSlots = (chain) =>
      !!chain &&
      chain.every(
        ({ owner, parent, descriptors }) =>
          Object.getPrototypeOf(owner) === parent &&
          descriptors.every(([key, before]) => {
            const now = Object.getOwnPropertyDescriptor(owner, key)
            return before
              ? !!now &&
                  ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                    (field) => now[field] === before[field]
                  )
              : !now
          })
      ),
    dataSlot = (object, key) => {
      for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key)
        if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
      }
    },
    store = dataSlot(nativePage, 'commonObjs'),
    get = store && dataSlot(store, 'get'),
    pageSlots = slots(nativePage, ['commonObjs']),
    storeSlots = store && slots(store, ['get'])
  if (typeof get !== 'function' || !pageSlots || !storeSlots) return
  const used = new Map()
  for (const glyph of glyphs) {
    const id = forward.get(glyph.font),
      name = glyph.glyph.operatorListId
    if (typeof id !== 'string' || typeof name !== 'string' || !name || name.length > 128) return
    if (!used.has(id)) used.set(id, new Set())
    used.get(id).add(name)
  }
  const fonts = []
  const fontKeys = [
    'isType3Font',
    'loadedName',
    'charProcOperatorList',
    ...(purpose === type3FontProgramPurpose
      ? ['fontMatrix', 'missingFile', 'isInvalidPDFjsFont', 'vertical']
      : [])
  ]
  for (const [id, names] of used) {
    const font = get.call(store, id),
      chain = slots(font, fontKeys)
    if (!chain) return
    for (const key of fontKeys) {
      const entry = chain.find((level) =>
          level.descriptors.find(([name, descriptor]) => name === key && descriptor)
        ),
        descriptor = entry?.descriptors.find(([name]) => name === key)?.[1]
      if (!descriptor) return
      if (
        !Object.hasOwn(descriptor, 'value') &&
        !(
          entry.owner === Object.getPrototypeOf(font) &&
          key !== 'charProcOperatorList' &&
          typeof descriptor.get === 'function' &&
          !descriptor.set &&
          Function.prototype.toString.call(descriptor.get).replace(/\s/gu, '') ===
            `get${key}(){returnthis.#fontData.${key};}`
        )
      )
        return
    }
    fonts.push({ id, names, font, chain })
  }
  if (!fonts.every((font) => currentSlots(font.chain))) return
  const programs = []
  for (const entry of fonts) {
    const { font, names } = entry
    if (font.isType3Font !== true || font.loadedName !== entry.id) return
    const dictionary = dataSlot(font, 'charProcOperatorList'),
      values = nativeRecoveryOwnValues(dictionary)
    if (!values) return
    entry.dictionary = dictionary
    for (const name of names) {
      const program = values[name],
        value = nativeRecoveryOwnValues(program)
      if (
        !value ||
        !Array.isArray(value.fnArray) ||
        !Array.isArray(value.argsArray) ||
        value.fnArray.length !== value.argsArray.length ||
        !value.fnArray.length ||
        value.fnArray.length > 4096 ||
        value.length !== value.fnArray.length ||
        !arrayData(value.argsArray)
      )
        return
      const stable = [],
        pathCaches = []
      let depth = 0
      for (let i = 0; i < value.fnArray.length; i++) {
        const op = value.fnArray[i],
          args = value.argsArray[i]
        if (args !== null && !arrayData(args)) return
        if (op === OPS.save || op === OPS.restore) {
          if (args !== null && args.length) return
          depth += op === OPS.save ? 1 : -1
          if (depth < 0) return
          stable.push(args)
        } else if (op === OPS.setCharWidth || op === OPS.setCharWidthAndBounds) {
          if (i !== 0 || !finite(args, op === OPS.setCharWidth ? 2 : 6)) return
          stable.push(args)
        } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
          if (!Array.isArray(args) || args.length !== 1 || !/^#[a-f0-9]{6}$/iu.test(args[0])) return
          stable.push(args)
        } else if (op === OPS.constructPath) {
          if (
            !Array.isArray(args) ||
            args.length !== 3 ||
            ![
              OPS.stroke,
              OPS.closeStroke,
              OPS.fill,
              OPS.eoFill,
              OPS.fillStroke,
              OPS.eoFillStroke,
              OPS.closeFillStroke,
              OPS.closeEOFillStroke,
              OPS.endPath
            ].includes(args[0]) ||
            !arrayData(args[1]) ||
            args[1].length !== 1 ||
            (args[2] !== null && !finite(args[2], 4))
          )
            return
          const data = args[1][0]
          if (
            data !== null &&
            !(data instanceof Path2D) &&
            !(ArrayBuffer.isView(data) && Array.from(data).every(Number.isFinite))
          )
            return
          const rawCurrent = ArrayBuffer.isView(data)
            ? retainNativeRecoveryInputs([data])
            : () => true
          if (!rawCurrent) return
          // CanvasGraphics replaces only this opaque path-cache entry with a
          // Path2D. It cannot alter the retained dispatch or save/restore flow.
          pathCaches.push({
            args,
            container: args[1],
            draw: args[0],
            bounds: args[2],
            rawCurrent,
            slots: slots(args, Reflect.ownKeys(args))
          })
          stable.push(args[2])
        } else return
      }
      const controlCurrent = retainNativeRecoveryInputs([value.fnArray, stable])
      if (depth || !controlCurrent) return
      programs.push({
        entry,
        name,
        program,
        value,
        programSlots: slots(program, Reflect.ownKeys(program)),
        argumentSlots: slots(value.argsArray, Reflect.ownKeys(value.argsArray)),
        controlCurrent,
        pathCaches,
        argsRefs: [...value.argsArray]
      })
    }
  }
  return () => {
    const now = nativeRecoveryOwnValues(scope)
    if (
      !now ||
      Object.getPrototypeOf(scope) !== scopePrototype ||
      !equal(Object.keys(now), Object.keys(options)) ||
      !Object.keys(now).every((key) => now[key] === options[key]) ||
      !retained() ||
      !currentSlots(pageSlots) ||
      !currentSlots(storeSlots) ||
      dataSlot(nativePage, 'commonObjs') !== store ||
      !fonts.every((entry) => currentSlots(entry.chain))
    )
      return false
    return (
      fonts.every(
        (entry) =>
          get.call(store, entry.id) === entry.font &&
          entry.font.isType3Font === true &&
          entry.font.loadedName === entry.id &&
          dataSlot(entry.font, 'charProcOperatorList') === entry.dictionary
      ) &&
      programs.every((p) => {
        const value = nativeRecoveryOwnValues(p.program)
        return (
          value &&
          currentSlots(p.programSlots) &&
          currentSlots(p.argumentSlots) &&
          dataSlot(p.entry.dictionary, p.name) === p.program &&
          value.fnArray === p.value.fnArray &&
          value.argsArray === p.value.argsArray &&
          value.length === p.value.length &&
          arrayData(value.argsArray) &&
          value.argsArray.every(
            (args, i) => args === p.argsRefs[i] && (args === null || arrayData(args))
          ) &&
          p.controlCurrent() &&
          p.pathCaches.every(
            (cache) =>
              currentSlots(cache.slots) &&
              cache.args[0] === cache.draw &&
              cache.args[1] === cache.container &&
              cache.args[2] === cache.bounds &&
              cache.rawCurrent() &&
              arrayData(cache.container) &&
              cache.container.length === 1 &&
              (cache.container[0] === null ||
                cache.container[0] instanceof Path2D ||
                ArrayBuffer.isView(cache.container[0]))
          )
        )
      })
    )
  }
}

export function nativeCaptionedFormPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect,
  live
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
          'opaqueRasterImages',
          'dualApiEvidence',
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
        [page, figure, captions, tables, tokens, publishedRect, input],
        input.viewport
      )
    if (
      !current ||
      !valid(publishedRect) ||
      !valid(figure?.rect) ||
      !valid(figure.caption?.rect) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.formCropRaster ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      figure.caption.page !== page.pageNumber ||
      figure.caption.regions ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      !Array.isArray(captions) ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      captions.filter(
        (c) =>
          c.page === page.pageNumber &&
          equal(c.rect, figure.caption.rect) &&
          equal(c.lines, figure.caption.lines)
      ).length !== 1
    )
      return
    let p = captionedFormProgram(page, tokens, input, pixelCropMode)
    if (!p && input.dualApiEvidence) {
      const certificate = verifyNativeDualApiCertificate(page, input, input.dualApiEvidence)
      if (!certificate) return
      p = captionedFormProgram(page, tokens, input, pixelCropMode, certificate)
    }
    if (!p || p.records.length > 4096 || p.forms.some((f) => f.paint.length > 4096)) return
    const cap = p.records.filter((r) => !r.form && inside(figure.caption.rect, r.token.rect))
    const type3Current = liveType3FormStack(input, p.type3Glyphs, live)
    if (!type3Current || !type3Current()) return
    if (
      !cap.length ||
      letters(cap.map((r) => r.r.str).join('')).join('') !==
        letters(figure.caption.lines?.join('') ?? '').join('')
    )
      return
    const choices = [],
      font = Math.max(...cap.map((r) => r.token.height))
    for (const form of p.forms) {
      const rect = expand(
          form.rect,
          form.pixelBoundary ? 3 / form.pixelBoundary.minimumScale : 0.5
        ),
        foreign = [
          ...p.outsideGlyphs,
          ...p.outsidePaint.map((g) => ({ rect: g.rect, visible: g.visible })),
          ...p.forms.filter((other) => other !== form).map((other) => ({ rect: other.rect }))
        ].filter((q) => valid(q.rect)),
        cleanup = foreign.some((q) => q.visible && inside(publishedRect, q.rect)),
        missingInk = form.pixelInk.some((ink) => !inside(publishedRect, ink))
      if (
        !form.records.length ||
        !form.paint.length ||
        !valid(rect) ||
        !inside([0, 0, page.width, page.height], rect) ||
        intersection(form.rect, figure.rect) <= 0 ||
        tables.some((r) => intersection(r, rect) > 0) ||
        foreign.some((q) => intersection(q.rect, rect) > 0) ||
        (!cleanup && !missingInk) ||
        ((!cleanup || p.forms.length > 1) &&
          (!(font > 0) ||
            form.rect[1] >= figure.caption.rect[1] ||
            form.rect[3] > figure.caption.rect[1] + font ||
            figure.caption.rect[1] - form.rect[3] > Math.max(48, font * 4)))
      )
        continue
      choices.push({ form, rect, foreign })
    }
    // A nearby caption and the actual old crop must identify one body. Never
    // choose the largest Form or discard an independent neighboring program.
    if (choices.length !== 1) return
    const { form, rect, foreign } = choices[0]
    const output = { rect },
      retained = retainNativeRecoveryInputs([output, form.rect, foreign, form.pixelBoundary])
    if (!retained) return
    pixelCrops.set(output, {
      page,
      body: form.rect,
      ...(form.pixelBoundary ? { boundary: form.pixelBoundary } : {}),
      foreign,
      current: () => {
        if (
          !current() ||
          !type3Current() ||
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

// Only the retained private plan can prevent a retry into a partial old crop.
// A serialized kind, a cloned plan or an ordinary Form grants no such identity.
export function nativeIsolatedGroupPixelCropCurrent(plan, page) {
  try {
    const proof = pixelCrops.get(plan)
    return !!(
      proof &&
      proof.page === page &&
      proof.boundary?.kind === 'isolated-group-clip' &&
      proof.current()
    )
  } catch {
    return false
  }
}

export function nativeCaptionedFormPixelPngSafe(plan, png, rect, page) {
  try {
    const proof = pixelCrops.get(plan),
      raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!proof &&
      proof.page === page &&
      proof.current() &&
      !!raster &&
      (!proof.boundary || raster.scaleLower >= proof.boundary.minimumScale) &&
      equal(plan.rect, rect) &&
      inside(rect, expand(proof.body, 1 / raster.scaleLower)) &&
      proof.foreign.every(
        (q) => intersection(raster.protection, expand(q.rect, 2 / raster.scaleLower)) <= 0
      )
    )
  } catch {
    return false
  }
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
