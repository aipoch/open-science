/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const digest = (b) => createHash('sha256').update(b).digest('hex')
const compact = (s) => s.replace(/\s/gu, '')
function plan(table, page, context) {
  const v = context?.viewport,
    sv = table?.sourceViewport
  if (
    !Number.isSafeInteger(page?.pageNumber) ||
    table?.page !== page.pageNumber ||
    context?.pageNumber !== page.pageNumber ||
    context?.sourceSha256?.length !== 64 ||
    !v ||
    v.rotation !== 0 ||
    v.scale !== 1 ||
    !finite(v.transform, 6) ||
    v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i]) ||
    v.width !== page.width ||
    v.height !== page.height ||
    !sv ||
    !(sv.scale > 0) ||
    sv.width !== v.width * sv.scale ||
    sv.height !== v.height * sv.scale ||
    !valid(table.cropRect) ||
    !valid(table.region) ||
    table.region.some((n) => n < 0 || n > 1) ||
    table.parts ||
    table.cropRects ||
    !Array.isArray(table.cells) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 3 ||
    table.grid.length > 16 ||
    table.cells.length > 128
  )
    return
  const columns = table.grid[0]?.length
  if (
    !Number.isSafeInteger(columns) ||
    columns < 5 ||
    columns > 13 ||
    columns % 2 !== 1 ||
    table.grid.some((r) => !Array.isArray(r) || r.length !== columns) ||
    table.cells.length !== table.grid.length * columns
  )
    return
  const items = context.content?.items
  if (!Array.isArray(items)) return
  const tokens = items.filter((i) => i.str?.trim()).map((i) => tableTextToken(i, v, 0)),
    byIndex = new Map(tokens.map((t) => [t.sourceItem?.index, t])),
    claims = [],
    keys = new Set(),
    slots = new Set()
  for (const c of table.cells) {
    if (
      !Number.isSafeInteger(c.row) ||
      !Number.isSafeInteger(c.column) ||
      c.row < 0 ||
      c.row >= table.grid.length ||
      c.column < 0 ||
      c.column >= columns ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      typeof c.text !== 'string' ||
      table.grid[c.row][c.column] !== c.text ||
      c.sourceSegments !== undefined ||
      slots.has(c.row + ':' + c.column)
    )
      return
    slots.add(c.row + ':' + c.column)
    if (!c.text.trim()) {
      if (c.sourceItems?.length || c.sourceRects?.length) return
      continue
    }
    if (
      !c.sourceItems?.length ||
      c.sourceRects?.length !== c.sourceItems.length ||
      compact(c.sourceItems.map((i) => i.text).join('')) !== compact(c.text)
    )
      return
    for (const [i, o] of c.sourceItems.entries()) {
      const t = byIndex.get(o.index)
      if (
        o.pageNumber !== page.pageNumber ||
        keys.has(o.index) ||
        !t ||
        t.sourceItem.text !== o.text ||
        !t.horizontal ||
        !valid(t.rect) ||
        !finite(c.sourceRects[i], 4) ||
        c.sourceRects[i].some((x, k) => Math.abs(x / sv.scale - t.rect[k]) > 1e-6)
      )
        return
      keys.add(o.index)
      claims.push(o)
    }
  }
  const head = table.cells.filter((c) => c.row === 0),
    empty = head.filter((c) => !c.text.trim())
  if (
    empty.length !== 1 ||
    empty[0].column !== 0 ||
    head.slice(1).some((c) => !c.sourceItems?.length)
  )
    return
  const headIndices = new Set(head.flatMap((c) => c.sourceItems ?? []).map((o) => o.index)),
    headTokens = tokens.filter((t) => headIndices.has(t.sourceItem.index)),
    topOfLeaf = Math.min(...headTokens.map((t) => t.rect[1])),
    region = table.region.map((n, i) => n * (i % 2 ? v.height : v.width))
  const missing = tokens.filter(
    (t) =>
      !keys.has(t.sourceItem.index) &&
      t.horizontal &&
      t.rect[0] >= region[0] &&
      t.rect[2] <= region[2] &&
      t.rect[3] > region[1] &&
      t.rect[1] < topOfLeaf
  )
  if (
    missing.length < 3 ||
    missing.some((t) => !t.text.trim()) ||
    claims.length + missing.length > 64
  )
    return
  const whole = [...claims, ...missing.map((t) => t.sourceItem)],
    p = nativeFractionInkPacket(page, tokens, context, whole)
  if (!p) return
  const selected = new Set(whole.map((o) => o.index)),
    owned = p.records.filter((r) => selected.has(r.index)),
    paths = [],
    stack = []
  let color = '#000000'
  for (const [id, op] of p.o.fnArray.entries()) {
    const a = p.o.argsArray[id]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      color = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) color = a?.[0]
    else if (
      [
        OPS.setStrokeGray,
        OPS.setStrokeCMYKColor,
        OPS.setStrokeColor,
        OPS.setStrokeColorN,
        OPS.setStrokeTransparent
      ].includes(op)
    )
      color = undefined
    if (op !== OPS.constructPath || !p.evidence.paths.has(id)) continue
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (a?.length === 3 && a[1]?.length === 1 && a[1][0] === null && a[2] === null) continue
    if (!finite(a?.[2], 4)) return
    const q = p.evidence.paths.get(id),
      m = Util.transform(v.transform, q.transform),
      margin = (q.lineWidth * Math.max(Math.abs(m[0]), Math.abs(m[3]))) / 2,
      b = p.box(Array.from(a[2]), m),
      envelope = b.map((x, i) => x + (i < 2 ? -margin : margin))
    if (!finite(envelope, 4) || !finite(q.clip, 4)) return
    if (!overlap(envelope, region)) continue
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
      color !== '#000000' ||
      !(margin > 0) ||
      !inside(envelope, q.clip)
    )
      return
    const x0 = cmd[1] * m[0] + m[4],
      y0 = cmd[2] * m[3] + m[5],
      x1 = cmd[4] * m[0] + m[4],
      y1 = cmd[5] * m[3] + m[5],
      horizontal = y0 === y1 && x0 !== x1,
      vertical = x0 === x1 && y0 !== y1
    if (
      (!horizontal && !vertical) ||
      Array.from(a[2]).some(
        (n, i) =>
          n !==
          [
            Math.min(cmd[1], cmd[4]),
            Math.min(cmd[2], cmd[5]),
            Math.max(cmd[1], cmd[4]),
            Math.max(cmd[2], cmd[5])
          ][i]
      )
    )
      return
    paths.push({
      id,
      horizontal,
      width: margin * 2,
      segment: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
      paint: horizontal
        ? [Math.min(x0, x1), y0 - margin, Math.max(x0, x1), y0 + margin]
        : [x0 - margin, Math.min(y0, y1), x0 + margin, Math.max(y0, y1)]
    })
  }
  if (stack.length) return
  const rails = paths.filter((p) => p.horizontal).sort((a, b) => a.segment[1] - b.segment[1])
  if (rails.length !== 3) return
  const [top, edge, bottom] = rails
  if (
    !rails.every(
      (r) =>
        r.segment[0] === top.segment[0] && r.segment[2] === top.segment[2] && r.width === top.width
    )
  )
    return
  const frame = [top.segment[0], top.paint[3], top.segment[2], bottom.paint[1]],
    header = [frame[0], frame[1], frame[2], edge.paint[1]],
    body = [frame[0], edge.paint[3], frame[2], frame[3]],
    vertical = paths.filter((p) => !p.horizontal),
    xs = [...new Set(vertical.map((p) => p.segment[0]))].sort((a, b) => a - b)
  if (
    !valid(header) ||
    !valid(body) ||
    !inside(frame, region) ||
    xs.length !== 2 ||
    xs.some((x) => x <= frame[0] || x >= frame[2]) ||
    vertical.some((p) => p.segment[1] < top.paint[1] || p.segment[3] > bottom.paint[3])
  )
    return
  for (const x of xs) {
    let end = top.paint[3]
    for (const line of vertical
      .filter((p) => p.segment[0] === x && p.segment[1] < edge.paint[1])
      .sort((a, b) => a.segment[1] - b.segment[1])) {
      if (line.width !== top.width || line.segment[1] > end) return
      end = Math.max(end, line.segment[3])
    }
    if (end < edge.paint[1]) return
  }
  if (
    owned.length !== whole.length ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        r.part.some(
          (z) =>
            z.g.rendererSkipped ||
            z.g.textPaint?.fillColor !== '#000000' ||
            z.g.textPaint.fillAlpha !== 1
        )
    )
  )
    return
  const glyphs = new Set()
  for (const record of owned)
    for (const glyph of new Set(record.part.map((z) => z.g))) {
      if (glyphs.has(glyph)) return
      glyphs.add(glyph)
    }
  if (
    p.records.some((r) => !selected.has(r.index) && valid(r.ink) && overlap(r.ink, frame)) ||
    p.glyphs.some((g) => !glyphs.has(g) && valid(g.ink) && overlap(g.ink, frame)) ||
    p.evidence.images.some((i) => overlap(i.rect, frame))
  )
    return
  const absent = new Set(missing.map((t) => t.sourceItem.index)),
    upper = owned.filter((r) => absent.has(r.index)),
    leaves = owned.filter((r) => headIndices.has(r.index)),
    data = owned.filter((r) => !absent.has(r.index) && !headIndices.has(r.index)),
    upperBaseline = tableTextToken(upper[0].r, v, 0).baseline,
    leafBaseline = tableTextToken(leaves[0].r, v, 0).baseline
  if (
    !upper.every((r) => inside(r.ink, header)) ||
    !leaves.every((r) => inside(r.ink, header)) ||
    !data.every((r) => inside(r.ink, body)) ||
    Math.max(...upper.map((r) => r.ink[3])) >= Math.min(...leaves.map((r) => r.ink[1])) ||
    !Number.isFinite(upperBaseline) ||
    !Number.isFinite(leafBaseline) ||
    upper.some((r) => tableTextToken(r.r, v, 0).baseline !== upperBaseline) ||
    leaves.some((r) => tableTextToken(r.r, v, 0).baseline !== leafBaseline)
  )
    return
  const bands = [
      [frame[0], xs[0]],
      [xs[0], xs[1]],
      [xs[1], frame[2]]
    ],
    groups = bands.map(([l, r]) => upper.filter((o) => o.ink[0] > l && o.ink[2] < r)),
    lower = bands.map(([l, r]) => leaves.filter((o) => o.ink[0] > l && o.ink[2] < r)),
    leafCount = (columns - 1) / 2
  if (
    groups[0].length !== 1 ||
    groups[1].length < 2 ||
    groups[2].length < 2 ||
    groups.flat().length !== upper.length ||
    lower[0].length !== 0 ||
    lower[1].length !== leafCount ||
    lower[2].length !== leafCount ||
    leaves.length !== columns - 1
  )
    return
  const raster = context.captionLaneRaster
  if (
    raster?.page !== page.pageNumber ||
    raster.sourceSha256 !== context.sourceSha256 ||
    raster.scale !== 1.5 ||
    raster.width !== Math.ceil(v.width * raster.scale) ||
    raster.height !== Math.ceil(v.height * raster.scale) ||
    raster.width * raster.height > 4_000_000 ||
    !/^[a-f0-9]{64}$/u.test(raster.sha256)
  )
    return
  return { paths, inks: owned.map((r) => r.ink), raster }
}
function rasterConfirms(p, image) {
  if (image.width !== p.raster.width || image.height !== p.raster.height) return false
  const canvas = createCanvas(image.width, image.height)
  try {
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data,
      scale = p.raster.scale,
      dark = (x, y) => {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
        const i = (y * image.width + x) * 4
        return pixels[i + 3] === 255 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 128
      }
    for (const path of p.paths) {
      const b = path.paint.map((x) => x * scale)
      if (path.horizontal) {
        if (Math.ceil(b[0]) >= Math.floor(b[2])) return false
        for (let x = Math.ceil(b[0]); x < Math.floor(b[2]); x++) {
          let hit = false
          for (let y = Math.floor(b[1]); y <= Math.ceil(b[3]); y++) hit ||= dark(x, y)
          if (!hit) return false
        }
      } else {
        if (Math.ceil(b[1]) >= Math.floor(b[3])) return false
        for (let y = Math.ceil(b[1]); y < Math.floor(b[3]); y++) {
          let hit = false
          for (let x = Math.floor(b[0]); x <= Math.ceil(b[2]); x++) hit ||= dark(x, y)
          if (!hit) return false
        }
      }
    }
    for (const ink of p.inks) {
      const b = ink.map((x) => x * scale)
      let hit = false
      for (let y = Math.floor(b[1]); !hit && y <= Math.ceil(b[3]); y++)
        for (let x = Math.floor(b[0]); x <= Math.ceil(b[2]); x++)
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
// A proved omitted parent band pauses mapping; it does not supply replacement spans.
export async function reviewNativeMissingGroupHeader(table, { page, context }, loadPng) {
  try {
    if (typeof loadPng !== 'function') return table
    const unchanged = retainNativeRecoveryInputs([table, page, context, loadPng], context?.viewport)
    if (!unchanged) return table
    const p = plan(table, page, context)
    if (!p) return table
    const certificate = JSON.stringify(p),
      value = await loadPng(p.raster)
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > 4 * 1024 * 1024 ||
      value.byteLength < 24 ||
      !unchanged() ||
      digest(value) !== p.raster.sha256
    )
      return table
    const bytes = Buffer.from(value)
    if (
      bytes.readUInt32BE(0) !== 0x89504e47 ||
      bytes.readUInt32BE(4) !== 0x0d0a1a0a ||
      bytes.readUInt32BE(16) !== p.raster.width ||
      bytes.readUInt32BE(20) !== p.raster.height
    )
      return table
    const current = plan(table, page, context)
    if (!current || JSON.stringify(current) !== certificate) return table
    const image = await loadImage(bytes)
    if (
      !unchanged() ||
      digest(value) !== p.raster.sha256 ||
      !rasterConfirms(p, image) ||
      !unchanged()
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
