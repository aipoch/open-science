/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'

const finiteRect = (rect) =>
  rect?.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const contains = (outer, inner) =>
  inner[0] >= outer[0] - 0.001 &&
  inner[2] <= outer[2] + 0.001 &&
  inner[1] >= outer[1] - 0.001 &&
  inner[3] <= outer[3] + 0.001
const coversRect = (outer, inner) =>
  inner[0] >= outer[0] && inner[2] <= outer[2] && inner[1] >= outer[1] && inner[3] <= outer[3]
const validToken = (t) =>
  t.horizontal &&
  finiteRect(t.rect) &&
  Number.isFinite(t.baseline) &&
  t.height > 0 &&
  Number.isFinite(t.height)
const lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
const validLine = (l) =>
  [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
  l.width > 0 &&
  l.height > 0 &&
  l.fontSize > 0
const compact = (text) => text.trim().replace(/\s+/gu, ' ')
const glyphs = (parts) =>
  [
    ...parts
      .map((p) => p.text)
      .join('')
      .replace(/\s/gu, '')
  ]
    .sort()
    .join('')

// Page/caption coordinates are scale 1; native tokens retain their source viewport
// scale. Only original single-letter glyph widths establish accent ownership.
function recoverOverlayLines(page, caption, nativeTokens, scale = 1.5, proof) {
  if (
    !(scale > 0) ||
    !Number.isFinite(scale) ||
    !finiteRect(caption.rect) ||
    page.pageNumber !== caption.page ||
    !captionKind(caption.lines?.[0] ?? '') ||
    !caption.lines?.length
  )
    return
  const starts = page.lines.filter(
    (l) =>
      validLine(l) &&
      (proof ? contains(caption.rect, lineRect(l)) : Math.abs(l.x - caption.rect[0]) < 0.001) &&
      Math.abs(l.y - caption.rect[1]) < 0.001 &&
      caption.lines[0].startsWith(l.text)
  )
  if (!starts.length || (proof && starts.length !== 1)) return
  const first = starts[0]
  const em = first.fontSize,
    frame = [caption.rect[0], caption.rect[1] - em * 0.35, caption.rect[2], caption.rect[3]]
  const sourceFrame = frame.map((x) => x * scale)
  const source = nativeTokens.filter(
    (t) => t.text.trim() && (!finiteRect(t.rect) || intersects(t.rect, sourceFrame))
  )
  if (source.some((t) => !validToken(t) || !contains(sourceFrame, t.rect))) return
  const accents = source.filter((t) => /^[ˆ¯]$/u.test(t.text))
  if (!accents.length) return
  if (proof && (accents.length !== 1 || accents[0].text !== 'ˆ')) return
  const geometry = page.lines.filter(
    (l) => l.text.trim() && (!validLine(l) || intersects(lineRect(l), frame))
  )
  if (geometry.some((l) => !validLine(l) || !contains(frame, lineRect(l)))) return
  // A native run may end in a real whitespace advance that overlaps the next
  // letter's font box. Require complete literal coverage instead of treating
  // that blank advance as foreign ink or estimating its glyph width.
  if (glyphs(source) !== glyphs(geometry)) return
  const result = [...caption.lines],
    assignments = new Set(),
    owners = new Set()
  let changed = false
  for (const accent of accents) {
    const center = (accent.rect[0] + accent.rect[2]) / 2
    const matches = source.filter(
      (base) =>
        base !== accent &&
        /^\p{L}$/u.test(base.text) &&
        Math.abs(base.height - accent.height) < 0.001 &&
        Math.abs(base.height / scale - em) < 0.001 &&
        base.baseline - accent.baseline >= base.height * 0.15 &&
        base.baseline - accent.baseline <= base.height * 0.35 &&
        center >= base.rect[0] &&
        center <= base.rect[2] &&
        accent.rect[0] >= base.rect[0] - 0.001 &&
        accent.rect[2] <= base.rect[2] + 0.001 &&
        accent.rect[2] - accent.rect[0] <= base.height * 0.7
    )
    if (matches.length !== 1 || owners.has(matches[0])) return
    const owner = matches[0]
    if (proof && !proof.visiblePair(accent, owner)) return
    owners.add(owner)
    const fragments = geometry.filter(
      (l) =>
        l.text.startsWith(owner.text) &&
        Math.abs(l.x - owner.rect[0] / scale) < 0.001 &&
        Math.abs(l.y - owner.rect[1] / scale) < 0.001 &&
        Math.abs(l.fontSize - em) < 0.001
    )
    if (fragments.length !== 1 || assignments.has(fragments[0])) return
    const fragment = fragments[0]
    assignments.add(fragment)
    const row = geometry
      .filter(
        (l) =>
          !/^[ˆ¯]$/u.test(l.text) &&
          (proof
            ? Math.abs(l.y - fragment.y) < em * 0.02 && l.fontSize >= em * 0.65 && l.fontSize <= em
            : Math.abs(l.y - fragment.y) < 0.001)
      )
      .sort((a, b) => a.x - b.x)
    if (proof) {
      const left = Math.min(...row.map((l) => l.x)),
        right = Math.max(...row.map((l) => l.x + l.width))
      if (
        Math.abs((left + right) / 2 - (caption.rect[0] + caption.rect[2]) / 2) > 0.01 ||
        !proof.orderedRow(row, fragment, em)
      )
        return
    }
    const literal = (text) => (proof ? text.normalize('NFKC').replace(/\s/gu, '') : compact(text))
    const rowText = literal(row.map((l) => l.text).join(' '))
    const rows = result.flatMap((text, index) => {
      const original = text.replaceAll(accent.text + owner.text, owner.text)
      return literal(original) === rowText ? [index] : []
    })
    if (rows.length !== 1) return
    const index = rows[0],
      text = result[index],
      start = text.indexOf(fragment.text)
    if (start < 0 || text.indexOf(fragment.text, start + 1) >= 0) return
    if (start > 0 && text[start - 1] === accent.text) continue
    result[index] = text.slice(0, start) + accent.text + text.slice(start)
    changed = true
  }
  return changed ? result : undefined
}

// The existing geometry-only contract is unchanged. A centered first line and
// an already accepted small script need a separate original-provider proof.
export function recoverNativeCaptionOverlayAccentLines(page, caption, tokens, scale = 1.5, source) {
  const legacy = recoverOverlayLines(page, caption, tokens, scale)
  if (legacy || !source) return legacy
  try {
    const proof = originalCaptionProof(page, caption, tokens, scale, source)
    return proof && recoverOverlayLines(page, caption, tokens, scale, proof)
  } catch {
    return undefined
  }
}

function demand(value) {
  if (!value) throw new Error('incomplete original caption evidence')
}
function plainEvidence(value, active = new Set(), budget = { n: 0 }, depth = 0) {
  demand(++budget.n <= 2000000 && depth <= 48)
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return
  if (typeof value === 'number') {
    demand(Number.isFinite(value))
    return
  }
  demand(typeof value === 'object' && !active.has(value))
  if (ArrayBuffer.isView(value)) {
    demand(
      Object.getPrototypeOf(value) === Float32Array.prototype ||
        Object.getPrototypeOf(value) === Float64Array.prototype
    )
    const keys = Reflect.ownKeys(value)
    demand(keys.every((k) => typeof k === 'string' && /^(0|[1-9]\d*)$/u.test(k)))
    demand(
      value.length <= 8192 &&
        keys.length === value.length &&
        keys.every(
          (k) => typeof k === 'string' && /^(0|[1-9]\d*)$/u.test(k) && Number(k) < value.length
        )
    )
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key)
      demand(d.enumerable && 'value' in d && Number.isFinite(d.value))
    }
    return
  }
  demand(
    Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
  )
  active.add(value)
  const keys = Reflect.ownKeys(value)
  if (Array.isArray(value))
    demand(
      keys.length === value.length + 1 &&
        keys.every(
          (k) =>
            k === 'length' ||
            (typeof k === 'string' && /^(0|[1-9]\d*)$/u.test(k) && Number(k) < value.length)
        )
    )
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue
    const d = Object.getOwnPropertyDescriptor(value, key)
    demand(typeof key === 'string' && d.enumerable && 'value' in d)
    plainEvidence(d.value, active, budget, depth + 1)
  }
  active.delete(value)
}
const sameRect = (a, b) =>
  finiteRect(a) && finiteRect(b) && a.every((v, k) => Math.abs(v - b[k]) < 0.000001)
