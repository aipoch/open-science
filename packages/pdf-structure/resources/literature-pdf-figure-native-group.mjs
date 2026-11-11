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
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { nativeFillStrokeGlyphEnvelope } from './literature-pdf-figure-native-stroked-text.mjs'

const pairedGroupPixelCertificates = new WeakMap(),
  pairedGroupPixelMode = Symbol('paired-group-pixel'),
  nonisolatedGroupPixelMode = Symbol('nonisolated-group-pixel'),
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
    nonisolatedPixels = mode === nonisolatedGroupPixelMode,
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
  const groups = [],
    stack = [],
    chars = [],
    outsideGlyphs = []
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
          group ||
          !g ||
          g.matrix !== null ||
          g.smask !== null ||
          g.knockout !== false ||
          typeof g.isolated !== 'boolean' ||
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
        group = { begin: i, arg: g, rect, paint: [], records: [], forms: 0 }
        groups.push(group)
      } else if (op === OPS.paintFormXObjectBegin) {
        if (group) {
          if (++group.forms !== 1 || !equal(a, [null, null])) return
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
        if (
          !group ||
          !equal(a?.[0], group.arg) ||
          o.fnArray[i - 1] !== OPS.paintFormXObjectEnd ||
          (pixels ? marked !== previous.marked : marked)
        )
          return
        group.end = i
        group = undefined
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
      if (text || !group) return
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
        if (pixels && op === OPS.constructPath) continue
        return
      }
      if (
        g.kind !== (op === OPS.constructPath ? 'path' : 'image') ||
        (!pixels && !inside(group.rect, g.rect))
      )
        return
      group.paint.push(g)
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
              (e[0] === 'SMask' && e[1] === false)
            )
        )
      )
        return
      if (pixels)
        for (const [k, v] of a[0]) {
          if (k === 'ca') state.fillAlpha = v
          if (k === 'CA') state.strokeAlpha = v
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
    if (
      source?.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== r.str ||
      !finite(r.transform, 6) ||
      (!(r.width > 0) && !internalZero) ||
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
    if (pixels && !supplied && !(pixelType3.size && part.every((p) => !p.group))) return
    if (
      (!valid(token.rect) && !internalZero) ||
      (!pixels && bounds.some((n, i) => Math.abs(n - token.rect[i]) > 0.02)) ||
      (supplied &&
        (supplied.text !== r.str ||
          supplied.sourceItem.text !== r.str ||
          supplied.sourceItem.pageNumber !== page.pageNumber ||
          (!valid(supplied.rect) && !internalZero) ||
          supplied.rect.some((n, i) => Math.abs(n - token.rect[i]) > 1e-6)))
    )
      return
    const record = {
      r,
      part,
      index,
      token,
      group: part[0].group,
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
    outsideInk,
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
function liveOrdinaryGroupFonts(context, program, witness, scope) {
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
    if (op === OPS.constructPath) {
      if (!groupArrayData(b) || a?.[0] !== b[0]) return
      consumed.push([b, groupSlots(b, ['0'])])
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
  const wanted = [...program.records.filter((r) => !r.group).flatMap((r) => r.part), ...witness]
  for (const p of wanted) {
    if (!targets.has(p.font)) targets.set(p.font, new Set())
    targets.get(p.font).add(p.glyph.fontChar)
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
      const bounds = program.fonts.get(name)?.get(character)
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
              !equal(
                Array.from(p.getBounds.call(p.compiled)),
                program.fonts.get(f.name).get(p.character)
              )
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
    const profileGroups =
      mode === nonisolatedGroupPixelMode
        ? nativeNonisolatedGroupProfileData(nonisolatedProfile, page, tokens, context)
        : undefined
    if (
      mode === nonisolatedGroupPixelMode &&
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
      figure.parts ||
      figure.cropRects ||
      figure.formCropRaster ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      figure.sourceItems?.length ||
      (figure.reason && figure.reason !== 'native-raster-composite-grid') ||
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
      rect = group.rect.map((v, i) => v + (i < 2 ? -0.5 : 0.5))
    if (
      (mode === nonisolatedGroupPixelMode &&
        (group.begin !== profileGroups[0].begin ||
          group.end !== profileGroups[0].end ||
          group.arg.isolated !== false ||
          group.arg.knockout !== false ||
          group.arg.matrix !== null ||
          group.arg.smask !== null ||
          !equal(group.arg.bbox, profileGroups[0].bbox))) ||
      group.records.length < 3 ||
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
    if (!foreground.length) return
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
        !valid(r.label)
      )
        return
      outsideLabels.push(r.label)
    }
    const foreign = [...p.outsideInk.filter(valid), ...outsideLabels]
    if (foreign.some((r) => intersection(r, rect) > 0)) return
    const liveCurrent = liveOrdinaryGroupFonts(
        input,
        p,
        [...foreground, ...p.internalZeroParts],
        live
      ),
      output = { rect },
      owned = retainNativeRecoveryInputs([output, group, foreign, foreground, p.strokeEnvelopes])
    if (!liveCurrent || !owned || !liveCurrent()) return
    groupPixelCertificates.set(output, {
      page,
      group,
      foreign,
      strokeEnvelopes: p.strokeEnvelopes,
      current: () =>
        current() &&
        (mode !== nonisolatedGroupPixelMode ||
          nativeNonisolatedGroupProfileData(nonisolatedProfile, page, tokens, context) ===
            profileGroups) &&
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
  profile
) {
  const descriptors = nativeNonisolatedGroupProfileData(profile, page, tokens, context)
  if (!Array.isArray(descriptors) || descriptors.length !== 1) return
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
  if (!proof?.current()) return
  return plan
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
