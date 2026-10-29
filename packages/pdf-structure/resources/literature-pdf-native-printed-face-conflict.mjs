/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeClosedPrintedFaceInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { samePrintedFaceOperators } from './literature-pdf-native-printed-face-packet.mjs'
import {
  getInitialPdfCropRaster,
  getPdfCropRasterProtectionFromPng,
  matchesInitialPdfCropPng
} from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const inside = (r, b) => r.every((x, i) => (i < 2 ? x > b[i] : x < b[i]))
const compact = (s) => s.replace(/\s/gu, '')
const binding = (table, inventory, rules, context) =>
  JSON.stringify([table, inventory, rules, context], (_key, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value
  )
const sameNumbers = (a, b) =>
  finite(a, 4) && finite(b, 4) && a.every((x, i) => Math.abs(x - b[i]) < 1e-6)

function inputs(table, inventory, rules, context) {
  const p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent,
    page = context?.sourcePage
  if (
    !Number.isSafeInteger(table?.page) ||
    table.page < 1 ||
    table.parts ||
    table.cropRects ||
    !valid(table.cropRect) ||
    !table.grid?.length ||
    !Array.isArray(table.cells) ||
    table.issues?.includes('native-table-structure-ambiguous') ||
    !Array.isArray(inventory) ||
    !Array.isArray(rules) ||
    typeof table.thumbnail !== 'string' ||
    !p ||
    !source ||
    context.content !== source ||
    page?.pageNumber !== table.page ||
    page.invalidGraphicsBounds !== 0 ||
    p.sourceSha256 !== context.sourceSha256 ||
    !/^[a-f\d]{64}$/u.test(context.sourceSha256) ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    v?.rotation !== 0 ||
    !(v.scale > 0) ||
    !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.width !== p.viewport.width * v.scale ||
    v.height !== p.viewport.height * v.scale ||
    table.sourceViewport?.scale !== v.scale ||
    table.sourceViewport.width !== v.width ||
    table.sourceViewport.height !== v.height
  )
    return
  const bound = matchNativeFigureRenderContext(
    p,
    table.page,
    source,
    p.viewport,
    page.graphicsBounds,
    context.sourceSha256
  )
  if (!bound) return
  const aliases = new Map(),
    reverse = new Map()
  for (const [i, item] of bound.content.items.entries()) {
    const target = source.items[i]?.fontName
    if (
      !equal(item.sourceItem, source.items[i]?.sourceItem) ||
      (aliases.has(item.fontName) && aliases.get(item.fontName) !== target) ||
      (reverse.has(target) && reverse.get(target) !== item.fontName)
    )
      return
    aliases.set(item.fontName, target)
    reverse.set(target, item.fontName)
  }
  if (
    !context.operators ||
    !samePrintedFaceOperators(bound.operators, context.operators, aliases) ||
    !equal(rules, collectTableRules(context.operators, v)) ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    !Array.isArray(context.nativeEvidenceGraphics) ||
    bound.graphicsBounds.length !== context.nativePaintIdentityGraphics.length ||
    bound.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
    bound.graphicsBounds.some((g, i) => {
      const target = context.nativePaintIdentityGraphics[i],
        evidence = context.nativeEvidenceGraphics[i]
      return (
        g.kind !== target.kind ||
        g.kind !== evidence.kind ||
        g.operationIndex !== target.operationIndex ||
        !sameNumbers(
          g.normalizedRect.map((x, k) => x * (k % 2 ? v.height : v.width)),
          target.rect
        ) ||
        !sameNumbers(target.rect, evidence.rect)
      )
    })
  )
    return
  const counts = new Map()
  for (const c of table.cells)
    for (const o of [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])]) {
      const key = o.pageNumber + ':' + o.index
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  const candidates = table.cells.filter(
    (c) =>
      c.row === 0 &&
      c.rowSpan === 1 &&
      c.colSpan === 1 &&
      c.sourceSegments === undefined &&
      c.sourceItems?.length === 2 &&
      c.sourceRects?.length === 2 &&
      c.sourceItems.every(
        (o) => o.pageNumber === table.page && counts.get(o.pageNumber + ':' + o.index) === 1
      ) &&
      typeof c.text === 'string' &&
      compact(c.text) === compact(c.sourceItems.map((o) => o.text).join('')) &&
      /^\p{L}[\p{L}\p{M} -]*$/u.test(c.sourceItems[0].text) &&
      /^\d+$/u.test(c.sourceItems[1].text) &&
      c.sourceRects.every(valid) &&
      c.sourceRects[0][3] < c.sourceRects[1][1]
  )
  if (!candidates.length) return
  const crop = table.cropRect.map((x) => x / v.scale),
    initial = getInitialPdfCropRaster(crop, page)
  if (!initial) return
  const nativeViewport = {
      ...bound.viewport,
      convertToViewportPoint: (x, y) => [x, bound.viewport.height - y]
    },
    workViewport = {
      ...v,
      convertToViewportPoint: (x, y) => [x * v.scale, v.height - y * v.scale]
    },
    tokens = bound.content.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, nativeViewport, 0))
  return {
    bound: {
      ...bound,
      viewport: nativeViewport,
      pageNumber: table.page,
      sourceSha256: context.sourceSha256
    },
    page,
    tokens,
    workViewport,
    candidates,
    crop,
    initial
  }
}

