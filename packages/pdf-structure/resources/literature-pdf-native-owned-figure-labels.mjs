/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

// The same proved margin exclusion must reach face association and completion.
// Otherwise a later label pass can reattach the printed page number. An explicit
// PDF page label can witness offset numbering; never infer an offset or fall back
// to the physical number against that label.
export function nativeFigureMarginPageNumber(page, tokens, captions, tables) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    !Number.isSafeInteger(page?.pageNumber) ||
    page.pageNumber < 1 ||
    ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    ![tokens, captions, tables, page.lines, page.graphicsBounds].every(Array.isArray) ||
    !page.graphicsBounds.length ||
    tokens.some((t) => !t || typeof t.text !== 'string' || (t.text.trim() && !valid(t.rect)))
  )
    return
  const pageLabel = page.pageLabel === undefined ? String(page.pageNumber) : page.pageLabel
  if (
    typeof pageLabel !== 'string' ||
    !/^[1-9]\d*$/.test(pageLabel) ||
    !Number.isSafeInteger(Number(pageLabel))
  )
    return
  const candidates = tokens.filter(
    (t) =>
      t.text === pageLabel &&
      t.sourceItem?.index === 0 &&
      t.sourceItem.pageNumber === page.pageNumber &&
      t.horizontal === true &&
      Number.isFinite(t.height) &&
      t.height > 0 &&
      Math.abs(t.rect[3] - t.rect[1] - t.height) < 1e-6 &&
      Math.abs(t.rect[3] - t.baseline) < 1e-6 &&
      t.rect[1] > 0 &&
      t.rect[1] < page.height * 0.07 &&
      (t.rect[2] < page.width * 0.15 || t.rect[0] > page.width * 0.85)
  )
  if (candidates.length !== 1 || !proveNativeUniqueWholeFonts(candidates, tokens)) return
  const token = candidates[0],
    bottom = token.rect[3] + token.height * 0.5
  if (
    tokens.some((t) => t !== token && t.text.trim() && t.rect[1] <= bottom) ||
    page.graphicsBounds.some(
      (g) =>
        !['path', 'image'].includes(g.kind) ||
        !valid(g.normalizedRect) ||
        g.normalizedRect.some((n) => n < 0 || n > 1) ||
        g.normalizedRect[1] * page.height <= bottom
    ) ||
    captions.some((c) => c.page === page.pageNumber && (!valid(c.rect) || c.rect[1] <= bottom)) ||
    tables.some((r) => !valid(r) || r[1] <= bottom)
  )
    return
  const lines = page.lines.filter(
    (line) =>
      line.text === token.text && lineRect(line).every((v, n) => Math.abs(v - token.rect[n]) < 1e-6)
  )
  if (
    lines.length !== 1 ||
    page.lines.some(
      (line) =>
        line !== lines[0] && line.text?.trim() && (!valid(lineRect(line)) || line.y <= bottom)
    )
  )
    return
  return { line: lines[0], token }
}
// Complete a resolved raster grid's column headings only when every raster
// belongs to the same repeated columns and each key has one original source.
// Raster ownership stays unchanged. Only a complete native boxed-legend proof
// also supplies whole-item provenance; keyed headings remain crop-only.
export function nativeOwnedRasterColumnHeadings(
  page,
  figure,
  captions,
  tables,
  tokens,
  foreignOwns,
  operatorContext
) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-6 : v <= a[n] + 1e-6))
  if (
    figure?.reason !== 'native-raster-composite-grid' ||
    page?.invalidGraphicsBounds !== 0 ||
    !Number.isSafeInteger(page.pageNumber) ||
    ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
    ![captions, tables, tokens, page.graphicsBounds].every(Array.isArray) ||
    typeof foreignOwns !== 'function'
  )
    return
  const rect = figure.rect,
    caption = figure.caption
  if (
    !valid(rect) ||
    !valid(caption?.rect) ||
    caption.page !== page.pageNumber ||
    captions.filter((c) => c === caption).length !== 1 ||
    !caption.lines?.length ||
    caption.lines.some((s) => typeof s !== 'string' || !s.trim()) ||
    captions.some((c) => !valid(c.rect)) ||
    tables.some((r) => !valid(r)) ||
    !inside([0, 0, page.width, page.height], rect)
  )
    return
  if (tokens.some((t) => !t || typeof t.text !== 'string' || (t.text.trim() && !valid(t.rect))))
    return
  const uniqueSource = (t) => {
    const source = t.sourceItem
    if (
      t.sourceSegment != null ||
      t.sourceToken != null ||
      source?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(source.index) ||
      source.index < 0 ||
      source.text !== t.text
    )
      return false
    // Count all original source carriers across tokens, including rotated aliases
    // and partial ranges outside this band; geometry cannot establish identity.
    return (
      tokens
        .flatMap((other) => [
          other.sourceItem,
          other.sourceSegment,
          other.sourceToken,
          other.sourceToken?.sourceItem,
          other.sourceToken?.sourceSegment
        ])
        .filter((s) => s?.pageNumber === source.pageNumber && s.index === source.index).length === 1
    )
  }
  const captionTokens = tokens.filter((t) => t.text.trim() && inside(caption.rect, t.rect))
  if (
    !captionTokens.length ||
    captionTokens.some((t) => !uniqueSource(t)) ||
    captionTokens
      .map((t) => t.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '')
  )
    return
  const em = Math.max(...captionTokens.map((t) => t.height))
  if (
    !(em > 0) ||
    !Number.isFinite(em) ||
    caption.rect[1] < rect[3] ||
    caption.rect[1] - rect[3] > em * 5
  )
    return
  const operationIds = new Set(),
    images = [],
    paths = []
  for (const g of page.graphicsBounds) {
    if (g?.kind === 'path' && operatorContext) {
      paths.push(g)
      continue
    }
    if (
      g?.kind !== 'image' ||
      !Number.isSafeInteger(g.operationIndex) ||
      g.operationIndex < 0 ||
      operationIds.has(g.operationIndex) ||
      !valid(g.normalizedRect) ||
      !valid(g.paintedNormalizedRect) ||
      !inside([0, 0, 1, 1], g.normalizedRect) ||
      !inside(g.normalizedRect, g.paintedNormalizedRect)
    )
      return
    operationIds.add(g.operationIndex)
    const r = g.paintedNormalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
    if (!inside(rect, r) || r[2] - r[0] < em * 4 || r[3] - r[1] < em * 4) return
    images.push(r)
  }
  const columns = []
  for (const r of images.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const matches = columns.filter(
      (c) => Math.abs(c[0][0] - r[0]) <= em && Math.abs(c[0][2] - r[2]) <= em
    )
    if (matches.length > 1) return
    if (matches.length) matches[0].push(r)
    else columns.push([r])
  }
  if (columns.length < 2 || columns.length > 6 || columns[0].length < 2) return
  for (const [i, col] of columns.entries()) {
    col.sort((a, b) => a[1] - b[1])
    if (col.length !== columns[0].length || (i && col[0][0] <= columns[i - 1][0][2])) return
    for (const [row, r] of col.entries()) {
      if (
        Math.abs(r[1] - columns[0][row][1]) > em ||
        Math.abs(r[3] - columns[0][row][3]) > em ||
        (row && r[1] <= col[row - 1][3])
      )
        return
    }
  }
  const labels = tokens
    .filter(
      (t) =>
        t.text.trim() &&
        t.rect[1] < rect[1] &&
        t.rect[3] <= rect[1] &&
        rect[1] - t.rect[3] <= em * 2 &&
        t.rect[0] >= rect[0] &&
        t.rect[2] <= rect[2]
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (labels.length !== columns.length) return
  // The expensive native program proof runs only after the repeated raster
  // rows and every column heading have been established. Arbitrary paths
  // still refuse ownership unless one complete boxed legend accounts for all.
  const legend = paths.length
    ? strictRasterLegendWitness(page, figure, tokens, labels, paths, operatorContext)
    : undefined
  if (paths.length && !legend) return
  const captionText = caption.lines.join(' ')
  for (const [i, t] of labels.entries()) {
    const key = String.fromCharCode(97 + i),
      title = t.text.match(/^\(([a-z])\)\s+\p{L}[^.!?]*$/u),
      col = columns[i][0]
    if (
      (!legend && (!title || title[1] !== key)) ||
      !uniqueSource(t) ||
      t.horizontal !== true ||
      ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
      t.height <= 0 ||
      t.fontDescent > 0 ||
      t.fontDescent < -0.5 ||
      Math.abs(t.height - em) > em * 0.05 ||
      Math.abs(t.rect[3] - t.baseline) > 1e-6 ||
      Math.abs(t.rect[3] - t.rect[1] - t.height) > 1e-6 ||
      Math.abs(t.baseline - labels[0].baseline) > em * 0.1 ||
      t.rect[0] < col[0] ||
      t.rect[2] > col[2] ||
      Math.abs((t.rect[0] + t.rect[2] - col[0] - col[2]) / 2) > em ||
      (!legend && !new RegExp(`\\(${key}\\)|\\bcolumn\\s+${key}\\b`, 'i').test(captionText))
    )
      return
  }
  const boxes = labels.map((t) => [
    t.rect[0],
    t.rect[1],
    t.rect[2],
    t.baseline - t.fontDescent * t.height
  ])
  if (legend) boxes.push(legend.background)
  const extension = [
    Math.min(rect[0], ...boxes.map((r) => r[0])),
    Math.min(...boxes.map((r) => r[1])),
    Math.max(rect[2], ...boxes.map((r) => r[2])),
    rect[1]
  ]
  if (
    extension[1] < 0 ||
    boxes.some((r) => r[3] > rect[1]) ||
    foreignOwns(extension) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, extension) > 0) ||
    tables.some((r) => intersection(r, extension) > 0) ||
    tokens.some(
      (t) =>
        t.text.trim() &&
        !labels.includes(t) &&
        !legend?.labels.includes(t) &&
        intersection(t.rect, extension) > 0
    )
  )
    return
  if (!legend) return { rects: boxes }
  const packet = [...labels, ...legend.labels]
  if (!packet.every(uniqueSource)) return
  const sourceItems = packet
    .map(({ sourceItem: { pageNumber, index, text } }) => ({ pageNumber, index, text }))
    .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
  return { rects: boxes, sourceItems }
}

