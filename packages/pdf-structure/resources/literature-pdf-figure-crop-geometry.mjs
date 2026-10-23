/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

// A single raster in a non-masking, untransformed group can outlive its
// quantized box. Keep the complete image, separating it from actual caption
// glyph ink rather than the caption's taller advance box. The legacy numeric
// limit and ordinary packet API retain their existing contracts.
export function nativeGroupedRasterCaptionBottom(page, figure, context) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0,
    same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7)),
    o = context?.operators,
    v = context?.viewport,
    caption = figure?.caption,
    raw = context?.content?.items
  if (
    !Number.isSafeInteger(page?.pageNumber) ||
    page.pageNumber < 1 ||
    !valid(figure?.rect) ||
    !valid(caption?.rect) ||
    caption.page !== page?.pageNumber ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    !caption.lines.every((l) => typeof l === 'string') ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.invalidGraphicsBounds !== 0 ||
    ![
      raw,
      page.graphicsBounds,
      context?.graphicsBounds,
      o?.fnArray,
      o?.argsArray,
      context?.glyphBounds
    ].every(Array.isArray) ||
    raw.some((r) => !r || typeof r.str !== 'string') ||
    !same(page.graphicsBounds, context.graphicsBounds) ||
    page.graphicsBounds.length !== 1 ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !same(v?.transform, [1, 0, 0, -1, 0, page.height]) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height
  )
    return
  const start = o.fnArray.indexOf(OPS.beginGroup),
    end = o.fnArray.indexOf(OPS.endGroup),
    group = o.argsArray[start]?.[0]
  if (
    start < 0 ||
    end <= start ||
    o.fnArray.lastIndexOf(OPS.beginGroup) !== start ||
    o.fnArray.lastIndexOf(OPS.endGroup) !== end ||
    !group ||
    !same(Object.keys(group).sort(), ['bbox', 'isolated', 'knockout', 'matrix', 'smask']) ||
    group.matrix !== null ||
    group.smask !== null ||
    group.knockout !== false ||
    typeof group.isolated !== 'boolean' ||
    !valid(group.bbox) ||
    o.argsArray[start]?.length !== 1 ||
    !same(o.argsArray[start], o.argsArray[end]) ||
    o.fnArray.slice(start + 1, end).includes(OPS.showText)
  )
    return
  // Group clipping can only shrink this envelope. No group matrix or mask is
  // admitted; save/restore preserves the original indices and parent state.
  const normalized = { fnArray: [...o.fnArray], argsArray: [...o.argsArray] }
  normalized.fnArray[start] = OPS.save
  normalized.fnArray[end] = OPS.restore
  normalized.argsArray[start] = normalized.argsArray[end] = []
  for (let i = start + 1; i < end; i++) {
    if (o.fnArray[i] !== OPS.beginText) continue
    const stop = o.fnArray.indexOf(OPS.endText, i + 1)
    if (
      stop <= i ||
      stop >= end ||
      !o.fnArray
        .slice(i + 1, stop)
        .every((n) => [OPS.dependency, OPS.setFont, OPS.setLeading].includes(n))
    )
      return
    // Leading in this empty text block paints nothing. Any visible packet or
    // relative line movement still reaches the unchanged strict packet parser.
    for (let j = i + 1; j < stop; j++)
      if (o.fnArray[j] === OPS.setLeading) {
        if (o.argsArray[j]?.length !== 1 || !Number.isFinite(o.argsArray[j][0])) return
        normalized.fnArray[j] = OPS.dependency
        normalized.argsArray[j] = []
      }
    i = stop
  }
  const tokens = raw
      .filter((r) => typeof r.str === 'string' && r.str.trim())
      .map((r) => tableTextToken(r, v, 0)),
    packet = nativePageTextPacketInventory(
      page,
      tokens,
      { ...context, operators: normalized },
      true
    )
  if (!packet || packet.evidence.paths.size || packet.evidence.images.length !== 1) return
  const image = packet.evidence.images[0],
    graphic = page.graphicsBounds[0],
    a = o.argsArray[image.operationIndex],
    images = context.opaqueRasterImages
  if (
    !valid(image.rect) ||
    !inside(figure.rect, image.rect) ||
    !valid(graphic?.normalizedRect) ||
    graphic.normalizedRect.some((n) => n < 0 || n > 1) ||
    graphic.kind !== 'image' ||
    graphic.operationIndex !== image.operationIndex ||
    image.operationIndex <= start ||
    image.operationIndex >= end ||
    !Array.isArray(images) ||
    images.length !== 1 ||
    !images[0] ||
    images[0].operationIndex !== image.operationIndex ||
    images[0].kind !== 2 ||
    !Number.isSafeInteger(a?.[1]) ||
    a[1] <= 0 ||
    !Number.isSafeInteger(a?.[2]) ||
    a[2] <= 0 ||
    images[0].imageId !== a?.[0] ||
    images[0].width !== a?.[1] ||
    images[0].height !== a?.[2]
  )
    return
  const records = packet.records.filter((r) => inside(caption.rect, r.rect)),
    key = (s) => s.replace(/\s+/gu, '')
  if (
    !records.length ||
    key(records.map((r) => r.r.str).join(' ')) !== key(caption.lines.join(' '))
  )
    return
  const claimed = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
    captionInk = [...claimed].filter((g) => area(g.ink) > 0),
    captionInkTop = Math.min(...captionInk.map((g) => g.ink[1])),
    bottom = (image.rect[3] + captionInkTop) / 2,
    strip = [0, bottom, page.width, Math.min(page.height, figure.rect[3] + 2)]
  if (
    !captionInk.length ||
    !Number.isFinite(bottom) ||
    image.rect[3] >= captionInkTop ||
    bottom >= figure.rect[3] ||
    bottom <= figure.rect[1] ||
    figure.rect[3] - bottom > (page.height / 256) * 2 ||
    packet.glyphs.some((g) => !claimed.has(g) && intersection(g.ink, strip) > 0)
  )
    return
  return { bottom, captionInkTop, imageRect: image.rect }
}

