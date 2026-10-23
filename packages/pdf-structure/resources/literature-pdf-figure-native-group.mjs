/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { intersection, union } from './literature-pdf-page-geometry.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const letters = (s) => Array.from(s.normalize('NFD')).filter((c) => !/\s/u.test(c))
const box = (r, m) => {
  const points = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]]
  ]
  for (const p of points) Util.applyTransform(p, m)
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
}

// This is a clip proof, not a font-ink proof. PDF.js 5.4.624 beginGroup creates
// a bounded scratch canvas and explicitly clips it to bbox even when isolated
// is false. Never admit that group to the stricter glyph/path inventories.
function disjointGroupProgram(page, tokens, context, groupCount = 2) {
  const o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items
  if (
    page.invalidGraphicsBounds !== 0 ||
    ![tokens, raw, page.graphicsBounds, context?.graphicsBounds, o?.fnArray, o?.argsArray].every(
      Array.isArray
    ) ||
    !equal(context.graphicsBounds, page.graphicsBounds) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    v?.width !== page.width ||
    v.height !== page.height ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    !equal(v.transform, [1, 0, 0, -1, 0, page.height])
  )
    return
  const viewport = { ...v, convertToViewportPoint: (x, y) => [x, page.height - y] }
  const paint = new Map()
  for (const g of page.graphicsBounds) {
    if (
      !Number.isInteger(g.operationIndex) ||
      paint.has(g.operationIndex) ||
      !['image', 'path'].includes(g.kind) ||
      !valid(g.normalizedRect)
    )
      return
    const rect = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (!inside([0, 0, page.width, page.height], rect)) return
    paint.set(g.operationIndex, { ...g, rect })
  }
  const groups = [],
    stack = [],
    chars = [],
    outsideGlyphs = []
  let state = { ctm: [1, 0, 0, 1, 0, 0], font: undefined, size: 0 },
    group,
    text = false,
    matrix = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lineX = 0,
    lineY = 0,
    marked = 0
  const plain = new Set([
    OPS.dependency,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.setLineWidth,
    OPS.setLineJoin,
    OPS.setLineCap,
    OPS.setMiterLimit,
    OPS.setDash,
    OPS.clip,
    OPS.eoClip,
    OPS.setRenderingIntent
  ])
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) {
      if (text) return
      stack.push({ state: { ...state, ctm: [...state.ctm] }, op })
      if (op === OPS.beginGroup) {
        const g = a?.[0]
        if (
          group ||
          !g ||
          g.matrix !== null ||
          g.smask !== null ||
          g.knockout !== false ||
          typeof g.isolated !== 'boolean' ||
          !valid(g.bbox) ||
          !finite(state.ctm, 6) ||
          state.ctm[0] <= 0 ||
          state.ctm[3] <= 0 ||
          state.ctm[1] !== 0 ||
          state.ctm[2] !== 0 ||
          o.fnArray[i + 1] !== OPS.paintFormXObjectBegin
        )
          return
        const rect = box(g.bbox, Util.transform(v.transform, state.ctm))
        if (!valid(rect) || !inside([0, 0, page.width, page.height], rect)) return
        group = { begin: i, arg: g, rect, paint: [], records: [], forms: 0 }
        groups.push(group)
      } else if (op === OPS.paintFormXObjectBegin) {
        if (!group || ++group.forms !== 1 || !equal(a, [null, null])) return
      }
    } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      const previous = stack.pop(),
        begin =
          op === OPS.restore
            ? OPS.save
            : op === OPS.endGroup
              ? OPS.beginGroup
              : OPS.paintFormXObjectBegin
      if (text || !previous || previous.op !== begin) return
      if (op === OPS.endGroup) {
        if (
          !group ||
          !equal(a?.[0], group.arg) ||
          o.fnArray[i - 1] !== OPS.paintFormXObjectEnd ||
          marked
        )
          return
        group.end = i
        group = undefined
      }
      state = previous.state
    } else if (op === OPS.transform) {
      if (text || !finite(a, 6)) return
      state.ctm = Util.transform(state.ctm, a)
    } else if (op === OPS.beginText) {
      if (text) return
      text = true
      matrix = [1, 0, 0, 1, 0, 0]
      x = y = lineX = lineY = 0
    } else if (op === OPS.endText) {
      if (!text) return
      text = false
    } else if (op === OPS.setFont) {
      if (!text || typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.setTextMatrix) {
      const m = a?.length === 1 ? a[0] : a
      if (!text || !finite(m, 6)) return
      matrix = m
      x = y = lineX = lineY = 0
    } else if (op === OPS.moveText) {
      if (!text || !finite(a, 2)) return
      x = lineX += a[0]
      y = lineY += a[1]
    } else if (op === OPS.showText) {
      if (!text || !state.font || !(state.size > 0) || !Array.isArray(a?.[0])) return
      const m = Util.transform(v.transform, Util.transform(state.ctm, matrix))
      if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
      for (const glyph of a[0]) {
        if (typeof glyph === 'number') {
          if (!Number.isFinite(glyph)) return
          x -= (glyph * state.size) / 1000
          continue
        }
        if (
          typeof glyph?.unicode !== 'string' ||
          !Number.isFinite(glyph.width) ||
          glyph.width < 0 ||
          glyph.accent != null ||
          glyph.vmetric != null ||
          glyph.operatorListId != null
        )
          return
        const advance = box([x, y, x + (glyph.width * state.size) / 1000, y + state.size], m)
        if (groupCount === 1 && !group)
          outsideGlyphs.push({
            font: state.font,
            glyph,
            origin: [x, y],
            matrix: m,
            size: state.size
          })
        for (const c of letters(glyph.unicode))
          chars.push({
            c,
            group,
            font: state.font,
            advance,
            glyph,
            origin: [x, y],
            matrix: m,
            size: state.size
          })
        x += (glyph.width * state.size) / 1000
      }
    } else if (op === OPS.constructPath || op === OPS.paintImageXObject) {
      if (text || !group) return
      if (
        op === OPS.constructPath &&
        (![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0]) ||
          !(Array.isArray(a[1]?.[0]) || ArrayBuffer.isView(a[1]?.[0])) ||
          !a[1][0].length ||
          !a[1][0].every(Number.isFinite) ||
          !finite(a[2], 4))
      )
        return
      if (op === OPS.constructPath && a?.[0] === OPS.endPath) continue
      const g = paint.get(i)
      if (
        !g ||
        g.kind !== (op === OPS.constructPath ? 'path' : 'image') ||
        !inside(group.rect, g.rect)
      )
        return
      group.paint.push(g)
      paint.delete(i)
    } else if (op === OPS.beginMarkedContentProps) {
      if (!group || a?.[0] !== 'OC' || a[1]?.type !== 'OCG') return
      marked++
    } else if (op === OPS.endMarkedContent) {
      if (!marked) return
      marked--
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            !(
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (['ca', 'CA'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false)
            )
        )
      )
        return
    } else if (!plain.has(op)) return
  }
  if (text || stack.length || group || marked || paint.size || groups.length !== groupCount) return
  const records = [],
    recordIndices = new Set(),
    byIndex = new Map()
  for (const token of tokens) {
    const key = token.sourceItem?.index
    if (!Number.isInteger(key) || byIndex.has(key) || token.sourceSegment) return
    byIndex.set(key, token)
  }
  let offset = 0
  for (const [index, r] of raw.entries()) {
    if (typeof r.str !== 'string') return
    const cs = letters(r.str)
    if (!cs.length) continue
    const part = chars.slice(offset, offset + cs.length),
      source = r.sourceItem
    offset += cs.length
    if (
      source?.pageNumber !== page.pageNumber ||
      source.index !== index ||
      source.text !== r.str ||
      !finite(r.transform, 6) ||
      !(r.width > 0) ||
      !(r.height > 0) ||
      part.map((p) => p.c).join('') !== cs.join('') ||
      part.some((p) => p.font !== r.fontName || p.group !== part[0].group)
    )
      return
    const token = tableTextToken(r, viewport, 0),
      bounds = union(part.map((p) => p.advance)),
      supplied = byIndex.get(index)
    if (
      !valid(token.rect) ||
      bounds.some((n, i) => Math.abs(n - token.rect[i]) > 0.02) ||
      (supplied &&
        (supplied.text !== r.str ||
          supplied.sourceItem.text !== r.str ||
          supplied.sourceItem.pageNumber !== page.pageNumber ||
          !valid(supplied.rect) ||
          supplied.rect.some((n, i) => Math.abs(n - token.rect[i]) > 1e-6)))
    )
      return
    const record = {
      r,
      part,
      index,
      token,
      group: part[0].group,
      label: nativeFigureLabelBounds(r, context.content.styles?.[r.fontName], viewport)
    }
    if (record.group) {
      if (
        !supplied ||
        r.dir !== 'ltr' ||
        !valid(record.label) ||
        !inside(record.group.rect, token.rect) ||
        !inside(record.group.rect, record.label)
      )
        return
      record.group.records.push(record)
    }
    records.push(record)
    recordIndices.add(index)
  }
  if (offset !== chars.length || [...byIndex.keys()].some((index) => !recordIndices.has(index)))
    return
  if (groupCount !== 1) return { groups, records }
  // Group clipping owns internal ink. Every outside glyph, including spaces,
  // still needs its actual loaded outline to exclude adjacent text.
  if (!Array.isArray(context.glyphBounds)) return
  const fonts = new Map(),
    outsideInk = []
  for (const f of context.glyphBounds) {
    if (typeof f?.fontName !== 'string' || fonts.has(f.fontName) || !Array.isArray(f.glyphs)) return
    const bounds = new Map()
    for (const g of f.glyphs) {
      if (
        typeof g?.fontChar !== 'string' ||
        bounds.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      bounds.set(g.fontChar, g.bounds)
    }
    fonts.set(f.fontName, bounds)
  }
  for (const p of outsideGlyphs) {
    const b = fonts.get(p.font)?.get(p.glyph.fontChar)
    if (p.glyph.isInFont !== true || !finite(b, 4)) return
    const rect = box(
      [
        p.origin[0] + b[0] * p.size,
        p.origin[1] + b[1] * p.size,
        p.origin[0] + b[2] * p.size,
        p.origin[1] + b[3] * p.size
      ],
      p.matrix
    )
    if (intersection(rect, groups[0].rect) > 0) return
    outsideInk.push(rect)
  }
  return { groups, records, outsideInk }
}

