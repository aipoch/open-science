/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import assert from 'node:assert/strict'
import { types } from 'node:util'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePageTextPacketInventory,
  nativeWholeCellInkPacket,
  nativePageTextPacketInventoryWithDualApiCertificate
} from './literature-pdf-figure-native-plot-labels.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { validateNativeGraphicalTableCropPng } from './literature-pdf-native-graphical-table-crop.mjs'
import {
  getPdfCropRasterProtectionFromPng,
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng
} from './literature-pdf-crop.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const textKey = (s) => s.replace(/\s/gu, '')

// This family has two complete ruled panels with diagonal headers, an explicit
// upper table caption and a separately proved following caption. It owns paint
// and whole native records, never inferred cells or a numeric reading order.
function plan(table, options) {
  const { page, tokens, context: c, captions, competingRects } = options ?? {}
  if (
    !valid(table?.rect) ||
    !table.caption ||
    table.nativeBody ||
    !page ||
    page.invalidGraphicsBounds !== 0 ||
    page.pageNumber !== table.caption.page ||
    c?.pageNumber !== page.pageNumber ||
    !/^[a-f\d]{64}$/u.test(c.sourceSha256) ||
    !Array.isArray(tokens) ||
    !Array.isArray(captions) ||
    !Array.isArray(competingRects) ||
    competingRects.some((r) => !valid(r)) ||
    !same(page.graphicsBounds, c.graphicsBounds)
  )
    return
  const packet = nativePageTextPacketInventory(page, tokens, c)
  if (!packet || packet.evidence.images.length) return
  const whole = nativeWholeCellInkPacket(page, tokens, c, {
    text: tokens.map((t) => t.text).join(''),
    sourceItems: tokens.map((t) => t.sourceItem),
    sourceRects: tokens.map((t) => t.rect)
  })
  if (!whole) return
  const styles = new Map(),
    state = { fill: '#000000', stroke: '#000000', ca: 1, CA: 1 },
    stack = []
  for (const [i, op] of c.operators.fnArray.entries()) {
    const a = c.operators.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      Object.assign(state, stack.pop())
    } else if (op === OPS.setFillRGBColor) state.fill = a[0]
    else if (op === OPS.setStrokeRGBColor) state.stroke = a[0]
    else if (op === OPS.setGState)
      for (const [k, v] of a[0]) if (k === 'ca' || k === 'CA') state[k] = v
    if (op === OPS.showText || op === OPS.constructPath) styles.set(i, { ...state })
  }
  if (stack.length) return
  const paths = []
  for (const [id, s] of whole.evidence.paths) {
    const a = c.operators.argsArray[id],
      q = Array.from(a?.[1]?.[0] ?? []),
      m = Util.transform(c.viewport.transform, s.transform)
    if (
      a?.[0] !== OPS.stroke ||
      q.length !== 6 ||
      q[0] !== 0 ||
      q[3] !== 1 ||
      !q.every(Number.isFinite) ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      !(m[0] > 0) ||
      m[3] !== -m[0] ||
      s.lineCap !== 0 ||
      s.solidStroke !== true ||
      s.strokeAlpha !== 1 ||
      styles.get(id)?.stroke !== '#000000' ||
      styles.get(id)?.CA !== 1
    )
      return
    const p = [q[1], q[2]],
      r = [q[4], q[5]]
    Util.applyTransform(p, m)
    Util.applyTransform(r, m)
    const dx = r[0] - p[0],
      dy = r[1] - p[1],
      length = Math.hypot(dx, dy),
      width = s.lineWidth * m[0]
    if (!(length > 0) || !(width > 0)) return
    const nx = ((-dy / length) * width) / 2,
      ny = ((dx / length) * width) / 2,
      points = [p, r].flatMap((t) => [
        [t[0] + nx, t[1] + ny],
        [t[0] - nx, t[1] - ny]
      ]),
      ink = union(points.map((p) => [...p, ...p]))
    if (!inside(s.clip, ink)) return
    paths.push({ id, segment: [...p, ...r], ink, width, horizontal: p[1] === r[1] })
  }
  const groups = new Map()
  for (const p of paths.filter((p) => p.horizontal)) {
    const k = JSON.stringify([p.segment[0], p.segment[2]])
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(p)
  }
  const candidateGroups = [...groups.values()].filter(
    (g) => g.length === 8 && over(table.rect, union(g.map((p) => p.ink)))
  )
  if (candidateGroups.length !== 1) return
  const rails = candidateGroups[0].toSorted((a, b) => a.segment[1] - b.segment[1]),
    railFrame = union(rails.map((p) => p.ink)),
    records = whole.records.filter((r) => inside(railFrame, r.rect)),
    wanted = new Set(records.map((r) => r.index))
  if (records.length < 12 || records.some((r) => !r.advanceComplete || !valid(r.ink))) return
  const panels = [0, 4].map((offset) => [
    railFrame[0],
    rails[offset].segment[1],
    railFrame[2],
    rails[offset + 3].segment[1]
  ])
  // Inter-panel prose is foreign even when it lies inside the parent's rails.
  // Both the source advance and all painted ink must belong to exactly one panel.
  if (
    records.some(
      (r) => panels.filter((panel) => inside(panel, r.rect) && inside(panel, r.ink)).length !== 1
    )
  )
    return
  const ownedPaths = paths.filter((p) =>
    inside(railFrame, [
      Math.min(p.segment[0], p.segment[2]),
      Math.min(p.segment[1], p.segment[3]),
      Math.max(p.segment[0], p.segment[2]),
      Math.max(p.segment[1], p.segment[3])
    ])
  )
  if (ownedPaths.length !== 10) return
  let mathematicalHeader = false
  for (const offset of [0, 4]) {
    const top = rails[offset].segment[1],
      titleEnd = rails[offset + 1].segment[1],
      headerEnd = rails[offset + 2].segment[1],
      bottom = rails[offset + 3].segment[1],
      title = records.filter((r) => r.rect[1] > top && r.rect[3] < titleEnd),
      diagonals = ownedPaths.filter(
        (p) =>
          !p.horizontal &&
          p.segment[0] === rails[0].segment[0] &&
          p.segment[1] > titleEnd &&
          p.segment[1] < headerEnd &&
          p.segment[2] > p.segment[0] &&
          p.segment[2] < rails[0].segment[2] &&
          p.segment[3] > p.segment[1] &&
          p.segment[3] <= headerEnd
      )
    if (
      !(top < titleEnd && titleEnd < headerEnd && headerEnd < bottom) ||
      title.length !== 1 ||
      !/[A-Za-z]/u.test(title[0].r.str) ||
      diagonals.length !== 1 ||
      records.filter((r) => r.rect[3] > headerEnd && r.rect[3] < bottom).length < 4
    )
      return
    const data = records.filter((r) => r.rect[3] > headerEnd && r.rect[3] < bottom)
    if (
      !data.some((r) => /\p{N}/u.test(r.r.str)) ||
      data.some((r) => !/^[\p{N}\p{Sm}.,()[\]{}−–—†‡%+\-/\s]+$/u.test(r.r.str))
    )
      return
    mathematicalHeader ||= records.some(
      (r) =>
        r.rect[3] > titleEnd &&
        r.rect[3] < headerEnd &&
        /^[\p{Script=Greek}\p{Sm}]$/u.test(r.r.str.trim())
    )
  }
  if (!mathematicalHeader) return
  const frame = union([railFrame, ...records.map((r) => r.ink), ...ownedPaths.map((p) => p.ink)]),
    crop = union([table.rect, frame])
  if (!inside([0, 0, page.width, page.height], crop)) return
  const glyphs = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
    owners = new Map()
  for (const r of whole.records)
    for (const g of new Set(r.part.map((p) => p.g))) {
      if (!owners.has(g)) owners.set(g, new Set())
      owners.get(g).add(r)
    }
  if (
    [...glyphs].some(
      (g) =>
        owners.get(g)?.size !== 1 ||
        styles.get(g.i)?.fill !== '#000000' ||
        styles.get(g.i)?.ca !== 1
    )
  )
    return
  const local = captions.filter((cap) => cap.page === page.pageNumber && valid(cap.rect)),
    current = local.filter(
      (cap) => same(cap.rect, table.caption.rect) && same(cap.lines, table.caption.lines)
    )
  if (current.length !== 1 || !/^Table\s+\d+[.:\s]/iu.test(current[0].lines?.[0] ?? '')) return
  const following = local
    .filter((cap) => cap.rect[1] > frame[3])
    .toSorted((a, b) => a.rect[1] - b.rect[1])[0]
  if (!following) return
  const captionDomains = [current[0], following].map((cap) => {
    const rs = whole.records.filter((r) => inside(cap.rect, r.rect))
    if (
      !rs.length ||
      rs.some((r) => !r.advanceComplete) ||
      textKey(rs.map((r) => r.r.str).join('')) !== textKey(cap.lines.join(''))
    )
      return
    return {
      indices: new Set(rs.map((r) => r.index)),
      bound: union([cap.rect, ...rs.flatMap((r) => [r.rect, r.ink])])
    }
  })
  if (
    captionDomains.some((c) => !c) ||
    captionDomains[0].bound[3] >= frame[1] ||
    captionDomains[1].bound[1] <= frame[3]
  )
    return
  const captionIds = new Set(captionDomains.flatMap((c) => [...c.indices])),
    lane = [0, captionDomains[0].bound[3], page.width, captionDomains[1].bound[1]],
    foreignRecords = whole.records.filter((r) => !wanted.has(r.index)),
    foreignPaths = paths.filter((p) => !ownedPaths.includes(p)),
    foreignGlyphs = whole.glyphs.filter((g) => !glyphs.has(g))
  if (
    competingRects.some((r) => over(r, crop)) ||
    local.some((cap) => over(cap.rect, crop)) ||
    foreignRecords.some(
      (r) =>
        over(crop, r.rect) ||
        over(crop, r.ink) ||
        (!captionIds.has(r.index) && (over(lane, r.rect) || over(lane, r.ink)))
    ) ||
    foreignPaths.some((p) => over(crop, p.ink) || over(lane, p.ink)) ||
    foreignGlyphs.some((g) => over(crop, g.ink))
  )
    return
  return {
    crop,
    records,
    glyphs: [...glyphs],
    paths: ownedPaths,
    proof: {
      nativeCrop: crop,
      bounds: { width: page.width, height: page.height },
      foreignPaints: foreignPaths.map((p) => p.ink),
      foreignGlyphs: foreignGlyphs.map((g) => g.ink)
    }
  }
}

