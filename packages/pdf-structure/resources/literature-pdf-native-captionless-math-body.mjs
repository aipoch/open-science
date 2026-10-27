/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { getInitialPdfCropRaster, matchesInitialPdfCropPng } from './literature-pdf-crop.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => a.every((x, i) => (i < 2 ? x >= b[i] : x <= b[i]))
const over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const binding = (table, options) =>
  JSON.stringify([table, options], (_key, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value
  )

// Every non-rail paint remains foreign, with conservative stroke/clip bounds.
function paints(packet) {
  let color = '#000000'
  const colors = new Map(),
    stack = [],
    result = []
  for (const [i, op] of packet.o.fnArray.entries()) {
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) color = stack.pop()
    else if (op === OPS.setStrokeRGBColor) color = packet.o.argsArray[i][0]
    if (op === OPS.constructPath) colors.set(i, color)
  }
  for (const [id, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[id],
      cmd = a?.[1]?.[0]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0]) || a?.[2] === null) continue
    const m = Util.transform(packet.v.transform, state.transform),
      axis =
        a[0] === OPS.stroke &&
        cmd?.length === 6 &&
        cmd[0] === 0 &&
        cmd[3] === 1 &&
        cmd[2] === cmd[5] &&
        m[1] === 0 &&
        m[2] === 0 &&
        m[0] > 0 &&
        m[3] < 0,
      segment = axis
        ? [cmd[1] * m[0] + m[4], cmd[2] * m[3] + m[5], cmd[4] * m[0] + m[4], cmd[5] * m[3] + m[5]]
        : undefined,
      width = state.lineWidth * Math.max(Math.abs(m[0]), Math.abs(m[3])),
      stroke = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      pad = stroke ? (state.lineWidth * Math.max(1, packet.strokeMargins.get(id) ?? 10)) / 2 : 0,
      bounds = axis
        ? [
            Math.min(segment[0], segment[2]),
            segment[1] - width / 2,
            Math.max(segment[0], segment[2]),
            segment[3] + width / 2
          ]
        : packet.box(
            Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
            m
          ),
      eligible =
        axis &&
        segment[0] < segment[2] &&
        width > 0 &&
        state.lineCap === 0 &&
        state.solidStroke === true &&
        state.strokeAlpha === 1 &&
        colors.get(id) === '#000000' &&
        inside(bounds, state.clip)
    result.push({ id, segment, width, bounds, clip: state.clip, eligible })
  }
  return result
}

function bodyPlan(table, options) {
  const { page, tokens, nativeContext: c, competingRects, captionRects } = options ?? {},
    v = c?.viewport,
    scale = table?.sourceViewport?.scale
  if (
    !table ||
    table.caption ||
    table.parts ||
    table.cropRects ||
    table.notes?.length ||
    table.unassigned?.length ||
    table.clipped?.length ||
    table.reviewCandidate !== false ||
    !table.issues?.length ||
    !valid(table.cropRect) ||
    !table.grid?.length ||
    !table.cells?.length ||
    table.cells.some((cell) => cell.sourceSegments?.length) ||
    !table.cells.some((cell) => cell.textRuns?.some((r) => r.position !== 'normal')) ||
    !page ||
    page.pageNumber !== table.page ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(tokens) ||
    !c ||
    c.pageNumber !== table.page ||
    !/^[a-f\d]{64}$/u.test(c.sourceSha256) ||
    v?.rotation !== 0 ||
    v.scale !== 1 ||
    !equal(v.transform, [1, 0, 0, -1, 0, v.height]) ||
    page.width !== v.width ||
    page.height !== v.height ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    table.sourceViewport.width !== v.width * scale ||
    table.sourceViewport.height !== v.height * scale ||
    !Array.isArray(competingRects) ||
    !Array.isArray(captionRects) ||
    [...competingRects, ...captionRects].some((r) => !valid(r))
  )
    return
  const crop = table.cropRect.map((x) => x / scale),
    raster = getInitialPdfCropRaster(crop, page)
  if (!raster || [...competingRects, ...captionRects].some((r) => over(r, raster.protection)))
    return
  const families = new Map()
  for (const r of collectTableRules(c.operators, v).filter(
    (r) => r[1] === r[3] && r[0] < r[2] && inside(r, crop)
  )) {
    const key = JSON.stringify([r[0], r[2]])
    if (!families.has(key)) families.set(key, [])
    families.get(key).push(r)
  }
  const found = [...families.values()].filter((rs) => rs.length === 3)
  if (found.length !== 1) return
  const rails = found[0].toSorted((a, b) => a[1] - b[1]),
    frame = [rails[0][0], rails[0][1], rails[0][2], rails[2][1]],
    owned = tokens.filter(
      (t) =>
        t.text?.trim() &&
        t.horizontal &&
        t.rect[0] >= frame[0] &&
        t.rect[2] <= frame[2] &&
        t.baseline > frame[1] &&
        t.baseline < frame[3]
    ),
    body = owned.filter((t) => t.baseline > rails[1][1]),
    height = Math.max(...owned.map((t) => t.height)),
    sources = owned.map((t) => t.sourceItem)
  // Indexed symbolic bodies have real smaller scripts and native numeric stubs.
  // This recognizes ownership; it constructs no row or column arrangement.
  if (
    !owned.length ||
    owned.length > 512 ||
    body.some((t) => /[A-Za-z]{4,}/u.test(t.text)) ||
    body.filter((t) => /^\d+$/u.test(t.text)).length < 2 ||
    body.filter((t) => /^\p{L}$/u.test(t.text) && t.height < height).length < 2
  )
    return
  const claims = table.cells.flatMap((cell) => cell.sourceItems ?? []),
    wanted = new Map(sources.map((s) => [s?.index, s]))
  if (
    wanted.size !== sources.length ||
    claims.length !== sources.length ||
    new Set(claims.map((s) => s.index)).size !== sources.length ||
    claims.some((s) => !equal(s, wanted.get(s.index)))
  )
    return
  const packet = nativeWholeCellInkPacket(page, tokens, c, {
    text: owned.map((t) => t.text).join(''),
    sourceItems: sources,
    sourceRects: owned.map((t) => t.rect)
  })
  if (!packet) return
  const all = paints(packet),
    edges = rails.map((r) => all.filter((p) => p.eligible && equal(p.segment, r)))
  if (edges.some((e) => e.length !== 1)) return
  const marks = edges.flat(),
    records = packet.records.filter((r) => wanted.has(r.index)),
    glyphs = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
    owners = new Map()
  for (const r of packet.records)
    for (const g of new Set(r.part.map((p) => p.g))) {
      if (!owners.has(g)) owners.set(g, new Set())
      owners.get(g).add(r)
    }
  if (
    records.length !== sources.length ||
    records.some((r) => !r.advanceComplete || !inside(r.rect, crop) || !inside(r.ink, crop)) ||
    [...glyphs].some((g) => owners.get(g)?.size !== 1) ||
    packet.glyphs.some((g) => !glyphs.has(g) && over(g.ink, raster.protection)) ||
    all.some((p) => !marks.includes(p) && over(p.bounds, raster.protection)) ||
    packet.evidence.images.some((im) => over(im.rect, raster.protection))
  )
    return
  const rules = marks.map((p) => ({
    operatorIndex: p.id,
    segment: p.segment,
    width: p.width,
    clip: p.clip
  }))
  if (
    rules[0].operatorIndex >= rules[1].operatorIndex ||
    rules[1].operatorIndex >= rules[2].operatorIndex
  )
    return
  return {
    crop,
    raster,
    rules,
    sources: sources.toSorted((a, b) => a.index - b.index),
    glyphs: [...glyphs]
  }
}

