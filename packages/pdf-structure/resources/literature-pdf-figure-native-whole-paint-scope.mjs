import { tableTextToken } from './literature-pdf-orientation.mjs'
import {
  nativeNormalRasterPairPixelCrop,
  nativeFourMarkerRasterPairPixelCrop,
  nativeCompoundCaptionRasterPairPixelCrop,
  nativeForeignCaptionRasterPairPixelCrop,
  nativeNormalRasterPairPixelCurrent,
  nativeNormalRasterPairPixelPngSafe,
  createNativeFigurePaintCertificate,
  createNativeLeadingType3PixelCertificate,
  nativeFigurePaintCertificateData,
  createNativeSavedUncoloredPixelEvidence,
  nativeSavedUncoloredPixelEvidenceData
} from './literature-pdf-figure-native-plot-labels.mjs'
const completePicturePaintPlans = new WeakMap()
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativeCompositingFigureCrop,
  nativeCompositingFigurePngSafe
} from './literature-pdf-figure-native-compositing-scope.mjs'
import {
  createNativeFigureRecoveryProfile,
  nativeFigureRecoveryProfileData,
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import {
  nativeRecoveryFigureInkPacket,
  nativePageTextPacketInventory,
  nativeTypedPlotPacketInventory,
  nativeClosedProgramInkPacket,
  nativeClosedPrintedFaceInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import {
  nativeFigureLabelBounds,
  nativeOwnedFigureInkBottom
} from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import {
  getPdfCropRasterProtectionFromPng,
  matchesInitialPdfCropPng,
  MAX_EDGE,
  MAX_SCALE
} from './literature-pdf-crop.mjs'
import { findCaptionCandidates, groupPageLines } from './literature-pdf-caption-group.mjs'
import {
  nativeClosedProgramFigureCrop,
  nativeClosedProgramPngSafe
} from './literature-pdf-figure-native-closed-program.mjs'
import {
  nativeIsolatedFormFigureCrop,
  nativeIsolatedFormPngSafe
} from './literature-pdf-figure-native-isolated-form.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'

const certificates = new WeakMap(),
  inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  positive = (g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3],
  compact = (s) => s.replace(/\s/gu, '')
const outputBinding = (candidate) =>
  JSON.stringify([
    candidate.rect,
    candidate.sourceItems,
    candidate.graphicsCount,
    candidate.formCropRaster,
    candidate.recoveryProgramRaster
  ])

function wholeNestedScope(page, figure, captions, tables, tokens, context, profile, data) {
  const anchor = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem,
    p = anchor && nativeRecoveryFigureInkPacket(page, tokens, context, [], profile)
  if (
    !p ||
    p.records.length > 4096 ||
    p.evidence.paths.size > 4096 ||
    p.evidence.images.length > 64
  )
    return
  const roots = data.nested.filter((g) => g.depth === 0)
  if (roots.length !== 1) return
  const root = p.evidence.isolatedGroups.get(roots[0].begin)
  if (
    !root ||
    !p.valid(root.rect) ||
    !p.valid(root.clip) ||
    !inside(root.clip, root.rect) ||
    !p.valid(figure.rect) ||
    !p.valid(figure.caption.rect) ||
    figure.caption.page !== page.pageNumber ||
    !hit(figure.rect, root.rect) ||
    root.rect[3] >= figure.caption.rect[1]
  )
    return
  const belongs = (i) => i > root.begin && i < root.end,
    owned = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
  if (
    owned.length > 64 ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !r.part.every(
          ({ g }) =>
            belongs(g.i) &&
            inside(root.clip, g.ink) &&
            g.textPaint.fillAlpha === 1 &&
            /^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) &&
            g.textPaint.fillColor.toLowerCase() !== '#ffffff'
        )
    )
  )
    return
  const ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
    membership = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (membership.has(g)) return
      membership.set(g, r)
    }
  if (p.glyphs.some((g) => belongs(g.i) && positive(g) && !ownGlyphs.has(g))) return
  const full = (r) => {
      const s = context.content.styles[r.r.fontName]
      // A complete foreign punctuation font can have no ascender. Preserve its
      // actual glyph ink and whole advance; this never supplies an owned metric.
      if (
        s?.vertical === false &&
        s.ascent === 0 &&
        Number.isFinite(s.descent) &&
        s.descent <= 0 &&
        s.descent >= -2 &&
        !owned.includes(r) &&
        r.advanceComplete
      )
        return union([r.rect, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (
        !Number.isFinite(s?.ascent) ||
        s.ascent <= 0 ||
        s.ascent > 2 ||
        !Number.isFinite(s.descent) ||
        s.descent > 0 ||
        s.descent < -2
      )
        return
      const font = nativeFigureLabelBounds(r.r, s, p.v)
      return font && union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
    },
    domains = new Map(p.records.map((r) => [r, full(r)]))
  if ([...domains.values()].some((r) => !p.valid(r))) return
  const cap = p.records.filter((r) => inside(figure.caption.rect, r.rect))
  if (
    !cap.length ||
    !/^Figure\s+\d+:/u.test(cap[0].r.str) ||
    compact(cap.map((r) => r.r.str).join('')) !== compact(figure.caption.lines.join('')) ||
    !/[.!?]$/u.test(cap.at(-1).r.str) ||
    cap[0].part[0].g.i <= root.end ||
    cap.some((r) => owned.includes(r))
  )
    return
  const images = p.evidence.images.filter((im) => belongs(im.operationIndex)),
    capGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g))),
    foreign = [],
    laneForeign = [],
    paints = []
  if (
    (!owned.length && !images.length) ||
    p.evidence.images.some((im) => !belongs(im.operationIndex))
  )
    return
  for (const im of images) {
    const actual = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
      ),
      a = p.o.argsArray[im.operationIndex]
    if (
      !inside(root.clip, im.rect) ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '') ||
      a?.length !== 3 ||
      !Number.isSafeInteger(a[1]) ||
      !Number.isSafeInteger(a[2]) ||
      a[1] <= 0 ||
      a[2] <= 0
    )
      return
  }
  for (const [i, state] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) continue
    if (belongs(i)) {
      if (
        !p.valid(state.clip) ||
        !inside(root.clip, state.clip) ||
        ![state.fillAlpha, state.strokeAlpha].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      )
        return
      paints.push(i)
    } else {
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreign.push(paint)
      laneForeign.push(paint)
    }
  }
  foreign.push(
    ...p.records.filter((r) => !owned.includes(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  laneForeign.push(
    ...p.records
      .filter((r) => !owned.includes(r) && !cap.includes(r))
      .map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g) && !capGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  const rect = union([root.rect, ...owned.map((r) => domains.get(r))]),
    scale = Math.ceil(page.width * 1.5) / page.width,
    padded = expand(rect, 2 / scale),
    lane = [
      Math.min(figure.rect[0], rect[0], figure.caption.rect[0]),
      rect[3],
      Math.max(figure.rect[2], rect[2], figure.caption.rect[2]),
      figure.caption.rect[1]
    ]
  if (
    rect[3] >= figure.caption.rect[1] ||
    !inside([0, 0, page.width, page.height], padded) ||
    laneForeign.some((q) => hit(lane, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((c) => c !== figure.caption && c.page === page.pageNumber && hit(c.rect, lane)) ||
    tables.some((t) => hit(t, lane)) ||
    foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
    tables.some((t) => hit(t, padded))
  )
    return
  if (
    !images.some((im) => !inside(figure.rect, im.rect)) &&
    ![...ownGlyphs].some((g) => positive(g) && !inside(figure.rect, g.ink)) &&
    !foreign.some((q) => hit(figure.rect, q.rect))
  )
    return
  const sourceItems = owned.map((r) => r.r.sourceItem).sort((a, b) => a.index - b.index)
  if (
    sourceItems.length &&
    !nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile)
  )
    return
  return {
    rect,
    sourceItems,
    graphicsCount: images.length + paints.length,
    formCropRaster: {
      ownedRects: [root.rect, ...owned.map((r) => domains.get(r))],
      foreignPaints: foreign
    },
    clip: root.clip
  }
}

export function nativeRecoveryFigureCrop(page, figure, captions, tables, tokens, context) {
  const captionBefore = nativeCaptionBeforeSavePixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context
  )
  if (captionBefore) return captionBefore
  const largeSave = nativeLargeSavePixelCrop(page, figure, captions, tables, tokens, context)
  if (largeSave) return largeSave
  const paired = nativePairedClippedGroupCrop(page, figure, captions, tables, tokens, context)
  if (paired) return paired
  const compositing = nativeCompositingFigureCrop(page, figure, captions, tables, tokens, context)
  if (compositing) return compositing
  try {
    if (
      !figure?.rect ||
      !figure.caption?.rect ||
      !Array.isArray(figure.caption.lines) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure
    )
      return
    const profile = createNativeFigureRecoveryProfile(page, tokens, context),
      data = nativeFigureRecoveryProfileData(profile, page, tokens, context)
    if (!data) return
    const result = data.nested
      ? wholeNestedScope(page, figure, captions, tables, tokens, context, profile, data)
      : (nativeClosedProgramFigureCrop(page, figure, captions, tables, tokens, context, profile) ??
        nativeIsolatedFormFigureCrop(page, figure, captions, tables, tokens, context, profile))
    if (!result) return
    const unchanged = retainNativeRecoveryInputs([figure, captions, tables])
    if (!unchanged) return
    const out = {
      rect: result.rect,
      sourceItems: result.sourceItems,
      graphicsCount: result.graphicsCount,
      formCropRaster: result.formCropRaster,
      ...(result.closedProgramRaster ? { closedProgramRaster: true } : {}),
      ...(result.isolatedFormRaster ? { isolatedFormRaster: true } : {}),
      recoveryProgramRaster: true,
      fallbackFigure: figure
    }
    const outputUnchanged = retainNativeRecoveryInputs([
      out.rect,
      out.sourceItems,
      out.formCropRaster
    ])
    if (!outputUnchanged) return
    certificates.set(out.formCropRaster, {
      page,
      figure,
      tokens,
      context,
      profile,
      unchanged,
      outputUnchanged,
      rect: out.rect,
      sourceItems: out.sourceItems,
      binding: outputBinding(out),
      clip: result.clip,
      legacySafe: result.closedProgramRaster
        ? nativeClosedProgramPngSafe
        : result.isolatedFormRaster
          ? nativeIsolatedFormPngSafe
          : undefined
    })
    return out
  } catch {
    return
  }
}

export function nativeRecoveryFigurePngSafe(png, rect, page, candidate) {
  const largeSave = nativeLargeSavePixelPngSafe(png, rect, page, candidate)
  if (largeSave !== undefined) return largeSave
  const paired = nativePairedClippedGroupPngSafe(png, rect, page, candidate)
  if (paired !== undefined) return paired
  const compositing = nativeCompositingFigurePngSafe(png, rect, page, candidate)
  if (compositing !== undefined) return compositing
  const values = nativeRecoveryOwnValues(candidate)
  if (!values) return false
  const proof = certificates.get(values.formCropRaster)
  if (!proof) return values.recoveryProgramRaster ? false : undefined
  try {
    if (
      page !== proof.page ||
      values.fallbackFigure !== proof.figure ||
      values.rect !== proof.rect ||
      values.sourceItems !== proof.sourceItems ||
      (Object.hasOwn(values, 'caption') && values.caption !== proof.figure.caption) ||
      values.parts ||
      values.cropRects ||
      values.headerRaster ||
      !proof.outputUnchanged() ||
      !proof.unchanged() ||
      outputBinding(values) !== proof.binding ||
      !nativeFigureRecoveryProfileData(proof.profile, page, proof.tokens, proof.context)
    )
      return false
    if (proof.legacySafe) return proof.legacySafe(png, rect, page, values)
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!raster &&
      inside(rect, expand(proof.clip, 1 / raster.scaleLower)) &&
      nativeCompleteFormCropPngSafe(png, rect, page, values)
    )
  } catch {
    return false
  }
}

const pairFinite = (r, n) =>
    (Array.isArray(r) || ArrayBuffer.isView(r)) &&
    r.length === n &&
    Array.from(r).every(Number.isFinite),
  pairValid = (r) => pairFinite(r, 4) && r[0] < r[2] && r[1] < r[3],
  pairInside = (a, b) =>
    pairFinite(a, 4) && pairFinite(b, 4) && b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i])),
  pairHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  pairExpand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  pairEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  pairBox = (r, m) =>
    union(
      [r[0], r[2]].flatMap((x) =>
        [r[1], r[3]].map((y) => [
          m[0] * x + m[2] * y + m[4],
          m[1] * x + m[3] * y + m[5],
          m[0] * x + m[2] * y + m[4],
          m[1] * x + m[3] * y + m[5]
        ])
      )
    ),
  pairedGroupCertificates = new WeakMap()
function pairedClippedGroupProgram(page, tokens, c) {
  const o = c?.operators,
    v = c?.viewport,
    raw = c?.content?.items
  if (version !== '5.4.624') return
  if (
    c?.pageNumber !== page.pageNumber ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    !/^([a-f0-9]{64})$/u.test(c.sourceSha256) ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(raw) ||
    raw.length > 4096 ||
    !Array.isArray(tokens) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(c.graphicsBounds) ||
    !pairEqual(c.graphicsBounds, page.graphicsBounds) ||
    !Array.isArray(o?.fnArray) ||
    o.fnArray.length !== o.argsArray?.length ||
    o.fnArray.length > 100000 ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !pairEqual(v.transform, [1, 0, 0, -1, 0, page.height])
  )
    return
  const groups = [],
    stack = [],
    marks = [],
    known = new Set(
      [
        'save',
        'restore',
        'transform',
        'beginGroup',
        'endGroup',
        'paintFormXObjectBegin',
        'paintFormXObjectEnd',
        'beginText',
        'endText',
        'showText',
        'setFont',
        'setTextMatrix',
        'moveText',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setGState',
        'dependency',
        'setCharSpacing',
        'constructPath',
        'paintImageXObject',
        'setLineWidth',
        'setLineCap',
        'setLineJoin',
        'setDash',
        'setMiterLimit',
        'clip',
        'eoClip',
        'beginMarkedContent',
        'beginMarkedContentProps',
        'endMarkedContent'
      ].map((k) => OPS[k])
    )
  let matrix = [1, 0, 0, 1, 0, 0],
    group,
    text = false,
    pending = false
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (!known.has(op)) return
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
      if (text) return
      stack.push({ op, matrix: [...matrix] })
      if (op === OPS.beginGroup) {
        const g = a?.[0]
        if (
          group ||
          pending ||
          marks.length ||
          groups.length >= 3 ||
          !g ||
          Object.keys(g).sort().join(',') !== 'bbox,isolated,knockout,matrix,smask' ||
          g.matrix !== null ||
          g.smask !== null ||
          g.knockout !== false ||
          typeof g.isolated !== 'boolean' ||
          !pairValid(g.bbox) ||
          matrix[0] <= 0 ||
          matrix[3] <= 0 ||
          matrix[1] !== 0 ||
          matrix[2] !== 0 ||
          o.fnArray[i + 1] !== OPS.paintFormXObjectBegin ||
          !pairEqual(o.argsArray[i + 1], [null, null])
        )
          return
        const bounds = pairBox(g.bbox, Util.transform(v.transform, matrix))
        if (!pairValid(bounds) || !pairInside([0, 0, page.width, page.height], bounds)) return
        group = { begin: i, args: g, rect: bounds, paint: [] }
        groups.push(group)
      }
      if (op === OPS.paintFormXObjectBegin) {
        if (
          !group ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          (a[0] !== null && (!pairFinite(a[0], 6) || a[0][0] * a[0][3] === a[0][1] * a[0][2])) ||
          (a[1] !== null && !pairValid(a[1]))
        )
          return
        if (a[0]) matrix = Util.transform(matrix, a[0])
        pending = false
      }
    } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      const prior = stack.pop(),
        expected =
          op === OPS.restore
            ? OPS.save
            : op === OPS.paintFormXObjectEnd
              ? OPS.paintFormXObjectBegin
              : OPS.beginGroup
      if (text || !prior || prior.op !== expected) return
      if (op === OPS.endGroup) {
        if (
          !group ||
          marks.length ||
          !pairEqual(group.args, a?.[0]) ||
          o.fnArray[i - 1] !== OPS.paintFormXObjectEnd
        )
          return
        group.end = i
        group = undefined
      }
      matrix = prior.matrix
      pending = false
    } else if (op === OPS.transform) {
      if (text || !pairFinite(a, 6) || a[0] * a[3] === a[1] * a[2]) return
      matrix = Util.transform(matrix, a)
    } else if (op === OPS.beginText) {
      if (text) return
      text = true
    } else if (op === OPS.endText) {
      if (!text) return
      text = false
    } else if (op === OPS.beginMarkedContent || op === OPS.beginMarkedContentProps) {
      if (
        !group ||
        (op === OPS.beginMarkedContent
          ? !(Array.isArray(a) && a.length === 1 && pairEqual(a[0], { name: 'Artifact' }))
          : !(
              Array.isArray(a) &&
              a.length === 2 &&
              ['P', 'Span'].includes(a[0]) &&
              Number.isSafeInteger(a[1]) &&
              a[1] >= 0
            ))
      )
        return
      marks.push(group.begin)
    } else if (op === OPS.endMarkedContent) {
      if (!group || marks.pop() !== group.begin) return
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (text) return
      pending = true
    } else if (op === OPS.constructPath) {
      if (text) return
      pending = false
      if (group && a?.[0] !== OPS.endPath) group.paint.push(i)
    } else if (op === OPS.paintImageXObject) {
      if (text) return
      if (group) group.paint.push(i)
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !(
              (['ca', 'CA'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (e[0] === 'SMask' && e[1] === false)
            )
        )
      )
        return
    }
  }
  if (
    text ||
    group ||
    stack.length ||
    marks.length ||
    pending ||
    groups.length !== 3 ||
    groups.some((g) => !Number.isInteger(g.end) || g.paint.length < 8)
  )
    return
  const belongs = (i) => groups.some((g) => i >= g.begin && i <= g.end),
    items = raw.map((r, index) => {
      if (
        typeof r.str !== 'string' ||
        r.sourceItem?.pageNumber !== page.pageNumber ||
        r.sourceItem.index !== index ||
        r.sourceItem.text !== r.str
      )
        throw Error('source identity')
      if (!r.str.trim()) return r
      if (
        !pairFinite(r.transform, 6) ||
        !Number.isFinite(r.width) ||
        r.width < 0 ||
        !(r.height > 0)
      )
        throw Error('source geometry')
      const rect = tableTextToken(r, v, 0).rect
      return groups.some((g) => pairInside(g.rect, rect)) ? { ...r, str: '' } : r
    }),
    projectedTokens = tokens.filter((t) => items[t.sourceItem?.index]?.str?.trim()),
    graphics = page.graphicsBounds.filter((g) => !belongs(g.operationIndex)),
    projected = {
      ...c,
      content: { ...c.content, items },
      operators: {
        fnArray: o.fnArray.map((op, i) => (belongs(i) ? OPS.dependency : op)),
        argsArray: o.argsArray.map((a, i) => (belongs(i) ? [] : a))
      },
      graphicsBounds: graphics
    }
  if (projected.skippedSpaceGlyphs)
    projected.skippedSpaceGlyphs = projected.skippedSpaceGlyphs.filter(
      (g) => !belongs(g.operationIndex)
    )
  const p = nativePageTextPacketInventory(
    { ...page, graphicsBounds: graphics },
    projectedTokens,
    projected,
    true
  )
  if (!p) return
  return { groups, p, removed: raw.filter((r, i) => r.str.trim() && !items[i].str.trim()).length }
}
function nativePairedClippedGroupCrop(page, f, captions, tables, tokens, c) {
  try {
    if (
      !pairValid(f?.rect) ||
      !pairValid(f.caption?.rect) ||
      f.caption.page !== page.pageNumber ||
      f.caption.lines?.length !== 1 ||
      !/^Figure\s+[1-9]\d*:\s+.+[.!?]$/u.test(f.caption.lines[0]) ||
      !['no-unambiguous-adjacent-graphics', undefined].includes(f.reason) ||
      f.sourceItems?.length ||
      f.fallbackFigure ||
      f.formCropRaster ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      !Array.isArray(captions) ||
      captions.filter((x) => x === f.caption).length !== 1 ||
      captions.filter(
        (x) =>
          x.page === page.pageNumber &&
          /^Figure\s+[1-9]\d*:/u.exec(x.lines?.[0] ?? '')?.[0] ===
            /^Figure\s+[1-9]\d*:/u.exec(f.caption.lines[0])?.[0]
      ).length !== 1 ||
      !Array.isArray(tables) ||
      !tables.every(pairValid)
    )
      return
    const unchanged = retainNativeRecoveryInputs(
      [page, f, captions, tables, tokens, c],
      c?.viewport
    )
    if (!unchanged) return
    const program = pairedClippedGroupProgram(page, tokens, c)
    if (!program) return
    const { groups, p } = program,
      labels = p.records.filter((r) => /^\([ab]\)\s+\p{L}[\p{L}\p{N} -]*$/u.test(r.r.str)),
      cap = p.records.filter((r) => pairInside(f.caption.rect, r.rect))
    if (
      labels.length !== 2 ||
      !/^\(a\)\s/u.test(labels[0].r.str) ||
      !/^\(b\)\s/u.test(labels[1].r.str) ||
      cap.length !== 1 ||
      compact(cap[0].r.str) !== compact(f.caption.lines[0])
    )
      return
    const em = labels[0].r.height,
      capStart = Math.min(...cap[0].part.map((z) => z.g.i)),
      owned = [],
      ownGlyphs = new Set(labels.flatMap((r) => r.part.map((z) => z.g))),
      bound = (r) => {
        const style = c.content.styles[r.r.fontName]
        if (
          !(style?.ascent > 0) ||
          style.ascent > 2 ||
          !Number.isFinite(style.ascent) ||
          !Number.isFinite(style.descent) ||
          style.descent > 0 ||
          style.descent < -2 ||
          style.vertical !== false
        )
          return
        const metric = nativeFigureLabelBounds(r.r, style, p.v)
        return pairValid(metric)
          ? union([r.rect, metric, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
          : undefined
      },
      domains = new Map(p.records.map((r) => [r, bound(r)]))
    if (
      !(em > 0) ||
      [...domains.values()].some((r) => !pairValid(r)) ||
      [...labels, ...cap].some(
        (r) =>
          r.r.dir !== 'ltr' ||
          r.r.transform[0] <= 0 ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[3] !== r.r.height ||
          r.part.some(
            (z) =>
              z.g.textPaint.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) ||
              /^#ffffff$/iu.test(z.g.textPaint.fillColor)
          )
      )
    )
      return
    for (const label of labels) {
      const start = Math.min(...label.part.map((z) => z.g.i)),
        end = Math.max(...label.part.map((z) => z.g.i)),
        matches = groups.filter(
          (g) =>
            g.end < start &&
            pairHit(g.rect, f.rect) &&
            g.rect[3] <= label.rect[1] &&
            label.rect[1] - g.rect[3] < em &&
            Math.abs((g.rect[0] + g.rect[2] - label.rect[0] - label.rect[2]) / 2) < em / 32
        )
      if (matches.length !== 1) return
      const g = matches[0],
        next = groups.find((q) => q.begin > g.end)?.begin ?? capStart
      if (
        end >= next ||
        p.glyphs.some((z) => z.i > g.end && z.i < next && !label.part.some((k) => k.g === z))
      )
        return
      owned.push(g)
    }
    const [a, b] = owned,
      body = union(owned.map((g) => g.rect)),
      other = groups.filter((g) => !owned.includes(g)),
      rect = union([body, ...labels.map((r) => domains.get(r))]),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = pairExpand(rect, 2 / scale)
    if (
      new Set(owned).size !== 2 ||
      labels[0].r.fontName !== labels[1].r.fontName ||
      labels[1].r.height !== em ||
      labels[0].rect[1] !== labels[1].rect[1] ||
      a.rect[2] >= b.rect[0] ||
      a.rect[3] !== b.rect[3] ||
      a.rect[2] - a.rect[0] < em * 8 ||
      b.rect[2] - b.rect[0] < em * 8 ||
      Math.abs(body[0] + body[2] - f.caption.rect[0] - f.caption.rect[2]) > em / 64 ||
      a.end >= b.begin ||
      b.end >= capStart ||
      !pairInside([0, 0, page.width, page.height], padded) ||
      pairInside(f.rect, rect)
    )
      return
    const foreign = [
      ...other.map((g) => ({ rect: g.rect, floor: 1 })),
      ...p.records
        .filter((r) => !labels.includes(r))
        .map((r) => ({ rect: domains.get(r), floor: 0 })),
      ...p.glyphs
        .filter((g) => !ownGlyphs.has(g) && !g.rendererSkipped && pairValid(g.ink))
        .map((g) => ({ rect: g.ink, floor: 0 }))
    ]
    if (
      p.evidence.paths.size ||
      p.evidence.images.length ||
      captions.some((q) => q.page === page.pageNumber && pairHit(padded, q.rect)) ||
      tables.some((t) => pairHit(padded, t)) ||
      foreign.some((q) => pairHit(padded, pairExpand(q.rect, (q.floor + 2) / scale)))
    )
      return
    const out = {
        rect,
        issue: f.issue ?? f.reason,
        formCropRaster: {
          ownedRects: [...owned.map((g) => g.rect), ...labels.map((r) => domains.get(r))],
          foreignPaints: foreign
        },
        recoveryProgramRaster: true,
        fallbackFigure: f
      },
      outputUnchanged = retainNativeRecoveryInputs([out])
    if (!outputUnchanged) return
    pairedGroupCertificates.set(out.formCropRaster, {
      page,
      f,
      unchanged,
      outputUnchanged,
      padded,
      rect: out.rect
    })
    return out
  } catch {
    return
  }
}
function nativePairedClippedGroupPngSafe(png, rect, page, candidate) {
  const values = nativeRecoveryOwnValues(candidate)
  if (!values) return false
  const proof = pairedGroupCertificates.get(values.formCropRaster)
  if (!proof) return
  return (
    page === proof.page &&
    values.fallbackFigure === proof.f &&
    values.rect === proof.rect &&
    values.issue === (proof.f.issue ?? proof.f.reason) &&
    values.graphicsCount === proof.f.graphicsCount &&
    (!Object.hasOwn(values, 'caption') || values.caption === proof.f.caption) &&
    !values.sourceItems?.length &&
    !values.parts &&
    !values.cropRects &&
    !values.headerRaster &&
    proof.unchanged() &&
    proof.outputUnchanged() &&
    pairEqual(rect, proof.padded) &&
    nativeCompleteFormCropPngSafe(png, rect, page, values)
  )
}

const savePixelCertificates = new WeakMap(),
  saveFinite = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) &&
    a.length === n &&
    Array.from(a).every(Number.isFinite),
  saveValid = (r) => saveFinite(r, 4) && r[0] < r[2] && r[1] < r[3],
  saveInside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i])),
  saveHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  saveExpand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  saveSame = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  saveMetrics = (s) =>
    Number.isFinite(s?.ascent) &&
    s.ascent > 0 &&
    s.ascent <= 2 &&
    Number.isFinite(s.descent) &&
    s.descent <= 0 &&
    s.descent >= -2