function completeRaster(png, p) {
  let initialRaster
  if (p.initialRaster) {
    initialRaster = getInitialPdfCropRaster(p.crop, p.proof.bounds)
    if (
      !initialRaster ||
      !same(initialRaster, p.initialRaster) ||
      !matchesInitialPdfCropPng(png, initialRaster) ||
      [...p.proof.foreignPaints, ...p.proof.foreignGlyphs].some(
        (r) => !valid(r) || over(r, initialRaster.protection)
      )
    )
      return false
  } else if (!validateNativeGraphicalTableCropPng(png, p.proof)) return false
  return loadImage(png).then((image) => {
    const raster = initialRaster
      ? { ...initialRaster, scaleLower: initialRaster.scale, scaleUpper: initialRaster.scale }
      : getPdfCropRasterProtectionFromPng(png, p.crop, p.proof.bounds)
    if (!raster || image.width !== raster.pixelWidth || image.height !== raster.pixelHeight)
      return false
    const canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext('2d')
    try {
      ctx.drawImage(image, 0, 0)
      const rgba = ctx.getImageData(0, 0, image.width, image.height).data,
        s = raster.scaleLower,
        black = (x, y) => {
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
          const i = (y * image.width + x) * 4
          return rgba[i + 3] === 255 && Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) < 200
        }
      const hit = (ink) => {
        for (
          let y = Math.max(0, Math.ceil((ink[1] - p.crop[1]) * raster.scaleUpper - 0.5));
          y <= Math.min(image.height - 1, Math.floor((ink[3] - p.crop[1]) * s - 0.5));
          y++
        )
          for (
            let x = Math.max(0, Math.ceil((ink[0] - p.crop[0]) * raster.scaleUpper - 0.5));
            x <= Math.min(image.width - 1, Math.floor((ink[2] - p.crop[0]) * s - 0.5));
            x++
          )
            if (black(x, y)) return true
        return false
      }
      if (p.glyphs.some((g) => !hit(g.ink))) return false
      return p.paths.every((path) => {
        const [x0, y0, x1, y1] = path.segment,
          length = Math.hypot(x1 - x0, y1 - y0),
          steps = Math.ceil(length * raster.scaleUpper)
        for (let i = 0; i <= steps; i++) {
          const t = i / steps,
            x = x0 + (x1 - x0) * t,
            y = y0 + (y1 - y0) * t
          if (
            !hit([x - path.width / 2, y - path.width / 2, x + path.width / 2, y + path.width / 2])
          )
            return false
        }
        return true
      })
    } finally {
      canvas.width = canvas.height = 1
    }
  })
}

