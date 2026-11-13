import { types, isDeepStrictEqual as sameValue } from 'node:util'
import { Path2D } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'
import { nativeAdditionalPixelInputsFit } from './literature-pdf-render-bounds.mjs'
import { verifyNativeDualApiCertificate } from './literature-pdf-native-dual-api-certificate.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { intersection, union } from './literature-pdf-page-geometry.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  nativeRecoveryOwnValues,
  nativeNonisolatedGroupProfileData,
  nativeNonisolatedExclusionProfileData,
  nativeCompositeGroupProfileData,
  retainNativeRecoveryInputs,
  retainNativeArrayPixelInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { getPdfCropRasterProtectionFromPng, renderPdfCrop } from './literature-pdf-crop.mjs'
import {
  nativeFillStrokeGlyphEnvelope,
  nativeStrokeOnlyGlyphEnvelope
} from './literature-pdf-figure-native-stroked-text.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { nativeCompiledPathBinding } from './literature-pdf-native-opaque-raster-crop.mjs'
import { nativeStrokeOnlyTextInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'

const pairedGroupPixelCertificates = new WeakMap(),
  pairedGroupPixelMode = Symbol('paired-group-pixel'),
  nonisolatedGroupPixelMode = Symbol('nonisolated-group-pixel'),
  nonisolatedExclusionPixelMode = Symbol('nonisolated-exclusion-pixel'),
  compositeGroupPixelMode = Symbol('composite-group-pixel'),
  groupPixelMode = Symbol('group-pixel'),
  groupPixelCertificates = new WeakMap()
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

// The complete raw program remains separate from ordinary glyph outlines. A
// Type3 entry can only confine pixels inside a real group canvas; no Source
// claim may be built from this profile or from its independent d1 advance.
function groupPixelType3Inventory(context) {
  if (context.pixelType3Programs === undefined) return new Map()
  if (!Array.isArray(context.pixelType3Programs) || !context.pixelType3Programs.length) return
  const fonts = new Map()
  for (const f of context.pixelType3Programs) {
    if (
      typeof f.fontName !== 'string' ||
      fonts.has(f.fontName) ||
      !finite(f.fontMatrix, 6) ||
      f.fontMatrix[0] <= 0 ||
      f.fontMatrix[3] <= 0 ||
      [1, 2, 4, 5].some((i) => f.fontMatrix[i] !== 0) ||
      f.missingFile !== false ||
      f.isInvalidPDFjsFont !== false ||
      (f.vertical !== undefined && f.vertical !== false) ||
      !Array.isArray(f.glyphs) ||
      !f.glyphs.length
    )
      return
    const glyphs = new Map(),
      unicode = new Set(),
      occurrences = new Set()
    for (const g of f.glyphs) {
      const p = g.program,
        a = p?.argsArray
      if (
        typeof g.operatorListId !== 'string' ||
        !g.operatorListId.length ||
        g.operatorListId.length > 256 ||
        glyphs.has(g.operatorListId) ||
        typeof g.unicode !== 'string' ||
        Array.from(g.unicode).length !== 1 ||
        unicode.has(g.unicode) ||
        g.fontChar !== '' ||
        !Number.isSafeInteger(g.originalCharCode) ||
        g.originalCharCode < 0 ||
        !(g.width > 0) ||
        !Number.isFinite(g.width) ||
        g.isSpace !== false ||
        g.isInFont !== true ||
        !equal(p?.fnArray, [OPS.setCharWidthAndBounds, OPS.setGState, OPS.constructPath]) ||
        p.length !== 3 ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        !finite(a[0], 6) ||
        a[0][0] <= 0 ||
        a[0][1] !== 0 ||
        !valid(a[0].slice(2)) ||
        !equal(a[1], [
          [
            ['FL', 1],
            ['LC', 0],
            ['LJ', 0],
            ['LW', 0],
            ['ML', 10]
          ]
        ]) ||
        !Array.isArray(a[2]) ||
        a[2].length !== 3 ||
        a[2][0] !== OPS.fill ||
        !Array.isArray(a[2][1]) ||
        a[2][1].length !== 1 ||
        !finite(a[2][2], 4) ||
        !Array.isArray(g.occurrences) ||
        !g.occurrences.length
      )
        return
      const data = a[2][1][0],
        path = new Path2D()
      if (!(Array.isArray(data) || ArrayBuffer.isView(data)) || !data.length || data[0] !== 0)
        return
      let open = false
      for (let i = 0; i < data.length;) {
        const op = data[i++],
          count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1
        if (
          count < 0 ||
          i + count > data.length ||
          !Array.from(data.slice(i, i + count)).every(Number.isFinite) ||
          (op !== 0 && !open)
        )
          return
        const values = Array.from(data.slice(i, i + count))
        i += count
        if (op === 0) {
          path.moveTo(...values)
          open = true
        } else if (op === 1) path.lineTo(...values)
        else if (op === 2) path.bezierCurveTo(...values)
        else if (op === 3) path.quadraticCurveTo(...values)
        else {
          path.closePath()
          open = false
        }
      }
      const bounds = Array.from(path.getBounds())
      if (!valid(bounds) || !equal(bounds, Array.from(a[2][2])) || !inside(a[0].slice(2), bounds))
        return
      for (const o of g.occurrences) {
        const key = o.operationIndex + ':' + o.glyphIndex
        if (
          !Number.isSafeInteger(o.operationIndex) ||
          o.operationIndex < 0 ||
          !Number.isSafeInteger(o.glyphIndex) ||
          o.glyphIndex < 0 ||
          occurrences.has(key)
        )
          return
        occurrences.add(key)
      }
      glyphs.set(g.operatorListId, { value: g, path, fontMatrix: f.fontMatrix })
      unicode.add(g.unicode)
    }
    fonts.set(f.fontName, { value: f, glyphs })
  }
  return fonts
}

function groupPixelType3LiveFont(font, entry) {
  const programs = font.charProcOperatorList,
    rows = [],
    slots = groupSlots(font, ['charProcOperatorList']),
    programSlots = groupSlots(programs, [...entry.glyphs.keys()])
  if (
    !slots ||
    !programSlots ||
    font.isType3Font !== true ||
    !equal(Array.from(font.fontMatrix ?? []), entry.value.fontMatrix)
  )
    return
  for (const [id, proof] of entry.glyphs) {
    const p = programs[id],
      v = proof.value.program,
      a = p?.argsArray,
      data = a?.[2]?.[1],
      pSlots = groupSlots(p, ['fnArray', 'argsArray', 'length']),
      aSlots = groupSlots(a, Reflect.ownKeys(a ?? {})),
      dataSlots = groupSlots(data, ['length']),
      fixed = retainNativeRecoveryInputs([p?.fnArray, a?.[0], a?.[1], a?.[2]?.[0], a?.[2]?.[2]]),
      pathSlots = groupSlots(a?.[2], Reflect.ownKeys(a?.[2] ?? {})),
      dataPrototype = data && Object.getPrototypeOf(data),
      expected = proof.path,
      original = data?.[0],
      originalCurrent =
        original instanceof Path2D ? undefined : retainNativeRecoveryInputs([original])
    if (
      !pSlots ||
      !aSlots ||
      !dataSlots ||
      !pathSlots ||
      !fixed ||
      !equal(p.fnArray, v.fnArray) ||
      p.length !== v.length ||
      !equal(a[0], v.argsArray[0]) ||
      !equal(a[1], v.argsArray[1]) ||
      a[2][0] !== v.argsArray[2][0] ||
      !equal(Array.from(a[2][2] ?? []), Array.from(v.argsArray[2][2])) ||
      !Array.isArray(data) ||
      data.length !== 1 ||
      Reflect.ownKeys(data).join(',') !== '0,length'
    )
      return
    let rendered = original instanceof Path2D ? original : undefined
    const pathCurrent = () => {
      const current = data[0]
      if (originalCurrent && !originalCurrent()) return false
      if (current instanceof Path2D) {
        if (
          Object.getPrototypeOf(current) !== Path2D.prototype ||
          Reflect.ownKeys(current).length ||
          !Path2D.prototype.equals.call(expected, current)
        )
          return false
        if (rendered && current !== rendered) return false
        rendered ??= current
        return true
      }
      return (
        current === original &&
        !!originalCurrent &&
        equal(Array.from(current ?? []), Array.from(v.argsArray[2][1][0]))
      )
    }
    if (!pathCurrent()) return
    rows.push(
      () =>
        groupSlotsCurrent(pSlots) &&
        groupSlotsCurrent(aSlots) &&
        groupSlotsCurrent(pathSlots) &&
        groupSlotsCurrent(dataSlots) &&
        Object.getPrototypeOf(data) === dataPrototype &&
        Reflect.ownKeys(data).join(',') === '0,length' &&
        fixed() &&
        pathCurrent()
    )
  }
  return () =>
    groupSlotsCurrent(slots) &&
    groupSlotsCurrent(programSlots) &&
    font.charProcOperatorList === programs &&
    font.isType3Font === true &&
    font.missingFile === false &&
    font.isInvalidPDFjsFont === false &&
    (font.vertical === undefined || font.vertical === false) &&
    equal(Array.from(font.fontMatrix ?? []), entry.value.fontMatrix) &&
    rows.every((current) => current())
}

// This is a clip proof, not a font-ink proof. PDF.js 5.4.624 beginGroup creates
// a bounded scratch canvas and explicitly clips it to bbox even when isolated
// is false. Never admit that group to the stricter glyph/path inventories.
function disjointGroupProgram(page, tokens, context, groupCount = 2, mode, pairedLiteral) {
  const pairedPixels = mode === pairedGroupPixelMode,
    exteriorPixels = mode === nonisolatedExclusionPixelMode,
    compositePixels = mode === compositeGroupPixelMode,
    nonisolatedPixels = mode === nonisolatedGroupPixelMode || exteriorPixels || compositePixels,
    pixels = mode === groupPixelMode || pairedPixels || nonisolatedPixels,
    literalCertificate = pairedPixels
      ? pairedLiteral
      : pixels
        ? verifyNativeDualApiCertificate(page, context, context.dualApiEvidence)
        : undefined
  const pixelType3 = pixels ? groupPixelType3Inventory(context) : new Map(),
    type3Used = new Set()
  if (!pixelType3) return
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
  const nodes = []
  const groups = [],
    stack = [],
    chars = [],
    outsideGlyphs = [],
    outsidePaint = [],
    outsidePaints = []
  let state = {
      ctm: [1, 0, 0, 1, 0, 0],
      font: undefined,
      size: 0,
      fillAlpha: 1,
      fillColor: '#000000',
      strokeAlpha: 1,
      strokeColor: '#000000',
      lineWidth: 1,
      lineJoin: 0,
      lineCap: 0,
      miterLimit: 10,
      textRenderingMode: 0,
      charSpacing: 0,
      wordSpacing: 0,
      leading: 0
    },
    group,
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
    if (op === OPS.save || op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) {
      if (text) return
      stack.push({ state: { ...state, ctm: [...state.ctm] }, op, marked })
      if (op === OPS.beginGroup) {
        const g = a?.[0]
        if (
          (!compositePixels && group) ||
          (compositePixels && (nodes.length > 1 || (nodes.length && group.children.length >= 4))) ||
          !g ||
          (g.matrix !== null &&
            !(compositePixels && nodes.length === 1 && equal(g.matrix, [1, 0, 0, 1, 0, 0]))) ||
          g.smask !== null ||
          g.knockout !== false ||
          (compositePixels
            ? g.isolated !== (nodes.length === 1)
            : typeof g.isolated !== 'boolean') ||
          !valid(g.bbox) ||
          !finite(state.ctm, 6) ||
          state.ctm[0] <= 0 ||
          state.ctm[3] <= 0 ||
          state.ctm[1] !== 0 ||
          state.ctm[2] !== 0 ||
          o.fnArray[i + 1] !== OPS.paintFormXObjectBegin
        )
          return
        const rect = box(g.bbox, Util.transform(v.transform, state.ctm))
        if (!valid(rect) || !inside([0, 0, page.width, page.height], rect)) return
        const node = { begin: i, arg: g, rect, paint: [], records: [], forms: 0 }
        if (compositePixels && nodes.length) {
          if (!inside(group.rect, rect)) return
          group.children.push(node)
        } else {
          group = node
          if (compositePixels) group.children = []
          groups.push(group)
        }
        if (compositePixels) nodes.push(node)
      } else if (op === OPS.paintFormXObjectBegin) {
        if (group) {
          const active = compositePixels ? nodes.at(-1) : group
          if (
            ++active.forms !== 1 ||
            (!equal(a, [null, null]) &&
              !(
                compositePixels &&
                nodes.length === 2 &&
                a?.length === 2 &&
                a[1] === null &&
                finite(a[0], 6) &&
                a[0].every((n, i) => n === [1, 0, 0, 1, 0, 0][i])
              ))
          )
            return
        } else if (!pixels || a?.[0] !== null || !valid(a?.[1])) return
      }
    } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      const previous = stack.pop(),
        begin =
          op === OPS.restore
            ? OPS.save
            : op === OPS.endGroup
              ? OPS.beginGroup
              : OPS.paintFormXObjectBegin
      if (text || !previous || previous.op !== begin) return
      if (op === OPS.endGroup) {
        const active = compositePixels ? nodes.at(-1) : group
        if (
          !group ||
          !active ||
          !equal(a?.[0], active.arg) ||
          o.fnArray[i - 1] !== OPS.paintFormXObjectEnd ||
          (pixels ? marked !== previous.marked : marked)
        )
          return
        active.end = i
        if (compositePixels) nodes.pop()
        if (!compositePixels || !nodes.length) group = undefined
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
    } else if (nonisolatedPixels && op === OPS.setTextRenderingMode) {
      if (!text || !group || ![0, 2].includes(a?.[0]) || a.length !== 1) return
      state.textRenderingMode = a[0]
    } else if (op === OPS.setTextMatrix) {
      const m = a?.length === 1 ? a[0] : a
      if (!text || !finite(m, 6)) return
      matrix = m
      x = y = lineX = lineY = 0
    } else if (op === OPS.moveText) {
      if (!text || !finite(a, 2)) return
      x = lineX += a[0]
      y = lineY += a[1]
    } else if (pixels && [OPS.setCharSpacing, OPS.setWordSpacing, OPS.setLeading].includes(op)) {
      if (!text || !finite(a, 1)) return
      state[
        op === OPS.setCharSpacing
          ? 'charSpacing'
          : op === OPS.setWordSpacing
            ? 'wordSpacing'
            : 'leading'
      ] = a[0]
    } else if (
      nonisolatedPixels &&
      [OPS.setLineWidth, OPS.setLineJoin, OPS.setLineCap, OPS.setMiterLimit].includes(op)
    ) {
      if (!finite(a, 1) || (op === OPS.setLineWidth && a[0] < 0)) return
      state[
        op === OPS.setLineWidth
          ? 'lineWidth'
          : op === OPS.setLineJoin
            ? 'lineJoin'
            : op === OPS.setLineCap
              ? 'lineCap'
              : 'miterLimit'
      ] = a[0]
    } else if (pixels && op === OPS.nextLine) {
      if (!text || (a !== null && (!Array.isArray(a) || a.length))) return
      x = lineX
      y = lineY -= state.leading
    } else if (op === OPS.showText) {
      if (!text || !state.font || !(state.size > 0) || !Array.isArray(a?.[0])) return
      const m = Util.transform(v.transform, Util.transform(state.ctm, matrix))
      if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
      for (const [glyphIndex, glyph] of a[0].entries()) {
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
          (glyph.operatorListId != null && !pixels)
        )
          return
        const type3 =
            glyph.operatorListId == null
              ? undefined
              : pixelType3.get(state.font)?.glyphs.get(glyph.operatorListId),
          advanceScale = type3 ? type3.fontMatrix[0] : 1 / 1000
        if (glyph.operatorListId != null) {
          const key = state.font + ':' + i + ':' + glyphIndex
          if (
            !group ||
            !type3 ||
            type3Used.has(key) ||
            !['unicode', 'fontChar', 'width', 'isSpace', 'isInFont', 'originalCharCode'].every(
              (k) => type3.value[k] === glyph[k]
            ) ||
            !type3.value.occurrences.some(
              (o) => o.operationIndex === i && o.glyphIndex === glyphIndex
            ) ||
            state.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(state.fillColor ?? '')
          )
            return
          type3Used.add(key)
        }
        const advance = box([x, y, x + glyph.width * state.size * advanceScale, y + state.size], m)
        const strokeState =
          nonisolatedPixels && state.textRenderingMode === 2
            ? {
                matrix: [...m],
                textMatrix: [...matrix],
                lineWidth: state.lineWidth,
                lineJoin: state.lineJoin,
                lineCap: state.lineCap,
                miterLimit: state.miterLimit,
                fillColor: state.fillColor,
                fillAlpha: state.fillAlpha,
                strokeColor: state.strokeColor,
                strokeAlpha: state.strokeAlpha,
                clip: [...group.rect]
              }
            : undefined
        if ((groupCount === 1 || pairedPixels) && !group)
          outsideGlyphs.push({
            font: state.font,
            i,
            glyphIndex,
            visible:
              state.fillAlpha === 1 &&
              /^#[a-f0-9]{6}$/iu.test(state.fillColor ?? '') &&
              state.fillColor.toLowerCase() !== '#ffffff',
            glyph,
            origin: [x, y],
            matrix: m,
            size: state.size,
            strokeState
          })
        for (const c of letters(glyph.unicode))
          chars.push({
            c,
            i,
            glyphIndex,
            visible:
              state.fillAlpha === 1 &&
              /^#[a-f0-9]{6}$/iu.test(state.fillColor ?? '') &&
              state.fillColor.toLowerCase() !== '#ffffff',
            group,
            font: state.font,
            advance,
            glyph,
            origin: [x, y],
            matrix: m,
            size: state.size,
            strokeState
          })
        x +=
          glyph.width * state.size * advanceScale +
          (pixels ? state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0) : 0)
      }
    } else if (op === OPS.constructPath || op === OPS.paintImageXObject) {
      if (exteriorPixels && !text && !group && op === OPS.constructPath) {
        if (
          !Array.isArray(a) ||
          a.length !== 3 ||
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
          ].includes(a[0]) ||
          a[1]?.length !== 1 ||
          !(Array.isArray(a[1][0]) || ArrayBuffer.isView(a[1][0])) ||
          !a[1][0].length ||
          !a[1][0].every(Number.isFinite)
        )
          return
        if (a[0] === OPS.endPath) continue
        const bounds = nativeFigurePathPaint(
            { o, v, finite, valid, box, strokeMargins: new Map([[i, state.miterLimit]]) },
            i,
            { transform: state.ctm, lineWidth: state.lineWidth, lineCap: state.lineCap }
          ),
          graphic = paint.get(i)
        if (
          !bounds ||
          !valid(bounds.rect) ||
          !Number.isFinite(bounds.floor) ||
          bounds.floor < 0 ||
          !graphic ||
          graphic.kind !== 'path'
        )
          return
        const path = a[1][0],
          matrix = Util.transform(v.transform, state.ctm)
        if (
          a[0] !== OPS.stroke ||
          path.length !== 6 ||
          path[0] !== 0 ||
          path[3] !== 1 ||
          path[2] !== path[5] ||
          matrix[1] !== 0 ||
          matrix[2] !== 0 ||
          state.strokeAlpha !== 1 ||
          !/^#[a-f0-9]{6}$/iu.test(state.strokeColor)
        )
          return
        const first = [path[1], path[2]],
          last = [path[4], path[5]]
        Util.applyTransform(first, matrix)
        Util.applyTransform(last, matrix)
        outsidePaints.push({ ...bounds, operationIndex: i, line: [...first, ...last] })
        paint.delete(i)
        continue
      }
      if (text || (!group && !nonisolatedPixels)) return
      if (
        pixels &&
        op === OPS.constructPath &&
        a?.length === 3 &&
        [OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.endPath].includes(
          a[0]
        ) &&
        a[1]?.length === 1 &&
        a[1][0] === null &&
        a[2] === null
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
      if (!g) {
        if (pixels && group && op === OPS.constructPath) continue
        return
      }
      if (
        g.kind !== (op === OPS.constructPath ? 'path' : 'image') ||
        (!pixels && !inside(group.rect, g.rect))
      )
        return
      if (!group) {
        // Later body rules do not belong to the clipped picture. Keep their
        // complete native paint bounds for the final raster-halo exclusion.
        if (
          !nonisolatedPixels ||
          op !== OPS.constructPath ||
          groups.length !== 1 ||
          !Number.isInteger(groups[0].end) ||
          i <= groups[0].end ||
          intersection(g.rect, groups[0].rect) > 0
        )
          return
        outsidePaint.push(g.rect)
        paint.delete(i)
        continue
      }
      group.paint.push(
        exteriorPixels
          ? {
              ...g,
              potentialPaint:
                op === OPS.paintImageXObject ||
                ([
                  OPS.fill,
                  OPS.eoFill,
                  OPS.fillStroke,
                  OPS.eoFillStroke,
                  OPS.closeFillStroke,
                  OPS.closeEOFillStroke
                ].includes(a[0]) &&
                  state.fillAlpha > 0 &&
                  /^#[a-f0-9]{6}$/iu.test(state.fillColor ?? '')) ||
                ([
                  OPS.stroke,
                  OPS.closeStroke,
                  OPS.fillStroke,
                  OPS.eoFillStroke,
                  OPS.closeFillStroke,
                  OPS.closeEOFillStroke
                ].includes(a[0]) &&
                  state.strokeAlpha > 0 &&
                  /^#[a-f0-9]{6}$/iu.test(state.strokeColor ?? ''))
            }
          : g
      )
      paint.delete(i)
    } else if (pixels && op === OPS.beginMarkedContent) {
      if (a?.length !== 1 || a[0]?.name !== 'Artifact' || Object.keys(a[0]).join(',') !== 'name')
        return
      marked++
    } else if (op === OPS.beginMarkedContentProps) {
      if (pixels) {
        if (!(
          (a?.[0] === 'P' && Number.isSafeInteger(a[1]) && a[1] >= 0) ||
          (a?.[0] === 'Span' && (a[1] == null || (Number.isSafeInteger(a[1]) && a[1] >= 0)))
        ))
          return
      } else if (!group || a?.[0] !== 'OC' || a[1]?.type !== 'OCG') return
      marked++
    } else if (op === OPS.endMarkedContent) {
      if (!marked) return
      marked--
    } else if (pixels && [OPS.setFillColorN, OPS.setStrokeColorN].includes(op)) {
      if (!group || !groupConfinedColor(a)) return
      if (op === OPS.setFillColorN) state.fillColor = undefined
      else state.strokeColor = undefined
    } else if (pixels && op === OPS.setFillRGBColor) {
      if (!/^#[a-f0-9]{6}$/iu.test(a?.[0] ?? '')) return
      state.fillColor = a[0]
    } else if (nonisolatedPixels && op === OPS.setStrokeRGBColor) {
      if (!/^#[a-f0-9]{6}$/iu.test(a?.[0] ?? '')) return
      state.strokeColor = a[0]
    } else if (
      pixels &&
      group &&
      op === OPS.setGState &&
      equal(a, [
        [
          ['FL', 1],
          ['LC', 0],
          ['LJ', 0],
          ['LW', 0],
          ['ML', 10]
        ]
      ])
    ) {
      // Exact pinned CanvasGraphics primitives inside the bounded scratch
      // canvas. FL dispatches to setFlatness (empty in PDF.js 5.4.624); the
      // remaining line state is retained, never used as font/Source evidence.
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
              ((exteriorPixels || compositePixels) &&
                ((['LC', 'LJ'].includes(e[0]) && [0, 1, 2].includes(e[1])) ||
                  (e[0] === 'LW' && Number.isFinite(e[1]) && e[1] >= 0) ||
                  (e[0] === 'ML' && Number.isFinite(e[1]) && e[1] >= 1)))
            )
        )
      )
        return
      if (pixels)
        for (const [k, v] of a[0]) {
          if (k === 'ca') state.fillAlpha = v
          if (k === 'CA') state.strokeAlpha = v
          if ((exteriorPixels || compositePixels) && k === 'LC') state.lineCap = v
          if ((exteriorPixels || compositePixels) && k === 'LJ') state.lineJoin = v
          if ((exteriorPixels || compositePixels) && k === 'LW') state.lineWidth = v
          if ((exteriorPixels || compositePixels) && k === 'ML') state.miterLimit = v
        }
    } else if (!plain.has(op)) return
  }
  if (text || stack.length || group || marked || paint.size || groups.length !== groupCount) return
  if (
    [...pixelType3].some(([name, f]) =>
      [...f.glyphs.values()].some((g) =>
        g.value.occurrences.some(
          (o) => !type3Used.has(name + ':' + o.operationIndex + ':' + o.glyphIndex)
        )
      )
    )
  )
    return
  const internalZeroParts = [],
    records = [],
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
    // Preserve native width zero and its original token rectangle. The
    // already closed group canvas, complete ordinary outline and live font
    // witness confine only these internal pixels, never an exterior record.
    const internalZero =
      pixels &&
      r.width === 0 &&
      part.length === cs.length &&
      part.every((p) => {
        const b = (context.glyphBounds ?? context.partialFontGlyphBounds)
          ?.find((f) => f.fontName === p.font)
          ?.glyphs.find((g) => g.fontChar === p.glyph.fontChar)?.bounds
        if (
          !p.group ||
          p.glyph.operatorListId != null ||
          p.glyph.width !== 0 ||
          p.glyph.isInFont !== true ||
          p.glyph.isSpace !== false ||
          !p.visible ||
          !finite(b, 4)
        )
          return false
        const ink = box(
          [
            p.origin[0] + b[0] * p.size,
            p.origin[1] + b[1] * p.size,
            p.origin[0] + b[2] * p.size,
            p.origin[1] + b[3] * p.size
          ],
          p.matrix
        )
        return (
          valid(ink) && ink.every((n, i) => (i < 2 ? n >= p.group.rect[i] : n <= p.group.rect[i]))
        )
      })
    if (internalZero) internalZeroParts.push(...part)
    const exteriorZero =
        exteriorPixels &&
        r.width === 0 &&
        part.length === cs.length &&
        part.every((p) => {
          const bounds = context.glyphBounds
            ?.find((f) => f.fontName === p.font)
            ?.glyphs.find((g) => g.fontChar === p.glyph.fontChar)?.bounds
          if (
            p.group ||
            p.glyph.operatorListId != null ||
            p.glyph.width !== 0 ||
            p.glyph.isInFont !== true ||
            p.glyph.isSpace !== false ||
            !finite(bounds, 4)
          )
            return false
          const ink = box(
            [
              p.origin[0] + bounds[0] * p.size,
              p.origin[1] + bounds[1] * p.size,
              p.origin[0] + bounds[2] * p.size,
              p.origin[1] + bounds[3] * p.size
            ],
            p.matrix
          )
          return valid(ink) && inside([0, 0, page.width, page.height], ink)
        }),
      boundZero = internalZero || exteriorZero
    if (
      source?.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== r.str ||
      !finite(r.transform, 6) ||
      (!(r.width > 0) && !boundZero) ||
      !(r.height > 0) ||
      (part.map((p) => p.c).join('') !== cs.join('') &&
        !(
          literalCertificate?.get(index)?.normal === r.str &&
          part.map((p) => p.c).join('') ===
            (pairedPixels
              ? letters(literalCertificate.get(index).raw).join('')
              : literalCertificate.get(index).raw.normalize('NFD'))
        )) ||
      part.some((p) => p.font !== r.fontName || p.group !== part[0].group)
    )
      return
    const token = tableTextToken(r, viewport, 0),
      bounds = union(part.map((p) => p.advance)),
      supplied = byIndex.get(index)
    // The CLI omits removed margin tokens. This new crop-only Type3 branch
    // still reads every original raw record and every exterior live outline.
    // No missing internal label is admitted and no text claim is produced.
    if (
      pixels &&
      !supplied &&
      !(
        (pixelType3.size || mode === nonisolatedGroupPixelMode || exteriorPixels) &&
        part.every((p) => !p.group)
      )
    )
      return
    if (
      (!valid(token.rect) && !boundZero) ||
      (!pixels && bounds.some((n, i) => Math.abs(n - token.rect[i]) > 0.02)) ||
      (supplied &&
        (supplied.text !== r.str ||
          supplied.sourceItem.text !== r.str ||
          supplied.sourceItem.pageNumber !== page.pageNumber ||
          (!valid(supplied.rect) && !boundZero) ||
          supplied.rect.some((n, i) => Math.abs(n - token.rect[i]) > 1e-6)))
    )
      return
    const record = {
      r,
      part,
      index,
      token,
      group: part[0].group,
      ...(exteriorZero ? { exteriorZero: true } : {}),
      label: nativeFigureLabelBounds(r, context.content.styles?.[r.fontName], viewport)
    }
    if (record.group) {
      if (
        !supplied ||
        r.dir !== 'ltr' ||
        (!pixels &&
          (!valid(record.label) ||
            !inside(record.group.rect, token.rect) ||
            !inside(record.group.rect, record.label)))
      )
        return
      record.group.records.push(record)
    }
    records.push(record)
    recordIndices.add(index)
  }
  if (offset !== chars.length || [...byIndex.keys()].some((index) => !recordIndices.has(index)))
    return
  if (groupCount !== 1 && !pairedPixels) return { groups, records }
  // Group clipping owns internal ink. Every outside glyph, including spaces,
  // still needs its actual loaded outline to exclude adjacent text.
  const exteriorBounds =
    context.glyphBounds ?? (pixels && pixelType3.size ? context.partialFontGlyphBounds : undefined)
  if (!Array.isArray(exteriorBounds)) return
  const fonts = new Map(),
    outsideInk = [],
    strokeEnvelopes = []
  for (const f of exteriorBounds) {
    if (typeof f?.fontName !== 'string' || fonts.has(f.fontName) || !Array.isArray(f.glyphs)) return
    const bounds = new Map()
    for (const g of f.glyphs) {
      if (
        typeof g?.fontChar !== 'string' ||
        bounds.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      bounds.set(g.fontChar, g.bounds)
    }
    fonts.set(f.fontName, bounds)
  }
  for (const p of chars.filter((p) => p.strokeState)) {
    if (!pixels || !p.group || p.glyph.operatorListId != null || p.glyph.isInFont !== true) return
    const b = fonts.get(p.font)?.get(p.glyph.fontChar)
    if (!finite(b, 4)) return
    const ink = box(
        [
          p.origin[0] + b[0] * p.size,
          p.origin[1] + b[1] * p.size,
          p.origin[0] + b[2] * p.size,
          p.origin[1] + b[3] * p.size
        ],
        p.matrix
      ),
      rect = nativeFillStrokeGlyphEnvelope(ink, p.strokeState, 4)
    if (!valid(ink) || !rect || !inside(p.group.rect, rect)) return
    strokeEnvelopes.push({ ink, state: p.strokeState, rect })
  }
  for (const p of outsideGlyphs) {
    const b = fonts.get(p.font)?.get(p.glyph.fontChar)
    if (
      pixels &&
      context.skippedSpaceGlyphs?.some(
        (z) =>
          z.operationIndex === p.i &&
          z.glyphIndex === p.glyphIndex &&
          z.fontName === p.font &&
          z.fontChar === p.glyph.fontChar &&
          z.width === p.glyph.width &&
          /^\s*$/u.test(p.glyph.unicode)
      )
    )
      continue
    if (p.glyph.isInFont !== true || !finite(b, 4)) return
    const rect = box(
      [
        p.origin[0] + b[0] * p.size,
        p.origin[1] + b[1] * p.size,
        p.origin[0] + b[2] * p.size,
        p.origin[1] + b[3] * p.size
      ],
      p.matrix
    )
    if (groups.some((g) => intersection(rect, g.rect) > 0)) return
    outsideInk.push(rect)
  }
  return {
    groups,
    records,
    outsideInk: [...outsideInk, ...outsidePaint],
    ...(exteriorPixels ? { outsidePaints } : {}),
    fonts,
    pixelType3,
    internalZeroParts,
    strokeEnvelopes,
    ...(pairedPixels ? { outsideParts: outsideGlyphs } : {})
  }
}