function savePixelContextBinding(context) {
  const values = nativeRecoveryOwnValues(context)
  if (!values) return
  const prototype = Object.getPrototypeOf(context),
    descriptors = Object.getOwnPropertyDescriptors(context),
    keys = Reflect.ownKeys(descriptors),
    input = Object.fromEntries(
      [
        'operators',
        'viewport',
        'content',
        'partialFontGlyphBounds',
        'glyphBounds',
        'graphicsBounds',
        'skippedSpaceGlyphs',
        'pageNumber',
        'sourceSha256',
        'dualApiEvidence'
      ]
        .filter((k) => Object.hasOwn(values, k))
        .map((k) => [k, values[k]])
    )
  // Optional page-furniture witnesses are not read by this pixel-only proof.
  // Bind every original slot without walking another page's viewport; retain
  // all native packet data consumed below through the unchanged deep observer.
  const current = () => {
    if (
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
  return { input, current }
}
// Missing foreign ascent metrics never supply an owned drawing boundary.
function savePixelForeignMetrics(style) {
  return (
    style?.vertical === false &&
    style.ascent === 0 &&
    Number.isFinite(style.descent) &&
    style.descent <= 0 &&
    style.descent >= -2
  )
}
// A single explicit Form may combine a raster panel with native companion
// paths and labels. The complete original program remains the only pixel source.
function savePixelSingleForm(p, page) {
  const stack = [],
    forms = []
  let matrix = [1, 0, 0, 1, 0, 0]
  for (let i = 0; i < p.o.fnArray.length; i++) {
    const op = p.o.fnArray[i],
      a = p.o.argsArray[i]
    if (op === OPS.beginGroup || op === OPS.endGroup) return
    if (
      op === OPS.setGState &&
      (!Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !((['CA', 'ca'].includes(e[0]) && e[1] === 1) || (e[0] === 'SMask' && e[1] === false))
        ))
    )
      return
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      const saved = { op, matrix: [...matrix] }
      stack.push(saved)
      if (op === OPS.paintFormXObjectBegin) {
        if (
          forms.length ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          (a[0] !== null && (!saveFinite(a[0], 6) || a[0][0] * a[0][3] === a[0][1] * a[0][2])) ||
          !saveValid(a[1])
        )
          return
        if (a[0]) matrix = Util.transform(matrix, a[0])
        const rect = p.box(a[1], Util.transform(p.v.transform, matrix))
        if (!saveValid(rect) || !saveInside([0, 0, page.width, page.height], rect)) return
        saved.form = { start: i, rect }
        forms.push(saved.form)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const saved = stack.pop()
      if (!saved || saved.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      if (saved.form) saved.form.end = i
      matrix = saved.matrix
    } else if (op === OPS.transform) {
      if (!saveFinite(a, 6) || a[0] * a[3] === a[1] * a[2]) return
      matrix = Util.transform(matrix, a)
    }
  }
  if (stack.length || forms.length !== 1 || !Number.isSafeInteger(forms[0].end)) return
  const form = forms[0],
    image = p.evidence.images[0]
  if (
    p.evidence.images.length !== 1 ||
    image.operationIndex <= form.start ||
    image.operationIndex >= form.end ||
    !saveValid(image.rect) ||
    !saveInside(form.rect, image.rect)
  )
    return
  const actual = page.graphicsBounds.filter(
    (g) => g.kind === 'image' && g.operationIndex === image.operationIndex
  )
  if (actual.length !== 1 || !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '')) return
  return form
}

function nativeLargeSavePixelCrop(page, f, captions, tables, tokens, context) {
  try {
    const binding = savePixelContextBinding(context)
    if (!binding) return
    const input = binding.input
    if (
      input.pageNumber !== page?.pageNumber ||
      !Number.isSafeInteger(page?.pageNumber) ||
      page.pageNumber < 1 ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '')
    )
      return
    if (
      !saveValid(f?.rect) ||
      !saveValid(f.caption?.rect) ||
      f.caption.page !== page.pageNumber ||
      !Array.isArray(f.caption.lines) ||
      !f.caption.lines.length ||
      f.caption.lines.length > 12 ||
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/iu.test(f.caption.lines[0]) ||
      f.sourceItems?.length ||
      f.fallbackFigure ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.caption.regions ||
      !Array.isArray(captions) ||
      captions.filter((c) => c === f.caption).length !== 1 ||
      !Array.isArray(tables) ||
      !tables.every(saveValid) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const key = /^(?:Figure|Fig\.?)\s+([A-Z]?\d+)[.:]/iu.exec(f.caption.lines[0])?.[1]
    if (
      captions.filter(
        (c) =>
          c.page === page.pageNumber &&
          /^(?:Figure|Fig\.?)\s+([A-Z]?\d+)[.:]/iu.exec(c.lines?.[0] ?? '')?.[1] === key
      ).length !== 1
    )
      return
    const retained = retainNativeRecoveryInputs(
        [page, f, captions, tables, tokens, input],
        input.viewport
      ),
      unchanged = () => binding.current() && retained()
    if (!retained) return
    const v = input.viewport
    if (
      v.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !saveSame(v.transform, [1, 0, 0, -1, 0, page.height])
    )
      return
    const seed = tokens.find((t) => saveValid(t.rect))?.sourceItem,
      literalPacket = seed && nativeClosedProgramInkPacket(page, tokens, input, [seed]),
      // The existing one-to-one foreign normalization bridge observes all
      // original glyphs and sources. This fallback never claims those sources.
      p =
        literalPacket ??
        (seed &&
          nativePageTextPacketInventory(page, tokens, input, true, new Set([seed.index]), true)),
      normalized = !literalPacket && p?.records.some((r) => r.foreignSourceNormalized),
      form = p && !normalized ? savePixelSingleForm(p, page) : undefined
    if (
      !p ||
      (!literalPacket && !normalized) ||
      p.records.length > 4096 ||
      p.evidence.paths.size > 4096 ||
      (!form && p.evidence.images.length) ||
      (!form &&
        p.o.fnArray.some((op) =>
          [
            OPS.paintFormXObjectBegin,
            OPS.paintFormXObjectEnd,
            OPS.beginGroup,
            OPS.endGroup
          ].includes(op)
        ))
    )
      return
    const domains = new Map()
    for (const r of p.records) {
      const style = input.content.styles[r.r.fontName]
      if (!saveMetrics(style) && !(normalized && savePixelForeignMetrics(style))) return
      const font = saveMetrics(style) ? nativeFigureLabelBounds(r.r, style, v) : undefined
      if (
        !font &&
        saveMetrics(style) &&
        !(
          r.r.width === 0 &&
          r.rect[0] === r.rect[2] &&
          r.advanceComplete &&
          r.part.length === 1 &&
          saveValid(r.part[0].g.ink)
        )
      )
        return
      const rect = union([
        r.rect,
        ...(font ? [font] : []),
        ...r.part.flatMap((z) => [z.g.ink, z.g.advance])
      ])
      if (!saveValid(rect)) return
      domains.set(r, rect)
    }
    const glyphs = p.glyphs.filter(
      (g) => !g.rendererSkipped && !(g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3])
    )
    if (
      glyphs.some(
        (g) =>
          !saveValid(g.ink) ||
          (!saveMetrics(input.content.styles[g.fontName]) &&
            !(normalized && savePixelForeignMetrics(input.content.styles[g.fontName])))
      )
    )
      return
    const glyphOwners = new Map(),
      shared = new Set()
    for (const r of p.records)
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (glyphOwners.has(g)) shared.add(g)
        else glyphOwners.set(g, r)
      }
    const paths = []
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
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint || state.strokeAlpha !== 1 || state.fillAlpha !== 1) return
      paths.push({ i, ...paint })
    }
    const scopes = [],
      stack = []
    for (let i = 0; i < p.o.fnArray.length; i++) {
      if (p.o.fnArray[i] === OPS.save) {
        const s = { start: i }
        scopes.push(s)
        stack.push(s)
        if (scopes.length > 512) return
      } else if (p.o.fnArray[i] === OPS.restore) {
        const s = stack.pop()
        if (!s) return
        s.end = i
      }
    }
    if (stack.length) return
    const result = [],
      scale = Math.ceil(page.width * 1.5) / page.width
    for (const s of scopes) {
      const paints = paths.filter((q) => q.i > s.start && q.i < s.end),
        records = p.records.filter((r) => r.part.every((z) => z.g.i > s.start && z.g.i < s.end))
      // The larger literal program and the two bounded small pixel families
      // retain their own admission. None creates or relaxes a source claim.
      if (
        paints.length < 3 ||
        (!normalized && !form && records.length <= 64) ||
        (form &&
          (records.length > 64 ||
            !records.length ||
            form.start <= s.start ||
            form.end >= s.end ||
            records.some((r) => r.part.some((z) => z.g.i <= form.start || z.g.i >= form.end)) ||
            paints.some((q) => q.i <= form.start || q.i >= form.end))) ||
        (normalized && (!records.length || records.length > 64)) ||
        records.length > 256 ||
        records.some(
          (r) =>
            !r.advanceComplete ||
            !saveMetrics(input.content.styles[r.r.fontName]) ||
            r.part.some(
              (z) =>
                shared.has(z.g) ||
                z.g.packet.start <= s.start ||
                z.g.packet.end >= s.end ||
                z.g.textPaint?.fillAlpha !== 1 ||
                !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint?.fillColor ?? '') ||
                /^#ffffff$/iu.test(z.g.textPaint.fillColor)
            )
        )
      )
        continue
      const ownedGlyphs = new Set(records.flatMap((r) => r.part.map((z) => z.g)))
      if (glyphs.some((g) => g.i > s.start && g.i < s.end && !ownedGlyphs.has(g))) continue
      // Font metrics and conservative stroke envelopes alone do not establish
      // missing picture content. This family requires actual omitted glyph ink.
      const previousCrop = saveExpand(f.rect, 2 / scale)
      previousCrop[3] = Math.max(previousCrop[3], nativeOwnedFigureInkBottom(f, tokens))
      if ([...ownedGlyphs].every((g) => saveInside(previousCrop, g.ink))) continue
      const rect = union([
          ...paints.map((q) => q.rect),
          ...records.map((r) => domains.get(r)),
          ...p.evidence.images
            .filter((q) => q.operationIndex > s.start && q.operationIndex < s.end)
            .map((q) => q.rect)
        ]),
        padded = saveExpand(rect, 2 / scale),
        em = Math.max(...records.map((r) => r.r.height)),
        area = (r) => (r[2] - r[0]) * (r[3] - r[1]),
        over = (a, b) =>
          Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
          Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
      if (
        !saveInside([0, 0, page.width, page.height], padded) ||
        rect[2] - rect[0] < (f.caption.rect[2] - f.caption.rect[0]) * 0.5 ||
        rect[3] - rect[1] < em * 5 ||
        rect[3] >= f.caption.rect[1] ||
        f.caption.rect[1] - rect[3] > em * 4 ||
        over(rect, f.rect) / area(f.rect) < 0.9 ||
        saveInside(f.rect, rect) ||
        captions.some((c) => c.page === page.pageNumber && saveHit(padded, c.rect)) ||
        tables.some((t) => saveHit(padded, t))
      )
        continue
      const foreign = [
        ...p.records
          .filter((r) => !records.includes(r))
          .map((r) => ({ rect: domains.get(r), floor: 0 })),
        ...paths.filter((q) => !paints.includes(q)).map((q) => ({ rect: q.rect, floor: q.floor })),
        ...glyphs.filter((g) => !ownedGlyphs.has(g)).map((g) => ({ rect: g.ink, floor: 0 })),
        ...p.evidence.images
          .filter((q) => q.operationIndex <= s.start || q.operationIndex >= s.end)
          .map((q) => ({ rect: q.rect, floor: 0 }))
      ]
      if (foreign.some((q) => saveHit(padded, saveExpand(q.rect, (q.floor + 2) / scale)))) continue
      const identity =
        paints.map((q) => q.i).join(',') + '|' + records.map((r) => r.index).join(',')
      if (!result.some((r) => r.identity === identity))
        result.push({ identity, rect, padded, foreign })
    }
    if (result.length !== 1) return
    const q = result[0],
      out = {
        rect: q.rect,
        issue: f.issue ?? f.reason,
        formCropRaster: { ownedRects: [q.rect], foreignPaints: q.foreign },
        recoveryProgramRaster: true,
        fallbackFigure: f
      },
      outputUnchanged = retainNativeRecoveryInputs([out])
    if (!outputUnchanged) return
    savePixelCertificates.set(out.formCropRaster, {
      page,
      f,
      rect: out.rect,
      padded: q.padded,
      unchanged,
      outputUnchanged
    })
    return out
  } catch {
    return
  }
}
function nativeLargeSavePixelPngSafe(png, rect, page, candidate) {
  const values = nativeRecoveryOwnValues(candidate)
  if (!values) return false
  const proof = savePixelCertificates.get(values.formCropRaster)
  if (!proof) return
  return (
    page === proof.page &&
    values.fallbackFigure === proof.f &&
    values.rect === proof.rect &&
    values.issue === (proof.f.issue ?? proof.f.reason) &&
    values.graphicsCount === proof.f.graphicsCount &&
    (!Object.hasOwn(values, 'caption') || values.caption === proof.f.caption) &&
    !values.sourceItems?.length &&
    !values.parts &&
    !values.cropRects &&
    !values.headerRaster &&
    proof.unchanged() &&
    proof.outputUnchanged() &&
    saveSame(rect, proof.padded) &&
    nativeCompleteFormCropPngSafe(png, rect, page, values)
  )
}

function savePixelAxisRectangle(args, matrix, viewport) {
  if (
    args?.length !== 3 ||
    args[1]?.length !== 1 ||
    !saveFinite(args[1][0], 13) ||
    !saveFinite(args[2], 4)
  )
    return
  const d = Array.from(args[1][0]),
    b = Array.from(args[2]),
    m = Util.transform(viewport.transform, matrix)
  if (
    d[0] !== 0 ||
    d[3] !== 1 ||
    d[6] !== 1 ||
    d[9] !== 1 ||
    d[12] !== 4 ||
    d[1] >= d[4] ||
    d[2] >= d[8] ||
    d[1] !== d[10] ||
    d[2] !== d[5] ||
    d[4] !== d[7] ||
    d[8] !== d[11] ||
    !saveSame(b, [d[1], d[2], d[4], d[8]]) ||
    !saveFinite(m, 6) ||
    m[1] !== 0 ||
    m[2] !== 0 ||
    m[0] === 0 ||
    m[3] === 0
  )
    return
  const x = [m[0] * b[0] + m[4], m[0] * b[2] + m[4]],
    y = [m[3] * b[1] + m[5], m[3] * b[3] + m[5]]
  return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]
}
function savePixelPageRectangle(args, matrix, viewport, page) {
  const rect = savePixelAxisRectangle(args, matrix, viewport),
    ulp = (n) => Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(n)) - 23)),
    tolerance = [ulp(page.width), ulp(page.height)]
  if (!rect) return
  return rect.every((x, i) => Math.abs(x - [0, 0, page.width, page.height][i]) <= tolerance[i % 2])
    ? rect
    : undefined
}
function savePixelInitialBackdrop(p, page) {
  const drawable = [...p.evidence.paths].filter(([i]) => p.o.argsArray[i][0] !== OPS.endPath),
    first = drawable[0]
  if (!first || p.evidence.images.length || p.glyphs.some((g) => g.i <= first[0])) return
  const [index, state] = first
  if (state.fillAlpha !== 1 || state.strokeAlpha !== 1 || p.o.argsArray[index][0] !== OPS.fill)
    return
  let matrix = [1, 0, 0, 1, 0, 0],
    fill,
    clip = false
  const stack = []
  for (let i = 0; i <= index; i++) {
    const op = p.o.fnArray[i],
      a = p.o.argsArray[i]
    if (op === OPS.save) {
      if (clip) return
      stack.push({ matrix, fill })
      matrix = [...matrix]
    } else if (op === OPS.restore) {
      if (clip || !stack.length) return
      ;({ matrix, fill } = stack.pop())
    } else if (op === OPS.transform) {
      if (clip || !saveFinite(a, 6) || a[0] * a[3] === a[1] * a[2]) return
      matrix = Util.transform(matrix, a)
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (clip) return
      clip = true
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (clip || !Array.isArray(a) || a.length !== 1 || !/^#[a-f0-9]{6}$/iu.test(a[0])) return
      if (op === OPS.setFillRGBColor) fill = a[0]
    } else if (op === OPS.setGState) {
      if (
        clip ||
        !Array.isArray(a?.[0]) ||
        a.length !== 1 ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !(
              (['ca', 'CA'].includes(e[0]) && e[1] === 1) ||
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (e[0] === 'SMask' && e[1] === false)
            )
        )
      )
        return
    } else if (op === OPS.constructPath) {
      const rect = savePixelPageRectangle(a, matrix, p.v, page)
      if (!rect) return
      if (i === index) {
        if (clip || !fill || !saveSame(matrix, state.transform) || !saveFinite(state.clip, 4))
          return
        const ulp = (n) => Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(n)) - 23))
        if (
          !state.clip.every(
            (n, k) =>
              Math.abs(n - [0, 0, page.width, page.height][k]) <=
              ulp(k % 2 ? page.height : page.width)
          )
        )
          return
        return { index, rect }
      }
      if (a[0] !== OPS.endPath || !clip) return
      clip = false
    } else return
  }
}

const sharedFramePlans = new WeakMap()
// A clip established before every paint in a closed root remains an upper
// bound even when a later clip has an unsupported shape. This projection is
// private measurement only; it never supplies a packet or a Source owner.
export function nativeSharedFramePixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure.rect
) {
  try {
    const binding = savePixelContextBinding(context)
    if (!binding) return
    const input = binding.input,
      v = input.viewport,
      retained = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, publishedRect, input],
        v
      )
    if (
      !retained ||
      !saveValid(figure?.rect) ||
      !saveValid(publishedRect) ||
      !saveValid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      figure.caption.regions ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      captions.filter((c) => c === figure.caption).length !== 1 ||
      !tables.every(saveValid) ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !saveSame(v.transform, [1, 0, 0, -1, 0, page.height])
    )
      return
    const o = input.operators,
      roots = [],
      stack = [],
      clips = [],
      groups = new Map()
    let matrix = [1, 0, 0, 1, 0, 0],
      root,
      pending = false
    if (
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000
    )
      return
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (
        [OPS.beginGroup, OPS.endGroup, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd].includes(
          op
        )
      )
        return
      if (op === OPS.save) {
        if (pending || roots.length > 512) return
        if (!stack.length) {
          root = { start: i }
          roots.push(root)
        }
        stack.push([...matrix])
      } else if (op === OPS.restore) {
        if (pending || !stack.length) return
        matrix = stack.pop()
        if (!stack.length) {
          root.end = i
          root = undefined
        }
      } else if (op === OPS.transform) {
        if (!saveFinite(a, 6) || a[0] * a[3] === a[1] * a[2]) return
        matrix = Util.transform(matrix, a)
      } else if (op === OPS.clip || op === OPS.eoClip) pending = true
      else if (op === OPS.constructPath && (pending || [OPS.clip, OPS.eoClip].includes(a?.[0]))) {
        pending = false
        const rect = savePixelAxisRectangle(a, matrix, v),
          event = { i, root, rect, matrix: [...matrix] }
        clips.push(event)
        if (clips.length > 2048) return
        if (!root || !rect || a[0] !== OPS.endPath) continue
        const key = JSON.stringify(rect)
        if (!groups.has(key)) groups.set(key, { frame: rect, roots: [], events: [] })
        const group = groups.get(key)
        if (!group.roots.includes(root)) group.roots.push(root)
        group.events.push(i)
      }
    }
    if (stack.length || pending || groups.size > 128) return
    const original = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
    collectClosedFigureFrames(o, v, original)
    const results = [],
      scale = Math.ceil(page.width * 1.5) / page.width,
      paint = (op, a) =>
        op === OPS.showText ||
        (op === OPS.constructPath && a[0] !== OPS.endPath) ||
        [OPS.paintImageXObject, OPS.paintImageMaskXObject].includes(op)
    for (const group of groups.values()) {
      const { frame } = group,
        crop = saveExpand(frame, 2 / scale)
      if (
        group.roots.length < 2 ||
        group.roots.some(
          (r, i) => i && roots.indexOf(r) !== roots.indexOf(group.roots[i - 1]) + 1
        ) ||
        frame[1] <= figure.caption.rect[3] ||
        !saveHit(frame, publishedRect) ||
        !saveInside([0, 0, page.width, page.height], crop) ||
        captions.some((c) => c.page === page.pageNumber && saveHit(crop, c.rect)) ||
        tables.some((t) => saveHit(crop, t))
      )
        continue
      const belongs = (i) => group.roots.some((r) => i > r.start && i < r.end)
      let closed = true
      for (const r of group.roots) {
        let guarded = false
        const states = []
        for (let i = r.start + 1; i < r.end; i++) {
          const op = o.fnArray[i]
          if (op === OPS.save) states.push(guarded)
          else if (op === OPS.restore) guarded = states.pop()
          else if (group.events.includes(i)) guarded = true
          else if (paint(op, o.argsArray[i]) && !guarded) closed = false
        }
        if (states.length) closed = false
      }
      if (!closed) continue
      const argsArray = [...o.argsArray]
      for (const e of clips.filter((e) => belongs(e.i) && !e.rect)) {
        if (o.argsArray[e.i][0] !== OPS.endPath) {
          closed = false
          break
        }
        const inverse = Util.inverseTransform(Util.transform(v.transform, e.matrix)),
          points = [
            [frame[0], frame[1]],
            [frame[2], frame[1]],
            [frame[2], frame[3]],
            [frame[0], frame[3]]
          ]
        if (!saveFinite(inverse, 6)) {
          closed = false
          break
        }
        for (const q of points) Util.applyTransform(q, inverse)
        argsArray[e.i] = [
          OPS.endPath,
          [[0, ...points[0], 1, ...points[1], 1, ...points[2], 1, ...points[3], 4]],
          [
            Math.min(...points.map((q) => q[0])),
            Math.min(...points.map((q) => q[1])),
            Math.max(...points.map((q) => q[0])),
            Math.max(...points.map((q) => q[1]))
          ]
        ]
      }
      if (!closed) continue
      const projection = { ...input, operators: { fnArray: o.fnArray, argsArray } },
        p = nativeClosedPrintedFaceInkPacket(
          page,
          tokens,
          projection,
          tokens.map((t) => t.sourceItem),
          [0, 0, page.width, page.height]
        )
      if (!p || p.records.length > 4096 || p.evidence.paths.size > 4096 || p.evidence.images.length)
        continue
      const backdrop = savePixelInitialBackdrop(p, page)
      if (!backdrop || !saveInside(backdrop.rect, crop)) continue
      // A real, originally rectangle-clipped outline must be missing. Unknown
      // inner clips cannot create a false defect witness from unclipped ink.
      if (
        !p.glyphs.some((g) => {
          const clip = original.texts.get(g.i)?.clip
          return (
            belongs(g.i) &&
            !g.rendererSkipped &&
            saveValid(g.ink) &&
            saveValid(clip) &&
            saveInside(clip, g.ink) &&
            !saveInside(publishedRect, g.ink) &&
            g.textPaint.fillAlpha === 1 &&
            /^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) &&
            !/^#ffffff$/iu.test(g.textPaint.fillColor)
          )
        })
      )
        continue
      const foreignPaints = p.glyphs
        .filter((g) => !belongs(g.i) && !g.rendererSkipped)
        .map((g) => ({ rect: g.ink, floor: 0 }))
      for (const [i, state] of p.evidence.paths) {
        const a = o.argsArray[i]
        if (
          belongs(i) ||
          i === backdrop.index ||
          a[0] === OPS.endPath ||
          (a[1]?.length === 1 && a[1][0] === null && a[2] === null)
        )
          continue
        const q = nativeFigurePathPaint(p, i, state)
        if (!q) {
          closed = false
          break
        }
        foreignPaints.push({ rect: q.rect, floor: q.floor })
      }
      if (
        !closed ||
        foreignPaints.some(
          (q) =>
            !saveValid(q.rect) ||
            saveHit(saveExpand(crop, 0.5), saveExpand(q.rect, (q.floor + 2) / 4))
        )
      )
        continue
      const proof = { formCropRaster: { ownedRects: [frame], foreignPaints } },
        projectionCurrent = retainNativeRecoveryInputs([projection, proof], v)
      if (projectionCurrent) results.push({ crop, proof, projectionCurrent })
    }
    // Every candidate faces the same complete foreign-paint test. A subset of
    // label roots cannot borrow the main drawing as unclaimed picture content.
    if (results.length !== 1 || !binding.current() || !retained()) return
    const result = results[0],
      plan = Object.freeze({ rect: result.crop }),
      outputCurrent = retainNativeRecoveryInputs([plan])
    if (!outputCurrent) return
    sharedFramePlans.set(plan, { page, result, binding, retained, outputCurrent })
    return plan
  } catch {
    return
  }
}

export function nativeSharedFramePixelPngSafe(plan, png, rect, page) {
  try {
    const proof = sharedFramePlans.get(plan)
    return (
      !!proof &&
      proof.page === page &&
      proof.binding.current() &&
      proof.retained() &&
      proof.outputCurrent() &&
      proof.result.projectionCurrent() &&
      saveSame(rect, plan.rect) &&
      nativeCompleteFormCropPngSafe(png, rect, page, proof.result.proof)
    )
  } catch {
    return false
  }
}

const barChartPlans = new WeakMap(),
  blockedTableCodes = new Set([
    'overlapping-predicted-columns',
    'conflicting-spanning-cells',
    'unresolved-spanning-cells',
    'span-conflicts-with-source-rows',
    'span-conflicts-with-source-columns',
    'native-table-structure-ambiguous'
  ])

function nativeTableViewportScale(page, table) {
  const v = table.sourceViewport,
    scale = v?.width / page.width
  return Number.isFinite(scale) &&
    scale > 0 &&
    scale <= 16 &&
    v.height / page.height === scale &&
    (v.scale === undefined || v.scale === scale)
    ? scale
    : undefined
}

function nativeBarRoles(p, crop) {
  const scopes = [],
    stack = []
  for (let i = 0; i < p.o.fnArray.length; i++) {
    if (p.o.fnArray[i] === OPS.save) {
      const s = { start: i }
      scopes.push(s)
      stack.push(s)
    } else if (p.o.fnArray[i] === OPS.restore) {
      const s = stack.pop()
      if (!s) return
      s.end = i
    }
  }
  if (stack.length || scopes.length > 512) return
  const result = [],
    amount = (r) => /^([$€£]?)(\d+(?:\.\d+)?)([A-Za-z%]*)$/u.exec(r.r.str),
    near = (a, b) => Math.abs(a - b) < 1e-6
  for (const s of scopes) {
    const first = s.start + 2,
      state = p.evidence.paths.get(first),
      a = p.o.argsArray[first],
      frame =
        state &&
        [OPS.clip, OPS.eoClip].includes(p.o.fnArray[s.start + 1]) &&
        a?.[0] === OPS.endPath &&
        savePixelAxisRectangle(a, state.transform, p.v)
    if (!frame || !saveInside(crop, frame)) continue
    const records = p.records.filter((r) => r.part.every((z) => z.g.i > s.start && z.g.i < s.end)),
      bars = [],
      rails = []
    let complete = true
    for (const [i, st] of p.evidence.paths) {
      if (i <= s.start || i >= s.end) continue
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath) continue
      const rect = a[0] === OPS.fill && savePixelAxisRectangle(a, st.transform, p.v)
      if (rect) {
        bars.push(rect)
        continue
      }
      const d = a[1]?.[0],
        m = Util.transform(p.v.transform, st.transform)
      if (
        a[0] !== OPS.stroke ||
        !saveFinite(d, 6) ||
        d[0] !== 0 ||
        d[3] !== 1 ||
        !saveFinite(m, 6)
      ) {
        complete = false
        break
      }
      const x = [d[1], d[2]],
        y = [d[4], d[5]]
      Util.applyTransform(x, m)
      Util.applyTransform(y, m)
      if (!near(x[0], y[0]) || x[1] === y[1]) {
        complete = false
        break
      }
      rails.push({ x: x[0], top: Math.min(x[1], y[1]), bottom: Math.max(x[1], y[1]) })
    }
    if (!complete || bars.length < 3 || bars.length > 32 || rails.length < 3 || rails.length > 32)
      continue
    bars.sort((a, b) => a[1] - b[1])
    rails.sort((a, b) => a.x - b.x)
    if (
      bars.some(
        (r, i) =>
          !near(r[0], bars[0][0]) ||
          !near(r[3] - r[1], bars[0][3] - bars[0][1]) ||
          (i && r[1] <= bars[i - 1][3])
      ) ||
      rails.some(
        (r, i) =>
          !near(r.top, rails[0].top) ||
          !near(r.bottom, rails[0].bottom) ||
          (i && r.x <= rails[i - 1].x)
      ) ||
      !near(bars[0][0], rails[0].x)
    )
      continue
    const axis = records.filter((r) => amount(r) && r.rect[1] > bars.at(-1)[3]),
      names = new Set(),
      values = new Set()
    if (axis.length !== rails.length) continue
    axis.sort((a, b) => a.rect[0] - b.rect[0])
    const unit = amount(axis[0]),
      step = +amount(axis[1])[2] - +unit[2]
    if (
      +unit[2] !== 0 ||
      !(step > 0) ||
      axis.some((r, i) => {
        const n = amount(r)
        return (
          n[1] !== unit[1] ||
          n[3] !== unit[3] ||
          +n[2] !== i * step ||
          Math.abs((r.rect[0] + r.rect[2]) / 2 - rails[i].x) > r.r.height / 2 ||
          !near(r.rect[3], axis[0].rect[3])
        )
      })
    )
      continue
    for (const bar of bars) {
      const matches = records.filter(
          (r) => amount(r) && r.rect[0] > bar[2] && r.rect[3] > bar[1] && r.rect[3] < bar[3]
        ),
        value = matches[0],
        left =
          value &&
          records.filter((r) => !amount(r) && r.rect[2] < bar[0] && near(r.rect[3], value.rect[3]))
      if (matches.length !== 1 || left.length !== 1 || names.has(left[0]) || values.has(value)) {
        complete = false
        break
      }
      const n = amount(value)
      if (n[1] !== unit[1] || n[3] !== unit[3] || !(+n[2] > 0) || +n[2] > +amount(axis.at(-1))[2]) {
        complete = false
        break
      }
      names.add(left[0])
      values.add(value)
    }
    if (complete && records.length === names.size + values.size + axis.length)
      result.push({ frame, records, names, values })
  }
  return result.length === 1 ? result[0] : undefined
}

// The table remains present and blocked by the existing Reader conflict code.
// Only a live, native-bound mixed capture loses its physical-table veto here.
export function nativeBarChartPixelCrop(options) {
  try {
    const values = nativeRecoveryOwnValues(options),
      optionBinding = values && savePixelContextBinding(options)
    if (!optionBinding) return
    const {
        page,
        figure,
        captions,
        tables,
        tokens,
        context,
        publishedRect,
        competingRects,
        recognizedTableRects
      } = values,
      binding = savePixelContextBinding(context)
    if (
      !binding ||
      !saveValid(publishedRect) ||
      !Array.isArray(tables) ||
      !tables.length ||
      tables.length > 64 ||
      !Array.isArray(competingRects) ||
      !competingRects.every(saveValid) ||
      !Array.isArray(recognizedTableRects) ||
      !recognizedTableRects.every(saveValid)
    )
      return
    const input = binding.input,
      retained = retainNativeRecoveryInputs(
        [
          page,
          figure,
          captions,
          tables,
          tokens,
          publishedRect,
          competingRects,
          recognizedTableRects,
          input
        ],
        input.viewport
      )
    if (!retained) return
    const tableRects = tables.map(
      (t) =>
        Array.isArray(t.region) && t.region.map((x, i) => x * (i % 2 ? page.height : page.width))
    )
    if (
      !tableRects.every(saveValid) ||
      !tables.some(
        (t, i) =>
          saveHit(tableRects[i], publishedRect) &&
          t.issues?.some((code) => blockedTableCodes.has(code))
      )
    )
      return
    const recovery = nativeCaptionBeforeSavePixelCrop(
      page,
      figure,
      captions,
      competingRects,
      tokens,
      context
    )
    if (!recovery) return
    const p = nativeClosedPrintedFaceInkPacket(
        page,
        tokens,
        input,
        tokens.map((t) => t.sourceItem),
        [0, 0, page.width, page.height]
      ),
      role = p && nativeBarRoles(p, recovery.rect)
    if (!role) return
    const cap = p.records.filter((r) => saveInside(figure.caption.rect, r.rect)),
      capIds = new Set(cap.map((r) => r.index)),
      ownIds = new Set(role.records.map((r) => r.index)),
      source = new Map(p.records.map((r) => [r.index, r])),
      excluded = []
    for (const [n, t] of tables.entries()) {
      if (!saveHit(tableRects[n], recovery.rect)) continue
      if (
        t.page !== page.pageNumber ||
        t.caption ||
        t.captionIssue !== 'no-adjacent-table-caption' ||
        !Array.isArray(t.issues) ||
        !t.issues.some((code) => blockedTableCodes.has(code)) ||
        !Array.isArray(t.cells) ||
        !t.cells.length ||
        t.cells.length > 4096
      )
        return
      const sourceScale = nativeTableViewportScale(page, t)
      if (!sourceScale || !saveValid(t.cropRect)) return
      const claims = []
      for (const cell of t.cells) {
        const owners = cell.sourceItems ?? [],
          rects = cell.sourceRects
        if (
          !Array.isArray(owners) ||
          !Array.isArray(rects) ||
          owners.length !== rects.length ||
          cell.sourceSegments?.length ||
          typeof cell.text !== 'string' ||
          compact(cell.text) !== compact(owners.map((s) => s.text).join(''))
        )
          return
        for (const [i, s] of owners.entries()) {
          const r = source.get(s.index),
            expected = r?.rect.map((x) => x * sourceScale)
          if (
            !r ||
            s.pageNumber !== page.pageNumber ||
            s.text !== r.r.str ||
            !saveFinite(rects[i], 4) ||
            rects[i].some((x, k) => Math.abs(x - expected[k]) > 1e-6)
          )
            return
          claims.push(r)
        }
      }
      if (
        new Set(claims).size !== claims.length ||
        !claims.some((r) => capIds.has(r.index)) ||
        !claims.some((r) => !ownIds.has(r.index) && !capIds.has(r.index)) ||
        !claims.some((r) => role.names.has(r)) ||
        !claims.some((r) => role.values.has(r)) ||
        tableRects[n][1] >= figure.caption.rect[1]
      )
        return
      excluded.push(n)
    }
    if (excluded.length !== 1) return
    const nativeCrops = tables.map((t) => {
        const scale = nativeTableViewportScale(page, t)
        return scale && t.cropRect?.map((x) => x / scale)
      }),
      sameRect = (a, b) =>
        saveFinite(a, 4) && saveFinite(b, 4) && a.every((x, i) => Math.abs(x - b[i]) < 1e-6),
      unmatched = []
    for (const r of recognizedTableRects) {
      const matches = tables.flatMap((t, i) =>
        sameRect(r, tableRects[i]) || sameRect(r, nativeCrops[i]) ? [i] : []
      )
      if (matches.length > 1) return
      if (!matches.length || !excluded.includes(matches[0])) unmatched.push(r)
    }
    const kept = [
        ...competingRects,
        ...tableRects.filter((r, i) => !excluded.includes(i)),
        ...unmatched
      ],
      final = nativeCaptionBeforeSavePixelCrop(page, figure, captions, kept, tokens, context)
    if (
      !final ||
      !saveSame(final.rect, recovery.rect) ||
      !role.records.some((r) =>
        r.part.some(
          (z) => !z.g.rendererSkipped && saveValid(z.g.ink) && !saveInside(publishedRect, z.g.ink)
        )
      )
    )
      return
    const candidate = { ...figure, ...final },
      crop = saveExpand(final.rect, 2 / (Math.ceil(page.width * 1.5) / page.width)),
      plan = Object.freeze({ rect: crop }),
      outputCurrent = retainNativeRecoveryInputs([plan, candidate], input.viewport)
    if (!outputCurrent || !optionBinding.current() || !binding.current() || !retained()) return
    barChartPlans.set(plan, { page, candidate, optionBinding, binding, retained, outputCurrent })
    return plan
  } catch {
    return
  }
}

