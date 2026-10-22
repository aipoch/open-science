/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const contains = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 0.01 : v <= a[i] + 0.01))
const strict = (a, b) => b.every((v, i) => (i < 2 ? v > a[i] + 0.01 : v < a[i] - 0.01))
const compact = (s) => s.replace(/\s/gu, '')
const cy = (r) => (r[1] + r[3]) / 2
const exactMatrixEquality = (nodes, text) =>
  nodes.length >= 2 && compact(text) === nodes.at(-1) + '=' + nodes.slice(0, -1).join('')

// Full rendered/native inventory is required even for optional label claims.
// Unknown external geometry, aliases and a second caption leave the original
// figure untouched; the Reader separately enforces complete native owners.
function inventory(page, figure, captions, tables, tokens, context) {
  if (!figure.caption || page.rotation !== 0 || !Array.isArray(captions) || !Array.isArray(tables))
    return
  const p = nativePageTextPacketInventory(page, tokens, context, true),
    seed = figure.rect
  if (!p || !p.valid(seed) || !p.inside([0, 0, page.width, page.height], seed)) return
  const caps = captions.filter((c) => c.page === page.pageNumber)
  if (
    caps.length !== 1 ||
    !Array.isArray(caps[0].lines) ||
    !/^Fig(?:ure|\.)\s+\d+[.:]/u.test(caps[0].lines.join(' '))
  )
    return
  const cap = caps[0]
  if (
    !p.valid(cap.rect) ||
    seed[3] >= cap.rect[1] ||
    figure.caption.page !== cap.page ||
    !p.valid(figure.caption.rect) ||
    !figure.caption.rect.every((n, i) => Math.abs(n - cap.rect[i]) < 1e-6) ||
    !Array.isArray(figure.caption.lines) ||
    compact(figure.caption.lines.join('')) !== compact(cap.lines.join(''))
  )
    return
  const capRecords = p.records.filter((r) => overlap(r.rect, cap.rect))
  if (
    !capRecords.length ||
    capRecords.some((r) => !p.inside(cap.rect, r.rect)) ||
    compact(capRecords.map((r) => r.r.str).join('')) !== compact(cap.lines.join(''))
  )
    return
  if (tables.some((r) => !p.valid(r) || overlap(r, seed))) return
  const nativeRectsByIndex = new Map()
  for (const r of p.records) {
    const box = nativeFigureLabelBounds(
      context.content.items[r.index],
      context.content.styles?.[r.r.fontName],
      context.viewport
    )
    if (!box) return
    nativeRectsByIndex.set(r.index, box)
  }
  return { p, seed, cap, capRecords, nativeRectsByIndex }
}
function result(figure, rect, records, tokens, context) {
  const ids = new Set(records.map((r) => r.index)),
    selected = tokens.filter(
      (t) =>
        ids.has(t.sourceItem?.index) &&
        t.sourceItem.pageNumber === records[0]?.r.sourceItem.pageNumber
    )
  if (
    !ids.size ||
    ids.size !== records.length ||
    selected.length !== ids.size ||
    !proveNativeUniqueWholeFonts(selected, tokens)
  )
    return
  const sources = new Map()
  for (const source of [...(figure.sourceItems ?? []), ...records.map((r) => r.r.sourceItem)]) {
    const key = source.pageNumber + ':' + source.index,
      previous = sources.get(key)
    if (
      !Number.isInteger(source.index) ||
      source.index < 0 ||
      source.pageNumber !== records[0].r.sourceItem.pageNumber ||
      context.content.items[source.index]?.str !== source.text ||
      (previous && previous.text !== source.text)
    )
      return
    sources.set(key, source)
  }
  return {
    rect,
    sourceItems: [...sources.values()].sort(
      (a, b) => a.pageNumber - b.pageNumber || a.index - b.index
    )
  }
}