// Byte-budget retries change the scale and ceil-sized last pixel. Admit this
// optional trim only after the actual PNG protects both complete paint domains.
export function nativeGroupedRasterCaptionPngSafe(proof, png, rect, bounds) {
  if (
    !proof ||
    !Array.isArray(proof.imageRect) ||
    proof.imageRect.length !== 4 ||
    !proof.imageRect.every(Number.isFinite) ||
    area(proof.imageRect) <= 0 ||
    !Number.isFinite(proof.captionInkTop) ||
    !Number.isFinite(proof.bottom) ||
    rect?.[3] !== proof.bottom ||
    proof.bottom !== (proof.imageRect[3] + proof.captionInkTop) / 2
  )
    return false
  const raster = getPdfCropRasterProtectionFromPng(png, rect, bounds)
  return (
    !!raster &&
    raster.protection[3] < proof.captionInkTop &&
    proof.imageRect.every((n, i) =>
      i < 2 ? n >= rect[i] + 1 / raster.scaleLower : n <= rect[i] - 1 / raster.scaleLower
    )
  )
}

// Quantized paint boxes can overlap a caption even though the actual native
// clip ends above it. Trim only that spill, with complete text provenance and
// a native clip/image bound for every operation touching the removed strip.
export function nativeFigureCaptionBottomLimit(page, figure, context) {
  const fallback = page.height,
    finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
    valid = (r) => finite(r, 4) && area(r) > 0,
    eq = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    rect = figure?.rect,
    caption = figure?.caption,
    o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items
  if (
    !valid(rect) ||
    !valid(caption?.rect) ||
    caption.page !== page.pageNumber ||
    !caption.lines?.length ||
    page.invalidGraphicsBounds !== 0 ||
    ![raw, page.graphicsBounds, context?.graphicsBounds, o?.fnArray, o?.argsArray].every(
      Array.isArray
    ) ||
    !eq(context.graphicsBounds, page.graphicsBounds) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !eq(v.transform, [1, 0, 0, -1, 0, page.height])
  )
    return fallback
  const bottom = caption.rect[1] - 0.5
  if (bottom <= rect[1] || bottom >= rect[3] || rect[3] - bottom > (page.height / 256) * 2)
    return fallback
  if (
    o.fnArray.some(
      (op, i) =>
        [OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup].includes(op) ||
        (op === OPS.setTextRenderingMode && o.argsArray[i]?.[0] !== 0) ||
        (op === OPS.showText &&
          o.argsArray[i]?.[0]?.some((g) => typeof g === 'object' && g?.accent != null))
    )
  )
    return fallback
  const viewport = { ...v, convertToViewportPoint: (x, y) => [x, page.height - y] },
    tokens = []
  const captionTokens = []
  for (const [index, item] of raw.entries()) {
    if (!item.str?.trim()) continue
    if (!finite(item.transform, 6) || !(item.width > 0) || !(item.height > 0)) return fallback
    const token = {
      ...tableTextToken(item, viewport, 0),
      fontName: item.fontName,
      nativeLabelRect: nativeFigureLabelBounds(
        item,
        context.content.styles?.[item.fontName],
        viewport
      )
    }
    if (
      !valid(token.rect) ||
      token.text !== item.str ||
      token.sourceItem?.pageNumber !== page.pageNumber ||
      token.sourceItem.index !== index ||
      token.sourceItem.text !== item.str
    )
      return fallback
    tokens.push(token)
    if (
      token.rect.every((n, j) =>
        j < 2 ? n >= caption.rect[j] - 1e-7 : n <= caption.rect[j] + 1e-7
      )
    )
      captionTokens.push(token)
  }
  const textKey = (text) => text.replace(/\s+/gu, '')
  if (
    !captionTokens.length ||
    textKey(captionTokens.map((t) => t.text).join(' ')) !== textKey(caption.lines.join(' '))
  )
    return fallback
  const strip = [rect[0] - 2, bottom, rect[2] + 2, rect[3] + 2]
  for (const token of tokens) {
    if (captionTokens.includes(token) || intersection(token.rect, strip) <= 0) continue
    return fallback
  }
  // Complete a label's descenders even when its advance box ends above the
  // strip. Unknown metrics cannot prove that removing the strip is harmless.
  for (const token of tokens.filter((t) => !captionTokens.includes(t) && t.rect[3] <= bottom)) {
    const style = context.content.styles?.[token.fontName]
    if (
      !valid(token.nativeLabelRect) ||
      !Number.isFinite(style?.descent) ||
      style.descent > 0 ||
      style.descent < -1
    )
      return fallback
    // Rotate the whole font envelope, including its descender, with the
    // native text basis. A horizontal baseline formula cannot bound a tick
    // label rotated away from the caption.
    if (!token.horizontal) {
      const item = raw[token.sourceItem.index],
        [a, b, c, d, x, y] = item.transform,
        advance = Math.hypot(a, b),
        height = Math.hypot(c, d)
      if (!Number.isFinite(style.ascent) || style.ascent <= 0) return fallback
      const points = [0, item.width].flatMap((u) =>
        [style.descent * height, Math.max(1, style.ascent) * height].map((v) =>
          viewport.convertToViewportPoint(
            x + (a / advance) * u + (c / height) * v,
            y + (b / advance) * u + (d / height) * v
          )
        )
      )
      if (
        points.some((p) => !finite(p, 2)) ||
        Math.max(token.rect[3], token.nativeLabelRect[3], ...points.map((p) => p[1])) + 0.5 > bottom
      )
        return fallback
    } else if (
      Math.max(
        token.rect[3],
        token.baseline - style.descent * token.height + 0.5,
        token.nativeLabelRect[3]
      ) > bottom
    )
      return fallback
  }
  const evidence = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
  collectClosedFigureFrames(o, v, evidence)
  if (
    new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !== page.graphicsBounds.length ||
    page.graphicsBounds.some(
      (g) => !valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex)
    )
  )
    return fallback
  const graphics = page.graphicsBounds.filter((g) => {
    const r = g.normalizedRect?.map((n, i) => n * (i % 2 ? page.height : page.width))
    return valid(r) && intersection(r, strip) > 0
  })
  if (!graphics.length) return fallback
  for (const graphic of graphics) {
    const n = graphic.operationIndex,
      bound =
        graphic.kind === 'path' && o.fnArray[n] === OPS.constructPath
          ? evidence.paths.get(n)?.clip
          : graphic.kind === 'image' && o.fnArray[n] === OPS.paintImageXObject
            ? evidence.images.find((image) => image.operationIndex === n)?.rect
            : undefined
    if (!valid(bound) || bound[3] > bottom) return fallback
  }
  return bottom
}