// A shared native legend supplies independent evidence for unkeyed column
// headings. Its complete perimeter, one-to-one swatches, original text fonts
// and glyph positions must agree; proximity or a common Form is insufficient.
function strictRasterLegendWitness(page, figure, tokens, headings, paths, context) {
  const o = context?.operators,
    v = context?.viewport,
    content = context?.content
  const nums = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) &&
    a.length === n &&
    Array.from(a).every(Number.isFinite)
  const inside = (a, b) => b.every((x, n) => (n < 2 ? x >= a[n] - 1e-6 : x <= a[n] + 1e-6))
  const matrix = (a) => nums(a, 6) && a[0] > 0 && a[3] > 0 && a[1] === 0 && a[2] === 0
  if (
    version !== '5.4.624' ||
    page.rotation !== 0 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 20000 ||
    !Array.isArray(content?.items) ||
    !content.styles ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !nums(v.transform, 6) ||
    v.transform.some((x, n) => x !== [1, 0, 0, -1, 0, page.height][n])
  )
    return
  const allowed = new Set(
    [
      'save',
      'restore',
      'transform',
      'paintFormXObjectBegin',
      'paintFormXObjectEnd',
      'setLineWidth',
      'setLineCap',
      'setLineJoin',
      'setMiterLimit',
      'setDash',
      'clip',
      'constructPath',
      'setGState',
      'setFillRGBColor',
      'setStrokeRGBColor',
      'dependency',
      'paintImageXObject',
      'beginText',
      'endText',
      'setFont',
      'moveText',
      'setTextMatrix',
      'showText'
    ].map((k) => OPS[k])
  )
  const painted = new Set(),
    imageOps = new Set(),
    rawTexts = [],
    colors = new Map(),
    stack = []
  let leadingBackground
  let state = { font: undefined, size: 0, fill: undefined, alpha: 1 },
    text = false,
    pendingClip = false,
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (!allowed.has(op)) return
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (text) return
      if (op === OPS.save && a != null && (!Array.isArray(a) || a.length)) return
      if (
        op === OPS.paintFormXObjectBegin &&
        (!Array.isArray(a) ||
          a.length !== 2 ||
          (a[0] != null && !matrix(a[0])) ||
          !nums(a[1], 4) ||
          a[1][0] >= a[1][2] ||
          a[1][1] >= a[1][3])
      )
        return
      stack.push({ state: { ...state }, form: op === OPS.paintFormXObjectBegin })
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const saved = stack.pop()
      if (
        text ||
        pendingClip ||
        !saved ||
        saved.form !== (op === OPS.paintFormXObjectEnd) ||
        (a != null && (!Array.isArray(a) || a.length))
      )
        return
      state = saved.state
    } else if (op === OPS.transform) {
      if (text || !matrix(a)) return
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        !a[0].every(
          (e) =>
            Array.isArray(e) &&
            e.length === 2 &&
            ['CA', 'ca'].includes(e[0]) &&
            Number.isFinite(e[1]) &&
            e[1] >= 0 &&
            e[1] <= 1
        )
      )
        return
      for (const [key, value] of a[0]) if (key === 'ca') state.alpha = value
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/i.test(a[0])
      )
        return
      if (op === OPS.setFillRGBColor) state.fill = a[0]
    } else if (op === OPS.constructPath) {
      if (text || !Array.isArray(a) || a.length !== 3 || a[1]?.length !== 1 || !nums(a[2], 4))
        return
      const p = a[1][0]
      if (
        !p ||
        !Number.isInteger(p.length) ||
        p.length > 20000 ||
        !Array.from(p).every(Number.isFinite)
      )
        return
      let current = false
      for (let n = 0; n < p.length;) {
        const c = p[n++],
          count = c === 0 || c === 1 ? 2 : c === 2 ? 6 : c === 4 ? 0 : -1
        if (count < 0 || n + count > p.length || (c !== 0 && !current)) return
        if (c === 0) current = true
        n += count
      }
      if (pendingClip) {
        if (
          a[0] !== OPS.endPath ||
          p.length !== 13 ||
          p[0] !== 0 ||
          p[12] !== 4 ||
          ![3, 6, 9].every((n) => p[n] === 1)
        )
          return
        pendingClip = false
      }
      if (a[0] === OPS.fill) {
        // A single initial opaque white rectangle may back the complete
        // native plate. It must cover its exact clip and precede all content;
        // later fills cannot erase unknown marks or supply ownership.
        if (
          leadingBackground !== undefined ||
          painted.size ||
          imageOps.size ||
          rawTexts.length ||
          state.fill?.toLowerCase() !== '#ffffff' ||
          state.alpha !== 1 ||
          p.length !== 13 ||
          p[0] !== 0 ||
          p[12] !== 4 ||
          ![3, 6, 9].every((n) => p[n] === 1)
        )
          return
        leadingBackground = i
      } else if (a[0] !== OPS.endPath) {
        if (
          ![
            OPS.stroke,
            OPS.fillStroke,
            OPS.eoFillStroke,
            OPS.closeFillStroke,
            OPS.closeEOFillStroke
          ].includes(a[0])
        )
          return
        painted.add(i)
        colors.set(i, { color: state.fill, alpha: state.alpha })
      }
    } else if (op === OPS.paintImageXObject) {
      if (
        text ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        ![a[1], a[2]].every((n) => Number.isSafeInteger(n) && n > 0) ||
        !(state.alpha > 0)
      )
        return
      imageOps.add(i)
    } else if (op === OPS.beginText) {
      if (text || (a != null && (!Array.isArray(a) || a.length))) return
      text = true
      tm = [1, 0, 0, 1, 0, 0]
      x = y = 0
    } else if (op === OPS.endText) {
      if (!text || (a != null && (!Array.isArray(a) || a.length))) return
      text = false
    } else if (op === OPS.setFont) {
      if (
        !text ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !(a[1] > 0) ||
        !Number.isFinite(a[1])
      )
        return
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.moveText) {
      if (!text || !nums(a, 2)) return
      x += a[0]
      y += a[1]
    } else if (op === OPS.setTextMatrix) {
      if (!text || a?.length !== 1 || !matrix(a[0])) return
      tm = Array.from(a[0])
      x = y = 0
    } else if (op === OPS.showText) {
      if (!text || !state.font || !(state.size > 0) || a?.length !== 1 || !Array.isArray(a[0]))
        return
      const left = x,
        glyphs = a[0].filter((g) => typeof g !== 'number')
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          x -= (g * state.size) / 1000
        } else {
          if (!g || typeof g.unicode !== 'string' || !Number.isFinite(g.width)) return
          x += (g.width * state.size) / 1000
        }
      }
      rawTexts.push({
        i,
        font: state.font,
        size: state.size,
        color: state.fill,
        alpha: state.alpha,
        tm: [...tm],
        left,
        right: x,
        y,
        glyphs
      })
    } else if (op === OPS.setDash) {
      if (a?.length !== 2 || !Array.isArray(a[0]) || a[0].length || a[1] !== 0) return
    } else if (op === OPS.dependency) {
      if (!Array.isArray(a) || !a.length || !a.every((s) => typeof s === 'string' && s)) return
    } else if (op === OPS.clip) {
      if (text || pendingClip || (a != null && (!Array.isArray(a) || a.length))) return
      pendingClip = true
    } else if (
      !nums(a, 1) ||
      a[0] < 0 ||
      ([OPS.setLineCap, OPS.setLineJoin].includes(op) && ![0, 1, 2].includes(a[0])) ||
      (op === OPS.setMiterLimit && a[0] === 0)
    )
      return
  }
  const outlines = paths.filter((g) => g.operationIndex !== leadingBackground)
  if (
    text ||
    pendingClip ||
    stack.length ||
    painted.size !== outlines.length ||
    new Set(paths.map((g) => g.operationIndex)).size !== paths.length ||
    outlines.some((g) => !painted.has(g.operationIndex)) ||
    paths.some((g) => !nums(g.normalizedRect, 4) || g.normalizedRect.some((x) => x < 0 || x > 1)) ||
    (leadingBackground !== undefined && !paths.some((g) => g.operationIndex === leadingBackground))
  )
    return
  const evidence = { paths: new Map(), frames: new Map(), texts: new Map(), images: [] }
  collectClosedFigureFrames(o, v, evidence)
  if (leadingBackground !== undefined) {
    const s = evidence.paths.get(leadingBackground),
      p = o.argsArray[leadingBackground][1][0],
      points = [0, 3, 6, 9].map((n) => [p[n + 1], p[n + 2]])
    if (!s?.clip) return
    for (const point of points) Util.applyTransform(point, Util.transform(v.transform, s.transform))
    if (
      new Set(points.map((p) => p.join(','))).size !== 4 ||
      points.some((p, n) => {
        const q = points[(n + 1) % 4]
        return p[0] !== q[0] && p[1] !== q[1]
      })
    )
      return
    const box = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    if (!inside(box, s.clip) || !inside(s.clip, figure.rect)) return
  }
  if (
    outlines.some(
      (g) =>
        !evidence.frames.has(g.operationIndex) ||
        !nums(g.normalizedRect, 4) ||
        g.normalizedRect.some((x) => x < 0 || x > 1) ||
        !inside(
          g.normalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)),
          evidence.frames.get(g.operationIndex)
        )
    )
  )
    return
  const frames = outlines
      .map((g) => evidence.frames.get(g.operationIndex))
      .sort((a, b) => area(b) - area(a)),
    background = frames[0],
    swatches = frames.slice(1).sort((a, b) => a[0] - b[0])
  const h = headings[0].height
  if (
    !background ||
    swatches.length < 2 ||
    !inside([0, 0, page.width, page.height], background) ||
    background[3] > Math.min(...headings.map((t) => t.rect[1])) ||
    Math.min(...headings.map((t) => t.rect[1])) - background[3] > h ||
    Math.abs((background[0] + background[2] - figure.rect[0] - figure.rect[2]) / 2) > h
  )
    return
  const labels = tokens
    .filter((t) => t.text.trim() && inside(background, t.rect))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (labels.length !== swatches.length || !labels.length) return
  for (let n = 0; n < labels.length; n++) {
    const t = labels[n],
      r = swatches[n],
      g = paths.find((g) => evidence.frames.get(g.operationIndex) === r),
      paint = colors.get(g.operationIndex)
    if (
      !inside(background, r) ||
      r[2] >= t.rect[0] ||
      t.rect[0] - r[2] > t.height ||
      Math.abs(r[3] - t.baseline) > 0.02 ||
      Math.abs(r[2] - r[0] - swatches[0][2] + swatches[0][0]) > 0.02 ||
      Math.abs(r[3] - r[1] - swatches[0][3] + swatches[0][1]) > 0.02 ||
      (n && labels[n - 1].rect[2] >= r[0]) ||
      !(paint.alpha > 0) ||
      !paint.color ||
      paint.color.toLowerCase() === '#ffffff' ||
      t.height > h ||
      t.height < h * 0.5 ||
      t.rect[1] - background[1] > t.height ||
      background[3] - (t.baseline - t.fontDescent * t.height) > t.height ||
      t.baseline - t.fontDescent * t.height > background[3]
    )
      return
  }
  if (swatches[0][0] - background[0] > h || background[2] - labels.at(-1).rect[2] > h) return
  const packet = [...headings, ...labels]
  if (!proveNativeUniqueWholeFonts(packet, tokens)) return
  const fonts = new Set(packet.map((t) => content.items[t.sourceItem.index]?.fontName))
  if (fonts.size !== 1 || fonts.has(undefined)) return
  const font = [...fonts][0],
    style = content.styles[font]
  if (
    !style ||
    style.vertical ||
    !Number.isFinite(style.ascent) ||
    style.ascent <= 0 ||
    style.ascent > 1 ||
    !Number.isFinite(style.descent) ||
    style.descent < -0.5 ||
    style.descent > 0 ||
    content.items.filter((i) => i.str?.trim() && i.fontName === font).length !== packet.length
  )
    return
  const nativeTexts = rawTexts.filter((r) => r.font === font)
  if (nativeTexts.length !== packet.length) return
  const used = new Set()
  for (const t of packet) {
    const item = content.items[t.sourceItem.index]
    if (
      !item ||
      item.str !== t.text ||
      item.dir !== 'ltr' ||
      !matrix(item.transform) ||
      Math.abs(item.transform[0] - t.height) > 1e-6 ||
      Math.abs(item.transform[3] - t.height) > 1e-6 ||
      Math.abs(item.height - t.height) > 1e-6 ||
      Math.abs(item.width - t.rect[2] + t.rect[0]) > 1e-6 ||
      Math.abs(item.transform[4] - t.rect[0]) > 1e-6 ||
      Math.abs(page.height - item.transform[5] - t.baseline) > 1e-6 ||
      t.fontDescent !== style.descent
    )
      return
    const matches = nativeTexts.filter(
      (r) =>
        r.glyphs
          .map((g) => g.unicode)
          .join('')
          .replace(/\s/gu, '') === t.text.replace(/\s/gu, '')
    )
    if (matches.length !== 1 || used.has(matches[0].i)) return
    const r = matches[0],
      s = evidence.texts.get(r.i)
    if (
      !(r.alpha > 0) ||
      !r.color ||
      r.color.toLowerCase() === '#ffffff' ||
      !s?.clip ||
      r.glyphs.some(
        (g) =>
          g.isInFont !== true ||
          !g.unicode ||
          !g.fontChar ||
          g.width <= 0 ||
          g.accent != null ||
          g.operatorListId != null ||
          g.vmetric != null
      )
    )
      return
    const m = Util.transform(v.transform, Util.transform(s.transform, r.tm)),
      points = [
        [r.left, r.y],
        [r.right, r.y],
        [r.left, r.y + r.size],
        [r.right, r.y + r.size]
      ]
    for (const p of points) Util.applyTransform(p, m)
    const box = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    if (box.some((x, n) => Math.abs(x - t.rect[n]) > 0.02) || !inside(s.clip, box)) return
    used.add(r.i)
  }
  // Margin-filtered tokens alone cannot prove that no native prose was
  // omitted from the added band. Check every original text item as well.
  const added = [
      Math.min(figure.rect[0], background[0]),
      background[1],
      Math.max(figure.rect[2], background[2]),
      figure.rect[1]
    ],
    ownedIndices = new Set(packet.map((t) => t.sourceItem.index))
  const viewport = {
    ...v,
    convertToViewportPoint: (x, y) => {
      const p = [x, y]
      Util.applyTransform(p, v.transform)
      return p
    }
  }
  for (const [i, item] of content.items.entries()) {
    if (typeof item?.str !== 'string' || !item.str.trim() || ownedIndices.has(i)) continue
    const native = tableTextToken(item, viewport, 0)
    if (!native || intersection(native.rect, added) > 0) return
  }
  const images = page.graphicsBounds.filter((g) => g.kind === 'image')
  if (imageOps.size !== images.length || evidence.images.length !== images.length) return
  for (const g of images) {
    const raw = evidence.images.filter((i) => i.operationIndex === g.operationIndex)
    if (raw.length !== 1 || !raw[0].rect || !imageOps.has(g.operationIndex)) return
    const source = g.normalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)),
      paintedRect = g.paintedNormalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)),
      r = raw[0].rect,
      a = o.argsArray[g.operationIndex]
    // Rendered ink can cover a boundary sample beyond the clipped native
    // rectangle. Bound that discrepancy by one original source pixel, not a
    // page-sized tolerance. Interior white margins need not equal the ink box.
    const dx = (r[2] - r[0]) / a[1],
      dy = (r[3] - r[1]) / a[2]
    if (!inside(source, r) || !inside([r[0] - dx, r[1] - dy, r[2] + dx, r[3] + dy], paintedRect))
      return
  }
  return { background, labels }
}
// Repeated raster rows own a uniquely aligned short left label band. Every
// row needs its own witness; one detached label or an intervening paragraph
// cannot expand a plate's boundary.
export function nativeRasterRowLabels(page, caption, captions, tables, rect, tokens = []) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return []
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
    .filter(
      (r) =>
        area(r) > 0 &&
        intersection(r, rect) / area(r) > 0.95 &&
        r[2] - r[0] >= font * 3 &&
        r[3] - r[1] >= font * 2
    )
  const rows = []
  const substantive = images.filter((r) => r[3] - r[1] >= font * 3)
  const left = Math.min(...substantive.map((r) => r[0]))
  const anchors = substantive.filter((r) => r[0] <= left + font)
  for (const r of anchors.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const row = rows.find((items) => Math.abs(items[0][1] - r[1]) <= font)
    if (row) row.push(r)
    else rows.push([r])
  }
  // Inset waveform images can begin halfway down a repeated raster row.
  // Only the repeated leading source column defines its row; an inset must
  // fit one unique row before it can witness a column heading.
  const insetMargin = Math.max(font * 0.25, page.height / 256)
  for (const r of images.filter((r) => !anchors.includes(r))) {
    const owners = rows.filter((row) =>
      row.some((anchor) => r[1] >= anchor[1] - insetMargin && r[3] <= anchor[3] + insetMargin)
    )
    if (owners.length === 1) owners[0].push(r)
  }
  if (rows.length < 2 || rows.length > 12 || (rows.length < 3 && rows.some((r) => r.length < 2)))
    return []
  const candidates = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= font * 1.5 &&
      l.height > 0 &&
      l.height <= font * 1.5 &&
      l.text.trim().length > 1 &&
      l.text.length < 40 &&
      !/[.!?]$/.test(l.text.trim()) &&
      l.width > 0 &&
      l.width <= font * 8 &&
      l.x >= rect[0] - font * 7 &&
      l.x < rect[0] &&
      l.x + l.width <= rect[0] + font &&
      l.y >= rect[1] &&
      l.y + l.height <= rect[3] &&
      !captions.some((c) => c.page === caption.page && intersection(c.rect, lineRect(l)) > 0) &&
      !tables.some((t) => intersection(t, lineRect(l)) > 0)
  )
  const labels = []
  for (const row of rows) {
    const b = union(row)
    const local = candidates.filter((l) => l.y >= b[1] && l.y + l.height <= b[3] + font * 0.25)
    if (!local.length || local.length > 3) return []
    labels.push(...local)
  }
  if (
    candidates.some((l) => !labels.includes(l)) ||
    labels.some(
      (l) =>
        Math.abs(l.fontSize - labels[0].fontSize) > font * 0.1 ||
        Math.abs(l.x - labels[0].x) > font * 1.5
    )
  )
    return []
  const strip = [Math.min(...labels.map((l) => l.x)), rect[1], rect[0], rect[3]]
  if (
    tables.some((t) => intersection(t, strip) > 0) ||
    captions.some((c) => c.page === caption.page && intersection(c.rect, strip) > 0) ||
    page.lines.some(
      (l) => !labels.includes(l) && l.text.length >= 40 && intersection(lineRect(l), strip) > 0
    )
  )
    return []
  const headings = tokens.filter(
    (t) =>
      t.horizontal &&
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      t.height <= font &&
      t.text.trim().length > 1 &&
      t.text.length < 40 &&
      !/[.!?]$/.test(t.text.trim()) &&
      t.rect[0] >= rect[0] &&
      t.rect[2] <= rect[2] &&
      t.rect[3] <= rect[1] &&
      rect[1] - t.rect[3] <= font
  )
  const headingOwners = headings.map((t) =>
    rows[0].filter((r) => (t.rect[0] + t.rect[2]) / 2 > r[0] && (t.rect[0] + t.rect[2]) / 2 < r[2])
  )
  if (
    headings.length >= 3 &&
    headings.length <= 6 &&
    headings.every(
      (t) =>
        Math.abs(t.rect[3] - headings[0].rect[3]) <= font * 0.1 &&
        Math.abs(t.height - headings[0].height) <= font * 0.1 &&
        rows.every(
          (row) =>
            row.filter(
              (r) => (t.rect[0] + t.rect[2]) / 2 > r[0] && (t.rect[0] + t.rect[2]) / 2 < r[2]
            ).length === 1
        )
    ) &&
    headingOwners.every((owners) => owners.length === 1) &&
    new Set(headingOwners.map((owners) => owners[0])).size === headings.length
  ) {
    const bounds = union(headings.map((t) => t.rect)),
      band = [rect[0], bounds[1], rect[2], rect[1]]
    if (
      !captions.some((c) => c.page === caption.page && intersection(c.rect, band) > 0) &&
      !tables.some((t) => intersection(t, band) > 0) &&
      !page.lines.some(
        (l) =>
          intersection(lineRect(l), band) > 0 &&
          intersection(lineRect(l), bounds) / area(lineRect(l)) < 0.95
      )
    )
      labels.push(
        ...headings.map((t) => ({
          text: t.text,
          x: t.rect[0],
          y: t.rect[1],
          width: t.rect[2] - t.rect[0],
          height: t.rect[3] - t.rect[1],
          fontSize: t.height
        }))
      )
  }
  return [...new Set(labels)]
}
// Preserve complete native font boxes already intersecting owned drawing ink.
// Detached rows require independent repeated panel/label column evidence.
export function nativeOwnedFigureLabels(
  page,
  caption,
  captions,
  tables,
  rect,
  foreignOwns = () => false
) {
  const font = Math.min(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((v) => v > 0)
  )
  if (!Number.isFinite(font)) return []
  const eligible = (l) =>
    l.fontSize > 0 &&
    l.fontSize <= font * 1.15 &&
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
    l.width > 0 &&
    l.height > 0 &&
    l.text.length < 40 &&
    !/[.!?]$/.test(l.text.trim()) &&
    !captions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
    !tables.some((t) => intersection(t, lineRect(l)) > 0) &&
    !foreignOwns(lineRect(l))
  const marker = (l) => /^(?:[a-z]|[a-z](?:\s+[a-z])+)$/.test(l.text.trim())
  const labels = page.lines.filter(
    (l) =>
      eligible(l) &&
      (l.width <= l.fontSize * 15 || marker(l)) &&
      intersection(lineRect(l), rect) / area(lineRect(l)) > 0.05
  )
  const marks = page.lines
    .filter(
      (l) =>
        eligible(l) &&
        /^[a-z]$/.test(l.text.trim()) &&
        l.x >= rect[0] - l.fontSize * 4 &&
        l.x < rect[0] &&
        l.y >= rect[1] - l.fontSize * 3 &&
        l.y + l.height <= rect[3] &&
        l.height <= l.fontSize * 1.25
    )
    .sort((a, b) => a.y - b.y)
  if (
    marks.length >= 3 &&
    marks.length <= 6 &&
    marks.every(
      (l, i) =>
        Math.abs(l.x - marks[0].x) < l.fontSize * 0.2 &&
        Math.abs(l.fontSize - marks[0].fontSize) < 0.1 &&
        l.text === String.fromCharCode(97 + i) &&
        (!i || l.y - marks[i - 1].y > l.fontSize * 5)
    )
  )
    labels.push(...marks)
  const expanded = union([rect, ...labels.map(lineRect)])
  const outside = page.lines.filter(
    (l) =>
      eligible(l) &&
      l.fontSize < font * 0.9 &&
      l.text.length < 30 &&
      l.height <= l.fontSize * 1.25 &&
      l.x >= rect[0] - l.fontSize * 6 &&
      l.x + l.width >= rect[0] - l.fontSize * 2 &&
      l.x < rect[0] &&
      l.y >= expanded[1] &&
      l.y + l.height <= expanded[3]
  )
  if (
    outside.length >= 5 &&
    outside.every((l) => Math.abs(l.fontSize - outside[0].fontSize) < 0.1) &&
    !page.lines.some(
      (l) => l.text.length > 60 && intersection(lineRect(l), union(outside.map(lineRect))) > 0
    )
  )
    labels.push(...outside)
  return [...new Set(labels)]
}
export function nativePanelTopHeading(page, captions, tables, rect, rules) {
  const headings = page.lines.filter(
    (l) =>
      /^\([a-z]\)\s+\p{L}/u.test(l.text) &&
      l.fontSize > 0 &&
      l.height <= l.fontSize * 1.3 &&
      l.text.length < 60 &&
      l.x >= rect[0] &&
      l.x + l.width <= rect[2] &&
      !captions.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const before = headings.filter(
    (l) => l.y + l.height < rect[1] && rect[1] - l.y - l.height <= l.fontSize * 3
  )
  if (before.length !== 1) return []
  const title = before[0],
    peers = headings.filter(
      (l) =>
        l.y >= rect[1] && l.y + l.height <= rect[3] && Math.abs(l.fontSize - title.fontSize) < 0.1
    )
  if (
    peers.length < 2 ||
    new Set([title, ...peers].map((l) => l.text[1])).size !== peers.length + 1
  )
    return []
  const opening = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[0] <= title.x &&
      r[2] >= title.x + title.width &&
      r[1] >= title.y + title.height &&
      r[1] <= rect[1] &&
      Math.abs(r[0] - rect[0]) < 8 &&
      Math.abs(r[2] - rect[2]) < 8
  )
  if (
    opening.length !== 1 ||
    tables.some((t) => intersection(t, lineRect(title)) > 0) ||
    page.lines.some(
      (l) => l !== title && intersection(lineRect(l), [rect[0], title.y, rect[2], rect[1]]) > 0
    )
  )
    return []
  return [title]
}

