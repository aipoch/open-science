/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'
import { connectFigureGraphics } from './literature-pdf-figure-connectivity.mjs'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

const contains = (a, b) => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3]
const pad = (r, n) => [r[0] - n, r[1] - n, r[2] + n, r[3] + n]

// A separate finite family: three styled line keys and two repeated marker
// shapes share one top row in a complete, non-nested native form. The form's
// hard BBox clip bounds every mark, including paths whose controls lie outside
// the visible plot. This never changes the older side/nested legend selector.
export function nativeFiniteTopRowKeyedLegend(
  page,
  caption,
  captions,
  tables,
  tokens,
  oldBounds,
  context
) {
  if (
    !validLegendRect(oldBounds) ||
    !validLegendRect(caption?.rect) ||
    caption.page !== page.pageNumber ||
    !Array.isArray(tokens) ||
    !tokens.length ||
    !Array.isArray(page.graphicsBounds) ||
    page.graphicsBounds.some(
      (g) =>
        g.kind !== 'path' ||
        !validLegendRect(g.normalizedRect) ||
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0
    ) ||
    tokens.some(
      (t) =>
        !validLegendRect(t?.rect) ||
        typeof t.text !== 'string' ||
        !t.text.trim() ||
        !Number.isFinite(t.height) ||
        t.height <= 0 ||
        !Number.isFinite(t.baseline) ||
        t.sourceItem?.pageNumber !== page.pageNumber ||
        !Number.isInteger(t.sourceItem.index) ||
        t.sourceItem.index < 0 ||
        t.sourceItem.text !== t.text
    ) ||
    new Set(tokens.map((t) => t.sourceItem.index)).size !== tokens.length
  )
    return
  const form = finiteLegendForm(page, tokens, context)
  if (!form) return
  const { bounds, fonts, paint } = form,
    font = Math.max(
      ...(page.lines ?? [])
        .filter((l) => intersection(lineRect(l), caption.rect) > 0)
        .map((l) => l.fontSize)
    )
  if (
    !(font > 0) ||
    !Number.isFinite(font) ||
    !contains(bounds, oldBounds) ||
    area(oldBounds) < area(bounds) * 0.5 ||
    bounds[2] - bounds[0] < font * 20 ||
    bounds[3] - bounds[1] < font * 8 ||
    bounds[3] - bounds[1] > font * 20 ||
    bounds[3] > caption.rect[1] - font * 0.5 ||
    caption.rect[1] - bounds[3] > font * 3 ||
    captions.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, bounds) > 0
    ) ||
    tables.some((t) => intersection(t, bounds) > 0) ||
    tokens.some((t) => intersection(t.rect, bounds) > 0 && !fonts.includes(t))
  )
    return
  const row = fonts.filter((t) => !contains(pad(oldBounds, 1e-8), t.rect))
  if (
    row.length !== 5 ||
    fonts.length - row.length < 8 ||
    row.some(
      (t) =>
        !t.horizontal ||
        t.height < font * 0.5 ||
        t.height > font * 0.9 ||
        t.rect[3] >= oldBounds[1] ||
        oldBounds[1] - t.rect[3] > font * 2 ||
        Math.abs(t.baseline - row[0].baseline) > 0.01 ||
        Math.abs(t.height - row[0].height) > 0.01
    )
  )
    return
  const labels = row.filter((t) => /^[\p{L}][\p{L} -]{2,}$/u.test(t.text)),
    seeds = row.filter((t) => /^\d{1,3}$/u.test(t.text))
  if (labels.length !== 3 || seeds.length !== 2 || seeds[0].text === seeds[1].text) return
  const carrier = paint.filter(
    (p) =>
      [OPS.fill, OPS.fillStroke].includes(p.kind) &&
      legendRectPath(p.path) &&
      p.fill === '#ffffff' &&
      p.ca === 1 &&
      (p.kind === OPS.fill || (p.stroke === '#ffffff' && p.CA === 1)) &&
      p.visible.every((v, i) => Math.abs(v - bounds[i]) < 1e-7)
  )
  if (carrier.length !== 1 || carrier[0] !== paint[0]) return
  const band = [bounds[0], row[0].rect[1] - row[0].height * 0.5, bounds[2], oldBounds[1]],
    keys = paint.filter((p) => p !== carrier[0] && intersection(p.visible, band) > 0)
  if (keys.length !== 5) return
  const paired = row.map((t) => ({
    token: t,
    keys: keys.filter(
      (p) =>
        p.visible[2] <= t.rect[0] &&
        t.rect[0] - p.visible[2] <= t.height * 1.5 &&
        Math.abs((p.visible[1] + p.visible[3]) / 2 - (t.rect[1] + t.rect[3]) / 2) <= t.height * 0.5
    )
  }))
  if (paired.some((p) => p.keys.length !== 1) || new Set(paired.map((p) => p.keys[0])).size !== 5)
    return
  const lines = paired.filter((p) => labels.includes(p.token)).map((p) => p.keys[0]),
    markers = paired.filter((p) => seeds.includes(p.token)).map((p) => p.keys[0]),
    core = paint.filter((p) => contains(pad(oldBounds, 1e-8), p.visible))
  if (
    core.length < 12 ||
    lines.some(
      (key) =>
        key.kind !== OPS.stroke ||
        key.path.length !== 9 ||
        key.path[0] !== 0 ||
        key.path[3] !== 1 ||
        key.path[6] !== 1 ||
        key.path[2] !== key.path[5] ||
        key.path[5] !== key.path[8] ||
        key.CA !== 1 ||
        key.stroke === '#ffffff' ||
        !core.some(
          (p) =>
            p.kind === OPS.stroke &&
            sameLegendLineStyle(p, key) &&
            p.visible[2] - p.visible[0] > row[0].height * 3
        )
    ) ||
    new Set(lines.map((p) => JSON.stringify([p.stroke, p.width, p.dash]))).size !== 3 ||
    markers.some(
      (p) =>
        p.kind !== OPS.fillStroke ||
        p.fill !== p.stroke ||
        p.fill === '#ffffff' ||
        p.ca !== 1 ||
        p.CA !== 1 ||
        p.dash[0].length ||
        p.width <= 0 ||
        p.path.length < 12 ||
        p.path.length > 60
    ) ||
    sameLegendMarker(markers[0], markers[1])
  )
    return
  const repetitions = markers.map((key) =>
    core.filter(
      (p) =>
        p.kind === OPS.fillStroke &&
        p.fill === p.stroke &&
        p.fill !== '#ffffff' &&
        p.ca === 1 &&
        p.CA === 1 &&
        !p.dash[0].length &&
        sameLegendMarker(p, key)
    )
  )
  if (
    repetitions.some((r) => r.length < 3) ||
    repetitions[0].filter((a) =>
      repetitions[1].some(
        (b) =>
          a.stroke === b.stroke &&
          Math.abs(a.visible[1] - b.visible[1]) <= row[0].height &&
          b.visible[0] >= a.visible[0] &&
          b.visible[0] - a.visible[2] <= row[0].height
      )
    ).length < 3
  )
    return
  return { caption, rect: bounds, graphicsCount: paint.length }
}