export function nativeBarChartPixelPngSafe(plan, png, rect, page) {
  try {
    const p = barChartPlans.get(plan)
    return (
      !!p &&
      p.page === page &&
      p.optionBinding.current() &&
      p.binding.current() &&
      p.retained() &&
      p.outputCurrent() &&
      saveSame(rect, plan.rect) &&
      nativeLargeSavePixelPngSafe(png, rect, page, p.candidate)
    )
  } catch {
    return false
  }
}
function nativeCaptionBeforeSavePixelCrop(page, f, captions, tables, tokens, context) {
  try {
    const binding = savePixelContextBinding(context)
    if (!binding) return
    const input = binding.input,
      v = input.viewport
    if (
      input.pageNumber !== page?.pageNumber ||
      !Number.isSafeInteger(page?.pageNumber) ||
      page.pageNumber < 1 ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      !saveValid(f?.rect) ||
      !saveValid(f.caption?.rect) ||
      f.caption.page !== page.pageNumber ||
      f.caption.rect[3] >= f.rect[1] ||
      !Array.isArray(f.caption.lines) ||
      !f.caption.lines.length ||
      f.caption.lines.length > 12 ||
      f.sourceItems?.length ||
      f.fallbackFigure ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.caption.regions ||
      !Array.isArray(captions) ||
      captions.filter((c) => c === f.caption).length !== 1 ||
      !Array.isArray(tables) ||
      !tables.every(saveValid) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !saveSame(v.transform, [1, 0, 0, -1, 0, page.height])
    )
      return
    const prefix = /^(?:Figure|Fig\.?)\s+([A-Z]?\d+(?:\.[a-z])?)(?:[.:]|\s*\|)/iu,
      key = prefix.exec(f.caption.lines[0])?.[1]
    if (
      !key ||
      captions.filter(
        (c) => c.page === page.pageNumber && prefix.exec(c.lines?.[0] ?? '')?.[1] === key
      ).length !== 1 ||
      tokens.length < 1 ||
      tokens.length > 64
    )
      return
    const retained = retainNativeRecoveryInputs([page, f, captions, tables, tokens, input], v),
      unchanged = () => binding.current() && retained()
    if (!retained) return
    const p = nativeClosedPrintedFaceInkPacket(
      page,
      tokens,
      input,
      tokens.map((t) => t.sourceItem),
      [0, 0, page.width, page.height]
    )
    if (
      !p ||
      p.records.length > 64 ||
      p.evidence.paths.size > 4096 ||
      p.evidence.images.length ||
      p.o.fnArray.some((op) =>
        [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup].includes(
          op
        )
      )
    )
      return
    const backdrop = savePixelInitialBackdrop(p, page)
    if (!backdrop) return
    const domains = new Map()
    for (const r of p.records) {
      const style = input.content.styles[r.r.fontName],
        font = saveMetrics(style) && nativeFigureLabelBounds(r.r, style, v)
      if (!font || !r.advanceComplete) return
      const rect = union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (!saveValid(rect)) return
      domains.set(r, rect)
    }
    const glyphs = p.glyphs.filter(
      (g) => !g.rendererSkipped && !(g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3])
    )
    if (glyphs.some((g) => !saveValid(g.ink) || !saveMetrics(input.content.styles[g.fontName])))
      return
    const cap = p.records.filter((r) => saveInside(f.caption.rect, r.rect)),
      compact = (s) => s.replace(/\s/gu, '')
    if (
      !cap.length ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join(' '))
    )
      return
    const captionLast = Math.max(...cap.flatMap((r) => r.part.map((z) => z.g.packet.end))),
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
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint || state.fillAlpha !== 1 || state.strokeAlpha !== 1) return
      if (i !== backdrop.index) paths.push({ i, state, ...paint })
    }
    const scopes = [],
      stack = []
    for (let i = 0; i < p.o.fnArray.length; i++) {
      if (p.o.fnArray[i] === OPS.save) {
        const s = { start: i }
        scopes.push(s)
        stack.push(s)
        if (scopes.length > 512) return
      } else if (p.o.fnArray[i] === OPS.restore) {
        const s = stack.pop()
        if (!s) return
        s.end = i
      }
    }
    if (stack.length) return
    const seen = new Map(),
      shared = new Set()
    for (const r of p.records)
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (seen.has(g)) shared.add(g)
        else seen.set(g, r)
      }
    const results = [],
      scale = Math.ceil(page.width * 1.5) / page.width
    for (const s of scopes) {
      if (s.start <= captionLast) continue
      const frameState = p.evidence.paths.get(s.start + 2),
        frameArgs = p.o.argsArray[s.start + 2],
        frame =
          frameState &&
          [OPS.clip, OPS.eoClip].includes(p.o.fnArray[s.start + 1]) &&
          p.o.fnArray[s.start + 2] === OPS.constructPath &&
          frameArgs[0] === OPS.endPath &&
          savePixelAxisRectangle(frameArgs, frameState.transform, v)
      if (!saveValid(frame) || !saveInside([0, 0, page.width, page.height], frame)) continue
      const paints = paths.filter((q) => q.i > s.start && q.i < s.end),
        records = p.records.filter((r) => r.part.every((z) => z.g.i > s.start && z.g.i < s.end))
      if (
        paints.some((q) => !saveValid(q.state.clip) || !saveInside(frame, q.state.clip)) ||
        records.some((r) => r.part.some((z) => !saveInside(frame, z.g.ink)))
      )
        continue
      if (
        paints.length < 3 ||
        records.length < 3 ||
        records.length > 64 ||
        records.some(
          (r) =>
            cap.includes(r) ||
            r.part.some(
              (z) =>
                shared.has(z.g) ||
                z.g.packet.start <= s.start ||
                z.g.packet.end >= s.end ||
                z.g.textPaint?.fillAlpha !== 1 ||
                !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint?.fillColor ?? '') ||
                /^#ffffff$/iu.test(z.g.textPaint.fillColor)
            )
        )
      )
        continue
      const ownedGlyphs = new Set(records.flatMap((r) => r.part.map((z) => z.g)))
      if (glyphs.some((g) => g.i > s.start && g.i < s.end && !ownedGlyphs.has(g))) continue
      // A wider declared clip frame is not evidence of lost picture content.
      // Decline even an uncertain AA-only margin when every physical envelope is
      // already inside the original published crop; require actual omitted ink.
      const previousCrop = saveExpand(f.rect, 2 / scale),
        physical = [
          ...paints.map((q) => q.rect),
          ...records.flatMap((r) => r.part.map((z) => z.g.ink))
        ]
      if (physical.every((r) => saveInside(previousCrop, r))) continue
      const rect = union([
          frame,
          ...paints.map((q) => q.rect),
          ...records.map((r) => domains.get(r))
        ]),
        padded = saveExpand(rect, 2 / scale),
        em = Math.max(...cap.map((r) => r.r.height)),
        area = (r) => (r[2] - r[0]) * (r[3] - r[1]),
        over = (a, b) =>
          Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
          Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
      if (
        !saveInside([0, 0, page.width, page.height], padded) ||
        !saveInside(backdrop.rect, padded) ||
        rect[2] - rect[0] < (f.caption.rect[2] - f.caption.rect[0]) * 0.5 ||
        rect[3] - rect[1] < em * 5 ||
        rect[1] <= f.caption.rect[3] ||
        rect[1] - f.caption.rect[3] > em * 4 ||
        over(rect, f.rect) / area(f.rect) < 0.9 ||
        saveInside(f.rect, rect) ||
        captions.some((c) => c.page === page.pageNumber && saveHit(padded, c.rect)) ||
        tables.some((t) => saveHit(padded, t))
      )
        continue
      const foreign = [
        ...p.records
          .filter((r) => !records.includes(r))
          .map((r) => ({ rect: domains.get(r), floor: 0 })),
        ...paths.filter((q) => !paints.includes(q)).map((q) => ({ rect: q.rect, floor: q.floor })),
        ...glyphs.filter((g) => !ownedGlyphs.has(g)).map((g) => ({ rect: g.ink, floor: 0 }))
      ]
      if (foreign.some((q) => saveHit(padded, saveExpand(q.rect, (q.floor + 2) / scale)))) continue
      const identity =
        paints.map((q) => q.i).join(',') + '|' + records.map((r) => r.index).join(',')
      if (!results.some((r) => r.identity === identity))
        results.push({ identity, rect, padded, foreign })
    }
    if (results.length !== 1) return
    const q = results[0],
      out = {
        rect: q.rect,
        issue: f.issue ?? f.reason,
        formCropRaster: { ownedRects: [q.rect], foreignPaints: q.foreign },
        recoveryProgramRaster: true,
        fallbackFigure: f
      },
      outputUnchanged = retainNativeRecoveryInputs([out])
    if (!outputUnchanged) return
    savePixelCertificates.set(out.formCropRaster, {
      page,
      f,
      rect: out.rect,
      padded: q.padded,
      unchanged,
      outputUnchanged
    })
    return out
  } catch {
    return
  }
}

const pictureValid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const pictureHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const pictureInside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-7 : v <= a[i] + 1e-7))
const pictureExpand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n))
const pictureCompact = (s) => s.normalize('NFD').replace(/\s/gu, '')
function pictureBounds(p, scale) {
  const expanded = pictureExpand(p.rect, ((p.floor ?? 0) + 1) / scale),
    c = p.paintClip
  const r = c
    ? [
        Math.max(expanded[0], c[0]),
        Math.max(expanded[1], c[1]),
        Math.min(expanded[2], c[2]),
        Math.min(expanded[3], c[3])
      ]
    : expanded
  return pictureValid(r) ? r : undefined
}
function picturePackets(items) {
  const groups = new Map()
  for (const p of items.filter((p) => p.kind === 'glyph')) {
    if (!groups.has(p.packetBegin)) groups.set(p.packetBegin, [])
    groups.get(p.packetBegin).push(p)
  }
  return [...groups].map(([begin, pieces]) => ({
    begin,
    end: pieces[0].packetEnd,
    pieces,
    text: pieces.map((p) => p.text).join(''),
    rect: union(pieces.map((p) => p.bound))
  }))
}
function pictureScopePieces(scope, items) {
  return items.filter((p) => p.operationIndex > scope.begin && p.operationIndex < scope.end)
}

function pictureOpeningParagraphForm(data, items, figure, pageCaps, page, tokens, context) {
  if (figure.sourceItems?.length || pageCaps.length !== 1 || pageCaps[0] !== figure.caption) return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  if (forms.length !== 1) return
  const scope = forms[0],
    own = pictureScopePieces(scope, items),
    top = own.length && Math.min(...own.map((p) => p.bound[1]))
  if (
    !own.some((p) => p.kind === 'path') ||
    !own.some((p) => p.kind === 'glyph') ||
    own.some((p) => !['glyph', 'path'].includes(p.kind)) ||
    Math.max(...own.map((p) => p.bound[3])) >= figure.caption.rect[1]
  )
    return
  const nonempty = context.content.items.filter((r) => r.str?.trim()),
    prefix = nonempty.filter((r) => {
      const token = tableTextToken(r, context.viewport, 0)
      return pictureValid(token?.rect) && token.rect[3] < top
    })
  if (
    !prefix.length ||
    prefix.length > 4096 ||
    prefix.some((r, i) => r !== nonempty[i]) ||
    prefix.some((r) => r.sourceItem?.text !== r.str)
  )
    return
  const indices = new Set(prefix.map((r) => r.sourceItem.index)),
    packet = nativePageTextPacketInventory(page, tokens, context, true, indices, true)
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const body = packet.records.filter(
      (r) => r.part.length && r.part.every(({ g }) => g.i < scope.begin)
    ),
    first = body[0]?.r,
    em = first?.height,
    font = first?.fontName,
    style = context.content.styles[font]
  if (
    body.length !== prefix.length ||
    body.some(
      (r, i) => r.r !== prefix[i] || r.foreignSourceNormalized || r.advanceComplete !== true
    ) ||
    !(em > 0) ||
    !/^\p{Lu}\p{Ll}*\s+\p{Ll}/u.test(first.str) ||
    /^(?:Notes?|Sources?|Abstract|Remarks?|Figures?|Fig\.|Tables?|Algorithms?|Programs?)\b/iu.test(
      first.str
    ) ||
    !/[.!?]$/u.test(body.at(-1).r.str) ||
    (body
      .map((r) => r.r.str)
      .join(' ')
      .match(/\p{L}{2,}/gu)?.length ?? 0) < 30 ||
    !Number.isFinite(style?.ascent) ||
    !Number.isFinite(style?.descent) ||
    style.vertical !== false ||
    style.ascent <= 0 ||
    style.ascent > 2 ||
    style.descent > 0 ||
    style.descent < -2
  )
    return
  if (
    body.some(
      ({ r }) =>
        r.fontName !== font ||
        r.height !== em ||
        r.dir !== 'ltr' ||
        !Array.isArray(r.transform) ||
        r.transform.length !== 6 ||
        !r.transform.every(Number.isFinite) ||
        r.transform[0] !== em ||
        r.transform[1] !== 0 ||
        r.transform[2] !== 0 ||
        r.transform[3] !== em
    )
  )
    return
  const bases = [...new Set(body.map((r) => r.r.transform[5]))].sort((a, b) => b - a),
    rows = bases.map((b) => body.filter((r) => r.r.transform[5] === b)),
    bounds = rows.map((rs) => union(rs.map((r) => r.rect))),
    pitch = bases[0] - bases[1],
    left = Math.min(...bounds.slice(1).map((r) => r[0])),
    width = Math.max(...bounds.map((r) => r[2] - r[0])),
    indent = bounds[0][0] - left
  if (
    rows.length < 3 ||
    rows.length > 12 ||
    pitch < em ||
    pitch > em * 2 ||
    indent < em / 2 ||
    indent > em * 3 ||
    bases.some((b, i) => i && Math.abs(bases[i - 1] - b - pitch) > em * 0.02) ||
    bounds.some(
      (r, i) =>
        (i && Math.abs(r[0] - left) > em * 0.02) ||
        (i < bounds.length - 1 && r[2] - r[0] < width * 0.75)
    )
  )
    return
  const captionLabel = /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*(?:[.-]\d+)*)[.:\s]/u.exec(
      figure.caption.lines[0]
    )?.[1],
    bodyText = body.map((r) => r.r.str).join(' ')
  if (
    !captionLabel ||
    !new RegExp(
      '\\b(?:Figure|Fig\\.)\\s+' +
        captionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(?=[\\s.,;:)]|$)',
      'u'
    ).test(bodyText)
  )
    return
  const bodyGlyphs = [...new Set(body.flatMap((r) => r.part.map(({ g }) => g)))],
    packets = [...new Set(bodyGlyphs.map((g) => g.packet))]
  if (
    packets.some(
      (p) =>
        !Number.isInteger(p.end) ||
        p.end >= scope.begin ||
        context.operators.fnArray[p.end] !== OPS.endText ||
        p.glyphs.some((g) => !bodyGlyphs.includes(g))
    ) ||
    bodyGlyphs.some((g) => g.text.trim() && (g.rendererSkipped || !pictureValid(g.ink)))
  )
    return
  const before = items.filter((p) => p.operationIndex < scope.begin)
  for (const p of before) {
    if (
      p.kind !== 'glyph' ||
      body.filter((r) =>
        r.part.some(
          ({ g }) =>
            g.i === p.operationIndex &&
            g.fontName === p.fontName &&
            g.text === p.text &&
            g.ink.every((v, i) => v === p.rect[i])
        )
      ).length !== 1
    )
      return
  }
  for (const g of bodyGlyphs)
    if (
      !g.rendererSkipped &&
      pictureValid(g.ink) &&
      before.filter(
        (p) =>
          p.operationIndex === g.i &&
          p.fontName === g.fontName &&
          p.text === g.text &&
          p.rect.every((v, i) => v === g.ink[i])
      ).length !== 1
    )
      return
  const bodyBox = union([
    ...body.map((r) => r.rect),
    ...bodyGlyphs.filter((g) => !g.rendererSkipped && pictureValid(g.ink)).map((g) => g.ink)
  ])
  if (
    !pictureInside([0, 0, page.width, page.height], bodyBox) ||
    bodyBox[3] + em > top ||
    Math.max(...own.map((p) => p.bound[3])) + em > figure.caption.rect[1]
  )
    return
  const positive = packet.records.filter(
      (r) => r.part.length && r.part.every(({ g }) => g.i > scope.begin && g.i < scope.end)
    ),
    glyphs = own.filter((p) => p.kind === 'glyph')
  if (
    !positive.length ||
    positive.some(
      (r) =>
        r.foreignSourceNormalized || r.advanceComplete !== true || r.r.sourceItem?.text !== r.r.str
    )
  )
    return
  for (const p of glyphs)
    if (
      positive.filter((r) =>
        r.part.some(
          ({ g }) =>
            g.i === p.operationIndex &&
            g.fontName === p.fontName &&
            g.text === p.text &&
            g.ink.every((v, i) => v === p.rect[i])
        )
      ).length !== 1
    )
      return
  for (const r of positive)
    for (const { g } of r.part)
      if (
        !g.rendererSkipped &&
        glyphs.filter(
          (p) =>
            p.operationIndex === g.i &&
            p.fontName === g.fontName &&
            p.text === g.text &&
            p.rect.every((v, i) => v === g.ink[i])
        ).length !== 1
      )
        return
  return { own, excluded: before, kind: 'complete-native-form-after-opening-body' }
}

function pictureStackedSourceForms(data, items, figure, pageCaps, page, tokens, context) {
  if (pageCaps.length !== 1 || pageCaps[0] !== figure.caption || !figure.sourceItems?.length) return
  const packet = nativePageTextPacketInventory(page, tokens, context, true)
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const captionText = figure.caption.lines.join(' ')
  if (!/\btop\b/iu.test(captionText) || !/\bbottom\b/iu.test(captionText)) return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (p) => p.op === OPS.paintFormXObjectBegin && p.begin < s.begin && p.end > s.end
      )
  )
  if (forms.length !== 2) return
  const groups = forms.map((s) => {
    const own = pictureScopePieces(s, items),
      records = packet.records.filter((r) => r.part.every(({ g }) => g.i > s.begin && g.i < s.end))
    return { scope: s, own, records, rect: own.length && union(own.map((p) => p.bound)) }
  })
  if (
    groups.some(
      (g) =>
        !g.rect ||
        !g.records.length ||
        !g.own.some((p) => p.kind === 'path') ||
        g.own.some((p) => !['glyph', 'path'].includes(p.kind))
    )
  )
    return
  const sameSource = (a, b) =>
    a.pageNumber === b.pageNumber && a.index === b.index && a.text === b.text
  if (
    !groups.some(
      (g) =>
        g.records.length === figure.sourceItems.length &&
        g.records.every((r, i) => sameSource(r.r.sourceItem, figure.sourceItems[i]))
    )
  )
    return
  const records = groups.flatMap((g) => g.records),
    sources = records.map((r) => r.r.sourceItem),
    own = groups.flatMap((g) => g.own),
    em = Math.max(...records.map((r) => r.r.height)),
    first = groups[0].rect
  if (
    sources.length <= figure.sourceItems.length ||
    sources.length > 4096 ||
    new Set(sources.map((s) => s.index)).size !== sources.length ||
    !(em > 0)
  )
    return
  for (const [i, g] of groups.entries()) {
    if (
      Math.abs(g.rect[0] - first[0]) > em / 20 ||
      Math.abs(g.rect[2] - first[2]) > em / 20 ||
      Math.abs(g.rect[3] - g.rect[1] - (first[3] - first[1])) > em / 20 ||
      g.rect[3] >= figure.caption.rect[1] ||
      (i && (g.rect[1] <= groups[i - 1].rect[3] || g.rect[1] - groups[i - 1].rect[3] > em * 4))
    )
      return
    for (const r of g.records) {
      const style = context.content.styles[r.r.fontName]
      if (
        !Number.isFinite(style?.ascent) ||
        !Number.isFinite(style?.descent) ||
        style.vertical !== false ||
        style.ascent <= 0 ||
        style.ascent > 2 ||
        style.descent > 0 ||
        style.descent < -2
      )
        return
      for (const { g: glyph } of r.part)
        if (
          !glyph.rendererSkipped &&
          !g.own.some(
            (p) =>
              p.kind === 'glyph' &&
              p.operationIndex === glyph.i &&
              p.fontName === glyph.fontName &&
              p.text === glyph.text &&
              p.rect.every((v, i) => v === glyph.ink[i])
          )
        )
          return
    }
  }
  return { own, sourceItems: sources, kind: 'complete-native-stacked-source-forms' }
}

// Each complete native Form keeps its own axes, titles and legend. Only a
// caption-bounded rectangular grid can combine them; surrounding paint remains
// subject to the unchanged whole-page exclusion and actual-PNG certificates.
// Complete lettered panels connect one original Form and closed boxed text
// lifetimes. Every other native paint remains foreign; no Source claim is minted.
function pictureFormWithBoxedPanel(data, items, figure, pageCaps, page, tokens, context) {
  if (figure.sourceItems?.length || pageCaps.length !== 1 || pageCaps[0] !== figure.caption) return
  const packet = nativePageTextPacketInventory(
    page,
    tokens,
    context,
    true,
    new Set(tokens.map((t) => t.sourceItem?.index))
  )
  if (!packet || !packet.records.length || packet.records.some((r) => r.advanceComplete !== true))
    return
  const caption = packet.records.filter((r) => pictureInside(figure.caption.rect, r.rect)),
    text = figure.caption.lines.join(' ')
  if (
    !caption.length ||
    compact(caption.map((r) => r.r.str).join('')) !== compact(text) ||
    !/\(a\)[\s\S]+\(b\)/u.test(text)
  )
    return
  const capStart = Math.min(...caption.flatMap((r) => r.part.map((z) => z.g.i))),
    before = packet.records.filter((r) => r.part.every((z) => z.g.i < capStart)),
    marker = (value) => before.filter((r) => r.r.str === value),
    aa = marker('(a)'),
    bb = marker('(b)')
  if (aa.length !== 1 || bb.length !== 1) return
  const a = aa[0],
    b = bb[0],
    lifetimes = (r) => [...new Set(r.part.map((z) => z.g.packet))],
    ap = lifetimes(a),
    bp = lifetimes(b)
  if (
    ap.length !== 1 ||
    bp.length !== 1 ||
    before.at(-1) !== b ||
    a.index >= b.index ||
    a.rect[3] >= b.rect[1] ||
    a.r.fontName !== b.r.fontName ||
    a.r.height !== b.r.height ||
    ![ap[0], bp[0]].every(
      (p) => Number.isSafeInteger(p.start) && Number.isSafeInteger(p.end) && p.start < p.end
    )
  )
    return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  if (forms.length !== 1 || forms[0].end >= ap[0].start) return
  const form = forms[0],
    inScope = (s, i) => i > s.begin && i < s.end,
    scopes = data.scopes.filter(
      (s) =>
        s.op === OPS.save &&
        s.begin > ap[0].end &&
        s.end < bp[0].start &&
        !data.scopes.some(
          (t) =>
            t.op === OPS.save &&
            t.begin > ap[0].end &&
            t.end < bp[0].start &&
            t.begin < s.begin &&
            t.end > s.end
        )
    )
  if (scopes.length < 2) return
  const blocks = []
  for (const scope of scopes) {
    const own = pictureScopePieces(scope, items),
      paths = own.filter((p) => p.kind === 'path'),
      glyphs = own.filter((p) => p.kind === 'glyph'),
      outer = paths.find((p) => paths.every((q) => pictureInside(p.rect, q.rect)))
    if (
      paths.length !== 2 ||
      !glyphs.length ||
      !outer ||
      own.some((p) => !['path', 'glyph'].includes(p.kind)) ||
      glyphs.some((g) => !pictureInside(outer.rect, g.rect))
    )
      return
    blocks.push({ scope, outer: outer.rect })
  }
  if (
    blocks.some(
      (v, i) =>
        i && (v.outer[0] <= blocks[i - 1].outer[2] || v.scope.begin <= blocks[i - 1].scope.end)
    )
  )
    return
  const under = before.filter((r) => r.index > a.index && r.index < b.index),
    headers = []
  for (const block of blocks) {
    const preceding = under.filter(
      (r) =>
        r.part.every((z) => z.g.i < block.scope.begin) &&
        !blocks.some((q) => r.part.every((z) => inScope(q.scope, z.g.i))) &&
        !headers.includes(r)
    )
    if (preceding.length !== 1) return
    const header = preceding[0],
      inner = under.filter((r) => r.part.some((z) => inScope(block.scope, z.g.i)))
    if (
      !inner.length ||
      header.rect[3] >= block.outer[1] ||
      header.rect[0] >= block.outer[2] ||
      header.rect[2] <= block.outer[0] ||
      header.r.height < Math.min(...inner.map((r) => r.r.height))
    )
      return
    headers.push(header)
  }
  const expected = packet.records
      .filter((r) => r.part.every((z) => inScope(form, z.g.i)))
      .concat(
        [a, b],
        headers,
        under.filter((r) => blocks.some((q) => r.part.every((z) => inScope(q.scope, z.g.i))))
      ),
    expectedIndices = [...new Set(expected)].map((r) => r.index).sort((x, y) => x - y)
  if (
    expectedIndices.length !== before.length ||
    expectedIndices.some((v, i) => v !== before[i].index)
  )
    return
  const physical = new Set()
  for (const r of before.concat(caption)) {
    const style = context.content.styles[r.r.fontName]
    if (
      !style ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      style.vertical !== false
    )
      return
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (physical.has(g)) return
      physical.add(g)
    }
    if (
      lifetimes(r).some(
        (p) =>
          !Number.isSafeInteger(p.start) ||
          !Number.isSafeInteger(p.end) ||
          p.start >= p.end ||
          r.part.some((z) => z.g.i <= z.g.packet.start || z.g.i >= z.g.packet.end)
      )
    )
      return
  }
  const own = items.filter((p) => p.operationIndex < capStart),
    allowed = (p) =>
      inScope(form, p.operationIndex) ||
      blocks.some((q) => inScope(q.scope, p.operationIndex)) ||
      [a, b, ...headers].some((r) => r.part.some((z) => z.g.i === p.operationIndex))
  if (!own.length || own.some((p) => !['glyph', 'path'].includes(p.kind) || !allowed(p))) return
  return { own, kind: 'complete-native-form-with-boxed-panel' }
}

function pictureCaptionedFormGrid(data, items, figure, pageCaps) {
  if (
    figure.sourceItems?.length ||
    pageCaps.filter((c) => c === figure.caption).length !== 1 ||
    pageCaps.some((c) => !pictureValid(c.rect))
  )
    return
  const caption = figure.caption.rect,
    previous = pageCaps.filter((c) => c.rect[3] < caption[1]),
    lower = previous.length ? Math.max(...previous.map((c) => c.rect[3])) : 0,
    forms = data.scopes.filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        !data.scopes.some(
          (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
        )
    ),
    groups = forms.flatMap((scope) => {
      const parts = pictureScopePieces(scope, items)
      if (!parts.length) return []
      const bound = union(parts.map((p) => p.bound))
      return bound[1] > lower && bound[3] < caption[1] ? [{ scope, parts, bound }] : []
    })
  if (
    ![2, 4, 6].includes(groups.length) ||
    groups.some(
      (g) =>
        !g.parts.some((p) => p.kind === 'path') ||
        !g.parts.some((p) => p.kind === 'glyph') ||
        g.parts.some((p) => !['path', 'glyph'].includes(p.kind))
    )
  )
    return
  const rows = []
  for (const group of groups) {
    const row = rows.at(-1)
    if (
      row &&
      Math.max(...row.map((g) => g.bound[1]), group.bound[1]) <
        Math.min(...row.map((g) => g.bound[3]), group.bound[3])
    ) {
      if (group.bound[0] <= row.at(-1).bound[2]) return
      row.push(group)
    } else {
      if (row && group.bound[1] <= Math.max(...row.map((g) => g.bound[3]))) return
      rows.push([group])
    }
  }
  const columns = rows[0].length
  if (
    ![2, 3].includes(columns) ||
    rows.some((row) => row.length !== columns) ||
    rows.some((row) =>
      row.some(
        (g, column) =>
          Math.max(...rows.map((r) => r[column].bound[0])) >=
          Math.min(...rows.map((r) => r[column].bound[2]))
      )
    ) ||
    (rows.length === 1 &&
      (columns !== 2 ||
        !/\bLeft:/u.test(figure.caption.lines.join(' ')) ||
        !/\bRight:/u.test(figure.caption.lines.join(' '))))
  )
    return
  return { own: groups.flatMap((g) => g.parts), kind: 'complete-native-captioned-form-grid' }
}

// Two complete raster rows share explicit consecutive caption ranges. Their
// original hashed images own the pixels; the caption grants no Source claim.
function pictureCaptionedRasterRows(
  items,
  figure,
  pageCaps,
  page,
  tokens,
  context,
  originalCropRect
) {
  const caption = figure.caption,
    ranges = [...caption.lines.join(' ').matchAll(/\(([a-z])[–-]([a-z])\)/gu)]
  if (
    ranges.length !== 2 ||
    ranges[0][1] !== 'a' ||
    ranges.some((r) => r[2] <= r[1]) ||
    ranges[1][1].charCodeAt(0) !== ranges[0][2].charCodeAt(0) + 1 ||
    ranges[0][2].charCodeAt(0) - ranges[0][1].charCodeAt(0) !==
      ranges[1][2].charCodeAt(0) - ranges[1][1].charCodeAt(0)
  )
    return
  const previous = pageCaps
      .filter((c) => c !== caption && c.rect[3] < caption.rect[1])
      .sort((a, b) => b.rect[3] - a.rect[3])[0],
    top = previous?.rect[3] ?? 0,
    images = items
      .filter((p) => p.kind === 'image' && p.rect[1] > top && p.rect[3] < caption.rect[1])
      .sort((a, b) => a.rect[1] - b.rect[1])
  if (
    images.length !== 2 ||
    images.some((p) => !/^[a-f\d]{64}$/u.test(p.imageHash ?? '')) ||
    Math.abs(images[0].rect[0] - images[1].rect[0]) > 1e-6 ||
    images[0].rect[3] >= images[1].rect[1] ||
    !images.some((p) => pictureInside(originalCropRect, p.rect)) ||
    images.every((p) => pictureInside(originalCropRect, p.bound))
  )
    return
  const supports = images.map((p) => {
    const original = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === p.operationIndex
      ),
      pageImages = page.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === p.operationIndex
      ),
      args = context.operators.argsArray[p.operationIndex]
    if (
      original.length !== 1 ||
      pageImages.length !== 1 ||
      original[0].imageHash !== p.imageHash ||
      pageImages[0].imageHash !== p.imageHash ||
      !Array.isArray(args) ||
      !Number.isSafeInteger(args[1]) ||
      args[1] <= 0 ||
      !Number.isSafeInteger(args[2]) ||
      args[2] <= 0 ||
      !pictureValid(original[0].paintedNormalizedRect) ||
      !original[0].paintedNormalizedRect.every((v, i) =>
        Object.is(v, pageImages[0].paintedNormalizedRect?.[i])
      )
    )
      return
    const painted = original[0].paintedNormalizedRect.map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      ),
      pitch = [(p.rect[2] - p.rect[0]) / args[1], (p.rect[3] - p.rect[1]) / args[2]]
    if (!painted.every((v, i) => (i < 2 ? v > p.rect[i] : v < p.rect[i]))) return
    // The recorded exact-white strip scan adds one decoded pixel on every
    // unclamped edge. Its budget may leave a conservative support envelope;
    // requiring that entire envelope outside the old crop still proves lost
    // positive paint. This does not replace the full image used for the crop.
    const support = painted.map((v, i) => v + (i < 2 ? 1 : -1) * pitch[i % 2])
    return pictureValid(support) && pictureInside(p.rect, support) ? support : undefined
  })
  if (supports.some((r) => !r) || !supports.some((r) => !pictureHit(originalCropRect, r))) return
  const packet = nativePageTextPacketInventory(page, tokens, context, true),
    records = packet?.records.filter((r) => pictureInside(caption.rect, r.rect))
  if (
    !records?.length ||
    records.map((r) => r.r.str).join(' ') !== caption.lines.join(' ') ||
    records.some((r) => {
      const style = context.content.styles[r.r.fontName]
      return (
        !Number.isFinite(style?.ascent) ||
        !Number.isFinite(style.descent) ||
        style.vertical !== false
      )
    })
  )
    return
  return { own: images, kind: 'complete-native-captioned-raster-rows', missingImagePaint: true }
}