// A group clip owns paint, but does not itself prove a text claim. Require the
// original whole horizontal font plus every loaded glyph's membership and ink.
// This optional proof never admits groups to the ordinary glyph inventory.
function nativeGroupLabelClaims(group, tokens, context) {
  const fonts = context.glyphBounds
  if (!Array.isArray(fonts)) return []
  const claims = []
  for (const record of group.records) {
    const token = tokens.find((t) => t.sourceItem?.index === record.index)
    if (
      !record.token.horizontal ||
      !/^\p{L}[\p{L}\p{N} -]{1,38}$/u.test(record.r.str) ||
      !proveNativeUniqueWholeFonts([token], tokens)
    )
      continue
    const matches = fonts.filter((f) => f.fontName === record.r.fontName)
    if (matches.length !== 1 || !Array.isArray(matches[0].glyphs)) continue
    const complete = record.part.every(({ glyph, origin: [x, y], matrix, size }) => {
      if (
        glyph.isInFont !== true ||
        typeof glyph.fontChar !== 'string' ||
        !glyph.fontChar ||
        glyph.accent != null ||
        glyph.vmetric != null ||
        glyph.operatorListId != null ||
        matrix[0] <= 0 ||
        matrix[3] >= 0 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0
      )
        return false
      const bounds = matches[0].glyphs.filter((g) => g.fontChar === glyph.fontChar)
      if (bounds.length !== 1 || !finite(bounds[0].bounds, 4)) return false
      const b = bounds[0].bounds
      if (b[0] > b[2] || b[1] > b[3]) return false
      return inside(
        group.rect,
        box([x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size], matrix)
      )
    })
    if (complete) claims.push({ ...record.r.sourceItem })
  }
  return claims
}