// The source probe can omit a tiny run from a grouped label. Preserve only
// literal glyph tails tightly attached to an already owned short native run.
export function nativeOwnedFigureGlyphTails(page, caption, captions, tables, rect, tokens) {
  const owned = page.lines.filter(
    (l) =>
      l.text.length < 20 &&
      l.fontSize > 0 &&
      [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
      intersection(lineRect(l), rect) / area(lineRect(l)) > 0.8 &&
      !captions.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const result = []
  for (const token of tokens) {
    if (
      !token.horizontal ||
      !/^[\p{L}\p{N}]{1,4}$/u.test(token.text) ||
      ![...token.rect, token.baseline, token.height].every(Number.isFinite) ||
      token.height <= 0 ||
      area(token.rect) <= 0 ||
      page.lines.some((l) => intersection(lineRect(l), token.rect) / area(token.rect) > 0.8) ||
      tables.some((t) => intersection(t, token.rect) > 0) ||
      captions.some((c) => intersection(c.rect, token.rect) > 0)
    )
      continue
    const peers = owned.filter(
      (l) =>
        Math.abs(token.rect[0] - l.x - l.width) <= token.height * 0.05 &&
        token.height >= l.fontSize * 0.65 &&
        token.height <= l.fontSize * 1.2 &&
        token.rect[1] < l.y + l.height &&
        token.baseline > l.y &&
        Math.abs(token.baseline - l.y - l.height) <= token.height * 0.2
    )
    if (
      peers.length !== 1 ||
      tokens.some(
        (t) =>
          t !== token &&
          t.horizontal &&
          intersection(t.rect, [token.rect[0], token.rect[1], token.rect[2], token.rect[3]]) > 0
      )
    )
      continue
    const strip = [token.rect[2], token.rect[1], token.rect[2] + token.height * 0.2, token.rect[3]]
    const clear =
      !tokens.some((t) => t !== token && intersection(t.rect, strip) > 0) &&
      !page.lines.some((l) => intersection(lineRect(l), strip) > 0) &&
      !captions.some((c) => intersection(c.rect, strip) > 0) &&
      !tables.some((t) => intersection(t, strip) > 0)
    result.push({
      cropRect: clear ? [token.rect[0], token.rect[1], strip[2], token.rect[3]] : token.rect,
      text: token.text,
      x: token.rect[0],
      y: token.rect[1],
      width: token.rect[2] - token.rect[0],
      height: token.rect[3] - token.rect[1],
      fontSize: token.height
    })
  }
  return result
}

// A caption matcher can stop before a typeset panel key even though the
// complete finite raster/closed face is already owned. Keep native font boxes
// and uniquely aligned keyed continuations; a neighbouring unowned panel or
// arbitrary paragraph cannot establish this extension.
export function nativeOwnedFigureTopLabel(page, caption, captions, tables, rect, tokens) {
  captions = captions.filter((c) => c.page === page.pageNumber)
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((v) => v > 0)
  )
  if (!Number.isFinite(font) || !rect?.every(Number.isFinite)) return
  const normalize = (s) => s.replace(/\s+/g, '')
  const labels = page.lines.filter(
    (l) =>
      l.text.length >= 12 &&
      l.text.length <= 100 &&
      /^\p{L}/u.test(l.text) &&
      !/[.!?]$/.test(l.text.trim()) &&
      !/\bet al\b|^(?:figure|fig|panel)\b/i.test(l.text) &&
      l.fontSize >= font * 0.8 &&
      l.fontSize <= font * 1.25 &&
      [l.x, l.y, l.width, l.height].every(Number.isFinite) &&
      l.width >= (rect[2] - rect[0]) * 0.5 &&
      l.height > 0 &&
      l.height <= l.fontSize * 1.25 &&
      l.y < rect[1] &&
      l.y + l.height > rect[1] &&
      rect[1] - l.y <= l.fontSize &&
      l.x >= rect[0] &&
      l.x + l.width <= rect[2] &&
      Math.abs(l.x + l.width / 2 - (rect[0] + rect[2]) / 2) <= font * 2
  )
  if (labels.length !== 1) return
  const l = labels[0],
    r = lineRect(l),
    native = tokens.filter(
      (t) =>
        t.horizontal &&
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        intersection(t.rect, r) / area(t.rect) > 0.95
    )
  if (
    !native.length ||
    normalize(native.map((t) => t.text).join('')) !== normalize(l.text) ||
    native.some((t) => intersection(t.rect, rect) / area(t.rect) < 0.1)
  )
    return
  const strips = (page.graphicsBounds ?? []).filter((g) => {
    if (g.kind !== 'image' || !g.imageHash) return false
    const b = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
    return (
      b[3] - b[1] <= font * 4 &&
      b[2] - b[0] >= r[2] - r[0] &&
      intersection(r, b) / area(r) > 0.999 &&
      intersection(b, rect) / area(b) > 0.5
    )
  })
  const added = [rect[0], r[1], rect[2], rect[1]]
  if (
    strips.length !== 1 ||
    captions.some((c) => intersection(c.rect, added) > 0) ||
    tables.some((t) => intersection(t, added) > 0) ||
    page.lines.some((other) => other !== l && intersection(lineRect(other), added) > 0)
  )
    return
  return r
}
// Four literal keys can sit above the four groups of an already complete
// paired-face plate. Closed faces and whole paint establish the existing
// body; this proof only completes the keys' physical native font boxes.
export function nativeOwnedPairedFacePanelKeys(
  page,
  caption,
  captions,
  tables,
  rect,
  frames,
  tokens,
  foreignOwns = () => false
) {
  const validRect = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0,
    contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-7 : v <= a[n] + 1e-7)),
    nearRect = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 1e-6),
    glyphs = (s) => s.replace(/\s+/gu, ''),
    physical = (t) => [t.rect[0], t.rect[1], t.rect[2], t.rect[3] - t.fontDescent * t.height]
  if (
    !page ||
    !caption ||
    ![captions, tables, frames, tokens, page.lines, page.graphicsBounds].every(Array.isArray) ||
    frames.length < 8 ||
    !tokens.length ||
    typeof foreignOwns !== 'function' ||
    !Number.isInteger(page.pageNumber) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    !validRect(rect) ||
    !validRect(caption.rect) ||
    caption.page !== page.pageNumber ||
    page.invalidGraphicsBounds > 0 ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    !caption.lines.every((l) => typeof l === 'string') ||
    !captions.every(
      (c) =>
        c &&
        Number.isInteger(c.page) &&
        validRect(c.rect) &&
        Array.isArray(c.lines) &&
        c.lines.every((l) => typeof l === 'string')
    ) ||
    captions.filter((c) => c === caption).length !== 1 ||
    !frames.every(validRect) ||
    !tables.every(validRect) ||
    !tokens.every((t) => t && typeof t.text === 'string') ||
    !page.lines.every(
      (l) =>
        l &&
        typeof l.text === 'string' &&
        [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
        l.width > 0 &&
        l.height > 0 &&
        l.fontSize > 0
    ) ||
    !page.graphicsBounds.every(
      (g) =>
        g &&
        ['image', 'path'].includes(g.kind) &&
        validRect(g.normalizedRect) &&
        contains([0, 0, 1, 1], g.normalizedRect) &&
        (!g.paintedNormalizedRect ||
          (validRect(g.paintedNormalizedRect) &&
            contains(g.normalizedRect, g.paintedNormalizedRect)))
    ) ||
    !/^(?:Fig\.?|Figure)\s+\d+[.:]\s+\S/iu.test(caption.lines[0])
  )
    return
  const captionKeys = [
    ...new Set([...caption.lines.join(' ').matchAll(/\(([a-z])\)/gu)].map((m) => m[1]))
  ]
  if (captionKeys.join('') !== 'abcd') return
  const native = tokens.filter((t) => t.text.trim())
  if (
    !native.length ||
    !native.every(
      (t) =>
        t.horizontal === true &&
        validRect(t.rect) &&
        [t.height, t.baseline, t.fontDescent].every(Number.isFinite) &&
        t.height > 0 &&
        t.fontDescent >= -1 &&
        t.fontDescent <= 0 &&
        Math.abs(t.rect[3] - t.rect[1] - t.height) <= 1e-6 &&
        Math.abs(t.rect[3] - t.baseline) <= 1e-6
    )
  )
    return
  const captionFonts = native.filter((t) => contains(caption.rect, t.rect))
  if (
    !captionFonts.length ||
    !nearRect(union(captionFonts.map((t) => t.rect)), caption.rect) ||
    glyphs(captionFonts.map((t) => t.text).join('')) !== glyphs(caption.lines.join(''))
  )
    return
  let font = 0
  for (const t of captionFonts) font = Math.max(font, t.height)
  const ownedFrames = frames.filter(
    (r) => contains(rect, r) && r[2] - r[0] >= font * 4 && r[3] - r[1] >= font * 6
  )
  if (
    ownedFrames.length !== 8 ||
    frames.some((r) => !ownedFrames.includes(r) && intersection(r, rect) > 0)
  )
    return
  const sorted = ownedFrames.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    rows = [sorted.slice(0, 4), sorted.slice(4)]
  if (
    !rows.every((row) =>
      row.every((r) => Math.abs(r[1] - row[0][1]) <= 0.02 && Math.abs(r[3] - row[0][3]) <= 0.02)
    ) ||
    rows[1][0][1] - rows[0][0][3] < font * 3
  )
    return
  for (const row of rows) row.sort((a, b) => a[0] - b[0])
  if (
    !rows[0].every(
      (r, c) => Math.abs(r[0] - rows[1][c][0]) <= 0.02 && Math.abs(r[2] - rows[1][c][2]) <= 0.02
    ) ||
    !rows.every((row) => row[2][0] - row[1][2] >= font * 4)
  )
    return
  const groups = rows.flatMap((row) => [row.slice(0, 2), row.slice(2)])
  if (
    !groups.every(
      (faces) =>
        faces[1][0] > faces[0][2] &&
        faces[1][0] - faces[0][2] <= font * 0.5 &&
        faces[0][2] - faces[0][0] >= (faces[1][2] - faces[1][0]) * 1.5
    )
  )
    return
  const keys = native.filter((t) => /^\([a-d]\)$/u.test(t.text.trim()))
  if (
    keys.length !== 4 ||
    keys.map((t) => t.text.trim()[1]).join('') !== 'abcd' ||
    !keys.every(
      (t) =>
        t.height >= font * 0.8 &&
        t.height <= font * 1.25 &&
        Math.abs(t.height - keys[0].height) <= 1e-6 &&
        t.rect[2] - t.rect[0] <= t.height * 2
    )
  )
    return
  const owners = keys.map((t) =>
    groups.filter(
      (faces) =>
        t.rect[0] >= faces[0][0] - t.height * 4.5 &&
        t.rect[2] <= faces[0][0] &&
        faces[0][0] - t.rect[2] <= t.height * 3 &&
        physical(t)[3] <= faces[0][1] &&
        faces[0][1] - physical(t)[3] <= t.height
    )
  )
  if (owners.some((gs, n) => gs.length !== 1 || gs[0] !== groups[n])) return
  // The row's complete font union preserves small independent baseline drift.
  // It does not replace that source evidence with assumed equal baselines.
  const keyLines = []
  for (const row of [keys.slice(0, 2), keys.slice(2)]) {
    const b = union(row.map((t) => t.rect)),
      lines = page.lines.filter(
        (l) =>
          glyphs(l.text) === glyphs(row.map((t) => t.text).join('')) &&
          nearRect(lineRect(l), b) &&
          Math.abs(l.fontSize - row[0].height) <= 1e-6
      )
    if (lines.length !== 1) return
    keyLines.push(lines[0])
  }
  const graphics = page.graphicsBounds.map((g) =>
    (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
  )
  if (!graphics.length || graphics.some((r) => !contains([0, 0, page.width, page.height], r)))
    return
  const paint = graphics.filter((r) => intersection(r, rect) > 0)
  if (
    !paint.length ||
    !paint.every((r) => contains(rect, r)) ||
    !nearRect(union(paint), rect) ||
    !groups.every((faces) =>
      faces.every((f) => paint.some((r) => intersection(r, f) > area(f) * 0.05))
    )
  )
    return
  const labels = keys.map(physical),
    expanded = union([rect, ...labels]),
    added = (r) => intersection(r, expanded) > intersection(r, rect) + 1e-8
  if (
    !contains([0, 0, page.width, page.height], expanded) ||
    expanded[3] >= caption.rect[1] ||
    foreignOwns(expanded) ||
    native.some((t) => added(physical(t)) && !keys.includes(t)) ||
    graphics.some((r) => added(r) && !paint.includes(r)) ||
    page.lines.some((l) => added(lineRect(l)) && !keyLines.includes(l)) ||
    tables.some((r) => intersection(r, expanded) > 0) ||
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, expanded) > 0
    )
  )
    return
  return labels
}