function rasterCloses(plan, image) {
  const canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  try {
    const a = ctx.getImageData(0, 0, image.width, image.height).data,
      pixel = (x, y, threshold) => {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
        const i = (y * image.width + x) * 4
        return a[i + 3] === 255 && Math.max(a[i], a[i + 1], a[i + 2]) < threshold
      },
      s = plan.raster.scale,
      c = plan.crop
    for (const edge of plan.rules) {
      const lo = Math.ceil((edge.segment[0] - c[0]) * s - 0.5),
        hi = Math.floor((edge.segment[2] - c[0]) * s - 0.5)
      if (lo > hi) return false
      for (let x = lo; x <= hi; x++) {
        let hit = false
        for (
          let y = Math.floor((edge.segment[1] - edge.width / 2 - c[1]) * s) - 1;
          y <= Math.ceil((edge.segment[3] + edge.width / 2 - c[1]) * s) + 1;
          y++
        )
          if (pixel(x, y, 128)) hit = true
        if (!hit) return false
      }
    }
    for (const glyph of plan.glyphs) {
      if (!valid(glyph.ink)) continue
      let hit = false
      for (
        let y = Math.floor((glyph.ink[1] - c[1]) * s);
        y <= Math.ceil((glyph.ink[3] - c[1]) * s);
        y++
      )
        for (
          let x = Math.floor((glyph.ink[0] - c[0]) * s);
          x <= Math.ceil((glyph.ink[2] - c[0]) * s);
          x++
        )
          if (pixel(x, y, 255)) hit = true
      if (!hit) return false
    }
    return true
  } finally {
    canvas.width = canvas.height = 1
  }
}

// Final assembly only, after measured claims and the unchanged original PNG.
// Captioned tables retain their existing, separate admission contract.
export async function retainCaptionlessMathTableBody(table, options, loadPng) {
  try {
    if (typeof loadPng !== 'function') return table
    const plan = bodyPlan(table, options)
    if (!plan) return table
    const before = binding(table, options),
      value = await loadPng()
    if (!(value instanceof Uint8Array)) return table
    const png = Buffer.from(value)
    if (!matchesInitialPdfCropPng(png, plan.raster)) return table
    const image = await loadImage(png)
    if (
      image.width !== plan.raster.pixelWidth ||
      image.height !== plan.raster.pixelHeight ||
      binding(table, options) !== before ||
      !rasterCloses(plan, image)
    )
      return table
    const nativeBody = {
        kind: 'math-table',
        sourceItems: plan.sources,
        boundary: {
          kind: 'three-rail',
          pageNumber: table.page,
          scale: 1,
          coordinateSystem: 'pdfjs-upright-points',
          rules: plan.rules,
          raster: {
            width: image.width,
            height: image.height,
            sha256: createHash('sha256').update(png).digest('hex')
          }
        }
      },
      issues = [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])]
    if (equal(table.nativeBody, nativeBody) && equal(table.issues, issues)) return table
    return { ...table, nativeBody, issues, reviewCandidate: false }
  } catch {
    return table
  }
}