export async function retainCaptionedRuledMathTableBody(table, options, renderCrop) {
  try {
    if (typeof renderCrop !== 'function') return
    const certified = sourceFencedSeeds.get(table)
    if (certified) return await retainSourceFencedBody(table, options, renderCrop, certified)
    const unchanged = retainNativeRecoveryInputs([table, options], options?.context?.viewport)
    if (!unchanged) return
    const p = plan(table, options)
    if (!p) return
    const bytes = await renderCrop([...p.crop])
    if (!(bytes instanceof Uint8Array) || !unchanged()) return
    const png = Buffer.from(bytes)
    if (!(await completeRaster(png, p)) || !unchanged()) return
    return {
      table: {
        ...table,
        rect: p.crop,
        nativeBody: {
          kind: 'math-table',
          sourceItems: p.records.map((r) => ({
            pageNumber: options.page.pageNumber,
            index: r.index,
            text: r.r.str
          }))
        }
      },
      png
    }
  } catch {
    return
  }
}

const sourceFencedSeeds = new WeakMap()

// Source-fenced mathematical bodies are independent of the older two-panel
// contract above. Only the original seed identity can consume the certificate.
export function recoverCaptionedNativeMathematicalBodies(options) {
  try {
    if (!options || types.isProxy(options)) return []
    const context = Object.getOwnPropertyDescriptor(options, 'context')?.value
    if (!context || types.isProxy(context)) return []
    const viewport = Object.getOwnPropertyDescriptor(context, 'viewport')?.value,
      originalCurrent = retainNativeRecoveryInputs([options], viewport),
      current =
        originalCurrent ??
        retainNativeRecoveryInputs([options], viewport, sourceBodySecondaryViewport(context))
    if (!current) return []
    const { page, tokens, captions, competingRects, dualApiEvidence } = options
    assert(
      page?.invalidGraphicsBounds === 0 &&
        page.pageNumber === context.pageNumber &&
        /^[a-f\d]{64}$/u.test(context.sourceSha256) &&
        page.width === viewport.width &&
        page.height === viewport.height &&
        viewport.rotation === 0 &&
        viewport.scale === 1 &&
        same(page.graphicsBounds, context.graphicsBounds) &&
        Array.isArray(tokens) &&
        Array.isArray(captions) &&
        Array.isArray(competingRects) &&
        competingRects.every(valid)
    )
    let packet
    if (dualApiEvidence) {
      const v = dualApiEvidence.renderContext?.viewport
      assert(
        v &&
          same(v.transform, viewport.transform) &&
          v.width === viewport.width &&
          v.height === viewport.height &&
          v.rotation === viewport.rotation &&
          v.scale === viewport.scale
      )
      // The explicit certificate compares canonical captured viewport values;
      // PageViewport's unrelated own fields grant no additional authority.
      const canonical = {
        ...v,
        convertToViewportPoint: (x, y) => [
          v.transform[0] * x + v.transform[2] * y + v.transform[4],
          v.transform[1] * x + v.transform[3] * y + v.transform[5]
        ]
      }
      packet = nativePageTextPacketInventoryWithDualApiCertificate(
        page,
        tokens,
        { ...context, viewport: canonical },
        dualApiEvidence,
        true
      )
    } else {
      packet = nativeWholeCellInkPacket(page, tokens, context, {
        text: tokens.map((token) => token.text).join(''),
        sourceItems: tokens.map((token) => token.sourceItem),
        sourceRects: tokens.map((token) => token.rect)
      })
    }
    if (!packet || !current()) return []
    const plans = sourceFencedBodyPlans({ page, packet, captions, context })
    return (
      plans
        // An actual secondary viewport only opens the new fully proved family.
        // Existing families keep their original constructor admission unchanged.
        .filter((p) => originalCurrent || p.family === 'captioned-two-rail-coefficient-body')
        .filter((p) => !competingRects.some((r) => over(r, p.crop)))
        .map((p) => {
          const seed = { rect: [...p.crop], caption: p.caption }
          const seedCurrent = retainNativeRecoveryInputs([seed], viewport)
          assert(seedCurrent)
          sourceFencedSeeds.set(seed, {
            plan: p,
            page,
            tokens,
            context,
            captions,
            current: () => current() && seedCurrent()
          })
          return seed
        })
    )
  } catch {
    return []
  }
}

