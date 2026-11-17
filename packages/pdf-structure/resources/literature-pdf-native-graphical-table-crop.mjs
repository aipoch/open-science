import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const near = (a, b) => Math.abs(a - b) < 1e-6
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const visible = (color) =>
  typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color) && color.toLowerCase() !== '#ffffff'

// Keep the exact saved opaque text/stroke state. A valid outline or source
// advance does not establish that the corresponding glyph was painted.
function paintStates(operators) {
  let fillAlpha = 1,
    fillColor = '#000000',
    strokeColor = '#000000'
  const stack = [],
    texts = new Map(),
    paths = new Map()
  for (const [index, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[index]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ fillAlpha, fillColor, strokeColor })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ fillAlpha, fillColor, strokeColor } = stack.pop())
    } else if (op === OPS.setGState) {
      if (!Array.isArray(args?.[0])) return
      for (const [key, value] of args[0]) if (key === 'ca') fillAlpha = value
    } else if (op === OPS.setFillRGBColor) fillColor = args?.[0]
    else if (op === OPS.setStrokeRGBColor) strokeColor = args?.[0]
    else if (op === OPS.showText) texts.set(index, { fillAlpha, fillColor })
    else if (op === OPS.constructPath) paths.set(index, { strokeColor, fillColor })
  }
  return stack.length ? undefined : { texts, paths }
}

