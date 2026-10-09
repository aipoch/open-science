/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'
import { nativeTableDividerGraphic } from './literature-pdf-native-owned-figure-labels.mjs'
import { captionKind, groupPageLines } from './literature-pdf-caption-group.mjs'

const contains = (a, b, tolerance = 0) =>
  b[0] >= a[0] - tolerance &&
  b[1] >= a[1] - tolerance &&
  b[2] <= a[2] + tolerance &&
  b[3] <= a[3] + tolerance
const graphics = (page, kind) =>
  page.graphicsBounds
    .filter((g) => g.kind === kind)
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
const captionFont = (page, caption) =>
  Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
const blocked = (rect, caption, captions, tables) =>
  tables.some((r) => intersection(r, rect) > 0) ||
  captions.some((c) => c !== caption && c.page === caption.page && intersection(c.rect, rect) > 0)

// Three independently painted source rasters can have two native title rows.
// Complete raw text/image operations, unique source-font rows, and one caption
// jointly own the plate; missing evidence retains every legacy matcher.
function nativeKeyedRasterTextProfile(context, page) {
  const nums = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
  const ops = context?.operators,
    vp = context?.viewport
  if (
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !ops.fnArray.length ||
    ops.fnArray.length > 20_000 ||
    !nums(vp?.transform, 6) ||
    vp.scale !== 1 ||
    vp.rotation !== 0 ||
    vp.width !== page.width ||
    vp.height !== page.height ||
    vp.transform[0] !== 1 ||
    vp.transform[1] !== 0 ||
    vp.transform[2] !== 0 ||
    vp.transform[3] !== -1 ||
    vp.transform[4] !== 0 ||
    vp.transform[5] !== page.height
  )
    return
  let ctm = [1, 0, 0, 1, 0, 0],
    text = false,
    literal = ''
  const saved = [],
    images = []
  const empty = (a) => a == null || (Array.isArray(a) && a.length === 0)
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.save) {
      if (!empty(a) || text) return
      saved.push([...ctm])
      continue
    }
    if (op === OPS.restore) {
      if (!empty(a) || text || !saved.length) return
      ctm = saved.pop()
      continue
    }
    if (op === OPS.transform) {
      if (text || !nums(a, 6) || a[1] !== 0 || a[2] !== 0 || a[0] <= 0 || a[3] <= 0) return
      ctm = [ctm[0] * a[0], 0, 0, ctm[3] * a[3], ctm[0] * a[4] + ctm[4], ctm[3] * a[5] + ctm[5]]
      if (!ctm.every(Number.isFinite)) return
      continue
    }
    if (op === OPS.setGState) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        a[0].length !== 1 ||
        a[0][0]?.[0] !== 'SMask' ||
        a[0][0]?.[1] !== false ||
        a[0][0].length !== 2
      )
        return
      continue
    }
    if (op === OPS.paintImageXObject) {
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isSafeInteger(a[1]) ||
        !Number.isSafeInteger(a[2]) ||
        a[1] <= 0 ||
        a[2] <= 0
      )
        return
      images.push({
        id: a[0],
        width: a[1],
        height: a[2],
        matrix: [...ctm],
        rect: [ctm[4], page.height - ctm[5] - ctm[3], ctm[4] + ctm[0], page.height - ctm[5]]
      })
      continue
    }
    if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (!Array.isArray(a) || a.length !== 1 || a[0] !== '#000000') return
      continue
    }
    if (op === OPS.dependency) {
      if (!Array.isArray(a) || !a.length || !a.every((v) => typeof v === 'string' && v)) return
      continue
    }
    if (op === OPS.beginText) {
      if (text || !empty(a)) return
      text = true
      continue
    }
    if (op === OPS.endText) {
      if (!text || !empty(a)) return
      text = false
      continue
    }
    if (op === OPS.setFont) {
      if (
        !text ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return
      continue
    }
    if (op === OPS.moveText) {
      if (!text || !nums(a, 2)) return
      continue
    }
    if (op === OPS.showText) {
      if (!text || !Array.isArray(a) || a.length !== 1 || !Array.isArray(a[0])) return
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          continue
        }
        if (
          !g ||
          typeof g !== 'object' ||
          typeof g.unicode !== 'string' ||
          !g.unicode ||
          typeof g.fontChar !== 'string' ||
          !g.fontChar ||
          !Number.isFinite(g.width) ||
          g.width <= 0 ||
          !Number.isInteger(g.originalCharCode) ||
          g.isInFont !== true ||
          g.accent != null ||
          g.operatorListId != null ||
          g.vmetric != null
        )
          return
        literal += g.unicode
      }
      continue
    }
    // No paths, clips, forms, groups, blend/alpha, invisible text, shading,
    // rotated/reflected transforms, Type3 programs or unknown operations.
    return
  }
  if (
    text ||
    saved.length ||
    !images.length ||
    new Set(images.map((i) => i.id)).size !== images.length
  )
    return
  return { images, literal: literal.replace(/\s/gu, '') }
}

export function nativeCaptionedKeyedRasterTriple(
  page,
  caption,
  captions,
  tables,
  tokens,
  operatorContext,
  existingOwnedRect
) {
  const finiteRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const contains = (a, b, e = 1e-8) =>
    finiteRect(a) &&
    finiteRect(b) &&
    b[0] >= a[0] - e &&
    b[1] >= a[1] - e &&
    b[2] <= a[2] + e &&
    b[3] <= a[3] + e
  const overlap = (a, b) =>
    finiteRect(a) &&
    finiteRect(b) &&
    Math.min(a[2], b[2]) > Math.max(a[0], b[0]) &&
    Math.min(a[3], b[3]) > Math.max(a[1], b[1])
  const compact = (s) => s.replace(/\s/gu, '')
  if (
    !page ||
    !Number.isInteger(page.pageNumber) ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !Array.isArray(tokens) ||
    !tokens.length ||
    caption?.page !== page.pageNumber ||
    !finiteRect(caption.rect) ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    !caption.lines.every((l) => typeof l === 'string' && l) ||
    !/^(?:Figure|Fig\.)\s+\d+[.:]/u.test(caption.lines[0]) ||
    captions.filter((c) => c === caption).length !== 1
  )
    return
  if (
    tokens.some((t) => !t || typeof t.text !== 'string' || !finiteRect(t.rect)) ||
    page.lines.some(
      (l) =>
        !l ||
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        !finiteRect(lineRect(l))
    ) ||
    captions.some(
      (c) =>
        !c ||
        !Number.isInteger(c.page) ||
        !finiteRect(c.rect) ||
        !Array.isArray(c.lines) ||
        !c.lines.every((l) => typeof l === 'string')
    ) ||
    tables.some((t) => !finiteRect(t))
  )
    return
  const samePage = captions.filter((c) => c.page === page.pageNumber)
  if (
    samePage.filter((c) => c.lines[0] === caption.lines[0]).length !== 1 ||
    samePage.some((c) => c !== caption && overlap(c.rect, caption.rect))
  )
    return
  const rawProfile = nativeKeyedRasterTextProfile(operatorContext, page)
  if (!rawProfile) return
  const images = page.graphicsBounds.map((g) => {
    if (
      !g ||
      g.kind !== 'image' ||
      typeof g.imageHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(g.imageHash) ||
      !finiteRect(g.normalizedRect) ||
      !finiteRect(g.paintedNormalizedRect) ||
      g.normalizedRect[0] < 0 ||
      g.normalizedRect[1] < 0 ||
      g.normalizedRect[2] > 1 ||
      g.normalizedRect[3] > 1 ||
      !contains(g.normalizedRect, g.paintedNormalizedRect)
    )
      return
    return {
      graphic: g,
      source: g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)),
      paint: g.paintedNormalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
    }
  })
  if (
    images.some((i) => !i) ||
    images.length !== rawProfile.images.length ||
    new Set(images.map((i) => i.graphic.imageHash)).size !== images.length
  )
    return
  const operationBindings = images.map((image) =>
    rawProfile.images.filter(
      (op) => contains(image.source, op.rect, 0.01) && contains(op.rect, image.paint, 0.01)
    )
  )
  if (
    operationBindings.some((b) => b.length !== 1) ||
    new Set(operationBindings.map((b) => b[0].id)).size !== images.length
  )
    return
  const captionFonts = tokens.filter((t) => t.text.trim() && overlap(t.rect, caption.rect))
  if (
    !captionFonts.length ||
    captionFonts.some((t) => !contains(caption.rect, t.rect)) ||
    compact(captionFonts.map((t) => t.text).join('')) !== compact(caption.lines.join(''))
  )
    return
  const captionRows = page.lines.filter((l) => overlap(lineRect(l), caption.rect))
  if (compact(captionRows.map((l) => l.text).join('')) !== compact(caption.lines.join(''))) return
  const em = captionFonts.reduce((maximum, token) => Math.max(maximum, token.height), 0)
  if (
    !Number.isFinite(em) ||
    em <= 0 ||
    captionFonts.some(
      (t) =>
        !t.horizontal ||
        ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
        t.height <= 0 ||
        t.fontDescent > 0 ||
        t.fontDescent < -1 ||
        Math.abs(t.height - (t.rect[3] - t.rect[1])) > 0.01 ||
        Math.abs(t.baseline - t.rect[3]) > 0.01
    )
  )
    return
  const previous = samePage
    .filter((c) => c !== caption && c.rect[3] < caption.rect[1])
    .sort((a, b) => b.rect[3] - a.rect[3])[0]
  const lowerBound = previous?.rect[3] ?? 0
  const row = images
    .filter((i) => i.source[1] >= lowerBound && i.source[3] < caption.rect[1])
    .sort((a, b) => a.source[0] - b.source[0])
  if (row.length !== 3) return
  const painted = union(row.map((i) => i.paint)),
    rawBounds = union(row.map((i) => i.source))
  if (existingOwnedRect != null && !finiteRect(existingOwnedRect)) return
  const first = row[0].paint,
    width = (r) => r[2] - r[0],
    height = (r) => r[3] - r[1]
  if (
    row.some(
      (i, n) =>
        width(i.paint) < em * 8 ||
        height(i.paint) < em * 6 ||
        Math.abs(i.paint[1] - first[1]) > em * 1.5 ||
        Math.abs(i.paint[3] - first[3]) > em * 0.5 ||
        width(i.paint) / width(first) < 0.8 ||
        width(i.paint) / width(first) > 1.25 ||
        height(i.paint) / height(first) < 0.8 ||
        height(i.paint) / height(first) > 1.25 ||
        (n > 0 &&
          (i.source[0] <= row[n - 1].source[2] || i.paint[0] - row[n - 1].paint[2] > em * 4))
    ) ||
    caption.rect[1] - painted[3] > em * 4 ||
    !contains([rawBounds[0], 0, rawBounds[2], page.height], caption.rect) ||
    Math.abs((caption.rect[0] + caption.rect[2] - rawBounds[0] - rawBounds[2]) / 2) > em
  )
    return
  const window = [rawBounds[0], painted[1], rawBounds[2], caption.rect[1]]
  if (
    tables.some((t) => overlap(t, window)) ||
    samePage.some((c) => c !== caption && overlap(c.rect, window))
  )
    return
  const labels = tokens.filter(
    (t) => !captionFonts.includes(t) && t.text.trim() && overlap(t.rect, window)
  )
  if (
    !labels.length ||
    labels.some(
      (t) =>
        !contains(window, t.rect) ||
        !t.horizontal ||
        ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
        t.height <= 0 ||
        t.fontDescent < -1 ||
        t.fontDescent > 0 ||
        Math.abs(t.height - (t.rect[3] - t.rect[1])) > 0.01 ||
        Math.abs(t.baseline - t.rect[3]) > 0.01 ||
        t.baseline - t.fontDescent * t.height >= caption.rect[1] - 0.5
    )
  )
    return
  const groupFonts = row.map((i) =>
    labels.filter((t) => contains([i.source[0], painted[3], i.source[2], caption.rect[1]], t.rect))
  )
  if (
    groupFonts.flat().length !== labels.length ||
    labels.some((t) => groupFonts.filter((group) => group.includes(t)).length !== 1)
  )
    return
  const keys = 'abc'
  for (let i = 0; i < 3; i++) {
    const fonts = groupFonts[i],
      markers = fonts.filter((t) => /^\([abc]\)(?:\s|$)/u.test(t.text))
    if (markers.length !== 1 || markers[0].text[1] !== keys[i]) return
    const normalHeight = markers[0].height,
      firstBase = markers[0].baseline
    if (
      normalHeight < em * 0.8 ||
      normalHeight > em ||
      Math.abs(firstBase - groupFonts[0].find((t) => /^\(a\)/u.test(t.text))?.baseline) > 0.01
    )
      return
    const ordinary = fonts.filter((t) => Math.abs(t.height - normalHeight) <= 0.01),
      small = fonts.filter((t) => !ordinary.includes(t))
    const baselines = [...new Set(ordinary.map((t) => Math.round(t.baseline * 1000) / 1000))].sort(
      (a, b) => a - b
    )
    if (
      baselines.length < 1 ||
      baselines.length > 2 ||
      Math.abs(baselines[0] - firstBase) > 0.01 ||
      (baselines.length === 2 &&
        (baselines[1] - baselines[0] < normalHeight * 1.05 ||
          baselines[1] - baselines[0] > normalHeight * 1.35)) ||
      firstBase - normalHeight - row[i].paint[3] < 0 ||
      firstBase - normalHeight - row[i].paint[3] > normalHeight * 1.5
    )
      return
    for (const base of baselines) {
      const line = ordinary
        .filter((t) => Math.abs(t.baseline - base) <= 0.01)
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !line.length ||
        Math.abs(line[0].rect[0] - markers[0].rect[0]) > 0.05 ||
        line.some(
          (t, n) =>
            n > 0 &&
            (t.rect[0] - line[n - 1].rect[2] > normalHeight * 0.9 ||
              t.rect[0] < line[n - 1].rect[2] - 0.01)
        )
      )
        return
    }
    for (const child of small) {
      if (
        !/^\d{1,2}$/u.test(child.text) ||
        child.height < normalHeight * 0.6 ||
        child.height > normalHeight * 0.75 ||
        child.baseline >= firstBase - normalHeight * 0.25 ||
        child.baseline < firstBase - normalHeight * 0.55 ||
        ordinary.filter(
          (p) =>
            /^\p{L}+$/u.test(p.text) &&
            p.baseline === firstBase &&
            child.rect[0] >= p.rect[2] - 0.01 &&
            child.rect[0] - p.rect[2] <= normalHeight * 0.1
        ).length !== 1
      )
        return
    }
    const literal = compact(fonts.map((t) => t.text).join(''))
    if (literal.length < 12 || literal.length > 140 || !rawProfile.literal.includes(literal)) return
  }
  const sourceRows = page.lines.filter((l) => overlap(lineRect(l), window))
  const membership = labels.map(
    (t) => sourceRows.filter((l) => contains(lineRect(l), t.rect)).length
  )
  if (
    membership.some((n) => n !== 1) ||
    sourceRows.some(
      (l) =>
        compact(
          labels
            .filter((t) => contains(lineRect(l), t.rect))
            .map((t) => t.text)
            .join('')
        ) !== compact(l.text)
    )
  )
    return
  const rect = union([
    painted,
    ...labels.map((t) => t.rect),
    ...(existingOwnedRect ? [existingOwnedRect] : [])
  ])
  rect[3] = Math.max(rect[3], ...labels.map((t) => t.baseline - t.fontDescent * t.height))
  if (
    rect[3] >= caption.rect[1] - 0.5 ||
    !contains(window, rect) ||
    samePage.some((c) => c !== caption && overlap(c.rect, rect)) ||
    tables.some((t) => overlap(t, rect)) ||
    images.some((i) => overlap(i.paint, rect) && !row.includes(i)) ||
    tokens.some((t) => overlap(t.rect, rect) && !labels.includes(t)) ||
    sourceRows.some((l) => !contains(rect, lineRect(l)))
  )
    return
  // A complete owner contains the measured rasters and every proved title's
  // full font descent. Existing owners with only the image extent may still
  // need the same uniquely captioned native title rows completed.
  if (existingOwnedRect && contains(existingOwnedRect, rect)) return
  return { caption, rect, graphicsCount: 3 }
}

// Complete the painted perimeter of a native annotation already wholly owned
// by a figure. Its independent closed frame supplies the edge evidence; the
// matching source path only identifies that frame's existing painted carrier.
export function nativeOwnedAnnotationFrame(
  page,
  figure,
  captions,
  tables,
  frames,
  tokens,
  foreignOwns = () => false
) {
  const rect = figure.rect,
    caption = figure.caption
  if (
    caption?.page !== page.pageNumber ||
    !rect?.every(Number.isFinite) ||
    !(area(rect) > 0) ||
    !caption.rect?.every(Number.isFinite)
  )
    return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const epsilon = 1e-8,
    tile = [page.width / 128, page.height / 128],
    enclosures = frames.filter(
      (frame) =>
        frame?.length === 4 &&
        frame.every(Number.isFinite) &&
        frame[0] >= rect[0] &&
        frame[1] >= rect[1] &&
        frame[2] <= rect[2] &&
        frame[3] > rect[3] &&
        frame[3] - rect[3] <= font * 2 &&
        frame[3] < caption.rect[1] &&
        frame[2] - frame[0] >= font * 8 &&
        frame[3] - frame[1] >= font * 3 &&
        frame[3] - frame[1] <= font * 8 &&
        intersection(frame, rect) / area(frame) > 0.8
    )
  if (enclosures.length !== 1) return
  const frame = enclosures[0],
    strip = [frame[0], rect[3], frame[2], frame[3]],
    rows = (page.lines ?? []).filter(
      (line) => line.text?.trim() && intersection(lineRect(line), frame) > 0
    ),
    native = tokens.filter((token) => intersection(token.rect ?? [], frame) > 0)
  if (
    blocked(frame, caption, captions, tables) ||
    foreignOwns(frame) ||
    rows.length < 3 ||
    rows.some(
      (line) =>
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        line.fontSize < font * 0.5 ||
        line.fontSize > font * 0.95 ||
        line.text.trim().length < 12 ||
        !contains(frame, lineRect(line), epsilon) ||
        !contains(rect, lineRect(line), epsilon) ||
        !native.some((token) => intersection(token.rect, lineRect(line)) / area(token.rect) > 0.8)
    ) ||
    new Set(rows.map((line) => Math.round(line.y / (font * 0.5)))).size < 3 ||
    Math.max(...rows.map((line) => line.x)) - Math.min(...rows.map((line) => line.x)) > font ||
    !native.length ||
    native.some(
      (token) =>
        !token.horizontal ||
        token.rect?.length !== 4 ||
        ![...token.rect, token.baseline, token.height, token.fontDescent].every(Number.isFinite) ||
        token.height <= 0 ||
        token.fontDescent < -1 ||
        token.fontDescent > 0 ||
        Math.abs(token.baseline - token.rect[3]) > 0.01 ||
        !contains(rect, token.rect, epsilon) ||
        !contains(frame, token.rect, epsilon) ||
        token.baseline - token.fontDescent * token.height > frame[3]
    )
  )
    return
  const paths = (page.graphicsBounds ?? [])
      .filter((graphic) => graphic.kind === 'path')
      .map((graphic) => {
        const bounds = graphic.paintedNormalizedRect ?? graphic.normalizedRect
        return bounds?.length === 4 && bounds.every(Number.isFinite)
          ? bounds.map((v, i) => v * (i % 2 ? page.height : page.width))
          : undefined
      })
      .filter(Boolean),
    carriers = paths.filter(
      (bounds) =>
        contains(bounds, frame, epsilon) &&
        bounds.every((value, i) => Math.abs(value - frame[i]) <= tile[i % 2])
    )
  if (
    carriers.length !== 1 ||
    paths.some((bounds) => bounds !== carriers[0] && intersection(bounds, strip) > 0) ||
    (page.graphicsBounds ?? []).some((graphic) => {
      if (graphic.kind !== 'image') return false
      const bounds = graphic.paintedNormalizedRect ?? graphic.normalizedRect
      return (
        bounds?.length === 4 &&
        intersection(
          bounds.map((v, i) => v * (i % 2 ? page.height : page.width)),
          strip
        ) > 0
      )
    })
  )
    return
  return union([rect, frame])
}