// Complete ordinary lower title packets of an already owned four-raster plate.
// Correct upper titles calibrate the lower pair; unknown paint/text state,
// incomplete font packets or any foreign extension keep the legacy path.
export function nativeOwnedRasterTitleRows(
  page,
  caption,
  captions,
  tables,
  ownedRect,
  tokens,
  foreignOwns,
  context
) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const contains = (a, b, e = 1e-7) => b.every((v, n) => (n < 2 ? v >= a[n] - e : v <= a[n] + e))
  const glyphs = (s) => s.replace(/\s+/gu, '')
  if (
    !page ||
    !caption ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber <= 0 ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    caption.lines.some((s) => typeof s !== 'string' || !s.trim()) ||
    ![page.lines, page.graphicsBounds, captions, tables, tokens].every(Array.isArray) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !valid(ownedRect) ||
    !valid(caption.rect) ||
    caption.page !== page.pageNumber ||
    !captions.includes(caption) ||
    typeof foreignOwns !== 'function'
  )
    return
  if (
    !contains([0, 0, page.width, page.height], ownedRect) ||
    !contains([0, 0, page.width, page.height], caption.rect)
  )
    return
  const caps = captions.filter((c) => c?.page === page.pageNumber)
  if (caps.some((c) => !valid(c.rect)) || tables.some((r) => !valid(r))) return
  if (
    page.graphicsBounds.length !== 4 ||
    page.graphicsBounds.some(
      (g) =>
        g?.kind !== 'image' ||
        !valid(g.normalizedRect) ||
        !valid(g.paintedNormalizedRect) ||
        !contains([0, 0, 1, 1], g.normalizedRect) ||
        !contains(g.normalizedRect, g.paintedNormalizedRect)
    )
  )
    return
  if (
    tokens.some(
      (t) =>
        !t ||
        typeof t.text !== 'string' ||
        (t.text.trim() &&
          (t.horizontal !== true ||
            !valid(t.rect) ||
            ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
            t.height <= 0 ||
            t.fontDescent < -1 ||
            t.fontDescent > 0 ||
            Math.abs(t.rect[3] - t.rect[1] - t.height) > 1e-6 ||
            Math.abs(t.rect[3] - t.baseline) > 1e-6))
    )
  )
    return
  if (
    page.lines.some(
      (l) =>
        !l ||
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.fontSize <= 0
    )
  )
    return
  const captionFonts = tokens.filter((t) => t.text.trim() && contains(caption.rect, t.rect))
  if (
    captionFonts.length !== 1 ||
    glyphs(captionFonts[0].text) !== glyphs(caption.lines?.join('') ?? '') ||
    !contains(caption.rect, union(captionFonts.map((t) => t.rect))) ||
    !contains(union(captionFonts.map((t) => t.rect)), caption.rect, 1e-6)
  )
    return
  const em = captionFonts[0].height
  const o = context?.operators,
    v = context?.viewport
  if (
    ![v?.width, v?.height].every((n) => Number.isFinite(n) && n > 0) ||
    version !== '5.4.624' ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o?.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    !Array.isArray(v?.transform) ||
    v.transform.length !== 6 ||
    !v.transform.every(Number.isFinite) ||
    v.rotation !== 0 ||
    v.transform[1] !== 0 ||
    v.transform[2] !== 0 ||
    v.transform[0] <= 0 ||
    v.transform[3] >= 0 ||
    Math.abs(v.width - page.width) > 1e-7 ||
    Math.abs(v.height - page.height) > 1e-7
  )
    return
  const permitted = new Set([
    OPS.save,
    OPS.restore,
    OPS.transform,
    OPS.dependency,
    OPS.paintImageXObject,
    OPS.beginText,
    OPS.endText,
    OPS.setFont,
    OPS.moveText,
    OPS.setTextMatrix,
    OPS.showText,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor
  ])
  let matrix = [1, 0, 0, 1, 0, 0],
    inText = false,
    program = ''
  const stack = [],
    images = [],
    showPackets = []
  for (const [index, op] of o.fnArray.entries()) {
    const a = o.argsArray[index]
    if (!permitted.has(op)) return
    if (op === OPS.save) {
      if (inText || stack.length >= 4) return
      stack.push([...matrix])
    } else if (op === OPS.restore) {
      if (inText || !stack.length) return
      matrix = stack.pop()
    } else if (op === OPS.transform) {
      if (
        inText ||
        !Array.isArray(a) ||
        a.length !== 6 ||
        !a.every(Number.isFinite) ||
        a[1] !== 0 ||
        a[2] !== 0 ||
        a[0] <= 0 ||
        a[3] <= 0
      )
        return
      matrix = Util.transform(matrix, a)
    } else if (op === OPS.paintImageXObject) {
      if (
        inText ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        typeof a[0] !== 'string' ||
        !a.slice(1).every((n) => Number.isSafeInteger(n) && n > 0)
      )
        return
      const m = Util.transform(v.transform, matrix)
      const rect = [
        Math.min(m[4], m[4] + m[0]),
        Math.min(m[5], m[5] + m[3]),
        Math.max(m[4], m[4] + m[0]),
        Math.max(m[5], m[5] + m[3])
      ]
      if (!valid(rect) || !contains(ownedRect, rect)) return
      images.push({ reference: a[0], rect })
    } else if (op === OPS.beginText) {
      if (inText) return
      inText = true
    } else if (op === OPS.endText) {
      if (!inText) return
      inText = false
    } else if (op === OPS.setFont) {
      if (
        !inText ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return
    } else if (op === OPS.moveText || op === OPS.setTextMatrix) {
      const position = op === OPS.setTextMatrix && Array.isArray(a) && a.length === 1 ? a[0] : a
      if (
        !inText ||
        !(Array.isArray(position) || position instanceof Float32Array) ||
        position.length !== (op === OPS.moveText ? 2 : 6) ||
        !Array.from(position).every(Number.isFinite) ||
        (op === OPS.setTextMatrix &&
          (position[1] !== 0 || position[2] !== 0 || position[0] <= 0 || position[3] <= 0))
      )
        return
    } else if (op === OPS.showText) {
      if (!inText || !Array.isArray(a) || a.length !== 1 || !Array.isArray(a[0])) return
      let text = ''
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          continue
        }
        if (
          !g ||
          typeof g.unicode !== 'string' ||
          !g.unicode.length ||
          typeof g.fontChar !== 'string' ||
          !g.fontChar.length ||
          !Number.isFinite(g.width) ||
          g.width <= 0 ||
          g.isInFont !== true ||
          g.operatorListId !== undefined ||
          g.accent
        )
          return
        text += g.unicode
      }
      program += text
      showPackets.push({ text })
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (!Array.isArray(a) || a.length !== 1 || a[0] !== '#000000') return
    } else if (op === OPS.dependency && (!Array.isArray(a) || a.some((s) => typeof s !== 'string')))
      return
  }
  if (
    stack.length ||
    inText ||
    images.length !== 4 ||
    new Set(images.map((i) => i.reference)).size !== 4 ||
    showPackets.length !== tokens.length ||
    showPackets.some((p, i) => glyphs(p.text) !== glyphs(tokens[i].text)) ||
    glyphs(program) !== glyphs(tokens.map((t) => t.text).join(''))
  )
    return
  // Raw indices never bind optimized renderer operationIndex. Bind each full
  // image enclosure through unique measured geometric containment instead.
  const imagePairs = images.map((image) => {
    const matched = page.graphicsBounds.filter((g) => {
      const nominal = g.normalizedRect.map((n, k) => n * (k % 2 ? page.height : page.width))
      const painted = g.paintedNormalizedRect.map((n, k) => n * (k % 2 ? page.height : page.width))
      return (
        contains(nominal, image.rect) &&
        contains(image.rect, painted) &&
        contains(ownedRect, painted)
      )
    })
    return { image, matches: matched }
  })
  if (
    imagePairs.some((p) => p.matches.length !== 1) ||
    new Set(imagePairs.map((p) => p.matches[0])).size !== 4
  )
    return
  const ordered = [...images].sort((a, b) => a.rect[1] - b.rect[1]).map((i) => i.rect)
  const rows = [
    ordered.slice(0, 2).sort((a, b) => a[0] - b[0]),
    ordered.slice(2).sort((a, b) => a[0] - b[0])
  ]
  if (
    rows.some((row) => row[0][2] >= row[1][0] || Math.abs(row[0][3] - row[1][3]) > em * 0.01) ||
    rows[0].some(
      (r, n) =>
        r[3] >= rows[1][n][1] ||
        Math.abs(r[0] - rows[1][n][0]) > em * 0.01 ||
        Math.abs(r[2] - rows[1][n][2]) > em * 0.01
    )
  )
    return
  const keys = tokens.filter((t) => /^\([a-d]\)\s+\p{L}/u.test(t.text))
  if (
    keys.length !== 4 ||
    keys.map((t) => t.text[1]).join('') !== 'abcd' ||
    new Set(keys.map((t) => t.text.slice(4))).size !== 1
  )
    return
  const groups = []
  for (const [n, key] of keys.entries()) {
    const image = rows[Math.floor(n / 2)][n % 2]
    if (
      key.inlineSymbol !== false ||
      key.height < em * 0.8 ||
      key.height > em ||
      key.rect[1] < image[3] ||
      key.rect[1] - image[3] > em ||
      Math.abs(key.height - keys[0].height) > 1e-6 ||
      Math.abs(key.fontDescent - keys[0].fontDescent) > 1e-6
    )
      return
    const group = tokens
      .filter(
        (t) =>
          t.text.trim() &&
          Math.abs(t.baseline - key.baseline) < 1e-6 &&
          t.rect[0] >= image[0] &&
          t.rect[2] <= image[2]
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      group[0] !== key ||
      group.length < 2 ||
      group.some(
        (t, i) =>
          t.inlineSymbol !== false ||
          Math.abs(t.height - key.height) > 1e-6 ||
          Math.abs(t.fontDescent - key.fontDescent) > 1e-6 ||
          (t !== key && /^\([a-z]\)/u.test(t.text)) ||
          (i &&
            (t.rect[0] - group[i - 1].rect[2] > em * 0.5 ||
              group[i - 1].rect[2] - t.rect[0] > em * 0.001))
      )
    )
      return
    const full = union(
      group.map((t) => [t.rect[0], t.rect[1], t.rect[2], t.rect[3] - t.fontDescent * t.height])
    )
    if (
      Math.abs((full[0] + full[2] - image[0] - image[2]) / 2) > em * 0.2 ||
      (n < 2 && !contains(ownedRect, full)) ||
      (n >= 2 && full[3] <= ownedRect[3])
    )
      return
    groups.push({ key, fonts: group, physicalRect: full, image })
  }
  if (
    Math.abs(groups[0].key.baseline - groups[1].key.baseline) > 1e-6 ||
    Math.abs(groups[2].key.baseline - groups[3].key.baseline) > 1e-6 ||
    groups.some(
      (g) =>
        Math.abs(g.key.baseline - g.image[3] - groups[0].key.baseline + groups[0].image[3]) >
        em * 0.01
    )
  )
    return
  const labels = groups.slice(2).flatMap((g) => g.fonts),
    rect = union([ownedRect, ...groups.slice(2).map((g) => g.physicalRect)])
  const added = (r) => intersection(r, rect) - intersection(r, ownedRect) > 1e-7
  if (
    rect[0] !== ownedRect[0] ||
    rect[1] !== ownedRect[1] ||
    rect[2] !== ownedRect[2] ||
    rect[3] >= caption.rect[1] ||
    foreignOwns(rect) !== false ||
    caps.some((c) => c !== caption && intersection(c.rect, rect) > 0) ||
    tables.some((t) => intersection(t, rect) > 0) ||
    tokens.some((t) => t.text.trim() && added(t.rect) && !labels.includes(t))
  )
    return
  if (
    page.lines.some(
      (l) =>
        added(lineRect(l)) &&
        glyphs(
          tokens
            .filter((t) => t.text.trim() && contains(lineRect(l), t.rect))
            .map((t) => t.text)
            .join('')
        ) !== glyphs(l.text)
    )
  )
    return
  return [rect]
}