const cover = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const axisMatrix = (m) =>
  Array.isArray(m) &&
  m.length === 6 &&
  m.every(Number.isFinite) &&
  m[0] > 0 &&
  m[3] > 0 &&
  m[1] === 0 &&
  m[2] === 0
const normalizedLiteral = (s) => s.normalize('NFKC').replace(/\s/gu, '')
function outlineEvidence(path, transform) {
  demand(Array.isArray(path) && path.length <= 8192 && path.every(Number.isFinite))
  let i = 0,
    at,
    start,
    segments = [],
    points = [],
    area = 0,
    contours = 0,
    magnitude = 0,
    terms = 0,
    origin
  const segmentArea = (ps) => {
    const weights =
      ps.length === 2
        ? [1]
        : ps.length === 3
          ? [2 / 3, 1 / 3, 2 / 3]
          : [0.6, 0.3, 0.1, 0.3, 0.3, 0.6]
    let k = 0
    for (let i = 0; i < ps.length - 1; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i],
          b = ps[j],
          weight = weights[k++],
          ax = a[0] - origin[0],
          ay = a[1] - origin[1],
          bx = b[0] - origin[0],
          by = b[1] - origin[1]
        area += weight * (ax * by - ay * bx)
        magnitude +=
          Math.abs(weight) *
          ((Math.abs(a[0]) + Math.abs(origin[0])) * (Math.abs(b[1]) + Math.abs(origin[1])) +
            (Math.abs(a[1]) + Math.abs(origin[1])) * (Math.abs(b[0]) + Math.abs(origin[0])))
        terms++
      }
  }
  const finish = () => {
    if (!at) return
    demand(at[0] === start[0] && at[1] === start[1])
    const hull = segments.flat()
    // A move-only or collinear fill has no area. A zero signed-area closed
    // curve can still paint; retain its hull as possible later coverage.
    if (
      hull.length &&
      Math.min(...hull.map((p) => p[0])) < Math.max(...hull.map((p) => p[0])) &&
      Math.min(...hull.map((p) => p[1])) < Math.max(...hull.map((p) => p[1]))
    ) {
      points.push(...hull.map(transform))
      for (const segment of segments) segmentArea(segment)
      contours++
    }
    at = start = undefined
    segments = []
  }
  const point = () => {
    demand(i + 2 <= path.length)
    return [path[i++], path[i++]]
  }
  while (i < path.length) {
    const op = path[i++]
    demand([0, 1, 2, 3, 4].includes(op))
    if (op === 0) {
      finish()
      at = point()
      start = at
      origin ??= at
    } else if (op === 4) {
      demand(at)
      segments.push([at, start])
      at = start
      finish()
    } else {
      demand(at)
      const next = Array.from({ length: op === 1 ? 1 : op === 2 ? 3 : 2 }, point)
      segments.push([at, ...next])
      at = next.at(-1)
    }
  }
  finish()
  const rect = points.length ? cover(points.map((p) => [p[0], p[1], p[0], p[1]])) : undefined
  if (rect) demand(rect.every(Number.isFinite))
  const error = 64 * (terms + 1) * (Number.EPSILON * magnitude + Number.MIN_VALUE)
  return {
    rect,
    nonzeroArea:
      contours > 0 && Number.isFinite(area) && Number.isFinite(error) && Math.abs(area) > error
  }
}
function originalCaptionProof(page, caption, tokens, scale, source) {
  plainEvidence(source)
  plainEvidence(tokens)
  plainEvidence(page)
  plainEvidence(caption)
  demand(scale > 0 && Number.isFinite(scale) && caption.page === page.pageNumber)
  const { content, operators, viewport, fonts, glyphPaths } = source
  demand(Reflect.ownKeys(source).length === 5 && [content, operators, viewport].every(Boolean))
  demand(
    Array.isArray(fonts) &&
      fonts.length > 0 &&
      fonts.length <= 64 &&
      Array.isArray(glyphPaths) &&
      glyphPaths.length <= 4096
  )
  demand(
    Array.isArray(content.items) &&
      content.items.length <= 10000 &&
      Array.isArray(operators.fnArray) &&
      Array.isArray(operators.argsArray) &&
      operators.fnArray.length === operators.argsArray.length &&
      operators.fnArray.length <= 30000
  )
  const v = viewport.transform
  demand(
    Array.isArray(v) &&
      v.length === 6 &&
      v[0] === scale &&
      v[1] === 0 &&
      v[2] === 0 &&
      v[3] === -scale &&
      v[4] === 0 &&
      v[5] === viewport.height &&
      viewport.width === page.width * scale &&
      viewport.height === page.height * scale
  )
  const byFont = new Map(),
    byPath = new Map()
  for (const font of fonts) {
    demand(
      Reflect.ownKeys(font).length === 6 &&
        typeof font.id === 'string' &&
        !byFont.has(font.id) &&
        ['missingFile', 'isType3Font', 'vertical', 'remeasure'].every((k) => font[k] === false) &&
        Array.isArray(font.fontMatrix) &&
        font.fontMatrix.length === 6 &&
        font.fontMatrix.every((n, k) => n === [0.001, 0, 0, 0.001, 0, 0][k])
    )
    byFont.set(font.id, font)
  }
  demand(
    Object.keys(content.styles).length === byFont.size &&
      Object.keys(content.styles).every((id) => byFont.has(id))
  )
  let pathValues = 0
  for (const p of glyphPaths) {
    demand(
      Reflect.ownKeys(p).length === 2 &&
        typeof p.id === 'string' &&
        !byPath.has(p.id) &&
        Array.isArray(p.path) &&
        (pathValues += p.path.length) <= 1000000
    )
    byPath.set(p.id, p.path)
  }
  let state = {
    ctm: [1, 0, 0, 1, 0, 0],
    matrix: [1, 0, 0, 1, 0, 0],
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    font: undefined,
    size: 0,
    fill: '#000000',
    stroke: '#000000',
    lineWidth: 1,
    inText: false
  }
  const stack = [],
    glyphs = [],
    units = [],
    paints = []
  const transform = (p, s = state) => {
    const q = [...p]
    Util.applyTransform(q, Util.transform(v, Util.transform(s.ctm, s.matrix)))
    return q
  }
  const color = (a) => {
    demand(Array.isArray(a) && a.length === 1 && /^#[0-9a-f]{6}$/iu.test(a[0]))
    return a[0].toLowerCase()
  }
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n],
      a = operators.argsArray[n]
    if (op === OPS.dependency) {
      demand(Array.isArray(a) && a.every((id) => byFont.has(id)))
      continue
    }
    if (op === OPS.save) stack.push(structuredClone(state))
    else if (op === OPS.restore) {
      demand(stack.length)
      state = stack.pop()
    } else if (op === OPS.transform) {
      demand(axisMatrix(a))
      state.ctm = Util.transform(state.ctm, a)
    } else if (op === OPS.setLineWidth) {
      demand(a.length === 1 && a[0] > 0)
      state.lineWidth = a[0]
    } else if (op === OPS.setLineCap) demand(a.length === 1 && a[0] === 0)
    else if (op === OPS.setDash)
      demand(a.length === 2 && Array.isArray(a[0]) && a[0].length === 0 && a[1] === 0)
    else if (op === OPS.setFillRGBColor) state.fill = color(a)
    else if (op === OPS.setStrokeRGBColor) state.stroke = color(a)
    else if (op === OPS.beginText) {
      demand(!state.inText)
      state.inText = true
      state.matrix = [1, 0, 0, 1, 0, 0]
      state.x = state.y = state.lineX = state.lineY = 0
    } else if (op === OPS.endText) {
      demand(state.inText)
      state.inText = false
    } else if (op === OPS.setFont) {
      demand(a.length === 2 && byFont.has(a[0]) && a[1] > 0)
      state.font = a[0]
      state.size = a[1]
    } else if (op === OPS.setTextMatrix) {
      demand(a.length === 1 && axisMatrix(a[0]))
      state.matrix = Array.from(a[0])
      state.x = state.y = state.lineX = state.lineY = 0
    } else if (op === OPS.moveText) {
      demand(a.length === 2)
      state.x = state.lineX += a[0]
      state.y = state.lineY += a[1]
    } else if (op === OPS.showText) {
      demand(state.inText && state.font && state.size > 0 && a.length === 1 && Array.isArray(a[0]))
      for (const g of a[0]) {
        if (typeof g === 'number') {
          state.x -= (g * state.size) / 1000
          continue
        }
        demand(
          typeof g.unicode === 'string' &&
            g.unicode.length > 0 &&
            typeof g.fontChar === 'string' &&
            g.fontChar.length > 0 &&
            g.accent === null &&
            g.operatorListId === undefined &&
            g.vmetric === undefined &&
            g.width >= 0
        )
        const text = normalizedLiteral(g.unicode),
          width = (g.width * state.size) / 1000,
          point = transform([state.x, state.y]),
          end = transform([state.x + width, state.y + state.size]),
          rect = [point[0], end[1], end[0], point[1]]
        let ink
        if (g.isInFont === true) {
          const path = byPath.get(`${state.font}_path_${g.fontChar}`)
          demand(path)
          ink = outlineEvidence(path, (p) =>
            transform([state.x + p[0] * state.size, state.y + p[1] * state.size])
          )
        } else demand(g.isInFont === false && !text)
        if (text) demand(ink?.rect && finiteRect(rect))
        const glyph = {
          text,
          font: state.font,
          rect,
          ink: ink?.rect,
          nonzeroArea: ink?.nonzeroArea,
          fill: state.fill,
          operation: n,
          order: paints.length
        }
        glyphs.push(glyph)
        for (const char of text) units.push({ char, glyph })
        if (ink?.rect) paints.push({ operation: n, order: paints.length, rect: ink.rect, glyph })
        state.x += width
      }
    } else if (op === OPS.constructPath) {
      demand(
        a.length === 3 && [OPS.stroke, OPS.fill, OPS.eoFill].includes(a[0]) && a[1].length === 1
      )
      const p = Array.from(a[1][0]),
        points = []
      let i = 0
      if (a[0] === OPS.stroke)
        demand(p.length === 6 && p[0] === 0 && p[3] === 1 && (p[1] === p[4] || p[2] === p[5]))
      while (i < p.length) {
        const command = p[i++],
          count =
            command === 0 || command === 1
              ? 2
              : command === 2
                ? 6
                : command === 3
                  ? 4
                  : command === 4
                    ? 0
                    : -1
        demand(count >= 0 && i + count <= p.length)
        for (let k = 0; k < count; k += 2) points.push([p[i + k], p[i + k + 1]])
        i += count
      }
      demand(points.length)
      const bounds = cover(points.map((q) => [...q, ...q]))
      demand(a[2].length === 4 && bounds.every((x, k) => Math.abs(x - a[2][k]) < 1e-7))
      const matrix = Util.transform(v, state.ctm),
        trans = points.map((p) => {
          const q = [...p]
          Util.applyTransform(q, matrix)
          return q
        }),
        r = cover(trans.map((p) => [...p, ...p]))
      if (a[0] === OPS.stroke) {
        const dx = (state.lineWidth * Math.abs(matrix[0])) / 2,
          dy = (state.lineWidth * Math.abs(matrix[3])) / 2
        r[0] -= dx
        r[1] -= dy
        r[2] += dx
        r[3] += dy
      }
      demand(r.every(Number.isFinite))
      // Only a single closed rectangle proves opaque coverage. Other path
      // hulls remain exclusion bounds, including strokes and curved fills.
      const rectangle =
        a[0] !== OPS.stroke &&
        p.length === 13 &&
        p[0] === 0 &&
        p[3] === 1 &&
        p[6] === 1 &&
        p[9] === 1 &&
        p[12] === 4 &&
        points.length === 4 &&
        finiteRect(bounds) &&
        new Set(points.map(([x, y]) => `${x},${y}`)).size === 4 &&
        points.every(([x, y], k) => {
          const next = points[(k + 1) % 4]
          return (
            (x === bounds[0] || x === bounds[2]) &&
            (y === bounds[1] || y === bounds[3]) &&
            (x === next[0] || y === next[1])
          )
        })
      if (finiteRect(r))
        paints.push({
          operation: n,
          order: paints.length,
          rect: r,
          ...(rectangle ? { rectangleFill: state.fill } : {})
        })
    } else demand(false) // Unknown opacity, clips, masks, forms, images or text modes refuse.
  }
  demand(stack.length === 0 && !state.inText)
  const byItem = new Map()
  let offset = 0
  for (let index = 0; index < content.items.length; index++) {
    const raw = content.items[index]
    demand(typeof raw.str === 'string')
    const text = normalizedLiteral(raw.str),
      count = Array.from(text).length,
      part = units.slice(offset, offset + count)
    offset += count
    demand(
      part.map((p) => p.char).join('') === text && part.every((p) => p.glyph.font === raw.fontName)
    )
    demand(
      raw.sourceItem?.pageNumber === page.pageNumber &&
        raw.sourceItem.index === index &&
        raw.sourceItem.text === raw.str
    )
    if (part.length) {
      demand(raw.dir === 'ltr' && axisMatrix(raw.transform) && raw.height > 0)
      const start = [raw.transform[4], raw.transform[5]]
      Util.applyTransform(start, v)
      demand(
        part.every(
          (p) =>
            Math.abs(p.glyph.rect[3] - p.glyph.rect[1] - raw.height * scale) < 1e-6 &&
            Math.abs(p.glyph.rect[3] - start[1]) < 1e-6
        )
      )
      if (!/^\s/u.test(raw.str)) demand(Math.abs(part[0].glyph.rect[0] - start[0]) < 1e-6)
    }
    byItem.set(index, { raw, glyphs: [...new Set(part.map((p) => p.glyph))] })
  }
  demand(offset === units.length)
  const seen = new Set(),
    tokenGlyphs = new Map()
  for (const token of tokens) {
    const item = byItem.get(token.sourceItem?.index)
    demand(
      item &&
        !seen.has(token.sourceItem.index) &&
        token.sourceItem.pageNumber === page.pageNumber &&
        token.sourceItem.text === item.raw.str &&
        token.text === item.raw.str
    )
    seen.add(token.sourceItem.index)
    const raw = item.raw,
      t = raw.transform
    demand(
      raw.dir === 'ltr' &&
        Array.isArray(t) &&
        t.length === 6 &&
        t[0] > 0 &&
        t[3] > 0 &&
        t[1] === 0 &&
        t[2] === 0
    )
    const start = [t[4], t[5]],
      finish = [t[4] + raw.width, t[5] + raw.height]
    Util.applyTransform(start, v)
    Util.applyTransform(finish, v)
    demand(
      sameRect(token.rect, [start[0], finish[1], finish[0], start[1]]) &&
        token.horizontal === true &&
        Math.abs(token.baseline - start[1]) < 1e-6 &&
        Math.abs(token.height - raw.height * scale) < 1e-6
    )
    tokenGlyphs.set(token, item.glyphs)
  }
  return {
    visiblePair(accent, owner) {
      const a = tokenGlyphs.get(accent),
        b = tokenGlyphs.get(owner)
      if (a?.length !== 1 || b?.length !== 1) return false
      const pair = [a[0], b[0]]
      if (!sameRect(a[0].rect, accent.rect) || !sameRect(b[0].rect, owner.rect)) return false
      if (
        pair.some(
          (g) =>
            !g.nonzeroArea ||
            g.fill !== '#000000' ||
            !finiteRect(g.ink) ||
            !contains([0, 0, viewport.width, viewport.height], g.ink)
        ) ||
        intersects(a[0].ink, b[0].ink) ||
        a[0].ink[3] >= b[0].ink[1] ||
        a[0].ink[0] < b[0].ink[0] ||
        a[0].ink[2] > b[0].ink[2]
      )
        return false
      return pair.every((g) => {
        const background = paints
          .filter(
            (p) => p.order < g.order && p.rectangleFill === g.fill && coversRect(p.rect, g.ink)
          )
          .at(-1)
        if (background) {
          const restoration = paints
            .filter(
              (p) => p.order > background.order && p.order < g.order && intersects(p.rect, g.ink)
            )
            .at(-1)
          if (
            !restoration?.rectangleFill ||
            restoration.rectangleFill === g.fill ||
            !coversRect(restoration.rect, background.rect)
          )
            return false
        }
        return !paints.some((p) => p.order > g.order && p.glyph !== g && intersects(p.rect, g.ink))
      })
    },
    orderedRow(row, fragment, em) {
      const baseline = tokens.filter(
        (t) =>
          Math.abs(t.rect[1] / scale - fragment.y) < em * 0.02 &&
          t.height / scale >= em * 0.65 &&
          t.height / scale <= em
      )
      if (!baseline.length) return false
      const first = Math.min(...baseline.map((t) => t.sourceItem.index)),
        last = Math.max(...baseline.map((t) => t.sourceItem.index))
      const band = tokens
        .filter((t) => t.sourceItem.index >= first && t.sourceItem.index <= last)
        .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
      if (
        [...byItem].some(
          ([index, item]) =>
            index >= first && index <= last && normalizedLiteral(item.raw.str) && !seen.has(index)
        )
      )
        return false
      // Standalone original overlay symbols remain separate geometry. They do
      // not acquire an inferred owner while the accepted inline scripts close.
      const ordinary = band.filter(
        (t) =>
          !(
            /^[ˆ\\]$/u.test(t.text) &&
            Math.abs(t.height / scale - em) < 0.001 &&
            fragment.y + em - t.baseline / scale >= em * 0.15 &&
            fragment.y + em - t.baseline / scale <= em * 0.35 &&
            page.lines.some(
              (l) =>
                l.text === t.text &&
                sameRect(
                  lineRect(l).map((x) => x * scale),
                  t.rect
                ) &&
                !row.includes(l)
            )
          )
      )
      const box = [
        Math.min(...row.map((l) => l.x)),
        fragment.y - em * 0.35,
        Math.max(...row.map((l) => l.x + l.width)),
        fragment.y + em * 1.2
      ].map((x) => x * scale)
      return (
        ordinary.length > 0 &&
        ordinary.every(
          (t) => contains(box, t.rect) && t.height / scale >= em * 0.65 && t.height / scale <= em
        ) &&
        normalizedLiteral(ordinary.map((t) => t.text).join('')) ===
          normalizedLiteral(row.map((l) => l.text).join('')) &&
        ordinary.every((t, k) => !k || t.rect[0] >= ordinary[k - 1].rect[0])
      )
    }
  }
}
