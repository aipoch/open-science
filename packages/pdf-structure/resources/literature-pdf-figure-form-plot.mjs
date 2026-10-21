/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeFormAxisArrayEvidence } from './literature-pdf-figure-form-axis-array.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { area, intersection, lineRect, union } from './literature-pdf-page-geometry.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-5 : v <= a[n] + 1e-5))
const text = (s) => s.replace(/\s/gu, '')
const rectanglePath = (a) => {
  const p = a?.[1]?.[0]
  return (
    a?.[1]?.length === 1 &&
    p?.length === 13 &&
    p[0] === 0 &&
    p[12] === 4 &&
    [3, 6, 9].every((n) => p[n] === 1) &&
    p[1] === p[10] &&
    p[4] === p[7] &&
    p[2] === p[5] &&
    p[8] === p[11]
  )
}
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

// Connect two closed panels only through an actual stroked shaft and a
// symmetric closed arrowhead. The target is the unique border midpoint on
// its directed ray, not the nearest rectangle. Small intentional arrow gaps
// are bounded by that shaft's native stroke width.
function connectedPanels(form, evidence, viewport, figure) {
  if (form.images.length || form.paths.length > 2048) return
  const point = (m, p) => {
    const q = [...p]
    Util.applyTransform(q, m)
    return q
  }
  const similarity = (m) => {
    if (!finite(m, 6)) return
    const s = Math.hypot(m[0], m[1])
    if (
      !(s > 0) ||
      Math.abs(Math.hypot(m[2], m[3]) - s) > s * 1e-6 ||
      Math.abs(m[0] * m[2] + m[1] * m[3]) > s * s * 1e-6
    )
      return
    return s
  }
  const close = (a, b) => Math.abs(a - b) <= 1e-4
  const safe = (p) =>
    p.state?.solidStroke &&
    p.state.strokeAlpha === 1 &&
    p.state.fillAlpha === 1 &&
    finite(p.state.transform, 6) &&
    valid(p.state.clip) &&
    p.state.clip.every((x, n) => close(x, form.rect[n])) &&
    p.state.lineWidth > 0
  const frames = form.paths.flatMap((p) => {
    const r = evidence.frames.get(p.index)
    if (!valid(r) || !safe(p)) return []
    const m = Util.transform(viewport.transform, p.state.transform),
      s = similarity(m)
    if (!s) return []
    const half = (p.state.lineWidth * s) / 2
    const outer = r.map((x, n) => x + (n < 2 ? -half : half))
    return inside(p.state.clip, outer) ? [{ rect: r, outer }] : []
  })
  const shafts = form.paths.filter(
    (p) =>
      p.args[0] === OPS.stroke &&
      p.args[1]?.length === 1 &&
      finite(p.args[1][0], 6) &&
      p.args[1][0][0] === 0 &&
      p.args[1][0][3] === 1 &&
      safe(p) &&
      p.state.lineCap === 0
  )
  const heads = form.paths.filter(
    (p) =>
      p.args[0] === OPS.fillStroke &&
      p.args[1]?.length === 1 &&
      finite(p.args[1][0], 21) &&
      safe(p) &&
      p.join === 0
  )
  if (frames.length < 2 || frames.length > 64 || shafts.length > 32 || heads.length > 32) return
  const plans = []
  for (const shaft of shafts) {
    const p = shaft.args[1][0],
      m = Util.transform(viewport.transform, shaft.state.transform)
    const scale = similarity(m)
    if (!scale) continue
    const start = point(m, [p[1], p[2]]),
      end = point(m, [p[4], p[5]])
    const dx = end[0] - start[0],
      dy = end[1] - start[1],
      length = Math.hypot(dx, dy)
    const width = shaft.state.lineWidth * scale
    if (
      !(dy > width && length > width) ||
      !inside(shaft.state.clip, [
        Math.min(start[0], end[0]) - width / 2,
        start[1] - width / 2,
        Math.max(start[0], end[0]) + width / 2,
        end[1] + width / 2
      ])
    )
      continue
    const sources = frames.filter(
      (f) =>
        close(start[0], (f.outer[0] + f.outer[2]) / 2) &&
        close(start[1], f.outer[3]) &&
        !inside(figure.rect, f.rect)
    )
    if (sources.length !== 1) continue
    for (const head of heads) {
      const h = head.args[1][0]
      if (
        h[0] !== 0 ||
        h[2] !== 0 ||
        h[3] !== 2 ||
        h[8] !== 0 ||
        h[10] !== 1 ||
        h[11] !== 0 ||
        h[13] !== 2 ||
        h[20] !== 4 ||
        !(h[1] > h[4] && h[4] > h[6] && h[6] > 0 && h[5] > 0 && h[7] > h[5] && h[9] > h[7]) ||
        !close(h[12], -h[9]) ||
        !close(h[14], h[6]) ||
        !close(h[15], -h[7]) ||
        !close(h[16], h[4]) ||
        !close(h[17], -h[5]) ||
        !close(h[18], h[1]) ||
        h[19] !== 0
      )
        continue
      const hm = Util.transform(viewport.transform, head.state.transform),
        hs = similarity(hm)
      if (!hs) continue
      const base = point(hm, [0, 0])
      if (
        !base.every((x, n) => close(x, end[n])) ||
        Math.abs(hm[0] / hs - dx / length) > 1e-4 ||
        Math.abs(hm[1] / hs - dy / length) > 1e-4
      )
        continue
      // The cusp's miter is determined by the two cubic endpoint tangents.
      // A control-point enclosure is insufficient to locate this painted tip.
      const ratio = Math.hypot(h[1] - h[4], h[5]) / h[5]
      if (!Number.isFinite(head.miter) || ratio > head.miter || head.miter < 1) continue
      const extension = (head.state.lineWidth / 2) * ratio
      const tip = point(hm, [h[1] + extension, 0])
      if (
        !inside(
          head.state.clip,
          box([-extension, -h[9] - extension, h[1] + extension, h[9] + extension], hm)
        )
      )
        continue
      const targets = frames.filter((f) => {
        const y = f.outer[1],
          gap = ((y - tip[1]) * length) / dy
        return (
          f !== sources[0] &&
          y > start[1] &&
          gap >= -1e-4 &&
          gap <= width &&
          close(start[0] + ((y - start[1]) * dx) / dy, (f.outer[0] + f.outer[2]) / 2)
        )
      })
      if (targets.length !== 1 || !inside(figure.rect, targets[0].rect)) continue
      const source = sources[0],
        target = targets[0]
      // Any other closed shape must be nested in a panel, or be a label
      // directly crossed by the shaft between the two panel boundaries.
      if (
        frames.some((f) => {
          if (inside(source.rect, f.rect) || inside(target.rect, f.rect)) return false
          const r = f.rect,
            y = (r[1] + r[3]) / 2,
            x = start[0] + ((y - start[1]) * dx) / dy
          return !(r[1] > source.outer[3] && r[3] < target.outer[1] && x > r[0] && x < r[2])
        })
      )
        continue
      plans.push([source.rect, target.rect])
    }
  }
  return plans.length === 1 ? plans[0] : undefined
}

