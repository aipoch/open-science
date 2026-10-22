/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { intersection, lineRect, union } from './literature-pdf-page-geometry.mjs'

// An opaque note painted over a connected diagram is part of that diagram,
// not an intervening paragraph. This proof only removes barriers; callers keep
// the original text, graphics and source eligibility unchanged.
export function nativeOverlayDiagramLines(page, captions, tables, tokens, context) {
  // Untrusted native inventories are evidence, never permission to bypass a
  // paragraph barrier. Malformed operator payloads must conservatively abstain.
  try {
    return proveOverlayLines(page, captions, tables, tokens, context)
  } catch {
    return new Set()
  }
}

function proveOverlayLines(page, captions, tables, tokens, context) {
  const result = new Set(),
    o = context?.operators,
    v = context?.viewport
  const items = context?.content?.items
  if (
    !o ||
    !v ||
    !Array.isArray(items) ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    v.rotation !== 0 ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i]) ||
    typeof v.convertToViewportPoint !== 'function' ||
    !Array.isArray(o.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    !Array.isArray(tokens) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(captions) ||
    !Array.isArray(tables)
  )
    return result
  // The shared observer tracks geometry, clips and alpha. Reject any state it
  // cannot prove, including patterns, transparency groups and blend modes.
  const allowed = new Set(
    [
      'save',
      'restore',
      'transform',
      'paintFormXObjectBegin',
      'paintFormXObjectEnd',
      'constructPath',
      'clip',
      'eoClip',
      'setLineWidth',
      'setLineCap',
      'setLineJoin',
      'setMiterLimit',
      'setDash',
      'setFillRGBColor',
      'setStrokeRGBColor',
      'setFillGray',
      'setStrokeGray',
      'setFillCMYKColor',
      'setStrokeCMYKColor',
      'beginText',
      'endText',
      'dependency',
      'setFont',
      'moveText',
      'setTextMatrix',
      'setLeading',
      'setCharSpacing',
      'setWordSpacing',
      'setHScale',
      'setTextRise',
      'setTextRenderingMode',
      'nextLine',
      'showText',
      'setGState'
    ]
      .map((k) => OPS[k])
      .filter(Number.isFinite)
  )
  let depth = 0
  const finiteArray = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (!allowed.has(op)) return result
    if (a !== null && !Array.isArray(a)) return result
    if (
      [OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) &&
      (a?.length !== 1 || typeof a[0] !== 'string' || !/^#[\da-f]{6}$/i.test(a[0]))
    )
      return result
    if (
      [OPS.setFillGray, OPS.setStrokeGray].includes(op) &&
      (!finiteArray(a, 1) || a[0] < 0 || a[0] > 1)
    )
      return result
    if (
      [OPS.setFillCMYKColor, OPS.setStrokeCMYKColor].includes(op) &&
      (!finiteArray(a, 4) || a.some((n) => n < 0 || n > 1))
    )
      return result
    if (
      op === OPS.setFont &&
      (a?.length !== 2 || typeof a[0] !== 'string' || !Number.isFinite(a[1]) || a[1] === 0)
    )
      return result
    if (
      op === OPS.showText &&
      (!Array.isArray(a?.[0]) ||
        a[0].some((g) =>
          typeof g === 'number'
            ? !Number.isFinite(g)
            : !g || typeof g.unicode !== 'string' || !Number.isFinite(g.width)
        ))
    )
      return result
    if ([OPS.transform, OPS.setTextMatrix].includes(op) && !finiteArray(a, 6)) return result
    if (
      op === OPS.paintFormXObjectBegin &&
      (!Array.isArray(a) ||
        (a[0] != null && !finiteArray(a[0], 6)) ||
        (a[1] != null && !finiteArray(a[1], 4)))
    )
      return result
    if (
      [
        OPS.setLineWidth,
        OPS.setLineCap,
        OPS.setLineJoin,
        OPS.setMiterLimit,
        OPS.setLeading,
        OPS.setCharSpacing,
        OPS.setWordSpacing,
        OPS.setHScale,
        OPS.setTextRise,
        OPS.setTextRenderingMode
      ].includes(op) &&
      !finiteArray(a, 1)
    )
      return result
    if (op === OPS.moveText && !finiteArray(a, 2)) return result
    if (op === OPS.constructPath) {
      if (!Array.isArray(a?.[1]) || a[1].length !== 1) return result
      const p = a[1][0]
      if (a[0] === OPS.endPath && p === null && a[2] === null) continue
      if (!Array.isArray(p) && !ArrayBuffer.isView(p)) return result
      for (let j = 0; j < p.length;) {
        const command = p[j++],
          count = command === 0 || command === 1 ? 2 : command === 2 ? 6 : command === 4 ? 0 : -1
        if (count < 0 || j + count > p.length) return result
        for (let n = 0; n < count; n++) if (!Number.isFinite(p[j++])) return result
      }
    }
    if (
      op === OPS.setDash &&
      (!Array.isArray(a?.[0]) ||
        a[0].some((n) => !Number.isFinite(n) || n < 0) ||
        !Number.isFinite(a[1]))
    )
      return result
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) depth++
    if ((op === OPS.restore || op === OPS.paintFormXObjectEnd) && --depth < 0) return result
    if (op === OPS.setTextRenderingMode && a?.[0] !== 0) return result
    if (
      op === OPS.setGState &&
      (!Array.isArray(a?.[0]) ||
        a[0].some(
          ([k, n]) =>
            !['LW', 'LC', 'LJ', 'ML', 'D', 'CA', 'ca', 'BM', 'SMask'].includes(k) ||
            (k === 'BM' && n !== 'Normal') ||
            (k === 'SMask' && n !== 'None') ||
            (['LW', 'LC', 'LJ', 'ML', 'CA', 'ca'].includes(k) && !Number.isFinite(n)) ||
            (k === 'D' &&
              (!Array.isArray(n?.[0]) ||
                n[0].some((v) => !Number.isFinite(v) || v < 0) ||
                !Number.isFinite(n[1])))
        ))
    )
      return result
  }
  if (depth !== 0) return result
  const paint = { frames: new Map(), paths: new Map(), images: [], texts: new Map() }
  collectClosedFigureFrames(o, v, paint)
  const contains = (a, b, t = 0) =>
    Array.isArray(a) &&
    b.every((n, i) => Number.isFinite(n) && (i < 2 ? n >= a[i] - t : n <= a[i] + t))
  const original = new Map(),
    validRect = (r) => finiteArray(r, 4) && r[0] < r[2] && r[1] < r[3]
  const aliases = (t) => t.sourceSegment || t.sourceToken || t.sourceItems || t.sourceSegments
  if (tokens.some((t) => aliases(t) || !t.sourceItem || !validRect(t.rect)) || items.some(aliases))
    return result
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.str?.trim()) continue
    const source = item.sourceItem
    if (
      !source ||
      Object.keys(source).some((k) => !['pageNumber', 'index', 'text'].includes(k)) ||
      source.pageNumber !== page.pageNumber ||
      source.index !== i ||
      source.text !== item.str
    )
      return result
    const matches = tokens.filter(
      (t) => t.sourceItem?.pageNumber === source.pageNumber && t.sourceItem.index === i
    )
    if (
      matches.length !== 1 ||
      matches[0].text !== item.str ||
      Object.keys(matches[0].sourceItem).some((k) => !['pageNumber', 'index', 'text'].includes(k))
    )
      return result
    const native = tableTextToken(item, v, 0),
      token = matches[0]
    if (
      !native ||
      !validRect(native.rect) ||
      native.rect.some((n, j) => Math.abs(n - token.rect[j]) > 1e-5)
    )
      return result
    original.set(i, token)
  }
  if (tokens.length !== original.size) return result
  const nativeTokens = [...original.values()],
    frames = [...paint.frames].map(([index, rect]) => ({ index, rect }))
  const node = (f) => nativeTokens.some((t) => contains(f.rect, t.rect))
  const strokes = [],
    heads = []
  const epsilon = Math.max(page.width, page.height) * 2 ** -23
  const touchesNode = (rect, point, radius) => {
    // The central straight portion is outside even the largest valid rounded
    // corner. A bounding-box corner alone cannot prove painted attachment.
    const inset = Math.min(rect[2] - rect[0], rect[3] - rect[1]) / 2
    return (
      (point[0] >= rect[0] + inset &&
        point[0] <= rect[2] - inset &&
        [rect[1], rect[3]].some((y) => Math.abs(point[1] - y) <= radius + epsilon)) ||
      (point[1] >= rect[1] + inset &&
        point[1] <= rect[3] - inset &&
        [rect[0], rect[2]].some((x) => Math.abs(point[0] - x) <= radius + epsilon))
    )
  }
  for (const [index, state] of paint.paths) {
    const a = o.argsArray[index],
      p = a?.[1]?.length === 1 ? a[1][0] : undefined
    if (
      a?.[0] !== OPS.fill ||
      state.fillAlpha !== 1 ||
      p?.length !== 12 ||
      p[0] !== 0 ||
      ![3, 6, 9].every((i) => p[i] === 1)
    )
      continue
    const matrix = Util.transform(v.transform, state.transform),
      points = [0, 3, 6, 9].map((i) => [p[i + 1], p[i + 2]])
    if (!matrix.every(Number.isFinite)) continue
    for (const point of points) Util.applyTransform(point, matrix)
    if (points.every((p) => contains(state.clip, [...p, ...p]))) heads.push({ index, points })
  }
  for (const [index, state] of paint.paths) {
    const a = o.argsArray[index],
      p = a?.[1]?.length === 1 ? a[1][0] : undefined
    if (
      a?.[0] !== OPS.stroke ||
      p?.length !== 6 ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      !state.solidStroke ||
      state.strokeAlpha !== 1 ||
      !(state.lineWidth > 0)
    )
      continue
    const matrix = Util.transform(v.transform, state.transform)
    if (
      !matrix.every(Number.isFinite) ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      Math.abs(matrix[0]) !== Math.abs(matrix[3])
    )
      continue
    const points = [
      [p[1], p[2]],
      [p[4], p[5]]
    ]
    for (const point of points) Util.applyTransform(point, matrix)
    const bounds = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    const radius = (state.lineWidth * Math.abs(matrix[0])) / 2
    if (
      !contains(
        state.clip,
        bounds.map((n, i) => n + (i < 2 ? -radius : radius))
      )
    )
      continue
    strokes.push({ index, points, radius })
  }
  for (const cover of frames) {
    const state = paint.paths.get(cover.index),
      mode = o.argsArray[cover.index]?.[0]
    if (
      !state ||
      ![OPS.fillStroke, OPS.closeFillStroke].includes(mode) ||
      state.fillAlpha !== 1 ||
      state.strokeAlpha !== 1 ||
      !contains(state.clip, cover.rect)
    )
      continue
    const hidden = frames.filter(
      (f) => f.index < cover.index && contains(cover.rect, f.rect) && node(f)
    )
    if (
      hidden.length < 3 ||
      hidden.some((f, i) => hidden.some((g, j) => i !== j && intersection(f.rect, g.rect) > 0))
    )
      continue
    const external = frames.filter(
      (f) => f.index < cover.index && intersection(f.rect, cover.rect) === 0 && node(f)
    )
    const links = []
    for (const stroke of strokes.filter((s) => s.index < cover.index)) {
      const inside = stroke.points.map((p) => contains(cover.rect, [...p, ...p]))
      if (inside.filter(Boolean).length !== 1) continue
      const point = stroke.points[inside[0] ? 1 : 0]
      // Native path coordinates may be Float32; this is coordinate roundoff,
      // not an attachment distance beyond the actual painted half-linewidth.
      const interior = stroke.points[inside[0] ? 0 : 1]
      const endpoints = (point, other) => {
        const dx = point[0] - other[0],
          dy = point[1] - other[1],
          length = Math.hypot(dx, dy)
        const attached = heads
          .filter(
            (h) =>
              h.index > stroke.index &&
              h.index < cover.index &&
              Math.hypot(h.points[2][0] - point[0], h.points[2][1] - point[1]) <= epsilon
          )
          .filter((h) => {
            const [tip, a, , b] = h.points,
              along = (p) => ((p[0] - point[0]) * dx + (p[1] - point[1]) * dy) / length,
              across = (p) => ((p[0] - point[0]) * dy - (p[1] - point[1]) * dx) / length
            return (
              Math.abs(across(tip)) <= epsilon &&
              along(tip) > 0 &&
              along(tip) < length / 2 &&
              along(a) < along(tip) &&
              along(b) < along(tip) &&
              across(a) * across(b) < 0
            )
          })
        return [point, ...(attached.length === 1 ? [attached[0].points[0]] : [])]
      }
      const innerEnds = endpoints(interior, point)
      if (
        hidden.filter((f) => innerEnds.some((p) => touchesNode(f.rect, p, stroke.radius)))
          .length !== 1
      )
        continue
      const ends = endpoints(point, interior)
      const owners = external.filter((f) => ends.some((p) => touchesNode(f.rect, p, stroke.radius)))
      if (owners.length !== 1) continue
      const owner = owners[0],
        side =
          owner.rect[3] < cover.rect[1]
            ? 'top'
            : owner.rect[1] > cover.rect[3]
              ? 'bottom'
              : owner.rect[2] < cover.rect[0]
                ? 'left'
                : owner.rect[0] > cover.rect[2]
                  ? 'right'
                  : undefined
      const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= epsilon
      if (
        side &&
        !links.some((l) =>
          [l.stroke.points, [...l.stroke.points].reverse()].some((p) =>
            p.every((p, i) => same(p, stroke.points[i]))
          )
        )
      )
        links.push({ stroke, owner, side, startsInside: inside[0] })
    }
    const opposing = [
      ['top', 'bottom'],
      ['left', 'right']
    ].find((pair) =>
      pair.every((side) => {
        const group = links.filter((l) => l.side === side)
        return (
          group.length >= 2 &&
          new Set(group.map((l) => l.owner.index)).size === 1 &&
          group.some((l) => l.startsInside) &&
          group.some((l) => !l.startsInside)
        )
      })
    )
    if (!opposing) continue
    const extent = union([cover.rect, ...links.map((l) => l.owner.rect)])
    if (
      captions.some((c) => intersection(c.rect, extent) > 0) ||
      tables.some((t) => intersection(t, extent) > 0)
    )
      continue
    // Only the existing paragraph-barrier candidates are waived. Short node
    // and connector labels may graze the border, and remain untouched.
    const lines = page.lines.filter(
      (l) => l.text.length > 60 && intersection(lineRect(l), cover.rect) > 0
    )
    if (!lines.length || lines.some((l) => !contains(cover.rect, lineRect(l)))) continue
    const completeLine = (line) => {
      const rect = lineRect(line),
        expected = line.text.replace(/\s/g, '')
      const row = nativeTokens.filter(
        (t) =>
          contains(cover.rect, t.rect) &&
          (t.rect[1] + t.rect[3]) / 2 >= rect[1] &&
          (t.rect[1] + t.rect[3]) / 2 <= rect[3] &&
          t.rect[0] >= rect[0] - 1e-5 &&
          t.rect[2] <= rect[2] + 1e-5
      )
      let matches = 0
      for (let i = 0; i < row.length; i++) {
        let text = ''
        for (let j = i; j < row.length; j++) {
          text += row[j].text.replace(/\s/g, '')
          if (text === expected) matches++
          if (!expected.startsWith(text)) break
        }
      }
      return expected.length > 0 && matches === 1
    }
    if (lines.some((l) => !completeLine(l))) continue
    for (const line of lines) result.add(line)
  }
  return result
}