// A group clip owns paint, but does not itself prove a text claim. Require the
// original whole horizontal font plus every loaded glyph's membership and ink.
// This optional proof never admits groups to the ordinary glyph inventory.
function nativeGroupLabelClaims(group, tokens, context) {
  const fonts = context.glyphBounds
  if (!Array.isArray(fonts)) return []
  const claims = []
  for (const record of group.records) {
    const token = tokens.find((t) => t.sourceItem?.index === record.index)
    if (
      !record.token.horizontal ||
      !/^\p{L}[\p{L}\p{N} -]{1,38}$/u.test(record.r.str) ||
      !proveNativeUniqueWholeFonts([token], tokens)
    )
      continue
    const matches = fonts.filter((f) => f.fontName === record.r.fontName)
    if (matches.length !== 1 || !Array.isArray(matches[0].glyphs)) continue
    const complete = record.part.every(({ glyph, origin: [x, y], matrix, size }) => {
      if (
        glyph.isInFont !== true ||
        typeof glyph.fontChar !== 'string' ||
        !glyph.fontChar ||
        glyph.accent != null ||
        glyph.vmetric != null ||
        glyph.operatorListId != null ||
        matrix[0] <= 0 ||
        matrix[3] >= 0 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0
      )
        return false
      const bounds = matches[0].glyphs.filter((g) => g.fontChar === glyph.fontChar)
      if (bounds.length !== 1 || !finite(bounds[0].bounds, 4)) return false
      const b = bounds[0].bounds
      if (b[0] > b[2] || b[1] > b[3]) return false
      return inside(
        group.rect,
        box([x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size], matrix)
      )
    })
    if (complete) claims.push({ ...record.r.sourceItem })
  }
  return claims
}

// Replace only a mixed strip that demonstrably borrowed an independently
// captioned peer. The whole renderer clip supplies every edge, including text
// outside path bounds; no threshold changes the ordinary strip matcher.
export function nativeDisjointMixedFigureGroup(page, figure, captions, tables, tokens, context) {
  if (
    figure?.reason !== 'native-raster-vector-strip' ||
    !valid(figure.rect) ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !tables.every(valid)
  )
    return
  const caps = captions.filter((c) => c.page === page.pageNumber)
  if (
    caps.length !== 2 ||
    !caps.includes(figure.caption) ||
    !caps.every((c) => valid(c.rect) && /^(?:figure|fig\.?)\s+\d+[.:]/i.test(c.lines?.[0] ?? ''))
  )
    return
  const program = disjointGroupProgram(page, tokens, context)
  if (!program) return
  const { groups, records } = program
  for (const g of groups) {
    const owners = caps.filter((c) => {
      const lead = records
        .filter(
          (r) =>
            !r.group &&
            r.token.horizontal &&
            inside(c.rect, r.token.rect) &&
            Math.abs(r.token.rect[1] - c.rect[1]) < 0.01
        )
        .sort((a, b) => a.token.rect[0] - b.token.rect[0])
      if (
        !lead.length ||
        lead.map((r) => letters(r.r.str).join('')).join('') !== letters(c.lines[0]).join('') ||
        Math.abs(lead[0].token.rect[0] - c.rect[0]) > 0.01 ||
        lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01)
      )
        return false
      const h = Math.max(...lead.map((r) => r.token.height))
      return (
        c.rect[2] - c.rect[0] <= page.width * 0.5 &&
        g.rect[2] - g.rect[0] >= h * 8 &&
        g.rect[3] - g.rect[1] >= h * 8 &&
        c.rect[1] > g.rect[3] &&
        c.rect[1] - g.rect[3] <= h * 3 &&
        Math.abs(g.rect[0] - c.rect[0]) <= h * 0.25 &&
        Math.abs(g.rect[2] - c.rect[2]) <= h * 0.25
      )
    })
    if (owners.length !== 1 || !g.records.length || !g.paint.length) return
    g.caption = owners[0]
  }
  const own = groups.find((g) => g.caption === figure.caption),
    other = groups.find((g) => g !== own)
  if (
    !own ||
    !other ||
    own.caption === other.caption ||
    intersection(own.rect, other.rect) > 0 ||
    !(own.rect[0] >= other.rect[2] || other.rect[0] >= own.rect[2]) ||
    Math.abs(own.rect[1] - other.rect[1]) > 1 ||
    own.paint.filter((g) => g.kind === 'image').length !== 1 ||
    own.paint.filter((g) => g.kind === 'path').length < 12 ||
    other.paint.some((g) => g.kind !== 'path') ||
    !other.paint.some((g) => intersection(g.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, own.rect) > 0) ||
    caps.some((c) => intersection(c.rect, own.rect) > 0) ||
    records.some((r) => r.group !== own && intersection(r.label ?? r.token.rect, own.rect) > 0) ||
    other.paint.some((g) => intersection(g.rect, own.rect) > 0)
  )
    return
  const sourceItems = figure.sourceItems?.length ? [] : nativeGroupLabelClaims(own, tokens, context)
  return {
    ...figure,
    rect: own.rect,
    graphicsCount: own.paint.length,
    ...(sourceItems.length ? { sourceItems, issue: 'native-disjoint-mixed-group' } : {})
  }
}