// Two independently hashed source images can share one caption even when one
// operation has no painted-ink observation. Their recorded image bounds still
// prove its complete footprint; quantized source boxes may overlap by one tile.
export function nativeCaptionedAlignedRasterPair(
  page,
  caption,
  captions,
  tables,
  ownedRects = [],
  nativeTokens = [],
  closedFrames = []
) {
  if (
    caption?.page !== page.pageNumber ||
    !Array.isArray(caption.lines) ||
    !/^(?:figure|fig\.?)[ \t]+/i.test(caption.lines[0] ?? '') ||
    caption.rect?.length !== 4 ||
    !caption.rect.every(Number.isFinite)
  )
    return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => {
      const source = g.paintedNormalizedRect ?? g.normalizedRect
      if (
        g.normalizedRect?.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        g.normalizedRect[0] < 0 ||
        g.normalizedRect[1] < 0 ||
        g.normalizedRect[2] > 1 ||
        g.normalizedRect[3] > 1 ||
        g.normalizedRect[2] <= g.normalizedRect[0] ||
        g.normalizedRect[3] <= g.normalizedRect[1] ||
        source?.length !== 4 ||
        !source.every(Number.isFinite) ||
        source[0] < 0 ||
        source[1] < 0 ||
        source[2] > 1 ||
        source[3] > 1 ||
        source[2] <= source[0] ||
        source[3] <= source[1] ||
        !contains(g.normalizedRect, source)
      )
        return
      return {
        hash: g.imageHash,
        raw: g.normalizedRect,
        painted: !!g.paintedNormalizedRect,
        rect: source.map((v, i) => v * (i % 2 ? page.height : page.width))
      }
    })
    .filter(
      (image) =>
        image &&
        image.rect[2] - image.rect[0] >= font * 8 &&
        image.rect[3] - image.rect[1] >= font * 6 &&
        image.rect[3] <= caption.rect[1] + (image.painted ? 0 : page.height / 128) &&
        caption.rect[1] - image.rect[3] <= page.height * 0.7 &&
        !ownedRects.some((r) => intersection(r, image.rect) / area(image.rect) > 0.1)
    )
  const titledRow = nativeTitledRasterRow(
    page,
    caption,
    captions,
    tables,
    images,
    nativeTokens,
    font,
    closedFrames
  )
  if (titledRow) return titledRow
  const keyedRow = nativeLowerKeyedRasterRow(
    page,
    caption,
    captions,
    tables,
    images,
    nativeTokens,
    font
  )
  if (keyedRow) return keyedRow
  const completeRows = nativeCompletePaintedRasterRows(page, caption, captions, tables, ownedRects)
  if (completeRows) return completeRows
  if (images.length !== 2 || images[0].hash === images[1].hash) return
  const bounds = union(images.map((g) => g.rect))
  const [first, second] = images.map((g) => g.rect).sort((a, b) => a[0] - b[0])
  const width = (r) => r[2] - r[0],
    height = (r) => r[3] - r[1]
  const comparable = (a, b) => a / b >= 0.65 && a / b <= 1.55
  const tolerance = Math.max(font, page.width / 128)
  const horizontal =
    comparable(width(first), width(second)) &&
    comparable(height(first), height(second)) &&
    Math.abs(first[1] - second[1]) <= font * 2 &&
    Math.abs(first[3] - second[3]) <= font * 2 &&
    second[0] - first[2] >= -page.width / 128 &&
    second[0] - first[2] <= font * 3
  if (bounds[3] > caption.rect[1]) {
    if (
      !horizontal ||
      !images.some((g) => g.painted) ||
      !images.every((g) => g.raw?.length === 4 && g.raw.every(Number.isFinite)) ||
      Math.abs(images[0].raw[1] - images[1].raw[1]) * page.height > font * 2 ||
      Math.abs(images[0].raw[3] - images[1].raw[3]) > 1 / 256
    )
      return
    // Dependency boxes include quantization padding. Only an exactly aligned
    // source row with an independent painted sibling can stop at its caption.
    bounds[3] = caption.rect[1] - 0.5
  }
  const [top, bottom] = images.map((g) => g.rect).sort((a, b) => a[1] - b[1])
  const centeredInset =
    Math.abs((top[0] + top[2] - bottom[0] - bottom[2]) / 2) <= tolerance &&
    (contains([top[0], 0, top[2], page.height], bottom, tolerance) ||
      contains([bottom[0], 0, bottom[2], page.height], top, tolerance))
  const vertical =
    /\([a\u0430]\)/i.test(caption.lines.join(' ')) &&
    /\(b\)/i.test(caption.lines.join(' ')) &&
    (comparable(width(top), width(bottom)) || centeredInset) &&
    comparable(height(top), height(bottom)) &&
    ((Math.abs(top[0] - bottom[0]) <= tolerance && Math.abs(top[2] - bottom[2]) <= tolerance) ||
      centeredInset) &&
    bottom[1] - top[3] >= -page.height / 128 &&
    bottom[1] - top[3] <= font * 3
  if (!horizontal && !vertical) return
  const gap = caption.rect[1] - bounds[3]
  const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
  if (
    gap < 0 ||
    gap > font * 3 ||
    overlap < Math.min(width(bounds), width(caption.rect)) * 0.9 ||
    Math.abs((bounds[0] + bounds[2] - caption.rect[0] - caption.rect[2]) / 2) > font * 2 ||
    blocked(bounds, caption, captions, tables)
  )
    return
  const corridor = [
    Math.min(bounds[0], caption.rect[0]),
    bounds[3],
    Math.max(bounds[2], caption.rect[2]),
    caption.rect[1]
  ]
  if (
    blocked(corridor, caption, captions, tables) ||
    (page.lines ?? []).some((line) => {
      if (!line.text?.trim() || intersection(lineRect(line), caption.rect) > 0) return false
      const rect = lineRect(line)
      return (
        intersection(rect, corridor) > 0 ||
        (intersection(rect, bounds) > 0 &&
          !images.some((g) => intersection(rect, g.rect) / area(rect) > 0.9))
      )
    })
  )
    return
  const excludedProseLines = (page.lines ?? []).filter(
    (line) =>
      line.text.trim().length >= 20 &&
      line.y + line.height <= bounds[1] &&
      bounds[1] - line.y - line.height <= font * 2 &&
      line.x < bounds[2] &&
      line.x + line.width > bounds[0]
  )
  return {
    caption,
    rect: bounds,
    graphicsCount: 2,
    reason: 'native-aligned-raster-pair',
    ...(excludedProseLines.length ? { excludedProseLines } : {})
  }
}

// Two whole decoded painted images can form one unkeyed vertical plate. Native
// text must independently match its sole caption and leave the entire plate
// corridor empty; nominal image boxes cannot supply missing painted evidence.
function nativeCompletePaintedRasterRows(page, caption, captions, tables, ownedRects) {
  const finite = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  if (
    !page ||
    ![page.width, page.height].every(Number.isFinite) ||
    !(page.width > 0 && page.height > 0) ||
    page.rotation !== 0 ||
    page.renderRotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    page.graphicsBounds.length !== 2 ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !Array.isArray(ownedRects) ||
    caption?.page !== page.pageNumber ||
    !finite(caption.rect) ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    caption.lines.some((text) => typeof text !== 'string') ||
    captionKind(caption.lines[0]) !== 'figure'
  )
    return
  const own = captions.filter((candidate) => candidate?.page === page.pageNumber)
  if (
    own.length !== 1 ||
    own[0] !== caption ||
    tables.some((rect) => !finite(rect)) ||
    ownedRects.some((rect) => !finite(rect)) ||
    page.lines.some(
      (line) =>
        !line ||
        typeof line.text !== 'string' ||
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        line.width <= 0 ||
        line.height <= 0 ||
        line.fontSize <= 0
    )
  )
    return
  const source = groupPageLines(page)
  const rows = caption.lines.map((text) =>
    source.filter(
      (line) =>
        line.text === text &&
        contains(caption.rect, [line.x, line.y, line.right, line.bottom], 1e-8)
    )
  )
  if (rows.some((row) => row.length !== 1)) return
  // Every intersecting canonical source row must belong to this exact native
  // caption, including smaller independent rows wholly inside its bounds.
  const captionRows = new Set(rows.flat())
  if (
    source.some(
      (line) =>
        line.text.trim() &&
        intersection([line.x, line.y, line.right, line.bottom], caption.rect) > 0 &&
        !captionRows.has(line)
    )
  )
    return
  const font = Math.max(...rows.map((row) => row[0].fontSize))
  if (
    !(font > 0) ||
    rows.some((row) => Math.abs(row[0].fontSize - font) > font * 0.015) ||
    page.lines.some(
      (line) =>
        intersection(lineRect(line), caption.rect) > 0 &&
        (line.height < line.fontSize - 0.02 || !contains(caption.rect, lineRect(line), 1e-8))
    )
  )
    return
  const images = page.graphicsBounds.map((graphic) => {
    if (
      !graphic ||
      graphic.kind !== 'image' ||
      !/^[a-f0-9]{64}$/u.test(graphic.imageHash ?? '') ||
      !finite(graphic.normalizedRect) ||
      !finite(graphic.paintedNormalizedRect) ||
      !contains([0, 0, 1, 1], graphic.normalizedRect) ||
      !contains(graphic.normalizedRect, graphic.paintedNormalizedRect, 1e-8)
    )
      return
    return {
      hash: graphic.imageHash,
      rect: graphic.paintedNormalizedRect.map(
        (value, i) => value * (i % 2 ? page.height : page.width)
      )
    }
  })
  if (images.some((image) => !image) || images[0].hash === images[1].hash) return
  images.sort((a, b) => a.rect[1] - b.rect[1])
  const top = images[0].rect,
    bottom = images[1].rect,
    bounds = union([top, bottom]),
    gap = bottom[1] - top[3],
    width = top[2] - top[0],
    height = top[3] - top[1]
  if (
    width < font * 12 ||
    height < font * 6 ||
    Math.abs(bottom[3] - bottom[1] - height) > height * 0.25 ||
    Math.abs(bottom[0] - top[0]) > font * 0.25 ||
    Math.abs(bottom[2] - top[2]) > font * 0.25 ||
    gap < font * 0.2 ||
    gap > font * 3 ||
    bounds[3] - bounds[1] > page.height * 0.7 ||
    bounds[0] < caption.rect[0] ||
    bounds[2] > caption.rect[2] ||
    Math.abs((bounds[0] + bounds[2] - caption.rect[0] - caption.rect[2]) / 2) > font ||
    caption.rect[1] - bounds[3] < font * 0.2 ||
    caption.rect[1] - bounds[3] > font * 3 ||
    ownedRects.some((rect) => intersection(rect, bounds) > 0)
  )
    return
  const corridor = [
    Math.min(bounds[0], caption.rect[0]),
    bounds[1],
    Math.max(bounds[2], caption.rect[2]),
    caption.rect[1]
  ]
  if (
    blocked(corridor, caption, captions, tables) ||
    page.lines.some((line) => line.text.trim() && intersection(lineRect(line), corridor) > 0)
  )
    return
  return {
    caption,
    rect: bounds,
    graphicsCount: 2,
    reason: 'native-complete-painted-raster-rows'
  }
}

// A short centered caption can own a wider raster pair when each complete
// lower title independently names its panel. This does not relax the ordinary
// unkeyed-pair gap or caption-overlap rule. An exact three-key row also admits
// a terminal title period, with tighter inter-image gaps and complete paint.
function nativeLowerKeyedRasterRow(page, caption, captions, tables, images, tokens, font) {
  if (
    page.invalidGraphicsBounds > 0 ||
    ![2, 3].includes(images.length) ||
    !images.every((g) => g.painted) ||
    new Set(images.map((g) => g.hash)).size !== images.length
  )
    return
  const row = [...images].sort((a, b) => a.rect[0] - b.rect[0]),
    keysForRow = row.length === 3 ? 'abc' : 'ab',
    anchor = row[0].rect,
    bounds = union(row.map((g) => g.rect)),
    width = (r) => r[2] - r[0],
    height = (r) => r[3] - r[1],
    epsilon = 1e-8,
    lane = [bounds[0], bounds[1], bounds[2], caption.rect[1]]
  if (
    row.some(({ rect: r }, n) => {
      if (!n) return false
      const prior = row[n - 1].rect
      return (
        Math.abs(anchor[1] - r[1]) > font ||
        Math.abs(anchor[3] - r[3]) > font ||
        width(anchor) / width(r) < 0.8 ||
        width(anchor) / width(r) > 1.25 ||
        height(anchor) / height(r) < 0.8 ||
        height(anchor) / height(r) > 1.25 ||
        r[0] - prior[2] <= 0 ||
        r[0] - prior[2] > (row.length === 3 ? font * 3 : Math.min(width(prior), width(r)))
      )
    }) ||
    caption.rect[1] - bounds[3] < 0 ||
    caption.rect[1] - bounds[3] > font * 4 ||
    !contains([bounds[0], 0, bounds[2], page.height], caption.rect) ||
    Math.abs((bounds[0] + bounds[2] - caption.rect[0] - caption.rect[2]) / 2) > font ||
    blocked(lane, caption, captions, tables)
  )
    return
  const lower = tokens.filter(
      (t) =>
        t.rect?.length === 4 &&
        intersection(t.rect, [bounds[0], bounds[3], bounds[2], caption.rect[1]]) > 0
    ),
    keys = lower.filter((t) =>
      (row.length === 3 ? /^\([abc]\)(?:\s|$)/ : /^\([ab]\)(?:\s|$)/).test(t.text?.trim() ?? '')
    )
  if (keys.length !== row.length) return
  const groups = row.map((image, n) => {
    const key = keys.find((t) => t.text.trim()[1] === keysForRow[n])
    if (!key || !contains([image.rect[0], bounds[3], image.rect[2], caption.rect[1]], key.rect))
      return
    return lower
      .filter((t) => contains([image.rect[0], bounds[3], image.rect[2], caption.rect[1]], t.rect))
      .sort((x, y) => x.rect[0] - y.rect[0])
  })
  if (groups.some((g) => !g?.length)) return
  const labels = groups.flat()
  if (
    lower.some((t) => !labels.includes(t)) ||
    groups.some((g, n) => {
      const r = union(g.map((t) => t.rect)),
        key = g[0],
        title = g
          .map((t) => t.text)
          .join('')
          .trim()
      return (
        key.text.trim()[1] !== keysForRow[n] ||
        title.length < 5 ||
        title.length > 90 ||
        !(
          row.length === 3
            ? /^\([abc]\)\s+\p{L}[\p{L}\p{M}\p{Sk}\p{N}\s,()+−\-–]*\.$/u
            : /^\([ab]\)\s+\p{L}[\p{L}\p{M}\p{Sk}\p{N}\s,()+−\-–]*$/u
        ).test(title) ||
        r[1] - row[n].rect[3] > font * 2 ||
        caption.rect[1] - r[3] > font * 2 ||
        Math.abs((r[0] + r[2] - row[n].rect[0] - row[n].rect[2]) / 2) > font * 2 ||
        g.some(
          (t, i) =>
            !t.horizontal ||
            ![...t.rect, t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
            t.height < font * 0.5 ||
            t.height > font ||
            t.fontDescent < -1 ||
            t.fontDescent > 0 ||
            Math.abs(t.rect[3] - t.baseline) > 0.01 ||
            Math.abs(t.rect[3] - t.rect[1] - t.height) > 0.01 ||
            Math.abs(t.height - labels[0].height) > 0.05 ||
            Math.abs(t.baseline - labels[0].baseline) > 0.01 ||
            t.baseline - t.fontDescent * t.height >= caption.rect[1] - 0.5 ||
            (i > 0 && t.rect[0] - g[i - 1].rect[2] > t.height * 0.6)
        )
      )
    })
  )
    return
  const normalized = (text) => text.replace(/\s+/g, ''),
    rect = union([bounds, ...labels.map((t) => t.rect)])
  if (
    tokens.some(
      (t) =>
        t.rect?.length === 4 &&
        intersection(t.rect, lane) > 0 &&
        !labels.includes(t) &&
        !row.some((g) => contains(g.rect, t.rect, epsilon))
    ) ||
    page.lines.some((line) => {
      const r = lineRect(line)
      if (intersection(r, lane) <= 0 || row.some((g) => contains(g.rect, r, epsilon))) return false
      const native = labels.filter((t) => intersection(t.rect, r) / area(t.rect) > 0.995)
      return (
        !native.length ||
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        Math.abs(line.fontSize - labels[0].height) > 0.05 ||
        !contains(rect, r, epsilon) ||
        normalized(native.map((t) => t.text).join('')) !== normalized(line.text)
      )
    }) ||
    (page.graphicsBounds ?? []).some((g) => {
      const source = g.paintedNormalizedRect ?? g.normalizedRect
      if (source?.length !== 4 || !source.every(Number.isFinite)) return true
      const r = source.map((v, i) => v * (i % 2 ? page.height : page.width))
      return intersection(r, lane) > 0 && !row.some((image) => contains(image.rect, r, epsilon))
    })
  )
    return
  return { caption, rect, graphicsCount: row.length, reason: 'native-aligned-raster-pair' }
}

function nativeTitledRasterRow(page, caption, captions, tables, images, tokens, font, frames) {
  const row = images
    .filter((g) => g.raw[1] * page.height >= captionLaneTop(caption, captions))
    .map((g) => ({ ...g, rect: g.raw.map((v, n) => v * (n % 2 ? page.height : page.width)) }))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (row.length < 2 || row.length > 3 || new Set(row.map((g) => g.hash)).size !== row.length)
    return
  const b = union(row.map((g) => g.rect)),
    anchor = row[0].rect
  if (
    caption.rect[1] - b[3] < 0 ||
    caption.rect[1] - b[3] > font * 4 ||
    Math.abs((b[0] + b[2] - caption.rect[0] - caption.rect[2]) / 2) > font * 2 ||
    row.some(
      (g, n) =>
        Math.abs(g.rect[1] - anchor[1]) > font * 2 ||
        Math.abs(g.rect[3] - anchor[3]) > font * 2 ||
        (g.rect[2] - g.rect[0]) / (anchor[2] - anchor[0]) < 0.65 ||
        (g.rect[2] - g.rect[0]) / (anchor[2] - anchor[0]) > 1.55 ||
        (n &&
          (g.rect[0] - row[n - 1].rect[2] < -page.width / 128 ||
            g.rect[0] - row[n - 1].rect[2] > font * 3))
    )
  )
    return
  const headings = page.lines.filter(
    (l) =>
      l.text.length >= 10 &&
      l.text.length <= 90 &&
      !/[.!?]$/.test(l.text.trim()) &&
      l.fontSize >= font * 0.9 &&
      l.fontSize <= font * 1.25 &&
      l.y >= captionLaneTop(caption, captions) &&
      l.y + l.height <= b[1] &&
      b[1] - l.y - l.height <= font * 3 &&
      l.x >= b[0] &&
      l.x + l.width <= b[2] &&
      Math.abs(l.x + l.width / 2 - (b[0] + b[2]) / 2) <= font * 2
  )
  if (headings.length !== 1) return
  const labels = tokens.filter(
    (t) =>
      t.horizontal &&
      t.rect?.every(Number.isFinite) &&
      t.height > 0 &&
      t.height <= font * 1.15 &&
      /^[\p{L}\p{N}\s.,+\-–()]+$/u.test(t.text) &&
      t.text.trim().length < 60 &&
      !/[.!?]$/.test(t.text.trim()) &&
      t.rect[1] >= b[3] - font * 0.5 &&
      t.rect[3] < caption.rect[1] &&
      row.filter((g) =>
        contains(
          [g.rect[0] - font * 0.5, b[3] - font * 0.5, g.rect[2] + font * 0.5, caption.rect[1]],
          t.rect
        )
      ).length === 1
  )
  if (
    row.some(
      (g) =>
        !labels.some(
          (t) =>
            /\p{L}/u.test(t.text) &&
            contains(
              [g.rect[0] - font * 0.5, b[3] - font * 0.5, g.rect[2] + font * 0.5, caption.rect[1]],
              t.rect
            )
        )
    )
  )
    return
  // Native closed painted edges can lie outside the quantized raster box.
  // Borrow only one close-fitting independent enclosure per already proved
  // panel. A whole-row box, competing frame or foreign glyph in the new strip
  // cannot establish that panel's ownership.
  const enclosures = row.map((image) => {
    const matches = frames.filter(
      (r) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] >= 0 &&
        r[1] >= captionLaneTop(caption, captions) &&
        r[2] <= page.width &&
        r[3] < caption.rect[1] &&
        contains(r, image.rect) &&
        area(image.rect) >= area(r) * 0.65 &&
        r.every((v, n) => Math.abs(v - image.rect[n]) <= font * 2) &&
        row.filter((other) => contains(r, other.rect)).length === 1
    )
    return matches.length === 1 ? matches[0] : undefined
  })
  let rect = union([b, lineRect(headings[0]), ...labels.map((t) => t.rect)])
  if (enclosures.every(Boolean)) {
    const expanded = union([rect, ...enclosures])
    if (
      !blocked(expanded, caption, captions, tables) &&
      !tokens.some(
        (t) =>
          t.rect?.every(Number.isFinite) &&
          area(t.rect) > 0 &&
          intersection(t.rect, expanded) > 0 &&
          intersection(t.rect, rect) / area(t.rect) < 0.95
      ) &&
      !graphics(page, 'image').some((r) => intersection(r, expanded) - intersection(r, rect) > 1e-8)
    )
      rect = expanded
  }
  const band = [rect[0], rect[1], rect[2], caption.rect[1]]
  if (blocked(band, caption, captions, tables)) return
  const normalized = (s) => s.replace(/\s+/g, '')
  if (
    page.lines.some((l) => {
      const r = lineRect(l)
      if (
        l === headings[0] ||
        intersection(r, band) <= 0 ||
        captions.some((c) => intersection(c.rect, r) > 0) ||
        row.some((g) => intersection(g.rect, r) / area(r) > 0.95)
      )
        return false
      const owned = labels.filter((t) => intersection(t.rect, r) / area(t.rect) > 0.95)
      return normalized(owned.map((t) => t.text).join('')) !== normalized(l.text)
    })
  )
    return
  return { caption, rect, graphicsCount: row.length, reason: 'native-aligned-raster-pair' }
}

// A detached page-top image is often a publisher logo. Include a small upper
// raster panel only when it continues the main plate directly, shares an edge
// or center, and has no independent text/caption/table between the panels.
const connectedUpperRasterPanel = (page, rect, caption, captions, tables, font) => {
  if ((page.marginRuleBounds ?? []).length) return
  const tolerance = Math.max(2, font * 0.5)
  const candidates = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image' && graphic.imageHash)
    .map((graphic) => graphic.paintedNormalizedRect ?? graphic.normalizedRect)
    .filter((source) => source?.length === 4 && source.every(Number.isFinite))
    .map((source) => source.map((value, index) => value * (index % 2 ? page.height : page.width)))
    .filter((candidate) => {
      const gap = rect[1] - candidate[3]
      const aligned =
        Math.abs(candidate[0] - rect[0]) <= tolerance ||
        Math.abs(candidate[2] - rect[2]) <= tolerance ||
        Math.abs((candidate[0] + candidate[2] - rect[0] - rect[2]) / 2) <= tolerance
      const contained = candidate[0] >= rect[0] - tolerance && candidate[2] <= rect[2] + tolerance
      // A typeset plate may have a slightly overhanging leading inset above
      // the main raster. Require a substantial panel, mostly within the main
      // lane, and at most three text heights of separation; interior or distant
      // page furniture still lacks that leading-edge continuity.
      const width = candidate[2] - candidate[0]
      const overlap = Math.min(candidate[2], rect[2]) - Math.max(candidate[0], rect[0])
      const leadingInset =
        candidate[0] < rect[0] &&
        rect[0] - candidate[0] <= font * 3 &&
        candidate[2] <= rect[2] &&
        width >= font * 12 &&
        candidate[3] - candidate[1] >= font * 3 &&
        overlap >= width * 0.75 &&
        gap <= font * 3
      const combined = union([rect, candidate])
      const corridor = [candidate[0], candidate[3], candidate[2], rect[1]]
      return (
        candidate[1] >= 0 &&
        candidate[1] < page.height * 0.08 &&
        candidate[2] - candidate[0] < page.width * 0.5 &&
        candidate[2] - candidate[0] >= font * 8 &&
        candidate[3] - candidate[1] >= font * 2 &&
        gap >= -font * 0.25 &&
        ((contained && aligned && gap <= Math.max(4, font * 1.5)) || leadingInset) &&
        !blocked(combined, caption, captions, tables) &&
        !(page.lines ?? []).some(
          (line) => line.text?.trim() && intersection(lineRect(line), corridor) > 0
        )
      )
    })
  if (candidates.length === 1) return candidates[0]
}

const captionLaneTop = (caption, captions) =>
  Math.max(
    0,
    ...captions
      .filter(
        (other) =>
          other !== caption &&
          other.page === caption.page &&
          other.rect[3] < caption.rect[1] &&
          Math.min(other.rect[2], caption.rect[2]) > Math.max(other.rect[0], caption.rect[0])
      )
      .map((other) => other.rect[3])
  )

const rasterRows = (rects, font) => {
  const rows = []
  for (const rect of rects.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const row = rows.find(
      (items) => Math.abs(items[0][1] - rect[1]) <= Math.max(font, (rect[3] - rect[1]) * 0.2)
    )
    if (row) row.push(rect)
    else rows.push([rect])
  }
  return rows.map((row) => row.sort((a, b) => a[0] - b[0]))
}