export function nativeOwnedFigureBottomLabels(
  page,
  caption,
  captions,
  tables,
  rect,
  frames,
  tokens,
  foreignOwns = () => false
) {
  const cutRow = nativeCutRasterLabelRow(page, caption, captions, tables, rect, tokens, foreignOwns)
  if (cutRow.length) return cutRow
  const pairedFaces = nativeOwnedPairedFacePanelKeys(
    page,
    caption,
    captions,
    tables,
    rect,
    frames,
    tokens,
    foreignOwns
  )
  if (pairedFaces) return pairedFaces
  const closedPair = nativeOwnedClosedBottomLabelPair(
    page,
    caption,
    captions,
    tables,
    rect,
    frames,
    tokens,
    foreignOwns
  )
  if (closedPair) return closedPair
  captions = captions.filter((c) => c.page === page.pageNumber)
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((v) => v > 0)
  )
  if (!Number.isFinite(font) || !rect?.every(Number.isFinite)) return []
  const axes = nativeOwnedRasterAxisPair(
    page,
    caption,
    captions,
    tables,
    rect,
    tokens,
    font,
    foreignOwns
  )
  if (axes) return axes
  const paired = nativeOwnedPairedBottomRow(
    page,
    caption,
    captions,
    tables,
    rect,
    tokens,
    font,
    foreignOwns
  )
  if (paired) return paired
  const anchors = [
    ...frames,
    ...(page.graphicsBounds ?? [])
      .filter((g) => g.kind === 'image' && (g.imageHash || g.paintedNormalizedRect))
      .map((g) =>
        (g.paintedNormalizedRect ?? g.normalizedRect).map(
          (v, n) => v * (n % 2 ? page.height : page.width)
        )
      )
  ].filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[2] - r[0] >= font * 3 &&
      r[3] - r[1] >= font * 2 &&
      intersection(r, rect) / area(r) > 0.95 &&
      !tables.some((t) => intersection(t, r) > 0)
  )
  const keys = tokens
    .filter(
      (t) =>
        t.horizontal &&
        /^\([a-z]\)(?:\s|$)/.test(t.text.trim()) &&
        t.text.length <= 120 &&
        t.rect?.every(Number.isFinite) &&
        t.height > 0 &&
        t.height <= font * 1.25 &&
        area(t.rect) > 0 &&
        t.rect[0] >= rect[0] - font * 0.5 &&
        t.rect[2] <= rect[2] + font * 0.5 &&
        t.rect[1] >= rect[3] - font * 2 &&
        t.rect[1] <= rect[3] + font * 4 &&
        t.rect[3] < caption.rect[1] &&
        !foreignOwns(t.rect) &&
        !tables.some((r) => intersection(r, t.rect) > 0) &&
        !captions.some((c) => intersection(c.rect, t.rect) > 0)
    )
    .flatMap((t) => {
      const matches = anchors.filter(
        (r) =>
          t.rect[0] >= r[0] - font * 2 &&
          t.rect[2] <= r[2] + font * 2 &&
          t.rect[1] >= r[3] - font * 0.5 &&
          t.rect[1] - r[3] <= font * 4
      )
      // A detector can cut the font box of an already included key. Completing
      // that physical box does not establish ownership of a new vector panel.
      const partlyOwned =
        t.rect[0] >= rect[0] &&
        t.rect[2] <= rect[2] &&
        intersection(t.rect, rect) / area(t.rect) > 0.1 &&
        t.rect[3] - rect[3] <= t.height
      return matches.length === 1 || partlyOwned
        ? [{ token: t, anchor: matches.length === 1 ? matches[0] : undefined }]
        : []
    })
  // Repeated printed letters are not ambiguous when separate rasters uniquely
  // own them. Two keys for the same raster (or an unanchored duplicate) remain
  // ambiguous, regardless of their lettering.
  if (
    !keys.length ||
    keys.some((key, index) =>
      keys.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          ((key.anchor && key.anchor === other.anchor) ||
            (key.token.text.trim()[1] === other.token.text.trim()[1] &&
              (!key.anchor || !other.anchor)))
      )
    )
  )
    return []
  const keySources = keys.map(({ token, anchor }) => {
    const parts =
      /^\([a-z]\)$/.test(token.text.trim()) && anchor
        ? tokens.filter(
            (t) =>
              t !== token &&
              t.horizontal &&
              Array.isArray(t.rect) &&
              t.rect.length === 4 &&
              t.rect?.every(Number.isFinite) &&
              t.rect[2] > t.rect[0] &&
              t.rect[3] > t.rect[1] &&
              t.height > 0 &&
              Math.abs(t.height - token.height) < token.height * 0.1 &&
              Math.abs(t.rect[3] - token.rect[3]) < token.height * 0.1 &&
              t.rect[0] >= token.rect[2] &&
              t.rect[0] - token.rect[2] < token.height &&
              t.rect[2] <= anchor[2] &&
              t.text.trim() &&
              !/^\([a-z]\)/.test(t.text.trim())
          )
        : []
    return { token, anchor, parts: parts.length === 1 ? [token, parts[0]] : [token] }
  })
  const ownedSources = keySources.flatMap((key) => key.parts)
  const completeKeys = keySources.map(({ token, anchor, parts }) => ({
    anchor,
    token:
      parts.length === 1
        ? token
        : {
            ...token,
            text: parts.map((t) => t.text).join(' '),
            rect: union(parts.map((t) => t.rect))
          }
  }))
  const continuations = page.lines
    .filter(
      (l) =>
        l.text.length < 40 &&
        !/^\([a-z]\)/.test(l.text.trim()) &&
        [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
        l.width > 0 &&
        l.height > 0 &&
        !captions.some((c) => intersection(c.rect, lineRect(l)) > 0) &&
        !tables.some((r) => intersection(r, lineRect(l)) > 0) &&
        !foreignOwns(lineRect(l))
    )
    .filter(
      (l) =>
        completeKeys.filter(
          ({ token: t, anchor: r }) =>
            r &&
            t.text.trim().length > 3 &&
            Math.abs(l.fontSize - t.height) < 0.1 &&
            l.y >= t.rect[3] - t.height * 0.1 &&
            l.y - t.rect[3] <= t.height * 1.25 &&
            l.x >= r[0] &&
            l.x + l.width <= r[2] &&
            l.width <= t.rect[2] - t.rect[0] &&
            Math.abs(l.x + l.width / 2 - (t.rect[0] + t.rect[2]) / 2) <= t.height * 2
        ).length === 1
    )
  const result = [...completeKeys.map(({ token }) => token.rect), ...continuations.map(lineRect)],
    b = union([rect, ...result]),
    strip = [b[0], rect[3], b[2], b[3]]
  const normalize = (s) => s.replace(/\s+/g, '')
  if (
    captions.some((c) => c !== caption && intersection(c.rect, strip) > 0) ||
    tables.some((r) => intersection(r, strip) > 0) ||
    page.lines.some((l) => {
      if (intersection(lineRect(l), strip) <= 0 || continuations.includes(l)) return false
      // Page-line grouping can combine two panel keys across a wide empty gap.
      // Prove the complete printed row, then check actual native glyph boxes in
      // the added strip. A key in a different panel is never borrowed.
      const native = tokens.filter(
        (t) =>
          t.horizontal &&
          t.rect?.every(Number.isFinite) &&
          area(t.rect) > 0 &&
          intersection(t.rect, lineRect(l)) / area(t.rect) > 0.95
      )
      return (
        normalize(native.map((t) => t.text).join('')) !== normalize(l.text) ||
        native.some(
          (t) =>
            intersection(t.rect, strip) > 0 &&
            !ownedSources.includes(t) &&
            intersection(t.rect, rect) / area(t.rect) < 0.999
        )
      )
    })
  )
    return []
  return result
}

