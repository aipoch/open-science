/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { samePrintedFaceOperators } from './literature-pdf-native-printed-face-packet.mjs'
import {
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng,
  getPdfCropRasterProtectionFromPng
} from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => a.every((x, i) => (i < 2 ? x >= b[i] : x <= b[i]))
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const box = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s/gu, '')
const sameRect = (a, b) =>
  finite(a, 4) && finite(b, 4) && a.every((x, i) => Math.abs(x - b[i]) < 1e-6)
const binding = (table, inventory, rules, context) =>
  JSON.stringify([table, inventory, rules, context], (_key, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value
  )

function retainInputIdentity(roots, descriptorOnlyReceiver) {
  const checks = [],
    seen = new WeakSet(),
    prototypes = new WeakSet(),
    pending = [...roots]
  const builtins = new Set([
    Object.prototype,
    Array.prototype,
    Function.prototype,
    Map.prototype,
    Set.prototype
  ])
  while (pending.length) {
    const value = pending.pop()
    if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
    seen.add(value)
    if (typeof value === 'function') continue
    const prototype = Object.getPrototypeOf(value)
    if (ArrayBuffer.isView(value)) {
      const buffer = value.buffer,
        offset = value.byteOffset,
        length = value.byteLength,
        bytes = Buffer.from(new Uint8Array(buffer, offset, length))
      checks.push(
        () =>
          Object.getPrototypeOf(value) === prototype &&
          value.buffer === buffer &&
          value.byteOffset === offset &&
          value.byteLength === length &&
          bytes.equals(Buffer.from(new Uint8Array(buffer, offset, length)))
      )
      continue
    }
    if (!prototypes.has(value) && value !== descriptorOnlyReceiver) {
      const inherited = [],
        inheritedKeys = new Set(Reflect.ownKeys(value))
      for (
        let current = prototype;
        current && !builtins.has(current);
        current = Object.getPrototypeOf(current)
      ) {
        for (const key of Reflect.ownKeys(current)) {
          if (inheritedKeys.has(key)) continue
          inheritedKeys.add(key)
          const descriptor = Object.getOwnPropertyDescriptor(current, key)
          if (descriptor.get) inherited.push([key, Reflect.get(value, key)])
        }
      }
      pending.push(...inherited.map(([, child]) => child))
      checks.push(() =>
        inherited.every(([key, child]) => Object.is(child, Reflect.get(value, key)))
      )
    }
    if (prototype && !builtins.has(prototype)) {
      prototypes.add(prototype)
      pending.push(prototype)
    }
    const keys = Reflect.ownKeys(value),
      descriptors = Object.getOwnPropertyDescriptors(value),
      isPrototype = prototypes.has(value),
      values = keys.map((key) => (isPrototype ? descriptors[key].value : Reflect.get(value, key)))
    pending.push(...values)
    checks.push(
      () =>
        Object.getPrototypeOf(value) === prototype &&
        equal(Reflect.ownKeys(value), keys) &&
        keys.every((key, i) => {
          const old = descriptors[key],
            current = Object.getOwnPropertyDescriptor(value, key)
          return (
            current &&
            old.get === current.get &&
            old.set === current.set &&
            old.enumerable === current.enumerable &&
            old.configurable === current.configurable &&
            old.writable === current.writable &&
            Object.is(old.value, current.value) &&
            (isPrototype || Object.is(values[i], Reflect.get(value, key)))
          )
        })
    )
    if (value instanceof Map) {
      const entries = [...value]
      pending.push(...entries.flat())
      checks.push(
        () =>
          value.size === entries.length &&
          [...value].every(
            ([key, child], i) => Object.is(key, entries[i][0]) && Object.is(child, entries[i][1])
          )
      )
    }
    if (value instanceof Set) {
      const entries = [...value]
      pending.push(...entries)
      checks.push(
        () =>
          value.size === entries.length &&
          [...value].every((child, i) => Object.is(child, entries[i]))
      )
    }
  }
  return () => checks.every((check) => check())
}

const certificate = (plan) =>
  JSON.stringify({
    top: plan.top,
    edge: plan.edge,
    bottom: plan.bottom,
    band: plan.band,
    crop: plan.crop,
    raster: plan.raster,
    owners: plan.owned.map((r) => [r.index, r.rect, r.ink, r.advanceComplete])
  })

function planConflict(table, inventory, rules, context) {
  const p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent,
    page = context?.sourcePage,
    count = table?.grid?.[0]?.length
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
    table.cells.length > 4096 ||
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
    !['scale', 'width', 'height', 'rotation', 'transform'].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)
      return descriptor && 'value' in descriptor
    }) ||
    !(v.scale > 0) ||
    !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
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
  for (const [index, item] of bound.content.items.entries()) {
    const next = source.items[index]
    if (
      !equal(item.sourceItem, next?.sourceItem) ||
      (aliases.has(item.fontName) && aliases.get(item.fontName) !== next.fontName) ||
      (reverse.has(next.fontName) && reverse.get(next.fontName) !== item.fontName)
    )
      return
    aliases.set(item.fontName, next.fontName)
    reverse.set(next.fontName, item.fontName)
  }
  if (
    !samePrintedFaceOperators(bound.operators, context.operators, aliases) ||
    !equal(rules, collectTableRules(context.operators, v)) ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    !Array.isArray(context.nativeEvidenceGraphics) ||
    bound.graphicsBounds.length !== context.nativePaintIdentityGraphics.length ||
    bound.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
    bound.graphicsBounds.some((g, index) => {
      const a = context.nativePaintIdentityGraphics[index],
        b = context.nativeEvidenceGraphics[index]
      return (
        g.kind !== a.kind ||
        g.kind !== b.kind ||
        g.operationIndex !== a.operationIndex ||
        !sameRect(
          g.normalizedRect.map((x, i) => x * (i % 2 ? v.height : v.width)),
          a.rect
        ) ||
        !sameRect(a.rect, b.rect)
      )
    })
  )
    return
  const nv = bound.viewport,
    tokens = bound.content.items.filter((i) => i.str?.trim()).map((i) => tableTextToken(i, nv, 0)),
    origins = [],
    rects = [],
    keys = new Set(),
    slots = new Set()
  for (const cell of table.cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= table.grid.length ||
      !Number.isSafeInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= count ||
      !Number.isSafeInteger(cell.rowSpan) ||
      cell.rowSpan < 1 ||
      cell.row + cell.rowSpan > table.grid.length ||
      !Number.isSafeInteger(cell.colSpan) ||
      cell.colSpan < 1 ||
      cell.column + cell.colSpan > count ||
      typeof cell.text !== 'string' ||
      cell.text !== table.grid[cell.row][cell.column] ||
      slots.has(cell.row + ':' + cell.column)
    )
      return
    slots.add(cell.row + ':' + cell.column)
    if (!cell.text.trim()) {
      if (cell.sourceItems?.length || cell.sourceSegments?.length) return
      continue
    }
    if (
      cell.sourceSegments !== undefined ||
      !cell.sourceItems?.length ||
      cell.sourceRects?.length !== cell.sourceItems.length ||
      compact(cell.sourceItems.map((i) => i.text).join('')) !== compact(cell.text)
    )
      return
    for (const [i, origin] of cell.sourceItems.entries()) {
      const owned = inventory.filter((t) => equal(t.sourceItem, origin))
      if (
        origin.pageNumber !== table.page ||
        keys.has(origin.index) ||
        owned.length !== 1 ||
        owned[0].text !== origin.text ||
        !owned[0].horizontal ||
        !(owned[0].height > 0) ||
        !Number.isFinite(owned[0].height) ||
        !Number.isFinite(owned[0].baseline) ||
        !sameRect(owned[0].rect, cell.sourceRects[i])
      )
        return
      keys.add(origin.index)
      origins.push(origin)
      rects.push(cell.sourceRects[i].map((x) => x / v.scale))
    }
  }
  const heads = table.cells.filter((c) => c.row === 0)
  if (
    heads.length !== count ||
    heads.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || !c.sourceItems?.length)
  )
    return
  const packet = nativeWholeCellInkPacket(page, tokens, bound, {
    text: origins.map((o) => o.text).join(''),
    sourceItems: origins,
    sourceRects: rects
  })
  if (!packet || packet.records.length !== tokens.length) return
  const records = new Map(packet.records.map((r) => [r.index, r])),
    glyphOwners = new Map(),
    shared = new Set()
  for (const record of packet.records)
    for (const glyph of new Set(record.part.map((z) => z.g))) {
      if (glyphOwners.has(glyph) && glyphOwners.get(glyph) !== record) shared.add(glyph)
      else glyphOwners.set(glyph, record)
    }
  for (const [i, origin] of origins.entries()) {
    const record = records.get(origin.index)
    if (
      !record?.advanceComplete ||
      !valid(record.ink) ||
      !equal(record.r.sourceItem, origin) ||
      !sameRect(record.rect, rects[i]) ||
      record.part.some(
        (z) =>
          shared.has(z.g) ||
          z.g.rendererSkipped ||
          z.g.textPaint?.fillColor !== '#000000' ||
          z.g.textPaint.fillAlpha !== 1
      )
    )
      return
  }
  const strokes = [],
    paints = [],
    stack = []
  let color = '#000000'
  for (const [id, op] of packet.o.fnArray.entries()) {
    const a = packet.o.argsArray[id]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      color = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) color = a?.[0]
    if (
      op !== OPS.constructPath ||
      !packet.evidence.paths.has(id) ||
      [OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])
    )
      continue
    if (a?.length === 3 && a[1]?.length === 1 && a[1][0] === null && a[2] === null) continue
    const q = packet.evidence.paths.get(id),
      m = Util.transform(nv.transform, q.transform)
    if (!finite(a?.[2], 4) || !finite(q.transform, 6) || !valid(q.clip)) return
    const stroked = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      pad = stroked ? (q.lineWidth * Math.max(1, packet.strokeMargins.get(id) ?? 10)) / 2 : 0
    if (!Number.isFinite(pad) || pad < 0 || (stroked && !(pad > 0))) return
    const full = packet.box(
        Array.from(a[2], (x, i) => x + (i < 2 ? -pad : pad)),
        m
      ),
      clipped = [
        Math.max(full[0], q.clip[0]),
        Math.max(full[1], q.clip[1]),
        Math.min(full[2], q.clip[2]),
        Math.min(full[3], q.clip[3])
      ]
    if (!finite(clipped, 4)) return
    paints.push({ id, rect: clipped })
    const cmd = a[1]?.[0]
    if (
      a[0] !== OPS.stroke ||
      a[1]?.length !== 1 ||
      !finite(cmd, 6) ||
      cmd[0] !== 0 ||
      cmd[3] !== 1 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      !(m[0] > 0) ||
      !(m[3] < 0) ||
      q.strokeAlpha !== 1 ||
      q.solidStroke !== true ||
      q.lineCap !== 0 ||
      color !== '#000000'
    )
      continue
    const x0 = cmd[1] * m[0] + m[4],
      y0 = cmd[2] * m[3] + m[5],
      x1 = cmd[4] * m[0] + m[4],
      y1 = cmd[5] * m[3] + m[5],
      width = q.lineWidth * Math.max(Math.abs(m[0]), Math.abs(m[3]))
    if (y0 !== y1 || x0 === x1 || !(width > 0)) continue
    const paint = [Math.min(x0, x1), y0 - width / 2, Math.max(x0, x1), y0 + width / 2]
    if (inside(paint, q.clip))
      strokes.push({ id, segment: [Math.min(x0, x1), y0, Math.max(x0, x1), y1], paint, width })
  }
  if (stack.length) return
  const owned = origins.map((o) => records.get(o.index)),
    allInk = box(owned.map((r) => r.ink)),
    crop = table.cropRect.map((x) => x / v.scale),
    frames = []
  for (const top of strokes)
    for (const bottom of strokes) {
      if (
        !(top.paint[3] < allInk[1] && bottom.paint[1] > allInk[3]) ||
        !equal(
          [top.segment[0], top.segment[2], top.width],
          [bottom.segment[0], bottom.segment[2], bottom.width]
        ) ||
        !(top.segment[0] < allInk[0] && top.segment[2] > allInk[2])
      )
        continue
      const middle = strokes.filter(
        (s) =>
          s.paint[1] > top.paint[3] &&
          s.paint[3] < bottom.paint[1] &&
          s.width <= top.width &&
          equal([s.segment[0], s.segment[2]], [top.segment[0], top.segment[2]])
      )
      if (middle.length !== 1) continue
      const edge = middle[0],
        headerRecords = heads.flatMap((c) => c.sourceItems.map((o) => records.get(o.index)))
      const above = (r) => r.ink[3] < edge.paint[1] && r.ink[1] > top.paint[3],
        below = (r) => r.ink[1] > edge.paint[3] && r.ink[3] < bottom.paint[1]
      if (
        !headerRecords.every((r) => above(r) || below(r)) ||
        !heads.some(
          (c) =>
            c.sourceItems.some((o) => above(records.get(o.index))) &&
            c.sourceItems.some((o) => below(records.get(o.index)))
        ) ||
        heads.filter((c) => c.sourceItems.every((o) => above(records.get(o.index)))).length < 1
      )
        continue
      const headIndices = new Set(headerRecords.map((r) => r.index))
      if (owned.filter((r) => !headIndices.has(r.index)).some((r) => !below(r))) continue
      const area = [top.segment[0], top.paint[3], top.segment[2], bottom.paint[1]],
        selected = new Set(owned.flatMap((r) => r.part.map((z) => z.g)))
      if (
        packet.glyphs.some((g) => !selected.has(g) && valid(g.ink) && overlaps(g.ink, area)) ||
        packet.records.some((r) => !keys.has(r.index) && valid(r.ink) && overlaps(r.ink, area)) ||
        paints.some(
          (p) =>
            ![top.id, edge.id, bottom.id].includes(p.id) && valid(p.rect) && overlaps(p.rect, area)
        ) ||
        packet.evidence.images.some((i) => overlaps(i.rect, area))
      )
        continue
      const band = [allInk[0], top.paint[1], allInk[2], bottom.paint[3]]
      if (!inside(band, crop)) continue
      frames.push({ top, edge, bottom, band, owned })
    }
  if (frames.length !== 1) return
  const raster = getInitialPdfCropRaster(crop, nv)
  if (!raster) return
  return { ...frames[0], crop, raster }
}

