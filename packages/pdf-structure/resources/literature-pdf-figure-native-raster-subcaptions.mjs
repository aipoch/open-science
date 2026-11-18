/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'

const plans = new WeakMap(),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  inside = (a, b, e = 1e-5) => b.every((n, i) => (i < 2 ? n >= a[i] - e : n <= a[i] + e)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  compact = (s) => s.replace(/\s/gu, '')

export function nativeRasterSubcaptionCurrent(proof, page) {
  if (!Array.isArray(proof?.foreignPaints)) return false
  const p = plans.get(proof?.rasterSubcaptions),
    foreign = new Set(proof?.foreignPaints)
  return (
    !!p &&
    p.page === page &&
    p.proof.ownedRects === proof.ownedRects &&
    p.proof.foreignPaints.every((p) => foreign.has(p)) &&
    p.current()
  )
}

// Only original pixels: four individually printed images and their immediately
// following native (a)..(d) captions form a complete, independently captioned
// row or 2x2 cohort. Other page captions and every unclaimed paint stay foreign.
export function nativeRasterSubcaptionCrop(page, figure, captions, tables, tokens, ctx, pathPaint) {
  try {
    if (
      page?.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.filter((g) => g.kind === 'image').length < 4 ||
      ctx?.operators?.fnArray?.length > 20000 ||
      ctx?.content?.items?.length > 4096 ||
      tokens?.length > 4096
    )
      return
    const own = nativeRecoveryOwnValues(ctx),
      witness =
        own?.runningHeadWitness === undefined
          ? undefined
          : nativeRecoveryOwnValues(own.runningHeadWitness)
    if (!own || (own.runningHeadWitness !== undefined && (!witness || !witness.witnessViewport)))
      return
    const cap = figure?.caption,
      v = own.viewport,
      secondary = witness?.witnessViewport,
      keep = retainNativeRecoveryInputs([page, figure, captions, tables, tokens, ctx], v, secondary)
    if (
      !keep ||
      (secondary &&
        (!(secondary.width > 0) ||
          !(secondary.height > 0) ||
          secondary.scale !== 1 ||
          secondary.rotation !== 0 ||
          !Array.isArray(secondary.transform) ||
          secondary.transform.length !== 6 ||
          !secondary.transform.every(Number.isFinite))) ||
      !valid(figure?.rect) ||
      !valid(cap?.rect) ||
      !captions.includes(cap) ||
      cap.page !== page.pageNumber ||
      !Array.isArray(cap.lines) ||
      !cap.lines.length ||
      figure.fallbackFigure ||
      figure.headerRaster ||
      figure.parts ||
      figure.cropRects ||
      figure.sourceItems?.length ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      ctx.operators.fnArray.includes(OPS.paintFormXObjectBegin)
    )
      return
    const capTokens = tokens.filter((t) => inside(cap.rect, t.rect)),
      capSources = capTokens.map((t) => t.sourceItem)
    if (
      !capSources.length ||
      capSources.length > 8 ||
      compact(capTokens.map((t) => t.text).join('')) !== compact(cap.lines.join(''))
    )
      return
    let p = nativeFractionInkPacket(page, tokens, ctx, capSources)
    if (!p || p.evidence.images.length > 16 || p.evidence.paths.size > 4096) return
    const captionRecords = p.records.filter((r) => capSources.some((s) => s.index === r.index)),
      capOp = Math.min(...captionRecords.flatMap((r) => r.part.map((z) => z.g.i))),
      images = p.evidence.images
        .filter(
          (im) =>
            valid(im.rect) &&
            im.operationIndex < capOp &&
            im.rect[1] < figure.rect[3] &&
            im.rect[3] > figure.rect[1] &&
            im.rect[3] < cap.rect[1]
        )
        .sort((a, b) => a.operationIndex - b.operationIndex)
    if (images.length !== 4) return
    const groups = images.map((im, n) =>
        p.records.filter((r) =>
          r.part.some(
            (z) => z.g.i > im.operationIndex && z.g.i < (images[n + 1]?.operationIndex ?? capOp)
          )
        )
      ),
      ids = new Set(capSources.map((s) => s.index))
    if (
      groups.some(
        (group, n) =>
          !group.length ||
          group.length > 24 ||
          !new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)(?:\\s|$)').test(group[0].r.str) ||
          group.some(
            (r) =>
              !r.part.every(
                (z) =>
                  z.g.i > images[n].operationIndex &&
                  z.g.i < (images[n + 1]?.operationIndex ?? capOp)
              )
          )
      )
    )
      return
    for (const group of groups) for (const r of group) ids.add(r.index)
    if (ids.size > 64) return
    // A foreign advance mismatch can never authorize a caption: rerun the
    // existing whole-native-owner contract with every cohort member claimed.
    const owners = [...ids].sort((a, b) => a - b).map((i) => ctx.content.items[i]?.sourceItem)
    p = nativeFractionInkPacket(page, tokens, ctx, owners)
    if (!p) return
    const selected = p.records.filter((r) => ids.has(r.index)),
      visible = (r) =>
        r.advanceComplete === true &&
        r.part.length &&
        r.part.every(
          ({ g }) =>
            valid(g.ink) &&
            valid(g.advance) &&
            g.textPaint?.fillAlpha === 1 &&
            /^#[0-9a-f]{6}$/i.test(g.textPaint.fillColor) &&
            g.textPaint.fillColor.toLowerCase() !== '#ffffff'
        ),
      labels = groups.map((group) => group.map((r) => selected.find((q) => q.index === r.index))),
      em = labels[0][0]?.r.height
    if (!(em > 0) || selected.some((r) => !visible(r)) || labels.some((g) => g.some((r) => !r)))
      return
    const labelBounds = labels.map((g) =>
        union(g.flatMap((r) => [r.rect, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])]))
      ),
      rows = images[2].rect[1] > images[0].rect[3] ? 2 : 1,
      columns = 4 / rows
    for (const [n, im] of images.entries()) {
      const group = labels[n],
        packet = group[0].part[0].g.packet,
        bound = labelBounds[n],
        first = images[Math.floor(n / columns) * columns],
        previous = images[n - 1]
      if (
        !Number.isInteger(packet?.end) ||
        group.some((r) => r.part.some((z) => z.g.packet !== packet)) ||
        Math.abs(im.rect[1] - first.rect[1]) > em * 2 ||
        Math.abs(im.rect[3] - first.rect[3]) > em / 16 ||
        im.rect[2] - im.rect[0] > (first.rect[2] - first.rect[0]) * 1.5 ||
        (n % columns &&
          (im.rect[0] <= previous.rect[2] || im.rect[0] - previous.rect[2] > em * 4)) ||
        bound[1] < im.rect[3] ||
        bound[1] - im.rect[3] > em * 2 ||
        bound[3] - im.rect[3] > em * 3 ||
        bound[3] >= cap.rect[1] ||
        !inside([im.rect[0] - em, im.rect[3], im.rect[2] + em, cap.rect[1]], bound) ||
        group.some((r) => r.r.height > em || r.r.height < em / 2)
      )
        return
      if (
        rows === 2 &&
        n >= columns &&
        (Math.abs(im.rect[0] - images[n - columns].rect[0]) > em / 16 ||
          Math.abs(im.rect[2] - images[n - columns].rect[2]) > em / 16 ||
          im.rect[1] <= labelBounds[n - columns][3] ||
          im.rect[1] - labelBounds[n - columns][3] > em * 3)
      )
        return
    }
    const rect = union([figure.rect, ...images.map((im) => im.rect), ...labelBounds]),
      padded = expand(rect, 2 / 1.5)
    if (
      rect.every((n, i) => n === figure.rect[i]) ||
      !inside([0, 0, page.width, page.height], padded) ||
      captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
      tables.some((t) => hit(t, padded))
    )
      return
    const ownIds = new Set(labels.flat().map((r) => r.index)),
      ownImages = new Set(images.map((im) => im.operationIndex)),
      foreignPaints = []
    for (const r of p.records) {
      if (ownIds.has(r.index)) continue
      for (const b of [r.rect, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])]) {
        if (!b.every(Number.isFinite) || hit(padded, expand(b, 2 / 1.5))) return
        foreignPaints.push({ rect: b, floor: 0 })
      }
    }
    for (const im of p.evidence.images)
      if (!ownImages.has(im.operationIndex)) {
        if (!valid(im.rect) || hit(padded, expand(im.rect, 2 / 1.5))) return
        foreignPaints.push({ rect: im.rect, floor: 0 })
      }
    for (const [i, s] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (
        a[0] === OPS.endPath ||
        (a[0] === OPS.stroke && a[1]?.length === 1 && a[1][0] === null && a[2] === null)
      )
        continue
      const paint = pathPaint(p, i, s)
      if (!paint || hit(padded, expand(paint.rect, (paint.floor + 2) / 1.5))) return
      foreignPaints.push(paint)
    }
    const proof = {
        ownedRects: [figure.rect, ...images.map((im) => im.rect), ...labelBounds],
        foreignPaints,
        rasterSubcaptions: Object.freeze({})
      },
      output = retainNativeRecoveryInputs([rect, proof])
    if (!output || !keep()) return
    plans.set(proof.rasterSubcaptions, { page, proof, current: () => keep() && output() })
    return { rect, formCropRaster: proof }
  } catch {
    return
  }
}