// Pair two closed native Save drawings with their separately printed, caption-
// linked descriptions. A description may share its original BT/ET with later
// caption/body text: full Source records divide the ink, never a fabricated ET.
function picturePairedSavedDiagrams(data, items, figure, pageCaps, page, tokens, context) {
  if (figure.sourceItems?.length || pageCaps.length !== 1 || pageCaps[0] !== figure.caption) return
  const indices = new Set(
      tokens.filter((t) => t.rect[3] <= figure.caption.rect[3]).map((t) => t.sourceItem?.index)
    ),
    packet = nativePageTextPacketInventory(page, tokens, context, true, indices, false)
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const caption = packet.records.filter((r) => pictureInside(figure.caption.rect, r.rect)),
    text = figure.caption.lines.join(' ')
  if (
    !caption.length ||
    compact(caption.map((r) => r.r.str).join('')) !== compact(text) ||
    !/\(a\)[\s\S]+\(b\)/u.test(text)
  )
    return
  const capStart = Math.min(...caption.flatMap((r) => r.part.map(({ g }) => g.i))),
    before = packet.records.filter(
      (r) =>
        r.rect[3] < figure.caption.rect[1] &&
        r.part.length &&
        r.part.every(({ g }) => g.i < capStart)
    ),
    printed = items.filter((p) => p.operationIndex < capStart),
    roots = data.scopes.filter(
      (s) =>
        s.op === OPS.save &&
        s.parent === undefined &&
        s.end < capStart &&
        pictureScopePieces(s, printed).some((p) => p.kind === 'glyph')
    )
  if (
    roots.length !== 2 ||
    !before.length ||
    printed.some((p) => !['glyph', 'path'].includes(p.kind))
  )
    return
  const groups = roots.map((scope) => ({ scope, own: pictureScopePieces(scope, printed) })),
    descriptions = [],
    used = new Set()
  for (const [i, group] of groups.entries()) {
    const { scope, own } = group,
      body = before.filter((r) => r.part.every(({ g }) => g.i > scope.begin && g.i < scope.end)),
      tail = before.filter((r) =>
        r.part.every(({ g }) => g.i > scope.end && g.i < (roots[i + 1]?.begin ?? capStart))
      ),
      marker = tail[0],
      em = marker?.r.height,
      bounds = own.length && union(own.map((p) => p.bound)),
      description = tail.length && union(tail.map((r) => r.rect)),
      literal = tail.map((r) => r.r.str).join(' ')
    if (
      !body.length ||
      own.filter((p) => p.kind === 'path').length < 3 ||
      !bounds ||
      !description ||
      !(em > 0) ||
      marker.r.str !== `(${String.fromCharCode(97 + i)})` ||
      !/^\([ab]\)[^.!?]*[.!?]$/u.test(literal) ||
      (literal.match(/\p{L}{2,}/gu)?.length ?? 0) < 2 ||
      tail.some(
        (r) => r.r.height !== em || Math.abs(r.r.transform[5] - marker.r.transform[5]) > 0.02
      ) ||
      description[1] <= bounds[3] ||
      description[1] - bounds[3] > em * 2 ||
      (description[0] + description[2]) / 2 <= bounds[0] ||
      (description[0] + description[2]) / 2 >= bounds[2] ||
      description[3] >= figure.caption.rect[1]
    )
      return
    if (
      i &&
      (bounds[0] <= groups[i - 1].bounds[2] ||
        description[0] <= descriptions[i - 1][2] ||
        Math.abs(bounds[1] - groups[0].bounds[1]) > em / 4 ||
        Math.abs(bounds[3] - groups[0].bounds[3]) > em / 4 ||
        Math.abs(description[3] - descriptions[0][3]) > 0.02)
    )
      return
    group.bounds = bounds
    descriptions.push(description)
    for (const r of body.concat(tail)) {
      if (used.has(r)) return
      used.add(r)
    }
  }
  if (used.size !== before.length) return
  const glyphOwner = new Map(),
    sameGlyph = (p, g) =>
      p.kind === 'glyph' &&
      p.operationIndex === g.i &&
      p.fontName === g.fontName &&
      p.text === g.text &&
      p.rect.every((v, i) => v === g.ink[i])
  for (const r of before.concat(caption)) {
    const raw = r.r,
      style = context.content.styles[raw.fontName]
    if (
      r.advanceComplete !== true ||
      r.foreignSourceNormalized ||
      raw.sourceItem?.text !== raw.str ||
      style?.vertical !== false ||
      !(style.ascent > 0) ||
      style.ascent > 2 ||
      !Number.isFinite(style.descent) ||
      style.descent > 0 ||
      style.descent < -2 ||
      raw.transform[1] !== 0 ||
      raw.transform[2] !== 0 ||
      raw.transform[0] <= 0 ||
      raw.transform[3] !== raw.height
    )
      return
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (
        glyphOwner.has(g) ||
        g.rendererSkipped ||
        !pictureValid(g.ink) ||
        !Number.isSafeInteger(g.packet.start) ||
        !Number.isSafeInteger(g.packet.end) ||
        context.operators.fnArray[g.packet.start] !== OPS.beginText ||
        context.operators.fnArray[g.packet.end] !== OPS.endText ||
        g.i <= g.packet.start ||
        g.i >= g.packet.end
      )
        return
      glyphOwner.set(g, r)
      if (items.filter((p) => sameGlyph(p, g)).length !== 1) return
    }
  }
  const positiveGlyphs = [...glyphOwner].filter(([, r]) => used.has(r)).map(([g]) => g),
    own = []
  for (const p of printed) {
    if (p.kind === 'path') {
      if (roots.filter((s) => p.operationIndex > s.begin && p.operationIndex < s.end).length !== 1)
        return
    } else if (positiveGlyphs.filter((g) => sameGlyph(p, g)).length !== 1 || p.fillAlpha !== 1)
      return
    own.push(p)
  }
  if (positiveGlyphs.some((g) => own.filter((p) => sameGlyph(p, g)).length !== 1)) return
  return { own, kind: 'complete-native-paired-saved-diagrams' }
}

// A complete nine-panel native plate can print its final label, shared key and
// caption in one BT. Partition whole original Sources and glyphs for pixels;
// never split that lifetime or turn this partition into Source authority.
function pictureKeyedFormGrid(data, items, figure, pageCaps, page, tokens, context) {
  if (figure.sourceItems?.length || pageCaps.length !== 1 || pageCaps[0] !== figure.caption) return
  const packet = nativePageTextPacketInventory(
    page,
    tokens,
    context,
    true,
    new Set(tokens.map((t) => t.sourceItem?.index))
  )
  if (!packet || !packet.records.length || packet.records.some((r) => r.advanceComplete !== true))
    return
  const caption = packet.records.filter((r) => pictureInside(figure.caption.rect, r.rect)),
    text = figure.caption.lines.join(' ')
  if (
    !caption.length ||
    compact(caption.map((r) => r.r.str).join('')) !== compact(text) ||
    !/\(a\)[\s\S]*\(i\)/u.test(text)
  )
    return
  const capStart = Math.min(...caption.flatMap((r) => r.part.map((z) => z.g.i))),
    before = packet.records.filter((r) => r.part.every((z) => z.g.i < capStart)),
    forms = data.scopes.filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        !data.scopes.some(
          (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
        )
    ),
    groups = forms.map((scope) => {
      const parts = pictureScopePieces(scope, items)
      return { scope, parts, bound: parts.length && union(parts.map((p) => p.bound)) }
    })
  if (
    groups.length !== 9 ||
    groups.some(
      (g) =>
        !pictureValid(g.bound) ||
        !g.parts.some((p) => p.kind === 'path') ||
        !g.parts.some((p) => p.kind === 'glyph') ||
        g.parts.some((p) => !['path', 'glyph'].includes(p.kind)) ||
        g.scope.end >= capStart
    )
  )
    return
  const rows = [groups.slice(0, 3), groups.slice(3, 6), groups.slice(6, 9)]
  if (
    rows.some(
      (row, i) =>
        Math.max(...row.map((g) => g.bound[1])) >= Math.min(...row.map((g) => g.bound[3])) ||
        row.some((g, j) => j && g.bound[0] <= row[j - 1].bound[2]) ||
        (i &&
          Math.min(...row.map((g) => g.bound[1])) <=
            Math.max(...rows[i - 1].map((g) => g.bound[3])))
    ) ||
    rows[0].some(
      (_, c) =>
        Math.max(...rows.map((r) => r[c].bound[0])) >= Math.min(...rows.map((r) => r[c].bound[2]))
    )
  )
    return
  const inForm = (r, g) => r.part.every((z) => z.g.i > g.scope.begin && z.g.i < g.scope.end),
    outside = before.filter((r) => !groups.some((g) => inForm(r, g))),
    markers = outside.filter((r) => /^\([a-i]\)$/u.test(r.r.str)),
    headings = outside.filter((r) => /\bkey$/iu.test(r.r.str))
  if (
    markers.length !== 9 ||
    markers.map((r) => r.r.str[1]).join('') !== 'abcdefghi' ||
    headings.length !== 1
  )
    return
  const heading = headings[0],
    em = markers[0].r.height,
    grid = union(groups.map((g) => g.bound)),
    key = outside.filter((r) => r.index > heading.index)
  if (
    !(em > 0) ||
    heading.index <= markers[8].index ||
    heading.rect[0] <= grid[2] ||
    heading.rect[1] <= grid[1] ||
    heading.rect[3] >= grid[3] ||
    !text.toLowerCase().includes(heading.r.str.toLowerCase() + ' applies to every panel') ||
    key.length < 4 ||
    key.length % 2 ||
    key.length > 64
  )
    return
  const pairs = []
  for (let i = 0; i < key.length; i += 2) {
    const code = key[i],
      value = key[i + 1],
      first = key[0].r
    if (
      !/^(?:[1-9]\d*|[A-Z])$/u.test(code.r.str) ||
      !value.r.str.trim() ||
      code.r.fontName !== first.fontName ||
      value.r.fontName !== first.fontName ||
      code.r.height !== first.height ||
      value.r.height !== first.height ||
      code.r.transform[5] !== value.r.transform[5] ||
      code.rect[2] >= value.rect[0] ||
      code.rect[0] <= grid[2] ||
      value.rect[0] <= grid[2] ||
      code.rect[1] <= heading.rect[3] ||
      value.rect[3] >= grid[3] ||
      (i && code.rect[1] <= key[i - 2].rect[3])
    )
      return
    pairs.push([code, value])
  }
  const codes = pairs.map(([code]) => code.r.str),
    numeric = codes.every((s, i) => s === String(i + 1)),
    alphabetic = codes.every((s, i) => s === String.fromCharCode(65 + i))
  if (
    (!numeric && !alphabetic) ||
    groups.some((g) =>
      codes.some((code) => before.filter((r) => inForm(r, g) && r.r.str === code).length !== 1)
    )
  )
    return
  const used = new Set([heading, ...key]),
    glyphOwner = new Map(),
    sameGlyph = (p, g) =>
      p.kind === 'glyph' &&
      p.operationIndex === g.i &&
      p.fontName === g.fontName &&
      p.text === g.text &&
      p.rect.every((v, i) => v === g.ink[i])
  for (let i = 0; i < 9; i++) {
    const group = groups[i],
      marker = markers[i],
      label = outside.filter(
        (r) => r.index >= marker.index && r.index < (markers[i + 1]?.index ?? heading.index)
      ),
      glyphs = label.flatMap((r) => r.part.map((z) => z.g)),
      pieces = items.filter((p) => glyphs.some((g) => sameGlyph(p, g))),
      bound = pieces.length && union(pieces.map((p) => p.bound)),
      lifetime = marker.part[0]?.g.packet
    if (
      marker.r.fontName !== markers[0].r.fontName ||
      marker.r.height !== em ||
      label.length < 2 ||
      !pictureValid(bound) ||
      bound[1] < group.bound[3] - 2 ||
      bound[0] < group.bound[0] - 2 ||
      bound[2] > group.bound[2] + 2 ||
      label.some((r) =>
        r.part.some(
          (z) =>
            z.g.i <= group.scope.end ||
            z.g.i >= (groups[i + 1]?.scope.begin ?? capStart) ||
            z.g.packet !== lifetime
        )
      ) ||
      label.some((r) => /^(?:Notes?|Sources?):/iu.test(r.r.str))
    )
      return
    label.forEach((r) => used.add(r))
  }
  for (const r of before) if (groups.some((g) => inForm(r, g))) used.add(r)
  if (used.size !== before.length || before.some((r) => !used.has(r))) return
  for (const r of packet.records) {
    const raw = r.r,
      style = context.content.styles[raw.fontName]
    if (
      !style ||
      style.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      raw.dir !== 'ltr' ||
      !Array.isArray(raw.transform) ||
      raw.transform.length !== 6 ||
      !raw.transform.every(Number.isFinite) ||
      raw.transform[0] <= 0 ||
      raw.transform[1] !== 0 ||
      raw.transform[2] !== 0 ||
      raw.transform[3] !== raw.height
    )
      return
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (
        glyphOwner.has(g) ||
        g.rendererSkipped ||
        !pictureValid(g.ink) ||
        !Number.isSafeInteger(g.packet.start) ||
        !Number.isSafeInteger(g.packet.end) ||
        context.operators.fnArray[g.packet.start] !== OPS.beginText ||
        context.operators.fnArray[g.packet.end] !== OPS.endText ||
        g.i <= g.packet.start ||
        g.i >= g.packet.end ||
        items.filter((p) => sameGlyph(p, g)).length !== 1
      )
        return
      glyphOwner.set(g, r)
    }
  }
  const own = items.filter((p) => p.operationIndex < capStart)
  if (
    !own.length ||
    own.some((p) =>
      p.kind === 'path'
        ? groups.filter((g) => p.operationIndex > g.scope.begin && p.operationIndex < g.scope.end)
            .length !== 1
        : p.kind !== 'glyph' ||
          [...glyphOwner].filter(([g, r]) => used.has(r) && sameGlyph(p, g)).length !== 1
    ) ||
    [...glyphOwner].some(([g, r]) => used.has(r) && own.filter((p) => sameGlyph(p, g)).length !== 1)
  )
    return
  return { own, kind: 'complete-native-keyed-form-grid' }
}

function pictureMultipart(data, items, figure, pageCaps, first = 0) {
  // Later table/figure captions remain global exclusions; they do not
  // invalidate a complete multipart family above its own caption.
  if (
    pageCaps.filter((c) => c === figure.caption).length !== 1 ||
    pageCaps.some((c) => c !== figure.caption && c.rect[1] <= figure.caption.rect[3])
  )
    return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  const roots = [
    ...forms,
    ...items
      .filter(
        (p) =>
          p.kind === 'image' &&
          !forms.some((s) => p.operationIndex > s.begin && p.operationIndex < s.end)
      )
      .map((p) => ({ begin: p.operationIndex, end: p.operationIndex, imagePiece: p }))
  ].sort((a, b) => a.begin - b.begin)
  if (roots.length < 2 || roots.length > 12) return
  const sub = picturePackets(items.filter((p) => p.bound[3] < figure.caption.rect[1])).filter((p) =>
    /^\([a-l]\)\S/u.test(p.text)
  )
  if (
    sub.length !== roots.length ||
    sub.map((p) => p.text[1]).join('') !== 'abcdefghijkl'.slice(first, first + sub.length)
  )
    return
  const own = []
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i],
      parts = r.imagePiece ? [r.imagePiece] : pictureScopePieces(r, items),
      label = sub[i]
    if (
      !parts.some((p) => p.kind !== 'glyph') ||
      r.end >= label.begin ||
      (roots[i + 1] && label.begin >= roots[i + 1].begin)
    )
      return
    const bounds = union(parts.map((p) => p.bound))
    const centered =
      r.imagePiece &&
      (label.rect[0] + label.rect[2]) / 2 > bounds[0] &&
      (label.rect[0] + label.rect[2]) / 2 < bounds[2]
    if (
      label.rect[1] < bounds[3] - 2 ||
      (!centered && (label.rect[0] < bounds[0] - 2 || label.rect[2] > bounds[2] + 2))
    )
      return
    // A panel description cannot borrow a later, separately printed note.
    const lines = new Map()
    for (const p of label.pieces) {
      if (!lines.has(p.operationIndex)) lines.set(p.operationIndex, [])
      lines.get(p.operationIndex).push(p.text)
    }
    if (
      [...lines.values()].some((line) =>
        /^(?:Notes?|Sources?):/u.test(pictureCompact(line.join('')))
      )
    )
      return
    own.push(...parts, ...label.pieces)
  }
  return { own, kind: 'complete-native-subcaption-family' }
}
// A saved comparison plate can place its pair headings and per-image labels
// outside the nested raster Form. Close every label lane before admitting that
// parent; an arbitrary Save never establishes ownership of surrounding prose.
function picturePairedRasterSave(data, items, figure) {
  if (figure.reason !== 'native-raster-horizontal-array') return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (p) => p.op === OPS.paintFormXObjectBegin && p.begin < s.begin && p.end > s.end
      )
  )
  if (forms.length !== 1) return
  const form = forms[0],
    parents = data.scopes.filter(
      (s) => s.op === OPS.save && s.parent === undefined && s.begin < form.begin && s.end > form.end
    )
  if (parents.length !== 1) return
  const own = pictureScopePieces(parents[0], items),
    inner = pictureScopePieces(form, items),
    images = inner.filter((p) => p.kind === 'image').sort((a, b) => a.rect[0] - b.rect[0]),
    width = (p) => p.rect[2] - p.rect[0],
    allImages = items.filter((p) => p.kind === 'image')
  if (images.length !== allImages.length || images.length < 4 || images.length > 13) return
  const widest = Math.max(...images.map(width)),
    main = images.filter((p) => width(p) >= widest / 2),
    bars = images.filter((p) => !main.includes(p)),
    first = main[0],
    near = (a, b) => Math.abs(a - b) <= 1e-4
  if (
    main.length < 4 ||
    main.length > 12 ||
    main.length % 2 ||
    bars.length > 1 ||
    main.some(
      (p, i) =>
        !near(width(p), width(first)) ||
        !near(p.rect[1], first.rect[1]) ||
        !near(p.rect[3], first.rect[3]) ||
        (i > 0 && p.rect[0] <= main[i - 1].rect[2])
    )
  )
    return
  const outside = own.filter(
      (p) => p.kind === 'glyph' && !(p.operationIndex > form.begin && p.operationIndex < form.end)
    ),
    packets = picturePackets(outside),
    above = packets.filter((p) => p.rect[3] < first.rect[1]).sort((a, b) => a.rect[0] - b.rect[0]),
    below = packets.filter((p) => p.rect[1] > first.rect[3]).sort((a, b) => a.rect[0] - b.rect[0])
  const line = (packet) => {
    const parts = packet.pieces,
      baseline = parts[0]?.advance[3],
      em = parts[0]?.advance[3] - parts[0]?.advance[1]
    return em > 0 &&
      parts.every(
        (p) =>
          near(p.advance[3], baseline) &&
          near(p.advance[3] - p.advance[1], em) &&
          p.advance[2] > p.advance[0]
      )
      ? em
      : undefined
  }
  if (
    above.length * 2 !== main.length ||
    below.length !== main.length ||
    above.length + below.length !== packets.length ||
    packets.some((p) => !line(p))
  )
    return
  if (Math.max(...above.map((p) => p.rect[1])) >= Math.min(...above.map((p) => p.rect[3]))) return
  const centered = (packet, left, right) => {
    const rect = union(packet.pieces.map((p) => p.advance)),
      em = line(packet)
    return (
      rect[0] >= left && rect[2] <= right && Math.abs(rect[0] + rect[2] - left - right) / 2 < em / 8
    )
  }
  if (
    above.some(
      (p, i) =>
        !centered(p, main[i * 2].rect[0], main[i * 2 + 1].rect[2]) ||
        first.rect[1] - p.rect[3] > line(p) * 2
    ) ||
    below.some(
      (p, i) =>
        !centered(p, main[i].rect[0], main[i].rect[2]) ||
        p.rect[1] - first.rect[3] > line(p) * 2 ||
        !near(p.pieces[0].advance[3], below[0].pieces[0].advance[3])
    )
  )
    return
  const em = Math.max(...packets.map(line)),
    bar = bars[0],
    innerLabels = picturePackets(inner)
  if (
    bar
      ? width(bar) >= widest / 4 ||
        bar.rect[0] <= main.at(-1).rect[2] ||
        Math.abs(bar.rect[1] - first.rect[1]) > em ||
        Math.abs(bar.rect[3] - first.rect[3]) > em ||
        innerLabels.length < 2 ||
        innerLabels.some(
          (p) =>
            !/^[+-]?\d+(?:\.\d+)?$/u.test(p.text) ||
            !line(p) ||
            p.rect[0] < bar.rect[2] - em ||
            p.rect[2] > bar.rect[2] + em * 3 ||
            p.rect[1] < bar.rect[1] - em ||
            p.rect[3] > bar.rect[3] + em
        )
      : innerLabels.length > 0
  )
    return
  const envelope = union([...images, ...own.filter((p) => p.kind === 'glyph')].map((p) => p.bound)),
    domain = pictureExpand(envelope, em)
  if (
    own.some((p) => p.kind !== 'glyph' && !pictureInside(domain, p.bound)) ||
    !own.some((p) => p.kind === 'glyph') ||
    union(own.map((p) => p.bound))[3] >= figure.caption.rect[1]
  )
    return
  return { own, kind: 'complete-native-paired-raster-save' }
}

// Removing old paint needs positive exterior-body evidence, not just a different
// save scope. Two complete displayed equations must follow consecutive native
// equation numbers and whole ordinary introductions, all before this drawing.
// This is pixel authority only; a foreign positioning space never gains a
// whole advance or a Source claim through this certificate.
function pictureExteriorNumberedBody(data, items, picked, page, tokens, context, oldRect) {
  const scopes = data.scopes.filter(
    (s) =>
      s.op === OPS.save &&
      pictureScopePieces(s, items).length === picked.own.length &&
      pictureScopePieces(s, items).every((p) => picked.own.includes(p))
  )
  if (!scopes.length) return
  const begin = Math.min(...scopes.map((s) => s.begin)),
    seed = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem,
    packet = seed && nativeClosedProgramInkPacket(page, tokens, context, [seed])
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const before = packet.records.filter((r) => r.part.every((z) => z.g.i < begin)),
    labels = before
      .flatMap((r) => {
        const match = /^\((\d+)\.(\d+)\)$/u.exec(r.r.str)
        return match && r.advanceComplete
          ? [{ r, section: match[1], ordinal: Number(match[2]) }]
          : []
      })
      .slice(-3)
  if (
    labels.length !== 3 ||
    labels.some(
      (l, i) =>
        l.section !== labels[0].section ||
        !Number.isSafeInteger(l.ordinal) ||
        l.ordinal !== labels[0].ordinal + i ||
        l.r.r.fontName !== labels[0].r.r.fontName ||
        Math.abs(l.r.r.height - labels[0].r.r.height) > 0.02 ||
        Math.abs(l.r.rect[0] - labels[0].r.rect[0]) > 0.02
    )
  )
    return
  const ink = (r) => union(r.part.map((z) => z.g.ink)),
    domains = []
  for (let i = 1; i < labels.length; i++) {
    const rows = before.filter(
        (r) => r.index > labels[i - 1].r.index && r.index < labels[i].r.index
      ),
      header = rows[0],
      math = rows.slice(1),
      em = header?.r.height,
      style = context.content.styles[header?.r.fontName]
    if (
      !header ||
      !header.advanceComplete ||
      !math.length ||
      rows.length > 256 ||
      !/^[A-Z][A-Za-z]*(?:[,;]?\s+[a-z][A-Za-z]*){3,}[.:;]?$/u.test(header.r.str) ||
      /^(?:Figure|Fig|Panel|Algorithm|Table)\b/iu.test(header.r.str) ||
      header.r.fontName !== labels[i].r.r.fontName ||
      Math.abs(header.rect[0] - labels[i].r.rect[0]) > 0.02 ||
      !Number.isFinite(em) ||
      em <= 0 ||
      style?.vertical !== false ||
      !(style.ascent > 0) ||
      style.ascent > 2 ||
      !Number.isFinite(style.descent) ||
      style.descent > 0 ||
      style.descent < -2 ||
      !math.some((r) => r.r.str.includes('=')) ||
      math.some((r) => /[A-Za-z]{2,}/u.test(r.r.str)) ||
      math.some((r) => ink(r)[1] <= ink(header)[3]) ||
      ink(labels[i].r)[1] <= ink(header)[3]
    )
      return
    const bound = union([...math.map(ink), ink(labels[i].r)]),
      next = i + 1 < labels.length ? before.find((r) => r.index > labels[i].r.index) : undefined
    if (
      (next && bound[3] >= ink(next)[1]) ||
      bound[3] >= Math.min(...picked.own.map((p) => p.bound[1]))
    )
      return
    domains.push({
      header,
      math,
      label: labels[i].r,
      bound,
      first: Math.min(...math.flatMap((r) => r.part.map((z) => z.g.i))),
      last: Math.max(...math.flatMap((r) => r.part.map((z) => z.g.i)))
    })
  }
  const owned = new Set(picked.own),
    excluded = items.filter(
      (p) =>
        !owned.has(p) &&
        pictureBounds(p, Infinity) &&
        pictureHit(oldRect, pictureBounds(p, Infinity))
    )
  if (!excluded.length) return
  for (const p of excluded) {
    if (p.operationIndex >= begin) return
    if (p.kind === 'glyph') {
      const owners = packet.records.filter((r) =>
        r.part.some(
          ({ g }) =>
            g.i === p.operationIndex &&
            g.fontName === p.fontName &&
            g.text === p.text &&
            JSON.stringify(g.ink) === JSON.stringify(p.fullInk)
        )
      )
      if (
        owners.length !== 1 ||
        !domains.some(
          (d) => owners[0] === d.header || owners[0] === d.label || d.math.includes(owners[0])
        )
      )
        return
    } else if (p.kind === 'path') {
      const points = p.visiblePaintPoints,
        domain = domains.filter((d) => p.operationIndex > d.first && p.operationIndex < d.last)
      if (
        domain.length !== 1 ||
        points?.length !== 2 ||
        Math.abs(points[0][1] - points[1][1]) > 1e-7 ||
        points[0][0] === points[1][0]
      )
        return
      const y = points[0][1],
        left = Math.min(points[0][0], points[1][0]),
        right = Math.max(points[0][0], points[1][0]),
        glyphs = domain[0].math
          .flatMap((r) => r.part.map((z) => z.g))
          .filter((g) => !g.rendererSkipped && g.ink[0] < right && g.ink[2] > left)
      if (!glyphs.some((g) => g.ink[3] < y) || !glyphs.some((g) => g.ink[1] > y)) return
    } else return
  }
  return excluded
}