const withLabelInkTail = (rect, graphicBottom, caption, font) =>
  rect[3] > graphicBottom
    ? [
        rect[0],
        rect[1],
        rect[2],
        rect[3] + Math.max(0, Math.min(font * 0.25, caption.rect[1] - rect[3] - 1))
      ]
    : rect

// Closed native frames prove the two-over-one layout independently of the
// model's lower-panel detection. At least one substantial real raster must
// anchor the frame grid; ordinary text boxes and open plots do not qualify.
export function nativeCaptionedRasterFrameBands(page, caption, captions, tables, frames = []) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  // Rounded native form plates are not four-corner closePath frames. Their
  // painted form extent and independent enclosing path must agree before
  // they can supply the same bounded-panel evidence.
  const paths = graphics(page, 'path')
  const formFrames = (page.graphicsBounds ?? [])
    .filter(
      (g) =>
        g.kind === 'image' &&
        g.paintedNormalizedRect?.length === 4 &&
        g.paintedNormalizedRect.every(Number.isFinite)
    )
    .map((g) => g.paintedNormalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .flatMap((form) =>
      paths.filter((path) => path.every((v, i) => Math.abs(v - form[i]) <= font * 0.5))
    )
  const eligible = [...frames, ...formFrames].filter(
    (r) =>
      r?.length === 4 &&
      r.every(Number.isFinite) &&
      r[1] >= top &&
      r[3] < caption.rect[1] &&
      r[2] - r[0] >= font * 8 &&
      r[3] - r[1] >= font * 4
  )
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => g.paintedNormalizedRect ?? g.normalizedRect)
    .filter((r) => r?.length === 4 && r.every(Number.isFinite))
    .map((r) => r.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const proofs = []
  for (const lower of eligible) {
    if (caption.rect[1] - lower[3] > font * 3) continue
    const upper = eligible
      .filter(
        (r) =>
          r !== lower &&
          r[3] <= lower[1] + font * 0.5 &&
          lower[1] - r[3] <= font &&
          r[0] >= lower[0] - font * 0.5 &&
          r[2] <= lower[2] + font * 0.5
      )
      .sort((a, b) => a[0] - b[0])
    if (
      upper.length !== 2 ||
      Math.abs(upper[0][1] - upper[1][1]) > font * 0.5 ||
      Math.abs(upper[0][3] - upper[1][3]) > font * 0.5 ||
      Math.abs(upper[0][0] - lower[0]) > font * 0.5 ||
      Math.abs(upper[1][2] - lower[2]) > font * 0.5 ||
      Math.abs(upper[1][0] - upper[0][2]) > font ||
      !images.some((image) =>
        upper.some(
          (frame) => contains(frame, image, font * 0.5) && area(image) >= area(frame) * 0.25
        )
      )
    )
      continue
    const bounds = union([lower, ...upper])
    if (blocked(bounds, caption, captions, tables)) continue
    const labels = (page.lines ?? []).filter((l) => intersection(lineRect(l), bounds) > 0)
    if (
      labels.some(
        (l) =>
          !contains(bounds, lineRect(l), font * 0.5) ||
          l.fontSize > font * 1.5 ||
          (l.text.trim().length > 110 && /[.!?]$/.test(l.text.trim()))
      )
    )
      continue
    // Text in a gap between frames is an independent ownership barrier.
    // Native line grouping can join two same-baseline panel titles across the
    // upper pair. Their shared row still owns the complete short label.
    if (
      labels.some((l) => ![lower, union(upper)].some((r) => contains(r, lineRect(l), font * 0.5)))
    )
      continue
    proofs.push({ caption, rect: bounds, graphicsCount: 3, reason: 'native-raster-frame-bands' })
  }
  if (proofs.length === 1) return proofs[0]
  // Three repeated native enclosures can each contain a small raster and an
  // independently painted wide comparison. The closed frames, complete titles
  // and six distinct source rasters establish the stack independently of the
  // model's single lower-band detection.
  const stack = frames.filter((frame) => eligible.includes(frame)).sort((a, b) => a[1] - b[1])
  if (caption.page !== page.pageNumber || stack.length !== 3) return
  const first = stack[0],
    bounds = union(stack),
    epsilon = 1e-8
  if (
    caption.rect[1] - bounds[3] > font * 3 ||
    Math.abs((bounds[0] + bounds[2] - caption.rect[0] - caption.rect[2]) / 2) > font ||
    bounds[0] < caption.rect[0] - font ||
    bounds[2] > caption.rect[2] + font ||
    blocked(bounds, caption, captions, tables) ||
    frames.some((frame) => !stack.includes(frame) && intersection(frame, bounds) > 0) ||
    stack.some(
      (frame, n) =>
        Math.abs(frame[0] - first[0]) > font * 0.1 ||
        Math.abs(frame[2] - first[2]) > font * 0.1 ||
        Math.abs(frame[3] - frame[1] - first[3] + first[1]) > font * 0.1 ||
        (n > 0 && (frame[1] < stack[n - 1][3] || frame[1] - stack[n - 1][3] > font))
    )
  )
    return
  const painted = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image' && graphic.imageHash)
    .map((graphic) => ({
      hash: graphic.imageHash,
      rect:
        graphic.paintedNormalizedRect?.length === 4 &&
        graphic.paintedNormalizedRect.every(Number.isFinite)
          ? graphic.paintedNormalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          : undefined
    }))
  const tiles = stack.map((frame) =>
    painted
      .filter((image) => image.rect && intersection(image.rect, frame) > 0)
      .sort((a, b) => a.rect[0] - b.rect[0])
  )
  if (
    tiles.some(
      (row, n) =>
        row.length !== 2 ||
        row.some(
          (image) =>
            !contains(stack[n], image.rect, epsilon) || area(image.rect) < area(stack[n]) * 0.2
        )
    ) ||
    new Set(tiles.flat().map((image) => image.hash)).size !== 6 ||
    painted.some(
      (image) =>
        !image.rect || (intersection(image.rect, bounds) > 0 && !tiles.flat().includes(image))
    ) ||
    tiles.some(
      (row) =>
        row[0].rect[2] >= row[1].rect[0] ||
        Math.abs(row[0].rect[1] - row[1].rect[1]) > font ||
        Math.abs(row[0].rect[3] - row[1].rect[3]) > font
    ) ||
    tiles.some((row) =>
      row.some((image, col) =>
        [0, 2].some((side) => Math.abs(image.rect[side] - tiles[0][col].rect[side]) > font * 0.5)
      )
    )
  )
    return
  const labels = (page.lines ?? []).filter(
    (line) => line.text?.trim() && intersection(lineRect(line), bounds) > 0
  )
  if (
    labels.length !== 3 ||
    stack.some(
      (frame) => labels.filter((line) => contains(frame, lineRect(line), epsilon)).length !== 1
    ) ||
    labels.some(
      (line) =>
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        line.fontSize < font * 0.5 ||
        line.fontSize > font * 0.8 ||
        line.height <= 0 ||
        line.width <= 0 ||
        line.text.trim().length < 4 ||
        line.text.trim().length > 80 ||
        /[.!?]$/.test(line.text.trim())
    )
  )
    return
  return { caption, rect: bounds, graphicsCount: 6, reason: 'native-raster-frame-bands' }
}

// Repeated full raster maps can have large axis-label gaps. Require matching
// native image bounds and a separate aligned color key for every map, with a
// single shared caption and no prose or competing caption inside the stack.
export function nativeCaptionedRasterMapStack(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => g.normalizedRect)
    .filter((r) => r?.length === 4 && r.every(Number.isFinite))
    .map((r) => r.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[1] >= top && r[3] < caption.rect[1])
  const maps = images
    .filter((r) => r[2] - r[0] >= font * 20 && r[3] - r[1] >= font * 6)
    .sort((a, b) => a[1] - b[1])
  if (maps.length !== 3) return
  const first = maps[0]
  if (
    maps.some(
      (r) =>
        Math.abs(r[0] - first[0]) > font ||
        Math.abs(r[2] - first[2]) > font ||
        Math.abs(r[3] - r[1] - first[3] + first[1]) > font * 2
    )
  )
    return
  const gaps = maps.slice(1).map((r, i) => r[1] - maps[i][3])
  if (gaps.some((gap) => gap < font || gap > font * 20) || Math.abs(gaps[0] - gaps[1]) > font * 3)
    return
  const keys = maps.map((map) =>
    images.filter(
      (r) =>
        r[0] >= map[2] &&
        r[0] - map[2] <= font * 4 &&
        r[2] - r[0] <= font * 2 &&
        Math.abs(r[1] - map[1]) <= font &&
        Math.abs(r[3] - map[3]) <= font
    )
  )
  if (keys.some((items) => items.length !== 1)) return
  const bounds = union([...maps, ...keys.flat()])
  if (caption.rect[1] - bounds[3] > font * 8 || blocked(bounds, caption, captions, tables)) return
  const band = [
    Math.max(0, bounds[0] - font * 6),
    Math.max(top, bounds[1] - font * 5),
    Math.min(page.width, bounds[2] + font * 5),
    caption.rect[1] - 1
  ]
  const labels = (page.lines ?? []).filter((l) => intersection(lineRect(l), band) > 0)
  if (
    labels.some(
      (l) =>
        !contains(band, lineRect(l), 0.5) ||
        l.fontSize > font * 1.35 ||
        l.text.trim().length > 110 ||
        /[.!?]\s*$/.test(l.text.trim())
    )
  )
    return
  const rect = union([bounds, ...labels.map(lineRect)])
  if (blocked(rect, caption, captions, tables)) return
  return { caption, rect, graphicsCount: 6, reason: 'native-raster-map-stack' }
}

// Three whole raster carriers can form a repeated plate without tile lanes.
// Require every observed painted object and native font to have a unique owner;
// an unmeasured image, mixed vector plate or intervening paragraph is insufficient.
function nativeCaptionedSingletonRasterStack(page, caption, captions, tables) {
  const finiteRect = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  if (
    !page ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    !(page.width > 0 && page.height > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !caption ||
    caption?.page !== page.pageNumber ||
    !finiteRect(caption.rect) ||
    !caption.lines?.length ||
    captionKind(caption.lines[0]) !== 'figure'
  )
    return
  const own = captions.filter((candidate) => candidate.page === page.pageNumber)
  if (own.length !== 1 || own[0] !== caption) return
  if (
    page.lines.some(
      (line) =>
        line.text?.trim() &&
        (!finiteRect(lineRect(line)) ||
          !Number.isFinite(line.fontSize) ||
          !(line.fontSize > 0) ||
          Math.abs(line.height - line.fontSize) > 0.02)
    )
  )
    return
  const captionRows = caption.lines.map((text) =>
    page.lines.filter((line) => line.text === text && contains(caption.rect, lineRect(line), 0.02))
  )
  if (captionRows.some((rows) => rows.length !== 1)) return
  const sourceCaption = captionRows.map((rows) => rows[0]),
    font = Math.max(...sourceCaption.map((line) => line.fontSize))
  if (!Number.isFinite(font) || sourceCaption.some((line) => line.fontSize < font * 0.9)) return
  if (
    page.graphicsBounds.length !== 3 ||
    page.graphicsBounds.some((graphic) => graphic.kind !== 'image')
  )
    return
  const images = page.graphicsBounds.map((graphic) => ({
    graphic,
    rect: graphic.paintedNormalizedRect?.map(
      (value, index) => value * (index % 2 ? page.height : page.width)
    ),
    recorded: graphic.normalizedRect?.map(
      (value, index) => value * (index % 2 ? page.height : page.width)
    )
  }))
  if (
    images.some(
      ({ graphic, rect, recorded }) =>
        !/^[a-f0-9]{64}$/u.test(graphic.imageHash ?? '') ||
        !finiteRect(rect) ||
        !finiteRect(recorded) ||
        !contains(recorded, rect, 1e-8) ||
        !contains([0, 0, page.width, page.height], recorded, 1e-8)
    ) ||
    new Set(images.map(({ graphic }) => graphic.imageHash)).size !== 3
  )
    return
  images.sort((a, b) => a.rect[1] - b.rect[1])
  const bounds = union(images.map(({ rect }) => rect)),
    height = images[0].rect[3] - images[0].rect[1]
  if (
    images.some(({ rect }, index) => {
      const rowHeight = rect[3] - rect[1],
        gap = index ? rect[1] - images[index - 1].rect[3] : 0
      return (
        rect[2] - rect[0] < font * 12 ||
        rowHeight < font * 6 ||
        Math.abs(rowHeight - height) > height * 0.25 ||
        Math.abs(rect[0] - images[0].rect[0]) > font ||
        Math.abs(rect[2] - images[0].rect[2]) > font ||
        Math.abs((rect[0] + rect[2] - caption.rect[0] - caption.rect[2]) / 2) > font ||
        rect[0] < caption.rect[0] - font ||
        rect[2] > caption.rect[2] + font ||
        (index && (gap < 0 || gap > font * 4))
      )
    })
  )
    return
  const wholeCaptionTop = Math.min(...sourceCaption.map((line) => line.y)),
    gap = wholeCaptionTop - bounds[3]
  if (
    gap < font * 0.2 ||
    gap > font * 3 ||
    bounds[3] - bounds[1] > page.height * 0.8 ||
    tables.some((table) => !finiteRect(table) || intersection(table, bounds) > 0) ||
    page.lines.some(
      (line) => line.text?.trim() && !sourceCaption.includes(line) && line.y < caption.rect[3]
    )
  )
    return
  return { caption, rect: bounds, graphicsCount: 3 }
}

// Repeated raster bands can be separated by short group labels. The nearest
// band alone is not the complete figure: require repeated column lanes in every
// row, close vertical spacing, and no intervening caption/table/body paragraph.
export function nativeCaptionedRepeatedRasterRows(page, caption, captions, tables) {
  const singleton = nativeCaptionedSingletonRasterStack(page, caption, captions, tables)
  if (singleton) return singleton
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  const images = graphics(page, 'image').filter(
    (rect) =>
      rect.every(Number.isFinite) &&
      rect[1] >= top &&
      rect[3] <= caption.rect[1] &&
      rect[2] - rect[0] >= font * 3 &&
      rect[3] - rect[1] >= font * 3 &&
      (caption.rect[2] - caption.rect[0] < page.width * 0.45 ||
        (rect[0] >= caption.rect[0] - font * 2 && rect[2] <= caption.rect[2] + font * 2))
  )
  const rows = rasterRows(images, font)
  if (rows.length < 3 || rows.some((row) => row.length < 4 || row.length > 12)) return
  const bounds = union(images)
  if (
    caption.rect[1] - bounds[3] > font * 4 ||
    bounds[2] - bounds[0] > page.width * 0.85 ||
    Math.abs((bounds[0] + bounds[2] - caption.rect[0] - caption.rect[2]) / 2) >
      (bounds[2] - bounds[0]) * 0.2 ||
    blocked(bounds, caption, captions, tables)
  )
    return
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const width = row[0][2] - row[0][0]
    const height = row[0][3] - row[0][1]
    if (
      row.some(
        (rect, lane) =>
          Math.abs(rect[2] - rect[0] - width) > width * 0.3 ||
          Math.abs(rect[3] - rect[1] - height) > height * 0.3 ||
          (lane > 0 &&
            (rect[0] - row[lane - 1][2] < -font || rect[0] - row[lane - 1][2] > font * 2))
      )
    )
      return
    if (!index) continue
    const previous = rows[index - 1]
    if (row[0][1] - Math.max(...previous.map((rect) => rect[3])) > font * 3) return
    const shared = row.filter((rect) =>
      previous.some(
        (prior) => Math.abs(rect[0] - prior[0]) <= font && Math.abs(rect[2] - prior[2]) <= font
      )
    ).length
    if (shared < Math.min(row.length, previous.length) - 1) return
  }
  const gapLines = (page.lines ?? []).filter((line) => {
    const rect = lineRect(line)
    return (
      line.text?.trim() &&
      intersection(rect, bounds) > 0 &&
      !images.some((image) => intersection(image, rect) / area(rect) > 0.7)
    )
  })
  if (
    gapLines.some(
      (line) =>
        line.fontSize > font * 1.1 || line.text.trim().length > 110 || line.height > font * 1.5
    ) ||
    gapLines.some((line, index) =>
      gapLines.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          Math.abs(other.y - line.y) > font * 0.4 &&
          Math.abs(other.y - line.y) < font * 1.7 &&
          line.text.trim().length > 40 &&
          other.text.trim().length > 40
      )
    )
  )
    return
  const headings = (page.lines ?? []).filter((line) => {
    const rect = lineRect(line)
    return (
      line.text?.trim() &&
      line.fontSize <= font * 1.1 &&
      rect[3] <= bounds[1] &&
      bounds[1] - rect[3] <= font * 2 &&
      rect[1] >= top &&
      rect[0] >= bounds[0] - font &&
      rect[2] <= bounds[2] + font
    )
  })
  const rect = withLabelInkTail(
    union([bounds, ...headings.map(lineRect), ...gapLines.map(lineRect)]),
    bounds[3],
    caption,
    font
  )
  if (blocked(rect, caption, captions, tables)) return
  return { caption, rect, graphicsCount: images.length, reason: 'native-repeated-raster-rows' }
}

// Video examples often place a frame strip over several boxed answers. The
// strip and repeated frames together prove a bounded visual plate; small logos
// or unframed prose alone cannot establish this ownership.
export function nativeCaptionedRasterAnswerPlate(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  const images = graphics(page, 'image').filter(
    (rect) => rect[1] >= top && rect[3] < caption.rect[1] && rect.every(Number.isFinite)
  )
  const strips = rasterRows(
    images.filter((rect) => rect[2] - rect[0] >= font * 3 && rect[3] - rect[1] >= font * 2),
    font
  ).filter((row) => row.length >= 4 && row.length <= 10)
  const paths = graphics(page, 'path')
  const candidates = []
  for (const strip of strips) {
    const stripBounds = union(strip)
    const frames = paths.filter(
      (rect) =>
        rect[1] >= stripBounds[3] &&
        rect[3] < caption.rect[1] &&
        rect[3] - rect[1] >= font * 2 &&
        rect[2] - rect[0] >= (stripBounds[2] - stripBounds[0]) * 0.7 &&
        rect[0] >= stripBounds[0] - font &&
        rect[2] <= stripBounds[2] + font
    )
    const orderedFrames = frames.slice().sort((a, b) => area(b) - area(a))
    const unique = orderedFrames.filter(
      (rect, index) =>
        !orderedFrames
          .slice(0, index)
          .some((prior) => prior.every((v, i) => Math.abs(v - rect[i]) < font * 0.5))
    )
    if (unique.length < 2 || unique.length > 8) continue
    unique.sort((a, b) => a[1] - b[1])
    if (
      unique[0][1] - stripBounds[3] > font * 5 ||
      caption.rect[1] - Math.max(...unique.map((rect) => rect[3])) > font * 4 ||
      unique.some(
        (rect, index) =>
          Math.abs(rect[0] - unique[0][0]) > font ||
          Math.abs(rect[2] - unique[0][2]) > font ||
          (index > 0 && rect[1] - unique[index - 1][3] > font * 5)
      )
    )
      continue
    const bounds = union([stripBounds, ...unique])
    if (blocked(bounds, caption, captions, tables)) continue
    const ownedImages = images.filter((rect) => contains(bounds, rect, font * 3))
    const lines = (page.lines ?? []).filter((line) => {
      const rect = lineRect(line)
      return line.text?.trim() && contains(bounds, rect, font * 3) && rect[3] < caption.rect[1]
    })
    if (
      lines.some(
        (line) =>
          !unique.some((rect) => contains(rect, lineRect(line), 2)) &&
          !strip.some((rect) => contains(rect, lineRect(line), 2)) &&
          (line.fontSize > font * 0.8 || line.text.trim().length > 90)
      )
    )
      continue
    const rect = union([bounds, ...ownedImages, ...lines.map(lineRect)])
    if (blocked(rect, caption, captions, tables)) continue
    candidates.push({
      caption,
      rect,
      graphicsCount: ownedImages.length + unique.length,
      reason: 'native-raster-answer-plate'
    })
  }
  if (candidates.length === 1) return candidates[0]
}

// A numbered task timeline can mix a raster strip with typeset examples and
// a lower summary. Require both an ordered list and the same small raster icon
// repeated alongside its entries; an ordinary list near a photo is insufficient.
export function nativeCaptionedRasterTaskTimeline(page, figure, captions, tables) {
  const caption = figure?.caption
  if (!caption || !figure.rect || !/\btasks?\b/i.test(caption.lines.join(' '))) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image' && graphic.imageHash)
    .map((graphic) => ({
      hash: graphic.imageHash,
      rect: (graphic.paintedNormalizedRect ?? graphic.normalizedRect).map(
        (value, index) => value * (index % 2 ? page.height : page.width)
      )
    }))
    .filter(({ rect }) => rect[1] >= top && rect[3] <= caption.rect[1])
  const strips = rasterRows(
    images
      .filter(({ rect }) => rect[2] - rect[0] >= font * 2 && rect[3] - rect[1] >= font * 2)
      .map(({ rect }) => rect),
    font
  ).filter((row) => row.length >= 4 && row.length <= 10 && union(row)[3] < figure.rect[1])
  const candidates = []
  for (const strip of strips) {
    const stripBounds = union(strip)
    if (
      Math.abs(stripBounds[0] - figure.rect[0]) > font * 2 ||
      Math.abs(stripBounds[2] - figure.rect[2]) > font * 2
    )
      continue
    const bounds = union([stripBounds, figure.rect])
    if (blocked(bounds, caption, captions, tables)) continue
    const lines = (page.lines ?? []).filter(
      (line) =>
        line.text?.trim() && contains(bounds, lineRect(line), font) && line.y >= stripBounds[3]
    )
    const entries = lines
      .filter((line) => /^\d\.\s+\S/.test(line.text.trim()))
      .sort((a, b) => a.y - b.y)
    if (
      entries.length < 4 ||
      entries.length > 9 ||
      entries.some(
        (line, index) =>
          Number(line.text.trim()[0]) !== index + 1 ||
          line.fontSize > font * 0.75 ||
          Math.abs(line.x - entries[0].x) > font
      )
    )
      continue
    if (lines.some((line) => line.fontSize > font * 0.8 || line.text.trim().length > 160)) continue
    const icons = images.filter(
      ({ rect }) => contains(bounds, rect) && rect[2] - rect[0] < font && rect[3] - rect[1] < font
    )
    const repeatedIcon = icons.find(({ hash }) =>
      entries.every((line) =>
        icons.some((icon) => icon.hash === hash && Math.abs(icon.rect[1] - line.y) <= font * 2)
      )
    )
    if (!repeatedIcon) continue
    const rect = union([bounds, ...lines.map(lineRect)])
    if (blocked(rect, caption, captions, tables)) continue
    candidates.push({
      caption,
      rect,
      graphicsCount: images.filter((image) => contains(rect, image.rect)).length,
      reason: 'native-raster-task-timeline'
    })
  }
  if (candidates.length === 1) return candidates[0]
}