const validLegendRect = (r) =>
  r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const legendNumeric = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  (n === undefined || a.length === n) &&
  Array.from(a).every(Number.isFinite)
const sameLegendLineStyle = (a, b) =>
  a.stroke === b.stroke &&
  a.width === b.width &&
  a.CA === b.CA &&
  a.cap === b.cap &&
  a.join === b.join &&
  JSON.stringify(a.dash) === JSON.stringify(b.dash)

function legendRectPath(path) {
  const xs = [path[1], path[4], path[7], path[10]],
    ys = [path[2], path[5], path[8], path[11]]
  return (
    path.length === 13 &&
    path[0] === 0 &&
    path[3] === 1 &&
    path[6] === 1 &&
    path[9] === 1 &&
    path[12] === 4 &&
    new Set(xs).size === 2 &&
    new Set(ys).size === 2 &&
    new Set(xs.map((x, n) => `${x}:${ys[n]}`)).size === 4 &&
    xs.every((x, n) => x === xs[(n + 1) % 4] || ys[n] === ys[(n + 1) % 4])
  )
}

function sameLegendMarker(a, b) {
  if (a.path.length !== b.path.length) return false
  const normalized = (p) => {
    const r = p.control,
      width = r[2] - r[0],
      height = r[3] - r[1],
      out = []
    if (!(width > 0) || !(height > 0)) return
    for (let n = 0; n < p.path.length;) {
      const op = p.path[n++],
        count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : 0
      out.push(op)
      for (let k = 0; k < count; k += 2)
        out.push((p.path[n + k] - r[0]) / width, (p.path[n + k + 1] - r[1]) / height)
      n += count
    }
    return out
  }
  const x = normalized(a),
    y = normalized(b)
  return !!x && !!y && x.every((v, n) => Math.abs(v - y[n]) < 1e-4)
}