async function retainSourceFencedBody(seed, options, renderCrop, certificate) {
  const { plan: p } = certificate
  if (
    !certificate.current() ||
    options?.page !== certificate.page ||
    options.tokens !== certificate.tokens ||
    options.context !== certificate.context ||
    options.captions !== certificate.captions ||
    !Array.isArray(options.competingRects) ||
    options.competingRects.some((r) => !valid(r) || over(r, p.crop))
  )
    return
  const unchanged = retainNativeRecoveryInputs(
    [seed, options],
    options.context.viewport,
    sourceBodySecondaryViewport(options.context)
  )
  if (!unchanged) return
  const bytes = await renderCrop([...p.crop])
  if (!(bytes instanceof Uint8Array) || !unchanged() || !certificate.current()) return
  const png = Buffer.from(bytes),
    sealed = Buffer.from(png)
  if (!(await completeRaster(png, p)) || !unchanged() || !certificate.current()) return
  const table = {
    ...seed,
    rect: [...p.crop],
    nativeBody: {
      kind: 'math-table',
      sourceItems: p.records.map((record) => ({
        pageNumber: options.page.pageNumber,
        index: record.index,
        text: record.r.str
      }))
    }
  }
  const outputCurrent = retainNativeRecoveryInputs([table], options.context.viewport)
  if (!outputCurrent) return
  const current = () =>
    unchanged() && certificate.current() && outputCurrent() && png.equals(sealed)
  return current() ? { table, png, current } : undefined
}

const sourceBodyValid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const sourceBodyInside = (r, domain) =>
  r.every((n, i) => (i < 2 ? n >= domain[i] - 1e-6 : n <= domain[i] + 1e-6))
const sourceBodyOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const sourceBodyUnion = (boxes) => [
  Math.min(...boxes.map((r) => r[0])),
  Math.min(...boxes.map((r) => r[1])),
  Math.max(...boxes.map((r) => r[2])),
  Math.max(...boxes.map((r) => r[3]))
]
const sourceBodyCompact = (text) => text.replace(/\s/gu, '')
const sourceBodyGlyphInk = (record) =>
  sourceBodyUnion(record.part.map((part) => part.g.ink).filter(sourceBodyValid))