// A raster color key repeated beside aligned vector cell grids proves a stack
// of heatmaps. Keep the key, grid and panel labels together rather than treating
// the final grid as a standalone bar chart.
export function nativeCaptionedKeyedHeatmapStack(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const top = captionLaneTop(caption, captions)
  const keys = graphics(page, 'image')
    .filter(
      (rect) =>
        rect[1] >= top &&
        rect[3] <= caption.rect[1] &&
        rect[2] - rect[0] > 0 &&
        rect[2] - rect[0] <= font * 1.5 &&
        rect[3] - rect[1] >= font * 4
    )
    .sort((a, b) => a[1] - b[1])
  if (keys.length < 2 || keys.length > 5) return
  if (
    keys.some(
      (rect) =>
        Math.abs(rect[0] - keys[0][0]) > font * 0.5 ||
        Math.abs(rect[3] - rect[1] - keys[0][3] + keys[0][1]) > font
    )
  )
    return
  const paths = graphics(page, 'path')
  const grids = keys.map((key) => {
    const frames = paths.filter(
      (rect) =>
        Math.abs(rect[1] - key[1]) <= 2 &&
        Math.abs(rect[3] - key[3]) <= 2 &&
        key[0] - rect[2] >= 0 &&
        key[0] - rect[2] <= font * 2 &&
        rect[2] - rect[0] >= font * 12
    )
    if (frames.length !== 1) return
    const grid = frames[0]
    const cells = paths.filter(
      (rect) => contains(grid, rect, 1) && area(rect) < area(grid) * 0.04 && area(rect) > 0
    )
    const rows = new Set(cells.map((rect) => Math.round(rect[1] / 2)))
    const columns = new Set(cells.map((rect) => Math.round(rect[0] / 2)))
    if (cells.length < 24 || rows.size < 4 || columns.size < 4) return
    return grid
  })
  if (grids.some((rect) => !rect)) return
  if (
    grids.some(
      (rect) => Math.abs(rect[0] - grids[0][0]) > font || Math.abs(rect[2] - grids[0][2]) > font
    )
  )
    return
  const bounds = union([...keys, ...grids])
  const labels = (page.lines ?? []).filter((line) => {
    const rect = lineRect(line)
    return (
      line.text?.trim() &&
      rect[0] >= bounds[0] - font * 3 &&
      rect[2] <= bounds[2] + font * 2 &&
      rect[1] >= bounds[1] - font * 2 &&
      rect[3] < caption.rect[1]
    )
  })
  if (keys.slice(1).some((key, index) => key[1] - keys[index][3] > font * 5)) return
  if (caption.rect[1] - bounds[3] > font * 5 || blocked(bounds, caption, captions, tables)) return
  if (labels.filter((line) => /^\([a-z]\)\s/.test(line.text.trim())).length !== keys.length) return
  if (labels.some((line) => line.fontSize > font * 1.1 || line.text.trim().length > 110)) return
  const rect = withLabelInkTail(union([bounds, ...labels.map(lineRect)]), bounds[3], caption, font)
  if (blocked(rect, caption, captions, tables)) return
  return {
    caption,
    rect,
    graphicsCount: keys.length + grids.length,
    reason: 'native-keyed-heatmap-stack'
  }
}

// Some native text figures draw their frame as four independent rules rather
// than one closed path. Join only aligned horizontal/vertical segments that
// form a closed rectangle; the text proof below still has to establish that
// the rectangle is an illustration rather than a table or paragraph.
const segmentedFrameRects = (paths, font) => {
  const tolerance = Math.max(2, font * 1.5)
  const thin = Math.max(2, font * 1.15)
  const horizontal = paths.filter(
    (r) => r[2] - r[0] >= font * 20 && r[3] - r[1] <= thin && r[3] - r[1] > 0
  )
  const vertical = paths.filter(
    (r) => r[3] - r[1] >= font * 5 && r[2] - r[0] <= thin && r[2] - r[0] > 0
  )
  const close = (a, b) => Math.abs(a - b) <= tolerance
  const frames = []
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom[1] - top[3] < font * 5) continue
      if (!close(top[0], bottom[0]) || !close(top[2], bottom[2])) continue
      const left = vertical.find(
        (r) =>
          close(r[0], top[0]) &&
          close(r[2], top[0]) &&
          r[1] <= top[1] + tolerance &&
          r[3] >= bottom[3] - tolerance
      )
      const right = vertical.find(
        (r) =>
          close(r[0], top[2]) &&
          close(r[2], top[2]) &&
          r[1] <= top[1] + tolerance &&
          r[3] >= bottom[3] - tolerance
      )
      if (!left || !right) continue
      const rect = [
        Math.min(top[0], bottom[0], left[0], right[0]),
        Math.min(top[1], bottom[1], left[1], right[1]),
        Math.max(top[2], bottom[2], left[2], right[2]),
        Math.max(top[3], bottom[3], left[3], right[3])
      ]
      if (!frames.some((r) => r.every((v, i) => Math.abs(v - rect[i]) <= tolerance)))
        frames.push(rect)
    }
  }
  return frames
}

// Text-only prompt cards sometimes omit the two vertical frame rules. Two
// aligned horizontal rules still provide a strong bounded witness when the
// native text block is long, dense, and immediately followed by its caption.
const horizontalBandRects = (paths, caption, font) => {
  const tolerance = Math.max(2, font * 1.5)
  const horizontal = paths.filter(
    (r) => r[2] - r[0] >= font * 20 && r[3] - r[1] <= Math.max(2, font * 1.15)
  )
  const bands = []
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom[1] - top[3] < font * 5 || bottom[1] >= caption.rect[1]) continue
      if (Math.abs(top[0] - bottom[0]) > tolerance || Math.abs(top[2] - bottom[2]) > tolerance)
        continue
      if (caption.rect[1] - bottom[3] > font * 2) continue
      const rect = [Math.min(top[0], bottom[0]), top[1], Math.max(top[2], bottom[2]), bottom[3]]
      if (
        !bands.some((candidate) =>
          candidate.every((value, index) => Math.abs(value - rect[index]) <= tolerance)
        )
      )
        bands.push(rect)
    }
  }
  return bands
}

// Some page screenshots are painted as four independent framed panels. When
// only one panel also has a raster operation, the raster match below can
// otherwise claim just that panel and crop the remaining vector panels away.
// Require a complete two-by-two frame grid immediately above the caption so
// ordinary rules, tables, and neighbouring panels cannot widen ownership.
export function nativeCaptionedFramedVectorQuad(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.?)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path')
  const isInternal = (outer, inner) =>
    area(inner) > 0 && area(inner) < area(outer) * 0.9 && contains(outer, inner, font * 1.5)
  const externalOverlap = (outer, inner) =>
    intersection(inner, outer) > 0 && !isInternal(outer, inner)
  const frames = segmentedFrameRects(paths, font).filter((rect) => {
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    return (
      width >= font * 20 &&
      height >= font * 5 &&
      rect[3] <= caption.rect[1] + font * 0.25 &&
      !tables.some((table) => externalOverlap(rect, table)) &&
      !captions.some((other) => other !== caption && externalOverlap(rect, other.rect))
    )
  })
  if (frames.length < 4) return
  const widths = frames.map((rect) => rect[2] - rect[0])
  const heights = frames.map((rect) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (
    widths.some((value) => Math.abs(value - width) > width * 0.35) ||
    heights.some((value) => Math.abs(value - height) > height * 0.35)
  )
    return
  const rows = []
  for (const rect of frames.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ anchor }) => Math.abs(anchor - rect[1]) <= height * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ anchor: rect[1], rects: [rect] })
  }
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 2)) return
  const orderedRows = rows.map(({ rects }) => rects.slice().sort((a, b) => a[0] - b[0]))
  if (
    orderedRows.some(([left, right]) => right[0] < left[2] || right[0] - left[2] > width * 0.75) ||
    orderedRows[1].some(
      (rect, index) =>
        rect[1] < orderedRows[0][index][3] ||
        rect[1] - orderedRows[0][index][3] > height * 0.5 ||
        Math.abs(rect[0] - orderedRows[0][index][0]) > width * 0.2 ||
        Math.abs(rect[2] - orderedRows[0][index][2]) > width * 0.2
    )
  )
    return
  const centers = rows
    .flatMap(({ rects }) => rects.map((rect) => (rect[0] + rect[2]) / 2))
    .sort((a, b) => a - b)
  const columns = []
  for (const center of centers) {
    const previous = columns.at(-1)
    if (previous === undefined || center - previous > width * 0.45) columns.push(center)
    else columns[columns.length - 1] = (previous + center) / 2
  }
  if (columns.length !== 2 || columns[1] - columns[0] < width * 0.5) return
  const bounds = union(frames)
  const gap = caption.rect[1] - bounds[3]
  if (gap < -font * 0.25 || gap > Math.max(font * 3, 24)) return
  // Preserve the no-crop contract for text-only illustrations: this recovery
  // repairs a mixed raster/vector plate rather than introducing vector crops.
  if (
    !graphics(page, 'image').some(
      (image) =>
        area(image) >= width * height * 0.1 && frames.some((frame) => contains(frame, image, font))
    ) ||
    tables.some(
      (table) =>
        intersection(table, bounds) > 0 && !frames.some((frame) => isInternal(frame, table))
    ) ||
    captions.some(
      (other) =>
        other !== caption &&
        intersection(other.rect, bounds) > 0 &&
        !frames.some((frame) => isInternal(frame, other.rect))
    )
  )
    return
  const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
  if (overlap < Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.5) return
  return {
    caption,
    rect: bounds,
    graphicsCount: frames.length,
    reason: 'native-framed-vector-quad'
  }
}

// A native outer drawing and distinctly smaller typeset contents prove the
// illustrated text face independently of paragraph-length exclusion heuristics.
export function nativeCaptionedTextIllustration(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path')
  const candidateRects = [
    ...paths.map((rect) => ({ rect, segmented: false })),
    ...segmentedFrameRects(paths, font).map((rect) => ({ rect, segmented: true })),
    ...horizontalBandRects(paths, caption, font).map((rect) => ({ rect, banded: true }))
  ]
  const proofs = candidateRects
    .filter(({ rect: r, segmented, banded }) => {
      if (
        !r.every(Number.isFinite) ||
        r[2] - r[0] < font * 20 ||
        r[3] - r[1] < font * 5 ||
        r[3] > caption.rect[1] ||
        caption.rect[1] - r[3] > font * 2 ||
        Math.min(r[2], caption.rect[2]) <= Math.max(r[0], caption.rect[0]) ||
        blocked(r, caption, captions, tables)
      )
        return false
      // A segmented text frame that encloses a substantial raster plate is
      // usually a detached publisher frame around the raster, rather than a
      // text illustration. Leave that ownership to the raster/frame matchers.
      if (
        (segmented || banded) &&
        page.graphicsBounds?.some((graphic) => {
          if (graphic.kind !== 'image' || !graphic.normalizedRect?.every(Number.isFinite))
            return false
          const image = graphic.normalizedRect.map(
            (value, index) => value * (index % 2 ? page.height : page.width)
          )
          return (
            area(image) > page.width * page.height * 0.01 &&
            contains(r, image, 2) &&
            r[1] < image[1] - Math.max(font * 4, 24)
          )
        })
      )
        return false
      const contents = page.lines.filter((l) => contains(r, lineRect(l)) && l.text.trim())
      // Some publishers draw a framed prompt card with an inset border and
      // keep its body at the regular text size, just above the caption size.
      // The inset border is a strict ownership witness; without it retain
      // the older, smaller-body threshold so ordinary prose stays deferred.
      const nestedFrame = paths.some((other) => {
        if (other === r || area(other) <= area(r) * 0.35) return false
        const ratio = area(other) / area(r)
        const tolerance = Math.max(2, font * 1.5)
        const duplicate =
          ratio >= 0.98 &&
          ratio <= 1.02 &&
          other.every((value, index) => Math.abs(value - r[index]) <= tolerance)
        return (ratio < 0.98 || duplicate) && contains(r, other, tolerance)
      })
      // Prompt-style text panels often keep their title at the caption size
      // while setting the body one point smaller.  Ignore that title line,
      // but require enough smaller body text to prove this is an illustration
      // rather than an ordinary paragraph.
      const body = (segmented ? contents.slice(1) : contents).filter(
        (l) =>
          l.fontSize > 0 &&
          l.fontSize <= font * (segmented || banded ? 1.05 : nestedFrame ? 1.2 : 0.95)
      )
      const title = segmented
        ? contents.slice(0, 1)
        : nestedFrame
          ? []
          : contents.filter((l) => l.fontSize > font * 0.95)
      return (
        body.length >= 4 &&
        body.filter((l) => l.text.length >= 30).length >= 3 &&
        (banded || title.every((l) => l === contents[0] && l.text.length < 80 && l.y <= body[0].y))
      )
    })
    .filter(
      ({ rect: r }, i, all) =>
        !all.some(
          (p, j) =>
            j !== i &&
            contains(p.rect, r) &&
            (area(p.rect) > area(r) || (area(p.rect) === area(r) && j < i))
        )
    )
  if (proofs.length === 1)
    return {
      caption,
      rect: proofs[0].rect,
      graphicsCount: paths.filter((r) => contains(proofs[0].rect, r)).length
    }
}

// A vector architecture plate can be painted as one large outer path with
// many small image/path operations for logos, arrows, and boxed labels. It has
// no raster plate for the ordinary association pass, and its short labels do
// not satisfy the prose-body proof above. Require a directly attached broad
// frame, several enclosed image marks, and three spatially separated stages;
// this keeps ordinary prose boxes and uncaptioned decorative drawings out.
export function nativeCaptionedVectorDiagram(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const inside = (outer, inner, tolerance = 2) =>
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  const frames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .filter(
      (rect) =>
        rect &&
        rect[2] - rect[0] >= page.width * 0.7 &&
        rect[3] - rect[1] >= page.height * 0.15 &&
        rect[3] <= caption.rect[1] &&
        caption.rect[1] - rect[3] <= Math.max(24, font * 3) &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
    .filter(
      (rect, index, all) =>
        !all
          .slice(0, index)
          .some((other) =>
            other.every((value, coordinate) => Math.abs(value - rect[coordinate]) <= 1)
          )
    )
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map(toRect)
    .filter((rect) => rect && area(rect) > 0)
  const candidates = frames
    .map((frame) => {
      const enclosedImages = images.filter((image) => inside(frame, image))
      if (enclosedImages.length < 6) return undefined
      const centers = enclosedImages.map((rect) => (rect[0] + rect[2]) / 2).sort((a, b) => a - b)
      const columns = []
      for (const center of centers) {
        const previous = columns.at(-1)
        if (previous === undefined || center - previous > page.width * 0.12) columns.push(center)
        else columns[columns.length - 1] = (previous + center) / 2
      }
      if (columns.length < 3) return undefined
      const lines = (page.lines ?? []).filter(
        (line) =>
          line.text?.trim() &&
          inside(frame, lineRect(line), 2) &&
          !captions.some(
            (other) => other !== caption && intersection(other.rect, lineRect(line)) > 0
          )
      )
      if (lines.length < 8) return undefined
      return { frame, graphicsCount: enclosedImages.length, columns: columns.length }
    })
    .filter(Boolean)
    .sort((a, b) => area(b.frame) - area(a.frame))
  if (candidates.length !== 1) return undefined
  return {
    caption,
    rect: candidates[0].frame,
    graphicsCount: candidates[0].graphicsCount
  }
}

// A narrow-column vector plate can contain only boxes, arrows, and short
// labels.  It has no raster witness and therefore cannot use the broad
// architecture-plate recognizer above.  Keep this fallback strict: require a
// caption-attached outer path, a dense repeated row/column lattice of smaller
// paths, and no table or competing caption in the candidate band.  Ordinary
// plots and prose rules do not satisfy the repeated lattice proof.
export function nativeCaptionedVectorGrid(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (
    !(font > 0) ||
    !Number.isFinite(font) ||
    !/^figure\s+\d+\s*[:.]/i.test(caption.lines[0] ?? '')
  )
    return
  const paths = graphics(page, 'path')
  const candidates = paths.filter((frame, index) => {
    const width = frame[2] - frame[0],
      height = frame[3] - frame[1]
    return (
      width >= page.width * 0.3 &&
      height >= Math.max(page.height * 0.1, font * 8) &&
      frame[3] <= caption.rect[1] + 1 &&
      caption.rect[1] - frame[3] <= Math.max(24, font * 3) &&
      Math.min(frame[2], caption.rect[2]) - Math.max(frame[0], caption.rect[0]) >= width * 0.8 &&
      !paths
        .slice(0, index)
        .some((other) => other.every((value, n) => Math.abs(value - frame[n]) <= 1)) &&
      !blocked(frame, caption, captions, tables)
    )
  })
  const cluster = (values, tolerance) => {
    const sorted = values.slice().sort((a, b) => a - b),
      groups = []
    for (const value of sorted) {
      const previous = groups.at(-1)
      if (!previous || value - previous.at(-1) > tolerance) groups.push([value])
      else previous.push(value)
    }
    return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length)
  }
  const proofs = candidates
    .map((frame) => {
      const frameArea = area(frame),
        marks = paths.filter((path) => {
          const width = path[2] - path[0],
            height = path[3] - path[1]
          return (
            path !== frame &&
            contains(frame, path, 2) &&
            width >= font * 1.8 &&
            height >= font * 1.3 &&
            height <= font * 2.8 &&
            area(path) > font * font * 0.25 &&
            area(path) < frameArea * 0.2 &&
            width < (frame[2] - frame[0]) * 0.35 &&
            height < (frame[3] - frame[1]) * 0.45
          )
        })
      if (marks.length < 18) return undefined
      const rowCenters = cluster(
          marks.map((path) => (path[1] + path[3]) / 2),
          Math.max(font * 1.5, 6)
        ),
        columnCenters = cluster(
          marks.map((path) => (path[0] + path[2]) / 2),
          Math.max(font * 1.5, 6)
        ),
        lines = page.lines.filter(
          (line) =>
            contains(frame, lineRect(line), 2) &&
            line.text?.trim() &&
            !captions.some(
              (other) => other !== caption && intersection(other.rect, lineRect(line)) > 0
            )
        )
      if (rowCenters.length < 3 || columnCenters.length < 4 || lines.length < 1) return undefined
      if (
        rowCenters.some(
          (row) =>
            marks.filter(
              (path) => Math.abs((path[1] + path[3]) / 2 - row) <= Math.max(font * 1.5, 6)
            ).length < 4
        ) ||
        columnCenters.some(
          (column) =>
            marks.filter(
              (path) => Math.abs((path[0] + path[2]) / 2 - column) <= Math.max(font * 1.5, 6)
            ).length < 2
        )
      )
        return undefined
      return { frame, marks, lines }
    })
    .filter(Boolean)
    .filter(
      ({ frame }, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            contains(other.frame, frame, 2) &&
            area(other.frame) > area(frame)
        )
    )
  if (proofs.length !== 1) return
  return {
    caption,
    rect: proofs[0].frame,
    graphicsCount: paths.filter((path) => contains(proofs[0].frame, path, 2)).length,
    reason: 'native-vector-grid'
  }
}

// A multi-panel chart can be painted entirely with native paths and text. The
// ordinary figure pass intentionally leaves pure vector prose-like drawings
// unresolved, but repeated axes with numeric ticks are a stronger visual
// witness than paragraph rules. Keep this fallback limited to a horizontal
// strip of similarly sized path clusters immediately above a figure caption.
export function nativeCaptionedVectorChartStrip(page, caption, captions, tables) {
  if (!/^figure\s+(?:[A-Z]\.)?\d+(?:\.\d+)?\s*[:.]/i.test(caption.lines?.[0] ?? '')) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[3] < caption.rect[1] &&
      caption.rect[1] - rect[3] <= Math.max(72, font * 6) &&
      rect[2] > caption.rect[0] - font * 5 &&
      rect[0] < caption.rect[2] + font * 5
  )
  if (paths.length < 18) return
  const ordered = paths.slice().sort((a, b) => a[0] - b[0])
  const groups = []
  for (const rect of ordered) {
    const current = groups.at(-1)
    if (!current || rect[0] - current.right > font * 0.75) {
      groups.push({ left: rect[0], right: rect[2], rects: [rect] })
    } else {
      current.right = Math.max(current.right, rect[2])
      current.rects.push(rect)
    }
  }
  if (groups.length < 3 || groups.length > 8 || groups.some((group) => group.rects.length < 3))
    return
  const widths = groups.map((group) => group.right - group.left)
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  if (width < font * 4 || widths.some((value) => Math.abs(value - width) > width * 0.45)) return
  const top = Math.min(...paths.map((rect) => rect[1]))
  const bottom = Math.max(...paths.map((rect) => rect[3]))
  const aligned = groups.every((group) => {
    const groupRects = group.rects
    const groupTop = Math.min(...groupRects.map((rect) => rect[1]))
    const groupBottom = Math.max(...groupRects.map((rect) => rect[3]))
    return groupBottom - groupTop >= font * 4 && Math.abs(groupTop - top) <= font * 2
  })
  if (!aligned || caption.rect[1] - bottom > Math.max(72, font * 6)) return
  const band = [
    Math.min(...groups.map((group) => group.left)) - font * 5,
    top - font * 2,
    Math.max(...groups.map((group) => group.right)) + font * 5,
    bottom + font * 4
  ]
  if (
    tables.some((table) => intersection(table, band) > 0) ||
    captions.some((other) => other !== caption && intersection(other.rect, band) > 0)
  ) {
    return
  }
  const numeric = page.lines.filter(
    (line) =>
      /^[-−+]?\d+(?:\.\d+)?$/.test(line.text.trim()) &&
      line.y >= band[1] &&
      line.y + line.height <= band[3] + font * 2 &&
      line.x >= band[0] - font &&
      line.x + line.width <= band[2] + font
  )
  if (numeric.length < Math.max(8, groups.length * 2)) return
  const labels = page.lines.filter(
    (line) =>
      line.text.trim() &&
      line.text.length < 40 &&
      line.y >= band[1] &&
      line.y + line.height <= band[3] + font * 2 &&
      line.x >= band[0] &&
      line.x + line.width <= band[2] &&
      !captions.some((other) => intersection(other.rect, lineRect(line)) > 0)
  )
  if (labels.length < groups.length) return
  const rect = union([...paths, ...labels.map(lineRect)])
  const allPaths = graphics(page, 'path')
  const legendPaths = allPaths.filter(
    (path) =>
      path[3] <= rect[1] + font * 0.25 &&
      path[3] >= rect[1] - font * 3 &&
      path[2] > rect[0] &&
      path[0] < rect[2]
  )
  const legendLabels = page.lines.filter(
    (line) =>
      line.text.trim() &&
      line.text.length < 60 &&
      line.y + line.height <= rect[1] + font * 0.25 &&
      line.y + line.height >= rect[1] - font * 3 &&
      line.x + line.width > rect[0] &&
      line.x < rect[2] &&
      !captions.some((other) => intersection(other.rect, lineRect(line)) > 0)
  )
  const completeRect = union([rect, ...legendPaths, ...legendLabels.map(lineRect)])
  if (caption.rect[1] - completeRect[3] > Math.max(72, font * 6)) return
  return {
    caption,
    rect: completeRect,
    graphicsCount: paths.length + legendPaths.length,
    reason: 'native-vector-chart-strip'
  }
}