// This proves only a rendering boundary. Existing slots, mathematical strings,
// source claims and ambiguity warnings remain untouched. Repeated native rule
// endpoints and interior fences delimit the graphical column independently of
// the detector edge; no missing rule or cell is synthesized.
export function proveNativeGraphicalTableCrop(table, scope) {
  try {
    const { page, context, competingRects, captions } = scope ?? {},
      native = context?.nativeGlyphContext,
      v = native?.viewport,
      work = context?.viewport,
      grid = table?.grid
    if (
      !valid(table?.cropRect) ||
      table.parts !== undefined ||
      table.cropRects !== undefined ||
      table.caption !== undefined ||
      (table.notes !== undefined && (!Array.isArray(table.notes) || table.notes.length)) ||
      !Number.isSafeInteger(table.page) ||
      table.page < 1 ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      !Array.isArray(page.graphicsBounds) ||
      !Array.isArray(grid) ||
      grid.length < 3 ||
      !Array.isArray(grid[0]) ||
      grid[0].length < 3 ||
      grid.some((r) => !Array.isArray(r) || r.length !== grid[0].length) ||
      grid[0].some((text) => typeof text !== 'string' || !/\p{L}/u.test(text)) ||
      grid
        .slice(1)
        .some(
          (row) =>
            row.at(-1) !== '' ||
            row.slice(0, -1).some((text) => typeof text !== 'string' || !text.trim())
        ) ||
      !Array.isArray(table.cells) ||
      table.cells.length !== grid.length * grid[0].length ||
      !equal(page.graphicsBounds, native?.graphicsBounds) ||
      new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !==
        page.graphicsBounds.length ||
      !equal(v?.transform, [1, 0, 0, -1, 0, page.height]) ||
      v?.scale !== 1 ||
      v?.rotation !== 0 ||
      !(work?.scale > 0) ||
      work.rotation !== 0 ||
      !equal(work.transform, [work.scale, 0, 0, -work.scale, 0, work.height]) ||
      work.width !== page.width * work.scale ||
      work.height !== page.height * work.scale ||
      context.content !== context.sourceContent ||
      !Array.isArray(context.sourceContent?.items) ||
      context.sourceContent.items.length !== native.content?.items?.length ||
      !Array.isArray(competingRects) ||
      !competingRects.every(valid) ||
      !Array.isArray(captions) ||
      !captions.every((c) => valid(c.rect))
    )
      return
    const forward = new Map(),
      reverse = new Map(),
      nativeTokens = []
    for (const [index, raw] of native.content.items.entries()) {
      const current = context.sourceContent.items[index]
      if (
        ['str', 'width', 'height', 'dir'].some((k) => raw[k] !== current[k]) ||
        !equal(raw.transform, current.transform) ||
        !equal(
          native.content.styles[raw.fontName],
          context.sourceContent.styles[current.fontName]
        ) ||
        (forward.has(raw.fontName) && forward.get(raw.fontName) !== current.fontName) ||
        (reverse.has(current.fontName) && reverse.get(current.fontName) !== raw.fontName)
      )
        return
      forward.set(raw.fontName, current.fontName)
      reverse.set(current.fontName, raw.fontName)
      if (!raw.str?.trim()) continue
      if (
        !finite(raw.transform, 6) ||
        raw.transform[1] ||
        raw.transform[2] ||
        raw.transform[0] <= 0 ||
        raw.transform[3] <= 0 ||
        raw.height !== raw.transform[3] ||
        raw.dir !== 'ltr' ||
        native.content.styles[raw.fontName]?.vertical
      )
        return
      const source = { pageNumber: table.page, index, text: raw.str }
      if (!equal(current.sourceItem, source)) return
      nativeTokens.push(tableTextToken({ ...raw, sourceItem: source }, v, 0))
    }
    const inventory = nativePageTextPacketInventory(page, nativeTokens, native, true),
      states = inventory && paintStates(native.operators)
    if (!inventory || !states || inventory.evidence.images.length) return
    const rules = collectTableRules(native.operators, v),
      paints = []
    for (const [id, state] of inventory.evidence.paths) {
      const args = native.operators.argsArray[id]
      if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(args?.[0])) continue
      const sequence = Array.from(args?.[1]?.[0] ?? []),
        transform = finite(state.transform, 6) && Util.transform(v.transform, state.transform)
      if (
        args?.[0] !== OPS.stroke ||
        sequence.length < 6 ||
        sequence.length % 3 ||
        !sequence.every(Number.isFinite) ||
        sequence[0] !== 0 ||
        sequence.some((n, i) => i % 3 === 0 && n !== 0 && n !== 1) ||
        !transform ||
        transform[1] !== 0 ||
        transform[2] !== 0 ||
        !(state.lineWidth > 0) ||
        state.lineCap !== 0 ||
        !state.solidStroke ||
        state.strokeAlpha !== 1 ||
        !visible(states.paths.get(id)?.strokeColor) ||
        page.graphicsBounds.filter((g) => g.operationIndex === id && g.kind === 'path').length !== 1
      )
        return
      const points = []
      for (let i = 0; i < sequence.length; i += 3) {
        const point = [sequence[i + 1], sequence[i + 2]]
        Util.applyTransform(point, transform)
        points.push(point)
      }
      const raw = union(points.map(([x, y]) => [x, y, x, y])),
        single = points.length === 2 && (near(raw[0], raw[2]) || near(raw[1], raw[3]))
      let rule, ink
      if (single) {
        const matches = rules.filter((r) => r.every((n, i) => near(n, raw[i])))
        if (matches.length !== 1) return
        rule = matches[0]
        const half =
          (state.lineWidth * Math.abs(near(raw[0], raw[2]) ? transform[0] : transform[3])) / 2
        ink = near(raw[0], raw[2])
          ? [raw[0] - half, raw[1], raw[2] + half, raw[3]]
          : [raw[0], raw[1] - half, raw[2], raw[3] + half]
      }
      const margin = (state.lineWidth * Math.max(1, inventory.strokeMargins.get(id) ?? 10)) / 2,
        bound =
          ink ??
          inventory.box(
            [
              Math.min(...sequence.filter((_, i) => i % 3 === 1)) - margin,
              Math.min(...sequence.filter((_, i) => i % 3 === 2)) - margin,
              Math.max(...sequence.filter((_, i) => i % 3 === 1)) + margin,
              Math.max(...sequence.filter((_, i) => i % 3 === 2)) + margin
            ],
            transform
          )
      if (!valid(bound) || !valid(state.clip) || !inside(state.clip, bound)) return
      paints.push({
        id,
        rule,
        ink,
        bound,
        diagonal: points.some(
          (p, i) =>
            i && sequence[i * 3] === 1 && p[0] !== points[i - 1][0] && p[1] !== points[i - 1][1]
        )
      })
    }
    if (paints.length !== page.graphicsBounds.length) return
    const old = table.cropRect.map((n) => n / work.scale),
      groups = new Map()
    for (const r of joinHorizontalTableRules(rules)) {
      const key = JSON.stringify([r[0], r[2]])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    }
    const candidates = [...groups.values()].filter(
      (g) =>
        g.length === grid.length + 1 &&
        g[0][0] >= old[0] &&
        g[0][2] > old[2] &&
        Math.min(...g.map((r) => r[1])) > old[1] &&
        Math.max(...g.map((r) => r[1])) < old[3]
    )
    if (candidates.length !== 1) return
    const h = candidates[0].sort((a, b) => a[1] - b[1]),
      left = h[0][0],
      right = h[0][2],
      hp = h.map((r) =>
        paints.filter(
          (p) =>
            p.rule &&
            near(p.rule[1], p.rule[3]) &&
            near(p.rule[1], r[1]) &&
            p.rule[0] >= left - 1e-6 &&
            p.rule[2] <= right + 1e-6
        )
      )
    if (hp.some((ps) => !ps.length)) return
    for (const ps of hp) {
      let end = left
      for (const p of [...ps].sort((a, b) => a.ink[0] - b.ink[0])) {
        if (p.ink[0] > end + 1e-6) return
        end = Math.max(end, p.ink[2])
      }
      if (!near(end, right)) return
    }
    const hpaint = hp.map((ps) => union(ps.map((p) => p.ink))),
      xs = []
    for (const r of rules.filter((r) => near(r[0], r[2]) && r[0] > left && r[0] < right))
      if (!xs.some((x) => near(x, r[0]))) xs.push(r[0])
    const lanes = xs
      .map((x) => ({
        x,
        rows: h
          .slice(1)
          .map((_, i) =>
            paints.filter(
              (p) =>
                p.rule &&
                near(p.rule[0], p.rule[2]) &&
                near(p.rule[0], x) &&
                p.ink[1] <= hpaint[i][3] + 1e-6 &&
                p.ink[3] >= hpaint[i + 1][1] - 1e-6
            )
          )
      }))
      .filter((lane) => lane.rows.every((r) => r.length === 1))
      .sort((a, b) => a.x - b.x)
    if (lanes.length !== grid[0].length - 1 || old[2] <= lanes.at(-1).x) return
    const cuts = [left, ...lanes.map((lane) => lane.x), right],
      frameRules = new Set([...hp.flat(), ...lanes.flatMap((lane) => lane.rows.flat())]),
      frame = union([...frameRules].map((p) => p.ink)),
      claimed = new Set(),
      claimedGlyphs = new Set(),
      slots = new Set()
    for (const cell of table.cells) {
      if (
        !cell ||
        !Number.isInteger(cell.row) ||
        cell.row < 0 ||
        cell.row >= grid.length ||
        !Number.isInteger(cell.column) ||
        cell.column < 0 ||
        cell.column >= grid[0].length ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        cell.text !== grid[cell.row][cell.column] ||
        typeof cell.text !== 'string' ||
        cell.sourceItem != null ||
        cell.sourceToken != null ||
        cell.sourceSegment != null ||
        (cell.sourceSegments !== undefined &&
          (!Array.isArray(cell.sourceSegments) || cell.sourceSegments.length)) ||
        !Array.isArray(cell.sourceRects) ||
        (cell.sourceItems !== undefined && !Array.isArray(cell.sourceItems)) ||
        (cell.sourceItems?.length ?? 0) !== cell.sourceRects.length ||
        slots.has(cell.row + ':' + cell.column)
      )
        return
      slots.add(cell.row + ':' + cell.column)
      if (cell.row > 0 && cell.column === cuts.length - 2) {
        if (cell.text !== '' || cell.sourceRects.length) return
        continue
      }
      if (!cell.sourceItems?.length || (cell.row === 0 && !/\p{L}/u.test(cell.text))) return
      for (const [i, source] of cell.sourceItems.entries()) {
        const record = inventory.records.find((r) => r.index === source.index),
          raw = native.content.items[source.index],
          current = context.sourceContent.items[source.index]
        if (
          !record ||
          claimed.has(record.index) ||
          source.pageNumber !== table.page ||
          source.text !== raw.str
        )
          return
        const glyphs = [...new Set(record.part.map((p) => p.g))]
        if (
          glyphs.some(
            (g) =>
              !valid(g.ink) ||
              claimedGlyphs.has(g) ||
              states.texts.get(g.i)?.fillAlpha !== 1 ||
              !visible(states.texts.get(g.i)?.fillColor)
          )
        )
          return
        const band = [cuts[cell.column], h[cell.row][1], cuts[cell.column + 1], h[cell.row + 1][1]],
          ink = union(glyphs.map((g) => g.ink)),
          token = tableTextToken(current, work, 0)
        if (!equal(token.rect, cell.sourceRects[i]) || !inside(band, ink)) return
        claimed.add(record.index)
        for (const glyph of glyphs) claimedGlyphs.add(glyph)
      }
    }
    if (
      inventory.records.some(
        (r) => over(union(r.part.map((p) => p.g.ink)), frame) && !claimed.has(r.index)
      )
    )
      return
    const graphical = paints.filter((p) => !frameRules.has(p) && over(p.bound, frame)),
      graphicRows = h
        .slice(2)
        .map((bottom, i) =>
          graphical.filter((p) => inside([cuts.at(-2), h[i + 1][1], right, bottom[1]], p.bound))
        )
    if (
      graphicRows.some((row) => !row.length || !row.some((p) => p.diagonal)) ||
      new Set(graphicRows.flat()).size !== graphical.length
    )
      return
    const ownedPaint = new Set([...frameRules, ...graphical]),
      foreignPaints = paints.filter((p) => !ownedPaint.has(p)).map((p) => p.bound),
      foreignGlyphs = inventory.glyphs.filter((g) => !claimedGlyphs.has(g)).map((g) => g.ink),
      nativeCrop = [old[0], old[1], right, old[3]]
    if (
      !inside(nativeCrop, frame) ||
      !inside([0, 0, page.width, page.height], nativeCrop) ||
      paints.some((p) => ownedPaint.has(p) && !inside(nativeCrop, p.bound)) ||
      [...foreignPaints, ...foreignGlyphs].some((r) => !valid(r) || over(r, nativeCrop)) ||
      competingRects.some((r) => over(r, nativeCrop)) ||
      captions.some((c) => over(c.rect, nativeCrop))
    )
      return
    return {
      cropRect: [table.cropRect[0], table.cropRect[1], right * work.scale, table.cropRect[3]],
      nativeCrop,
      bounds: { width: page.width, height: page.height },
      foreignPaints,
      foreignGlyphs
    }
  } catch {
    return
  }
}

