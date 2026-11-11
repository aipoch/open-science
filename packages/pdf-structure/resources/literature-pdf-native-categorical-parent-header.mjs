/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import {
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  within = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 0.02 : x <= a[i] + 0.02)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]

// Independent closed categorical matrix: repeated row/column categories and a
// centered physical underline establish one parent. A stub between baselines
// owns its separate x domain across both tiers; it is not another leaf.
export function recoverNativeCategoricalParentHeaderGrid(table, items, context, rules, native) {
  const { source, frame, edges, height: h } = context,
    c = native?.nativeGlyphContext,
    page = native?.sourcePage,
    scale = native?.viewport?.scale
  if (
    table.structure?.objects?.filter((o) => o.label === 'table column').length !== 3 ||
    edges.length !== 3 ||
    source.length !== 10 ||
    scale !== 1.5 ||
    !c ||
    !page ||
    !proveNativeUniqueWholeFonts(source, items) ||
    source.some((i) => Math.abs(i.height - h) > h * 0.1)
  )
    return
  const [opening, divider] = edges,
    head = source.filter((i) => i.baseline < divider[1]),
    body = groupSourceRowsWithScripts(
      source.filter((i) => !head.includes(i)),
      h,
      0.2
    )?.map((r) => [...r].sort((a, b) => a.rect[0] - b.rect[0]))
  if (
    head.length !== 4 ||
    body?.length !== 2 ||
    body.some((r) => r.length !== 3 || r.some((i) => !/\p{L}/u.test(i.text))) ||
    !hasUniqueRecordTokens(source, [head, ...body]) ||
    body[0][0].text === body[1][0].text
  )
    return
  const leaves = body.map((r) => head.filter((i) => i.text === r[0].text))
  if (leaves.some((a) => a.length !== 1)) return
  const leaf = leaves.map((a) => a[0]),
    other = head.filter((i) => !leaf.includes(i)),
    left = other.filter((i) => i.rect[2] < Math.min(...leaf.map((a) => a.rect[0]))),
    stub = left[0],
    parent = other.find((i) => i !== stub)
  if (
    left.length !== 1 ||
    !parent ||
    head.some((i) => !/\p{L}/u.test(i.text)) ||
    leaf[0].rect[2] >= leaf[1].rect[0] ||
    Math.abs(leaf[0].baseline - leaf[1].baseline) > h * 0.1 ||
    leaf[0].baseline - parent.baseline < h ||
    leaf[0].baseline - parent.baseline > h * 2.5 ||
    stub.baseline <= parent.baseline + h * 0.1 ||
    stub.baseline >= leaf[0].baseline - h * 0.1 ||
    parent.rect[1] < opening[1] ||
    leaf.some((i) => i.rect[3] >= divider[1])
  )
    return
  const lanes = [
      [stub, ...body.map((r) => r[0])],
      ...leaf.map((i, n) => [i, ...body.map((r) => r[n + 1])])
    ],
    cuts = [frame[0] - 0.1]
  for (let n = 1; n < 3; n++) {
    const end = Math.max(...lanes[n - 1].map((i) => i.rect[2])),
      start = Math.min(...lanes[n].map((i) => i.rect[0]))
    if (start - end < h * 0.45) return
    cuts.push((end + start) / 2)
  }
  cuts.push(frame[2] + 0.1)
  if (
    lanes.some((a, n) => a.some((i) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])) ||
    parent.rect[0] < cuts[1] ||
    parent.rect[2] > cuts[3] ||
    parent.rect[0] >= cuts[2] ||
    parent.rect[2] <= cuts[2]
  )
    return
  const partials = joinHorizontalTableRules(rules).filter(
    (r) => r[0] > cuts[1] && r[2] < frame[2] && r[1] > parent.baseline && r[1] < leaf[0].baseline
  )
  if (partials.length !== 1) return
  const partial = partials[0]
  if (
    Math.abs(partial[0] - leaf[0].rect[0]) > h * 0.8 ||
    Math.abs(partial[2] - leaf[1].rect[2]) > h * 0.8 ||
    Math.abs((partial[0] + partial[2] - parent.rect[0] - parent.rect[2]) / 2) > h * 0.1
  )
    return
  const v = c.viewport,
    tokens = c.content?.items?.filter((i) => i.str?.trim()).map((i) => tableTextToken(i, v, 0)),
    ordered = [...source].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
    packet =
      tokens &&
      nativeWholeCellInkPacket(page, tokens, c, {
        text: ordered.map((i) => i.text).join(''),
        sourceItems: ordered.map((i) => i.sourceItem),
        sourceRects: ordered.map((i) => i.rect.map((x) => x / scale))
      })
  if (!packet || packet.evidence.images.length) return
  const byIndex = new Map(source.map((i) => [i.sourceItem.index, i])),
    physical = new Map(),
    nativeFrame = frame.map((x) => x / scale)
  for (const r of packet.records) {
    const item = byIndex.get(r.index)
    if (item) {
      if (
        !r.advanceComplete ||
        !c.content.styles?.[r.r.fontName] ||
        r.part.some(({ g }) => g.fontName !== r.r.fontName)
      )
        return
      const ink = r.part
        .filter(({ g }) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3])
        .map(({ g }) => g.ink.map((x) => x * scale))
      if (!ink.length) return
      physical.set(item, union(ink))
    } else if (r.part.some(({ g }) => !g.rendererSkipped && hit(g.ink, nativeFrame))) return
  }
  if (physical.size !== source.length) return
  // Colors belong to the complete native program, including nested save/Form
  // restoration. The geometric rule collector alone cannot prove visible ink.
  const colors = new Map(),
    stack = []
  let color = '#000000'
  for (let i = 0; i < packet.o.fnArray.length; i++) {
    const op = packet.o.fnArray[i],
      a = packet.o.argsArray[i]
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
      stack.push({ op, color })
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      const s = stack.pop(),
        expected =
          op === OPS.restore
            ? OPS.save
            : op === OPS.paintFormXObjectEnd
              ? OPS.paintFormXObjectBegin
              : OPS.beginGroup
      if (!s || s.op !== expected) return
      color = s.color
    } else if (op === OPS.setStrokeRGBColor) color = a[0]
    else if (op === OPS.constructPath) colors.set(i, color)
  }
  if (stack.length) return
  const rails = [...edges, partial],
    used = new Set()
  for (const [i, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[i],
      paint = a[0] === OPS.endPath ? undefined : nativeFigurePathPaint(packet, i, state)
    if (!paint) {
      if (a[0] !== OPS.endPath) return
      continue
    }
    if (!hit(paint.rect, nativeFrame)) continue
    const p = a[1]?.[0],
      m = Util.transform(packet.v.transform, state.transform)
    if (
      a[0] !== OPS.stroke ||
      !p ||
      p.length !== 6 ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      !Array.from(p).every(Number.isFinite) ||
      state.strokeAlpha !== 1 ||
      state.solidStroke !== true ||
      state.lineCap !== 0 ||
      !/^#[0-9a-f]{6}$/iu.test(colors.get(i) ?? '') ||
      /^#ffffff$/iu.test(colors.get(i)) ||
      (Math.max(Math.hypot(m[0], m[2]), Math.hypot(m[1], m[3])) * state.lineWidth * scale) / 2 > 2
    )
      return
    const a0 = [p[1], p[2]],
      a1 = [p[4], p[5]]
    Util.applyTransform(a0, m)
    Util.applyTransform(a1, m)
    const line = [
        Math.min(a0[0], a1[0]) * scale,
        a0[1] * scale,
        Math.max(a0[0], a1[0]) * scale,
        a1[1] * scale
      ],
      matches = rails.filter((r) => r.every((x, n) => Math.abs(x - line[n]) < 0.02))
    if (matches.length !== 1 || used.has(matches[0])) return
    used.add(matches[0])
  }
  if (used.size !== 4) return
  const bounds = body.map((r) => union(r.map((i) => physical.get(i)))),
    split = (bounds[0][3] + bounds[1][1]) / 2,
    rows = [
      [cuts[0], frame[1], cuts[3], partial[1]],
      [cuts[0], partial[1], cuts[3], divider[1]],
      [cuts[0], divider[1], cuts[3], split],
      [cuts[0], split, cuts[3], frame[3]]
    ],
    assignments = [
      [stub, 0, 0, 2, 1],
      [parent, 0, 1, 1, 2],
      ...leaf.map((i, n) => [i, 1, n + 1, 1, 1]),
      ...body.flatMap((r, n) => r.map((i, k) => [i, n + 2, k, 1, 1]))
    ]
  if (
    bounds[0][3] >= bounds[1][1] ||
    assignments.some(
      ([i, r, col, rs, cs]) =>
        !within([cuts[col], rows[r][1], cuts[col + cs], rows[r + rs - 1][3]], physical.get(i))
    )
  )
    return
  return {
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: 2 }
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    // This repairs ownership inside the accepted crop. The physical rails
    // establish the header tiers without changing its existing raster padding.
    cropRect: [...table.cropRect],
    repair: 'native-body-records-recovered'
  }
}
