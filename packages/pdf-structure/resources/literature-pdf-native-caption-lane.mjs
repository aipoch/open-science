/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  groupNativeCaptionFragments,
  joinCaptionLines,
  sourceWordSpellings,
  captionKind
} from './literature-pdf-caption-group.mjs'
import {
  nativeClosedProgramInkPacket,
  nativeForeignCompoundInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import {
  getPdfCropRasterProtectionFromPng,
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng,
  MAX_BYTES
} from './literature-pdf-crop.mjs'
const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const overlap = (a, b) =>
  valid(a) && valid(b) && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s/gu, '')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const recoveredCaptions = new WeakMap()
// A subscript and the next row's superscript can connect two otherwise
// separate rows. Only an exact native principal-font baseline and a monotone
// source-order partition may replace that connected-component grouping.
function baselineCaptionRows(lines, tokens, context, firstNative, start, left, right) {
  const em = firstNative.height,
    principal = (t) => {
      const r = context.content.items[t.sourceItem.index]
      return r.fontName === firstNative.fontName && r.height === em
    },
    baselines = [
      ...new Set(
        tokens
          .filter(
            (t) =>
              principal(t) &&
              t.rect[0] >= left - em * 0.1 &&
              t.rect[2] <= right + em * 0.1 &&
              t.rect[1] >= start.y
          )
          .map((t) => t.baseline)
      )
    ].sort((a, b) => a - b)
  const gap = baselines.findIndex((y, i) => i > 0 && y - baselines[i - 1] > em * 1.6)
  if (gap >= 0) baselines.splice(gap)
  if (baselines.length < 2 || baselines.length > 32) return
  const groups = new Map(baselines.map((y) => [y, []]))
  for (const l of lines.filter((l) => l.y < baselines.at(-1))) {
    const parts = tokens.filter((t) => overlap(t.rect, [l.x, l.y, l.x + l.width, l.y + l.height])),
      mains = parts.filter(principal)
    let target
    if (mains.length) {
      const ys = [...new Set(mains.map((t) => t.baseline))]
      if (ys.length !== 1) return
      target = ys[0]
    } else {
      const baseline = Math.max(...parts.map((t) => t.baseline)),
        distances = baselines
          .map((y) => ({ y, d: Math.abs(y - baseline) }))
          .sort((a, b) => a.d - b.d)
      if (!distances.length || distances[0].d === distances[1]?.d || distances[0].d > em * 0.5)
        return
      target = distances[0].y
    }
    if (!groups.has(target)) return
    groups.get(target).push(l)
  }
  if ([...groups.values()].some((parts) => !parts.length)) return
  return [...groups].map(([baseline, parts]) => {
    parts.sort((a, b) => a.x - b.x || a.y - b.y)
    return {
      parts,
      nativeBaseline: baseline,
      text: parts.map((p) => p.text).join(' '),
      x: parts[0].x,
      y: Math.min(...parts.map((p) => p.y)),
      bottom: Math.max(...parts.map((p) => p.y + p.height)),
      right: Math.max(...parts.map((p) => p.x + p.width)),
      fontSize: em
    }
  })
}
function plan(page, candidate, tokens, context, anchors, others) {
  if (
    page.pageNumber !== candidate.page ||
    context.pageNumber !== candidate.page ||
    !Array.isArray(candidate.lines) ||
    candidate.lines.length < 2 ||
    candidate.lines.length > 32 ||
    /[.!?]$/u.test(candidate.lines.at(-1).trim()) ||
    !valid(candidate.rect) ||
    !['table', 'figure'].includes(captionKind(candidate.lines[0])) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(anchors) ||
    !Array.isArray(others)
  )
    return
  const first = page.lines.filter((l) => l.text === candidate.lines[0])
  if (first.length !== 1) return
  const start = first[0],
    starts = tokens
      .filter(
        (t) =>
          t.text.trim() &&
          overlap(t.rect, [start.x, start.y, start.x + start.width, start.y + start.height])
      )
      .sort((a, b) => a.rect[0] - b.rect[0]),
    firstNative = starts[0] && context.content.items[starts[0].sourceItem.index]
  if (
    !firstNative ||
    !Number.isFinite(firstNative.height) ||
    !(firstNative.height > 0) ||
    !firstNative.fontName
  )
    return
  const em = firstNative.height,
    left = candidate.rect[0],
    right = candidate.rect[2],
    type = captionKind(candidate.lines[0])
  const lines = page.lines.filter(
    (l) =>
      l.y >= start.y &&
      l.x >= left - em * 0.1 &&
      l.x + l.width <= right + em * 0.1 &&
      l.fontSize >= em * 0.5 &&
      l.fontSize <= em * 1.45
  )
  const connected = groupNativeCaptionFragments(lines, em),
    bridged = connected?.some(
      (row) =>
        new Set(
          tokens
            .filter((t) => {
              const r = context.content.items[t.sourceItem.index]
              return (
                r.fontName === firstNative.fontName &&
                r.height === em &&
                overlap(t.rect, [row.x, row.y, row.right, row.bottom])
              )
            })
            .map((t) => t.baseline)
        ).size > 1
    ),
    physical = bridged
      ? baselineCaptionRows(lines, tokens, context, firstNative, start, left, right)
      : connected
  if (!physical || physical[0]?.text !== candidate.lines[0]) return
  const rows = []
  for (const row of physical) {
    if (rows.length >= 32) return
    if (rows.length && row.y - rows.at(-1).y > em * 1.6) break
    if (rows.length && captionKind(row.text)) break
    const box = [row.x, row.y, row.right, row.bottom],
      claims = tokens.filter((t) => overlap(t.rect, box)),
      principal = claims.filter((t) => {
        const r = context.content.items[t.sourceItem.index]
        return r.fontName === firstNative.fontName && r.height === em
      })
    if (!principal.length || Math.abs(row.x - left) > em * 0.1) break
    rows.push(row)
    if (
      rows.length > candidate.lines.length &&
      /[.!?]$/u.test(row.text.trim()) &&
      row.right < right - em * 1.5
    )
      break
  }
  if (
    rows.length <= candidate.lines.length ||
    !/[.!?]$/u.test(rows.at(-1).text.trim()) ||
    candidate.lines.some((s, i) => compact(s) !== compact(rows[i]?.text ?? ''))
  )
    return
  const last = rows.at(-1)
  if (
    page.lines.some(
      (l) => l.y >= last.bottom && l.y - last.y <= em * 1.6 && l.x < right && l.x + l.width > left
    )
  )
    return
  const owns = (r, t) => {
    if (!bridged) return overlap(t.rect, [r.x, r.y, r.right, r.bottom])
    if (!overlap(t.rect, [left, start.y, right, rows.at(-1).bottom])) return false
    const distances = rows
      .map((row) => ({ row, d: Math.abs(row.nativeBaseline - t.baseline) }))
      .sort((a, b) => a.d - b.d)
    return (
      distances[0]?.row === r && distances[0].d <= em * 0.5 && distances[0].d !== distances[1]?.d
    )
  }
  const selected = tokens.filter((t) => rows.some((r) => owns(r, t)))
  if (
    !selected.length ||
    selected.length > (bridged ? 4096 : 64) ||
    selected.some((t) => rows.filter((r) => owns(r, t)).length !== 1)
  )
    return
  for (const row of rows) {
    const parts = selected.filter((t) => owns(row, t)).sort((a, b) => a.rect[0] - b.rect[0])
    if (
      parts.some((t, i) => i > 0 && t.rect[0] === parts[i - 1].rect[0]) ||
      compact(parts.map((t) => t.text).join('')) !== compact(row.text)
    )
      return
  }
  if (bridged) {
    const sequence = [...selected]
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
      .map((t) => rows.findIndex((r) => owns(r, t)))
    if (sequence.some((n, i) => i > 0 && n < sequence[i - 1])) return
  }
  const indices = new Set(selected.map((t) => t.sourceItem.index))
  if (indices.size !== selected.length) return
  const packet =
    nativeClosedProgramInkPacket(
      page,
      tokens,
      context,
      selected.map((t) => t.sourceItem)
    ) ??
    nativeForeignCompoundInkPacket(
      page,
      tokens,
      context,
      selected.map((t) => t.sourceItem)
    ) ??
    // The existing foreign inventory retains every native literal and physical
    // glyph. This caption-only caller separately proves its complete owners;
    // the default packet's owned-accent refusal and 64-source limit stay intact.
    nativeClosedProgramInkPacket(page, tokens, context, [selected[0].sourceItem]) ??
    nativeForeignCompoundInkPacket(page, tokens, context, [])
  if (!packet) return
  const owned = packet.records.filter((r) => indices.has(r.index))
  if (
    owned.length !== indices.size ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        r.part.some(
          (z) =>
            (z.g.compoundAccent &&
              (!/^\p{L}$/u.test(z.g.text) ||
                !Array.from(r.r.str.matchAll(/\p{L}+/gu)).some(
                  (word) => word[0].length > 1 && word[0].includes(z.g.text)
                ))) ||
            z.g.rendererSkipped ||
            z.g.textPaint?.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) ||
            z.g.textPaint.fillColor.toLowerCase() === '#ffffff'
        )
    )
  )
    return
  const physicalOwners = new Map()
  for (const r of packet.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      const previous = physicalOwners.get(g)
      if (previous !== undefined && (indices.has(previous) || indices.has(r.index))) return
      physicalOwners.set(g, r.index)
    }
  const sourceInk = union(owned.map((r) => r.ink)),
    rect = union([...rows.map((r) => [r.x, r.y, r.right, r.bottom]), sourceInk]),
    glyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
    aa = 1 / 1.5,
    protection = [rect[0] - aa, rect[1] - aa, rect[2] + aa, rect[3] + aa]
  if (
    packet.glyphs.some((g) => !glyphs.has(g) && overlap(g.ink, protection)) ||
    packet.records.some((r) => !indices.has(r.index) && overlap(r.ink, protection))
  )
    return
  const graphics = page.graphicsBounds.map((g) => ({
    ...g,
    rect: g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
  }))
  const self = others.filter(
    (c) =>
      c.page === candidate.page &&
      JSON.stringify(c.lines) === JSON.stringify(candidate.lines) &&
      JSON.stringify(c.rect) === JSON.stringify(candidate.rect)
  )
  if (
    self.length !== 1 ||
    graphics.some((g) => overlap(g.rect, protection)) ||
    others.some((c) => !self.includes(c) && valid(c.rect) && overlap(c.rect, protection))
  )
    return
  const matching = anchors.filter(
    (a) =>
      a.page === page.pageNumber &&
      a.kind === type &&
      valid(a.rect) &&
      a.caption?.lines?.[0] === candidate.lines[0] &&
      a.rect[0] < right &&
      a.rect[2] > left &&
      (type === 'table' ? a.rect[1] > protection[3] : a.rect[3] < protection[1])
  )
  if (matching.length !== 1) return
  let anchor = matching[0]
  if (type === 'table') {
    const sources = anchor.sourceItems ?? [],
      sourceIndices = new Set(sources.map((s) => s.index)),
      body = packet.records.filter((r) => sourceIndices.has(r.index))
    if (
      !body.length ||
      body.length !== sourceIndices.size ||
      body.some(
        (r) =>
          !r.advanceComplete ||
          !valid(r.ink) ||
          sources.find((s) => s.index === r.index)?.text !== r.r.str
      )
    )
      return
    const bodyInk = union(body.map((r) => r.ink)),
      rules = anchor.rules?.filter(
        (r) =>
          finite(r, 4) &&
          r[1] === r[3] &&
          r[1] > protection[3] &&
          r[1] < bodyInk[1] &&
          r[0] < bodyInk[0] &&
          r[2] > bodyInk[2]
      )
    if (rules?.length !== 1) return
    anchor = { ...anchor, captionSeparation: { rule: rules[0], bodyInk } }
  }
  if (anchor.sourceItems?.some((s) => indices.has(s.index))) return
  const principalFont = firstNative.fontName,
    fullChars = Array.from(compact(rows.map((r) => r.text).join('')))
      .sort()
      .join(''),
    nativeChars = Array.from(compact(selected.map((t) => t.text).join('')))
      .sort()
      .join('')
  if (fullChars !== nativeChars) return
  return { rows, owned, packet, indices, rect, protection, anchor, principalFont, glyphs }
}
const certificate = (p) =>
  JSON.stringify({
    rect: p.rect,
    rows: p.rows.map((r) => r.text),
    owned: p.owned.map((r) => [r.index, r.rect, r.ink, r.advanceComplete]),
    anchor: p.anchor
  })