// Association has already excluded these prose owners. Limit only the final
// padding and proved quantization spill, using font descent and native paint.
export function nativeProseInkTopLimit(figure, tokens, page, context) {
  if (!figure.rect || !figure.excludedProseLines?.length) return 0
  const paintTop = nativeRasterTop(figure, tokens, page, context)
  const limit = Math.max(figure.rect[1], paintTop ?? 0)
  const bottoms = tokens
    .filter(
      (t) =>
        t.horizontal &&
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        Number.isFinite(t.baseline) &&
        Number.isFinite(t.height) &&
        t.height > 0 &&
        Number.isFinite(t.fontDescent) &&
        t.fontDescent >= -1 &&
        t.fontDescent <= 0 &&
        t.rect[3] <= figure.rect[1] &&
        figure.excludedProseLines.some(
          (line) => intersection(lineRect(line), t.rect) / area(t.rect) > 0.8
        )
    )
    .map((t) => t.baseline - t.fontDescent * t.height + 0.5)
    .map((bottom) => (paintTop === undefined ? bottom : Math.min(bottom, paintTop)))
    .filter((bottom) => bottom <= limit)
  return Math.max(0, ...bottoms)
}

// The geometry recorder rounds image bounds to page bins. A matching native
// image transform can prove that the apparent top strip contains no plate ink.
// Clipping only reduces this envelope, so an unclipped envelope is conservative.
function nativeRasterTop(figure, tokens, page, context) {
  const o = context?.operators,
    v = context?.viewport
  if (
    !page?.graphicsBounds?.length ||
    !o?.fnArray ||
    !o.argsArray ||
    o.fnArray.length !== o.argsArray.length ||
    !v?.transform?.every(Number.isFinite)
  )
    return
  const related = page.graphicsBounds.filter((g) => {
    const r = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
    return (
      intersection(r, [
        figure.rect[0],
        figure.rect[1],
        figure.rect[2],
        figure.rect[1] + page.height / 256
      ]) > 0
    )
  })
  if (related.length !== 1 || related[0].kind !== 'image') return
  const index = related[0].operationIndex
  if (o.fnArray[index] !== OPS.paintImageXObject) return
  let matrix = [1, 0, 0, 1, 0, 0]
  const stack = []
  for (let i = 0; i <= index; i++) {
    const op = o.fnArray[i],
      args = o.argsArray[i]
    if ([OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup].includes(op)) return
    if (op === OPS.save) stack.push([...matrix])
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      matrix = stack.pop()
    } else if (op === OPS.transform) {
      if (args?.length !== 6 || !args.every(Number.isFinite)) return
      matrix = Util.transform(matrix, args)
    } else if (op === OPS.paintFormXObjectBegin) {
      stack.push([...matrix])
      if (args?.[0]) {
        if (args[0].length !== 6 || !args[0].every(Number.isFinite)) return
        matrix = Util.transform(matrix, args[0])
      }
    }
  }
  const points = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0]
  ]
  const transform = Util.transform(v.transform, matrix)
  for (const point of points) Util.applyTransform(point, transform)
  const top = Math.min(...points.map((point) => point[1]))
  if (
    !Number.isFinite(top) ||
    top <= figure.rect[1] ||
    top >= figure.rect[3] ||
    top > figure.rect[1] + page.height / 256
  )
    return
  const strip = [figure.rect[0], figure.rect[1], figure.rect[2], top]
  if (
    tokens.some(
      (token) =>
        token.rect &&
        intersection(token.rect, strip) > 0 &&
        !figure.excludedProseLines.some(
          (line) => intersection(lineRect(line), token.rect) / area(token.rect) > 0.8
        )
    )
  )
    return
  return top
}

