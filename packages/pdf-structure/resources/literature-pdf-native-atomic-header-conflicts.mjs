/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { getInitialPdfCropRaster, matchesInitialPdfCropPng } from './literature-pdf-crop.mjs'

const finite = (a, n) => a?.length === n && Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (r, b) => r.every((x, i) => (i < 2 ? x > b[i] : x < b[i]))
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const box = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s/gu, '')
const sameNumbers = (a, b) =>
  finite(a, 4) && finite(b, 4) && a.every((x, i) => Math.abs(x - b[i]) < 1e-6)

function proofInputs(table, inventory, rules, context) {
  return JSON.stringify([table, inventory, rules, context], (_key, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value
  )
}

function headerPlan(table, inventory, rules, context) {
  const count = table?.grid?.[0]?.length,
    p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent,
    page = context?.sourcePage
  if (
    !Number.isSafeInteger(table?.page) ||
    table.page < 1 ||
    table.parts ||
    table.cropRects ||
    !valid(table.cropRect) ||
    !Number.isSafeInteger(count) ||
    count < 3 ||
    count > 8 ||
    table.grid.length < 4 ||
    table.grid.length > 64 ||
    table.grid.some((r) => !Array.isArray(r) || r.length !== count) ||
    !Array.isArray(table.cells) ||
    table.cells.length !== count * table.grid.length ||
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
  const mapped = (a) =>
    Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
  if (
    !equal(bound.operators.fnArray, context.operators?.fnArray) ||
    !equal(mapped(bound.operators.argsArray), context.operators?.argsArray) ||
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
          g.normalizedRect.map((n, k) => n * (k % 2 ? v.height : v.width)),
          target.rect
        ) ||
        !sameNumbers(target.rect, evidence.rect)
      )
    })
  )
    return
  const nativeViewport = {
      ...bound.viewport,
      convertToViewportPoint: (x, y) => [x, bound.viewport.height - y]
    },
    tokens = bound.content.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, nativeViewport, 0)),
    keys = new Set(),
    slots = new Set(),
    origins = [],
    rects = []
  for (const cell of table.cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= table.grid.length ||
      !Number.isSafeInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= count ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      cell.sourceSegments !== undefined ||
      !cell.sourceItems?.length ||
      cell.sourceRects?.length !== cell.sourceItems.length ||
      typeof cell.text !== 'string' ||
      !cell.text.trim() ||
      cell.text !== table.grid[cell.row][cell.column] ||
      compact(cell.sourceItems.map((o) => o.text).join('')) !== compact(cell.text) ||
      slots.has(cell.row + ':' + cell.column)
    )
      return
    slots.add(cell.row + ':' + cell.column)
    for (const [i, origin] of cell.sourceItems.entries()) {
      const owned = inventory.filter((f) => equal(f.sourceItem, origin))
      if (
        origin.pageNumber !== table.page ||
        keys.has(origin.index) ||
        owned.length !== 1 ||
        owned[0].text !== origin.text ||
        !owned[0].horizontal ||
        !(owned[0].height > 0) ||
        !Number.isFinite(owned[0].height) ||
        !Number.isFinite(owned[0].baseline) ||
        !sameNumbers(owned[0].rect, cell.sourceRects[i])
      )
        return
      keys.add(origin.index)
      origins.push(origin)
      rects.push(cell.sourceRects[i].map((x) => x / v.scale))
    }
  }
  const packet = nativeWholeCellInkPacket(
    page,
    tokens,
    { ...bound, viewport: nativeViewport },
    { text: origins.map((o) => o.text).join(''), sourceItems: origins, sourceRects: rects }
  )
  if (!packet || packet.records.length !== tokens.length) return
  const records = new Map(packet.records.map((r) => [r.index, r])),
    glyphOwners = new Map(),
    sharedGlyphs = new Set()
  for (const record of packet.records)
    for (const glyph of new Set(record.part.map((z) => z.g))) {
      if (glyphOwners.has(glyph) && glyphOwners.get(glyph) !== record) sharedGlyphs.add(glyph)
      else glyphOwners.set(glyph, record)
    }
  for (const [i, origin] of origins.entries()) {
    const r = records.get(origin.index)
    if (
      !r?.advanceComplete ||
      !valid(r.ink) ||
      !equal(r.r.sourceItem, origin) ||
      !sameNumbers(r.rect, rects[i]) ||
      r.part.some(
        (z) =>
          sharedGlyphs.has(z.g) ||
          z.g.rendererSkipped ||
          z.g.textPaint?.fillColor !== '#000000' ||
          z.g.textPaint.fillAlpha !== 1
      )
    )
      return
  }
  const heads = table.cells.filter((c) => c.row < 2),
    headIndices = new Set(heads.flatMap((c) => c.sourceItems.map((o) => o.index))),
    headerRecords = packet.records.filter((r) => headIndices.has(r.index)),
    headerInk = box(headerRecords.map((r) => r.ink.map((x) => x * v.scale))),
    paints = [],
    strokes = []
  let color = '#000000'
  const stack = []
  for (const [id, op] of packet.o.fnArray.entries()) {
    const a = packet.o.argsArray[id]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) color = stack.pop()
    else if (op === OPS.setStrokeRGBColor) color = a?.[0]
    if (op !== OPS.constructPath || !packet.evidence.paths.has(id)) continue
    if (a?.length === 3 && a[1]?.length === 1 && a[1][0] === null && a[2] === null) continue
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    const state = packet.evidence.paths.get(id)
    if (!finite(a?.[2], 4) || !finite(state.transform, 6) || !valid(state.clip)) return
    const stroked = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      pad = stroked ? (state.lineWidth * Math.max(1, packet.strokeMargins.get(id) ?? 10)) / 2 : 0,
      matrix = Util.transform(nativeViewport.transform, state.transform)
    if (!Number.isFinite(pad) || pad < 0 || (stroked && !(pad > 0))) return
    const b = packet.box(
        Array.from(a[2], (x, i) => x + (i < 2 ? -pad : pad)),
        matrix
      ),
      clipped = [
        Math.max(b[0], state.clip[0]),
        Math.max(b[1], state.clip[1]),
        Math.min(b[2], state.clip[2]),
        Math.min(b[3], state.clip[3])
      ].map((x) => x * v.scale)
    if (!finite(clipped, 4)) return
    paints.push({ id, rect: clipped })
    const path = a[1]?.[0]
    if (
      a[0] !== OPS.stroke ||
      a[1]?.length !== 1 ||
      !finite(path, 6) ||
      path[0] !== 0 ||
      path[3] !== 1 ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      !(matrix[0] > 0) ||
      !(matrix[3] < 0) ||
      state.strokeAlpha !== 1 ||
      state.solidStroke !== true ||
      state.lineCap !== 0 ||
      color !== '#000000'
    )
      continue
    const x0 = (path[1] * matrix[0] + matrix[4]) * v.scale,
      y0 = (path[2] * matrix[3] + matrix[5]) * v.scale,
      x1 = (path[4] * matrix[0] + matrix[4]) * v.scale,
      y1 = (path[5] * matrix[3] + matrix[5]) * v.scale,
      width = state.lineWidth * Math.max(Math.abs(matrix[0]), Math.abs(matrix[3])) * v.scale
    if ((x0 !== x1 && y0 !== y1) || !(width > 0)) continue
    const paint = [
        Math.min(x0, x1) - (x0 === x1 ? width / 2 : 0),
        Math.min(y0, y1) - (y0 === y1 ? width / 2 : 0),
        Math.max(x0, x1) + (x0 === x1 ? width / 2 : 0),
        Math.max(y0, y1) + (y0 === y1 ? width / 2 : 0)
      ],
      clip = state.clip.map((x) => x * v.scale)
    if (paint.some((x, i) => (i < 2 ? x < clip[i] : x > clip[i]))) continue
    strokes.push({ id, segment: [x0, y0, x1, y1], paint, width })
  }
  const horizontal = strokes.filter(
      (s) =>
        s.segment[1] === s.segment[3] &&
        Math.min(s.segment[0], s.segment[2]) <= headerInk[0] &&
        Math.max(s.segment[0], s.segment[2]) >= headerInk[2]
    ),
    top = horizontal
      .filter((s) => s.segment[1] < headerInk[1])
      .sort((a, b) => b.segment[1] - a.segment[1])[0],
    bottom = horizontal
      .filter((s) => s.segment[1] > headerInk[3])
      .sort((a, b) => a.segment[1] - b.segment[1])[0]
  if (!top || !bottom) return
  const band = [
      Math.min(top.segment[0], top.segment[2]),
      top.segment[1],
      Math.max(top.segment[0], top.segment[2]),
      bottom.segment[1]
    ],
    vertical = strokes
      .filter(
        (s) =>
          s.segment[0] === s.segment[2] &&
          s.segment[0] >= band[0] &&
          s.segment[0] <= band[2] &&
          Math.min(s.segment[1], s.segment[3]) <= band[1] + s.width &&
          Math.max(s.segment[1], s.segment[3]) >= band[3] - s.width
      )
      .sort((a, b) => a.segment[0] - b.segment[0]),
    edges = [top, bottom, ...vertical],
    edgeIds = new Set(edges.map((e) => e.id))
  if (
    !valid(band) ||
    !sameNumbers(
      [Math.min(top.segment[0], top.segment[2]), 0, Math.max(top.segment[0], top.segment[2]), 1],
      [
        Math.min(bottom.segment[0], bottom.segment[2]),
        0,
        Math.max(bottom.segment[0], bottom.segment[2]),
        1
      ]
    ) ||
    vertical.length !== count + 1 ||
    new Set(vertical.map((s) => s.segment[0])).size !== vertical.length ||
    paints.some((p) => valid(p.rect) && overlaps(p.rect, band) && !edgeIds.has(p.id)) ||
    packet.evidence.images.some(
      (im) =>
        !valid(im.rect) ||
        overlaps(
          im.rect.map((x) => x * v.scale),
          band
        )
    )
  )
    return
  for (let column = 0; column < count; column++) {
    const face = [vertical[column].segment[0], band[1], vertical[column + 1].segment[0], band[3]],
      own = headerRecords.filter((r) =>
        inside(
          r.ink.map((x) => x * v.scale),
          face
        )
      ),
      objects = [...new Set(own.flatMap((r) => r.part.map((z) => z.g.packet)))],
      object = objects[0],
      objectRecords =
        object && packet.records.filter((r) => r.part.some((z) => z.g.packet === object)),
      ownedGlyphs = new Set(own.flatMap((r) => r.part.map((z) => z.g))),
      cells = heads.filter((c) => c.sourceItems.some((o) => own.some((r) => r.index === o.index)))
    if (
      own.length !== 2 ||
      own.some((r) => !/^\p{L}[\p{L}\p{M}]*(?:[ -]\p{L}[\p{L}\p{M}]*)*$/u.test(r.r.str)) ||
      own[0].r.height !== own[1].r.height ||
      own[0].r.fontName !== own[1].r.fontName ||
      objects.length !== 1 ||
      object.shows.length !== 2 ||
      objectRecords.length !== 2 ||
      objectRecords.some((r) => !own.includes(r)) ||
      new Set(object.glyphs.map((g) => g.fontName)).size !== 1 ||
      object.glyphs.some((g) => valid(g.ink) && !ownedGlyphs.has(g)) ||
      cells.length !== 2 ||
      cells.some((c) => c.column !== column || c.sourceItems.length !== 1) ||
      cells[0].row === cells[1].row ||
      packet.records.some(
        (r) =>
          !own.includes(r) &&
          valid(r.ink) &&
          overlaps(
            r.ink.map((x) => x * v.scale),
            face
          )
      ) ||
      packet.glyphs.some(
        (g) =>
          !ownedGlyphs.has(g) &&
          valid(g.ink) &&
          overlaps(
            g.ink.map((x) => x * v.scale),
            face
          )
      )
    )
      return
    for (const cell of table.cells.filter((c) => c.column === column && c.row >= 2)) {
      if (!/^[+−-]?\d+(?:[.,]\d+)?(?:\/\d+)?$/u.test(compact(cell.text))) return
      for (const origin of cell.sourceItems) {
        const ink = records.get(origin.index).ink.map((x) => x * v.scale)
        if (ink[0] <= face[0] || ink[2] >= face[2] || ink[1] <= band[3]) return
      }
    }
  }
  const raster = getInitialPdfCropRaster(
    table.cropRect.map((x) => x / v.scale),
    bound.viewport
  )
  if (!raster) return
  return { edges, band, raster, pixelScale: raster.scale / v.scale }
}

