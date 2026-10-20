/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A previous page supplies only the closed header and numbered stub witness.
// Current text and paint must independently fit the complete continuation frame.
// The result is a graphical exclusion, never a reconstructed grid or source claim.
import { classifyTableRuleEdge, clusterTableRulePositions } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
const finite = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3]
function framePacket(page, tokens, rules, witnessOnly = false) {
  if (
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.invalidGraphicsBounds !== 0
  )
    return
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(rules) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return
  const vs = rules.filter((r) => r[0] === r[2] && r[3] > r[1]),
    hs = rules.filter((r) => r[1] === r[3] && r[2] > r[0])
  const xs = clusterTableRulePositions(vs.map((r) => r[0])),
    ys = clusterTableRulePositions(hs.map((r) => r[1]))
  if (xs.length < 4 || xs.length > 10 || ys.length < 4 || ys.length > 30) return
  const box = [xs[0], ys[0], xs.at(-1), ys.at(-1)]
  if (
    !finite(box) ||
    vs.some((r) => r[1] < box[1] - 1 || r[3] > box[3] + 1) ||
    xs.some((x) => classifyTableRuleEdge(vs, 0, x, box[1], box[3]) !== 1)
  )
    return
  const edges = ys.map((y) => xs.slice(1).map((x, c) => classifyTableRuleEdge(hs, 1, y, xs[c], x)))
  if (
    edges[0].some((e) => e !== 1) ||
    edges.at(-1).some((e) => e !== 1) ||
    edges.flat().some((e) => e === -1) ||
    edges.some((e) => e[0] !== 1)
  )
    return
  const faces = []
  for (let c = 0; c < xs.length - 1; c++) {
    let first = 0
    for (let r = 1; r < ys.length; r++)
      if (edges[r][c] === 1) {
        faces.push({
          column: c,
          row: first,
          rowSpan: r - first,
          rect: [xs[c], ys[first], xs[c + 1], ys[r]],
          fonts: []
        })
        first = r
      }
  }
  const own = []
  for (const t of tokens) {
    if (typeof t?.text !== 'string' || !t.text.trim()) continue
    if (!finite(t.rect)) return
    if (!overlaps(t.rect, box)) continue
    const witness = t.rect[0] < xs[1] || t.rect[1] < ys[1]
    if (witnessOnly && !witness) continue
    const cells = faces.filter((f) => inside(t.rect, f.rect))
    if (cells.length !== 1) return
    cells[0].fonts.push(t)
    own.push(t)
  }
  if (
    !proveNativeUniqueWholeFonts(own, tokens) ||
    own.some((t) => t.sourceItem.pageNumber !== page.pageNumber)
  )
    return
  const stub = faces.filter((f) => f.column === 0).sort((a, b) => a.row - b.row),
    numbers = stub.map((f) => {
      const fonts = [...f.fonts].sort((a, b) => a.rect[0] - b.rect[0])
      if (!fonts.length || f.rowSpan !== 1) return null
      if (
        fonts.some(
          (t, i) =>
            !/^\d+$/.test(t.text) ||
            Math.abs(t.height - fonts[0].height) > 1e-6 ||
            Math.abs(t.baseline - fonts[0].baseline) > 1e-6 ||
            (i &&
              (t.rect[0] - fonts[i - 1].rect[2] > t.height * 0.05 ||
                t.rect[0] < fonts[i - 1].rect[2] - t.height * 0.01))
        )
      )
        return null
      const s = fonts.map((t) => t.text).join('')
      return /^(?:[1-9]\d*)$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null
    })
  return { box, xs, ys, edges, faces, own, numbers }
}
function proveNumberedContinuation(current, previous, captions) {
  const [a, at, ar] = current,
    [b, bt, br] = previous
  if (a.pageNumber !== b.pageNumber + 1 || a.width !== b.width || a.height !== b.height) return
  const now = framePacket(a, at, ar),
    old = framePacket(b, bt, br, true)
  if (
    !now ||
    !old ||
    now.xs.length !== old.xs.length ||
    now.xs.some((x, i) => Math.abs(x - old.xs[i]) > 1e-6)
  )
    return
  if (
    now.box[1] > a.height * 0.2 ||
    old.box[3] < b.height * 0.8 ||
    now.numbers.some((n) => n === null) ||
    now.numbers.length < 2
  )
    return
  if (
    old.numbers[0] !== null ||
    old.numbers.slice(1).some((n, i) => n !== i + 1) ||
    old.numbers.length < 4
  )
    return
  if (now.numbers.some((n, i) => n !== old.numbers.at(-1) + i + 1)) return
  const caps = captions.filter(
    (c) => c.page === b.pageNumber && /^Table\s+\d+(?:[:.]|\s)/i.test(c.lines?.[0] ?? '')
  )
  if (
    caps.length !== 1 ||
    caps[0].rect[3] > old.box[1] ||
    old.box[1] - caps[0].rect[3] > now.own[0].height * 3
  )
    return
  if (
    captions.some(
      (c) => c.page === a.pageNumber && c.rect[1] < now.box[3] && c.rect[3] > now.box[1]
    )
  )
    return
  // Every continued record has its own complete nonempty stub + descriptor + at least two further independent fields.
  for (let r = 0; r < now.numbers.length; r++)
    if (now.faces.filter((f) => f.row === r && f.rowSpan === 1 && f.fonts.length).length < 4) return
  if (
    old.faces.filter((f) => f.row === 0 && f.column > 0 && f.rowSpan === 1 && f.fonts.length)
      .length !==
    old.xs.length - 2
  )
    return
  return {
    rect: now.box,
    current: now,
    previous: old,
    caption: caps[0],
    status: 'source-and-rule-proof-only-paint-check-pending'
  }
}