// Numeric ticks may be paths. Recover a complete independent clip only when
// the existing crop omits consecutive native panel keys; no tick/font matcher
// is relaxed, and this proof grants no text ownership or translation claims.
export function nativeSingleVectorFigureGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !/^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]/u.test(cap.lines?.[0] ?? '')
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    keys = g.records.filter((r) => /^\([a-h]\)$/u.test(r.r.str)),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    keys.length < 3 ||
    keys.length > 8 ||
    keys
      .map((r) => r.r.str[1])
      .sort()
      .join('') !== 'abcdefgh'.slice(0, keys.length) ||
    !lead.length ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    Math.abs(rect[2] - cap.rect[2]) > height * 0.25 ||
    !inside(rect, figure.rect) ||
    !keys.some((r) => !inside(figure.rect, r.label)) ||
    g.paint.length < 12 ||
    g.paint.some((q) => q.kind !== 'path') ||
    !g.paint.some((q) => intersection(q.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// Engineering keys can themselves be vector paths. Admit this separate case
// only through two whole native titles explicitly named by the complete caption.
// The existing plot-key gate and every scope/font exclusion remain unchanged.
export function nativeCaptionNamedDrawingGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption,
    names =
      /^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]\s+Drawings of \(a\) (.+) and \(b\) (.+)\. Dimensions are in mm\.$/u.exec(
        cap?.lines?.[0] ?? ''
      )
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    cap.lines.length !== 1 ||
    !names ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !Array.isArray(tables) ||
    !tables.every(valid)
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    canonical = (s) => s.normalize('NFD').replace(/\s+/gu, ' ').toLowerCase().trim(),
    titles = names
      .slice(1)
      .map((name) => g.records.filter((r) => canonical(r.r.str) === canonical(name))),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    !lead.length ||
    titles.some((rs) => rs.length !== 1) ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01)
  )
    return
  const [a, b] = titles.map((rs) => rs[0])
  if (
    a === b ||
    !a.token.horizontal ||
    !b.token.horizontal ||
    a.r.fontName !== b.r.fontName ||
    a.r.height !== b.r.height ||
    a.token.rect[3] >= b.token.rect[1] ||
    titles.some((rs) => rs[0].part.some((p) => p.glyph.isInFont !== true)) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    !inside(rect, figure.rect) ||
    !titles.some((rs) => !inside(figure.rect, rs[0].label)) ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    cap.rect[2] > rect[2] ||
    g.paint.length < 12 ||
    g.paint.some((p) => p.kind !== 'path') ||
    !g.paint.some((p) => intersection(p.rect, figure.rect) > 0) ||
    tables.some((t) => intersection(t, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// A paired engineering header is independent of caption name expansion. Both
// whole keys, their adjacent titles and dimensions must belong to one closed
// native group; this geometry proof grants no text or translation ownership.
export function nativePairedDrawingHeaderGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    cap.lines?.length !== 1 ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    !/^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]\s+Drawings of \(a\) .+ and \(b\) .+\. Dimensions are in mm\.$/u.test(
      cap.lines[0]
    )
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    keys = g.records
      .filter((r) => /^\([a-h]\)$/u.test(r.r.str))
      .sort((a, b) => a.token.rect[1] - b.token.rect[1]),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    keys.length !== 2 ||
    keys.map((r) => r.r.str).join('') !== '(a)(b)' ||
    !lead.length ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    !inside(rect, figure.rect) ||
    !keys.some((r) => !inside(figure.rect, r.label)) ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    cap.rect[2] > rect[2] ||
    g.paint.length < 12 ||
    g.paint.some((q) => q.kind !== 'path') ||
    !g.paint.some((q) => intersection(q.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  const rows = keys.map((key) => ({
    key,
    headers: g.records.filter(
      (r) =>
        r !== key &&
        r.token.horizontal &&
        /^\p{L}[\p{L}\p{N} -]{1,38}$/u.test(r.r.str) &&
        r.r.fontName === key.r.fontName &&
        r.token.rect[0] >= key.token.rect[2] &&
        r.token.rect[0] - key.token.rect[2] <= key.token.height &&
        Math.min(r.token.rect[3], key.token.rect[3]) -
          Math.max(r.token.rect[1], key.token.rect[1]) >=
          Math.min(r.token.height, key.token.height) * 0.75
    )
  }))
  if (
    rows.some((r) => r.headers.length !== 1) ||
    keys[0].r.fontName !== keys[1].r.fontName ||
    Math.abs(keys[0].token.rect[0] - keys[1].token.rect[0]) >
      Math.min(...keys.map((r) => r.token.height)) * 0.25 ||
    rows[0].headers[0] === rows[1].headers[0] ||
    rows[0].headers[0].r.height !== rows[1].headers[0].r.height ||
    keys[0].token.rect[3] >= keys[1].token.rect[1]
  )
    return
  const complete = (record) => {
    const token = tokens.find((t) => t.sourceItem?.index === record.index)
    if (!record.token.horizontal || !proveNativeUniqueWholeFonts([token], tokens)) return false
    return record.part.every(({ glyph, origin: [x, y], matrix, size, font }) => {
      const matches = context.glyphBounds.filter((f) => f.fontName === font),
        bounds =
          matches.length === 1 ? matches[0].glyphs.filter((b) => b.fontChar === glyph.fontChar) : []
      if (
        glyph.isInFont !== true ||
        glyph.accent != null ||
        glyph.vmetric != null ||
        glyph.operatorListId != null ||
        bounds.length !== 1 ||
        !finite(bounds[0].bounds, 4) ||
        bounds[0].bounds[0] > bounds[0].bounds[2] ||
        bounds[0].bounds[1] > bounds[0].bounds[3]
      )
        return false
      const b = bounds[0].bounds
      return inside(
        rect,
        box([x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size], matrix)
      )
    })
  }
  if (
    rows.some((row) => !complete(row.key) || !complete(row.headers[0])) ||
    rows.some(
      ({ key }, n) =>
        g.records.filter(
          (r) =>
            /^(?:\d+(?:\.\d+)?|\(\d+(?:\.\d+)?\))$/u.test(r.r.str) &&
            r.token.rect[1] > key.token.rect[3] &&
            r.token.rect[3] < (keys[n + 1]?.token.rect[1] ?? rect[3]) &&
            complete(r)
        ).length < 3
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// The public renderer can retry at a smaller scale. Use the actual PNG's
// conservative scale interval and halo before publishing any image.
export function nativeSingleVectorGroupPng(png, candidate) {
  const proof = candidate?.groupRasterProof,
    raster = getPdfCropRasterProtectionFromPng(png, candidate?.rect, proof?.bounds)
  return (
    !!raster &&
    Array.isArray(proof.outsideInk) &&
    proof.outsideInk.every((r) => finite(r, 4) && intersection(r, raster.protection) === 0)
  )
}

function groupConfinedColor(a) {
  if (a?.[0] === 'Shading')
    return a.length === 3 && typeof a[1] === 'string' && a[1].length > 0 && a[2] === null
  if (
    a?.[0] !== 'TilingPattern' ||
    a.length !== 9 ||
    a[1] !== null ||
    !finite(a[3], 6) ||
    !valid(a[4]) ||
    !Number.isFinite(a[5]) ||
    !Number.isFinite(a[6]) ||
    a[5] <= 0 ||
    a[6] <= 0 ||
    a[7] !== 1 ||
    a[8] !== 2
  )
    return false
  const p = a[2]
  if (
    !Array.isArray(p?.fnArray) ||
    !Array.isArray(p.argsArray) ||
    p.length !== p.fnArray.length ||
    p.argsArray.length !== p.length ||
    p.length < 1 ||
    p.length > 64
  )
    return false
  let depth = 0
  for (let i = 0; i < p.length; i++) {
    const f = p.fnArray[i],
      args = p.argsArray[i]
    if (f === OPS.save) depth++
    else if (f === OPS.restore) {
      if (--depth < 0) return false
    } else if (f === OPS.transform) {
      if (!finite(args, 6)) return false
    } else if (f === OPS.dependency) {
      if (!Array.isArray(args) || !args.every((x) => typeof x === 'string')) return false
    } else if (f === OPS.paintImageXObject) {
      if (
        !Array.isArray(args) ||
        typeof args[0] !== 'string' ||
        !args.slice(1).every((x) => Number.isSafeInteger(x) && x > 0)
      )
        return false
    } else return false
  }
  return depth === 0
}

const groupTypedPrototype = Object.getPrototypeOf(Uint8Array.prototype),
  groupBufferGetter = Object.getOwnPropertyDescriptor(groupTypedPrototype, 'buffer').get,
  groupOffsetGetter = Object.getOwnPropertyDescriptor(groupTypedPrototype, 'byteOffset').get,
  groupLengthGetter = Object.getOwnPropertyDescriptor(groupTypedPrototype, 'byteLength').get,
  groupBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get,
  groupResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get,
  groupFloat16 = globalThis.Float16Array
function groupFontByteWindow(data) {
  if (
    !data ||
    types.isProxy(data) ||
    !ArrayBuffer.isView(data) ||
    ![Float32Array.prototype, groupFloat16?.prototype].includes(Object.getPrototypeOf(data)) ||
    Object.getOwnPropertySymbols(data).length ||
    ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'toJSON'].some((k) =>
      Object.hasOwn(data, k)
    )
  )
    return
  const buffer = groupBufferGetter.call(data)
  if (
    types.isProxy(buffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    Reflect.ownKeys(buffer).length ||
    (groupResizable && groupResizable.call(buffer))
  )
    return
  return {
    prototype: Object.getPrototypeOf(data),
    buffer,
    bufferByteLength: groupBufferLength.call(buffer),
    byteOffset: groupOffsetGetter.call(data),
    byteLength: groupLengthGetter.call(data)
  }
}
function groupSlots(object, keys) {
  const chain = []
  for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner) || chain.length >= 8) return
    chain.push({
      owner,
      prototype: Object.getPrototypeOf(owner),
      entries: keys.map((key) => [key, Object.getOwnPropertyDescriptor(owner, key)])
    })
  }
  return chain
}
function groupSlotsCurrent(chain) {
  return (
    !!chain &&
    chain.every(
      (x) =>
        Object.getPrototypeOf(x.owner) === x.prototype &&
        x.entries.every(([key, before]) => {
          const now = Object.getOwnPropertyDescriptor(x.owner, key)
          return before
            ? now &&
                ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                  (k) => now[k] === before[k]
                )
            : !now
        })
    )
  )
}
function groupDataSlot(object, key) {
  for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) return
    const d = Object.getOwnPropertyDescriptor(owner, key)
    if (d) return Object.hasOwn(d, 'value') ? d.value : undefined
  }
}
function groupArrayData(a) {
  return (
    Array.isArray(a) &&
    !types.isProxy(a) &&
    Object.getPrototypeOf(a) === Array.prototype &&
    Reflect.ownKeys(Object.getOwnPropertyDescriptors(a)).every((k) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(a, k), 'value')
    )
  )
}
function liveOrdinaryGroupFonts(
  context,
  program,
  witness,
  scope,
  strictArguments = false,
  purpose
) {
  const strokePacket = purpose === strokePairLiveMode || purpose === strokePairDisplayMode,
    compiledDisplay = purpose === strokePairDisplayMode
  const compiledPaths = [],
    packetValues = strokePacket && nativeRecoveryOwnValues(program),
    packetCurrent = packetValues?.current,
    outlineBounds = (name, character) =>
      strokePacket
        ? context.glyphBounds
            .find((f) => f.fontName === name)
            ?.glyphs.find((g) => g.fontChar === character)?.bounds
        : program.fonts.get(name)?.get(character)
  if (
    strokePacket &&
    (witness !== packetValues?.glyphs || typeof packetCurrent !== 'function' || !packetCurrent())
  )
    return
  const options = nativeRecoveryOwnValues(scope)
  if (!options) return
  const { nativePage, pageContent, operators } = options,
    source = context.operators,
    raw = context.content.items,
    livePageValues = !!nativePage && typeof nativePage === 'object' && !types.isProxy(nativePage),
    opValues = nativeRecoveryOwnValues(operators),
    contentCurrent = retainNativeRecoveryInputs([pageContent]),
    forward = new Map(),
    reverse = new Map()
  if (
    !livePageValues ||
    !opValues ||
    !contentCurrent ||
    !groupArrayData(opValues.fnArray) ||
    !groupArrayData(opValues.argsArray) ||
    opValues.fnArray.length !== source.fnArray.length ||
    opValues.argsArray.length !== source.argsArray.length ||
    !source.fnArray.every((op, i) => op === opValues.fnArray[i]) ||
    !Array.isArray(pageContent?.items) ||
    pageContent.items.length !== raw.length
  )
    return
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i],
      b = pageContent.items[i]
    if (
      !b ||
      !['str', 'dir', 'width', 'height', 'hasEOL'].every((k) => a[k] === b[k]) ||
      !equal(a.transform, b.transform) ||
      !equal(context.content.styles[a.fontName], pageContent.styles[b.fontName]) ||
      (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    forward.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  // Resource identifiers are local to a render intent/document instance. Bind
  // only the already confined image/pattern operations, preserving every other
  // argument and the complete actual program references through publication.
  const fontForward = [...forward]
  const resourceId = (id, kind) =>
    typeof id === 'string' &&
    new RegExp('^' + kind + '_p' + (context.pageNumber - 1) + '_[0-9]+$', 'u').test(id)
  const bindResource = (a, b, kind) => {
    if (
      !resourceId(a, kind) ||
      !resourceId(b, kind) ||
      (forward.has(a) && forward.get(a) !== b) ||
      (reverse.has(b) && reverse.get(b) !== a)
    )
      return false
    forward.set(a, b)
    reverse.set(b, a)
    return true
  }
  const bindImage = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 3 &&
    b.length === 3 &&
    a.slice(1).every((x, i) => Number.isSafeInteger(x) && x > 0 && x === b[i + 1]) &&
    bindResource(a[0], b[0], 'img')
  for (let i = 0; i < source.fnArray.length; i++) {
    const op = source.fnArray[i],
      a = source.argsArray[i],
      b = opValues.argsArray[i]
    if (op === OPS.paintImageXObject) {
      if (!bindImage(a, b)) return
    }
    if ([OPS.setFillColorN, OPS.setStrokeColorN].includes(op)) {
      if (!groupConfinedColor(a) || !groupConfinedColor(b) || a[0] !== b[0]) return
      if (a[0] === 'Shading') {
        if (!bindResource(a[1], b[1], 'pattern')) return
      } else {
        const x = a[2],
          y = b[2]
        if (!equal(x.fnArray, y.fnArray) || x.length !== y.length) return
        for (let j = 0; j < x.length; j++)
          if (x.fnArray[j] === OPS.paintImageXObject && !bindImage(x.argsArray[j], y.argsArray[j]))
            return
      }
    }
  }
  const resourceArgs = (op, a) => {
    if (op === OPS.paintImageXObject) return [forward.get(a[0]), a[1], a[2]]
    if (op === OPS.dependency) return a.map((id) => forward.get(id) ?? id)
    if ([OPS.setFillColorN, OPS.setStrokeColorN].includes(op)) {
      if (a[0] === 'Shading') return [a[0], forward.get(a[1]), a[2]]
      return [
        a[0],
        a[1],
        { ...a[2], argsArray: a[2].argsArray.map((v, i) => resourceArgs(a[2].fnArray[i], v)) },
        ...a.slice(3)
      ]
    }
    return a
  }
  const scopeSlots = groupSlots(scope, ['nativePage', 'pageContent', 'operators']),
    scopePrototype = Object.getPrototypeOf(scope),
    scopeKeys = Reflect.ownKeys(scope),
    arraySlots = groupSlots(operators, ['fnArray', 'argsArray', 'lastChunk', 'separateAnnots']),
    fnSlots = groupSlots(opValues.fnArray, Reflect.ownKeys(opValues.fnArray)),
    argsSlots = groupSlots(opValues.argsArray, Reflect.ownKeys(opValues.argsArray)),
    consumed = [],
    bindings = [],
    glyphKeys = [
      'unicode',
      'fontChar',
      'width',
      'isSpace',
      'isInFont',
      'accent',
      'vmetric',
      'operatorListId',
      'originalCharCode'
    ]
  const glyphData = (g) => {
    const d = nativeRecoveryOwnValues(g)
    return d && glyphKeys.map((k) => d[k])
  }
  for (let i = 0; i < source.fnArray.length; i++) {
    const op = source.fnArray[i],
      a = source.argsArray[i],
      b = opValues.argsArray[i]
    let cachedPath = false
    if (
      strictArguments &&
      !equal(op === OPS.setFont ? [forward.get(a[0]), ...a.slice(1)] : resourceArgs(op, a), b)
    ) {
      const proof =
        strokePacket &&
        compiledDisplay &&
        op === OPS.constructPath &&
        (nativeCompiledPathBinding(a, b) || strokeEmptyEndPathBinding(a, b))
      if (!proof) return
      compiledPaths.push(proof)
      cachedPath = true
    }
    if (op === OPS.constructPath) {
      if (!groupArrayData(b) || a?.[0] !== b[0]) return
      consumed.push([b, groupSlots(b, ['0'])])
      if (strictArguments) bindings.push(cachedPath ? [b[0], b[2]] : b)
      continue
    }
    if (op === OPS.setFont) {
      if (!groupArrayData(b) || !equal([forward.get(a[0]), a[1]], b)) return
      bindings.push(b)
      continue
    }
    if (op === OPS.showText) {
      if (
        !groupArrayData(b) ||
        !groupArrayData(b[0]) ||
        !Array.isArray(a?.[0]) ||
        a[0].length !== b[0].length
      )
        return
      consumed.push([b, groupSlots(b, ['0'])], [b[0], groupSlots(b[0], Reflect.ownKeys(b[0]))])
      for (let k = 0; k < a[0].length; k++) {
        const x = a[0][k],
          y = b[0][k]
        if (typeof x === 'number') {
          if (y !== x) return
          continue
        }
        const vals = glyphData(y)
        if (
          !vals ||
          !equal(
            glyphKeys.map((k) => x[k]),
            vals
          ) ||
          (y.operatorListId != null &&
            !program.records.some((r) =>
              r.part.some(
                (part) =>
                  part.i === i &&
                  part.glyphIndex === k &&
                  program.pixelType3?.get(part.font)?.glyphs.has(y.operatorListId)
              )
            ))
        )
          return
        consumed.push([y, groupSlots(y, glyphKeys)])
      }
      continue
    }
    const expected = resourceArgs(op, a)
    if (!equal(expected, b)) return
    bindings.push(b)
  }
  const bindingsCurrent = retainNativeRecoveryInputs(bindings),
    pageSlots = groupSlots(nativePage, ['commonObjs', 'render', 'getViewport', 'rotate']),
    getViewport = groupDataSlot(nativePage, 'getViewport'),
    store = groupDataSlot(nativePage, 'commonObjs'),
    get = store && groupDataSlot(store, 'get'),
    storeSlots = store && groupSlots(store, ['get'])
  if (
    !bindingsCurrent ||
    typeof get !== 'function' ||
    typeof getViewport !== 'function' ||
    !pageSlots ||
    !storeSlots
  )
    return
  const viewportCurrent = () => {
    const viewport = getViewport.call(nativePage, { scale: 1, rotation: context.viewport.rotation })
    if (!viewport || types.isProxy(viewport)) return false
    const values = {},
      keys = ['width', 'height', 'scale', 'rotation', 'transform']
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(viewport, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
      values[key] = descriptor.value
    }
    return (
      finite(values.transform, 6) &&
      !!retainNativeRecoveryInputs([values.transform]) &&
      keys.every((key) => equal(values[key], context.viewport[key]))
    )
  }
  if (!viewportCurrent()) return
  const keys = [
      'fontMatrix',
      'loadedName',
      'vertical',
      'missingFile',
      'isType3Font',
      'isInvalidPDFjsFont',
      'disableFontFace',
      'remeasure',
      'getPathGenerator',
      'compiledGlyphs',
      'fontExtraProperties',
      'charProcOperatorList'
    ],
    faces = [],
    pixelFaces = [],
    targets = new Map()
  if (strokePacket) {
    const shows = new Set()
    for (const g of [...program.records.flatMap((r) => r.part.map((p) => p.g)), ...witness]) {
      if (
        !g ||
        g.show?.i !== g.i ||
        g.show.fontName !== g.fontName ||
        source.fnArray[g.i] !== OPS.showText
      )
        return
      const key = g.fontName + '\0' + g.i
      if (shows.has(key)) continue
      shows.add(key)
      if (!targets.has(g.fontName)) targets.set(g.fontName, new Set())
      for (const glyph of source.argsArray[g.i][0])
        if (typeof glyph !== 'number') {
          if (
            typeof glyph.fontChar !== 'string' ||
            !finite(outlineBounds(g.fontName, glyph.fontChar), 4)
          )
            return
          targets.get(g.fontName).add(glyph.fontChar)
        }
    }
  } else {
    const wanted = [...program.records.filter((r) => !r.group).flatMap((r) => r.part), ...witness]
    for (const p of wanted) {
      if (!targets.has(p.font)) targets.set(p.font, new Set())
      targets.get(p.font).add(p.glyph.fontChar)
    }
  }
  for (const [name, id] of fontForward) {
    if (typeof name !== 'string' || typeof id !== 'string') continue
    const font = get.call(store, id),
      slots = groupSlots(font, keys)
    if (!slots) return
    for (const row of slots)
      for (const [key, d] of row.entries)
        if (d && !Object.hasOwn(d, 'value')) {
          const text =
            typeof d.get === 'function'
              ? Function.prototype.toString.call(d.get).replace(/\s/gu, '')
              : ''
          if (
            row.owner !== Object.getPrototypeOf(font) ||
            ![
              `get${key}(){returnthis.#fontData.${key};}`,
              `get${key}(){returnthis.#fontData.${key}??false;}`
            ].includes(text)
          )
            return
        }
    if (program.pixelType3?.has(name)) {
      if (
        targets.has(name) ||
        font.loadedName !== id ||
        font.disableFontFace !== true ||
        font.fontExtraProperties !== true
      )
        return
      const current = groupPixelType3LiveFont(font, program.pixelType3.get(name))
      if (!current || !current()) return
      pixelFaces.push({ font, id, slots, current })
      continue
    }
    // CanvasGraphics.setFont uses FONT_IDENTITY_MATRIX only when this slot is
    // absent. Keep that exact absence bound alongside explicit ordinary matrices.
    if (
      font.isType3Font !== false ||
      font.missingFile !== false ||
      font.isInvalidPDFjsFont !== false ||
      font.disableFontFace !== true ||
      font.fontExtraProperties !== true ||
      font.vertical !== false ||
      (font.remeasure !== undefined && font.remeasure !== false) ||
      (font.fontMatrix !== undefined &&
        !equal(Array.from(font.fontMatrix ?? []), [0.001, 0, 0, 0.001, 0, 0])) ||
      typeof font.loadedName !== 'string'
    )
      return
    const getPath = groupDataSlot(font, 'getPathGenerator'),
      cache = groupDataSlot(font, 'compiledGlyphs'),
      paths = []
    if (typeof getPath !== 'function') return
    for (const character of targets.get(name) ?? []) {
      const bounds = outlineBounds(name, character)
      if (!finite(bounds, 4)) return
      const beforeCache = cache && groupSlots(cache, [character])
      if (beforeCache?.some((x) => x.entries.some(([, d]) => d && !Object.hasOwn(d, 'value'))))
        return
      const compiled = getPath.call(font, store, character),
        getBounds = groupDataSlot(compiled, 'getBounds')
      if (typeof getBounds !== 'function' || !equal(Array.from(getBounds.call(compiled)), bounds))
        return
      const key = font.loadedName + '_path_' + character,
        info = get.call(store, key),
        infoSlots = groupSlots(info, ['path']),
        compiledSlots = groupSlots(compiled, ['getBounds']),
        descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(info), 'path')
      if (
        !infoSlots ||
        !compiledSlots ||
        Object.hasOwn(info, 'path') ||
        typeof descriptor?.get !== 'function'
      )
        return
      const data = descriptor.get.call(info),
        view = groupFontByteWindow(data)
      if (!view || view.bufferByteLength > 1024 * 1024) return
      paths.push({
        key,
        info,
        infoSlots,
        compiled,
        compiledSlots,
        getBounds,
        character,
        getter: descriptor.get,
        view,
        sha: createHash('sha256')
          .update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
          .digest('hex')
      })
    }
    faces.push({
      name,
      id,
      font,
      slots,
      cacheSlots:
        cache &&
        groupSlots(
          cache,
          paths.map((p) => p.character)
        ),
      getPath,
      paths,
      loadedName: font.loadedName,
      matrix: JSON.stringify(
        font.fontMatrix === undefined ? undefined : Array.from(font.fontMatrix)
      )
    })
  }
  if (!faces.length) return
  return () => {
    if (
      (strokePacket && !packetCurrent()) ||
      !compiledPaths.every((current) => current()) ||
      !nativeRecoveryOwnValues(scope) ||
      Object.getPrototypeOf(scope) !== scopePrototype ||
      Reflect.ownKeys(scope).length !== scopeKeys.length ||
      !groupSlotsCurrent(scopeSlots) ||
      !contentCurrent() ||
      !bindingsCurrent() ||
      !groupSlotsCurrent(arraySlots) ||
      !groupSlotsCurrent(fnSlots) ||
      !groupSlotsCurrent(argsSlots) ||
      !groupSlotsCurrent(pageSlots) ||
      !viewportCurrent() ||
      !groupSlotsCurrent(storeSlots) ||
      !consumed.every(
        ([object, slots]) =>
          (Array.isArray(object) ? groupArrayData(object) : !!nativeRecoveryOwnValues(object)) &&
          groupSlotsCurrent(slots)
      ) ||
      !faces.every(
        (f) =>
          groupSlotsCurrent(f.slots) &&
          (!f.cacheSlots || groupSlotsCurrent(f.cacheSlots)) &&
          f.paths.every((p) => groupSlotsCurrent(p.infoSlots) && groupSlotsCurrent(p.compiledSlots))
      )
    )
      return false
    return (
      pixelFaces.every(
        (f) => get.call(store, f.id) === f.font && groupSlotsCurrent(f.slots) && f.current()
      ) &&
      faces.every(
        (f) =>
          get.call(store, f.id) === f.font &&
          f.font.isType3Font === false &&
          f.font.missingFile === false &&
          f.font.isInvalidPDFjsFont === false &&
          f.font.disableFontFace === true &&
          f.font.fontExtraProperties === true &&
          f.font.vertical === false &&
          (f.font.remeasure === undefined || f.font.remeasure === false) &&
          f.font.loadedName === f.loadedName &&
          JSON.stringify(
            f.font.fontMatrix === undefined ? undefined : Array.from(f.font.fontMatrix)
          ) === f.matrix &&
          f.font.getPathGenerator === f.getPath &&
          f.paths.every((p) => {
            if (
              get.call(store, p.key) !== p.info ||
              f.getPath.call(f.font, store, p.character) !== p.compiled ||
              !equal(Array.from(p.getBounds.call(p.compiled)), outlineBounds(f.name, p.character))
            )
              return false
            const v = groupFontByteWindow(p.getter.call(p.info))
            return (
              v &&
              v.prototype === p.view.prototype &&
              v.buffer === p.view.buffer &&
              v.byteOffset === p.view.byteOffset &&
              v.byteLength === p.view.byteLength &&
              createHash('sha256')
                .update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
                .digest('hex') === p.sha
            )
          })
      )
    )
  }
}