function rasterCloses(plan, table, image) {
  const canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data,
    dark = (x, y) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
      const i = (y * image.width + x) * 4
      return pixels[i + 3] === 255 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 128
    }
  for (const edge of plan.edges) {
    const r = edge.paint.map((x, k) => (x - table.cropRect[k % 2]) * plan.pixelScale),
      vertical = edge.segment[0] === edge.segment[2],
      start = Math.ceil(
        (plan.band[vertical ? 1 : 0] - table.cropRect[vertical ? 1 : 0]) * plan.pixelScale
      ),
      end = Math.floor(
        (plan.band[vertical ? 3 : 2] - table.cropRect[vertical ? 1 : 0]) * plan.pixelScale
      )
    if (start > end) return false
    for (let n = start; n <= end; n++) {
      let hit = false
      for (
        let other = Math.floor(r[vertical ? 0 : 1]);
        other <= Math.ceil(r[vertical ? 2 : 3]);
        other++
      )
        if (dark(vertical ? other : n, vertical ? n : other)) hit = true
      if (!hit) return false
    }
  }
  return true
}

// Called only after measured source attachment and the existing final review.
// A repeated native cell contradiction suspends mapping; it supplies no new grid.
export async function reviewFinalNativeAtomicHeaderSources(
  table,
  inventory,
  rules,
  context,
  loadPng
) {
  try {
    if (typeof loadPng !== 'function') return table
    const plan = headerPlan(table, inventory, rules, context)
    if (!plan) return table
    const binding = proofInputs(table, inventory, rules, context),
      png = await loadPng()
    if (!(png instanceof Uint8Array) || !matchesInitialPdfCropPng(png, plan.raster)) return table
    const image = await loadImage(png)
    if (
      image.width !== plan.raster.pixelWidth ||
      image.height !== plan.raster.pixelHeight ||
      proofInputs(table, inventory, rules, context) !== binding ||
      !rasterCloses(plan, table, image)
    )
      return table
    return {
      ...table,
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
  } catch {
    return table
  }
}