// A small set of publishers places a native vector bar chart immediately
// before its caption. The ordinary vector strip matcher expects several
// separated panels and can otherwise leave this single framed chart
// unresolved. Require the same numeric ticks and category labels as a chart,
// plus a unique broad frame directly above the caption.
export function nativeCaptionedVectorBarChart(page, caption, captions, tables, rules = []) {
  // A few publishers omit punctuation after the ordinal.  Accept that form
  // only when the next word starts with an uppercase title word; lowercase
  // narrative references such as "Figure 3 further illustrates" remain out.
  if (
    !/^figure\s+(?:[A-Z]\.)?\d+(?:\.\d+)?\s*(?:[.:|]|(?=\s+[A-Z]))/i.test(caption.lines?.[0] ?? '')
  )
    return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path')
  if (paths.length < 8) return
  const frames = paths
    .filter(
      (rect) =>
        // Compact single plots can be narrower than a full caption line. Keep
        // the frame requirement strict, but allow a 14-point-font-width chart
        // when the downstream numeric ticks and category labels also agree.
        rect[2] - rect[0] >= Math.max(page.width * 0.2, font * 14) &&
        rect[3] - rect[1] >= font * 8 &&
        rect[3] <= caption.rect[1] + font * 0.5 &&
        caption.rect[1] - rect[3] <= Math.max(font * 3, 24)
    )
    .filter(
      (rect, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            area(other) > area(rect) * 1.05 &&
            contains(other, rect, font * 2)
        )
    )
  // Pages with two narrow-column charts often have several frame-like paths
  // immediately above one row of captions. Select only the frame that shares
  // the caption's horizontal column; otherwise a neighboring chart can steal
  // the crop when its frame happens to be wider.
  const matchingFrames = frames.filter((frame) => {
    const overlap = Math.min(frame[2], caption.rect[2]) - Math.max(frame[0], caption.rect[0])
    return overlap >= Math.min(frame[2] - frame[0], caption.rect[2] - caption.rect[0]) * 0.35
  })
  if (matchingFrames.length !== 1) return
  const frame = matchingFrames[0]
  if (
    tables.some((table) => intersection(table, frame) > 0) ||
    captions.some((other) => other !== caption && intersection(other.rect, frame) > 0)
  )
    return
  const inside = (rect, outer, tolerance = font * 1.5) =>
    rect[0] >= outer[0] - tolerance &&
    rect[1] >= outer[1] - tolerance &&
    rect[2] <= outer[2] + tolerance &&
    rect[3] <= outer[3] + tolerance
  // Caption grouping can join a raised formula symbol to two native prose
  // fragments. Its short text box and vector rule are still caption ink, even
  // when the grouped caption starts below the raised symbol. Prove the prose
  // fragments by their full text, then require a short fragment to touch one
  // of those native neighbors at the same font and nearby baseline.
  const captionProse = page.lines.filter(
    (line) =>
      line.text?.trim().length >= 20 &&
      caption.lines.some((text) => text.includes(line.text.trim())) &&
      intersection(caption.rect, lineRect(line)) / area(lineRect(line)) > 0.8
  )
  const captionFragments = page.lines.filter(
    (line) =>
      captionProse.includes(line) ||
      (line.text?.trim().length <= 4 &&
        line.text.trim() &&
        caption.lines.some((text) => text.includes(line.text.trim())) &&
        intersection(caption.rect, lineRect(line)) > 0 &&
        captionProse.some(
          (owner) =>
            Math.abs(line.fontSize - owner.fontSize) < font * 0.1 &&
            Math.abs(line.y + line.height - owner.y - owner.height) < font &&
            Math.min(
              Math.abs(line.x + line.width - owner.x),
              Math.abs(owner.x + owner.width - line.x)
            ) <
              font * 0.15
        ))
  )
  const chartPaths = paths.filter(
    (rect) =>
      inside(rect, frame) &&
      !nativeTableDividerGraphic(page, rect, tables, rules) &&
      !(
        rect[1] > frame[3] &&
        contains(caption.rect, rect) &&
        captionFragments.some((line) =>
          contains(lineRect(line), rect, Math.max(page.width, page.height) / 256)
        )
      )
  )
  if (chartPaths.length < 8) return
  const chartLines = page.lines.filter(
    (line) =>
      line.text?.trim() &&
      inside(lineRect(line), frame, font * 2) &&
      !captionFragments.includes(line) &&
      !captions.some(
        (other) =>
          intersection(other.rect, lineRect(line)) > 0 &&
          (other !== caption ||
            other.lines.includes(line.text.trim()) ||
            intersection(other.rect, lineRect(line)) / area(lineRect(line)) > 0.8)
      )
  )
  const numeric = chartLines.filter((line) => /^[-−+]?\d+(?:[.,]\d+)?$/.test(line.text.trim()))
  const labels = chartLines.filter(
    (line) =>
      line.text.trim().length >= 1 &&
      line.text.trim().length < 80 &&
      !/^[-−+]?\d+(?:[.,]\d+)?$/.test(line.text.trim())
  )
  const categoryWords = labels
    .flatMap((line) => line.text.trim().split(/\s+/))
    .filter((word) => word.length >= 2)
  if (numeric.length < 4 || (labels.length < 3 && categoryWords.length < 3)) return
  const rect = union([frame, ...chartPaths, ...chartLines.map(lineRect)])
  return {
    caption,
    rect,
    graphicsCount: chartPaths.length,
    reason: 'native-vector-bar-chart'
  }
}

// A vector bar figure may contain adjacent panels without a shared frame.
// Recover only dense, narrow bars that share a baseline and form a broad chart
// band; table rules are wider/shorter and are blocked explicitly by the table
// rectangles. Separate x-clusters are retained when a publisher leaves a
// visible gap between panels, while touching panels are recovered as one band.
export function nativeCaptionedVectorBarPanels(page, caption, captions, tables) {
  if (
    !/^figure\s+(?:[A-Z]\.)?\d+(?:\.\d+)?\s*(?:[.:|]|(?=\s+[A-Z]))/i.test(caption.lines?.[0] ?? '')
  )
    return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[3] <= caption.rect[1] + font * 2 &&
      rect[3] >= caption.rect[1] - Math.max(font * 24, 180) &&
      rect[2] - rect[0] >= font * 0.45 &&
      rect[2] - rect[0] <= font * 3.5 &&
      rect[3] - rect[1] >= font * 1.5
  )
  if (paths.length < 10) return
  const baselineCandidates = paths.map((rect) => rect[3]).sort((a, b) => a - b)
  const baseline = baselineCandidates[Math.floor(baselineCandidates.length * 0.75)]
  const bars = paths.filter(
    (rect) => Math.abs(rect[3] - baseline) <= font * 0.6 && rect[3] - rect[1] >= font * 2
  )
  if (bars.length < 10) return
  const centers = bars.map((rect) => (rect[0] + rect[2]) / 2).sort((a, b) => a - b)
  const clusters = []
  for (const center of centers) {
    const current = clusters.at(-1)
    if (!current || center - current.at(-1) > font * 1.5) clusters.push([center])
    else current.push(center)
  }
  const panelClusters = clusters.filter((cluster) => cluster.length >= 5)
  if (!panelClusters.length) return
  const panels = panelClusters.map((cluster) => [
    cluster[0] - font * 2,
    Math.min(
      ...bars
        .filter((rect) => cluster.some((center) => center >= rect[0] && center <= rect[2]))
        .map((rect) => rect[1])
    ) -
      font * 2,
    cluster.at(-1) + font * 2,
    baseline + font * 0.5
  ])
  const bounds = union(panels)
  // A later caption must not reuse a complete bar band that belongs to an
  // earlier figure. This is common on pages where the next figure is a
  // workflow assembled immediately below the previous chart. Treat the
  // intervening caption as an ownership barrier before accepting the bars.
  if (
    captions.some(
      (other) =>
        other !== caption &&
        other.page === caption.page &&
        other.rect[1] > bounds[1] + font &&
        other.rect[3] < caption.rect[1] - font &&
        intersection(other.rect, bounds) > 0
    )
  )
    return
  if (bounds[2] - bounds[0] < font * 12 || bounds[3] - bounds[1] < font * 6) return
  const meaningfulOverlap = (a, b) =>
    Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > font * 2 &&
    Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > font * 0.5
  if (
    tables.some((table) => meaningfulOverlap(table, bounds)) ||
    captions.some((other) => other !== caption && meaningfulOverlap(other.rect, bounds))
  )
    return
  const labels = page.lines.filter(
    (line) =>
      line.text.trim() &&
      line.text.length < 80 &&
      line.fontSize <= font * 1.2 &&
      !/^(?:table|tab\.)\s+/i.test(line.text.trim()) &&
      line.y + line.height >= bounds[1] - font * 2 &&
      line.y <= caption.rect[1] + font * 2 &&
      line.x >= bounds[0] - font &&
      line.x + line.width <= bounds[2] + font &&
      intersection(caption.rect, lineRect(line)) === 0 &&
      !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
  )
  if (labels.length < panelClusters.length) return
  const rect = union([
    bounds,
    ...paths.filter((path) => intersection(path, bounds) > 0),
    ...labels.map(lineRect)
  ])
  const horizontalOverlap = Math.max(
    0,
    Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
  )
  if (horizontalOverlap / Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) < 0.5)
    return
  return {
    caption,
    rect,
    graphicsCount: bars.length,
    reason: 'native-vector-bar-panels'
  }
}

// A full-width plate may combine a raster grid on the left with native-vector
// plots on the right. Keep this recovery strict: the raster side must have at
// least two aligned rows, and the adjacent vector cluster must be substantial
// and vertically aligned with the same caption. The union is deliberately
// limited to the right-hand cluster so unrelated page rules cannot widen it.
export function nativeCaptionedRasterVectorCompositeGrid(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter((rect) => {
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    return (
      rect[3] <= caption.rect[1] &&
      rect[1] >= page.height * 0.04 &&
      width >= font * 3 &&
      height >= font * 3 &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0) &&
      !tables.some((table) => intersection(table, rect) > 0)
    )
  })
  if (images.length < 8) return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const height = rect[3] - rect[1]
    const row = rows.find(
      ({ anchor, rowHeight }) =>
        Math.abs(anchor - rect[1]) <= Math.max(font * 2, rowHeight, height) * 0.3
    )
    if (row) {
      row.rects.push(rect)
      row.rowHeight = Math.max(row.rowHeight, height)
    } else rows.push({ anchor: rect[1], rowHeight: height, rects: [rect] })
  }
  if (rows.length < 2 || rows.filter(({ rects }) => rects.length >= 3).length < 2) return
  const rasterBounds = union(images)
  const rightPaths = graphics(page, 'path').filter(
    (rect) =>
      rect[0] >= rasterBounds[2] - font * 2 &&
      rect[1] <= rasterBounds[3] + font * 2 &&
      rect[3] >= rasterBounds[1] - font * 2 &&
      rect[3] <= caption.rect[1] + font * 2 &&
      rect[2] > rect[0] &&
      rect[3] > rect[1]
  )
  if (rightPaths.length < 20) return
  const vectorBounds = union(rightPaths)
  if (
    vectorBounds[2] - vectorBounds[0] < page.width * 0.2 ||
    vectorBounds[3] - vectorBounds[1] < (rasterBounds[3] - rasterBounds[1]) * 0.45
  )
    return
  const bounds = union([rasterBounds, vectorBounds])
  const gap = caption.rect[1] - bounds[3]
  if (gap < -font * 2 || gap > Math.max(font * 5, 40)) return
  const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
  if (overlap < (bounds[2] - bounds[0]) * 0.7) return
  if (blocked(bounds, caption, captions, tables)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: images.length + rightPaths.length,
    reason: 'native-raster-vector-composite-grid'
  }
}

// A qualitative plate may contain one or two raster panels followed by native
// vector plots.  The raster-grid matcher intentionally requires many images,
// while the workflow matcher requires a preceding caption; both miss this
// compact, self-contained strip.  Keep the fallback narrow: every graphic
// must occupy one band immediately above the caption, the vector side must be
// substantial, and no table or competing caption may cross the union.
export function nativeCaptionedRasterVectorStrip(
  page,
  caption,
  captions,
  tables,
  ownedRasters = []
) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)\s+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter(
    (rect) =>
      rect[3] <= caption.rect[1] + font * 2 &&
      // A stacked workflow can place its first raster row well above the
      // caption while vector score panels fill the intervening band.
      caption.rect[1] - rect[3] <= Math.max(font * 24, 160) &&
      area(rect) >= page.width * page.height * 0.001 &&
      !tables.some((table) => intersection(table, rect) > 0) &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
  )
  if (images.length < 1 || images.length > 4) return
  // A neighboring caption can own a complete raster column even though its
  // legend is below this vector chart. A horizontal caption overlap with the
  // union is insufficient evidence for lending those already assigned panels.
  if (
    images.some((image) =>
      ownedRasters.some((owner) => intersection(owner, image) / area(image) > 0.95)
    )
  )
    return
  const imageBounds = union(images)
  const text = caption.lines.join(' ')
  const keyedRows =
    images.length === 3 &&
    /\(Top\)/.test(text) &&
    /\(Bottom\)/.test(text) &&
    [...new Set([...text.matchAll(/\(([a-z])\)/g)].map((m) => m[1]))].join('') === 'abc' &&
    images.every(
      (r) =>
        Math.abs(r[1] - images[0][1]) < font &&
        Math.abs(r[3] - images[0][3]) < font &&
        (r[2] - r[0]) / (images[0][2] - images[0][0]) > 0.8 &&
        (r[2] - r[0]) / (images[0][2] - images[0][0]) < 1.25 &&
        page.lines.filter(
          (l) =>
            /^[\p{L}\d]+$/u.test(l.text.trim()) &&
            l.fontSize > 0 &&
            l.fontSize <= font &&
            l.height <= font * 1.3 &&
            l.x >= r[0] - font &&
            l.x + l.width <= r[2] + font &&
            l.y >= imageBounds[1] - font * 8 &&
            l.y + l.height < imageBounds[1]
        ).length >= 2
    ) &&
    !page.lines.some(
      (l) =>
        l.text.length >= 60 && l.y >= imageBounds[1] - font * 8 && l.y + l.height < imageBounds[1]
    )
  const minY = imageBounds[1] - Math.max(font * (keyedRows ? 8 : 6), 30)
  let paths = graphics(page, 'path').filter(
    (rect) =>
      rect[1] >= minY &&
      // Quantized outlines may graze the caption band; long wrapped captions
      // are clipped to their first line below, while short captions retain
      // the one-point closing-rule tolerance.
      rect[3] <= caption.rect[1] + font * 2 &&
      rect[2] > rect[0] &&
      rect[3] > rect[1] &&
      !tables.some((table) => intersection(table, rect) > 0)
  )
  // Facing captions can own independent plates at the same height. A raster
  // inset in one column does not lend that owner the other column's vector
  // chart. Require both narrow caption columns, isolated native raster ink,
  // and a substantial path wholly inside the neighboring caption column.
  const edge = Math.max(font * 0.5, page.width / 128)
  const neighbors = captions.filter((other) => {
    if (
      other === caption ||
      other.page !== caption.page ||
      caption.rect[2] - caption.rect[0] > page.width * 0.5 ||
      other.rect[2] - other.rect[0] > page.width * 0.5 ||
      Math.abs(other.rect[1] - caption.rect[1]) > font * 2 ||
      !/^(?:figure|fig\.?)[ \t]+/i.test(other.lines?.[0] ?? '')
    )
      return false
    const gap = Math.max(other.rect[0] - caption.rect[2], caption.rect[0] - other.rect[2])
    return (
      gap > 0 &&
      gap <= page.width * 0.06 &&
      imageBounds[0] >= caption.rect[0] - edge &&
      imageBounds[2] <= caption.rect[2] + edge &&
      paths.some(
        (rect) =>
          rect[0] >= other.rect[0] - edge &&
          rect[2] <= other.rect[2] + edge &&
          area(rect) >= page.width * page.height * 0.01
      )
    )
  })
  if (neighbors.length === 1) {
    const other = neighbors[0]
    const right = other.rect[0] > caption.rect[2]
    const gutter = right
      ? (caption.rect[2] + other.rect[0]) / 2
      : (other.rect[2] + caption.rect[0]) / 2
    // A path spanning the gutter is evidence of a shared full-width plate.
    if (!paths.some((rect) => rect[0] < gutter - edge && rect[2] > gutter + edge))
      paths = paths.filter((rect) => (right ? rect[2] < gutter : rect[0] > gutter))
  }
  if (paths.length < 12) return
  const pathBounds = union(paths)
  const bounds = union([imageBounds, pathBounds])
  // Long wrapped captions have a broad caption band; outlined marks that
  // graze its first line are page furniture. Keep the short-caption contract
  // (where a one-point closing rule may overlap the caption band) unchanged.
  const longCaption =
    caption.rect[3] - caption.rect[1] > Math.max(font * 8, 48) || caption.lines.length > 3
  const boundaryMarks = paths.filter(
    (rect) =>
      rect[3] > caption.rect[1] - Math.max(2, font * 0.35) &&
      rect[3] <= caption.rect[1] + font * 2 &&
      rect[1] >= caption.rect[1] - Math.max(font * 4, 32) &&
      rect[2] - rect[0] <= Math.max(12, font * 1.5) &&
      rect[3] - rect[1] <= Math.max(32, font * 4)
  )
  const cropBounds = longCaption
    ? [
        bounds[0],
        bounds[1],
        bounds[2],
        Math.min(
          bounds[3],
          caption.rect[1] - (boundaryMarks.length >= 2 ? 1 : Math.max(4, font * 0.6))
        )
      ]
    : bounds
  if (cropBounds[2] - cropBounds[0] < page.width * 0.45 || cropBounds[3] - cropBounds[1] < font * 8)
    return
  const gap = caption.rect[1] - cropBounds[3]
  if (gap < -font * 2 || gap > Math.max(font * 5, 36)) return
  const captionOverlap =
    Math.min(cropBounds[2], caption.rect[2]) - Math.max(cropBounds[0], caption.rect[0])
  if (captionOverlap < (caption.rect[2] - caption.rect[0]) * 0.65) return
  if (blocked(cropBounds, caption, captions, tables)) return
  return {
    caption,
    rect: cropBounds,
    graphicsCount: images.length + paths.length,
    reason: 'native-raster-vector-strip'
  }
}

// A workflow plate can have only two raster endpoints with a dense vector
// pipeline between them. Require a preceding figure caption barrier and use
// only graphics after that caption, preventing reuse of the prior chart band.
export function nativeCaptionedMixedWorkflowPanel(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  const prior = captions
    .filter(
      (other) =>
        other !== caption &&
        other.page === caption.page &&
        other.rect[3] < caption.rect[1] - font * 6 &&
        intersection(other.rect, [0, 0, page.width, page.height]) > 0
    )
    .sort((a, b) => b.rect[3] - a.rect[3])[0]
  if (!prior) return
  const lower = prior.rect[3] + Math.max(font * 0.5, 3)
  const images = graphics(page, 'image').filter(
    (rect) =>
      rect[1] >= lower &&
      rect[3] <= caption.rect[1] + font * 2 &&
      area(rect) >= page.width * page.height * 0.004 &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0) &&
      !tables.some((table) => intersection(table, rect) > 0)
  )
  if (images.length !== 2) return
  const imageBounds = union(images)
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[1] >= lower &&
      rect[3] <= caption.rect[1] + font * 2 &&
      rect[2] > rect[0] &&
      rect[3] > rect[1] &&
      !tables.some((table) => intersection(table, rect) > 0)
  )
  if (paths.length < 20) return
  const pathBounds = union(paths)
  const bounds = union([imageBounds, pathBounds])
  if (bounds[2] - bounds[0] < page.width * 0.65 || bounds[3] - bounds[1] < font * 8) return
  const gap = caption.rect[1] - bounds[3]
  if (gap < -font * 2 || gap > Math.max(font * 4, 32)) return
  if (blocked(bounds, caption, captions, tables)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: images.length + paths.length,
    reason: 'native-mixed-workflow-panel'
  }
}

// Some papers draw a small table diagram entirely with independent vector
// rules.  It has no outer frame and therefore falls through the ordinary
// vector-figure matchers.  Recover only a tight grid immediately above a
// numbered figure caption: repeated horizontal and vertical rule families,
// multiple row/column centers, and text inside the grid together distinguish
// it from axes, bars, and paragraph rules.
export function nativeCaptionedVectorTableGrid(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[3] <= caption.rect[1] + 1 &&
      caption.rect[1] - rect[3] <= Math.max(font * 10, 72) &&
      rect[2] > rect[0] &&
      rect[3] > rect[1]
  )
  if (paths.length < 12) return
  const horizontal = paths.filter(
    (rect) => rect[2] - rect[0] >= font * 3 && rect[3] - rect[1] <= font * 1.5
  )
  const vertical = paths.filter(
    (rect) => rect[3] - rect[1] >= font * 1.5 && rect[2] - rect[0] <= font * 1.5
  )
  if (horizontal.length < 3 || vertical.length < 4) return
  const bounds = union(paths)
  const width = bounds[2] - bounds[0]
  const height = bounds[3] - bounds[1]
  if (width < font * 10 || height < font * 3 || width > page.width * 0.8) return
  const longHorizontal = horizontal.filter(
    (rect) => rect[2] - rect[0] >= Math.max(font * 6, width * 0.6)
  )
  if (longHorizontal.length < 2) return
  const horizontalSpan =
    Math.min(...longHorizontal.map((rect) => rect[2])) -
    Math.max(...longHorizontal.map((rect) => rect[0]))
  if (horizontalSpan < width * 0.55) return
  const rowCenters = []
  for (const rect of horizontal.slice().sort((a, b) => a[1] - b[1])) {
    const center = (rect[1] + rect[3]) / 2
    const previous = rowCenters.at(-1)
    if (previous === undefined || center - previous > Math.max(font * 0.75, 4))
      rowCenters.push(center)
    else rowCenters[rowCenters.length - 1] = (previous + center) / 2
  }
  const columnCenters = []
  for (const rect of vertical.slice().sort((a, b) => a[0] - b[0])) {
    const center = (rect[0] + rect[2]) / 2
    const previous = columnCenters.at(-1)
    if (previous === undefined || center - previous > Math.max(font * 0.75, 4))
      columnCenters.push(center)
    else columnCenters[columnCenters.length - 1] = (previous + center) / 2
  }
  if (rowCenters.length < 3 || columnCenters.length < 4) return
  const repeatedVerticals = columnCenters.filter(
    (column) =>
      vertical.filter(
        (rect) => Math.abs((rect[0] + rect[2]) / 2 - column) <= Math.max(font * 0.75, 4)
      ).length >= 2
  )
  if (repeatedVerticals.length < 4) return
  if (blocked(bounds, caption, captions, tables)) return
  const textInside = page.lines.some(
    (line) =>
      line.text?.trim() &&
      contains(bounds, lineRect(line), Math.max(font * 0.8, 2)) &&
      !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
  )
  if (!textInside) return
  const gap = caption.rect[1] - bounds[3]
  if (gap < 0 || gap > Math.max(font * 3, 24)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: paths.length,
    reason: 'native-vector-table-grid'
  }
}