// A native equation outside the seed must literally repeat the ordered labels
// of closed matrices on the same row. A save/restore scope alone owns nothing.
export function nativeMatrixFigureScope(page, figure, captions, tables, tokens, context) {
  const common = inventory(page, figure, captions, tables, tokens, context)
  if (!common) return
  const { p, seed, cap, capRecords, nativeRectsByIndex } = common,
    otherRegions = tables
  if (p.evidence.images.length) return

  const frameEvidence = { frames: new Map(), paths: new Map(), texts: new Map(), images: [] }
  const proofArgs = p.o.argsArray.slice()
  for (const [i] of p.evidence.paths) {
    const a = p.o.argsArray[i],
      path = a[1]?.length === 1 && a[1][0] ? Array.from(a[1][0]) : null
    if (!path) continue
    // After an explicit close, trailing moveTo commands paint no edge. Remove
    // only those complete unpainted commands before reusing the frame validator.
    let n = 0,
      lastClose = -1,
      valid = true
    while (n < path.length) {
      const op = path[n]
      if (op === 4) {
        lastClose = n
        n++
      } else if (op === 0 || op === 1) {
        if (n + 2 >= path.length) {
          valid = false
          break
        }
        n += 3
      } else {
        valid = false
        break
      }
    }
    if (valid && lastClose >= 0) {
      const tail = path.slice(lastClose + 1)
      if (tail.length % 3 === 0 && tail.every((v, j) => j % 3 !== 0 || v === 0))
        proofArgs[i] = [a[0], [path.slice(0, lastClose + 1)], a[2]]
    }
  }
  collectClosedFigureFrames({ ...p.o, argsArray: proofArgs }, p.v, frameEvidence)
  const paints = []
  for (const [i, state] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath) continue
    if (a[0] !== OPS.stroke || !state.solidStroke || state.strokeAlpha !== 1 || !p.finite(a[2], 4))
      return
    // Existing collector proves four consecutive closed edges, not only their bbox.
    const exact = frameEvidence.frames.get(i),
      transform = Util.transform(p.v.transform, state.transform)
    if (
      !exact ||
      !p.finite(transform, 6) ||
      Math.abs(transform[1]) > 1e-8 ||
      Math.abs(transform[2]) > 1e-8 ||
      transform[0] === 0 ||
      transform[3] === 0
    )
      return
    const pad = state.lineWidth / 2
    if (!Number.isFinite(pad) || pad < 0) return
    const ink = p.box(
      Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
      transform
    )
    if (!state.clip || !p.inside(state.clip, ink) || !p.inside(seed, ink)) return
    paints.push({ i, rect: exact, ink })
  }
  if (paints.length < 2) return
  const stack = [],
    scopes = []
  for (let i = 0; i < p.o.fnArray.length; i++) {
    const op = p.o.fnArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ i, op })
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const s = stack.pop()
      if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      if (paints.every((x) => x.i > s.i && x.i < i)) scopes.push({ start: s.i, end: i })
    }
  }
  if (stack.length || !scopes.length) return
  scopes.sort((a, b) => a.end - a.start - (b.end - b.start))
  const scope = scopes[0],
    owned = (g) => g.i > scope.start && g.i < scope.end,
    body = p.records.filter((r) => r.part.some((x) => owned(x.g))),
    packets = p.packets.filter((t) => t.glyphs.some(owned))
  if (
    body.some((r) => !r.part.every((x) => owned(x.g))) ||
    packets.some((t) => !t.glyphs.every(owned))
  )
    return
  // Independent semantic witness: complete matrix rows in seed, exact native equality label outside.
  const rows = []
  for (const paint of paints) {
    const row = rows.find((r) => Math.abs(cy(r[0].rect) - cy(paint.rect)) < 0.01)
    if (row) row.push(paint)
    else rows.push([paint])
  }
  for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
  const outside = packets.filter((t) => !p.inside(seed, t.rect))
  if (!outside.length) return
  for (const t of outside) {
    if (t.rect[0] >= seed[0] || t.rect[2] <= seed[0]) return
    const matches = []
    for (const row of rows) {
      if (
        row.length < 2 ||
        !row.every((r) => overlap([t.rect[0], t.rect[1], r.rect[2], t.rect[3]], r.rect))
      )
        continue
      const labels = row.map((r) => packets.filter((x) => p.inside(r.rect, union([x.rect, x.ink]))))
      if (labels.some((x) => x.length !== 1)) continue
      const seq = labels.map((x) => compact(x[0].text))
      if (!exactMatrixEquality(seq, t.text)) continue
      const insideGlyphs = packets
        .filter((x) => p.inside(seed, union([x.rect, x.ink])))
        .flatMap((x) => x.glyphs)
      if (
        !t.glyphs.every(
          (g) =>
            !g.text.trim() ||
            insideGlyphs.some(
              (h) =>
                h.text === g.text &&
                h.fontName === g.fontName &&
                Math.abs(h.height - g.height) < 1e-6 &&
                h.ink[1] < g.ink[3] &&
                g.ink[1] < h.ink[3]
            )
        )
      )
        continue
      matches.push(row)
    }
    if (matches.length !== 1) return
  }
  const nativeRects = []
  for (const r of body) {
    const n = nativeRectsByIndex.get(r.index)
    if (!n) return
    nativeRects.push(n)
  }
  const rect = union([
    seed,
    ...paints.map((x) => x.ink),
    ...body.map((r) => r.rect),
    ...body.flatMap((r) => r.part.map((z) => z.g.ink)),
    ...nativeRects
  ])
  if (!p.inside([0, 0, page.width, page.height], rect) || rect[3] >= cap.rect[1]) return
  if (otherRegions.some((q) => overlap(q, rect))) return
  const keys = new Set(body.map((r) => r.index))
  for (const r of p.records.filter((r) => !keys.has(r.index))) {
    const nr = nativeRectsByIndex.get(r.index)
    if (!nr) return
    if ([r.rect, nr, ...r.part.map((z) => z.g.ink)].some((q) => overlap(q, rect))) return
  }
  const corridor = [rect[0], rect[3], rect[2], cap.rect[1]]
  if (
    p.records.some(
      (r) =>
        !keys.has(r.index) &&
        !capRecords.includes(r) &&
        [r.rect, ...r.part.map((z) => z.g.ink)].some((q) => overlap(q, corridor))
    )
  )
    return

  return result(figure, rect, body, tokens, context)
}
function paintEnvelope(p, i, state) {
  const a = p.o.argsArray[i],
    op = a?.[0]
  if (
    ![
      OPS.stroke,
      OPS.closeStroke,
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(op) ||
    !p.finite(a?.[2], 4) ||
    !p.finite(state.transform, 6) ||
    !p.valid(state.clip)
  )
    return
  const stroked = [
    OPS.stroke,
    OPS.closeStroke,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke
  ].includes(op)
  const miter = p.strokeMargins.get(i),
    pad = stroked ? (state.lineWidth * miter) / 2 : 0
  if (!Number.isFinite(pad) || pad < 0 || (stroked && (!Number.isFinite(miter) || miter < 1)))
    return
  const raw = p.box(
    Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
    Util.transform(p.v.transform, state.transform)
  )
  if (!raw?.every(Number.isFinite)) return
  return [
    Math.max(raw[0], state.clip[0]),
    Math.max(raw[1], state.clip[1]),
    Math.min(raw[2], state.clip[2]),
    Math.min(raw[3], state.clip[3])
  ]
}
function closedLeafHierarchy(frames, seed) {
  if (frames.length < 6 || frames.some((r) => !contains(seed, r))) return
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i],
        b = frames[j]
      if (overlap(a, b) && !strict(a, b) && !strict(b, a)) return
    }
  const parents = frames.map((r) => frames.filter((s) => s !== r && strict(s, r)))
  if (parents.some((ps) => ps.length > 1)) return
  const roots = frames.filter((_, i) => parents[i].length === 0)
  if (roots.length < 2) return
  const leaf = []
  for (const root of roots) {
    const children = frames.filter((_, i) => parents[i].length === 1 && parents[i][0] === root)
    if (
      children.length < 2 ||
      children.some(
        (c) => Math.abs(c[1] - children[0][1]) > 0.01 || Math.abs(c[3] - children[0][3]) > 0.01
      )
    )
      return
    leaf.push(...children)
  }
  return { roots, leaf }
}