// A continued, full-width opening body paragraph is outside a separately saved
// drawing only when every original word, inline glyph and closing ET is proved.
function pictureExteriorLeadingBody(data, items, picked, figure, page, tokens, context, oldRect) {
  const scopes = data.scopes.filter((s) => {
    const own = pictureScopePieces(s, items)
    return (
      s.op === OPS.save &&
      own.length === picked.own.length &&
      own.every((p) => picked.own.includes(p))
    )
  })
  if (!scopes.length) return
  const begin = Math.min(...scopes.map((s) => s.begin)),
    packet = nativePageTextPacketInventory(page, tokens, context, true)
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const before = packet.records.filter((r) => r.part.every((z) => z.g.i < begin)),
    head = before[0]?.r,
    em = head?.height,
    font = head?.fontName,
    style = context.content.styles[font]
  if (
    !Number.isFinite(style?.ascent) ||
    !Number.isFinite(style?.descent) ||
    !(
      (style.ascent === 0 && style.descent === 0) ||
      (style.ascent > 0 && style.ascent <= 2 && style.descent <= 0 && style.descent >= -2)
    )
  )
    return
  if (
    !head ||
    before[0].index !== 0 ||
    !Number.isFinite(em) ||
    em <= 0 ||
    !/^\p{Ll}\p{L}*\s/u.test(head.str) ||
    !/[.!?]$/u.test(before.at(-1).r.str) ||
    (before
      .map((r) => r.r.str)
      .join(' ')
      .match(/\p{L}{2,}/gu)?.length ?? 0) < 30
  )
    return
  const main = before.filter((r) => r.r.fontName === font && r.r.height === em),
    bases = [...new Set(main.map((r) => r.r.transform[5]))].sort((a, b) => b - a)
  if (
    bases.length < 3 ||
    bases.length > 12 ||
    bases.some((b, i) => i && (bases[i - 1] - b < em || bases[i - 1] - b > em * 1.7))
  )
    return
  const rows = bases.map(() => [])
  for (const r of before) {
    const raw = r.r,
      m = raw.transform,
      matches = bases.flatMap((b, i) => (Math.abs(b - m[5]) <= em * 0.6 ? [i] : []))
    if (
      matches.length !== 1 ||
      !Array.isArray(m) ||
      m.length !== 6 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      m[0] <= 0 ||
      m[3] !== raw.height ||
      raw.height < em / 2 ||
      raw.height > em * 1.05
    )
      return
    rows[matches[0]].push(r)
  }
  const bounds = rows.map((rs) => union(rs.map((r) => r.rect))),
    left = bounds[0][0],
    width = Math.max(...bounds.map((r) => r[2] - r[0])),
    body = union(bounds)
  if (
    bounds.some((r) => Math.abs(r[0] - left) > em / 4 || r[2] - r[0] < width * 0.75) ||
    body[3] + em > Math.min(...picked.own.map((p) => p.bound[1])) ||
    !packet.records.some(
      (r) =>
        r.rect[1] > figure.caption.rect[3] &&
        r.r.fontName === font &&
        r.r.height === em &&
        (r.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 8
    )
  )
    return
  const last = Math.max(...before.flatMap((r) => r.part.map((z) => z.g.i)))
  if (context.operators.fnArray[last + 1] !== OPS.endText || last + 1 >= begin) return
  const own = new Set(picked.own),
    excluded = items.filter(
      (p) =>
        !own.has(p) && pictureBounds(p, Infinity) && pictureHit(oldRect, pictureBounds(p, Infinity))
    )
  if (!excluded.length) return
  for (const p of excluded) {
    if (p.kind !== 'glyph' || p.operationIndex >= begin) return
    const records = before.filter((r) =>
      r.part.some(
        ({ g }) =>
          g.i === p.operationIndex &&
          g.fontName === p.fontName &&
          g.text === p.text &&
          JSON.stringify(g.ink) === JSON.stringify(p.rect)
      )
    )
    if (records.length !== 1) return
  }
  return excluded
}

// A numbered section and its four complete body lines may share one native ET
// with a running title. Only independently witnessed body ink can be exterior;
// the title, section and every other original Source remain foreign paint.
function pictureExteriorSectionBody(data, items, picked, figure, page, tokens, context, oldRect) {
  const saves = data.scopes.filter((s) => {
    const own = pictureScopePieces(s, items)
    return (
      s.op === OPS.save &&
      own.length === picked.own.length &&
      own.every((p) => picked.own.includes(p))
    )
  })
  if (!saves.length) return
  const begin = Math.min(...saves.map((s) => s.begin)),
    inventory = nativePageTextPacketInventory(page, tokens, context, true),
    before = inventory?.records.filter((r) => r.part.every((z) => z.g.i < begin))
  if (!before || before.length !== 6) return
  const [title, section, ...body] = before,
    font = body[0].r.fontName,
    em = body[0].r.height,
    style = context.content.styles[font],
    bounds = body.map((r) => r.rect),
    left = bounds[0][0],
    width = Math.max(...bounds.map((r) => r[2] - r[0])),
    rect = pictureExpand(union(picked.own.map((p) => p.bound)), 2 / 1.5)
  if (
    title.index !== 0 ||
    !/^\p{Lu}/u.test(title.r.str) ||
    title.r.height > em ||
    !Number.isFinite(em) ||
    em <= 0 ||
    style?.vertical !== false ||
    !(style.ascent > 0 && style.ascent <= 2) ||
    !Number.isFinite(style.descent) ||
    style.descent > 0 ||
    style.descent < -2 ||
    section.r.fontName === font ||
    section.r.fontName === title.r.fontName ||
    section.r.height !== em ||
    !/^\d+(?:\.\d+){1,3}\.\s+\p{Lu}[\p{L}\s-]+$/u.test(section.r.str) ||
    (section.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) < 3 ||
    Math.abs(section.rect[0] - left) > em / 4 ||
    title.rect[3] + em >= section.rect[1] ||
    section.r.transform[5] - body[0].r.transform[5] < em * 1.5 ||
    section.r.transform[5] - body[0].r.transform[5] > em * 3 ||
    !/^\p{Lu}\p{L}*\s/u.test(body[0].r.str) ||
    /^(?:Note|Figure|Fig|Table|Algorithm|Panel)\b/iu.test(body[0].r.str) ||
    !/[.!?]$/u.test(body.at(-1).r.str) ||
    (body
      .map((r) => r.r.str)
      .join(' ')
      .match(/\p{L}{2,}/gu)?.length ?? 0) < 30 ||
    body.some((r, i) => {
      const m = r.r.transform,
        gap = i && body[i - 1].r.transform[5] - m[5]
      return (
        r.r.fontName !== font ||
        r.r.height !== em ||
        m[0] !== em ||
        m[1] !== 0 ||
        m[2] !== 0 ||
        m[3] !== em ||
        r.r.hasEOL !== i < body.length - 1 ||
        Math.abs(r.rect[0] - left) > em / 4 ||
        r.rect[2] - r.rect[0] < width * 0.75 ||
        (i && (gap < em || gap > em * 1.7))
      )
    }) ||
    bounds.at(-1)[3] + em >= Math.min(...picked.own.map((p) => p.bound[1])) ||
    [title, section].some((r) =>
      [r.rect, ...r.part.map((z) => z.g.ink)].some(
        (b) => pictureHit(oldRect, b) || pictureHit(rect, b)
      )
    )
  )
    return
  const witness = inventory.records.find(
    (r) =>
      r.rect[1] > figure.caption.rect[3] &&
      r.r.fontName === font &&
      r.r.height === em &&
      Math.abs(r.rect[0] - left) <= em / 4 &&
      r.rect[2] - r.rect[0] >= width * 0.75 &&
      (r.r.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 8
  )
  if (!witness) return
  const packet = nativeClosedProgramInkPacket(
    page,
    tokens,
    context,
    [...before, witness].map((r) => r.r.sourceItem)
  )
  if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
  const proved = before.map((r) => packet.records.find((p) => p.index === r.index)),
    scope = proved[0]?.part[0]?.g.packet,
    last = Math.max(...proved.flatMap((r) => r.part.map((z) => z.g.i)))
  if (
    !scope ||
    proved.some((r) => !r.advanceComplete || r.part.some((z) => z.g.packet !== scope)) ||
    packet.records.filter((r) => r.part.some((z) => z.g.packet === scope)).length !== 6 ||
    scope.end >= begin ||
    context.operators.fnArray[scope.end] !== OPS.endText
  )
    return
  const tail = context.operators.fnArray.slice(last + 1, scope.end)
  if (
    tail.length &&
    (tail.length !== 2 ||
      tail[0] !== OPS.setFillRGBColor ||
      tail[1] !== OPS.setStrokeRGBColor ||
      JSON.stringify(context.operators.argsArray[last + 1]) !== '["#000000"]' ||
      JSON.stringify(context.operators.argsArray[last + 2]) !== '["#000000"]')
  )
    return
  const own = new Set(picked.own),
    excluded = items.filter(
      (p) =>
        !own.has(p) && pictureBounds(p, Infinity) && pictureHit(oldRect, pictureBounds(p, Infinity))
    )
  if (!excluded.length) return
  for (const p of excluded) {
    if (p.kind !== 'glyph' || p.operationIndex >= begin) return
    const owners = packet.records.filter((r) =>
      r.part.some(
        ({ g }) =>
          g.i === p.operationIndex &&
          g.fontName === p.fontName &&
          g.text === p.text &&
          JSON.stringify(g.ink) === JSON.stringify(p.fullInk)
      )
    )
    if (owners.length !== 1 || !proved.slice(2).includes(owners[0])) return
  }
  return excluded
}

// A full caption text packet can be foreign paint inside an earlier crop.
// Its Source records stay intact; this only permits excluding its complete ink.
function pictureExteriorCompleteCaption(items, picked, figure, page, tokens, context) {
  const packet = nativePageTextPacketInventory(page, tokens, context, true)
  if (!packet) return
  const marker = /^(?:Figure|Fig\.)\s+[A-Z]?[1-9]\d*[a-z]?[.:](?:\s|$)/u
    .exec(figure.caption.lines?.[0] ?? '')?.[0]
    .trim()
  if (!marker) return
  const starts = packet.records.filter(
    (r) =>
      r.r.str.startsWith(marker) &&
      pictureInside(figure.caption.rect, r.rect) &&
      figure.caption.lines[0].startsWith(r.r.str)
  )
  if (starts.length !== 1) return
  const first = starts[0],
    textPacket = first.part[0]?.g.packet,
    records = packet.records.filter((r) => r.part.some((z) => z.g.packet === textPacket))
  if (
    !textPacket ||
    records[0] !== first ||
    !/[.!?]$/u.test(records.at(-1)?.r.str ?? '') ||
    packet.records.filter((r) => r.index >= first.index && r.index <= records.at(-1).index)
      .length !== records.length ||
    records.some((r) => {
      const style = context.content.styles[r.r.fontName]
      return (
        r.part.some((z) => z.g.packet !== textPacket) ||
        !Number.isFinite(style?.ascent) ||
        !Number.isFinite(style?.descent) ||
        style.vertical !== false ||
        r.rect[1] < figure.caption.rect[1] - 1e-6 ||
        r.rect[3] > figure.caption.rect[3] + 1e-6 ||
        r.rect[1] <= Math.max(...picked.own.map((p) => p.bound[3]))
      )
    })
  )
    return
  const glyphs = [...new Set(records.flatMap((r) => r.part.map((z) => z.g)))],
    matches = glyphs.map((g) =>
      items.filter(
        (p) =>
          p.kind === 'glyph' &&
          p.packetBegin === textPacket.start &&
          p.packetEnd === textPacket.end &&
          p.fontName === g.fontName &&
          p.text === g.text &&
          JSON.stringify(p.rect) === JSON.stringify(g.ink)
      )
    )
  if (matches.some((rs) => rs.length !== 1)) return
  const excluded = [...new Set(matches.flat())],
    printed = items.filter(
      (p) =>
        p.kind === 'glyph' && p.packetBegin === textPacket.start && p.packetEnd === textPacket.end
    )
  if (
    excluded.some((p) => picked.own.includes(p)) ||
    printed.length !== excluded.length ||
    printed.some((p) => !excluded.includes(p))
  )
    return
  return excluded
}

// A proof-end box is four original, opaque stroke capsules. This is a pixel
// witness only; it neither repairs font metrics nor establishes a text owner.
function pictureProofTailBox(data, items, context, packet, form, em, baseline, right) {
  const paths = items.filter((p) => p.operationIndex > packet.end && p.operationIndex < form.begin),
    o = context.operators,
    evidence = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  if (paths.length !== 4 || paths.some((p) => p.kind !== 'path')) return
  collectClosedFigureFrames(o, context.viewport, evidence)
  const capsules = paths.map((p) => {
    const ss = data.scopes.filter(
      (s) => s.op === OPS.save && s.begin < p.operationIndex && s.end > p.operationIndex
    )
    return ss.filter(
      (s) => s.end - s.begin >= 5 && s.end - s.begin <= 7 && p.operationIndex === s.end - 1
    )
  })
  if (capsules.some((s) => s.length !== 1)) return
  const scopes = capsules.map((s) => s[0]).sort((a, b) => a.begin - b.begin),
    segments = [],
    widths = []
  if (
    scopes[0].begin !== packet.end + 1 ||
    scopes.some((s, i) => i && s.begin !== scopes[i - 1].end + 1)
  )
    return
  for (const s of scopes) {
    const settingOps = o.fnArray.slice(s.begin + 1, s.end - 1),
      setting = (op) => {
        const indices = settingOps.flatMap((value, n) => (value === op ? [s.begin + 1 + n] : []))
        return indices.length === 1 ? o.argsArray[indices[0]] : undefined
      },
      transform = setting(OPS.transform),
      dash = setting(OPS.setDash),
      join = setting(OPS.setLineJoin)
    if (
      o.fnArray[s.end] !== OPS.restore ||
      o.fnArray[s.end - 1] !== OPS.constructPath ||
      settingOps.some(
        (op) =>
          ![OPS.transform, OPS.setLineWidth, OPS.setLineCap, OPS.setLineJoin, OPS.setDash].includes(
            op
          )
      ) ||
      new Set(settingOps).size !== settingOps.length ||
      (dash && (!Array.isArray(dash[0]) || dash[0].length !== 0 || dash[1] !== 0)) ||
      (join && join[0] !== 0)
    )
      return
    const i = s.end - 1,
      p = paths.find((p) => p.operationIndex === i),
      a = o.argsArray[i],
      t = transform,
      state = evidence.paths.get(i),
      w = setting(OPS.setLineWidth)?.[0],
      line = a?.[1]?.[0]
    if (
      !p ||
      !state ||
      !Number.isFinite(w) ||
      w <= 0 ||
      w > em / 10 ||
      a[0] !== OPS.stroke ||
      a[1].length !== 1 ||
      line?.length !== 6 ||
      line[0] !== 0 ||
      line[3] !== 1 ||
      !Array.from(line).every(Number.isFinite) ||
      !Array.isArray(t) ||
      t.length !== 6 ||
      !t.every(Number.isFinite) ||
      t[0] !== 1 ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] !== 1 ||
      setting(OPS.setLineCap)?.[0] !== 0 ||
      state.strokeAlpha !== 1 ||
      state.solidStroke !== true ||
      state.lineWidth !== w ||
      !pictureValid(state.clip) ||
      !pictureInside(state.clip, p.rect) ||
      p.visiblePaintPoints?.length !== 2
    )
      return
    const [a0, b0] = p.visiblePaintPoints
    if ((a0[0] === b0[0]) === (a0[1] === b0[1])) return
    widths.push(w)
    segments.push([a0, b0])
  }
  if (widths.some((w) => w !== widths[0])) return
  const vertical = segments.filter(([a, b]) => a[0] === b[0]).sort((a, b) => a[0][0] - b[0][0]),
    horizontal = segments.filter(([a, b]) => a[1] === b[1]).sort((a, b) => a[0][1] - b[0][1])
  if (vertical.length !== 2 || horizontal.length !== 2) return
  const left = vertical[0][0][0],
    rightEdge = vertical[1][0][0],
    top = Math.min(...vertical.flat().map((p) => p[1])),
    bottom = Math.max(...vertical.flat().map((p) => p[1])),
    w = widths[0],
    joint = w * 0.51
  if (
    rightEdge - left < em / 2 ||
    rightEdge - left > em ||
    bottom - top < em / 2 ||
    bottom - top > em ||
    Math.abs((rightEdge - left) / (bottom - top) - 1) > 0.1 ||
    Math.abs(bottom - baseline) > w ||
    left < right ||
    left - right > em * 2 ||
    vertical.some(([a, b]) => Math.min(a[1], b[1]) !== top || Math.max(a[1], b[1]) !== bottom) ||
    horizontal.some(
      ([a, b], i) =>
        Math.abs(Math.min(a[0], b[0]) - left) > joint ||
        Math.abs(Math.max(a[0], b[0]) - rightEdge) > joint ||
        Math.abs(a[1] - (i ? bottom : top)) > joint
    )
  )
    return
  return paths
}

// A proof concludes with a wrapped reference to a preceding equation label.
// All complete source runs in the two-line conclusion and the four
// original QED strokes must be outside the independently saved drawing.
function pictureExteriorWrappedProof(data, items, picked, figure, page, tokens, context, oldRect) {
  const sources = context.content?.items
  if (
    !Array.isArray(sources) ||
    !['Hence', 'proves', 'Proof.'].every((text) => sources.some((r) => r.str === text)) ||
    !sources.some((r) => /^\([1-9]\d*\.[1-9]\d*\)\.$/u.test(r.str ?? ''))
  )
    return
  const saves = data.scopes.filter(
    (s) =>
      s.op === OPS.save &&
      pictureScopePieces(s, items).length === picked.own.length &&
      pictureScopePieces(s, items).every((p) => picked.own.includes(p))
  )
  if (!saves.length || context.operators.fnArray.includes(OPS.beginGroup)) return
  const scope = saves.slice().sort((a, b) => a.begin - b.begin)[0],
    ordinal = finitePatternSourceRecords(data, tokens, context),
    bySerial = new Map(items.map((p) => [p.serial, p])),
    original = new Map(data.pieces.map((p, i) => [p, bySerial.get(i)]))
  if (!ordinal) return
  const records = ordinal.map((r) => ({ ...r, pieces: r.pieces.map((p) => original.get(p)) }))
  if (records.some((r) => r.pieces.some((p) => !p))) return
  const packet = picturePackets(items)
    .filter((p) => p.end < scope.begin)
    .sort((a, b) => b.end - a.end)[0]
  if (!packet || context.operators.fnArray[packet.end] !== OPS.endText) return
  const last = records
      .filter((r) =>
        r.pieces.every((p) => p.packetBegin === packet.begin && p.packetEnd === packet.end)
      )
      .at(-1),
    label = /^\(([1-9]\d*\.[1-9]\d*)\)\.$/u.exec(last?.r.str ?? ''),
    starts = records.filter(
      (r) =>
        r.r.str === 'Hence' &&
        r.pieces.every((p) => p.packetBegin === packet.begin && p.packetEnd === packet.end)
    )
  if (!label || starts.length !== 1) return
  const first = starts[0],
    body = records.filter((r) => r.index >= first.index && r.index <= last.index),
    em = first.r.height,
    font = first.r.fontName,
    base = first.r.transform[5],
    endBase = last.r.transform[5],
    preceding = body.at(-2),
    equations = records.filter((r) => r.index < first.index && r.r.str === `(${label[1]})`),
    proofs = records.filter((r) => r.index < first.index && r.r.str === 'Proof.')
  if (
    equations.length !== 1 ||
    proofs.length !== 1 ||
    equations[0].index >= proofs[0].index ||
    proofs[0].index >= first.index ||
    preceding?.r.str !== 'proves' ||
    !Number.isFinite(em) ||
    em <= 0 ||
    last.r.height !== em ||
    last.r.fontName !== font ||
    preceding.r.fontName !== font ||
    preceding.r.height !== em ||
    base - endBase < em ||
    base - endBase > em * 1.7 ||
    Math.abs(first.rect[0] - last.rect[0]) > 0.02 ||
    preceding.r.transform[5] !== base ||
    preceding.rect[2] - first.rect[0] < page.width * 0.65 ||
    (body
      .map((r) => r.r.str)
      .join(' ')
      .match(/\p{L}{2,}/gu)?.length ?? 0) < 5 ||
    body.some(
      (r) =>
        r.pieces.some((p) => p.packetBegin !== packet.begin || p.packetEnd !== packet.end) ||
        r.r.dir !== 'ltr' ||
        r.r.height < em / 2 ||
        r.r.height > em ||
        !r.r.transform.every(Number.isFinite) ||
        r.r.transform[0] <= 0 ||
        r.r.transform[3] !== r.r.height ||
        r.r.transform[1] !== 0 ||
        r.r.transform[2] !== 0 ||
        (r !== last && Math.abs(r.r.transform[5] - base) > em * 0.75) ||
        r.pieces.some(
          (p) =>
            p.fillAlpha !== 1 || p.fillColor !== '#000000' || !pictureInside(p.paintClip, p.fullInk)
        )
    )
  )
    return
  const equationLabel = equations[0],
    proofAnchor = proofs[0]
  if (
    !pictureValid(equationLabel.rect) ||
    !pictureValid(proofAnchor.rect) ||
    equationLabel.rect[3] >= proofAnchor.rect[1] ||
    proofAnchor.rect[3] >= first.rect[1] ||
    Math.abs(equationLabel.rect[2] - preceding.rect[2]) > em / 4 ||
    Math.abs(proofAnchor.rect[0] - first.rect[0]) > em / 4
  )
    return
  const claimed = [equationLabel, proofAnchor, ...body].map((r) => r.r.sourceItem)
  if (claimed.length > 64) return
  const native = nativeClosedProgramInkPacket(page, tokens, context, claimed)
  if (
    !native ||
    claimed.some((s) => !native.records.find((r) => r.index === s.index)?.advanceComplete)
  )
    return
  // Complete source boundaries, including advance-only spaces, remain native.
  for (let i = first.index; i <= last.index; i++)
    if (context.content.items[i]?.str?.trim() && !body.some((r) => r.index === i)) return
  const box = pictureProofTailBox(
    data,
    items,
    context,
    packet,
    scope,
    em,
    last.rect[3],
    preceding.rect[2] - em
  )
  if (
    !box ||
    Math.abs(
      Math.max(...box.flatMap((p) => p.visiblePaintPoints.map((q) => q[0]))) - preceding.rect[2]
    ) >
      em / 10
  )
    return
  const excluded = [...body.flatMap((r) => r.pieces), ...box],
    members = new Set(excluded),
    own = new Set(picked.own)
  if (
    excluded.some((p) => own.has(p)) ||
    items.some(
      (p) => !own.has(p) && pictureHit(oldRect, pictureBounds(p, Infinity)) && !members.has(p)
    )
  )
    return
  return excluded
}

// Reuse the complete ordinary crop-paint certificate and its original glyph
// ordinal inventory. Source/advance disagreements remain foreign facts, never
// a relaxed HeaderInk packet or a Source claim.
function pictureExteriorProofTail(data, items, picked, figure, page, tokens, context, oldRect) {
  if (
    !Array.isArray(context.glyphBounds) ||
    context.partialFontGlyphBounds ||
    context.type3GlyphPrograms ||
    context.pixelType3Programs ||
    context.operators.fnArray.includes(OPS.beginGroup) ||
    items.some((p) => !['glyph', 'path'].includes(p.kind))
  )
    return
  const forms = data.scopes.filter((s) => s.op === OPS.paintFormXObjectBegin),
    scope = forms[0],
    own = new Set(picked.own),
    ordinal = finitePatternSourceRecords(data, tokens, context),
    bySerial = new Map(items.map((p) => [p.serial, p])),
    original = new Map(data.pieces.map((p, i) => [p, bySerial.get(i)]))
  if (!scope || forms.length !== 1 || !ordinal) return
  if (pictureScopePieces(scope, items).some((p) => !own.has(p))) return
  const records = ordinal.map((r) => ({ ...r, pieces: r.pieces.map((p) => original.get(p)) }))
  if (records.some((r) => r.pieces.some((p) => !p))) return
  const packet = picturePackets(items)
    .filter((p) => p.end < scope.begin)
    .sort((a, b) => b.end - a.end)[0]
  if (!packet || context.operators.fnArray[packet.end] !== OPS.endText) return
  const inPacket = records.filter((r) => r.pieces.some((p) => p.packetBegin === packet.begin)),
    last = inPacket.at(-1),
    em = last?.r.height,
    font = last?.r.fontName,
    main = inPacket.filter((r) => r.r.fontName === font && r.r.height === em),
    bases = [...new Set(main.map((r) => r.r.transform[5]))].sort((a, b) => b - a),
    body = []
  if (
    !last ||
    !Number.isFinite(em) ||
    em <= 0 ||
    bases.length < 3 ||
    bases.length > 12 ||
    bases.some((b, i) => i && (bases[i - 1] - b < em || bases[i - 1] - b > em * 1.7)) ||
    inPacket.some((r) =>
      r.pieces.some((p) => p.packetBegin !== packet.begin || p.packetEnd !== packet.end)
    ) ||
    inPacket.reduce((n, r) => n + r.pieces.length, 0) !== packet.pieces.length
  )
    return
  for (const r of inPacket) {
    const raw = r.r,
      m = raw.transform,
      matches = bases.filter((b) => Math.abs(b - m[5]) <= em * 0.6)
    if (!matches.length && m[5] > bases[0] + em) continue
    const native = tokens.filter(
      (t) =>
        t.sourceItem?.pageNumber === page.pageNumber &&
        t.sourceItem.index === r.index &&
        t.sourceItem.text === raw.str &&
        t.text === raw.str
    )
    if (
      matches.length !== 1 ||
      native.length !== 1 ||
      native[0].rect.some((v, i) => Math.abs(v - r.rect[i]) > 1e-6) ||
      raw.dir !== 'ltr' ||
      m.length !== 6 ||
      !m.every(Number.isFinite) ||
      m[0] <= 0 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      m[3] !== raw.height ||
      raw.height < em / 2 ||
      raw.height > em * 1.05 ||
      r.pieces.some(
        (p) =>
          p.fillAlpha !== 1 ||
          !/^#[a-f0-9]{6}$/iu.test(p.fillColor ?? '') ||
          /^#ffffff$/iu.test(p.fillColor) ||
          !pictureInside(p.paintClip, p.fullInk)
      )
    )
      return
    body.push(r)
  }
  if (!body.length || body.at(-1) !== last) return
  const text = body.map((r) => r.r.str).join(' '),
    label = /^(?:Figure|Fig\.?)\s+((?:[A-Z]\.)?[1-9]\d*(?:[.-]\d+)*|[A-Z][1-9]\d*)[.:]\s/u.exec(
      figure.caption.lines?.[0] ?? ''
    )?.[1]
  if (
    !label ||
    !/^\p{Lu}\p{Ll}*\s/u.test(body[0].r.str) ||
    /^(?:Figure|Fig|Panel|Table|Algorithm)\b/iu.test(body[0].r.str) ||
    !/[.!?]$/u.test(last.r.str) ||
    (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 30 ||
    !new RegExp(
      '\\b(?:Figure|Fig\\.)\\s+' +
        label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(?=[\\s.,;:)]|$)',
      'u'
    ).test(text)
  )
    return
  const rows = bases.map((b) => body.filter((r) => Math.abs(r.r.transform[5] - b) <= em * 0.6)),
    rowBounds = rows.map((rs) => union(rs.map((r) => r.rect))),
    width = Math.max(...rowBounds.map((r) => r[2] - r[0])),
    rect = pictureExpand(union(picked.own.map((p) => p.bound)), 2 / 1.5),
    bodyGlyphs = body.flatMap((r) => r.pieces)
  if (
    rowBounds.some((r) => Math.abs(r[0] - rowBounds[0][0]) > em / 4 || r[2] - r[0] < width * 0.75)
  )
    return
  const lastRowGlyphs = rows.at(-1).flatMap((r) => r.pieces)
  const box = pictureProofTailBox(
    data,
    items,
    context,
    packet,
    scope,
    em,
    last.rect[3],
    Math.max(...lastRowGlyphs.map((p) => p.rect[2]))
  )
  if (!box) return
  const excluded = [...bodyGlyphs, ...box],
    members = new Set(excluded)
  if (
    items.some(
      (p) => !own.has(p) && pictureHit(oldRect, pictureBounds(p, Infinity)) && !members.has(p)
    )
  )
    return
  const ownedRecords = records.filter((r) => r.pieces.some((p) => own.has(p)))
  if (!ownedRecords.length || ownedRecords.some((r) => r.pieces.some((p) => !own.has(p)))) return
  const first = ownedRecords[0].index,
    end = ownedRecords.at(-1).index
  for (const [index, raw] of context.content.items.entries()) {
    const rawRect = tableTextToken(raw, context.viewport, 0).rect
    if (index >= first && index <= end) {
      if (raw.str.trim() && !ownedRecords.some((r) => r.index === index)) return
      if (!pictureInside(rect, rawRect)) return
      continue
    }
    const labelRect = nativeFigureLabelBounds(
      raw,
      context.content.styles[raw.fontName],
      context.viewport
    )
    if (
      pictureHit(rect, pictureExpand(rawRect, 1 / 1.5)) ||
      (labelRect && pictureHit(rect, pictureExpand(labelRect, 1 / 1.5)))
    )
      return
  }
  if (
    items.some(
      (p) => !own.has(p) && p.advance && pictureHit(rect, pictureExpand(p.advance, 1 / 1.5))
    )
  )
    return
  return excluded
}

// A repeated publisher header consists of one complete native source, one
// separate path-only logo Form and a straight separator. Its complete prefix
// must match the same document's earlier parity page, including font outlines.
// This establishes only the excluded header: the sole remaining complete Form
// still passes the unchanged full-paint, foreign-owner and encoded-PNG guards.
function pictureRepeatedPaintHeader(data, items, figure, page, context) {
  const w = context.runningHeadWitness,
    proof = w?.paintPrefix,
    o = context.operators,
    other = proof?.operators,
    content = context.content,
    v = context.viewport,
    wv = w?.witnessViewport
  if (
    !proof ||
    !other ||
    !content ||
    !v ||
    !wv ||
    w.sourceSha256 !== context.sourceSha256 ||
    w.currentPageNumber !== page.pageNumber ||
    w.witnessPageNumber !== page.pageNumber - 2 ||
    ![v, wv].every(
      (x) =>
        x.scale === 1 &&
        x.rotation === 0 &&
        x.width === page.width &&
        x.height === page.height &&
        Array.isArray(x.transform) &&
        x.transform.length === 6 &&
        x.transform.every(Number.isFinite)
    ) ||
    v.transform.some((n, i) => n !== wv.transform[i]) ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    !Array.isArray(other.fnArray) ||
    !Array.isArray(other.argsArray)
  )
    return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  if (forms.length !== 2) return
  const [logo, drawing] = forms.slice().sort((a, b) => a.begin - b.begin),
    header = items.filter((p) => p.operationIndex < drawing.begin),
    own = pictureScopePieces(drawing, items),
    logoPaint = pictureScopePieces(logo, items),
    glyphs = header.filter((p) => p.kind === 'glyph'),
    exterior = header.filter((p) => p.kind !== 'glyph' && !logoPaint.includes(p))
  if (
    !header.length ||
    !logoPaint.length ||
    !glyphs.length ||
    exterior.length !== 1 ||
    logoPaint.some((p) => p.kind !== 'path') ||
    exterior[0].kind !== 'path' ||
    !own.some((p) => p.kind === 'glyph') ||
    own.filter((p) => p.kind === 'path').length < 3 ||
    header.some((p) => !pictureValid(p.rect) || p.rect[1] < 0 || p.rect[3] > page.height * 0.07) ||
    own.some(
      (p) =>
        p.bound[1] <= Math.max(...header.map((h) => h.bound[3])) ||
        p.bound[3] >= figure.caption.rect[1]
    )
  )
    return
  const raw = content.items[0],
    witnessRaw = w.witnessContent?.items?.[0],
    text = glyphs.map((p) => p.text).join(''),
    lb = union(logoPaint.map((p) => p.rect)),
    hb = union(glyphs.map((p) => p.rect)),
    rule = exterior[0].rect,
    line = exterior[0].visiblePaintPoints,
    lineArgs = o.argsArray[exterior[0].operationIndex]
  if (
    !raw ||
    !witnessRaw ||
    !/^[A-Z][A-Z .&'-]{2,}$/u.test(raw.str) ||
    text !== raw.str ||
    glyphs.some((p) => p.fontName !== raw.fontName) ||
    raw.sourceItem?.pageNumber !== page.pageNumber ||
    raw.sourceItem?.index !== 0 ||
    raw.sourceItem?.text !== raw.str ||
    new Set(glyphs.map((p) => p.packetBegin)).size !== 1 ||
    new Set(glyphs.map((p) => p.packetEnd)).size !== 1 ||
    witnessRaw.sourceItem?.pageNumber !== w.witnessPageNumber ||
    witnessRaw.sourceItem?.index !== 0 ||
    witnessRaw.sourceItem?.text !== witnessRaw.str ||
    hb[2] - hb[0] <= 2 * (hb[3] - hb[1]) ||
    lb[0] <= hb[2] ||
    lb[2] - lb[0] > page.width * 0.25 ||
    lb[3] - lb[1] > page.height * 0.035 ||
    hb[1] >= lb[3] ||
    lb[1] >= hb[3] ||
    rule[2] - rule[0] < page.width * 0.7 ||
    rule[3] - rule[1] > page.height * 0.005 ||
    o.fnArray[exterior[0].operationIndex] !== OPS.constructPath ||
    lineArgs?.[0] !== OPS.stroke ||
    lineArgs[1]?.length !== 1 ||
    lineArgs[1][0]?.length !== 6 ||
    lineArgs[1][0][0] !== 0 ||
    lineArgs[1][0][3] !== 1 ||
    line?.length !== 2 ||
    line[0][1] !== line[1][1] ||
    Math.min(line[0][0], line[1][0]) > hb[0] ||
    Math.max(line[0][0], line[1][0]) < lb[2] ||
    line[0][1] <= Math.max(hb[3], lb[3]) ||
    line[0][1] - Math.max(hb[3], lb[3]) > raw.height * 1.5 ||
    content.items.slice(1).some((r) => {
      if (typeof r.str !== 'string' || !r.str.trim()) return false
      const bounds = nativeFigureLabelBounds(r, content.styles[r.fontName], v)
      return !pictureValid(bounds) || bounds[1] <= rule[3]
    })
  )
    return
  const keys = ['str', 'dir', 'width', 'height', 'transform', 'fontName', 'hasEOL']
  if (
    keys.some((k) => JSON.stringify(raw[k]) !== JSON.stringify(witnessRaw[k])) ||
    JSON.stringify(content.styles[raw.fontName]) !==
      JSON.stringify(w.witnessContent.styles?.[witnessRaw.fontName])
  )
    return
  const advance = tableTextToken(raw, v, 0)?.rect
  if (
    !pictureValid(advance) ||
    glyphs.some(
      (p) =>
        !pictureValid(p.advance) ||
        p.advance.some((n, i) => (i < 2 ? n < advance[i] - 0.02 : n > advance[i] + 0.02))
    )
  )
    return
  const lastPaint = Math.max(...header.map((p) => p.operationIndex)),
    closing = data.scopes.filter(
      (s) => s.begin < lastPaint && s.end > lastPaint && s.end < drawing.begin
    ),
    end = Math.max(lastPaint, ...closing.map((s) => s.end))
  if (
    end >= drawing.begin ||
    end < logo.end ||
    end >= other.fnArray.length ||
    end >= other.argsArray.length
  )
    return
  // Compare the complete stream prefix from the default graphics/text state,
  // including every transform, Form bbox/clip, path byte and paint setting.
  const stack = []
  for (let i = 0; i <= end; i++) {
    const op = o.fnArray[i]
    if (
      op !== other.fnArray[i] ||
      JSON.stringify(o.argsArray[i]) !== JSON.stringify(other.argsArray[i])
    )
      return
    if (op === OPS.save || op === OPS.paintFormXObjectBegin || op === OPS.beginText) stack.push(op)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd || op === OPS.endText) {
      const expected =
        op === OPS.restore
          ? OPS.save
          : op === OPS.paintFormXObjectEnd
            ? OPS.paintFormXObjectBegin
            : OPS.beginText
      if (stack.pop() !== expected) return
    }
  }
  if (stack.length) return
  const font = context.glyphBounds?.filter((f) => f.fontName === raw.fontName),
    otherFont = proof.glyphBounds?.filter((f) => f.fontName === raw.fontName)
  if (font?.length !== 1 || otherFont?.length !== 1) return
  const shown = o.fnArray
    .slice(0, end + 1)
    .flatMap((op, i) =>
      op === OPS.showText ? (o.argsArray[i]?.[0]?.filter((g) => typeof g === 'object') ?? []) : []
    )
  if (!shown.length) return
  for (const g of shown) {
    const a = font[0].glyphs.filter((x) => x.fontChar === g.fontChar),
      b = otherFont[0].glyphs.filter((x) => x.fontChar === g.fontChar)
    if (a.length !== 1 || b.length !== 1 || JSON.stringify(a[0]) !== JSON.stringify(b[0])) return
  }
  return { own, excluded: header, kind: 'complete-native-picture-with-repeated-header' }
}

function pictureSavedScope(data, items, figure) {
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  if (forms.length > 1) return
  const candidates = (forms.length ? forms : data.scopes.filter((s) => s.op === OPS.save)).flatMap(
    (s) => {
      const own = pictureScopePieces(s, items),
        paint = own.filter((p) => p.kind !== 'glyph')
      if (paint.length < 3 || !own.some((p) => p.kind === 'glyph')) return []
      const rect = union(own.map((p) => p.bound))
      return rect[3] < figure.caption.rect[1] && pictureHit(rect, figure.rect)
        ? [{ own, rect }]
        : []
    }
  )
  if (!candidates.length) return
  const groups = new Map(candidates.map((c) => [c.own.map((p) => p.serial).join(','), c]))
  const all = [...groups.values()].filter(
    (c) =>
      !candidates.some((t) => t.own.length > c.own.length && c.own.every((p) => t.own.includes(p)))
  )
  return all.length === 1 ? { own: all[0].own, kind: 'complete-native-saved-picture' } : undefined
}
function pictureRasterRowKeys(data, items, figure, tokens, context) {
  if (figure.reason !== 'native-raster-composite-grid') return
  const images = items.filter((p) => p.kind === 'image' && pictureInside(figure.rect, p.bound))
  if (images.length < 4 || images.length > 36) return
  const rows = []
  for (const p of images
    .slice()
    .sort((a, b) => a.bound[1] - b.bound[1] || a.bound[0] - b.bound[0])) {
    const row = rows.find((r) => Math.abs(r[0].rect[1] - p.rect[1]) < 1e-6)
    if (row) row.push(p)
    else rows.push([p])
  }
  if (
    rows.length < 2 ||
    rows.length > 6 ||
    rows[0].length < 2 ||
    rows.some((r) => r.length !== rows[0].length)
  )
    return
  const keys = picturePackets(
    items.filter((p) => p.kind !== 'glyph' || p.bound[3] < figure.caption.rect[1])
  ).filter(
    (p) => /^\([a-f]\)$/u.test(p.text) && p.rect[0] >= Math.max(...images.map((p) => p.bound[2]))
  )
  if (
    keys.length !== rows.length ||
    keys.map((p) => p.text[1]).join('') !== 'abcdef'.slice(0, keys.length)
  )
    return
  const fontDomains = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i],
      key = keys[i]
    const baselines = new Set(key.pieces.map((p) => p.advance[3]))
    if (
      baselines.size !== 1 ||
      Math.abs([...baselines][0] - row[0].rect[3]) > 1e-6 ||
      !row.every((p, n) =>
        rows[0]
          .filter((q) => p.rect[0] < q.rect[2] && p.rect[2] > q.rect[0])
          .every((q) => q === rows[0][n])
      )
    )
      return
    const native = tokens.filter((t) => t.text === key.text && t.sourceItem?.text === key.text)
    if (native.length !== 1) return
    const raw = context.content.items[native[0].sourceItem.index],
      font =
        raw && nativeFigureLabelBounds(raw, context.content.styles[raw.fontName], context.viewport)
    if (!pictureValid(font) || raw.str !== key.text) return
    fontDomains.push({ kind: 'font-domain', bound: font, serial: -(i + 1) })
  }
  return {
    own: [...images, ...keys.flatMap((k) => k.pieces), ...fontDomains],
    kind: 'complete-native-raster-row-keys'
  }
}
function pictureRepeatedHeader(items, page, figure, context, tokens) {
  const w = context.runningHeadWitness,
    c = context.content,
    o = w?.witnessContent,
    cur = w?.currentContent,
    v = context.viewport
  if (
    !w ||
    w.sourceSha256 !== context.sourceSha256 ||
    w.currentPageNumber !== page.pageNumber ||
    w.witnessPageNumber !== page.pageNumber - 2 ||
    !o ||
    !cur ||
    ['width', 'height', 'scale', 'rotation'].some((k) => v[k] !== w.witnessViewport?.[k])
  )
    return
  const nonempty = (content) =>
    content.items.map((r, index) => ({ r, index })).filter((x) => x.r.str?.trim())
  const a = nonempty(cur),
    b = nonempty(o),
    number = a.slice(0, 6).filter((x) => x.r.str === String(page.pageNumber))
  if (number.length !== 1) return
  const y = number[0].r.transform[5],
    row = a.filter((x) => x.r.transform[5] === y),
    before = b.filter((x) => x.r.transform[5] === y)
  if (
    row.length < 2 ||
    row.length > 6 ||
    row.length !== before.length ||
    !row.every((x, i) => x.index === a[i].index && x.index === before[i].index)
  )
    return
  // A complete repeated title can contain a separate mathematical fragment.
  // The full original row must carry uppercase title evidence; every fragment
  // still matches literally under the same fonts, positions and page numbers.
  if (
    !/\p{Lu}/u.test(
      row
        .filter((x) => x.r.str !== String(page.pageNumber))
        .map((x) => x.r.str)
        .join('')
    )
  )
    return
  const bounds = []
  for (let i = 0; i < row.length; i++) {
    const x = row[i].r,
      z = before[i].r,
      raw = c.items[row[i].index]
    if (x.str === String(page.pageNumber) ? z.str !== String(page.pageNumber - 2) : x.str !== z.str)
      return
    if (
      !raw ||
      raw.str !== x.str ||
      raw.width !== x.width ||
      raw.height !== x.height ||
      JSON.stringify(raw.transform) !== JSON.stringify(x.transform) ||
      JSON.stringify(x.transform) !== JSON.stringify(z.transform) ||
      JSON.stringify(cur.styles[x.fontName]) !== JSON.stringify(o.styles[z.fontName]) ||
      JSON.stringify(c.styles[raw.fontName]) !== JSON.stringify(cur.styles[x.fontName])
    )
      return
    const rect = nativeFigureLabelBounds(raw, c.styles[raw.fontName], v)
    if (!pictureValid(rect)) return
    bounds.push(rect)
  }
  let native
  const nativeGlyphs = (raw) => {
    native ??= nativePageTextPacketInventory(page, tokens, context, true)
    const records = native?.records.filter((r) => r.r === raw && r.r.sourceItem?.text === raw.str)
    if (records?.length !== 1) return
    const result = []
    for (const g of new Set(records[0].part.map((part) => part.g))) {
      if (g.rendererSkipped || !pictureValid(g.ink)) continue
      const matches = items.filter(
        (p) =>
          p.kind === 'glyph' &&
          p.operationIndex === g.i &&
          p.packetBegin === g.packet.start &&
          p.packetEnd === g.packet.end &&
          p.fontName === g.fontName &&
          p.text === g.text &&
          p.advance.every((n, i) => n === g.advance[i]) &&
          p.rect.every((n, i) => n === g.ink[i])
      )
      if (matches.length !== 1) return
      result.push(matches[0])
    }
    return result.length && new Set(result).size === result.length ? result : undefined
  }
  const rasterRow = (own) => {
    const images = own.filter((p) => p.kind === 'image').sort((a, b) => a.rect[0] - b.rect[0]),
      glyphs = own.filter((p) => p.kind === 'glyph'),
      near = (a, b) => Math.abs(a - b) <= 1e-4
    if (
      images.length !== 3 ||
      images.length + glyphs.length !== own.length ||
      images.some(
        (p, i) =>
          !near(p.rect[3], images[0].rect[3]) || (i > 0 && p.rect[0] <= images[i - 1].rect[2])
      )
    )
      return false
    native ??= nativePageTextPacketInventory(page, tokens, context, true)
    const exactHeader = []
    for (const entry of row) {
      const parts = nativeGlyphs(c.items[entry.index])
      if (!parts) return false
      exactHeader.push(...parts)
    }
    if (exactHeader.length !== head.length || exactHeader.some((p) => !head.includes(p)))
      return false
    const labels = []
    let descriptions = 0
    for (let i = 0; i < images.length; i++) {
      const records = native?.records.filter((r) => r.r.str === `(${String.fromCharCode(97 + i)})`)
      if (records?.length !== 1) return false
      let parts = nativeGlyphs(records[0].r)
      const next = native?.records.find(
          (r) => r.index > records[0].index && r.r.str === '(' + String.fromCharCode(98 + i) + ')'
        ),
        tails = native?.records.filter(
          (r) =>
            r.index > records[0].index &&
            (!next || r.index < next.index) &&
            r.rect[3] < figure.caption.rect[1] &&
            r.part.every(({ g }) => g.i > images[i].operationIndex)
        )
      if (tails?.length) {
        const label = records[0].r,
          text = tails.map((r) => r.r.str).join(' ')
        if (
          !/^\p{L}/u.test(text) ||
          !/[.!?]$/u.test(text) ||
          (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 2 ||
          tails.some(
            (r) =>
              r.r.height !== label.height ||
              Math.abs(r.r.transform[5] - label.transform[5]) > label.height / 100 ||
              /^(?:Notes?|Sources?):/u.test(r.r.str)
          )
        )
          return false
        descriptions++
        const all = [parts, ...tails.map((r) => nativeGlyphs(r.r))]
        if (all.some((p) => !p)) return false
        parts = all.flat()
      }
      if (!parts?.every((p) => glyphs.includes(p))) return false
      const advance = union(parts.map((p) => p.advance)),
        baseline = parts[0].advance[3],
        em = parts[0].advance[3] - parts[0].advance[1],
        image = images[i].rect
      if (
        !(em > 0) ||
        !parts.every(
          (p) => near(p.advance[3], baseline) && near(p.advance[3] - p.advance[1], em)
        ) ||
        (i > 0 && !near(baseline, labels[0][0].advance[3])) ||
        advance[0] < image[0] ||
        advance[2] > image[2] ||
        Math.abs(advance[0] + advance[2] - image[0] - image[2]) / 2 >= em / 8 ||
        union(parts.map((p) => p.bound))[1] <= image[3] ||
        union(parts.map((p) => p.bound))[1] - image[3] > em * 2
      )
        return false
      labels.push(parts)
    }
    if (descriptions !== 0 && descriptions !== images.length) return false
    // Complete native descriptions identify each bottom-aligned image column.
    // Bare panel letters retain the established equal-size raster contract.
    if (
      !descriptions &&
      images.some(
        (p) =>
          !near(p.rect[1], images[0].rect[1]) ||
          !near(p.rect[2] - p.rect[0], images[0].rect[2] - images[0].rect[0])
      )
    )
      return false
    const closed = labels.flat()
    return new Set(closed).size === closed.length && glyphs.every((p) => closed.includes(p))
  }

  const beforeCaptionPaint = items.filter(
    (p) => p.kind !== 'glyph' && p.bound[3] < figure.caption.rect[1]
  )
  const rasterSources =
    beforeCaptionPaint.length === 3 && beforeCaptionPaint.every((p) => p.kind === 'image')
  const head = []
  for (const entry of row) {
    const raw = c.items[entry.index],
      advance = tableTextToken(raw, v, 0).rect,
      geometryGlyphs = items.filter(
        (p) =>
          p.kind === 'glyph' &&
          p.fontName === raw.fontName &&
          pictureValid(p.advance) &&
          p.advance.every((n, i) => (i < 2 ? n >= advance[i] - 0.02 : n <= advance[i] + 0.02))
      )
    if (!pictureValid(advance)) return
    const glyphs =
      geometryGlyphs.length &&
      pictureCompact(geometryGlyphs.map((p) => p.text).join('')) === pictureCompact(raw.str)
        ? geometryGlyphs
        : rasterSources
          ? nativeGlyphs(raw)
          : undefined
    if (!glyphs?.length) return
    head.push(...glyphs)
  }
  if (new Set(head).size !== head.length) return
  // Font metrics need not contain every outline extremum. Whole original
  // advances/literals bind each header glyph; its full ink stays protected.
  const headerBox = union([...bounds, ...head.map((p) => p.rect)])
  if (
    pictureCompact(head.map((p) => p.text).join('')) !==
    pictureCompact(row.map((x) => x.r.str).join(''))
  )
    return
  const own = items.filter((p) => !head.includes(p) && p.bound[3] < figure.caption.rect[1])
  const vector = own.filter((p) => p.kind === 'path').length >= 3
  if (
    !own.length ||
    own.some((p) => p.bound[1] <= headerBox[3]) ||
    (!vector && !rasterRow(own)) ||
    own.some((p) => !pictureHit(p.bound, figure.rect))
  )
    return
  return {
    own,
    excluded: head,
    kind: vector
      ? 'complete-native-picture-with-repeated-header'
      : 'complete-native-raster-row-with-repeated-header'
  }
}

// A complete caption can start with advance-only whitespace above its ink.
// Preserve the full Forms only after the complete native paragraph is rebound;
// keep every caption/folio/path in the unchanged encoded-PNG foreign inventory.
function pictureCaptionAdvanceBlank(figure, picked, rect, page, tokens, context) {
  if (
    picked.kind !== 'complete-native-captioned-form-grid' ||
    rect[3] <= figure.caption.rect[1] ||
    !Array.isArray(page.lines)
  )
    return
  const matches = findCaptionCandidates([page]).filter(
    (c) =>
      c.page === figure.caption.page &&
      JSON.stringify(c.lines) === JSON.stringify(figure.caption.lines) &&
      JSON.stringify(c.rect) === JSON.stringify(figure.caption.rect)
  )
  if (matches.length !== 1) return
  const packet =
    nativePageTextPacketInventory(page, tokens, context, true) ??
    nativeTypedPlotPacketInventory(page, figure, [figure.caption], [], [], tokens, context)
  const records = packet?.records.filter((r) => pictureInside(figure.caption.rect, r.rect))
  if (
    !records?.length ||
    !/^(?:Figure|Fig\.?)\s/u.test(records[0].r.str) ||
    !/[.!?]$/u.test(records.at(-1).r.str) ||
    packet.records.filter((r) => r.index >= records[0].index && r.index <= records.at(-1).index)
      .length !== records.length ||
    records.some((r) => {
      const s = context.content.styles[r.r.fontName]
      return (
        !Number.isFinite(s?.ascent) ||
        !Number.isFinite(s.descent) ||
        s.ascent <= 0 ||
        s.descent > 0 ||
        s.vertical !== false
      )
    })
  )
    return
  const owner = new Map()
  for (const r of packet.records)
    for (const g of new Set(r.part.map((p) => p.g))) {
      if (owner.has(g)) return
      owner.set(g, r)
    }
  const glyphs = [...new Set(records.flatMap((r) => r.part.map((p) => p.g)))],
    lifetimes = [...new Set(glyphs.map((g) => g.packet))].sort((a, b) => a.start - b.start)
  if (
    lifetimes.some(
      (p, i) =>
        !Number.isSafeInteger(p.start) ||
        !Number.isSafeInteger(p.end) ||
        context.operators.fnArray[p.start] !== OPS.beginText ||
        context.operators.fnArray[p.end] !== OPS.endText ||
        (i && p.start <= lifetimes[i - 1].end)
    )
  )
    return
  for (const g of packet.glyphs.filter((g) => lifetimes.includes(g.packet))) {
    if (!g.text.trim()) continue
    const r = owner.get(g)
    if (!r || g.rendererSkipped || !pictureValid(g.ink)) return
    if (
      !records.includes(r) &&
      !(
        r.index > records.at(-1).index &&
        r.rect[1] > figure.caption.rect[3] &&
        r.r.str === String(page.pageNumber)
      )
    )
      return
  }
  const width = rect[2] - rect[0],
    height = rect[3] - rect[1],
    scale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(width, height)),
    pixelWidth = Math.min(MAX_EDGE, Math.max(1, Math.ceil(width * scale))),
    pixelHeight = Math.min(MAX_EDGE, Math.max(1, Math.ceil(height * scale))),
    scaleLower =
      Math.max((pixelWidth - 1) / width, (pixelHeight - 1) / height) * (1 - 8 * Number.EPSILON)
  if (!Number.isFinite(scaleLower) || scaleLower < 1.5) return
  return { pixelWidth, pixelHeight, scaleLower }
}