// A four-panel heatmap can be encoded entirely as native vector cell paths,
// so there is no image witness for the ordinary figure pass.  Keep recovery
// narrow: the caption must name success rates/trajectory lengths, the paths
// must form a dense multi-row grid immediately above it, and no table or
// competing caption may intersect the band.
export function nativeCaptionedVectorHeatmap(page, caption, captions, tables) {
  const text = caption.lines.join(' ')
  if (
    !/^figure\s+\d+\s*:/i.test(text) ||
    !/success\s+rates?/i.test(text) ||
    !/trajectory\s+lengths?/i.test(text)
  )
    return undefined
  const font = captionFont(page, caption)
  const paths = graphics(page, 'path').filter(
    (rect) =>
      rect[3] <= caption.rect[1] && rect[0] >= page.width * 0.08 && rect[2] <= page.width * 0.92
  )
  if (paths.length < 24) return undefined

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const gapX = Math.max(font * 1.5, median(paths.map((rect) => rect[2] - rect[0])) * 0.4)
  const gapY = Math.max(font * 1.5, median(paths.map((rect) => rect[3] - rect[1])) * 0.4)
  const touches = (a, b) => {
    const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
    const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    const horizontalGap = Math.max(b[0] - a[2], a[0] - b[2], 0)
    const verticalGap = Math.max(b[1] - a[3], a[1] - b[3], 0)
    return (overlapX > 0 && verticalGap <= gapY) || (overlapY > 0 && horizontalGap <= gapX)
  }
  const components = []
  const pending = new Set(paths.keys())
  while (pending.size > 0) {
    const seed = pending.values().next().value
    pending.delete(seed)
    const component = [paths[seed]]
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()
      for (const candidate of [...pending]) {
        if (!touches(paths[current], paths[candidate])) continue
        pending.delete(candidate)
        queue.push(candidate)
        component.push(paths[candidate])
      }
    }
    components.push(component)
  }
  const candidates = components
    .filter((component) => component.length >= 24)
    .map((component) => {
      const bounds = union(component)
      const rowCenters = [
        ...new Set(component.map((rect) => Math.round((rect[1] + rect[3]) / 2 / 4)))
      ]
      const columnCenters = [
        ...new Set(component.map((rect) => Math.round((rect[0] + rect[2]) / 2 / 8)))
      ]
      return { component, bounds, rowCenters, columnCenters }
    })
    .filter(({ bounds, rowCenters, columnCenters }) => {
      if (caption.rect[1] - bounds[3] > Math.max(28, font * 4)) return false
      if (blocked(bounds, caption, captions, tables)) return false
      if (bounds[2] - bounds[0] < page.width * 0.55 || bounds[3] - bounds[1] < page.height * 0.12)
        return false
      return rowCenters.length >= 4 && columnCenters.length >= 4
    })
  if (candidates.length !== 1) return undefined
  const { component, bounds } = candidates[0]
  return { caption, rect: bounds, graphicsCount: component.length, reason: 'native-vector-heatmap' }
}

// Workflow screenshots are a native composite: raster panels are connected
// by arrows and small labels, with the caption below the whole plate.  Require
// several image panels in two rows plus a broad path component spanning them;
// this prevents ordinary screenshot prose or a single image from widening a
// crop merely by proximity.
export function nativeCaptionedWorkflowPanel(page, caption, captions, tables) {
  if (!/execution\s+trajectory/i.test(caption.lines.join(' '))) return undefined
  const toRect = (graphic) => {
    const source = graphic?.paintedNormalizedRect ?? graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map(toRect)
    .filter((rect) => rect && rect[3] < caption.rect[1] && rect[1] > page.height * 0.04)
  if (images.length < 6) return undefined
  const imageBounds = union(images)
  if (
    imageBounds[2] - imageBounds[0] < page.width * 0.62 ||
    caption.rect[1] - imageBounds[3] > Math.max(32, captionFont(page, caption) * 5)
  )
    return undefined
  const rows = [...new Set(images.map((rect) => Math.round((rect[1] + rect[3]) / 2 / 12)))]
  if (rows.length < 2) return undefined
  const paths = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .filter((rect) => rect && intersection(rect, imageBounds) > 0)
  const spanningPath = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map(toRect)
    .find(
      (rect) =>
        rect &&
        rect[0] <= imageBounds[0] + 8 &&
        rect[2] >= imageBounds[2] - 8 &&
        rect[1] <= imageBounds[1] + 8 &&
        rect[3] >= imageBounds[3] - 8
    )
  if (!spanningPath || blocked(union([imageBounds, ...paths]), caption, captions, tables))
    return undefined
  const rect = union([imageBounds, spanningPath, ...paths])
  return {
    caption,
    rect,
    graphicsCount: images.length + paths.length,
    reason: 'native-workflow-panel'
  }
}

// A full-width raster can sit directly above its caption while unrelated
// graphics continue below the caption in a second figure/table region. The
// ordinary raster matcher conservatively defers when those directions compete.
// Recover only the upper image when it is broad, uniquely adjacent, and free
// of overlaid vector ink; the caption itself remains the ownership boundary.
export function nativeCaptionedRasterFullWidth(page, caption, captions, tables) {
  if (!/^(?:figure|fig\.?)\s+/i.test(caption.lines?.[0] ?? '')) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  // A side caption displaced from its neighboring raster makes the page
  // direction ambiguous. Defer both plates to the conservative association
  // pass instead of letting this shortcut claim one by proximity.
  const sideCaptionDisplaced = captions.some((other) => {
    if (other === caption) return false
    return (page.graphicsBounds ?? []).some((graphic) => {
      if (graphic.kind !== 'image' || !graphic.normalizedRect?.every(Number.isFinite)) return false
      const rect = graphic.normalizedRect.map(
        (value, index) => value * (index % 2 ? page.height : page.width)
      )
      const gap = other.rect[0] - rect[2]
      const overlap =
        Math.max(0, Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])) /
        Math.max(1, Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]))
      return (
        gap >= 0 &&
        gap <= Math.max(12, font * 2) &&
        rect[1] >= caption.rect[3] - Math.max(12, font * 2) &&
        overlap >= 0.25 &&
        Math.abs(rect[1] - other.rect[1]) > Math.max(6, font * 0.9) &&
        Math.min(rect[3], other.rect[3]) - Math.max(rect[1], other.rect[1]) >
          Math.min(rect[3] - rect[1], other.rect[3] - other.rect[1]) * 0.35
      )
    })
  })
  if (sideCaptionDisplaced) return
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => {
      const source = graphic.paintedNormalizedRect ?? graphic.normalizedRect
      return source?.every(Number.isFinite)
        ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
        : undefined
    })
    .filter(Boolean)
    .filter((rect) => {
      const width = rect[2] - rect[0]
      const height = rect[3] - rect[1]
      const gap = caption.rect[1] - rect[3]
      const overlap = Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
      const captionWidth = caption.rect[2] - caption.rect[0]
      const captionCenter = (caption.rect[0] + caption.rect[2]) / 2
      return (
        width >= page.width * 0.65 &&
        height >= font * 8 &&
        gap >= 0 &&
        gap <= Math.max(8, font * 1.5) &&
        overlap >= Math.min(width * 0.65, captionWidth * 0.8) &&
        captionCenter >= rect[0] &&
        captionCenter <= rect[2] &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
  if (images.length !== 1) return
  let rect = images[0]
  const headerPlate = connectedUpperRasterPanel(page, rect, caption, captions, tables, font)
  if (headerPlate) rect = union([rect, headerPlate])
  const paths = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => {
      const source = graphic.paintedNormalizedRect ?? graphic.normalizedRect
      return source?.every(Number.isFinite)
        ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
        : undefined
    })
    .filter(Boolean)
  if (paths.some((path) => intersection(path, rect) > 0)) return
  return {
    caption,
    rect,
    graphicsCount: headerPlate ? 2 : 1,
    reason: 'native-raster-full-width'
  }
}

// A single raster chart can sit immediately above a narrow-column caption
// while a second multi-panel figure occupies the lower half of the page. The
// ordinary adjacency pass can see both directions and conservatively defer;
// accept only a unique, tightly attached raster with no competing caption.
export function nativeCaptionedRaster(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  // Leave a raster/vector plate to the general association pass when a path
  // touches the candidate image/caption or sits in the immediately preceding
  // figure band. Unrelated paths elsewhere on the page (for example a listing
  // below a wide chart) must not suppress an otherwise unique crop.
  const paths = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        : undefined
    )
    .filter(Boolean)
  const nearby = (a, b, tolerance = Math.max(2, font * 1.5)) =>
    intersection([a[0] - tolerance, a[1] - tolerance, a[2] + tolerance, a[3] + tolerance], b) > 0
  // A neighboring side caption normally shares the top baseline of its raster.
  // If that caption is vertically displaced, the two plates are ambiguous;
  // defer ownership rather than letting the upper raster claim the whole page.
  const sideCaptionDisplaced = captions.some((other) => {
    if (other === caption) return false
    return (page.graphicsBounds ?? []).some((graphic) => {
      if (graphic.kind !== 'image' || !graphic.normalizedRect?.every(Number.isFinite)) return false
      const rect = graphic.normalizedRect.map(
        (value, index) => value * (index % 2 ? page.height : page.width)
      )
      const gap = other.rect[0] - rect[2]
      const horizontalOverlap =
        Math.max(0, Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])) /
        Math.max(1, Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]))
      return (
        gap >= 0 &&
        gap <= Math.max(12, font * 2) &&
        rect[1] >= caption.rect[3] - Math.max(12, font * 2) &&
        horizontalOverlap >= 0.25 &&
        Math.abs(rect[1] - other.rect[1]) > Math.max(6, font * 0.9) &&
        Math.min(rect[3], other.rect[3]) - Math.max(rect[1], other.rect[1]) >
          Math.min(rect[3] - rect[1], other.rect[3] - other.rect[1]) * 0.35
      )
    })
  })
  if (sideCaptionDisplaced) return
  const candidates = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? { rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)) }
        : undefined
    )
    .filter(Boolean)
    .filter(({ rect }) => {
      const overlap = Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
      const gap = caption.rect[1] - rect[3]
      // A detached vector panel in the vertical band between the raster and
      // its caption belongs to the same composite figure. Keep the generic
      // association pass in charge so it can join that panel instead of
      // letting this narrow raster shortcut steal the caption.
      const pathInFigureBand = paths.some(
        (path) =>
          path[1] < caption.rect[1] &&
          path[3] <= rect[1] &&
          rect[1] - path[3] <= Math.max(24, page.height * 0.2)
      )
      return (
        rect[2] - rect[0] >= font * 8 &&
        rect[3] - rect[1] >= font * 8 &&
        gap >= 0 &&
        gap <= Math.max(8, font * 2) &&
        overlap >= Math.min(rect[2] - rect[0], caption.rect[2] - caption.rect[0]) * 0.2 &&
        !pathInFigureBand &&
        !paths.some((path) => nearby(rect, path) || nearby(caption.rect, path)) &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
  if (candidates.length !== 1) return
  let rect = candidates[0].rect
  const headerPlate = connectedUpperRasterPanel(page, rect, caption, captions, tables, font)
  if (headerPlate) rect = union([rect, headerPlate])
  return { caption, rect, graphicsCount: headerPlate ? 2 : 1 }
}

// A single composite raster in a narrow column can have a larger typesetting
// gap before its caption than the ordinary raster shortcut allows. Keep this
// fallback stricter than the normal matcher: require one image, at least 80%
// horizontal overlap, and no competing graphics, tables, or captions.
export function nativeCaptionedRasterModerateGap(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) =>
      g.normalizedRect?.every(Number.isFinite)
        ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
        : undefined
    )
    .filter(Boolean)
  const allImages = (page.graphicsBounds ?? []).filter(
    (g) => g.kind === 'image' && g.normalizedRect?.every(Number.isFinite)
  )
  if (allImages.length !== 1) return
  const images = allImages
    .map((g) => ({ rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)) }))
    .filter(({ rect }) => {
      const overlap = Math.min(rect[2], caption.rect[2]) - Math.max(rect[0], caption.rect[0])
      const gap = caption.rect[1] - rect[3]
      const width = rect[2] - rect[0]
      const height = rect[3] - rect[1]
      const pathInBand = paths.some(
        (path) =>
          path[1] < caption.rect[1] &&
          path[3] <= rect[1] &&
          rect[1] - path[3] <= Math.max(24, page.height * 0.2)
      )
      return (
        width >= font * 8 &&
        height >= font * 8 &&
        gap >= 0 &&
        gap <= Math.max(24, font * 3) &&
        overlap >= width * 0.8 &&
        !pathInBand &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
  if (images.length !== 1 || paths.some((path) => intersection(path, images[0].rect) > 0)) return
  return { caption, rect: images[0].rect, graphicsCount: 1, reason: 'native-raster-moderate-gap' }
}

// Some publishers paint a raster plate and its border as separate image/path
// operations. On stacked pages the ordinary adjacency pass sees both plates
// and declines the caption. Recover only one uniquely nearest framed image;
// never widen the crop to include a neighbouring plate.
export function nativeCaptionedFramedRaster(page, caption, captions, tables) {
  // Decimal continuation labels (for example Figure 4.1) commonly annotate
  // the preceding plate rather than introduce a new graphic. Leave those to
  // the established panel recognizer so the strict recovery cannot steal a
  // neighboring stacked image.
  if (/\b(?:Figure|Fig\.?)[ \t]+\d+\.\d+\b/i.test(caption.lines?.[0] ?? '')) return
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => ({ rect: toRect(graphic) }))
    .filter(({ rect }) => rect && area(rect) >= page.width * page.height * 0.01)
  const frames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => ({ rect: toRect(graphic) }))
    .filter(({ rect }) => rect && area(rect) > 0)
  const frameTolerance = Math.max(8, page.width * 0.025, page.height * 0.04)
  const overlapRatio = (a, b) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) /
    Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]))
  const candidates = images
    .map(({ rect }) => {
      const frame = frames.find(
        ({ rect: candidate }) =>
          candidate &&
          overlapRatio(candidate, rect) >= 0.96 &&
          Math.abs(candidate[0] - rect[0]) <= frameTolerance &&
          Math.abs(candidate[1] - rect[1]) <= frameTolerance &&
          Math.abs(candidate[2] - rect[2]) <= frameTolerance &&
          Math.abs(candidate[3] - rect[3]) <= frameTolerance
      )
      if (!frame) return undefined
      // Painted image bounds can be inset from the publisher's border by
      // several pixels. Use the matched frame for ownership and crop gaps so
      // a caption immediately below the border is not stolen by a lower plate.
      const cropRect = frame.rect ?? rect
      const enclosingFrame = frames.some(({ rect: outer }) => {
        if (!outer || outer === cropRect || area(outer) < area(cropRect) * 2) return false
        const containsCrop =
          outer[0] <= cropRect[0] + 2 &&
          outer[1] <= cropRect[1] + 2 &&
          outer[2] >= cropRect[2] - 2 &&
          outer[3] >= cropRect[3] - 2
        const captionGap = caption.rect[1] - outer[3]
        return containsCrop && captionGap >= 0 && captionGap <= 24
      })
      // A bordered inset inside a larger composite plate belongs to the outer
      // figure. Let the enclosing-frame matcher claim the full workflow so a
      // single raster panel cannot truncate the crop.
      if (enclosingFrame) return undefined
      if (overlapRatio(cropRect, caption.rect) < 0.8) return undefined
      const aboveGap = caption.rect[1] - cropRect[3]
      const belowGap = cropRect[1] - caption.rect[3]
      const direction =
        aboveGap >= 0 && aboveGap <= 24
          ? 'above'
          : belowGap >= 0 && belowGap <= 24
            ? 'below'
            : undefined
      if (!direction) return undefined
      // A caption below an image is usually the trailing caption for the
      // preceding plate. If another caption is already immediately above that
      // same image, keep the ownership with the preceding caption and avoid
      // assigning the image twice on stacked pages.
      if (
        aboveGap >= 0 &&
        captions.some(
          (other) =>
            other !== caption &&
            other.rect[3] <= cropRect[1] &&
            cropRect[1] - other.rect[3] <= 24 &&
            overlapRatio(other.rect, cropRect) >= 0.8
        )
      )
        return undefined
      if (
        tables.some((table) => intersection(table, cropRect) > 0) ||
        captions.some((other) => other !== caption && intersection(other.rect, cropRect) > 0)
      )
        return undefined
      return {
        rect: cropRect,
        direction,
        gap: direction === 'above' ? aboveGap : belowGap
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.gap - b.gap)
  // When a caption sits between two stacked plates, its preceding plate is
  // the stronger ownership signal: the following plate commonly belongs to
  // the next caption on the next page. Prefer the unique above candidate;
  // otherwise require exactly one below candidate.
  const above = candidates.filter((candidate) => candidate.direction === 'above')
  const below = candidates.filter((candidate) => candidate.direction === 'below')
  const selected = above.length ? above : below
  if (selected.length !== 1) return undefined
  return { caption, rect: selected[0].rect, graphicsCount: 1 }
}

// UI-style examples can place a raster image beside a prompt/response panel
// inside one outer frame. The frame is the figure boundary even though the
// raster does not share that boundary and the panel uses the same body font
// as the caption. Accept only one enclosing frame with a substantial raster,
// a caption directly below it, and no table or competing caption overlap.
export function nativeCaptionedFramedRasterTextPanel(page, caption, captions, tables) {
  const toRect = (graphic) => {
    const source = graphic?.normalizedRect
    return source?.every(Number.isFinite)
      ? source.map((value, index) => value * (index % 2 ? page.height : page.width))
      : undefined
  }
  const contains = (outer, inner, tolerance = 2) =>
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  const rawFrames = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'path')
    .map((graphic) => toRect(graphic))
    .filter((rect) => rect && area(rect) >= page.width * page.height * 0.04)
  const frameGroups = []
  for (const frame of rawFrames.sort((a, b) => a[1] - b[1])) {
    const group = frameGroups.find((candidate) => {
      const horizontal =
        Math.max(0, Math.min(candidate.rect[2], frame[2]) - Math.max(candidate.rect[0], frame[0])) /
        Math.max(1, Math.min(candidate.rect[2] - candidate.rect[0], frame[2] - frame[0]))
      const verticalGap =
        Math.max(candidate.rect[1], frame[1]) - Math.min(candidate.rect[3], frame[3])
      return horizontal >= 0.9 && verticalGap <= 8
    })
    if (group) group.rect = union([group.rect, frame])
    else frameGroups.push({ rect: frame.slice() })
  }
  const frames = frameGroups.map(({ rect }) => rect)
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) => toRect(graphic))
    .filter((rect) => rect && area(rect) >= page.width * page.height * 0.01)
  const candidates = frames
    .map((frame) => {
      if (caption.rect[1] - frame[3] < 0 || caption.rect[1] - frame[3] > 24) return undefined
      if (
        tables.some((table) => intersection(table, frame) > 0) ||
        captions.some((other) => other !== caption && intersection(other.rect, frame) > 0)
      )
        return undefined
      const enclosedImages = images.filter((image) => contains(frame, image))
      if (enclosedImages.length < 1 || enclosedImages.length > 4) return undefined
      if (enclosedImages.reduce((total, image) => total + area(image), 0) < area(frame) * 0.1)
        return undefined
      const panelLines = (page.lines ?? []).filter(
        (line) => line.text?.trim() && contains(frame, lineRect(line), 1)
      )
      if (panelLines.length < 2) return undefined
      return {
        frame,
        imageKey: enclosedImages
          .map((image) => image.join(','))
          .sort()
          .join('|'),
        gap: caption.rect[1] - frame[3]
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.gap - b.gap)
  const imageKeys = new Set(candidates.map((candidate) => candidate.imageKey))
  if (imageKeys.size === 1 && candidates.length > 1) {
    candidates.sort((a, b) => area(b.frame) - area(a.frame))
  }
  if (imageKeys.size !== 1 || candidates.length < 1) return undefined
  return { caption, rect: candidates[0].frame, graphicsCount: 1 }
}

// Explicit sequential caption keys must each match one raster and its own
// physically attached source key. Caption centering cannot define plate width.
export function nativeLetteredRasterArray(page, caption, captions, tables, tokens) {
  const keys = [...caption.lines.join(' ').matchAll(/\(([a-z])\)/g)].map((m) => m[1])
  const font = captionFont(page, caption)
  if (
    keys.length < 3 ||
    keys.length > 12 ||
    !(font > 0) ||
    !Number.isFinite(font) ||
    new Set(keys).size !== keys.length ||
    keys.some((k, i) => k.charCodeAt(0) !== 97 + i)
  )
    return
  const source = tokens.filter(
    (t) => t.horizontal && t.rect?.every(Number.isFinite) && area(t.rect) > 0
  )
  const labels = source
    .filter((t) => /^\([a-z]\)$/.test(t.text.trim()))
    .map((t) => ({ key: t.text.trim()[1], rect: t.rect }))
  for (const t of source.filter((t) => /^[a-z]$/.test(t.text.trim()))) {
    const adjacent = (p, left) =>
      Math.abs(p.baseline - t.baseline) < font * 0.05 &&
      Math.abs(p.height - t.height) < font * 0.05 &&
      Math.abs(left ? t.rect[0] - p.rect[2] : p.rect[0] - t.rect[2]) < font * 0.05
    const open = source.filter((p) => p.text === '(' && adjacent(p, true))
    const close = source.filter((p) => p.text === ')' && adjacent(p, false))
    if (open.length === 1 && close.length === 1)
      labels.push({ key: t.text.trim(), rect: union([open[0].rect, t.rect, close[0].rect]) })
  }
  const images = graphics(page, 'image').filter(
    (r) => r[3] < caption.rect[1] && r[2] - r[0] > font * 4 && r[3] - r[1] > font * 4
  )
  const pairs = keys.map((key) => {
    const attached = labels
      .filter((t) => t.key === key && t.rect[3] < caption.rect[1])
      .flatMap((t) =>
        images
          .filter(
            (r) =>
              t.rect[1] >= r[3] - font * 0.3 &&
              t.rect[1] - r[3] < font * 2 &&
              t.rect[0] >= r[0] &&
              t.rect[2] <= r[2]
          )
          .map((r) => ({ label: t.rect, image: r }))
      )
    return attached.length === 1 ? attached[0] : undefined
  })
  if (
    pairs.some((p) => !p) ||
    new Set(pairs.map((p) => p.image)).size !== keys.length ||
    pairs.some((p, i) => pairs.slice(0, i).some((q) => intersection(p.image, q.image) > 0))
  )
    return
  const rect = union(pairs.flatMap((p) => [p.image, p.label]))
  if (
    caption.rect[1] - rect[3] > font * 3 ||
    blocked(rect, caption, captions, tables) ||
    source.some((t) => t.text.length >= 40 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: pairs.length }
}

// Some PDFs split a compact ``Fig.2.`` prefix away from the caption candidate
// when that prefix shares a baseline with the final raster panel. Recover this
// narrow case only when the page has one unique 2x2 raster plate and the merged
// caption proves a complete (a)-(d) sequence. The extra prefix proof keeps
// running prose references and open vector plots out of this recovery path.
export function nativeCaptionedRasterArrayFragment(page, caption, captions, tables) {
  const lines = page.lines ?? []
  const prefix = lines.find((line) => {
    if (!line?.text || /^(?:Fig(?:ure)?\s*\.?\s*\d+\.)/i.test(caption.lines?.[0] ?? ''))
      return false
    if (!/^(?:Fig(?:ure)?\s*\.?\s*\d+\.)/i.test(line.text.trim())) return false
    const font = Math.max(line.fontSize || 0, 1)
    return (
      Math.abs(line.y - caption.rect[1]) <= font * 1.2 &&
      Math.abs(line.x - caption.rect[0]) <= font * 1.2 &&
      !caption.lines.some((text) => text.trim() === line.text.trim())
    )
  })
  if (!prefix) return
  const font = Math.max(prefix.fontSize || 0, 1)
  const bandLines = lines
    .filter(
      (line) =>
        line.y >= caption.rect[1] - font * 0.5 &&
        line.y <= caption.rect[3] + font * 0.5 &&
        line.x >= caption.rect[0] - font &&
        line.x + line.width <= caption.rect[2] + font &&
        !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const text = bandLines.map((line) => line.text).join(' ')
  if (!/\(a\).*?\(b\).*?\(c\).*?\(d\)/s.test(text)) return
  let images = graphics(page, 'image').filter((rect) => {
    if (
      !rect.every(Number.isFinite) ||
      rect[2] - rect[0] < font * 4 ||
      rect[3] - rect[1] < font * 4
    )
      return false
    return (
      rect[1] < caption.rect[1] + font * 2 &&
      !tables.some((table) => intersection(table, rect) > 0) &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  })
  if (images.length !== 4) return
  const widths = images.map((rect) => rect[2] - rect[0])
  const heights = images.map((rect) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (
    widths.some((value) => Math.abs(value - width) > width * 0.25) ||
    heights.some((value) => Math.abs(value - height) > height * 0.25)
  )
    return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ rects }) => Math.abs(rects[0][1] - rect[1]) <= height * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ rects: [rect] })
  }
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 2)) return
  const centers = rows
    .flatMap(({ rects }) => rects.map((rect) => (rect[0] + rect[2]) / 2))
    .sort((a, b) => a - b)
  const columns = []
  for (const center of centers) {
    const previous = columns.at(-1)
    if (previous === undefined || center - previous > width * 0.5) columns.push(center)
    else columns[columns.length - 1] = (previous + center) / 2
  }
  if (columns.length !== 2 || columns[1] - columns[0] < width * 0.5) return
  const rect = union(images)
  if (blocked(rect, caption, captions, tables)) return
  const captionLines = bandLines.map((line) => line.text)
  const captionRect = union([caption.rect, lineRect(prefix)])
  return {
    caption,
    captionLines,
    captionRect,
    rect,
    graphicsCount: images.length
  }
}