function paintInventory(packet) {
  let color = '#000000',
    miter = 10,
    join = 0
  const stack = [],
    strokes = [],
    paints = []
  for (const [id, op] of packet.o.fnArray.entries()) {
    const a = packet.o.argsArray[id]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ color, miter, join })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ color, miter, join } = stack.pop())
    } else if (op === OPS.setStrokeRGBColor) color = a?.[0]
    else if (op === OPS.setStrokeColorN) color = undefined
    else if (op === OPS.setMiterLimit) miter = a?.[0]
    else if (op === OPS.setLineJoin) join = a?.[0]
    else if (op === OPS.setGState)
      for (const [key, value] of a[0]) {
        if (key === 'ML') miter = value
        if (key === 'LJ') join = value
      }
    if (
      op !== OPS.constructPath ||
      [OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0]) ||
      a?.[2] === null
    )
      continue
    const q = packet.evidence.paths.get(id),
      cmd = a?.[1]?.[0],
      matrix = q && Util.transform(packet.v.transform, q.transform),
      stroked = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a?.[0])
    if (
      !q ||
      !valid(q.clip) ||
      !finite(matrix, 6) ||
      !finite(a?.[2], 4) ||
      !Number.isFinite(miter) ||
      miter < 1 ||
      ![0, 1, 2].includes(join)
    )
      return
    const simple =
        a[0] === OPS.stroke &&
        a[1].length === 1 &&
        finite(cmd, 6) &&
        cmd[0] === 0 &&
        cmd[3] === 1 &&
        matrix[1] === 0 &&
        matrix[2] === 0 &&
        matrix[0] > 0 &&
        matrix[3] < 0,
      width = q.lineWidth * Math.max(Math.abs(matrix[0]), Math.abs(matrix[3]))
    if (stroked && !(Number.isFinite(width) && width > 0)) return
    const pad = stroked ? (q.lineWidth * (simple ? 1 : miter)) / 2 : 0,
      b = packet.box(
        Array.from(a[2], (x, k) => x + (k < 2 ? -pad : pad)),
        matrix
      ),
      rect = [
        Math.max(b[0], q.clip[0]),
        Math.max(b[1], q.clip[1]),
        Math.min(b[2], q.clip[2]),
        Math.min(b[3], q.clip[3])
      ]
    if (!finite(rect, 4)) return
    paints.push({ id, rect })
    if (
      !simple ||
      q.strokeAlpha !== 1 ||
      q.solidStroke !== true ||
      q.lineCap !== 0 ||
      color !== '#000000'
    )
      continue
    const segment = [
        cmd[1] * matrix[0] + matrix[4],
        cmd[2] * matrix[3] + matrix[5],
        cmd[4] * matrix[0] + matrix[4],
        cmd[5] * matrix[3] + matrix[5]
      ],
      vertical = segment[0] === segment[2],
      horizontal = segment[1] === segment[3]
    if (!vertical && !horizontal) continue
    const ink = [
      Math.min(segment[0], segment[2]) - (vertical ? width / 2 : 0),
      Math.min(segment[1], segment[3]) - (horizontal ? width / 2 : 0),
      Math.max(segment[0], segment[2]) + (vertical ? width / 2 : 0),
      Math.max(segment[1], segment[3]) + (horizontal ? width / 2 : 0)
    ]
    if (ink.some((x, k) => (k < 2 ? x < q.clip[k] : x > q.clip[k]))) continue
    strokes.push({ id, segment, rect: ink, width })
  }
  return stack.length ? undefined : { paints, strokes }
}

// Retain positive foreign outlines; only their exact native clip excludes them.
function paintedInk(g) {
  if (!g.excludedByClosedFaceClip) return g.ink
  return [
    Math.max(g.ink[0], g.paintClip[0]),
    Math.max(g.ink[1], g.paintClip[1]),
    Math.min(g.ink[2], g.paintClip[2]),
    Math.min(g.ink[3], g.paintClip[3])
  ]
}