export async function recoverNativeClosedCaptionLane({
  page,
  candidate,
  tokens,
  context,
  anchors,
  otherCaptions,
  raster,
  loadPng
}) {
  try {
    if (
      typeof loadPng !== 'function' ||
      raster?.sourceSha256 !== context.sourceSha256 ||
      raster.page !== page.pageNumber ||
      raster.scale !== 1.5 ||
      raster.width !== Math.ceil(page.width * 1.5) ||
      raster.height !== Math.ceil(page.height * 1.5) ||
      raster.width * raster.height > 4000000 ||
      !/^[a-f\d]{64}$/u.test(raster.sha256 ?? '')
    )
      return
    if (
      !['width', 'height', 'scale', 'rotation', 'transform'].every((k) => {
        const d = Object.getOwnPropertyDescriptor(context.viewport, k)
        return d && 'value' in d
      })
    )
      return
    const guarded = context,
      converter = context.viewport.convertToViewportPoint,
      unchanged = retainNativeRecoveryInputs(
        [page, tokens, context, candidate, anchors, otherCaptions, raster, loadPng],
        context.viewport
      )
    if (!unchanged) return
    const p = plan(page, candidate, tokens, guarded, anchors, otherCaptions)
    if (!p) return
    const before = certificate(p),
      value = await loadPng()
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > MAX_BYTES ||
      digest(value) !== raster.sha256 ||
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter ||
      !getPdfCropRasterProtectionFromPng(value, [0, 0, page.width, page.height], context.viewport)
    )
      return
    const bytes = Buffer.from(value),
      image = await loadImage(bytes)
    if (
      image.width !== raster.width ||
      image.height !== raster.height ||
      digest(value) !== raster.sha256 ||
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter
    )
      return
    const current = plan(page, candidate, tokens, guarded, anchors, otherCaptions)
    if (!current || certificate(current) !== before) return
    const sample = p.anchor.captionSeparation
      ? union([
          p.protection,
          [
            p.anchor.captionSeparation.bodyInk[0],
            p.anchor.captionSeparation.rule[1] - 1 / 1.5,
            p.anchor.captionSeparation.bodyInk[2],
            p.anchor.captionSeparation.rule[1] + 1 / 1.5
          ]
        ])
      : p.protection
    const x0 = Math.floor(sample[0] * 1.5),
      y0 = Math.floor(sample[1] * 1.5),
      x1 = Math.ceil(sample[2] * 1.5),
      y1 = Math.ceil(sample[3] * 1.5)
    if (
      x0 < 0 ||
      y0 < 0 ||
      x1 > image.width ||
      y1 > image.height ||
      (x1 - x0) * (y1 - y0) > MAX_BYTES / 8
    )
      return
    const canvas = createCanvas(image.width, image.height)
    try {
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data,
        w = x1 - x0
      const dark = (x, y) => {
        if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
        const i = ((y - y0) * w + x - x0) * 4
        return pixels[i + 3] === 255 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 192
      }
      if (p.anchor.captionSeparation) {
        const { rule, bodyInk } = p.anchor.captionSeparation
        for (let x = Math.ceil(bodyInk[0] * 1.5); x <= Math.floor(bodyInk[2] * 1.5); x++) {
          let hit = false
          for (let y = Math.floor(rule[1] * 1.5) - 1; y <= Math.ceil(rule[1] * 1.5) + 1; y++)
            if (dark(x, y)) {
              hit = true
              break
            }
          if (!hit) return
        }
      }
      for (const g of p.glyphs) {
        let hit = false
        for (let y = Math.floor(g.ink[1] * 1.5); !hit && y < Math.ceil(g.ink[3] * 1.5); y++)
          for (let x = Math.floor(g.ink[0] * 1.5); x < Math.ceil(g.ink[2] * 1.5); x++)
            if (dark(x, y)) {
              hit = true
              break
            }
        if (!hit) return
      }
    } finally {
      canvas.width = canvas.height = 0
    }
    if (
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter ||
      digest(value) !== raster.sha256
    )
      return
    const lines = p.rows.map((r) => r.text)
    const result = {
      ...candidate,
      lines,
      rect: p.rect,
      text: joinCaptionLines(lines, sourceWordSpellings(page.lines.map((l) => l.text)))
    }
    recoveredCaptions.set(result, {
      page,
      tokens,
      context,
      plan: p,
      unchanged,
      literal: JSON.stringify(result)
    })
    return result
  } catch {
    return
  }
}