// Some papers encode a trajectory plate as many equal raster tiles instead of
// one composite image. Require a coherent multi-row grid directly above its
// caption so decorative icons and neighboring column images cannot widen the
// figure crop by accident.
// Some papers encode a compact four-panel result plate as four independent
// raster operations while keeping the caption as an ordinary Figure line.
// Require a complete 2x2 image grid directly above that caption; this avoids
// widening a crop from a single nearby image or from an unrelated table.
export function nativeCaptionedRasterQuad(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter((rect) => {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) return false
    if (rect[3] > caption.rect[1] || rect[1] < page.height * 0.04) return false
    if (tables.some((table) => intersection(table, rect) > 0)) return false
    if (captions.some((other) => other !== caption && intersection(other.rect, rect) > 0))
      return false
    return rect[2] - rect[0] >= font * 4 && rect[3] - rect[1] >= font * 4
  })
  if (images.length !== 4) return
  const widths = images.map((rect) => rect[2] - rect[0])
  const heights = images.map((rect) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (
    widths.some((value) => Math.abs(value - width) > width * 0.25) ||
    heights.some((value) => Math.abs(value - height) > height * 0.25)
  )
    return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ anchor }) => Math.abs(anchor[1] - rect[1]) <= height * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ rects: [rect], anchor: rect })
  }
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 2)) return
  const centers = rows
    .flatMap(({ rects }) => rects.map((rect) => (rect[0] + rect[2]) / 2))
    .sort((a, b) => a - b)
  const columns = []
  for (const center of centers) {
    const previous = columns.at(-1)
    if (previous === undefined || center - previous > width * 0.45) columns.push(center)
    else columns[columns.length - 1] = (previous + center) / 2
  }
  if (columns.length !== 2 || columns[1] - columns[0] < width * 0.45) return
  const bounds = union(images)
  const gap = caption.rect[1] - bounds[3]
  if (
    gap < 0 ||
    gap > Math.max(font * 3, 24) ||
    Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0]) <
      Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.5 ||
    blocked(bounds, caption, captions, tables)
  )
    return
  return { caption, rect: bounds, graphicsCount: images.length, reason: 'native-raster-quad' }
}

// Two aligned five-panel rows can share one caption. Ten consecutive native
// panel labels and one recorded color key per panel prove the complete plate;
// a nearest-row match alone would omit the upper row and the attached ink.
function nativeLetteredTwoRowRasterPlate(page, caption, captions, tables, rows, font) {
  if (rows.length !== 2 || rows.some((row) => row.rects.length !== 5)) return
  const ordered = rows
    .slice()
    .sort((a, b) => a.anchor - b.anchor)
    .map((row) => row.rects.slice().sort((a, b) => a[0] - b[0]))
  const panels = ordered.flat()
  const width = panels[0][2] - panels[0][0]
  const height = panels[0][3] - panels[0][1]
  const edge = Math.max(font * 0.5, page.width / 128)
  if (
    panels.some(
      (rect) =>
        Math.abs(rect[2] - rect[0] - width) > width * 0.15 ||
        Math.abs(rect[3] - rect[1] - height) > height * 0.15
    ) ||
    ordered[0].some(
      (rect, i) =>
        Math.abs(rect[0] - ordered[1][i][0]) > edge || Math.abs(rect[2] - ordered[1][i][2]) > edge
    )
  )
    return
  const verticalGap = ordered[1][0][1] - ordered[0][0][3]
  if (verticalGap < font * 2 || verticalGap > height) return
  for (const row of ordered)
    if (
      row.slice(1).some((rect, i) => {
        const gap = rect[0] - row[i][2]
        return gap < font || gap > width
      })
    )
      return
  const allImages = graphics(page, 'image')
  const keys = []
  const labels = []
  for (const [index, panel] of panels.entries()) {
    const key = allImages.filter(
      (rect) =>
        Math.abs(rect[0] - panel[0]) <= edge &&
        Math.abs(rect[2] - panel[2]) <= edge &&
        rect[3] <= panel[1] &&
        panel[1] - rect[3] <= font * 2 &&
        rect[3] - rect[1] > 0 &&
        rect[3] - rect[1] <= height * 0.25
    )
    const label = (page.lines ?? []).filter((line) => {
      const rect = lineRect(line)
      return (
        new RegExp(`^\\(${String.fromCharCode(97 + index)}\\)[ \\t]+`).test(line.text ?? '') &&
        (rect[0] + rect[2]) / 2 >= panel[0] &&
        (rect[0] + rect[2]) / 2 <= panel[2] &&
        rect[1] >= panel[3] - font * 1.5 &&
        rect[3] <= panel[3] + font * 3
      )
    })
    if (key.length !== 1 || label.length !== 1) return
    keys.push(key[0])
    labels.push(label[0])
  }
  const ink = (page.lines ?? []).filter((line) => {
    const rect = lineRect(line)
    if (
      !rect.every(Number.isFinite) ||
      !(area(rect) > 0) ||
      line.fontSize < font * 0.45 ||
      line.fontSize > font * 1.3 ||
      (!labels.includes(line) && !/^[\d\s.·×+\-−πxyuv*∗]+$/u.test(line.text?.trim() ?? ''))
    )
      return false
    return panels.some((panel, i) => {
      if (rect[0] < panel[0] - font * 3 || rect[2] > panel[2] + font * 3) return false
      return (
        (rect[1] >= keys[i][1] - font * 2 && rect[3] <= keys[i][3] + font * 2) ||
        (rect[2] <= panel[0] + font &&
          rect[1] >= panel[1] - font &&
          rect[3] <= panel[3] + font * 2) ||
        (rect[1] >= panel[3] - font * 1.5 && rect[3] <= lineRect(labels[i])[3] + font * 0.5)
      )
    })
  })
  const bounds = union([...panels, ...keys, ...ink.map(lineRect)])
  if (
    blocked(bounds, caption, captions, tables) ||
    bounds[3] >= caption.rect[1] ||
    caption.rect[1] - bounds[3] > font * 5 ||
    Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0]) <
      Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.8 ||
    (page.lines ?? []).some(
      (line) => line.text?.trim() && intersection(lineRect(line), bounds) > 0 && !ink.includes(line)
    )
  )
    return
  return { bounds, graphicsCount: panels.length + keys.length }
}

// Some publishers place four to eight raster panels in one horizontal strip and
// keep the panel legend as a single line immediately above the caption. The
// ordinary raster pass can claim only the rightmost panels when the leftmost
// image has a detached label. Four-panel strips still require the embedded
// (a)–(d) legend; larger strips use the stronger repeated-size and adjacency
// evidence from the extra panels.
export function nativeCaptionedRasterHorizontalArray(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  let images = graphics(page, 'image').filter((rect) => {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) return false
    if (rect[3] > caption.rect[1] || rect[1] < page.height * 0.04) return false
    if (rect[2] - rect[0] < font * 4 || rect[3] - rect[1] < font * 4) return false
    return (
      !tables.some((table) => intersection(table, rect) > 0) &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  })
  if (images.length < 4) return
  // A prior multi-panel figure can leave several raster rows above the target
  // caption. Treat an intervening figure caption as an ownership barrier so a
  // complete six-to-eight-panel strip is not rejected as ambiguous with the
  // preceding plate.
  if (images.length > 8) {
    const allBounds = union(images)
    const barrier = captions
      .filter((other) => {
        if (other === caption || !/^\s*(?:figure|fig\.?)[ \t]+/i.test(other.lines?.[0] ?? ''))
          return false
        if (other.rect[1] <= allBounds[1] + font || other.rect[3] >= caption.rect[1] - font)
          return false
        if (Math.min(other.rect[2], allBounds[2]) <= Math.max(other.rect[0], allBounds[0]))
          return false
        return (
          images.some((rect) => rect[3] <= other.rect[1] + font) &&
          images.some((rect) => rect[1] >= other.rect[3] - font)
        )
      })
      .sort((a, b) => b.rect[3] - a.rect[3])[0]
    if (barrier) {
      const lowerImages = images.filter((rect) => rect[1] >= barrier.rect[3] - font)
      if (lowerImages.length >= 4 && lowerImages.length < images.length) images = lowerImages
    }
  }
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const height = rect[3] - rect[1]
    const row = rows.find(
      ({ anchor, rowHeight }) => Math.abs(anchor - rect[1]) <= Math.max(rowHeight, height) * 0.3
    )
    if (row) {
      row.rects.push(rect)
      row.rowHeight = Math.max(row.rowHeight, height)
    } else rows.push({ anchor: rect[1], rowHeight: height, rects: [rect] })
  }
  const completeRows = nativeLetteredTwoRowRasterPlate(page, caption, captions, tables, rows, font)
  if (completeRows)
    return {
      caption,
      rect: completeRows.bounds,
      graphicsCount: completeRows.graphicsCount,
      reason: 'native-raster-horizontal-array'
    }
  const candidates = rows
    .map(({ rects }) => rects.slice().sort((a, b) => a[0] - b[0]))
    .filter((rects) => rects.length >= 4 && rects.length <= 8)
    .map((rects) => {
      const widths = rects.map((rect) => rect[2] - rect[0])
      const heights = rects.map((rect) => rect[3] - rect[1])
      const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
      const width = median(widths)
      const height = median(heights)
      if (
        widths.some((value) => Math.abs(value - width) > width * 0.3) ||
        heights.some((value) => Math.abs(value - height) > height * 0.3)
      )
        return
      const gaps = rects.slice(1).map((rect, index) => rect[0] - rects[index][2])
      if (gaps.some((gap) => gap < -font || gap > Math.max(width * 1.2, font * 8))) return
      const bounds = union(rects)
      const gap = caption.rect[1] - bounds[3]
      const maxGap = rects.length >= 5 ? Math.max(font * 5, 40) : Math.max(font * 3, 24)
      if (gap < 0 || gap > maxGap) return
      const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
      if (overlap < Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.5) return
      const legend = (page.lines ?? []).find((line) => {
        const text = line.text?.trim() ?? ''
        if (!/\(a\).*\(b\).*\(c\).*\(d\)/i.test(text)) return false
        const candidate = lineRect(line)
        return (
          candidate[1] >= bounds[3] - Math.max(font * 1.5, 8) &&
          candidate[1] <= bounds[3] + Math.max(font * 1.5, 8) &&
          intersection(candidate, [
            bounds[0] - font * 2,
            bounds[1],
            bounds[2] + font * 2,
            bounds[3] + font * 2
          ]) > 0
        )
      })
      if (rects.length === 4 && !legend) return
      return { bounds, graphicsCount: rects.length }
    })
    .filter(Boolean)
  if (candidates.length !== 1) return
  if (blocked(candidates[0].bounds, caption, captions, tables)) return
  return {
    caption,
    rect: candidates[0].bounds,
    graphicsCount: candidates[0].graphicsCount,
    reason: 'native-raster-horizontal-array'
  }
}

// Some papers place exactly two large raster panels side by side and leave a
// wider typesetting gap before the caption. Keep this recovery deliberately
// narrow so a single raster, an inset image, or a neighboring column cannot
// widen the crop: both panels must be comparable, aligned, and captioned as a
// single plate.
export function nativeCaptionedRasterSideBySide(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image')
    .filter((rect) => {
      const width = rect[2] - rect[0]
      const height = rect[3] - rect[1]
      return (
        rect.every(Number.isFinite) &&
        width >= font * 8 &&
        height >= font * 8 &&
        area(rect) >= page.width * page.height * 0.015 &&
        rect[3] <= caption.rect[1] &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
      )
    })
    .sort((a, b) => a[0] - b[0])
  if (images.length !== 2) return
  const [left, right] = images
  const leftWidth = left[2] - left[0]
  const rightWidth = right[2] - right[0]
  const leftHeight = left[3] - left[1]
  const rightHeight = right[3] - right[1]
  const widthRatio = leftWidth / rightWidth
  const heightRatio = leftHeight / rightHeight
  if (
    widthRatio < 0.55 ||
    widthRatio > 1.8 ||
    heightRatio < 0.65 ||
    heightRatio > 1.5 ||
    right[0] < left[2]
  )
    return
  const baselineTolerance = Math.max(font * 2, Math.max(leftHeight, rightHeight) * 0.08)
  if (Math.abs(left[1] - right[1]) > baselineTolerance) return
  if (right[0] - left[2] > Math.max(font * 8, page.width * 0.08)) return
  const bounds = union(images)
  const gap = caption.rect[1] - bounds[3]
  if (gap < 0 || gap > Math.max(font * 8, 40)) return
  const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
  if (overlap < (bounds[2] - bounds[0]) * 0.8) return
  if (blocked(bounds, caption, captions, tables)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: images.length,
    reason: 'native-raster-side-by-side'
  }
}

