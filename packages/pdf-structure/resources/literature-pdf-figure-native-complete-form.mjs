/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePlotPacketInventory,
  nativeTypedPlotPacketInventory
} from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { nativePairedScopedSubcaptions } from './literature-pdf-figure-native-paired-subcaptions.mjs'
import { nativeOrderedRasterLabels } from './literature-pdf-figure-native-ordered-raster-labels.mjs'
import { nativeWrappedPanelSubcaptionCrop } from './literature-pdf-figure-native-wrapped-subcaptions.mjs'
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b, e = 1e-5) => b.every((v, i) => (i < 2 ? v >= a[i] - e : v <= a[i] + e))
const close = (a, b) => Math.abs(a - b) < 0.05
const expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d))
export function nativeCompleteFormCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (f?.fallbackFigure || f?.headerRaster) return
    const wrapped = nativeWrappedPanelSubcaptionCrop(
      page,
      f,
      captions,
      tables,
      tokens,
      ctx,
      nativeFigurePathPaint
    )
    if (wrapped) return wrapped
    const tail = nativePairedScopedSubcaptions(
      page,
      f,
      captions,
      tables,
      tokens,
      ctx,
      nativeFigurePathPaint
    )
    if (tail) return tail
    const ordered = nativeOrderedRasterLabels(page, f, captions, tables, tokens, ctx)
    if (ordered) return ordered
    const rules = collectTableRules(ctx.operators, ctx.viewport),
      inv =
        nativeTypedPlotPacketInventory(page, f, captions, tables, rules, tokens, ctx) ??
        nativePlotPacketInventory(page, f, captions, tables, rules, tokens, ctx, true)
    if (!inv) return
    const { o, v, evidence, finite, valid, box } = inv,
      forms = [],
      stack = [],
      strokes = new Map(),
      fillColors = new Map(),
      joins = new Map(),
      textPaints = new Map()
    let matrix = [1, 0, 0, 1, 0, 0],
      active,
      strokeColor = '#000000',
      fillColor = '#000000',
      fillAlpha = 1,
      lineJoin = 0
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push({ matrix, active, op, strokeColor, fillColor, fillAlpha, lineJoin })
        if (op === OPS.paintFormXObjectBegin) {
          if (a?.[0]) {
            if (!finite(a[0], 6)) return
            matrix = Util.transform(matrix, a[0])
          }
          const m = Util.transform(v.transform, matrix)
          if (!finite(a?.[1], 4) || !finite(m, 6) || (!m[0] && !m[1]) || (!m[2] && !m[3])) return
          const form = { start: i, parent: active, rect: box(a[1], m) }
          if (!valid(form.rect)) return
          forms.push(form)
          active = form
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (op === OPS.paintFormXObjectEnd && active) active.end = i
        const s = stack.pop()
        if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        ;({ matrix, active, strokeColor, fillColor, fillAlpha, lineJoin } = s)
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        matrix = Util.transform(matrix, a)
      } else if (op === OPS.setStrokeRGBColor) strokeColor = a?.[0]
      else if (op === OPS.setFillRGBColor) fillColor = a?.[0]
      else if (op === OPS.setGState) {
        for (const [key, value] of a[0]) if (key === 'ca') fillAlpha = value
      } else if (op === OPS.showText) textPaints.set(i, { fillColor, fillAlpha })
      else if (op === OPS.setLineJoin) lineJoin = a?.[0]
      else if (op === OPS.constructPath) {
        strokes.set(i, strokeColor)
        fillColors.set(i, fillColor)
        joins.set(i, lineJoin)
      }
    }
    const roots = forms.filter((x) => !x.parent),
      owned = (form, i) => i > form.start && i < form.end,
      visible = (record) =>
        record.part.every(({ g }) => {
          const p = textPaints.get(g.i)
          return (
            p &&
            /^#[0-9a-f]{6}$/i.test(p.fillColor) &&
            p.fillColor.toLowerCase() !== '#ffffff' &&
            p.fillAlpha === 1
          )
        })
    if (
      stack.length ||
      roots.length < 1 ||
      roots.length > 9 ||
      roots.some((q) => !Number.isInteger(q.end))
    )
      return
    const plotGrid =
        roots.length >= 5 &&
        roots.length <= 9 &&
        roots.length % 2 === 1 &&
        evidence.images.length === 0,
      gridLegend = plotGrid ? roots.at(-1) : undefined
    if (roots.length > 2 && !plotGrid) return
    if (plotGrid) {
      // Bound identity work before visiting or expanding any marker path.
      if (evidence.paths.size > 4096) return
      let markerCount = 0
      for (const [i] of evidence.paths)
        if (o.argsArray[i]?.[0] === OPS.fillStroke && ++markerCount > 1024) return
    }
    const vs = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 35),
      hs = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 65)
    const rasterTitles = roots.length === 1 && f.reason === 'native-raster-horizontal-array'
    for (const form of roots) {
      if (form === gridLegend) {
        form.records = inv.records.filter((r) => r.part.some((p) => owned(form, p.g.i)))
        if (
          form.records.length < 2 ||
          form.records.length > 16 ||
          form.records.some(
            (r) =>
              !visible(r) ||
              !inside(form.rect, r.rect) ||
              !r.part.every((p) => owned(form, p.g.i) && inside(form.rect, p.g.ink))
          )
        )
          return
        continue
      }
      if (rasterTitles) {
        const images = evidence.images.filter((im) => owned(form, im.operationIndex))
        form.records = inv.records.filter((r) => r.part.some((p) => owned(form, p.g.i)))
        if (
          images.length < 3 ||
          images.length > 16 ||
          evidence.images.length !== images.length ||
          form.records.length !== images.length ||
          form.records.some(
            (r) =>
              !visible(r) ||
              !r.part.every((p) => owned(form, p.g.i) && inside(form.rect, p.g.ink)) ||
              !inside(form.rect, r.rect) ||
              r.r.transform[0] <= 0 ||
              r.r.transform[1] !== 0 ||
              r.r.transform[2] !== 0 ||
              r.r.transform[3] <= 0 ||
              r.r.height !== r.r.transform[3]
          )
        )
          return
        images.sort((a, b) => a.rect[0] - b.rect[0])
        const labels = [],
          first = images[0],
          em = form.records[0].r.height
        if (!(em > 0)) return
        for (const [n, image] of images.entries()) {
          if (
            !valid(image.rect) ||
            !inside(form.rect, image.rect) ||
            !inside(f.rect, image.rect) ||
            Math.abs(image.rect[2] - image.rect[0] - (first.rect[2] - first.rect[0])) > 1e-5 ||
            Math.abs(image.rect[3] - image.rect[1] - (first.rect[3] - first.rect[1])) > 1e-5 ||
            !close(image.rect[1], first.rect[1]) ||
            !close(image.rect[3], first.rect[3]) ||
            (n > 0 &&
              (image.rect[0] <= images[n - 1].rect[2] ||
                image.rect[0] - images[n - 1].rect[2] > em * 2))
          )
            return
          const matches = form.records.filter(
            (r) =>
              r.rect[3] <= image.rect[1] &&
              image.rect[1] - r.rect[3] < em * 1.5 &&
              Math.abs(r.rect[0] + r.rect[2] - image.rect[0] - image.rect[2]) / 2 < em / 64 &&
              r.r.fontName === form.records[0].r.fontName &&
              r.r.height === em &&
              r.part.every(
                (p) =>
                  p.g.i > image.operationIndex &&
                  p.g.i < (images[n + 1]?.operationIndex ?? form.end)
              )
          )
          if (matches.length !== 1) return
          labels.push(matches[0])
        }
        if (
          new Set(labels).size !== images.length ||
          labels.some(
            (r, n) =>
              (n > 0 &&
                (r.index <= labels[n - 1].index ||
                  ctx.content.items
                    .slice(labels[n - 1].index + 1, r.index)
                    .some((t) => typeof t.str !== 'string' || t.str.trim()))) ||
              Math.abs(r.rect[1] - labels[0].rect[1]) > 1e-5 ||
              Math.abs(r.rect[3] - labels[0].rect[3]) > 1e-5
          )
        )
          return
        continue
      }
      form.faces = vs
        .flatMap((a) =>
          hs
            .filter((b) => close(a[0], b[0]) && close(a[3], b[1]))
            .map((b) => [a[0], a[1], b[2], a[3]])
        )
        .filter(
          (r, i, all) =>
            inside(form.rect, r) && !all.slice(0, i).some((q) => q.every((n, k) => close(n, r[k])))
        )
      const faces = form.faces,
        w = faces[0]?.[2] - faces[0]?.[0],
        h = faces[0]?.[3] - faces[0]?.[1]
      if (
        faces.length < (plotGrid ? 1 : 3) ||
        faces.length > (plotGrid ? 1 : 8) ||
        faces.some(
          (r, i) =>
            Math.abs(r[2] - r[0] - w) > w * 0.15 ||
            Math.abs(r[3] - r[1] - h) > h * 0.05 ||
            !close(r[1], faces[0][1]) ||
            faces.slice(0, i).some((q) => hit(q, r))
        )
      )
        return
      for (const face of faces) {
        for (const side of [
          [face[0], face[1], face[0], face[3]],
          [face[0], face[3], face[2], face[3]]
        ]) {
          const matches = [...evidence.paths].filter(([i, s]) => {
            const a = o.argsArray[i],
              p = a?.[1]?.[0],
              m = Util.transform(v.transform, s.transform)
            if (
              !owned(form, i) ||
              a?.[0] !== OPS.stroke ||
              p?.length !== 6 ||
              p[0] !== 0 ||
              p[3] !== 1 ||
              s.strokeAlpha !== 1 ||
              s.solidStroke !== true ||
              !(s.lineWidth > 0) ||
              ![0, 1, 2].includes(s.lineCap) ||
              !s.clip ||
              !/^#[0-9a-f]{6}$/i.test(strokes.get(i)) ||
              strokes.get(i).toLowerCase() === '#ffffff'
            )
              return false
            const segment = [
              Math.min(p[1], p[4]),
              Math.min(p[2], p[5]),
              Math.max(p[1], p[4]),
              Math.max(p[2], p[5])
            ]
            return (
              box(segment, m).every((n, k) => close(n, side[k])) &&
              box(a[2], m).every((n, k) => close(n, side[k])) &&
              inside(form.rect, s.clip)
            )
          })
          if (!matches.length) return
        }
        if (
          inv.records.filter(
            (r) =>
              r.part.every((p) => owned(form, p.g.i)) &&
              /^[−-]?\d+(?:\.\d+)?$/.test(r.r.str.trim()) &&
              visible(r) &&
              inside(expand(face, 4 * r.r.height), r.rect)
          ).length < 2
        )
          return
      }
      form.records = inv.records.filter((r) => r.part.some((p) => owned(form, p.g.i)))
      if (
        !form.records.length ||
        form.records.some(
          (r) =>
            !r.part.every((p) => owned(form, p.g.i)) ||
            !r.part.every((p) => inside(form.rect, p.g.ink))
        )
      )
        return
      if (form.rect[3] - form.rect[1] > h * 3) return
    }
    roots.sort((a, b) => a.rect[1] - b.rect[1])
    const keys = [],
      markerClips = []
    if (plotGrid) {
      const plots = roots.filter((q) => q !== gridLegend),
        columns = plots.length / 2,
        first = plots[0],
        legend = gridLegend
      if (legend !== roots.at(-1) || columns < 2 || columns > 4) return
      for (const [n, form] of plots.entries()) {
        const row = Math.floor(n / columns),
          column = n % columns,
          previous = plots[n - 1],
          upper = plots[column]
        if (
          !inside(f.rect, form.faces[0]) ||
          !close(form.rect[2] - form.rect[0], first.rect[2] - first.rect[0]) ||
          !close(form.rect[1], plots[row * columns].rect[1]) ||
          !close(form.rect[3], plots[row * columns].rect[3]) ||
          (row === 1 && (!close(form.rect[0], upper.rect[0]) || form.rect[1] <= upper.rect[3])) ||
          (column > 0 &&
            (form.rect[0] <= previous.rect[2] ||
              form.rect[0] - previous.rect[2] > (first.rect[2] - first.rect[0]) / 4))
        )
          return
        const group = inv.records.filter((r) =>
          r.part.some((p) => p.g.i > form.end && p.g.i < roots[n + 1].start)
        )
        if (
          group.length !== 3 ||
          group[0].r.str !== '(' + String.fromCharCode(97 + n) + ')' ||
          !/^[A-Za-z]$/.test(group[1].r.str) ||
          !/^=\s*\d+$/.test(group[2].r.str) ||
          group.some(
            (r) =>
              !visible(r) || !r.part.every((p) => p.g.i > form.end && p.g.i < roots[n + 1].start)
          ) ||
          group.some(
            (r, k) => k > 0 && (r.index <= group[k - 1].index || r.rect[0] <= group[k - 1].rect[2])
          ) ||
          group.some(
            (r) =>
              !close(r.r.height, group[0].r.height) ||
              !close(r.rect[1], group[0].rect[1]) ||
              !close(r.rect[3], group[0].rect[3])
          )
        )
          return
        const span = union(group.map((r) => r.rect)),
          em = group[0].r.height
        if (
          !(em > 0) ||
          span[1] < form.rect[3] - 0.02 ||
          span[1] - form.rect[3] > em ||
          !inside(
            [form.rect[0], form.rect[3] - 0.02, form.rect[2], form.rect[3] + em * 1.5],
            span
          ) ||
          Math.abs((span[0] + span[2] - form.rect[0] - form.rect[2]) / 2) > em / 16 ||
          (n > 0 &&
            group.some(
              (r, k) => r.r.fontName !== keys[k].r.fontName || !close(r.r.height, keys[k].r.height)
            )) ||
          (n > 0 && group[1].r.str !== keys[1].r.str)
        )
          return
        keys.push(...group)
      }
      const bottom = Math.max(...keys.map((r) => r.rect[3])),
        lr = legend.records,
        em = lr[0].r.height
      if (
        !close(legend.rect[0], plots[0].rect[0]) ||
        !close(legend.rect[2], plots[columns - 1].rect[2]) ||
        legend.rect[1] <= bottom ||
        legend.rect[1] - bottom > em * 2 ||
        legend.rect[3] - legend.rect[1] > em * 3 ||
        lr.some(
          (r, n) =>
            !close(r.r.height, em) ||
            r.r.fontName !== lr[0].r.fontName ||
            !close(r.rect[1], lr[0].rect[1]) ||
            !close(r.rect[3], lr[0].rect[3]) ||
            (n > 0 && (r.rect[0] <= lr[n - 1].rect[2] || r.index <= lr[n - 1].index))
        )
      )
        return
      const marker = (i) => {
          const a = o.argsArray[i],
            state = evidence.paths.get(i),
            path = a?.[1]?.[0],
            b = a?.[2],
            join = joins.get(i),
            miter = inv.strokeMargins.get(i)
          if (
            a?.[0] !== OPS.fillStroke ||
            (!Array.isArray(path) && !ArrayBuffer.isView(path)) ||
            path.length < 10 ||
            path.length > 64 ||
            !state ||
            state.fillAlpha !== 1 ||
            state.strokeAlpha !== 1 ||
            state.solidStroke !== true ||
            ![0, 1, 2].includes(join) ||
            ![0, 1, 2].includes(state.lineCap) ||
            !Number.isFinite(state.lineWidth) ||
            !(state.lineWidth > 0) ||
            !Number.isFinite(miter) ||
            miter < 1 ||
            !finite(b, 4) ||
            b[2] <= b[0] ||
            b[3] <= b[1] ||
            !/^#[0-9a-f]{6}$/i.test(strokes.get(i)) ||
            strokes.get(i).toLowerCase() === '#ffffff' ||
            !/^#[0-9a-f]{6}$/i.test(fillColors.get(i))
          )
            return
          const m = Util.transform(v.transform, state.transform)
          if (
            !finite(m, 6) ||
            m[0] <= 0 ||
            m[1] !== 0 ||
            m[2] !== 0 ||
            m[3] !== -m[0] ||
            !valid(state.clip)
          )
            return
          // Reuse the existing closed convex tri/quad contract: actual corner
          // angles bound miters; every other path keeps the configured worst bound.
          const vertices =
            [10, 13].includes(path?.length) &&
            path[0] === 0 &&
            path.at(-1) === 4 &&
            path.every(
              (n, k) =>
                Number.isFinite(n) &&
                (k === path.length - 1 || k % 3 !== 0 || n === (k === 0 ? 0 : 1))
            )
              ? Array.from({ length: (path.length - 1) / 3 }, (_, k) =>
                  Array.from(path.slice(k * 3 + 1, k * 3 + 3))
                )
              : undefined
          let ratio = 1,
            turn,
            convex =
              !!vertices && new Set(vertices.map((p) => p.join(','))).size === vertices.length
          if (convex)
            for (let k = 0; k < vertices.length; k++) {
              const a = vertices[(k + vertices.length - 1) % vertices.length],
                b = vertices[k],
                c = vertices[(k + 1) % vertices.length],
                u = [a[0] - b[0], a[1] - b[1]],
                w = [c[0] - b[0], c[1] - b[1]],
                length = Math.hypot(...u) * Math.hypot(...w),
                cross = u[0] * w[1] - u[1] * w[0]
              if (
                !Number.isFinite(length) ||
                !length ||
                !Number.isFinite(cross) ||
                !cross ||
                (turn !== undefined && Math.sign(cross) !== turn)
              ) {
                convex = false
                break
              }
              turn = Math.sign(cross)
              const sine = Math.sqrt(Math.max(0, (1 - (u[0] * w[0] + u[1] * w[1]) / length) / 2))
              if (!Number.isFinite(sine) || !sine) {
                convex = false
                break
              }
              ratio = Math.max(ratio, Math.min(miter, 1 / sine))
            }
          const radius = join === 0 ? (convex ? ratio : miter) : 1,
            pad = (state.lineWidth * radius) / 2
          if (!inside(state.clip, box(expand(Array.from(b), pad), m))) return
          // Float32 inputs carry half-ULP rounding intervals. Only normalized
          // identities use these intervals; actual bounds and clips stay exact.
          const halfUlp = (x) =>
              Math.abs(x) < 2 ** -126 ? 2 ** -150 : 2 ** (Math.floor(Math.log2(Math.abs(x))) - 24),
            rounding = (container, x) => (container instanceof Float32Array ? halfUlp(x) : 0),
            width = b[2] - b[0],
            ew = rounding(b, b[0]) + rounding(b, b[2]),
            den = [width - ew, width + ew],
            divide = (n) => {
              if (!(den[0] > 0)) return
              const q = n.flatMap((a) => den.map((b) => a / b))
              return [Math.min(...q), Math.max(...q)]
            },
            shape = [],
            coords = [[], []]
          for (let n = 0; n < path.length;) {
            const op = path[n++],
              count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 4 ? 0 : -1
            if (count < 0 || n + count > path.length) return
            shape.push(op)
            for (let k = 0; k < count; k++) {
              const axis = k % 2,
                x = path[n + k]
              if (!Number.isFinite(x) || x < b[axis] || x > b[axis + 2]) return
              coords[axis].push(x)
              const e = rounding(path, x) + rounding(b, b[axis]),
                q = divide([x - b[axis] - e, x - b[axis] + e])
              if (!q) return
              shape.push(q)
            }
            n += count
          }
          if (
            path.at(-1) !== 4 ||
            coords.some(
              (q, k) => !q.length || Math.min(...q) !== b[k] || Math.max(...q) !== b[k + 2]
            )
          )
            return
          const strokeRatio = divide([state.lineWidth, state.lineWidth])
          if (!strokeRatio) return
          const strokeWidth = state.lineWidth * m[0]
          if (
            !Number.isFinite(strokeWidth) ||
            !(strokeWidth > 0) ||
            !Number.isFinite(radius) ||
            radius < 1
          )
            return
          return {
            rasterClip: {
              rect: box(b, m),
              clip: Array.from(state.clip),
              strokeWidth,
              joinFactor: radius
            },
            i,
            shape,
            color: strokes.get(i).toLowerCase(),
            fillColor: fillColors.get(i).toLowerCase(),
            lineCap: state.lineCap,
            lineJoin: join,
            miter,
            strokeRatio,
            rect: box(b, m)
          }
        },
        legendMarkers = [...evidence.paths.keys()]
          .filter((i) => owned(legend, i))
          .map(marker)
          .filter(Boolean)
      if (legendMarkers.length !== lr.length) return
      const sameMarker = (m, key) =>
        m.lineCap === key.lineCap &&
        m.lineJoin === key.lineJoin &&
        m.miter === key.miter &&
        m.strokeRatio[0] <= key.strokeRatio[1] &&
        key.strokeRatio[0] <= m.strokeRatio[1] &&
        m.fillColor === key.fillColor &&
        m.color === key.color &&
        m.shape.length === key.shape.length &&
        m.shape.every((v, i) =>
          Array.isArray(v)
            ? Array.isArray(key.shape[i]) && v[0] <= key.shape[i][1] && key.shape[i][0] <= v[1]
            : v === key.shape[i]
        )
      if (legendMarkers.some((m, n) => legendMarkers.slice(0, n).some((k) => sameMarker(m, k))))
        return
      const candidates = plots.map((form) =>
        [...evidence.paths.keys()]
          .filter((i) => owned(form, i))
          .map(marker)
          .filter(Boolean)
      )
      for (const [n, r] of lr.entries()) {
        const matches = legendMarkers.filter(
          (m) =>
            m.i < r.part[0].g.i &&
            (n === 0 || m.i > lr[n - 1].part.at(-1).g.i) &&
            m.rect[2] < r.rect[0] &&
            r.rect[0] - m.rect[2] < em &&
            m.rect[1] >= r.rect[1] &&
            m.rect[3] <= r.rect[3]
        )
        if (matches.length !== 1) return
        const key = matches[0]
        markerClips.push([key.rasterClip])
        for (let c = 0; c < columns; c++) {
          const witnesses = [...candidates[c], ...candidates[c + columns]].filter(
            (m) => sameMarker(m, key) && legendMarkers.filter((k) => sameMarker(m, k)).length === 1
          )
          if (!witnesses.length) return
          markerClips.push(witnesses.map((m) => m.rasterClip))
        }
      }
    } else if (!rasterTitles && roots.length === 2) {
      const [a, b] = roots
      if (
        a.faces.some((q, i) => !close(q[0], b.faces[i]?.[0])) ||
        !close(a.rect[0], b.rect[0]) ||
        !close(a.rect[2], b.rect[2]) ||
        !close(a.rect[3] - a.rect[1], b.rect[3] - b.rect[1]) ||
        a.faces.length !== b.faces.length ||
        !inside(f.rect, b.rect) ||
        hit(a.rect, f.rect)
      )
        return
      for (let n = 0; n < 2; n++) {
        const form = roots[n],
          key = inv.records.filter(
            (r) =>
              r.r.str.trimStart().startsWith(`(${String.fromCharCode(97 + n)})`) &&
              r.part.every((p) => !roots.some((q) => owned(q, p.g.i))) &&
              r.rect[1] >= form.rect[3] &&
              r.rect[1] - form.rect[3] < 2 * r.r.height &&
              r.rect[0] >= form.rect[0] &&
              r.rect[2] <= form.rect[2]
          )
        if (key.length !== 1 || !visible(key[0])) return
        keys.push(key[0])
      }
    } else if (!rasterTitles) {
      const form = roots[0]
      // A graphics seed may include a margin beyond the Form while missing
      // its top-left panel keys. Require every complete face and its native
      // alphabetical key chain; the whole Form still owns every added paint.
      const topKeys = form.faces.map((face, n) =>
          form.records.filter(
            (r) =>
              r.r.str === String.fromCharCode(97 + n) &&
              r.rect[2] <= face[0] &&
              face[0] - r.rect[0] < 2 * r.r.height &&
              r.rect[3] <= face[1] &&
              face[1] - r.rect[3] < r.r.height
          )
        ),
        completeTopKeys =
          form.faces.every((face) => inside(f.rect, face)) &&
          topKeys.every(
            (items, n) =>
              items.length === 1 &&
              visible(items[0]) &&
              items[0].r.fontName === topKeys[0][0]?.r.fontName &&
              close(items[0].r.height, topKeys[0][0]?.r.height) &&
              close(items[0].rect[1], topKeys[0][0]?.rect[1]) &&
              (n === 0 || items[0].index > topKeys[n - 1][0]?.index)
          )
      if (!inside(form.rect, f.rect) && !completeTopKeys) return
      const panelKeys = []
      for (let n = 0; !completeTopKeys && n < form.faces.length; n++) {
        const face = form.faces[n],
          key = form.records.filter(
            (r) =>
              r.r.str.trim() === `(${String.fromCharCode(97 + n)})` &&
              r.rect[1] >= face[3] &&
              r.rect[3] <= form.rect[3] &&
              Math.abs((r.rect[0] + r.rect[2] - face[0] - face[2]) / 2) < r.r.height
          )
        if (key.length !== 1 || !visible(key[0])) return
        panelKeys.push(key[0])
      }
      if (
        panelKeys.some(
          (q) =>
            !close(q.rect[1], panelKeys[0].rect[1]) || !close(q.r.height, panelKeys[0].r.height)
        )
      )
        return
    }
    const rect = union([
      f.rect,
      ...roots.map((q) => q.rect),
      ...keys.map((r) => union([r.rect, ...r.part.map((p) => p.g.ink)]))
    ])
    if (rect.every((n, i) => close(n, f.rect[i]))) return
    const scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      belongs = (i) => roots.some((q) => owned(q, i))
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      captions.some((c) => c.page === page.pageNumber && hit(padded, c.rect)) ||
      tables.some((t) => hit(padded, t))
    )
      return
    for (const [i, s] of evidence.paths) {
      if (
        belongs(i) &&
        (!valid(s.clip) || !roots.some((q) => owned(q, i) && inside(q.rect, s.clip)))
      )
        return
    }
    if (
      evidence.images.some(
        (im) =>
          belongs(im.operationIndex) &&
          (!valid(im.rect) ||
            !roots.some((q) => owned(q, im.operationIndex) && inside(q.rect, im.rect)))
      )
    )
      return
    const allowed = new Set(keys.flatMap((r) => r.part.map((p) => p.g))),
      foreignPaints = [
        ...captions
          .filter((c) => c.page === page.pageNumber)
          .map((c) => ({ rect: c.rect, floor: 0 })),
        ...tables.map((rect) => ({ rect, floor: 0 })),
        ...inv.glyphs
          .filter((g) => !belongs(g.i) && !allowed.has(g) && valid(g.ink))
          .map((g) => ({ rect: g.ink, floor: 0 }))
      ]
    if (
      inv.glyphs.some((g) => !belongs(g.i) && !allowed.has(g) && valid(g.ink) && hit(padded, g.ink))
    )
      return
    for (const [i, s] of evidence.paths) {
      const a = o.argsArray[i]
      if (belongs(i) || a?.[0] === OPS.endPath) continue
      const paint = nativeFigurePathPaint(inv, i, s)
      if (!paint) return
      foreignPaints.push(paint)
      if (hit(padded, expand(paint.rect, (paint.floor + 2) / scale))) return
    }
    if (
      evidence.images.some(
        (im) =>
          !belongs(im.operationIndex) &&
          (!valid(im.rect) || hit(padded, expand(im.rect, 2 / scale)))
      )
    )
      return
    foreignPaints.push(
      ...evidence.images
        .filter((im) => !belongs(im.operationIndex))
        .map((im) => ({ rect: im.rect, floor: 0 }))
    )
    return {
      rect,
      ...(rasterTitles && !f.sourceItems?.length
        ? {
            sourceItems: roots[0].records.map(({ r }) => ({
              pageNumber: r.sourceItem.pageNumber,
              index: r.sourceItem.index,
              text: r.str
            }))
          }
        : {}),
      formCropRaster: {
        ...(plotGrid ? { markerClips } : {}),
        ownedRects: [
          ...roots.map((q) => q.rect),
          ...keys.map((r) => union([r.rect, ...r.part.map((p) => p.g.ink)]))
        ],
        foreignPaints
      }
    }
  } catch {
    return undefined
  }
}