// These plans change pixels only. No Source records are exposed by the paint
// certificate, and zero-advance or translucent text never acquires navigation
// or cell ownership through this API.
const finiteColoredPatternFigures = new WeakMap()

// This ordinal inventory binds original spellings and fonts without making any
// claim about the completeness of a clipped interior Source's advance or ink.
function finitePatternSourceRecords(data, tokens, context) {
  const source = [],
    glyphs = []
  for (const [index, r] of context.content.items.entries())
    for (const c of pictureCompact(r.str ?? '')) source.push({ index, c, font: r.fontName })
  for (const p of data.pieces.filter((p) => p.kind === 'glyph'))
    for (const c of pictureCompact(p.text)) glyphs.push({ p, c })
  if (source.length !== glyphs.length) return
  const groups = new Map(),
    owners = new Map()
  for (let i = 0; i < source.length; i++) {
    const s = source[i],
      g = glyphs[i]
    if (s.c !== g.c || s.font !== g.p.fontName || (owners.has(g.p) && owners.get(g.p) !== s.index))
      return
    owners.set(g.p, s.index)
    if (!groups.has(s.index)) groups.set(s.index, new Set())
    groups.get(s.index).add(g.p)
  }
  return [...groups].map(([index, ps]) => ({
    index,
    r: context.content.items[index],
    pieces: [...ps],
    rect: tableTextToken(context.content.items[index], context.viewport, 0).rect
  }))
}
function finitePatternExteriorRecord(r, tokens, context) {
  const s = context.content.styles[r.r.fontName],
    native = tokens.filter(
      (t) =>
        r.r.sourceItem?.pageNumber === context.pageNumber &&
        r.r.sourceItem.index === r.index &&
        r.r.sourceItem.text === r.r.str &&
        t.sourceItem?.pageNumber === r.r.sourceItem.pageNumber &&
        t.sourceItem?.index === r.index &&
        t.sourceItem?.text === r.r.str &&
        t.text === r.r.str
    ),
    advance = union(r.pieces.map((p) => p.advance))
  return (
    s?.vertical === false &&
    Number.isFinite(s.ascent) &&
    s.ascent > 0 &&
    s.ascent <= 2 &&
    Number.isFinite(s.descent) &&
    s.descent >= -2 &&
    s.descent <= 0 &&
    pictureValid(r.rect) &&
    native.length === 1 &&
    native[0].rect.every((v, i) => Math.abs(v - r.rect[i]) <= 1e-6) &&
    advance.every((v, i) => Math.abs(v - r.rect[i]) <= 0.02) &&
    r.pieces.every(
      (p) =>
        p.fillAlpha === 1 &&
        /^#[a-f0-9]{6}$/iu.test(p.fillColor ?? '') &&
        !/^#ffffff$/iu.test(p.fillColor) &&
        pictureValid(p.paintClip) &&
        pictureInside(p.paintClip, p.rect)
    )
  )
}
export function nativeFiniteColoredPatternFigures(page, captions, tables, tokens, context) {
  try {
    const own = nativeRecoveryOwnValues(context),
      keep = own && retainNativeRecoveryInputs([page, tokens, context], own.viewport),
      handle = keep && createNativeFigurePaintCertificate(page, tokens, context),
      data = nativeFigurePaintCertificateData(handle, page, tokens, context)
    if (
      !data?.coloredPatternForms?.length ||
      !Array.isArray(captions) ||
      !Array.isArray(tables) ||
      !Array.isArray(page.lines)
    )
      return []
    const records = finitePatternSourceRecords(data, tokens, context)
    if (!records) return []
    const result = [],
      ordinal = (s) => /^(?:Fig\.?|Figure)\s+(\d+)\.?$/u.exec(s)?.[1]
    for (const form of data.coloredPatternForms) {
      const heads = records.filter(
        (r) =>
          ordinal(r.r.str) &&
          r.pieces.every((p) => p.operationIndex > form.end) &&
          Math.abs(r.rect[0] - form.rect[0]) <= 0.02 &&
          r.rect[1] > form.rect[3] &&
          r.rect[1] - form.rect[3] < r.r.height * 2
      )
      if (heads.length !== 1) continue
      const head = heads[0],
        at = records.indexOf(head),
        next = records[at + 1],
        number = Number(ordinal(head.r.str)),
        em = head.r.height,
        witness = captions.filter(
          (c) =>
            c.page === page.pageNumber &&
            c.rect[3] < form.rect[1] &&
            /^(?:Fig\.?|Figure)\s+(\d+)\b/u.exec(c.lines?.[0] ?? '')?.[1] === String(number - 1)
        )
      if (
        !next ||
        !/^Where\s+\p{Ll}/u.test(next.r.str) ||
        next.r.fontName !== head.r.fontName ||
        !Number.isSafeInteger(number) ||
        number < 2 ||
        witness.length !== 1
      )
        continue
      const prior = records.filter(
        (r) =>
          ordinal(r.r.str) === String(number - 1) &&
          r.r.fontName === head.r.fontName &&
          pictureInside(witness[0].rect, r.rect)
      )
      if (prior.length !== 1 || !finitePatternExteriorRecord(prior[0], tokens, context)) continue
      const priorTitle = records[records.indexOf(prior[0]) + 1]
      if (
        !priorTitle ||
        priorTitle.r.fontName !== head.r.fontName ||
        !pictureInside(witness[0].rect, priorTitle.rect) ||
        !pictureCompact(witness[0].lines.join(' ')).startsWith(
          pictureCompact(prior[0].r.str + priorTitle.r.str)
        ) ||
        !finitePatternExteriorRecord(priorTitle, tokens, context)
      )
        continue
      const packetBegin = head.pieces[0].packetBegin,
        packetEnd = head.pieces[0].packetEnd,
        packetPieces = data.pieces.filter(
          (p) => p.kind === 'glyph' && p.packetBegin === packetBegin
        ),
        packetRecords = records.filter((r) => r.pieces.some((p) => p.packetBegin === packetBegin))
      if (
        packetBegin <= form.end ||
        packetRecords.length < 4 ||
        packetRecords.length > 96 ||
        packetRecords[0] !== head ||
        packetRecords.some(
          (r) =>
            r.pieces.some((p) => p.packetBegin !== packetBegin || p.packetEnd !== packetEnd) ||
            !finitePatternExteriorRecord(r, tokens, context)
        ) ||
        packetPieces.length !== packetRecords.reduce((n, r) => n + r.pieces.length, 0)
      )
        continue
      const footer = packetRecords.at(-1),
        body = packetRecords.slice(0, -1),
        last = body.at(-1)
      // Retain the complete original BT/ET. The closing folio is a separate
      // original font/baseline/center domain, never a truncated caption ET.
      if (
        footer.r.str !== String(page.pageNumber) ||
        footer.r.fontName === head.r.fontName ||
        !(footer.r.height > em && footer.r.height < em * 2) ||
        footer.rect[1] - last.rect[3] < em * 3 ||
        Math.abs((footer.rect[0] + footer.rect[2] - form.rect[0] - form.rect[2]) / 2) > em * 0.05 ||
        Math.abs((footer.rect[0] + footer.rect[2]) / 2 - page.width / 2) > em * 2 ||
        !/[.!?]$/u.test(last.r.str.trim()) ||
        body.every((r) => r.r.fontName === head.r.fontName)
      )
        continue
      const capRect = union(body.map((r) => r.rect)),
        rows = page.lines
          .filter(
            (l) =>
              l.x >= capRect[0] - 0.02 &&
              l.y >= capRect[1] - 0.02 &&
              l.x + l.width <= capRect[2] + 0.02 &&
              l.y + l.height <= capRect[3] + 0.02
          )
          .sort((a, b) => a.y - b.y)
      if (
        rows.length < 2 ||
        rows.length > 16 ||
        pictureCompact(rows.map((r) => r.text).join(' ')) !==
          pictureCompact(body.map((r) => r.r.str).join(' ')) ||
        rows.some(
          (r, i) =>
            Math.abs(r.x - form.rect[0]) > 0.02 ||
            Math.abs(r.fontSize - em) > em * 0.01 ||
            r.x + r.width > form.rect[2] + 0.02 ||
            (i && (r.y - rows[i - 1].y < em || r.y - rows[i - 1].y > em * 1.5))
        ) ||
        rows.at(-1).width > (form.rect[2] - form.rect[0]) * 0.85 ||
        Math.abs(rows[0].width - (form.rect[2] - form.rect[0])) > 0.02
      )
        continue
      const caption = { page: page.pageNumber, rect: capRect, lines: rows.map((r) => r.text) },
        candidate = {
          rect: [...form.rect],
          caption,
          sourceItems: [],
          graphicsCount: data.pieces.filter(
            (p) => p.kind === 'path' && p.operationIndex > form.begin && p.operationIndex < form.end
          ).length
        },
        current = retainNativeRecoveryInputs(
          [candidate, witness[0], form, body, footer],
          own.viewport
        )
      if (!current || !keep()) continue
      finiteColoredPatternFigures.set(candidate, {
        page,
        tokens,
        context,
        handle,
        data,
        form,
        witness: witness[0],
        current: () => keep() && current()
      })
      if (
        finiteColoredPatternPlan(
          page,
          candidate,
          [...captions, caption],
          tables,
          tokens,
          context,
          []
        )
      )
        result.push(candidate)
    }
    return result
  } catch {
    return []
  }
}
function finiteColoredPatternPlan(page, figure, captions, tables, tokens, context, peers) {
  const p = finiteColoredPatternFigures.get(figure)
  if (
    !p ||
    p.page !== page ||
    p.tokens !== tokens ||
    p.context !== context ||
    !p.current() ||
    !captions.includes(figure.caption) ||
    !captions.includes(p.witness) ||
    captions.filter((c) => c.page === page.pageNumber && c.lines[0] === figure.caption.lines[0])
      .length !== 1 ||
    nativeFigurePaintCertificateData(p.handle, page, tokens, context) !== p.data
  )
    return
  const minScale = 1.5,
    items = p.data.pieces.flatMap((piece, serial) => {
      const bound = pictureBounds(piece, minScale)
      return bound ? [{ ...piece, bound, serial }] : []
    }),
    owned = pictureScopePieces(p.form, items),
    foreign = items.filter((q) => !owned.includes(q)),
    rect = pictureExpand(p.form.rect, 2 / minScale),
    protection = pictureExpand(rect, 2 / minScale)
  if (
    !owned.length ||
    owned.some((q) => !pictureInside(p.form.rect, q.bound)) ||
    !pictureInside([0, 0, page.width, page.height], rect) ||
    foreign.some((q) => pictureHit(protection, pictureExpand(q.bound, 2 / minScale))) ||
    captions.some(
      (c) => c.page === page.pageNumber && (!pictureValid(c.rect) || pictureHit(rect, c.rect))
    ) ||
    tables.some((t) => !pictureValid(t) || pictureHit(rect, t)) ||
    peers.some((f) => f !== figure && f.rect && (!pictureValid(f.rect) || pictureHit(rect, f.rect)))
  )
    return
  const plan = {
      rect,
      kind: 'complete-native-colored-pattern-form',
      sourceItems: [],
      graphicsCount: figure.graphicsCount
    },
    form = {
      ownedRects: owned.map((q) => q.bound),
      foreignPaints: foreign.map((q) => ({ rect: q.bound, floor: 0 }))
    },
    inputs = retainNativeRecoveryInputs([figure, captions, tables, peers], context.viewport),
    outputCurrent = retainNativeRecoveryInputs([plan, form])
  if (!inputs || !outputCurrent || !p.current()) return
  completePicturePaintPlans.set(plan, {
    page,
    tokens,
    context,
    handle: p.handle,
    current: () => p.current() && inputs(),
    outputCurrent,
    form,
    minScale,
    rect: plan.rect
  })
  return plan
}