function rasterConfirms(plan, image) {
  const canvas = createCanvas(image.width, image.height)
  try {
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data
    const dark = (x, y) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
      const i = (y * image.width + x) * 4
      return pixels[i + 3] === 255 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 128
    }
    const pixel = (r) => r.map((x, i) => (x - plan.crop[i % 2]) * plan.raster.scale)
    for (const line of [plan.top, plan.edge, plan.bottom]) {
      const r = pixel([plan.band[0], line.paint[1], plan.band[2], line.paint[3]]),
        left = Math.ceil(r[0]),
        right = Math.floor(r[2])
      if (left > right) return false
      for (let x = left; x <= right; x++) {
        let hit = false
        for (let y = Math.floor(r[1]); y <= Math.ceil(r[3]); y++) if (dark(x, y)) hit = true
        if (!hit) return false
      }
    }
    for (const record of plan.owned) {
      const r = pixel(record.ink)
      let hit = false
      for (
        let y = Math.max(0, Math.floor(r[1]));
        !hit && y < Math.min(image.height, Math.ceil(r[3]));
        y++
      )
        for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(image.width, Math.ceil(r[2])); x++)
          if (dark(x, y)) {
            hit = true
            break
          }
      if (!hit) return false
    }
    return true
  } finally {
    canvas.width = canvas.height = 0
  }
}