// Both crop families use the same unclipped physical and device-stroke bound.
// A clip cannot justify omitting paint whose minimum pixel width reaches it.
export function nativeFigurePathPaint(inv, i, s) {
  const { o, v, finite, valid, box } = inv,
    a = o.argsArray[i],
    stroke = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0]),
    margin = Math.max(Math.SQRT2, inv.strokeMargins.get(i) ?? 10),
    pad = stroke ? (s.lineWidth * margin) / 2 : 0
  if (
    !finite(a?.[2], 4) ||
    !finite(s.transform, 6) ||
    s.transform[0] * s.transform[3] - s.transform[1] * s.transform[2] === 0 ||
    !Number.isFinite(pad) ||
    pad < 0 ||
    (stroke &&
      (![0, 1, 2].includes(s.lineCap) || !Number.isFinite(s.lineWidth) || s.lineWidth < 0)) ||
    (s.clip && !valid(s.clip))
  )
    return
  const matrix = Util.transform(v.transform, s.transform),
    rect = box(expand(Array.from(a[2]), pad), matrix),
    det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]),
    nx = Math.hypot(matrix[0], matrix[1]),
    ny = Math.hypot(matrix[2], matrix[3]),
    floor = stroke
      ? (margin / 2) *
        Math.max(
          (Math.abs(matrix[0]) * ny + Math.abs(matrix[2]) * nx) / det,
          (Math.abs(matrix[1]) * ny + Math.abs(matrix[3]) * nx) / det
        )
      : 0
  if (!(det > 0) || !finite(rect, 4) || !Number.isFinite(floor) || floor < 0) return
  return { rect, floor }
}

