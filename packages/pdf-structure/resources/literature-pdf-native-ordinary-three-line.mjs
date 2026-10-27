/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { getInitialPdfCropRaster } from './literature-pdf-crop.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { refineTable } from './literature-pdf-table-refine.mjs'

const rect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const over = (a, b) =>
  rect(a) && rect(b) && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const box = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const scalar = (s) => /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(s)
const value = (s) =>
  scalar(s) ||
  /^\[\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\s*,\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\s*\]$/u.test(s)

// Graphical table products carry normalized regions without a working crop.
// Unknown existing owners retain the entire page as a competing region.
export function ordinaryTableCompetitionRect(table, page, scale = 1.5) {
  if (
    !Number.isFinite(page?.width) ||
    !Number.isFinite(page?.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    return
  if (rect(table?.cropRect)) return table.cropRect.map((n) => n / scale)
  if (rect(table?.region) && table.region.every((n) => n >= 0 && n <= 1))
    return table.region.map((n, i) => n * (i % 2 ? page.height : page.width))
  return [0, 0, page.width, page.height]
}

// This pure seam operates on complete native fields. It never subdivides a
// string, fabricates a vertical rule, or infers the meaning of a number.
export function planOrdinaryThreeLineFields(records, rails) {
  if (
    !Array.isArray(records) ||
    records.length < 9 ||
    records.length > 54 ||
    !Array.isArray(rails) ||
    rails.length !== 3
  )
    return
  if (
    records.some(
      (r) =>
        !rect(r.rect) ||
        !rect(r.ink) ||
        typeof r.text !== 'string' ||
        !r.text.trim() ||
        r.text.length > 128 ||
        !Number.isFinite(r.baseline) ||
        !(r.height > 0)
    )
  )
    return
  const frame = [rails[0][0], rails[0][1], rails[0][2], rails[2][1]],
    mid = rails[1][1]
  if (
    !rect(frame) ||
    rails.some((r) => r[0] !== frame[0] || r[2] !== frame[2] || r[1] !== r[3]) ||
    !(frame[1] < mid && mid < frame[3])
  )
    return
  if (records.some((r) => !inside(frame, r.rect) || !inside(frame, r.ink))) return
  const groups = []
  for (const r of [...records].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = groups.at(-1)
    if (last && Math.abs(r.baseline - last[0].baseline) < r.height * 0.02) last.push(r)
    else groups.push([r])
  }
  if (groups.length < 3 || groups.length > 9) return
  for (const g of groups) g.sort((a, b) => a.rect[0] - b.rect[0])
  const count = groups[0].length
  if (count < 3 || count > 6 || groups.some((g) => g.length !== count)) return
  if (
    groups[0].some((r) => !/[\p{L}]/u.test(r.text) || r.ink[1] <= frame[1] || r.ink[3] >= mid) ||
    groups.slice(1).some((g) => g.some((r) => r.ink[1] <= mid))
  )
    return
  if (
    groups
      .slice(1)
      .some(
        (g) =>
          !/^[\p{L}][\p{L}\p{N} ._-]*$/u.test(g[0].text) || g.slice(1).some((r) => !value(r.text))
      )
  )
    return
  const domains = Array.from({ length: count }, (_, col) =>
    box(groups.flatMap((g) => [g[col].rect, g[col].ink]))
  )
  if (domains.slice(1).some((d, c) => d[0] <= domains[c][2])) return
  const gaps = groups
    .slice(1)
    .map((g, i) => [
      Math.max(...groups[i].flatMap((r) => [r.rect[3], r.ink[3]])),
      Math.min(...g.flatMap((r) => [r.rect[1], r.ink[1]]))
    ])
  if (gaps.some((g) => g[0] >= g[1])) return
  const xs = [frame[0], ...domains.slice(1).map((d, c) => (domains[c][2] + d[0]) / 2), frame[2]],
    ys = [frame[1], mid, ...gaps.slice(1).map((g) => (g[0] + g[1]) / 2), frame[3]]
  if (
    groups.some((g, row) =>
      g.some(
        (r, col) =>
          !inside([xs[col], ys[row], xs[col + 1], ys[row + 1]], r.rect) ||
          !inside([xs[col], ys[row], xs[col + 1], ys[row + 1]], r.ink)
      )
    )
  )
    return
  return { frame, groups, xs, ys, grid: groups.map((g) => g.map((r) => r.text)) }
}

function paintInventory(packet) {
  let color = '#000000'
  const colors = new Map(),
    stack = []
  for (const [i, op] of packet.o.fnArray.entries()) {
    const a = packet.o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      color = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) color = a[0]
    else if (op === OPS.constructPath) colors.set(i, color)
  }
  if (stack.length) return
  const result = []
  for (const [id, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[id]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!a?.[2] || a[2].length !== 4 || !Array.from(a[2]).every(Number.isFinite)) return
    const m = Util.transform(packet.v.transform, state.transform),
      commands = a?.[1]?.[0],
      straight =
        a[0] === OPS.stroke &&
        commands?.length === 6 &&
        commands[0] === 0 &&
        commands[3] === 1 &&
        commands[2] === commands[5] &&
        commands[1] < commands[4] &&
        m[1] === 0 &&
        m[2] === 0 &&
        m[0] > 0 &&
        m[3] < 0
    const stroke = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0])
    const pad = stroke
      ? (state.lineWidth * (straight ? 1 : Math.max(1, packet.strokeMargins.get(id) ?? 10))) / 2
      : 0
    if (!Number.isFinite(pad) || pad < 0) return
    const bounds = packet.box(
      Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
      m
    )
    const p = commands && [
      commands[1] * m[0] + m[4],
      commands[2] * m[3] + m[5],
      commands[4] * m[0] + m[4],
      commands[5] * m[3] + m[5]
    ]
    result.push({
      id,
      bounds,
      rule: straight ? p : undefined,
      visible:
        straight &&
        state.solidStroke === true &&
        state.strokeAlpha === 1 &&
        colors.get(id) === '#000000' &&
        state.lineCap === 0 &&
        state.lineWidth > 0,
      clip: state.clip
    })
  }
  return result
}