// Unknown curved clips may only reduce a complete original Form's paint.
// This separate image-only proof keeps their full programs and never supplies
// visible points, filled corners, Source ownership or a replacement clip.
const occupiedClippedFormPlans = new WeakMap()
function occupiedClippedFormCrop(page, figure, captions, tables, tokens, context, peers, oldRect) {
  // renderPdfCrop uses this pinned CanvasGraphics' default opaque white
  // canvas and always executes the complete original operator program.
  if (version !== '5.4.624') return
  const own = nativeRecoveryOwnValues(context),
    current =
      own &&
      retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, context, peers, oldRect],
        own.viewport
      )
  if (
    !current ||
    !own.operators.fnArray.includes(OPS.paintFormXObjectBegin) ||
    !own.operators.fnArray.some((op) => op === OPS.clip || op === OPS.eoClip)
  )
    return
  const p = nativePageTextPacketInventory(page, tokens, context, true)
  if (
    !p ||
    !pictureValid(figure?.rect) ||
    !pictureValid(oldRect) ||
    !pictureValid(figure.caption?.rect) ||
    figure.caption.page !== page.pageNumber ||
    ![captions, tables, peers].every(Array.isArray) ||
    !captions.includes(figure.caption) ||
    figure.parts ||
    figure.cropRects ||
    figure.sourceItems?.length ||
    p.records.length > 4096 ||
    p.evidence.paths.size > 4096 ||
    p.evidence.images.length
  )
    return
  const { o, v } = p,
    forms = [],
    paths = [],
    stack = [],
    allowed = new Set([
      OPS.setFillRGBColor,
      OPS.setStrokeRGBColor,
      OPS.beginText,
      OPS.dependency,
      OPS.setFont,
      OPS.moveText,
      OPS.showText,
      OPS.endText,
      OPS.transform,
      OPS.save,
      OPS.paintFormXObjectBegin,
      OPS.paintFormXObjectEnd,
      OPS.restore,
      OPS.setLineJoin,
      OPS.setLineWidth,
      OPS.constructPath,
      OPS.setGState,
      OPS.clip,
      OPS.eoClip,
      OPS.setDash,
      OPS.setLineCap,
      OPS.setMiterLimit,
      OPS.setTextMatrix
    ]),
    same = (a, b) => a?.length === b?.length && a.every((n, i) => n === b[i]),
    cut = (a, b) => [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3])
    ],
    boundedPath = (a) => {
      const t = a?.[1]?.length === 1 && a[1][0]
      if (!t || !p.finite(a[2], 4) || t[0] !== 0) return
      let at = 0
      while (at < t.length) {
        const op = t[at++],
          count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 4 ? 0 : -1
        if (count < 0 || at + count > t.length) return
        for (let j = 0; j < count; j += 2) {
          const x = t[at + j],
            y = t[at + j + 1]
          // Every cubic lies in its control hull, including the serialized
          // Float32 program. Finite min/max alone is insufficient here.
          if (
            ![x, y].every(Number.isFinite) ||
            x < a[2][0] ||
            x > a[2][2] ||
            y < a[2][1] ||
            y > a[2][3]
          )
            return
        }
        at += count
      }
      return t
    }
  let state = {
      matrix: [1, 0, 0, 1, 0, 0],
      form: undefined,
      curves: [],
      fill: '#000000',
      cap: 0,
      join: 0,
      dash: [[], 0]
    },
    pending
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (!allowed.has(op) || (pending !== undefined && op !== OPS.constructPath)) return
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ op, state })
      state = { ...state, matrix: [...state.matrix], curves: [...state.curves] }
      if (op === OPS.paintFormXObjectBegin) {
        if (a?.[0] && !p.finite(a[0], 6)) return
        if (a?.[0]) state.matrix = Util.transform(state.matrix, a[0])
        if (!p.valid(a?.[1])) return
        const rect = p.box(a[1], Util.transform(v.transform, state.matrix)),
          form = { begin: i, parent: state.form, rect, bbox: a[1], matrix: [...state.matrix] }
        if (!pictureValid(rect)) return
        forms.push(form)
        state.form = form
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const last = stack.pop()
      if (!last || last.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      if (op === OPS.paintFormXObjectEnd) state.form.end = i
      state = last.state
    } else if (op === OPS.transform) state.matrix = Util.transform(state.matrix, a)
    else if (op === OPS.setFillRGBColor) state.fill = a?.[0]
    else if (op === OPS.setLineCap) state.cap = a?.[0]
    else if (op === OPS.setLineJoin) state.join = a?.[0]
    else if (op === OPS.setDash) state.dash = a
    else if (op === OPS.setGState) {
      for (const [key, value] of a?.[0] ?? []) {
        if (!['CA', 'ca', 'LW', 'LC', 'LJ', 'ML', 'D'].includes(key)) return
        if (key === 'LC') state.cap = value
        if (key === 'LJ') state.join = value
        if (key === 'D') state.dash = value
      }
    } else if (op === OPS.clip || op === OPS.eoClip) pending = i
    else if (op === OPS.constructPath) {
      const t = boundedPath(a),
        s = p.evidence.paths.get(i)
      if (!t || !s || !same(s.transform, state.matrix)) return
      if (a[0] !== OPS.endPath) {
        const paint = nativeFigurePathPaint(p, i, s)
        if (!paint || !pictureValid(paint.rect)) return
        paths.push({
          i,
          a,
          t,
          s,
          paint,
          form: state.form,
          fill: state.fill,
          curves: [...state.curves]
        })
        const q = paths.at(-1),
          m = Util.transform(v.transform, s.transform),
          dash = state.dash,
          solid =
            state.cap === 2 && s.solidStroke && Array.isArray(dash?.[0]) && dash[0].length === 0,
          buttDash =
            state.cap === 0 &&
            !s.solidStroke &&
            Array.isArray(dash?.[0]) &&
            dash[0].length > 0 &&
            dash[0].every((n) => Number.isFinite(n) && n > 0) &&
            Number.isFinite(dash[1])
        // A round join on two strictly same-direction horizontal segments
        // has no miter extension. Positive butt dashes paint a subset of the
        // continuous tube. Keep original cap/join/dash/ML entirely unchanged.
        if (
          a[0] === OPS.stroke &&
          t.length === 9 &&
          t[3] === 1 &&
          t[6] === 1 &&
          t[1] < t[4] &&
          t[4] < t[7] &&
          t[2] === t[5] &&
          t[5] === t[8] &&
          state.cap === s.lineCap &&
          state.join === 1 &&
          (solid || buttDash) &&
          m[1] === 0 &&
          m[2] === 0 &&
          Math.abs(m[0]) === Math.abs(m[3])
        ) {
          const pad = (s.lineWidth * Math.SQRT2) / 2
          q.paint = {
            rect: p.box([t[1] - pad, t[2] - pad, t[7] + pad, t[2] + pad], m),
            floor: Math.SQRT2 / 2
          }
        }
      }
      if (pending !== undefined) {
        if (a[0] !== OPS.endPath || t.at(-1) !== 4 || !state.form) return
        state.curves.push({ i, form: state.form })
        pending = undefined
      }
    }
  }
  if (stack.length || pending !== undefined || !paths.some((q) => q.s.clip === null)) return
  const owner = new Map(),
    sources = []
  for (const r of p.records) {
    const s = context.content.styles[r.r.fontName],
      [a, b, c, d, x, y] = r.r.transform,
      advance = Math.hypot(a, b),
      height = Math.hypot(c, d)
    if (
      s?.vertical !== false ||
      !Number.isFinite(s.ascent) ||
      s.ascent <= 0 ||
      s.ascent > 2 ||
      !Number.isFinite(s.descent) ||
      s.descent < -2 ||
      s.descent > 0 ||
      !(advance > 0) ||
      !(height > 0) ||
      a * d - b * c <= 0
    )
      return
    const points = [0, r.r.width].flatMap((u) =>
        [s.descent * height, s.ascent * height].map((w) =>
          v.convertToViewportPoint(
            x + (a / advance) * u + (c / height) * w,
            y + (b / advance) * u + (d / height) * w
          )
        )
      ),
      font = [
        Math.min(...points.map((q) => q[0])),
        Math.min(...points.map((q) => q[1])),
        Math.max(...points.map((q) => q[0])),
        Math.max(...points.map((q) => q[1]))
      ],
      glyphs = [...new Set(r.part.map((z) => z.g))],
      av = union(glyphs.map((g) => g.advance))
    if (!pictureValid(font) || av.some((n, i) => Math.abs(n - r.rect[i]) > 0.02)) return
    for (const g of glyphs) {
      if (owner.has(g)) return
      owner.set(g, r)
    }
    sources.push({
      r,
      glyphs,
      rect: union([r.rect, font, av, ...glyphs.filter(positive).map((g) => g.ink)])
    })
  }
  if (p.glyphs.some((g) => positive(g) && !owner.has(g))) return
  const minScale = 1.5,
    results = []
  for (const root of forms.filter((f) => !f.parent)) {
    const belongs = (i) => i > root.begin && i < root.end,
      rootPaths = paths.filter((q) => belongs(q.i)),
      bg = rootPaths[0],
      t = bg?.t,
      corners = t?.length === 13 ? [0, 3, 6, 9].map((i) => [t[i + 1], t[i + 2]]) : [],
      rootSources = sources.filter((q) => q.glyphs.some((g) => belongs(g.i))),
      cap = sources.filter((q) => pictureInside(figure.caption.rect, q.r.rect)),
      packets = new Set(cap.flatMap((q) => q.glyphs.map((g) => g.packet)))
    if (
      !bg ||
      paths[0] !== bg ||
      bg.form !== root ||
      bg.a[0] !== OPS.fill ||
      bg.s.fillAlpha !== 1 ||
      !/^#ffffff$/iu.test(bg.fill) ||
      !same(bg.s.clip, root.rect) ||
      !same(bg.s.transform, root.matrix) ||
      !same(bg.a[2], root.bbox) ||
      t.length !== 13 ||
      t[12] !== 4 ||
      ![3, 6, 9].every((j) => t[j] === 1) ||
      new Set(corners.map((q) => q.join(','))).size !== 4 ||
      corners.some((q, i) => {
        const next = corners[(i + 1) % 4]
        return q[0] !== next[0] && q[1] !== next[1]
      }) ||
      !same(
        [...new Set([t[1], t[4], t[7], t[10]])].sort((a, b) => a - b),
        [root.bbox[0], root.bbox[2]]
      ) ||
      !same(
        [...new Set([t[2], t[5], t[8], t[11]])].sort((a, b) => a - b),
        [root.bbox[1], root.bbox[3]]
      ) ||
      !rootPaths.some((q) => q.s.clip === null) ||
      !rootSources.length ||
      !cap.length ||
      captions.filter(
        (c) =>
          c.page === page.pageNumber &&
          pictureCompact(c.lines.join(' ')) === pictureCompact(figure.caption.lines.join(' '))
      ).length !== 1 ||
      packets.size !== 1 ||
      rootSources.some((q) => !q.glyphs.every((g) => belongs(g.i))) ||
      rootSources.at(-1) !== sources[sources.indexOf(cap[0]) - 1] ||
      !/^(?:Figure|Fig\.?)\d+/u.test(pictureCompact(cap.map((q) => q.r.r.str).join(' '))) ||
      !/[.!?]$/u.test(cap.at(-1).r.r.str.trim()) ||
      pictureCompact(cap.map((q) => q.r.r.str).join(' ')) !==
        pictureCompact(figure.caption.lines.join(' ')) ||
      [...packets].some((q) => q.start <= root.end) ||
      p.glyphs.some(
        (g) => packets.has(g.packet) && g.text.trim() && !cap.some((q) => q.glyphs.includes(g))
      ) ||
      sources.some((q) => q.glyphs.some((g) => g.i < bg.i) && pictureHit(q.rect, root.rect))
    )
      continue
    const ownPaths = rootPaths.slice(1),
      foreignPaths = paths.filter((q) => !belongs(q.i)),
      bounds = ownPaths.map((q) => {
        if (q.s.clip === null && (!q.curves.length || q.curves.some((c) => !belongs(c.i)))) return
        return cut(
          pictureExpand(q.paint.rect, (q.paint.floor + 1) / minScale),
          q.s.clip ?? root.rect
        )
      })
    if (bounds.some((r) => !pictureValid(r))) continue
    const owned = [...bounds, ...rootSources.map((q) => pictureExpand(q.rect, 1 / minScale))],
      foreign = [
        ...foreignPaths.map((q) => pictureExpand(q.paint.rect, (q.paint.floor + 1) / minScale)),
        ...sources
          .filter((q) => !rootSources.includes(q))
          .map((q) => pictureExpand(q.rect, 1 / minScale))
      ],
      rect = pictureExpand(union(owned), 2 / minScale)
    if (
      !pictureInside([0, 0, page.width, page.height], rect) ||
      !pictureHit(rect, figure.rect) ||
      foreign.some((r) => pictureHit(rect, pictureExpand(r, 2 / minScale))) ||
      captions.some(
        (c) => c.page === page.pageNumber && (!pictureValid(c.rect) || pictureHit(rect, c.rect))
      ) ||
      tables.some((r) => !pictureValid(r) || pictureHit(rect, r)) ||
      peers.some(
        (f) => f !== figure && f.rect && (!pictureValid(f.rect) || pictureHit(rect, f.rect))
      ) ||
      !sources.some((q) => !rootSources.includes(q) && pictureHit(oldRect, q.rect)) ||
      same(rect, figure.rect)
    )
      continue
    const plan = {
        rect,
        kind: 'complete-native-occupied-clipped-form',
        graphicsCount: rootPaths.length
      },
      form = { ownedRects: owned, foreignPaints: foreign.map((r) => ({ rect: r, floor: 0 })) },
      outputCurrent = retainNativeRecoveryInputs([plan, form])
    if (!outputCurrent || !current()) continue
    occupiedClippedFormPlans.set(plan, { page, rect, form, current, outputCurrent, minScale })
    results.push(plan)
  }
  return results.length === 1 ? results[0] : undefined
}

const savedUncoloredPixelPlans = new WeakMap()
function savedUncoloredPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers,
  originalCrop
) {
  try {
    const input = nativeRecoveryOwnValues(context),
      binding = savePixelContextBinding(context)
    if (!input || !binding || input.type3GlyphPrograms !== undefined) return
    const keep = retainNativeRecoveryInputs(
      [page, figure, captions, tables, tokens, peers, originalCrop],
      input.viewport
    )
    if (!keep) return
    const current = () => binding.current() && keep()
    context = binding.input
    if (
      !pictureValid(figure?.rect) ||
      !pictureValid(originalCrop) ||
      !pictureValid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      ![captions, tables, peers].every(Array.isArray) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !captions.includes(figure.caption) ||
      peers.length !== 1 ||
      peers[0] !== figure ||
      tables.length
    )
      return
    const handle = createNativeSavedUncoloredPixelEvidence(page, tokens, context),
      data = nativeSavedUncoloredPixelEvidenceData(handle, page, tokens, context)
    if (!data || context.operators.fnArray.includes(OPS.setGState)) return
    const member = (scope, i) => i > scope.begin && i < scope.end
    const candidates = data.scopes.filter((s) => data.patterns.some((i) => member(s, i)))
    const selected = data.patterns.map(
      (i) => candidates.filter((s) => member(s, i)).sort((a, b) => a.begin - b.begin)[0]
    )
    if (selected.some((s) => !s)) return
    const scopes = [...new Set(selected)]
    if (scopes.some((s, n) => scopes.some((t, k) => k !== n && s.begin < t.end && s.end > t.begin)))
      return
    if (
      data.patterns.length === 2 &&
      (scopes.length !== 1 || data.paths.some((p) => !member(scopes[0], p.operationIndex)))
    )
      return
    if (data.patterns.length === 3 && ![1, 3].includes(scopes.length)) return
    const scope = {
        begin: Math.min(...scopes.map((s) => s.begin)),
        end: Math.max(...scopes.map((s) => s.end))
      },
      owns = (g) => scopes.some((s) => member(s, g.operationIndex)),
      // Complete the actual ink of whole native Sources already inside the
      // old preview. Their nominal source cells alone can clip descenders.
      retained =
        data.patterns.length === 3
          ? data.records.filter(
              (r) =>
                r.raw.str.trim() &&
                r.glyphIndices.length &&
                pictureInside(originalCrop, r.rect) &&
                r.glyphIndices.every((i) => !owns(data.glyphs[i])) &&
                union(r.glyphIndices.map((i) => data.glyphs[i].advance)).every(
                  (v, i) => Math.abs(v - r.rect[i]) <= 0.02
                )
            )
          : [],
      retainedGlyphs = new Set(retained.flatMap((r) => r.glyphIndices)),
      ownedGlyphs = data.glyphs.filter((g, i) => owns(g) || retainedGlyphs.has(i)),
      foreignGlyphs = data.glyphs.filter((g, i) => !owns(g) && !retainedGlyphs.has(i)),
      ownedRecords = data.records.filter(
        (r) => retained.includes(r) || r.glyphIndices.some((i) => owns(data.glyphs[i]))
      )
    if (
      ownedGlyphs.length < 4 ||
      ownedRecords.length < 2 ||
      data.records.some(
        (r) =>
          r.glyphIndices.some((i) => owns(data.glyphs[i])) &&
          r.glyphIndices.some((i) => !owns(data.glyphs[i]))
      ) ||
      ownedRecords.some(
        (r) =>
          !r.glyphIndices.length ||
          union(r.glyphIndices.map((i) => data.glyphs[i].advance)).some(
            (v, i) => Math.abs(v - r.rect[i]) > 0.02
          )
      )
    )
      return
    const finite = (a, k) =>
        (Array.isArray(a) || ArrayBuffer.isView(a)) &&
        a.length === k &&
        Array.from(a).every(Number.isFinite),
      box = (r, m) =>
        union(
          [
            [r[0], r[1]],
            [r[0], r[3]],
            [r[2], r[1]],
            [r[2], r[3]]
          ].map((p) => {
            Util.applyTransform(p, m)
            return [p[0], p[1], p[0], p[1]]
          })
        ),
      inv = {
        o: context.operators,
        v: context.viewport,
        finite,
        valid: pictureValid,
        box,
        strokeMargins: new Map(data.paths.map((p) => [p.operationIndex, p.strokeMargin]))
      },
      owned = [],
      foreignPaths = []
    for (const p of data.paths) {
      const a = inv.o.argsArray[p.operationIndex],
        s = p.state
      if (!pictureValid(s.clip) || s.fillAlpha !== 1 || s.strokeAlpha !== 1) return
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(inv, p.operationIndex, s),
        points = []
      if (!paint || !Array.isArray(a[1])) return
      for (const path of a[1]) {
        if (path === null) continue
        let i = 0
        while (i < path.length) {
          const op = path[i++],
            n = op === 0 || op === 1 ? 1 : op === 2 ? 3 : op === 4 ? 0 : -1
          if (n < 0) return
          for (let k = 0; k < n; k++) {
            const x = path[i++],
              y = path[i++]
            if (!Number.isFinite(x) || !Number.isFinite(y)) return
            points.push([x, y, x, y])
          }
        }
      }
      if (!points.length) return
      const stroke = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a[0]),
        pad = stroke ? (s.lineWidth * Math.max(Math.SQRT2, p.strokeMargin)) / 2 : 0,
        hull = box(
          pictureExpand(union(points), pad),
          Util.transform(context.viewport.transform, s.transform)
        )
      const destination = owns(p) ? owned : foreignPaths
      destination.push({ rect: union([paint.rect, hull]), floor: paint.floor })
    }
    owned.push(
      ...ownedGlyphs.flatMap((g) => [
        { rect: g.rect, floor: 0 },
        { rect: g.advance, floor: 0 }
      ]),
      ...ownedRecords.map((r) => ({ rect: r.rect, floor: 0 }))
    )
    // Three independently closed hatch panels only enlarge an existing
    // preview. Original pixels (including external panel descriptions) remain
    // in place; only the newly exposed bands require new ownership.
    const expansion = data.patterns.length === 3
    const exterior = (r) => {
      if (!expansion) return [r]
      const [x0, y0, x1, y1] = originalCrop
      return [
        [r[0], r[1], Math.min(r[2], x0), r[3]],
        [Math.max(r[0], x1), r[1], r[2], r[3]],
        [Math.max(r[0], x0), r[1], Math.min(r[2], x1), Math.min(r[3], y0)],
        [Math.max(r[0], x0), Math.max(r[1], y1), Math.min(r[2], x1), r[3]]
      ].filter(pictureValid)
    }
    const physical = union(owned.map((p) => p.rect)),
      minScale = 1.5,
      bounds = owned.map((p) => pictureExpand(p.rect, (p.floor + 1) / minScale)),
      provedRect = pictureExpand(union(bounds), 2 / minScale),
      foreignRecords = data.records.filter((r) => r.raw.str.trim() && !ownedRecords.includes(r)),
      foreign = foreignGlyphs
        .flatMap((g) => [g.rect, g.advance])
        .concat(foreignRecords.map((r) => r.rect)),
      foreignBounds = foreign
        .map((r) => pictureExpand(r, 1 / minScale))
        .concat(foreignPaths.map((p) => pictureExpand(p.rect, (p.floor + 1) / minScale)))
        .flatMap(exterior),
      outside = foreignGlyphs.filter((g) => pictureHit(originalCrop, g.rect)),
      // A label completion with no removed foreign prose is expansion only.
      // Keep every old pixel and prove all three saved panels independently.
      rect = expansion ? union([provedRect, originalCrop]) : provedRect
    if (
      !pictureInside([0, 0, page.width, page.height], rect) ||
      (!outside.length && data.patterns.length !== 3) ||
      foreignBounds.some((r) => pictureHit(rect, expansion ? r : pictureExpand(r, 2 / minScale))) ||
      pictureHit(rect, figure.caption.rect) ||
      rect.every((v, i) => Math.abs(v - originalCrop[i]) < 1e-6)
    )
      return
    // Save membership alone cannot delete a title/legend printed outside it.
    // Only the complete preceding page-column ordinary sentence may leave the
    // old crop; bind all of its original Sources, outlines and advance cells.
    if (!expansion) {
      const band = union(outside.map((g) => g.rect)),
        body = foreignRecords.filter((r) =>
          r.glyphIndices.some((i) => {
            const g = data.glyphs[i]
            return g.rect[1] < band[3] && g.rect[3] > band[1]
          })
        ),
        first = body[0],
        last = body.at(-1),
        em = first?.raw.height,
        literal = body.map((r) => r.raw.str).join(' '),
        bodyGlyphs = new Set(body.flatMap((r) => r.glyphIndices)),
        bodyFont = first?.raw.fontName,
        witnesses = foreignRecords.filter(
          (r) =>
            r.index < first?.index &&
            r.raw.fontName === bodyFont &&
            r.raw.height === em &&
            Math.abs(r.rect[0] - first.rect[0]) <= em * 2 &&
            r.rect[2] - r.rect[0] >= page.width * 0.4 &&
            /\p{L}{3,}\s+\p{L}{3,}/u.test(r.raw.str)
        )
      if (
        !first ||
        !last ||
        !(em > 0) ||
        witnesses.length < 2 ||
        first.rect[0] >= physical[0] - em * 2 ||
        !/^\p{Lu}\p{Ll}*\s+\p{L}/u.test(literal) ||
        !/\p{L}{3,}/u.test(literal) ||
        /^(?:Figure|Fig\.?|Table|Tab\.?|Algorithm)\s/iu.test(literal) ||
        !/[.!?]$/u.test(literal) ||
        foreignRecords.filter(
          (r) => r.index >= first.index && r.index <= last.index && r.raw.str.trim()
        ).length !== body.filter((r) => r.raw.str.trim()).length ||
        body.some(
          (r) =>
            r.glyphIndices.some((i) => data.glyphs[i].operationIndex >= scope.begin) ||
            r.raw.transform[1] !== 0 ||
            r.raw.transform[2] !== 0 ||
            !(r.raw.transform[0] > 0) ||
            !(r.raw.transform[3] > 0)
        ) ||
        outside.some((g) => !bodyGlyphs.has(data.glyphs.indexOf(g))) ||
        union(
          body.flatMap((r) => [
            r.rect,
            ...r.glyphIndices.flatMap((i) => [data.glyphs[i].rect, data.glyphs[i].advance])
          ])
        )[3] >= physical[1]
      )
        return
    }
    const cap = data.records.filter(
      (r) => r.raw.str.trim() && pictureInside(figure.caption.rect, r.rect)
    )
    if (
      !cap.length ||
      pictureCompact(cap.map((r) => r.raw.str).join(' ')) !==
        pictureCompact(figure.caption.lines.join(' ')) ||
      !/^(?:Figure|Fig\.?)\s+[A-Z]?[1-9]\d*[.:]/u.test(cap[0].raw.str) ||
      cap.some(
        (r) =>
          !r.glyphIndices.length ||
          r.glyphIndices.some((i) => data.glyphs[i].operationIndex <= scope.end)
      ) ||
      data.records.filter(
        (r) => r.index >= cap[0].index && r.index <= cap.at(-1).index && r.raw.str.trim()
      ).length !== cap.length
    )
      return
    const plan = { rect, kind: 'complete-native-uncolored-saved-pixel' },
      form = {
        ownedRects: bounds,
        foreignPaints: foreignBounds.map((rect) => ({ rect, floor: 0 }))
      },
      outputCurrent = retainNativeRecoveryInputs([plan, form])
    if (
      !outputCurrent ||
      !current() ||
      nativeSavedUncoloredPixelEvidenceData(handle, page, tokens, context) !== data
    )
      return
    savedUncoloredPixelPlans.set(plan, {
      page,
      tokens,
      context,
      handle,
      data,
      current,
      outputCurrent,
      form,
      minScale,
      rect
    })
    return plan
  } catch {
    return
  }
}

// Each leading panel marker is an exact whole record of the complete page
// bridge. It immediately precedes one closed top-level Form in paint order;
// unrelated footer Forms remain foreign even when they follow the caption.
function pictureLeadingType3Forms(data, items, figure, pageCaps, tokens) {
  const records = data.leadingMarkerRecords
  if (!records || records.some((r) => !pictureValid(r.fontRect))) return
  const caption = records.filter((r) => pictureInside(figure.caption.rect, r.rect))
  if (!caption.length) return
  if (
    pictureCompact(caption.map((r) => r.text).join('')) !==
    pictureCompact(figure.caption.lines.join(' '))
  ) {
    // Caption grouping displays a tightly attached raised digit as a superscript.
    // Reproduce that display from the complete native records, preserving every
    // literal source and its order; Unicode folding would also accept a baseline digit.
    if (
      caption.some(
        (r) =>
          tokens.filter(
            (t) =>
              t.horizontal &&
              t.text === r.text &&
              t.sourceItem?.pageNumber === figure.caption.page &&
              t.sourceItem.index === r.index &&
              t.sourceItem.text === r.text &&
              t.height === r.height &&
              t.rect.every((n, i) => Math.abs(n - r.rect[i]) <= 1e-6)
          ).length !== 1
      )
    )
      return
    const fragments = caption.map((r) => ({
        text: r.text,
        x: r.rect[0],
        y: r.rect[1],
        width: r.rect[2] - r.rect[0],
        height: r.rect[3] - r.rect[1],
        fontSize: r.height
      })),
      origins = new Map(),
      rows = groupPageLines({ lines: fragments }, [], origins),
      consumed = rows.flatMap((r) => origins.get(r) ?? [])
    if (
      consumed.length !== fragments.length ||
      consumed.some((r, i) => r !== fragments[i]) ||
      pictureCompact(rows.map((r) => r.text).join(' ')) !==
        pictureCompact(figure.caption.lines.join(' '))
    )
      return
  }
  const byGlyph = new Map(items.filter((p) => p.kind === 'glyph').map((p) => [p.glyphOrdinal, p])),
    capPaint = caption.flatMap((r) => r.glyphOrdinals.map((i) => byGlyph.get(i)))
  if (capPaint.some((p) => !p)) return
  const capStart = Math.min(...capPaint.map((p) => p.operationIndex)),
    forms = data.scopes.filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        s.end < capStart &&
        !data.scopes.some(
          (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
        )
    )
  if (forms.length !== 1 && forms.length !== 2) return
  if (items.some((p) => p.operationIndex > forms.at(-1).end && p.operationIndex < capStart)) return
  const own = [],
    bounds = []
  if (forms.length === 1) {
    // The same whole-page Type3 witness can close one complete plate. Its
    // outer labels must belong to that Form, not merely lie near its images.
    const pieces = pictureScopePieces(forms[0], items)
    if (
      pieces.filter((p) => p.kind !== 'glyph').length < 3 ||
      !pieces.some((p) => p.kind === 'glyph')
    )
      return
    own.push(...pieces)
  } else {
    const marks = ['a', 'b'].map((text) => records.filter((r) => r.text === text))
    if (marks.some((r) => r.length !== 1)) return
    const [a, b] = marks.map((r) => r[0])
    if (a.fontName !== b.fontName || a.height !== b.height || !(a.height > 0)) return
    for (const [i, r] of [a, b].entries()) {
      const form = forms[i],
        mark = r.glyphOrdinals.map((id) => byGlyph.get(id))
      if (!mark.length || mark.some((p) => !p) || mark.map((p) => p.text).join('') !== r.text)
        return
      const start = Math.min(...mark.map((p) => p.operationIndex)),
        end = Math.max(...mark.map((p) => p.operationIndex))
      if (
        end >= form.begin ||
        (i && start <= forms[i - 1].end) ||
        items.some(
          (p) => p.operationIndex >= start && p.operationIndex < form.begin && !mark.includes(p)
        )
      )
        return
      const pieces = pictureScopePieces(form, items)
      if (!pieces.some((p) => p.kind !== 'glyph') || !pieces.some((p) => p.kind === 'glyph')) return
      const bound = union(pieces.map((p) => p.bound)),
        em = r.height
      if (
        r.rect[0] > bound[0] + em ||
        bound[0] - r.rect[0] > 3 * em ||
        r.rect[1] > bound[1] ||
        bound[1] - r.rect[3] > 3 * em
      )
        return
      own.push(...mark, ...pieces)
      bounds.push(bound)
    }
    if (
      bounds[0][2] >= bounds[1][0] ||
      Math.min(bounds[0][3], bounds[1][3]) - Math.max(bounds[0][1], bounds[1][1]) <
        0.75 * Math.min(bounds[0][3] - bounds[0][1], bounds[1][3] - bounds[1][1])
    )
      return
  }
  const rect = pictureExpand(union(own.map((p) => p.bound)), 2 / 1.5),
    ownedGlyphs = new Set(own.filter((p) => p.kind === 'glyph').map((p) => p.glyphOrdinal))
  // A whole source cannot straddle a panel boundary. Foreign font envelopes
  // remain an exclusion domain in addition to actual foreign paint.
  if (
    records.some((r) => {
      const count = r.glyphOrdinals.filter((i) => ownedGlyphs.has(i)).length
      return count
        ? count !== r.glyphOrdinals.length ||
            tokens.filter((t) => t.sourceItem?.index === r.index && t.text === r.text).length !== 1
        : pictureHit(rect, pictureExpand(r.fontRect, 2 / 1.5))
    }) ||
    pageCaps.some((c) => c !== figure.caption && pictureHit(rect, c.rect))
  )
    return
  return { own, kind: 'complete-native-leading-type3-forms' }
}

export function nativeCertifiedFigurePixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  originalCropRect = figure.rect,
  live
) {
  try {
    const normalPair = nativeNormalRasterPairPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (normalPair) return normalPair
    const compoundPair = nativeCompoundCaptionRasterPairPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (compoundPair) return compoundPair
    const foreignCaptionPair = nativeForeignCaptionRasterPairPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (foreignCaptionPair) return foreignCaptionPair
    const fourMarkerPair = nativeFourMarkerRasterPairPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (fourMarkerPair) return fourMarkerPair
    const uncolored = savedUncoloredPixelCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (uncolored) return uncolored
    const occupied = occupiedClippedFormCrop(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      originalCropRect
    )
    if (occupied) return occupied
    const finitePattern = finiteColoredPatternPlan(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers
    )
    if (finitePattern) return finitePattern
    const own = nativeRecoveryOwnValues(context),
      current =
        own && retainNativeRecoveryInputs([figure, captions, tables, peers, originalCropRect])
    if (
      !current ||
      !pictureValid(figure?.rect) ||
      !pictureValid(originalCropRect) ||
      !pictureValid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      ![captions, tables, peers].every(Array.isArray) ||
      !captions.includes(figure.caption) ||
      figure.parts ||
      figure.cropRects
    )
      return
    const ordinaryHandle = createNativeFigurePaintCertificate(page, tokens, context),
      handle =
        ordinaryHandle ?? createNativeLeadingType3PixelCertificate(page, tokens, context, live),
      data = nativeFigurePaintCertificateData(handle, page, tokens, context)
    if (!data) return
    const minScale = 1.5,
      items = data.pieces.flatMap((p, serial) => {
        const bound = pictureBounds(p, minScale)
        return bound ? [{ ...p, bound, serial }] : []
      }),
      pageCaps = captions.filter((c) => c.page === page.pageNumber)
    const stacked = figure.sourceItems?.length
      ? pictureStackedSourceForms(data, items, figure, pageCaps, page, tokens, context)
      : undefined
    if (figure.sourceItems?.length && !stacked) return
    const picked =
      (data.leadingMarkerRecords
        ? pictureLeadingType3Forms(data, items, figure, pageCaps, tokens)
        : undefined) ??
      (!data.leadingMarkerRecords
        ? (stacked ??
          pictureOpeningParagraphForm(data, items, figure, pageCaps, page, tokens, context) ??
          picturePairedSavedDiagrams(data, items, figure, pageCaps, page, tokens, context) ??
          pictureKeyedFormGrid(data, items, figure, pageCaps, page, tokens, context) ??
          pictureMultipart(data, items, figure, pageCaps) ??
          pictureFormWithBoxedPanel(data, items, figure, pageCaps, page, tokens, context) ??
          pictureCaptionedFormGrid(data, items, figure, pageCaps) ??
          pictureCaptionedRasterRows(
            items,
            figure,
            pageCaps,
            page,
            tokens,
            context,
            originalCropRect
          ) ??
          pictureRasterRowKeys(data, items, figure, tokens, context) ??
          picturePairedRasterSave(data, items, figure) ??
          pictureRepeatedPaintHeader(data, items, figure, page, context) ??
          pictureSavedScope(data, items, figure) ??
          pictureAboveCaptionNotes(data, items, figure, pageCaps, page, tokens, context) ??
          pictureRasterPanelsWithNotes(data, items, figure, pageCaps, page, tokens, context) ??
          pictureAboveHeadingTwinScope(data, items, figure, tokens, context) ??
          pictureRepeatedHeader(items, page, figure, context, tokens))
        : undefined)
    if (!picked) return
    if (picked.kind === 'complete-native-saved-picture') {
      const excluded = pictureExteriorNumberedBody(
        data,
        items,
        picked,
        page,
        tokens,
        context,
        originalCropRect
      )
      const leadingBody =
        excluded ??
        pictureExteriorLeadingBody(
          data,
          items,
          picked,
          figure,
          page,
          tokens,
          context,
          originalCropRect
        )
      const completeCaption =
        leadingBody ??
        pictureExteriorSectionBody(
          data,
          items,
          picked,
          figure,
          page,
          tokens,
          context,
          originalCropRect
        ) ??
        pictureExteriorCompleteCaption(items, picked, figure, page, tokens, context)
      if (completeCaption) picked.excluded = completeCaption
      const proofTail =
        pictureExteriorWrappedProof(
          data,
          items,
          picked,
          figure,
          page,
          tokens,
          context,
          originalCropRect
        ) ??
        pictureExteriorProofTail(
          data,
          items,
          picked,
          figure,
          page,
          tokens,
          context,
          originalCropRect
        )
      if (proofTail) {
        picked.excluded = [...new Set([...(picked.excluded ?? []), ...proofTail])]
        picked.closedProofTail = true
      }
    }
    const owned = [...new Set(picked.own)],
      ids = new Set(owned.map((p) => p.serial)),
      foreign = items.filter((p) => !ids.has(p.serial)),
      rect = pictureExpand(union(owned.map((p) => p.bound)), 2 / minScale)
    const captionBlank = pictureCaptionAdvanceBlank(figure, picked, rect, page, tokens, context)
    // A non-member of one drawing scope can still be another panel in the
    // established figure. Only an independently repeated native header or a
    // complete separately printed Notes paragraph may leave the old crop.
    // Every other original paint remains protected, including panel descriptions.
    const repeatedHeader = pictureRepeatedHeader(items, page, figure, context, tokens)
    if (
      foreign.some(
        (p) =>
          !repeatedHeader?.excluded.includes(p) &&
          !picked.excluded?.includes(p) &&
          pictureBounds(p, Infinity) &&
          pictureHit(originalCropRect, pictureBounds(p, Infinity))
      )
    )
      return
    // A different padding rectangle alone does not establish a missing part.
    // Require complete original paint outside the old crop, or actual foreign
    // paint inside it, before replacing an already published picture boundary.
    const completeRasterRowMissing =
      picked.kind === 'complete-native-captioned-raster-rows' && picked.missingImagePaint === true
    if (
      !completeRasterRowMissing &&
      !owned.some(
        (p) =>
          p.kind !== 'image' &&
          !p.opaqueWhiteFill &&
          (p.kind !== 'path' ||
            p.visiblePaintPoints.some(
              (point) =>
                point[0] < originalCropRect[0] ||
                point[0] > originalCropRect[2] ||
                point[1] < originalCropRect[1] ||
                point[1] > originalCropRect[3]
            )) &&
          pictureValid(p.rect) &&
          pictureBounds(p, Infinity) &&
          (picked.kind !== 'complete-native-subcaption-family' ||
            p.kind !== 'glyph' ||
            !pictureHit(originalCropRect, pictureBounds(p, Infinity))) &&
          !pictureInside(originalCropRect, pictureBounds(p, Infinity))
      ) &&
      !foreign.some(
        (p) =>
          (p.kind !== 'path' ||
            p.visiblePaintPoints.some(
              (point) =>
                point[0] > originalCropRect[0] &&
                point[0] < originalCropRect[2] &&
                point[1] > originalCropRect[1] &&
                point[1] < originalCropRect[3]
            )) &&
          pictureBounds(p, Infinity) &&
          pictureHit(originalCropRect, pictureBounds(p, Infinity))
      )
    )
      return
    // A source font box can start above its first painted caption glyph. Keep
    // the exact source barrier, and let the actual PNG's owner guard decide
    // whether this tighter final edge still retains every physical paint.
    if (picked.kind === 'complete-native-raster-row-with-repeated-header') {
      rect[1] = Math.max(rect[1], ...picked.excluded.map((p) => p.bound[3] + 2 / minScale))
      if (owned.some((p) => !pictureInside(rect, p.bound))) return
    }
    if (
      !captionBlank &&
      !['complete-native-form-after-caption', 'complete-native-captioned-raster-notes'].includes(
        picked.kind
      )
    )
      rect[3] = Math.min(rect[3], figure.caption.rect[1])
    if (
      !pictureInside([0, 0, page.width, page.height], rect) ||
      !pictureHit(rect, figure.rect) ||
      captions.some(
        (c) =>
          c.page === page.pageNumber &&
          (!pictureValid(c.rect) ||
            (pictureHit(c.rect, rect) && !(captionBlank && c === figure.caption)))
      ) ||
      tables.some((t) => !pictureValid(t) || pictureHit(t, rect)) ||
      peers.some(
        (f) => f !== figure && f.rect && (!pictureValid(f.rect) || pictureHit(f.rect, rect))
      ) ||
      foreign.some((p) =>
        pictureHit(rect, pictureExpand(p.bound, 2 / (captionBlank?.scaleLower ?? minScale)))
      ) ||
      rect.every((n, i) => Math.abs(n - figure.rect[i]) < 1e-6)
    )
      return
    if (
      picked.sourceItems?.some((source) => {
        const raw = context.content.items[source.index],
          font =
            raw &&
            nativeFigureLabelBounds(raw, context.content.styles[raw.fontName], context.viewport)
        return raw?.sourceItem !== source || !pictureValid(font) || !pictureInside(rect, font)
      })
    )
      return
    const operations = new Set(
      owned
        .filter((p) => ['path', 'image', 'solid-mask'].includes(p.kind))
        .map((p) => p.operationIndex)
    )
    const plan = {
        rect,
        kind: picked.kind,
        ...(picked.sourceItems ? { sourceItems: picked.sourceItems } : {}),
        graphicsCount:
          page.graphicsBounds.filter((g) => operations.has(g.operationIndex)).length +
          owned.filter((p) => p.kind === 'solid-mask').length
      },
      form = {
        ownedRects: owned.map((p) => p.bound),
        foreignPaints: foreign.map((p) => ({ rect: p.bound, floor: 0 }))
      },
      outputCurrent = retainNativeRecoveryInputs([plan, form])
    if (!outputCurrent || !current()) return
    completePicturePaintPlans.set(plan, {
      page,
      tokens,
      context,
      handle,
      current,
      outputCurrent,
      form,
      keyedForm: picked.kind === 'complete-native-keyed-form-grid',
      closedProofTail: picked.closedProofTail === true,
      minScale: captionBlank?.scaleLower ?? minScale,
      ...(captionBlank ? { initialRaster: captionBlank } : {}),
      rect: plan.rect
    })
    return plan
  } catch {
    return
  }
}
export function nativeCertifiedFigurePixelPngSafe(plan, png, rect, page) {
  try {
    if (nativeNormalRasterPairPixelCurrent(plan, page))
      return nativeNormalRasterPairPixelPngSafe(plan, png, rect, page)
    const uncolored = savedUncoloredPixelPlans.get(plan)
    if (uncolored) {
      const p = uncolored,
        raster = getPdfCropRasterProtectionFromPng(png, rect, page)
      return !!(
        p.page === page &&
        p.rect === rect &&
        p.current() &&
        p.outputCurrent() &&
        raster &&
        raster.scaleLower >= p.minScale &&
        nativeSavedUncoloredPixelEvidenceData(p.handle, p.page, p.tokens, p.context) === p.data &&
        nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: p.form })
      )
    }
    const occupied = occupiedClippedFormPlans.get(plan)
    if (occupied) {
      const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
      return !!(
        occupied.page === page &&
        occupied.rect === rect &&
        occupied.current() &&
        occupied.outputCurrent() &&
        raster &&
        raster.scaleLower >= occupied.minScale &&
        nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: occupied.form })
      )
    }
    const p = completePicturePaintPlans.get(plan),
      r = p && getPdfCropRasterProtectionFromPng(png, rect, page)
    return !!(
      p &&
      p.page === page &&
      p.rect === rect &&
      p.current() &&
      p.outputCurrent() &&
      nativeFigurePaintCertificateData(p.handle, p.page, p.tokens, p.context) &&
      r &&
      (!p.next ||
        nativeFigurePaintCertificateData(
          p.next.handle,
          p.next.page,
          p.next.tokens,
          p.next.context
        )) &&
      r.scaleLower >= p.minScale &&
      (!p.initialRaster || matchesInitialPdfCropPng(png, p.initialRaster)) &&
      nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: p.form })
    )
  } catch {
    return false
  }
}