// Only the same successful full-caption certificate can close this image-only
// recovery. No native text becomes a figure owner, and no clip or hash budget
// is widened. The caller publishes the crop only after its encoded PNG passes.
export async function recoverNativeClosedCaptionImage({
  page,
  figure,
  caption,
  tokens,
  context,
  otherCaptions,
  tables,
  renderCrop
}) {
  try {
    const proof = recoveredCaptions.get(caption)
    if (
      !proof ||
      proof.page !== page ||
      proof.tokens !== tokens ||
      proof.context !== context ||
      proof.plan.anchor.sourceOwner !== figure ||
      !proof.unchanged() ||
      JSON.stringify(caption) !== proof.literal ||
      figure.page !== page.pageNumber ||
      !valid(figure.region) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.issue ||
      !Array.isArray(otherCaptions) ||
      !Array.isArray(tables) ||
      typeof renderCrop !== 'function'
    )
      return
    const p = proof.plan.packet,
      images = p.evidence.images,
      unchanged = retainNativeRecoveryInputs([figure, caption, otherCaptions, tables, renderCrop])
    if (
      !unchanged ||
      images.length !== 1 ||
      p.o.fnArray.some((op) =>
        [OPS.beginGroup, OPS.endGroup, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd].includes(
          op
        )
      )
    )
      return
    const image = images[0],
      a = p.o.argsArray[image.operationIndex],
      actual = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === image.operationIndex
      ),
      inside = (outer, inner) => inner.every((n, i) => (i < 2 ? n >= outer[i] : n <= outer[i])),
      cap = p.records.filter((r) => inside(caption.rect, r.rect))
    if (
      !valid(image.rect) ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '') ||
      a?.length !== 3 ||
      !Number.isSafeInteger(a[1]) ||
      !Number.isSafeInteger(a[2]) ||
      a[1] <= 0 ||
      a[2] <= 0 ||
      !cap.length ||
      !/^Figure\s+\d+:/u.test(cap[0].r.str) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(caption.lines.join('')) ||
      !/[.!?]$/u.test(cap.at(-1).r.str) ||
      cap.some((r) => !r.advanceComplete || r.part.some((z) => z.g.i <= image.operationIndex))
    )
      return
    const foreign = []
    for (const r of p.records) {
      const style = context.content.styles[r.r.fontName],
        font = nativeFigureLabelBounds(r.r, style, p.v)
      if (!font || !valid(font)) return
      const domain = union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (!valid(domain) || overlap(domain, image.rect)) return
      foreign.push({ rect: domain, floor: 0 })
    }
    for (const g of p.glyphs) {
      if (g.rendererSkipped) continue
      if (!valid(g.ink)) return
      foreign.push({ rect: g.ink, floor: 0 })
    }
    for (const [i, state] of p.evidence.paths) {
      const args = p.o.argsArray[i]
      if (
        args[0] === OPS.endPath ||
        (args[1]?.length === 1 && args[1][0] === null && args[2] === null)
      )
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreign.push(paint)
    }
    const scale = Math.ceil(page.width * 1.5) / page.width,
      expand = (rect, padding) => rect.map((n, i) => n + (i < 2 ? -padding : padding)),
      rect = expand(image.rect, 2 / scale),
      old = figure.region.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (
      !inside([0, 0, page.width, page.height], rect) ||
      foreign.some((q) => overlap(rect, expand(q.rect, (q.floor + 2) / scale))) ||
      otherCaptions.some((c) => c.page === page.pageNumber && overlap(c.rect, rect)) ||
      tables.some((t) => overlap(t, rect)) ||
      (inside(old, image.rect) && !foreign.some((q) => overlap(old, q.rect)))
    )
      return
    const raster = { ownedRects: [image.rect], foreignPaints: foreign },
      png = await renderCrop(rect)
    if (
      !unchanged() ||
      !proof.unchanged() ||
      JSON.stringify(caption) !== proof.literal ||
      !nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: raster })
    )
      return
    return {
      region: rect.map((n, i) => n / (i % 2 ? page.height : page.width)),
      graphicsCount: 1,
      png
    }
  } catch {
    return
  }
}