function finiteLegendForm(page, tokens, context) {
  const o = context?.operators,
    v = context?.viewport
  if (
    version !== '5.4.624' ||
    !o ||
    !Array.isArray(o.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    !v ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !legendNumeric(v.transform, 6) ||
    v.transform.some((x, i) => x !== [1, 0, 0, -1, 0, page.height][i]) ||
    typeof v.convertToViewportPoint !== 'function'
  )
    return
  const stack = [],
    fonts = [],
    paint = [],
    indices = new Set(),
    dependencies = new Set()
  let state = {
      matrix: [1, 0, 0, 1, 0, 0],
      clip: [0, 0, page.width, page.height],
      size: 0,
      width: 1,
      cap: 0,
      join: 0,
      dash: [[], 0],
      fill: '#000000',
      stroke: '#000000',
      ca: 1,
      CA: 1
    },
    inForm = false,
    forms = 0,
    bounds,
    inText = false,
    textMatrix,
    shown = false,
    pendingClip = false
  const clipped = (r) => [
    Math.max(state.clip[0], r[0]),
    Math.max(state.clip[1], r[1]),
    Math.min(state.clip[2], r[2]),
    Math.min(state.clip[3], r[3])
  ]
  const transformed = (r) => {
    const m = Util.transform(v.transform, state.matrix),
      ps = [
        [r[0], r[1]],
        [r[0], r[3]],
        [r[2], r[1]],
        [r[2], r[3]]
      ].map((p) => {
        Util.applyTransform(p, m)
        return p
      })
    return [
      Math.min(...ps.map((p) => p[0])),
      Math.min(...ps.map((p) => p[1])),
      Math.max(...ps.map((p) => p[0])),
      Math.max(...ps.map((p) => p[1]))
    ]
  }
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (inText || pendingClip) return
      stack.push({ state: structuredClone(state), form: op === OPS.paintFormXObjectBegin })
      if (op === OPS.paintFormXObjectBegin) {
        if (
          inForm ||
          ++forms !== 1 ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          !legendNumeric(a[1], 4) ||
          !validLegendRect(Array.from(a[1])) ||
          (a[0] !== null && !legendNumeric(a[0], 6))
        )
          return
        if (a[0]) state.matrix = Util.transform(state.matrix, a[0])
        if (
          state.matrix[0] <= 0 ||
          state.matrix[3] <= 0 ||
          state.matrix[1] !== 0 ||
          state.matrix[2] !== 0
        )
          return
        bounds = transformed(a[1])
        state.clip = clipped(bounds)
        inForm = true
      } else if (a !== null && a !== undefined && (!Array.isArray(a) || a.length)) return
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (inText || pendingClip) return
      const old = stack.pop()
      if (!old || old.form !== (op === OPS.paintFormXObjectEnd)) return
      state = old.state
      if (op === OPS.paintFormXObjectEnd) inForm = false
    } else if (op === OPS.transform) {
      if (inText || !legendNumeric(a, 6) || a[0] * a[3] - a[1] * a[2] <= 0) return
      state.matrix = Util.transform(state.matrix, a)
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (!Array.isArray(a) || a.length !== 1 || !/^#[0-9a-f]{6}$/u.test(a[0])) return
      state[op === OPS.setFillRGBColor ? 'fill' : 'stroke'] = a[0]
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a) || a.length !== 1 || !Array.isArray(a[0]) || !a[0].length) return
      for (const pair of a[0]) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !['ca', 'CA'].includes(pair[0]) ||
          !Number.isFinite(pair[1]) ||
          pair[1] < 0 ||
          pair[1] > 1
        )
          return
        state[pair[0]] = pair[1]
      }
    } else if ([OPS.setLineWidth, OPS.setLineCap, OPS.setLineJoin].includes(op)) {
      if (
        !legendNumeric(a, 1) ||
        a[0] < 0 ||
        (op !== OPS.setLineWidth && (!Number.isInteger(a[0]) || a[0] > 2))
      )
        return
      state[op === OPS.setLineWidth ? 'width' : op === OPS.setLineCap ? 'cap' : 'join'] = a[0]
    } else if (op === OPS.setDash) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        !legendNumeric(a[0]) ||
        a[0].some((x) => x < 0) ||
        !Number.isFinite(a[1])
      )
        return
      state.dash = [Array.from(a[0]), a[1]]
    } else if (op === OPS.clip) {
      if (!inForm || pendingClip) return
      pendingClip = true
    } else if (op === OPS.constructPath) {
      if (
        inText ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        ![OPS.fill, OPS.stroke, OPS.fillStroke, OPS.endPath].includes(a[0]) ||
        !Array.isArray(a[1]) ||
        a[1].length !== 1 ||
        !legendNumeric(a[1][0]) ||
        !legendNumeric(a[2], 4)
      )
        return
      const path = Array.from(a[1][0]),
        ps = []
      for (let n = 0; n < path.length;) {
        const code = path[n++],
          count = code === 0 || code === 1 ? 2 : code === 2 ? 6 : code === 4 ? 0 : -1
        if (count < 0 || n + count > path.length) return
        for (let k = 0; k < count; k += 2) ps.push([path[n + k], path[n + k + 1]])
        n += count
      }
      if (!ps.length) return
      const control = [
        Math.min(...ps.map((p) => p[0])),
        Math.min(...ps.map((p) => p[1])),
        Math.max(...ps.map((p) => p[0])),
        Math.max(...ps.map((p) => p[1]))
      ]
      if (control.some((x, n) => Math.abs(x - a[2][n]) > 1e-7)) return
      if (pendingClip) {
        const xs = [path[1], path[4], path[7], path[10]],
          ys = [path[2], path[5], path[8], path[11]]
        if (
          a[0] !== OPS.endPath ||
          path.length !== 13 ||
          path[0] !== 0 ||
          path[3] !== 1 ||
          path[6] !== 1 ||
          path[9] !== 1 ||
          path[12] !== 4 ||
          new Set(xs).size !== 2 ||
          new Set(ys).size !== 2 ||
          new Set(xs.map((x, n) => `${x}:${ys[n]}`)).size !== 4 ||
          xs.some((x, n) => x !== xs[(n + 1) % 4] && ys[n] !== ys[(n + 1) % 4]) ||
          state.matrix[1] !== 0 ||
          state.matrix[2] !== 0
        )
          return
        state.clip = clipped(transformed(control))
        pendingClip = false
      } else {
        if (a[0] === OPS.endPath) return
        const extra = a[0] === OPS.stroke ? state.width / 2 : 0,
          visible = clipped(transformed(control.map((x, n) => x + (n < 2 ? -extra : extra)))),
          expected = visible.map(
            (x, n) =>
              ((n < 2 ? Math.floor : Math.ceil)((x * 256) / (n % 2 ? page.height : page.width)) +
                (n < 2 ? 0 : 1)) /
              256
          ),
          g = page.graphicsBounds.filter((g) => g.operationIndex === i)
        if (!visible.every(Number.isFinite) || visible[0] > visible[2] || visible[1] > visible[3])
          return
        if (inForm) {
          if (
            g.length !== 1 ||
            g[0].kind !== 'path' ||
            !legendNumeric(g[0].normalizedRect, 4) ||
            g[0].normalizedRect.some((x, n) => Math.abs(x - expected[n]) > 1e-8) ||
            g[0].paintedNormalizedRect
          )
            return
          indices.add(i)
          paint.push({ ...state, i, kind: a[0], control, path, visible })
        } else {
          const guard = state.width * 5,
            full = clipped(transformed(control.map((x, n) => x + (n < 2 ? -guard : guard))))
          if (!bounds || intersection(full, bounds) > 0) return
        }
      }
    } else if (op === OPS.beginText) {
      if (inText || pendingClip) return
      inText = true
      textMatrix = [1, 0, 0, 1, 0, 0]
      shown = false
    } else if (op === OPS.endText) {
      if (!inText || (inForm && !shown)) return
      inText = false
    } else if (op === OPS.setFont) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !dependencies.has(a[0]) ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return
      state.size = a[1]
    } else if (op === OPS.moveText) {
      if (!inText || !legendNumeric(a, 2) || (inForm && shown)) return
      textMatrix = Util.transform(textMatrix, [1, 0, 0, 1, ...a])
    } else if (op === OPS.setTextMatrix) {
      if (inForm || !inText || !Array.isArray(a) || a.length !== 1 || !legendNumeric(a[0], 6))
        return
      textMatrix = Array.from(a[0])
    } else if (op === OPS.showText) {
      if (!inText || !Array.isArray(a) || a.length !== 1 || !Array.isArray(a[0])) return
      if (!inForm) continue
      if (shown || !paint.length || !(state.size > 0) || state.fill !== '#000000' || state.ca !== 1)
        return
      let text = '',
        advance = 0
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          advance -= g
          continue
        }
        if (
          !g ||
          typeof g.unicode !== 'string' ||
          !g.unicode ||
          typeof g.fontChar !== 'string' ||
          !g.fontChar ||
          !Number.isInteger(g.originalCharCode) ||
          g.originalCharCode < 0 ||
          typeof g.isSpace !== 'boolean' ||
          (g.isSpace && g.unicode !== ' ') ||
          typeof g.isInFont !== 'boolean' ||
          !Number.isFinite(g.width) ||
          g.width <= 0 ||
          g.accent ||
          g.vmetric ||
          g.operatorListId ||
          (!g.isSpace &&
            !g.isInFont &&
            !(g.unicode === ' ' && g.fontChar === ' ' && g.originalCharCode === 32))
        )
          return
        text += g.unicode
        advance += g.width
      }
      const matrix = Util.transform(
          state.matrix,
          Util.transform(textMatrix, [state.size, 0, 0, state.size, 0, 0])
        ),
        raw = {
          str: text,
          dir: 'ltr',
          transform: matrix,
          width: ((advance * state.size) / 1000) * Math.hypot(state.matrix[0], state.matrix[1]),
          height: Math.hypot(matrix[2], matrix[3])
        },
        expected = tableTextToken(raw, v, 0),
        matching = tokens.filter(
          (t) =>
            t.text === text &&
            t.horizontal === expected.horizontal &&
            Math.abs(t.height - expected.height) < 0.02 &&
            Math.abs(t.baseline - expected.baseline) < 0.02 &&
            t.rect.every((x, n) => Math.abs(x - expected.rect[n]) < 0.02)
        )
      if (
        matching.length !== 1 ||
        fonts.includes(matching[0]) ||
        !contains(pad(bounds, 1e-8), matching[0].rect) ||
        !contains(pad(state.clip, 1e-8), matching[0].rect) ||
        (fonts.length && matching[0].sourceItem.index <= fonts.at(-1).sourceItem.index)
      )
        return
      fonts.push(matching[0])
      shown = true
    } else if (op === OPS.dependency) {
      if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== 'string' || !x)) return
      for (const name of a) dependencies.add(name)
    } else return
  }
  if (
    stack.length ||
    inText ||
    pendingClip ||
    inForm ||
    forms !== 1 ||
    !fonts.length ||
    page.graphicsBounds.some(
      (g) =>
        intersection(
          (g.paintedNormalizedRect ?? g.normalizedRect).map(
            (x, n) => x * (n % 2 ? page.height : page.width)
          ),
          bounds
        ) > 0 && !indices.has(g.operationIndex)
    )
  )
    return
  return { bounds, fonts, paint }
}