// Call only after complete Form ownership has been proved. These native lines
// are outside its paints/text, but their descenders can reach the final padding.
export function nativeFormPlotExcludedProse(page, rect, tokens) {
  return (page.lines ?? []).filter((line) => {
    const r = lineRect(line)
    return (
      valid(r) &&
      r[3] <= rect[1] &&
      r[3] + line.height >= rect[1] &&
      Math.min(r[2], rect[2]) > Math.max(r[0], rect[0]) &&
      tokens.some(
        (t) => valid(t.rect) && t.rect[3] <= rect[1] && intersection(t.rect, r) / area(t.rect) > 0.8
      )
    )
  })
}

// A separately authored Form owns outlined labels even when their Unicode is
// unavailable. Its BBox is only an isolation guard: crop to actual paints and
// matched native text, excluding an initial opaque white rectangular backdrop.
function legacyNativeFormPlotBounds(page, figure, captions, tables, tokens, context) {
  const o = context?.operators,
    v = context?.viewport
  if (
    !valid(figure?.rect) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !finite(v?.transform, 6) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height
  )
    return
  const barriers = [
    ...captions.filter((c) => c.page === page.pageNumber).map((c) => c.rect),
    ...tables
  ]
  if (!barriers.every(valid)) return
  const e = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  collectClosedFigureFrames(o, v, e)
  const forms = [],
    stack = [],
    blankBackdrops = new Set()
  let matrix = [1, 0, 0, 1, 0, 0],
    fill,
    alpha = 1,
    font,
    miter = 10,
    join = 0,
    normal = true,
    form
  const safe = new Set(
    [
      'beginMarkedContent',
      'beginMarkedContentProps',
      'endMarkedContent',
      'dependency',
      'beginText',
      'endText',
      'setFont',
      'setTextMatrix',
      'moveText',
      'setCharSpacing',
      'showText',
      'save',
      'restore',
      'transform',
      'setFillRGBColor',
      'setStrokeRGBColor',
      'setLineWidth',
      'setLineJoin',
      'setLineCap',
      'setMiterLimit',
      'setDash',
      'setGState',
      'clip',
      'eoClip',
      'constructPath',
      'paintImageXObject'
    ].map((k) => OPS[k])
  )
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ matrix: [...matrix], fill, alpha, font, miter, join, normal, form })
      if (op === OPS.paintFormXObjectBegin) {
        if (form) {
          form.bad = true
          continue
        }
        if (a?.[0]) matrix = Util.transform(matrix, a[0])
        const m = Util.transform(v.transform, matrix)
        form = {
          start: i,
          end: Infinity,
          bad:
            !normal ||
            !finite(a?.[1], 4) ||
            !finite(m, 6) ||
            Math.abs(m[1]) > 1e-5 ||
            Math.abs(m[2]) > 1e-5,
          rect: finite(a?.[1], 4) ? box(a[1], m) : undefined,
          paints: [],
          paths: [],
          movedText: false,
          opaqueText: true,
          shows: new Map(),
          foreground: false,
          images: []
        }
        forms.push(form)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (op === OPS.paintFormXObjectEnd && form) form.end = i
      const s = stack.pop()
      if (!s) return
      ;({ matrix, fill, alpha, font, miter, join, normal, form } = s)
    } else if (op === OPS.transform) {
      if (!finite(a, 6)) return
      matrix = Util.transform(matrix, a)
    } else if (op === OPS.setFillRGBColor) fill = a?.[0]
    else if (op === OPS.setFont) font = a?.[0]
    else if (op === OPS.setMiterLimit) miter = a?.[0]
    else if (op === OPS.setLineJoin) join = a?.[0]
    else if (op === OPS.setGState) {
      for (const [k, value] of a?.[0] ?? []) {
        if (k === 'ca') alpha = value
        else if (k === 'ML') miter = value
        else if (k === 'LJ') join = value
        else if (!(
          ['CA', 'LW', 'LC', 'LJ', 'ML', 'D'].includes(k) ||
          (k === 'BM' && value === 'source-over') ||
          (k === 'SMask' && value === false)
        )) {
          normal = false
          if (form) form.bad = true
        }
      }
    }
    if (
      op === OPS.constructPath &&
      normal &&
      fill === '#ffffff' &&
      alpha === 1 &&
      [OPS.fill, OPS.eoFill].includes(a?.[0]) &&
      rectanglePath(a)
    )
      blankBackdrops.add(i)
    if (!form || form.bad || op === OPS.paintFormXObjectBegin) continue
    if (!safe.has(op)) form.bad = true
    // Positioning is accepted only together with the complete per-font native
    // text/showText match below; it never substitutes for source ownership.
    if (op === OPS.moveText) {
      form.movedText = true
      if (!finite(a, 2)) form.bad = true
    }
    if (op === OPS.showText) {
      if (alpha !== 1) form.opaqueText = false
      if (
        typeof font !== 'string' ||
        !Array.isArray(a?.[0]) ||
        a[0].some((g) => typeof g !== 'number' && typeof g?.unicode !== 'string')
      ) {
        form.bad = true
        continue
      }
      form.shows.set(
        font,
        (form.shows.get(font) ?? '') +
          a[0]
            .filter((g) => typeof g !== 'number')
            .map((g) => g.unicode)
            .join('')
      )
      form.foreground = true
    }
    if (op === OPS.paintImageXObject) {
      const image = e.images.find((im) => im.operationIndex === i)
      if (!valid(image?.rect)) form.bad = true
      else {
        form.images.push(image.rect)
        form.paints.push(image.rect)
      }
      form.foreground = true
    }
    if (op !== OPS.constructPath || [OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    const state = e.paths.get(i)
    form.paths.push({ index: i, args: a, state, miter, join })
    const backdrop = !form.foreground && blankBackdrops.has(i)
    if (backdrop) continue
    form.foreground = true
    const stroke = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]),
      pad = stroke ? (state?.lineWidth * Math.max(1, miter)) / 2 : 0
    if (
      !finite(a?.[2], 4) ||
      !finite(state?.transform, 6) ||
      !Number.isFinite(pad) ||
      pad < 0 ||
      (!stroke && ![OPS.fill, OPS.eoFill].includes(a[0]))
    ) {
      form.bad = true
      continue
    }
    // An unknown inner clip can only remove paint. The enclosing Form BBox
    // remains an upper bound, subject to all prose/caption guards below.
    const clip = state.clip ?? form.rect,
      r = box(
        Array.from(a[2], (x, n) => x + (n < 2 ? -pad : pad)),
        Util.transform(v.transform, state.transform)
      ),
      clipped = [
        Math.max(r[0], clip[0]),
        Math.max(r[1], clip[1]),
        Math.min(r[2], clip[2]),
        Math.min(r[3], clip[3])
      ]
    if (valid(clipped)) form.paints.push(clipped)
  }
  if (stack.length) return
  const plans = []
  for (const f of forms) {
    if (f.bad || !Number.isFinite(f.end) || !valid(f.rect) || !inside(f.rect, figure.rect)) continue
    const rasterGeometry =
      f.images.length >= 2 &&
      area(f.rect) <= area(figure.rect) * 2 &&
      f.images.filter((r) => intersection(r, figure.rect) >= area(r) * 0.9).length >= 2 &&
      f.images.reduce((n, r) => n + intersection(r, figure.rect), 0) >=
        f.images.reduce((n, r) => n + area(r), 0) * 0.9
    // A positioned text run needs the actual glyph stream, not a Form BBox
    // or concatenated text alone. Existing unpositioned Forms keep their proof.
    const packetProof =
      rasterGeometry &&
      f.movedText &&
      f.opaqueText &&
      nativePlotPacketInventory(page, figure, captions, tables, [], tokens, context, true)
    const raster = rasterGeometry && (!f.movedText || Boolean(packetProof))
    const panels =
      !raster &&
      figure.caption?.page === page.pageNumber &&
      valid(figure.caption.rect) &&
      captions.some(
        (c) => c.page === page.pageNumber && c.rect.every((x, n) => x === figure.caption.rect[n])
      ) &&
      connectedPanels(f, e, v, figure)
    if (!raster && !panels) continue
    const source = tokens.filter(
      (t) =>
        valid(t.rect) &&
        intersection(t.rect, f.rect) > 0 &&
        !barriers.some((r) => intersection(r, t.rect) > 0)
    )
    if (source.some((t) => !inside(f.rect, t.rect))) continue
    let nativeInk = []
    if (raster && f.movedText) {
      const owned = (g) => g.i > f.start && g.i < f.end
      const records = packetProof.records.filter((r) => r.part.some((p) => owned(p.g)))
      if (
        records.some((r) => r.part.some((p) => !owned(p.g))) ||
        records.length !== source.length ||
        source.some(
          (t) => !records.some((r) => r.index === t.sourceItem?.index && r.r.str === t.text)
        )
      )
        continue
      nativeInk = packetProof.glyphs.filter(owned).map((g) => g.ink)
      if (!nativeInk.length || nativeInk.some((r) => !inside(f.rect, r))) continue
    }
    if (panels && panels.some((r) => !source.some((t) => inside(r, t.rect)))) continue
    const strings = new Map()
    for (const t of source) {
      const name = t.fontName ?? context?.content?.items?.[t.sourceItem?.index]?.fontName
      strings.set(name, (strings.get(name) ?? '') + t.text)
    }
    if (
      [...new Set([...f.shows.keys(), ...strings.keys()])].some(
        (k) =>
          (packetProof
            ? text(f.shows.get(k) ?? '').normalize('NFD')
            : text(f.shows.get(k) ?? '')) !==
          (packetProof ? text(strings.get(k) ?? '').normalize('NFD') : text(strings.get(k) ?? ''))
      )
    )
      continue
    const result = union([figure.rect, ...f.paints, ...source.map((t) => t.rect), ...nativeInk])
    if (
      !valid(result) ||
      !inside(f.rect, result) ||
      barriers.some((r) => intersection(r, result) > 0)
    )
      continue
    if (
      tokens.some((t) => valid(t.rect) && intersection(t.rect, result) > 0 && !source.includes(t))
    )
      continue
    // A second native image cannot be silently absorbed from outside this Form.
    if (
      e.images.some(
        (im) =>
          (im.operationIndex < f.start || im.operationIndex > f.end) &&
          valid(im.rect) &&
          intersection(im.rect, result) > intersection(im.rect, figure.rect) + 1e-5
      )
    )
      continue
    if (
      (page.graphicsBounds ?? []).some((g) => {
        if (g.operationIndex > f.start && g.operationIndex < f.end) return false
        if (blankBackdrops.has(g.operationIndex)) return false
        const r = g.normalizedRect?.map((x, n) => x * (n % 2 ? page.height : page.width))
        return valid(r) && intersection(r, result) > intersection(r, figure.rect) + 1e-5
      })
    )
      continue
    plans.push(result)
  }
  return plans.length === 1 ? plans[0] : undefined
}

export function nativeFormPlotEvidence(page, figure, captions, tables, tokens, context) {
  const rect = legacyNativeFormPlotBounds(page, figure, captions, tables, tokens, context)
  return rect
    ? { rect }
    : nativeFormAxisArrayEvidence(page, figure, captions, tables, tokens, context)
}

export function nativeFormPlotBounds(page, figure, captions, tables, tokens, context) {
  return nativeFormPlotEvidence(page, figure, captions, tables, tokens, context)?.rect
}