// A rendered group canvas can prove physical crop bounds without granting any
// of its labels ownership. The private plan also retains the live ordinary fonts
// and actual program; serialized metadata cannot recreate this certificate.
function nativeExclusionBodyLanes(program, page, caption, publishedRect, rect, context) {
  const printedRow = (records) =>
      records
        .toSorted((a, b) => a.token.rect[0] - b.token.rect[0])
        .map(
          (r, i, all) =>
            (i && r.token.rect[0] - all[i - 1].token.rect[2] > r.r.height * 0.1 ? ' ' : '') +
            r.r.str
        )
        .join(''),
    annotation = (text) => /^\s*(?:Task|Legend|Prediction|Target|Panel)\b/iu.test(text)
  const group = program.groups[0],
    ink = (r) =>
      union(
        r.part.map((p) => {
          const b = program.fonts.get(p.font)?.get(p.glyph.fontChar)
          if (!finite(b, 4)) throw Error('Missing exterior native outline')
          return box(
            [
              p.origin[0] + b[0] * p.size,
              p.origin[1] + b[1] * p.size,
              p.origin[0] + b[2] * p.size,
              p.origin[1] + b[3] * p.size
            ],
            p.matrix
          )
        })
      ),
    before = program.records.filter((r) => !r.group && r.part.every((p) => p.i < group.begin)),
    captionRecords = program.records.filter((r) => !r.group && inside(caption.rect, r.token.rect)),
    captionEm = Math.max(...captionRecords.map((r) => r.r.height)),
    prose = before.filter(
      (r) =>
        r.part.every((p) => p.visible) &&
        r.token.horizontal &&
        r.r.height > captionEm * 1.05 &&
        r.r.height < captionEm * 1.5 &&
        (r.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
        r.token.rect[2] - r.token.rect[0] >= page.width * 0.2
    ),
    lanes = []
  const captionLast = Math.max(...captionRecords.flatMap((r) => r.part.map((p) => p.i))),
    captionEnd = captionLast + 1,
    exterior = program.records.filter((r) => !r.group)
  if (!captionRecords.every((r) => r.part.every((p) => p.visible))) return
  const suffixBoundary = (row, font, em) => {
    const first = Math.min(...row.records.flatMap((r) => r.part.map((p) => p.i))),
      o = context.operators
    if (first <= captionLast) return false
    if (o.fnArray[captionEnd] === OPS.endText) return first > captionEnd
    if (first - captionLast > 32) return false
    let changedFont = false,
      positioned = false
    for (let i = captionEnd; i < first; i++) {
      const op = o.fnArray[i],
        args = o.argsArray[i]
      if (op === OPS.setFont) {
        if (args?.length !== 2 || args[0] !== font || Math.abs(args[1] - em) > 0.02) return false
        changedFont = true
      } else if (op === OPS.moveText || op === OPS.setTextMatrix) {
        const values = op === OPS.setTextMatrix && args?.length === 1 ? args[0] : args
        if (!finite(values, op === OPS.moveText ? 2 : 6)) return false
        positioned = true
      } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
        if (!equal(args, ['#000000'])) return false
      } else if (op === OPS.dependency) {
        if (!Array.isArray(args) || !args.every((id) => id === font)) return false
      } else return false
    }
    return changedFont && positioned
  }
  for (const seed of prose) {
    const em = seed.r.height,
      font = seed.r.fontName,
      primary = exterior.filter(
        (r) =>
          r.token.horizontal &&
          r.r.fontName === font &&
          Math.abs(r.r.height - em) < 0.02 &&
          r.token.rect[0] >= seed.token.rect[0] - 0.02
      ),
      starts = prose.filter(
        (r) =>
          r.r.fontName === font &&
          Math.abs(r.r.height - em) < 0.02 &&
          r.token.rect[0] >= seed.token.rect[0] - 0.02 &&
          r.token.rect[0] <= seed.token.rect[0] + em * 1.05
      ),
      left = seed.token.rect[0],
      right = Math.max(...starts.map((r) => r.token.rect[2]))
    if (
      !Number.isFinite(right) ||
      right - left > page.width * 0.48 ||
      lanes.some((l) => Math.abs(l.left - left) < em)
    )
      continue
    const insideLane = (r) =>
        r.token.rect[0] >= left - em * 0.05 && r.token.rect[2] <= right + em * 0.1,
      bases = [...new Set(primary.filter(insideLane).map((r) => r.token.baseline))].sort(
        (a, b) => a - b
      ),
      rows = bases.map((y) => {
        const fragments = primary.filter(
          (r) => insideLane(r) && Math.abs(r.token.baseline - y) < 0.02
        )
        return {
          y,
          records: [],
          lo: Math.min(...fragments.map((r) => r.index)),
          hi: Math.max(...fragments.map((r) => r.index))
        }
      })
    let ambiguous = false
    for (const r of exterior.filter(insideLane)) {
      if (r.r.height < em / 2 || r.r.height > em * 1.05) continue
      const tolerance = r.r.height < em * 0.85 ? em * 0.6 : 0.02,
        sourceRows = rows.filter((row) => r.index >= row.lo && r.index <= row.hi),
        owners = sourceRows.length
          ? sourceRows
          : rows.filter((row) => Math.abs(row.y - r.token.baseline) <= tolerance)
      if (owners.length > 1) {
        ambiguous = true
        break
      }
      if (
        sourceRows.length === 1 &&
        (ink(r)[1] < owners[0].y - em * 2 || ink(r)[3] > owners[0].y + em)
      ) {
        ambiguous = true
        break
      }
      if (owners.length === 1) owners[0].records.push(r)
    }
    if (ambiguous) continue
    const eligible = rows.filter((row) => {
        const records = row.records,
          text = printedRow(records)
        row.words = text.match(/\p{L}{2,}/gu)?.length ?? 0
        return (
          row.words > 0 &&
          records.length &&
          Math.min(...records.map((r) => r.token.rect[0])) <= left + em * 1.05 &&
          !annotation(text)
        )
      }),
      above = eligible.filter((row) =>
        row.records.every(
          (r) => r.token.rect[3] < group.rect[1] - em && r.part.every((p) => p.i < group.begin)
        )
      ),
      possibleBelow = eligible.filter((row) =>
        row.records.every((r) => r.token.rect[1] > caption.rect[3] + em / 2)
      ),
      suffix = possibleBelow
        .filter((row) => row.records.every((r) => r.part.every((p) => p.i > captionLast)))
        .sort(
          (a, b) =>
            Math.min(...a.records.flatMap((r) => r.part.map((p) => p.i))) -
            Math.min(...b.records.flatMap((r) => r.part.map((p) => p.i)))
        ),
      suffixProved = suffix.length && suffixBoundary(suffix[0], font, em),
      below = possibleBelow.filter(
        (row) =>
          row.records.every((r) => r.part.every((p) => p.i < group.begin)) ||
          (suffixProved && suffix.includes(row))
      ),
      regular = (rs) =>
        rs.some((row, i) => {
          if (i < 2) return false
          const three = rs.slice(i - 2, i + 1)
          return (
            three[1].y - three[0].y >= em &&
            three[1].y - three[0].y <= em * 1.7 &&
            three[2].y - three[1].y >= em &&
            three[2].y - three[1].y <= em * 1.7 &&
            three.reduce((n, r) => n + r.words, 0) >= 12 &&
            three.filter((r) => r.words >= 4).length >= 2
          )
        })
    if (!regular(above) || !regular(below)) continue
    const anchors = [...above, ...below].flatMap((row) => row.records),
      lo = Math.min(...anchors.map((r) => r.index)),
      hi = Math.max(...anchors.map((r) => r.index))
    lanes.push({
      left: left - em * 0.05,
      right: right + em * 0.1,
      font,
      em,
      lo,
      hi,
      anchors,
      rows: eligible,
      allRows: rows
    })
  }
  const removed = before.filter(
      (r) => intersection(ink(r), publishedRect) > 0 && intersection(ink(r), rect) === 0
    ),
    members = new Map()
  const equationLabels = new Set()
  for (const lane of lanes) {
    const inLane = (r) =>
        r.token.rect[0] >= lane.left &&
        r.token.rect[2] <= lane.right &&
        inside([lane.left, 0, lane.right, page.height], ink(r)),
      tags = before.filter(
        (r) =>
          /^\(\d+\)$/u.test(r.r.str) &&
          inLane(r) &&
          r.r.fontName === lane.font &&
          Math.abs(r.r.height - lane.em) < 0.02 &&
          Math.abs(r.token.rect[2] - lane.right) < lane.em / 4
      )
    const complete = (tag) => {
      const intro = before
          .filter((r) => r.index < tag.index && inLane(r) && /\p{L}{3,}/u.test(r.r.str))
          .at(-1),
        body = intro && before.filter((r) => r.index > intro.index && r.index < tag.index)
      if (
        !body ||
        body.length < 4 ||
        body.length > 128 ||
        body.some(
          (r) => !inLane(r) || /\p{L}{3,}/u.test(r.r.str) || !r.part.every((p) => p.visible)
        ) ||
        !body.some((r) => /[=≤≥<>⊆∈]/u.test(r.r.str))
      )
        return false
      const bounds = union(body.map(ink)),
        tagInk = ink(tag),
        last = Math.max(...tag.part.map((p) => p.i)),
        next = before.find((r) => r.index > tag.index)
      const inline = body.filter((r) => r.token.rect[1] <= intro.token.rect[3] + lane.em),
        inlineBases = [
          ...new Set([
            intro.token.baseline,
            ...inline
              .filter((r) => Math.abs(r.r.height - lane.em) < 0.02)
              .map((r) => r.token.baseline)
          ])
        ].filter(
          (y) => y >= intro.token.baseline - 0.02 && y <= intro.token.baseline + lane.em * 1.7
        ),
        inlineProved =
          body.some((r) => r.token.rect[1] > intro.token.rect[3] + lane.em * 2) &&
          inline.every(
            (r) =>
              inlineBases.filter(
                (y) =>
                  Math.abs(y - r.token.baseline) <
                  (r.r.height < lane.em * 0.85 ? lane.em * 0.6 : 0.02)
              ).length === 1
          )
      if (
        bounds[3] > tagInk[3] + lane.em * 2 ||
        tagInk[1] - bounds[3] > lane.em * 2 ||
        (intro.token.rect[3] >= bounds[1] && !inlineProved) ||
        bounds[1] < intro.token.rect[1] - lane.em ||
        bounds[1] - intro.token.rect[3] > lane.em * 4 ||
        !next
      )
        return false
      if (
        inLane(next) &&
        next.token.rect[1] >= bounds[1] &&
        lane.rows.some(
          (row) =>
            row.records.includes(next) &&
            row.words >= 4 &&
            row.records.every((r) => r.index > tag.index)
        )
      )
        return true
      const following = lanes.filter(
        (l) =>
          l !== lane &&
          next.token.rect[0] >= l.left &&
          next.token.rect[2] <= l.right &&
          next.r.fontName === l.font &&
          Math.abs(next.r.height - l.em) < 0.02 &&
          Math.abs(next.token.rect[0] - l.left) < l.em / 4 &&
          next.token.rect[1] <= Math.min(...l.anchors.map((r) => r.token.rect[1])) + l.em &&
          tag.token.baseline > page.height * 0.85 &&
          next.token.rect[1] < page.height * 0.15
      )
      if (following.length !== 1 || !/^\p{Lu}\p{L}*[, ]/u.test(next.r.str)) return false
      let positioned = false
      const first = Math.min(...next.part.map((p) => p.i))
      for (let i = last + 1; i < first; i++) {
        const op = context.operators.fnArray[i],
          a = context.operators.argsArray[i]
        if (op === OPS.moveText || op === OPS.setTextMatrix) {
          if (
            !finite(
              op === OPS.setTextMatrix && a?.length === 1 ? a[0] : a,
              op === OPS.moveText ? 2 : 6
            )
          )
            return false
          positioned = true
        } else if (op === OPS.setFont) {
          if (a?.[0] !== following[0].font || Math.abs(a?.[1] - following[0].em) > 0.02)
            return false
        } else return false
      }
      return positioned
    }
    for (let i = 1; i < tags.length; i++)
      if (
        Number.isSafeInteger(Number(tags[i].r.str.slice(1, -1))) &&
        Number(tags[i].r.str.slice(1, -1)) === Number(tags[i - 1].r.str.slice(1, -1)) + 1 &&
        Math.abs(tags[i].token.rect[2] - tags[i - 1].token.rect[2]) < 0.02 &&
        complete(tags[i - 1]) &&
        complete(tags[i])
      ) {
        equationLabels.add(tags[i - 1])
        equationLabels.add(tags[i])
      }
  }
  const sectionMember = (record, lane) => {
    const row = before.filter(
        (r) =>
          r.index >= lane.lo &&
          r.index <= lane.hi &&
          r.r.fontName === record.r.fontName &&
          Math.abs(r.r.height - record.r.height) < 0.02 &&
          Math.abs(r.token.baseline - record.token.baseline) < 0.02 &&
          r.part.every((p) => p.visible)
      ),
      romanOrdinal = row.filter((r) => /^[IVXLCDM]+\.$/u.test(r.r.str)),
      romanTitle = row.filter((r) => /^[A-Z][A-Z -]{3,}$/u.test(r.r.str)),
      roman = romanOrdinal.length === 1 && romanTitle.length === 1,
      ordinal = roman ? romanOrdinal : row.filter((r) => /^[A-Z]\.$/u.test(r.r.str)),
      title = roman
        ? romanTitle
        : row.filter((r) => /^[A-Z][a-z]+(?:[ -][A-Za-z]+){0,4}$/u.test(r.r.str))
    if (
      row.length !== 2 ||
      ordinal.length !== 1 ||
      title.length !== 1 ||
      !row.includes(record) ||
      ordinal[0].token.rect[2] >= title[0].token.rect[0] ||
      title[0].token.rect[0] - ordinal[0].token.rect[2] > record.r.height * 2 ||
      record.r.height < lane.em * 0.8 ||
      record.r.height > lane.em
    )
      return false
    const bounds = union(row.map((r) => r.token.rect)),
      body = before.filter(
        (r) =>
          r.r.fontName === lane.font &&
          Math.abs(r.r.height - lane.em) < 0.02 &&
          r.token.rect[0] >= lane.left &&
          r.token.rect[2] <= lane.right &&
          (r.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) > 0
      ),
      preceding = body
        .filter(
          (r) =>
            r.index < Math.min(...row.map((t) => t.index)) &&
            r.token.rect[3] < bounds[1] &&
            bounds[1] - r.token.rect[3] < lane.em * 5
        )
        .at(-1),
      following = body.find(
        (r) =>
          r.index > Math.max(...row.map((t) => t.index)) &&
          r.token.rect[1] > bounds[3] &&
          r.token.rect[1] - bounds[3] < lane.em * 5
      )
    if (
      bounds[0] < lane.left ||
      bounds[2] > lane.right ||
      !following ||
      !/^\p{Lu}\p{L}*\s/u.test(following.r.str)
    )
      return false
    if (roman) return !!preceding && /[.!?]$/u.test(preceding.r.str.trim())
    const first = Math.min(...row.map((r) => r.index)),
      parent = before
        .filter(
          (r) =>
            r.index < first &&
            r.r.fontName === record.r.fontName &&
            Math.abs(r.r.height - record.r.height) < 0.02 &&
            /^[A-Z][A-Z -]{3,}$/u.test(r.r.str) &&
            r.token.rect[3] < bounds[1] &&
            bounds[1] - r.token.rect[3] < lane.em * 4 &&
            sectionMember(r, lane)
        )
        .at(-1)
    if (!parent || before.some((r) => r.index > parent.index && r.index < first)) return false
    const last = Math.max(...parent.part.map((p) => p.i)),
      next = Math.min(...row.flatMap((r) => r.part.map((p) => p.i)))
    for (let i = last + 1; i < next; i++) {
      const op = context.operators.fnArray[i],
        a = context.operators.argsArray[i]
      if (op === OPS.moveText || op === OPS.setTextMatrix) {
        if (
          !finite(
            op === OPS.setTextMatrix && a?.length === 1 ? a[0] : a,
            op === OPS.moveText ? 2 : 6
          )
        )
          return false
      } else if (op === OPS.setFont) {
        if (a?.[0] !== record.r.fontName || Math.abs(a?.[1] - record.r.height) > 0.02) return false
      } else if (
        ![OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) ||
        !equal(a, ['#000000'])
      )
        return false
    }
    return true
  }
  const inlineCitation = (record, lane) => {
    if (
      !/^\[\d+(?:\s*[-,]\s*\d+)*\][,;.]?$/u.test(record.r.str) ||
      record.r.fontName !== lane.font ||
      Math.abs(record.r.height - lane.em) > 0.02
    )
      return false
    const rows = lane.rows.filter((row) => row.records.includes(record))
    if (rows.length !== 1) return false
    const row = rows[0],
      left = row.records.filter((r) => r.index < record.index),
      right = row.records.filter((r) => r.index > record.index),
      words = (rs) =>
        rs
          .map((r) => r.r.str)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0,
      last = left.at(-1),
      first = right[0],
      preceding = lane.rows.find((r) => row.y - r.y >= lane.em && row.y - r.y <= lane.em * 1.7),
      previous = preceding?.records.toSorted((a, b) => a.index - b.index),
      wrapped =
        previous &&
        /^[=<>≤≥⊆∈]$/u.test(previous.at(-1).r.str) &&
        (previous
          .filter((r) => r.r.fontName === lane.font && Math.abs(r.r.height - lane.em) < 0.02)
          .map((r) => r.r.str)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
        left.length >= 3 &&
        left.every((r) => !/\p{L}{2,}/u.test(r.r.str)) &&
        previous.at(-1).index < left[0].index &&
        !before.some((r) => r.index > previous.at(-1).index && r.index < left[0].index) &&
        Math.max(...previous.at(-1).part.map((p) => p.i)) <
          Math.min(...left[0].part.map((p) => p.i)) &&
        !program.outsidePaints.some(
          (p) =>
            p.operationIndex > Math.max(...previous.at(-1).part.map((t) => t.i)) &&
            p.operationIndex < Math.min(...left[0].part.map((t) => t.i))
        ),
      mathBody =
        (left.length >= 4 &&
          left.some((r) => /[=<>≤≥]/u.test(r.r.str)) &&
          left.some((r) => inlineMathArgument(r, lane))) ||
        wrapped
    if (
      (words(left) < 4 && !mathBody) ||
      !last ||
      record.token.rect[0] - last.token.rect[2] > lane.em * 1.5 ||
      record.token.rect[0] < last.token.rect[2] - 0.02
    )
      return false
    const beforeOp = Math.max(...last.part.map((p) => p.i)),
      citationFirst = Math.min(...record.part.map((p) => p.i))
    if (
      beforeOp > citationFirst ||
      program.outsidePaints.some(
        (p) => p.operationIndex > beforeOp && p.operationIndex < citationFirst
      )
    )
      return false
    if (
      words(right) >= (mathBody ? 2 : 1) &&
      first &&
      first.token.rect[0] >= record.token.rect[2] - 0.02 &&
      first.token.rect[0] - record.token.rect[2] < lane.em * 1.5 &&
      !program.outsidePaints.some(
        (p) =>
          p.operationIndex > Math.max(...record.part.map((t) => t.i)) &&
          p.operationIndex < Math.min(...first.part.map((t) => t.i))
      )
    )
      return true
    const next = lane.rows.find(
      (r) =>
        r.y > row.y &&
        r.y - row.y >= lane.em &&
        r.y - row.y <= lane.em * 1.7 &&
        r.words >= 4 &&
        r.records.every((t) => t.index > record.index) &&
        !/^\s*(?:Task|Legend|Prediction|Target|Panel)\b/iu.test(
          r.records.map((t) => t.r.str).join(' ')
        )
    )
    return !!next
  }
  const inlineProse = (record, lane) => {
    if (Math.abs(record.r.height - lane.em) > 0.02 || !/\p{L}{3,}/u.test(record.r.str)) return false
    const rows = lane.rows.filter((row) => row.records.includes(record))
    if (rows.length !== 1) return false
    const row = rows[0],
      primary = row.records.filter(
        (r) => r.r.fontName === lane.font && Math.abs(r.r.height - lane.em) < 0.02
      ),
      ordered = row.records.toSorted((a, b) => a.index - b.index),
      index = ordered.indexOf(record),
      previous = ordered[index - 1],
      next = ordered[index + 1],
      primaryWords =
        primary
          .map((r) => r.r.str)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0,
      emphasisWords = record.r.str.match(/\p{L}{2,}/gu)?.length ?? 0,
      adjacent = lane.rows.some(
        (r) =>
          r !== row &&
          Math.abs(r.y - row.y) >= lane.em &&
          Math.abs(r.y - row.y) <= lane.em * 1.7 &&
          (r.records
            .filter((t) => t.r.fontName === lane.font && Math.abs(t.r.height - lane.em) < 0.02)
            .map((t) => t.r.str)
            .join(' ')
            .match(/\p{L}{2,}/gu)?.length ?? 0) >= 4
      )
    if (
      annotation(printedRow(row.records)) ||
      emphasisWords > 4 ||
      record.token.rect[2] - record.token.rect[0] > (lane.right - lane.left) / 2 ||
      !(
        primaryWords >= 4 ||
        (primaryWords >= 2 && primaryWords + emphasisWords >= 4 && adjacent)
      ) ||
      Math.abs(record.token.baseline - row.y) > 0.02 ||
      (!previous && !next)
    )
      return false
    for (const [left, right] of [
      [previous, record],
      [record, next]
    ]) {
      if (!left || !right) continue
      const last = Math.max(...left.part.map((p) => p.i)),
        first = Math.min(...right.part.map((p) => p.i)),
        gap = right.token.rect[0] - left.token.rect[2]
      if (
        last >= first ||
        gap < -0.02 ||
        gap > lane.em * 1.5 ||
        program.outsidePaints.some((p) => p.operationIndex > last && p.operationIndex < first)
      )
        return false
    }
    return true
  }
  const inlineParenthetical = (record, lane) =>
    /^\(\p{L}{3,}\)[,;.]?(?:\s*\(\d+\))?$/u.test(record.r.str) &&
    inlineProse(record, lane) &&
    lane.rows.some(
      (row) => row.records.includes(record) && row.records.some((r) => r.index < record.index)
    )
  const inlineMathArgument = (record, lane) => {
    if (!/^\(\d+\)$/u.test(record.r.str) || Math.abs(record.r.height - lane.em) > 0.02) return false
    const rows = lane.rows.filter((row) => row.records.includes(record))
    if (rows.length !== 1) return false
    const row = rows[0],
      ordered = row.records.toSorted((a, b) => a.index - b.index),
      index = ordered.indexOf(record),
      previous = ordered[index - 1],
      next = ordered[index + 1]
    if (
      !previous ||
      !next ||
      !/^\p{L}$/u.test(previous.r.str) ||
      !/^[)\]∥|=<>≤≥+−-]$/u.test(next.r.str) ||
      !row.records.some((r) => /[=<>≤≥]/u.test(r.r.str)) ||
      !lane.rows.some(
        (r) =>
          r !== row &&
          Math.abs(r.y - row.y) >= lane.em &&
          Math.abs(r.y - row.y) <= lane.em * 1.7 &&
          r.words >= 4
      )
    )
      return false
    for (const [left, right] of [
      [previous, record],
      [record, next]
    ]) {
      const last = Math.max(...left.part.map((p) => p.i)),
        first = Math.min(...right.part.map((p) => p.i)),
        gap = right.token.rect[0] - left.token.rect[2]
      if (
        Math.abs(left.r.height - lane.em) > 0.02 ||
        Math.abs(left.token.baseline - row.y) > 0.02 ||
        Math.abs(right.token.baseline - row.y) > 0.02 ||
        last >= first ||
        gap < -0.02 ||
        gap > lane.em * 0.15 ||
        program.outsidePaints.some((p) => p.operationIndex > last && p.operationIndex < first)
      )
        return false
    }
    return true
  }
  const definitionParentheticals = new Set()
  for (const lane of lanes) {
    const rows = lane.rows.filter((row) =>
      row.records.every((r) => r.part.every((p) => p.i < group.begin))
    )
    for (let start = 1; start < rows.length - 1; start++)
      for (let count = 1; count <= 3 && start + count < rows.length; count++) {
        const sequence = rows.slice(start - 1, start + count + 1),
          body = sequence.slice(1, -1),
          preceding = sequence[0],
          following = sequence.at(-1),
          records = body.flatMap((row) => row.records),
          text = body.map((row) => printedRow(row.records)).join(' '),
          tags = [...text.matchAll(/\((\d+)\)/gu)],
          primaryWords = (row) =>
            row.records
              .filter((r) => r.r.fontName === lane.font && Math.abs(r.r.height - lane.em) < 0.02)
              .map((r) => r.r.str)
              .join(' ')
              .match(/\p{L}{2,}/gu)?.length ?? 0
        if (
          primaryWords(preceding) < 4 ||
          primaryWords(following) < 4 ||
          tags.length !== 3 ||
          tags.some((tag, i) => Number(tag[1]) !== i + 1) ||
          sequence.some(
            (row, i) =>
              i &&
              (row.y - sequence[i - 1].y < lane.em || row.y - sequence[i - 1].y > lane.em * 1.7)
          ) ||
          records.some(
            (r) =>
              annotation(r.r.str) ||
              r.r.height < lane.em / 2 ||
              r.r.height > lane.em * 1.05 ||
              !r.part.every((p) => p.visible) ||
              !inside([lane.left, 0, lane.right, page.height], ink(r))
          ) ||
          tags.some(
            (tag, i) =>
              !/[=<>≤≥]/u.test(
                text.slice(tag.index + tag[0].length, tags[i + 1]?.index ?? text.length)
              )
          )
        )
          continue
        const first = Math.min(...records.flatMap((r) => r.part.map((p) => p.i))),
          last = Math.max(...records.flatMap((r) => r.part.map((p) => p.i)))
        if (
          program.outsidePaints.some((p) => p.operationIndex > first && p.operationIndex < last) ||
          records.some((r, i) => i && r.index <= records[i - 1].index)
        )
          continue
        for (const record of records)
          if (/^(?:\(\p{L}{3,}(?:[-–]\p{L}{3,})?\)(?:[,;.]|\s|$)|\([1-3]\)$)/u.test(record.r.str))
            definitionParentheticals.add(record)
      }
  }
  for (const r of removed) {
    // Even a typographically matching annotation is not a body continuation.
    // These explicit labels remain exterior figure content, never prose.
    if (
      annotation(r.r.str) ||
      /\[[A-Za-z]\]/u.test(r.r.str) ||
      lanes.some((l) =>
        l.allRows.some((row) => row.records.includes(r) && annotation(printedRow(row.records)))
      ) ||
      (/^(?:[IVXLCDM]+|[A-Z])\.$/u.test(r.r.str) && !lanes.some((l) => sectionMember(r, l))) ||
      (/^\s*(?:\([A-Za-z0-9]+\)|\[[A-Za-z0-9]+\])/u.test(r.r.str) &&
        !equationLabels.has(r) &&
        !definitionParentheticals.has(r) &&
        !lanes.some(
          (l) => inlineCitation(r, l) || inlineParenthetical(r, l) || inlineMathArgument(r, l)
        ))
    )
      return
    const owners = lanes.filter(
      (l) =>
        r.index >= l.lo &&
        r.index <= l.hi &&
        r.token.rect[0] >= l.left &&
        r.token.rect[2] <= l.right &&
        inside([l.left, 0, l.right, page.height], ink(r)) &&
        ((r.r.fontName === l.font && Math.abs(r.r.height - l.em) < 0.02) ||
          (r.r.height >= l.em / 2 && r.r.height <= l.em * 1.05 && !/\p{L}{3,}/u.test(r.r.str)) ||
          sectionMember(r, l) ||
          inlineProse(r, l))
    )
    if (owners.length !== 1) return
    members.set(r, owners[0])
  }
  if (!removed.some((r) => (r.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4)) return
  if (
    program.records.some(
      (r) =>
        !r.group &&
        !before.includes(r) &&
        intersection(ink(r), publishedRect) > 0 &&
        intersection(ink(r), rect) === 0
    )
  )
    return
  for (const path of program.outsidePaints) {
    if (!intersection(path.rect, publishedRect)) continue
    const lane = lanes.filter(
      (l) => path.line[0] >= l.left && path.line[2] <= l.right && path.operationIndex < group.begin
    )
    if (lane.length !== 1) return
    const l = lane[0],
      glyphs = before
        .filter(
          (r) =>
            r.index >= l.lo &&
            r.index <= l.hi &&
            r.token.rect[0] >= l.left &&
            r.token.rect[2] <= l.right
        )
        .flatMap((r) =>
          r.part.map((p) => {
            const b = program.fonts.get(p.font)?.get(p.glyph.fontChar)
            return finite(b, 4)
              ? box(
                  [
                    p.origin[0] + b[0] * p.size,
                    p.origin[1] + b[1] * p.size,
                    p.origin[0] + b[2] * p.size,
                    p.origin[1] + b[3] * p.size
                  ],
                  p.matrix
                )
              : undefined
          })
        )
        .filter(valid),
      y = path.line[1],
      cross = (g) =>
        g[0] < Math.max(path.line[0], path.line[2]) && g[2] > Math.min(path.line[0], path.line[2])
    if (
      !glyphs.some((g) => cross(g) && g[3] < y && g[3] > y - l.em * 2) ||
      !glyphs.some((g) => cross(g) && g[1] > y && g[1] < y + l.em * 2)
    )
      return
  }
  return lanes
}
function renderedGroupPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect,
  live,
  mode = groupPixelMode,
  nonisolatedProfile
) {
  try {
    const composite = mode === compositeGroupPixelMode,
      exclusion = mode === nonisolatedExclusionPixelMode,
      profileReader = composite
        ? nativeCompositeGroupProfileData
        : exclusion
          ? nativeNonisolatedExclusionProfileData
          : nativeNonisolatedGroupProfileData,
      profileGroups =
        mode === nonisolatedGroupPixelMode || exclusion || composite
          ? profileReader(nonisolatedProfile, page, tokens, context)
          : undefined
    if (
      (mode === nonisolatedGroupPixelMode || exclusion || composite) &&
      (!Array.isArray(profileGroups) || profileGroups.length !== 1)
    )
      return
    const values = nativeRecoveryOwnValues(context)
    if (!values) return
    const keys = Object.keys(values),
      descriptors = Object.getOwnPropertyDescriptors(context),
      prototype = Object.getPrototypeOf(context),
      input = Object.fromEntries(
        [
          'operators',
          'glyphBounds',
          'partialFontGlyphBounds',
          'type3GlyphPrograms',
          'pixelType3Programs',
          'skippedSpaceGlyphs',
          'opaqueRasterImages',
          'graphicsBounds',
          'viewport',
          'content',
          'pageNumber',
          'sourceSha256',
          'dualApiEvidence'
        ]
          .filter((k) => Object.hasOwn(values, k))
          .map((k) => [k, values[k]])
      ),
      current = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, input, publishedRect],
        input.viewport
      )
    if (
      !current ||
      !valid(publishedRect) ||
      (composite &&
        !['native-raster-composite-grid', 'native-raster-vector-strip'].includes(figure.reason)) ||
      figure.parts ||
      figure.cropRects ||
      figure.formCropRaster ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      figure.sourceItems?.length ||
      (figure.reason &&
        figure.reason !== 'native-raster-composite-grid' &&
        !(composite && figure.reason === 'native-raster-vector-strip')) ||
      figure.issue ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      figure.caption.regions ||
      !Array.isArray(captions) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !captions.includes(figure.caption) ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s/u.test(figure.caption.lines?.[0] ?? '') ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? page.rotation) !== 0 ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      (input.partialFontGlyphBounds?.length && !input.pixelType3Programs) ||
      input.type3GlyphPrograms
    )
      return
    const p = disjointGroupProgram(page, tokens, input, 1, mode)
    if (!p || p.records.length > 4096) return
    const group = p.groups[0],
      cap = p.records.filter((r) => !r.group && inside(figure.caption.rect, r.token.rect)),
      em = Math.max(...cap.map((r) => r.r.height)),
      rect = group.rect.map((v, i) => v + (i < 2 ? -1 : 1) * (exclusion ? 2 / 1.5 : 0.5))
    if (
      ((mode === nonisolatedGroupPixelMode || exclusion || composite) &&
        (group.begin !== profileGroups[0].begin ||
          group.end !== profileGroups[0].end ||
          group.arg.isolated !== false ||
          group.arg.knockout !== false ||
          group.arg.matrix !== null ||
          group.arg.smask !== null ||
          !equal(group.arg.bbox, profileGroups[0].bbox))) ||
      (!exclusion && !composite && group.records.length < 3) ||
      (composite && !group.paint.some((p) => valid(p.rect))) ||
      (exclusion && !group.paint.some((p) => p.potentialPaint && valid(p.rect))) ||
      group.records.length > 256 ||
      !cap.length ||
      compactGroup(cap.map((r) => r.r.str).join('')) !==
        compactGroup(figure.caption.lines.join('')) ||
      group.rect[3] >= figure.caption.rect[1] ||
      figure.caption.rect[1] - group.rect[3] > em * 4 ||
      Math.min(group.rect[2], figure.caption.rect[2]) -
        Math.max(group.rect[0], figure.caption.rect[0]) <
        (group.rect[2] - group.rect[0]) * 0.75 ||
      !inside([0, 0, page.width, page.height], rect) ||
      tables.some((r) => intersection(r, rect) > 0)
    )
      return
    const foreground = []
    for (const r of group.records)
      for (const part of r.part) {
        if (!part.visible || part.glyph.isInFont !== true) continue
        const b = p.fonts.get(part.font)?.get(part.glyph.fontChar)
        if (!finite(b, 4)) continue
        const ink = box(
          [
            part.origin[0] + b[0] * part.size,
            part.origin[1] + b[1] * part.size,
            part.origin[0] + b[2] * part.size,
            part.origin[1] + b[3] * part.size
          ],
          part.matrix
        )
        if (valid(ink) && inside(group.rect, ink) && !inside(publishedRect, ink))
          foreground.push(part)
      }
    if (composite) {
      const children = group.children
      if (
        !Array.isArray(children) ||
        children.length < 1 ||
        children.length > 4 ||
        children.length !== profileGroups[0].children.length ||
        inside(publishedRect, group.rect) ||
        children.some((child, i) => {
          const expected = profileGroups[0].children[i]
          return (
            child.begin !== expected.begin ||
            child.end !== expected.end ||
            child.arg.isolated !== true ||
            child.arg.knockout !== false ||
            child.arg.smask !== null ||
            !equal(child.arg.matrix, expected.matrix) ||
            !equal(child.arg.bbox, expected.bbox)
          )
        })
      )
        return
      // The root canvas may also contain a prose block. Only native numeric
      // labels are an independent supported root role; child ownership is the
      // exact operator interval, never inferred from a path bounding box.
      for (const record of group.records) {
        const owners = record.part.map((part) =>
          children.findIndex((child) => part.i > child.begin && part.i < child.end)
        )
        if (!owners.length || owners.some((owner) => owner !== owners[0])) return
        if (
          owners[0] === -1 &&
          (!record.token.horizontal ||
            !/^(?:0|[1-9][0-9]*)$/u.test(record.r.str) ||
            !Number.isSafeInteger(Number(record.r.str)) ||
            !record.part.every((part) => part.visible && part.glyph.isInFont === true))
        )
          return
      }
    }
    if (exclusion) {
      if (
        group.rect[2] - group.rect[0] > page.width * 0.5 ||
        figure.caption.rect[2] - figure.caption.rect[0] > page.width * 0.5 ||
        !inside(publishedRect, group.rect) ||
        !nativeExclusionBodyLanes(p, page, figure.caption, publishedRect, rect, input)
      )
        return
    } else if (!composite && !foreground.length) return
    const outsideLabels = []
    for (const r of p.records.filter((r) => !r.group)) {
      const style = input.content.styles[r.r.fontName]
      if (
        !Number.isFinite(style?.ascent) ||
        style.ascent < 0 ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2 ||
        style.vertical !== false ||
        (!valid(r.label) && !(exclusion && r.exteriorZero))
      )
        return
      if (valid(r.label)) outsideLabels.push(r.label)
    }
    const foreign = [...p.outsideInk.filter(valid), ...outsideLabels],
      outsidePaints = exclusion ? p.outsidePaints : []
    if (foreign.some((r) => intersection(r, rect) > 0)) return
    if (
      outsidePaints.some(
        (p) =>
          intersection(
            p.rect.map((n, i) => n + ((i < 2 ? -1 : 1) * (p.floor + 1)) / 1.5),
            rect
          ) > 0
      )
    )
      return
    const liveCurrent = liveOrdinaryGroupFonts(
        input,
        p,
        [...foreground, ...p.internalZeroParts],
        live,
        exclusion || composite
      ),
      output = { rect },
      owned = retainNativeRecoveryInputs([
        output,
        group,
        foreign,
        foreground,
        p.strokeEnvelopes,
        outsidePaints
      ])
    if (!liveCurrent || !owned || !liveCurrent()) return
    groupPixelCertificates.set(output, {
      page,
      group,
      foreign,
      strokeEnvelopes: p.strokeEnvelopes,
      ...(exclusion ? { outsidePaints, minScale: 1.5 } : {}),
      current: () =>
        current() &&
        (!(mode === nonisolatedGroupPixelMode || exclusion || composite) ||
          profileReader(nonisolatedProfile, page, tokens, context) === profileGroups) &&
        owned() &&
        liveCurrent() &&
        Object.getPrototypeOf(context) === prototype &&
        Reflect.ownKeys(context).length === keys.length &&
        keys.every((k) => {
          const d = Object.getOwnPropertyDescriptor(context, k),
            old = descriptors[k]
          return (
            d &&
            Object.hasOwn(d, 'value') &&
            d.value === old.value &&
            d.writable === old.writable &&
            d.enumerable === old.enumerable &&
            d.configurable === old.configurable
          )
        })
    })
    return output
  } catch {
    return
  }
}
export function nativeRenderedGroupPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect,
  live
) {
  return renderedGroupPixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    publishedRect,
    live,
    groupPixelMode
  )
}
// Opt-in crop-only path. The separate profile proves there is no earlier page
// paint; this independent interpreter proves complete group paint/text closure
// and that every outside glyph is disjoint from the recovered group bounds.
export function nativeNonisolatedGroupPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect,
  live,
  profile,
  exclusionProfile,
  compositeProfile
) {
  const renderExclusion = () => {
    const exclusion = nativeNonisolatedExclusionProfileData(exclusionProfile, page, tokens, context)
    return Array.isArray(exclusion) && exclusion.length === 1
      ? renderedGroupPixelCrop(
          page,
          figure,
          captions,
          tables,
          tokens,
          context,
          publishedRect,
          live,
          nonisolatedExclusionPixelMode,
          exclusionProfile
        )
      : undefined
  }
  const composite = nativeCompositeGroupProfileData(compositeProfile, page, tokens, context)
  if (Array.isArray(composite) && composite.length === 1)
    return renderedGroupPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      publishedRect,
      live,
      compositeGroupPixelMode,
      compositeProfile
    )
  const descriptors = nativeNonisolatedGroupProfileData(profile, page, tokens, context)
  if (!Array.isArray(descriptors) || descriptors.length !== 1) return renderExclusion()
  const plan = renderedGroupPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      publishedRect,
      live,
      nonisolatedGroupPixelMode,
      profile
    ),
    proof = plan && groupPixelCertificates.get(plan)
  return proof?.current() ? plan : renderExclusion()
}
function compactGroup(s) {
  return s.replace(/\s/gu, '')
}
export function nativeRenderedGroupPixelPngSafe(plan, png, rect, page) {
  try {
    const proof = groupPixelCertificates.get(plan),
      raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!proof &&
      page === proof.page &&
      proof.current() &&
      !!raster &&
      (!proof.minScale || raster.scaleLower >= proof.minScale) &&
      equal(plan.rect, rect) &&
      proof.strokeEnvelopes.every((stroke) => {
        const envelope = nativeFillStrokeGlyphEnvelope(stroke.ink, stroke.state, raster.scaleLower)
        return envelope && inside(proof.group.rect, envelope) && inside(rect, envelope)
      }) &&
      inside(
        rect,
        proof.group.rect.map((v, i) => v + (i < 2 ? -1 : 1) / raster.scaleLower)
      ) &&
      proof.foreign.every((r) => intersection(r, raster.protection) === 0) &&
      (!proof.outsidePaints ||
        proof.outsidePaints.every(
          (p) =>
            intersection(
              p.rect.map((n, i) => n + ((i < 2 ? -1 : 1) * (p.floor + 1)) / raster.scaleLower),
              raster.protection
            ) === 0
        )) &&
      proof.current()
    )
  } catch {
    return false
  }
}