function sourceBodyAxisPaths(packet) {
  const colors = new Map(),
    stack = []
  let color = '#000000'
  for (const [index, op] of packet.o.fnArray.entries()) {
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      assert(stack.length)
      color = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) color = packet.o.argsArray[index][0]
    if (op === OPS.constructPath) colors.set(index, color)
  }
  assert.equal(stack.length, 0)
  return [...packet.evidence.paths].map(([id, state]) => {
    const args = packet.o.argsArray[id],
      command = Array.from(args?.[1]?.[0] ?? []),
      m = Util.transform(packet.v.transform, state.transform)
    assert(
      args[0] === OPS.stroke &&
        command.length === 6 &&
        command[0] === 0 &&
        command[3] === 1 &&
        command.every(Number.isFinite)
    )
    assert(
      m[1] === 0 &&
        m[2] === 0 &&
        m[0] > 0 &&
        m[3] === -m[0] &&
        state.lineCap === 0 &&
        state.solidStroke &&
        state.strokeAlpha === 1 &&
        colors.get(id) === '#000000'
    )
    const a = [command[1], command[2]],
      b = [command[4], command[5]]
    Util.applyTransform(a, m)
    Util.applyTransform(b, m)
    assert(a[0] === b[0] || a[1] === b[1])
    const width = state.lineWidth * m[0],
      horizontal = a[1] === b[1]
    assert(width > 0 && width < 2)
    const ink = horizontal
      ? [Math.min(a[0], b[0]), a[1] - width / 2, Math.max(a[0], b[0]), a[1] + width / 2]
      : [a[0] - width / 2, Math.min(a[1], b[1]), a[0] + width / 2, Math.max(a[1], b[1])]
    assert(sourceBodyValid(ink) && sourceBodyInside(ink, state.clip))
    return { id, segment: [...a, ...b], width, ink, horizontal, clip: state.clip }
  })
}
function sourceFencedBodyPlans({ page, packet, captions, context }) {
  assert(packet && packet.evidence.images.length === 0)
  const records = packet.records,
    paths = sourceBodyAxisPaths(packet),
    plans = []
  assert(
    records.every(
      (record) =>
        record.advanceComplete &&
        sourceBodyValid(record.rect) &&
        sourceBodyValid(sourceBodyGlyphInk(record))
    )
  )
  const caps = captions
    .filter(
      (cap) => cap.page === page.pageNumber && /^Table\s+\d+\s*:/iu.test(cap.lines?.[0] ?? '')
    )
    .map((caption) => {
      const owners = records.filter((record) => sourceBodyInside(record.rect, caption.rect))
      assert(
        owners.length &&
          sourceBodyCompact(owners.map((record) => record.r.str).join('')) ===
            sourceBodyCompact(caption.lines.join(''))
      )
      return {
        caption,
        owners,
        lo: Math.min(...owners.map((record) => record.index)),
        hi: Math.max(...owners.map((record) => record.index))
      }
    })
    .sort((a, b) => a.caption.rect[1] - b.caption.rect[1])
  const captionIds = new Set(caps.flatMap((cap) => cap.owners.map((record) => record.index))),
    short = (record) => !/[A-Za-z]{4,}/u.test(record.r.str),
    rest = records.filter((record) => !captionIds.has(record.index)),
    footer = rest.filter(
      (record) => record.r.str === String(page.pageNumber) && record.rect[1] > page.height * 0.85
    ),
    footerIds = new Set(footer.map((record) => record.index))
  const add = (family, cap, owned, ownedPaths, extra = {}) => {
    assert(owned.length >= 8 && ownedPaths.length)
    assert(new Set(owned.map((record) => record.index)).size === owned.length)
    const glyphs = [...new Set(owned.flatMap((record) => record.part.map((part) => part.g)))],
      glyphSet = new Set(glyphs),
      native = sourceBodyUnion([
        ...owned.map((record) => record.rect),
        ...glyphs.map((glyph) => glyph.ink),
        ...ownedPaths.map((p) => p.ink)
      ]),
      padding = 2 / 1.5,
      crop = native.map((n, index) => n + (index < 2 ? -padding : padding)),
      foreignRecords = records.filter((record) => !owned.includes(record)),
      foreignGlyphs = packet.glyphs.filter(
        (glyph) => !glyphSet.has(glyph) && sourceBodyValid(glyph.ink)
      ),
      foreignPaths = paths.filter((p) => !ownedPaths.includes(p))
    assert(sourceBodyInside(crop, [0, 0, page.width, page.height]))
    assert(
      foreignRecords.every(
        (record) =>
          !sourceBodyOverlap(crop, record.rect) &&
          !sourceBodyOverlap(crop, sourceBodyGlyphInk(record))
      )
    )
    assert(
      foreignGlyphs.every(
        (glyph) =>
          !sourceBodyOverlap(
            crop,
            glyph.ink.map((n, i) => n + (i < 2 ? -1 / 1.5 : 1 / 1.5))
          )
      )
    )
    assert(
      foreignPaths.every(
        (path) =>
          !sourceBodyOverlap(
            crop,
            path.ink.map((n, i) => n + (i < 2 ? -1 / 1.5 : 1 / 1.5))
          )
      )
    )
    plans.push({
      family,
      crop,
      records: owned,
      glyphs,
      paths: ownedPaths,
      caption: cap.caption,
      proof: {
        nativeCrop: crop,
        bounds: { width: page.width, height: page.height },
        foreignPaints: foreignPaths.map((p) => p.ink),
        foreignGlyphs: foreignGlyphs.map((glyph) => glyph.ink)
      },
      ...extra
    })
  }
  // A table-only mathematical page can contain several separately captioned
  // arrays. Full caption packets and the page boundary fence each whole source
  // interval. No row, column or mathematical reading order is constructed.
  if (
    caps.length >= 2 &&
    caps.length <= 4 &&
    footer.length === 1 &&
    rest.every((record) => footerIds.has(record.index) || short(record))
  ) {
    const numbers = caps.map((cap) => Number(/^Table\s+(\d+)/iu.exec(cap.caption.lines[0])[1]))
    assert(numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1))
    const consumed = new Set()
    for (const [index, cap] of caps.entries()) {
      const lower = index ? caps[index - 1].caption.rect[3] : 0,
        upper = cap.caption.rect[1],
        own = rest.filter(
          (record) =>
            !footerIds.has(record.index) && record.rect[1] > lower && record.rect[3] < upper
        ),
        ownedPaths = paths.filter((path) => path.ink[1] > lower && path.ink[3] < upper)
      assert(own.every((record) => !/[A-Za-z]{2,}/u.test(record.r.str.normalize('NFKC'))))
      assert(
        own.filter((record) => /\p{Script=Greek}/u.test(record.r.str.normalize('NFKC'))).length >= 2
      )
      assert(
        own.every(
          (record) => record.index > (index ? caps[index - 1].hi : -1) && record.index < cap.lo
        )
      )
      assert(
        ownedPaths.some((path) => path.horizontal) &&
          ownedPaths.filter((path) => !path.horizontal).length >= 2
      )
      own.forEach((record) => consumed.add(record.index))
      add('caption-fenced-mathematical-table-only-page', cap, own, ownedPaths)
    }
    assert(rest.every((record) => footerIds.has(record.index) || consumed.has(record.index)))
    assert(paths.every((path) => plans.some((plan) => plan.paths.includes(path))))
  }
  // A single header rail and repeated native symbolic rows provide a separate
  // complete body between an upper caption and the following ordinary prose.
  if (caps.length === 1) {
    const cap = caps[0],
      after = records.filter((record) => record.index > cap.hi),
      nextProse = after.find((record) => !short(record))
    if (nextProse) {
      const own = after.filter((record) => record.index < nextProse.index),
        lo = Math.min(...own.map((record) => record.rect[1])),
        hi = Math.max(...own.map((record) => record.rect[3])),
        ownedPaths = paths.filter((path) => path.ink[1] > lo && path.ink[3] < hi),
        h = Math.max(...own.map((record) => record.r.height))
      if (own.length && own.every(short) && ownedPaths.length === 1 && ownedPaths[0].horizontal) {
        const rail = ownedPaths[0],
          body = own.filter((record) => record.rect[3] > rail.segment[1]),
          baselines = [...new Set(body.map((record) => record.rect[3]))].sort((a, b) => a - b),
          rows = baselines.map((baseline) =>
            body.filter((record) => Math.abs(record.rect[3] - baseline) < 1e-5)
          ),
          stubs = rows.map((row) =>
            row
              .filter(
                (record) =>
                  /^\p{L}$/u.test(record.r.str) &&
                  record.rect[2] < rail.segment[0] + (rail.segment[2] - rail.segment[0]) * 0.4
              )
              .sort((a, b) => a.rect[0] - b.rect[0])
          )
        assert(rows.length >= 4 && stubs.every((row) => row.length === 3))
        assert(
          stubs.every((row) =>
            row.every(
              (record, column) => Math.abs(record.rect[0] - stubs[0][column].rect[0]) < h * 0.05
            )
          )
        )
        assert(rows.every((row) => row.some((record) => /[+−]/u.test(record.r.str))))
        assert(
          own.every(
            (record) => record.rect[0] >= rail.segment[0] && record.rect[2] <= rail.segment[2]
          )
        )
        assert(own.some((record) => record.rect[3] < rail.segment[1] && /[≡=]/u.test(record.r.str)))
        assert(lo > cap.caption.rect[3] && nextProse.rect[1] > hi)
        add('upper-caption-single-header-symbolic-body', cap, own, ownedPaths, {
          symbolicRows: rows.length
        })
      }
    }
  }
  // Explicitly captioned, fully painted horizontal frames own every complete
  // native mathematical program between their opening and closing operations.
  // Full advances can slightly overhang a rail; they are retained in the crop.
  if (caps.length === 1 && !plans.length) {
    const groups = new Map()
    for (const p of paths.filter((path) => path.horizontal)) {
      const k = JSON.stringify([p.segment[0], p.segment[2]])
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(p)
    }
    const candidates = [...groups.values()].filter(
      (group) => group.length >= 3 && group.length <= 8
    )
    if (candidates.length === 1) {
      const rails = candidates[0].toSorted((a, b) => a.segment[1] - b.segment[1]),
        first = rails[0],
        last = rails.at(-1),
        frame = sourceBodyUnion(rails.map((rail) => rail.ink)),
        cap = caps[0],
        own = records.filter((record) =>
          record.part.every(
            (part) =>
              part.g.i > first.id && part.g.i < last.id && sourceBodyInside(part.g.ink, frame)
          )
        ),
        ownedPaths = paths.filter((path) => path.id >= first.id && path.id <= last.id),
        h = Math.max(...own.map((record) => record.r.height))
      assert(first.id < last.id && own.length >= 12)
      assert(ownedPaths.every((path) => sourceBodyInside(path.ink, frame)))
      assert(own.filter((record) => /[≤≥=<>]/u.test(record.r.str)).length >= 3)
      assert(own.filter((record) => /\p{Script=Greek}/u.test(record.r.str)).length >= 3)
      assert(own.some((record) => record.r.height < h * 0.85))
      assert(cap.caption.rect[1] > frame[3] && cap.caption.rect[1] - frame[3] < h * 6)
      const end = Math.max(...own.map((record) => record.index))
      assert(cap.lo > end && !records.some((record) => record.index > end && record.index < cap.lo))
      add('closed-rule-captioned-mathematical-body', cap, own, ownedPaths)
    }
  }
  return plans.length
    ? plans
    : sourceTwoRailCoefficientBody({ page, packet, captions, context }, paths)
}
// This is a separate complete topology, not an open-frame exemption for the
// older families. It produces a whole native image and no row/cell assignments.
function sourceTwoRailCoefficientBody({ page, packet, captions, context }, paths) {
  const records = packet.records,
    local = captions.filter((cap) => cap.page === page.pageNumber && sourceBodyValid(cap.rect))
  if (local.length !== 1 || !/^Table\s+\d+\.\s/u.test(local[0].lines?.[0] ?? '')) return []
  const caption = local[0],
    cap = records.filter((record) => sourceBodyInside(record.rect, caption.rect))
  if (!cap.length || !/^Table\s+\d+\.$/u.test(cap[0].r.str)) return []
  // Reuse the original presentation routine, including its existing script
  // position rules. Neither Source literals nor advance rectangles are changed.
  const origins = new Map(),
    lines = records.map((r) => ({
      text: r.r.str,
      x: r.rect[0],
      y: r.rect[1],
      width: r.rect[2] - r.rect[0],
      height: r.r.height,
      fontSize: r.r.height,
      record: r
    })),
    runs = groupPageLines({ ...page, lines }, [], origins),
    capRuns = runs.filter((run) => origins.get(run)?.some((line) => cap.includes(line.record)))
  if (
    !capRuns.length ||
    capRuns.some((run) => origins.get(run).some((line) => !cap.includes(line.record))) ||
    !same(
      capRuns.flatMap((run) => origins.get(run).map((line) => line.record.index)),
      cap.map((r) => r.index)
    ) ||
    sourceBodyCompact(capRuns.map((run) => run.text).join('')) !==
      sourceBodyCompact(caption.lines.join(''))
  )
    return []
  const groups = new Map()
  for (const path of paths.filter((p) => p.horizontal)) {
    const key = JSON.stringify([path.segment[0], path.segment[2]])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(path)
  }
  const pairs = [...groups.values()].filter((group) => group.length === 2)
  if (pairs.length !== 1) return []
  const rails = pairs[0].toSorted((a, b) => a.segment[1] - b.segment[1]),
    left = rails[0].segment[0],
    right = rails[0].segment[2],
    stubs = paths
      .filter(
        (p) =>
          !p.horizontal && p.segment[0] > left && p.segment[0] < right && p.ink[3] < caption.rect[3]
      )
      .toSorted((a, b) => a.ink[1] - b.ink[1])
  if (
    stubs.length !== 5 ||
    stubs.some((p) => p.segment[0] !== stubs[0].segment[0] || p.width !== stubs[0].width) ||
    stubs.some(
      (p, i) => i && (p.ink[1] <= stubs[i - 1].ink[1] || p.ink[3] <= stubs[i - 1].ink[3])
    ) ||
    !(stubs[0].ink[3] < rails[0].segment[1] && rails[0].segment[1] < stubs[1].ink[1]) ||
    !(stubs[3].ink[3] < rails[1].segment[1] && rails[1].segment[1] < stubs[4].ink[1])
  )
    return []
  const frame = [left, stubs[0].ink[1], right, stubs[4].ink[3]],
    own = records.filter((r) => sourceBodyInside(sourceBodyGlyphInk(r), frame)),
    ownPaths = [...rails, ...stubs],
    rowOf = (r) =>
      stubs.flatMap((stub, i) =>
        sourceBodyInside(sourceBodyGlyphInk(r), [left, stub.ink[1], right, stub.ink[3]]) ? [i] : []
      ),
    divider = stubs[0].segment[0]
  if (
    own.length < 19 ||
    own.some((r) => rowOf(r).length !== 1) ||
    own.some((r) => {
      const style = context?.content?.styles?.[r.r.fontName]
      return (
        !style ||
        style.vertical !== false ||
        !(style.ascent > 0 && style.ascent <= 1 && style.descent >= -1 && style.descent <= 0)
      )
    }) ||
    own.some((r) => r.index >= cap[0].index) ||
    records.some(
      (r) => r.index >= own[0].index && r.index <= own.at(-1).index && !own.includes(r)
    ) ||
    records.some((r) => r.index > own.at(-1).index && r.index < cap[0].index)
  )
    return []
  const header = own.filter((r) => rowOf(r)[0] === 0),
    headerRuns = runs.filter((run) =>
      origins.get(run)?.some((line) => header.includes(line.record))
    ),
    data = own.filter((r) => rowOf(r)[0] > 0),
    values = data.filter((r) => sourceBodyGlyphInk(r)[0] > divider)
  if (
    headerRuns.length !== 3 ||
    headerRuns.some((run) => origins.get(run).some((line) => !header.includes(line.record))) ||
    header.some((r) => sourceBodyGlyphInk(r)[0] <= divider) ||
    values.some(
      (r) =>
        !/^[\p{N}\p{Sm}A-Za-z\p{Script=Greek}.,()[\]{}−–—+\-/\s]+$/u.test(r.r.str) ||
        /[A-Za-z]{2,}/u.test(r.r.str)
    ) ||
    values.filter((r) => /[A-Za-z\p{Script=Greek}]/u.test(r.r.str)).length < 6 ||
    values.filter((r) => /\p{N}/u.test(r.r.str)).length < 6 ||
    values.filter((r) => /[+−]/u.test(r.r.str)).length < 3 ||
    [1, 2, 3, 4].some((i) => values.filter((r) => rowOf(r)[0] === i).length < 3) ||
    [1, 2, 3, 4].some(
      (i) => !data.some((r) => rowOf(r)[0] === i && sourceBodyGlyphInk(r)[2] < divider)
    ) ||
    data.some(
      (r) =>
        sourceBodyGlyphInk(r)[2] < divider && !/^[\p{N}A-Za-z\p{Script=Greek}]+$/u.test(r.r.str)
    )
  )
    return []
  const glyphs = [...new Set(own.flatMap((r) => r.part.map((p) => p.g)))],
    glyphSet = new Set(glyphs)
  if (glyphs.some((g) => records.filter((r) => r.part.some((p) => p.g === g)).length !== 1))
    return []
  const native = sourceBodyUnion([
      ...own.map((r) => r.rect),
      ...glyphs.map((g) => g.ink),
      ...ownPaths.map((p) => p.ink)
    ]),
    crop = native.map((n, i) => (i === 3 ? n : n + (i < 2 ? -2 / 1.5 : 2 / 1.5))),
    raster = getInitialPdfCropRaster(crop, { width: page.width, height: page.height }),
    foreign = records.filter((r) => !own.includes(r)),
    foreignGlyphs = packet.glyphs.filter((g) => !glyphSet.has(g) && sourceBodyValid(g.ink)),
    foreignPaths = paths.filter((p) => !ownPaths.includes(p))
  if (
    !raster ||
    !sourceBodyInside(crop, [0, 0, page.width, page.height]) ||
    foreign.some(
      (r) =>
        (!cap.includes(r) && sourceBodyOverlap(crop, r.rect)) ||
        sourceBodyOverlap(crop, sourceBodyGlyphInk(r))
    ) ||
    foreignGlyphs.some((g) => sourceBodyOverlap(raster.protection, g.ink)) ||
    foreignPaths.some((p) => sourceBodyOverlap(raster.protection, p.ink)) ||
    ownPaths.some((p) => !sourceBodyInside(p.ink, crop)) ||
    glyphs.some((g) => !sourceBodyInside(g.ink, crop))
  )
    return []
  return [
    {
      family: 'captioned-two-rail-coefficient-body',
      crop,
      records: own,
      glyphs,
      paths: ownPaths,
      caption,
      initialRaster: raster,
      proof: {
        nativeCrop: crop,
        bounds: { width: page.width, height: page.height },
        foreignPaints: foreignPaths.map((p) => p.ink),
        foreignGlyphs: foreignGlyphs.map((g) => g.ink)
      }
    }
  ]
}

