/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { getInitialPdfCropRaster } from './literature-pdf-crop.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { preciseNativeGraphicsBounds } from './literature-pdf-native-table-boundary-ink.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
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

// A lower caption and an actual stub close this independent two-rule family.
// Whole native fields may contain several tokens, but no string is subdivided.
function recoverLowerCaptionTwoRuleTable(
  page,
  tokens,
  context,
  competing,
  captions,
  rails,
  scale,
  serial
) {
  const own = nativeRecoveryOwnValues(context),
    witness =
      own?.runningHeadWitness === undefined
        ? undefined
        : nativeRecoveryOwnValues(own.runningHeadWitness)
  if (
    !own ||
    (own.runningHeadWitness !== undefined &&
      (!witness || !witness.witnessViewport || typeof witness.witnessViewport !== 'object'))
  )
    return
  const retained = retainNativeRecoveryInputs(
    [page, tokens, context, competing, captions, rails],
    own.viewport,
    witness?.witnessViewport
  )
  if (!retained || rails.length !== 2 || !(scale > 0) || !Number.isFinite(scale)) return
  const rulePaintBounds = new Map(),
    rules = collectTableRules(context.operators, context.viewport, rulePaintBounds),
    stub = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > rails[0][0] &&
        r[0] < rails[0][2] &&
        r[1] < rails[1][1] &&
        r[3] <= rails[1][1] &&
        r[1] >= 0
    )
  if (stub.length < 2 || stub.length > 9 || new Set(stub.map((r) => r[0])).size !== 1) return
  const top = Math.min(...stub.map((r) => r[1])),
    bottom = rails[1][1],
    selected = tokens.filter(
      (t) =>
        t.horizontal &&
        t.text?.trim() &&
        t.baseline >= top &&
        t.baseline < bottom &&
        rect(t.rect) &&
        t.rect[0] >= rails[0][0] &&
        t.rect[2] <= rails[0][2]
    )
  if (top >= rails[0][1] || selected.length < 9 || selected.length > 54) return
  const height = Math.max(...selected.map((t) => t.height)),
    caps = captions.filter(
      (c) =>
        c.page === page.pageNumber &&
        c.rect[1] > bottom &&
        c.rect[1] - bottom < height * 3 &&
        c.lines?.length === 1 &&
        /^TABLE\s+\S/iu.test(c.lines[0])
    )
  if (caps.length !== 1) return
  const cap = caps[0],
    capFields = tokens.filter((t) => rect(t.rect) && inside(cap.rect, t.rect))
  if (!capFields.length || capFields.map((t) => t.text).join(' ') !== cap.lines.join(' ')) return
  const following = tokens.filter(
      (t) => t.sourceItem?.index > Math.max(...capFields.map((t) => t.sourceItem.index))
    ),
    next = following[0],
    capHeight = Math.max(...capFields.map((t) => t.height)),
    continuation =
      next &&
      next.rect[1] > cap.rect[3] &&
      next.rect[1] - cap.rect[3] < capHeight &&
      Math.abs(next.rect[0] + next.rect[2] - cap.rect[0] - cap.rect[2]) < capHeight * 0.02
        ? following.filter((t) => Math.abs(t.baseline - next.baseline) < capHeight * 0.02)
        : []
  if (
    continuation.length !== 1 ||
    context.content.items[next.sourceItem.index].fontName !==
      context.content.items[capFields[0].sourceItem.index].fontName ||
    next.height !== capHeight ||
    !/[.!?]$/u.test(next.text.trim()) ||
    /[.!?]$/u.test(cap.lines.join(' ').trim())
  )
    return
  const captionFields = [...capFields, ...continuation],
    all = [...selected, ...captionFields]
  if (all.length > 64 || new Set(all.map((t) => t.sourceItem?.index)).size !== all.length) return
  if (
    all.some((t) => {
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
        !(s.ascent > 0) ||
        !Number.isFinite(s.descent) ||
        s.descent > 0 ||
        !(s.ascent > s.descent) ||
        !Array.isArray(r.transform) ||
        !r.transform.every(Number.isFinite) ||
        !(r.transform[0] > 0) ||
        !(r.transform[3] > 0) ||
        r.transform[1] !== 0 ||
        r.transform[2] !== 0 ||
        r.height !== r.transform[3] ||
        !(r.width > 0)
      )
    })
  )
    return
  const packet = nativeFractionInkPacket(
    page,
    tokens,
    context,
    all.map((t) => t.sourceItem)
  )
  if (!packet || packet.evidence.images.length) return
  const byIndex = new Map(packet.records.map((r) => [r.index, r])),
    records = all.map((t) => {
      const record = byIndex.get(t.sourceItem.index)
      return (
        record && {
          ...t,
          ...tableTextToken(context.content.items[t.sourceItem.index], context.viewport, 0),
          record,
          ink: box(record.part.map((p) => p.g.ink))
        }
      )
    })
  if (
    records.some(
      (r) =>
        !r?.record.advanceComplete ||
        r.record.part.some(
          ({ g }) =>
            g.rendererSkipped ||
            g.textPaint?.fillColor !== '#000000' ||
            g.textPaint?.fillAlpha !== 1
        )
    )
  )
    return
  const body = records.slice(0, selected.length),
    captionRecords = records.slice(selected.length),
    baselines = [...new Set(body.filter((r) => r.height === height).map((r) => r.baseline))].sort(
      (a, b) => a - b
    ),
    groups = baselines.map((y) =>
      body.filter((r) =>
        r.height === height ? r.baseline === y : r.rect[1] < y && r.rect[3] > y - height
      )
    )
  if (
    groups.length < 3 ||
    groups.length > 9 ||
    body.some((r) => groups.filter((g) => g.includes(r)).length !== 1)
  )
    return
  for (const g of groups) g.sort((a, b) => a.rect[0] - b.rect[0])
  const header = groups[0],
    lanes = header.map(() => [])
  if (
    header.length < 3 ||
    header.length > 6 ||
    header.some((r) => r.height !== height || !/\p{L}/u.test(r.text))
  )
    return
  const cells = groups.map(() => header.map(() => []))
  for (const [row, g] of groups.entries())
    for (const r of g) {
      const cols = header.flatMap((h, c) =>
        r.rect[0] < h.rect[2] && r.rect[2] > h.rect[0] ? [c] : []
      )
      if (cols.length !== 1) return
      cells[row][cols[0]].push(r)
      lanes[cols[0]].push(r)
    }
  if (cells.some((row) => row.some((c) => !c.length))) return
  const domains = lanes.map((l) => box(l.flatMap((r) => [r.rect, r.ink]))),
    rowDomains = groups.map((g) => box(g.flatMap((r) => [r.rect, r.ink])))
  if (
    domains.slice(1).some((d, c) => d[0] <= domains[c][2]) ||
    stub[0][0] <= domains[0][2] ||
    stub[0][0] >= domains[1][0]
  )
    return
  if (rowDomains.slice(2).some((r, i) => r[1] <= rowDomains[i + 1][3])) return
  if (
    header.some((r) => r.ink[3] >= rails[0][1]) ||
    groups.slice(1).some((g) => g.some((r) => r.ink[1] <= rails[0][1] || r.ink[3] >= bottom))
  )
    return
  const identity = page.graphicsBounds.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map((z, i) => z * (i % 2 ? page.height : page.width))
    })),
    precise = preciseNativeGraphicsBounds({
      rulePaintBounds,
      nativeGlyphContext: context,
      viewport: context.viewport,
      nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect })),
      nativePaintIdentityGraphics: identity
    })
  if (precise.length !== identity.length || precise.some((r) => !rect(r))) return
  const colors = new Map(),
    stack = []
  let color
  for (const [i, op] of packet.o.fnArray.entries()) {
    const a = packet.o.argsArray[i]
    if (
      [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup].includes(
        op
      )
    )
      return
    if (op === OPS.save) stack.push(color)
    else if (op === OPS.restore) {
      if (!stack.length) return
      color = stack.pop()
    } else if (op === OPS.setStrokeRGBColor)
      color = a?.length === 1 && /^#[a-f0-9]{6}$/iu.test(a[0]) ? a[0].toLowerCase() : undefined
    else if (
      [
        OPS.setStrokeColor,
        OPS.setStrokeColorN,
        OPS.setStrokeCMYKColor,
        OPS.setStrokeGray,
        OPS.setStrokeColorSpace
      ].includes(op)
    )
      color = undefined
    else if (op === OPS.constructPath) colors.set(i, color)
  }
  if (stack.length) return
  const selectedRules = [...rails, ...stub],
    owned = []
  for (const rule of selectedRules) {
    const found = identity.flatMap((g, i) => {
      const a = packet.o.argsArray[g.operationIndex],
        state = packet.evidence.paths.get(g.operationIndex),
        cmd = a?.[1]?.[0]
      if (
        g.kind !== 'path' ||
        packet.o.fnArray[g.operationIndex] !== OPS.constructPath ||
        a?.[0] !== OPS.stroke ||
        a[1]?.length !== 1 ||
        cmd?.length !== 6 ||
        cmd[0] !== 0 ||
        cmd[3] !== 1 ||
        !state ||
        state.strokeAlpha !== 1 ||
        state.solidStroke !== true ||
        state.lineCap !== 0 ||
        !(state.lineWidth > 0) ||
        colors.get(g.operationIndex) !== '#000000'
      )
        return []
      const m = Util.transform(packet.v.transform, state.transform)
      if (m[1] || m[2] || !(m[0] > 0) || !(m[3] < 0)) return []
      const points = [
          cmd[1] * m[0] + m[4],
          cmd[2] * m[3] + m[5],
          cmd[4] * m[0] + m[4],
          cmd[5] * m[3] + m[5]
        ],
        r = [
          Math.min(points[0], points[2]),
          Math.min(points[1], points[3]),
          Math.max(points[0], points[2]),
          Math.max(points[1], points[3])
        ]
      return eq(r, rule) && inside(state.clip, precise[i]) ? [i] : []
    })
    if (found.length !== 1 || owned.includes(found[0])) return
    owned.push(found[0])
  }
  const verticalIntervals = owned
      .slice(rails.length)
      .map((i) => precise[i])
      .sort((a, b) => a[1] - b[1]),
    joined = []
  for (const r of verticalIntervals) {
    const last = joined.at(-1)
    if (last && r[1] <= last[1]) last[1] = Math.max(last[1], r[3])
    else joined.push([r[1], r[3]])
  }
  if (
    body.some((r) =>
      r.record.part.some(({ g }) => !joined.some((y) => g.ink[1] >= y[0] && g.ink[3] <= y[1]))
    )
  )
    return
  const strokes = owned.map((i) => precise[i]),
    crop = box([...body.flatMap((r) => [r.rect, r.ink]), ...strokes]),
    raster = getInitialPdfCropRaster(crop, page)
  if (
    !raster ||
    !inside([0, 0, page.width, page.height], raster.protection) ||
    competing.some((r) => over(r, raster.protection)) ||
    captions.some((c) => over(c.rect, raster.protection))
  )
    return
  const glyphs = new Set(body.flatMap((r) => r.record.part.map(({ g }) => g)))
  if (
    packet.glyphs.some((g) => !glyphs.has(g) && over(g.ink, raster.protection)) ||
    precise.some((r, i) => !owned.includes(i) && over(r, raster.protection)) ||
    body.some((r) => strokes.some((s) => over(r.ink, s)))
  )
    return
  const capRect = box(captionFields.map((t) => t.rect)),
    capInk = box(captionRecords.map((r) => r.ink)),
    capEnvelope = box([capRect, capInk]),
    capGlyphs = new Set(captionRecords.flatMap((r) => r.record.part.map(({ g }) => g)))
  if (
    packet.glyphs.some((g) => !capGlyphs.has(g) && over(g.ink, capEnvelope)) ||
    precise.some((r) => over(r, capEnvelope)) ||
    competing.some((r) => over(r, capEnvelope))
  )
    return
  const ys = [
      crop[1],
      ...rowDomains.slice(1).map((r, i) => (rowDomains[i][3] + r[1]) / 2),
      crop[3]
    ],
    xs = [
      crop[0],
      stub[0][0],
      ...domains.slice(2).map((d, c) => (domains[c + 1][2] + d[0]) / 2),
      crop[2]
    ],
    workTransform = context.viewport.transform.map((n) => n * scale),
    workViewport = {
      ...context.viewport,
      scale,
      width: page.width * scale,
      height: page.height * scale,
      transform: workTransform,
      convertToViewportPoint: (x, y) =>
        context.viewport.convertToViewportPoint(x, y).map((n) => n * scale)
    },
    source = body.map((r) => ({
      ...tableTextToken(context.content.items[r.sourceItem.index], workViewport, 0),
      fontAscent: context.content.styles[context.content.items[r.sourceItem.index].fontName].ascent,
      fontDescent:
        context.content.styles[context.content.items[r.sourceItem.index].fontName].descent
    })),
    workCrop = crop.map((n) => n * scale),
    objects = [
      ...ys.slice(1).map((y, i) => ({
        label: 'table row',
        rect: [0, ys[i] * scale - workCrop[1], workCrop[2] - workCrop[0], y * scale - workCrop[1]]
      })),
      ...xs.slice(1).map((x, i) => ({
        label: 'table column',
        rect: [xs[i] * scale - workCrop[0], 0, x * scale - workCrop[0], workCrop[3] - workCrop[1]]
      })),
      {
        label: 'table column header',
        rect: [0, 0, workCrop[2] - workCrop[0], ys[1] * scale - workCrop[1]]
      }
    ],
    table = refineTable(
      {
        id: `p${page.pageNumber}-open-rule-table-${serial}`,
        pageNumber: page.pageNumber,
        cropRect: workCrop,
        recoveredGrid: true,
        structure: { objects }
      },
      source,
      [],
      [],
      selectedRules.map((r) => r.map((n) => n * scale))
    )
  if (
    table.issues?.length ||
    table.notes?.length ||
    table.unassigned?.length ||
    table.caption ||
    table.cells.length !== cells.length * header.length
  )
    return
  for (const [row, g] of cells.entries())
    for (const [col, fields] of g.entries()) {
      const found = table.cells.filter((c) => c.row === row && c.column === col),
        expected = fields.map((r) => r.sourceItem)
      if (
        found.length !== 1 ||
        found[0].rowSpan !== 1 ||
        found[0].colSpan !== 1 ||
        !eq(found[0].sourceItems, expected) ||
        !eq(
          found[0].sourceRects,
          fields.map((r) => source.find((t) => t.sourceItem.index === r.sourceItem.index).rect)
        )
      )
        return
    }
  const lines = [cap.lines.join(' '), continuation.map((t) => t.text).join(' ')],
    result = {
      table: {
        ...table,
        page: page.pageNumber,
        cropRect: workCrop,
        notes: [],
        caption: { text: lines.join(' '), lines, page: page.pageNumber, rect: capRect },
        sourceViewport: { width: workViewport.width, height: workViewport.height, scale }
      },
      nativeCrop: crop,
      raster,
      grid: table.grid,
      sources: body.map((r) => r.sourceItem)
    },
    current = () => retained() && outputCurrent(),
    proof = { ...result, current },
    outputCurrent = retainNativeRecoveryInputs([proof], undefined)
  if (!outputCurrent || !retained()) return
  return proof
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
    // Existing three-rule results and their IDs are complete before this family.
    let twoRuleSerial = 1
    for (const family of families.values()) {
      if (family.length !== 2) continue
      const proof = recoverLowerCaptionTwoRuleTable(
        page,
        tokens,
        context,
        competingRects,
        captions,
        [...family].sort((a, b) => a[1] - b[1]),
        scale,
        twoRuleSerial
      )
      if (proof && !results.some((p) => over(p.nativeCrop, proof.nativeCrop))) {
        results.push(proof)
        twoRuleSerial++
      }
    }
    return results
  } catch {
    return []
  }
}