function facesFor(packet, records, crop, raster) {
  const paint = paintInventory(packet)
  if (!paint) return
  const horizontal = paint.strokes.filter((s) => s.segment[1] === s.segment[3]),
    vertical = paint.strokes.filter((s) => s.segment[0] === s.segment[2]),
    moat = 1 / raster.scale,
    faces = [],
    nearest = (choices, axis, descending) => {
      const sorted = choices.toSorted(
          (a, b) => (a.segment[axis] - b.segment[axis]) * (descending ? -1 : 1)
        ),
        first = sorted[0]
      return first && !sorted.slice(1).some((s) => overlaps(first.rect, s.rect)) ? first : undefined
    }
  for (const record of records) {
    const top = nearest(
        horizontal.filter(
          (s) =>
            s.segment[1] + s.width / 2 + moat < record.ink[1] &&
            s.rect[0] < record.ink[0] &&
            s.rect[2] > record.ink[2]
        ),
        1,
        true
      ),
      bottom = nearest(
        horizontal.filter(
          (s) =>
            s.segment[1] - s.width / 2 - moat > record.ink[3] &&
            s.rect[0] < record.ink[0] &&
            s.rect[2] > record.ink[2]
        ),
        1,
        false
      )
    if (!top || !bottom) return
    const sides = vertical.filter(
        (s) => s.rect[1] < record.ink[1] - moat && s.rect[3] > record.ink[3] + moat
      ),
      left = nearest(
        sides.filter((s) => s.segment[0] + s.width / 2 + moat < record.ink[0]),
        0,
        true
      ),
      right = nearest(
        sides.filter((s) => s.segment[0] - s.width / 2 - moat > record.ink[2]),
        0,
        false
      )
    if (
      !left ||
      !right ||
      top.rect[0] > left.rect[2] ||
      top.rect[2] < right.rect[0] ||
      bottom.rect[0] > left.rect[2] ||
      bottom.rect[2] < right.rect[0]
    )
      return
    const rect = [left.segment[0], top.segment[1], right.segment[0], bottom.segment[1]],
      inner = [
        rect[0] + left.width / 2,
        rect[1] + top.width / 2,
        rect[2] - right.width / 2,
        rect[3] - bottom.width / 2
      ],
      edges = [top, bottom, left, right],
      edgeIds = new Set(edges.map((e) => e.id)),
      owned = new Set(record.part.map((z) => z.g))
    if (
      !valid(inner) ||
      !inside(rect, crop) ||
      paint.paints.some((p) => !edgeIds.has(p.id) && valid(p.rect) && overlaps(p.rect, inner)) ||
      packet.evidence.images.some((im) => !valid(im.rect) || overlaps(im.rect, inner)) ||
      packet.glyphs.some(
        (g) => !owned.has(g) && valid(paintedInk(g)) && overlaps(paintedInk(g), inner)
      )
    )
      return
    faces.push({ rect, inner, edges })
  }
  return faces[0].rect[3] === faces[1].rect[1] ? faces : undefined
}