export function recoverOrdinaryThreeLineTables(
  page,
  tokens,
  context,
  competingRects = [],
  captions = [],
  scale = 1.5
) {
  try {
    if (
      !Number.isSafeInteger(page?.pageNumber) ||
      page.pageNumber < 1 ||
      !(scale > 0) ||
      !Array.isArray(tokens) ||
      tokens.length > 4096 ||
      context?.content?.items?.length > 4096 ||
      context?.operators?.fnArray?.length > 100000 ||
      !eq(page.graphicsBounds, context.graphicsBounds) ||
      !eq(context.viewport?.transform, [1, 0, 0, -1, 0, page.height]) ||
      !Array.isArray(context.glyphBounds) ||
      !competingRects.every(rect) ||
      !captions.every((c) => rect(c.rect))
    )
      return []
    const rules = collectTableRules(context.operators, context.viewport),
      families = new Map(),
      results = []
    for (const r of rules.filter((r) => r[1] === r[3] && r[0] < r[2])) {
      const k = JSON.stringify([r[0], r[2]])
      if (!families.has(k)) families.set(k, [])
      families.get(k).push(r)
    }
    if (families.size > 128) return []
    for (const family of families.values()) {
      if (family.length !== 3) continue
      const rails = [...family].sort((a, b) => a[1] - b[1]),
        frame = [rails[0][0], rails[0][1], rails[0][2], rails[2][1]]
      if (
        !rect(frame) ||
        !inside([0, 0, page.width, page.height], frame) ||
        competingRects.some((r) => over(r, frame)) ||
        captions.some((c) => over(c.rect, frame))
      )
        continue
      const claimed = tokens.filter(
        (t) =>
          t.text?.trim() &&
          t.horizontal &&
          t.baseline > frame[1] &&
          t.baseline < frame[3] &&
          t.rect[0] >= frame[0] &&
          t.rect[2] <= frame[2]
      )
      if (
        claimed.length < 9 ||
        claimed.length > 54 ||
        new Set(claimed.map((t) => t.sourceItem?.index)).size !== claimed.length
      )
        continue
      if (
        claimed.some((t) => {
          const r = context.content.items[t.sourceItem?.index],
            s = context.content.styles[r?.fontName]
          return (
            !r ||
            r.str !== t.text ||
            !eq(r.sourceItem, t.sourceItem) ||
            r.dir !== 'ltr' ||
            !s ||
            s.vertical !== false ||
            !Number.isFinite(s.ascent) ||
            s.ascent <= 0 ||
            !Number.isFinite(s.descent) ||
            s.descent > 0 ||
            s.ascent <= s.descent ||
            !Array.isArray(r.transform) ||
            r.transform[0] <= 0 ||
            r.transform[3] <= 0 ||
            r.transform[1] !== 0 ||
            r.transform[2] !== 0 ||
            r.height !== r.transform[3] ||
            r.width <= 0
          )
        })
      )
        continue
      const packet = nativeFractionInkPacket(
        page,
        tokens,
        context,
        claimed.map((t) => t.sourceItem)
      )
      if (!packet) continue
      const records = claimed.map((t) => {
        const r = packet.records.find((r) => r.index === t.sourceItem.index)
        return r && { ...t, record: r, ink: box(r.part.map(({ g }) => g.ink)) }
      })
      if (
        records.some(
          (r) =>
            !r ||
            !r.record.advanceComplete ||
            r.record.part.some(
              ({ g }) =>
                g.rendererSkipped ||
                g.textPaint?.fillColor !== '#000000' ||
                g.textPaint?.fillAlpha !== 1
            )
        )
      )
        continue
      const plan = planOrdinaryThreeLineFields(records, rails)
      if (!plan) continue
      const paints = paintInventory(packet)
      if (!paints) continue
      const ownedPaint = rails.map((r) => paints.filter((p) => p.visible && eq(p.rule, r)))
      if (ownedPaint.some((p) => p.length !== 1)) continue
      const strokes = ownedPaint.flat()
      if (strokes.some((p) => !inside(p.clip, p.bounds))) continue
      const crop = box([
          ...records.flatMap((r) => [r.rect, r.ink]),
          ...strokes.map((p) => p.bounds)
        ]),
        raster = getInitialPdfCropRaster(crop, page)
      if (
        !raster ||
        !inside([0, 0, page.width, page.height], raster.protection) ||
        competingRects.some((r) => over(r, raster.protection)) ||
        captions.some((c) => over(c.rect, raster.protection))
      )
        continue
      const owned = new Set(records.flatMap((r) => r.record.part.map(({ g }) => g)))
      if (
        packet.glyphs.some((g) => !owned.has(g) && over(g.ink, raster.protection)) ||
        paints.some((p) => !strokes.includes(p) && over(p.bounds, raster.protection)) ||
        packet.evidence.images.length
      )
        continue
      if (results.some((p) => over(p.nativeCrop, crop))) continue
      const workTransform = context.viewport.transform.map((n) => n * scale),
        workViewport = {
          ...context.viewport,
          scale,
          width: page.width * scale,
          height: page.height * scale,
          transform: workTransform,
          convertToViewportPoint: (x, y) => [
            workTransform[0] * x + workTransform[4],
            workTransform[3] * y + workTransform[5]
          ]
        }
      const source = plan.groups.flat().map((r) => ({
        ...tableTextToken(context.content.items[r.sourceItem.index], workViewport, 0),
        fontAscent:
          context.content.styles[context.content.items[r.sourceItem.index].fontName].ascent,
        fontDescent:
          context.content.styles[context.content.items[r.sourceItem.index].fontName].descent
      }))
      const workCrop = crop.map((n) => n * scale),
        objects = [
          ...plan.ys.slice(1).map((y, i) => ({
            label: 'table row',
            rect: [
              0,
              plan.ys[i] * scale - workCrop[1],
              workCrop[2] - workCrop[0],
              y * scale - workCrop[1]
            ]
          })),
          ...plan.xs.slice(1).map((x, i) => ({
            label: 'table column',
            rect: [
              plan.xs[i] * scale - workCrop[0],
              0,
              x * scale - workCrop[0],
              workCrop[3] - workCrop[1]
            ]
          }))
        ]
      const seed = {
        id: `p${page.pageNumber}-native-ordinary-three-line-${results.length + 1}`,
        pageNumber: page.pageNumber,
        cropRect: workCrop,
        recoveredGrid: true,
        structure: { objects }
      }
      const table = refineTable(
        seed,
        source,
        [],
        [],
        rails.map((r) => r.map((n) => n * scale))
      )
      const expected = plan.groups.flatMap((g, row) =>
        g.map((r, column) => ({
          row,
          column,
          text: r.text,
          sourceItems: [r.sourceItem],
          sourceRects: [source.find((t) => t.sourceItem.index === r.sourceItem.index).rect]
        }))
      )
      if (
        !eq(table.grid, plan.grid) ||
        table.cells.length !== expected.length ||
        table.notes?.length ||
        table.unassigned?.length ||
        table.caption ||
        expected.some((e) => {
          const cc = table.cells.filter((c) => c.row === e.row && c.column === e.column),
            c = cc[0]
          return (
            cc.length !== 1 ||
            c.rowSpan !== 1 ||
            c.colSpan !== 1 ||
            c.text !== e.text ||
            !eq(c.sourceItems, e.sourceItems) ||
            !eq(c.sourceRects, e.sourceRects) ||
            c.sourceSegments?.length
          )
        })
      )
        continue
      results.push({
        table: {
          ...table,
          page: page.pageNumber,
          cropRect: workCrop,
          notes: [],
          caption: undefined,
          sourceViewport: { width: workViewport.width, height: workViewport.height, scale }
        },
        nativeCrop: crop,
        raster,
        grid: plan.grid,
        sources: expected
      })
    }
    return results
  } catch {
    return []
  }
}