// Two independently closed, already owned faces can have ordinary explanatory
// keys without native tick text or explicit key references in their caption.
// Complete both physical font boxes and every tightly enclosed painted carrier;
// do not infer a new open plot or discard bounds crossing the extension.
function nativeOwnedClosedBottomLabelPair(
  page,
  caption,
  captions,
  tables,
  rect,
  frames,
  tokens,
  foreignOwns
) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0,
    contains = (a, b, gap = 0) => b.every((v, n) => (n < 2 ? v >= a[n] - gap : v <= a[n] + gap))
  if (
    !page ||
    !caption ||
    ![captions, tables, frames, tokens, page.lines, page.graphicsBounds].every(Array.isArray) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    !valid(rect) ||
    caption.page !== page.pageNumber ||
    !valid(caption.rect) ||
    !Array.isArray(caption.lines) ||
    page.invalidGraphicsBounds !== 0 ||
    typeof foreignOwns !== 'function' ||
    tables.some((r) => !valid(r))
  )
    return
  const localCaptions = captions.filter((c) => c?.page === page.pageNumber)
  if (!localCaptions.includes(caption) || localCaptions.some((c) => !valid(c.rect))) return
  const captionLines = page.lines.filter(
      (l) => l && valid(lineRect(l)) && intersection(lineRect(l), caption.rect) > 0
    ),
    font = captionLines.reduce(
      (maximum, l) =>
        Number.isFinite(l.fontSize) && l.fontSize > 0 ? Math.max(maximum, l.fontSize) : maximum,
      -Infinity
    )
  if (!Number.isFinite(font)) return
  if (
    tokens.some(
      (t) =>
        !t ||
        typeof t.text !== 'string' ||
        (t.text.trim() &&
          (!valid(t.rect) ||
            ![t.height, t.baseline, t.fontDescent].every(Number.isFinite) ||
            t.height <= 0 ||
            t.fontDescent < -1 ||
            t.fontDescent > 0))
    )
  )
    return
  const starts = tokens.filter(
    (t) =>
      t.horizontal === true &&
      /^\([ab]\)\s+\p{L}[\p{L}\p{M}\s-]*$/u.test(t.text.trim()) &&
      t.text.length < 80 &&
      t.height >= font * 0.6 &&
      t.height <= font &&
      valid(t.rect) &&
      Math.abs(t.rect[3] - t.baseline) <= 0.01 &&
      Math.abs(t.rect[3] - t.rect[1] - t.height) <= 0.01 &&
      t.rect[0] >= rect[0] &&
      t.rect[2] <= rect[2] &&
      t.rect[1] >= rect[3] - font * 2 &&
      t.rect[3] - t.fontDescent * t.height > rect[3] &&
      t.rect[1] - rect[3] < font * 2 &&
      t.rect[3] - t.fontDescent * t.height < caption.rect[1]
  )
  if (
    starts.length !== 2 ||
    starts[0].text[1] !== 'a' ||
    starts[1].text[1] !== 'b' ||
    Math.abs(starts[0].baseline - starts[1].baseline) > 0.01 ||
    Math.abs(starts[0].height - starts[1].height) > 0.01 ||
    starts[0].rect[2] >= starts[1].rect[0] ||
    frames.some((r) => !valid(r))
  )
    return
  const faces = frames
    .filter(
      (r) =>
        contains(rect, r) &&
        r[2] - r[0] >= font * 6 &&
        r[3] - r[1] >= font * 6 &&
        starts[0].rect[1] >= r[3] &&
        starts[0].rect[1] - r[3] < font * 2
    )
    .sort((a, b) => a[0] - b[0])
  if (
    faces.length !== 2 ||
    faces[0][2] >= faces[1][0] ||
    [1, 3].some((n) => Math.abs(faces[0][n] - faces[1][n]) > 0.02) ||
    Math.abs(faces[0][2] - faces[0][0] - faces[1][2] + faces[1][0]) > 0.02 ||
    starts.some(
      (t, n) =>
        t.rect[0] < faces[n][0] ||
        t.rect[2] > faces[n][2] ||
        Math.abs((t.rect[0] + t.rect[2] - faces[n][0] - faces[n][2]) / 2) > font * 2
    )
  )
    return
  const ux = page.width / 256,
    uy = page.height / 256,
    graphics = page.graphicsBounds.map((g) => {
      const source = g?.paintedNormalizedRect ?? g?.normalizedRect
      if (!['path', 'image'].includes(g?.kind) || !valid(source)) return
      if (g.kind === 'image' && !g.imageHash) return
      return {
        rect: source.map((v, n) => v * (n % 2 ? page.height : page.width))
      }
    })
  if (graphics.some((g) => !g)) return
  const owners = graphics.map((g) =>
      faces.filter(
        (f) =>
          contains(
            [
              f[0] - Math.max(font, ux * 2),
              f[1] - Math.max(font, uy * 2),
              f[2] + Math.max(font, ux * 2),
              f[3] + Math.max(font, uy * 2)
            ],
            g.rect
          ) && intersection(f, g.rect) > 0
      )
    ),
    paint = graphics.filter((g, n) => owners[n].length === 1)
  if (faces.some((f) => owners.filter((owner) => owner.length === 1 && owner[0] === f).length < 3))
    return
  const labels = starts.map((t) => [
      t.rect[0],
      t.rect[1],
      t.rect[2],
      t.rect[3] - t.fontDescent * t.height
    ]),
    expanded = union([rect, ...paint.map((g) => g.rect), ...labels]),
    added = (r) => intersection(r, expanded) - intersection(r, rect) > 1e-7
  if (
    !contains([0, 0, page.width, page.height], expanded) ||
    expanded[3] >= caption.rect[1] ||
    localCaptions.some((c) => c !== caption && intersection(c.rect, expanded) > 0) ||
    tables.some((r) => intersection(r, expanded) > 0) ||
    foreignOwns(expanded) ||
    frames.some((f) => !faces.includes(f) && added(f)) ||
    graphics.some((g) => added(g.rect) && !paint.includes(g)) ||
    tokens.some((t) => t.text.trim() && added(t.rect) && !starts.includes(t))
  )
    return
  const glyphs = (s) => s.replace(/\s+/gu, '')
  if (
    page.lines.some((l) => {
      if (
        !l ||
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite)
      )
        return true
      if (!added(lineRect(l))) return false
      const members = starts.filter((t) => contains(lineRect(l), t.rect, 1e-7))
      return (
        members.length !== 1 ||
        glyphs(members[0].text) !== glyphs(l.text) ||
        Math.abs(members[0].height - l.fontSize) > 0.01
      )
    })
  )
    return
  return [expanded]
}