// This certificate stays inside the extractor. The actual PNG determines the
// final raster footprint, including ceil rounding and byte-budget retries.
export function nativeCompleteFormCropPngSafe(png, rect, page, candidate) {
  try {
    const proof = candidate?.formCropRaster,
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] >= r[0] &&
        r[3] >= r[1]
    if (
      !proof ||
      ![
        'foreignPaints,ownedRects',
        'foreignPaints,nativeTail,ownedRects',
        'foreignPaints,ownedRects,paintSeparations',
        'foreignPaints,markerClips,ownedRects'
      ].includes(Object.keys(proof).sort().join(',')) ||
      !Array.isArray(proof.ownedRects) ||
      !proof.ownedRects.length ||
      !Array.isArray(proof.foreignPaints) ||
      !valid(rect)
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster) return false
    const scale = raster.scaleLower
    if (Object.hasOwn(proof, 'nativeTail')) {
      const p = proof.nativeTail,
        positive = (r) => valid(r) && r[0] < r[2] && r[1] < r[3]
      if (
        !p ||
        Object.keys(p).sort().join(',') !== 'frames,labels,paints' ||
        !Array.isArray(p.labels) ||
        p.labels.length !== 2 ||
        !p.labels.every(positive) ||
        !Array.isArray(p.frames) ||
        p.frames.length !== 2 ||
        p.frames.some(
          (f) =>
            !f ||
            Object.keys(f).sort().join(',') !== 'clip,joinFactor,rect,strokeWidth' ||
            !positive(f.rect) ||
            !positive(f.clip) ||
            !Number.isFinite(f.strokeWidth) ||
            f.strokeWidth <= 0 ||
            !Number.isFinite(f.joinFactor) ||
            f.joinFactor < Math.SQRT2 ||
            !inside(f.clip, expand(f.rect, (Math.max(f.strokeWidth, 1 / scale) * f.joinFactor) / 2))
        ) ||
        !Array.isArray(p.paints) ||
        p.paints.length > 4096 ||
        p.paints.some(
          (q) =>
            !q ||
            Object.keys(q).sort().join(',') !== 'floor,rect' ||
            !positive(q.rect) ||
            !Number.isFinite(q.floor) ||
            q.floor < 0 ||
            p.labels.some((r) => hit(expand(r, 2 / scale), expand(q.rect, (q.floor + 2) / scale)))
        )
      )
        return false
    }
    if (Object.hasOwn(proof, 'markerClips')) {
      // At most 16 labels each need a legend witness plus four columns (80).
      // Unique identities use at most 1024 plot markers plus 16 legend markers.
      const groups = proof.markerClips,
        positive = (r) => valid(r) && r[2] > r[0] && r[3] > r[1]
      if (
        !Array.isArray(groups) ||
        !groups.length ||
        groups.length > 80 ||
        groups.some((g) => !Array.isArray(g) || !g.length) ||
        groups.reduce((n, g) => n + g.length, 0) > 1040 ||
        groups.some((g) =>
          g.some(
            (p) =>
              !p ||
              Object.keys(p).sort().join(',') !== 'clip,joinFactor,rect,strokeWidth' ||
              !positive(p.rect) ||
              !positive(p.clip) ||
              !Number.isFinite(p.strokeWidth) ||
              !(p.strokeWidth > 0) ||
              !Number.isFinite(p.joinFactor) ||
              p.joinFactor < 1
          )
        ) ||
        groups.some(
          (g) =>
            !g.some((p) =>
              inside(
                p.clip,
                expand(p.rect, (Math.max(p.strokeWidth, 1 / scale) * p.joinFactor) / 2)
              )
            )
        )
      )
        return false
    }
    if (
      Object.hasOwn(proof, 'paintSeparations') &&
      (!Array.isArray(proof.paintSeparations) ||
        !proof.paintSeparations.length ||
        !proof.paintSeparations.every(
          (p) =>
            p &&
            Object.keys(p).sort().join(',') === 'glyphInk,laterPaintRect' &&
            valid(p.glyphInk) &&
            p.glyphInk[2] > p.glyphInk[0] &&
            p.glyphInk[3] > p.glyphInk[1] &&
            valid(p.laterPaintRect) &&
            p.laterPaintRect[2] > p.laterPaintRect[0] &&
            p.laterPaintRect[3] > p.laterPaintRect[1] &&
            !hit(expand(p.glyphInk, 2 / scale), expand(p.laterPaintRect, 2 / scale))
        ))
    )
      return false
    return (
      proof.ownedRects.every((r) => valid(r) && inside(rect, expand(r, 1 / scale))) &&
      proof.foreignPaints.every(
        (p) =>
          valid(p?.rect) &&
          Number.isFinite(p.floor) &&
          p.floor >= 0 &&
          !hit(raster.protection, expand(p.rect, (p.floor + 2) / scale))
      )
    )
  } catch {
    return false
  }
}