// Same-page physical character relation; never changes either API value.
function pairedMicroRelation(context, normalContent, rawContent) {
  if (
    !Array.isArray(normalContent?.items) ||
    normalContent.items.length !== rawContent?.items?.length ||
    normalContent.items.length !== context.content.items.length ||
    !sameValue(normalContent.styles, rawContent.styles)
  )
    return
  const a = { ...normalContent },
    b = { ...rawContent }
  delete a.items
  delete b.items
  if (!sameValue(a, b)) return
  const pairs = new Map(),
    forward = new Map(),
    reverse = new Map()
  for (let index = 0; index < normalContent.items.length; index++) {
    const normal = normalContent.items[index],
      raw = rawContent.items[index],
      paint = context.content.items[index],
      x = { ...normal },
      y = { ...raw },
      z = { ...paint }
    delete x.str
    delete y.str
    if (!sameValue(x, y) || typeof normal.str !== 'string' || typeof raw.str !== 'string') return
    delete z.sourceItem
    const oldFont = z.fontName
    z.fontName = normal.fontName
    if (
      !sameValue(z, normal) ||
      !sameValue(context.content.styles[oldFont], normalContent.styles[normal.fontName]) ||
      (forward.has(oldFont) && forward.get(oldFont) !== normal.fontName) ||
      (reverse.has(normal.fontName) && reverse.get(normal.fontName) !== oldFont)
    )
      return
    forward.set(oldFont, normal.fontName)
    reverse.set(normal.fontName, oldFont)
    if (normal.str === raw.str) continue
    const nc = Array.from(normal.str),
      rc = Array.from(raw.str)
    if (nc.length !== rc.length || !nc.every((c, i) => c === rc[i] || (c === 'μ' && rc[i] === 'µ')))
      return
    pairs.set(index, { normal: normal.str, raw: raw.str })
  }
  return pairs
}
function completePairedMicroCursors(program, pairs) {
  if (!program || !pairs) return false
  const owners = new Map()
  for (const r of program.records)
    for (const p of r.part) {
      const key = p.i + ':' + p.glyphIndex
      if (owners.has(key) && owners.get(key) !== r) return false
      owners.set(key, r)
    }
  for (const [index, pair] of pairs) {
    const r = program.records.find((r) => r.index === index)
    if (
      !r ||
      r.r.str !== pair.normal ||
      r.part.map((p) => p.c).join('') !== letters(pair.raw).join('') ||
      new Set(r.part.map((p) => p.i + ':' + p.glyphIndex)).size !== r.part.length ||
      r.part.length !== letters(pair.raw).length
    )
      return false
    if (
      r.part.some(
        (p) =>
          !p.visible ||
          p.glyph.isInFont !== true ||
          !Number.isSafeInteger(p.glyph.originalCharCode) ||
          p.glyph.originalCharCode < 0 ||
          typeof p.glyph.fontChar !== 'string' ||
          !p.glyph.fontChar ||
          !(p.glyph.width > 0) ||
          p.glyph.operatorListId != null ||
          p.glyph.accent != null ||
          p.glyph.vmetric != null ||
          Array.from(p.glyph.unicode).length !== 1 ||
          !valid(p.advance)
      )
    )
      return false
    const whole = union(r.part.map((p) => p.advance))
    if (!valid(whole) || whole.some((n, i) => Math.abs(n - r.token.rect[i]) > 0.02)) return false
  }
  return true
}