// A composite plate can mix raster panels with a vector/table-like panel. Use
// the raster rows as the ownership witness and return their complete union;
// the surrounding vector content is preserved by the enclosing crop. Require
// at least two aligned rows and a broad multi-panel footprint so a standalone
// image near a caption cannot widen its crop.
// Complete paired raster rows only with a native header partition, full source
// fonts and every measured carrier. Retain overlapping images whole: lane
// centers identify owners and never manufacture image slices or vector frames.
export function nativeCaptionedPairedRasterGrid(page, caption, captions, tables, nativeTokens) {
  const validRect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-7 : v <= a[n] + 1e-7))
  const glyphs = (s) => s.replace(/\s+/gu, '')
  const centerX = (r) => (r[0] + r[2]) / 2
  const centerY = (r) => (r[1] + r[3]) / 2
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const nearRect = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 1e-6)
  const validFont = (t) =>
    validRect(t.rect) &&
    Number.isFinite(t.height) &&
    t.height > 0 &&
    Number.isFinite(t.baseline) &&
    Number.isFinite(t.fontDescent) &&
    t.fontDescent <= 0 &&
    t.fontDescent >= -1 &&
    typeof t.horizontal === 'boolean' &&
    (t.horizontal
      ? Math.abs(t.rect[3] - t.rect[1] - t.height) <= 1e-6 &&
        Math.abs(t.rect[3] - t.baseline) <= 1e-6
      : Math.abs(t.rect[2] - t.rect[0] - t.height) <= 1e-6)
  function fullSourceLine(line, native) {
    const r = lineRect(line)
    if (!validRect(r) || !Number.isFinite(line.fontSize) || line.fontSize <= 0) return false
    const parts = native.filter((t) => contains(r, t.rect))
    if (!parts.length || !parts.every(validFont)) return false
    return (
      nearRect(union(parts.map((t) => t.rect)), r) &&
      Math.abs(Math.max(...parts.map((t) => t.height)) - line.fontSize) <= 1e-6 &&
      glyphs(parts.map((t) => t.text).join('')) === glyphs(line.text)
    )
  }

  if (
    !caption ||
    caption.page !== page.pageNumber ||
    page.invalidGraphicsBounds ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    return
  if (!/^\s*(?:Fig\.?|Figure)\s+\d+[.:]\s+\S/iu.test(caption.lines?.[0] ?? '')) return
  if (
    !validRect(caption.rect) ||
    captions.filter((c) => c.page === page.pageNumber && c === caption).length !== 1 ||
    !nativeTokens?.length
  )
    return
  const sourceFonts = nativeTokens.filter((t) => t.text?.trim())
  if (
    !sourceFonts.every(validFont) ||
    !page.lines.every((l) => !l.text.trim() || validRect(lineRect(l)))
  )
    return
  const captionFonts = sourceFonts.filter((t) => contains(caption.rect, t.rect))
  if (
    !captionFonts.length ||
    !nearRect(union(captionFonts.map((t) => t.rect)), caption.rect) ||
    glyphs(captionFonts.map((t) => t.text).join('')) !== glyphs(caption.lines.join(''))
  )
    return
  const font = Math.max(...captionFonts.map((t) => t.height))
  if (captionFonts.some((t) => !t.horizontal)) return
  const pageRect = [0, 0, page.width, page.height]
  const all = []
  for (const original of page.graphicsBounds ?? []) {
    if (
      !['path', 'image'].includes(original.kind) ||
      !validRect(original.normalizedRect) ||
      !contains([0, 0, 1, 1], original.normalizedRect)
    )
      return
    if (
      original.paintedNormalizedRect &&
      (!validRect(original.paintedNormalizedRect) ||
        !contains(original.normalizedRect, original.paintedNormalizedRect))
    )
      return
    const rect = (original.paintedNormalizedRect ?? original.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
    all.push({ original, rect })
  }
  const beforeCaption = all.filter((g) => g.rect[3] < caption.rect[1])
  const images = beforeCaption.filter((g) => g.original.kind === 'image')
  if (
    images.length < 19 ||
    images.length > 145 ||
    images.some((g) => !g.original.imageHash) ||
    new Set(images.map((g) => g.original.imageHash)).size !== images.length
  )
    return
  const raster = images.filter((g) => g.rect[2] - g.rect[0] >= font * 2)
  const keys = images.filter((g) => !raster.includes(g))
  if (
    keys.length !== 1 ||
    !raster.every((g) => g.original.paintedNormalizedRect && g.rect[3] - g.rect[1] >= font)
  )
    return
  const key = keys[0]
  if (key.rect[2] - key.rect[0] > font * 2 || key.rect[3] - key.rect[1] < font * 6) return
  const rasterRect = union(raster.map((g) => g.rect))
  if (key.rect[0] < rasterRect[2] || key.rect[0] - rasterRect[2] > font * 2) return
  const paths = beforeCaption.filter((g) => g.original.kind === 'path')
  const enclosing = paths.filter((g) => contains(g.rect, union(images.map((g) => g.rect))))
  if (enclosing.length !== 1) return
  const outer = enclosing[0]
  const bands = paths.filter((g) => g !== outer).sort((a, b) => a.rect[1] - b.rect[1])
  if (bands.length < 3 || bands.length > 6 || !bands.every((g) => contains(outer.rect, g.rect)))
    return
  const cellX = page.width / 128,
    cellY = page.height / 128
  if (
    !bands.every(
      (g) =>
        Math.abs(g.rect[0] - bands[0].rect[0]) <= cellX &&
        Math.abs(g.rect[2] - bands[0].rect[2]) <= cellX
    )
  )
    return
  const bandUnion = union([...bands.map((g) => g.rect), key.rect])
  if (outer.rect.some((v, n) => (n < 2 ? bandUnion[n] - v : v - bandUnion[n]) > font * 3)) return
  const bandData = []
  const rows = []
  for (const band of bands) {
    const members = raster.filter((g) => contains(band.rect, g.rect))
    if (members.length < 12 || members.length > 24 || members.length % 2) return
    const sorted = members.slice().sort((a, b) => centerY(a.rect) - centerY(b.rect))
    const gaps = sorted.slice(1).map((g, n) => centerY(g.rect) - centerY(sorted[n].rect))
    const maxGap = Math.max(...gaps)
    const split = gaps.indexOf(maxGap) + 1
    if (
      split * 2 !== sorted.length ||
      maxGap < font * 2 ||
      gaps.filter((_, n) => n !== split - 1).some((gap) => gap > font / 4)
    )
      return
    const pair = [sorted.slice(0, split), sorted.slice(split)].map((rs) =>
      rs.sort((a, b) => centerX(a.rect) - centerX(b.rect))
    )
    if (
      Math.max(...pair[0].map((g) => g.rect[3])) >
      Math.min(...pair[1].map((g) => g.rect[1])) + 1e-7
    )
      return
    if (pair.some((rs) => rs.slice(1).some((g, n) => g.rect[0] - rs[n].rect[2] < -cellX))) return
    if (bandData.length && band.rect[1] < bandData.at(-1).band.rect[3] - cellY * 2) return
    const groupFonts = sourceFonts.filter(
      (t) => !t.horizontal && contains(band.rect, t.rect) && t.rect[2] < rasterRect[0]
    )
    if (groupFonts.length !== 1) return
    bandData.push({
      band,
      pair,
      groupFont: groupFonts[0],
      largestSourceYGap: maxGap,
      withinRowMaximumSourceYGap: Math.max(...gaps.filter((_, n) => n !== split - 1))
    })
    rows.push(...pair)
  }
  if (!raster.every((g) => bandData.filter((b) => b.pair.some((r) => r.includes(g))).length === 1))
    return
  if (!rows.every((row) => row.length === rows[0].length)) return
  const lanes = rows[0].map((_, c) => ({
    center: median(rows.map((r) => centerX(r[c].rect))),
    fullRecords: rows.map((r) => r[c])
  }))
  if (
    rows.some((r) => r.length !== lanes.length) ||
    !lanes.every((l) => l.fullRecords.every((g) => Math.abs(centerX(g.rect) - l.center) <= font))
  )
    return
  const cuts = [
    rasterRect[0],
    ...lanes.slice(1).map((l, n) => (l.center + lanes[n].center) / 2),
    rasterRect[2]
  ]
  const headers = sourceFonts
    .filter(
      (t) =>
        t.horizontal &&
        t.rect[3] < rasterRect[1] &&
        t.rect[1] >= outer.rect[1] - font &&
        t.rect[0] >= rasterRect[0] &&
        t.rect[2] <= rasterRect[2]
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    headers.length < 3 ||
    headers.length > lanes.length ||
    !headers.every(
      (t) =>
        Math.abs(t.baseline - headers[0].baseline) <= 1e-6 &&
        Math.abs(t.height - headers[0].height) <= 1e-6 &&
        t.height >= font &&
        t.height <= font * 1.6 &&
        rasterRect[1] - t.rect[3] <= t.height * 3
    )
  )
    return
  const headerOwners = headers.map((header) => {
    const ownedLanes = lanes
      .map((_, c) => c)
      .filter((c) => header.rect[0] < cuts[c + 1] && header.rect[2] > cuts[c])
    if (!ownedLanes.length || ownedLanes.length > 2) return
    const first = ownedLanes[0],
      last = ownedLanes.at(-1)
    if (
      header.rect[0] < cuts[first] ||
      header.rect[2] > cuts[last + 1] ||
      Math.abs(centerX(header.rect) - (lanes[first].center + lanes[last].center) / 2) > font
    )
      return
    return { header, ownedLanes }
  })
  if (
    headerOwners.some((h) => !h) ||
    !lanes.every((_, c) => headerOwners.filter((h) => h.ownedLanes.includes(c)).length === 1) ||
    !headerOwners.some((h) => h.ownedLanes.length === 2)
  )
    return
  if (headerOwners[0].ownedLanes.length !== 1 || headerOwners.at(-1).ownedLanes.length !== 1) return
  for (const group of bandData)
    for (const row of group.pair) {
      for (const h of headerOwners.slice(1)) {
        const start = h.ownedLanes[0]
        if (row[start].rect[0] - row[start - 1].rect[2] < font) return
      }
    }
  const keyFonts = sourceFonts.filter(
    (t) =>
      contains(outer.rect, t.rect) &&
      t.rect[0] >= key.rect[0] - font &&
      t.rect[2] <= key.rect[2] + font &&
      t.rect[1] >= key.rect[1] &&
      t.rect[3] <= key.rect[3]
  )
  const numbers = keyFonts
    .filter((t) => t.horizontal && /^[-−+]?\d+(?:\.\d+)?$/u.test(t.text))
    .sort((a, b) => a.rect[1] - b.rect[1])
  const rotatedKeys = keyFonts.filter((t) => !t.horizontal)
  if (
    numbers.length !== 2 ||
    rotatedKeys.length !== 2 ||
    keyFonts.length !== 4 ||
    numbers[0].rect[1] - key.rect[1] > numbers[0].height * 1.5 ||
    key.rect[3] - numbers[1].rect[3] > numbers[1].height * 1.5
  )
    return
  if (!rotatedKeys.every((t) => t.rect[1] > numbers[0].rect[3] && t.rect[3] < numbers[1].rect[1]))
    return
  const fullFonts = [...headers, ...bandData.map((b) => b.groupFont), ...keyFonts]
  if (new Set(fullFonts).size !== fullFonts.length) return
  const rect = union([outer.rect, ...fullFonts.map((t) => t.rect)])
  if (
    !contains(pageRect, rect) ||
    !sourceFonts.filter((t) => intersection(t.rect, rect) > 0).every((t) => fullFonts.includes(t))
  )
    return
  if (
    !fullFonts.every((t) =>
      contains(
        rect,
        t.horizontal
          ? [t.rect[0], t.rect[1], t.rect[2], t.rect[3] - t.fontDescent * t.height]
          : t.rect
      )
    )
  )
    return
  const ownedLines = page.lines.filter((l) => l.text.trim() && intersection(lineRect(l), rect) > 0)
  if (!ownedLines.every((l) => contains(rect, lineRect(l)) && fullSourceLine(l, sourceFonts)))
    return
  if (!fullFonts.every((t) => ownedLines.filter((l) => contains(lineRect(l), t.rect)).length === 1))
    return
  if (
    !beforeCaption.every((g) => contains(rect, g.rect)) ||
    all.filter((g) => intersection(g.rect, rect) > 0).some((g) => !beforeCaption.includes(g))
  )
    return
  if (tables.some((t) => !validRect(t) || intersection(t, rect) > 0)) return
  if (
    captions.some(
      (c) =>
        c !== caption &&
        c.page === page.pageNumber &&
        (!validRect(c.rect) || intersection(c.rect, rect) > 0)
    )
  )
    return
  const gap = caption.rect[1] - rect[3]
  if (gap < font / 2 || gap > font * 3 || caption.rect[0] > rect[0] || caption.rect[2] < rect[2])
    return
  if (
    sourceFonts.some(
      (t) =>
        !captionFonts.includes(t) &&
        !fullFonts.includes(t) &&
        intersection(t.rect, [rect[0], rect[1], rect[2], caption.rect[1]]) > 0
    )
  )
    return
  return { caption, rect, graphicsCount: images.length }
}

export function nativeCaptionedRasterCompositeGrid(
  page,
  caption,
  captions,
  tables,
  nativeTokens = []
) {
  const paired = nativeCaptionedPairedRasterGrid(page, caption, captions, tables, nativeTokens)
  if (paired) return paired
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+(?:[A-Z]\.)?\d+(?:\.\d+)?[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  let images = graphics(page, 'image').filter((rect) => {
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    return (
      rect[3] <= caption.rect[1] &&
      rect[3] >= caption.rect[1] - page.height * 0.85 &&
      width >= font * 2.5 &&
      height >= font * 2.5 &&
      !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  })
  // When two raster grids are stacked, the upper grid's figure caption is a
  // hard ownership boundary for a lower caption. Apply this only when images
  // clearly exist on both sides of an intervening figure caption; ordinary
  // multi-row plates remain unchanged.
  if (images.length > 1) {
    const allBounds = union(images)
    const barrier = captions
      .filter((other) => {
        if (other === caption || !/^\s*(?:figure|fig\.?)[ \t]+/i.test(other.lines?.[0] ?? ''))
          return false
        if (other.rect[1] <= allBounds[1] + font || other.rect[3] >= caption.rect[1] - font)
          return false
        if (Math.min(other.rect[2], allBounds[2]) <= Math.max(other.rect[0], allBounds[0]))
          return false
        return (
          images.some((rect) => rect[3] <= other.rect[1] + font) &&
          images.some((rect) => rect[1] >= other.rect[3] - font)
        )
      })
      .sort((a, b) => b.rect[3] - a.rect[3])[0]
    if (barrier) {
      const lowerImages = images.filter((rect) => rect[1] >= barrier.rect[3] - font)
      if (lowerImages.length >= 4 && lowerImages.length < images.length) images = lowerImages
    }
  }
  if (images.length < 4) return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const height = rect[3] - rect[1]
    const row = rows.find(
      ({ anchor, rowHeight }) =>
        Math.abs(anchor - rect[1]) <= Math.max(font * 2, rowHeight, height) * 0.3
    )
    if (row) {
      row.rects.push(rect)
      row.rowHeight = Math.max(row.rowHeight, height)
    } else rows.push({ anchor: rect[1], rowHeight: height, rects: [rect] })
  }
  if (rows.length < 2) return
  // Two short rows are already covered by the keyed/dual-panel recognizers;
  // reserve this broad union for a three-row composite or a dense wide grid.
  const maxRowImages = Math.max(...rows.map(({ rects }) => rects.length))
  const compactTwoRowGrid =
    rows.length === 2 && rows.every(({ rects }) => rects.length >= 3) && maxRowImages >= 3
  if (rows.length < 3 && maxRowImages < 6 && !compactTwoRowGrid) return
  const nearest = rows.at(-1)
  const medianHeight = rows.map(({ rowHeight }) => rowHeight).sort((a, b) => a - b)[
    Math.floor(rows.length / 2)
  ]
  const selectedRows = [nearest]
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const gap = selectedRows[0].anchor - (rows[index].anchor + rows[index].rowHeight)
    if (gap > Math.max(font * 5, medianHeight * 1.5)) break
    selectedRows.unshift(rows[index])
  }
  if (selectedRows.length < 2) return
  const selectedImages = selectedRows.flatMap(({ rects }) => rects)
  if (selectedImages.length < 4) return
  // A three-row, two-column plate is also the shape used by forest/survival
  // plots whose panels are separated by one shared native axis title.  Keep
  // that title as proof that the upper rows belong to this caption, but defer
  // when the title is missing (for example, after a tick-only crop) or when a
  // full-size prose line occupies the same inter-row gap.  The ordinary
  // composite recognizers remain responsible for other grid shapes.
  const pairedTriple =
    selectedRows.length === 3 && selectedRows.every(({ rects }) => rects.length === 2)
  if (pairedTriple) {
    const firstGapStart = selectedRows[0].anchor + selectedRows[0].rowHeight
    const firstGapEnd = selectedRows[1].anchor
    const sharedAxisTitle = page.lines.some(
      (line) =>
        line.fontSize <= 8 &&
        line.text.trim().length >= 35 &&
        line.y + line.height >= firstGapStart - font &&
        line.y <= firstGapEnd + font &&
        line.x < page.width * 0.9 &&
        line.x + line.width > page.width * 0.1
    )
    const axisTitleLine = page.lines.find(
      (line) =>
        line.fontSize <= 8 &&
        line.text.trim().length >= 35 &&
        line.y + line.height >= firstGapStart - font &&
        line.y <= firstGapEnd + font &&
        line.x < page.width * 0.9 &&
        line.x + line.width > page.width * 0.1
    )
    const nearbyTick = axisTitleLine
      ? page.lines.some(
          (line) =>
            line !== axisTitleLine &&
            line.fontSize <= 8 &&
            /^[−-]?\d+(?:\.\d+)?(?:\s+[−-]?\d+(?:\.\d+)?)*$/.test(line.text.trim()) &&
            line.y + line.height <= axisTitleLine.y &&
            axisTitleLine.y - line.y - line.height <= font * 2
        )
      : false
    if (!sharedAxisTitle || !nearbyTick) return
    if (
      page.lines.some(
        (line) =>
          line.fontSize > 8 &&
          line.text.trim().length >= 35 &&
          line.y + line.height >= firstGapStart - font &&
          line.y <= firstGapEnd + font
      )
    )
      return
  }
  const bounds = union(selectedImages)
  const gap = caption.rect[1] - bounds[3]
  if (gap < 0 || gap > Math.max(font * 5, 40)) return
  const denseRows = selectedRows.length >= 3 && selectedRows.every(({ rects }) => rects.length >= 2)
  const minimumWidth = denseRows ? page.width * 0.3 : page.width * 0.45
  if (bounds[2] - bounds[0] < minimumWidth || bounds[3] - bounds[1] < page.height * 0.1) return
  const overlap = Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
  if (overlap < Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0]) * 0.6) return
  if (
    captions.some((other) => other !== caption && intersection(other.rect, bounds) > 0) ||
    tables.some((table) => {
      const overlap = intersection(table, bounds)
      return overlap > 0 && !contains(bounds, table, font * 2)
    })
  )
    return
  const nearbyPaths = graphics(page, 'path').filter((rect) => {
    const pathArea = area(rect)
    return (
      pathArea > 0 &&
      pathArea <= area(bounds) * 0.2 &&
      intersection(rect, [bounds[0] - font * 2, bounds[1], bounds[2] + font * 3, bounds[3]]) > 0
    )
  })
  const ownedText = pairedTriple
    ? page.lines
        .filter((line) => {
          const text = line.text.trim()
          const panelLabel = /^[A-Z](?:\s+[A-Z])*$/.test(text)
          if (!panelLabel && line.fontSize > 8) return false
          if (line.y + line.height < bounds[1] - font * 2 || line.y >= caption.rect[1]) return false
          return line.x + line.width > bounds[0] - font * 12 && line.x < bounds[2] + font * 12
        })
        .map(lineRect)
    : []
  const completeBounds = union([bounds, ...nearbyPaths, ...ownedText])
  return {
    caption,
    rect: completeBounds,
    graphicsCount: selectedImages.length + nearbyPaths.length,
    reason: 'native-raster-composite-grid'
  }
}

// Some papers render a comparison plate as two side-by-side raster panels,
// each with three tiles per row and four rows.  The generic grid matcher can
// reject this shape when the two panels use different tile widths, leaving a
// lower subset as the figure.  Recover only a complete four-row, six-tile
// band whose two panel clusters are separated on every row and whose bottom
// edge is immediately followed by this caption.
export function nativeCaptionedRasterDualPanelGrid(page, caption, captions, tables) {
  const firstLine = caption.lines?.[0] ?? ''
  if (!/^(?:figure|fig\.?)[ \t]+\d+[.:]/i.test(firstLine)) return
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const images = graphics(page, 'image').filter((rect) => {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) return false
    if (rect[3] > caption.rect[1] || rect[1] < page.height * 0.04) return false
    if (tables.some((table) => intersection(table, rect) > 0)) return false
    if (captions.some((other) => other !== caption && intersection(other.rect, rect) > 0))
      return false
    return rect[2] - rect[0] >= font * 3 && rect[3] - rect[1] >= font * 2
  })
  if (images.length < 24) return
  const widths = images.map((rect) => rect[2] - rect[0]).sort((a, b) => a - b)
  const heights = images.map((rect) => rect[3] - rect[1]).sort((a, b) => a - b)
  const median = (values) => values[Math.floor(values.length / 2)]
  const tileWidth = median(widths)
  const tileHeight = median(heights)
  if (!(tileWidth > 0) || !(tileHeight > 0)) return
  const rows = []
  for (const rect of images.slice().sort((a, b) => a[1] - b[1])) {
    const row = rows.find(({ anchor }) => Math.abs(anchor - rect[1]) <= tileHeight * 0.45)
    if (row) row.rects.push(rect)
    else rows.push({ anchor: rect[1], rects: [rect] })
  }
  if (rows.length !== 4 || rows.some((row) => row.rects.length !== 6)) return
  const panelSplit = (rects) => {
    const centers = rects.map((rect) => (rect[0] + rect[2]) / 2).sort((a, b) => a - b)
    const gaps = centers.slice(1).map((center, index) => ({
      index,
      gap: center - centers[index]
    }))
    const split = gaps.sort((a, b) => b.gap - a.gap)[0]
    if (!split || split.gap < tileWidth * 1.05) return
    const left = rects.filter((rect) => (rect[0] + rect[2]) / 2 <= centers[split.index])
    const right = rects.filter((rect) => (rect[0] + rect[2]) / 2 > centers[split.index])
    if (left.length !== 3 || right.length !== 3) return
    return { left, right }
  }
  const panels = rows.map((row) => panelSplit(row.rects))
  if (panels.some((panel) => !panel)) return
  const leftBounds = union(panels.flatMap((panel) => panel.left))
  const rightBounds = union(panels.flatMap((panel) => panel.right))
  if (leftBounds[2] >= rightBounds[0]) return
  const bounds = union([leftBounds, rightBounds])
  const gap = caption.rect[1] - bounds[3]
  if (gap < 0 || gap > Math.max(font * 3, 24) || blocked(bounds, caption, captions, tables)) return
  return {
    caption,
    rect: bounds,
    graphicsCount: images.length,
    reason: 'native-raster-dual-panel-grid'
  }
}

export function nativeRasterGrid(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  let allImages = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => ({
      rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    }))
    .filter(
      ({ rect }) =>
        rect.every(Number.isFinite) &&
        rect[2] - rect[0] >= font * 4 &&
        rect[3] - rect[1] >= font * 4 &&
        rect[3] <= caption.rect[1] &&
        !tables.some((table) => intersection(table, rect) > 0) &&
        !captions.some((other) => other !== caption && intersection(other.rect, rect) > 0)
    )
  if (allImages.length > 1) {
    const bounds = union(allImages.map(({ rect }) => rect))
    const barrier = captions
      .filter((other) => {
        if (other === caption || !/^\s*(?:figure|fig\.?)[ \t]+/i.test(other.lines?.[0] ?? ''))
          return false
        if (other.rect[1] <= bounds[1] + font || other.rect[3] >= caption.rect[1] - font)
          return false
        if (Math.min(other.rect[2], bounds[2]) <= Math.max(other.rect[0], bounds[0])) return false
        return (
          allImages.some(({ rect }) => rect[3] <= other.rect[1] + font) &&
          allImages.some(({ rect }) => rect[1] >= other.rect[3] - font)
        )
      })
      .sort((a, b) => b.rect[3] - a.rect[3])[0]
    if (barrier) {
      const lowerImages = allImages.filter(({ rect }) => rect[1] >= barrier.rect[3] - font)
      if (lowerImages.length >= 6 && lowerImages.length < allImages.length) allImages = lowerImages
    }
  }
  if (allImages.length < 8) return
  const widths = allImages.map(({ rect }) => rect[2] - rect[0])
  const heights = allImages.map(({ rect }) => rect[3] - rect[1])
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const width = median(widths)
  const height = median(heights)
  if (!(width > 0) || !(height > 0)) return

  // A page can contain several raster grids with identical tile geometry.
  // Cluster by horizontal proximity first, then split vertically at the
  // whitespace between figure bands. This keeps a caption from claiming a
  // neighboring grid merely because all of its tiles sit above the caption.
  const clusterGap = Math.max(width * 1.5, font * 8)
  const horizontalClusters = []
  for (const image of allImages.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
    const cluster = horizontalClusters.find(
      ({ bounds }) =>
        image.rect[0] <= bounds[2] + clusterGap && image.rect[2] >= bounds[0] - clusterGap
    )
    if (cluster) {
      cluster.images.push(image)
      cluster.bounds = union(cluster.images.map(({ rect }) => rect))
    } else horizontalClusters.push({ images: [image], bounds: image.rect.slice() })
  }
  const candidates = []
  for (const cluster of horizontalClusters) {
    const clusterWidths = cluster.images.map(({ rect }) => rect[2] - rect[0])
    const clusterHeights = cluster.images.map(({ rect }) => rect[3] - rect[1])
    const clusterWidth = median(clusterWidths)
    const clusterHeight = median(clusterHeights)
    if (
      clusterWidths.some((value) => Math.abs(value - clusterWidth) > clusterWidth * 0.2) ||
      clusterHeights.some((value) => Math.abs(value - clusterHeight) > clusterHeight * 0.2)
    )
      continue
    const rows = []
    for (const image of cluster.images.slice().sort((a, b) => a.rect[1] - b.rect[1])) {
      const row = rows.find(({ rect }) => Math.abs(rect[1] - image.rect[1]) <= clusterHeight * 0.45)
      if (row) {
        row.images.push(image)
        row.rect = union(row.images.map(({ rect }) => rect))
      } else rows.push({ images: [image], rect: image.rect.slice() })
    }
    const blocks = []
    for (const row of rows) {
      const previous = blocks.at(-1)
      if (
        previous &&
        row.rect[1] - previous.rows.at(-1).rect[3] <= Math.max(clusterHeight * 1.25, font * 6)
      ) {
        previous.rows.push(row)
        previous.images.push(...row.images)
      } else blocks.push({ rows: [row], images: row.images.slice() })
    }
    for (const block of blocks) {
      if (block.rows.length < 2 || block.rows.some((row) => row.images.length < 3)) continue
      const bounds = union(block.images.map(({ rect }) => rect))
      const gap = caption.rect[1] - bounds[3]
      const horizontalOverlap = Math.max(
        0,
        Math.min(bounds[2], caption.rect[2]) - Math.max(bounds[0], caption.rect[0])
      )
      const overlapRatio =
        horizontalOverlap / Math.min(bounds[2] - bounds[0], caption.rect[2] - caption.rect[0])
      const interveningCaption = captions.some(
        (other) =>
          other !== caption &&
          other.page === caption.page &&
          other.rect[1] >= bounds[3] - font &&
          other.rect[3] <= caption.rect[1] + font &&
          intersection(other.rect, bounds) > 0
      )
      if (
        gap < 0 ||
        gap > Math.max(font * 7, page.height * 0.1) ||
        overlapRatio < 0.5 ||
        interveningCaption
      )
        continue
      candidates.push({ block, bounds, gap, overlapRatio })
    }
  }
  const selected = candidates.sort((a, b) => a.gap - b.gap || b.overlapRatio - a.overlapRatio)[0]
  if (!selected) return
  const { images, rows } = selected.block
  const columns = rows
    .flatMap((row) => row.images)
    .map(({ rect }) => (rect[0] + rect[2]) / 2)
    .sort((a, b) => a - b)
  const columnCenters = []
  for (const center of columns) {
    const previous = columnCenters.at(-1)
    if (previous === undefined || center - previous > width * 0.55) columnCenters.push(center)
    else columnCenters[columnCenters.length - 1] = (previous + center) / 2
  }
  if (
    columnCenters.length < 3 ||
    rows.filter((row) => row.images.length >= columnCenters.length * 0.6).length < 2
  )
    return
  const bounds = union(images.map(({ rect }) => rect))
  if (
    bounds[3] >= caption.rect[1] ||
    caption.rect[1] - bounds[3] > Math.max(font * 7, page.height * 0.1) ||
    area(bounds) < page.width * page.height * 0.01
  )
    return
  const attached = (page.lines ?? []).filter(
    (line) =>
      line.text.trim() &&
      line.text.length < 40 &&
      line.y >= bounds[3] - font &&
      line.y + line.height <= caption.rect[1] &&
      line.x >= bounds[0] - font * 2 &&
      line.x + line.width <= bounds[2] + font * 2 &&
      !captions.some((other) => other !== caption && intersection(other.rect, lineRect(line)) > 0)
  )
  const rect = union([bounds, ...attached.map(lineRect)])
  return { caption, rect, graphicsCount: images.length }
}
