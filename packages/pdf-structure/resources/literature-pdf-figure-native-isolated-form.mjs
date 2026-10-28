/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The entire ordinary isolated Form is owned. All native paint clips must be
// inside its exact rectangular group clip; this is independent of opacity and
// preserves ordinary transparent overlays. Default packet/group guards stay strict.
import { createHash } from 'node:crypto'
import { nativeCompleteFormCropPngSafe } from './literature-pdf-figure-native-complete-form.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativeClosedProgramInkPacket,
  nativeRecoveryFigureInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { nativeFigureRecoveryProfileData } from './literature-pdf-native-figure-recovery-profile.mjs'
const union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  positive = (g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3]
function deriveIsolatedForm(page, f, captions, tables, tokens, c, recoveryProfile) {
  if (
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !f.rect ||
    !f.caption?.rect ||
    f.sourceItems?.length ||
    f.parts ||
    f.cropRects ||
    f.headerRaster ||
    f.fallbackFigure
  )
    return
  const anchor = tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem
  const p = recoveryProfile
    ? nativeRecoveryFigureInkPacket(page, tokens, c, [], recoveryProfile)
    : nativeClosedProgramInkPacket(page, tokens, c, [anchor])
  if (!p) return
  if (p.records.length > 4096 || p.evidence.paths.size > 4096 || p.evidence.images.length > 64)
    return
  const groups = [...(p.evidence.isolatedGroups?.values() ?? [])],
    begins = p.o.fnArray.flatMap((op, i) => (op === OPS.paintFormXObjectBegin ? [i] : [])),
    ends = p.o.fnArray.flatMap((op, i) => (op === OPS.paintFormXObjectEnd ? [i] : []))
  if (groups.length !== 1 || begins.length !== 1 || ends.length !== 1) return
  const group = groups[0],
    begin = begins[0],
    end = ends[0]
  if (
    group.begin !== begin - 1 ||
    group.end !== end + 1 ||
    !p.valid(group.rect) ||
    !p.valid(group.clip) ||
    !p.valid(f.rect) ||
    !p.valid(f.caption.rect) ||
    !hit(f.rect, group.rect) ||
    !inside(group.rect, group.clip) ||
    p.o.argsArray[begin]?.[0] !== null ||
    p.o.argsArray[begin]?.[1] !== null
  )
    return
  const belongs = (i) => i > begin && i < end,
    records = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
  if (
    !records.length ||
    records.length > 64 ||
    records.some(
      (r) =>
        !r.advanceComplete || !r.part.every((z) => belongs(z.g.i) && inside(group.clip, z.g.ink))
    )
  )
    return
  if (
    records.some((r) =>
      r.part.some(
        ({ g }) =>
          g.textPaint.fillAlpha !== 1 ||
          !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
          g.textPaint.fillColor.toLowerCase() === '#ffffff'
      )
    )
  )
    return
  const sourceItems = records.map((r) => r.r.sourceItem).sort((a, b) => a.index - b.index)
  if (
    !(recoveryProfile
      ? nativeRecoveryFigureInkPacket(page, tokens, c, sourceItems, recoveryProfile)
      : nativeClosedProgramInkPacket(page, tokens, c, sourceItems))
  )
    return
  if (
    sourceItems.some(
      (s) =>
        tokens.filter(
          (t) =>
            t.sourceItem?.pageNumber === s.pageNumber &&
            t.sourceItem?.index === s.index &&
            t.sourceItem?.text === s.text &&
            t.text === s.text
        ).length !== 1
    )
  )
    return
  const glyphOwners = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (glyphOwners.has(g)) return
      glyphOwners.set(g, r)
    }
  const owned = new Set(records),
    ownedGlyphs = new Set(records.flatMap((r) => r.part.map((z) => z.g)))
  if (p.glyphs.some((g) => belongs(g.i) && positive(g) && !ownedGlyphs.has(g))) return
  const full = (r) => {
      const s = c.content.styles[r.r.fontName]
      if (s?.ascent === 0 && s?.descent === 0 && !owned.has(r))
        return union([r.rect, ...r.part.map((z) => z.g.ink)])
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
    },
    domains = new Map(p.records.map((r) => [r, full(r)]))
  if ([...domains.values()].some((r) => !p.valid(r))) return
  if (
    p.glyphs.some((g) => {
      const s = c.content.styles[g.fontName]
      return (
        positive(g) &&
        !(s?.ascent === 0 && s?.descent === 0 && !ownedGlyphs.has(g)) &&
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
  const cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
  if (!cap.length || !/^Figure\s+[1-9]\d*:/u.test(cap[0].r.str) || cap[0].part[0].g.i <= group.end)
    return
  const number = /^Figure\s+([1-9]\d*):/u.exec(cap[0].r.str)?.[1]
  if (
    captions.filter(
      (c) =>
        c.page === page.pageNumber &&
        new RegExp(`^(?:Figure|Fig\\.?)\\s+${number}[.:]`, 'u').test(c.lines[0])
    ).length !== 1
  )
    return
  const rect = union([group.rect, ...records.map((r) => domains.get(r))])
  if (!hit(f.rect, rect) || rect[3] > f.caption.rect[1]) return
  const lane = [
      Math.min(f.rect[0], rect[0], f.caption.rect[0]),
      rect[3],
      Math.max(f.rect[2], rect[2], f.caption.rect[2]),
      f.caption.rect[1]
    ],
    captionRecords = new Set(cap),
    captionGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g)))
  if (
    p.records.some((r) => !owned.has(r) && !captionRecords.has(r) && hit(lane, domains.get(r))) ||
    p.glyphs.some(
      (g) => positive(g) && !ownedGlyphs.has(g) && !captionGlyphs.has(g) && hit(lane, g.ink)
    ) ||
    captions.some((q) => q.page === page.pageNumber && hit(lane, q.rect)) ||
    tables.some((q) => hit(lane, q))
  )
    return
  const captureMargin = 2 / (Math.ceil(page.width * 1.5) / page.width)
  if (
    c.graphicsBounds
      .filter((g) => belongs(g.operationIndex) && g.kind === 'image')
      .some((g) => {
        const rect = g.normalizedRect?.map((x, i) => x * (i % 2 ? page.height : page.width))
        return !p.finite(rect, 4) || !inside(expand(group.clip, captureMargin), rect)
      })
  )
    return
  const foreignPaints = [],
    images = p.evidence.images.filter((im) => belongs(im.operationIndex))
  let pathPaints = 0
  for (const im of images) {
    const raw = p.o.argsArray[im.operationIndex],
      actual = c.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
      )
    if (
      p.o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
      raw.length !== 3 ||
      !Number.isSafeInteger(raw[1]) ||
      raw[1] <= 0 ||
      !Number.isSafeInteger(raw[2]) ||
      raw[2] <= 0 ||
      !inside(group.clip, im.rect) ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '')
    )
      return
  }
  if (p.evidence.images.some((im) => !belongs(im.operationIndex))) return
  for (const [i, s] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) continue
    if (belongs(i)) {
      if (
        !p.valid(s.clip) ||
        !inside(group.clip, s.clip) ||
        ![s.fillAlpha, s.strokeAlpha].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
      )
        return
      pathPaints++
    } else {
      const paint = nativeFigurePathPaint(p, i, s)
      if (!paint || hit(lane, paint.rect)) return
      foreignPaints.push(paint)
    }
  }
  foreignPaints.push(
    ...p.records.filter((r) => !owned.has(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownedGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  const scale = Math.ceil(page.width * 1.5) / page.width,
    padded = expand(rect, 2 / scale)
  if (
    !inside([0, 0, page.width, page.height], padded) ||
    foreignPaints.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((q) => q.page === page.pageNumber && hit(q.rect, padded)) ||
    tables.some((q) => hit(q, padded))
  )
    return
  const missingVisible =
      images.some((im) => !inside(f.rect, im.rect)) ||
      [...ownedGlyphs].some((g) => positive(g) && !inside(f.rect, g.ink)),
    borrowedForeign = foreignPaints.some((q) => hit(f.rect, q.rect))
  if (!missingVisible && !borrowedForeign) return
  return {
    rect,
    sourceItems,
    graphicsCount: images.length + pathPaints,
    formCropRaster: {
      ownedRects: [group.rect, ...records.map((r) => domains.get(r))],
      foreignPaints
    },
    nativeClip: group.clip
  }
}

const certificates = new WeakMap()
export function nativeIsolatedFormFigureCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  recoveryProfile
) {
  try {
    const result = deriveIsolatedForm(
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      recoveryProfile
    )
    if (!result) return
    const binding = () =>
        createHash('sha256')
          .update(JSON.stringify([page, figure, captions, tables, tokens, context]))
          .digest('hex'),
      nativeBinding = binding(),
      output = {
        rect: result.rect,
        sourceItems: result.sourceItems,
        graphicsCount: result.graphicsCount,
        formCropRaster: result.formCropRaster,
        isolatedFormRaster: true
      }
    certificates.set(output.formCropRaster, {
      recoveryProfile,
      tokens,
      context,
      page,
      binding,
      nativeBinding,
      ownerBinding: JSON.stringify(output),
      clip: result.nativeClip
    })
    return output
  } catch {
    return
  }
}
export function nativeIsolatedFormPngSafe(png, rect, page, candidate) {
  const proof = certificates.get(candidate?.formCropRaster)
  if (!proof) return candidate?.isolatedFormRaster ? false : undefined
  try {
    if (
      proof.recoveryProfile &&
      !nativeFigureRecoveryProfileData(proof.recoveryProfile, page, proof.tokens, proof.context)
    )
      return false
    const projection = {
      rect: candidate.rect,
      sourceItems: candidate.sourceItems,
      graphicsCount: candidate.graphicsCount,
      formCropRaster: candidate.formCropRaster,
      isolatedFormRaster: candidate.isolatedFormRaster
    }
    if (
      page !== proof.page ||
      proof.binding() !== proof.nativeBinding ||
      JSON.stringify(projection) !== proof.ownerBinding
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!raster &&
      inside(rect, expand(proof.clip, 1 / raster.scaleLower)) &&
      nativeCompleteFormCropPngSafe(png, rect, page, candidate)
    )
  } catch {
    return false
  }
}
