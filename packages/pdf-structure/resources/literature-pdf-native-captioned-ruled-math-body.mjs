/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePageTextPacketInventory,
  nativeWholeCellInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { validateNativeGraphicalTableCropPng } from './literature-pdf-native-graphical-table-crop.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

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
  if (!validateNativeGraphicalTableCropPng(png, p.proof)) return false
  return loadImage(png).then((image) => {
    const raster = getPdfCropRasterProtectionFromPng(png, p.crop, p.proof.bounds)
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
