/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePlotPacketInventory,
  nativeTypedPlotPacketInventory
} from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d))
const color = (c) =>
  typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) && c.toLowerCase() !== '#ffffff'

// Complete an exclusive, painted legend plate. This certificate owns crop
// pixels only; the existing source/translation decisions are preserved.
export function nativeBottomLegendCrop(page, f, captions, tables, tokens, ctx) {
  try {
    if (f?.fallbackFigure || f?.headerRaster || f?.sourceItems?.length || f?.caption?.regions)
      return
    const rules = collectTableRules(ctx.operators, ctx.viewport),
      p =
        nativeTypedPlotPacketInventory(page, f, captions, tables, rules, tokens, ctx) ??
        nativePlotPacketInventory(page, f, captions, tables, rules, tokens, ctx, true)
    if (!p) return
    const { o, v, evidence, valid, finite, box } = p,
      paints = new Map(),
      texts = new Map(),
      stack = []
    // Both owned and foreign domains retain the complete native font ascent
    // and descent, advance, and actual glyph ink. No fallback font metrics.
    for (const r of p.records) {
      const style = ctx.content.styles[r.r.fontName],
        label = nativeFigureLabelBounds(r.r, style, v),
        [a, b, c, d, x, y] = r.r.transform,
        width = Math.hypot(a, b),
        height = Math.hypot(c, d)
      if (
        !valid(label) ||
        !Number.isFinite(style?.ascent) ||
        style.ascent <= 0 ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2 ||
        !(width > 0) ||
        !(height > 0)
      )
        return
      const corners = [0, r.r.width].flatMap((u) =>
          [style.descent * height, style.ascent * height].map((h) =>
            v.convertToViewportPoint(
              x + (a / width) * u + (c / height) * h,
              y + (b / width) * u + (d / height) * h
            )
          )
        ),
        font = [
          Math.min(...corners.map((q) => q[0])),
          Math.min(...corners.map((q) => q[1])),
          Math.max(...corners.map((q) => q[0])),
          Math.max(...corners.map((q) => q[1]))
        ]
      r.whole = union([r.rect, label, font, ...r.part.map(({ g }) => g.ink)])
      if (!valid(r.whole)) return
    }
    let fill = '#000000',
      stroke = '#000000',
      ca = 1,
      CA = 1
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ fill, stroke, ca, CA })
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        ;({ fill, stroke, ca, CA } = stack.pop())
      } else if (op === OPS.setFillRGBColor) fill = a[0]
      else if (op === OPS.setStrokeRGBColor) stroke = a[0]
      else if (op === OPS.setGState)
        for (const [k, n] of a[0]) {
          if (k === 'ca') ca = n
          if (k === 'CA') CA = n
        }
      else if (op === OPS.constructPath) paints.set(i, { fill, stroke, ca, CA })
      else if (op === OPS.showText) texts.set(i, { fill, ca })
    }
    if (stack.length) return
    const paths = []
    for (const [i, s] of evidence.paths) {
      const a = o.argsArray[i]
      if (a[0] === OPS.endPath) continue
      const stroked = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a[0]),
        margin = Math.max(Math.SQRT2, p.strokeMargins.get(i) ?? 10),
        pad = stroked ? (s.lineWidth * margin) / 2 : 0,
        m = Util.transform(v.transform, s.transform),
        det = Math.abs(m[0] * m[3] - m[1] * m[2]),
        nx = Math.hypot(m[0], m[1]),
        ny = Math.hypot(m[2], m[3]),
        floor = stroked
          ? (margin / 2) *
            Math.max(
              (Math.abs(m[0]) * ny + Math.abs(m[2]) * nx) / det,
              (Math.abs(m[1]) * ny + Math.abs(m[3]) * nx) / det
            )
          : 0
      if (
        !finite(a[2], 4) ||
        !finite(m, 6) ||
        !(det > 0) ||
        !Number.isFinite(pad) ||
        pad < 0 ||
        !Number.isFinite(floor) ||
        floor < 0 ||
        (s.clip && !valid(s.clip)) ||
        (stroked &&
          (![0, 1, 2].includes(s.lineCap) || !Number.isFinite(s.lineWidth) || s.lineWidth < 0))
      )
        return
      paths.push({
        i,
        s,
        a,
        m,
        rect: box(Array.from(a[2]), m),
        physical: box(expand(Array.from(a[2]), pad), m),
        floor,
        paint: paints.get(i)
      })
    }
    const horizontal = (q) => {
        const z = q.a[1]?.[0]
        return (
          q.a[0] === OPS.stroke &&
          Array.isArray(q.a[1]) &&
          q.a[1].length === 1 &&
          finite(z, 6) &&
          z[0] === 0 &&
          z[3] === 1 &&
          z[2] === z[5] &&
          z[1] < z[4] &&
          Array.from(q.a[2]).every((n, i) => n === [z[1], z[2], z[4], z[5]][i]) &&
          q.m[1] === 0 &&
          q.m[2] === 0 &&
          q.m[0] > 0 &&
          q.m[3] !== 0 &&
          q.s.lineCap === 0 &&
          q.s.solidStroke &&
          q.s.strokeAlpha === 1 &&
          q.s.lineWidth > 0 &&
          q.paint.CA === 1 &&
          color(q.paint.stroke)
        )
      },
      labels = p.records.filter(
        (r) =>
          r.rect[1] >= f.rect[3] &&
          r.rect[1] - f.rect[3] < r.r.height * 4 &&
          r.rect[3] < f.caption.rect[1] &&
          r.rect[0] >= f.rect[0] &&
          r.rect[2] <= f.rect[2]
      )
    if (labels.length < 3 || labels.length > 12) return
    const em = labels[0].r.height,
      font = labels[0].r.fontName,
      markers = []
    for (const r of labels) {
      if (
        r.r.fontName !== font ||
        Math.abs(r.r.height - em) > 1e-6 ||
        r.r.transform[1] !== 0 ||
        r.r.transform[2] !== 0 ||
        r.r.transform[0] !== em ||
        r.r.transform[3] !== em ||
        !r.part.every(({ g }) => {
          const t = texts.get(g.i)
          return t && t.ca === 1 && color(t.fill)
        })
      )
        return
      const matches = paths.filter(
        (q) =>
          horizontal(q) &&
          q.rect[2] <= r.rect[0] &&
          r.rect[0] - q.rect[2] < em &&
          q.rect[2] - q.rect[0] >= em &&
          q.rect[2] - q.rect[0] <= em * 4 &&
          q.rect[1] >= r.rect[1] &&
          q.rect[3] <= r.rect[3] &&
          q.i < Math.min(...r.part.map(({ g }) => g.i))
      )
      if (matches.length !== 1) return
      const key = matches[0]
      // A single horizontal butt-capped segment has no join or miter. Its
      // painted width is perpendicular to the segment, including native CTM.
      key.markerRect = [
        key.rect[0],
        key.rect[1] - (key.s.lineWidth * Math.abs(key.m[3])) / 2,
        key.rect[2],
        key.rect[3] + (key.s.lineWidth * Math.abs(key.m[3])) / 2
      ]
      key.curves = paths.filter(
        (q) =>
          q !== key &&
          q.a[0] === OPS.stroke &&
          inside(f.rect, q.physical) &&
          q.paint.stroke === key.paint.stroke &&
          q.paint.CA === 1 &&
          q.s.strokeAlpha === 1 &&
          JSON.stringify(q.s.transform) === JSON.stringify(key.s.transform) &&
          q.rect[1] !== q.rect[3] &&
          q.i < key.i
      )
      if (!key.curves.length) return
      markers.push(key)
    }
    if (
      new Set(markers.map((q) => q.i)).size !== labels.length ||
      new Set(markers.map((q) => q.paint.stroke)).size !== labels.length
    )
      return
    const rows = []
    for (const r of labels) {
      let row = rows.find((s) => Math.abs(s[0].rect[3] - r.rect[3]) < em * 0.05)
      if (!row) rows.push((row = []))
      row.push(r)
    }
    rows.sort((a, b) => a[0].rect[3] - b[0].rect[3])
    if (
      rows.length !== 2 ||
      rows[0].length < 2 ||
      rows[1].length < 1 ||
      rows[1][0].rect[3] - rows[0][0].rect[3] > em * 2 ||
      rows[1].some((r) => !rows[0].some((q) => Math.abs(r.rect[0] - q.rect[0]) < em * 0.05))
    )
      return
    const rectangle = (q) => {
        const z = q.a[1]?.[0]
        return (
          q.a[0] === OPS.fill &&
          q.paint.fill?.toLowerCase() === '#ffffff' &&
          q.paint.ca === 1 &&
          q.s.fillAlpha === 1 &&
          Array.isArray(q.a[1]) &&
          q.a[1].length === 1 &&
          finite(z, 13) &&
          z[0] === 0 &&
          z[3] === 1 &&
          z[6] === 1 &&
          z[9] === 1 &&
          z[12] === 4 &&
          z[1] === z[10] &&
          z[4] === z[7] &&
          z[2] === z[5] &&
          z[8] === z[11] &&
          Array.from(q.a[2]).every(
            (n, i) =>
              n ===
              [
                Math.min(z[1], z[4]),
                Math.min(z[2], z[8]),
                Math.max(z[1], z[4]),
                Math.max(z[2], z[8])
              ][i]
          ) &&
          q.m[1] === 0 &&
          q.m[2] === 0 &&
          valid(q.s.clip) &&
          inside(q.s.clip, q.rect)
        )
      },
      ink = labels.flatMap((r) => r.part.map(({ g }) => g.ink)),
      beforeKeys = Math.min(
        ...markers.map((q) => q.i),
        ...labels.flatMap((r) => r.part.map(({ g }) => g.i))
      ),
      plates = paths.filter(
        (q) =>
          rectangle(q) &&
          inside(q.rect, f.rect) &&
          labels.every((r) => inside(q.rect, r.whole)) &&
          markers.every((r) => inside(q.rect, r.markerRect)) &&
          q.i < beforeKeys
      )
    if (plates.length !== 1) return
    const plate = plates[0],
      rect = union([f.rect, plate.rect]),
      allowedGlyphs = new Set(
        p.records
          .filter((r) => inside(f.rect, r.rect) || labels.includes(r))
          .flatMap((r) => r.part.map(({ g }) => g))
      ),
      oldGlyphs = [...allowedGlyphs].filter(
        (g) => !labels.some((r) => r.part.some((z) => z.g === g))
      ),
      frames = paths.filter(
        (q) =>
          rectangle(q) &&
          q !== plate &&
          inside(plate.rect, q.rect) &&
          ink.every((r) => inside(q.rect, r)) &&
          markers.every((r) => inside(q.rect, r.markerRect)) &&
          q.i < beforeKeys
      )
    if (
      frames.length !== 1 ||
      markers.some((q) => !q.curves.some((curve) => curve.i > plate.i)) ||
      oldGlyphs.some((g) => plate.i >= g.i) ||
      oldGlyphs.some((g) => hit(frames[0].rect, g.ink))
    )
      return
    const owned = new Set([
        plate.i,
        frames[0].i,
        ...markers.map((q) => q.i),
        ...paths
          .filter(
            (q) =>
              inside(f.rect, q.rect) &&
              inside(plate.rect, q.physical) &&
              !labels.some((r) => hit(r.whole, q.physical))
          )
          .map((q) => q.i)
      ]),
      foreignPaints = [
        ...captions
          .filter((c) => c.page === page.pageNumber)
          .map((c) => ({ rect: c.rect, floor: 0 })),
        ...tables.map((r) => ({ rect: r, floor: 0 })),
        ...p.records
          .filter((r) => !r.part.every(({ g }) => allowedGlyphs.has(g)))
          .map((r) => ({ rect: r.whole, floor: 0 })),
        ...p.glyphs.filter((g) => !allowedGlyphs.has(g)).map((g) => ({ rect: g.ink, floor: 0 })),
        ...paths.filter((q) => !owned.has(q.i)).map((q) => ({ rect: q.physical, floor: q.floor })),
        ...evidence.images.map((im) => ({ rect: im.rect, floor: 0 }))
      ],
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale)
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      foreignPaints.some(
        (q) =>
          !finite(q.rect, 4) ||
          q.rect[2] < q.rect[0] ||
          q.rect[3] < q.rect[1] ||
          hit(padded, expand(q.rect, (q.floor + 2) / scale))
      )
    )
      return
    return {
      rect,
      formCropRaster: { ownedRects: [rect, ...labels.map((r) => r.whole)], foreignPaints }
    }
  } catch {
    return undefined
  }
}