function closesRaster(faces, image, crop, scale, records) {
  const canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  try {
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data,
      black = (x, y) => {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
        const i = (y * image.width + x) * 4
        return Math.max(data[i], data[i + 1], data[i + 2]) < 128
      }
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false
    let sampled = 0
    for (const g of new Set(records.flatMap((r) => r.part.map((z) => z.g)))) {
      const r = g.ink.map((x, i) => (x - crop[i % 2]) * scale),
        left = Math.floor(r[0]),
        top = Math.floor(r[1]),
        right = Math.ceil(r[2]),
        bottom = Math.ceil(r[3])
      sampled += (right - left + 1) * (bottom - top + 1)
      if (!valid(g.ink) || sampled > image.width * image.height * 2) return false
      let hit = false
      for (let y = top; y <= bottom && !hit; y++)
        for (let x = left; x <= right; x++)
          if (black(x, y)) {
            hit = true
            break
          }
      if (!hit) return false
    }
    for (const face of faces) {
      const rect = face.rect.map((x, i) => (x - crop[i % 2]) * scale),
        inner = face.inner.map((x, i) => (x - crop[i % 2]) * scale),
        left = Math.floor(rect[0]) - 2,
        right = Math.ceil(rect[2]) + 2,
        top = Math.floor(rect[1]) - 2,
        bottom = Math.ceil(rect[3]) + 2,
        width = right - left + 1,
        height = bottom - top + 1
      if (width < 1 || height < 1 || width * height > (image.width + 8) * (image.height + 8))
        return false
      const seen = new Uint8Array(width * height),
        queue = [],
        push = (x, y) => {
          if (x < left || x > right || y < top || y > bottom) return
          const i = (y - top) * width + x - left
          if (seen[i] || black(x, y)) return
          seen[i] = 1
          queue.push([x, y])
        }
      for (let x = left; x <= right; x++) {
        push(x, top)
        push(x, bottom)
      }
      for (let y = top; y <= bottom; y++) {
        push(left, y)
        push(right, y)
      }
      for (let i = 0; i < queue.length; i++) {
        const [x, y] = queue[i]
        push(x - 1, y)
        push(x + 1, y)
        push(x, y - 1)
        push(x, y + 1)
      }
      let total = 0,
        white = 0
      for (let y = Math.ceil(inner[1]); y < Math.floor(inner[3]); y++)
        for (let x = Math.ceil(inner[0]); x < Math.floor(inner[2]); x++) {
          total++
          if (!black(x, y)) {
            white++
            if (seen[(y - top) * width + x - left]) return false
          }
        }
      if (!total || white <= total / 2) return false
      for (const edge of face.edges) {
        const vertical = edge.segment[0] === edge.segment[2],
          along = vertical ? 1 : 0,
          other = 1 - along,
          start = Math.ceil((face.rect[along] - crop[along]) * scale),
          end = Math.floor((face.rect[along + 2] - crop[along]) * scale),
          a = Math.floor((edge.rect[other] - crop[other]) * scale),
          b = Math.ceil((edge.rect[other + 2] - crop[other]) * scale)
        if (start > end) return false
        for (let n = start; n <= end; n++) {
          let hit = false
          for (let m = a; m <= b; m++) if (black(vertical ? m : n, vertical ? n : m)) hit = true
          if (!hit) return false
        }
      }
    }
    return true
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

// Final measured ownership and a real crop are mandatory. This supplies no
// replacement grid, source literal or whole-body ownership.
export async function reviewFinalNativePrintedFaceSources(
  table,
  inventory,
  rules,
  context,
  loadPng
) {
  try {
    if (typeof loadPng !== 'function') return table
    const plan = inputs(table, inventory, rules, context)
    if (!plan) return table
    const before = binding(table, inventory, rules, context),
      bytes = await loadPng()
    if (!(bytes instanceof Uint8Array) || !matchesInitialPdfCropPng(bytes, plan.initial))
      return table
    const protection = getPdfCropRasterProtectionFromPng(bytes, plan.crop, plan.page)
    if (!protection) return table
    const png = Buffer.from(bytes)
    const image = await loadImage(png)
    if (
      before !== binding(table, inventory, rules, context) ||
      !Buffer.from(bytes).equals(png) ||
      image.width !== plan.initial.pixelWidth ||
      image.height !== plan.initial.pixelHeight
    )
      return table
    for (const cell of plan.candidates) {
      const packet = nativeClosedPrintedFaceInkPacket(
        plan.page,
        plan.tokens,
        plan.bound,
        cell.sourceItems,
        protection.protection
      )
      if (!packet) continue
      const records = cell.sourceItems.map((o) => packet.records.find((r) => r.index === o.index)),
        glyphOwners = new Map(),
        shared = new Set()
      for (const r of packet.records)
        for (const g of new Set(r.part.map((z) => z.g))) {
          if (glyphOwners.has(g) && glyphOwners.get(g) !== r) shared.add(g)
          else glyphOwners.set(g, r)
        }
      if (
        records.some((r, i) => {
          const rows = inventory.filter((f) => equal(f.sourceItem, cell.sourceItems[i]))
          return (
            !r ||
            !r.advanceComplete ||
            !valid(r.ink) ||
            rows.length !== 1 ||
            !rows[0].horizontal ||
            !(Number.isFinite(rows[0].height) && rows[0].height > 0) ||
            !equal(r.r.sourceItem, cell.sourceItems[i]) ||
            !equal(tableTextToken(r.r, plan.workViewport, 0).rect, cell.sourceRects[i]) ||
            !equal(rows[0].rect, cell.sourceRects[i]) ||
            r.part.some(
              (z) =>
                shared.has(z.g) ||
                z.g.rendererSkipped ||
                z.g.excludedByClosedFaceClip ||
                z.g.textPaint?.fillColor !== '#000000' ||
                z.g.textPaint.fillAlpha !== 1
            )
          )
        })
      )
        continue
      if (
        records.some((r) => {
          const objects = [...new Set(r.part.map((z) => z.g.packet))],
            owned = new Set(r.part.map((z) => z.g))
          return (
            objects.length !== 1 ||
            packet.records.some(
              (other) => other !== r && other.part.some((z) => z.g.packet === objects[0])
            ) ||
            objects[0].glyphs.some((g) => valid(g.ink) && !owned.has(g))
          )
        })
      )
        continue
      const faces = facesFor(packet, records, plan.crop, plan.initial)
      if (!faces || !closesRaster(faces, image, plan.crop, plan.initial.scale, records)) continue
      return {
        ...table,
        issues: [...(table.issues ?? []), 'native-table-structure-ambiguous'],
        reviewCandidate: false
      }
    }
  } catch {
    // Incomplete evidence leaves every existing field intact.
  }
  return table
}