// An explicit continued-picture page keeps its own pixels and page provenance.
// Both adjacent original pages, native numbered caption and consecutive panel
// keys must close; neither text proximity nor the next page's model box suffices.
export function nativeExplicitContinuationFigurePixelCrop(
  page,
  nextCaption,
  captions,
  tables,
  tokens,
  context,
  nextPage,
  nextTokens,
  nextContext
) {
  try {
    const ctx = nativeRecoveryOwnValues(context),
      nctx = nativeRecoveryOwnValues(nextContext),
      retained =
        ctx &&
        retainNativeRecoveryInputs(
          [nextCaption, captions, tables, page, tokens, context],
          ctx.viewport
        ),
      retainedNext =
        nctx && retainNativeRecoveryInputs([nextPage, nextTokens, nextContext], nctx.viewport),
      current = retained && retainedNext && (() => retained() && retainedNext())
    // Each actual PDF.js viewport has its own prototype. Keep both original
    // contexts under their own viewport exception; neither is cloned or sliced.
    if (!current) return
    if (
      nextPage.pageNumber !== page.pageNumber + 1 ||
      context.sourceSha256 !== nextContext.sourceSha256 ||
      page.width !== nextPage.width ||
      page.height !== nextPage.height ||
      nextCaption?.page !== nextPage.pageNumber ||
      !captions.includes(nextCaption) ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]/iu.test(nextCaption.lines?.[0] ?? '') ||
      captions.some((c) => c.page === page.pageNumber) ||
      captions.filter((c) => c.page === nextPage.pageNumber).length !== 1 ||
      tables.length
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, context, true),
      q = nativePageTextPacketInventory(nextPage, nextTokens, nextContext, true)
    if (!p || !q) return
    const marker = p.records.filter((r) =>
      /^Figure continued on the following page\.$/u.test(r.r.str)
    )
    if (marker.length !== 1 || !pictureValid(marker[0].rect)) return
    const capText = pictureCompact(nextCaption.lines.join(' ')),
      pairs = [...capText.matchAll(/\(([a-l]),([a-l])\)/gu)].map((m) => m[1] + m[2])
    const h = createNativeFigurePaintCertificate(page, tokens, context),
      nh = createNativeFigurePaintCertificate(nextPage, nextTokens, nextContext),
      d = nativeFigurePaintCertificateData(h, page, tokens, context),
      nd = nativeFigurePaintCertificateData(nh, nextPage, nextTokens, nextContext)
    if (!d || !nd) return
    const panelCount = d.pieces.filter((p) => p.kind === 'image').length,
      nextPanelCount = nd.pieces.filter((p) => p.kind === 'image').length,
      totalPanels = panelCount + nextPanelCount
    if (
      panelCount < 2 ||
      nextPanelCount < 2 ||
      totalPanels > 12 ||
      pairs.join('') !==
        Array.from({ length: totalPanels }, (_, i) => String.fromCharCode(97 + i)).join('')
    )
      return
    const minScale = 1.5,
      toItems = (data) =>
        data.pieces.flatMap((piece, serial) => {
          const bound = pictureBounds(piece, minScale)
          return bound ? [{ ...piece, bound, serial }] : []
        }),
      items = toItems(d),
      following = toItems(nd),
      ownCaption = { page: page.pageNumber, lines: [marker[0].r.str], rect: marker[0].rect },
      shape = {
        rect: union(items.filter((p) => p.kind === 'image').map((p) => p.bound)),
        caption: ownCaption
      },
      nextShape = {
        rect: union(following.filter((p) => p.kind === 'image').map((p) => p.bound)),
        caption: nextCaption
      },
      picked = pictureMultipart(d, items, shape, [ownCaption]),
      nextPicked = pictureMultipart(nd, following, nextShape, [nextCaption], panelCount)
    if (!picked || !nextPicked) return
    const ids = new Set(picked.own.map((p) => p.serial)),
      foreign = items.filter((p) => !ids.has(p.serial)),
      rect = pictureExpand(union(picked.own.map((p) => p.bound)), 2 / minScale)
    if (
      !pictureInside([0, 0, page.width, page.height], rect) ||
      pictureHit(rect, ownCaption.rect) ||
      foreign.some((p) => pictureHit(rect, pictureExpand(p.bound, 2 / minScale)))
    )
      return
    const plan = {
        rect,
        kind: 'native-explicit-continued-picture',
        caption: nextCaption,
        graphicsCount: panelCount
      },
      form = {
        ownedRects: picked.own.map((p) => p.bound),
        foreignPaints: foreign.map((p) => ({ rect: p.bound, floor: 0 }))
      },
      outputCurrent = retainNativeRecoveryInputs([plan, form])
    if (!outputCurrent || !current()) return
    completePicturePaintPlans.set(plan, {
      page,
      tokens,
      context,
      handle: h,
      current,
      outputCurrent,
      form,
      minScale,
      rect: plan.rect,
      next: { handle: nh, page: nextPage, tokens: nextTokens, context: nextContext }
    })
    return plan
  } catch {
    return
  }
}

// Complete two independent native save-scoped cell panels whose headings are
// above their own grids. This is deliberately separate from below-body panel
// captions. The opaque paint handle supplies no Source/cell/navigation authority.
function pictureAboveHeadingTwinScope(data, items, figure, tokens, context) {
  const heads = tokens.filter((t) => /^\([ab]\)\s+\S/u.test(t.text)),
    roots = data.scopes.filter((s) => s.op === OPS.save && s.parent === undefined)
  if (
    heads.length !== 2 ||
    !heads[0].text.startsWith('(a) ') ||
    !heads[1].text.startsWith('(b) ') ||
    heads[0].rect[2] >= heads[1].rect[0]
  )
    return
  const selected = [],
    same = (a, b) => Math.abs(a - b) <= 0.01
  // Check whole original label Sources locally, without constructing a page or
  // cell Source packet. The existing opaque handle retains the complete page.
  const wholeLabel = (packet) => {
    const used = new Set()
    for (const [index, raw] of context.content.items.entries()) {
      if (!raw.str?.trim()) continue
      const r = tableTextToken(raw, context.viewport, 0).rect,
        glyphs = packet.pieces.filter(
          (p) =>
            p.fontName === raw.fontName &&
            p.advance[0] >= r[0] - 0.02 &&
            p.advance[2] <= r[2] + 0.02 &&
            Math.abs(p.advance[1] - r[1]) <= 0.02 &&
            Math.abs(p.advance[3] - r[3]) <= 0.02
        )
      if (!glyphs.length) continue
      const source = raw.sourceItem,
        matches = tokens.filter((t) => t.sourceItem?.index === index)
      if (
        !source ||
        source.pageNumber !== data.pageNumber ||
        source.index !== index ||
        source.text !== raw.str ||
        matches.length !== 1 ||
        matches[0].text !== raw.str ||
        matches[0].sourceItem.pageNumber !== source.pageNumber ||
        matches[0].sourceItem.text !== source.text ||
        context.content.items.filter((r) => r.sourceItem?.index === index).length !== 1 ||
        pictureCompact(glyphs.map((p) => p.text).join('')) !== pictureCompact(raw.str) ||
        union(glyphs.map((p) => p.advance)).some((n, i) => Math.abs(n - r[i]) > 0.02) ||
        glyphs.some(
          (p) =>
            used.has(p) ||
            p.fillAlpha !== 1 ||
            (p.paintClip && !pictureInside(p.paintClip, p.fullInk))
        )
      )
        return false
      glyphs.forEach((p) => used.add(p))
    }
    return used.size === packet.pieces.length
  }

  for (const token of heads) {
    const source = token.sourceItem,
      raw = context.content.items[source?.index],
      rect = raw && tableTextToken(raw, context.viewport, 0).rect
    if (
      !raw ||
      raw.sourceItem?.pageNumber !== source.pageNumber ||
      raw.sourceItem?.index !== source.index ||
      raw.sourceItem?.text !== source.text ||
      source.pageNumber !== data.pageNumber ||
      source.text !== token.text ||
      raw.str !== token.text ||
      !pictureValid(rect) ||
      !raw.transform.every(Number.isFinite) ||
      raw.transform[1] ||
      raw.transform[2] ||
      raw.transform[0] <= 0 ||
      raw.transform[3] <= 0 ||
      raw.height !== raw.transform[3] ||
      context.content.items.filter((r) => r.sourceItem?.index === source.index).length !== 1 ||
      tokens.filter((t) => t.sourceItem?.index === source.index).length !== 1 ||
      !context.glyphBounds?.some((f) => f.fontName === raw.fontName)
    )
      return
    const glyphs = items.filter(
        (p) =>
          p.kind === 'glyph' &&
          p.fontName === raw.fontName &&
          p.advance[0] >= rect[0] - 0.02 &&
          p.advance[2] <= rect[2] + 0.02 &&
          Math.abs(p.advance[1] - rect[1]) <= 0.02 &&
          Math.abs(p.advance[3] - rect[3]) <= 0.02
      ),
      owners = roots.filter(
        (s) =>
          glyphs.length &&
          glyphs.every((p) => p.operationIndex > s.begin && p.operationIndex < s.end)
      )
    if (
      owners.length !== 1 ||
      !glyphs.length ||
      pictureCompact(glyphs.map((p) => p.text).join('')) !== pictureCompact(raw.str) ||
      union(glyphs.map((p) => p.advance)).some((n, i) => Math.abs(n - rect[i]) > 0.02) ||
      glyphs.some(
        (p) => p.fillAlpha !== 1 || (p.paintClip && !pictureInside(p.paintClip, p.fullInk))
      )
    )
      return
    const scope = owners[0],
      own = pictureScopePieces(scope, items),
      paint = own.filter((p) => p.kind === 'path'),
      packets = picturePackets(own),
      headingPackets = new Set(glyphs.map((p) => p.packetBegin)),
      em = raw.height
    if (
      own.some((p) => !['glyph', 'path'].includes(p.kind)) ||
      paint.length < 6 ||
      packets.some((p) => !wholeLabel(p))
    )
      return
    // The original renderer's explicit rectangular stroke witnesses must form a
    // complete repeated grid. An AABB or a long prose packet is not a cell face.
    const faces = []
    for (const p of paint) {
      const points = p.visiblePaintPoints,
        xs = [...new Set(points.map((q) => q[0]))],
        ys = [...new Set(points.map((q) => q[1]))]
      if (xs.length !== 2 || ys.length !== 2 || new Set(points.map((q) => q.join(','))).size !== 4)
        continue
      const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      if (!pictureValid(r) || r[2] - r[0] < em || r[3] - r[1] < em) continue
      if (!faces.some((q) => q.every((n, i) => same(n, r[i])))) faces.push(r)
    }
    const grids = []
    for (const face of faces) {
      const family = faces.filter(
          (r) => same(r[2] - r[0], face[2] - face[0]) && same(r[3] - r[1], face[3] - face[1])
        ),
        rows = [],
        columns = []
      for (const r of family) {
        if (!rows.some((y) => same(y, r[1]))) rows.push(r[1])
        if (!columns.some((x) => same(x, r[0]))) columns.push(r[0])
      }
      rows.sort((a, b) => a - b)
      columns.sort((a, b) => a - b)
      if (
        rows.length < 2 ||
        rows.length > 12 ||
        columns.length < 2 ||
        columns.length > 12 ||
        family.length !== rows.length * columns.length ||
        rows.some((y, i) => i && !same(y - rows[i - 1], face[3] - face[1])) ||
        columns.some((x, i) => i && !same(x - columns[i - 1], face[2] - face[0])) ||
        rows.some((y) =>
          columns.some((x) => family.filter((r) => same(r[0], x) && same(r[1], y)).length !== 1)
        )
      )
        continue
      const bound = union(family)
      if (!grids.some((r) => r.bound.every((n, i) => same(n, bound[i]))))
        grids.push({ bound, family, rows, columns })
    }
    if (grids.length !== 1) return
    const gridProof = grids[0],
      grid = gridProof.bound,
      titleFont = nativeFigureLabelBounds(
        raw,
        context.content.styles[raw.fontName],
        context.viewport
      ),
      domain = pictureValid(titleFont) && union([rect, titleFont]),
      headingBand = [grid[0] - em, rect[1] - em / 4, grid[2] + em, rect[3] + em / 2],
      columnLabels = new Set(),
      rowLabels = new Set()
    if (
      !domain ||
      domain[3] >= grid[1] ||
      grid[1] - domain[3] > em * 4 ||
      domain[0] < grid[0] - em ||
      domain[2] > grid[2] + em ||
      !pictureHit(grid, figure.rect) ||
      paint.some((p) => !pictureInside(pictureExpand(grid, em), p.rect))
    )
      return
    for (const packet of packets) {
      const physical = union(packet.pieces.map((p) => p.rect))
      if (headingPackets.has(packet.begin)) {
        if (!pictureInside(headingBand, physical)) return
        continue
      }
      const cells = gridProof.family.filter((r) => pictureInside(r, physical)),
        columns = gridProof.columns.filter((x) =>
          pictureInside(
            [x, grid[1] - em * 2, x + gridProof.family[0][2] - gridProof.family[0][0], grid[1]],
            physical
          )
        ),
        rows = gridProof.rows.filter((y) =>
          pictureInside(
            [grid[0] - em * 4, y, grid[0], y + gridProof.family[0][3] - gridProof.family[0][1]],
            physical
          )
        )
      if (cells.length + columns.length + rows.length !== 1) return
      if (columns.length) {
        if (columnLabels.has(columns[0])) return
        columnLabels.add(columns[0])
      }
      if (rows.length) {
        if (rowLabels.has(rows[0])) return
        rowLabels.add(rows[0])
      }
    }
    // A lone short word in a broad edge strip is not a row/column heading.
    // Every admitted exterior lane is a complete, unique repeated family.
    if (
      (columnLabels.size && columnLabels.size !== gridProof.columns.length) ||
      (rowLabels.size && rowLabels.size !== gridProof.rows.length)
    )
      return
    selected.push({ scope, own, domain, grid, raw })
  }
  if (
    selected[0].scope === selected[1].scope ||
    selected[0].scope.end >= selected[1].scope.begin ||
    selected[0].raw.fontName !== selected[1].raw.fontName ||
    selected[0].raw.height !== selected[1].raw.height ||
    selected[0].grid[2] >= selected[1].grid[0] ||
    pictureHit(
      union(selected[0].own.map((p) => p.bound)),
      union(selected[1].own.map((p) => p.bound))
    )
  )
    return
  return {
    own: [
      ...selected.flatMap((s) => s.own),
      ...selected.map((s, i) => ({
        kind: 'font-domain',
        bound: s.domain,
        serial: -(i + 1)
      }))
    ],
    kind: 'complete-native-above-heading-twin-scope'
  }
}

// An above-body caption and a complete original Form do not make exterior
// text disposable. Only a separately closed native Notes paragraph may explain
// paint removed from the old crop. Its whole Sources are checked with the
// existing local printed-face API over the untouched page program and tokens;
// no Source, navigation or cell claim is returned by this pixel-only plan.
// Complete raster panels can print their descriptions and a whole Notes
// paragraph outside the images. Those native glyphs remain positive owners.
function pictureRasterPanelsWithNotes(data, items, figure, pageCaps, page, tokens, context) {
  if (pageCaps.length !== 1 || pageCaps[0] !== figure.caption) return
  const p = nativePageTextPacketInventory(page, tokens, context, true),
    images = items.filter((q) => q.kind === 'image')
  if (
    !p ||
    p.records.length > 4096 ||
    p.evidence.paths.size ||
    items.some((q) => !['glyph', 'image'].includes(q.kind)) ||
    images.length < 2 ||
    images.length > 12
  )
    return
  const cap = p.records.filter((r) => pictureInside(figure.caption.rect, r.rect)),
    after = p.records.filter((r) => r.index > (cap.at(-1)?.index ?? Infinity))
  if (
    !cap.length ||
    cap[0].index !== 0 ||
    compact(cap.map((r) => r.r.str).join('')) !== compact(figure.caption.lines.join(''))
  )
    return
  const heads = after.filter((r) => /^Notes?(?::\s|$)/u.test(r.r.str))
  if (heads.length !== 1) return
  const head = heads[0],
    em = head.r.height,
    before = after.filter((r) => r.index < head.index),
    labels = before.filter((r) => /^\([a-z]\)\s+\p{L}/u.test(r.r.str))
  if (
    !Number.isFinite(em) ||
    em <= 0 ||
    labels.length !== images.length ||
    labels.some((r, i) => r.r.str[1] !== String.fromCharCode(97 + i)) ||
    before[0] !== labels[0] ||
    !(head.r.str.includes(':') || after[after.indexOf(head) + 1]?.r.str.startsWith(':'))
  )
    return
  const xs = [...new Set(images.map((q) => q.rect[0]))].sort((a, b) => a - b),
    ys = [...new Set(images.map((q) => q.rect[1]))].sort((a, b) => a - b),
    w = images[0].rect[2] - images[0].rect[0],
    h = images[0].rect[3] - images[0].rect[1],
    tolerance = Math.max(w, h) * 1e-6
  if (
    xs.length * ys.length !== images.length ||
    xs.some((x, i) => i && (x - xs[i - 1] < w - tolerance || x - xs[i - 1] > w * 2)) ||
    ys.some((y, i) => i && (y - ys[i - 1] < h - tolerance || y - ys[i - 1] > h * 2))
  )
    return
  for (const [i, image] of images.entries()) {
    const records = before.filter(
        (r) => r.index >= labels[i].index && r.index < (labels[i + 1]?.index ?? head.index)
      ),
      label = labels[i].r,
      baseline = label.transform[5],
      size = label.height,
      bounds = records.length && union(records.map((r) => r.rect))
    if (
      !bounds ||
      Math.abs(image.rect[2] - image.rect[0] - w) > tolerance ||
      Math.abs(image.rect[3] - image.rect[1] - h) > tolerance ||
      image.rect[0] !== xs[i % xs.length] ||
      image.rect[1] !== ys[Math.floor(i / xs.length)] ||
      records.some(
        (r) =>
          r.part.some(
            ({ g }) => g.i >= image.operationIndex || (i && g.i <= images[i - 1].operationIndex)
          ) ||
          r.r.height < size / 2 ||
          r.r.height > size * 1.05 ||
          Math.abs(r.r.transform[5] - baseline) > size * 0.6
      ) ||
      bounds[0] < image.rect[0] - size / 2 ||
      bounds[2] > image.rect[2] + size / 2 ||
      bounds[3] > image.rect[1] ||
      image.rect[1] - bounds[3] > size * 2
    )
      return
  }
  const notes = [],
    rows = []
  let baseline = head.r.transform[5],
    next
  for (const r of after.slice(after.indexOf(head))) {
    const base = r.r.transform[5],
      delta = baseline - base
    if (
      r.r.height < em / 2 ||
      r.r.height > em * 1.05 ||
      (Math.abs(delta) > em * 0.6 && (delta < em || delta > em * 1.6))
    ) {
      next = r
      break
    }
    if (!rows.length || Math.abs(delta) > em * 0.6) {
      if (rows.length >= 8) return
      rows.push([])
      baseline = base
    }
    rows.at(-1).push(r)
    notes.push(r)
  }
  const firstImage = images[0],
    lastImage = images.at(-1),
    noteRows = rows.map((rs) => union(rs.map((r) => r.rect))),
    left = noteRows[0]?.[0],
    text = notes.map((r) => r.r.str).join(' '),
    last = notes.length && Math.max(...notes.flatMap((r) => r.part.map(({ g }) => g.i)))
  if (
    rows.length < 2 ||
    notes.length > 64 ||
    !next ||
    !/[.!?]$/u.test(notes.at(-1).r.str) ||
    (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 12 ||
    !/\b(?:figures?|panels?|lines?|plots?)\b/iu.test(text) ||
    noteRows.some((r) => Math.abs(r[0] - left) > em / 2) ||
    head.rect[1] < lastImage.rect[3] - em / 2 ||
    head.rect[1] > lastImage.rect[3] + em * 2 ||
    head.rect[0] < firstImage.rect[0] - em * 2 ||
    baseline - next.r.transform[5] < em * 2 ||
    next.r.height !== cap[0].r.height ||
    notes.some((r) => r.part.some(({ g }) => g.i <= lastImage.operationIndex)) ||
    context.operators.fnArray[last + 1] !== OPS.endText
  )
    return
  const selected = [...before, ...notes],
    owned = new Set(images),
    claimed = new Map()
  for (const r of [...cap, ...selected]) {
    const s = context.content.styles[r.r.fontName]
    if (
      !Number.isFinite(s?.ascent) ||
      !Number.isFinite(s?.descent) ||
      !(
        (s.ascent === 0 && s.descent === 0) ||
        (s.ascent > 0 && s.ascent <= 2 && s.descent <= 0 && s.descent >= -2)
      )
    )
      return
  }
  for (const r of selected)
    for (const { g } of r.part) {
      if (g.rendererSkipped) continue
      const matches = items.filter(
        (q) =>
          q.kind === 'glyph' &&
          q.operationIndex === g.i &&
          q.fontName === g.fontName &&
          q.text === g.text &&
          JSON.stringify(q.rect) === JSON.stringify(g.ink)
      )
      if (matches.length !== 1 || (claimed.has(matches[0]) && claimed.get(matches[0]) !== r.index))
        return
      claimed.set(matches[0], r.index)
      owned.add(matches[0])
    }
  return { own: [...owned], kind: 'complete-native-captioned-raster-notes' }
}

function pictureAboveCaptionNotes(data, items, figure, pageCaps, page, tokens, context) {
  if (pageCaps.length !== 1) return
  const forms = data.scopes.filter((s) => s.op === OPS.paintFormXObjectBegin)
  if (forms.length !== 1) return
  const form = forms[0],
    own = pictureScopePieces(form, items),
    body = own.length && union(own.map((p) => p.bound))
  if (
    !body ||
    own.filter((p) => p.kind !== 'glyph').length < 3 ||
    !own.some((p) => p.kind === 'glyph') ||
    figure.caption.rect[3] >= body[1] ||
    !pictureHit(body, figure.rect)
  )
    return
  const lines = []
  let line = []
  for (const [index, raw] of context.content.items.entries()) {
    if (typeof raw.str !== 'string' || typeof raw.hasEOL !== 'boolean') return
    if (raw.str.trim()) line.push({ raw, index })
    if (raw.hasEOL) {
      if (line.length) {
        line.closed = true
        lines.push(line)
      }
      line = []
    }
  }
  if (line.length) lines.push(line)
  // An unterminated original last line cannot close a paragraph.
  const starts = lines.flatMap((row, index) =>
    /^Notes?:(?:\s|$)/u.test(row[0].raw.str) ? [index] : []
  )
  if (starts.length !== 1) return
  const first = starts[0],
    head = lines[first][0].raw,
    em = head.height,
    rows = []
  if (!Number.isFinite(em) || em <= 0) return
  let end = first
  for (; end < lines.length && rows.length < 8; end++) {
    const row = lines[end],
      base = Math.max(...row.map((x) => x.raw.transform?.[5] ?? NaN)),
      left = row[0].raw.transform?.[4]
    if (
      row.closed !== true ||
      !Number.isFinite(base) ||
      !Number.isFinite(left) ||
      Math.abs(left - head.transform[4]) > em / 4 ||
      row.some(
        ({ raw }) =>
          !Array.isArray(raw.transform) ||
          raw.transform.length !== 6 ||
          !raw.transform.every(Number.isFinite) ||
          raw.transform[1] !== 0 ||
          raw.transform[2] !== 0 ||
          raw.transform[0] <= 0 ||
          raw.transform[3] !== raw.height ||
          raw.height < em / 2 ||
          raw.height > em ||
          raw.width <= 0 ||
          base - raw.transform[5] < 0 ||
          base - raw.transform[5] > em / 2
      )
    )
      break
    if (rows.length) {
      const leading = rows.at(-1).base - base
      if (leading < em || leading > em * 1.6) break
    }
    rows.push({ row, base })
  }
  const selected = rows.flatMap((r) => r.row),
    text = rows.map(({ row }) => row.map((x) => x.raw.str).join('')).join('\n'),
    next = lines[end]?.[0].raw
  if (
    rows.length < 3 ||
    selected.length > 64 ||
    !/[.!?]$/u.test(rows.at(-1).row.at(-1).raw.str) ||
    /\([a-z]\)/u.test(text) ||
    (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 12 ||
    (next && rows.at(-1).base - next.transform[5] < em * 2)
  )
    return
  const claims = [],
    domains = []
  for (const { raw, index } of selected) {
    const token = tokens.filter((t) => t.sourceItem?.index === index),
      source = raw.sourceItem,
      font = nativeFigureLabelBounds(raw, context.content.styles[raw.fontName], context.viewport),
      advance = tableTextToken(raw, context.viewport, 0).rect
    if (
      !source ||
      source.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== raw.str ||
      token.length !== 1 ||
      token[0].text !== raw.str ||
      token[0].sourceItem.pageNumber !== source.pageNumber ||
      token[0].sourceItem.text !== source.text ||
      !pictureValid(font) ||
      !pictureValid(advance)
    )
      return
    claims.push(source)
    domains.push(font, advance)
  }
  const scope = union(domains)
  if (scope[1] <= body[3] || !pictureInside([0, 0, page.width, page.height], scope)) return
  const packet = nativeClosedPrintedFaceInkPacket(page, tokens, context, claims, scope)
  if (!packet || packet.o !== context.operators) return
  const indices = new Set(selected.map((r) => r.index)),
    records = packet.records.filter((r) => indices.has(r.index))
  if (
    records.length !== selected.length ||
    records.some((r) => !r.advanceComplete || r.part.some((p) => p.g.excludedByClosedFaceClip))
  )
    return
  const glyphs = [...new Set(records.flatMap((r) => r.part.map((p) => p.g)))].filter(
      (g) => g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3]
    ),
    excluded = [],
    key = (i, font, text, advance, ink) => JSON.stringify([i, font, text, advance, ink])
  for (const g of glyphs) {
    const matches = items.filter(
      (p) =>
        p.kind === 'glyph' &&
        key(p.operationIndex, p.fontName, p.text, p.advance, p.fullInk) ===
          key(g.i, g.fontName, g.text, g.advance, g.ink)
    )
    if (matches.length !== 1 || matches[0].operationIndex <= form.end || matches[0].fillAlpha !== 1)
      return
    excluded.push(matches[0])
  }
  if (!excluded.length || new Set(excluded).size !== excluded.length) return
  return { own, excluded, kind: 'complete-native-form-after-caption' }
}

// Only the original private factory may establish this complete pixel family.
export function nativeKeyedFormGridPixelPlanCurrent(plan, page) {
  try {
    const p = completePicturePaintPlans.get(plan)
    return !!(
      p?.keyedForm &&
      p.page === page &&
      p.rect === plan.rect &&
      p.current() &&
      p.outputCurrent() &&
      nativeFigurePaintCertificateData(p.handle, p.page, p.tokens, p.context)
    )
  } catch {
    return false
  }
}

export function nativeProofTailFigurePixelPlanCurrent(plan, page) {
  try {
    const p = completePicturePaintPlans.get(plan)
    return !!(
      p?.closedProofTail &&
      p.page === page &&
      p.rect === plan.rect &&
      p.current() &&
      p.outputCurrent() &&
      nativeFigurePaintCertificateData(p.handle, p.page, p.tokens, p.context)
    )
  } catch {
    return false
  }
}

export { nativeNormalRasterPairPixelCurrent } from './literature-pdf-figure-native-plot-labels.mjs'