// Bind the actual optional native witness viewport; never manufacture a plain
// substitute or omit the surrounding complete Source/options graph.
function sourceBodySecondaryViewport(context) {
  const witness = Object.getOwnPropertyDescriptor(context, 'runningHeadWitness')?.value
  if (!witness || typeof witness !== 'object' || types.isProxy(witness)) return
  return Object.getOwnPropertyDescriptor(witness, 'witnessViewport')?.value
}

import {
  nativeCaptionedThreeRulePixelCrop,
  nativeCaptionedThreeRulePixelCurrent,
  nativeCaptionedThreeRulePixelPngSafe
} from './literature-pdf-figure-native-plot-labels.mjs'

// Image-only retention never enters the mathematical Source-body constructor.
export function recoverCaptionedNativeThreeRulePixelTable(options) {
  return nativeCaptionedThreeRulePixelCrop(
    options?.page,
    options?.tokens,
    options?.context,
    options?.captions,
    options?.competingRects
  )
}
export function captionedNativeThreeRulePixelTableCurrent(table, page) {
  return nativeCaptionedThreeRulePixelCurrent(table, page)
}
export function captionedNativeThreeRulePixelTablePngSafe(table, png, rect, page) {
  return nativeCaptionedThreeRulePixelPngSafe(table, png, rect, page)
}