const finiteArray = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
  containsRect = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3],
  overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-5)
function completeCurrentDomain(page, tokens, rules, context, packet) {
  const ops = context?.operators,
    vp = context?.viewport,
    content = context?.content,
    box = packet.box
  if (
    !ops ||
    !Array.isArray(ops.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !vp ||
    vp.rotation !== 0 ||
    vp.scale !== 1 ||
    vp.width !== page.width ||
    vp.height !== page.height ||
    !near(vp.transform, [1, 0, 0, -1, 0, page.height]) ||
    !Array.isArray(content?.items) ||
    !Array.isArray(context.graphicsBounds)
  )
    return
  const full = []
  try {
    for (const i of content.items)
      if (typeof i.str === 'string' && i.str.trim()) full.push(tableTextToken(i, vp, 0))
  } catch {
    return
  }
  if (full.some((t) => !finiteArray(t.rect, 4) || t.rect[0] >= t.rect[2] || t.rect[1] >= t.rect[3]))
    return
  const relevant = full.filter((t) => overlap(t.rect, box))
  if (
    relevant.length !== packet.own.length ||
    relevant.some(
      (t) =>
        packet.own.filter(
          (x) =>
            x.sourceItem?.pageNumber === t.sourceItem?.pageNumber &&
            x.sourceItem?.index === t.sourceItem?.index &&
            x.text === t.text &&
            near(x.rect, t.rect)
        ).length !== 1
    )
  )
    return
  const known = new Set(
    [
      'dependency',
      'setLineWidth',
      'setLineCap',
      'setLineJoin',
      'setMiterLimit',
      'setDash',
      'setGState',
      'save',
      'restore',
      'transform',
      'clip',
      'eoClip',
      'beginText',
      'endText',
      'setFont',
      'setTextMatrix',
      'showText',
      'setStrokeRGBColor',
      'setFillRGBColor',
      'beginMarkedContentProps',
      'endMarkedContent',
      'paintImageXObject',
      'constructPath'
    ].map((k) => OPS[k])
  )
  if (
    ops.fnArray.some(
      (op, i) =>
        !known.has(op) ||
        (op === OPS.setGState &&
          (ops.argsArray[i]?.[0] ?? []).some(
            ([k]) => !['LW', 'LC', 'LJ', 'ML', 'D', 'CA', 'ca'].includes(k)
          ))
    )
  )
    return
  const evidence = { paths: new Map(), texts: new Map(), images: [] }
  try {
    collectClosedFigureFrames(ops, vp, evidence)
  } catch {
    return
  }
  const records = new Map(),
    rect = (g) => g.normalizedRect?.map((v, i) => v * (i % 2 ? page.height : page.width))
  for (const g of context.graphicsBounds) {
    if (
      !Number.isSafeInteger(g.operationIndex) ||
      records.has(g.operationIndex) ||
      !finiteArray(rect(g), 4)
    )
      return
    records.set(g.operationIndex, g)
  }
  if (
    page.graphicsBounds.some(
      (g) =>
        !records.has(g.operationIndex) ||
        JSON.stringify(g) !== JSON.stringify(records.get(g.operationIndex))
    )
  )
    return
  const paints = [],
    matches = new Set(),
    background = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      a = ops.argsArray[i]
    if (op === OPS.paintImageXObject) {
      const g = records.get(i)
      if (!g || g.kind !== 'image' || overlap(rect(g), box)) return
      continue
    }
    if (op !== OPS.constructPath) continue
    const state = evidence.paths.get(i)
    if (!state) return
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    const g = records.get(i)
    if (!g || g.kind !== 'path') return
    if (!overlap(rect(g), box)) continue
    const raw = a?.[1]?.length === 1 ? Array.from(a[1][0]) : []
    // A page-wide backdrop remains untouched. It is never claimed by this table.
    if (
      a[0] === OPS.fill &&
      raw.length === 13 &&
      raw.every(Number.isFinite) &&
      raw[0] === 0 &&
      raw[3] === 1 &&
      raw[6] === 1 &&
      raw[9] === 1 &&
      raw[12] === 4 &&
      raw[1] === raw[10] &&
      raw[4] === raw[7] &&
      raw[2] === raw[5] &&
      raw[8] === raw[11] &&
      raw[1] < raw[4] &&
      raw[8] < raw[2] &&
      finiteArray(state.transform, 6) &&
      state.transform[1] === 0 &&
      state.transform[2] === 0 &&
      finiteArray(state.clip, 4) &&
      containsRect(box, state.clip) &&
      state.fillAlpha === 1 &&
      rect(g)[0] < page.width * 0.03 &&
      rect(g)[1] < page.height * 0.03 &&
      rect(g)[2] > page.width * 0.97 &&
      rect(g)[3] > page.height * 0.97
    ) {
      background.push(i)
      continue
    }
    if (
      a[0] !== OPS.stroke ||
      raw.length !== 6 ||
      raw[0] !== 0 ||
      raw[3] !== 1 ||
      !raw.every(Number.isFinite) ||
      !finiteArray(state.transform, 6) ||
      state.transform[1] !== 0 ||
      state.transform[2] !== 0 ||
      !finiteArray(state.clip, 4) ||
      !state.solidStroke ||
      state.strokeAlpha !== 1 ||
      ![0, 1, 2].includes(state.lineCap) ||
      !Number.isFinite(state.lineWidth) ||
      state.lineWidth <= 0
    )
      return
    const matrix = Util.transform(vp.transform, state.transform),
      p = [raw[1], raw[2]],
      q = [raw[4], raw[5]]
    Util.applyTransform(p, matrix)
    Util.applyTransform(q, matrix)
    const line = [
      Math.min(p[0], q[0]),
      Math.min(p[1], q[1]),
      Math.max(p[0], q[0]),
      Math.max(p[1], q[1])
    ]
    if (line[0] !== line[2] && line[1] !== line[3]) return
    const found = rules.map((r, n) => (near(r, line) ? n : -1)).filter((n) => n >= 0)
    if (found.length !== 1 || matches.has(found[0])) return
    matches.add(found[0])
    const px = (Math.abs(matrix[0]) * state.lineWidth) / 2,
      py = (Math.abs(matrix[3]) * state.lineWidth) / 2,
      r = [line[0] - px, line[1] - py, line[2] + px, line[3] + py]
    if (!containsRect(r, state.clip)) return
    paints.push({ operationIndex: i, rect: r, line })
  }
  if (matches.size !== rules.length || paints.length !== rules.length || !paints.length) return
  const paintRect = [
    Math.min(...paints.map((p) => p.rect[0])),
    Math.min(...paints.map((p) => p.rect[1])),
    Math.max(...paints.map((p) => p.rect[2])),
    Math.max(...paints.map((p) => p.rect[3]))
  ]
  const ownedPaint = new Set(paints.map((p) => p.operationIndex))
  if (
    context.graphicsBounds.some(
      (g) =>
        !ownedPaint.has(g.operationIndex) &&
        !background.includes(g.operationIndex) &&
        overlap(rect(g), paintRect)
    )
  )
    return
  if (full.some((t) => overlap(t.rect, paintRect) && !relevant.includes(t))) return
  return {
    paintRect,
    paints,
    unclaimedPageBackground: background,
    wholeSourceCount: relevant.length
  }
}

export function findNativeNumberedContinuationFrame(page, tokens, rules) {
  const frame = framePacket(page, tokens, rules)
  return frame &&
    frame.box[1] <= page.height * 0.2 &&
    frame.numbers.length >= 2 &&
    frame.numbers.every((n, i) => n !== null && (!i || n === frame.numbers[i - 1] + 1))
    ? frame
    : undefined
}
export function recoverNativeNumberedContinuationRect(current, previous, captions, context) {
  const proof = proveNumberedContinuation(current, previous, captions)
  if (!proof) return
  return completeCurrentDomain(current[0], current[1], current[2], context, proof.current)
    ?.paintRect
}