const inside = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
const borderBox = (b, m) =>
  union(
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]]
    ].map((p) => {
      Util.applyTransform(p, m)
      return [p[0], p[1], p[0], p[1]]
    })
  )
function planClosedThreeRailCrop(page, tokens, context, table) {
  if (
    !table.caption ||
    table.page !== page.pageNumber ||
    !Array.isArray(table.cells) ||
    !table.cells.length ||
    !Array.isArray(table.cropRect) ||
    !table.sourceViewport
  )
    return
  const claims = table.cells.flatMap((c) => c.sourceItems ?? []),
    indices = new Set(claims.map((s) => s.index))
  if (
    indices.size !== claims.length ||
    claims.length > 64 ||
    claims.some((s) => s.pageNumber !== page.pageNumber)
  )
    return
  const p =
    nativeClosedProgramInkPacket(page, tokens, context, claims) ??
    nativeForeignCompoundInkPacket(page, tokens, context, claims)
  if (!p) return
  const body = p.records.filter((r) => indices.has(r.index))
  if (
    body.length !== claims.length ||
    body.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        claims.find((s) => s.index === r.index)?.text !== r.r.str
    )
  )
    return
  const owners = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (owners.has(g)) return
      owners.set(g, r.index)
    }
  const bodyInk = union(body.map((r) => r.ink)),
    old = table.cropRect.map((n) => n / 1.5),
    colors = new Map(),
    stack = []
  let stroke = '#000000'
  for (const [i, op] of p.o.fnArray.entries()) {
    const a = p.o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(stroke)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      stroke = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) stroke = a?.[0]
    else if (op === OPS.constructPath) colors.set(i, stroke)
  }
  if (stack.length) return
  const rails = []
  for (const [i, q] of p.evidence.paths) {
    const a = p.o.argsArray[i],
      z = a?.[1]?.[0],
      m = Util.transform(p.v.transform, q.transform)
    if (a?.[0] !== OPS.stroke || z?.length !== 6 || z[0] !== 0 || z[3] !== 1) continue
    const s = [z[1], z[2]],
      e = [z[4], z[5]]
    Util.applyTransform(s, m)
    Util.applyTransform(e, m)
    if (s[1] !== e[1] || s[0] >= e[0] || s[0] >= bodyInk[0] || e[0] <= bodyInk[2]) continue
    if (
      colors.get(i) !== '#000000' ||
      q.lineCap !== 0 ||
      q.solidStroke !== true ||
      q.strokeAlpha !== 1 ||
      q.fillAlpha !== 1 ||
      !Number.isFinite(q.lineWidth) ||
      q.lineWidth <= 0 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      Math.abs(m[0]) !== 1 ||
      Math.abs(m[3]) !== 1
    )
      return
    const ink = [s[0], s[1] - q.lineWidth / 2, e[0], e[1] + q.lineWidth / 2]
    if (!(ink[1] < old[3] && ink[3] > old[1])) continue
    if (!valid(q.clip) || !inside(q.clip, ink)) return
    rails.push({ operatorIndex: i, segment: [...s, ...e], width: q.lineWidth, ink, clip: q.clip })
  }
  rails.sort((a, b) => a.segment[1] - b.segment[1])
  if (
    rails.length !== 3 ||
    rails.some(
      (r) => r.segment[0] !== rails[0].segment[0] || r.segment[2] !== rails[0].segment[2]
    ) ||
    rails[0].ink[3] >= bodyInk[1] ||
    rails[2].ink[1] <= bodyInk[3]
  )
    return
  const header = new Set(
    table.cells
      .filter((c) => c.row === 0)
      .flatMap((c) => c.sourceItems ?? [])
      .map((s) => s.index)
  )
  if (
    !header.size ||
    body.some((r) =>
      header.has(r.index) ? r.ink[3] >= rails[1].ink[1] : r.ink[1] <= rails[1].ink[3]
    )
  )
    return
  const ink = union([bodyInk, ...rails.map((r) => r.ink)]),
    aa = 1 / 4,
    rect = ink.map((n, i) => n + (i < 2 ? -aa : aa)),
    raster = getInitialPdfCropRaster(rect, page)
  if (!raster || raster.scale !== 4) return
  const owned = new Set(body.flatMap((r) => r.part.map((z) => z.g)))
  if (
    p.glyphs.some((g) => !owned.has(g) && valid(g.ink) && overlap(g.ink, raster.protection)) ||
    p.records.some(
      (r) => !indices.has(r.index) && valid(r.ink) && overlap(r.ink, raster.protection)
    ) ||
    p.evidence.images.some((im) => overlap(im.rect, raster.protection))
  )
    return
  const permitted = new Set(rails.map((r) => r.operatorIndex))
  for (const [i, q] of p.evidence.paths) {
    if (permitted.has(i)) continue
    const a = p.o.argsArray[i]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!a?.[2] || a[2].length !== 4) return
    const margin = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0])
        ? (q.lineWidth * Math.max(1, p.strokeMargins.get(i) ?? 10)) / 2
        : 0,
      b = borderBox(
        Array.from(a[2], (n, k) => n + (k < 2 ? -margin : margin)),
        Util.transform(p.v.transform, q.transform)
      ),
      clipped = q.clip
        ? [
            Math.max(b[0], q.clip[0]),
            Math.max(b[1], q.clip[1]),
            Math.min(b[2], q.clip[2]),
            Math.min(b[3], q.clip[3])
          ]
        : b
    if (valid(clipped) && overlap(clipped, raster.protection)) return
  }
  return {
    rect,
    raster,
    rails,
    wholeBodySources: claims,
    bodyInk,
    glyphInks: [...owned].filter((g) => valid(g.ink)).map((g) => g.ink),
    oldModelFrame: table.cropRect,
    oldNativeCrop: old
  }
}