function pairedPartInk(part, program) {
  const b = program.fonts.get(part.font)?.get(part.glyph.fontChar)
  return finite(b, 4)
    ? box(
        [
          part.origin[0] + b[0] * part.size,
          part.origin[1] + b[1] * part.size,
          part.origin[0] + b[2] * part.size,
          part.origin[1] + b[3] * part.size
        ],
        part.matrix
      )
    : undefined
}
function pairedDescription(rows, group, nextTop, marker, program) {
  if (!rows.length || !new RegExp('^\\(' + marker + '\\)\\s+\\p{L}', 'u').test(rows[0].r.str))
    return
  const first = rows[0],
    em = first.r.height,
    baselines = new Set(
      rows
        .filter((r) => r.r.fontName === first.r.fontName && r.r.height === em)
        .map((r) => r.token.baseline)
    )
  if (
    !(em > 0) ||
    baselines.size < 2 ||
    first.token.rect[1] <= group.rect[3] ||
    first.token.rect[1] - group.rect[3] > 2 * em
  )
    return
  const bounds = []
  for (const [i, r] of rows.entries()) {
    const t = r.r.transform,
      advance = union(r.part.map((p) => p.advance)),
      inks = r.part.map((p) => pairedPartInk(p, program))
    if (
      r.group ||
      !r.token.horizontal ||
      r.r.dir !== 'ltr' ||
      !finite(t, 6) ||
      !(t[0] > 0) ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] !== r.r.height ||
      r.r.height > em ||
      !valid(r.label) ||
      !valid(advance) ||
      advance.some((n, i) => Math.abs(n - r.token.rect[i]) > 0.02) ||
      inks.some((r) => !finite(r, 4)) ||
      r.token.rect[0] < group.rect[0] - 1e-6 ||
      r.token.rect[2] > group.rect[2] + 1e-6 ||
      (i && /^\([a-z]\)\s/u.test(r.r.str))
    )
      return
    bounds.push(r.token.rect, r.label, advance, ...inks.filter(valid))
  }
  const rect = union(bounds)
  if (rect[3] >= nextTop || nextTop - rect[3] > 3 * em) return
  return { rect, rows, em, first }
}