// Replace only a mixed strip that demonstrably borrowed an independently
// captioned peer. The whole renderer clip supplies every edge, including text
// outside path bounds; no threshold changes the ordinary strip matcher.
export function nativeDisjointMixedFigureGroup(page, figure, captions, tables, tokens, context) {
  if (
    figure?.reason !== 'native-raster-vector-strip' ||
    !valid(figure.rect) ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !tables.every(valid)
  )
    return
  const caps = captions.filter((c) => c.page === page.pageNumber)
  if (
    caps.length !== 2 ||
    !caps.includes(figure.caption) ||
    !caps.every((c) => valid(c.rect) && /^(?:figure|fig\.?)\s+\d+[.:]/i.test(c.lines?.[0] ?? ''))
  )
    return
  const program = disjointGroupProgram(page, tokens, context)
  if (!program) return
  const { groups, records } = program
  for (const g of groups) {
    const owners = caps.filter((c) => {
      const lead = records
        .filter(
          (r) =>
            !r.group &&
            r.token.horizontal &&
            inside(c.rect, r.token.rect) &&
            Math.abs(r.token.rect[1] - c.rect[1]) < 0.01
        )
        .sort((a, b) => a.token.rect[0] - b.token.rect[0])
      if (
        !lead.length ||
        lead.map((r) => letters(r.r.str).join('')).join('') !== letters(c.lines[0]).join('') ||
        Math.abs(lead[0].token.rect[0] - c.rect[0]) > 0.01 ||
        lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01)
      )
        return false
      const h = Math.max(...lead.map((r) => r.token.height))
      return (
        c.rect[2] - c.rect[0] <= page.width * 0.5 &&
        g.rect[2] - g.rect[0] >= h * 8 &&
        g.rect[3] - g.rect[1] >= h * 8 &&
        c.rect[1] > g.rect[3] &&
        c.rect[1] - g.rect[3] <= h * 3 &&
        Math.abs(g.rect[0] - c.rect[0]) <= h * 0.25 &&
        Math.abs(g.rect[2] - c.rect[2]) <= h * 0.25
      )
    })
    if (owners.length !== 1 || !g.records.length || !g.paint.length) return
    g.caption = owners[0]
  }
  const own = groups.find((g) => g.caption === figure.caption),
    other = groups.find((g) => g !== own)
  if (
    !own ||
    !other ||
    own.caption === other.caption ||
    intersection(own.rect, other.rect) > 0 ||
    !(own.rect[0] >= other.rect[2] || other.rect[0] >= own.rect[2]) ||
    Math.abs(own.rect[1] - other.rect[1]) > 1 ||
    own.paint.filter((g) => g.kind === 'image').length !== 1 ||
    own.paint.filter((g) => g.kind === 'path').length < 12 ||
    other.paint.some((g) => g.kind !== 'path') ||
    !other.paint.some((g) => intersection(g.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, own.rect) > 0) ||
    caps.some((c) => intersection(c.rect, own.rect) > 0) ||
    records.some((r) => r.group !== own && intersection(r.label ?? r.token.rect, own.rect) > 0) ||
    other.paint.some((g) => intersection(g.rect, own.rect) > 0)
  )
    return
  const sourceItems = figure.sourceItems?.length ? [] : nativeGroupLabelClaims(own, tokens, context)
  return {
    ...figure,
    rect: own.rect,
    graphicsCount: own.paint.length,
    ...(sourceItems.length ? { sourceItems, issue: 'native-disjoint-mixed-group' } : {})
  }
}

