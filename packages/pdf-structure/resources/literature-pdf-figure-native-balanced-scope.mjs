/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { intersection, union } from './literature-pdf-page-geometry.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const letters = (s) => s.normalize('NFD').replace(/\s/gu, '')

// A balanced save is not a clip. Bound every painted path and loaded glyph,
// then independently exclude every outside source and paint. The old candidate
// must actually borrow foreign content; same-column labels cannot be discarded.
export function nativeBalancedVectorFigureScope(page, figure, captions, tables, tokens, context) {
  try {
    return proveBalancedScope(page, figure, captions, tables, tokens, context)
  } catch {
    // Missing optional evidence must preserve the ordinary complete candidate.
    return undefined
  }
}

export function nativeRepeatedHeaderVectorFigureScope(
  page,
  figure,
  captions,
  tables,
  tokens,
  context
) {
  try {
    const header = repeatedHeaderSources(page, context)
    return header && proveBalancedScope(page, figure, captions, tables, tokens, context, header)
  } catch {
    return undefined
  }
}

function repeatedHeaderSources(page, context) {
  const witness = context?.runningHeadWitness,
    current = witness?.currentContent,
    native = context?.content,
    other = witness?.witnessContent,
    v = context?.viewport
  if (
    !witness ||
    witness.sourceSha256 !== context.sourceSha256 ||
    witness.currentPageNumber !== page.pageNumber ||
    !Number.isSafeInteger(witness.witnessPageNumber) ||
    witness.witnessPageNumber < 1 ||
    witness.witnessPageNumber !== page.pageNumber - 2 ||
    !Array.isArray(native?.items) ||
    !Array.isArray(current?.items) ||
    !Array.isArray(other?.items) ||
    native.items.length !== current.items.length ||
    !Number.isFinite(v?.width) ||
    !(v.width > 0) ||
    !Number.isFinite(v?.height) ||
    !(v.height > 0) ||
    ['width', 'height', 'scale', 'rotation', 'transform'].some(
      (k) => !same(v?.[k], witness.witnessViewport?.[k])
    )
  )
    return
  const aliases = new Map(),
    reverse = new Map()
  for (let index = 0; index < native.items.length; index++) {
    const a = native.items[index],
      b = current.items[index]
    if (
      !a ||
      !b ||
      ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
      !same(a.transform, b.transform) ||
      !same(a.sourceItem, b.sourceItem) ||
      !native.styles?.[a.fontName] ||
      !same(native.styles[a.fontName], current.styles?.[b.fontName]) ||
      (aliases.has(a.fontName) && aliases.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    aliases.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  const pair = (content, number) => {
      const all = content.items.flatMap((r, index) =>
          typeof r?.str === 'string' && r.str.trim() ? [{ r, index }] : []
        ),
        p = all.slice(0, 2),
        a = p[0]?.r,
        b = p[1]?.r
      if (
        !a ||
        !b ||
        a.str !== String(number) ||
        !/\p{L}/u.test(b.str) ||
        [a, b].some(
          (r) =>
            r.dir !== 'ltr' ||
            !finite(r.transform, 6) ||
            !Number.isFinite(r.width) ||
            !(r.width > 0) ||
            !Number.isFinite(r.height) ||
            !(r.height > 0) ||
            r.transform[1] !== 0 ||
            r.transform[2] !== 0 ||
            r.transform[0] !== r.height ||
            r.transform[3] !== r.height ||
            r.transform[4] < 0 ||
            r.transform[4] + r.width > v.width ||
            v.height - r.transform[5] - r.height < 0 ||
            v.height - r.transform[5] > v.height
        ) ||
        a.fontName !== b.fontName ||
        a.height !== b.height ||
        a.transform[5] !== b.transform[5] ||
        a.transform[4] + a.width >= b.transform[4]
      )
        return
      const top = v.height - a.transform[5] - a.height,
        bottom = v.height - a.transform[5]
      if (
        all
          .slice(2)
          .some(
            ({ r }) =>
              !finite(r.transform, 6) ||
              !(r.height > 0) ||
              v.height - r.transform[5] - r.height <= bottom
          )
      )
        return
      return { indices: p.map((p) => p.index), items: [a, b], top, bottom }
    },
    a = pair(current, page.pageNumber),
    b = pair(other, witness.witnessPageNumber)
  if (!a || !b || !same(a.indices, b.indices)) return
  for (let i = 0; i < 2; i++) {
    const x = a.items[i],
      y = b.items[i]
    if (
      (i === 1 && x.str !== y.str) ||
      ['width', 'height', 'dir', 'fontName', 'hasEOL'].some((k) => x[k] !== y[k]) ||
      !same(x.transform, y.transform) ||
      !current.styles?.[x.fontName] ||
      !same(current.styles[x.fontName], other.styles?.[y.fontName])
    )
      return
  }
  return new Set(a.indices)
}

function proveBalancedScope(page, figure, captions, tables, tokens, context, repeatedHeader) {
  const cap = figure?.caption,
    v = context?.viewport,
    o = context?.operators
  if (
    !valid(figure?.rect) ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    !Array.isArray(cap.lines) ||
    !/^(?:Figure|Fig\.?)\s+\d+[.:]/u.test(cap.lines[0] ?? '') ||
    !Array.isArray(captions) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    !Array.isArray(tokens) ||
    context?.pageNumber !== page.pageNumber ||
    !/^[0-9a-f]{64}$/iu.test(context?.sourceSha256 ?? '') ||
    !Array.isArray(context?.content?.items) ||
    !same(page.graphicsBounds, context.graphicsBounds) ||
    !finite(v?.transform, 6) ||
    v.rotation !== 0 ||
    v.scale !== 1 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o?.argsArray) ||
    o.fnArray.some((op) =>
      [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup].includes(
        op
      )
    )
  )
    return
  const viewport = {
    ...v,
    convertToViewportPoint: (x, y) => [
      v.transform[0] * x + v.transform[2] * y + v.transform[4],
      v.transform[1] * x + v.transform[3] * y + v.transform[5]
    ]
  }
  const native = context.content.items.flatMap((r) =>
    typeof r.str === 'string' && r.str.trim() ? [tableTextToken(r, viewport, 0)] : []
  )
  // Supplied tokens are optional inventory matches. A zero-advance foreign
  // source remains a complete raw record with its actual loaded glyph ink.
  const supplied = native.filter((t) => valid(t.rect)),
    strict = new Set(
      supplied.filter((t) => intersection(t.rect, figure.rect) > 0).map((t) => t.sourceItem?.index)
    )
  if (!strict.size) return
  const inv = nativePageTextPacketInventory(page, supplied, context, true, strict, true)
  if (!inv || inv.evidence.images.length) return
  const captured = new Map()
  for (const p of page.graphicsBounds) {
    if (
      p.kind !== 'path' ||
      !Number.isSafeInteger(p.operationIndex) ||
      captured.has(p.operationIndex) ||
      !finite(p.normalizedRect, 4)
    )
      return
    captured.set(p.operationIndex, p)
  }
  const paints = []
  for (const [id, state] of inv.evidence.paths) {
    const a = o.argsArray[id]
    if (a[0] === OPS.endPath) continue
    if (!captured.has(id) || !finite(a[2], 4) || !finite(state.transform, 6) || !valid(state.clip))
      return
    const stroke = ![OPS.fill, OPS.eoFill].includes(a[0]),
      miter = inv.strokeMargins.get(id)
    if (stroke && (!(state.lineWidth > 0) || !Number.isFinite(miter) || miter < 1)) return
    // Expanding the native path AABB in both axes covers round/square caps,
    // all accepted joins and the complete affine-transformed miter envelope.
    const pad = stroke ? (state.lineWidth * Math.max(1, miter)) / 2 : 0,
      raw = inv.box(
        Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
        Util.transform(v.transform, state.transform)
      ),
      rect = [
        Math.max(raw[0], state.clip[0]),
        Math.max(raw[1], state.clip[1]),
        Math.min(raw[2], state.clip[2]),
        Math.min(raw[3], state.clip[3])
      ]
    if (!valid(rect)) return
    paints.push({ id, rect })
  }
  const parsed = new Set(paints.map((p) => p.id))
  if (paints.length !== captured.size || [...captured.keys()].some((id) => !parsed.has(id))) return
  const lead = inv.records
    .filter((r) => {
      const t = tableTextToken(r.r, viewport, 0)
      return (
        valid(t.rect) &&
        t.horizontal &&
        inside(cap.rect, t.rect) &&
        Math.abs(t.rect[1] - cap.rect[1]) < 0.01
      )
    })
    .sort((a, b) => a.rect[0] - b.rect[0])
  const h = Math.max(...lead.map((r) => r.r.height))
  if (
    !lead.length ||
    !(h > 0) ||
    lead.some((r) => r.foreignSourceNormalized || !r.advanceComplete) ||
    letters(lead.map((r) => r.r.str).join('')) !== letters(cap.lines[0])
  )
    return
  const stack = [],
    scopes = []
  for (const [i, op] of o.fnArray.entries()) {
    if (op === OPS.save) {
      if (stack.length >= 64) return
      stack.push({ begin: i, paint: [], shows: [] })
    } else if (op === OPS.restore) {
      const scope = stack.pop()
      if (!scope) return
      scope.end = i
      scopes.push(scope)
    }
    for (const scope of stack) {
      if (captured.has(i)) scope.paint.push(i)
      if (op === OPS.showText) scope.shows.push(i)
    }
  }
  if (stack.length) return
  const possible = scopes.filter((s) => s.paint.length >= 3 && s.shows.length >= 3)
  if (possible.length > 64) return
  const results = new Map(),
    captionBand = [cap.rect[0], 0, cap.rect[2], page.height]
  for (const scope of possible) {
    const owns = (id) => id > scope.begin && id < scope.end,
      frames = [...inv.evidence.frames].filter(([id]) => owns(id)).map(([, r]) => r)
    if (
      frames.length < 3 ||
      frames.length > 128 ||
      frames.some((r, i) => !valid(r) || frames.some((q, j) => i !== j && intersection(r, q) > 0))
    )
      continue
    const glyphs = inv.glyphs.filter((g) => owns(g.i)),
      records = inv.records.filter((r) => r.part.some((p) => owns(p.g.i))),
      ownPaint = paints.filter((p) => owns(p.id))
    if (
      !glyphs.length ||
      !records.length ||
      ownPaint.length < 3 ||
      records.some(
        (r) =>
          r.part.some((p) => !owns(p.g.i)) ||
          r.foreignSourceNormalized ||
          !r.advanceComplete ||
          !strict.has(r.index)
      )
    )
      continue
    const rect = union([
      ...ownPaint.map((p) => p.rect),
      ...glyphs.flatMap((g) => [g.advance, g.ink]).filter(valid)
    ])
    if (
      !valid(rect) ||
      (!repeatedHeader && !inside(figure.rect, rect)) ||
      !inside(captionBand, rect) ||
      cap.rect[1] <= rect[3] ||
      cap.rect[1] - rect[3] > h * 4 ||
      tables.some((t) => intersection(t, rect) > 0) ||
      captions.some(
        (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
      )
    )
      continue
    const foreign = inv.glyphs.filter((g) => !owns(g.i)),
      foreignRecords = inv.records.filter((r) => r.part.every((p) => !owns(p.g.i))),
      foreignPaint = paints.filter((p) => !owns(p.id)),
      outsideInk = [
        ...foreign.map((g) => g.ink),
        ...foreignRecords.map((r) => r.rect),
        ...foreignPaint.map((p) => p.rect),
        ...tables,
        ...captions.filter((c) => c.page === page.pageNumber).map((c) => c.rect)
      ]
    if (!outsideInk.every((r) => finite(r, 4) && intersection(r, rect) === 0)) continue
    const removed = [
      ...foreign.map((g) => g.ink),
      ...foreignRecords.map((r) => r.rect),
      ...foreignPaint.map((p) => p.rect)
    ].filter((r) => intersection(r, figure.rect) > 0)
    if (!removed.length) continue
    if (repeatedHeader) {
      const headerRecords = foreignRecords.filter((r) => repeatedHeader.has(r.index)),
        headerGlyphs = new Set(headerRecords.flatMap((r) => r.part.map((p) => p.g))),
        inColumn = (r) => intersection(r, figure.rect) > 0 && intersection(r, captionBand) > 0
      if (
        headerRecords.length !== 2 ||
        headerRecords.some(
          (r) => r.foreignSourceNormalized || !r.advanceComplete || !inside(figure.rect, r.rect)
        ) ||
        foreignRecords.some((r) => inColumn(r.rect) && !repeatedHeader.has(r.index)) ||
        foreign.some((g) => inColumn(g.ink) && !headerGlyphs.has(g)) ||
        foreignPaint.some((p) => inColumn(p.rect))
      )
        continue
    } else if (removed.some((r) => intersection(r, captionBand) > 0)) continue
    // Nested saves with the exact same paint/text owners are one proof, not
    // competing bodies. Independent owner sets remain ambiguous and fail.
    const key = JSON.stringify([scope.paint, scope.shows])
    results.set(key, {
      ...figure,
      rect,
      graphicsCount: ownPaint.length,
      reason: repeatedHeader
        ? 'native-repeated-header-vector-scope'
        : 'native-balanced-vector-scope',
      groupRasterProof: { bounds: { width: page.width, height: page.height }, outsideInk }
    })
  }
  return results.size === 1 ? [...results.values()][0] : undefined
}