// Do not drop arbitrary enclosing frames. This no-expansion family requires an
// exact two-level forest and complete page-local label fonts in its leaf nodes.
export function nativeClosedNodeSources(page, figure, captions, tables, tokens, context) {
  const common = inventory(page, figure, captions, tables, tokens, context)
  if (!common) return
  const { p, seed, nativeRectsByIndex } = common
  const ev = { frames: new Map(), paths: new Map(), texts: new Map(), images: [] }
  const allFrames = collectClosedFigureFrames(p.o, p.v, ev)
  const hierarchy = closedLeafHierarchy(
    allFrames.filter((r) => overlap(r, seed)),
    seed
  )
  if (!hierarchy || ev.images.some((x) => !x.rect || overlap(x.rect, seed))) return
  const { leaf } = hierarchy,
    owned = [],
    claimedBoxes = []
  for (const r of p.records) {
    const n = nativeRectsByIndex.get(r.index)
    if (!n) return
    const boxes = [r.rect, n, ...r.part.map((x) => x.g.ink)]
    const touching = leaf.filter((f) => boxes.some((b) => overlap(f, b)))
    if (!touching.length) continue
    if (touching.length !== 1 || !boxes.every((b) => strict(touching[0], b))) return
    owned.push(r)
    claimedBoxes.push(...boxes)
  }
  if (leaf.some((f) => !owned.some((r) => contains(f, r.rect)))) return
  const ids = new Set(owned.map((r) => r.index)),
    fonts = new Set(owned.map((r) => r.r.fontName))
  if (p.records.some((r) => fonts.has(r.r.fontName) && !ids.has(r.index))) return
  const ownedGlyphs = new Set(owned.flatMap((r) => r.part.map((x) => x.g)))
  for (const packet of p.packets.filter((t) => t.glyphs.some((g) => ownedGlyphs.has(g)))) {
    if (
      !leaf.some((f) => strict(f, packet.rect) && strict(f, packet.ink)) ||
      packet.glyphs.some((g) => g.text.trim() && !ownedGlyphs.has(g))
    )
      return
    claimedBoxes.push(packet.rect, packet.ink)
  }
  const selected = tokens.filter(
    (t) => ids.has(t.sourceItem?.index) && t.sourceItem.pageNumber === page.pageNumber
  )
  if (selected.length !== ids.size || !proveNativeUniqueWholeFonts(selected, tokens)) return
  // Closed nodes own complete enclosed labels. Connections may touch a node's
  // perimeter, but every non-frame painted ink envelope must miss all claimed
  // advance/em/glyph envelopes. This does not claim edge or container labels.
  for (const [i, state] of ev.paths) {
    if (ev.frames.has(i) || p.o.argsArray[i][0] === OPS.endPath) continue
    const box = paintEnvelope(p, i, state)
    if (!box) return
    if (claimedBoxes.some((b) => overlap(box, b))) return
  }

  return result(figure, [...seed], owned, tokens, context)
}