// Validate the actual PNG, including byte-budget retries. No scale is guessed
// from advances or from the initial renderer settings.
export function validateNativeGraphicalTableCropPng(png, proof) {
  if (!proof || !Array.isArray(proof.foreignPaints) || !Array.isArray(proof.foreignGlyphs))
    return false
  const raster = getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds)
  return (
    !!raster &&
    inside([0, 0, proof.bounds.width, proof.bounds.height], raster.protection) &&
    [...proof.foreignPaints, ...proof.foreignGlyphs].every(
      (r) => valid(r) && !over(r, raster.protection)
    )
  )
}

// Two aligned rows of opaque cell fills immediately above a full-width body
// rule identify the header of this graphical table.
function completeFilledHeader(table, page, native, boxes, competingRects, current) {
  const tokens = native.content.items.flatMap((item, index) =>
    item.str?.trim()
      ? [
          tableTextToken(
            { ...item, sourceItem: { pageNumber: page.pageNumber, index, text: item.str } },
            native.viewport,
            0
          )
        ]
      : []
  )
  const inv = nativePageTextPacketInventory(page, tokens, native, true)
  const states = inv && paintStates(native.operators)
  if (!inv || !states || inv.evidence.images.length) return
  const old = table.rect
  if (table.caption.rect[1] < old[3]) return
  const maxTop = old[1] - 30
  const local = [],
    foreignPaints = []
  for (const [index, state] of inv.evidence.paths) {
    const args = inv.o.argsArray[index]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(args?.[0])) continue
    const rect = nativeFigurePathPaint(inv, index, state)?.rect
    if (!valid(rect) || (state.clip && !inside(state.clip, rect))) return
    if (!over(rect, [old[0], maxTop, old[2], old[1]])) {
      if (!over(rect, old)) foreignPaints.push(rect)
      continue
    }
    const color = states.paths.get(index)?.fillColor
    const seq = Array.from(args?.[1]?.[0] ?? [])
    const x = [seq[1], seq[4], seq[7], seq[10]],
      y = [seq[2], seq[5], seq[8], seq[11]]
    if (
      args[0] !== OPS.fill ||
      state.fillAlpha !== 1 ||
      !visible(color) ||
      seq.length !== 13 ||
      [seq[0], seq[3], seq[6], seq[9], seq[12]].join(',') !== '0,1,1,1,4' ||
      !seq.every(Number.isFinite) ||
      new Set(x).size !== 2 ||
      new Set(y).size !== 2 ||
      !x.every((v, n) => v === x[(n + 1) % 4] || y[n] === y[(n + 1) % 4]) ||
      state.transform[1] !== 0 ||
      state.transform[2] !== 0 ||
      rect[0] < old[0] ||
      rect[2] > old[2] ||
      rect[1] < maxTop
    )
      return
    local.push({ rect, color, index })
  }
  const bands = []
  for (const { rect, color } of local.sort((a, b) => a.rect[1] - b.rect[1])) {
    const band = bands.at(-1)
    if (band && Math.abs(band.rects[0][1] - rect[1]) < 0.01) band.rects.push(rect)
    else bands.push({ rects: [rect], color })
    if (bands.at(-1).color !== color) return
  }
  if (bands.length !== 2 || bands[0].color !== bands[1].color) return
  const [upper, lower] = bands.map(({ rects }) => rects.sort((a, b) => a[0] - b[0]))
  if (upper.length < 3 || upper.length !== lower.length || upper.length > 32) return
  const frame = union([...upper, ...lower]),
    height = upper[0][3] - upper[0][1]
  if (
    !(height > 0) ||
    frame[0] - old[0] > height ||
    old[2] - frame[2] > height ||
    frame[3] < old[1] ||
    frame[3] - old[1] > height * 0.4 ||
    Math.abs(lower[0][1] - upper[0][3]) > 0.01 ||
    upper.some(
      (r, i) => Math.abs(r[0] - lower[i][0]) > 0.01 || Math.abs(r[2] - lower[i][2]) > 0.01
    ) ||
    [upper, lower].some((band) =>
      band.some(
        (r, i) =>
          Math.abs(r[1] - band[0][1]) > 0.01 ||
          Math.abs(r[3] - band[0][3]) > 0.01 ||
          (i && Math.abs(r[0] - band[i - 1][2]) > 0.01)
      )
    ) ||
    !joinHorizontalTableRules(collectTableRules(native.operators, native.viewport)).some(
      (r) =>
        Math.abs(r[1] - frame[3]) < height * 0.2 &&
        Math.abs(r[0] - frame[0]) < height * 0.2 &&
        Math.abs(r[2] - frame[2]) < height * 0.2
    )
  )
    return
  const header = boxes.filter((box) =>
    over(box.rect, [frame[0], frame[1] - height * 0.4, frame[2], frame[3]])
  )
  const rows = [upper, lower].map((band) =>
    header.filter((box) =>
      band.some(
        (r) =>
          inside([r[0], r[1] - height * 0.4, r[2], r[3]], box.rect) &&
          (box.rect[1] + box.rect[3]) / 2 > r[1] &&
          (box.rect[1] + box.rect[3]) / 2 < r[3]
      )
    )
  )
  if (
    rows.some((row) => row.length < upper.length - 1) ||
    new Set(rows.flat()).size !== header.length
  )
    return
  if (
    local.some(
      ({ index }) =>
        !native.graphicsBounds.some(
          (graphic) => graphic.operationIndex === index && graphic.kind === 'path'
        )
    )
  )
    return
  const nativeCrop = [
    old[0],
    Math.min(frame[1], ...header.map((box) => box.rect[1])) - 0.5,
    old[2],
    old[3]
  ]
  const extra = [nativeCrop[0], nativeCrop[1], nativeCrop[2], old[1]]
  if (
    !valid(extra) ||
    old[1] - nativeCrop[1] > 30 ||
    !inside([0, 0, page.width, page.height], nativeCrop) ||
    competingRects.some((rect) => over(rect, extra)) ||
    boxes.some((box) => !header.includes(box) && over(box.rect, extra)) ||
    foreignPaints.some((rect) => over(rect, extra)) ||
    !current()
  )
    return
  return {
    table: { ...table, rect: nativeCrop },
    current,
    nativeCrop,
    bounds: { width: page.width, height: page.height },
    foreignGlyphs: boxes
      .filter((box) => !header.includes(box) && !over(box.rect, old))
      .map((box) => box.rect),
    foreignPaints: [...foreignPaints, ...competingRects]
  }
}