// Final review only. Body spans are preserved; a painted header-rule contradiction supplies no replacement grid.
export async function reviewFinalNativeHeaderRuleSources(
  table,
  inventory,
  rules,
  context,
  loadPng
) {
  try {
    if (typeof loadPng !== 'function') return table
    const plan = planConflict(table, inventory, rules, context)
    if (!plan) return table
    const initial = binding(table, inventory, rules, context),
      unchanged = retainInputIdentity([table, inventory, rules, context], context.viewport),
      expected = certificate(plan),
      value = await loadPng()
    if (
      !(value instanceof Uint8Array) ||
      !matchesInitialPdfCropPng(value, plan.raster) ||
      !unchanged() ||
      binding(table, inventory, rules, context) !== initial
    )
      return table
    const png = Buffer.from(value),
      protection = getPdfCropRasterProtectionFromPng(
        png,
        plan.crop,
        context.nativeGlyphContext.viewport
      )
    if (!protection) return table
    const image = await loadImage(png)
    const current = planConflict(table, inventory, rules, context)
    if (
      !png.equals(Buffer.from(value)) ||
      !unchanged() ||
      binding(table, inventory, rules, context) !== initial ||
      !current ||
      certificate(current) !== expected ||
      image.width !== plan.raster.pixelWidth ||
      image.height !== plan.raster.pixelHeight ||
      !rasterConfirms(plan, image)
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