// The detector crop remains the model coordinate frame. Only the independent
// image region may grow after whole native owners and every stroke close.
export async function recoverNativeClosedTableBorder({ page, tokens, context, table, renderCrop }) {
  try {
    if (typeof renderCrop !== 'function') return
    const unchanged = retainNativeRecoveryInputs(
      [page, tokens, context, table, renderCrop],
      context.viewport
    )
    if (!unchanged) return
    const p = planClosedThreeRailCrop(page, tokens, context, table)
    if (!p) return
    const certificate = JSON.stringify(p),
      value = await renderCrop(p.rect)
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > MAX_BYTES ||
      !unchanged() ||
      !matchesInitialPdfCropPng(value, p.raster)
    )
      return
    const current = planClosedThreeRailCrop(page, tokens, context, table)
    if (!current || JSON.stringify(current) !== certificate) return
    const bytes = Buffer.from(value),
      sha = digest(bytes),
      image = await loadImage(bytes)
    if (
      !unchanged() ||
      digest(value) !== sha ||
      image.width !== p.raster.pixelWidth ||
      image.height !== p.raster.pixelHeight
    )
      return
    const canvas = createCanvas(image.width, image.height)
    try {
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data,
        mask = new Uint8Array(image.width * image.height),
        scale = p.raster.scale
      const coordinates = (r) => [
        Math.max(0, Math.floor((r[0] - p.rect[0]) * scale) - 1),
        Math.max(0, Math.floor((r[1] - p.rect[1]) * scale) - 1),
        Math.min(image.width, Math.ceil((r[2] - p.rect[0]) * scale) + 1),
        Math.min(image.height, Math.ceil((r[3] - p.rect[1]) * scale) + 1)
      ]
      const dark = (x, y) => {
        const i = (y * image.width + x) * 4
        return pixels[i + 3] === 255 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 192
      }
      for (const ink of [...p.glyphInks, ...p.rails.map((r) => r.ink)]) {
        const [x0, y0, x1, y1] = coordinates(ink)
        let hit = false
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            mask[y * image.width + x] = 1
            if (dark(x, y)) hit = true
          }
        if (!hit) return
      }
      for (let i = 0; i < mask.length; i++)
        if (
          pixels[i * 4 + 3] !== 255 ||
          (!mask[i] && Math.min(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]) < 192)
        )
          return
      for (const r of p.rails) {
        const y = (r.segment[1] - p.rect[1]) * scale
        for (
          let x = Math.ceil((r.segment[0] - p.rect[0]) * scale);
          x < Math.floor((r.segment[2] - p.rect[0]) * scale);
          x++
        ) {
          let hit = false
          for (
            let yy = Math.max(0, Math.floor(y) - 1);
            yy <= Math.min(image.height - 1, Math.ceil(y) + 1);
            yy++
          )
            if (dark(x, yy)) hit = true
          if (!hit) return
        }
      }
    } finally {
      canvas.width = canvas.height = 0
    }
    if (!unchanged() || digest(value) !== sha) return
    return { region: p.rect.map((n, i) => n / (i % 2 ? page.height : page.width)), png: bytes }
  } catch {
    return
  }
}