// Match the Reader's native label envelope before publishing optional source
// claims. Font ascent and descent are not necessarily complementary metrics.
export function nativeFigureLabelBounds(item, style, viewport) {
  if (
    item.dir !== 'ltr' ||
    style?.vertical ||
    item.transform?.length !== 6 ||
    ![...item.transform, item.width, item.height].every(Number.isFinite) ||
    item.width <= 0 ||
    item.height <= 0
  )
    return
  const [a, b, c, d, x, y] = item.transform,
    advance = Math.hypot(a, b),
    height = Math.hypot(c, d)
  if (
    advance <= 0 ||
    height <= 0 ||
    a * d - b * c <= 0 ||
    Math.abs(a * c + b * d) > advance * height * 0.0001
  )
    return
  const ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
  const points = [0, item.width].flatMap((u) =>
    [-(1 - ascent) * height, ascent * height].map((v) =>
      viewport.convertToViewportPoint(
        x + (a / advance) * u + (c / height) * v,
        y + (b / advance) * u + (d / height) * v
      )
    )
  )
  const rect = [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
  return rect.every(Number.isFinite) && area(rect) > 0 ? rect : undefined
}

// Native advance boxes end at the baseline. Complete the ink of glyphs already
// wholly owned by this plate, without admitting adjacent text into the crop.
export function nativeOwnedFigureInkBottom(figure, tokens) {
  const rect = figure.rect
  if (!rect?.every(Number.isFinite) || area(rect) <= 0) return rect?.[3] ?? 0
  // Viewport scaling and its inverse can differ by a floating-point ulp.
  const epsilon = 1e-8
  const owned = tokens.filter(
    (token) =>
      token.horizontal &&
      token.rect?.every(Number.isFinite) &&
      area(token.rect) > 0 &&
      token.rect[0] >= rect[0] - epsilon &&
      token.rect[1] >= rect[1] - epsilon &&
      token.rect[2] <= rect[2] + epsilon &&
      token.rect[3] <= rect[3] + epsilon &&
      Number.isFinite(token.baseline) &&
      Math.abs(token.baseline - token.rect[3]) <= 0.01 &&
      Number.isFinite(token.height) &&
      token.height > 0 &&
      Number.isFinite(token.fontDescent) &&
      token.fontDescent >= -1 &&
      token.fontDescent <= 0 &&
      !figure.excludedProseLines?.some(
        (line) => intersection(lineRect(line), token.rect) / area(token.rect) > 0.8
      )
  )
  const bottom = Math.max(
    rect[3],
    ...owned.map((token) => {
      const claimed = figure.sourceItems?.some(
        (item) =>
          item.pageNumber === token.sourceItem?.pageNumber &&
          item.index === token.sourceItem?.index &&
          item.text === token.text &&
          item.text === token.sourceItem?.text
      )
      const label = claimed && token.nativeLabelRect
      return Math.max(
        token.baseline - token.fontDescent * token.height + 0.5,
        label?.length === 4 && label.every(Number.isFinite) && area(label) > 0 ? label[3] : 0
      )
    })
  )
  if (bottom === rect[3]) return bottom
  const strip = [rect[0], rect[3], rect[2], bottom]
  return tokens.some(
    (token) =>
      !owned.includes(token) &&
      token.rect?.every(Number.isFinite) &&
      (intersection(strip, token.rect) > 0 ||
        (token.nativeLabelRect?.every(Number.isFinite) &&
          intersection(strip, token.nativeLabelRect) > 0))
  )
    ? rect[3]
    : bottom
}