// Pixel-baked ticks do not supply native numeric anchors. A whole uniquely
// owned raster plus a matching perpendicular native axis pair can instead
// prove these two complete font boxes, without borrowing a new plot body.
function nativeOwnedRasterAxisPair(
  page,
  caption,
  captions,
  tables,
  rect,
  tokens,
  font,
  foreignOwns
) {
  if (
    caption?.page !== page.pageNumber ||
    !caption.rect?.every(Number.isFinite) ||
    page.invalidGraphicsBounds > 0 ||
    area(rect) <= 0
  )
    return
  const contains = (a, b) =>
      b[0] >= a[0] - 1e-8 && b[1] >= a[1] - 1e-8 && b[2] <= a[2] + 1e-8 && b[3] <= a[3] + 1e-8,
    graphics = (page.graphicsBounds ?? []).map((g) => {
      const source = g.paintedNormalizedRect ?? g.normalizedRect
      if (source?.length !== 4 || !source.every(Number.isFinite)) return
      return { source: g, rect: source.map((v, i) => v * (i % 2 ? page.height : page.width)) }
    })
  if (graphics.some((g) => !g)) return
  const images = graphics.filter(
    (g) =>
      g.source.kind === 'image' &&
      g.source.imageHash &&
      g.source.paintedNormalizedRect &&
      g.rect[2] - g.rect[0] >= font * 8 &&
      g.rect[3] - g.rect[1] >= font * 6 &&
      contains(rect, g.rect) &&
      contains([0, 0, page.width, page.height], g.rect)
  )
  if (images.length !== 1) return
  const image = images[0],
    painted = image.rect
  if (
    painted.some((v, i) => Math.abs(v - rect[i]) > font * 1.5) ||
    caption.rect[1] <= rect[3] ||
    caption.rect[1] - rect[3] > font * 4 ||
    Math.abs((painted[0] + painted[2] - caption.rect[0] - caption.rect[2]) / 2) > font * 1.5
  )
    return
  const native = tokens.filter(
      (t) =>
        t.rect?.length === 4 &&
        [...t.rect, t.height, t.baseline, t.fontDescent].every(Number.isFinite) &&
        t.height >= font * 0.6 &&
        t.height <= font &&
        t.fontDescent >= -1 &&
        t.fontDescent <= 0 &&
        area(t.rect) > 0 &&
        contains([0, 0, page.width, page.height], t.rect) &&
        /^\p{L}[\p{L}\p{M}\p{N}\s()/+−-]*$/u.test(t.text?.trim() ?? '') &&
        t.text.trim().length < 40
    ),
    sides = native.filter(
      (t) =>
        t.horizontal === false &&
        Math.abs(t.rect[2] - t.rect[0] - t.height) <= 0.01 &&
        Math.min(Math.abs(t.baseline - t.rect[1]), Math.abs(t.baseline - t.rect[3])) <= 0.01 &&
        t.rect[3] - t.rect[1] >= t.height * 2 &&
        t.rect[3] - t.rect[1] <= t.height * 12 &&
        t.rect[2] <= painted[0] &&
        painted[0] - t.rect[2] <= t.height &&
        t.rect[1] >= painted[1] &&
        t.rect[3] <= painted[3] &&
        Math.abs((t.rect[1] + t.rect[3] - painted[1] - painted[3]) / 2) <=
          (painted[3] - painted[1]) * 0.25
    ),
    bottoms = native.filter(
      (t) =>
        t.horizontal === true &&
        Math.abs(t.rect[3] - t.baseline) <= 0.01 &&
        Math.abs(t.rect[3] - t.rect[1] - t.height) <= 0.01 &&
        t.rect[1] >= painted[3] &&
        t.rect[1] - painted[3] <= t.height * 1.5 &&
        t.rect[0] >= painted[0] &&
        t.rect[2] <= painted[2] &&
        t.rect[2] - t.rect[0] >= t.height * 2 &&
        t.rect[2] - t.rect[0] <= t.height * 12 &&
        Math.abs((t.rect[0] + t.rect[2] - painted[0] - painted[2]) / 2) <= t.height &&
        t.baseline - t.fontDescent * t.height < caption.rect[1] - 0.5
    )
  if (
    sides.length !== 1 ||
    bottoms.length !== 1 ||
    Math.abs(sides[0].height - bottoms[0].height) > 0.05
  )
    return
  const labels = [sides[0], bottoms[0]],
    expanded = union([rect, ...labels.map((t) => t.rect)]),
    added = (r) => intersection(r, expanded) - intersection(r, rect) > 1e-8
  if (
    tables.some((r) => intersection(r, expanded) > 0) ||
    captions.some((c) => c !== caption && intersection(c.rect, expanded) > 0) ||
    foreignOwns(expanded) ||
    tokens.some((t) => t.rect?.length === 4 && added(t.rect) && !labels.includes(t)) ||
    graphics.some((g) => g !== image && added(g.rect)) ||
    page.lines.some((line) => {
      const r = lineRect(line)
      if (!added(r)) return false
      const owned = labels.filter((t) => contains(r, t.rect))
      return (
        owned.length !== 1 ||
        line.text.replace(/\s+/g, '') !== owned[0].text.replace(/\s+/g, '') ||
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        Math.abs(line.fontSize - owned[0].height) > 0.05 ||
        !contains(expanded, r)
      )
    })
  )
    return
  return labels.map((t) => t.rect)
}

// This completes labels on an existing finite owner; it never establishes a
// new vector body. Two populated owned columns and one complete native keyed
// row are required, with caption keys or independently repeated plot axes.
function nativeOwnedPairedBottomRow(
  page,
  caption,
  captions,
  tables,
  rect,
  tokens,
  font,
  foreignOwns
) {
  const starts = tokens.filter(
    (t) =>
      t.horizontal &&
      /^\([ab]\)(?:\s|$)/.test(t.text.trim()) &&
      t.rect?.every(Number.isFinite) &&
      t.height > 0 &&
      t.height <= font * 1.25 &&
      t.rect[0] >= rect[0] &&
      t.rect[2] <= rect[2] &&
      t.rect[1] > rect[3] &&
      t.rect[1] - rect[3] < font * 2 &&
      t.rect[3] < caption.rect[1]
  )
  if (
    starts.length !== 2 ||
    starts[0].text.trim()[1] !== 'a' ||
    starts[1].text.trim()[1] !== 'b' ||
    Math.abs(starts[0].rect[3] - starts[1].rect[3]) > 0.01 ||
    Math.abs(starts[0].height - starts[1].height) > 0.01 ||
    starts[0].rect[2] >= starts[1].rect[0]
  )
    return
  const mid = (starts[0].rect[0] + starts[0].rect[2] + starts[1].rect[0] + starts[1].rect[2]) / 4
  const columns = [
    [rect[0], rect[1], mid, rect[3]],
    [mid, rect[1], rect[2], rect[3]]
  ]
  const groups = columns.map((column, n) =>
    tokens.filter(
      (t) =>
        t.horizontal &&
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        Math.abs(t.height - starts[n].height) < 0.05 &&
        Math.abs(t.rect[3] - starts[n].rect[3]) < 0.01 &&
        t.rect[0] >= column[0] &&
        t.rect[2] <= column[2]
    )
  )
  if (
    groups.some(
      (g, n) =>
        !g.includes(starts[n]) ||
        g[0] !== starts[n] ||
        g.some((t) => t !== starts[n] && /^\([a-z]\)/.test(t.text.trim()))
    )
  )
    return
  const labels = groups.map((g) => union(g.map((t) => t.rect))),
    strip = [rect[0], rect[3], rect[2], Math.max(...labels.map((r) => r[3]))]
  if (
    captions.some((c) => c !== caption && intersection(c.rect, strip) > 0) ||
    tables.some((r) => intersection(r, strip) > 0) ||
    foreignOwns(strip)
  )
    return
  const source = groups.flat(),
    normalize = (s) => s.replace(/\s+/g, '')
  if (
    tokens.some(
      (t) =>
        t.rect?.every(Number.isFinite) && intersection(t.rect, strip) > 0 && !source.includes(t)
    ) ||
    page.lines.some((l) => {
      if (intersection(lineRect(l), strip) <= 0) return false
      return (
        normalize(
          source
            .filter((t) => intersection(t.rect, lineRect(l)) / area(t.rect) > 0.95)
            .map((t) => t.text)
            .join('')
        ) !== normalize(l.text)
      )
    })
  )
    return
  const graphics = (page.graphicsBounds ?? []).map((g) => ({
    kind: g.kind,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
  }))
  if (
    columns.some((column) => {
      const owned = graphics.filter(
        (g) =>
          area(g.rect) > 0 &&
          intersection(g.rect, rect) / area(g.rect) > 0.995 &&
          g.rect[0] >= column[0] &&
          g.rect[2] <= column[2]
      )
      if (
        !owned.length ||
        (owned.filter((g) => g.kind === 'path').length < 3 &&
          !owned.some((g) => g.kind === 'image'))
      )
        return true
      const b = union(owned.map((g) => g.rect))
      return (
        b[2] - b[0] < font * 6 ||
        b[3] - b[1] < font * 3 ||
        tables.some((t) => intersection(t, b) > 0)
      )
    })
  )
    return
  const keys = [...new Set([...caption.lines.join(' ').matchAll(/\(([a-z])\)/g)].map((m) => m[1]))]
  if (keys.length) {
    if (keys.join('') !== 'ab') return
  } else {
    const axisLabels = columns.map((column) => {
      const axis = tokens.filter(
        (t) =>
          t.horizontal &&
          t.rect?.every(Number.isFinite) &&
          t.rect[0] >= column[0] &&
          t.rect[2] <= column[2] &&
          t.rect[1] >= rect[3] - font * 3 &&
          t.rect[3] <= rect[3]
      )
      if (axis.filter((t) => /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim())).length < 4) return []
      return axis
        .filter(
          (t) =>
            /^\p{L}[\p{L}\sαβ]+$/u.test(t.text.trim()) &&
            t.text.length < 40 &&
            t.rect[1] >= rect[3] - font * 1.5
        )
        .map((t) => t.text.trim())
    })
    if (axisLabels.some((labels) => labels.length !== 1) || axisLabels[0][0] !== axisLabels[1][0])
      return
  }
  return labels
}

// Quantized PDF.js stroke bounds can overhang a table's actual last divider.
// Match one complete native segment and a uniquely recognized native
// ruled table; this is not a lower overlap threshold for arbitrary graphics.
export function nativeTableDividerGraphic(page, rect, tables, rules) {
  const ux = page.width / 256,
    uy = page.height / 256
  if (
    ![...rect, ux, uy].every(Number.isFinite) ||
    ux <= 0 ||
    uy <= 0 ||
    (rect[2] - rect[0] > ux * 2 + 0.01 && rect[3] - rect[1] > uy * 2 + 0.01)
  )
    return false
  const owners = tables.filter((table) => {
    const horizontals = rules.filter(
      (r) =>
        r[1] === r[3] &&
        // A refined crop can retain a small outer margin around the printed
        // fence. The source rules themselves must still share exact endpoints.
        Math.abs(r[0] - table[0]) <= ux * 2 &&
        Math.abs(r[2] - table[2]) <= ux * 2 &&
        r[1] >= table[1] - uy &&
        r[1] <= table[3] + 0.02
    )
    if (
      new Set(horizontals.map((r) => r[1])).size < 3 ||
      horizontals.some(
        (r) =>
          Math.abs(r[0] - horizontals[0][0]) > 0.02 || Math.abs(r[2] - horizontals[0][2]) > 0.02
      ) ||
      // Painted stroke margins can place the crop just below the rule's
      // centreline. This does not license a remotely closing table boundary.
      !horizontals.some((r) => Math.abs(r[1] - table[3]) <= Math.max(0.02, uy * 0.2))
    )
      return false
    const verticals = rules.filter(
      (r) =>
        r[0] === r[2] &&
        r[3] - r[1] >= uy * 2 &&
        r[0] >= table[0] &&
        r[0] <= table[2] &&
        r[1] >= table[1] - 0.02 &&
        r[3] <= table[3] + 0.02 &&
        r[0] >= rect[0] &&
        r[0] <= rect[2] &&
        r[1] >= rect[1] &&
        r[3] <= rect[3] &&
        r[0] - rect[0] <= ux * 2 &&
        rect[2] - r[0] <= ux * 2 &&
        r[1] - rect[1] <= uy * 2 &&
        rect[3] - r[3] <= uy * 2
    )
    const horizontal = horizontals.filter(
      (r) =>
        rect[3] - rect[1] <= uy * 2 + 0.01 &&
        r[0] >= rect[0] &&
        r[2] <= rect[2] &&
        r[1] >= rect[1] &&
        r[1] <= rect[3] &&
        r[0] - rect[0] <= ux * 2 &&
        rect[2] - r[2] <= ux * 2 &&
        r[1] - rect[1] <= uy * 2 &&
        rect[3] - r[1] <= uy * 2
    )
    return verticals.length + horizontal.length === 1
  })
  return owners.length === 1
}