const captionAnchorSourceItems = (owner, pageNumber) => {
  if (owner.cells !== undefined && !Array.isArray(owner.cells)) return
  const result = []
  for (const cell of owner.cells ?? []) {
    if (
      !cell ||
      typeof cell !== 'object' ||
      (cell.sourceItems !== undefined && !Array.isArray(cell.sourceItems))
    )
      return
    result.push(...(cell.sourceItems ?? []))
  }
  if (
    result.some(
      (s) =>
        !s ||
        s.pageNumber !== pageNumber ||
        !Number.isSafeInteger(s.index) ||
        s.index < 0 ||
        typeof s.text !== 'string'
    )
  )
    return
  return result
}
// A published image region never substitutes for the detector/model frame.
// Unsupported split or image-only tables decline without unioning their bounds.
export function nativeCaptionLaneAnchors(page, tables, figures, rules) {
  try {
    if (
      !Number.isSafeInteger(page?.pageNumber) ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      !Array.isArray(tables) ||
      !Array.isArray(figures) ||
      !Array.isArray(rules) ||
      rules.some((r) => !finite(r, 4))
    )
      return []
    const anchors = []
    for (const table of tables) {
      if (
        !table ||
        table.page !== page.pageNumber ||
        !table.caption ||
        table.parts !== undefined ||
        table.cropRects !== undefined ||
        !valid(table.cropRect)
      )
        continue
      const frame = table.sourceViewport
      if (
        !Number.isFinite(frame?.scale) ||
        frame.scale <= 0 ||
        frame.width !== page.width * frame.scale ||
        frame.height !== page.height * frame.scale
      )
        continue
      const rect = table.cropRect.map((n) => n / frame.scale),
        sources = captionAnchorSourceItems(table, page.pageNumber)
      if (
        !valid(rect) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] > page.width ||
        rect[3] > page.height ||
        !sources
      )
        continue
      anchors.push({
        page: page.pageNumber,
        kind: 'table',
        caption: table.caption,
        rect,
        sourceItems: sources,
        rules,
        sourceOwner: table
      })
    }
    for (const figure of figures) {
      if (
        !figure ||
        figure.page !== page.pageNumber ||
        !figure.caption ||
        !valid(figure.region) ||
        figure.region.some((n) => n < 0 || n > 1) ||
        (figure.sourceItems !== undefined && !Array.isArray(figure.sourceItems))
      )
        continue
      anchors.push({
        page: page.pageNumber,
        kind: 'figure',
        caption: figure.caption,
        rect: figure.region.map((n, i) => n * (i % 2 ? page.height : page.width)),
        sourceItems: figure.sourceItems ?? [],
        sourceOwner: figure
      })
    }
    return anchors
  } catch {
    return []
  }
}
