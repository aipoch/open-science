/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeOpaqueTextPlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
const close = (a, b) => Math.abs(a - b) < 1e-4
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-8 : v <= a[i] + 1e-8))
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

// Complete the omitted leading row of an already recognized vector chart.
// Exact Form/clip ownership and both numeric axes prove every panel. Merely
// having nine boxes or a large path count does not establish a chart.
export function nativeClippedGridCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (
      f?.reason !== 'native-vector-chart-strip' ||
      f.fallbackFigure ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.sourceItems?.length ||
      f.caption?.regions
    )
      return
    const p = nativeOpaqueTextPlotPacketInventory(
      page,
      f,
      captions,
      tables,
      collectTableRules(ctx.operators, ctx.viewport),
      tokens,
      ctx
    )
    if (!p || p.evidence.images.length) return
    const { o, v, evidence, finite, valid, box } = p,
      forms = [],
      stack = [],
      textPaints = new Map()
    let matrix = [1, 0, 0, 1, 0, 0],
      active,
      fillColor = '#000000',
      fillAlpha = 1
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push({ matrix, active, fillColor, fillAlpha, op })
        if (op === OPS.paintFormXObjectBegin) {
          if (active || !finite(a?.[1], 4) || (a[0] && !finite(a[0], 6))) return
          if (a[0]) matrix = Util.transform(matrix, a[0])
          const m = Util.transform(v.transform, matrix)
          if (!finite(m, 6) || m[0] * m[3] - m[1] * m[2] === 0) return
          active = { start: i, rect: box(a[1], m) }
          if (!valid(active.rect)) return
          forms.push(active)
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (op === OPS.paintFormXObjectEnd) {
          if (!active) return
          active.end = i
        }
        const state = stack.pop()
        if (!state || state.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin))
          return
        ;({ matrix, active, fillColor, fillAlpha } = state)
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        matrix = Util.transform(matrix, a)
      } else if (op === OPS.setFillRGBColor) fillColor = a?.[0]
      else if (op === OPS.setGState) {
        for (const [key, value] of a[0]) if (key === 'ca') fillAlpha = value
      } else if (op === OPS.showText) textPaints.set(i, { fillColor, fillAlpha })
    }
    if (stack.length || forms.length !== 1 || !Number.isInteger(forms[0].end)) return
    const form = forms[0],
      owns = (i) => i > form.start && i < form.end,
      owned = p.records.filter((r) => r.part.some((z) => owns(z.g.i)))
    if (
      !owned.length ||
      owned.some((r) =>
        r.part.some(({ g }) => {
          const paint = textPaints.get(g.i)
          return (
            !owns(g.i) ||
            !inside(form.rect, g.ink) ||
            !paint ||
            paint.fillAlpha !== 1 ||
            typeof paint.fillColor !== 'string' ||
            !/^#[\da-f]{6}$/iu.test(paint.fillColor) ||
            /^#ffffff$/iu.test(paint.fillColor)
          )
        })
      )
    )
      return
    const groups = []
    for (const [i, state] of evidence.paths) {
      // Every paint contribution belongs to the same exact Form domain.
      if (!owns(i) || !valid(state.clip) || !inside(form.rect, state.clip)) return
      if (o.argsArray[i]?.[0] === OPS.endPath || state.clip.every((n, k) => close(n, form.rect[k])))
        continue
      let group = groups.find((g) => g.rect.every((n, k) => close(n, state.clip[k])))
      if (!group) groups.push((group = { rect: state.clip, paths: [] }))
      group.paths.push([i, state])
    }
    if (groups.length !== 9) return
    const rows = []
    for (const group of groups.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
      let row = rows.find(
        (r) => close(r[0].rect[1], group.rect[1]) && close(r[0].rect[3], group.rect[3])
      )
      if (!row) rows.push((row = []))
      row.push(group)
    }
    if (rows.length !== 3 || rows.some((row) => row.length !== 3)) return
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) {
        const r = rows[y][x].rect,
          first = rows[0][x].rect
        if (
          !close(r[2], first[2]) ||
          !close(r[3] - r[1], first[3] - first[1]) ||
          (x && r[0] <= rows[y][x - 1].rect[2]) ||
          (y && r[1] <= rows[y - 1][x].rect[3])
        )
          return
      }
    const numeric = owned.filter(
      (r) =>
        /^[−-]?\d+(?:\.\d+)?$/u.test(r.r.str.trim()) &&
        r.r.dir === 'ltr' &&
        r.r.transform[0] > 0 &&
        r.r.transform[1] === 0 &&
        r.r.transform[2] === 0 &&
        r.r.transform[3] === r.r.height
    )
    for (const group of groups) {
      const r = group.rect,
        horizontal = [],
        vertical = []
      for (const [i, s] of group.paths) {
        const a = o.argsArray[i],
          native = a?.[1]?.[0],
          m = Util.transform(v.transform, s.transform)
        if (
          a?.[0] !== OPS.stroke ||
          native?.length !== 6 ||
          native[0] !== 0 ||
          native[3] !== 1 ||
          !finite(native, 6) ||
          !finite(m, 6) ||
          s.strokeAlpha !== 1 ||
          s.solidStroke !== true ||
          !(s.lineWidth > 0)
        )
          continue
        const line = box(
          [
            Math.min(native[1], native[4]),
            Math.min(native[2], native[5]),
            Math.max(native[1], native[4]),
            Math.max(native[2], native[5])
          ],
          m
        )
        if (close(line[1], line[3]) && line[2] - line[0] >= (r[2] - r[0]) * 0.8)
          horizontal.push(line)
        if (close(line[0], line[2]) && line[3] - line[1] >= (r[3] - r[1]) * 0.8) vertical.push(line)
      }
      const yTicks = numeric.filter(
        (t) =>
          t.rect[2] <= r[0] &&
          r[0] - t.rect[2] < t.r.height &&
          t.rect[1] >= r[1] &&
          t.rect[3] <= r[3] &&
          horizontal.some((line) => Math.abs(line[1] - (t.rect[1] + t.rect[3]) / 2) < t.r.height)
      )
      const xTicks = numeric.filter(
        (t) =>
          t.rect[0] >= r[0] &&
          t.rect[2] <= r[2] &&
          t.rect[1] >= r[3] &&
          t.rect[3] - r[3] < t.r.height * 2 &&
          vertical.some((line) => Math.abs(line[0] - (t.rect[0] + t.rect[2]) / 2) < t.r.height)
      )
      if (
        new Set(yTicks.map((t) => t.rect[1])).size < 2 ||
        new Set(xTicks.map((t) => t.rect[0])).size < 2
      )
        return
    }
    const em = Math.max(...numeric.map((t) => t.r.height))
    if (
      !(em > 0) ||
      f.rect[1] <= rows[0][0].rect[3] ||
      f.rect[1] < rows[1][0].rect[1] ||
      f.rect[1] - rows[1][0].rect[1] >= em ||
      f.rect[3] < rows[2][0].rect[3] ||
      groups.some((g) => f.rect[0] > g.rect[0] || f.rect[2] < g.rect[2])
    )
      return
    const rect = form.rect,
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = rect.map((n, i) => n + (i < 2 ? -2 / scale : 2 / scale)),
      foreignPaints = [
        ...p.cap.map((c) => ({ rect: c.rect, floor: 0 })),
        ...tables.map((rect) => ({ rect, floor: 0 }))
      ]
    for (const record of p.records.filter((r) => !owned.includes(r))) {
      const font = nativeFigureLabelBounds(record.r, ctx.content.styles[record.r.fontName], v)
      if (!valid(font) || record.part.some((z) => owns(z.g.i))) return
      foreignPaints.push(
        { rect: font, floor: 0 },
        ...record.part.map((z) => ({ rect: z.g.ink, floor: 0 }))
      )
    }
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      foreignPaints.some((p) => !finite(p.rect, 4) || hit(padded, p.rect))
    )
      return
    return { rect, formCropRaster: { ownedRects: [rect], foreignPaints } }
  } catch {
    return undefined
  }
}
