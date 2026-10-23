/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import {
  completeNativeNodeGlyphProgram,
  completeNativeNodeGlyphState
} from './literature-pdf-figure-native-plot-bands.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
const over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const cap = (c) => c && { page: c.page, lines: c.lines, rect: c.rect }
const multiset = (a) => a.map((v) => JSON.stringify(v)).sort()

const mapped = (v, aliases) =>
  Array.isArray(v) || ArrayBuffer.isView(v)
    ? Array.from(v, (x) => mapped(x, aliases))
    : typeof v === 'string'
      ? (aliases.get(v) ?? v)
      : v
function boundSource(page, native, current) {
  if (
    !native ||
    page.invalidGraphicsBounds !== 0 ||
    native.pageNumber !== page.pageNumber ||
    !/^[a-f0-9]{64}$/u.test(native.sourceSha256) ||
    current?.sourceSha256 !== native.sourceSha256 ||
    !equal(native.graphicsBounds, page.graphicsBounds) ||
    new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !== page.graphicsBounds.length ||
    native.content?.items?.length !== current?.content?.items?.length ||
    !equal(native.viewport?.transform, [1, 0, 0, -1, 0, page.height]) ||
    native.viewport?.width !== page.width ||
    native.viewport?.height !== page.height ||
    native.viewport?.scale !== 1 ||
    native.viewport?.rotation !== 0 ||
    page.rotation !== 0 ||
    page.renderRotation !== 0
  )
    return false
  for (const field of ['width', 'height', 'scale', 'rotation', 'transform'])
    if (!equal(native.viewport[field], current.viewport?.[field])) return false
  const aliases = new Map(),
    reverse = new Map()
  for (let index = 0; index < native.content.items.length; index++) {
    const a = native.content.items[index],
      b = current.content.items[index]
    if (
      ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
      !equal(a.transform, b.transform) ||
      !equal(a.sourceItem, b.sourceItem) ||
      !native.content.styles[a.fontName] ||
      !equal(native.content.styles[a.fontName], current.content.styles?.[b.fontName]) ||
      (aliases.has(a.fontName) && aliases.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return false
    aliases.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  return aliases
}
function nativePaints(proof) {
  const paths = [],
    rules = new Map(),
    o = proof.o
  if (
    proof.evidence.images.length ||
    o.fnArray.some((op) =>
      [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op)
    )
  )
    return
  for (const [index, state] of proof.evidence.paths) {
    const args = o.argsArray[index],
      p = args?.[1]?.length === 1 ? args[1][0] : undefined,
      matrix = Util.transform(proof.v.transform, state.transform)
    if (
      !p ||
      !Array.from(p).every(Number.isFinite) ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      !valid(state.clip)
    )
      return
    const line = args[0] === OPS.stroke && p.length === 6 && p[0] === 0 && p[3] === 1,
      rectangle = p.length === 13 && p[0] === 0 && p[12] === 4 && [3, 6, 9].every((n) => p[n] === 1)
    if (!line && !rectangle) return
    if (
      line
        ? state.strokeAlpha !== 1 || !state.solidStroke || !(state.lineWidth > 0)
        : args[0] !== OPS.fill || state.fillAlpha !== 1
    )
      return
    const points = (line ? [0, 3] : [0, 3, 6, 9]).map((n) => {
      const q = [p[n + 1], p[n + 2]]
      Util.applyTransform(q, matrix)
      return q
    })
    if (
      rectangle &&
      (new Set(points.map((p) => p[0])).size !== 2 || new Set(points.map((p) => p[1])).size !== 2)
    )
      return
    const rect = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    // One move/line has no joins: a full transformed line width conservatively
    // bounds all butt, round and square caps without assuming a miter limit.
    const pad = line ? Math.max(Math.abs(matrix[0]), Math.abs(matrix[3])) * state.lineWidth : 0,
      bounds = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad]
    if (!valid(bounds) || !inside(state.clip, bounds)) return
    paths.push({ index, bounds })
    if (line && rect[1] === rect[3]) {
      const key = rect.join(',')
      if (rules.has(key)) return
      rules.set(key, index)
    }
  }
  if (paths.length !== proof.evidence.paths.size) return
  return { paths, rules }
}

// Caption ownership is independent from cell reliability. Complete native source
// and paint prove only which table owns this caption; they repair no cell text.
function proveCaptionOwner(page, native, graphical, tables, captions, current) {
  try {
    const aliases = boundSource(page, native, current)
    if (!aliases) return
    if (
      !Array.isArray(tables) ||
      tables.length > 64 ||
      !Array.isArray(captions) ||
      captions.length > 512
    )
      return
    if (
      !valid(graphical.rect) ||
      !valid(graphical.caption?.rect) ||
      graphical.caption.page !== page.pageNumber
    )
      return
    const v = { ...native.viewport, convertToViewportPoint: (x, y) => [x, page.height - y] },
      context = { ...native, viewport: v },
      tokens = context.content.items
        .map((r) => tableTextToken(r, v, 0))
        .filter((t) => t?.text?.trim()),
      frames = collectClosedFigureFrames(context.operators, v)
    if (!completeNativeNodeGlyphState(page, tokens, frames, context)) return
    const currentView = {
        ...current.viewport,
        convertToViewportPoint: (x, y) => [x, page.height - y]
      },
      currentContext = { ...current, viewport: currentView },
      currentEvidence = { paths: new Map(), texts: new Map(), images: [], frames: new Map() },
      currentFrames = collectClosedFigureFrames(current.operators, currentView, currentEvidence),
      currentTokens = current.content.items
        .map((r) => tableTextToken(r, currentView, 0))
        .filter((t) => t?.text?.trim())
    if (!completeNativeNodeGlyphProgram(page, currentTokens, currentFrames, currentContext)) return
    const currentPaints = nativePaints({
      o: current.operators,
      v: currentView,
      evidence: currentEvidence
    })
    if (!currentPaints) return
    if (
      context.operators.fnArray.some(
        (op, i) =>
          [OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) &&
          (!/^#[0-9a-f]{6}$/iu.test(context.operators.argsArray[i]?.[0]) ||
            context.operators.argsArray[i][0].toLowerCase() === '#ffffff')
      )
    )
      return
    if (
      captions.filter((c) => c.page === page.pageNumber && equal(cap(c), cap(graphical.caption)))
        .length !== 1
    )
      return
    const candidates = tables.filter(
      (t) =>
        t.page === page.pageNumber &&
        Array.isArray(t.grid) &&
        t.grid.length >= 3 &&
        t.grid[0]?.length >= 2 &&
        t.cells?.length &&
        equal(cap(t.caption), cap(graphical.caption))
    )
    if (candidates.length !== 1) return
    const owner = candidates[0],
      grid = owner.grid,
      cols = grid[0]?.length
    if (
      grid.length < 3 ||
      grid.length > 256 ||
      !Number.isInteger(cols) ||
      cols < 2 ||
      cols > 128 ||
      grid.some((r) => !Array.isArray(r) || r.length !== cols) ||
      !owner.cells?.length ||
      owner.cells.length > 2048
    )
      return
    const selected = new Set(),
      captionItems = []
    if (
      owner.caption.lines.length < 1 ||
      owner.caption.lines.length > 3 ||
      owner.caption.lines.join(' ') !== owner.caption.text
    )
      return
    for (const line of owner.caption.lines) {
      const matches = context.content.items.flatMap((r, index) =>
        r.str === line ? [{ r, index }] : []
      )
      if (matches.length !== 1) return
      captionItems.push(matches[0])
      selected.add(matches[0].index)
    }
    if (captionItems.some((r, i) => i && r.index <= captionItems[i - 1].index)) return
    const proof = nativePageTextPacketInventory(page, tokens, context, false, selected)
    if (!proof) return
    const paints = nativePaints(proof)
    if (!paints) return
    if (
      paints.paths.some((p) =>
        proof.glyphs.some((g) => g.i < p.index && valid(g.ink) && over(p.bounds, g.ink))
      )
    )
      return
    const captionRecords = proof.records.filter((r) => selected.has(r.index))
    if (
      captionRecords.length !== selected.size ||
      captionRecords.some(
        (r) => !r.advanceComplete || !valid(r.ink) || r.part.some((z) => !valid(z.g.ink))
      )
    )
      return
    const captionRect = union([owner.caption.rect, ...captionRecords.map((r) => r.ink)]),
      h = captionRecords[0].r.height
    if (
      captionRecords.some(
        (r, i) =>
          r.r.fontName !== captionRecords[0].r.fontName ||
          r.r.height !== h ||
          !inside(owner.caption.rect, r.rect) ||
          (i && r.rect[1] <= captionRecords[i - 1].rect[3])
      )
    )
      return
    if (proof.records.some((r) => !selected.has(r.index) && over(captionRect, r.ink))) return
    if (!(graphical.rect[0] > captionRect[2] || captionRect[0] > graphical.rect[2])) return
    const paint = new Map(),
      rules = collectTableRules(context.operators, v, paint),
      groups = new Map()
    for (const r of rules) {
      if (r[1] !== r[3] || !paint.has(r.join(','))) continue
      const k = r[0] + ':' + r[2]
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    const slots = new Set(),
      assigned = new Map()
    const sv = owner.sourceViewport
    if (
      !sv ||
      sv.scale !== 1.5 ||
      sv.width !== page.width * sv.scale ||
      sv.height !== page.height * sv.scale
    )
      return
    const sourceView = {
      scale: sv.scale,
      transform: [sv.scale, 0, 0, -sv.scale, 0, sv.height],
      convertToViewportPoint: (x, y) => [x * sv.scale, sv.height - y * sv.scale]
    }
    for (const c of owner.cells) {
      if (
        ![c.row, c.column, c.rowSpan, c.colSpan].every(Number.isInteger) ||
        c.row < 0 ||
        c.column < 0 ||
        c.rowSpan < 1 ||
        c.colSpan < 1 ||
        c.row + c.rowSpan > grid.length ||
        c.column + c.colSpan > cols ||
        c.text !== grid[c.row][c.column]
      )
        return
      for (let r = c.row; r < c.row + c.rowSpan; r++)
        for (let n = c.column; n < c.column + c.colSpan; n++) {
          const k = r + ':' + n
          if (slots.has(k)) return
          slots.add(k)
        }
      const items = c.sourceItems ?? [],
        actual = []
      if (
        !Array.isArray(c.sourceRects) ||
        items.length !== c.sourceRects.length ||
        (!items.length && c.text !== '')
      )
        return
      for (const s of items) {
        const r = context.content.items[s.index]
        if (
          s.pageNumber !== page.pageNumber ||
          !r ||
          r.str !== s.text ||
          assigned.has(s.index) ||
          !r.sourceItem ||
          !equal(r.sourceItem, s)
        )
          return
        assigned.set(s.index, s)
        actual.push(tableTextToken(r, sourceView, 0).rect)
      }
      if (!equal(multiset(actual), multiset(c.sourceRects))) return
    }
    if (slots.size !== grid.length * cols || assigned.size < 6) return
    const bodyCandidates = []
    for (const rs of groups.values()) {
      rs.sort((a, b) => a[1] - b[1])
      if (rs.length < 3) continue
      const frame = [rs[0][0], rs[0][1], rs[0][2], rs.at(-1)[1]],
        body = proof.records.filter((r) => over(frame, r.ink))
      if (
        frame[3] >= captionRect[1] ||
        captionRect[1] - frame[3] > h * 2 ||
        !(graphical.rect[0] > frame[2] || frame[0] > graphical.rect[2]) ||
        Math.min(frame[2], captionRect[2]) <= Math.max(frame[0], captionRect[0])
      )
        continue
      if (
        body.length < assigned.size ||
        body.some(
          (r) =>
            !inside(frame, r.ink) ||
            !inside(frame, r.rect) ||
            !r.advanceComplete ||
            r.part.some((z) => !valid(z.g.ink))
        ) ||
        [...assigned].some(([index]) => !body.some((r) => r.index === index))
      )
        continue
      const unassigned = body.filter((r) => !assigned.has(r.index)).map((r) => r.r.str)
      if (!equal(multiset(unassigned), multiset(owner.unassigned ?? []))) continue
      const ruleOwners = rs.map((r) => paints.rules.get(r.join(',')))
      const currentRuleOwners = rs.map((r) => currentPaints.rules.get(r.join(',')))
      if (
        ruleOwners.some((i) => i === undefined) ||
        new Set(ruleOwners).size !== rs.length ||
        currentRuleOwners.some((i) => i === undefined) ||
        new Set(currentRuleOwners).size !== rs.length ||
        currentPaints.paths.some(
          (p) =>
            !currentRuleOwners.includes(p.index) &&
            (over(p.bounds, frame) || over(p.bounds, captionRect))
        ) ||
        paints.paths.some(
          (p) =>
            !ruleOwners.includes(p.index) && (over(p.bounds, frame) || over(p.bounds, captionRect))
        ) ||
        rs.some((r) => body.some((b) => over(paint.get(r.join(',')), b.ink)))
      )
        continue
      const lastPacket = Math.max(
        ...[...body, ...captionRecords].flatMap((r) => r.part.map((z) => z.g.packet.end))
      )
      if (
        !Number.isSafeInteger(lastPacket) ||
        context.operators.fnArray[lastPacket] !== OPS.endText ||
        !equal(
          context.operators.fnArray.slice(0, lastPacket + 1),
          current.operators.fnArray.slice(0, lastPacket + 1)
        ) ||
        !equal(
          mapped(context.operators.argsArray.slice(0, lastPacket + 1), aliases),
          mapped(current.operators.argsArray.slice(0, lastPacket + 1), new Map())
        )
      )
        continue
      bodyCandidates.push({ frame, rules: rs, body, unassigned, lastPacket })
    }
    if (bodyCandidates.length !== 1) return
    const body = bodyCandidates[0]
    return {
      ownerId: owner.id,
      captionRect,
      captionIndexes: [...selected],
      bodyFrame: body.frame,
      bodySourceCount: body.body.length,
      assignedSourceCount: assigned.size,
      unassigned: body.unassigned,
      slotCount: slots.size,
      ruleCount: body.rules.length,
      cellRectMultisetsExact: true,
      targetClosedPacketPrefixEnd: body.lastPacket,
      fullNativeSourceFontBinding: true,
      bothWholeProgramsKnownState: true,
      currentWholeGlyphProgramBound: true,
      allCurrentNonOwnerPaintExcludedFromBodyAndCaption: true,
      allNativePrimitivesExcluded: true,
      laterPaintCannotCoverAnyNativeGlyph: true,
      metadataOnly: true
    }
  } catch {
    return undefined
  }
}

// This is a metadata-only proof. The caller owns the final immutable caption removal.
export function proveNativeTableCaptionOwnership(table, scope = {}) {
  try {
    const { page, context, tables, captions } = scope
    if (
      !page ||
      !context ||
      table?.page !== page.pageNumber ||
      !valid(table.region) ||
      table.region.some((n) => n < 0 || n > 1) ||
      !Array.isArray(table.grid) ||
      table.grid.length ||
      !Array.isArray(table.cells) ||
      table.cells.length ||
      !Array.isArray(table.unassigned) ||
      table.unassigned.length ||
      !equal(table.issues, ['no-source-cell-grid']) ||
      table.nativeBody ||
      table.parts ||
      !table.caption
    )
      return
    const graphical = {
      caption: table.caption,
      rect: table.region.map((n, i) => n * (i % 2 ? page.height : page.width))
    }
    const proof = proveCaptionOwner(
      page,
      context.nativeGlyphContext,
      graphical,
      tables,
      captions,
      context
    )
    return proof ? { ...proof, caption: table.caption } : undefined
  } catch {
    return undefined
  }
}