// This independent purpose interprets the same original two group canvases.
// It publishes pixels only, including both whole native descriptions; it never
// registers a label, Source packet, cell, navigation or translation capability.
export async function nativePairedDescriptionGroupPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  live
) {
  try {
    const values = nativeRecoveryOwnValues(context),
      scope = nativeRecoveryOwnValues(live)
    if (
      !values ||
      !scope ||
      !scope.nativePage ||
      types.isProxy(scope.nativePage) ||
      scope.nativePage.pageNumber !== page.pageNumber ||
      scope.sourceSha256 !== context.sourceSha256 ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      context.pageNumber !== page.pageNumber ||
      !figure ||
      valid(figure.rect) ||
      figure.parts ||
      figure.cropRects ||
      figure.formCropRaster ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      figure.sourceItems?.length ||
      (figure.issue && figure.issue !== 'no-unambiguous-adjacent-graphics') ||
      (figure.reason && figure.reason !== 'no-unambiguous-adjacent-graphics') ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      figure.caption.regions ||
      !Array.isArray(captions) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !captions.includes(figure.caption) ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s/u.test(figure.caption.lines?.[0] ?? '') ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? page.rotation) !== 0 ||
      context.partialFontGlyphBounds?.length ||
      context.type3GlyphPrograms ||
      context.pixelType3Programs
    )
      return
    const input = Object.fromEntries(
        [
          'operators',
          'glyphBounds',
          'graphicsBounds',
          'viewport',
          'content',
          'pageNumber',
          'sourceSha256'
        ]
          .filter((k) => Object.hasOwn(values, k))
          .map((k) => [k, values[k]])
      ),
      contextSlots = groupSlots(context, Reflect.ownKeys(context)),
      contextPrototype = Object.getPrototypeOf(context),
      contextKeys = Reflect.ownKeys(context),
      sourceSlots = groupSlots(live, ['sourceSha256']),
      getText = groupDataSlot(scope.nativePage, 'getTextContent'),
      methodSlots = groupSlots(scope.nativePage, ['getTextContent']),
      originalCurrent = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, input, scope.pageContent],
        input.viewport
      )
    if (
      typeof getText !== 'function' ||
      !methodSlots ||
      !contextSlots ||
      !sourceSlots ||
      !originalCurrent
    )
      return
    const raw = await getText.call(scope.nativePage, { disableNormalization: true })
    if (
      !originalCurrent() ||
      !groupSlotsCurrent(methodSlots) ||
      !nativeAdditionalPixelInputsFit(input, scope.pageContent, raw)
    )
      return
    const pairs = pairedMicroRelation(input, scope.pageContent, raw),
      program = pairs && disjointGroupProgram(page, tokens, input, 2, pairedGroupPixelMode, pairs)
    if (!program || !completePairedMicroCursors(program, pairs) || program.records.length > 4096)
      return
    const groups = [...program.groups].sort((a, b) => a.rect[1] - b.rect[1]),
      [a, b] = groups,
      cap = program.records.filter((r) => !r.group && inside(figure.caption.rect, r.token.rect))
    if (
      !cap.length ||
      compactGroup(cap.map((r) => r.r.str).join('')) !==
        compactGroup(figure.caption.lines.join('')) ||
      groups.some((g) => g.records.length < 3 || g.records.length > 256 || g.paint.length < 2) ||
      a.end >= b.begin ||
      a.rect[3] >= b.rect[1] ||
      Math.abs(a.rect[0] - b.rect[0]) > 1e-6 ||
      Math.abs(a.rect[2] - b.rect[2]) > 1e-6 ||
      b.rect[3] >= figure.caption.rect[1]
    )
      return
    const capStart = Math.min(...cap.flatMap((r) => r.part.map((p) => p.i))),
      intervals = [
        [a, b, '(a)'],
        [b, undefined, '(b)']
      ],
      descriptions = []
    for (const [g, next, label] of intervals) {
      const after = Math.max(...g.records.map((r) => r.index)),
        before = Math.min(...(next ? next.records : cap).map((r) => r.index)),
        rows = program.records.filter((r) => r.index > after && r.index < before),
        end = next?.begin ?? capStart
      if (rows.some((r) => r.part.some((p) => p.i <= g.end || p.i >= end))) return
      const description = pairedDescription(
        rows,
        g,
        next?.rect[1] ?? figure.caption.rect[1],
        label[1],
        program
      )
      if (!description) return
      descriptions.push(description)
    }
    if (
      descriptions[0].first.r.fontName !== descriptions[1].first.r.fontName ||
      descriptions[0].em !== descriptions[1].em
    )
      return
    const owned = new Set([
        ...groups.flatMap((g) => g.records),
        ...descriptions.flatMap((d) => d.rows)
      ]),
      glyphOwners = new Map()
    for (const r of program.records)
      for (const part of r.part) {
        const key = part.i + ':' + part.glyphIndex
        if (glyphOwners.has(key) && glyphOwners.get(key) !== r) return
        glyphOwners.set(key, r)
      }
    const physical = union([...groups.map((g) => g.rect), ...descriptions.map((d) => d.rect)]),
      minimumScale = 1.5,
      rect = physical.map((n, i) => n + (i < 2 ? -3 : 3) / minimumScale),
      foreign = []
    for (const r of program.records.filter((r) => !owned.has(r))) {
      const advance = union(r.part.map((p) => p.advance)),
        inks = r.part.map((p) => pairedPartInk(p, program))
      if (
        !valid(r.label) ||
        !valid(r.token.rect) ||
        !valid(advance) ||
        inks.some((r) => !finite(r, 4))
      )
        return
      foreign.push(union([r.label, r.token.rect, advance, ...inks.filter(valid)]))
    }
    for (const part of program.outsideParts) {
      if (owned.has(glyphOwners.get(part.i + ':' + part.glyphIndex))) continue
      const ink = pairedPartInk(part, program)
      if (!finite(ink, 4)) return
      if (valid(ink)) foreign.push(ink)
    }
    const protection = rect.map((n, i) => n + (i < 2 ? -2 : 2) / minimumScale),
      protectedForeign = foreign.map((r) => r.map((n, i) => n + (i < 2 ? -1 : 1) / minimumScale))
    if (
      !inside([0, 0, page.width, page.height], rect) ||
      tables.some((r) => intersection(r, rect) > 0) ||
      protectedForeign.some((r) => intersection(r, protection) > 0)
    )
      return
    const liveCurrent = liveOrdinaryGroupFonts(
        input,
        program,
        [...owned].flatMap((r) => r.part),
        live
      ),
      output = { rect },
      current = retainNativeRecoveryInputs(
        [
          output,
          physical,
          foreign,
          protectedForeign,
          raw,
          program.groups,
          program.records,
          program.outsideParts
        ],
        input.viewport
      )
    if (!liveCurrent || !current || !liveCurrent()) return
    pairedGroupPixelCertificates.set(output, {
      page,
      physical,
      foreign: protectedForeign,
      minimumScale,
      current: () =>
        originalCurrent() &&
        current() &&
        groupSlotsCurrent(methodSlots) &&
        groupSlotsCurrent(sourceSlots) &&
        Object.getPrototypeOf(context) === contextPrototype &&
        Reflect.ownKeys(context).length === contextKeys.length &&
        groupSlotsCurrent(contextSlots) &&
        liveCurrent()
    })
    return output
  } catch {
    return
  }
}
export function nativePairedDescriptionGroupPixelCurrent(plan, page) {
  const proof = pairedGroupPixelCertificates.get(plan)
  return !!proof && page === proof.page && proof.current()
}
export function nativePairedDescriptionGroupPixelPngSafe(plan, png, rect, page) {
  try {
    const proof = pairedGroupPixelCertificates.get(plan),
      raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!proof &&
      page === proof.page &&
      proof.current() &&
      !!raster &&
      raster.scaleLower >= proof.minimumScale &&
      equal(plan.rect, rect) &&
      inside(
        rect,
        proof.physical.map((n, i) => n + (i < 2 ? -1 : 1) / raster.scaleLower)
      ) &&
      proof.foreign.every((r) => intersection(r, raster.protection) === 0) &&
      proof.current()
    )
  } catch {
    return false
  }
}

// C-only preview proof: ordinary Source and existing crop purposes do not gain
// rendering modes, cached-path normalization, image opacity or text ownership.
const strokePairLiveMode = Symbol('stroke-pair-live'),
  strokePairDisplayMode = Symbol('stroke-pair-display'),
  strokePairPixelPlans = new WeakMap()
function strokePairLiveInputs(context, packet, scope, display = false) {
  if (context.type3GlyphPrograms !== undefined) return
  return liveOrdinaryGroupFonts(
    context,
    packet,
    packet.glyphs,
    scope,
    true,
    display ? strokePairDisplayMode : strokePairLiveMode
  )
}
const strokeEmptyPathPrototype = Path2D.prototype,
  strokeEmptyPathMethods = Object.fromEntries(
    ['equals', 'toSVGString', 'getFillType'].map((key) => [
      key,
      groupDataSlot(strokeEmptyPathPrototype, key)
    ])
  )
function strokeEmptyEndPathBinding(a, b) {
  const m = strokeEmptyPathMethods,
    currentMethods = () =>
      Object.entries(m).every(
        ([key, value]) =>
          typeof value === 'function' && groupDataSlot(strokeEmptyPathPrototype, key) === value
      )
  if (
    !equal(a, [OPS.endPath, [null], null]) ||
    !Array.isArray(b) ||
    b.length !== 3 ||
    b[0] !== OPS.endPath ||
    b[2] !== null ||
    !Array.isArray(b[1]) ||
    b[1].length !== 1 ||
    !currentMethods()
  )
    return
  const actual = b[1][0],
    expected = new Path2D(),
    fill = m.getFillType.call(expected)
  if (
    !actual ||
    types.isProxy(actual) ||
    Object.getPrototypeOf(actual) !== strokeEmptyPathPrototype ||
    Reflect.ownKeys(actual).length ||
    !m.equals.call(expected, actual) ||
    m.toSVGString.call(actual) !== '' ||
    m.getFillType.call(actual) !== fill
  )
    return
  const slots = groupSlots(b, Reflect.ownKeys(b)),
    container = groupSlots(b[1], Reflect.ownKeys(b[1])),
    methods = groupSlots(actual, Object.keys(m))
  if (!slots || !container || !methods) return
  return () =>
    currentMethods() &&
    groupSlotsCurrent(slots) &&
    groupSlotsCurrent(container) &&
    groupSlotsCurrent(methods) &&
    Object.getPrototypeOf(actual) === strokeEmptyPathPrototype &&
    !Reflect.ownKeys(actual).length &&
    m.equals.call(expected, actual) &&
    m.toSVGString.call(actual) === '' &&
    m.getFillType.call(actual) === fill
}

const strokePairValid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  strokePairInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
  strokePairHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  strokePairExpand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  strokePairCenter = (r) => (r[0] + r[2]) / 2,
  strokePairCompact = (s) => s.replace(/\s/gu, ''),
  strokePairWords = (s) => s.match(/\p{L}{2,}/gu)?.length ?? 0,
  strokePairRefuse = () => undefined,
  strokePairGlyphInk = (g, scale) =>
    g.strokeOnlyText
      ? nativeStrokeOnlyGlyphEnvelope(g.strokeOnlyText.ink, g.strokeOnlyText, scale)
      : g.fillStrokeText
        ? nativeFillStrokeGlyphEnvelope(g.fillStrokeText.ink, g.fillStrokeText, scale)
        : g.ink,
  strokePairEmptyGlyph = (g) =>
    g.rendererSkipped === true ||
    (/^\s+$/u.test(g.text) &&
      Array.isArray(g.ink) &&
      g.ink.length === 4 &&
      g.ink.every(Number.isFinite) &&
      g.ink[0] === g.ink[2] &&
      g.ink[1] === g.ink[3]),
  strokePairForeignGlyphSafe = (g, scale, rect) => {
    const ink = strokePairGlyphInk(g, scale)
    return strokePairValid(ink)
      ? !strokePairHit(rect, strokePairExpand(ink, 2 / scale))
      : strokePairEmptyGlyph(g)
  },
  strokePairNormalRecord = (r) =>
    r.advanceComplete &&
    r.r.dir === 'ltr' &&
    r.r.height > 0 &&
    sameValue(r.r.transform.slice(0, 4), [r.r.height, 0, 0, r.r.height]) &&
    r.part.every(
      ({ g }) =>
        !g.rendererSkipped &&
        !g.strokeOnlyText &&
        !g.fillStrokeText &&
        g.textPaint.fillAlpha === 1 &&
        /^#[0-9a-f]{6}$/iu.test(g.textPaint.fillColor ?? '') &&
        g.textPaint.fillColor.toLowerCase() !== '#ffffff' &&
        strokePairValid(g.ink)
    ),
  strokePairFirst = (r) => Math.min(...r.part.map(({ g }) => g.i)),
  strokePairLast = (r) => Math.max(...r.part.map(({ g }) => g.i))
export function nativeStrokeTaskRasterPairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect,
  live
) {
  try {
    const own = nativeRecoveryOwnValues(context),
      figureOwn = nativeRecoveryOwnValues(figure)
    if (!own || !figureOwn) return strokePairRefuse('own values')
    if (oldRect === undefined) oldRect = figureOwn.rect
    const witness = nativeRecoveryOwnValues(own.runningHeadWitness),
      keep = retainNativeArrayPixelInputs(
        [page, figure, captions, tables, tokens, context, peers, oldRect],
        own.viewport,
        witness?.witnessViewport
      )
    if (!keep) return strokePairRefuse('retention')
    const cap = figureOwn.caption,
      figureCaps = captions.filter(
        (c) => c.page === page.pageNumber && /^(?:Figure|Fig\.?)[\s\d]/u.test(c.lines?.[0] ?? '')
      )
    if (
      !keep ||
      !strokePairValid(oldRect) ||
      !strokePairValid(cap?.rect) ||
      cap.page !== page.pageNumber ||
      figure.reason !== 'native-raster-side-by-side' ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.nativeBody ||
      figureCaps.length !== 1 ||
      !sameValue(figureCaps[0].rect, cap.rect) ||
      !sameValue(figureCaps[0].lines, cap.lines) ||
      (cap.lines.join(' ').match(/\(a\)/gu)?.length ?? 0) !== 1 ||
      (cap.lines.join(' ').match(/\(b\)/gu)?.length ?? 0) !== 1 ||
      cap.lines.join(' ').indexOf('(a)') >= cap.lines.join(' ').indexOf('(b)') ||
      !tables.every(strokePairValid)
    )
      return strokePairRefuse('inputs')
    const quotes = context.content.items.flatMap((r, index) =>
      /^[“"][\s\S]+[”"]$/u.test(r.str ?? '')
        ? [{ pageNumber: page.pageNumber, index, text: r.str }]
        : []
    )
    if (
      quotes.length !== 2 ||
      quotes.some((r) => strokePairWords(r.text) < 4 || strokePairWords(r.text) > 20)
    )
      return strokePairRefuse('quotes')
    const p = nativeStrokeOnlyTextInkPacket(page, tokens, context, quotes),
      binding = p && strokePairLiveInputs(context, p, live)
    if (!p || !binding || !binding() || !p.current()) return strokePairRefuse('packet/live')
    if (p.records.length > 4096 || p.glyphs.length > 100000 || p.evidence.images.length !== 2)
      return strokePairRefuse('inventory')
    const images = p.evidence.images.toSorted((a, b) => a.rect[0] - b.rect[0]),
      pageRect = [0, 0, page.width, page.height]
    if (
      images.some(
        (im) =>
          !strokePairValid(im.rect) ||
          !strokePairInside(pageRect, im.rect) ||
          p.o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
          !p.o.argsArray[im.operationIndex]?.slice(1).every((n) => Number.isSafeInteger(n) && n > 0)
      ) ||
      images[0].rect[2] >= images[1].rect[0] ||
      !sameValue(images[0].rect.slice(1, 2), images[1].rect.slice(1, 2)) ||
      Math.abs(images[0].rect[3] - images[1].rect[3]) > 0.02
    )
      return strokePairRefuse('images')
    const tasks = quotes
        .map((q) => p.records.find((r) => r.index === q.index))
        .toSorted((a, b) => a.rect[0] - b.rect[0]),
      em = tasks[0]?.r.height,
      font = tasks[0]?.r.fontName
    if (
      !(em > 0) ||
      tasks.some(
        (r, i) =>
          !r ||
          !strokePairNormalRecord(r) ||
          r.r.fontName !== font ||
          r.r.height !== em ||
          Math.abs(r.rect[3] - tasks[0].rect[3]) > em / 100 ||
          r.rect[0] < images[i].rect[0] ||
          r.rect[2] > images[i].rect[2] ||
          Math.abs(strokePairCenter(r.rect) - strokePairCenter(images[i].rect)) > em / 4 ||
          images[i].rect[1] - r.rect[3] < em / 3 ||
          images[i].rect[1] - r.rect[3] > em * 2 ||
          strokePairLast(r) >= images[i].operationIndex
      )
    )
      return strokePairRefuse('tasks')
    const labels = ['a', 'b'].map((letter, i) =>
      p.records.filter(
        (r) =>
          new RegExp('^\\(' + letter + '\\)\\s+\\p{L}', 'u').test(r.r.str) &&
          r.rect[1] >= images[i].rect[3] &&
          r.rect[3] < cap.rect[1] &&
          r.rect[0] >= images[i].rect[0] &&
          r.rect[2] <= images[i].rect[2]
      )
    )
    if (labels.some((rs) => rs.length !== 1)) return strokePairRefuse('panel labels')
    const panels = labels.map((rs) => rs[0]),
      panelEm = panels[0].r.height
    if (
      panels.some(
        (r, i) =>
          !strokePairNormalRecord(r) ||
          r.r.fontName !== panels[0].r.fontName ||
          r.r.height !== panelEm ||
          !(panelEm >= em && panelEm <= em * 1.5) ||
          strokePairWords(r.r.str) < 2 ||
          strokePairWords(r.r.str) > 8 ||
          Math.abs(strokePairCenter(r.rect) - strokePairCenter(images[i].rect)) > panelEm ||
          r.rect[0] < images[i].rect[0] ||
          r.rect[2] > images[i].rect[2] ||
          r.rect[1] < images[i].rect[3] ||
          r.rect[1] - images[i].rect[3] > panelEm * 2 ||
          strokePairFirst(r) <= images[i].operationIndex ||
          Math.abs(r.rect[3] - panels[0].rect[3]) > panelEm / 100
      )
    )
      return strokePairRefuse('panels')
    const captionRecords = p.records.filter((r) => strokePairHit(r.rect, cap.rect)),
      captionFirst = Math.min(...captionRecords.map(strokePairFirst))
    if (
      !captionRecords.length ||
      captionRecords.some(
        (r) => !strokePairNormalRecord(r) || !strokePairInside(cap.rect, r.rect)
      ) ||
      strokePairCompact(captionRecords.map((r) => r.r.str).join('')) !==
        strokePairCompact(cap.lines.join(''))
    )
      return strokePairRefuse('caption')
    const band = p.records.filter(
        (r) => r.rect[1] >= Math.max(...panels.map((q) => q.rect[3])) && r.rect[3] < cap.rect[1]
      ),
      descriptions = band
        .filter((r) => r.r.fontName === font && r.r.height === em && strokePairNormalRecord(r))
        .toSorted((a, b) => a.rect[0] - b.rect[0])
    if (
      descriptions.length !== 6 ||
      descriptions.some(
        (r) =>
          strokePairWords(r.r.str) < 1 ||
          strokePairWords(r.r.str) > 2 ||
          /[.!?]/u.test(r.r.str) ||
          strokePairFirst(r) <= Math.max(...panels.map(strokePairLast)) ||
          strokePairLast(r) >= captionFirst
      ) ||
      Math.max(...descriptions.map((r) => r.rect[3])) -
        Math.min(...descriptions.map((r) => r.rect[3])) >
        em / 5 ||
      Math.max(...descriptions.map((r) => union(r.part.map(({ g }) => g.ink))[1])) >=
        Math.min(...descriptions.map((r) => union(r.part.map(({ g }) => g.ink))[3]))
    )
      return strokePairRefuse('legend row')
    const tuples = descriptions.slice(0, 4).map((r) => /^([A-Z])\s+(\p{L}{3,12})$/u.exec(r.r.str))
    if (
      tuples.some((t) => !t) ||
      new Set(tuples.map((t) => t[1])).size !== 2 ||
      new Set(tuples.map((t) => t[2])).size !== 2 ||
      tuples[0][1] !== tuples[1][1] ||
      tuples[2][1] !== tuples[3][1] ||
      tuples[0][2] !== tuples[2][2] ||
      tuples[1][2] !== tuples[3][2]
    )
      return strokePairRefuse('crossproduct')
    const allPaths = []
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a?.[0] === OPS.endPath) continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint)
        return strokePairRefuse(
          'path envelope ' + i + ' op ' + a?.[0] + ' state ' + JSON.stringify(state)
        )
      const nominal = p.box(Array.from(a[2]), Util.transform(p.v.transform, state.transform))
      if (
        !Array.isArray(nominal) ||
        nominal.length !== 4 ||
        !nominal.every(Number.isFinite) ||
        nominal[0] > nominal[2] ||
        nominal[1] > nominal[3]
      )
        return strokePairRefuse('nominal path')
      allPaths.push({ i, state, paint, nominal })
    }
    const ownedPaths = new Set(),
      keys = []
    for (const description of [...descriptions.slice(0, 4), descriptions[5]]) {
      const options = allPaths.filter(
        (path) =>
          strokePairValid(path.nominal) &&
          !ownedPaths.has(path) &&
          path.nominal[2] <= description.rect[0] &&
          description.rect[0] - path.nominal[2] < em &&
          path.nominal[2] - path.nominal[0] <= em * 2 &&
          path.nominal[3] - path.nominal[1] <= em * 2 &&
          strokePairHit(path.nominal, [
            description.rect[0] - em * 3,
            description.rect[1],
            description.rect[0],
            description.rect[3]
          ])
      )
      if (options.length !== 1) return strokePairRefuse('legend path key')
      ownedPaths.add(options[0])
      keys.push(options[0])
    }
    const starRecords = p.records.filter((r) => /^[*⋆]$/u.test(r.r.str)),
      overlays = []
    for (const image of images) {
      const candidates = starRecords.filter((r) => strokePairInside(image.rect, r.rect))
      if (
        candidates.length !== 2 ||
        !candidates.every((r) => r.advanceComplete && r.part.length === 1) ||
        !sameValue(candidates[0].rect, candidates[1].rect) ||
        candidates[0].r.str !== candidates[1].r.str ||
        candidates[0].r.fontName !== candidates[1].r.fontName ||
        candidates[0].r.height !== candidates[1].r.height
      )
        return strokePairRefuse('overlay pair')
      const stroke = candidates.find((r) => r.part[0].g.strokeOnlyText),
        fill = candidates.find((r) => !r.part[0].g.strokeOnlyText)
      if (
        !stroke ||
        !fill ||
        !strokePairNormalRecord(fill) ||
        !strokePairValid(strokePairGlyphInk(stroke.part[0].g, 4)) ||
        !strokePairInside(image.rect, strokePairGlyphInk(stroke.part[0].g, 4))
      )
        return strokePairRefuse('overlay stroke/fill')
      overlays.push({ stroke, fill })
    }
    const legendStars = band.filter(
        (r) =>
          starRecords.includes(r) && !overlays.some((pair) => pair.stroke === r || pair.fill === r)
      ),
      star = legendStars[0]
    if (
      legendStars.length !== 1 ||
      !strokePairNormalRecord(star) ||
      star.part.length !== 1 ||
      overlays.some(
        (pair) =>
          pair.fill.r.str !== star.r.str ||
          pair.fill.r.fontName !== star.r.fontName ||
          pair.fill.r.height !== star.r.height ||
          pair.fill.part[0].g.textPaint.fillColor !== star.part[0].g.textPaint.fillColor
      ) ||
      star.rect[2] > descriptions[4].rect[0] ||
      descriptions[4].rect[0] - star.rect[2] > em ||
      Math.abs(star.rect[3] - descriptions[4].rect[3]) > em / 5
    )
      return strokePairRefuse('legend star key')
    const selected = [
        ...tasks,
        ...panels,
        ...descriptions,
        star,
        ...overlays.flatMap((pair) => [pair.stroke, pair.fill])
      ],
      ownedGlyphs = new Set(selected.flatMap((r) => r.part.map(({ g }) => g))),
      owners = new Map()
    for (const r of p.records)
      for (const { g } of r.part) {
        if (!owners.has(g)) owners.set(g, new Set())
        owners.get(g).add(r.index)
      }
    if (
      selected.some((r) => !r.advanceComplete) ||
      [...ownedGlyphs].some((g) => owners.get(g)?.size !== 1) ||
      band.some((r) => !selected.includes(r))
    )
      return strokePairRefuse('whole record ownership')
    for (const path of allPaths)
      if (images.some((image) => strokePairInside(image.rect, path.nominal))) ownedPaths.add(path)
    const owned = [
        ...images.map((im) => im.rect),
        ...selected.map((r) => r.rect),
        ...[...ownedGlyphs].map((g) => strokePairGlyphInk(g, 4)),
        ...[...ownedPaths].map((path) => path.paint.rect)
      ],
      foreignGlyphs = p.glyphs.filter((g) => !ownedGlyphs.has(g)),
      foreignPaths = allPaths.filter((path) => !ownedPaths.has(path)),
      padding = Math.max(2 / 1.5, ...[...ownedPaths].map((path) => (path.paint.floor + 2) / 1.5)),
      rect = strokePairExpand(union([oldRect, ...owned]), padding)
    if (
      !strokePairValid(rect) ||
      !strokePairInside(pageRect, rect) ||
      tables.some((r) => strokePairHit(rect, r)) ||
      peers.some((f) => f !== figure && strokePairValid(f.rect) && strokePairHit(rect, f.rect)) ||
      selected.every((r) => strokePairInside(oldRect, r.rect)) ||
      foreignGlyphs.some((g) => !strokePairForeignGlyphSafe(g, 1.5, rect)) ||
      foreignPaths.some((path) =>
        strokePairHit(rect, strokePairExpand(path.paint.rect, (path.paint.floor + 2) / 1.5))
      )
    )
      return strokePairRefuse('foreign confinement')
    const plan = Object.freeze({ rect, graphicsCount: 2 }),
      proof = {
        owned,
        ownedGlyphs: [...ownedGlyphs],
        foreignGlyphs,
        ownedPaths: [...ownedPaths],
        foreignPaths
      },
      output = retainNativeArrayPixelInputs([plan, proof]),
      current = () => keep() && p.current() && binding() && output?.()
    if (!current()) return strokePairRefuse('current')
    strokePairPixelPlans.set(plan, { page, current, p, proof, context, live })

    return plan
  } catch {
    return undefined
  }
}
export function nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, page) {
  try {
    const proof = strokePairPixelPlans.get(plan)
    if (
      !proof ||
      proof.page !== page ||
      plan.rect !== rect ||
      !proof.current() ||
      !proof.seal?.current() ||
      !proof.canonical
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || raster.scaleLower < 1.5) return false
    if (!Buffer.from(png).equals(proof.canonical)) return false
    const scale = raster.scaleLower,
      { ownedGlyphs, foreignGlyphs, ownedPaths, foreignPaths } = proof.proof,
      owned = [
        ...proof.p.evidence.images.map((im) => im.rect),
        ...ownedGlyphs.map((g) => strokePairGlyphInk(g, scale)),
        ...ownedPaths.map((p) => p.paint.rect)
      ]
    return (
      owned.every(
        (r) => strokePairValid(r) && strokePairInside(rect, strokePairExpand(r, 1 / scale))
      ) &&
      ownedPaths.every((p) =>
        strokePairInside(rect, strokePairExpand(p.paint.rect, (p.paint.floor + 2) / scale))
      ) &&
      foreignGlyphs.every((g) => strokePairForeignGlyphSafe(g, scale, raster.protection)) &&
      foreignPaths.every(
        (p) =>
          !strokePairHit(
            raster.protection,
            strokePairExpand(p.paint.rect, (p.paint.floor + 2) / scale)
          )
      ) &&
      proof.current() &&
      proof.seal.current()
    )
  } catch {
    return false
  }
}
function strokePairImageByteWindow(data) {
  try {
    if (
      !data ||
      types.isProxy(data) ||
      !ArrayBuffer.isView(data) ||
      ![Uint8Array.prototype, Uint8ClampedArray.prototype].includes(Object.getPrototypeOf(data)) ||
      Object.getOwnPropertySymbols(data).length ||
      ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'toJSON'].some((key) =>
        Object.hasOwn(data, key)
      )
    )
      return
    const buffer = groupBufferGetter.call(data)
    if (
      types.isProxy(buffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      Reflect.ownKeys(buffer).length ||
      (groupResizable && groupResizable.call(buffer))
    )
      return
    const bufferByteLength = groupBufferLength.call(buffer),
      byteOffset = groupOffsetGetter.call(data),
      byteLength = groupLengthGetter.call(data)
    if (
      !Number.isSafeInteger(bufferByteLength) ||
      bufferByteLength > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(byteLength) ||
      byteOffset < 0 ||
      byteLength < 0 ||
      byteOffset + byteLength > bufferByteLength
    )
      return
    return {
      prototype: Object.getPrototypeOf(data),
      buffer,
      bufferByteLength,
      byteOffset,
      byteLength
    }
  } catch {
    return undefined
  }
}
function strokePairSealedDisplayImages(proof, display) {
  const nativePage = proof.live.nativePage,
    objsSlot = Object.getOwnPropertyDescriptor(nativePage, 'objs'),
    store = objsSlot?.value,
    prototype = store && Object.getPrototypeOf(store),
    getSlot = prototype && Object.getOwnPropertyDescriptor(prototype, 'get'),
    ownGet = store && Object.getOwnPropertyDescriptor(store, 'get'),
    get = getSlot?.value,
    binding = strokePairLiveInputs(
      proof.context,
      proof.p,
      { nativePage, pageContent: proof.live.pageContent, operators: display },
      true
    )
  if (!store || typeof get !== 'function' || ownGet || !binding || !binding()) {
    return
  }
  const images = []
  for (const image of proof.p.evidence.images) {
    const original = proof.p.o.argsArray[image.operationIndex],
      args = display.argsArray[image.operationIndex]
    if (
      display.fnArray[image.operationIndex] !== OPS.paintImageXObject ||
      !Array.isArray(args) ||
      args.length !== 3 ||
      !sameValue(args.slice(1), original.slice(1))
    )
      return
    const data = get.call(store, args[0]),
      own = nativeRecoveryOwnValues(data),
      bytes = own?.data,
      view = strokePairImageByteWindow(bytes),
      length = args[1] * args[2] * (own?.kind === 2 ? 3 : own?.kind === 3 ? 4 : 0)
    if (
      !own ||
      own.bitmap != null ||
      ![2, 3].includes(own.kind) ||
      own.width !== args[1] ||
      own.height !== args[2] ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 8 * 1024 * 1024 ||
      !view ||
      view.byteLength !== length
    ) {
      return
    }
    if (own.kind === 3) for (let i = 3; i < length; i += 4) if (bytes[i] !== 255) return
    const keys = Reflect.ownKeys(data)
    if (keys.some((key) => typeof key !== 'string')) return
    const prototype = Object.getPrototypeOf(data),
      slots = groupSlots(data, keys),
      metadata = Object.fromEntries(Object.entries(own).filter(([key]) => key !== 'data')),
      metadataCurrent = retainNativeArrayPixelInputs([metadata]),
      current = () => {
        if (
          !slots ||
          !metadataCurrent?.() ||
          Object.getPrototypeOf(data) !== prototype ||
          !groupSlotsCurrent(slots) ||
          !sameValue(Reflect.ownKeys(data), keys)
        )
          return false
        const now = strokePairImageByteWindow(bytes)
        return (
          !!now &&
          ['prototype', 'buffer', 'bufferByteLength', 'byteOffset', 'byteLength'].every(
            (key) => now[key] === view[key]
          )
        )
      },
      hash = createHash('sha256').update(bytes).digest('hex')
    if (!current || !current()) return
    images.push({ id: args[0], data, current, bytes, hash, kind: own.kind })
  }
  return {
    images,
    current: () =>
      proof.current() &&
      binding() &&
      Object.getPrototypeOf(store) === prototype &&
      sameValue(Object.getOwnPropertyDescriptor(nativePage, 'objs'), objsSlot) &&
      sameValue(Object.getOwnPropertyDescriptor(prototype, 'get'), getSlot) &&
      Object.getOwnPropertyDescriptor(store, 'get') === undefined &&
      images.every(
        (row) =>
          get.call(store, row.id) === row.data &&
          row.current() &&
          createHash('sha256').update(row.bytes).digest('hex') === row.hash
      )
  }
}
export async function renderNativeStrokeTaskPairPng(plan, nativePage, rect, rotation) {
  const proof = strokePairPixelPlans.get(plan)
  try {
    if (
      !proof ||
      !proof.current() ||
      proof.live.nativePage !== nativePage ||
      plan.rect !== rect ||
      rotation !== 0
    )
      return
    proof.seal = undefined
    proof.canonical = undefined
    const adapter = {
        rotate: rotation,
        getViewport: (options) => nativePage.getViewport(options),
        render: (options) => {
          if (!proof.current()) throw Error('Native stroke preview changed before rendering.')
          const task = nativePage.render(options),
            promise = task.promise.then((value) => {
              if (!proof.current()) throw Error('Native stroke preview changed during rendering.')
              const seal = strokePairSealedDisplayImages(
                proof,
                task._internalRenderTask?.operatorList
              )
              if (!seal || !seal.current())
                throw Error('Native stroke image opacity/display changed.')
              proof.seal = seal
              return value
            })
          return { promise }
        }
      },
      png = await renderPdfCrop(adapter, rect, rotation)
    if (!proof.current() || !proof.seal?.current()) return
    proof.canonical = Buffer.from(png)
    if (nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, proof.page)) return png
  } catch {
    // An optional preview declines atomically when its final render changes.
  }
  if (proof) {
    proof.seal = undefined
    proof.canonical = undefined
  }
}