// Complete native vector-rule tables published as PNGs without a cell grid.
// Raster/mixed-image pages keep their existing fallback; foreign fonts stay excluded.
export function completeNativeUnstructuredTableCrop(table, scope) {
  try {
    const { page, context, competingRects } = scope ?? {},
      native = context?.nativeGlyphContext,
      v = native?.viewport,
      work = context?.viewport,
      content = native?.content,
      graphics = native?.graphicsBounds
    if (
      !table?.caption ||
      table.nativeBody ||
      table.parts ||
      table.cropRects ||
      (table.grid?.length ?? 0) ||
      (table.cells?.length ?? 0) ||
      (table.issues !== undefined && !equal(table.issues, ['no-source-cell-grid'])) ||
      !valid(table.rect) ||
      table.caption.page !== page?.pageNumber ||
      page.invalidGraphicsBounds !== 0 ||
      !equal(graphics, page.graphicsBounds) ||
      !Array.isArray(graphics) ||
      !graphics.length ||
      graphics.length > 10000 ||
      !Array.isArray(content?.items) ||
      !equal(v?.transform, [1, 0, 0, -1, 0, page.height]) ||
      v.rotation !== 0 ||
      v.scale !== 1 ||
      !(work?.scale > 0) ||
      work.rotation !== 0 ||
      work.width !== page.width * work.scale ||
      work.height !== page.height * work.scale ||
      !Array.isArray(competingRects) ||
      !competingRects.every(valid)
    )
      return
    const primary = context.sourceContent
    if (!Array.isArray(primary?.items) || primary.items.length !== content.items.length) return
    for (const [index, item] of content.items.entries()) {
      const current = primary.items[index]
      if (
        ['str', 'width', 'height', 'dir'].some((key) => item[key] !== current[key]) ||
        !equal(item.transform, current.transform) ||
        !equal(content.styles[item.fontName], primary.styles[current.fontName])
      )
        return
    }
    const binding = JSON.stringify([table, page, context, competingRects]),
      current = () => binding === JSON.stringify([table, page, context, competingRects]),
      old = table.rect,
      boxes = []
    for (const [index, item] of content.items.entries()) {
      if (!item.str?.trim()) continue
      const style = content.styles?.[item.fontName],
        t = item.transform
      if (
        !finite(t, 6) ||
        item.dir !== 'ltr' ||
        style?.vertical !== false ||
        ![item.width, item.height, style?.ascent, style?.descent].every(Number.isFinite) ||
        t[0] <= 0 ||
        t[3] <= 0 ||
        t[1] ||
        t[2] ||
        item.height !== t[3] ||
        item.width <= 0 ||
        style.ascent <= style.descent
      )
        return
      const rect = [
        t[4],
        page.height - t[5] - style.ascent * t[3],
        t[4] + item.width,
        page.height - t[5] - style.descent * t[3]
      ]
      if (!valid(rect)) return
      boxes.push({ index, text: item.str, rect })
    }
    const selected = boxes.filter((b) => over(b.rect, old))
    if (selected.length < 9) return
    const header =
      native.glyphBounds &&
      completeFilledHeader(table, page, native, boxes, competingRects, current)
    if (header) return header
    const rulePaintBounds = new Map(),
      rulePaintOperations = new Map()
    collectTableRules(native.operators, v, rulePaintBounds, rulePaintOperations)
    const graph = graphics.map((g) => {
      const r = g.normalizedRect
      return g.kind === 'path' && valid(r)
        ? r.map((n, i) => n * (i % 2 ? page.height : page.width))
        : undefined
    })
    if (graph.some((r) => !r)) return
    const components = []
    for (const rect of graph) {
      let component = { rect, parts: [rect] }
      for (let i = 0; i < components.length;) {
        const a = component.rect,
          b = components[i].rect,
          connected =
            a[0] <= b[2] + page.width * 0.006 &&
            a[2] + page.width * 0.006 >= b[0] &&
            a[1] <= b[3] + page.height * 0.006 &&
            a[3] + page.height * 0.006 >= b[1]
        if (connected) {
          const previous = components.splice(i, 1)[0]
          component = { rect: union([a, b]), parts: [...component.parts, ...previous.parts] }
          i = 0
        } else i++
      }
      components.push(component)
    }
    const candidates = components.filter(
      (c) =>
        c.parts.length >= 5 &&
        c.rect[2] - c.rect[0] >= 30 &&
        c.rect[3] - c.rect[1] >= 30 &&
        selected.every((b) => inside(c.rect, b.rect))
    )
    if (candidates.length !== 1) return
    const component = candidates[0],
      exact = []
    for (const rect of component.parts) {
      const graphic = graphics[graph.indexOf(rect)],
        keys = rulePaintOperations.get(graphic.operationIndex)
      if (!keys?.size) return
      for (const key of keys) {
        const paint = rulePaintBounds.get(key)
        if (!valid(paint) || !inside(rect, paint)) return
        exact.push(paint)
      }
    }
    const exactGraph = union(exact)
    if (!selected.every((b) => inside(exactGraph, b.rect))) return
    const nativeCrop = union([old, exactGraph, ...selected.map((b) => b.rect)]),
      foreignGlyphs = boxes.filter((b) => !selected.includes(b)).map((b) => b.rect),
      foreignPaints = components.filter((c) => c !== component).map((c) => c.rect),
      captionBoxes = boxes.filter((b) => over(b.rect, table.caption.rect)),
      captionText = captionBoxes
        .map((box, position) => {
          const item = content.items[box.index],
            next = content.items[captionBoxes[position + 1]?.index]
          const between = content.items.slice(
              box.index + 1,
              captionBoxes[position + 1]?.index ?? box.index + 1
            ),
            lineEnd =
              item.hasEOL ||
              (between.every((i) => typeof i.str === 'string' && !i.str.trim()) &&
                between.some((i) => i.hasEOL))
          return next &&
            lineEnd &&
            /\p{L}-$/u.test(item.str) &&
            /^\p{Ll}/u.test(next.str) &&
            item.fontName === next.fontName &&
            item.transform[5] - next.transform[5] >= item.height * 0.5 &&
            item.transform[5] - next.transform[5] <= item.height * 1.75 &&
            next.transform[4] < item.transform[4] + item.width
            ? item.str.slice(0, -1)
            : item.str
        })
        .join('')
        .replace(/\s/gu, '')
    if (
      !inside([0, 0, page.width, page.height], nativeCrop) ||
      nativeCrop[3] <= old[3] ||
      (captionText !==
        (table.caption.text ?? table.caption.lines?.join(' '))?.replace(/\s/gu, '') &&
        captionBoxes
          .map((b) => b.text)
          .join('')
          .replace(/\s/gu, '') !==
          (table.caption.text ?? table.caption.lines?.join(' '))?.replace(/\s/gu, '')) ||
      !captionBoxes.length ||
      captionBoxes.some((b) => selected.includes(b) || over(b.rect, nativeCrop)) ||
      [...foreignGlyphs, ...foreignPaints].some((r) => over(r, nativeCrop)) ||
      competingRects.some((r) => over(r, nativeCrop)) ||
      !current()
    )
      return
    return {
      table: { ...table, rect: nativeCrop },
      current,
      nativeCrop,
      bounds: { width: page.width, height: page.height },
      foreignGlyphs,
      foreignPaints
    }
  } catch {
    return
  }
}