// Path bounding boxes establish connected ink, not ellipse/closure/color. A
// repeated keyed legend is separately proved by native marker/text alignment.
export function nativeConnectedKeyedLegend(page, caption, captions, tables, tokens, oldBounds) {
  if (!oldBounds?.every(Number.isFinite) || !tokens.length) return
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  const font = Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
  if (!(font > 0) || !Number.isFinite(font)) return
  const source = tokens.filter((t) => t.text.trim())
  if (
    source.some(
      (t) =>
        !t.rect?.every(Number.isFinite) ||
        !(area(t.rect) > 0) ||
        !(t.height > 0) ||
        !Number.isFinite(t.baseline)
    )
  )
    return
  const paths = page.graphicsBounds.map((g) => ({
    kind: g.kind,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, i) => v * (i % 2 ? page.height : page.width)
    )
  }))
  if (paths.some((g) => !g.rect.every(Number.isFinite) || !(area(g.rect) > 0))) return
  const eligible = paths.filter(
    (g) =>
      g.kind === 'path' &&
      g.rect[2] < caption.rect[0] - font &&
      contains(pad(oldBounds, font * 7), g.rect) &&
      !tables.some((t) => intersection(t, g.rect) > 0)
  )
  const proofs = []
  for (const outer of eligible.filter(
    (g) => g.rect[2] - g.rect[0] > font * 15 && g.rect[3] - g.rect[1] > font * 10
  )) {
    const inner = eligible.filter(
      (g) =>
        g !== outer &&
        contains(outer.rect, g.rect) &&
        area(g.rect) > area(outer.rect) * 0.35 &&
        area(g.rect) < area(outer.rect) * 0.8
    )
    if (inner.length !== 1) continue
    const nodePaths = eligible
      .filter(
        (g) =>
          contains(inner[0].rect, g.rect) &&
          g.rect[2] - g.rect[0] > font * 2 &&
          g.rect[2] - g.rect[0] < font * 5 &&
          g.rect[3] - g.rect[1] > font * 2 &&
          g.rect[3] - g.rect[1] < font * 5
      )
      .filter(
        (g, i, all) =>
          !all.slice(0, i).some((p) => p.rect.every((v, n) => Math.abs(v - g.rect[n]) < 0.01))
      )
    const nodes = nodePaths.filter((g) =>
      source.some((t) => contains(g.rect, t.rect) && t.height < font * 0.9)
    )
    if (
      nodes.length < 6 ||
      !nodes.some((g) => nodes.filter((p) => Math.abs(p.rect[1] - g.rect[1]) < font).length >= 3)
    )
      continue
    const labels = source.filter(
      (t) => nodes.some((g) => contains(g.rect, t.rect)) && t.height < font * 0.9
    )
    const labelFont = Math.max(...labels.map((t) => t.height))
    if (
      !(labelFont > font * 0.5) ||
      labels.filter((t) => Math.abs(t.height - labelFont) < 0.01).length < 6
    )
      continue
    const component = [outer]
    const pending = new Set(
      eligible.filter((g) => g !== outer && contains(pad(outer.rect, font * 5), g.rect))
    )
    connectFigureGraphics(component, pending)
    const core = union(component.map((g) => g.rect))
    if (core[1] >= oldBounds[1] || core[3] <= oldBounds[3] || core[2] >= caption.rect[0] - font)
      continue
    const band = [
      outer.rect[0] - labelFont * 3,
      core[3] - labelFont,
      caption.rect[0] - font,
      core[3] + labelFont * 5
    ]
    const legend = source.filter(
      (t) => contains(band, t.rect) && Math.abs(t.height - labelFont) < 0.01 && t.horizontal
    )
    const keys = legend.filter((t) =>
      eligible.some(
        (g) =>
          g.rect[2] - g.rect[0] >= labelFont * 0.5 &&
          g.rect[2] - g.rect[0] <= labelFont * 2 &&
          g.rect[3] - g.rect[1] >= labelFont * 0.5 &&
          g.rect[3] - g.rect[1] <= labelFont * 2 &&
          Math.abs((g.rect[1] + g.rect[3]) / 2 - (t.rect[1] + t.rect[3]) / 2) < labelFont &&
          t.rect[0] - g.rect[2] >= -labelFont * 0.5 &&
          t.rect[0] - g.rect[2] < labelFont
      )
    )
    const columns = keys
      .filter(
        (t, i, all) => !all.slice(0, i).some((p) => Math.abs(p.rect[0] - t.rect[0]) < labelFont)
      )
      .map((t) => keys.filter((p) => Math.abs(p.rect[0] - t.rect[0]) < labelFont))
      .filter(
        (c) =>
          c.length >= 2 &&
          c.some((t) =>
            c.some(
              (p) =>
                Math.abs(p.baseline - t.baseline) > labelFont &&
                Math.abs(p.baseline - t.baseline) < labelFont * 2
            )
          )
      )
    if (
      columns.length < 2 ||
      !columns.some((a, i) =>
        columns
          .slice(i + 1)
          .some(
            (b) =>
              a.filter((t) => b.some((p) => Math.abs(t.baseline - p.baseline) < labelFont * 0.1))
                .length >= 2
          )
      )
    )
      continue
    const baselines = keys.map((t) => t.baseline)
    const candidates = source.filter(
      (t) =>
        contains(band, t.rect) &&
        t.height <= labelFont * 1.01 &&
        t.height >= labelFont * 0.6 &&
        baselines.some((b) => Math.abs(t.baseline - b) < labelFont * 0.5)
    )
    const ownedLegend = [...keys]
    const indexPairs = candidates
      .filter(
        (t) =>
          Array.from(t.text.trim()).length === 1 &&
          candidates.filter(
            (p) =>
              Array.from(p.text.trim()).length === 1 &&
              Math.abs(p.rect[0] - t.rect[0]) < 0.01 &&
              Math.abs(p.height - t.height) < 0.01
          ).length >= 3
      )
      .map((t) => ({
        index: t,
        definitions: candidates.filter(
          (p) =>
            p !== t &&
            p.text.trim().length >= 2 &&
            Math.abs(p.height - t.height) < 0.01 &&
            Math.abs(p.baseline - t.baseline) < labelFont * 0.15 &&
            p.rect[0] - t.rect[2] >= labelFont * 0.5 &&
            p.rect[0] - t.rect[2] <= labelFont * 1.2
        )
      }))
    const completePairs = indexPairs.filter(
      (p) =>
        p.definitions.length === 1 &&
        indexPairs.filter(
          (q) =>
            q.definitions.length === 1 &&
            Math.abs(q.index.rect[0] - p.index.rect[0]) < 0.01 &&
            Math.abs(q.definitions[0].rect[0] - p.definitions[0].rect[0]) < labelFont * 0.15
        ).length >= 3
    )
    for (const p of completePairs) ownedLegend.push(p.index, p.definitions[0])
    for (let pass = 0; pass < candidates.length; pass++) {
      const additions = candidates.filter(
        (t) =>
          !ownedLegend.includes(t) &&
          ownedLegend.filter(
            (p) =>
              Math.abs(p.height - t.height) < 0.01 &&
              Math.abs(p.baseline - t.baseline) < 0.01 &&
              t.rect[0] - p.rect[2] >= -labelFont * 0.05 &&
              t.rect[0] - p.rect[2] < labelFont * 0.35
          ).length === 1
      )
      if (!additions.length) break
      ownedLegend.push(...additions)
    }
    const legendBounds = union(ownedLegend.map((t) => t.rect))
    const legendPaths = eligible.filter(
      (g) =>
        contains(pad(legendBounds, labelFont * 3), g.rect) &&
        g.rect[2] - g.rect[0] <= labelFont * 2 &&
        g.rect[3] - g.rect[1] <= labelFont * 2 &&
        keys.some(
          (t) =>
            Math.abs((g.rect[1] + g.rect[3]) / 2 - (t.rect[1] + t.rect[3]) / 2) < labelFont &&
            t.rect[0] - g.rect[2] >= -labelFont * 0.5 &&
            t.rect[0] - g.rect[2] < labelFont * 3
        )
    )
    const rect = union([oldBounds, core, legendBounds, ...legendPaths.map((g) => g.rect)])
    if (
      rect[2] >= caption.rect[0] - font ||
      tables.some((t) => intersection(t, rect) > 0) ||
      ownCaps.some((c) => intersection(c.rect, rect) > 0)
    )
      continue
    const coreSource = source.filter(
      (t) =>
        contains(core, t.rect) &&
        t.height <= labelFont * 1.01 &&
        (contains(oldBounds, t.rect) ||
          component.some(
            (g) =>
              contains(g.rect, t.rect) &&
              g.rect[2] - g.rect[0] < font * 6 &&
              g.rect[3] - g.rect[1] < font * 6
          ))
    )
    if (
      source.some(
        (t) => intersection(t.rect, rect) > 0 && !coreSource.includes(t) && !ownedLegend.includes(t)
      )
    )
      continue
    const ownedGraphics = [...component, ...legendPaths]
    if (paths.some((g) => intersection(g.rect, rect) > 0 && !ownedGraphics.includes(g))) continue
    proofs.push({ caption, rect, graphicsCount: ownedGraphics.length })
  }
  if (proofs.length === 1) return proofs[0]
}
