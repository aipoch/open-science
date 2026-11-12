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

const within = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 0.02 : x <= a[i] + 0.02)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]

// A separate three-lane shape, not a relaxed version of the ordinary multi-
// parent/repeated-record grammar. Whole mathematical fonts and their scripts
// stay in one Source-purpose native packet throughout the two closed records.
export function recoverNativeSingleParentMathHeaderGrid(table, items, context, native) {
  const { source, frame, edges, height: h } = context,
    model = table.structure?.objects?.filter((o) => o.label === 'table column'),
    c = native?.nativeGlyphContext,
    page = native?.sourcePage,
    scale = native?.viewport?.scale
  if (
    model?.length !== 3 ||
    edges.length !== 3 ||
    scale !== 1.5 ||
    !c ||
    !page ||
    !proveNativeUniqueWholeFonts(source, items)
  )
    return
  const [opening, divider, closing] = edges,
    head = source.filter((i) => i.baseline < divider[1]),
    body = groupSourceRowsWithScripts(
      source.filter((i) => !head.includes(i)),
      h,
      0.2
    ),
    upper = head.filter(
      (i) => Math.abs(i.baseline - Math.min(...head.map((i) => i.baseline))) < h * 0.2
    ),
    lower = head.filter((i) => !upper.includes(i)).sort((a, b) => a.rect[0] - b.rect[0])
  if (
    head.length !== 4 ||
    upper.length !== 1 ||
    lower.length !== 3 ||
    body?.length !== 2 ||
    !hasUniqueRecordTokens(source, [head, ...body]) ||
    head.some(
      (i) => Math.abs(i.height - h) > h * 0.1 || !/\p{L}/u.test(i.text) || /\d/u.test(i.text)
    ) ||
    lower.some((i) => Math.abs(i.baseline - lower[0].baseline) > h * 0.1) ||
    lower[0].baseline - upper[0].baseline < h ||
    lower[0].baseline - upper[0].baseline > h * 2.5 ||
    upper[0].rect[1] < opening[1] ||
    lower.some((i) => i.rect[3] >= divider[1])
  )
    return
  const records = body.map((row) => {
    const ordered = [...row].sort((a, b) => a.rect[0] - b.rect[0]),
      values = ordered.slice(-2),
      stub = ordered.slice(0, -2)
    return { stub, values, all: ordered }
  })
  if (
    records.some(
      (r) =>
        r.stub.length < 2 ||
        r.stub.length > 16 ||
        r.values.some(
          (i) => !/^\d+(?:\.\d+)?$/u.test(i.text) || Math.abs(i.height - h) > h * 0.1
        ) ||
        !r.stub.some((i) => /\p{L}/u.test(i.text)) ||
        r.stub.filter((i) => /^[<>=≤≥]$/u.test(i.text)).length !== 1 ||
        r.stub.some((i) => !/^[\p{L}\p{N}.<>=≤≥+−-]+$/u.test(i.text)) ||
        !r.stub.some((i) => i.height < h * 0.8)
    )
  )
    return
  const expressions = records.map((r) => {
    const relation = r.stub.findIndex((i) => /^[<>=≤≥]$/u.test(i.text))
    return [
      r.stub
        .slice(0, relation)
        .map((i) => i.text)
        .join(''),
      r.stub
        .slice(relation + 1)
        .map((i) => i.text)
        .join('')
    ]
  })
  if (
    expressions.some((e) => !/^\p{L}[\p{N}.]*$/u.test(e[0]) || !/^\d+(?:\.\d+)?$/u.test(e[1])) ||
    expressions[0].some((s, n) => s !== expressions[1][n])
  )
    return
  const lanes = [
      [lower[0], ...records.flatMap((r) => r.stub)],
      [lower[1], ...records.map((r) => r.values[0])],
      [lower[2], ...records.map((r) => r.values[1])]
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
    lanes.some((g, n) => g.some((i) => i.rect[0] < cuts[n] || i.rect[2] > cuts[n + 1])) ||
    upper[0].rect[0] < cuts[1] ||
    upper[0].rect[2] > cuts[3] ||
    Math.abs((upper[0].rect[0] + upper[0].rect[2] - lower[1].rect[0] - lower[2].rect[2]) / 2) >=
      h * 0.8
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
      // Full original font/advance boxes remain bound above. Their global
      // ascent/descent can cross a physical tier; actual painted glyph ink,
      // not a cropped or shortened Source box, establishes this separator.
      physical.set(item, union(ink))
    } else if (r.part.some(({ g }) => !g.rendererSkipped && hit(g.ink, nativeFrame))) return
  }
  if (physical.size !== source.length) return
  const railUses = new Set()
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
      (Math.max(Math.hypot(m[0], m[2]), Math.hypot(m[1], m[3])) * state.lineWidth * scale) / 2 > 2
    )
      return
    const left = [p[1], p[2]],
      right = [p[4], p[5]]
    Util.applyTransform(left, m)
    Util.applyTransform(right, m)
    const line = [
        Math.min(left[0], right[0]) * scale,
        left[1] * scale,
        Math.max(left[0], right[0]) * scale,
        right[1] * scale
      ],
      matches = edges.filter((e) => e.every((x, n) => Math.abs(x - line[n]) < 0.02))
    if (matches.length !== 1 || railUses.has(matches[0])) return
    railUses.add(matches[0])
  }
  if (railUses.size !== 3) return
  const headerTop = physical.get(upper[0])[3],
    leafTop = Math.min(...lower.slice(1).map((i) => physical.get(i)[1])),
    bodyBounds = records.map((r) => union(r.all.map((i) => physical.get(i)))),
    headerSplit = (headerTop + leafTop) / 2,
    bodySplit = (bodyBounds[0][3] + bodyBounds[1][1]) / 2
  if (
    headerTop >= leafTop ||
    bodyBounds[0][3] >= bodyBounds[1][1] ||
    bodyBounds[0][1] <= divider[1] ||
    bodyBounds[1][3] >= closing[1]
  )
    return
  const rows = [
      [cuts[0], frame[1], cuts[3], headerSplit],
      [cuts[0], headerSplit, cuts[3], divider[1]],
      [cuts[0], divider[1], cuts[3], bodySplit],
      [cuts[0], bodySplit, cuts[3], frame[3]]
    ],
    assignments = [
      [upper[0], 0, 1, 1, 2],
      [lower[0], 0, 0, 2, 1],
      ...[1, 2].map((n) => [lower[n], 1, n, 1, 1]),
      ...records.flatMap((r, n) => [
        ...r.stub.map((i) => [i, n + 2, 0, 1, 1]),
        ...r.values.map((i, k) => [i, n + 2, k + 1, 1, 1])
      ])
    ]
  if (
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
    // Keep the existing assigned-frame horizontal padding. The complete
    // three-rail/whole-font proof above also bounds its straight butt strokes;
    // publishing header spans must not restore discarded detector whitespace.
    cropRect: [
      Math.max(table.cropRect[0], frame[0] - 2),
      table.cropRect[1],
      Math.min(table.cropRect[2], frame[2] + 2),
      table.cropRect[3]
    ],
    repair: 'native-body-records-recovered'
  }
}