// Restore only a visible filled upper boundary from one mixed-image Form.
// The Form establishes ownership; its BBox is a clip, never recovered paint.
export function nativeOwnedFormPaintBounds(page, caption, captions, tables, rect, context) {
  const nums = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) && a.length === n && a.every(Number.isFinite)
  const valid = (r) => nums(r, 4) && r[2] > r[0] && r[3] > r[1]
  const o = context?.operators,
    v = context?.viewport
  if (
    !valid(rect) ||
    !valid(caption?.rect) ||
    !nums(v?.transform, 6) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000
  )
    return
  const font = Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
  if (!(font > 0) || !Number.isFinite(font)) return
  let s = {
      m: [1, 0, 0, 1, 0, 0],
      clip: [0, 0, page.width, page.height],
      fill: '#000000',
      stroke: '#000000',
      ca: 1,
      CA: 1,
      safe: true,
      width: 1,
      form: null
    },
    pending = false
  const stack = [],
    forms = [],
    paints = [],
    images = []
  const box = (b) => {
    const m = Util.transform(v.transform, s.m),
      ps = [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]]
      ]
    for (const p of ps) Util.applyTransform(p, m)
    return [
      Math.min(...ps.map((p) => p[0])),
      Math.min(...ps.map((p) => p[1])),
      Math.max(...ps.map((p) => p[0])),
      Math.max(...ps.map((p) => p[1]))
    ]
  }
  const clipped = (b) => [
    Math.max(b[0], s.clip[0]),
    Math.max(b[1], s.clip[1]),
    Math.min(b[2], s.clip[2]),
    Math.min(b[3], s.clip[3])
  ]
  const ignored = new Set([
    OPS.dependency,
    OPS.beginText,
    OPS.endText,
    OPS.setFont,
    OPS.setTextMatrix,
    OPS.moveText,
    OPS.showText,
    OPS.setCharSpacing,
    OPS.setWordSpacing,
    OPS.setHScale,
    OPS.setLeading,
    OPS.setTextRenderingMode,
    OPS.setTextRise,
    OPS.nextLine,
    OPS.setLeadingMoveText,
    OPS.beginMarkedContent,
    OPS.beginMarkedContentProps,
    OPS.endMarkedContent,
    OPS.setLineCap,
    OPS.setLineJoin,
    OPS.setMiterLimit,
    OPS.setDash,
    OPS.setRenderingIntent,
    OPS.setFlatness
  ])
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save) stack.push({ state: structuredClone(s), form: false })
    else if (op === OPS.paintFormXObjectBegin) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        !valid(a[1]) ||
        (a[0] !== null && !nums(a[0], 6)) ||
        s.form !== null
      )
        return
      stack.push({ state: structuredClone(s), form: true })
      if (a[0]) s.m = Util.transform(s.m, a[0])
      if (s.m[1] !== 0 || s.m[2] !== 0) return
      const bounds = clipped(box(a[1]))
      if (!valid(bounds)) return
      s.form = forms.length
      s.clip = bounds
      forms.push({ start: i, end: null, rect: bounds })
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const saved = stack.pop()
      if (!saved || saved.form !== (op === OPS.paintFormXObjectEnd) || pending) return
      if (saved.form) forms[s.form].end = i
      s = saved.state
    } else if (op === OPS.transform) {
      if (!nums(a, 6)) return
      s.m = Util.transform(s.m, a)
      if (!s.m.every(Number.isFinite)) return
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      const color = a?.[0]
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return
      s[op === OPS.setFillRGBColor ? 'fill' : 'stroke'] = color.toLowerCase()
    } else if (op === OPS.setTextRenderingMode) {
      if (!Number.isInteger(a?.[0]) || a[0] < 0 || a[0] > 3) return
    } else if (op === OPS.setFillColorN) s.fill = null
    else if (op === OPS.setStrokeColorN) s.stroke = null
    else if (op === OPS.setLineWidth) {
      if (!Number.isFinite(a?.[0]) || a[0] < 0) return
      s.width = a[0]
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0])) return
      for (const [k, value] of a[0]) {
        if (k === 'ca' || k === 'CA') {
          if (!Number.isFinite(value) || value < 0 || value > 1) return
          s[k] = value
        } else if (k === 'BM') {
          if (value !== 'source-over') s.safe = false
        } else if (k === 'SMask') {
          if (value !== false) s.safe = false
        } else if (k === 'LW') {
          if (!Number.isFinite(value) || value < 0) return
          s.width = value
        } else if (!['LC', 'LJ', 'ML', 'D', 'RI', 'FL'].includes(k)) return
      }
    } else if (op === OPS.clip || op === OPS.eoClip) {
      if (pending) return
      pending = true
    } else if (op === OPS.constructPath) {
      if (!Array.isArray(a) || !nums(a[2], 4) || !Array.isArray(a[1]) || a[1].length !== 1) return
      const p = Array.from(a[1][0] ?? []),
        points = [],
        b = [Infinity, Infinity, -Infinity, -Infinity]
      let closed = false,
        current,
        start
      for (let n = 0; n < p.length;) {
        const c = p[n++],
          count = c === 0 || c === 1 ? 2 : c === 2 ? 6 : c === 4 ? 0 : -1
        if (
          count < 0 ||
          n + count > p.length ||
          p.slice(n, n + count).some((x) => !Number.isFinite(x))
        )
          return
        if (c === 4) {
          if (!current || !start) return
          closed = true
          current = start
        } else if (c === 2) {
          if (!current) return
          Util.bezierBoundingBox(...current, ...p.slice(n, n + 6), b)
          current = p.slice(n + 4, n + 6)
        } else {
          if (c === 1 && !current) return
          current = p.slice(n, n + 2)
          if (c === 0) start = current
          points.push(current)
          b[0] = Math.min(b[0], current[0])
          b[1] = Math.min(b[1], current[1])
          b[2] = Math.max(b[2], current[0])
          b[3] = Math.max(b[3], current[1])
        }
        n += count
      }
      if (!points.length) return
      if (b.some((z, n) => Math.abs(z - a[2][n]) > 0.001)) return
      if (pending) {
        if (
          a[0] !== OPS.endPath ||
          p.length !== 13 ||
          !closed ||
          s.m[1] !== 0 ||
          s.m[2] !== 0 ||
          points.length !== 4 ||
          new Set(points.map((q) => q[0])).size !== 2 ||
          new Set(points.map((q) => q[1])).size !== 2 ||
          points.some((q, n) => q[0] !== points[(n + 1) % 4][0] && q[1] !== points[(n + 1) % 4][1])
        )
          return
        s.clip = clipped(box(b))
        pending = false
        continue
      }
      if (a[0] === OPS.endPath) continue
      const filled = a[0] === OPS.fill || a[0] === OPS.eoFill,
        stroked = a[0] === OPS.stroke
      if (!filled && !stroked) return
      let r = box(b)
      if (stroked) {
        const w = s.width * Math.max(Math.hypot(s.m[0], s.m[1]), Math.hypot(s.m[2], s.m[3])) * 5
        r = [r[0] - w, r[1] - w, r[2] + w, r[3] + w]
      }
      r = clipped(r)
      if (valid(r))
        paints.push({
          i,
          rect: r,
          form: s.form,
          fill: filled,
          closed,
          color: filled ? s.fill : s.stroke,
          opaque: s.safe && (filled ? s.ca : s.CA) === 1
        })
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const r = clipped(box([0, 0, 1, 1]))
      if (
        !valid(r) ||
        !s.safe ||
        s.ca !== 1 ||
        !((s.m[1] === 0 && s.m[2] === 0) || (s.m[0] === 0 && s.m[3] === 0))
      )
        return
      images.push({ i, rect: r, form: s.form })
    } else if (!ignored.has(op)) return
  }
  if (stack.length || pending) return
  const recorded = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => ({
      i: g.operationIndex,
      rect: g.normalizedRect?.map((x, n) => x * (n % 2 ? page.height : page.width))
    }))
  const epsilon = Math.max(page.width, page.height) / 128
  if (
    images.some(
      (im) =>
        recorded.filter(
          (g) =>
            g.i === im.i &&
            valid(g.rect) &&
            g.rect.every((x, n) => Math.abs(x - im.rect[n]) <= epsilon)
        ).length !== 1
    )
  )
    return
  const owners = forms
    .map((f, n) => ({ f, n, images: images.filter((im) => im.form === n) }))
    .filter(
      ({ f, images: ims }) =>
        f.end !== null &&
        ims.length >= 2 &&
        ims.every((im) => intersection(im.rect, rect) / area(im.rect) > 0.5) &&
        ims.filter((im) => intersection(im.rect, rect) / area(im.rect) > 0.9).length >= 2 &&
        f.rect[3] < caption.rect[1] &&
        caption.rect[1] - f.rect[3] < font * 3 &&
        Math.min(f.rect[2], caption.rect[2]) - Math.max(f.rect[0], caption.rect[0]) >
          Math.min(f.rect[2] - f.rect[0], caption.rect[2] - caption.rect[0]) * 0.7
    )
  if (owners.length !== 1) return
  const { n } = owners[0],
    candidates = paints.filter(
      (p) =>
        p.form === n &&
        p.fill &&
        p.closed &&
        p.opaque &&
        p.color &&
        p.color !== '#ffffff' &&
        p.rect[1] < rect[1] &&
        p.rect[3] > rect[1] &&
        p.rect[2] - p.rect[0] > font * 6 &&
        p.rect[3] - p.rect[1] > font * 4 &&
        p.rect[0] >= rect[0] - font * 2 &&
        p.rect[2] <= rect[2] + font * 2
    )
  if (!candidates.length) return
  const top = Math.min(...candidates.map((p) => p.rect[1])),
    edgeOwners = candidates.filter((p) => Math.abs(p.rect[1] - top) < 0.01)
  if (
    edgeOwners.some((p) =>
      paints.some(
        (q) =>
          q.i > p.i &&
          (!q.opaque || !q.color || q.color === '#ffffff' || q.form !== n) &&
          intersection(q.rect, [p.rect[0], top, p.rect[2], top + 0.01]) > 0
      )
    )
  )
    return
  const result = [rect[0], top, rect[2], rect[3]],
    added = [rect[0], top, rect[2], rect[1]]
  if (
    tables.some((t) => intersection(t, result) > 0) ||
    captions.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, result) > 0
    ) ||
    page.lines.some((l) => l.text?.length > 60 && intersection(lineRect(l), added) > 0)
  )
    return
  return result
}

// Complete physical source boxes from a clipped, repeated raster label row.
// The row touches the cropped image edge (within one tenth of its em height);
// this cannot claim a detached row farther down in the caption gap.
function nativeCutRasterLabelRow(page, caption, captions, tables, rect, tokens, foreignOwns) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (!valid(rect)) return []
  const source = tokens.filter((t) => t.text.trim())
  if (
    source.some(
      (t) =>
        !valid(t.rect) ||
        !Number.isFinite(t.height) ||
        t.height <= 0 ||
        !Number.isFinite(t.baseline)
    )
  )
    return []
  const row = source.filter(
    (t) =>
      t.horizontal &&
      t.rect[1] < rect[3] + t.height * 0.1 &&
      t.rect[3] > rect[3] &&
      t.rect[0] >= rect[0] &&
      t.rect[2] <= rect[2] &&
      t.height <= 24
  )
  if (
    row.length < 3 ||
    row.some(
      (t) =>
        t.text.length > 45 ||
        /[.!?]$/.test(t.text.trim()) ||
        Math.abs(t.height - row[0].height) > row[0].height * 0.1 ||
        Math.abs(t.baseline - row[0].baseline) > row[0].height * 0.1 ||
        foreignOwns(t.rect)
    )
  )
    return []
  const h = row[0].height,
    images = (page.graphicsBounds ?? [])
      .filter((g) => g.kind === 'image' && g.imageHash)
      .map((g) => g.normalizedRect?.map((x, n) => x * (n % 2 ? page.height : page.width)))
      .filter(
        (r) =>
          valid(r) &&
          r[2] - r[0] > h * 3 &&
          r[3] - r[1] > h * 3 &&
          Math.abs(r[3] - rect[3]) < h + page.height / 128 &&
          intersection(r, rect) / area(r) > 0.85
      )
  if (images.length < 2) return []
  const owners = row.map((t) =>
    images.filter(
      (r) =>
        t.rect[0] >= r[0] && t.rect[2] <= r[2] && Math.abs(t.rect[1] - r[3]) < h + page.height / 128
    )
  )
  if (owners.some((a) => a.length !== 1) || images.some((im) => !owners.some((a) => a[0] === im)))
    return []
  const groups = []
  for (const t of row.slice().sort((a, b) => a.rect[0] - b.rect[0])) {
    const prev = groups.at(-1)
    if (prev && t.rect[0] - prev.at(-1).rect[2] < h * 0.5) prev.push(t)
    else groups.push([t])
  }
  if (groups.length < 3 || groups.some((g) => g.map((t) => t.text).join('').length > 45)) return []
  const count = images.map((im) => groups.filter((g) => owners[row.indexOf(g[0])][0] === im).length)
  if (count.some((n) => n !== count[0])) return []
  const added = [rect[0], rect[3], rect[2], Math.max(...row.map((t) => t.rect[3]))]
  if (
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, added) > 0) ||
    tables.some((t) => intersection(t, added) > 0) ||
    source.some((t) => !row.includes(t) && intersection(t.rect, added) > 0)
  )
    return []
  return row.map((t) => t.rect)
}