// Numeric ticks may be paths. Recover a complete independent clip only when
// the existing crop omits consecutive native panel keys; no tick/font matcher
// is relaxed, and this proof grants no text ownership or translation claims.
export function nativeSingleVectorFigureGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !/^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]/u.test(cap.lines?.[0] ?? '')
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    keys = g.records.filter((r) => /^\([a-h]\)$/u.test(r.r.str)),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    keys.length < 3 ||
    keys.length > 8 ||
    keys
      .map((r) => r.r.str[1])
      .sort()
      .join('') !== 'abcdefgh'.slice(0, keys.length) ||
    !lead.length ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    Math.abs(rect[2] - cap.rect[2]) > height * 0.25 ||
    !inside(rect, figure.rect) ||
    !keys.some((r) => !inside(figure.rect, r.label)) ||
    g.paint.length < 12 ||
    g.paint.some((q) => q.kind !== 'path') ||
    !g.paint.some((q) => intersection(q.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// Engineering keys can themselves be vector paths. Admit this separate case
// only through two whole native titles explicitly named by the complete caption.
// The existing plot-key gate and every scope/font exclusion remain unchanged.
export function nativeCaptionNamedDrawingGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption,
    names =
      /^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]\s+Drawings of \(a\) (.+) and \(b\) (.+)\. Dimensions are in mm\.$/u.exec(
        cap?.lines?.[0] ?? ''
      )
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    cap.lines.length !== 1 ||
    !names ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !Array.isArray(tables) ||
    !tables.every(valid)
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    canonical = (s) => s.normalize('NFD').replace(/\s+/gu, ' ').toLowerCase().trim(),
    titles = names
      .slice(1)
      .map((name) => g.records.filter((r) => canonical(r.r.str) === canonical(name))),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    !lead.length ||
    titles.some((rs) => rs.length !== 1) ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01)
  )
    return
  const [a, b] = titles.map((rs) => rs[0])
  if (
    a === b ||
    !a.token.horizontal ||
    !b.token.horizontal ||
    a.r.fontName !== b.r.fontName ||
    a.r.height !== b.r.height ||
    a.token.rect[3] >= b.token.rect[1] ||
    titles.some((rs) => rs[0].part.some((p) => p.glyph.isInFont !== true)) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    !inside(rect, figure.rect) ||
    !titles.some((rs) => !inside(figure.rect, rs[0].label)) ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    cap.rect[2] > rect[2] ||
    g.paint.length < 12 ||
    g.paint.some((p) => p.kind !== 'path') ||
    !g.paint.some((p) => intersection(p.rect, figure.rect) > 0) ||
    tables.some((t) => intersection(t, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// A paired engineering header is independent of caption name expansion. Both
// whole keys, their adjacent titles and dimensions must belong to one closed
// native group; this geometry proof grants no text or translation ownership.
export function nativePairedDrawingHeaderGroup(page, figure, captions, tables, tokens, context) {
  const cap = figure?.caption
  if (
    !valid(figure?.rect) ||
    !valid(cap?.rect) ||
    cap.page !== page.pageNumber ||
    cap.lines?.length !== 1 ||
    figure.reason ||
    figure.issue ||
    figure.sourceItems?.length ||
    !Array.isArray(captions) ||
    captions.filter((c) => c === cap).length !== 1 ||
    !Array.isArray(tables) ||
    !tables.every(valid) ||
    !/^(?:Figure\s+\d+|Fig\.?\s+[A-Z]?\d+)[.:]\s+Drawings of \(a\) .+ and \(b\) .+\. Dimensions are in mm\.$/u.test(
      cap.lines[0]
    )
  )
    return
  const p = disjointGroupProgram(page, tokens, context, 1)
  if (!p) return
  const g = p.groups[0],
    rect = g.rect,
    keys = g.records
      .filter((r) => /^\([a-h]\)$/u.test(r.r.str))
      .sort((a, b) => a.token.rect[1] - b.token.rect[1]),
    lead = p.records
      .filter(
        (r) =>
          !r.group &&
          r.token.horizontal &&
          inside(cap.rect, r.token.rect) &&
          Math.abs(r.token.rect[1] - cap.rect[1]) < 0.01
      )
      .sort((a, b) => a.token.rect[0] - b.token.rect[0]),
    height = Math.max(...lead.map((r) => r.token.height))
  if (
    keys.length !== 2 ||
    keys.map((r) => r.r.str).join('') !== '(a)(b)' ||
    !lead.length ||
    lead.map((r) => letters(r.r.str).join('')).join('') !== letters(cap.lines[0]).join('') ||
    Math.abs(lead[0].token.rect[0] - cap.rect[0]) > 0.01 ||
    Math.abs(Math.max(...lead.map((r) => r.token.rect[2])) - cap.rect[2]) > 0.01 ||
    lead.some((r, i) => i > 0 && r.token.rect[0] < lead[i - 1].token.rect[2] - 0.01) ||
    !(height > 0) ||
    rect[2] - rect[0] < height * 8 ||
    rect[3] - rect[1] < height * 8 ||
    !inside(rect, figure.rect) ||
    !keys.some((r) => !inside(figure.rect, r.label)) ||
    cap.rect[1] <= rect[3] ||
    cap.rect[1] - rect[3] > height * 3 ||
    Math.abs(rect[0] - cap.rect[0]) > height * 0.25 ||
    cap.rect[2] > rect[2] ||
    g.paint.length < 12 ||
    g.paint.some((q) => q.kind !== 'path') ||
    !g.paint.some((q) => intersection(q.rect, figure.rect) > 0) ||
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some(
      (c) => c.page === page.pageNumber && valid(c.rect) && intersection(c.rect, rect) > 0
    )
  )
    return
  const rows = keys.map((key) => ({
    key,
    headers: g.records.filter(
      (r) =>
        r !== key &&
        r.token.horizontal &&
        /^\p{L}[\p{L}\p{N} -]{1,38}$/u.test(r.r.str) &&
        r.r.fontName === key.r.fontName &&
        r.token.rect[0] >= key.token.rect[2] &&
        r.token.rect[0] - key.token.rect[2] <= key.token.height &&
        Math.min(r.token.rect[3], key.token.rect[3]) -
          Math.max(r.token.rect[1], key.token.rect[1]) >=
          Math.min(r.token.height, key.token.height) * 0.75
    )
  }))
  if (
    rows.some((r) => r.headers.length !== 1) ||
    keys[0].r.fontName !== keys[1].r.fontName ||
    Math.abs(keys[0].token.rect[0] - keys[1].token.rect[0]) >
      Math.min(...keys.map((r) => r.token.height)) * 0.25 ||
    rows[0].headers[0] === rows[1].headers[0] ||
    rows[0].headers[0].r.height !== rows[1].headers[0].r.height ||
    keys[0].token.rect[3] >= keys[1].token.rect[1]
  )
    return
  const complete = (record) => {
    const token = tokens.find((t) => t.sourceItem?.index === record.index)
    if (!record.token.horizontal || !proveNativeUniqueWholeFonts([token], tokens)) return false
    return record.part.every(({ glyph, origin: [x, y], matrix, size, font }) => {
      const matches = context.glyphBounds.filter((f) => f.fontName === font),
        bounds =
          matches.length === 1 ? matches[0].glyphs.filter((b) => b.fontChar === glyph.fontChar) : []
      if (
        glyph.isInFont !== true ||
        glyph.accent != null ||
        glyph.vmetric != null ||
        glyph.operatorListId != null ||
        bounds.length !== 1 ||
        !finite(bounds[0].bounds, 4) ||
        bounds[0].bounds[0] > bounds[0].bounds[2] ||
        bounds[0].bounds[1] > bounds[0].bounds[3]
      )
        return false
      const b = bounds[0].bounds
      return inside(
        rect,
        box([x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size], matrix)
      )
    })
  }
  if (
    rows.some((row) => !complete(row.key) || !complete(row.headers[0])) ||
    rows.some(
      ({ key }, n) =>
        g.records.filter(
          (r) =>
            /^(?:\d+(?:\.\d+)?|\(\d+(?:\.\d+)?\))$/u.test(r.r.str) &&
            r.token.rect[1] > key.token.rect[3] &&
            r.token.rect[3] < (keys[n + 1]?.token.rect[1] ?? rect[3]) &&
            complete(r)
        ).length < 3
    )
  )
    return
  return {
    ...figure,
    rect,
    graphicsCount: g.paint.length,
    reason: 'native-single-vector-group',
    groupRasterProof: {
      bounds: { width: page.width, height: page.height },
      outsideInk: p.outsideInk
    }
  }
}

// The public renderer can retry at a smaller scale. Use the actual PNG's
// conservative scale interval and halo before publishing any image.
export function nativeSingleVectorGroupPng(png, candidate) {
  const proof = candidate?.groupRasterProof,
    raster = getPdfCropRasterProtectionFromPng(png, candidate?.rect, proof?.bounds)
  return (
    !!raster &&
    Array.isArray(proof.outsideInk) &&
    proof.outsideInk.every((r) => finite(r, 4) && intersection(r, raster.protection) === 0)
  )
}
